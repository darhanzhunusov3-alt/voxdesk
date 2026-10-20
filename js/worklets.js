/* =====================================================================
   WOK Studio — обработчики, работающие прямо в аудиопотоке (AudioWorklet)
   ---------------------------------------------------------------------
   vox-autotune  — автотюн в реальном времени (YIN + TD-PSOLA),
                   задержка 13–27 мс в зависимости от диапазона голоса
   vox-deesser   — де-эссер для VocalChain
   vox-recorder  — запись с микрофона с точной привязкой ко времени
   vox-vocalchain — VocalChain 1.2 (C++ код плагина, собранный в WebAssembly)
   vox-shkafx    — ShkaFX: delay Throw A/B, хвосты и прослушивание (C++ код плагина)

   Функция ниже целиком отправляется в аудиопоток (через toString),
   поэтому снаружи неё ничего использовать нельзя.
   ===================================================================== */
function voxWorkletModule() {
  const SCALES = {
    chromatic:  [0,1,2,3,4,5,6,7,8,9,10,11],
    major:      [0,2,4,5,7,9,11],
    minor:      [0,2,3,5,7,8,10],
    harmMinor:  [0,2,3,5,7,8,11],
    pentaMinor: [0,3,5,7,10],
    pentaMajor: [0,2,4,7,9]
  };
  // позиция песни в долях для процессоров, которым нужен темп (VocalChain, ShkaFX);
  // при зацикливании [loopA, loopB) позиция заворачивается так же, как курсор в студии
  function songBeat(t, now) {
    const b = t.startBeat + (now - t.t0 + t.ahead) * t.bpm / 60;
    return t.loopB > t.loopA && t.startBeat < t.loopB && b >= t.loopB ? t.loopA + (b - t.loopB) % (t.loopB - t.loopA) : b;
  }

  /* ---------------------------- АВТОТЮН ----------------------------
     Определение ноты: YIN на сигнале с половинной частотой + уточнение на полной.
     Каждое измерение запоминается вместе со временем, к которому оно относится,
     и каждый кусочек голоса сдвигается по высоте, измеренной именно в его момент.
     Сдвиг высоты: TD-PSOLA — голос режется на кусочки длиной в два периода
     и складывается заново с новым шагом, тембр не «плывёт».
     Ручки как у Auto-Tune: Retune Speed, Humanize, Flex-Tune, Tracking, Transpose.
     Задержка постоянная: 2 × самый длинный период выбранного типа голоса.
     Против щелчков и «фазовости»: метки периодов выравниваются по форме волны (корреляция с прошлым куском),
     кусок не короче шага синтеза (нет провалов при понижении), коэффициент сдвига меняется плавно и на
     паузах/согласных (без скачка к 1), даже при Retune 0 есть сглаживание ~1 мс, период — медиана из 3,
     на выходе — фильтр постоянной составляющей. */
  const RANGE_FMIN = { low: 75, mid: 100, high: 150 };
  // ядро Ланцоша (a = 4) для дробного чтения кусков голоса
  function lanczos4(d) {
    if (Math.abs(d) < 1e-9) return 1;
    if (Math.abs(d) >= 4) return 0;
    const pd = Math.PI * d;
    return 4 * Math.sin(pd) * Math.sin(pd / 4) / (pd * pd);
  }
  const HIST = 512, HMASK = HIST - 1;
  class VoxAutoTune extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      this.sr = sampleRate;
      this.N = 1 << 15; this.mask = this.N - 1;
      this.x = new Float32Array(this.N); this.y = new Float32Array(this.N); this.ws = new Float32Array(this.N);
      this.n = 0;
      this.p = { key: 9, scale: 'minor', ref: 440, speed: 25, amount: 1, range: 'mid', humanize: 0, flex: 0, tracking: 50, transpose: 0, hyst: 0.05 };
      if (opts && opts.processorOptions) Object.assign(this.p, opts.processorOptions);
      // история измерений: время (сэмпл входа), период, есть ли голос, сглаженная коррекция
      this.hT = new Float32Array(HIST); this.hTime = new Float64Array(HIST); this.hV = new Uint8Array(HIST);
      this.hC = new Float32Array(HIST); this.hHead = 0; this.hCount = 0;
      // метки периодов
      this.mPos = new Float64Array(256); this.mT = new Float32Array(256); this.mV = new Uint8Array(256); this.mC = new Float32Array(256);
      this.mHead = 0; this.mCount = 0;
      this.hop = 128; this.hc = 0; this.rep = 0;
      this.corr = 0; this.midi = 0; this.note = -1; this.held = 0;
      this.voiced = false; this.T = 256; this.pendingT = 0; this.pendingN = 0; this.unvoicedRun = 0; this.onsetT = 0; this.onsetN = 0;
      this.tq = new Float32Array(3); this.tqN = 0;  // последние периоды для медианы
      this.dcX = 0; this.dcY = 0; this.dcR = 1 - 2 * Math.PI * 10 / this.sr; // фильтр постоянной составляющей ~10 Гц
      this.setRange();
      this.port.onmessage = (e) => {
        if (e.data.dispose) { this.dead = true; return; }
        const old = this.p.range; Object.assign(this.p, e.data);
        if (this.p.range !== old) this.setRange();
      };
    }
    setRange() {
      const fmin = RANGE_FMIN[this.p.range] || 100;
      this.Tmax = Math.floor(this.sr / fmin);
      this.Tmin = Math.floor(this.sr / 1050);
      this.Tu = Math.min(256, this.Tmax);
      this.L = 2 * this.Tmax + 64;
      this.dTmax = Math.ceil(this.Tmax / 2) + 2;
      this.dTmin = Math.max(2, Math.floor(this.Tmin / 2));
      this.dW = Math.ceil(this.Tmax / 2) + 48;
      this.dbuf = new Float32Array(this.dW + this.dTmax + 4);
      this.dd = new Float32Array(this.dTmax + 4);
      this.y.fill(0); this.ws.fill(0); this.mCount = 0; this.mHead = 0; this.hCount = 0;
      this.syn = this.n; this.lastMark = this.n; this.voiced = false; this.T = this.Tu; this.tqN = 0; this.prevMark = -1;
    }
    // медиана трёх последних периодов: одиночный выброс (в т.ч. октавный) не проходит дальше
    medianT(T) {
      const q = this.tq; q[0] = q[1]; q[1] = q[2]; q[2] = T; if (this.tqN < 3) this.tqN++;
      if (this.tqN < 3) return T;
      const a = q[0], b = q[1], c = q[2];
      return a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b);
    }
    // ---- история ----
    pushHist(time, T, v, c) {
      const i = this.hHead; this.hTime[i] = time; this.hT[i] = T; this.hV[i] = v ? 1 : 0; this.hC[i] = c;
      this.hHead = (i + 1) & HMASK; if (this.hCount < HIST) this.hCount++;
    }
    // ближайшие измерения вокруг момента t: период, голос, коррекция
    histAt(t, out) {
      if (!this.hCount) { out.T = this.Tu; out.v = 0; out.c = 0; return; }
      let i1 = (this.hHead - 1) & HMASK;
      if (t >= this.hTime[i1]) { out.T = this.hT[i1]; out.v = this.hV[i1]; out.c = this.hC[i1]; return; }
      for (let k = 1; k < this.hCount; k++) {
        const i0 = (this.hHead - 1 - k) & HMASK;
        if (this.hTime[i0] <= t) {
          const t0 = this.hTime[i0], t1 = this.hTime[i1], f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
          const v0 = this.hV[i0], v1 = this.hV[i1];
          out.v = f < 0.5 ? v0 : v1;
          if (v0 && v1) { out.T = this.hT[i0] + (this.hT[i1] - this.hT[i0]) * f; out.c = this.hC[i0] + (this.hC[i1] - this.hC[i0]) * f; }
          else { out.T = f < 0.5 ? this.hT[i0] : this.hT[i1]; out.c = f < 0.5 ? this.hC[i0] : this.hC[i1]; }
          return;
        }
        i1 = i0;
      }
      out.T = this.hT[i1]; out.v = this.hV[i1]; out.c = this.hC[i1];
    }
    // ---- определение высоты ----
    detect() {
      const dW = this.dW, dTmax = this.dTmax, total = dW + dTmax + 2, b = this.dbuf, mask = this.mask;
      let src = this.n - 2 * total;
      let e = 0;
      for (let i = 0; i < total; i++, src += 2) {
        const v = 0.5 * (this.x[src & mask] + this.x[(src + 1) & mask]);
        b[i] = v; if (i >= total - dW) e += v * v;
      }
      if (Math.sqrt(e / dW) < 0.004) return this.unvoiced();
      const th = 0.06 + Math.max(0, Math.min(100, +this.p.tracking)) / 100 * 0.18;
      // окно — последние dW сэмплов, сравниваем их с тем, что было на tau раньше
      const d = this.dd, s0 = total - dW; d[0] = 1; let run = 0, found = -1, gmin = 1, gi = -1;
      for (let tau = 1; tau <= dTmax; tau++) {
        let s = 0;
        for (let j = s0; j < total; j++) { const df = b[j] - b[j - tau]; s += df * df; }
        run += s; d[tau] = run > 0 ? s * tau / run : 1;
        if (tau >= this.dTmin && d[tau] < gmin) { gmin = d[tau]; gi = tau; }
        if (found < 0 && tau > this.dTmin + 1 && d[tau - 1] < th && d[tau - 1] <= d[tau] && d[tau - 1] <= d[tau - 2]) found = tau - 1;
      }
      if (found < 0 && gmin < th * 1.6) found = gi;
      // ошибка на октаву (половина или двойной период) — главный источник треска. Если рядом с прошлым
      // периодом тоже есть хороший провал, остаёмся на прошлой октаве
      if (found > 0 && this.voiced) {
        const prev = this.T / 2, ok2 = (t) => t > this.dTmin && t < dTmax - 1 && d[t] < Math.max(th * 2.2, d[found] * 1.8);
        const dbl = Math.round(found * 2), half = Math.round(found / 2);
        if (Math.abs(dbl - prev) < prev * 0.12 && ok2(dbl)) found = this.localMin(d, dbl);
        else if (Math.abs(half - prev) < prev * 0.12 && ok2(half)) found = this.localMin(d, half);
      }
      if (found < 1 || found >= dTmax) return this.unvoiced();
      const a = d[found - 1], c = d[found + 1], bb = d[found], den = a - 2 * bb + c;
      let T = 2 * (found + (Math.abs(den) > 1e-9 ? 0.5 * (a - c) / den : 0));
      if (T < this.Tmin || T > this.Tmax) return this.unvoiced();
      T = this.refine(T);
      // начало ноты: первые измерения после паузы часто ошибаются на октаву —
      // включаем коррекцию, только когда три измерения подряд совпали (~9 мс)
      if (!this.voiced) {
        if (this.onsetT && Math.abs(T / this.onsetT - 1) < 0.1) this.onsetN++;
        else { this.onsetT = T; this.onsetN = 1; }
        if (this.onsetN < 3) { this.pushHist(this.n - this.dW, this.Tu, false, this.corr); return; }
      }
      // скачок на октаву принимаем, только если он держится ~25 мс подряд (8 измерений)
      if (this.voiced) {
        const q = T / this.T;
        if (q > 1.7 || q < 0.59) {
          if (this.pendingT && Math.abs(T / this.pendingT - 1) < 0.08) { if (++this.pendingN < 8) return this.hold(); }
          else { this.pendingT = T; this.pendingN = 1; return this.hold(); }
        }
        this.pendingT = 0; this.pendingN = 0;
      }
      T = this.medianT(T);
      this.unvoicedRun = 0; this.voiced = true; this.T = T;
      const P = this.p;
      // опорная частота (Reference Pitch): f(n) = ref · 2^((n − 69) / 12), ref 415.3…466.2 Гц (±100 центов от 440)
      const ref = Math.min(466.2, Math.max(415.3, +P.ref || 440));
      const midi = 69 + 12 * Math.log2(this.sr / T / ref);
      const sc = SCALES[P.scale] || SCALES.chromatic, key = (+P.key) | 0;
      const ok = (m) => sc.indexOf((((m - key) % 12) + 12) % 12) >= 0;
      let best = -1, bd = 1e9;
      for (let m = Math.floor(midi) - 3; m <= Math.floor(midi) + 3; m++) if (ok(m)) { const dd = Math.abs(m - midi); if (dd < bd) { bd = dd; best = m; } }
      if (this.note >= 0 && ok(this.note) && Math.abs(midi - this.note) < bd + (+P.hyst || 0)) best = this.note;
      this.held = best === this.note ? this.held + this.hop : 0;
      this.note = best; this.midi = midi;
      // Flex-Tune: чем выше, тем больше естественных отклонений остаётся (тянем только у самой ноты)
      const dev = best - midi;
      let w = 1;
      const flex = Math.max(0, Math.min(100, +P.flex || 0));
      if (flex > 0) {
        const zone = 0.5 * Math.pow(1 - flex / 100, 1.5) + 0.03;
        const ad = Math.abs(dev);
        w = ad <= zone * 0.6 ? 1 : ad >= zone ? 0 : 1 - (ad - zone * 0.6) / (zone * 0.4);
      }
      const target = (dev + (+P.transpose || 0)) * Math.max(0, Math.min(1, +P.amount)) * w + (1 - Math.max(0, Math.min(1, +P.amount))) * (+P.transpose || 0);
      // Retune Speed + Humanize: на длинных нотах коррекция становится мягче
      let ms = Math.max(0, +P.speed || 0);
      const hum = Math.max(0, Math.min(100, +P.humanize || 0));
      if (hum > 0) {
        const heldMs = this.held / this.sr * 1000;
        const k = heldMs <= 120 ? 0 : Math.min(1, (heldMs - 120) / 180);
        ms += hum * 4 * k;
      }
      // даже при Retune 0 переход между нотами занимает ~1 мс — эффект «жёсткий», но без ступеньки-щелчка
      const coef = 1 - Math.exp(-this.hop / (Math.max(1, ms) * 0.001 * this.sr));
      this.corr += (target - this.corr) * coef;
      this.pushHist(this.n - (dW + found), T, true, this.corr);
    }
    hold() { // сомнительное измерение — повторяем предыдущее
      if (this.hCount) { const i = (this.hHead - 1) & HMASK; this.pushHist(this.n - (this.dW + this.T / 2), this.hT[i], this.hV[i], this.hC[i]); }
    }
    localMin(d, t) { // ближайший локальный минимум около t
      while (t > 2 && d[t - 1] < d[t]) t--;
      while (t < this.dTmax - 1 && d[t + 1] < d[t]) t++;
      return t;
    }
    unvoiced() {
      // короткие провалы внутри ноты (~10 мс) не считаем паузой, иначе куски меняют размер и трещат
      if (this.voiced && this.unvoicedRun < 3) { this.unvoicedRun++; return this.hold(); }
      this.onsetN = 0;
      if (++this.unvoicedRun >= 2) { this.voiced = false; this.T = this.Tu; this.held = 0; this.tqN = 0; }
      // на паузе/согласной коррекция плавно уходит к транспозиции (~30 мс), а не обрывается —
      // иначе на стыке голоса и шума шаг кусков скачет и слышен щелчок
      if (!this.voiced) {
        const rest = +this.p.transpose || 0;
        this.corr += (rest - this.corr) * (1 - Math.exp(-this.hop / (0.03 * this.sr)));
      }
      this.pushHist(this.n - this.dW, this.voiced ? this.T : this.Tu, this.voiced, this.corr);
    }
    // уточнение периода на полной частоте (точность до долей сэмпла)
    refine(T0) {
      const t0 = Math.round(T0), Wf = 2 * this.dW, mask = this.mask, base = this.n - Wf - t0 - 6;
      const sd = (tau) => { let s = 0; for (let j = 0; j < Wf; j++) { const df = this.x[(base + j) & mask] - this.x[(base + j + tau) & mask]; s += df * df; } return s; };
      let bt = t0, bv = sd(t0);
      for (let t = t0 - 3; t <= t0 + 3; t++) { if (t === t0 || t < 2) continue; const v = sd(t); if (v < bv) { bv = v; bt = t; } }
      const l = sd(bt - 1), r = sd(bt + 1), den = l - 2 * bv + r;
      return bt + (den > 1e-12 ? 0.5 * (l - r) / den : 0);
    }
    // новая метка периода; возвращает шаг до следующей. На голосе метка сдвигается в пределах ±T/4 туда,
    // где форма волны лучше всего совпадает с прошлой меткой (нормированная корреляция) — куски
    // складываются в фазе, без «шероховатости» и гребёнки
    pushMark(pos) {
      const h = this._h || (this._h = { T: 0, v: 0, c: 0 });
      this.histAt(pos, h);
      let T = h.v ? h.T : this.Tu, at = pos;
      const pm = this.prevMark;
      if (h.v && pm >= 0 && this.prevMarkV) {
        // сначала грубо (шаг ~T/48 по сдвигу и по окну), потом точно рядом с лучшим — дёшево для аудиопотока
        const x = this.x, mask = this.mask, p0 = Math.round(pos), q0 = Math.round(pm);
        const W = Math.max(8, Math.round(T / 2)), R = Math.max(1, Math.round(T / 4));
        const corr = (d, js) => {
          let xy = 0, yy = 0, xx = 0;
          for (let j = -W; j < W; j += js) { const a = x[(p0 + d + j) & mask], b = x[(q0 + j) & mask]; xy += a * b; yy += a * a; xx += b * b; }
          return xy / Math.sqrt(xx * yy + 1e-12);
        };
        const cs = Math.max(1, Math.round(T / 48)), js = Math.max(1, Math.round(T / 48));
        let best = 0, bc = -2;
        for (let d = -R; d <= R; d += cs) { const c = corr(d, js); if (c > bc) { bc = c; best = d; } }
        const lo = Math.max(-R, best - cs), hi = Math.min(R, best + cs), jf = Math.max(1, Math.round(T / 96));
        bc = -2;
        for (let d = lo; d <= hi; d++) { const c = corr(d, jf); if (c > bc) { bc = c; best = d; } }
        if (bc > 0.3) {
          // Доводка до долей сэмпла: вершина параболы через соседние значения корреляции. Метку ставим от прошлой
          // на найденное расстояние между совпадающими местами волны (p0 + best + frac − q0). Раньше шаг меток
          // сводился к целому числу сэмплов (at = pos + best), фаза кусков отставала и тон уходил вниз на
          // 1200·log2(round(T)/T) центов (до −6 ц при T ≈ 104).
          let frac = 0;
          const c0 = corr(best - 1, 1), c1 = corr(best, 1), c2 = corr(best + 1, 1), den = c0 - 2 * c1 + c2;
          if (den < -1e-9) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (c0 - c2) / den));
          at = pm + (p0 - q0) + best + frac;
        }
      }
      const i = this.mHead;
      this.mPos[i] = at; this.mT[i] = T; this.mV[i] = h.v; this.mC[i] = h.c;
      this.mHead = (i + 1) & 255; if (this.mCount < 256) this.mCount++;
      this.prevMark = at; this.prevMarkV = h.v;
      return at - pos + T;
    }
    placeGrain() {
      // ближайшая к позиции синтеза метка, для которой уже есть весь кусок
      let best = -1, bd = 1e18;
      for (let k = 0; k < this.mCount; k++) {
        const i = (this.mHead - 1 - k) & 255, a = this.mPos[i];
        if (a + this.Tmax + 5 > this.n) continue; // кусок (до Tmax в каждую сторону + 4 точки интерполяции) уже записан
        const dd = Math.abs(a - this.syn);
        if (dd < bd) { bd = dd; best = i; }
        else if (a < this.syn) break;
      }
      if (best < 0) { this.syn += this.Tu; return; }
      const a = this.mPos[best], T = this.mT[best];
      // коэффициент берём и на паузах: коррекция там уже плавно уходит к транспозиции (см. unvoiced)
      const r = Math.pow(2, this.mC[best] / 12), hop = T / r;
      // кусок — два периода; удлиняем, только когда шаг синтеза так велик (понижение > ~9 полутонов), что окна
      // перестали бы перекрываться. Длиннее без нужды нельзя — захватываются соседние периоды и появляется гребёнка.
      // Не длиннее Tmax: иначе кусок не успевает целиком попасть в ещё не выведенную часть буфера.
      const half = Math.max(16, Math.round(Math.min(this.Tmax, Math.max(T, 0.6 * hop)))), mask = this.mask;
      const k = Math.PI / half, x = this.x, y = this.y, ws = this.ws;
      // Кусок ставится с точностью до долей сэмпла: центр на выходе s0 = syn + L (дробный), вход читается в точке
      // u = o + (a − s0) через 8-точечную интерполяцию Ланцоша (доля u одна на весь кусок — веса считаем один раз).
      // С округлением центров (как раньше) фаза кусков дрожала на ±0.5 сэмпла — лишние искажения на чистом тоне.
      const s0 = this.syn + this.L, off = a - s0, o0 = Math.ceil(s0 - half), u0 = o0 + off, i0 = Math.floor(u0), fr = u0 - i0;
      const lw = this.lzW || (this.lzW = new Float64Array(8));
      let sum = 0;
      for (let m = 0; m < 8; m++) { lw[m] = lanczos4(fr - (m - 3)); sum += lw[m]; }
      for (let m = 0; m < 8; m++) lw[m] /= sum;
      // сумму окон копим отдельно и делим на неё на выходе — громкость не «дышит», когда шаг кусков меняется
      for (let o = o0, i = i0; o - s0 < half; o++, i++) {
        const w = 0.5 + 0.5 * Math.cos(k * (o - s0)), idx = o & mask;
        let v = 0;
        for (let m = 0; m < 8; m++) v += x[(i + m - 3) & mask] * lw[m];
        y[idx] += v * w;
        ws[idx] += w;
      }
      this.syn += hop;
    }
    process(inputs, outputs) {
      if (this.dead) return false;
      const out = outputs[0]; if (!out || !out.length) return true;
      const inp = inputs[0], has = inp && inp.length > 0, o = out[0], n = o.length, mask = this.mask;
      for (let i = 0; i < n; i++) {
        this.x[this.n & mask] = has ? (inp.length > 1 ? 0.5 * (inp[0][i] + inp[1][i]) : inp[0][i]) : 0;
        if (++this.hc >= this.hop) { this.hc = 0; this.detect(); }
        // метки периодов ставим с отставанием, когда для их места уже есть измерение
        while (this.n - this.lastMark >= this.Tmax) this.lastMark += this.pushMark(this.lastMark);
        let guard = 0;
        while (this.syn + this.L - this.Tmax <= this.n + 1 && guard++ < 8) this.placeGrain();
        const yi = this.n & mask;
        const s = this.y[yi] / Math.max(this.ws[yi], 0.4); this.y[yi] = 0; this.ws[yi] = 0;
        const dc = s - this.dcX + this.dcR * this.dcY; this.dcX = s; this.dcY = Math.abs(dc) < 1e-20 ? 0 : dc;
        o[i] = dc;
        this.n++;
      }
      for (let c = 1; c < out.length; c++) out[c].set(o);
      if (++this.rep >= 12) {
        this.rep = 0;
        this.port.postMessage({ voiced: this.voiced, midi: this.midi, note: this.note, corr: this.corr, latency: this.L / this.sr });
      }
      return true;
    }
  }

  /* ---------------------------- ДЕ-ЭССЕР --------------------------- */
  class VoxDeEsser extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      this.p = { freq: 6500, thresh: -30, range: 8 };
      if (opts && opts.processorOptions) Object.assign(this.p, opts.processorOptions);
      this.lp = [0, 0]; this.env = 0;
      this.port.onmessage = (e) => { if (e.data.dispose) this.dead = true; else Object.assign(this.p, e.data); };
    }
    process(inputs, outputs) {
      if (this.dead) return false;
      const inp = inputs[0], out = outputs[0];
      if (!out || !out.length) return true;
      const n = out[0].length;
      if (!inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
      const sr = sampleRate;
      const a = Math.exp(-6.283185307179586 * this.p.freq / sr);
      const att = Math.exp(-1 / (0.0008 * sr)), rel = Math.exp(-1 / (0.06 * sr));
      const nc = Math.min(inp.length, 2);
      for (let i = 0; i < n; i++) {
        let peak = 0; const hp = [0, 0], lpv = [0, 0];
        for (let c = 0; c < nc; c++) {
          const x = inp[c][i];
          this.lp[c] = (1 - a) * x + a * this.lp[c];
          lpv[c] = this.lp[c]; hp[c] = x - this.lp[c];
          const ab = Math.abs(hp[c]); if (ab > peak) peak = ab;
        }
        this.env = peak > this.env ? att * this.env + (1 - att) * peak : rel * this.env + (1 - rel) * peak;
        const db = 20 * Math.log10(this.env + 1e-9);
        const over = db - this.p.thresh;
        const gr = over > 0 ? Math.min(this.p.range, over * 0.8) : 0;
        const g = Math.pow(10, -gr / 20);
        for (let c = 0; c < out.length; c++) {
          const src = c < nc ? c : 0;
          out[c][i] = lpv[src] + hp[src] * g;
        }
      }
      return true;
    }
  }

  /* ---------------------------- ЗАПИСЬ ----------------------------- */
  class VoxRecorder extends AudioWorkletProcessor {
    constructor() {
      super();
      this.state = 'idle'; this.at = 0; this.startIdx = 0;
      this.chunk = new Float32Array(16384); this.ci = 0;
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.cmd === 'start') { this.state = 'armed'; this.at = m.at; this.ci = 0; }
        else if (m.cmd === 'stop') { this.flush(); this.state = 'idle'; this.port.postMessage({ type: 'done' }); }
      };
    }
    flush() {
      if (this.ci > 0) { this.port.postMessage({ type: 'data', data: this.chunk.slice(0, this.ci) }); this.ci = 0; }
    }
    process(inputs, outputs) {
      const inp = inputs[0];
      const n = (outputs[0] && outputs[0][0]) ? outputs[0][0].length : 128;
      if (this.state === 'armed') {
        if (currentTime + n / sampleRate > this.at) {
          this.state = 'rec';
          this.startIdx = Math.max(0, Math.min(n, Math.round((this.at - currentTime) * sampleRate)));
        } else return true;
      }
      if (this.state === 'rec') {
        const has = inp && inp.length > 0;
        for (let i = this.startIdx; i < n; i++) {
          let v = 0;
          if (has) v = inp.length > 1 ? 0.5 * (inp[0][i] + inp[1][i]) : inp[0][i];
          this.chunk[this.ci++] = v;
          if (this.ci === this.chunk.length) this.flush();
        }
        this.startIdx = 0;
      }
      return true;
    }
  }

  /* ---------------------------- VOCALCHAIN 1.2 (WebAssembly) ----------------------------
     Тот же C++ код, что в VST для FL Studio, собранный в WebAssembly. */
  function vcWasi(getMem) {
    return {
      fd_close: () => 0, fd_seek: () => 0, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8,
      proc_exit: (c) => { throw new Error('VocalChain exit ' + c); },
      fd_write: (fd, iov, n, pw) => {
        const dv = new DataView(getMem().buffer); let t = 0;
        for (let i = 0; i < n; i++) t += dv.getUint32(iov + i * 8 + 4, true);
        dv.setUint32(pw, t, true); return 0;
      }
    };
  }
  class VoxVocalChain extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      const o = (opts && opts.processorOptions) || {};
      const mod = o.module || new WebAssembly.Module(o.wasm);
      let mem = null;
      const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: vcWasi(() => mem) });
      const e = (this.e = inst.exports); mem = e.memory;
      e._initialize();
      this.np = e.vc_create(sampleRate);
      this.pVals = e.vc_values(); this.pL = e.vc_buf_l(); this.pR = e.vc_buf_r(); this.pM = e.vc_meters();
      if (o.values) this.setAll(o.values);
      this.tr = Object.assign({ playing: false, t0: 0, startBeat: 0, bpm: 120, ahead: 0 }, o.transport || {});
      this.silent = 0; this.sleepAfter = Math.round(sampleRate * 4);
      this.metCount = 0; this.metEvery = Math.max(1, Math.round(sampleRate / 128 / 30));
      this.mx = new Float32Array(10);
      this.port.onmessage = (ev) => {
        const m = ev.data;
        if (m.dispose) { this.dead = true; return; }
        if (m.values) this.setAll(m.values);
        if (m.set) { this.f32()[this.pVals / 4 + m.set[0]] = m.set[1]; this.e.vc_apply(); this.silent = 0; }
        if (m.transport) Object.assign(this.tr, m.transport);
      };
    }
    f32() { if (!this._f || this._f.buffer !== this.e.memory.buffer) this._f = new Float32Array(this.e.memory.buffer); return this._f; }
    setAll(v) { this.f32().set(v.length > this.np ? v.subarray(0, this.np) : v, this.pVals / 4); this.e.vc_apply(); this.silent = 0; }
    process(inputs, outputs) {
      if (this.dead) return false;
      const out = outputs[0]; if (!out || !out.length) return true;
      const inp = inputs[0], n = out[0].length, e = this.e;
      const a = inp && inp[0], b = inp && (inp[1] || inp[0]);
      // экономия процессора: долгая тишина на входе — модуль «спит»
      let quiet = true;
      if (a) for (let i = 0; i < n; i++) if (a[i] !== 0 || b[i] !== 0) { quiet = false; break; }
      if (quiet) this.silent += n; else this.silent = 0;
      if (this.silent > this.sleepAfter) { for (const ch of out) ch.fill(0); return true; }
      const f = this.f32(), l = this.pL / 4, r = this.pR / 4;
      if (a) { f.set(a, l); f.set(b, r); } else { f.fill(0, l, l + n); f.fill(0, r, r + n); }
      const t = this.tr;
      e.vc_set_transport(t.bpm, t.playing ? 1 : 0, t.playing ? songBeat(t, currentTime) : 0);
      e.vc_process(n);
      const g = this.f32();
      out[0].set(g.subarray(l, l + n));
      if (out[1]) out[1].set(g.subarray(r, r + n));
      // индикаторы ~30 раз в секунду
      const mp = e.vc_meters() / 4, mx = this.mx;
      mx[0] = Math.max(mx[0], g[mp]); mx[1] = Math.max(mx[1], g[mp + 1]); mx[2] = g[mp + 2];
      for (let k = 3; k < 10; k++) mx[k] = Math.max(mx[k], g[mp + k]);
      if (++this.metCount >= this.metEvery) {
        this.metCount = 0;
        const dyn = new Float32Array(16);
        for (let k = 0; k < 8; k++) { dyn[k] = e.vc_eq_dyn(0, k); dyn[8 + k] = e.vc_eq_dyn(1, k); }
        this.port.postMessage({ m: mx.slice(), dyn });
        mx.fill(0);
      }
      return true;
    }
  }

  registerProcessor('vox-vocalchain', VoxVocalChain);

  /* ---------------------------- ShkaFX (WebAssembly) ----------------------------
     Здесь только то, что должно звучать без задержки: delay Throw A/B (C++ код плагина),
     подмешивание готовых хвостов по позиции песни, прослушивание и запись волны.
     Сами хвосты считаются в фоне (Web Worker) и приходят сюда готовыми. */
  class VoxShkaFX extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      const o = (opts && opts.processorOptions) || {};
      let mem = null;
      const inst = new WebAssembly.Instance(o.module || new WebAssembly.Module(o.wasm), { wasi_snapshot_preview1: vcWasi(() => mem) });
      const e = (this.e = inst.exports); mem = e.memory; e._initialize();
      this.np = e.rt_create(sampleRate);
      this.pV = e.rt_values(); this.pL = e.rt_buf_l(); this.pR = e.rt_buf_r();
      this.tr = Object.assign({ playing: false, t0: 0, startBeat: 0, bpm: 120, ahead: 0 }, o.transport || {});
      this.tails = o.tails || []; this.fileMode = !!o.fileMode;
      this.gain = 1; this.gainT = 1; this.capOn = true;
      this.cap = new Float32Array(1024); this.capN = 0; this.capPos = -1;
      this.preview = null; this.prevOn = false; this.prevPos = 0;
      this.peak = 0; this.metCount = 0; this.metEvery = Math.max(1, Math.round(sampleRate / 128 / 30));
      this.capPort = null;
      if (o.values) this.setAll(o.values);
      this.port.onmessage = (ev) => {
        const m = ev.data;
        if (m.dispose) { this.dead = true; return; }
        if (m.values) this.setAll(m.values);
        if (m.set) { this.f32()[this.pV / 4 + m.set[0]] = m.set[1]; this.apply(); }
        if (m.transport) { Object.assign(this.tr, m.transport); this.apply(); if (this.tr.playing && !this.fileMode) this.prevOn = false; }
        if (m.tails) this.tails = m.tails;
        if (m.fileMode != null) this.fileMode = m.fileMode;
        if (m.capPort) this.capPort = m.capPort;
        if (m.preview) { this.preview = m.preview; }
        if (m.previewPlay != null) { this.prevOn = !!m.previewPlay; if (m.from != null) this.prevPos = m.from; }
      };
    }
    f32() { if (!this._f || this._f.buffer !== this.e.memory.buffer) this._f = new Float32Array(this.e.memory.buffer); return this._f; }
    setAll(v) { this.f32().set(v.length > this.np ? v.subarray(0, this.np) : v, this.pV / 4); this.apply(); }
    apply() {
      const db = this.e.rt_apply(this.tr.bpm || 120);
      this.gainT = Math.pow(10, db / 20); this.capOn = !!this.e.rt_capture_on();
    }
    flushCap() {
      if (this.capN > 0 && this.capPort) this.capPort.postMessage({ pos: this.capPos, data: this.cap.slice(0, this.capN) });
      this.capN = 0; this.capPos = -1;
    }
    process(inputs, outputs) {
      if (this.dead) return false;
      const out = outputs[0]; if (!out || !out.length) return true;
      const inp = inputs[0], n = out[0].length, e = this.e;
      const a = inp && inp[0], b = inp && (inp[1] || inp[0]);
      const t = this.tr, sr = sampleRate;
      const playing = t.playing && !this.fileMode;
      const pos = Math.round(songBeat(t, currentTime) * 60 / (t.bpm || 120) * sr);
      // 1) запись волны для выделений (до эффектов)
      if (playing && this.capOn && pos >= 0 && a) {
        if (this.capPos >= 0 && this.capPos + this.capN !== pos) this.flushCap();
        if (this.capPos < 0) this.capPos = pos;
        for (let i = 0; i < n; i++) { this.cap[this.capN++] = 0.5 * (a[i] + b[i]); if (this.capN === this.cap.length) { this.flushCap(); this.capPos = pos + i + 1; } }
      } else if (this.capN) this.flushCap();
      // 2) delay на выбранные слова
      const f = this.f32(), l = this.pL / 4, r = this.pR / 4;
      if (a) { f.set(a, l); f.set(b, r); } else { f.fill(0, l, l + n); f.fill(0, r, r + n); }
      e.rt_process(n);
      const g = this.f32(), L = out[0], R = out[1] || out[0];
      L.set(g.subarray(l, l + n)); if (out[1]) R.set(g.subarray(r, r + n));
      // 3) готовые хвосты и повторы по позиции песни
      if (playing && pos + n > 0) {
        for (const it of this.tails) {
          const s0 = it.start, s1 = it.start + it.l.length;
          if (s1 <= pos || s0 >= pos + n) continue;
          const from = Math.max(pos, s0), to = Math.min(pos + n, s1);
          for (let k = from; k < to; k++) { L[k - pos] += it.l[k - s0]; R[k - pos] += it.r[k - s0]; }
        }
      }
      // 4) прослушивание внутри плагина
      if (this.prevOn && this.preview) {
        const pb = this.preview, end = pb.start + pb.l.length;
        for (let i = 0; i < n; i++) { const k = this.prevPos + i - pb.start; if (k >= 0 && k < pb.l.length) { L[i] += pb.l[k]; R[i] += pb.r[k]; } }
        this.prevPos += n; if (this.prevPos >= end) this.prevOn = false;
      }
      // выход
      let pk = 0;
      for (let i = 0; i < n; i++) {
        this.gain += (this.gainT - this.gain) * 0.002;
        L[i] *= this.gain; if (R !== L) R[i] *= this.gain;
        if (!isFinite(L[i])) L[i] = 0; if (!isFinite(R[i])) R[i] = 0;
        const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (v > pk) pk = v;
      }
      if (pk > this.peak) this.peak = pk;
      if (++this.metCount >= this.metEvery) {
        this.metCount = 0;
        const prev = this.prevOn || (this.fileMode && this.prevPos > 0);
        this.port.postMessage({ m: { pos: (prev ? this.prevPos : pos) / sr, hasPos: prev || t.playing, playing: prev ? this.prevOn : playing, previewing: this.prevOn, out: this.peak } });
        this.peak = 0;
      }
      return true;
    }
  }
  registerProcessor('vox-shkafx', VoxShkaFX);
  registerProcessor('vox-autotune', VoxAutoTune);
  registerProcessor('vox-deesser', VoxDeEsser);
  registerProcessor('vox-recorder', VoxRecorder);
}
