/* =====================================================================
   WOK Studio — ИНТЕРФЕЙС
   Строит плейлист, Channel Rack, микшер и окна плагинов из Vox.state.
   Внешний вид задают css/theme.css и css/app.css.
   ===================================================================== */
(function () {
  const st = Vox.state;
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cssNum = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
  const insertLabel = (i) => i + ' · ' + st.mixer[i].name;

  let ppb = cssNum('--beat-px') || 28; // пикселей на долю
  let lastPointer = 'mouse';
  document.addEventListener('pointerdown', (e) => (lastPointer = e.pointerType), true);

  /* ------------------------------ подсказки ------------------------------ */
  const hintEl = $('hint');
  Vox.on('hint', (t) => { hintEl.textContent = t; });
  function hoverHints(root) {
    root.addEventListener('pointerover', (e) => {
      const t = e.target.closest('[title]'); if (t && !st.playing) hintEl.textContent = t.title;
    });
  }
  hoverHints(document.body);

  /* ------------------------------ РУЧКА ------------------------------ */
  function knob(o) {
    const root = el('div', 'knob' + (o.small ? ' small' : ''));
    const dial = el('div', 'knob-dial'); dial.appendChild(el('i')); dial.tabIndex = 0;
    dial.setAttribute('role', 'slider'); dial.setAttribute('aria-label', o.label || 'ручка');
    const val = el('div', 'knob-val');
    root.appendChild(dial);
    if (o.label) root.appendChild(el('div', 'knob-label', o.label));
    root.appendChild(val);
    const { min, max } = o; let v = o.value;
    const norm = (x) => (o.log ? Math.log(x / min) / Math.log(max / min) : (x - min) / (max - min));
    const denorm = (p) => (o.log ? min * Math.pow(max / min, p) : min + p * (max - min));
    function show() { dial.style.setProperty('--p', clamp(norm(v), 0, 1)); val.textContent = o.fmt ? o.fmt(v) : v.toFixed(2); }
    function set(nv, emit) {
      nv = clamp(nv, min, max); if (o.step) nv = Math.round(nv / o.step) * o.step;
      v = nv; show(); if (emit && o.onInput) o.onInput(v);
    }
    let sy = 0, sp = 0;
    dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); sy = e.clientY; sp = norm(v); e.preventDefault(); });
    dial.addEventListener('pointermove', (e) => {
      if (!dial.hasPointerCapture(e.pointerId)) return;
      set(denorm(clamp(sp + (sy - e.clientY) / (e.shiftKey ? 600 : 160), 0, 1)), true);
    });
    dial.addEventListener('dblclick', () => set(o.def != null ? o.def : o.value, true));
    dial.addEventListener('wheel', (e) => { e.preventDefault(); set(denorm(clamp(norm(v) - Math.sign(e.deltaY) * 0.02, 0, 1)), true); }, { passive: false });
    dial.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); set(denorm(clamp(norm(v) + d * 0.02, 0, 1)), true); }
    });
    show();
    return { el: root, set: (x) => set(x, false) };
  }

  /* ------------------------------ ОКНА ------------------------------ */
  const layer = $('windows'); const wins = {}; let zTop = 10;
  function front(win) { Object.values(wins).forEach((w) => w.classList.remove('front')); win.classList.add('front'); win.style.zIndex = ++zTop; }
  function openWindow(id, o) {
    if (wins[id]) { front(wins[id]); return wins[id]; }
    const win = el('div', 'win'); win.dataset.win = id;
    const W = layer.clientWidth, H = layer.clientHeight;
    const w = Math.min(o.w, W), h = o.h ? Math.min(o.h, H) : null;
    win.style.width = w + 'px'; if (h) win.style.height = h + 'px';
    win.style.left = clamp(o.x, 0, Math.max(0, W - w)) + 'px';
    win.style.top = clamp(o.y, 0, Math.max(0, H - (h || 200))) + 'px';
    const tb = el('div', 'win-title'); tb.appendChild(el('span', 'w-name', o.title));
    const sub = el('span', 'w-sub', o.sub || ''); tb.appendChild(sub);
    const x = el('button', 'w-close', '×'); x.title = 'Закрыть'; x.setAttribute('aria-label', 'Закрыть окно');
    x.onclick = () => closeWindow(id); tb.appendChild(x);
    const body = el('div', 'win-body');
    win.append(tb, body); layer.appendChild(win);
    win.addEventListener('pointerdown', () => front(win));
    let sx, sy, ox, oy;
    tb.addEventListener('pointerdown', (e) => {
      if (e.target === x || matchMedia('(max-width: 820px)').matches) return;
      tb.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = win.offsetLeft; oy = win.offsetTop;
    });
    tb.addEventListener('pointermove', (e) => {
      if (!tb.hasPointerCapture(e.pointerId)) return;
      win.style.left = clamp(ox + e.clientX - sx, 0, layer.clientWidth - 60) + 'px';
      win.style.top = clamp(oy + e.clientY - sy, 0, layer.clientHeight - 26) + 'px';
    });
    win.sub = sub; win.body = body; win.onCloseCb = o.onClose;
    wins[id] = win; front(win);
    if (o.build) o.build(body, win);
    syncWindowButtons();
    return win;
  }
  function closeWindow(id) {
    const w = wins[id]; if (!w) return;
    if (w.onCloseCb) w.onCloseCb(); w.remove(); delete wins[id]; syncWindowButtons();
  }
  function toggleWindow(id) { wins[id] ? closeWindow(id) : OPENERS[id](); }
  function syncWindowButtons() {
    $('wbRack').classList.toggle('on', !!wins.rack);
    $('wbMixer').classList.toggle('on', !!wins.mixer);
    $('wbBrowser').classList.toggle('on', !$('workspace').classList.contains('no-browser'));
  }

  /* ------------------------------ ВЕРХНЯЯ ПАНЕЛЬ ------------------------------ */
  $('btnPlay').onclick = () => Vox.togglePlay();
  $('btnStop').onclick = () => Vox.stop();
  $('btnRec').onclick = () => Vox.toggleRecord();
  $('btnExport').onclick = () => Vox.exportMix().catch((e) => Vox.hint('Экспорт не удался: ' + e.message));
  $('bpm').addEventListener('change', (e) => { Vox.setBpm(+e.target.value || 140); e.target.value = st.bpm; });
  $('btnMetro').onclick = () => { st.metronome = !st.metronome; syncTransport(); };
  $('btnMonitor').onclick = () => Vox.setMonitor(!st.monitor);
  $('btnPattern').onclick = () => { st.patternInSong = !st.patternInSong; syncTransport(); renderPlaylist(); };
  $('wbRack').onclick = () => toggleWindow('rack');
  $('wbMixer').onclick = () => toggleWindow('mixer');
  $('wbBrowser').onclick = () => { $('workspace').classList.toggle('no-browser'); syncWindowButtons(); };
  $('latencyMs').addEventListener('change', (e) => { st.latencyMs = +e.target.value || 0; Vox.hint('Сдвиг новых записей: ' + st.latencyMs + ' мс'); });

  function syncTransport() {
    $('btnPlay').classList.toggle('active', st.playing);
    $('btnRec').classList.toggle('active', st.recording);
    $('btnMetro').classList.toggle('on', st.metronome);
    $('btnMonitor').classList.toggle('on', st.monitor);
    $('btnPattern').classList.toggle('on', st.patternInSong);
  }
  Vox.on('transport', syncTransport);

  /* ------------------------------ БРАУЗЕР ------------------------------ */
  function renderBrowser() {
    const pl = $('brPlugins'); pl.innerHTML = '';
    Vox.FX_ORDER.forEach((t) => {
      const li = el('li'); li.appendChild(el('span', 'dot'));
      li.appendChild(el('span', '', Vox.FX[t].title));
      li.title = 'Вставить ' + Vox.FX[t].title + ' в канал ' + insertLabel(st.selectedInsert);
      li.onclick = () => {
        const fx = st.mixer[st.selectedInsert].fx, k = fx.indexOf(null);
        if (k < 0) { Vox.hint('В канале нет свободных слотов'); return; }
        Vox.setFx(st.selectedInsert, k, t); openPlugin(st.selectedInsert, k);
      };
      pl.appendChild(li);
    });
    const al = $('brAudio'); al.innerHTML = '';
    if (!Vox.buffers.size) al.appendChild(el('li', 'empty', 'Пока пусто'));
    Vox.buffers.forEach((b, id) => {
      const li = el('li'); li.appendChild(el('span', 'dot')); li.lastChild.style.background = 'var(--clip-6)';
      li.appendChild(el('span', '', b.name + ' · ' + b.buffer.duration.toFixed(1) + ' с'));
      li.title = 'Поставить на дорожку «' + st.tracks[st.selectedTrack].name + '» в позицию курсора';
      li.onclick = () => Vox.addClip(st.selectedTrack, id, Math.floor(st.posBeats));
      al.appendChild(li);
    });
  }
  Vox.on('buffers', renderBrowser);
  $('fileImport').addEventListener('change', async (e) => {
    for (const f of e.target.files) await Vox.importFile(f, st.selectedTrack, Math.floor(st.posBeats));
    e.target.value = '';
  });

  /* ------------------------------ ПЛЕЙЛИСТ ------------------------------ */
  const heads = $('plHeads'), lanes = $('lanes'), ruler = $('ruler'), content = $('plContent'), scroller = $('plScroll');
  const peakCache = new Map();

  function totalBeats() { return Math.max(Vox.songBeats() + 32, Math.ceil(scroller.clientWidth / ppb / 4 + 1) * 4, 128); }

  function renderPlaylist() {
    $('playlist').style.setProperty('--beat-px', ppb + 'px');
    const tb = totalBeats();
    content.style.width = tb * ppb + 'px';

    // линейка
    ruler.innerHTML = '';
    const every = ppb < 10 ? 4 : ppb < 18 ? 2 : 1;
    for (let b = 0; b < tb / 4; b += every) {
      const s = el('span', b % 4 === 0 ? 'bar4' : '', String(b + 1)); s.style.left = b * 4 * ppb + 'px'; ruler.appendChild(s);
    }

    heads.innerHTML = ''; lanes.innerHTML = '';

    // строка паттерна
    const ph = el('div', 'head pattern-head');
    ph.appendChild(el('div', 'swatch')); ph.firstChild.style.background = 'var(--clip-6)';
    const pm = el('div', 'h-main'); pm.appendChild(el('div', 'h-name', 'Паттерн 1'));
    ph.appendChild(pm);
    const pb = el('button', 'sq' + (st.patternInSong ? ' on' : ''), 'P'); pb.title = 'Паттерн играет в песне';
    pb.onclick = (e) => { e.stopPropagation(); st.patternInSong = !st.patternInSong; syncTransport(); renderPlaylist(); };
    ph.appendChild(pb);
    ph.onclick = () => OPENERS.rack();
    heads.appendChild(ph);
    const pl = el('div', 'lane pattern-lane');
    if (st.patternInSong) {
      const blk = el('div', 'pattern-block', 'Паттерн 1 · бит из Channel Rack');
      blk.style.width = Vox.songBeats() * ppb + 'px'; pl.appendChild(blk);
    }
    lanes.appendChild(pl);

    st.tracks.forEach((tr, ti) => {
      // заголовок дорожки
      const h = el('div', 'head' + (ti === st.selectedTrack ? ' selected' : ''));
      const sw = el('div', 'swatch'); sw.style.background = 'var(--clip-' + tr.color + ')';
      const main = el('div', 'h-main');
      const name = el('input', 'h-name'); name.value = tr.name; name.id = 'trackName' + ti; name.setAttribute('aria-label', 'Название дорожки');
      name.addEventListener('change', () => { tr.name = name.value || tr.name; renderBrowser(); });
      const route = el('div', 'h-route'); route.appendChild(el('span', '', 'Канал'));
      const sel = el('select'); sel.id = 'trackInsert' + ti; sel.setAttribute('aria-label', 'Канал микшера');
      for (let i = 1; i < st.mixer.length; i++) { const op = el('option', '', insertLabel(i)); op.value = i; if (i === tr.insert) op.selected = true; sel.appendChild(op); }
      sel.addEventListener('change', () => { tr.insert = +sel.value; Vox.routeMonitor(); });
      sel.addEventListener('click', (e) => e.stopPropagation());
      route.appendChild(sel); main.append(name, route);
      const btns = el('div', 'h-btns');
      const m = el('button', 'sq' + (tr.mute ? ' on' : ''), 'M'); m.title = 'Заглушить дорожку';
      m.onclick = (e) => { e.stopPropagation(); tr.mute = !tr.mute; renderPlaylist(); if (st.playing) { Vox.stop(); Vox.play(); } };
      const r = el('button', 'sq arm' + (tr.armed ? ' on' : ''), '●'); r.title = 'Писать на эту дорожку';
      r.onclick = (e) => { e.stopPropagation(); st.tracks.forEach((t, k) => (t.armed = k === ti ? !t.armed : false)); Vox.routeMonitor(); renderPlaylist(); };
      const dup = el('button', 'sq', '⧉'); dup.title = 'Дублировать дорожку: клипы и канал с эффектами (Ctrl+D)';
      dup.setAttribute('aria-label', 'Дублировать дорожку ' + tr.name);
      dup.onclick = (e) => { e.stopPropagation(); Vox.duplicateTrack(ti); };
      btns.append(dup, m, r);
      h.append(sw, main, btns);
      h.onclick = () => { st.selectedTrack = ti; st.selectedInsert = tr.insert; renderPlaylist(); if (wins.mixer) renderMixer(); renderBrowser(); };
      heads.appendChild(h);

      // дорожка
      const lane = el('div', 'lane'); lane.dataset.track = ti;
      if (!tr.clips.length && ti === 0) lane.appendChild(el('div', 'lane-empty', 'Перетащи сюда аудио или включи ● и нажми запись'));
      tr.clips.forEach((c) => lane.appendChild(renderClip(c, tr, ti)));
      lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drop'); });
      lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
      lane.addEventListener('drop', async (e) => {
        e.preventDefault(); lane.classList.remove('drop');
        const x = e.clientX - lane.getBoundingClientRect().left;
        const beat = Math.max(0, Math.round(x / ppb));
        for (const f of e.dataTransfer.files) await Vox.importFile(f, ti, beat);
      });
      lane.addEventListener('pointerdown', (e) => { if (e.target === lane) { st.selectedClip = null; lanes.querySelectorAll('.clip.selected').forEach((c) => c.classList.remove('selected')); } });
      lanes.appendChild(lane);
    });
  }

  function renderClip(c, tr, ti) {
    const spb = 60 / st.bpm;
    const d = el('div', 'clip' + (st.selectedClip === c.id ? ' selected' : ''));
    d.style.setProperty('--c', 'var(--clip-' + tr.color + ')');
    const w = Math.max(6, (c.dur / spb) * ppb);
    d.style.left = c.startBeat * ppb + 'px'; d.style.width = w + 'px';
    d.title = c.name + ' · тяни — двигать, края — обрезать, кружки — fade. S — разрезать, Ctrl+D — копия, правый клик — удалить';
    d.appendChild(el('div', 'c-name', c.name));
    const cv = el('canvas'); d.appendChild(cv);
    const tl = el('div', 'trim l'), trr = el('div', 'trim r');
    const fl = el('div', 'fade fi'), fr = el('div', 'fade fo');
    tl.title = 'Обрезать начало'; trr.title = 'Обрезать конец';
    fl.title = 'Fade in — тяни вправо'; fr.title = 'Fade out — тяни влево';
    d.append(tl, trr, fl, fr);
    const placeFades = () => {
      const px = (sec) => (sec / spb) * ppb;
      fl.style.left = Math.min(px(c.fadeIn || 0), w - 9) - 4 + 'px';
      fr.style.left = Math.max(w - px(c.fadeOut || 0), 9) - 5 + 'px';
    };
    placeFades();
    requestAnimationFrame(() => drawWave(cv, c, w));

    const select = () => {
      st.selectedClip = c.id; st.selectedTrack = ti;
      lanes.querySelectorAll('.clip.selected').forEach((x) => x.classList.remove('selected')); d.classList.add('selected');
    };
    const snap = (beat, e) => (e.altKey ? beat : Math.round(beat * 4) / 4);
    // универсальное перетаскивание для ручек клипа
    function drag(handle, onMove) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button === 2) return;
        e.stopPropagation(); e.preventDefault(); select();
        handle.setPointerCapture(e.pointerId); handle.classList.add('active');
        const x0 = e.clientX, start = { startBeat: c.startBeat, offset: c.offset, dur: c.dur, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 };
        const mv = (ev) => {
          onMove((ev.clientX - x0) / ppb, start, ev);
          const nw = Math.max(6, (c.dur / spb) * ppb);
          d.style.left = c.startBeat * ppb + 'px'; d.style.width = nw + 'px';
          placeFades(); drawWave(cv, c, nw);
        };
        const up = () => {
          handle.classList.remove('active');
          handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
          renderPlaylist();
        };
        handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
      });
    }
    drag(tl, (db, s0, e) => { Object.assign(c, s0); Vox.trimClipStart(c, snap(s0.startBeat + db, e)); });
    drag(trr, (db, s0, e) => { Object.assign(c, s0); Vox.trimClipEnd(c, snap(s0.startBeat + s0.dur / spb + db, e)); });
    drag(fl, (db, s0) => { c.fadeIn = Math.max(0, s0.fadeIn + db * spb); Vox.clampFades(c); });
    drag(fr, (db, s0) => { c.fadeOut = Math.max(0, s0.fadeOut - db * spb); c.fadeIn = s0.fadeIn; Vox.clampFades(c); });

    let sx, sy, sb, moved = false, targetTi = ti;
    d.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      d.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; sb = c.startBeat; moved = false; targetTi = ti;
      select(); d.style.cursor = 'grabbing'; e.preventDefault();
    });
    d.addEventListener('pointermove', (e) => {
      if (!d.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      c.startBeat = Math.max(0, snap(sb + dx / ppb, e)); d.style.left = c.startBeat * ppb + 'px';
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList && x.classList.contains('lane') && x.dataset.track != null);
      if (under) { targetTi = +under.dataset.track; d.style.transform = 'translateY(' + (under.offsetTop - d.parentNode.offsetTop) + 'px)'; }
    });
    d.addEventListener('pointerup', () => {
      d.style.cursor = '';
      if (moved && targetTi !== ti) { tr.clips = tr.clips.filter((x) => x !== c); st.tracks[targetTi].clips.push(c); st.selectedTrack = targetTi; }
      if (moved) renderPlaylist();
    });
    // правый клик удаляет; долгое нажатие пальцем только выделяет (удалить — кнопкой ✕)
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); if (lastPointer !== 'touch') Vox.deleteClip(c.id); });
    return d;
  }

  function drawWave(cv, c, w) {
    const b = Vox.buffers.get(c.bufferId); if (!b) return;
    const W = Math.min(4096, Math.max(2, Math.round(w))), H = 40;
    cv.width = W; cv.height = H;
    const key = c.bufferId + ':' + W + ':' + c.offset.toFixed(4) + ':' + c.dur.toFixed(4);
    let peaks = peakCache.get(key);
    if (!peaks) {
      const data = b.buffer.getChannelData(0), sr = b.buffer.sampleRate;
      const s0 = Math.floor(c.offset * sr), n = Math.floor(c.dur * sr), per = Math.max(1, Math.floor(n / W));
      const step = Math.max(1, Math.floor(per / 64));
      peaks = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        let m = 0; const a = s0 + x * per;
        for (let i = a; i < a + per && i < data.length; i += step) { const v = Math.abs(data[i]); if (v > m) m = v; }
        peaks[x] = m;
      }
      if (peakCache.size > 400) peakCache.clear();
      peakCache.set(key, peaks);
    }
    const g = cv.getContext('2d');
    const col = getComputedStyle(cv.parentNode.querySelector('.c-name')).backgroundColor;
    // волна с учётом fade: громкость на краях уменьшается так же, как при воспроизведении
    const spx = c.dur / W, fi = c.fadeIn || 0, fo = c.fadeOut || 0;
    g.fillStyle = col;
    for (let x = 0; x < W; x++) {
      const t = x * spx;
      let k = 1; if (fi > 0 && t < fi) k = t / fi; if (fo > 0 && t > c.dur - fo) k = Math.min(k, (c.dur - t) / fo);
      const hh = Math.max(1, peaks[x] * H * 0.95 * k); g.fillRect(x, (H - hh) / 2, 1, hh);
    }
    if (fi > 0 || fo > 0) {
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1; g.beginPath();
      if (fi > 0) { g.moveTo(0, H); g.lineTo(fi / spx, 0); }
      if (fo > 0) { g.moveTo(W - fo / spx, 0); g.lineTo(W, H); }
      g.stroke();
    }
  }

  ruler.addEventListener('pointerdown', (e) => {
    const x = e.clientX - ruler.getBoundingClientRect().left;
    Vox.setPosition(Math.max(0, Math.round(x / ppb)));
  });
  $('zoomIn').onclick = () => { ppb = Math.min(96, ppb * 1.25); renderPlaylist(); };
  $('zoomOut').onclick = () => { ppb = Math.max(6, ppb / 1.25); renderPlaylist(); };
  $('splitBtn').onclick = () => Vox.splitAtCursor();
  $('delBtn').onclick = () => { if (st.selectedClip != null) Vox.deleteClip(st.selectedClip); };
  setInterval(() => { $('delBtn').disabled = st.selectedClip == null; }, 200);
  $('dupBtn').onclick = () => {
    if (st.selectedClip != null) Vox.duplicateClip(st.selectedClip); else Vox.duplicateTrack(st.selectedTrack);
  };
  $('addTrack').onclick = () => {
    const n = st.tracks.length;
    st.tracks.push({ name: 'Дорожка ' + (n + 1), color: (n % 6) + 1, insert: Math.min(st.mixer.length - 1, n + 1), armed: false, mute: false, clips: [] });
    renderPlaylist();
  };
  scroller.addEventListener('scroll', () => { heads.scrollTop = scroller.scrollTop; });
  heads.addEventListener('wheel', (e) => { scroller.scrollTop += e.deltaY; }, { passive: true });
  Vox.on('tracks', () => { renderPlaylist(); renderBrowser(); });

  /* ------------------------------ CHANNEL RACK ------------------------------ */
  let rackSteps = [];
  function buildRack(body) {
    body.innerHTML = ''; rackSteps = []; lastStep = -1; closeRackSheet();
    if (Vox.isMobile()) { buildRackMobile(body); return; }
    const r = el('div', 'rack');
    st.rack.channels.forEach((c, ci) => {
      const row = el('div', 'rack-row');
      const led = el('button', 'led' + (c.mute ? ' off' : '')); led.title = 'Вкл/выкл канал'; led.setAttribute('aria-label', 'Вкл/выкл ' + c.name);
      led.onclick = () => { c.mute = !c.mute; led.classList.toggle('off', c.mute); };
      const nm = el('button', 'r-name', c.name); nm.title = 'Прослушать звук';
      nm.onclick = () => Vox.previewDrum(ci);
      const vk = knob({ small: true, min: 0, max: 1, value: c.vol, def: 0.8, step: 0.01, fmt: (v) => Math.round(v * 100), onInput: (v) => (c.vol = v), label: '' });
      const sel = el('select'); sel.id = 'rackInsert' + ci; sel.title = 'Канал микшера'; sel.setAttribute('aria-label', 'Канал микшера для ' + c.name);
      for (let i = 1; i < st.mixer.length; i++) { const op = el('option', '', String(i)); op.value = i; if (i === c.insert) op.selected = true; sel.appendChild(op); }
      sel.onchange = () => (c.insert = +sel.value);
      const steps = el('div', 'steps'); const arr = [];
      c.steps.forEach((on, si) => {
        const b = el('button', 'step' + (Math.floor(si / 4) % 2 ? ' b' : '') + (on ? ' on' : ''));
        b.setAttribute('aria-label', c.name + ' шаг ' + (si + 1));
        b.onclick = () => { c.steps[si] = c.steps[si] ? 0 : 1; b.classList.toggle('on', !!c.steps[si]); };
        steps.appendChild(b); arr.push(b);
      });
      rackSteps.push(arr);
      row.append(led, nm, vk.el, sel, steps); r.appendChild(row);
    });
    body.appendChild(r);
  }

  // Телефон: строка = заголовок (LED + имя) и сетка 8×2 на всю ширину; остальное — в панели канала.
  const rackMeta = (c) => '→' + c.insert + ' · ' + Math.round(c.vol * 100) + '%';
  function buildRackMobile(body) {
    const r = el('div', 'rack m-rack');
    st.rack.channels.forEach((c, ci) => {
      const row = el('div', 'm-rack-row' + (c.mute ? ' muted' : ''));
      const head = el('div', 'm-rack-head');
      const led = el('button', 'm-led'); led.appendChild(el('span', 'led' + (c.mute ? ' off' : '')));
      led.title = 'Вкл/выкл канал'; led.setAttribute('aria-label', 'Вкл/выкл ' + c.name); led.setAttribute('aria-pressed', String(!c.mute));
      const nm = el('button', 'r-name'); nm.appendChild(el('span', 'r-title', c.name));
      const meta = el('span', 'r-meta', rackMeta(c)); nm.appendChild(meta);
      nm.title = 'Настройки канала'; nm.setAttribute('aria-haspopup', 'dialog');
      const ui = { row, led: led.firstChild, ledBtn: led, meta };
      led.onclick = () => setRackMute(c, ui, !c.mute);
      nm.onclick = () => openRackSheet(ci, ui);
      head.append(led, nm);

      const steps = el('div', 'steps m-steps'); const arr = [];
      c.steps.forEach((on, si) => {
        const b = el('button', 'step' + (Math.floor(si / 4) % 2 ? ' b' : '') + (on ? ' on' : ''));
        b.dataset.si = si; b.setAttribute('aria-label', c.name + ' шаг ' + (si + 1)); b.setAttribute('aria-pressed', String(!!on));
        // тап/свайп обрабатывает pointerdown ниже; click — только с клавиатуры (detail = 0)
        b.onclick = (e) => { if (e.detail === 0) setStep(c, si, b, !c.steps[si]); };
        steps.appendChild(b); arr.push(b);
      });
      paintSteps(steps, c, arr);
      rackSteps.push(arr);
      row.append(head, steps); r.appendChild(row);
    });
    body.appendChild(r);
  }
  function setStep(c, si, b, on) {
    c.steps[si] = on ? 1 : 0; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  }
  // Рисование свайпом: первый шаг задаёт режим (вкл/выкл), дальше он применяется к шагам под пальцем
  // этого же канала. Состояние меняется сразу — планировщик транспорта читает c.steps сам, звук здесь не трогаем.
  // Отмена: один жест = один pointerup = один шаг истории.
  function paintSteps(grid, c, arr) {
    let mode = null, pid = null;
    const stepAt = (x, y) => { const t = document.elementFromPoint(x, y); const b = t && t.closest('.step'); return b && b.parentNode === grid ? b : null; };
    grid.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.step'); if (!b || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault(); pid = e.pointerId; grid.setPointerCapture(pid);
      const si = +b.dataset.si; mode = !c.steps[si]; setStep(c, si, b, mode);
    });
    grid.addEventListener('pointermove', (e) => {
      if (mode === null || e.pointerId !== pid) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      (evs.length ? evs : [e]).forEach((p) => {
        const b = stepAt(p.clientX, p.clientY); if (!b) return;
        const si = +b.dataset.si; if (!!c.steps[si] !== mode) setStep(c, si, arr[si], mode);
      });
    });
    const end = (e) => { if (e.pointerId !== pid) return; mode = null; pid = null; Vox.history.schedule(); };
    grid.addEventListener('pointerup', end); grid.addEventListener('pointercancel', end); grid.addEventListener('lostpointercapture', end);
    grid.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  function setRackMute(c, ui, mute) {
    c.mute = mute; ui.led.classList.toggle('off', mute); ui.ledBtn.setAttribute('aria-pressed', String(!mute)); ui.row.classList.toggle('muted', mute);
  }

  // Панель канала (bottom sheet): прослушать, вкл/выкл, громкость, канал микшера.
  let rackSheet = null;
  function closeRackSheet() {
    if (!rackSheet) return;
    const s = rackSheet; rackSheet = null; s.back.remove(); document.removeEventListener('keydown', s.key, true);
    if (s.opener && document.contains(s.opener)) s.opener.focus();
  }
  function openRackSheet(ci, ui) {
    closeRackSheet();
    const c = st.rack.channels[ci];
    const back = el('div', 'sheet-back'), sh = el('div', 'sheet');
    sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', 'Канал ' + c.name);
    const head = el('div', 'sheet-head');
    head.append(el('div', 'sheet-grip'), el('span', 'sheet-title', c.name), el('span', 'sheet-sub', Vox.DRUM_TYPES[c.type] || c.type));
    const x = el('button', 'w-close', '×'); x.title = 'Закрыть'; x.setAttribute('aria-label', 'Закрыть панель'); x.onclick = closeRackSheet;
    head.appendChild(x);

    const acts = el('div', 'sheet-acts');
    const play = el('button', 'sheet-btn primary', '▶ Прослушать'); play.title = 'Прослушать звук';
    play.onclick = () => Vox.previewDrum(ci);
    const mute = el('button', 'sheet-btn tog' + (c.mute ? '' : ' on'), c.mute ? 'Выключен' : 'Включён');
    mute.title = 'Вкл/выкл канал'; mute.setAttribute('aria-pressed', String(!c.mute));
    mute.onclick = () => {
      setRackMute(c, ui, !c.mute);
      mute.classList.toggle('on', !c.mute); mute.textContent = c.mute ? 'Выключен' : 'Включён'; mute.setAttribute('aria-pressed', String(!c.mute));
    };
    acts.append(play, mute);

    // регуляторы: горизонтальный фейдер громкости (удобнее пальцем, чем ручка) и канал микшера
    const ctl = el('div', 'sheet-ctl');
    const volRow = el('label', 'sheet-row'); volRow.appendChild(el('span', '', 'Громкость'));
    const vbox = el('span', 'sheet-val'), vol = el('input', 'hfader'), out = el('output', '', Math.round(c.vol * 100) + '%');
    vol.type = 'range'; vol.min = 0; vol.max = 100; vol.step = 1; vol.value = Math.round(c.vol * 100); vol.setAttribute('aria-label', 'Громкость ' + c.name);
    const showVol = () => { vol.style.setProperty('--p', vol.value / 100); out.textContent = vol.value + '%'; };
    vol.oninput = () => { c.vol = vol.value / 100; showVol(); ui.meta.textContent = rackMeta(c); };
    vol.ondblclick = () => { vol.value = 80; vol.oninput(); };
    showVol(); vbox.append(vol, out); volRow.appendChild(vbox);
    const insRow = el('label', 'sheet-row'); insRow.appendChild(el('span', '', 'Канал микшера'));
    const sel = el('select'); sel.id = 'rackInsert' + ci; sel.setAttribute('aria-label', 'Канал микшера для ' + c.name);
    for (let i = 1; i < st.mixer.length; i++) { const op = el('option', '', insertLabel(i)); op.value = i; if (i === c.insert) op.selected = true; sel.appendChild(op); }
    sel.onchange = () => { c.insert = +sel.value; ui.meta.textContent = rackMeta(c); };
    insRow.appendChild(sel);
    ctl.append(volRow, insRow);

    sh.append(head, acts, ctl); back.appendChild(sh); document.body.appendChild(back);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) closeRackSheet(); });
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeRackSheet(); } };
    document.addEventListener('keydown', key, true);
    rackSheet = { back, key, opener: document.activeElement };
    play.focus();
  }

  /* ------------------------------ МИКШЕР ------------------------------ */
  // Маршрут как в FL Studio: внизу каждого канала — стрелка «направить сюда выбранный канал» и ручка уровня
  // посыла (0–100 %, 100 % = 0 дБ). На мастере стрелка включает/выключает прямой выход выбранного канала в мастер.
  function routeBox(i, src, knobsOf, syncSend) {
    const box = el('div', 's-route');
    if (i === src) { box.appendChild(el('span', 's-route-src', i === 0 ? 'ВЫХОД' : 'ИСТОЧНИК')); return box; }
    if (src === 0) return box; // мастер никуда не направляется
    const routed = Vox.isRouted(src, i), can = i === 0 || routed || Vox.canRoute(src, i);
    const btn = el('button', 'route-btn' + (routed ? ' on' : ''));
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13 3 7h3V3h4v4h3z"/></svg>';
    btn.setAttribute('aria-pressed', String(routed));
    const to = i === 0 ? 'мастер' : insertLabel(i);
    btn.title = !can ? 'Нельзя: получится петля (' + insertLabel(i) + ' уже идёт в ' + insertLabel(src) + ')'
      : (routed ? 'Убрать маршрут ' : 'Направить ') + insertLabel(src) + ' → ' + to;
    btn.setAttribute('aria-label', btn.title);
    btn.disabled = !can;
    btn.onclick = (e) => {
      e.stopPropagation();
      if (!Vox.setRoute(src, i, !routed)) Vox.hint('Маршрут не создан: получилась бы петля');
      else Vox.hint(routed ? 'Маршрут убран: ' + insertLabel(src) + ' ↛ ' + to : 'Маршрут: ' + insertLabel(src) + ' → ' + to + (i === 0 ? '' : ', уровень — ручкой рядом'));
    };
    box.appendChild(btn);
    if (routed && i > 0) {
      const U = Vox.UNITY_SEND, v = Math.min(U, st.mixer[src].sends[i] || 0);
      const kn = knob({ small: true, min: 0, max: U, value: v, def: U, step: U / 100, label: '',
        fmt: (x) => Math.round(x / U * 100) + '%', onInput: (x) => { Vox.setSend(src, i, Math.max(x, 0.0005)); syncSend(src, i, x, kn); } });
      kn.el.classList.add('send', 'route-level'); kn.el.title = 'Уровень посыла ' + insertLabel(src) + ' → ' + to + ' (двойной клик — 100 %)';
      (knobsOf[src + '>' + i] = knobsOf[src + '>' + i] || []).push(kn);
      box.appendChild(kn.el);
    }
    return box;
  }
  let mixerMeters = [];
  function fader(ch, onChange) {
    const f = el('div', 'fader'); const cap = el('div', 'cap'); f.appendChild(cap);
    f.tabIndex = 0; f.setAttribute('role', 'slider'); f.setAttribute('aria-label', 'Громкость');
    const show = () => { cap.style.top = (1 - ch.vol) * 100 + '%'; };
    const setFromY = (y) => { const r = f.getBoundingClientRect(); ch.vol = clamp(1 - (y - r.top) / r.height, 0, 1); show(); onChange(); };
    let sy, sv;
    f.addEventListener('pointerdown', (e) => {
      f.setPointerCapture(e.pointerId); sy = e.clientY; sv = ch.vol;
      if (e.target === f) setFromY(e.clientY), (sv = ch.vol);
      e.preventDefault();
    });
    f.addEventListener('pointermove', (e) => {
      if (!f.hasPointerCapture(e.pointerId)) return;
      ch.vol = clamp(sv + (sy - e.clientY) / (e.shiftKey ? 600 : 150), 0, 1); show(); onChange();
    });
    f.addEventListener('dblclick', () => { ch.vol = 0.8; show(); onChange(); });
    f.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' ? 0.02 : e.key === 'ArrowDown' ? -0.02 : 0;
      if (d) { e.preventDefault(); ch.vol = clamp(ch.vol + d, 0, 1); show(); onChange(); }
    });
    show(); return f;
  }
  const dbText = (v) => { const d = Vox.faderDb(v); return d === -Infinity ? '−∞' : (d > 0 ? '+' : '') + d.toFixed(1); };

  function renderMixer() {
    const win = wins.mixer; if (!win) return;
    const body = win.body; body.innerHTML = ''; mixerMeters = [];
    win.sub.textContent = 'Канал ' + insertLabel(st.selectedInsert);
    const mx = el('div', 'mixer'), strips = el('div', 'strips');
    const buses = st.mixer.map((c, b) => (c.ret ? b : -1)).filter((b) => b > 0);
    const busShort = (b) => { const f = st.mixer[b].fx.find((x) => x); return f ? Vox.FX[f.type].title.slice(0, 3) : 'S' + b; };
    const src = st.selectedInsert, knobsOf = {}; // ручки посылов «канал>куда», чтобы обе копии показывали одно значение
    const syncSend = (a, b, x, from) => (knobsOf[a + '>' + b] || []).forEach((k) => { if (k !== from) k.set(x); });
    st.mixer.forEach((ch, i) => {
      const feeds = i > 0 && src > 0 && i !== src && Vox.isRouted(i, src); // этот канал приходит в выбранный
      const s = el('div', 'strip' + (i === 0 ? ' master' : '') + (ch.ret ? ' ret' : '') + (i === src ? ' selected' : '')
        + (i !== src && src > 0 && Vox.isRouted(src, i) ? ' routed' : '') + (feeds ? ' feeds' : ''));
      s.appendChild(el('div', 's-num', i === 0 ? 'M' : String(i)));
      const nm = el('div', 's-name', ch.name); nm.title = 'Двойной клик, чтобы переименовать';
      nm.ondblclick = (e) => {
        e.stopPropagation(); const inp = el('input'); inp.value = ch.name; inp.style.width = '100%'; inp.style.fontSize = '11px';
        nm.replaceWith(inp); inp.focus(); inp.select();
        const done = () => { ch.name = inp.value || ch.name; renderMixer(); renderPlaylist(); };
        inp.onblur = done; inp.onkeydown = (k) => { if (k.key === 'Enter') inp.blur(); };
      };
      s.appendChild(nm);
      const pan = knob({ small: true, min: -1, max: 1, value: ch.pan, def: 0, step: 0.01,
        fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)),
        onInput: (v) => { ch.pan = v; Vox.updateMix(); }, label: '' });
      s.appendChild(pan.el);
      // посылы на каналы-возвраты
      const sb = el('div', 's-sends');
      if (i > 0 && !ch.ret) buses.forEach((b) => {
        const v = (ch.sends && ch.sends[b]) || 0;
        const kn = knob({ small: true, min: 0, max: 1, value: v, def: 0, step: 0.01, label: busShort(b),
          fmt: (x) => { const d = Vox.sendDb(x); return d === -Infinity ? '−∞' : Math.round(d); },
          onInput: (x) => { Vox.setSend(i, b, x); syncSend(i, b, x, kn); } });
        (knobsOf[i + '>' + b] = knobsOf[i + '>' + b] || []).push(kn);
        kn.el.classList.add('send'); kn.el.title = 'Посыл в ' + insertLabel(b);
        sb.appendChild(kn.el);
      });
      else if (ch.ret) sb.appendChild(el('div', 's-retlabel', 'ВОЗВРАТ'));
      s.appendChild(sb);
      const fw = el('div', 'fader-wrap');
      const db = el('div', 's-db', dbText(ch.vol));
      fw.appendChild(fader(ch, () => { db.textContent = dbText(ch.vol); Vox.updateMix(); }));
      const mc = el('canvas', 'strip-meter'); mc.width = 12; mc.height = 128; fw.appendChild(mc); mixerMeters[i] = mc;
      s.appendChild(fw); s.appendChild(db);
      if (i > 0) {
        const b = el('div', 's-btns');
        const m = el('button', 'sq' + (ch.mute ? ' on' : ''), 'M'); m.title = 'Mute';
        m.onclick = (e) => { e.stopPropagation(); ch.mute = !ch.mute; m.classList.toggle('on', ch.mute); Vox.updateMix(); };
        const so = el('button', 'sq solo' + (ch.solo ? ' on' : ''), 'S'); so.title = 'Solo';
        so.onclick = (e) => { e.stopPropagation(); ch.solo = !ch.solo; so.classList.toggle('on', ch.solo); Vox.updateMix(); };
        b.append(m, so); s.appendChild(b);
      }
      s.appendChild(routeBox(i, src, knobsOf, syncSend));
      s.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.fader, .knob-dial, button, input, .s-route')) return;
        if (st.selectedInsert !== i) { st.selectedInsert = i; renderMixer(); renderBrowser(); }
      });
      strips.appendChild(s);
    });
    // добавить канал-возврат
    const add = el('div', 'strip add-ret');
    add.appendChild(el('div', 's-num', '+'));
    add.appendChild(el('div', 's-name', 'Посыл'));
    const sel = el('select'); sel.id = 'addReturn'; sel.setAttribute('aria-label', 'Добавить канал-возврат');
    [['', 'Добавить…'], ['reverb', 'Reverb'], ['delay', 'Delay'], ['chorus', 'Chorus']].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; sel.appendChild(o); });
    sel.onchange = () => { if (!sel.value) return; const b = Vox.addReturn(sel.value); st.selectedInsert = b; renderMixer(); Vox.hint('Добавлен канал-возврат ' + insertLabel(b) + '. Посыл на него — ручки над фейдерами.'); };
    add.appendChild(sel);
    add.appendChild(el('p', 's-addnote', 'Общий ревер или дилей для нескольких дорожек'));
    strips.appendChild(add);
    mx.appendChild(strips);

    // FX-слоты выбранного канала
    const fr = el('div', 'fx-rack');
    const t = el('div', 'fr-title'); t.append('Эффекты: '); t.appendChild(el('b', '', insertLabel(st.selectedInsert)));
    fr.appendChild(t);
    const i = st.selectedInsert;
    st.mixer[i].fx.forEach((s, k) => {
      const row = el('div', 'fx-slot');
      const led = el('button', 'led' + (!s ? ' none' : s.bypass ? ' off' : ''));
      led.title = s ? (s.bypass ? 'Включить эффект' : 'Выключить (bypass)') : 'Пустой слот';
      led.setAttribute('aria-label', 'Bypass слота ' + (k + 1));
      led.onclick = () => { if (s) Vox.toggleBypass(i, k); };
      const sel = el('select'); sel.id = 'fxSlot' + k; sel.setAttribute('aria-label', 'Эффект в слоте ' + (k + 1));
      const none = el('option', '', '— Слот ' + (k + 1) + ' —'); none.value = ''; sel.appendChild(none);
      Vox.FX_ORDER.forEach((tp) => { const op = el('option', '', Vox.FX[tp].title); op.value = tp; if (s && s.type === tp) op.selected = true; sel.appendChild(op); });
      sel.onchange = () => { closeWindow('plug-' + i + '-' + k); Vox.setFx(i, k, sel.value || null); if (sel.value) openPlugin(i, k); };
      const op = el('button', 'open', '⚙'); op.title = 'Открыть окно плагина'; op.disabled = !s;
      op.onclick = () => openPlugin(i, k);
      row.append(led, sel, op); fr.appendChild(row);
    });
    fr.appendChild(el('div', 'fx-note', st.mixer[i].ret
      ? 'Канал-возврат: сюда приходят посылы с других каналов. У эффекта Dry 0%, Wet 100%.'
      : 'Порядок важен: автотюн ставь первым, до VocalChain. Ручки над фейдерами — посылы в общий ревер и дилей.'));
    mx.appendChild(fr);
    body.appendChild(mx);
  }
  Vox.on('mixer', () => { renderMixer(); renderBrowser(); });

  /* ------------------------------ ОКНА ПЛАГИНОВ ------------------------------ */
  const pct = (v) => Math.round(v * 100) + '%';
  const hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'к' : Math.round(v)) + ' Гц';
  const dbf = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' дБ';
  const ms = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' мс';

  const sec = (v) => v.toFixed(v < 10 ? 1 : 0) + ' с';
  const GENERIC = {
    delay: [
      { k: 'sync', type: 'select', label: 'Время', options: [['1/4', '1/4'], ['1/8', '1/8'], ['1/8.', '1/8 с точкой'], ['1/8t', '1/8 триоль'], ['1/16', '1/16'], ['1/4.', '1/4 с точкой'], ['1/2', '1/2']] },
      { k: 'pingpong', type: 'select', num: true, label: 'Режим', options: [[0, 'Обычный'], [1, 'Пинг-понг']] },
      { k: 'feedback', label: 'Feedback', min: 0, max: 0.92, fmt: pct, def: 0.32 },
      { k: 'tone', label: 'High Cut', min: 1000, max: 16000, log: true, fmt: hz, def: 5500 },
      { k: 'lowcut', label: 'Low Cut', min: 40, max: 1500, log: true, fmt: hz, def: 300 },
      { k: 'sat', label: 'Drive', min: 0, max: 1, fmt: pct, def: 0.2 },
      { k: 'dry', label: 'Dry', min: 0, max: 1, fmt: pct, def: 1 },
      { k: 'wet', label: 'Wet', min: 0, max: 1, fmt: pct, def: 0.25 }
    ],
    reverb: [
      { k: 'decay', label: 'Decay', min: 0.3, max: 10, log: true, fmt: sec, def: 2.2 },
      { k: 'size', label: 'Size', min: 0, max: 1, fmt: pct, def: 0.5 },
      { k: 'predelay', label: 'Pre-delay', min: 0, max: 200, fmt: ms, def: 20 },
      { k: 'damp', label: 'Damping', min: 0, max: 1, fmt: pct, def: 0.55 },
      { k: 'early', label: 'Early', min: 0, max: 1, fmt: pct, def: 0.5 },
      { k: 'width', label: 'Width', min: 0, max: 1, fmt: pct, def: 0.9 },
      { k: 'lowcut', label: 'Low Cut', min: 20, max: 1500, log: true, fmt: hz, def: 250 },
      { k: 'highcut', label: 'High Cut', min: 1500, max: 20000, log: true, fmt: hz, def: 9000 },
      { k: 'dry', label: 'Dry', min: 0, max: 1, fmt: pct, def: 1 },
      { k: 'wet', label: 'Wet', min: 0, max: 1, fmt: pct, def: 0.2 }
    ],
    chorus: [
      { k: 'rate', label: 'Rate', min: 0.05, max: 6, log: true, fmt: (v) => v.toFixed(2) + ' Гц', def: 0.8 },
      { k: 'depth', label: 'Depth', min: 0, max: 10, fmt: ms, def: 3 },
      { k: 'delay', label: 'Delay', min: 2, max: 40, fmt: ms, def: 12 },
      { k: 'feedback', label: 'Feedback', min: 0, max: 0.8, fmt: pct, def: 0 },
      { k: 'width', label: 'Width', min: 0, max: 1, fmt: pct, def: 1 },
      { k: 'lowcut', label: 'Low Cut', min: 20, max: 1500, log: true, fmt: hz, def: 200 },
      { k: 'mix', label: 'Mix', min: 0, max: 1, fmt: pct, def: 0.4 }
    ]
  };
  const GENERIC_NOTE = {
    delay: () => 'Время привязано к темпу проекта (' + st.bpm + ' BPM). На канале-возврате держи Dry 0%.',
    reverb: () => 'Decay — длина хвоста, Size — размер помещения (ранние отражения), Damping — насколько быстро гаснет верх.',
    chorus: () => 'Расширяет и «удваивает» голос. Для даблов: Rate 0.5–1 Гц, Depth 2–4 мс, Mix 30–50%.'
  };

  function field(label, control) { const f = el('label', 'plug-field'); f.append(label); f.appendChild(control); return f; }
  function selectOf(id, options, value, onChange) {
    const s = el('select'); s.id = id;
    options.forEach(([v, l]) => { const o = el('option', '', l); o.value = v; if (String(v) === String(value)) o.selected = true; s.appendChild(o); });
    s.onchange = () => onChange(s.value); return s;
  }
  function knobFor(i, k, spec, params) {
    return knob({ label: spec.label, min: spec.min, max: spec.max, log: spec.log, value: params[spec.k], def: spec.def,
      step: spec.step, fmt: spec.fmt, onInput: (v) => Vox.setFxParams(i, k, { [spec.k]: v }) });
  }

  function openPlugin(i, k) {
    const s = st.mixer[i].fx[k]; if (!s) return;
    const id = 'plug-' + i + '-' + k;
    const n = Object.keys(wins).length;
    if (s.type === 'shkafx') {
      const W = layer.clientWidth, H = layer.clientHeight, w = Math.min(1180, W);
      openWindow(id, {
        title: 'ShkaFX', sub: insertLabel(i) + ' · слот ' + (k + 1), w, h: Math.min(H, Math.round(880 * w / 1180) + 28),
        x: Math.max(0, (W - w) / 2), y: 0,
        build: (body, win) => { win.vcBridge = shkaBridge(body, i, k); },
        onClose: () => { const w2 = wins[id]; if (w2 && w2.vcBridge) w2.vcBridge.close(); }
      });
      return;
    }
    if (s.type === 'vocalchain') {
      const W = layer.clientWidth;
      openWindow(id, {
        title: 'VocalChain', sub: insertLabel(i) + ' · слот ' + (k + 1), w: Math.min(1060, W), h: 720,
        x: Math.max(0, (W - Math.min(1060, W)) / 2), y: 10,
        build: (body, win) => { win.vcBridge = vcBridge(body, i, k); },
        onClose: () => { const w = wins[id]; if (w && w.vcBridge) w.vcBridge.close(); }
      });
      return;
    }
    const sizes = { autotune: 520, delay: 470, reverb: 560, chorus: 470, eq: 640, clipper: 520 };
    openWindow(id, {
      title: Vox.FX[s.type].title, sub: insertLabel(i) + ' · слот ' + (k + 1),
      w: sizes[s.type] || 400, x: 240 + n * 24, y: 30 + n * 20,
      build: (body, win) => {
        if (s.type === 'autotune') buildAutotune(body, win, i, k);
        else if (s.type === 'eq') buildEQ(body, win, i, k);
        else if (s.type === 'clipper') buildClipper(body, win, i, k);
        else buildGeneric(body, i, k);
      },
      onClose: () => { if (atView && atView.id === id) atView = null; const w = wins[id]; if (w && w.onCloseExtra) w.onCloseExtra(); }
    });
  }

  function buildGeneric(body, i, k) {
    const s = st.mixer[i].fx[k], p = s.params;
    const wrap = el('div', 'plug'), row = el('div', 'plug-row');
    GENERIC[s.type].forEach((spec) => {
      if (spec.type === 'select') row.appendChild(field(spec.label, selectOf('p' + i + k + spec.k, spec.options, p[spec.k], (v) => Vox.setFxParams(i, k, { [spec.k]: spec.num ? +v : v }))));
      else row.appendChild(knobFor(i, k, spec, p).el);
    });
    wrap.appendChild(row);
    if (GENERIC_NOTE[s.type]) wrap.appendChild(el('div', 'plug-foot', GENERIC_NOTE[s.type]() + ' Двойной клик по ручке — значение по умолчанию.'));
    body.appendChild(wrap);
  }

  /* --- EQ: график, точки полос тянутся мышью или пальцем --- */
  const EQ_NAMES = { hp: 'Low Cut', ls: 'Low Shelf', pk: 'Bell', hs: 'High Shelf', lp: 'High Cut' };
  const EQ_FREQS = Float32Array.from({ length: 220 }, (_, i) => 20 * Math.pow(1000, i / 219));
  function buildEQ(body, win, i, k) {
    const s = st.mixer[i].fx[k], p = s.params;
    body.innerHTML = '';
    const wrap = el('div', 'plug eq');
    const graph = el('div', 'eq-graph'); const cv = el('canvas'); graph.appendChild(cv); wrap.appendChild(graph);
    const bandsRow = el('div', 'eq-bands');
    let sel = 2;
    const DB = 18, FMIN = 20, FMAX = 20000;
    const fx = (f, w) => Math.log(f / FMIN) / Math.log(FMAX / FMIN) * w;
    const xf = (x, w) => FMIN * Math.pow(FMAX / FMIN, clamp(x / w, 0, 1));
    const dy = (db, h) => h / 2 - db / DB * (h / 2 - 10);
    const yd = (y, h) => (h / 2 - y) / (h / 2 - 10) * DB;
    const css = () => getComputedStyle(document.documentElement);
    const push = () => { Vox.setFxParams(i, k, { bands: p.bands, out: p.out }); draw(); };
    function draw() {
      const dpr = window.devicePixelRatio || 1, w = graph.clientWidth, h = graph.clientHeight;
      if (!w || !h) return;
      cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const C = css(), line = C.getPropertyValue('--eq-grid').trim(), txt = C.getPropertyValue('--text-faint').trim();
      g.clearRect(0, 0, w, h);
      g.font = '10px ' + C.getPropertyValue('--font-mono'); g.fillStyle = txt; g.strokeStyle = line; g.lineWidth = 1;
      [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => { const x = Math.round(fx(f, w)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, h - 4); });
      [-12, -6, 0, 6, 12].forEach((d) => { const y = Math.round(dy(d, h)) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillText((d > 0 ? '+' : '') + d, 4, y - 3); });
      const r = Vox.eqResponse(p, EQ_FREQS);
      // выбранная полоса — заливкой, сумма — линией
      const acc = C.getPropertyValue('--accent').trim();
      if (p.bands[sel] && p.bands[sel].on !== false) {
        g.beginPath(); g.moveTo(0, dy(0, h));
        r.bands[sel].forEach((v, n) => g.lineTo(fx(EQ_FREQS[n], w), dy(clamp(v, -DB - 2, DB + 2), h)));
        g.lineTo(w, dy(0, h)); g.closePath(); g.fillStyle = C.getPropertyValue('--eq-fill').trim(); g.fill();
      }
      g.beginPath();
      r.total.forEach((v, n) => { const x = fx(EQ_FREQS[n], w), y = dy(clamp(v, -DB - 2, DB + 2), h); n ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.strokeStyle = acc; g.lineWidth = 2; g.stroke();
      p.bands.forEach((b, n) => {
        const x = fx(b.f, w), y = dy(b.t === 'hp' || b.t === 'lp' ? 0 : b.g, h);
        g.beginPath(); g.arc(x, y, n === sel ? 7 : 5.5, 0, Math.PI * 2);
        g.fillStyle = b.on === false ? C.getPropertyValue('--bg-inset').trim() : C.getPropertyValue('--eq-band-' + (n + 1)).trim() || acc;
        g.fill(); g.lineWidth = n === sel ? 2 : 1; g.strokeStyle = C.getPropertyValue('--text').trim(); g.stroke();
      });
    }
    // перетаскивание точек
    let drag = -1;
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, w = r.width, h = r.height;
      let best = -1, bd = 22;
      p.bands.forEach((b, n) => { const d = Math.hypot(fx(b.f, w) - x, dy(b.t === 'hp' || b.t === 'lp' ? 0 : b.g, h) - y); if (d < bd) { bd = d; best = n; } });
      if (best < 0) return;
      drag = best; sel = best; cv.setPointerCapture(e.pointerId); p.bands[best].on = true; renderBands(); draw(); e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0 || !cv.hasPointerCapture(e.pointerId)) return;
      const r = cv.getBoundingClientRect(), b = p.bands[drag];
      b.f = Math.round(xf(e.clientX - r.left, r.width));
      if (b.t !== 'hp' && b.t !== 'lp') b.g = Math.round(clamp(yd(e.clientY - r.top, r.height), -DB, DB) * 10) / 10;
      push(); syncBand(drag);
    });
    cv.addEventListener('pointerup', () => (drag = -1));
    cv.addEventListener('wheel', (e) => {
      const b = p.bands[sel]; if (!b) return; e.preventDefault();
      b.q = clamp(b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 18); push(); syncBand(sel);
    }, { passive: false });
    cv.addEventListener('dblclick', () => { const b = p.bands[sel]; if (b) { b.g = 0; push(); syncBand(sel); } });
    // ручки полос
    const bandUi = [];
    function syncBand(n) { const u = bandUi[n]; if (!u) return; const b = p.bands[n]; u.f.set(b.f); if (u.g) u.g.set(b.g); u.q.set(b.q); }
    function renderBands() { bandUi.forEach((u, n) => u.el.classList.toggle('sel', n === sel)); }
    p.bands.forEach((b, n) => {
      const card = el('div', 'eq-band'); card.style.setProperty('--band', 'var(--eq-band-' + (n + 1) + ')');
      const head = el('div', 'eq-band-head');
      const on = el('button', 'led' + (b.on === false ? ' off' : '')); on.setAttribute('aria-label', 'Вкл/выкл полосу ' + (n + 1)); on.title = 'Вкл/выкл полосу';
      on.onclick = (e) => { e.stopPropagation(); b.on = b.on === false; on.classList.toggle('off', b.on === false); push(); };
      head.append(on, el('span', '', EQ_NAMES[b.t]));
      card.appendChild(head);
      const u = { el: card };
      u.f = knob({ small: true, label: 'Freq', min: 20, max: 20000, log: true, value: b.f, def: b.f, fmt: hz, onInput: (v) => { b.f = Math.round(v); push(); } });
      card.appendChild(u.f.el);
      if (b.t !== 'hp' && b.t !== 'lp') { u.g = knob({ small: true, label: 'Gain', min: -DB, max: DB, value: b.g, def: 0, step: 0.1, fmt: dbf, onInput: (v) => { b.g = v; push(); } }); card.appendChild(u.g.el); }
      else {
        const sl = selectOf('eqSlope' + n, [[12, '12 дБ/окт'], [24, '24 дБ/окт']], b.slope || 12, (v) => { b.slope = +v; push(); });
        card.appendChild(sl);
      }
      u.q = knob({ small: true, label: 'Q', min: 0.1, max: 18, log: true, value: b.q, def: b.t === 'pk' ? 1 : 0.71, fmt: (v) => v.toFixed(2), onInput: (v) => { b.q = v; push(); } });
      card.appendChild(u.q.el);
      card.addEventListener('pointerdown', () => { sel = n; renderBands(); draw(); });
      bandUi.push(u); bandsRow.appendChild(card);
    });
    const outK = knob({ label: 'Output', min: -18, max: 18, value: p.out, def: 0, step: 0.1, fmt: dbf, onInput: (v) => { p.out = v; push(); } });
    const outCard = el('div', 'eq-band out'); outCard.appendChild(outK.el); bandsRow.appendChild(outCard);
    wrap.appendChild(bandsRow);
    wrap.appendChild(el('div', 'plug-foot', 'Тяни точки на графике: влево-вправо — частота, вверх-вниз — усиление, колёсико — ширина (Q). Двойной клик по графику — сбросить усиление выбранной полосы.'));
    body.appendChild(wrap);
    renderBands();
    const ro = new ResizeObserver(draw); ro.observe(graph);
    win.onCloseExtra = () => ro.disconnect();
    requestAnimationFrame(draw);
  }

  /* --- Soft Clipper: кривая и индикатор срезанного --- */
  function buildClipper(body, win, i, k) {
    const s = st.mixer[i].fx[k], p = s.params;
    body.innerHTML = '';
    const wrap = el('div', 'plug clipper');
    const top = el('div', 'clip-top');
    const graph = el('div', 'clip-graph'); const cv = el('canvas'); graph.appendChild(cv);
    const meter = el('div', 'clip-meter');
    const grBar = el('div', 'gr-bar'); const grFill = el('i'); grBar.appendChild(grFill);
    const grVal = el('div', 'gr-val', '0.0 дБ');
    meter.append(el('div', 'gr-label', 'Срезано'), grBar, grVal);
    top.append(graph, meter); wrap.appendChild(top);
    const row = el('div', 'plug-row');
    const upd = (key) => (v) => { Vox.setFxParams(i, k, { [key]: v }); draw(); };
    row.append(
      knob({ label: 'Drive', min: 0, max: 18, value: p.drive, def: 0, step: 0.1, fmt: dbf, onInput: upd('drive') }).el,
      knob({ label: 'Ceiling', min: -12, max: 0, value: p.ceiling, def: -0.3, step: 0.1, fmt: dbf, onInput: upd('ceiling') }).el,
      knob({ label: 'Softness', min: 0, max: 1, value: p.soft, def: 0.5, step: 0.01, fmt: pct, onInput: upd('soft') }).el,
      knob({ label: 'Output', min: -12, max: 6, value: p.out, def: 0, step: 0.1, fmt: dbf, onInput: upd('out') }).el
    );
    wrap.appendChild(row);
    wrap.appendChild(el('div', 'plug-foot', 'Срезает пики мягко, без хрипа, и даёт громкость без лимитера. Drive — сколько громкости добавить, Ceiling — потолок, выше которого сигнал не пройдёт, Softness — насколько плавно скругляется.'));
    body.appendChild(wrap);
    function draw() {
      const dpr = window.devicePixelRatio || 1, w = graph.clientWidth, h = graph.clientHeight; if (!w) return;
      cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const C = getComputedStyle(document.documentElement);
      g.clearRect(0, 0, w, h);
      // по осям: вход и выход в дБ от −24 до +6
      const toX = (db) => (db + 24) / 30 * w, toY = (db) => h - (db + 24) / 30 * h;
      g.strokeStyle = C.getPropertyValue('--eq-grid').trim(); g.lineWidth = 1;
      [-18, -12, -6, 0].forEach((d) => { g.beginPath(); g.moveTo(toX(d), 0); g.lineTo(toX(d), h); g.moveTo(0, toY(d)); g.lineTo(w, toY(d)); g.stroke(); });
      g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, h); g.lineTo(w, 0); g.stroke(); g.setLineDash([]);
      const curve = Vox.clipCurve(p), R = Vox.CLIP_R, drive = Math.pow(10, p.drive / 20), out = Math.pow(10, p.out / 20);
      g.beginPath();
      for (let x = 0; x <= w; x++) {
        const inDb = x / w * 30 - 24, a = Math.pow(10, inDb / 20) * drive;
        const u = clamp(a / R, -1, 1), idx = Math.round((u + 1) / 2 * (curve.length - 1));
        const y = Math.abs(curve[idx]) * out, yDb = 20 * Math.log10(Math.max(1e-6, y));
        x ? g.lineTo(x, toY(yDb)) : g.moveTo(x, toY(yDb));
      }
      g.strokeStyle = C.getPropertyValue('--accent').trim(); g.lineWidth = 2; g.stroke();
      g.fillStyle = C.getPropertyValue('--text-faint').trim(); g.font = '10px ' + C.getPropertyValue('--font-mono');
      g.fillText('вход →', w - 44, h - 5); g.fillText('выход', 4, 12);
    }
    // индикатор: разница пиков до и после клиппера
    const live = () => Vox.live && Vox.live[i] && Vox.live[i].fx[k];
    const buf = new Float32Array(1024); let hold = 0;
    const peak = (an) => { an.getFloatTimeDomainData(buf); let m = 0; for (let n = 0; n < buf.length; n++) { const v = Math.abs(buf[n]); if (v > m) m = v; } return m; };
    const timer = setInterval(() => {
      const f = live(); if (!f || !f.aIn) return;
      const a = peak(f.aIn), b = peak(f.aOut);
      const gr = a > 1e-4 && b > 1e-5 ? Math.max(0, 20 * Math.log10(a / b)) : 0;
      hold = Math.max(gr, hold - 0.4);
      grFill.style.height = clamp(hold / 12 * 100, 0, 100) + '%'; grVal.textContent = hold.toFixed(1) + ' дБ';
    }, 50);
    const ro = new ResizeObserver(draw); ro.observe(graph);
    win.onCloseExtra = () => { clearInterval(timer); ro.disconnect(); };
    requestAnimationFrame(draw);
  }

  /* --- Автотюн --- */
  let atView = null;
  const SCALE_OPTS = [['minor', 'Минор'], ['major', 'Мажор'], ['harmMinor', 'Гарм. минор'], ['pentaMinor', 'Пентатоника минор'], ['pentaMajor', 'Пентатоника мажор'], ['chromatic', 'Хроматика']];
  function noteName(m) { if (m < 0) return '—'; const r = Math.round(m); return Vox.NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); }

  function buildAutotune(body, win, i, k) {
    const s = st.mixer[i].fx[k], p = s.params, P = Vox.FX.autotune.presets;
    body.innerHTML = '';
    const wrap = el('div', 'plug');
    const disp = el('div', 'at-display');
    const note = el('div', 'at-note idle', '—');
    const right = el('div'); right.style.display = 'flex'; right.style.flexDirection = 'column'; right.style.gap = '8px';
    const bar = el('div', 'at-bar'); const fill = el('i'); bar.appendChild(fill);
    const cap = el('div', 'at-cap', 'Пой в микрофон с включённым мониторингом или включи дорожку с голосом');
    right.append(bar, cap); disp.append(note, right); wrap.appendChild(disp);

    const seg = el('div', 'seg');
    const knobs = {};
    const syncSeg = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === p.preset));
    Object.entries(P).forEach(([key, pr]) => {
      const b = el('button', '', pr.label); b.dataset.p = key;
      b.title = key === 'hard' ? 'Мгновенная коррекция, «роботизированный» звук (как Auto-Tune с Retune 0)' : key === 'light' ? 'Мягкая коррекция, длинные ноты и вибрато остаются живыми' : 'Заметная, но естественная коррекция';
      b.onclick = () => {
        const q = { preset: key, speed: pr.speed, amount: pr.amount, humanize: pr.humanize, flex: pr.flex };
        Vox.setFxParams(i, k, q);
        ['speed', 'amount', 'humanize', 'flex'].forEach((n) => knobs[n] && knobs[n].set(q[n]));
        syncSeg();
      };
      seg.appendChild(b);
    });
    const row1 = el('div', 'plug-row'); row1.appendChild(field('Пресет', seg));
    row1.appendChild(field('Тональность', selectOf('atKey' + i + k, Vox.NOTE_NAMES.map((n, idx) => [idx, n]), p.key, (v) => Vox.setFxParams(i, k, { key: +v }))));
    row1.appendChild(field('Лад', selectOf('atScale' + i + k, SCALE_OPTS, p.scale, (v) => Vox.setFxParams(i, k, { scale: v }))));
    const R = Vox.FX.autotune.ranges, sr = Vox.ctx ? Vox.ctx.sampleRate : 48000;
    const latEl = el('div', 'at-cap');
    const syncLat = () => (latEl.textContent = 'Задержка плагина ' + Math.round(Vox.FX.autotune.latency(p, sr) * 1000) + ' мс, при воспроизведении компенсируется');
    row1.appendChild(field('Тип голоса', selectOf('atRange' + i + k, Object.entries(R).map(([kk, r]) => [kk, r.label]), p.range || 'mid',
      (v) => { Vox.setFxParams(i, k, { range: v }); syncLat(); })));
    wrap.appendChild(row1);

    const custom = (name) => (v) => { Vox.setFxParams(i, k, { [name]: v, preset: 'custom' }); syncSeg(); };
    const row2 = el('div', 'plug-row at-knobs');
    const spec = [
      ['speed', 'Retune Speed', 0, 400, 20, 1, (v) => Math.round(v) + ' мс', 'Как быстро голос притягивается к ноте. 0 — мгновенно, «роботизированно»'],
      ['humanize', 'Humanize', 0, 100, 0, 1, (v) => Math.round(v), 'На длинных нотах коррекция мягче: вибрато и живость остаются'],
      ['flex', 'Flex-Tune', 0, 100, 0, 1, (v) => Math.round(v), 'Тянет к ноте только рядом с ней, переходы и подъезды остаются натуральными'],
      ['amount', 'Сила', 0, 1, 1, 0.01, pct, 'Насколько сильно подтягивать: 100% — до самой ноты'],
      ['tracking', 'Tracking', 0, 100, 50, 1, (v) => Math.round(v), 'Чувствительность определения ноты. Больше — ловит хриплый и шумный голос'],
      ['transpose', 'Transpose', -12, 12, 0, 1, (v) => (v > 0 ? '+' : '') + Math.round(v) + ' пт', 'Сдвиг всего голоса на полутоны']
    ];
    spec.forEach(([name, label, mn, mx, def, step, fmt, tip]) => {
      const kn = knob({ label, min: mn, max: mx, value: p[name] == null ? def : p[name], def, step, fmt,
        onInput: name === 'tracking' || name === 'transpose' ? (v) => Vox.setFxParams(i, k, { [name]: v }) : custom(name) });
      kn.el.title = tip; knobs[name] = kn; row2.appendChild(kn.el);
    });
    wrap.appendChild(row2);
    syncLat(); wrap.appendChild(latEl);
    wrap.appendChild(el('div', 'plug-foot', '«Жёсткий» повторяет Auto-Tune Pro в режиме Classic (Retune 0, Humanize 0, Flex-Tune 0). Тип голоса выбирай по самой низкой ноте: чем выше, тем меньше задержка. Задержку слышно только при живом мониторинге, записанные дорожки играют ровно.'));
    body.appendChild(wrap);
    syncSeg();
    atView = { id: 'plug-' + i + '-' + k, i, k, note, fill, cap };
  }
  Vox.on('autotune-report', (r) => {
    if (!atView || atView.i !== r.insert || atView.k !== r.slot) return;
    if (!r.voiced) { atView.note.classList.add('idle'); return; }
    atView.note.classList.remove('idle');
    atView.note.textContent = noteName(r.note);
    const cents = Math.round(r.corr * 100);
    const w = clamp(Math.abs(r.corr) * 100, 0, 50);
    atView.fill.style.width = w + '%'; atView.fill.style.left = (r.corr >= 0 ? 50 : 50 - w) + '%';
    atView.cap.textContent = 'Вход ' + noteName(r.midi) + ' ' + (Math.round((r.midi - Math.round(r.midi)) * 100)) + ' ц → коррекция ' + (cents > 0 ? '+' : '') + cents + ' ц';
  });

  /* --- VocalChain: родной интерфейс плагина (plugins/vocalchain/ui) в окне студии ---
     Окно общается со студией тем же протоколом, что и в FL Studio (window.__JUCE__.backend). */
  const vcBridges = new Set();
  window.addEventListener('message', (e) => {
    const d = e.data; if (!d || !d.vcBridge) return;
    vcBridges.forEach((b) => { if (b.frame.contentWindow === e.source) b.handle(d.ev, d.obj || {}); });
  });
  const VC_FREQS = Float32Array.from({ length: 160 }, (_, i) => 20 * Math.pow(1000, i / 159));
  function vcSkew(d) { if (!d.centre || d.centre <= d.min || d.centre >= d.max) return 1; return Math.log(0.5) / Math.log((d.centre - d.min) / (d.max - d.min)); }
  function vcToNorm(d, v) {
    const p = clamp((v - d.min) / (d.max - d.min || 1), 0, 1);
    if (d.kind !== 'float') return p;
    const sk = vcSkew(d); return sk === 1 ? p : Math.pow(p, sk);
  }
  function vcFromNorm(d, n) {
    n = clamp(n, 0, 1);
    if (d.kind !== 'float') return Math.round(d.min + n * (d.max - d.min));
    const sk = vcSkew(d), p = sk === 1 ? n : (n > 0 ? Math.exp(Math.log(n) / sk) : 0);
    return d.min + (d.max - d.min) * p;
  }
  function vcText(d, v) { // как formatValue в PluginProcessor.cpp
    if (d.kind === 'bool') return v > 0.5 ? 'On' : 'Off';
    if (d.kind === 'choice') return d.choices[Math.round(v)] || '';
    const u = d.unit;
    if (u === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : v.toFixed(v < 100 ? 1 : 0) + ' Hz';
    if (u === 'dB') return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) < 10 ? 2 : 1) + ' dB';
    if (u === '%') return Math.round(v) + ' %';
    if (u === 'ms') return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + ' ms';
    if (u === 's') return v.toFixed(2) + ' s';
    if (u === ':1') return v >= 39.5 && d.id === 'ssl_ratio' ? '∞' : v.toFixed(2) + ':1';
    if (d.id === 'air_mid' || d.id === 'air_high') return String(Math.round(v));
    if (['fet_att', 'fet_rel', 'fet_in', 'fet_out'].includes(d.id)) return v.toFixed(1);
    return v.toFixed(2);
  }
  function vcSrcdoc() {
    const ui = window.VC.ui;
    const shim = '(function(){var L={};window.__JUCE__={backend:{' +
      'addEventListener:function(ev,fn){(L[ev]=L[ev]||[]).push(fn);return [ev,fn];},removeEventListener:function(){},' +
      'emitEvent:function(ev,obj){parent.postMessage({vcBridge:true,ev:ev,obj:obj||{}},"*");}}};' +
      'window.addEventListener("message",function(e){var d=e.data;if(d&&d.vcBridgeOut)(L[d.ev]||[]).slice().forEach(function(f){f(d.obj);});});})();';
    const safe = (t) => t.replace(/<\/script/gi, '<\\/script');
    return ui.html
      .replace('<link rel="stylesheet" href="style.css">', () => '<style>' + ui.css + '</style>')
      .replace('<script src="mock-params.js"></script>', () => '<script>' + shim + '</script>')
      .replace('<script src="app.js"></script>', () => '<script>' + safe(ui.js) + '</script>');
  }

  function vcBridge(body, i, k) {
    const D = window.VC.data.params;
    const idxOf = new Map(D.map((d, n) => [d.id, n]));
    const slotP = () => { const s = st.mixer[i].fx[k]; return s && s.type === 'vocalchain' ? s.params : null; };
    const frame = el('iframe', 'plug-frame'); frame.title = 'Интерфейс VocalChain';
    const box = el('div', 'plug-frame-box'); box.appendChild(frame);
    frame.srcdoc = vcSrcdoc(); body.appendChild(box);
    // на узком экране интерфейс плагина целиком уменьшается под ширину
    const fit = () => {
      const W = body.clientWidth, mob = Vox.isMobile && Vox.isMobile(), base = mob ? 620 : 1060;
      if (W && W < base) {
        const k = W / base;
        let hgt = body.clientHeight / k;
        try { const d = frame.contentDocument; if (mob && d && d.documentElement) hgt = Math.max(hgt, d.documentElement.scrollHeight); } catch (e) {}
        frame.style.width = base + 'px'; frame.style.height = hgt + 'px'; frame.style.minHeight = '0';
        frame.style.transform = 'scale(' + k + ')'; frame.style.transformOrigin = '0 0';
        frame.parentNode.style.height = hgt * k + 'px';
        body.style.overflowX = 'hidden'; body.style.overflowY = mob ? 'auto' : 'hidden';
      } else { frame.style.width = ''; frame.style.height = ''; frame.style.transform = ''; frame.style.minHeight = ''; frame.parentNode.style.height = ''; body.style.overflow = ''; }
    };
    frame.addEventListener('load', () => { setTimeout(fit, 300); setTimeout(fit, 1200); });
    const fro = new ResizeObserver(fit); fro.observe(body);
    const send = (ev, obj) => { try { frame.contentWindow.postMessage({ vcBridgeOut: true, ev, obj }, '*'); } catch (e) {} };
    const sr = () => (Vox.ctx ? Vox.ctx.sampleRate : 48000);
    const change = (n, v) => { const d = D[n]; return { id: d.id, norm: vcToNorm(d, v), value: v, text: vcText(d, v) }; };
    let eqDirty = true, lastDyn = null, tick = 0;
    function sendEq() {
      const p = slotP(); if (!p) return;
      const r = Vox.vcEqCurves(p.values, lastDyn, VC_FREQS, sr()); if (r) send('vc_eq', r);
      eqDirty = false;
    }
    function setVal(n, v, notify) {
      const p = slotP(); if (!p || n == null) return;
      const d = D[n]; v = clamp(v, d.min, d.max); if (d.kind !== 'float') v = Math.round(v);
      Vox.vcSetOne(i, k, n, v); Vox.history.schedule();
      if (d.group === 'EQ 1' || d.group === 'EQ 2') eqDirty = true;
      if (notify !== false) send('vc_values', { changes: [change(n, v)] });
    }
    function setType(type, variant) {
      Vox.vcSetType(i, k, type, variant); Vox.history.schedule();
      const p = slotP(); if (!p) return;
      send('vc_values', { changes: p.values.map((v, n) => change(n, v)) });
      eqDirty = true;
    }
    const b = {
      frame,
      handle(ev, o) {
        const p = slotP(); if (!p) return;
        if (ev === 'vc_ready') {
          send('vc_init', {
            params: D.map((d, n) => Object.assign({}, d, change(n, p.values[n]), { defNorm: vcToNorm(d, d.def) })),
            eqFreqs: Array.from(VC_FREQS), sampleRate: sr(), latencyMs: Vox.vcLatency(sr()) * 1000, version: window.VC.version + ' web'
          });
          eqDirty = true; sendEq();
        } else if (ev === 'vc_set') { const n = idxOf.get(o.id); if (n != null) setVal(n, vcFromNorm(D[n], +o.norm)); }
        else if (ev === 'vc_setValue') { const n = idxOf.get(o.id); if (n != null) setVal(n, +o.value); }
        else if (ev === 'vc_default') { const n = idxOf.get(o.id); if (n != null) setVal(n, D[n].def); }
        else if (ev === 'vc_resetAll') setType(p.type, p.variant);
        else if (ev === 'vc_setType') {
          const t = clamp(o.type | 0, 0, window.VC.data.types.length - 1);
          if (window.VC.data.types[t].ready) setType(t, o.variant | 0);
        }
      },
      onMeters(r) {
        if (r.insert !== i || r.slot !== k) return;
        const m = r.m;
        send('vc_meters', { in: m[0], out: m[1], nsVoice: m[2], ds: m[3], sslComp: m[4], sslGate: m[5], rc: m[6], fet: m[7], vox: m[8], voxGate: m[9], bpm: st.bpm });
        lastDyn = r.dyn;
        const p = slotP();
        const dynOn = p && D.some((d, n) => /_dyn$/.test(d.id) && p.values[n] > 0.5);
        if ((++tick % 2) === 0 && (eqDirty || dynOn)) sendEq();
      },
      idle() { if (eqDirty) sendEq(); },
      close() { vcBridges.delete(b); fro.disconnect(); }
    };
    vcBridges.add(b);
    return b;
  }
  /* --- ShkaFX: родной интерфейс плагина, протокол как в UI_API.md плагина --- */
  function shkaSrcdoc() {
    const ui = window.SHKA.ui;
    const shim = '(function(){var L={};window.__JUCE__={backend:{' +
      'addEventListener:function(ev,fn){(L[ev]=L[ev]||[]).push(fn);return [ev,fn];},removeEventListener:function(){},' +
      'emitEvent:function(ev,obj){parent.postMessage({vcBridge:true,ev:ev,obj:obj||{}},"*");}}};' +
      'window.addEventListener("message",function(e){var d=e.data;if(d&&d.vcBridgeOut)(L[d.ev]||[]).slice().forEach(function(f){f(d.obj);});});})();';
    const safe = (t) => t.replace(/<\/script/gi, '<\\/script');
    return ui.html
      .replace('<link rel="stylesheet" href="style.css">', () => '<style>' + ui.css + '</style>')
      .replace('<script src="mock-params.js"></script>', () => '<script>' + shim + '</script>')
      .replace('<script src="app.js"></script>', () => '<script>' + safe(ui.js) + '</script>');
  }
  function shkaText(d, v) { // как formatValue в PluginProcessor.cpp ShkaFX
    if (d.kind === 'bool') return v > 0.5 ? 'On' : 'Off';
    if (d.kind === 'choice') return d.choices[Math.round(v)] || '';
    const u = d.unit;
    if (u === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : v.toFixed(v < 100 ? 1 : 0) + ' Hz';
    if (u === 'dB') return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) < 10 ? 2 : 1) + ' dB';
    if (u === '%') return v.toFixed(1) + ' %';
    if (u === 'ms') return v.toFixed(v < 10 ? 2 : 1) + ' ms';
    if (u === 's') return v.toFixed(2) + ' s';
    if (u === 'x') return v.toFixed(2) + 'x';
    if (u === 'BPM') return v.toFixed(1);
    return v.toFixed(2);
  }
  function wav24(L, R, sr) {
    const n = L.length, bytes = n * 6, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    const w = (o, t) => { for (let q = 0; q < t.length; q++) v.setUint8(o + q, t.charCodeAt(q)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true);
    w(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let q = 0; q < n; q++) for (const ch of [L, R]) {
      const x = Math.round(Math.max(-1, Math.min(1, ch[q])) * 8388607);
      v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3;
    }
    return new Uint8Array(buf);
  }

  function shkaBridge(body, i, k) {
    const D = Vox.shkaParams, idxOf = new Map(D.map((d, n) => [d.id, n]));
    const slotP = () => { const s = st.mixer[i].fx[k]; return s && s.type === 'shkafx' ? s.params : null; };
    const host = Vox.shkaHost(slotP());
    const frame = el('iframe', 'plug-frame'); frame.title = 'Интерфейс ShkaFX';
    const box = el('div', 'plug-frame-box'); box.appendChild(frame);
    frame.srcdoc = shkaSrcdoc(); body.appendChild(box);
    const fit = () => {
      const W = body.clientWidth, base = 1180;
      if (W && W < base) {
        const kk = W / base, hgt = Math.max(880, body.clientHeight / kk);
        frame.style.width = base + 'px'; frame.style.height = hgt + 'px'; frame.style.minHeight = '0';
        frame.style.transform = 'scale(' + kk + ')'; frame.style.transformOrigin = '0 0'; box.style.height = hgt * kk + 'px';
        body.style.overflowX = 'hidden'; body.style.overflowY = Vox.isMobile() ? 'auto' : 'hidden';
      } else { frame.style.width = ''; frame.style.height = ''; frame.style.transform = ''; frame.style.minHeight = '880px'; box.style.height = ''; body.style.overflow = ''; }
    };
    const fro = new ResizeObserver(fit); fro.observe(body);
    const send = (ev, obj) => { try { frame.contentWindow.postMessage({ vcBridgeOut: true, ev, obj }, '*'); } catch (e) {} };
    const sr = () => (Vox.ctx ? Vox.ctx.sampleRate : 48000);
    const val = (id) => { const p = slotP(); const n = idxOf.get(id); return p && n != null ? p.values[n] : 0; };
    const bpmNow = () => (val('bpm_src') > 0.5 ? val('bpm') : st.bpm);
    const change = (n, v) => { const d = D[n]; return { id: d.id, norm: vcToNorm(d, v), value: v, text: shkaText(d, v) }; };
    const notice = (type, text) => send('lf_notice', { type, text, path: '' });
    const call = (fn, ...args) => host.ready.then(() => host.call('call', { fn, args }));

    // ---- отмена внутри плагина (как в VST): ручки + снимок выделений ----
    host.undo = host.undo || []; host.redo = host.redo || []; host.uKey = host.uKey || ''; host.uTime = host.uTime || 0;
    const undoState = () => send('lf_undoState', { canUndo: host.undo.length > 0, canRedo: host.redo.length > 0 });
    const capture = () => ({ values: slotP().values.slice(), snap: call('shka_snap') });
    function checkpoint(key, coalesce, paramId) {
      if (paramId === 'dla_throw' || paramId === 'dlb_throw') return;
      const now = Date.now();
      if (coalesce && key === host.uKey && now - host.uTime < 1500) { host.uTime = now; return; }
      host.uKey = key; host.uTime = now;
      host.undo.push(capture());
      if (host.undo.length > 60) host.undo.shift().snap.then((id) => call('shka_free_snap', id));
      host.redo.forEach((e) => e.snap.then((id) => call('shka_free_snap', id))); host.redo = [];
      undoState();
    }
    async function undoRedo(what) {
      const from = what === 'undo' ? host.undo : host.redo, to = what === 'undo' ? host.redo : host.undo;
      if (!from.length) { undoState(); return; }
      to.push(capture());
      const e = from.pop();
      Vox.shkaSetAll(i, k, e.values);
      call('shka_restore', await e.snap);
      host.uKey = '';
      send('vc_values', { changes: e.values.map((v, n) => change(n, v)) });
      send('lf_restored', { what, canUndo: host.undo.length > 0, canRedo: host.redo.length > 0 });
      Vox.history.schedule();
    }
    function setVal(n, v) {
      const d = D[n]; v = clamp(v, d.min, d.max); if (d.kind !== 'float') v = Math.round(v);
      Vox.shkaSetOne(i, k, n, v); Vox.history.schedule();
      send('vc_values', { changes: [change(n, v)] });
    }
    async function sendRegionVals(id) { const vals = await host.call('regionVals', { id }); send('lf_regionVals', { id, vals }); }
    // ---- свой файл ----
    let dropName = '', dropParts = [];
    async function loadFile(file, keepRegions) {
      try {
        await Vox.init();
        host.busy = true; pushRegions();
        const ab = await Vox.ctx.decodeAudioData(await file.arrayBuffer());
        const L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
        await host.call('loadSource', { L, R, name: file.name || 'vocal.wav', keepRegions });
        notice('loaded', file.name || 'vocal.wav');
      } catch (e) { notice('error', "Can't open the file (use WAV, MP3, FLAC or OGG): " + (file.name || '')); }
      host.busy = false; pushRegions();
    }
    function pushRegions(r) {
      const R = r || host.regions; if (!R) return;
      send('lf_regions', Object.assign({}, R, { busy: !!host.busy }));
    }
    // ---- прослушивание ----
    async function preview(from) {
      if (!host.fileMode && st.playing) return; // песня уже играет — слушаем её
      await Vox.resume();
      const s0 = Math.round(Math.max(-120, from) * sr());
      const rq = { includeVocal: true, alignToBar: true, bpm: bpmNow() };
      if (!host.fileMode) { rq.rangeStart = Math.max(0, s0 - 2 * sr()); rq.rangeEnd = s0 + 90 * sr(); }
      const res = await host.call('render', rq);
      if (!res.ok) { notice('error', res.error || 'Nothing to play yet'); return; }
      const n = res.fxL.length, l = new Float32Array(n), r = new Float32Array(n);
      for (let q = 0; q < n; q++) { l[q] = res.fxL[q] + (res.voxL ? res.voxL[q] || 0 : 0); r[q] = res.fxR[q] + (res.voxR ? res.voxR[q] || 0 : 0); }
      Vox.shkaPreview(i, k, { start: res.start, l, r }, s0);
    }
    // ---- сохранение в WAV ----
    async function doExport(job) {
      host.busy = true; pushRegions();
      const rate = sr(), bpm = Math.max(1, bpmNow()), beatS = 60 / bpm * rate, files = [];
      const barBeat = (sec) => { const beats = Math.floor(sec / (60 / bpm) + 1e-6), bar = Math.floor(beats / 4); return (bar + 1) + '.' + (beats - bar * 4 + 1); };
      try {
        const R = host.regions ? host.regions.regions : [];
        if (job.regionId > 0 || !job.timeline) {
          const cnt = [0, 0, 0];
          for (const ri of R) {
            const num = ++cnt[ri.type];
            if (job.regionId > 0 && ri.id !== job.regionId) continue;
            if (ri.status !== 1) continue;
            const res = await host.call('render', { onlyRegion: ri.id, bpm });
            if (!res.ok) throw new Error(res.error);
            let end = res.fxL.length; while (end > 0 && Math.abs(res.fxL[end - 1]) < 3e-5 && Math.abs(res.fxR[end - 1]) < 3e-5) end--;
            end = Math.min(res.fxL.length, end + Math.round(0.01 * rate));
            let L = res.fxL.subarray(0, end), Rr = res.fxR.subarray(0, end), startSec = res.start / rate, barsBefore = 0;
            if (res.start !== 0) {
              const grid = res.start > 0 ? beatS : 4 * beatS, snapped = Math.floor(res.start / grid) * grid;
              const pad = Math.max(0, res.start - Math.round(snapped));
              const l2 = new Float32Array(pad + end), r2 = new Float32Array(pad + end); l2.set(L, pad); r2.set(Rr, pad); L = l2; Rr = r2;
              startSec = snapped / rate; if (snapped < 0) barsBefore = Math.round(-snapped / (4 * beatS));
            }
            const kind = ['Tail', 'Delay A', 'Delay B'][ri.type];
            const where = barsBefore > 0 ? barsBefore + (barsBefore === 1 ? ' bar before start' : ' bars before start') : 'bar ' + barBeat(startSec);
            files.push({ name: kind + ' ' + String(num).padStart(2, '0') + ' — ' + where + '.wav', L, R: Rr });
          }
        } else {
          const res = await host.call('render', { includeVocal: job.withVocal, alignToBar: host.fileMode, bpm });
          if (!res.ok) throw new Error(res.error);
          if (job.withVocal && res.voxL) for (let q = 0; q < res.fxL.length; q++) { res.fxL[q] += res.voxL[q]; res.fxR[q] += res.voxR[q]; }
          const name = host.fileMode ? (job.withVocal ? 'Vocal + FX' : 'FX only') : (job.withVocal ? 'Vocal + FX — from project start' : 'All FX — from project start');
          files.push({ name: name + '.wav', L: res.fxL, R: res.fxR });
        }
        if (!files.length) throw new Error('Nothing to save: no ready tails or delay regions');
        // каждый файл ещё и в «Аудио в проекте» студии — его можно сразу поставить на дорожку
        files.forEach((f) => {
          const ab = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, f.L.length), sampleRate: rate });
          ab.copyToChannel(Float32Array.from(f.L), 0); ab.copyToChannel(Float32Array.from(f.R), 1);
          Vox.addBuffer(ab, 'ShkaFX ' + f.name.replace(/\.wav$/, ''));
        });
        const blobs = files.map((f) => ({ name: f.name, data: wav24(f.L, f.R, rate) }));
        if (blobs.length === 1) await Vox.saveBlob(blobs[0].name, new Blob([blobs[0].data], { type: 'audio/wav' }));
        else await Vox.saveBlob('ShkaFX export.zip', Vox.makeZip(blobs));
        notice('exported', 'Files saved: ' + files.length + '. They are also in WOK Studio → Audio in project');
      } catch (e) { notice('error', e.message || String(e)); }
      host.busy = false; pushRegions();
    }

    const H = {
      vc_ready() {
        const p = slotP();
        send('vc_init', { params: D.map((d, n) => Object.assign({}, d, change(n, p.values[n]), { defNorm: vcToNorm(d, d.def) })), sampleRate: sr(), version: window.SHKA.version + ' web' });
        send('lf_license', { licensed: true, machine: '', name: 'WOK Studio', expires: '', daysLeft: -1, error: '' });
        host.ready.then(async () => { pushRegions(host.regions || await host.call('regions')); });
        undoState();
      },
      vc_set(o) { const n = idxOf.get(o.id); if (n == null) return; checkpoint('p:' + o.id, true, o.id); setVal(n, vcFromNorm(D[n], +o.norm)); },
      vc_setValue(o) { const n = idxOf.get(o.id); if (n == null) return; checkpoint('p:' + o.id, true, o.id); setVal(n, +o.value); },
      vc_default(o) { const n = idxOf.get(o.id); if (n == null) return; checkpoint('def:' + o.id, false, o.id); setVal(n, D[n].def); },
      vc_resetAll() { checkpoint('resetAll', false); D.forEach((d, n) => setVal(n, d.def)); },
      lf_resetKnobs(o) {
        checkpoint('resetKnobs', false);
        const id = +o.regionId || 0;
        if (id > 0) call('shka_reset_region_values', id, 0).then(() => sendRegionVals(id));
        else { D.forEach((d, n) => setVal(n, d.def)); call('shka_reset_region_values', 0, 1); }
      },
      lf_addRegion(o) { checkpoint('add', false); call('shka_add_region', +o.start, +o.end, clamp(+o.type | 0, 0, 2)); },
      lf_setRegionProps(o) { checkpoint('props:' + o.id, true); call('shka_set_region_props', +o.id, +o.gainDb, o.pan ? 1 : 0); },
      lf_setRegionParam(o) { checkpoint('rp:' + o.id + ':' + o.index, true); call('shka_set_region_param', +o.id, +o.index, +o.value); },
      lf_getRegionVals(o) { sendRegionVals(+o.id); },
      lf_applyAll() { checkpoint('applyAll', false); call('shka_apply_all'); },
      lf_setRegionFades(o) { checkpoint('fades', false); call('shka_set_region_fades', +o.id, +o.fadeIn, +o.fadeOut); },
      lf_updateRegion(o) { checkpoint('move', false); call('shka_update_region', +o.id, +o.start, +o.end); },
      lf_removeRegion(o) { checkpoint('remove', false); call('shka_remove_region', +o.id); },
      lf_clearRegions() { checkpoint('clear', false); call('shka_clear_regions'); },
      lf_clearCapture() { call('shka_clear_capture'); },
      lf_undo() { undoRedo('undo'); },
      lf_redo() { undoRedo('redo'); },
      async lf_peaks(o) {
        const cols = clamp(+o.columns | 0, 1, 4000);
        const peaks = await host.ready.then(() => host.call('peaks', { start: +o.start, end: +o.end, columns: cols }));
        send('lf_peaks', { reqId: o.reqId || 0, start: +o.start, end: +o.end, peaks });
      },
      lf_loadFile(o) {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.aif,.aiff';
        inp.onchange = () => { if (inp.files[0]) loadFile(inp.files[0], !!o.keepRegions); };
        inp.click();
      },
      lf_dropBegin(o) { dropName = o.name || 'vocal.wav'; dropParts = []; },
      lf_dropChunk(o) { dropParts.push(Vox.b64ToBytes(o.data || '')); },
      lf_dropEnd() { const f = new File(dropParts, dropName); dropParts = []; loadFile(f, false); },
      lf_useProject() { Vox.shkaPreviewStop(i, k); call('shka_use_project').then(() => notice('project', 'Back to project audio')); },
      lf_preview(o) { if (o.action === 'play') preview(+o.from || 0); else Vox.shkaPreviewStop(i, k); },
      lf_export(o) { doExport({ regionId: +o.regionId || 0, timeline: !!o.timeline, withVocal: !!o.withVocal }); },
      lf_openFolder() { notice('project', 'In the browser, exported files go to your Downloads folder'); },
      lf_copy(o) { try { navigator.clipboard.writeText(o.text || ''); } catch (e) {} }
    };
    const listener = (type, data) => {
      if (type === 'regions') pushRegions(data);
      else if (type === 'meters') send('vc_meters', Object.assign({}, data, { hostPlaying: st.playing, bpm: bpmNow(), hostBpm: st.bpm, throwA: val('dla_throw'), throwB: val('dlb_throw') }));
    };
    host.listeners.add(listener);
    const b = {
      frame,
      handle(ev, o) { if (H[ev]) H[ev](o); },
      onMeters() {}, idle() {},
      close() { vcBridges.delete(b); host.listeners.delete(listener); fro.disconnect(); }
    };
    vcBridges.add(b);
    return b;
  }

  Vox.on('vc-meters', (r) => vcBridges.forEach((b) => b.onMeters(r)));
  // если звук не играет, индикаторы не приходят — EQ всё равно обновляем
  setInterval(() => vcBridges.forEach((b) => b.idle()), 120);

  /* ------------------------------ открытие окон ------------------------------ */
  const OPENERS = {
    rack: () => {
      const W = layer.clientWidth;
      openWindow('rack', { title: 'Channel Rack', sub: 'Паттерн 1', w: 600, x: W - 610, y: 40, build: buildRack });
    },
    mixer: () => {
      const W = layer.clientWidth, H = layer.clientHeight;
      const w = Math.min(980, W - 230);
      openWindow('mixer', { title: 'Микшер', w: Math.max(320, w), h: 452, x: Math.max(0, W - Math.max(320, w) - 10), y: Math.max(0, H - 462), build: () => {} });
      renderMixer();
    }
  };

  /* ------------------------------ АНИМАЦИЯ: курсор, LCD, индикаторы ------------------------------ */
  const playhead = $('playhead'), lcd = $('lcdTime');
  const mm = $('masterMeter'), micM = $('micMeter');
  const tdBuf = new Float32Array(512);
  const levels = {};
  function peakOf(an) { an.getFloatTimeDomainData(tdBuf); let m = 0; for (let i = 0; i < tdBuf.length; i++) { const v = Math.abs(tdBuf[i]); if (v > m) m = v; } return m; }
  function smooth(key, v) { const o = levels[key] || 0; const n = v > o ? v : o * 0.9; levels[key] = n; return n; }
  const meterColors = {};
  function meterColor(name) { return meterColors[name] || (meterColors[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim()); }
  function levelToFrac(v) { if (v <= 0) return 0; const db = 20 * Math.log10(v); return clamp((db + 60) / 63, 0, 1); }
  function drawBar(g, x, y, w, h, frac, vertical) {
    const segs = [[0, 0.75, '--meter-lo'], [0.75, 0.92, '--meter-mid'], [0.92, 1, '--meter-hi']];
    segs.forEach(([a, b, c]) => {
      if (frac <= a) return; const e = Math.min(frac, b);
      g.fillStyle = meterColor(c);
      if (vertical) g.fillRect(x, y + h - e * h, w, (e - a) * h);
      else g.fillRect(x + a * w, y, (e - a) * w, h);
    });
  }
  let lastStep = -1;
  function frame() {
    const beat = Vox.currentBeat();
    playhead.style.left = beat * ppb + 'px';
    if (st.playing) {
      const x = beat * ppb, sl = scroller.scrollLeft, vw = scroller.clientWidth;
      if (x > sl + vw - 60 || x < sl) scroller.scrollLeft = Math.max(0, x - 80);
    }
    const bar = Math.floor(beat / 4) + 1, bt = Math.floor(beat % 4) + 1, sx = Math.floor((beat * 4) % 4) + 1;
    lcd.textContent = bar + ':' + bt + ':' + String(sx).padStart(2, '0');

    const step = st.playing ? Math.floor(beat * 4) % 16 : -1;
    if (step !== lastStep) {
      rackSteps.forEach((arr) => { if (lastStep >= 0 && arr[lastStep]) arr[lastStep].classList.remove('now'); if (step >= 0 && arr[step]) arr[step].classList.add('now'); });
      lastStep = step;
    }

    if (Vox.live && Vox.ctx.state === 'running') {
      // мастер
      const L = smooth('mL', peakOf(Vox.live[0].aL)), R = smooth('mR', peakOf(Vox.live[0].aR));
      const g = mm.getContext('2d'); g.clearRect(0, 0, mm.width, mm.height);
      drawBar(g, 0, 0, mm.width, 6, levelToFrac(L), false); drawBar(g, 0, 8, mm.width, 6, levelToFrac(R), false);
      // каналы микшера
      if (wins.mixer) mixerMeters.forEach((c, i) => {
        if (!c || !Vox.live[i]) return;
        const l = smooth('l' + i, peakOf(Vox.live[i].aL)), r = smooth('r' + i, peakOf(Vox.live[i].aR));
        const cg = c.getContext('2d'); cg.clearRect(0, 0, c.width, c.height);
        drawBar(cg, 0, 0, 5, c.height, levelToFrac(l), true); drawBar(cg, 7, 0, 5, c.height, levelToFrac(r), true);
      });
      if (Vox.micAnalyser) {
        const v = smooth('mic', peakOf(Vox.micAnalyser)); const gg = micM.getContext('2d');
        gg.clearRect(0, 0, micM.width, micM.height); drawBar(gg, 0, 0, micM.width, micM.height, levelToFrac(v), false);
      }
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------ ПРОЕКТ: меню, отмена, окна ------------------------------ */
  const menu = $('projMenu'), menuBtn = $('btnProject');
  const setMenu = (open) => {
    menu.hidden = !open; menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { $('projNameInput').value = st.projectName; }
  };
  menuBtn.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) setMenu(false); });
  $('projNameInput').addEventListener('input', (e) => { st.projectName = e.target.value.trim() || 'Новый проект'; $('projName').textContent = st.projectName; });
  $('projNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') setMenu(false); });
  $('mSave').onclick = () => { setMenu(false); Vox.saveProject(); };
  $('mOpen').onclick = () => { setMenu(false); $('projOpenInput').click(); };
  $('mExport').onclick = () => { setMenu(false); $('btnExport').click(); };
  $('mNew').onclick = async () => {
    setMenu(false);
    const ok = await confirmBox('Начать новый проект? Несохранённые изменения пропадут. Сохранить текущий можно через «Сохранить проект».', 'Новый проект');
    if (ok) Vox.newProject();
  };
  $('projOpenInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) Vox.openProjectFile(f); e.target.value = ''; });
  $('btnUndo').onclick = () => Vox.history.undo();
  $('btnRedo').onclick = () => Vox.history.redo();
  Vox.on('history', () => {
    const H = Vox.history;
    $('btnUndo').disabled = H.idx <= 0; $('btnRedo').disabled = H.idx >= H.stack.length - 1;
  });
  // перетаскивание файла проекта в окно
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (e.target.closest && e.target.closest('.lane')) return;
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && /\.zip$|\.voxdesk$|\.wok$/i.test(f.name)) Vox.openProjectFile(f);
    else if (f) Vox.importFile(f, st.selectedTrack, Math.floor(st.posBeats));
  });

  // окно подтверждения внутри страницы (системные окна в предпросмотре не работают)
  function confirmBox(text, okLabel) {
    return new Promise((res) => {
      const back = el('div', 'modal-back'), box = el('div', 'modal'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      box.appendChild(el('p', '', text));
      const btns = el('div', 'm-btns'), no = el('button', '', 'Отмена'), yes = el('button', 'primary', okLabel || 'OK');
      const done = (v) => { back.remove(); document.removeEventListener('keydown', key, true); res(v); };
      const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      no.onclick = () => done(false); yes.onclick = () => done(true);
      back.addEventListener('pointerdown', (e) => { if (e.target === back) done(false); });
      document.addEventListener('keydown', key, true);
      btns.append(no, yes); box.appendChild(btns); back.appendChild(box); document.body.appendChild(back); yes.focus();
    });
  }
  Vox.confirmBox = confirmBox;

  // предложение восстановить прошлый проект
  Vox.on('restore-available', (a) => {
    const t = new Date(a.savedAt);
    const when = t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ' в ' + t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const bar = el('div', 'hintbar restore');
    bar.appendChild(el('span', '', 'Найден прошлый проект «' + (a.state.projectName || 'Без названия') + '» от ' + when + '.'));
    const box = el('span', 'hint-actions');
    const yes = el('button', 'primary', 'Восстановить'), no = el('button', '', 'Не нужно');
    yes.onclick = () => { bar.remove(); Vox.autosave.restore(); };
    no.onclick = () => bar.remove();
    box.append(yes, no); bar.appendChild(box); hintEl.after(bar);
  });

  // после отмены, открытия или нового проекта — обновить всё, что показано
  Vox.on('project', () => {
    $('bpm').value = st.bpm; $('projName').textContent = st.projectName;
    syncTransport();
    if (wins.rack) buildRack(wins.rack.body);
    Object.keys(wins).filter((id) => id.startsWith('plug-')).forEach((id) => {
      const [, i, k] = id.split('-').map(Number);
      const s = st.mixer[i] && st.mixer[i].fx[k];
      closeWindow(id);
      if (s) openPlugin(i, k);
    });
    renderMixer(); renderBrowser();
  });

  /* ------------------------------ ТЕЛЕФОН: вкладки ------------------------------ */
  const mobileMQ = matchMedia('(max-width: 820px)');
  const appEl = $('app');
  function setTab(t) {
    appEl.dataset.tab = t;
    document.querySelectorAll('#mtabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'rack' && !wins.rack) OPENERS.rack();
    if (t === 'mixer' && !wins.mixer) OPENERS.mixer();
    if (t === 'browser') $('workspace').classList.remove('no-browser');
    requestAnimationFrame(() => { if (t === 'playlist') renderPlaylist(); });
  }
  document.querySelectorAll('#mtabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  Vox.isMobile = () => mobileMQ.matches;
  // раскладка Rack своя для телефона и компьютера — пересобрать при смене режима
  mobileMQ.addEventListener('change', () => { if (wins.rack) buildRack(wins.rack.body); });

  /* ------------------------------ ГОРЯЧИЕ КЛАВИШИ ------------------------------ */
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input, select, textarea');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyS') { e.preventDefault(); Vox.saveProject(); return; }
    if (mod && e.code === 'KeyO') { e.preventDefault(); $('projOpenInput').click(); return; }
    if (typing) return;
    if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); Vox.history.undo(); return; }
    if (mod && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); Vox.history.redo(); return; }
    if (!mod && e.code === 'KeyS') { e.preventDefault(); Vox.splitAtCursor(); return; }
    if (e.code === 'Space') { e.preventDefault(); Vox.togglePlay(); }
    else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') { if (!e.ctrlKey && !e.metaKey) Vox.toggleRecord(); }
    else if (e.key === 'F6') { e.preventDefault(); toggleWindow('rack'); }
    else if (e.key === 'F9') { e.preventDefault(); toggleWindow('mixer'); }
    else if (e.key === 'F8') { e.preventDefault(); $('wbBrowser').click(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedClip != null) { e.preventDefault(); Vox.deleteClip(st.selectedClip); }
    else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyD' || e.code === 'KeyB')) {
      e.preventDefault();
      if (st.selectedClip != null) Vox.duplicateClip(st.selectedClip); else Vox.duplicateTrack(st.selectedTrack);
    }
  });

  /* ------------------------------ ЗАПУСК ------------------------------ */
  document.addEventListener('pointerdown', () => { Vox.resume().catch(() => {}); }, { once: true, capture: true });
  Vox.on('ready', () => {
    const c = Vox.ctx;
    const lat = Math.max(0, (c.outputLatency || 0) || (c.baseLatency || 0));
    $('audioInfo').textContent = c.sampleRate + ' Гц · задержка выхода ≈' + Math.round(lat * 1000) + ' мс';
  });

  renderBrowser(); renderPlaylist(); syncTransport();
  requestAnimationFrame(() => {
    OPENERS.rack(); OPENERS.mixer();
    syncWindowButtons();
  });
  Vox.init().catch(() => {});
  requestAnimationFrame(frame);
  window.addEventListener('resize', () => renderPlaylist());
})();
