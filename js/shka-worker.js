/* =====================================================================
   WOK Studio — фоновая часть ShkaFX (Web Worker)
   Здесь работает SwellEngine из исходников плагина: записанная волна,
   выделения, расчёт хвостов и офлайн-рендер. Готовые хвосты уходят в
   AudioWorklet, список выделений — в окно плагина.
   Функция целиком отправляется в Worker (через toString).
   ===================================================================== */
function voxShkaWorker() {
  let e = null, mem = null, timer = null, lastRC = -1, lastCC = -1, lastSent = 0, dataTimer = null;
  const wasi = {
    fd_close: () => 0, fd_seek: () => 0, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8,
    proc_exit: () => { throw new Error('exit'); },
    fd_write: (fd, iov, n, pw) => { const dv = new DataView(mem.buffer); let t = 0; for (let i = 0; i < n; i++) t += dv.getUint32(iov + i * 8 + 4, true); dv.setUint32(pw, t, true); return 0; }
  };
  const f32 = (p, n) => new Float32Array(mem.buffer, p, n);
  const str = () => new TextDecoder().decode(new Uint8Array(mem.buffer, e.shka_str(), e.shka_str_len()));
  let scratch = 0, scratchN = 0;
  const buf = (n) => { if (n > scratchN) { if (scratch) e.shka_free(scratch); scratch = e.shka_alloc(n * 4); scratchN = n; } return scratch; };
  let bpm = 120, np = 0;

  function sendTails() {
    const n = e.shka_tails_count(), list = [], tr = [];
    for (let i = 0; i < n; i++) {
      const len = e.shka_tail_len(i);
      const l = f32(e.shka_tail_l(i), len).slice(), r = f32(e.shka_tail_r(i), len).slice();
      list.push({ start: e.shka_tail_start(i), l, r }); tr.push(l.buffer, r.buffer);
    }
    postMessage({ type: 'tails', tails: list }, tr);
  }
  function regions() { e.shka_regions_json(); return JSON.parse(str()); }
  function tick() {
    if (e.shka_pump()) sendTails();
    const rc = e.shka_region_counter(), cc = e.shka_change_counter(), now = Date.now();
    if (rc !== lastRC || (cc !== lastCC && now - lastSent > 250)) {
      const regionsChanged = rc !== lastRC;
      lastRC = rc; lastCC = cc; lastSent = now;
      postMessage({ type: 'regions', regions: regions() });
      // после правки выделений сохраняем состояние для проекта (с небольшой паузой)
      if (regionsChanged) { clearTimeout(dataTimer); dataTimer = setTimeout(() => postMessage({ type: 'data', data: serialise() }), 1200); }
    }
  }
  function serialise() { const n = e.shka_serialise(); return new Uint8Array(mem.buffer, e.shka_str(), n).slice(); }

  const H = {
    async init(m) {
      const inst = await WebAssembly.instantiate(m.module, { wasi_snapshot_preview1: wasi });
      e = inst.exports; mem = e.memory; e._initialize();
      np = e.shka_create(m.sr);
      e.shka_params_json(); const params = JSON.parse(str());
      if (m.values) { f32(e.shka_values(), np).set(m.values); }
      bpm = m.bpm || 120; e.shka_set_global(bpm);
      if (m.data && m.data.length) H.deserialise({ data: m.data });
      timer = setInterval(tick, 15);
      return { params };
    },
    values(m) { f32(e.shka_values(), np).set(m.values); if (m.bpm) bpm = m.bpm; e.shka_set_global(bpm); },
    call(m) { return e[m.fn](...(m.args || [])); },
    regionVals(m) { const n = e.shka_region_vals(m.id); return Array.from(f32(e.shka_fbuf(), n)); },
    peaks(m) { const n = e.shka_peaks(m.start, m.end, m.columns); return Array.from(f32(e.shka_fbuf(), n), (v) => Math.round(v * 1000) / 1000); },
    regions() { return regions(); },
    loadSource(m) {
      const n = m.L.length, pl = e.shka_alloc(n * 4), pr = e.shka_alloc(n * 4);
      f32(pl, n).set(m.L); f32(pr, n).set(m.R);
      const nm = new TextEncoder().encode(m.name + '\0'), pn = e.shka_alloc(nm.length); new Uint8Array(mem.buffer, pn, nm.length).set(nm);
      e.shka_load_source(pl, pr, n, pn, m.keepRegions ? 1 : 0);
      e.shka_free(pl); e.shka_free(pr); e.shka_free(pn);
      return true;
    },
    render(m) {
      const ok = e.shka_render(m.includeVocal ? 1 : 0, m.onlyRegion || 0, m.bpm || bpm, m.alignToBar ? 1 : 0, m.rangeStart || 0, m.rangeEnd || 0);
      if (!ok) return { ok: false, error: str() };
      const n = e.shka_res_len(), vn = e.shka_res_voxlen();
      const out = { ok: true, start: e.shka_res_start(), fxL: f32(e.shka_res_fxl(), n).slice(), fxR: f32(e.shka_res_fxr(), n).slice() };
      if (vn) { out.voxL = f32(e.shka_res_voxl(), vn).slice(); out.voxR = f32(e.shka_res_voxr(), vn).slice(); }
      e.shka_res_free();
      return out;
    },
    serialise() { return serialise(); },
    deserialise(m) {
      const d = m.data, p = e.shka_alloc(d.length); new Uint8Array(mem.buffer, p, d.length).set(d);
      e.shka_deserialise(p, d.length); e.shka_free(p);
    },
    capture(m) {
      const n = m.data.length, p = buf(n); f32(p, n).set(m.data); e.shka_capture(m.pos, p, n);
    },
    capPort(m) { m.port.onmessage = (ev) => H.capture(ev.data); }
  };
  onmessage = async (ev) => {
    const m = ev.data;
    try {
      const r = await H[m.cmd](m);
      if (m.id) postMessage({ type: 'reply', id: m.id, result: r }, r && r.fxL ? [r.fxL.buffer, r.fxR.buffer].concat(r.voxL ? [r.voxL.buffer, r.voxR.buffer] : []) : []);
    } catch (err) {
      if (m.id) postMessage({ type: 'reply', id: m.id, error: String(err && err.message || err) });
    }
  };
}
