/* =====================================================================
   WOK Studio — ЗВУКОВОЙ ДВИЖОК
   Состояние проекта, микшер, эффекты, транспорт, запись, экспорт.
   Интерфейс (ui.js) только читает Vox.state и вызывает функции Vox.*
   ===================================================================== */
(function () {
  const Vox = (window.Vox = {});
  Vox.ctx = null;
  Vox.live = null;            // узлы микшера живого контекста
  Vox.buffers = new Map();    // id -> { buffer, name }
  let bufSeq = 1, clipSeq = 1;

  /* ------------------------------ события ------------------------------ */
  const listeners = {};
  Vox.on = (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn);
  Vox.emit = (ev, data) => (listeners[ev] || []).forEach((f) => f(data));
  Vox.hint = (text) => Vox.emit('hint', text);

  /* ------------------------------ ЭФФЕКТЫ ------------------------------ */
  const FX = (Vox.FX = {});
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  Vox.NOTE_NAMES = NOTE_NAMES;

  /* --- ShkaFX 3.4.1: исходники плагина в WebAssembly (см. plugins/shkafx) ---
     Звук (Throw A/B, хвосты) — в AudioWorklet, расчёт хвостов — в Web Worker,
     окно — родной интерфейс плагина. У каждого слота свой «хост» с записанной волной. */
  Vox.shkaReady = false;
  const b64ToBytes = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const bytesToB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  Vox.b64ToBytes = b64ToBytes; Vox.bytesToB64 = bytesToB64;
  async function loadShka() {
    if (Vox.shkaModule || !window.SHKA) return;
    Vox.shkaBytes = await gunzip(window.SHKA.wasmGz);
    Vox.shkaModule = await WebAssembly.compile(Vox.shkaBytes);
    // таблица параметров — из того же кода плагина
    let mem = null;
    const wasi = { fd_close: () => 0, fd_seek: () => 0, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8, proc_exit: () => { throw new Error('exit'); },
      fd_write: (fd, iov, n, pw) => { const dv = new DataView(mem.buffer); let t = 0; for (let i = 0; i < n; i++) t += dv.getUint32(iov + i * 8 + 4, true); dv.setUint32(pw, t, true); return 0; } };
    const inst = await WebAssembly.instantiate(Vox.shkaModule, { wasi_snapshot_preview1: wasi });
    const e = inst.exports; mem = e.memory; e._initialize();
    const n = e.shka_params_json();
    Vox.shkaParams = JSON.parse(new TextDecoder().decode(new Uint8Array(mem.buffer, e.shka_str(), n)));
    Vox.shkaReady = true;
  }
  const shkaUid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  Vox.shkaHosts = {};
  // хост ShkaFX: Web Worker с движком + список живых узлов звука
  function shkaHost(p) {
    let h = Vox.shkaHosts[p.uid];
    if (h) return h;
    const src = '(' + voxShkaWorker.toString() + ')();';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    h = Vox.shkaHosts[p.uid] = { uid: p.uid, worker: w, nodes: new Set(), tails: [], regions: null, fileMode: false, seq: 1, wait: {}, listeners: new Set(), p };
    h.call = (cmd, args, transfer) => new Promise((res, rej) => {
      const id = h.seq++; h.wait[id] = { res, rej };
      w.postMessage(Object.assign({ cmd, id }, args || {}), transfer || []);
    });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'reply') { const q = h.wait[m.id]; delete h.wait[m.id]; if (q) m.error ? q.rej(new Error(m.error)) : q.res(m.result); }
      else if (m.type === 'tails') { h.tails = m.tails; h.nodes.forEach((nd) => nd.port.postMessage({ tails: h.tails })); }
      else if (m.type === 'regions') {
        h.regions = m.regions;
        if (h.fileMode !== !!m.regions.fileMode) { h.fileMode = !!m.regions.fileMode; h.nodes.forEach((nd) => nd.port.postMessage({ fileMode: h.fileMode })); }
        h.listeners.forEach((fn) => fn('regions', m.regions));
      } else if (m.type === 'data') { h.p.data = bytesToB64(m.data); }
    };
    h.ready = h.call('init', { module: Vox.shkaModule, sr: Vox.ctx ? Vox.ctx.sampleRate : 48000, values: Float32Array.from(p.values), bpm: st.bpm,
      data: p.data ? b64ToBytes(p.data) : null });
    return h;
  }
  Vox.shkaHost = shkaHost;
  // актуальное состояние всех ShkaFX — перед сохранением проекта
  Vox.shkaFlush = async () => {
    const jobs = [];
    st.mixer.forEach((ch) => ch.fx.forEach((s) => {
      if (!s || s.type !== 'shkafx') return;
      const h = Vox.shkaHosts[s.params.uid]; if (!h) return;
      jobs.push(h.ready.then(() => h.call('serialise')).then((d) => { s.params.data = bytesToB64(d); }).catch(() => {}));
    }));
    await Promise.all(jobs);
  };
  FX.shkafx = {
    title: 'ShkaFX',
    defaults: () => ({ uid: shkaUid(), values: (Vox.shkaParams || []).map((d) => d.def), data: '' }),
    latency: () => 0,
    create(ctx, p, info) {
      if (!p.uid) p.uid = shkaUid();
      const live = info && info.live, h = live ? shkaHost(p) : Vox.shkaHosts[p.uid];
      const opts = { values: Float32Array.from(p.values), tails: h ? h.tails : [], fileMode: h ? h.fileMode : false,
        transport: Object.assign(Vox.transportFor(ctx), { ahead: info ? info.ahead || 0 : 0 }) };
      let node;
      try { node = new AudioWorkletNode(ctx, 'vox-shkafx', { outputChannelCount: [2], processorOptions: Object.assign({ module: Vox.shkaModule }, opts) }); }
      catch (err) { node = new AudioWorkletNode(ctx, 'vox-shkafx', { outputChannelCount: [2], processorOptions: Object.assign({ wasm: Vox.shkaBytes }, opts) }); }
      const fx = { input: node, output: node, node, wantsTransport: true, ahead: opts.transport.ahead, host: h,
        dispose() { node.port.postMessage({ dispose: true }); if (h) h.nodes.delete(node); },
        apply(q) {
          node.port.postMessage({ values: Float32Array.from(q.values) });
          if (h) h.ready.then(() => h.worker.postMessage({ cmd: 'values', values: Float32Array.from(q.values), bpm: st.bpm }));
          // отмена/открытие проекта вернули другое состояние выделений
          if (h && q.data && q.data !== h.p.data) { h.p = q; h.ready.then(() => h.call('deserialise', { data: b64ToBytes(q.data) })); }
          if (h) h.p = q;
        },
        setOne(idx, v) {
          node.port.postMessage({ set: [idx, v] });
          if (h) h.ready.then(() => h.worker.postMessage({ cmd: 'values', values: Float32Array.from((h.p || p).values), bpm: st.bpm }));
        } };
      if (live && h) {
        h.nodes.add(node);
        const ch = new MessageChannel();
        node.port.postMessage({ capPort: ch.port1 }, [ch.port1]);
        h.ready.then(() => h.worker.postMessage({ cmd: 'capPort', port: ch.port2 }, [ch.port2]));
        node.port.onmessage = (e) => { if (e.data.m) h.listeners.forEach((fn) => fn('meters', e.data.m)); };
      }
      return fx;
    }
  };
  Vox.shkaSetOne = (i, k, idx, v) => {
    const s = st.mixer[i].fx[k]; if (!s || s.type !== 'shkafx') return;
    s.params.values[idx] = v;
    const f = Vox.live && Vox.live[i] && Vox.live[i].fx[k]; if (f && f.setOne) f.setOne(idx, v);
    else { const h = Vox.shkaHosts[s.params.uid]; if (h) h.worker.postMessage({ cmd: 'values', values: Float32Array.from(s.params.values), bpm: st.bpm }); }
  };
  Vox.shkaSetAll = (i, k, values) => {
    const s = st.mixer[i].fx[k]; if (!s || s.type !== 'shkafx') return;
    s.params.values = Array.from(values);
    const f = Vox.live && Vox.live[i] && Vox.live[i].fx[k]; if (f) f.apply(s.params);
  };
  // прослушивание внутри плагина: буфер с голосом и эффектами отдаём узлу звука
  Vox.shkaPreview = (i, k, buf, from) => {
    const f = Vox.live && Vox.live[i] && Vox.live[i].fx[k]; if (!f) return;
    f.node.port.postMessage({ preview: buf, previewPlay: !!buf, from });
  };
  Vox.shkaPreviewStop = (i, k) => { const f = Vox.live && Vox.live[i] && Vox.live[i].fx[k]; if (f) f.node.port.postMessage({ previewPlay: false }); };

  const atMsg = (q) => ({ key: +q.key, scale: q.scale, speed: +q.speed, amount: +q.amount, range: q.range || 'mid',
    humanize: +(q.humanize || 0), flex: +(q.flex || 0), tracking: q.tracking == null ? 50 : +q.tracking, transpose: +(q.transpose || 0) });
  FX.autotune = {
    title: 'Автотюн',
    // Жёсткий = настройки Auto-Tune Pro Classic: Retune 0, Humanize 0, Flex-Tune 0
    presets: {
      light:  { label: 'Лёгкий',  speed: 60, amount: 1, humanize: 40, flex: 30 },
      medium: { label: 'Средний', speed: 20, amount: 1, humanize: 20, flex: 10 },
      hard:   { label: 'Жёсткий', speed: 0,  amount: 1, humanize: 0,  flex: 0 }
    },
    defaults: () => ({ preset: 'medium', key: 9, scale: 'minor', speed: 20, amount: 1, humanize: 20, flex: 10, tracking: 50, transpose: 0, range: 'mid' }),
    ranges: { high: { label: 'Сопрано', fmin: 150 }, mid: { label: 'Альт / Тенор', fmin: 100 }, low: { label: 'Низкий мужской', fmin: 75 } },
    latency(p, sr) { const f = (FX.autotune.ranges[p.range] || FX.autotune.ranges.mid).fmin; return (2 * Math.floor(sr / f) + 64) / sr; },
    create(ctx, p, info) {
      const node = new AudioWorkletNode(ctx, 'vox-autotune', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: atMsg(p)
      });
      if (info && info.live) node.port.onmessage = (e) => Vox.emit('autotune-report', Object.assign({ insert: info.insert, slot: info.slot }, e.data));
      const fx = { input: node, output: node, node,
        dispose() { node.port.postMessage({ dispose: true }); },
        apply(q) { node.port.postMessage(atMsg(q)); } };
      fx.apply(p); return fx;
    }
  };

  function satCurve(drive) {
    const n = 2048, c = new Float32Array(n), k = 1 + drive * 7;
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    return c;
  }

  /* --- VocalChain 1.2: оригинальный C++ код плагина в WebAssembly (см. plugins/vocalchain) --- */
  const VCD = () => window.VC && window.VC.data;
  Vox.vcReady = false;
  async function gunzip(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const ds = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  async function loadVocalChain() {
    if (Vox.vcModule || !window.VC) return;
    Vox.vcBytes = await gunzip(window.VC.wasmGz);
    Vox.vcModule = await WebAssembly.compile(Vox.vcBytes);
    // экземпляр в основном потоке: задержка и кривые EQ для интерфейса плагина
    let mem = null;
    const wasi = {
      fd_close: () => 0, fd_seek: () => 0, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8,
      proc_exit: () => { throw new Error('exit'); },
      fd_write: (fd, iov, n, pw) => { const dv = new DataView(mem.buffer); let t = 0; for (let i = 0; i < n; i++) t += dv.getUint32(iov + i * 8 + 4, true); dv.setUint32(pw, t, true); return 0; }
    };
    const inst = await WebAssembly.instantiate(Vox.vcModule, { wasi_snapshot_preview1: wasi });
    const e = inst.exports; mem = e.memory; e._initialize();
    Vox.vcMain = { e, sr: 0, freqs: 0, out: 0, dyn: 0 };
    Vox.vcReady = true;
  }
  const vcLatCache = {};
  Vox.vcLatency = (sr) => {
    if (vcLatCache[sr] != null) return vcLatCache[sr];
    const m = Vox.vcMain; if (!m) return 0.03;
    m.e.vc_create(sr); m.sr = sr;
    return (vcLatCache[sr] = m.e.vc_latency() / sr);
  };
  Vox.vcEqCurves = (values, dyn, freqs, sr) => {
    const m = Vox.vcMain; if (!m) return null;
    const e = m.e;
    if (m.sr !== sr) { e.vc_create(sr); m.sr = sr; }
    if (!m.freqs) { m.freqs = e.vc_alloc(freqs.length); m.out = e.vc_alloc(freqs.length); m.dyn = e.vc_alloc(8); }
    const f = () => new Float32Array(e.memory.buffer);
    f().set(freqs, m.freqs / 4);
    f().set(values, e.vc_values() / 4);
    const res = {};
    ['eq1', 'eq2'].forEach((nm, w) => {
      const d = dyn ? dyn.subarray(w * 8, w * 8 + 8) : new Float32Array(8);
      f().set(d, m.dyn / 4);
      e.vc_eq_curve(w, m.freqs, freqs.length, m.out, m.dyn);
      res[nm] = Array.from(f().subarray(m.out / 4, m.out / 4 + freqs.length));
      res[nm + 'Dyn'] = Array.from(d);
    });
    return res;
  };
  Vox.vcPresetValues = (type, variant) => {
    const t = VCD().types[type] || VCD().types[0];
    return t.variants[Math.min(variant | 0, t.variants.length - 1)].slice();
  };

  FX.vocalchain = {
    title: 'VocalChain',
    defaults: (type, variant) => ({ type: type | 0, variant: variant | 0, values: Vox.vcPresetValues(type | 0, variant | 0) }),
    latency: (p, sr) => Vox.vcLatency(sr),
    create(ctx, p, info) {
      const opts = { values: Float32Array.from(p.values), transport: Object.assign(Vox.transportFor(ctx), { ahead: info ? info.ahead || 0 : 0 }) };
      let node;
      try { node = new AudioWorkletNode(ctx, 'vox-vocalchain', { outputChannelCount: [2], processorOptions: Object.assign({ module: Vox.vcModule }, opts) }); }
      catch (err) { node = new AudioWorkletNode(ctx, 'vox-vocalchain', { outputChannelCount: [2], processorOptions: Object.assign({ wasm: Vox.vcBytes }, opts) }); }
      node.onprocessorerror = () => Vox.hint('VocalChain не запустился в этом браузере. Попробуй свежий Chrome или Edge.');
      if (info && info.live) {
        node.port.onmessage = (e) => Vox.emit('vc-meters', { insert: info.insert, slot: info.slot, m: e.data.m, dyn: e.data.dyn });
        vcNodes.add(node);
      }
      const fx = { input: node, output: node, node, isVC: true, ahead: opts.transport.ahead,
        dispose() { node.port.postMessage({ dispose: true }); vcNodes.delete(node); },
        apply(q) { node.port.postMessage({ values: Float32Array.from(q.values) }); },
        setOne(idx, v) { node.port.postMessage({ set: [idx, v] }); } };
      return fx;
    }
  };
  const vcNodes = new Set();
  // темп и позиция песни для PanMan, delay и «карусели» внутри VocalChain
  Vox.transportFor = (ctx) => (ctx === Vox.ctx
    ? { playing: !!Vox.state.playing, t0: Vox.t0 || 0, startBeat: Vox.startBeat || 0, bpm: Vox.state.bpm,
        loopA: Vox.loopRun ? Vox.loopRun.start : 0, loopB: Vox.loopRun ? Vox.loopRun.end : 0 }
    : { playing: true, t0: Vox.offlineT0 || 0, startBeat: 0, bpm: Vox.state.bpm, loopA: 0, loopB: 0 });
  function broadcastTransport() {
    if (!Vox.live) return;
    Vox.live.forEach((n) => n && n.fx.forEach((f) => f && (f.isVC || f.wantsTransport) && f.node.port.postMessage({ transport: Object.assign(Vox.transportFor(Vox.ctx), { ahead: f.ahead }) })));
  }
  Vox.vcSetOne = (i, k, idx, v) => {
    const s = Vox.state.mixer[i].fx[k]; if (!s || s.type !== 'vocalchain') return;
    s.params.values[idx] = v;
    const f = Vox.live && Vox.live[i] && Vox.live[i].fx[k]; if (f && f.setOne) f.setOne(idx, v);
  };
  Vox.vcSetType = (i, k, type, variant) => {
    const s = Vox.state.mixer[i].fx[k]; if (!s || s.type !== 'vocalchain') return;
    s.params.type = type; s.params.variant = variant; s.params.values = Vox.vcPresetValues(type, variant);
    const f = Vox.live && Vox.live[i] && Vox.live[i].fx[k]; if (f) f.apply(s.params);
  };

  const SYNC = { '1/4': 1, '1/8': 0.5, '1/8.': 0.75, '1/8t': 1 / 3, '1/16': 0.25, '1/4.': 1.5, '1/2': 2 };
  const dbToLin = (db) => Math.pow(10, db / 20);
  // вход, который из моно делает стерео (нужно эффектам с разделением каналов)
  function stereoIn(ctx) {
    const g = ctx.createGain(); g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g;
  }

  /* --- Delay: эхо в темп, пинг-понг, мягкое насыщение повторов --- */
  FX.delay = {
    title: 'Delay',
    defaults: () => ({ sync: '1/8', feedback: 0.32, dry: 1, wet: 0.25, tone: 5500, lowcut: 300, pingpong: 0, sat: 0.2 }),
    create(ctx, p) {
      const input = stereoIn(ctx), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const merge = ctx.createChannelMerger(2);
      const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const dL = ctx.createDelay(4), dR = ctx.createDelay(4), fbL = ctx.createGain(), fbR = ctx.createGain();
      const lpL = ctx.createBiquadFilter(), lpR = ctx.createBiquadFilter(); lpL.type = lpR.type = 'lowpass';
      const shL = ctx.createWaveShaper(), shR = ctx.createWaveShaper();
      const xL = ctx.createGain(), xR = ctx.createGain(), sL = ctx.createGain(), sR = ctx.createGain();
      input.connect(dry); dry.connect(out);
      input.connect(mono); mono.connect(hp);
      hp.connect(dL);
      dL.connect(lpL); lpL.connect(shL); dR.connect(lpR); lpR.connect(shR);
      // обычный режим: L->L, R->R; пинг-понг: L->R->L
      shL.connect(sL); sL.connect(dL); shR.connect(sR); sR.connect(dR);
      shL.connect(xL); xL.connect(dR); shR.connect(xR); xR.connect(dL);
      const inR = ctx.createGain(); hp.connect(inR); inR.connect(dR);
      shL.connect(merge, 0, 0); shR.connect(merge, 0, 1); merge.connect(wet); wet.connect(out);
      let lastSat = null;
      const fx = { input, output: out, isDelay: true, params: p,
        apply(q) {
          fx.params = q;
          const t = ctx.currentTime, beat = 60 / Vox.state.bpm, dt = Math.min(3.9, (SYNC[q.sync] || 0.5) * beat);
          const pp = q.pingpong > 0.5;
          dL.delayTime.setTargetAtTime(dt, t, 0.03);
          dR.delayTime.setTargetAtTime(dt, t, 0.03);
          inR.gain.setTargetAtTime(pp ? 0 : 1, t, 0.01); // в пинг-понге звук входит только слева
          sL.gain.setTargetAtTime(pp ? 0 : q.feedback, t, 0.02); sR.gain.setTargetAtTime(pp ? 0 : q.feedback, t, 0.02);
          xL.gain.setTargetAtTime(pp ? q.feedback : 0, t, 0.02); xR.gain.setTargetAtTime(pp ? q.feedback : 0, t, 0.02);
          [lpL, lpR].forEach((f) => f.frequency.setTargetAtTime(q.tone, t, 0.02));
          hp.frequency.setTargetAtTime(q.lowcut, t, 0.02);
          dry.gain.setTargetAtTime(q.dry, t, 0.02); wet.gain.setTargetAtTime(q.wet, t, 0.02);
          if (q.sat !== lastSat) { const c = satCurve(q.sat * 0.8); shL.curve = c; shR.curve = c; lastSat = q.sat; }
        } };
      fx.apply(p); return fx;
    }
  };

  /* --- Reverb: свёртка с импульсом, который рассчитывается по ручкам
     (ранние отражения + хвост с разной длиной для низа, середины и верха) --- */
  function makeIR(ctx, q) {
    const sr = ctx.sampleRate, dec = Math.max(0.2, q.decay), len = Math.floor(sr * Math.min(12, dec * 1.25 + 0.05));
    const ir = ctx.createBuffer(2, len, sr);
    const rnd = (() => { let s = 12345; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2147483648) - 1; })();
    const rtLow = dec * (1 + 0.3 * (1 - q.damp)), rtMid = dec, rtHigh = dec * Math.max(0.12, 1 - q.damp * 0.85);
    const kLow = Math.exp(-2 * Math.PI * 400 / sr), kHigh = Math.exp(-2 * Math.PI * 4000 / sr);
    const attack = Math.max(0.002, 0.008 + q.size * 0.07);  // чем больше комната, тем позже нарастает хвост
    const chans = [];
    for (let c = 0; c < 2; c++) {
      const d = new Float32Array(len); let l1 = 0, l2 = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, n = rnd();
        l1 = (1 - kLow) * n + kLow * l1; l2 = (1 - kHigh) * n + kHigh * l2;
        const low = l1, high = n - l2, mid = l2 - l1;
        const env = (rt) => Math.pow(10, -3 * t / rt);
        let v = low * env(rtLow) + mid * env(rtMid) + high * env(rtHigh);
        if (t < attack) v *= Math.pow(t / attack, 1.5);
        d[i] = v;
      }
      // ранние отражения
      const erN = 14, erSpan = 0.006 + q.size * 0.06;
      for (let k = 0; k < erN; k++) {
        const t = 0.002 + erSpan * Math.pow((k + 0.5 + 0.4 * rnd()) / erN, 1.3), i = Math.floor(t * sr);
        if (i < len) d[i] += (0.9 - k / erN * 0.6) * (rnd() > 0 ? 1 : -1) * 0.6 * q.early;
      }
      chans.push(d);
    }
    // ширина: 0 — моно, 1 — независимые каналы
    const w = q.width, a = (1 + w) / 2, b = (1 - w) / 2;
    let e = 0; for (let i = 0; i < len; i++) { const L = chans[0][i], R = chans[1][i]; chans[0][i] = a * L + b * R; chans[1][i] = b * L + a * R; e += chans[0][i] ** 2 + chans[1][i] ** 2; }
    const norm = 1 / Math.sqrt(e / 2) * 0.9;
    ir.copyToChannel(chans[0].map((v) => v * norm), 0); ir.copyToChannel(chans[1].map((v) => v * norm), 1);
    return ir;
  }
  FX.reverb = {
    title: 'Reverb',
    defaults: () => ({ decay: 2.2, size: 0.5, predelay: 20, damp: 0.55, early: 0.5, width: 0.9, lowcut: 250, highcut: 9000, dry: 1, wet: 0.2 }),
    create(ctx, p) {
      const input = stereoIn(ctx), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const pre = ctx.createDelay(0.5), conv = ctx.createConvolver(); conv.normalize = false;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      input.connect(dry); dry.connect(out);
      input.connect(pre); pre.connect(conv); conv.connect(hp); hp.connect(lp); lp.connect(wet); wet.connect(out);
      let lastIR = '', irTimer = null;
      const fx = { input, output: out,
        apply(q) {
          const key = [q.decay, q.size, q.damp, q.early, q.width].map((v) => (+v).toFixed(3)).join('/');
          if (key !== lastIR) {
            lastIR = key; clearTimeout(irTimer);
            // при движении ручки импульс пересчитывается не чаще раза в 60 мс
            if (!conv.buffer || ctx instanceof OfflineAudioContext) conv.buffer = makeIR(ctx, q);
            else irTimer = setTimeout(() => (conv.buffer = makeIR(ctx, q)), 60);
          }
          const t = ctx.currentTime;
          pre.delayTime.setTargetAtTime(q.predelay / 1000, t, 0.02);
          hp.frequency.setTargetAtTime(q.lowcut, t, 0.02); lp.frequency.setTargetAtTime(q.highcut, t, 0.02);
          dry.gain.setTargetAtTime(q.dry, t, 0.02); wet.gain.setTargetAtTime(q.wet, t, 0.02);
        } };
      fx.apply(p); return fx;
    }
  };

  /* --- Chorus: две голоса с медленно «плавающей» задержкой, левый и правый в противофазе --- */
  FX.chorus = {
    title: 'Chorus',
    defaults: () => ({ rate: 0.8, depth: 3, delay: 12, mix: 0.4, width: 1, feedback: 0, lowcut: 200 }),
    create(ctx, p) {
      const input = stereoIn(ctx), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const dl = [ctx.createDelay(0.1), ctx.createDelay(0.1)], fb = [ctx.createGain(), ctx.createGain()];
      const lfo = ctx.createOscillator(), dep = [ctx.createGain(), ctx.createGain()];
      const wL = ctx.createGain(), wR = ctx.createGain(), cL = ctx.createGain(), cR = ctx.createGain();
      input.connect(dry); dry.connect(out);
      input.connect(hp); hp.connect(split);
      for (let c = 0; c < 2; c++) {
        split.connect(dl[c], c); dl[c].connect(fb[c]); fb[c].connect(dl[c]);
        lfo.connect(dep[c]); dep[c].connect(dl[c].delayTime);
      }
      // ширина: смешиваем каналы крест-накрест
      dl[0].connect(wL); dl[1].connect(wR); dl[0].connect(cR); dl[1].connect(cL);
      wL.connect(merge, 0, 0); cL.connect(merge, 0, 0); wR.connect(merge, 0, 1); cR.connect(merge, 0, 1);
      merge.connect(wet); wet.connect(out);
      lfo.start();
      const fx = { input, output: out, osc: lfo,
        dispose() { try { lfo.stop(); } catch (e) {} },
        apply(q) {
          const t = ctx.currentTime;
          lfo.frequency.setTargetAtTime(q.rate, t, 0.05);
          dl.forEach((d) => d.delayTime.setTargetAtTime(q.delay / 1000, t, 0.05));
          dep[0].gain.setTargetAtTime(q.depth / 1000, t, 0.05); dep[1].gain.setTargetAtTime(-q.depth / 1000, t, 0.05);
          fb.forEach((g) => g.gain.setTargetAtTime(q.feedback, t, 0.02));
          hp.frequency.setTargetAtTime(q.lowcut, t, 0.02);
          const a = (1 + q.width) / 2, b = (1 - q.width) / 2;
          wL.gain.value = wR.gain.value = a; cL.gain.value = cR.gain.value = b;
          dry.gain.setTargetAtTime(Math.cos(q.mix * Math.PI / 2), t, 0.02);
          wet.gain.setTargetAtTime(Math.sin(q.mix * Math.PI / 2), t, 0.02);
        } };
      fx.apply(p); return fx;
    }
  };

  /* --- EQ: 7 полос — срез низа, полка, 3 колокола, полка, срез верха --- */
  const EQ_TYPES = { hp: 'highpass', ls: 'lowshelf', pk: 'peaking', hs: 'highshelf', lp: 'lowpass' };
  FX.eq = {
    title: 'EQ',
    defaults: () => ({ out: 0, bands: [
      { t: 'hp', on: true, f: 80, g: 0, q: 0.71, slope: 24 },
      { t: 'ls', on: true, f: 150, g: 0, q: 0.71 },
      { t: 'pk', on: true, f: 400, g: 0, q: 1 },
      { t: 'pk', on: true, f: 1500, g: 0, q: 1 },
      { t: 'pk', on: true, f: 4000, g: 0, q: 1 },
      { t: 'hs', on: true, f: 10000, g: 0, q: 0.71 },
      { t: 'lp', on: false, f: 18000, g: 0, q: 0.71, slope: 12 }
    ] }),
    // настроить пару биквадов под полосу (вторая нужна только для среза 24 дБ/окт)
    setBand(b, n1, n2, t) {
      const on = b.on !== false, cut = b.t === 'hp' || b.t === 'lp';
      const set = (n, type, f, g, q) => {
        if (n.type !== type) n.type = type;
        if (t == null) { n.frequency.value = f; n.gain.value = g; n.Q.value = q; }
        else { n.frequency.setTargetAtTime(f, t, 0.015); n.gain.setTargetAtTime(g, t, 0.015); n.Q.setTargetAtTime(q, t, 0.015); }
      };
      if (!on) { set(n1, 'peaking', 1000, 0, 1); set(n2, 'peaking', 1000, 0, 1); return; }
      const qq = cut ? (b.slope === 24 ? 0.54 : b.q) : b.q;
      set(n1, EQ_TYPES[b.t], b.f, b.g, qq);
      if (cut && b.slope === 24) set(n2, EQ_TYPES[b.t], b.f, 0, 1.31); else set(n2, 'peaking', 1000, 0, 1);
    },
    create(ctx, p) {
      const input = ctx.createGain(), out = ctx.createGain();
      const nodes = p.bands.map(() => [ctx.createBiquadFilter(), ctx.createBiquadFilter()]);
      let prev = input; nodes.forEach(([a, b]) => { prev.connect(a); a.connect(b); prev = b; }); prev.connect(out);
      const fx = { input, output: out,
        apply(q) {
          const t = ctx.currentTime;
          q.bands.forEach((b, k) => nodes[k] && FX.eq.setBand(b, nodes[k][0], nodes[k][1], t));
          out.gain.setTargetAtTime(dbToLin(q.out), t, 0.02);
        } };
      fx.apply(p); return fx;
    }
  };
  // АЧХ эквалайзера для графика (считается на «пустых» фильтрах, звук не трогает)
  let eqProbe = null;
  Vox.eqResponse = (p, freqs) => {
    if (!eqProbe) { const c = new OfflineAudioContext(1, 1, 48000); eqProbe = { c, nodes: [] }; }
    const tot = new Float32Array(freqs.length), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const per = p.bands.map(() => new Float32Array(freqs.length));
    p.bands.forEach((b, k) => {
      while (eqProbe.nodes.length <= k) eqProbe.nodes.push([eqProbe.c.createBiquadFilter(), eqProbe.c.createBiquadFilter()]);
      const [n1, n2] = eqProbe.nodes[k];
      FX.eq.setBand(b, n1, n2, null);
      [n1, n2].forEach((n) => { n.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < freqs.length; i++) per[k][i] += 20 * Math.log10(Math.max(1e-6, mag[i])); });
      for (let i = 0; i < freqs.length; i++) tot[i] += per[k][i];
    });
    for (let i = 0; i < freqs.length; i++) tot[i] += p.out;
    return { total: tot, bands: per };
  };

  /* --- Soft Clipper: мягко срезает пики, как клиппер на мастере в FL --- */
  const CLIP_R = 8; // запас по входу: до +18 дБ над 0 dBFS
  function clipCurve(q) {
    const n = 8193, curve = new Float32Array(n), c = dbToLin(q.ceiling);
    const t = c * (1 - Math.max(0, Math.min(1, q.soft)) * 0.85), span = c - t;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) * 2 - 1) * CLIP_R, a = Math.abs(x);
      const y = a <= t ? a : span > 1e-6 ? t + span * Math.tanh((a - t) / span) : c;
      curve[i] = Math.sign(x) * Math.min(c, y);
    }
    return curve;
  }
  Vox.clipCurve = clipCurve; Vox.CLIP_R = CLIP_R;
  FX.clipper = {
    title: 'Soft Clipper',
    defaults: () => ({ drive: 0, ceiling: -0.3, soft: 0.5, out: 0 }),
    create(ctx, p, info) {
      const input = ctx.createGain(), pre = ctx.createGain(), sh = ctx.createWaveShaper(), post = ctx.createGain();
      sh.oversample = '4x';
      // страховка: после передискретизации пики могут чуть выйти за потолок — срезаем жёстко ровно по нему
      const guard = ctx.createWaveShaper(), gpre = ctx.createGain(), gpost = ctx.createGain();
      input.connect(pre); pre.connect(sh); sh.connect(gpre); gpre.connect(guard); guard.connect(gpost); gpost.connect(post);
      const fx = { input, output: post };
      if (info && info.live) {
        // индикаторы: уровень до клиппера и после — разница = сколько срезано
        fx.aIn = ctx.createAnalyser(); fx.aOut = ctx.createAnalyser(); fx.aIn.fftSize = fx.aOut.fftSize = 1024;
        const g = ctx.createGain(); input.connect(g); g.connect(fx.aIn); fx.inGain = g; sh.connect(fx.aOut);
      }
      let last = '';
      fx.apply = (q) => {
        const key = q.ceiling + '/' + q.soft;
        if (key !== last) {
          sh.curve = clipCurve(q); last = key;
          const c = dbToLin(q.ceiling), g = new Float32Array(4097);
          for (let n = 0; n < g.length; n++) { const x = (n / (g.length - 1) * 2 - 1) * 2; g[n] = Math.max(-c, Math.min(c, x)); }
          guard.curve = g; gpre.gain.value = 0.5; gpost.gain.value = 1;
        }
        const t = ctx.currentTime, d = dbToLin(q.drive);
        pre.gain.setTargetAtTime(d / CLIP_R, t, 0.01);
        if (fx.inGain) fx.inGain.gain.setTargetAtTime(d, t, 0.01);
        // WaveShaper отдаёт значения кривой в настоящих единицах, поэтому после него только Output
        post.gain.setTargetAtTime(dbToLin(q.out), t, 0.01);
      };
      fx.apply(p); return fx;
    }
  };

  Vox.FX_ORDER = ['autotune', 'vocalchain', 'shkafx', 'eq', 'reverb', 'delay', 'chorus', 'clipper'];
  // заполнить параметры, которых нет в старом проекте (после обновления плагина)
  Vox.fillDefaults = (s) => {
    if (!s || !FX[s.type]) return;
    const d = FX[s.type].defaults(s.params && s.params.type, s.params && s.params.variant);
    if (s.type === 'reverb' && s.params.size > 1.01 && s.params.decay == null) { s.params.decay = s.params.size; s.params.size = 0.5; }
    if ((s.type === 'reverb' || s.type === 'delay') && s.params.mix != null && s.params.wet == null) { s.params.wet = s.params.mix; delete s.params.mix; }
    Object.keys(d).forEach((k) => { if (s.params[k] == null) s.params[k] = d[k]; });
  };

  /* ------------------------------ ПРОЕКТ ------------------------------ */
  const slot = (type, extra) => ({ type, bypass: false, params: Object.assign(FX[type].defaults(), extra || {}) });
  const vcSlot = (type, variant) => ({ type: 'vocalchain', bypass: false, params: FX.vocalchain.defaults(type, variant) });
  const emptySlots = () => new Array(8).fill(null);
  function insert(name, fxList) {
    const fx = emptySlots(); (fxList || []).forEach((f, i) => (fx[i] = f));
    return { name, vol: 0.8, pan: 0, mute: false, solo: false, fx, sends: {}, ret: false };
  }

  Vox.state = {
    projectName: 'WOK Studio',
    bpm: 140, posBeats: 0, playing: false, recording: false,
    metronome: false, monitor: false, patternInSong: true, latencyMs: 0,
    key: { root: 6, scale: 'minor' },           // тональность проекта: задаётся всем автотюнам
    loop: { on: false, start: 0, end: 16 },     // зацикливание, доли (целые, конец > начала)
    selectedInsert: 1, selectedTrack: 0, selectedClip: null,
    tracks: [
      { name: 'Вокал Мейн', color: 1, insert: 1, armed: true,  mute: false, clips: [] },
      { name: 'Даблы',      color: 2, insert: 2, armed: false, mute: false, clips: [] },
      { name: 'Бэки',       color: 3, insert: 3, armed: false, mute: false, clips: [] },
      { name: 'Адлибы',     color: 4, insert: 4, armed: false, mute: false, clips: [] },
      { name: 'Бит',        color: 5, insert: 5, armed: false, mute: false, clips: [] }
    ],
    mixer: [
      insert('Master', [slot('clipper')]),
      insert('Вокал', [slot('autotune', { key: 6 }), vcSlot(0, 0)]),
      insert('Даблы', [slot('autotune', { preset: 'hard', speed: 0, amount: 1, humanize: 0, flex: 0, key: 6 }), vcSlot(1, 0)]),
      insert('Бэки', [vcSlot(2, 0)]),
      insert('Адлибы', [slot('autotune', { preset: 'hard', speed: 0, amount: 1, humanize: 0, flex: 0, key: 6 })]),
      insert('Бит'),
      insert('Kick'), insert('Clap'), insert('Hats'), insert('808'), insert('Insert 10'),
      Object.assign(insert('Send Reverb', [slot('reverb', { dry: 0, wet: 1, decay: 2.4 })]), { ret: true }),
      Object.assign(insert('Send Delay', [slot('delay', { dry: 0, wet: 1, sync: '1/4', feedback: 0.35 })]), { ret: true })
    ],
    rack: {
      channels: [
        { name: 'Kick', type: 'kick', insert: 6, vol: 0.9, mute: false, steps: new Array(16).fill(0) },
        { name: 'Clap', type: 'clap', insert: 7, vol: 0.7, mute: false, steps: new Array(16).fill(0) },
        { name: 'Hi-hat', type: 'hat', insert: 8, vol: 0.45, mute: false, steps: new Array(16).fill(0) },
        { name: 'Open hat', type: 'ohat', insert: 8, vol: 0.35, mute: false, steps: new Array(16).fill(0) },
        { name: '808', type: 'b808', insert: 9, vol: 0.8, mute: false, steps: new Array(16).fill(0) }
      ]
    }
  };
  const st = Vox.state;
  Vox.slotFor = slot;
  // посылы по умолчанию: голос в общий ревер и дилей
  Object.assign(st.mixer[1].sends, { 11: 0.16, 12: 0.06 });
  Object.assign(st.mixer[2].sends, { 11: 0.12 });
  Object.assign(st.mixer[3].sends, { 11: 0.3, 12: 0.1 });
  Object.assign(st.mixer[4].sends, { 11: 0.25, 12: 0.3 });
  Vox.newInsert = insert;

  /* ------------------------------ МИКШЕР ------------------------------ */
  function faderGain(v) { return v <= 0 ? 0 : Math.pow(v / 0.8, 2); }
  Vox.faderDb = (v) => (v <= 0 ? -Infinity : 20 * Math.log10(faderGain(v)));

  function buildChannel(ctx, i, dest, live) {
    const n = { input: ctx.createGain(), fader: ctx.createGain(), pan: ctx.createStereoPanner(), fx: [], routes: {}, down: 0 };
    n.fader.connect(n.pan);
    if (i === 0) n.pan.connect(dest); // мастер — на выход; остальные каналы подключает connectRoutes
    if (live) {
      n.split = ctx.createChannelSplitter(2);
      n.aL = ctx.createAnalyser(); n.aR = ctx.createAnalyser();
      n.aL.fftSize = n.aR.fftSize = 512;
      n.pan.connect(n.split); n.split.connect(n.aL, 0); n.split.connect(n.aR, 1);
    }
    n.down = routePlan(ctx.sampleRate).down[i] || 0;
    rebuildFx(ctx, n, i, live);
    return n;
  }

  function rebuildFx(ctx, n, i, live) {
    try { n.input.disconnect(); } catch (e) {}
    n.fx.forEach((f) => { if (f) { try { f.output.disconnect(); } catch (e) {} if (f.dispose) f.dispose(); } });
    const ch = st.mixer[i];
    ch.fx.forEach((s) => Vox.fillDefaults(s));
    if (!ch.sends) ch.sends = {};
    // для каждого эффекта — какая задержка стоит после него до мастера: в своём канале и дальше по маршруту
    // (нужно VocalChain и ShkaFX для синхронизации с темпом)
    const lat = ch.fx.map((s) => (s && !s.bypass && FX[s.type].latency ? FX[s.type].latency(s.params, ctx.sampleRate) : 0));
    n.fx = ch.fx.map((s, k) => (s ? FX[s.type].create(ctx, s.params, { live, insert: i, slot: k, ahead: lat.slice(k + 1).reduce((a, b) => a + b, 0) + n.down }) : null));
    let prev = n.input;
    ch.fx.forEach((s, k) => { const f = n.fx[k]; if (!f || s.bypass) return; prev.connect(f.input); prev = f.output; });
    prev.connect(n.fader);
  }

  const fxKey = (ch) => ch.fx.map((s) => (s ? s.type + (s.bypass ? '0' : '1') + (s.type === 'autotune' ? s.params.range : '') : '-')).join('|');
  function dropRoute(n, r) {
    try { n.pan.disconnect(r.delay || r.gain); } catch (e) {}
    try { if (r.delay) r.delay.disconnect(); r.gain.disconnect(); } catch (e) {}
  }
  function disposeChannel(n) {
    if (!n) return;
    n.fx.forEach((f) => { if (f) { try { f.output.disconnect(); } catch (e) {} if (f.dispose) f.dispose(); } });
    Object.values(n.routes || {}).forEach((r) => dropRoute(n, r)); n.routes = {};
    try { n.input.disconnect(); n.fader.disconnect(); n.pan.disconnect(); } catch (e) {}
  }
  // привести живой микшер к Vox.state.mixer, пересобирая только то, что изменилось (для Ctrl+Z и открытия проекта)
  Vox.syncMixer = () => {
    const live = Vox.live; if (!live) return;
    const ctx = Vox.ctx;
    for (let i = st.mixer.length; i < live.length; i++) disposeChannel(live[i]);
    live.length = Math.min(live.length, st.mixer.length);
    st.mixer.forEach((ch, i) => {
      const n = live[i];
      if (!n) { live[i] = buildChannel(ctx, i, ctx.destination, true); live[i].key = fxKey(ch); return; }
      const key = fxKey(ch);
      if (n.key !== key) { rebuildFx(ctx, n, i, true); n.key = key; return; }
      ch.fx.forEach((s, k) => { const f = n.fx[k]; if (s && f) f.apply(s.params); });
    });
    connectRoutes(ctx, live);
    applyMix(live); Vox.routeMonitor();
  };

  /* ---------- маршрутизация как в FL Studio ----------
     Каждый канал (кроме мастера) идёт в мастер (ch.toMaster, по умолчанию да) и может слать сигнал в любой
     другой канал (ch.sends[куда] = 0..1, после фейдера и панорамы). Петли запрещены (Vox.canRoute).
     Компенсация задержки по всему графу: R(i) — задержка от входа канала i до входа мастера по самому
     длинному пути; на каждое ребро i→j ставится DelayNode на R(i) − lat(i) − R(j), так что сигнал приходит
     в мастер по всем путям одновременно — без гребёнки, когда один голос идёт и напрямую, и через шину. */
  const routeKey = (sr) => sr + '#' + st.mixer.map((c) => fxKey(c) + (c.toMaster === false ? '!' : '') + JSON.stringify(c.sends || {})).join('/');
  let planCache = null;
  // рёбра канала (без проверки петель)
  function rawEdges(i) {
    const ch = st.mixer[i]; if (!ch || i === 0) return [];
    const out = [];
    if (ch.toMaster !== false) out.push({ to: 0, amt: 1, master: true });
    Object.entries(ch.sends || {}).forEach(([b, amt]) => { b = +b; if (b > 0 && b !== i && st.mixer[b] && amt > 0) out.push({ to: b, amt }); });
    return out;
  }
  function routePlan(sr) {
    const key = routeKey(sr);
    if (planCache && planCache.key === key) return planCache;
    const N = st.mixer.length, lat = st.mixer.map((_, i) => Vox.insertLatency(i, sr));
    const R = new Array(N).fill(0), mark = new Uint8Array(N), edges = [];
    const visit = (i) => {
      if (mark[i] === 2) return true; if (mark[i] === 1) return false; // петля
      mark[i] = 1; let d = 0; const ok = [];
      rawEdges(i).forEach((e) => { if (e.to === 0) { ok.push(e); return; } if (visit(e.to)) { ok.push(e); d = Math.max(d, R[e.to]); } });
      edges[i] = ok; R[i] = lat[i] + d; mark[i] = 2; return true;
    };
    for (let i = 1; i < N; i++) visit(i);
    edges[0] = [];
    const down = R.map((r, i) => (i === 0 ? 0 : r - lat[i]));
    edges.forEach((list, i) => list.forEach((e) => { e.comp = Math.max(0, down[i] - (e.to === 0 ? 0 : R[e.to])); }));
    return (planCache = { key, lat, R, down, edges });
  }
  // задержка от входа канала до выхода мастера (на столько раньше стартуют клипы и шаги паттерна)
  Vox.pathLatency = (i, sr) => { const p = routePlan(sr); return i === 0 ? p.lat[0] : (p.R[i] || 0); };
  // можно ли направить канал from в канал to (без петли)
  Vox.canRoute = (from, to) => {
    if (from === to || from <= 0 || to <= 0 || !st.mixer[from] || !st.mixer[to]) return false;
    const seen = new Set(), stack = [to];
    while (stack.length) {
      const i = stack.pop(); if (i === from) return false;
      if (seen.has(i)) continue; seen.add(i);
      rawEdges(i).forEach((e) => { if (e.to > 0) stack.push(e.to); });
    }
    return true;
  };
  const sendGain = (v) => (v <= 0 ? 0 : Math.pow(v, 2) * 1.6);
  Vox.sendDb = (v) => (v <= 0 ? -Infinity : 20 * Math.log10(sendGain(v)));
  const isLive = (ctx) => ctx === Vox.ctx;
  // плавная смена параметра в живом контексте (без щелчка), мгновенная — в офлайн-рендере
  function setParam(ctx, p, v) { if (isLive(ctx)) p.setTargetAtTime(v, ctx.currentTime, 0.008); else p.value = v; }
  // подключить маршруты по плану; существующие рёбра только подстраиваются
  function connectRoutes(ctx, chans) {
    const plan = routePlan(ctx.sampleRate);
    let downChanged = false;
    chans.forEach((n, i) => {
      if (!n || i === 0) return;
      const want = {}; (plan.edges[i] || []).forEach((e) => { if (chans[e.to]) want[e.to] = e; });
      n.routes = n.routes || {};
      Object.keys(n.routes).forEach((k) => {
        const r = n.routes[k], e = want[k];
        if (!e || r.dst !== chans[k].input || !!r.delay !== e.comp > 1e-6) { dropRoute(n, r); delete n.routes[k]; }
      });
      Object.entries(want).forEach(([k, e]) => {
        const g = e.master ? 1 : sendGain(e.amt);
        let r = n.routes[k];
        if (!r) {
          r = { gain: ctx.createGain(), delay: null, dst: chans[k].input };
          r.gain.gain.value = g;
          if (e.comp > 1e-6) { r.delay = ctx.createDelay(2); r.delay.delayTime.value = e.comp; n.pan.connect(r.delay); r.delay.connect(r.gain); }
          else n.pan.connect(r.gain);
          r.gain.connect(r.dst); n.routes[k] = r;
        } else {
          setParam(ctx, r.gain.gain, g);
          if (r.delay && Math.abs(r.delay.delayTime.value - e.comp) > 1e-6) r.delay.delayTime.value = e.comp;
        }
      });
      // задержка «после канала» поменялась — сдвинуть позицию песни у плагинов, которым нужен темп
      const d = plan.down[i] || 0;
      if (Math.abs(d - n.down) > 1e-9) {
        n.fx.forEach((f) => { if (f && f.ahead != null) f.ahead += d - n.down; });
        n.down = d; downChanged = true;
      }
    });
    if (downChanged && isLive(ctx)) broadcastTransport();
  }
  Vox.setSend = (i, bus, amt) => {
    const ch = st.mixer[i]; if (!ch || (amt > 0 && !Vox.canRoute(i, bus))) return false;
    ch.sends = ch.sends || {};
    if (amt > 0) ch.sends[bus] = amt; else delete ch.sends[bus];
    if (Vox.live) { connectRoutes(Vox.ctx, Vox.live); applyMix(Vox.live); }
    return true;
  };
  // направить канал в другой (FL: стрелка внизу канала). Включение ставит уровень 100 % (единичное усиление)
  Vox.UNITY_SEND = Math.sqrt(1 / 1.6);
  Vox.setRoute = (i, bus, on) => {
    if (bus === 0) { const ch = st.mixer[i]; if (!ch || i === 0) return false; ch.toMaster = !!on; if (Vox.live) { connectRoutes(Vox.ctx, Vox.live); applyMix(Vox.live); } Vox.emit('mixer'); return true; }
    const ok = Vox.setSend(i, bus, on ? (st.mixer[i].sends && st.mixer[i].sends[bus]) || Vox.UNITY_SEND : 0);
    Vox.emit('mixer'); return ok;
  };
  Vox.isRouted = (i, bus) => (bus === 0 ? i > 0 && st.mixer[i].toMaster !== false : !!(st.mixer[i].sends && st.mixer[i].sends[bus] > 0));
  // новый канал-возврат с эффектом
  Vox.addReturn = (type) => {
    const fx = type === 'delay' ? slot('delay', { dry: 0, wet: 1, sync: '1/4' }) : type === 'chorus' ? slot('chorus', { mix: 1 }) : slot('reverb', { dry: 0, wet: 1 });
    const n = st.mixer.filter((c) => c.ret).length + 1;
    st.mixer.push(Object.assign(insert('Send ' + n + ' ' + FX[fx.type].title, [fx]), { ret: true }));
    Vox.syncMixer(); Vox.emit('mixer'); return st.mixer.length - 1;
  };
  function buildMixer(ctx, live) {
    const chans = [];
    chans[0] = buildChannel(ctx, 0, ctx.destination, live);
    for (let i = 1; i < st.mixer.length; i++) chans[i] = buildChannel(ctx, i, ctx.destination, live);
    chans.forEach((n, i) => (n.key = fxKey(st.mixer[i])));
    connectRoutes(ctx, chans);
    applyMix(chans);
    return chans;
  }

  // при Solo слышны выбранные каналы, всё, что в них приходит и куда они идут, и каналы-возвраты
  function audible() {
    const solo = st.mixer.map((c, i) => (i > 0 && c.solo ? i : -1)).filter((i) => i > 0);
    if (!solo.length) return null;
    const N = st.mixer.length, out = new Set(solo);
    const walk = (start, next) => { const stack = start.slice(); while (stack.length) { const i = stack.pop(); next(i).forEach((j) => { if (j > 0 && !out.has(j)) { out.add(j); stack.push(j); } }); } };
    walk(solo, (i) => rawEdges(i).map((e) => e.to));
    const rev = []; for (let i = 1; i < N; i++) rawEdges(i).forEach((e) => (rev[e.to] = rev[e.to] || []).push(i));
    walk(solo, (i) => rev[i] || []);
    st.mixer.forEach((c, i) => { if (c.ret) out.add(i); });
    return out;
  }
  function applyMix(chans) {
    const keep = audible();
    st.mixer.forEach((c, i) => {
      const n = chans[i]; if (!n) return;
      let g = faderGain(c.vol);
      if (c.mute) g = 0;
      if (i > 0 && keep && !keep.has(i)) g = 0;
      const ctx = n.fader.context;
      setParam(ctx, n.fader.gain, g); setParam(ctx, n.pan.pan, c.pan);
    });
  }

  Vox.updateMix = () => { if (Vox.live) applyMix(Vox.live); };
  Vox.rebuildInsert = (i) => {
    if (Vox.live) { rebuildFx(Vox.ctx, Vox.live[i], i, true); Vox.live[i].key = fxKey(st.mixer[i]); connectRoutes(Vox.ctx, Vox.live); }
    Vox.routeMonitor(); Vox.emit('mixer');
  };
  Vox.setFxParams = (i, k, params) => {
    const s = st.mixer[i].fx[k]; if (!s) return;
    Object.assign(s.params, params);
    const f = Vox.live && Vox.live[i].fx[k]; if (f) f.apply(s.params);
  };
  Vox.setFx = (i, k, type) => {
    st.mixer[i].fx[k] = type ? slot(type, type === 'autotune' && st.key ? { key: st.key.root, scale: st.key.scale } : null) : null;
    Vox.rebuildInsert(i);
  };
  // тональность проекта: одна на все автотюны (как Key в BandLab)
  Vox.setProjectKey = (root, scale) => {
    st.key = { root: +root, scale };
    st.mixer.forEach((ch, i) => ch.fx.forEach((s, k) => { if (s && s.type === 'autotune') Vox.setFxParams(i, k, { key: +root, scale }); }));
    Vox.emit('key');
  };
  Vox.toggleBypass = (i, k) => { const s = st.mixer[i].fx[k]; if (!s) return; s.bypass = !s.bypass; Vox.rebuildInsert(i); };

  /* ------------------------------ ЗАПУСК ------------------------------ */
  async function loadWorklets(ctx) {
    const src = '(' + voxWorkletModule.toString() + ')();';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
  }

  let initPromise = null;
  Vox.init = () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const ctx = (Vox.ctx = new AudioContext({ latencyHint: 'interactive' }));
      await Promise.all([loadWorklets(ctx), loadVocalChain(), loadShka()]);
      Vox.live = buildMixer(ctx, true);
      Vox.emit('ready');
    })().catch((e) => { Vox.hint('Звук не запустился: ' + e.message); throw e; });
    return initPromise;
  };
  Vox.resume = async () => { await Vox.init(); if (Vox.ctx.state !== 'running') await Vox.ctx.resume(); };

  /* ------------------------------ ЗВУКИ ПАТТЕРНА ------------------------------ */
  function noise(ctx) {
    if (!ctx.__noise) {
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      ctx.__noise = b;
    }
    return ctx.__noise;
  }
  function env(ctx, dest, t, v, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    g.connect(dest); return g;
  }
  function noiseHit(ctx, dest, t, v, dur, type, freq, q) {
    const s = ctx.createBufferSource(); s.buffer = noise(ctx);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    s.connect(f); f.connect(env(ctx, dest, t, v, dur));
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }
  const DRUMS = {
    kick(ctx, dest, t, v) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
      o.connect(env(ctx, dest, t, v, 0.42)); o.start(t); o.stop(t + 0.45);
    },
    clap(ctx, dest, t, v) {
      [0, 0.011, 0.023].forEach((d, i) => noiseHit(ctx, dest, t + d, v * (i === 2 ? 1 : 0.7), i === 2 ? 0.2 : 0.02, 'bandpass', 1300, 1.4));
    },
    hat(ctx, dest, t, v) { noiseHit(ctx, dest, t, v, 0.045, 'highpass', 7800); },
    ohat(ctx, dest, t, v) { noiseHit(ctx, dest, t, v, 0.3, 'highpass', 7200); },
    b808(ctx, dest, t, v) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(49, t + 0.08);
      const sh = ctx.createWaveShaper(); sh.curve = satCurve(0.35);
      o.connect(sh); sh.connect(env(ctx, dest, t, v, 1.1)); o.start(t); o.stop(t + 1.15);
    }
  };
  Vox.DRUM_TYPES = { kick: 'Kick', clap: 'Clap', hat: 'Hi-hat', ohat: 'Open hat', b808: '808' };

  // t — когда удар должен прозвучать на выходе; стартуем раньше на задержку пути канала (PDC, как у клипов)
  function playStep(ctx, chans, step, t) {
    st.rack.channels.forEach((c) => {
      if (c.mute || !c.steps[step]) return;
      const ins = chans[c.insert] ? c.insert : 0;
      DRUMS[c.type](ctx, chans[ins].input, Math.max(ctx.currentTime, t - Vox.pathLatency(ins, ctx.sampleRate)), c.vol);
    });
  }
  Vox.previewDrum = async (idx) => {
    await Vox.resume(); const c = st.rack.channels[idx];
    DRUMS[c.type](Vox.ctx, Vox.live[c.insert].input, Vox.ctx.currentTime + 0.01, c.vol);
  };
  function click(ctx, t, accent) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = accent ? 1760 : 1180;
    o.connect(env(ctx, ctx.destination, t, 0.18, 0.04)); o.start(t); o.stop(t + 0.05);
  }

  /* ------------------------------ ТРАНСПОРТ ------------------------------ */
  // задержка эффектов канала (для компенсации, как PDC в FL Studio)
  Vox.insertLatency = (i, sr) => {
    const ch = st.mixer[i]; if (!ch) return 0;
    return ch.fx.reduce((a, s) => a + (s && !s.bypass && FX[s.type].latency ? FX[s.type].latency(s.params, sr) : 0), 0);
  };
  // самая большая задержка пути до мастера среди звучащих дорожек и каналов паттерна — на столько сдвигаем старт
  Vox.maxPdc = (sr) => {
    let m = st.tracks.reduce((a, tr) => (tr.mute || !tr.clips.length ? a : Math.max(a, Vox.pathLatency(tr.insert, sr))), 0);
    if (st.patternInSong) st.rack.channels.forEach((c) => { if (!c.mute && c.steps.some((x) => x)) m = Math.max(m, Vox.pathLatency(c.insert, sr)); });
    return m;
  };
  // громкость клипа в момент t (секунды от начала клипа) с учётом fade in / fade out
  function fadeGain(c, t) {
    const fi = c.fadeIn || 0, fo = c.fadeOut || 0;
    let g = 1;
    if (fi > 0 && t < fi) g = Math.min(g, t / fi);
    if (fo > 0 && t > c.dur - fo) g = Math.min(g, (c.dur - t) / fo);
    return Math.max(0, g);
  }
  // t0 — момент, когда звучит позиция startBeat (до него должно оставаться не меньше maxPdc)
  // endBeat — граница прохода цикла: клипы обрезаются по ней (с микро-затуханием против щелчка)
  const DECLICK = 0.004;
  function scheduleClips(ctx, chans, t0, startBeat, list, endBeat) {
    const spb = 60 / st.bpm, songPos = startBeat * spb, endPos = endBeat == null ? Infinity : endBeat * spb;
    st.tracks.forEach((tr) => {
      if (tr.mute) return;
      const dest = (chans[tr.insert] || chans[0]).input;
      const pdc = Vox.pathLatency(tr.insert, ctx.sampleRate);
      tr.clips.forEach((c) => {
        const b = Vox.buffers.get(c.bufferId); if (!b) return;
        const cs = c.startBeat * spb;
        if (cs + c.dur <= songPos || cs >= endPos) return;
        const skip = Math.max(0, songPos - cs);
        const when = t0 + Math.max(0, cs - songPos) - pdc;
        const len = Math.min(c.dur - skip, endPos - Math.max(cs, songPos));
        if (len <= 0) return;
        const src = ctx.createBufferSource(); src.buffer = b.buffer;
        let out = src;
        if ((c.fadeIn || 0) > 0 || (c.fadeOut || 0) > 0) {
          const g = ctx.createGain(), abs = when - skip, gp = g.gain;
          gp.setValueAtTime(fadeGain(c, skip), when);
          if (c.fadeIn > skip) gp.linearRampToValueAtTime(1, abs + c.fadeIn);
          if (c.fadeOut > 0) {
            const fs = Math.max(abs + c.dur - c.fadeOut, when, c.fadeIn > skip ? abs + c.fadeIn : when);
            gp.setValueAtTime(fadeGain(c, fs - abs), fs);
            gp.linearRampToValueAtTime(0, abs + c.dur);
          }
          src.connect(g); out = g;
        }
        // начало посреди клипа или обрез по концу цикла — короткая рампа, чтобы стык не щёлкал
        const cut = len < c.dur - skip - 1e-6;
        if (skip > 0 || cut) {
          const g = ctx.createGain(), gp = g.gain;
          if (skip > 0) { gp.setValueAtTime(0, when); gp.linearRampToValueAtTime(1, when + DECLICK); }
          if (cut) { gp.setValueAtTime(1, Math.max(when + DECLICK, when + len - DECLICK)); gp.linearRampToValueAtTime(0, when + len); }
          out.connect(g); out = g;
        }
        out.connect(dest); src.start(when, c.offset + skip, len);
        src.onended = () => { src.done = true; };
        list.push(src);
      });
    });
  }

  let timer = null, sources = [], nextStepIdx = 0, nextStepTime = 0, nextLoopT = Infinity;
  Vox.t0 = 0; Vox.startBeat = 0; Vox.curPdc = 0;
  Vox.loopRun = null; // { start, end } — цикл, с которым идёт текущее воспроизведение

  // Цикл без пауз: каждый следующий проход [start, end) планируется заранее, ровно с момента конца
  // предыдущего (nextLoopT), — те же источники и шаги, что и при обычной игре, только со сдвигом во времени.
  function loopRange() {
    const L = st.loop;
    return L && L.on && !st.recording && L.end - L.start >= 1 ? { start: L.start, end: L.end } : null;
  }
  function tick() {
    const ctx = Vox.ctx, ahead = ctx.currentTime + 0.15 + Vox.curPdc, stepDur = 60 / st.bpm / 4, lp = Vox.loopRun;
    if (lp) {
      let added = false;
      while (nextLoopT < ctx.currentTime + 0.5 + Vox.curPdc) {
        scheduleClips(ctx, Vox.live, nextLoopT, lp.start, sources, lp.end);
        nextLoopT += (lp.end - lp.start) * 60 / st.bpm; added = true;
      }
      if (added) sources = sources.filter((s) => !s.done);
    }
    while (nextStepTime < ahead) {
      if (lp && nextStepIdx >= lp.end * 4) {
        nextStepTime -= (nextStepIdx - lp.end * 4) * stepDur; // момент конца прохода
        nextStepIdx = lp.start * 4;
        continue;
      }
      if (st.patternInSong) playStep(ctx, Vox.live, nextStepIdx % 16, nextStepTime);
      if (st.metronome && nextStepIdx % 4 === 0) click(ctx, nextStepTime, nextStepIdx % 16 === 0);
      nextStepIdx++; nextStepTime += stepDur;
    }
  }

  Vox.currentBeat = () => {
    if (!st.playing || !Vox.ctx) return st.posBeats;
    const b = Math.max(Vox.startBeat, Vox.startBeat + (Vox.ctx.currentTime - Vox.t0) * st.bpm / 60), lp = Vox.loopRun;
    return lp && b >= lp.end ? lp.start + (b - lp.end) % (lp.end - lp.start) : b;
  };

  Vox.play = async () => {
    await Vox.resume();
    if (st.playing) return;
    const ctx = Vox.ctx;
    st.playing = true;
    const lp = (Vox.loopRun = loopRange());
    if (lp && st.posBeats >= lp.end) st.posBeats = lp.start; // курсор за концом цикла — играем с начала цикла
    Vox.curPdc = Vox.maxPdc(ctx.sampleRate);
    Vox.t0 = ctx.currentTime + 0.08 + Vox.curPdc; Vox.startBeat = st.posBeats;
    sources = []; scheduleClips(ctx, Vox.live, Vox.t0, st.posBeats, sources, lp ? lp.end : null);
    nextLoopT = lp ? Vox.t0 + (lp.end - st.posBeats) * 60 / st.bpm : Infinity;
    nextStepIdx = Math.ceil(st.posBeats * 4 - 1e-6);
    nextStepTime = Vox.t0 + (nextStepIdx / 4 - st.posBeats) * 60 / st.bpm;
    tick(); timer = setInterval(tick, 25);
    broadcastTransport();
    Vox.emit('transport');
  };

  Vox.stop = () => {
    if (st.recording && Vox.recNode) Vox.recNode.port.postMessage({ cmd: 'stop' });
    if (!st.playing) { st.posBeats = 0; Vox.emit('transport'); return; }
    sources.forEach((s) => { try { s.stop(); } catch (e) {} }); sources = [];
    clearInterval(timer); timer = null;
    st.playing = false; st.posBeats = Vox.startBeat; Vox.loopRun = null;
    broadcastTransport();
    Vox.emit('transport');
  };

  Vox.togglePlay = () => (st.playing ? Vox.stop() : Vox.play());
  Vox.setPosition = (beat) => { const was = st.playing; if (was) Vox.stop(); st.posBeats = Math.max(0, beat); if (was) Vox.play(); else Vox.emit('transport'); };
  // зацикливание: границы — целые доли; во время игры перезапуск с текущего места
  Vox.setLoop = (patch) => {
    const L = Object.assign(st.loop, patch || {});
    L.start = Math.max(0, Math.round(L.start)); L.end = Math.max(L.start + 1, Math.round(L.end));
    if (st.playing && !st.recording) { const b = Vox.currentBeat(); Vox.stop(); st.posBeats = b; Vox.play(); }
    else Vox.emit('transport');
  };
  Vox.setBpm = (bpm) => {
    const was = st.playing; if (was) Vox.stop();
    st.bpm = Math.max(40, Math.min(240, bpm));
    if (Vox.live) Vox.live.forEach((n) => n.fx.forEach((f) => f && f.isDelay && f.apply(f.params)));
    if (was) Vox.play();
    Vox.emit('tracks');
  };

  /* ------------------------------ АУДИО-ФАЙЛЫ ------------------------------ */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  Vox.addBuffer = (buffer, name, id, u) => {
    if (id == null) id = bufSeq++; else bufSeq = Math.max(bufSeq, id + 1);
    Vox.buffers.set(id, { buffer, name, uid: u || uid() }); Vox.emit('buffers'); return id;
  };
  Vox.newClipId = () => clipSeq++;
  Vox.bumpIds = () => {
    st.tracks.forEach((t) => t.clips.forEach((c) => (clipSeq = Math.max(clipSeq, c.id + 1))));
    Vox.buffers.forEach((b, id) => (bufSeq = Math.max(bufSeq, id + 1)));
  };
  // ---- редактирование клипов ----
  const MIN_CLIP = 0.03;
  Vox.clampFades = (c) => {
    c.fadeIn = Math.max(0, Math.min(c.fadeIn || 0, c.dur));
    c.fadeOut = Math.max(0, Math.min(c.fadeOut || 0, c.dur - c.fadeIn));
  };
  // обрезка левого края: новая позиция начала в долях
  Vox.trimClipStart = (c, newStartBeat) => {
    const spb = 60 / st.bpm, b = Vox.buffers.get(c.bufferId); if (!b) return;
    const end = c.startBeat + c.dur / spb;
    let ns = Math.min(newStartBeat, end - MIN_CLIP / spb);
    ns = Math.max(ns, c.startBeat - c.offset / spb, 0);
    const d = (ns - c.startBeat) * spb;
    c.offset += d; c.dur -= d; c.startBeat = ns; Vox.clampFades(c);
  };
  // обрезка правого края: новая позиция конца в долях
  Vox.trimClipEnd = (c, newEndBeat) => {
    const spb = 60 / st.bpm, b = Vox.buffers.get(c.bufferId); if (!b) return;
    const dur = (newEndBeat - c.startBeat) * spb;
    c.dur = Math.max(MIN_CLIP, Math.min(dur, b.buffer.duration - c.offset)); Vox.clampFades(c);
  };
  // разрезать клип в позиции beat; возвращает правую часть
  Vox.splitClip = (clipId, beat) => {
    const f = Vox.findClip(clipId); if (!f) return null;
    const c = f.c, spb = 60 / st.bpm, cut = (beat - c.startBeat) * spb;
    if (cut < MIN_CLIP || cut > c.dur - MIN_CLIP) return null;
    const r = Object.assign({}, c, { id: clipSeq++, startBeat: beat, offset: c.offset + cut, dur: c.dur - cut, fadeIn: 0 });
    c.dur = cut; c.fadeOut = 0; Vox.clampFades(c); Vox.clampFades(r);
    st.tracks[f.ti].clips.push(r);
    Vox.emit('tracks'); return r;
  };
  // разрезать по курсору: выделенный клип или все клипы выбранной дорожки под курсором
  Vox.splitAtCursor = () => {
    const beat = st.playing ? Vox.currentBeat() : st.posBeats;
    const spb = 60 / st.bpm;
    const under = (c) => beat > c.startBeat && beat < c.startBeat + c.dur / spb;
    let list = [];
    if (st.selectedClip != null) { const f = Vox.findClip(st.selectedClip); if (f && under(f.c)) list = [f.c]; }
    if (!list.length) list = (st.tracks[st.selectedTrack] || { clips: [] }).clips.filter(under);
    if (!list.length) { Vox.hint('Под курсором нет клипа: поставь курсор кликом по линейке на нужное место'); return; }
    list.forEach((c) => Vox.splitClip(c.id, beat));
    Vox.hint('Разрезано по курсору');
  };
  Vox.addClip = (trackIdx, bufferId, startBeat) => {
    const b = Vox.buffers.get(bufferId); if (!b) return;
    const c = { id: clipSeq++, bufferId, startBeat, offset: 0, dur: b.buffer.duration, name: b.name, fadeIn: 0, fadeOut: 0 };
    st.tracks[trackIdx].clips.push(c); Vox.emit('tracks'); return c;
  };
  Vox.importFile = async (file, trackIdx, startBeat) => {
    await Vox.init();
    try {
      const buf = await Vox.ctx.decodeAudioData(await file.arrayBuffer());
      const id = Vox.addBuffer(buf, file.name.replace(/\.[^.]+$/, ''));
      Vox.addClip(trackIdx, id, startBeat);
      Vox.hint('Добавлено: ' + file.name);
    } catch (e) { Vox.hint('Не удалось открыть ' + file.name + '. Подойдут WAV, MP3, OGG, FLAC.'); }
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  Vox.findClip = (clipId) => {
    for (let ti = 0; ti < st.tracks.length; ti++) { const c = st.tracks[ti].clips.find((x) => x.id === clipId); if (c) return { c, ti }; }
    return null;
  };
  // копия клипа сразу после оригинала (как Ctrl+B в FL), выравнивание по доле
  Vox.duplicateClip = (clipId) => {
    const f = Vox.findClip(clipId); if (!f) return;
    const len = f.c.dur / (60 / st.bpm);
    const c = Object.assign({}, f.c, { id: clipSeq++, startBeat: f.c.startBeat + Math.ceil(len - 1e-6) });
    st.tracks[f.ti].clips.push(c); st.selectedClip = c.id;
    Vox.hint('Клип скопирован'); Vox.emit('tracks'); return c;
  };
  // новый канал микшера — копия существующего вместе с эффектами
  Vox.addInsert = (fromIdx, name) => {
    const src = st.mixer[fromIdx];
    const ch = src ? clone(src) : { name: 'Insert', vol: 0.8, pan: 0, mute: false, solo: false, fx: new Array(8).fill(null) };
    ch.name = name || ch.name; ch.solo = false;
    ch.fx.forEach((s) => { if (s && s.type === 'shkafx') s.params.uid = shkaUid(); }); // у копии своя запись волны
    st.mixer.push(ch);
    const i = st.mixer.length - 1;
    if (!ch.sends) ch.sends = {};
    Vox.syncMixer();
    Vox.emit('mixer'); return i;
  };
  // копия дорожки: все клипы + свой канал микшера с теми же эффектами
  Vox.duplicateTrack = (ti, opts) => {
    const tr = st.tracks[ti]; if (!tr) return;
    const o = opts || {};
    const name = o.name || tr.name + ' копия';
    const ins = o.sameInsert ? tr.insert : Vox.addInsert(tr.insert, (st.mixer[tr.insert].name + ' 2').slice(0, 24));
    const nt = { name, color: (tr.color % 6) + 1, insert: ins, armed: false, mute: false,
      clips: tr.clips.map((c) => Object.assign({}, c, { id: clipSeq++ })) };
    st.tracks.splice(ti + 1, 0, nt);
    st.selectedTrack = ti + 1; st.selectedInsert = ins;
    Vox.hint('Дорожка «' + tr.name + '» продублирована в «' + name + '», канал ' + ins);
    Vox.emit('tracks'); Vox.emit('mixer');
    return ti + 1;
  };
  Vox.deleteClip = (clipId) => {
    st.tracks.forEach((t) => (t.clips = t.clips.filter((c) => c.id !== clipId)));
    if (st.selectedClip === clipId) st.selectedClip = null;
    Vox.emit('tracks');
  };
  Vox.songBeats = () => {
    const spb = 60 / st.bpm; let end = 0;
    st.tracks.forEach((t) => t.clips.forEach((c) => (end = Math.max(end, c.startBeat + c.dur / spb))));
    return end > 0 ? Math.ceil(end / 4) * 4 : 32;
  };

  /* ------------------------------ МИКРОФОН И ЗАПИСЬ ------------------------------ */
  let recChunks = [], recTrack = null, recStartBeat = 0, recCount = 0;

  Vox.openMic = async () => {
    await Vox.resume();
    if (Vox.micStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nomic');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, latency: 0 }
    });
    const ctx = Vox.ctx;
    Vox.micStream = stream;
    const src = (Vox.micSrc = ctx.createMediaStreamSource(stream));
    Vox.recNode = new AudioWorkletNode(ctx, 'vox-recorder', { outputChannelCount: [1] });
    const sink = ctx.createGain(); sink.gain.value = 0;
    src.connect(Vox.recNode); Vox.recNode.connect(sink); sink.connect(ctx.destination);
    Vox.micAnalyser = ctx.createAnalyser(); Vox.micAnalyser.fftSize = 512; src.connect(Vox.micAnalyser);
    Vox.monGain = ctx.createGain(); src.connect(Vox.monGain);
    Vox.recNode.port.onmessage = (e) => {
      if (e.data.type === 'data') recChunks.push(e.data.data);
      else if (e.data.type === 'done') finishRecord();
    };
    Vox.routeMonitor();
    const label = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : '';
    Vox.hint('Микрофон подключён' + (label ? ': ' + label : ''));
    Vox.emit('mic');
  };

  Vox.routeMonitor = () => {
    if (!Vox.monGain) return;
    try { Vox.monGain.disconnect(); } catch (e) {}
    const tr = st.tracks.find((t) => t.armed);
    Vox.monGain.gain.value = st.monitor ? 1 : 0;
    if (tr && Vox.live) Vox.monGain.connect(Vox.live[tr.insert].input);
  };
  Vox.setMonitor = async (on) => {
    if (on) { try { await Vox.openMic(); } catch (e) { micError(e); return; } }
    st.monitor = on; Vox.routeMonitor(); Vox.emit('transport');
  };

  function micError(e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.message === 'nomic'))
      Vox.hint('Нет доступа к микрофону. В предпросмотре Claude запись отключена: открой студию с GitHub Pages или локального сервера и разреши микрофон.');
    else Vox.hint('Микрофон не найден: ' + (e && e.message ? e.message : 'неизвестная ошибка'));
  }

  Vox.toggleRecord = async () => {
    if (st.recording) { Vox.stop(); return; }
    const ti = st.tracks.findIndex((t) => t.armed);
    if (ti < 0) { Vox.hint('Включи кнопку записи (●) на нужной дорожке'); return; }
    try { await Vox.openMic(); } catch (e) { micError(e); return; }
    if (st.playing) Vox.stop();
    recChunks = []; recTrack = ti; recStartBeat = st.posBeats;
    st.recording = true;
    await Vox.play();
    Vox.recNode.port.postMessage({ cmd: 'start', at: Vox.t0 });
    Vox.emit('transport');
  };

  function finishRecord() {
    st.recording = false;
    const ctx = Vox.ctx, total = recChunks.reduce((a, c) => a + c.length, 0);
    Vox.emit('transport');
    if (total < ctx.sampleRate * 0.15) { Vox.hint('Запись слишком короткая'); return; }
    const buf = ctx.createBuffer(1, total, ctx.sampleRate), d = buf.getChannelData(0);
    let o = 0; recChunks.forEach((c) => { d.set(c, o); o += c.length; }); recChunks = [];
    const tr = st.tracks[recTrack];
    const id = Vox.addBuffer(buf, tr.name + ' #' + ++recCount);
    // компенсация задержки: звук пришёл позже на выход + вход + ручную поправку
    const lat = (ctx.outputLatency || ctx.baseLatency || 0) + st.latencyMs / 1000;
    const off = Math.max(0, Math.min(buf.duration - 0.05, lat));
    tr.clips.push({ id: clipSeq++, bufferId: id, startBeat: recStartBeat, offset: off, dur: buf.duration - off, name: Vox.buffers.get(id).name, fadeIn: 0.005, fadeOut: 0.01 });
    Vox.hint('Записано ' + buf.duration.toFixed(1) + ' с на дорожку «' + tr.name + '»');
    Vox.emit('tracks');
  }

  /* ------------------------------ ЭКСПОРТ ------------------------------ */
  function encodeWav(ab) {
    const nc = ab.numberOfChannels, len = ab.length, sr = ab.sampleRate;
    const view = new DataView(new ArrayBuffer(44 + len * nc * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); view.setUint32(4, 36 + len * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nc, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * nc * 2, true); view.setUint16(32, nc * 2, true);
    view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, len * nc * 2, true);
    const chs = []; for (let c = 0; c < nc; c++) chs.push(ab.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i])); view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  Vox.encodeWav = encodeWav;
  // сохранить файл: в артефакте Claude — через окно подтверждения, иначе обычной загрузкой
  Vox.saveBlob = async (name, blob) => {
    const ext = (name.split('.').pop() || '').toLowerCase();
    try {
      if (window.claude && window.claude.use && ['zip', 'json'].includes(ext)) {
        const dl = await window.claude.use('downloads');
        if (dl) { await dl.save({ filename: name, data: blob }); return true; }
      }
    } catch (e) { if (e && e.code === 'declined') return false; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  };
  Vox.exportMix = async () => {
    await Vox.init();
    if (st.playing) Vox.stop();
    Vox.hint('Сводим проект в WAV…');
    const sr = Vox.ctx.sampleRate, spb = 60 / st.bpm;
    const songSec = Vox.songBeats() * spb, len = songSec + 2.5;
    const pre = Vox.maxPdc(sr), preN = Math.round(pre * sr);
    const oc = new OfflineAudioContext(2, Math.ceil(len * sr) + preN, sr);
    await loadWorklets(oc);
    Vox.offlineT0 = pre;
    const chans = buildMixer(oc, false);
    scheduleClips(oc, chans, pre, 0, []);
    if (st.patternInSong) { const sd = spb / 4; for (let s = 0; s * sd < songSec; s++) playStep(oc, chans, s % 16, pre + s * sd); }
    const rendered = await oc.startRendering();
    chans.forEach(disposeChannel);
    // отрезаем запас под задержку эффектов, чтобы микс начинался ровно с 1-го такта
    const out = new AudioBuffer({ numberOfChannels: 2, length: rendered.length - preN, sampleRate: sr });
    for (let c = 0; c < 2; c++) out.copyToChannel(rendered.getChannelData(c).subarray(preN), c);
    const name = (st.projectName || 'WOK Studio') + ' mix.wav';
    await Vox.saveBlob(name, encodeWav(out));
    Vox.hint('Готово: ' + name + ', ' + songSec.toFixed(0) + ' с. Если файл не скачался, открой студию вне предпросмотра Claude.');
  };
})();
