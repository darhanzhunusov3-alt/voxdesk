/* =====================================================================
   WOK Studio — ПРОЕКТ
   Отмена/повтор (Ctrl+Z / Ctrl+Y), сохранение и открытие проекта
   (.wok.zip, раньше .voxdesk.zip: project.json + аудио в WAV), автосохранение в браузере.
   ===================================================================== */
(function () {
  const st = Vox.state;

  /* ------------------------------ снимок состояния ------------------------------ */
  // то, что входит в проект и в историю отмены (без позиции курсора, выделения и т. п.)
  function snapObj() {
    return {
      projectName: st.projectName, bpm: st.bpm, patternInSong: st.patternInSong,
      tracks: st.tracks.map((t) => { const o = Object.assign({}, t); delete o.armed; return o; }),
      mixer: st.mixer, rack: st.rack
    };
  }
  // в историю отмены не кладём состояние выделений ShkaFX (у плагина своя отмена внутри окна)
  const snapJSON = () => JSON.stringify(snapObj(), (k, v) => (k === 'data' ? undefined : v));

  // применить снимок к студии (отмена, открытие проекта, новый проект)
  Vox.applySnapshot = (o) => {
    if (st.playing || st.recording) Vox.stop();
    const armedIdx = st.tracks.findIndex((t) => t.armed);
    const copy = JSON.parse(JSON.stringify(o));
    st.projectName = copy.projectName || 'WOK Studio';
    st.bpm = copy.bpm || 140;
    st.patternInSong = copy.patternInSong !== false;
    st.tracks = copy.tracks.map((t, i) => Object.assign(t, { armed: i === (armedIdx >= 0 ? armedIdx : 0) && armedIdx >= 0 }));
    st.mixer = copy.mixer;
    st.rack = copy.rack;
    st.selectedTrack = Math.min(st.selectedTrack, st.tracks.length - 1);
    st.selectedInsert = Math.min(st.selectedInsert, st.mixer.length - 1);
    if (st.selectedClip != null && !Vox.findClip(st.selectedClip)) st.selectedClip = null;
    Vox.bumpIds();
    Vox.syncMixer();
    Vox.emit('project');
    Vox.emit('tracks');
    Vox.emit('mixer');
  };

  /* ------------------------------ ОТМЕНА / ПОВТОР ------------------------------ */
  const H = (Vox.history = { stack: [], idx: -1, max: 120, timer: null });
  H.reset = () => { H.stack = [snapJSON()]; H.idx = 0; Vox.emit('history'); };
  H.check = () => {
    clearTimeout(H.timer); H.timer = null;
    const s = snapJSON();
    if (s === H.stack[H.idx]) return;
    H.stack = H.stack.slice(0, H.idx + 1);
    H.stack.push(s);
    if (H.stack.length > H.max) H.stack.shift();
    H.idx = H.stack.length - 1;
    Vox.emit('history');
    Auto.schedule();
  };
  H.schedule = () => { clearTimeout(H.timer); H.timer = setTimeout(H.check, 250); };
  H.undo = () => {
    H.check();
    if (H.idx <= 0) { Vox.hint('Нечего отменять'); return; }
    H.idx--; Vox.applySnapshot(JSON.parse(H.stack[H.idx]));
    Vox.hint('Отменено (Ctrl+Y — вернуть)'); Vox.emit('history'); Auto.schedule();
  };
  H.redo = () => {
    H.check();
    if (H.idx >= H.stack.length - 1) { Vox.hint('Нечего возвращать'); return; }
    H.idx++; Vox.applySnapshot(JSON.parse(H.stack[H.idx]));
    Vox.hint('Возвращено'); Vox.emit('history'); Auto.schedule();
  };
  // любое законченное действие пользователя — повод проверить, изменилось ли что-то
  ['pointerup', 'change', 'keyup'].forEach((ev) => document.addEventListener(ev, () => H.schedule(), true));
  Vox.on('tracks', () => H.schedule());
  Vox.on('mixer', () => H.schedule());

  /* ------------------------------ ZIP ------------------------------ */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  // простой zip без сжатия (WAV всё равно почти не сжимается); открывается любым архиватором
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach((f) => {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((a, p) => a + (p.byteLength || p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  async function readZip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let e = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('это не zip');
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const out = {};
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('повреждённый архив');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      const dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      let data = u8.subarray(dataStart, dataStart + csize);
      if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else if (method !== 0) throw new Error('неизвестный способ сжатия в архиве');
      out[name] = data;
      p += 46 + nl + xl + cl;
    }
    return out;
  }

  Vox.makeZip = makeZip;
  /* ------------------------------ WAV (32-бит float, без потерь) ------------------------------ */
  function floatWav(ab) {
    const nc = ab.numberOfChannels, len = ab.length, sr = ab.sampleRate, bytes = len * nc * 4;
    const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * nc * 4, true); v.setUint16(32, nc * 4, true); v.setUint16(34, 32, true);
    w(36, 'data'); v.setUint32(40, bytes, true);
    const f = new Float32Array(buf, 44), chs = []; for (let c = 0; c < nc; c++) chs.push(ab.getChannelData(c));
    for (let i = 0, o = 0; i < len; i++) for (let c = 0; c < nc; c++) f[o++] = chs[c][i];
    return new Uint8Array(buf);
  }

  /* ------------------------------ СОХРАНИТЬ / ОТКРЫТЬ ------------------------------ */
  const safeName = (s) => (s || 'Проект').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Проект';

  Vox.saveProject = async () => {
    H.check();
    if (Vox.shkaFlush) await Vox.shkaFlush();
    Vox.hint('Собираю проект…');
    const used = new Set(); st.tracks.forEach((t) => t.clips.forEach((c) => used.add(c.bufferId)));
    const files = [], list = [];
    Vox.buffers.forEach((b, id) => {
      if (!used.has(id)) return;
      const file = 'audio/' + id + ' ' + safeName(b.name) + '.wav';
      files.push({ name: file, data: floatWav(b.buffer) });
      list.push({ id, name: b.name, uid: b.uid, file });
    });
    const meta = { app: 'WOK Studio', format: 1, savedAt: new Date().toISOString(), state: snapObj(), buffers: list };
    files.unshift({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
    const name = safeName(st.projectName) + '.wok.zip';
    const ok = await Vox.saveBlob(name, makeZip(files));
    Vox.hint(ok ? 'Проект сохранён: ' + name : 'Сохранение отменено');
  };

  Vox.openProjectFile = async (file) => {
    await Vox.init();
    Vox.hint('Открываю ' + file.name + '…');
    try {
      const z = await readZip(await file.arrayBuffer());
      if (!z['project.json']) throw new Error('в архиве нет project.json');
      const meta = JSON.parse(new TextDecoder().decode(z['project.json']));
      // проекты, сохранённые до переименования, — тоже наши
      if (meta.app !== 'WOK Studio' && meta.app !== 'VoxDesk') throw new Error('это не проект WOK Studio');
      const bufs = new Map();
      for (const b of meta.buffers) {
        const data = z[b.file]; if (!data) continue;
        const ab = await Vox.ctx.decodeAudioData(data.slice().buffer);
        bufs.set(b.id, { buffer: ab, name: b.name, uid: b.uid });
      }
      Vox.buffers.clear();
      bufs.forEach((b, id) => Vox.addBuffer(b.buffer, b.name, id, b.uid));
      Vox.applySnapshot(meta.state);
      H.reset(); Auto.fresh(); Auto.schedule();
      Vox.hint('Открыт проект «' + st.projectName + '»');
    } catch (e) {
      Vox.hint('Не удалось открыть проект: ' + e.message);
    }
  };

  const DEFAULT = snapJSON();
  Vox.newProject = () => {
    Vox.buffers.clear(); Vox.emit('buffers');
    const o = JSON.parse(DEFAULT); o.projectName = 'WOK Studio';
    Vox.applySnapshot(o);
    H.reset(); Auto.fresh(); Auto.schedule();
    Vox.hint('Новый проект');
  };

  /* ------------------------------ АВТОСОХРАНЕНИЕ (IndexedDB в этом браузере) ------------------------------ */
  const Auto = (Vox.autosave = { timer: null, saved: new Set(), cleared: false, enabled: true });
  function db() {
    if (Auto.dbp) return Auto.dbp;
    Auto.dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('voxdesk', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('buffers'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return Auto.dbp;
  }
  const tx = async (store, mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then((v) => (out = v));
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  Auto.fresh = () => { Auto.cleared = false; Auto.saved = new Set(); };
  Auto.schedule = () => { if (!Auto.enabled) return; clearTimeout(Auto.timer); Auto.timer = setTimeout(Auto.save, 2500); };
  Auto.save = async () => {
    try {
      if (Vox.shkaFlush) await Vox.shkaFlush();
      // в новой сессии оставляем в базе только прошлый проект (его можно восстановить), остальное чистим
      if (!Auto.cleared) {
        const keep = new Set(Auto.startup ? Auto.startup.buffers.map((b) => b.uid) : []);
        await tx('buffers', 'readwrite', async (s) => {
          const keys = await req(s.getAllKeys());
          keys.forEach((k) => { if (!keep.has(k)) s.delete(k); });
        });
        Auto.cleared = true;
      }
      const list = [];
      for (const [id, b] of Vox.buffers) {
        list.push({ id, uid: b.uid, name: b.name });
        if (Auto.saved.has(b.uid)) continue;
        const chans = []; for (let c = 0; c < b.buffer.numberOfChannels; c++) chans.push(b.buffer.getChannelData(c).slice());
        await tx('buffers', 'readwrite', (s) => s.put({ sampleRate: b.buffer.sampleRate, chans }, b.uid));
        Auto.saved.add(b.uid);
      }
      await tx('kv', 'readwrite', (s) => s.put({ state: snapObj(), buffers: list, savedAt: Date.now() }, 'autosave'));
    } catch (e) { /* автосохранение — удобство, без него студия работает */ }
  };
  Auto.peek = async () => { try { return await tx('kv', 'readonly', (s) => req(s.get('autosave'))); } catch (e) { return null; } };
  Auto.restore = async () => {
    const a = Auto.startup; if (!a) return;
    await Vox.init();
    Vox.buffers.clear();
    for (const b of a.buffers) {
      const rec = await tx('buffers', 'readonly', (s) => req(s.get(b.uid)));
      if (!rec) continue;
      const ab = new AudioBuffer({ numberOfChannels: rec.chans.length, length: rec.chans[0].length, sampleRate: rec.sampleRate });
      rec.chans.forEach((d, c) => ab.copyToChannel(d, c));
      Vox.addBuffer(ab, b.name, b.id, b.uid);
      Auto.saved.add(b.uid);
    }
    Vox.applySnapshot(a.state);
    H.reset(); Auto.schedule();
    Vox.hint('Восстановлен проект «' + st.projectName + '»');
  };

  // при запуске: есть ли что восстановить
  H.reset();
  Auto.peek().then((a) => {
    if (!a) return;
    Auto.startup = a;
    const hasWork = a.state && a.state.tracks && a.state.tracks.some((t) => t.clips && t.clips.length);
    if (hasWork) Vox.emit('restore-available', a);
  });
})();
