/* ShkaFX — логика интерфейса.
 *
 * Как устроено:
 *   1) Backend — связь с плагином (window.__JUCE__.backend) или «заглушка» для браузера.
 *   2) P — состояние параметров: id -> { desc, norm, value, text }, подписчики на изменения.
 *   3) Компоненты: knob(), toggle(), choice() — создают DOM и сами обновляются.
 *   4) wave — волна дорожки, выделения слогов и хвосты.
 * Протокол обмена с плагином описан в UI_API.md.
 */
(() => {
  "use strict";

  // ===================================================================== Backend
  const Backend = (() => {
    const juce = window.__JUCE__ && window.__JUCE__.backend;
    if (juce) {
      return {
        live: true,
        on: (ev, fn) => juce.addEventListener(ev, fn),
        emit: (ev, obj) => juce.emitEvent(ev, obj || {}),
      };
    }
    return createMockBackend();
  })();

  // ===================================================================== Математика шкал (как NormalisableRange в JUCE)
  function skewOf(d) {
    if (!d.centre || d.centre <= d.min || d.centre >= d.max) return 1;
    return Math.log(0.5) / Math.log((d.centre - d.min) / (d.max - d.min));
  }
  function fromNorm(d, n) {
    n = Math.min(1, Math.max(0, n));
    if (d.kind !== "float") return Math.round(d.min + n * (d.max - d.min));
    const s = skewOf(d);
    const p = s === 1 ? n : (n > 0 ? Math.exp(Math.log(n) / s) : 0);
    return d.min + (d.max - d.min) * p;
  }
  function toNorm(d, v) {
    const p = Math.min(1, Math.max(0, (v - d.min) / (d.max - d.min)));
    if (d.kind !== "float") return p;
    const s = skewOf(d);
    return s === 1 ? p : Math.pow(p, s);
  }
  function formatValue(d, v) {
    if (d.kind === "bool") return v > 0.5 ? "On" : "Off";
    if (d.kind === "choice") return d.choices[Math.round(v)] || "";
    switch (d.unit) {
      case "Hz": return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " kHz" : v.toFixed(v < 100 ? 1 : 0) + " Hz";
      case "dB": return (v > 0 ? "+" : "") + v.toFixed(Math.abs(v) < 10 ? 2 : 1) + " dB";
      case "%": return v.toFixed(1) + " %";
      case "ms": return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + " ms";
      case "s": return v.toFixed(2) + " s";
      case "x": return v.toFixed(2) + "x";
      case "BPM": return v.toFixed(1);
      default: return v.toFixed(2);
    }
  }

  // ===================================================================== Состояние
  // Эти ручки общие для плагина; остальные — свои у каждого выделения
  const GLOBAL_ONLY = new Set(["bpm_src", "bpm", "out_gain", "sw_capture", "dla_throw", "dlb_throw", "sw_on", "dl_on"]);   // кружки вкл/выкл модулей — на весь плагин
  // Какие ручки относятся к выделению: у хвоста — «Плавный вход» (sw_, rv_, pm_), у Delay A/B — «Delay на слово»
  // (общие dl_ и свои dla_/dlb_). Остальные ручки при выбранном выделении настраивают новые выделения, а не его.
  function relevantTo(id, type) {
    if (!type) return /^(sw_|rv_|pm_)/.test(id);
    return id.startsWith("dl_") || id.startsWith(type === 1 ? "dla_" : "dlb_");
  }
  const P = {
    map: new Map(),
    subs: new Map(),
    order: [],               // id в порядке таблицы параметров (как в плагине)
    region: null,            // { id, vals: Map } — выбранное выделение: ручки показывают и меняют его настройки
    scoped(id) { return !!this.region && !GLOBAL_ONLY.has(id) && relevantTo(id, this.region.type) && this.region.vals.has(id); },
    get(id) {
      const p = this.map.get(id);
      if (!p || !this.scoped(id)) return p;
      const v = this.region.vals.get(id);
      return { desc: p.desc, value: v, norm: toNorm(p.desc, v), text: formatValue(p.desc, v) };
    },
    notify(id) { const p = this.get(id); if (p) (this.subs.get(id) || []).forEach((fn) => fn(p)); },
    setScope(regionId, vals, type) {
      const was = this.region;
      if (regionId && vals && vals.length === this.order.length) {
        this.region = { id: regionId, type: type || 0, vals: new Map(this.order.map((id, i) => [id, vals[i]])) };
      } else this.region = null;
      if (was || this.region) this.order.forEach((id) => this.notify(id));
      (this.scopeSubs || []).forEach((fn) => fn(this.region));
    },
    onScope(fn) { (this.scopeSubs = this.scopeSubs || []).push(fn); },
    setRegionValue(id, value) {
      const d = this.map.get(id).desc;
      if (d.kind !== "float") value = Math.round(value);
      value = Math.min(d.max, Math.max(d.min, value));
      this.region.vals.set(id, value);
      this.notify(id);
      const rid = this.region.id, index = this.order.indexOf(id);
      const key = rid + ":" + id;
      this.pending = this.pending || new Map();
      const fire = () => { this.pending.delete(key); Backend.emit("lf_setRegionParam", { id: rid, index, value: this.region && this.region.id === rid ? this.region.vals.get(id) : value }); };
      if (!this.pending.has(key)) { this.pending.set(key, setTimeout(fire, 60)); }
    },
    scope: "app",            // "module" — подписки текущего открытого модуля, снимаются при переключении
    on(id, fn) {
      if (!this.subs.has(id)) this.subs.set(id, []);
      fn._scope = this.scope;
      this.subs.get(id).push(fn);
      const p = this.get(id);
      if (p) fn(p);
    },
    update(ch) {
      const p = this.map.get(ch.id);
      if (!p) return;
      p.norm = ch.norm; p.value = ch.value; p.text = ch.text;
      if (!this.scoped(ch.id)) (this.subs.get(ch.id) || []).forEach((fn) => fn(p));
    },
    set(id, norm, gesture) {
      if (this.scoped(id)) return this.setRegionValue(id, fromNorm(this.map.get(id).desc, norm));
      Backend.emit("vc_set", { id, norm, gesture: !!gesture });
    },
    setValue(id, value) {
      if (this.scoped(id)) return this.setRegionValue(id, value);
      Backend.emit("vc_setValue", { id, value });
    },
    begin(id) { if (!this.scoped(id)) Backend.emit("vc_begin", { id }); },
    end(id) { if (!this.scoped(id)) Backend.emit("vc_end", { id }); },
    reset(id) {
      if (this.scoped(id)) return this.setRegionValue(id, this.map.get(id).desc.def);
      Backend.emit("vc_default", { id });
    },
    isOn(id) { const p = this.get(id); return !!p && p.value > 0.5; },
  };


  // ===================================================================== DOM-помощники
  const $ = (sel, el = document) => el.querySelector(sel);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
    return el;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }
  function shortName(d) {
    // «SSL HMF Gain» -> «HMF Gain»: имя модуля уже видно в заголовке
    return d.name.replace(/^(Swell|Throw [AB]|Delay)\s+/, "") || d.name;
  }

  // ===================================================================== Ручка
  const A0 = 135, A1 = 405; // градусы: от левого-нижнего до правого-нижнего
  function polar(cx, cy, r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function arc(cx, cy, r, a, b) {
    if (Math.abs(b - a) < 0.01) b = a + 0.01;
    const [x0, y0] = polar(cx, cy, r, a), [x1, y1] = polar(cx, cy, r, b);
    const large = Math.abs(b - a) > 180 ? 1 : 0;
    const sweep = b > a ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
  }

  function knob(id, opts = {}) {
    const p = P.get(id);
    if (!p) return h("div", null, "?" + id);
    const d = p.desc;
    const svg = s("svg", { viewBox: "0 0 60 60", role: "slider", tabindex: "0", "aria-label": d.name });
    const track = s("path", { class: "track", d: arc(30, 30, 24, A0, A1) });
    const fill = s("path", { class: "fill" });
    const cap = s("circle", { class: "cap", cx: 30, cy: 30, r: 16 });
    const ptr = s("line", { class: "ptr", x1: 30, y1: 30, x2: 30, y2: 17 });
    svg.append(track, fill, cap, ptr);

    const value = h("button", { class: "knob-value", type: "button", title: "Type a value" });
    const label = h("div", { class: "knob-label" }, opts.label || shortName(d));
    const glow = h("span", { class: "knob-glow", "aria-hidden": "true" });
    const box = h("div", { class: "knob" + (opts.big ? " big" : "") }, glow, svg, label, value);

    const bipolar = d.min < 0 && d.max > 0 && !d.reverse;
    const zeroNorm = bipolar ? toNorm(d, 0) : 0;
    function draw(pp) {
      const shown = d.reverse ? 1 - pp.norm : pp.norm;
      const ang = A0 + shown * (A1 - A0);
      const from = A0 + (d.reverse ? 0 : zeroNorm) * (A1 - A0);
      fill.setAttribute("d", ang >= from ? arc(30, 30, 24, from, ang) : arc(30, 30, 24, ang, from));
      ptr.setAttribute("transform", `rotate(${ang - 360} 30 30)`);
      // яркость свечения при наведении — насколько ручка выкручена (у ручек «от центра» — насколько далеко от центра)
      const gl = bipolar ? Math.abs(pp.norm - zeroNorm) / Math.max(zeroNorm, 1 - zeroNorm) : shown;
      box.style.setProperty("--g", Math.min(1, Math.max(0, gl)).toFixed(3));
      value.textContent = pp.text;
      svg.setAttribute("aria-valuetext", pp.text);
    }
    P.on(id, draw);

    // перетаскивание
    let dragging = false, startY = 0, startNorm = 0;
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; startY = e.clientY; startNorm = P.get(id).norm; box.classList.add("drag");
      svg.setPointerCapture(e.pointerId);
      P.begin(id);
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const speed = e.shiftKey ? 1000 : 220;
      let dn = (startY - e.clientY) / speed;
      if (d.reverse) dn = -dn;
      const n = Math.min(1, Math.max(0, startNorm + dn));
      if (e.shiftKey) { startNorm = n; startY = e.clientY; }
      P.set(id, n, true);
      if (opts.onDrag) opts.onDrag(n);
    });
    const stop = (e) => { if (!dragging) return; dragging = false; box.classList.remove("drag"); P.end(id); try { svg.releasePointerCapture(e.pointerId); } catch (_) {} };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("dblclick", () => P.reset(id));
    // колесо мыши ручку не крутит — чтобы при прокрутке окна случайно ничего не задеть
    svg.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.002 : 0.01;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") P.set(id, Math.min(1, P.get(id).norm + (d.reverse ? -step : step)));
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") P.set(id, Math.max(0, P.get(id).norm - (d.reverse ? -step : step)));
      else return;
      e.preventDefault();
    });

    // ввод числа
    value.addEventListener("click", () => {
      const input = h("input", { class: "knob-input", type: "text", value: String(+P.get(id).value.toFixed(3)) });
      value.replaceWith(input);
      input.focus(); input.select();
      let finished = false;
      const done = (commit) => {
        if (finished) return;
        finished = true;
        if (commit) {
          const v = parseFloat(input.value.replace(",", ".").replace(/k$/i, "e3"));
          if (Number.isFinite(v)) P.setValue(id, v);
        }
        input.replaceWith(value);
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
      input.addEventListener("blur", () => done(true), { once: true });
    });
    return box;
  }

  // Плавающая заливка для переключателей с вариантами: фиолетовая «таблетка» плавно переезжает на выбранный вариант
  function attachPill(container, selector) {
    const pill = h("span", { class: "seg-pill", "aria-hidden": "true" });
    container.prepend(pill);
    container.classList.add("has-pill");
    let first = true;
    const place = (instant) => {
      const on = container.querySelector(selector + ".on");
      if (!on || !on.offsetWidth) { pill.style.opacity = "0"; return; }
      if (instant || first) pill.style.transition = "none";
      pill.style.opacity = "1";
      pill.style.width = on.offsetWidth + "px";
      pill.style.height = on.offsetHeight + "px";
      pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
      if (instant || first) { void pill.offsetWidth; pill.style.transition = ""; first = false; }
    };
    new MutationObserver(() => place(false)).observe(container, { subtree: true, attributes: true, attributeFilter: ["class"] });
    if (window.ResizeObserver) new ResizeObserver(() => place(true)).observe(container);
    requestAnimationFrame(() => place(true));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => place(true));
    return place;
  }

  function toggle(id, opts = {}) {
    const p = P.get(id);
    if (!p) return h("div", null, "?" + id);
    const b = h("button", { class: "toggle" + (opts.red ? " red" : ""), type: "button", "aria-pressed": "false" },
      opts.label || shortName(p.desc).replace(/ On$/, ""));
    P.on(id, (pp) => { const on = pp.value > 0.5; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    b.addEventListener("click", () => P.set(id, P.isOn(id) ? 0 : 1));
    return b;
  }

  function powerDot(id) {
    const b = h("button", { class: "power", type: "button", title: "On / Off" });
    P.on(id, (pp) => b.classList.toggle("on", pp.value > 0.5));
    b.addEventListener("click", (e) => { e.stopPropagation(); P.set(id, P.isOn(id) ? 0 : 1); });
    return b;
  }

  function choice(id, opts = {}) {
    const p = P.get(id);
    if (!p) return h("div", null, "?" + id);
    const d = p.desc, n = d.choices.length;
    const label = h("div", { class: "choice-label" }, opts.label || shortName(d));
    let ctl;
    if (n <= 5 && !opts.dropdown) {
      const btns = d.choices.map((c, i) => h("button", { type: "button", onclick: () => P.set(id, n > 1 ? i / (n - 1) : 0) }, c));
      ctl = h("div", { class: "segments" }, btns);
      attachPill(ctl, "button");
      P.on(id, (pp) => btns.forEach((b, i) => b.classList.toggle("on", i === Math.round(pp.value))));
    } else {
      ctl = h("select", { class: "dropdown", "aria-label": d.name }, d.choices.map((c, i) => h("option", { value: i }, c)));
      ctl.addEventListener("change", () => P.set(id, n > 1 ? ctl.selectedIndex / (n - 1) : 0));
      P.on(id, (pp) => { ctl.selectedIndex = Math.round(pp.value); });
    }
    return h("div", { class: "choice" }, label, ctl);
  }

  function control(item) {
    const it = typeof item === "string" ? { id: item } : item;
    if (it.meter) return meter(it.meter, it.label, it.kind);
    const p = P.get(it.id);
    if (!p) return h("div", null, "?" + it.id);
    if (p.desc.kind === "bool") return toggle(it.id, it);
    if (p.desc.kind === "choice") return choice(it.id, it);
    return knob(it.id, it);
  }


  // ===================================================================== Индикаторы
  const meterSubs = new Map();
  function onMeter(key, fn) { if (!meterSubs.has(key)) meterSubs.set(key, []); meterSubs.get(key).push(fn); }
  function meter() { return h("span"); }
  let outHold = 0;
  function handleMeters(m) {
    transport = m;
    const pb = $("#btn-play");
    pb.classList.toggle("on", !!m.previewing);
    $("#btn-play .lbl").textContent = m.previewing ? "Stop" : "Preview";
    outHold = Math.max(m.out || 0, outHold * 0.85);
    const db = 20 * Math.log10(Math.max(outHold, 1e-6));
    $("#m-out").style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
    (meterSubs.get("transport") || []).forEach((fn) => fn(m));
    wave.onTransport(m);
  }

  // ===================================================================== Волна дорожки
  let transport = { pos: 0, playing: false, bpm: 146, hostBpm: 0, hasPos: false };
  let regions = [];
  let capturedEnd = 0;
  let fileMode = false;
  const TYPE_NAMES = ["Tail", "Delay A", "Delay B"];
  const DELAY_BEATS = [2, 1, 1.5, 2 / 3, 0.5, 0.75, 1 / 3, 0.25];

  const wave = (() => {
    const canvas = $("#wave");
    // окно уменьшено (CSS zoom на маленьких экранах): мышь — в экранных точках, рисуем — в своих; делим на масштаб
    const zoomK = (rect) => (canvas.offsetWidth ? rect.width / canvas.offsetWidth : 1) || 1;
    const scroll = $("#wave-scroll");
    const RULER = 26;
    let viewStart = 0, viewLen = 16;           // секунды
    let peaks = null, peaksFor = null, reqId = 0, pending = false;
    let selected = 0;
    let follow = true;
    let drag = null;                            // { mode: "new"|"move"|"l"|"r"|"pan", ... }
    let lastPeakAsk = 0;
    let tool = 0;                               // 0 хвост, 1 delay A, 2 delay B
    let allMode = false;                        // «Все»: трогать можно любые выделения
    const touchable = (r) => allMode || (r.type || 0) === tool;
    const FADED = 0.13;                         // насколько видны выделения другого вида
    let selectNewest = false;
    const typeColor = (c, t) => c.getPropertyValue(t === 1 ? "--da" : t === 2 ? "--db" : "--tail").trim();
    const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

    const css = () => getComputedStyle(document.documentElement);
    const beat = () => 60 / Math.max(20, transport.bpm || 120);
    const W = () => canvas.clientWidth, H = () => canvas.clientHeight;
    const xOf = (t) => (t - viewStart) / viewLen * W();
    const tOf = (x) => viewStart + x / W() * viewLen;

    function askPeaks(force) {
      const now = performance.now();
      if (!force && now - lastPeakAsk < 120) { if (!pending) { pending = true; setTimeout(() => { pending = false; askPeaks(true); }, 130); } return; }
      lastPeakAsk = now;
      const cols = Math.max(50, Math.round(W()));
      Backend.emit("lf_peaks", { start: viewStart, end: viewStart + viewLen, columns: cols, reqId: ++reqId });
    }
    function onPeaks(d) {
      if (d.reqId !== reqId) return;
      peaks = d.peaks; peaksFor = { start: d.start, end: d.end };
      draw();
    }

    function setView(start, len) {
      viewLen = Math.min(1200, Math.max(0.5, len));
      viewStart = Math.max(fileMode ? -8 : 0, start);
      updateScroll();
      draw();
      askPeaks();
    }
    function updateScroll() {
      const total = Math.max(capturedEnd, viewStart + viewLen, 30);
      scroll.max = String(Math.max(0, total - viewLen));
      scroll.step = String(viewLen / 200);
      scroll.value = String(viewStart);
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1, w = W(), hgt = H();
      if (!w || !hgt) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
      }
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = css(), col = (n) => c.getPropertyValue(n).trim();
      g.clearRect(0, 0, w, hgt);
      const bgG = g.createLinearGradient(0, 0, 0, hgt);
      bgG.addColorStop(0, "#10162a"); bgG.addColorStop(1, col("--ink"));
      g.fillStyle = bgG; g.fillRect(0, 0, w, hgt);
      g.fillStyle = "rgba(10,13,26,0.55)"; g.fillRect(0, 0, w, RULER);
      g.font = "11px " + col("--font");

      // такты и доли
      const b = beat(), bar = b * 4;
      const pxPerBeat = w / viewLen * b;
      const step = pxPerBeat < 6 ? bar : b;
      for (let t = Math.floor(viewStart / step) * step; t <= viewStart + viewLen; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        const isBar = Math.abs(t / bar - Math.round(t / bar)) < 1e-6;
        g.strokeStyle = col("--line"); g.globalAlpha = isBar ? 0.9 : 0.35;
        g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, hgt); g.stroke(); g.globalAlpha = 1;
        if (isBar && (pxPerBeat * 4 > 34 || Math.round(t / bar) % 4 === 0)) {
          g.fillStyle = col("--muted"); g.fillText(String(Math.round(t / bar) + 1), x + 4, 16);
        }
      }
      g.strokeStyle = col("--line"); g.beginPath(); g.moveTo(0, RULER + 0.5); g.lineTo(w, RULER + 0.5); g.stroke();

      const mid = RULER + (hgt - RULER) / 2, amp = (hgt - RULER) / 2 - 8;

      // хвосты (нарастание) — рисуем под волной
      for (const r of regions) {
        if ((r.type || 0) !== 0) continue;
        const ts = r.tailStart, te = r.start;
        const x0 = xOf(ts), x1 = xOf(te);
        if (x1 < 0 || x0 > w) continue;
        g.save(); if (!touchable(r)) g.globalAlpha = FADED;
        const grad = g.createLinearGradient(x0, 0, x1, 0);
        const tcol = col("--tail");
        grad.addColorStop(0, rgba(tcol, 0));
        grad.addColorStop(1, r.status === 2 ? "rgba(240,100,106,0.25)" : rgba(tcol, 0.5));
        g.fillStyle = grad;
        g.beginPath();
        // форма экспоненты: тонкая в начале, полная у слога
        g.moveTo(x0, mid);
        for (let i = 0; i <= 24; i++) {
          const f = i / 24, x = x0 + (x1 - x0) * f, a = amp * 0.85 * Math.pow(f, 2.2);
          g.lineTo(x, mid - a);
        }
        for (let i = 24; i >= 0; i--) {
          const f = i / 24, x = x0 + (x1 - x0) * f, a = amp * 0.85 * Math.pow(f, 2.2);
          g.lineTo(x, mid + a);
        }
        g.closePath(); g.fill();
        // Pan: зигзаг поверх хвоста
        if (r.pan && x1 - x0 > 20) {
          const per = 0.25 * beat() / viewLen * w;  // период качания на экране
          g.strokeStyle = rgba(col("--tail"), 0.9); g.lineWidth = 1.2; g.beginPath();
          for (let x = x0; x <= x1; x += Math.max(2, per / 8)) {
            const f = (x - x0) / (x1 - x0), a = amp * 0.85 * Math.pow(f, 2.2);
            const y = mid - a * Math.sin((x - x0) / Math.max(4, per) * 2 * Math.PI);
            if (x === x0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke(); g.lineWidth = 1;
        }
        const tags = [];
        if (r.pan) tags.push("Pan");
        if (Math.abs(r.gainDb || 0) > 0.05) tags.push(((r.gainDb > 0) ? "+" : "") + r.gainDb.toFixed(1) + " dB");
        if (tags.length && x1 - x0 > 40) {
          g.fillStyle = r.id === selected ? col("--paper") : col("--tail");
          g.fillText(tags.join(" · "), Math.max(x0 + 4, x1 - 8 - g.measureText(tags.join(" · ")).width), hgt - 8);
        }
        if (r.id === selected) {
          g.strokeStyle = col("--accent"); g.setLineDash([3, 3]);
          g.strokeRect(x0 + 0.5, RULER + 4.5, Math.max(1, x1 - x0 - 1), hgt - RULER - 9);
          g.setLineDash([]);
        }
        g.restore();
      }

      // повторы delay-выделений — пунктир, куда полетит слово
      for (const r of regions) {
        const t = r.type || 0;
        if (t === 0) continue;
        const d = (r.echoBeats || 1) * beat();
        const ratio = Math.min(0.95, Math.pow(((r.echoFb !== undefined ? r.echoFb : 45) / 100), 2) * 1.1);   // повторы только затухают
        let lvl = 0.6 * Math.min(1.5, Math.pow(10, (r.gainDb || 0) / 20));   // громкость выделения — размер повторов
        const fade = touchable(r) ? 1 : FADED;
        g.fillStyle = typeColor(c, t);
        for (let k = 1; k <= 12 && lvl > 0.02; k++) {
          const xs = xOf(r.start + k * d), xe = xOf(r.end + k * d);
          if (xs > w) break;
          g.globalAlpha = 0.5 * lvl * fade;
          const a = amp * lvl;
          g.fillRect(xs, mid - a, Math.max(1, xe - xs), 2 * a);
          if (k % 2 === 0) lvl *= Math.sqrt(ratio) * Math.sqrt(ratio);
        }
        g.globalAlpha = 1;
      }

      // волна
      if (peaks && peaksFor) {
        const n = peaks.length / 2;
        const pStart = peaksFor.start, pLen = peaksFor.end - peaksFor.start;
        const wg = g.createLinearGradient(0, mid - amp, 0, mid + amp);
        wg.addColorStop(0, "#d6d0ff"); wg.addColorStop(0.5, col("--wave")); wg.addColorStop(1, "#d6d0ff");
        g.fillStyle = wg; g.globalAlpha = 0.85;
        for (let i = 0; i < n; i++) {
          const t = pStart + (i + 0.5) / n * pLen;
          const x = xOf(t);
          if (x < -2 || x > w + 2) continue;
          const mn = peaks[2 * i], mx = peaks[2 * i + 1];
          if (mn === 0 && mx === 0) continue;
          const y0 = mid - Math.min(1, mx) * amp, y1 = mid - Math.max(-1, mn) * amp;
          g.fillRect(x - 0.5, y0, Math.max(1, w / n), Math.max(1, y1 - y0));
        }
        g.globalAlpha = 1;
      }
      if (!capturedEnd) {
        g.fillStyle = col("--muted");
        g.font = "14px " + col("--font");
        g.textAlign = "center";
        g.fillText(fileMode ? "Loading file…" : "Play your project in FL Studio — the waveform shows up here", w / 2, mid - 6);
        g.fillText(fileMode ? "" : "…or drag & drop a .wav file", w / 2, mid + 16);
        g.textAlign = "left"; g.font = "11px " + col("--font");
      }

      // выделенные слоги
      // сначала бледные (другого вида), сверху — те, что можно трогать
      const ordered = regionsForDraw().slice().sort((a, b) => (touchable(a) ? 1 : 0) - (touchable(b) ? 1 : 0));
      for (const r of ordered) {
        const x0 = xOf(r.start), x1 = xOf(r.end);
        if (x1 < 0 || x0 > w) continue;
        g.save(); if (!touchable(r)) g.globalAlpha = FADED;
        const sel = r.id === selected;
        const bad = r.status === 2;
        const tc = typeColor(c, r.type || 0);
        g.fillStyle = bad ? "rgba(240,100,106,0.18)" : rgba(tc, sel ? 0.34 : 0.18);
        g.fillRect(x0, RULER + 1, x1 - x0, hgt - RULER - 1);
        g.strokeStyle = bad ? col("--gr") : tc; g.lineWidth = 1.2;
        if (bad) g.setLineDash([4, 3]);
        g.strokeRect(x0 + 0.5, RULER + 1.5, Math.max(1, x1 - x0 - 1), hgt - RULER - 3);
        g.setLineDash([]); g.lineWidth = 1;
        if (sel && !bad) {
          // выбранное — фиолетовая рамка со свечением поверх цвета вида
          g.save(); g.shadowColor = "rgba(139,124,246,0.9)"; g.shadowBlur = 12;
          g.strokeStyle = col("--accent"); g.lineWidth = 2;
          g.strokeRect(x0 - 1.5, RULER + 0.5, Math.max(1, x1 - x0 + 3), hgt - RULER - 1);
          g.restore();
        }
        if ((r.type || 0) !== 0) {
          // плавные края (fade-in / fade-out): линии от нижних углов к ручкам наверху
          const fi = Math.min(x1 - x0, (r.fadeIn || 0) / 1000 / viewLen * w), fo = Math.min(x1 - x0, (r.fadeOut || 0) / 1000 / viewLen * w);
          const top = RULER + 2, bot = hgt - 2;
          g.fillStyle = "rgba(20,24,34,0.45)";
          g.beginPath(); g.moveTo(x0, top); g.lineTo(x0 + fi, top); g.lineTo(x0, bot); g.closePath(); g.fill();
          g.beginPath(); g.moveTo(x1, top); g.lineTo(x1 - fo, top); g.lineTo(x1, bot); g.closePath(); g.fill();
          g.strokeStyle = tc; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(x0, bot); g.lineTo(x0 + fi, top); g.moveTo(x1, bot); g.lineTo(x1 - fo, top); g.stroke(); g.lineWidth = 1;
          g.fillStyle = sel ? col("--paper") : tc;
          g.fillRect(x0 + fi - 4, top, 8, 8); g.fillRect(x1 - fo - 4, top, 8, 8);
        }
        const label = bad ? "play this part" : (r.status === 1 ? "" : "rendering…");
        if (label) { g.fillStyle = bad ? col("--gr") : col("--muted"); g.fillText(label, x0 + 4, RULER + 14); }
        else if ((r.type || 0) !== 0 && x1 - x0 > 30) { g.fillStyle = tc; g.fillText(r.type === 1 ? "A" : "B", x0 + 4, RULER + 14); }
        if ((r.type || 0) !== 0 && Math.abs(r.gainDb || 0) > 0.05) {
          // громкость delay-выделения — подписью внизу, как у хвостов
          const tag = ((r.gainDb > 0) ? "+" : "") + r.gainDb.toFixed(1) + " dB";
          const tw = g.measureText(tag).width;
          g.fillStyle = "rgba(10,13,26,0.75)"; g.fillRect(x0 + 2, hgt - 21, tw + 8, 16);
          g.fillStyle = sel ? col("--paper") : tc; g.fillText(tag, x0 + 6, hgt - 9);
        }
        g.restore();
      }

      // курсор воспроизведения
      if (transport.hasPos) {
        const x = Math.round(xOf(transport.pos)) + 0.5;
        if (x >= 0 && x <= w) {
          g.save(); g.shadowColor = "rgba(139,124,246,0.9)"; g.shadowBlur = 8;
          g.strokeStyle = "#b4a9ff"; g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hgt); g.stroke(); g.restore();
          g.fillStyle = "#b4a9ff"; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.closePath(); g.fill();
        }
      }
    }

    function regionsForDraw() {
      if (!drag || !drag.region) return regions;
      return regions.map((r) => (r.id === drag.region.id ? Object.assign({}, r, drag.preview) : r));
    }

    function hit(x, y) {
      const edge = 6;
      // ручки плавных краёв у delay-выделений: квадратики в верхних углах
      if (y !== undefined && y < RULER + 16) {
        for (const r of regions) {
          if ((r.type || 0) === 0 || !touchable(r)) continue;
          const x0 = xOf(r.start), x1 = xOf(r.end);
          const fi = (r.fadeIn || 0) / 1000 / viewLen * W(), fo = (r.fadeOut || 0) / 1000 / viewLen * W();
          if (Math.abs(x - (x0 + fi)) <= 7) return { r, part: "fadeIn" };
          if (Math.abs(x - (x1 - fo)) <= 7) return { r, part: "fadeOut" };
        }
      }
      for (const r of regions) {
        if (!touchable(r)) continue;
        const x0 = xOf(r.start), x1 = xOf(r.end);
        if (Math.abs(x - x0) <= edge) return { r, part: "l" };
        if (Math.abs(x - x1) <= edge) return { r, part: "r" };
        if (x > x0 && x < x1) return { r, part: "body" };
      }
      for (const r of regions) {
        if ((r.type || 0) !== 0 || !touchable(r)) continue;
        if (x >= xOf(r.tailStart) && x < xOf(r.start)) return { r, part: "tail" };
      }
      return null;
    }

    canvas.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect(), k = zoomK(rect);
      const x = (e.clientX - rect.left) / k, y = (e.clientY - rect.top) / k;
      canvas.setPointerCapture(e.pointerId);
      if (y < RULER || e.button === 1) { drag = { mode: "pan", x0: x, v0: viewStart }; return; }
      const hh = hit(x, y);
      if (hh && hh.part === "tail") {
        selected = hh.r.id;
        drag = { mode: "select" };
      } else if (hh && (hh.part === "fadeIn" || hh.part === "fadeOut")) {
        selected = hh.r.id;
        drag = { mode: hh.part, x0: x, region: hh.r, preview: { start: hh.r.start, end: hh.r.end, fadeIn: hh.r.fadeIn || 0, fadeOut: hh.r.fadeOut || 0 } };
      } else if (hh) {
        selected = hh.r.id;
        drag = { mode: hh.part === "body" ? "move" : hh.part, x0: x, region: hh.r, preview: { start: hh.r.start, end: hh.r.end } };
      } else {
        const t = Math.max(0, tOf(x));
        drag = { mode: "new", t0: t, region: { id: -1 }, preview: { start: t, end: t } };
        regions = regions.concat([{ id: -1, type: tool, start: t, end: t, tailStart: t, status: 1 }]);
      }
      draw(); updateButtons();
    });
    canvas.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect(), k = zoomK(rect);
      const x = (e.clientX - rect.left) / k, y = (e.clientY - rect.top) / k;
      if (!drag) {
        const hh = hit(x, y);
        canvas.style.cursor = hh ? (hh.part === "body" ? "grab" : hh.part === "tail" ? "pointer" : hh.part.startsWith("fade") ? "col-resize" : "ew-resize") : "crosshair";
        canvas.title = hh && hh.part.startsWith("fade") ? "Drag to fade the word in/out of the delay" : "";
        return;
      }
      if (drag.mode === "pan") { setView(drag.v0 - (x - drag.x0) / W() * viewLen, viewLen); return; }
      if (drag.mode === "select") return;
      const t = Math.max(0, tOf(x));
      const p = drag.preview, r = drag.region;
      if (drag.mode === "new") { p.start = Math.min(drag.t0, t); p.end = Math.max(drag.t0, t); }
      else if (drag.mode === "l") { p.start = Math.min(t, r.end - 0.01); }
      else if (drag.mode === "r") { p.end = Math.max(t, r.start + 0.01); }
      else if (drag.mode === "move") { const dt = (x - drag.x0) / W() * viewLen; p.start = Math.max(0, r.start + dt); p.end = p.start + (r.end - r.start); }
      else if (drag.mode === "fadeIn") { p.fadeIn = Math.max(0, Math.min((r.end - r.start) * 1000 - p.fadeOut, (tOf(x) - r.start) * 1000)); }
      else if (drag.mode === "fadeOut") { p.fadeOut = Math.max(0, Math.min((r.end - r.start) * 1000 - p.fadeIn, (r.end - tOf(x)) * 1000)); }
      draw();
    });
    const finish = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mode === "new") {
        regions = regions.filter((r) => r.id !== -1);
        if (d.preview.end - d.preview.start > 0.015) {
          selectNewest = true;
          Backend.emit("lf_addRegion", { start: d.preview.start, end: d.preview.end, type: tool });
        }
      } else if (d.mode === "fadeIn" || d.mode === "fadeOut") {
        Object.assign(d.region, { fadeIn: d.preview.fadeIn, fadeOut: d.preview.fadeOut });
        Backend.emit("lf_setRegionFades", { id: d.region.id, fadeIn: d.preview.fadeIn, fadeOut: d.preview.fadeOut });
      } else if (d.mode !== "pan" && d.mode !== "select") {
        const p = d.preview;
        if (Math.abs(p.start - d.region.start) > 1e-4 || Math.abs(p.end - d.region.end) > 1e-4) {
          Object.assign(d.region, p);
          Backend.emit("lf_updateRegion", { id: d.region.id, start: p.start, end: p.end });
        }
      }
      draw();
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("dblclick", (e) => {
      // прослушать с этого места прямо в плагине (и для своего файла, и для записанной дорожки проекта)
      if (transport.hostPlaying && !fileMode) { toast("FL is playing — stop it to preview in the plugin"); return; }
      const rect = canvas.getBoundingClientRect();
      Backend.emit("lf_preview", { action: "play", from: Math.max(0, tOf((e.clientX - rect.left) / zoomK(rect))) });
    });
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoomK(rect);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        setView(viewStart + (e.shiftKey ? e.deltaY : e.deltaX) / W() * viewLen, viewLen);
      } else {
        const t = tOf(x), k = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        const nl = viewLen * k;
        setView(t - (x / W()) * nl, nl);
      }
    }, { passive: false });
    scroll.addEventListener("input", () => setView(parseFloat(scroll.value), viewLen));
    window.addEventListener("keydown", (e) => {
      if (document.activeElement && document.activeElement.tagName === "INPUT" && document.activeElement.type !== "range" && document.activeElement.type !== "checkbox") return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if ((k === "z" || k === "я") && !e.shiftKey) { e.preventDefault(); Backend.emit("lf_undo"); return; }
        if (((k === "z" || k === "я") && e.shiftKey) || k === "y" || k === "н") { e.preventDefault(); Backend.emit("lf_redo"); return; }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        Backend.emit("lf_removeRegion", { id: selected }); selected = 0; updateButtons();
      }
      if (e.code === "Space" && (fileMode || !transport.hostPlaying)) {
        e.preventDefault();
        Backend.emit("lf_preview", transport.previewing ? { action: "stop" } : { action: "play", from: transport.pos || 0 });
      }
    });
    new ResizeObserver(() => { draw(); askPeaks(); }).observe(canvas);

    function dropHidden() {
      const r = regions.find((x) => x.id === selected);
      if (r && !touchable(r)) selected = 0;
      updateButtons();
    }
    function updateButtons() {
      if (!regions.some((r) => r.id === selected)) selected = 0;
      inspector.show(regions.find((r) => r.id === selected) || null);
    }

    return {
      draw, askPeaks, onPeaks,
      zoom(k) { const c = viewStart + viewLen / 2; setView(c - viewLen * k / 2, viewLen * k); },
      fit() {
        const first = Math.min(0, ...regions.filter((r) => (r.type || 0) === 0).map((r) => r.tailStart));
        setView(first, Math.max(4, (capturedEnd || 16) - first));
      },
      setTool(t) { tool = t; allMode = false; dropHidden(); draw(); },
      setAll(on) { allMode = on; dropHidden(); draw(); },
      clearWave() { peaks = null; peaksFor = null; capturedEnd = 0; draw(); },
      deselect() { selected = 0; updateButtons(); draw(); },
      selectedRegion() { return regions.find((r) => r.id === selected) || null; },
      setFollow(v) { follow = v; },
      deleteSelected() { if (selected) { Backend.emit("lf_removeRegion", { id: selected }); selected = 0; updateButtons(); } },
      onRegions(d) {
        const prevEnd = capturedEnd;
        regions = d.regions; capturedEnd = d.capturedEnd || 0;
        if (selectNewest && regions.length) { selected = Math.max(...regions.map((r) => r.id)); selectNewest = false; }
        if (!prevEnd && capturedEnd && viewStart === 0) setView(0, Math.max(viewLen, 8));
        if (prevEnd && !capturedEnd) { peaks = null; peaksFor = null; }
        updateScroll(); updateButtons(); draw();
        if (capturedEnd !== prevEnd) askPeaks();
      },
      onTransport(m) {
        if (follow && m.playing && m.hasPos && (m.pos < viewStart || m.pos > viewStart + viewLen * 0.92))
          setView(m.pos - viewLen * 0.08, viewLen);
        else draw();
        if (m.playing && !fileMode && performance.now() - lastPeakAsk > 400) askPeaks(true);
      },
    };
  })();

  // ===================================================================== Выбранное выделение
  // Панель собирается один раз на выбранное выделение и дальше только обновляет значения —
  // поэтому ползунок и кнопки работают и во время воспроизведения.
  const inspector = (() => {
    const box = $("#inspector");
    let cur = null, ui = null, timer = 0, requested = 0;
    const colorOf = (t) => getComputedStyle(document.documentElement).getPropertyValue(t === 1 ? "--da" : t === 2 ? "--db" : "--tail").trim();
    function send() {
      clearTimeout(timer);
      const r = cur;
      timer = setTimeout(() => Backend.emit("lf_setRegionProps", { id: r.id, gainDb: r.gainDb || 0, pan: !!r.pan }), 40);
    }
    function title(r) {
      const t = r.type || 0;
      const num = regions.filter((x) => (x.type || 0) === t && x.start <= r.start).length;
      const b = 60 / Math.max(20, transport.bpm || 120);
      const beats = Math.floor(Math.max(0, r.start) / b + 1e-6);
      return `${TYPE_NAMES[t]} ${num} · bar ${Math.floor(beats / 4) + 1}.${(beats % 4) + 1}`;
    }
    function build(r) {
      box.innerHTML = "";
      const t = r.type || 0;
      if (t !== 0) {
        // delay-выделение: только громкость этого слова и «Удалить»; остальное — в панели «Delay на слово»
        const sw = h("i"); sw.style.background = colorOf(t); sw.style.color = colorOf(t);
        const name = h("span", null, title(r));
        const fades = h("span", { class: "tools-label" });
        const out = h("output", { title: "Double-click — 0 dB" });
        const range = h("input", { type: "range", min: "-24", max: "12", step: "0.1", "aria-label": "Delay region gain" });
        const setGain = (v) => { cur.gainDb = v; range.value = String(v); out.textContent = (v > 0 ? "+" : "") + v.toFixed(1) + " dB"; };
        range.addEventListener("input", () => { setGain(parseFloat(range.value)); send(); wave.draw(); });
        const zero = () => { setGain(0); send(); wave.draw(); };
        range.addEventListener("dblclick", zero); out.addEventListener("dblclick", zero);
        const del = h("button", { class: "btn btn-ghost insp-del", type: "button", title: "Delete this region (Delete). Ctrl+Z to undo" });
        del.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg><span class="lbl">Delete</span>';
        del.onclick = () => wave.deleteSelected();
        box.append(h("span", { class: "insp-title" }, sw, name),
          h("label", { class: "gain", title: "Echo volume of this word only" }, "Gain", range, out),
          fades, h("span", { class: "insp-note" }, "· more in the Word Delay panel"), h("span", { class: "spacer" }), del);
        ui = { name, range, out, setGain, paintPan: () => {}, fades };
        return;
      }
      const swatch = h("i"); swatch.style.background = colorOf(t); swatch.style.color = colorOf(t);
      const name = h("span", null, title(r));
      const out = h("output", { title: "Double-click — 0 dB" });
      const range = h("input", { type: "range", min: "-24", max: "12", step: "0.1", "aria-label": "Region gain" });
      const setGain = (v) => { cur.gainDb = v; range.value = String(v); out.textContent = (v > 0 ? "+" : "") + v.toFixed(1) + " dB"; };
      range.addEventListener("input", () => { setGain(parseFloat(range.value)); send(); wave.draw(); });
      const zero = () => { setGain(0); send(); wave.draw(); };
      range.addEventListener("dblclick", zero); out.addEventListener("dblclick", zero);
      const pan = h("button", { class: "btn pan-btn", type: "button", title: "Fast left-right panning (settings in the Pan section below)" });
      pan.addEventListener("click", () => { cur.pan = !cur.pan; paintPan(); send(); wave.draw(); });
      const paintPan = () => { pan.classList.toggle("on", !!cur.pan); pan.textContent = cur.pan ? "Pan on — click to remove" : "Add Pan"; };
      const save = h("button", { class: "btn", type: "button", title: "Save this region to Documents\\ShkaFX" }, "Export WAV");
      save.onclick = () => Backend.emit("lf_export", { regionId: cur.id });
      const del = h("button", { class: "btn", type: "button" }, "Delete");
      del.onclick = () => wave.deleteSelected();
      const fades = h("span", { class: "tools-label" });
      box.append(...[h("span", { class: "insp-title" }, swatch, name),
        h("label", { class: "gain" }, "Gain", range, out), pan,
        t !== 0 ? fades : null, save, del].filter(Boolean));
      ui = { name, range, out, setGain, paintPan, fades };
    }
    function show(r) {
      if (!r) {
        if (cur || !box.childElementCount) {
          box.innerHTML = "";
          box.append(h("span", { class: "empty" }, "Nothing selected — the knobs below set up new regions. Click a region or tail to edit just that one."));
        }
        cur = null; ui = null;
        if (P.region) P.setScope(null);
        requested = 0;
        return;
      }
      const fresh = !cur || cur.id !== r.id || (cur.type || 0) !== (r.type || 0);
      const dragging = !!ui && !!ui.range && box.contains(document.activeElement) && document.activeElement.type === "range";
      if (fresh) { cur = Object.assign({}, r); build(cur); }
      else if (!dragging) { cur.gainDb = r.gainDb; cur.pan = r.pan; }
      cur.start = r.start; cur.end = r.end; cur.type = r.type; cur.fadeIn = r.fadeIn; cur.fadeOut = r.fadeOut;
      ui.name.textContent = title(cur);
      if (!dragging) ui.setGain(cur.gainDb || 0);
      ui.paintPan();
      if ((r.type || 0) !== 0) ui.fades.textContent = `fade: ${Math.round(r.fadeIn || 0)} / ${Math.round(r.fadeOut || 0)} ms`;
      if (requested !== r.id) { requested = r.id; Backend.emit("lf_getRegionVals", { id: r.id }); }
    }
    // после Ctrl+Z ручки выделения могли поменяться — перезапросить
    function refresh() { requested = 0; if (cur) { const r = regions.find((x) => x.id === cur.id); if (r) { cur = null; show(r); } } }
    return { show, refresh };
  })();

  // плашка после «Сбросить ручки» без выделения: 5 секунд, чтобы передумать
  const resetBanner = (() => {
    let el = null, timer = 0, left = 0, undoAt = -1;
    function hide() { clearInterval(timer); if (el) { el.classList.add("out"); const e = el; setTimeout(() => e.remove(), 220); el = null; } }
    function show() {
      hide();
      left = 5;
      const count = h("b", { class: "rb-count" }, String(left));
      const undoBtn = h("button", { class: "btn rb-undo", type: "button" }, "Undo");
      const bar = h("i", { class: "rb-bar" });
      el = h("div", { class: "reset-banner", role: "alert" },
        h("div", { class: "rb-text" }, h("strong", null, "Reset ALL knobs?"), " Undo within ", count, " s"),
        undoBtn, bar);
      undoBtn.onclick = () => { Backend.emit("lf_undo"); hide(); };
      document.body.append(el);
      requestAnimationFrame(() => bar.classList.add("run"));
      timer = setInterval(() => { left--; count.textContent = String(left); if (left <= 0) hide(); }, 1000);
    }
    return { show, hide };
  })();

  function toast(text, isError) {
    const t = $("#toast");
    t.textContent = text; t.hidden = false; t.classList.toggle("error", !!isError);
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 4000);
  }

  // своё окно подтверждения вместо системного confirm() (у того заголовок «juce:backend»)
  function askConfirm(title, text, okLabel, danger) {
    return new Promise((resolve) => {
      const ok = h("button", { class: "btn md-ok" + (danger ? " danger" : ""), type: "button" }, okLabel || "OK");
      const cancel = h("button", { class: "btn md-cancel", type: "button" }, "Cancel");
      const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true" },
        h("div", { class: "md-title" }, title), text ? h("div", { class: "md-text" }, text) : "",
        h("div", { class: "md-btns" }, cancel, ok));
      const wrap = h("div", { class: "modal-wrap" }, box);
      const keys = (e) => {
        e.stopImmediatePropagation();
        if (e.key === "Escape") { e.preventDefault(); done(false); }
        else if (e.key === "Enter") { e.preventDefault(); done(true); }
        else if (e.key === "Tab") { e.preventDefault(); (document.activeElement === ok ? cancel : ok).focus(); }
      };
      function done(v) {
        window.removeEventListener("keydown", keys, true);
        wrap.classList.add("out");
        setTimeout(() => wrap.remove(), 200);
        resolve(v);
      }
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(false); });
      window.addEventListener("keydown", keys, true);
      document.body.append(wrap);
      ok.focus();
    });
  }

  function buildScopeBar() {
    const bar = $("#scope-bar");
    const text = h("span", { class: "scope-text" });
    const all = h("button", { class: "btn", type: "button", title: "Copy these knobs to every region" }, "Apply to all regions");
    all.onclick = () => { askConfirm("Apply to all regions?", "Every tail and delay region gets these knob settings. Ctrl+Z to undo.", "Apply").then((y) => { if (y) Backend.emit("lf_applyAll"); }); };
    const unsel = h("button", { class: "btn", type: "button" }, "Deselect");
    unsel.onclick = () => wave.deselect();
    bar.innerHTML = "";
    bar.append(text, all, unsel);
    const paint = (r) => {
      bar.classList.toggle("region", !!r);
      const rr = r && regions.find((x) => x.id === r.id);
      const rt = rr ? (rr.type || 0) : 0;
      text.textContent = r ? (rt === 0
        ? "Swell knobs — only for this tail. Word Delay knobs — for new delay regions"
        : `Word Delay knobs — only for this ${TYPE_NAMES[rt]}. Swell knobs — for new tails`)
                           : "The knobs below are for new regions";
      all.hidden = !!r; unsel.hidden = !r;
      // панель, которая сейчас настраивает выбранное выделение, — с фиолетовой рамкой
      $("#panel-swell").classList.toggle("scoped", !!r && rt === 0);
      $("#panel-delay").classList.toggle("scoped", !!r && rt !== 0);
    };
    P.onScope(paint);
    paint(null);
  }

  function buildDrop() {
    const over = $("#drop");
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; over.hidden = false; });
    window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) over.hidden = true; });
    window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    window.addEventListener("drop", async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; over.hidden = true;
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (f.size > 300 * 1024 * 1024) { toast("File is too big", true); return; }
      toast("Loading “" + f.name + "”…");
      const buf = new Uint8Array(await f.arrayBuffer());
      Backend.emit("lf_dropBegin", { name: f.name });
      const CH = 393216; // 384 КБ на кусок
      for (let i = 0; i < buf.length; i += CH) {
        const part = buf.subarray(i, Math.min(buf.length, i + CH));
        let bin = "";
        for (let k = 0; k < part.length; k += 8192) bin += String.fromCharCode.apply(null, part.subarray(k, k + 8192));
        Backend.emit("lf_dropChunk", { data: btoa(bin) });
        if ((i / CH) % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      Backend.emit("lf_dropEnd", {});
    });
  }

  function buildSource() {
    $("#btn-load").onclick = () => Backend.emit("lf_loadFile", {});
    $("#btn-project").onclick = () => { askConfirm("Back to project audio?", "Regions made on this file will be deleted.", "Go back", true).then((y) => { if (y) Backend.emit("lf_useProject"); }); };
    $("#btn-play").onclick = () => {
      if (transport.hostPlaying && !fileMode) { toast("FL is playing — stop it to preview in the plugin"); return; }
      const sel = wave.selectedRegion();
      const from = transport.previewing ? 0 : (sel ? Math.max(0, (sel.type || 0) === 0 ? sel.tailStart - 0.3 : sel.start - 0.3) : (transport.pos || 0));
      Backend.emit("lf_preview", transport.previewing ? { action: "stop" } : { action: "play", from });
    };
    const toolsBox = $(".tools"), allBtn = $("#tool-all");
    if (!toolsBox.classList.contains("has-pill")) attachPill(toolsBox, ".tool[data-tool]");
    for (const b of document.querySelectorAll(".tool[data-tool]")) {
      b.onclick = () => {
        document.querySelectorAll(".tool[data-tool]").forEach((x) => x.classList.toggle("on", x === b));
        allBtn.classList.remove("on"); toolsBox.classList.remove("all-mode");
        wave.setTool(parseInt(b.dataset.tool, 10));
      };
    }
    allBtn.onclick = () => {
      const on = !allBtn.classList.contains("on");
      allBtn.classList.toggle("on", on); toolsBox.classList.toggle("all-mode", on);
      wave.setAll(on);
    };
    $("#btn-exp-each").onclick = () => Backend.emit("lf_export", { timeline: false });
    $("#btn-exp-all").onclick = () => Backend.emit("lf_export", { timeline: true, withVocal: $("#chk-vocal").checked });
    $("#btn-folder").onclick = () => Backend.emit("lf_openFolder");
  }

  let lastSourceKey = "";
  function onSourceState(d) {
    fileMode = !!d.fileMode;
    const name = $("#source-name");
    name.textContent = fileMode ? (d.sourceName || "your file") : "project audio";
    name.classList.toggle("file", fileMode);
    $("#btn-project").hidden = !fileMode;
    $("#btn-load .lbl").textContent = fileMode ? "Load another…" : "Load file…";
    $("#btn-exp-all").title = fileMode ? "One file for the whole length of your file. If a tail starts before the file, whole bars are added in front (shown in the name)"
                                       : "One file with all effects, from the project start (place it at bar 1)";
    document.body.classList.toggle("busy", !!d.busy);
    const key = fileMode + "|" + (d.sourceName || "");
    const changed = key !== lastSourceKey && lastSourceKey !== "";
    lastSourceKey = key;
    return changed;
  }

  // ===================================================================== Раскладка панелей
  function section(title, items, extraClass) {
    return h("section", { class: "section" + (extraClass ? " " + extraClass : "") },
      h("div", { class: "section-head" }, h("h2", { class: "section-title" }, title)),
      h("div", { class: "controls" }, items.map(control)));
  }

  // «Edit details»: редкие ручки спрятаны и плавно раскрываются по кнопке в правом нижнем углу секции
  function detailsBlock(key, sections) {
    const inner = h("div", { class: "details-inner" }, h("div", { class: "sections" }, sections));
    const box = h("div", { class: "details", id: "details-" + key }, inner);
    const btn = h("button", { class: "btn btn-details", type: "button", "aria-expanded": "false" });
    btn.innerHTML = '<span class="lbl">Edit details</span><svg class="ic chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
    const set = (open, save) => {
      box.classList.toggle("open", open);
      btn.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.querySelector(".lbl").textContent = open ? "Hide details" : "Edit details";
      if (save) try { localStorage.setItem("lfx_details_" + key, open ? "1" : "0"); } catch (_) {}
    };
    btn.onclick = () => set(!box.classList.contains("open"), true);
    let open = false;
    try { open = localStorage.getItem("lfx_details_" + key) === "1"; } catch (_) {}
    set(open, false);
    return { box, btn };
  }
  function withFooter(sec, btn) { sec.append(h("div", { class: "section-foot" }, btn)); return sec; }

  function throwButton(id, label) {
    const b = h("button", { class: "throw", type: "button", title: "Click it, or draw FL automation for this button over the word" },
      h("span", { class: "throw-name" }, label), h("span", { class: "throw-hint" }, "Throw"));
    P.on(id, (pp) => b.classList.toggle("on", pp.value > 0.5));
    b.addEventListener("pointerdown", () => { P.begin(id); P.set(id, P.isOn(id) ? 0 : 1, true); P.end(id); });
    return b;
  }

  function buildPanels() {
    const sw = $("#panel-swell");
    sw.innerHTML = "";
    const swDetails = detailsBlock("swell", [
        section("Reverb", [{ id: "rv_mix", label: "Mix" }, { id: "rv_predelay", label: "Predelay" }, { id: "rv_decay", label: "Decay", big: true },
                           { id: "rv_size", label: "Size" }, { id: "rv_attack", label: "Attack" }]),
        section("Damping", [{ id: "rv_hf", label: "HighFreq" }, { id: "rv_hshelf", label: "HighShelf" },
                            { id: "rv_bf", label: "BassFreq" }, { id: "rv_bmult", label: "BassMult" }]),
        section("Diffusion & Mod", [{ id: "rv_early", label: "Early" }, { id: "rv_late", label: "Late" },
                                    { id: "rv_modrate", label: "Rate" }, { id: "rv_moddepth", label: "Depth" }]),
        section("EQ", [{ id: "rv_highcut", label: "HighCut" }, { id: "rv_lowcut", label: "LowCut" }])]);
    sw.append(
      h("div", { class: "panel-head" }, powerDot("sw_on"), h("h1", { class: "panel-title" }, "Swell"),
        h("p", { class: "panel-desc" }, "Mark the first syllable on the waveform — a reversed reverb tail swells in before it.")),
      h("div", { class: "sections" },
        withFooter(section("Build-up", [{ id: "sw_len", label: "Length", dropdown: true }, { id: "sw_level", label: "Level", big: true },
                               { id: "sw_offset", label: "Offset" }, { id: "sw_fadein", label: "Fade In" },
                               { id: "sw_fadeout", label: "Cut" }, { id: "sw_capture", label: "Record" }]), swDetails.btn),
        swDetails.box,
        section("Pan (tails with Pan on)", [{ id: "pm_rate", label: "Rate", dropdown: true }, { id: "pm_depth", label: "Depth" },
                                                  { id: "pm_shape", label: "Shape" }, { id: "pm_follow", label: "Follow" }], "pm")));

    const dl = $("#panel-delay");
    dl.innerHTML = "";
    const dlDetails = detailsBlock("delay", [
        section("Tone", [{ id: "dl_midf", label: "Mid Freq" }, { id: "dl_midg", label: "Mid Gain" }, { id: "dl_sat", label: "Saturation" }]),
        section("Motion & Stereo", [{ id: "dl_wob", label: "Wobble" }, { id: "dl_width", label: "Width" }])]);
    const lane = (k, label) => h("div", { class: "lane" },
      throwButton(`dl${k}_throw`, label),
      h("div", { class: "controls" }, [{ id: `dl${k}_time`, label: "Time", dropdown: true }, { id: `dl${k}_fb`, label: "Feedback" },
                                       { id: `dl${k}_level`, label: "Level" }].map(control)));
    dl.append(
      h("div", { class: "panel-head" }, powerDot("dl_on"), h("h1", { class: "panel-title" }, "Word Delay"),
        h("p", { class: "panel-desc" }, "Mark a word with Delay A/B — only that word goes into the echoes. Corner squares fade the word in and out. The A/B buttons below are for FL automation.")),
      lane("a", "A"), lane("b", "B"),
      h("div", { class: "sections" },
        withFooter(section("Character", [{ id: "dl_mode", label: "Mode" }, { id: "dl_first", label: "First Echo" },
                                      { id: "dl_lowcut", label: "LowCut" }, { id: "dl_highcut", label: "HighCut" }], "character"), dlDetails.btn),
        dlDetails.box));

    // выключенный модуль — панель «под серым слоем»: крутилки и кнопки не трогаются (включить — кружок у заголовка)
    const dim = (panel, id, name) => {
      let note = panel.querySelector(".off-note");
      if (!note) { note = h("div", { class: "off-note" }, `${name} is off — turn it on with the dot next to the title`); panel.append(note); }
      P.on(id, (pp) => panel.classList.toggle("off", pp.value < 0.5));
    };
    dim(sw, "sw_on", "Swell");
    dim(dl, "dl_on", "Word Delay");
  }

  function buildTop() {
    $("#io-out").innerHTML = "";
    $("#io-out").append(knob("out_gain", { label: "Output" }));
    const bpmBox = $("#bpm");
    bpmBox.innerHTML = "";
    const val = h("span", { class: "bpm-value" }, "—");
    const src = choice("bpm_src", { label: "Tempo" });
    // темп вручную — поле для ввода с клавиатуры
    const bpmIn = h("input", { class: "bpm-input", type: "text", inputmode: "decimal", maxlength: "6", title: "Type a tempo and press Enter (40–240). Arrows ↑/↓ — ±1, with Shift — ±0.1", "aria-label": "Manual BPM" });
    const commitBpm = () => {
      const v = parseFloat(bpmIn.value.replace(",", "."));
      if (!Number.isFinite(v)) { bpmIn.value = (+P.get("bpm").value.toFixed(2)).toString(); return; }
      const nv = Math.min(240, Math.max(40, Math.round(v * 100) / 100));
      bpmIn.value = String(nv);
      if (Math.abs(nv - P.get("bpm").value) > 1e-3) P.setValue("bpm", nv);
    };
    bpmIn.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") bpmIn.blur();   // blur сам применит
      else if (e.key === "Escape") { bpmIn.value = (+P.get("bpm").value.toFixed(2)).toString(); bpmIn.blur(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const step = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 0.1 : 1);
        const cur = parseFloat(bpmIn.value.replace(",", ".")) || P.get("bpm").value;
        bpmIn.value = String(Math.round(Math.min(240, Math.max(40, cur + step)) * 10) / 10);
        commitBpm();
      }
    });
    bpmIn.addEventListener("blur", commitBpm);
    bpmIn.addEventListener("focus", () => bpmIn.select());
    P.on("bpm", (pp) => { if (document.activeElement !== bpmIn) bpmIn.value = (+pp.value.toFixed(2)).toString(); });
    // «Вручную»: большое окошко темпа само становится полем для ввода
    const now = h("div", { class: "bpm-now" }, val, bpmIn, h("span", { class: "bpm-unit" }, "BPM"));
    bpmBox.append(now, src);
    const pos = $("#pos");
    onMeter("transport", (m) => {
      val.textContent = (m.bpm || 0).toFixed(1);
      const b = 60 / Math.max(20, m.bpm || 120);
      const beats = Math.floor((m.pos || 0) / b + 1e-6);
      pos.textContent = m.hasPos ? `${Math.floor(beats / 4) + 1}:${(beats % 4) + 1}` : "—";
      pos.classList.toggle("playing", !!m.playing);
    });
    P.on("bpm_src", (pp) => {
      const man = Math.round(pp.value) === 1;
      now.classList.toggle("manual", man);
      now.title = man ? "Type a tempo and press Enter" : "FL project tempo";
    });
    now.addEventListener("click", () => { if (now.classList.contains("manual")) bpmIn.focus(); });
    $("#btn-reset").onclick = () => {
      const r = wave.selectedRegion();
      if (r) {
        Backend.emit("lf_resetKnobs", { regionId: r.id });
        toast(`${TYPE_NAMES[r.type || 0]} knobs reset (Ctrl+Z to undo)`);
      } else {
        Backend.emit("lf_resetKnobs", { regionId: 0 });
        resetBanner.show();
      }
    };
    $("#btn-undo").onclick = () => Backend.emit("lf_undo");
    $("#btn-redo").onclick = () => Backend.emit("lf_redo");
    $("#btn-zoom-in").onclick = () => wave.zoom(1 / 1.5);
    $("#btn-zoom-out").onclick = () => wave.zoom(1.5);
    $("#btn-fit").onclick = () => wave.fit();
    $("#btn-clear").onclick = () => { askConfirm("Delete all regions?", "All tails and delay regions will be removed. Ctrl+Z to undo.", "Delete all", true).then((y) => { if (y) Backend.emit("lf_clearRegions"); }); };
    $("#btn-wipe").onclick = () => { Backend.emit("lf_clearCapture"); wave.clearWave(); toast("Waveform cleared. Tails and settings stay — play the next line"); };
    const fol = $("#chk-follow");
    fol.onchange = () => wave.setFollow(fol.checked);
  }

  // ===================================================================== События от плагина
  Backend.on("vc_init", (data) => {
    P.map.clear();
    for (const d of data.params) P.map.set(d.id, { desc: d, norm: d.norm, value: d.value, text: d.text });
    P.order = data.params.map((d) => d.id);
    P.region = null;
    buildTop();
    buildPanels();
    buildSource();
    buildScopeBar();
    if (!buildDrop.done) { buildDrop(); buildDrop.done = true; }
    bootDone();
    wave.askPeaks(true);
  });
  Backend.on("vc_values", (data) => data.changes.forEach((c) => P.update(c)));
  Backend.on("vc_meters", handleMeters);
  Backend.on("lf_regions", (d) => {
    const changed = onSourceState(d);
    wave.onRegions(d);
    if (changed) wave.fit();
  });
  Backend.on("lf_notice", (n) => {
    if (n.type === "error") toast(n.text, true);
    else if (n.type === "exported") toast(n.text + " — Documents\\ShkaFX (folder opened)");
    else if (n.type === "loaded") toast("Loaded: " + n.text);
    else toast(n.text);
  });
  Backend.on("lf_peaks", (d) => wave.onPeaks(d));
  function paintUndo(d) {
    $("#btn-undo").disabled = !d.canUndo;
    $("#btn-redo").disabled = !d.canRedo;
  }
  Backend.on("lf_undoState", paintUndo);
  Backend.on("lf_restored", (d) => {
    paintUndo(d);
    resetBanner.hide();
    toast(d.what === "redo" ? "Redone" : "Undone");
    inspector.refresh();
  });
  Backend.on("lf_regionVals", (d) => {
    const r = wave.selectedRegion();
    if (r && r.id === d.id) P.setScope(d.id, d.vals, r.type || 0);
  });

  // ---- подсказка под волной: плавно раскрывается, если задержать на ней мышь
  (function setupHint() {
    const hint = $("#hint");
    if (!hint) return;
    const text = hint.innerHTML;
    hint.innerHTML = "";
    const body = h("div", { class: "hint-body" });
    body.innerHTML = text;
    hint.append(body);
    const LINE = () => parseFloat(getComputedStyle(body).lineHeight) || 16;
    let timer = 0, open = false;
    const setH = (px) => { hint.style.height = px + "px"; };
    const collapse = () => { clearTimeout(timer); open = false; hint.classList.remove("open"); setH(LINE()); };
    const expand = () => { open = true; hint.classList.add("open"); setH(body.scrollHeight); };
    // раскрывается, только если задержать на ней мышь ~0.65 с — при обычном движении курсора не дёргается
    hint.addEventListener("mouseenter", () => { clearTimeout(timer); timer = setTimeout(expand, 450); });
    hint.addEventListener("mouseleave", collapse);
    window.addEventListener("resize", () => { if (open) setH(body.scrollHeight); });
    requestAnimationFrame(collapse);
  })();

  // ---- заставка: интерфейс построен и шрифты загружены — сообщаем плагину (он покажет окно) и плавно убираем заставку
  function bootDone() {
    if (bootDone.done) return;
    bootDone.done = true;
    const boot = $("#boot");
    const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    fonts.then(() => setTimeout(() => {
      Backend.emit("lf_uiReady");
      const reveal = () => {
        if (window.innerWidth < 200) return;   // плагин ещё держит окно свёрнутым в точку
        window.removeEventListener("resize", reveal);
        requestAnimationFrame(() => {
          document.body.classList.add("booted");
          if (boot) { boot.classList.add("out"); setTimeout(() => boot.remove(), 700); }
        });
      };
      window.addEventListener("resize", reveal);
      reveal();
    }, 30));
  }

  // ---- это плагин, а не браузер: без масштаба, контекстного меню, перезагрузки, печати и поиска
  window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });
  window.addEventListener("contextmenu", (e) => { if (!(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) e.preventDefault(); }, { capture: true });
  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const block = (ctrl && ["+", "=", "-", "_", "0", "r", "p", "f", "s", "u", "o", "g", "j", "h", "k", "l", "n", "t", "w", "к", "з", "а", "ы", "г"].includes(k))
      || k === "f5" || k === "f3" || k === "f7" || k === "f12" || (ctrl && e.shiftKey && ["i", "j", "c", "ш", "о", "с"].includes(k));
    if (block) e.preventDefault();
  }, { capture: true });
  document.addEventListener("dragstart", (e) => e.preventDefault());

  // ===================================================================== Активация (лицензия)
  // Без ключа плагин пропускает звук как есть, а поверх окна — карточка активации. Закрыть её нельзя.
  const licenseGate = (() => {
    let wrap = null, ui = null;
    // Delete, пробел, Ctrl+Z не должны трогать волну под окном: клавиши вне карточки гасим сразу, внутри — после поля ввода
    const keys = (e) => { if (wrap && !wrap.contains(e.target)) e.stopPropagation(); };
    function copyCode(code) {
      Backend.emit("lf_copy", { text: code });
      try { navigator.clipboard && navigator.clipboard.writeText(code).catch(() => {}); } catch (e) { /* в плагине копирует сам плагин */ }
      ui.copy.textContent = "Copied ✓"; ui.copy.classList.add("done");
      clearTimeout(ui.t); ui.t = setTimeout(() => { ui.copy.textContent = "Copy"; ui.copy.classList.remove("done"); }, 1600);
    }
    function build() {
      const code = h("div", { class: "lic-code" });
      const copy = h("button", { class: "btn lic-copy", type: "button" }, "Copy");
      const input = h("textarea", { class: "lic-input", rows: "3", spellcheck: "false", placeholder: "SHKA-XXXXX-XXXXX-…" });
      const go = h("button", { class: "btn lic-go", type: "button" }, "Activate");
      const err = h("div", { class: "lic-err", role: "alert" });
      const card = h("div", { class: "lic-card", role: "dialog", "aria-modal": "true" },
        h("div", { class: "lic-title" }, "Activate ShkaFX"),
        h("div", { class: "lic-text" }, "1. Send this computer code to ", h("b", null, "@shkaf232"), ":"),
        h("div", { class: "lic-row" }, code, copy),
        h("div", { class: "lic-text" }, "2. Paste the key you get here:"),
        input, err,
        h("div", { class: "lic-btns" }, go),
        h("div", { class: "lic-foot" }, "Until then the plugin passes the sound through unchanged."));
      wrap = h("div", { class: "lic-wrap" }, card);
      wrap.addEventListener("keydown", (e) => e.stopPropagation());
      copy.onclick = () => copyCode(code.textContent);
      const activate = () => {
        const key = input.value.trim();
        if (!key) { showError("Paste your key first"); input.focus(); return; }
        go.disabled = true; go.textContent = "Checking…"; showError("");
        Backend.emit("lf_activate", { key });
        setTimeout(() => { go.disabled = false; go.textContent = "Activate"; }, 600);
      };
      go.onclick = activate;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); activate(); } });
      input.addEventListener("input", () => showError(""));
      ui = { code, copy, input, go, err };
      window.addEventListener("keydown", keys, true);
      document.body.append(wrap);
      setTimeout(() => input.focus(), 50);
    }
    function showError(text) { if (!ui) return; ui.err.textContent = text || ""; ui.err.classList.toggle("on", !!text); if (text) { ui.err.classList.remove("shake"); void ui.err.offsetWidth; ui.err.classList.add("shake"); } }
    function onState(st) {
      const brand = $(".brand-text");
      if (brand) brand.title = st.licensed ? `Licensed to ${st.name || "you"} · ${st.expires ? "until " + st.expires : "forever"}` : "";
      if (st.licensed) {
        if (wrap) {
          const w = wrap; wrap = null; ui = null;
          window.removeEventListener("keydown", keys, true);
          w.classList.add("out"); setTimeout(() => w.remove(), 420);
          toast(st.name ? `Activated — welcome, ${st.name}!` : "Activated — thank you!");
        }
        return;
      }
      if (!wrap) build();
      ui.code.textContent = st.machine || "—";
      showError(st.error || "");
    }
    return { onState, showError };
  })();
  Backend.on("lf_zoom", (d) => {
    const z = d && d.scale > 0 && d.scale < 1 ? String(d.scale) : "";
    document.documentElement.style.zoom = z;
    window.dispatchEvent(new Event("resize"));
  });
  Backend.on("lf_license", licenseGate.onState);
  Backend.on("lf_activateResult", (d) => licenseGate.showError(d.error));

  Backend.emit("vc_ready");

  // ===================================================================== Заглушка для браузера
  function createMockBackend() {
    const listeners = {};
    const fire = (ev, obj) => (listeners[ev] || []).forEach((fn) => fn(obj));
    const params = (window.VC_MOCK_PARAMS || []).map((d) => {
      const norm = toNorm(d, d.def);
      return Object.assign({}, d, { norm, defNorm: norm, value: d.def, text: formatValue(d, d.def) });
    });
    const byId = new Map(params.map((p) => [p.id, p]));
    let regs = [{ id: 1, type: 0, start: 2.6, end: 2.79, gainDb: 0, pan: true }, { id: 2, type: 1, start: 8.2, end: 8.55, gainDb: 0, pan: false, fadeIn: 30, fadeOut: 80 }], nextId = 3, pos = 0;
    let mockFile = false, previewing = false;
    let mockLic = { licensed: /[?&]licensed/.test(location.search), machine: "7K3M-Q9TB-X2CW-48FD", name: "demo", expires: "", daysLeft: -1, error: "" };
    if (/[?&]expired/.test(location.search)) mockLic = Object.assign(mockLic, { expires: "2026-11-16", error: "Your key expired on 2026-11-16 — message @shkaf232 to renew" });
    let captured = 19;
    const bpm = 146;
    const lineEnv = (t) => ((t > 2.5 && t < 8.6) || (t > 11.4 && t < 17.1)) ? (0.35 + 0.3 * Math.abs(Math.sin(t * 9.1)) * Math.abs(Math.sin(t * 2.3))) : 0;
    function setNorm(id, norm) {
      const p = byId.get(id); if (!p) return;
      p.value = fromNorm(p, Math.min(1, Math.max(0, norm))); p.norm = toNorm(p, p.value); p.text = formatValue(p, p.value);
      fire("vc_values", { changes: [{ id, norm: p.norm, value: p.value, text: p.text }] });
      if (id === "sw_len") sendRegions();
    }
    function sendRegions() {
      const beats = [1, 2, 3, 4, 6, 8][Math.round(byId.get("sw_len").value)];
      fire("lf_regions", { capturedEnd: captured, fileMode: mockFile, sourceName: mockFile ? "acapella_final.wav" : "", busy: false,
        regions: regs.map((r) => {
          // как в плагине: повторы рисуются по ручкам самого выделения (или общим, если своих ещё нет)
          const val = (id) => { const i = params.findIndex((q) => q.id === id); return r.vals ? r.vals[i] : params[i].value; };
          const k = r.type === 2 ? "b" : "a";
          const extra = (r.type || 0) ? { echoFb: val(`dl${k}_fb`), echoBeats: [2, 1, 1.5, 2 / 3, 0.5, 0.75, 1 / 3, 0.25][Math.round(val(`dl${k}_time`))] } : {};
          return Object.assign({}, r, { tailStart: r.start - beats * 60 / bpm, status: r.start > captured ? 2 : 1 }, extra);
        }) });
    }
    // простая история для предпросмотра Ctrl+Z
    const hist = [], fut = [];
    const snap = () => JSON.stringify({ regs, vals: params.map((p) => p.norm) });
    const point = () => { hist.push(snap()); fut.length = 0; fire("lf_undoState", { canUndo: true, canRedo: false }); };
    const back = (from, to, what) => {
      if (!from.length) return;
      to.push(snap());
      const st = JSON.parse(from.pop());
      regs = st.regs; params.forEach((p, i) => { if (Math.abs(p.norm - st.vals[i]) > 1e-6) setNorm(p.id, st.vals[i]); });
      sendRegions();
      fire("lf_restored", { what, canUndo: hist.length > 0, canRedo: fut.length > 0 });
    };
    const handlers = {
      lf_activate: (o) => {
        const k = (o.key || "").replace(/\s/g, "").toUpperCase();
        if (!k.startsWith("SHKA-") || k.length < 60) { fire("lf_activateResult", { error: "This doesn't look like a ShkaFX key — copy it again, all of it" }); return; }
        mockLic = { licensed: true, machine: mockLic.machine, name: "demo", expires: "2026-11-17", daysLeft: 30, error: "" };
        fire("lf_license", mockLic);
      },
      lf_copy: () => {},
      lf_undo: () => back(hist, fut, "undo"),
      lf_resetKnobs: (o) => {
        point();
        if (o.regionId > 0) { const r = regs.find((x) => x.id === o.regionId); if (r) { r.vals = params.map((p) => p.def); fire("lf_regionVals", { id: r.id, vals: r.vals.slice() }); sendRegions(); } }
        else { params.forEach((p) => setNorm(p.id, p.defNorm)); regs.forEach((r) => { r.vals = null; r.gainDb = 0; }); sendRegions(); }
      },
      lf_redo: () => back(fut, hist, "redo"),
      vc_ready: () => {
        fire("vc_init", { params: params.map((p) => Object.assign({}, p)), sampleRate: 44100 });
        fire("lf_license", mockLic);
        sendRegions();
        setInterval(() => {
          if (previewing) pos = (pos + 0.033) % 22;
          fire("vc_meters", { pos, hasPos: true, playing: previewing, hostPlaying: false, previewing, bpm, hostBpm: bpm, out: previewing ? lineEnv(pos) * 0.8 : 0, throwA: 0, throwB: 0 });
        }, 33);
      },
      vc_end: () => { handlers._g = false; },
      vc_set: (o) => { if (!o.gesture || !handlers._g) point(); handlers._g = !!o.gesture; setNorm(o.id, o.norm); },
      vc_setValue: (o) => { const p = byId.get(o.id); if (p) setNorm(o.id, toNorm(p, Math.min(p.max, Math.max(p.min, o.value)))); },
      vc_default: (o) => { const p = byId.get(o.id); if (p) setNorm(o.id, p.defNorm); },
      vc_resetAll: () => { point(); params.forEach((p) => setNorm(p.id, p.defNorm)); },
      lf_addRegion: (o) => { point(); regs.push({ id: nextId++, type: o.type || 0, start: o.start, end: o.end, gainDb: 0, pan: false, fadeIn: 10, fadeOut: 25 }); sendRegions(); },
      lf_setRegionProps: (o) => { point(); const r = regs.find((x) => x.id === o.id); if (r) { r.gainDb = o.gainDb; r.pan = o.pan; } sendRegions(); },
      lf_getRegionVals: (o) => { const r = regs.find((x) => x.id === o.id); if (!r) return; r.vals = r.vals || params.map((p) => p.value); fire("lf_regionVals", { id: r.id, vals: r.vals.slice() }); },
      lf_setRegionParam: (o) => { const r = regs.find((x) => x.id === o.id); if (r && r.vals) { r.vals[o.index] = o.value; sendRegions(); } },
      lf_setRegionFades: (o) => { point(); const r = regs.find((x) => x.id === o.id); if (r) { r.fadeIn = o.fadeIn; r.fadeOut = o.fadeOut; } sendRegions(); },
      lf_applyAll: () => { regs.forEach((r) => { r.vals = null; }); },
      lf_dropBegin: () => {}, lf_dropChunk: () => {}, lf_dropEnd: () => { handlers.lf_loadFile(); },
      lf_loadFile: () => { mockFile = true; regs = []; pos = 0; sendRegions(); fire("lf_notice", { type: "loaded", text: "acapella_final.wav" }); },
      lf_useProject: () => { mockFile = false; previewing = false; regs = []; sendRegions(); },
      lf_preview: (o) => { previewing = o.action === "play"; if (previewing) pos = Math.max(0, o.from || 0); },
      lf_export: (o) => fire("lf_notice", { type: "exported", text: o.regionId ? "Files saved: 1" : "Files saved: " + (o.timeline ? 1 : regs.length) }),
      lf_openFolder: () => {},
      lf_updateRegion: (o) => { point(); const r = regs.find((x) => x.id === o.id); if (r) { r.start = o.start; r.end = o.end; } sendRegions(); },
      lf_removeRegion: (o) => { point(); regs = regs.filter((x) => x.id !== o.id); sendRegions(); },
      lf_clearRegions: () => { point(); regs = []; sendRegions(); },
      lf_clearCapture: () => { captured = 0; sendRegions(); },
      lf_peaks: (o) => {
        const out = [];
        for (let i = 0; i < o.columns; i++) {
          const t = o.start + (i + 0.5) / o.columns * (o.end - o.start);
          const a = t < captured && captured > 0 ? lineEnv(t) * (0.6 + 0.4 * Math.abs(Math.sin(t * 173.3))) : 0;
          out.push(-a, a);
        }
        fire("lf_peaks", { reqId: o.reqId, start: o.start, end: o.end, peaks: out });
      },
    };
    return {
      live: false,
      on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      emit: (ev, obj) => { if (handlers[ev]) setTimeout(() => handlers[ev](obj || {}), 0); },
    };
  }
})();
