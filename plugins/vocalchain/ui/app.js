/* VocalChain — логика интерфейса.
 *
 * Как устроено:
 *   1) Backend — связь с плагином (window.__JUCE__.backend) или «заглушка» для браузера.
 *   2) P — состояние параметров: id -> { desc, norm, value, text }, подписчики на изменения.
 *   3) Компоненты: knob(), toggle(), choice(), meter() — создают DOM и сами обновляются.
 *   4) MODULES — раскладка: какие ручки в каком модуле и секции. Меняйте её, чтобы переставить элементы.
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
      case "%": return Math.round(v) + " %";
      case "ms": return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + " ms";
      case "s": return v.toFixed(2) + " s";
      case ":1": return d.id === "ssl_ratio" && v >= 39.5 ? "∞" : v.toFixed(2) + ":1";
      default:
        if (d.id === "air_mid" || d.id === "air_high") return String(Math.round(v));
        return v.toFixed(d.id.startsWith("fet_") ? 1 : 2);
    }
  }

  // ===================================================================== Состояние
  const P = {
    map: new Map(),
    subs: new Map(),
    get(id) { return this.map.get(id); },
    scope: "app",            // "module" — подписки текущего открытого модуля, снимаются при переключении
    on(id, fn) {
      if (!this.subs.has(id)) this.subs.set(id, []);
      fn._scope = this.scope;
      this.subs.get(id).push(fn);
      const p = this.map.get(id);
      if (p) fn(p);
    },
    update(ch) {
      const p = this.map.get(ch.id);
      if (!p) return;
      p.norm = ch.norm; p.value = ch.value; p.text = ch.text;
      (this.subs.get(ch.id) || []).forEach((fn) => fn(p));
    },
    set(id, norm, gesture) { Backend.emit("vc_set", { id, norm, gesture: !!gesture }); },
    setValue(id, value) { Backend.emit("vc_setValue", { id, value }); },
    begin(id) { Backend.emit("vc_begin", { id }); },
    end(id) { Backend.emit("vc_end", { id }); },
    reset(id) { Backend.emit("vc_default", { id }); },
    isOn(id) { const p = this.map.get(id); return !!p && p.value > 0.5; },
  };

  // ===================================================================== Раскладка модулей
  const MODULES = [
    { key: "ns", name: "NS1", role: "Шумодав", power: "ns_on", meter: "nsVoice", meterKind: "voice",
      desc: "Нейросетевое шумоподавление RNNoise. Amount — сколько шума убрать (как ползунок NS1). Голосовой гейт глушит паузы без голоса, 0 % — выключен.",
      sections: [
        { title: "Подавление", items: [{ id: "ns_amount", big: true }] },
        { title: "Голосовой гейт", items: ["ns_vad", "ns_grace", { meter: "nsVoice", label: "Голос", kind: "voice" }] },
      ] },
    { key: "eq1", name: "EQ", role: "Pro-Q 3", power: "eq1_on", eq: "eq1",
      desc: "Параметрический EQ на 8 полос. Точки на графике можно таскать мышью: влево-вправо — частота, вверх-вниз — усиление." },
    { key: "ds", name: "DeEsser", role: "Шипящие", power: "ds_on", meter: "ds",
      desc: "Split — приглушает только верх выше частоты, Wide — весь сигнал. Listen — послушать, на что реагирует детектор.",
      sections: [
        { title: "Детектор", items: [{ id: "ds_freq", big: true }, { id: "ds_thr", big: true }, "ds_ratio", "ds_range"] },
        { title: "Режим", items: ["ds_mode", "ds_sc", "ds_listen", { meter: "ds", label: "Подавление" }] },
      ] },
    { key: "ssl", name: "SSL", role: "Канал E-Series", power: "ssl_on", meter: "sslComp",
      desc: "Фильтры, 4 полосы EQ, компрессор и гейт/экспандер. Analog — окраска консоли (Airwindows Channel9, режим SSL).",
      sections: [
        { title: "Фильтры и окраска", rows: [
          { label: "HPF", items: ["ssl_hpf_on", { id: "ssl_hpf", label: "Частота" }] },
          { label: "LPF", items: ["ssl_lpf_on", { id: "ssl_lpf", label: "Частота" }] },
          { label: "Уровни", items: [{ id: "ssl_in", label: "Input" }, { id: "ssl_out", label: "Output" }, { id: "ssl_phase", label: "Ø" }] },
          { label: "Analog", items: [{ id: "ssl_analog", label: "Вкл" }, { id: "ssl_drive", label: "Drive" }] },
        ] },
        { title: "EQ", toggle: "ssl_eq_on", rows: [
          { label: "HF",  items: [{ id: "ssl_hf_g", label: "Gain" },  { id: "ssl_hf_f", label: "Freq" },  { id: "ssl_hf_bell", label: "Bell" }] },
          { label: "HMF", items: [{ id: "ssl_hmf_g", label: "Gain" }, { id: "ssl_hmf_f", label: "Freq" }, { id: "ssl_hmf_q", label: "Q" }] },
          { label: "LMF", items: [{ id: "ssl_lmf_g", label: "Gain" }, { id: "ssl_lmf_f", label: "Freq" }, { id: "ssl_lmf_q", label: "Q" }] },
          { label: "LF",  items: [{ id: "ssl_lf_g", label: "Gain" },  { id: "ssl_lf_f", label: "Freq" },  { id: "ssl_lf_bell", label: "Bell" }] },
        ] },
        { title: "Динамика", rows: [
          { label: "Comp", items: [{ id: "ssl_comp_on", label: "Вкл" }, { id: "ssl_ratio", label: "Ratio" }, { id: "ssl_thr", label: "Threshold" },
                                   { id: "ssl_rel", label: "Release" }, { id: "ssl_fatk", label: "Fast" }, { meter: "sslComp", label: "Сжатие" }] },
          { label: "Gate", items: [{ id: "ssl_gate_on", label: "Вкл" }, { id: "ssl_gthr", label: "Threshold" }, { id: "ssl_range", label: "Range" },
                                   { id: "ssl_grel", label: "Release" }, { id: "ssl_gfatk", label: "Fast" }, { meter: "sslGate", label: "Гейт" }] },
          { label: "Режим", items: [{ id: "ssl_gate_mode", label: "Gate / Expander" }, { id: "ssl_dynpost", label: "Динамика после EQ" }] },
        ] },
      ] },
    { key: "rc", name: "RComp", role: "Компрессор", power: "rc_on", meter: "rc",
      desc: "Прозрачный компрессор. ARC — авторелиз, Electro — релиз зависит от глубины сжатия, Warm — мягкое колено и окраска.",
      sections: [
        { title: "Сжатие", items: [{ id: "rc_thr", big: true }, { id: "rc_ratio", big: true }, "rc_att", "rc_rel", { meter: "rc", label: "Сжатие" }] },
        { title: "Выход", items: ["rc_gain", "rc_mix", "rc_trim"] },
        { title: "Характер", items: ["rc_arc", "rc_electro", "rc_warm"] },
      ] },
    { key: "fet", name: "FET-76", role: "Как 1176", power: "fet_on", meter: "fet",
      desc: "FET-компрессор с фиксированным порогом: сжатие задаётся ручкой Input, громкость — Output. Attack и Release: 7 — самые быстрые.",
      sections: [
        { title: "Уровни", items: [{ id: "fet_in", big: true }, { id: "fet_out", big: true }] },
        { title: "Время и Ratio", items: ["fet_att", "fet_rel", "fet_ratio"] },
        { title: "Компрессия", items: [{ id: "fet_comp", red: true, label: "Вкл" }, { meter: "fet", label: "Сжатие" }] },
        { title: "Окраска", items: ["fet_rev", "fet_analog", "fet_mix", "fet_trim"] },
      ] },
    { key: "air", name: "Air", role: "Fresh Air", power: "air_on",
      desc: "Mid Air — подъём верхней середины, который отступает на резких местах. High Air — самый верх (Airwindows Air3). Link двигает обе ручки вместе.",
      sections: [
        { title: "Воздух", items: [{ id: "air_mid", big: true }, "air_link", { id: "air_high", big: true }] },
        { title: "Выход", items: ["air_trim"] },
      ] },
    { key: "eq2", name: "EQ", role: "Pro-Q 3", power: "eq2_on", eq: "eq2",
      desc: "Второй EQ: срез низа и две динамические полосы, которые работают только когда сигнал громче порога." },
    { key: "vox", name: "RVox", role: "Вокальный", power: "vox_on", meter: "vox",
      desc: "Вокальный компрессор в одну ручку. Comp — порог с автоматическим подъёмом громкости и лимитером на 0 дБ. Gate — тихий экспандер для пауз.",
      sections: [
        { title: "RVox", items: [{ id: "vox_gate", big: true }, { id: "vox_comp", big: true }, { id: "vox_gain", big: true },
                                  { meter: "vox", label: "Сжатие" }, { meter: "voxGate", label: "Гейт" }] },
      ] },
    { key: "pm", name: "PanMan", role: "Автопанорама", power: "pm_on",
      desc: "Медленно водит звук влево-вправо в такт проекту, как Soundtoys PanMan «2 BarWideSlow». Цикл — сколько тактов на полный круг лево-право-лево.",
      sections: [ { title: "PanMan", items: [{ id: "pm_rate", label: "Цикл", dropdown: true }, { id: "pm_width", big: true, label: "Width" }] } ] },
    { key: "dl", name: "Delay", role: "EchoBoy", power: "dl_on",
      desc: "Ленточное эхо, как EchoBoy Single Echo / Master Tape. Голос проходит как есть, Mix — громкость повторов, Feedback — сколько повторов.",
      sections: [
        { title: "Эхо", items: [{ id: "dl_time", label: "Время", dropdown: true }, { id: "dl_mix", big: true, label: "Mix" }, { id: "dl_fb", big: true, label: "Feedback" }] },
        { title: "Плёнка", items: [{ id: "dl_lowcut", label: "LowCut" }, { id: "dl_highcut", label: "HighCut" }, { id: "dl_sat", label: "Saturation" }] },
      ] },
    { key: "ch", name: "Chorus", role: "Finisher Micro", power: "ch_on",
      desc: "Хорус для даблов, как UJAM Finisher Micro в режиме Chorus на 100 %: разводит голос по ушам. Сверено по вашей акапелле даблов.",
      sections: [
        { title: "Хорус", items: [{ id: "ch_amount", big: true, label: "Amount" }, { id: "ch_rate", label: "Rate" }, { id: "ch_depth", label: "Depth" },
                                  { id: "ch_delay", label: "Delay" }, { id: "ch_width", label: "Width" }] },
        { title: "Тон и уровень", items: [{ id: "ch_hpf", label: "LowCut" }, { id: "ch_air", label: "Air" }, { id: "ch_gain", label: "Output" }, { id: "ch_xfeed", label: "Crossfeed" }] },
      ] },
    { key: "lp", name: "LowPass", role: "Love Philter", power: "lp_on",
      desc: "Резонансный lowpass как Fruity Love Philter «Simple lowpass» — бэки «под водой».",
      sections: [ { title: "Фильтр", items: [{ id: "lp_freq", big: true, label: "Срез" }, { id: "lp_res", label: "Резонанс" }] } ] },
    { key: "sm", name: "Карусель", role: "Supermassive", power: "sm_on",
      desc: "Повторы в духе Valhalla Supermassive «Carousel»: после фразы бэки кружатся и затихают. Delay — длительность в долях проекта.",
      sections: [
        { title: "Повторы", items: [{ id: "sm_time", label: "Delay", dropdown: true }, { id: "sm_mix", big: true, label: "Mix" }, { id: "sm_fb", label: "Feedback" }, { id: "sm_density", label: "Density" }] },
        { title: "Mod и EQ", items: [{ id: "sm_modrate", label: "Rate" }, { id: "sm_moddepth", label: "Depth" }, { id: "sm_high", label: "High" }, { id: "sm_low", label: "Low" }, { id: "sm_width", label: "Width" }] },
      ] },
  ];

  // Типы дорожек: что видно на главном экране. Вариации добавятся в variants.
  const TYPES = [
    { name: "Мейн", desc: "Основной вокал. Ваша цепочка: шумодав, EQ, де-эссер, SSL, компрессоры, воздух, RVox.",
      variants: ["Ваш пресет"] },
    { name: "Даблы", desc: "Та же цепочка, низ срезан выше (280 Гц) и хорус как Finisher Micro разводит дабл по ушам.",
      variants: ["Сухие — подложка"] },
    { name: "Бэки", desc: "Цепочка со срезом 323 Гц, PanMan медленно водит их влево-вправо (4 такта) и EchoBoy 1/4. Темп берётся из проекта.",
      variants: ["Обычные", "Хорусные", "Лоупасс (под водой)", "Повторяющиеся атмосферные"] },
  ];

  // Ручки на главном экране для бэков (по варианту добавляются свои)
  const QUICK = [
    { title: "PanMan", power: "pm_on", items: [{ id: "pm_rate", label: "Цикл", dropdown: true }, { id: "pm_width", label: "Width" }] },
    { title: "Delay", power: "dl_on", items: [{ id: "dl_time", label: "Время", dropdown: true }, { id: "dl_mix", label: "Mix" }, { id: "dl_fb", label: "Feedback" }] },
    { title: "Хорус", power: "ch_on", variants: [1, 3], items: [{ id: "ch_amount", label: "Amount" }] },
    { title: "Лоупасс", power: "lp_on", variants: [2], items: [{ id: "lp_freq", label: "Срез" }, { id: "lp_res", label: "Резонанс" }] },
    { title: "Карусель", power: "sm_on", variants: [3], items: [{ id: "sm_time", label: "Delay", dropdown: true }, { id: "sm_mix", label: "Mix" }, { id: "sm_fb", label: "Feedback" }] },
  ];

  const BAND_COLORS = ["#5ccf62", "#d65ee6", "#5aa7f0", "#ef5c5c", "#8f6cf2", "#c9e64b", "#57d2f2", "#f2a35a"];

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
    return d.name.replace(/^(NS|EQ\d B\d|DeEsser|SSL|RComp|FET|Air|RVox)\s+/, "") || d.name;
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

    const value = h("button", { class: "knob-value", type: "button", title: "Ввести значение" });
    const label = h("div", { class: "knob-label" }, opts.label || shortName(d));
    const box = h("div", { class: "knob" + (opts.big ? " big" : "") }, svg, label, value);

    const bipolar = d.min < 0 && d.max > 0 && !d.reverse;
    const zeroNorm = bipolar ? toNorm(d, 0) : 0;
    function draw(pp) {
      const shown = d.reverse ? 1 - pp.norm : pp.norm;
      const ang = A0 + shown * (A1 - A0);
      const from = A0 + (d.reverse ? 0 : zeroNorm) * (A1 - A0);
      fill.setAttribute("d", ang >= from ? arc(30, 30, 24, from, ang) : arc(30, 30, 24, ang, from));
      ptr.setAttribute("transform", `rotate(${ang - 360} 30 30)`);
      value.textContent = pp.text;
      svg.setAttribute("aria-valuetext", pp.text);
    }
    P.on(id, draw);

    // перетаскивание
    let dragging = false, startY = 0, startNorm = 0;
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; startY = e.clientY; startNorm = P.get(id).norm;
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
    const stop = (e) => { if (!dragging) return; dragging = false; P.end(id); try { svg.releasePointerCapture(e.pointerId); } catch (_) {} };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("dblclick", () => P.reset(id));
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      let step = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.002 : 0.01);
      if (d.reverse) step = -step;
      P.set(id, Math.min(1, Math.max(0, P.get(id).norm + step)));
    }, { passive: false });
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
    const b = h("button", { class: "power", type: "button", title: "Вкл / выкл" });
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
  const meterHold = {};
  function onMeter(key, fn) { if (!meterSubs.has(key)) meterSubs.set(key, []); meterSubs.get(key).push(fn); }
  function meter(key, label, kind) {
    const bar = h("i");
    const txt = h("span", null, label);
    onMeter(key, (v) => {
      const pct = kind === "voice" ? v * 100 : Math.min(100, v / 20 * 100);
      bar.style.width = pct + "%";
      bar.style.background = kind === "voice" ? "var(--sea)" : "";
      txt.textContent = kind === "voice" ? `${label}: ${Math.round(v * 100)} %` : `${label}: −${v.toFixed(1)} дБ`;
    });
    return h("div", { class: "grbar" }, txt, h("div", { class: "meter" }, bar));
  }
  function handleMeters(m) {
    for (const [k, v] of Object.entries(m)) {
      // плавный спад: подъём сразу, спад ~ 20 дБ/с
      const prev = meterHold[k] || 0;
      const nv = k === "in" || k === "out" ? Math.max(v, prev * 0.85) : (k === "nsVoice" ? v : Math.max(v, prev - 0.7));
      meterHold[k] = nv;
      (meterSubs.get(k) || []).forEach((fn) => fn(nv));
    }
  }
  function ioMeter(elId, key) {
    const el = document.getElementById(elId);
    onMeter(key, (v) => {
      const db = 20 * Math.log10(Math.max(v, 1e-6));
      el.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
    });
  }

  // ===================================================================== EQ
  const eqData = { freqs: [], eq1: [], eq2: [], eq1Dyn: [], eq2Dyn: [] };
  const eqRedraw = new Map();

  function eqPanel(prefix) {
    const canvas = h("canvas");
    const graph = h("div", { class: "eq-graph" }, canvas);
    const bands = h("div", { class: "eq-bands" });
    for (let b = 1; b <= 8; b++) bands.append(bandCard(prefix, b));

    const FMIN = 20, FMAX = 20000, DBR = 18;
    const fx = (f, w) => Math.log(f / FMIN) / Math.log(FMAX / FMIN) * w;
    const xf = (x, w) => FMIN * Math.pow(FMAX / FMIN, x / w);
    const dy = (db, hgt) => hgt / 2 - db / DBR * (hgt / 2 - 12);
    const yd = (y, hgt) => (hgt / 2 - y) / (hgt / 2 - 12) * DBR;

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      if (!w || !hgt) return;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hgt);
      const css = getComputedStyle(document.documentElement);
      const line = css.getPropertyValue("--line").trim(), muted = css.getPropertyValue("--muted").trim();
      const sea = css.getPropertyValue("--sea").trim();
      g.font = "11px " + css.getPropertyValue("--font");
      g.lineWidth = 1;
      // сетка
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(fx(f, w)) + 0.5;
        g.strokeStyle = line; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hgt); g.stroke();
        g.fillStyle = muted; g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x + 3, hgt - 5);
      }
      for (const db of [-12, -6, 0, 6, 12]) {
        const y = Math.round(dy(db, hgt)) + 0.5;
        g.strokeStyle = db === 0 ? muted : line; g.globalAlpha = db === 0 ? 0.6 : 1;
        g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.globalAlpha = 1;
        g.fillStyle = muted; g.fillText((db > 0 ? "+" : "") + db, w - 24, y - 3);
      }
      // кривая
      const curve = eqData[prefix], freqs = eqData.freqs;
      if (curve && curve.length === freqs.length && freqs.length) {
        g.beginPath();
        freqs.forEach((f, i) => {
          const x = fx(f, w), y = dy(Math.max(-DBR - 4, Math.min(DBR + 4, curve[i])), hgt);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.strokeStyle = sea; g.lineWidth = 2.2; g.stroke();
        g.lineTo(w, dy(0, hgt)); g.lineTo(0, dy(0, hgt)); g.closePath();
        g.fillStyle = sea; g.globalAlpha = 0.08; g.fill(); g.globalAlpha = 1;
      }
      // точки полос
      const dyn = eqData[prefix + "Dyn"] || [];
      dots.length = 0;
      for (let b = 1; b <= 8; b++) {
        const id = `${prefix}_b${b}_`;
        if (!P.isOn(id + "on")) continue;
        const type = Math.round(P.get(id + "type").value);
        const f = P.get(id + "freq").value;
        const gain = type >= 3 ? 0 : P.get(id + "gain").value;
        const x = fx(f, w), y = dy(gain, hgt);
        const col = BAND_COLORS[b - 1];
        if (P.isOn(id + "dyn") && dyn[b - 1]) {
          const y2 = dy(gain + dyn[b - 1], hgt);
          g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y2); g.stroke();
        }
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2);
        g.fillStyle = col; g.fill();
        g.strokeStyle = "#0008"; g.lineWidth = 1; g.stroke();
        dots.push({ b, x, y, cut: type >= 3 });
      }
    }
    const dots = [];
    eqRedraw.set(prefix, draw);

    // перетаскивание точек
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = dots.find((d) => Math.hypot(d.x - x, d.y - y) < 10);
      if (!hit) return;
      drag = hit;
      canvas.setPointerCapture(e.pointerId);
      P.begin(`${prefix}_b${hit.b}_freq`); if (!hit.cut) P.begin(`${prefix}_b${hit.b}_gain`);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const id = `${prefix}_b${drag.b}_`;
      const fd = P.get(id + "freq").desc;
      P.set(id + "freq", toNorm(fd, Math.min(20000, Math.max(10, xf(x, r.width)))), true);
      if (!drag.cut) {
        const gd = P.get(id + "gain").desc;
        P.set(id + "gain", toNorm(gd, Math.max(-30, Math.min(30, yd(y, r.height)))), true);
      }
    });
    const stop = () => {
      if (!drag) return;
      P.end(`${prefix}_b${drag.b}_freq`); if (!drag.cut) P.end(`${prefix}_b${drag.b}_gain`);
      drag = null;
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    const ro = new ResizeObserver(draw);
    ro.observe(graph);
    resizeObservers.push(ro);
    for (let b = 1; b <= 8; b++) for (const k of ["on", "type", "freq", "gain", "dyn"]) P.on(`${prefix}_b${b}_${k}`, () => requestAnimationFrame(draw));

    return h("div", { class: "eq-wrap" }, graph, bands);
  }

  function bandCard(prefix, b) {
    const id = `${prefix}_b${b}_`;
    const dot = h("span", { class: "band-dot", style: `background:${BAND_COLORS[b - 1]}` });
    const name = h("span", { class: "band-name" }, `Полоса ${b}`);
    const head = h("div", { class: "band-head" }, powerDot(id + "on"), dot, name);
    const typeSel = choice(id + "type", { label: "Тип", dropdown: true });
    const gain = knob(id + "gain", { label: "Gain" });
    const slope = choice(id + "slope", { label: "Крутизна", dropdown: true });
    const dynToggle = toggle(id + "dyn", { label: "Динамика" });
    const side = h("div", { class: "band-side" }, head, typeSel, slope, dynToggle);
    const main = h("div", { class: "controls" }, knob(id + "freq", { label: "Freq" }), gain, knob(id + "q", { label: "Q" }));
    const dynBox = h("div", { class: "controls dyn" },
      knob(id + "range", { label: "Range" }), knob(id + "thr", { label: "Порог" }),
      knob(id + "att", { label: "Attack" }), knob(id + "rel", { label: "Release" }));
    const card = h("div", { class: "band" }, side, h("div", { class: "band-knobs" }, main, dynBox));

    const refresh = () => {
      const type = Math.round(P.get(id + "type").value);
      const isCut = type === 3 || type === 4;
      gain.style.visibility = isCut || type === 5 ? "hidden" : "";
      slope.style.display = isCut ? "" : "none";
      dynToggle.style.display = isCut || type === 5 ? "none" : "";
      dynBox.classList.toggle("hidden", !(P.isOn(id + "dyn") && !isCut && type !== 5));
      card.classList.toggle("off", !P.isOn(id + "on"));
    };
    for (const k of ["type", "dyn", "on"]) P.on(id + k, refresh);
    return card;
  }

  // ===================================================================== Построение страницы
  let selected = "ns";
  try { selected = localStorage.getItem("vc_selected") || "ns"; } catch (_) {}

  function buildChain() {
    const chain = $("#chain");
    chain.innerHTML = "";
    for (const m of MODULES) {
      const bar = h("i");
      const link = h("div", { class: "link", role: "button", tabindex: "0", "data-key": m.key },
        h("div", { class: "link-top" }, powerDot(m.power), h("span", { class: "link-name" }, m.name)),
        h("div", { class: "link-role" }, m.role),
        h("div", { class: "link-gr" }, bar));
      link.addEventListener("click", () => select(m.key));
      link.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(m.key); } });
      P.on(m.power, (pp) => link.classList.toggle("bypassed", pp.value < 0.5));
      if (m.meter) onMeter(m.meter, (v) => {
        bar.style.width = (m.meterKind === "voice" ? v * 100 : Math.min(100, v / 20 * 100)) + "%";
        bar.style.background = m.meterKind === "voice" ? "var(--sea)" : "";
      });
      chain.append(link);
    }
  }

  function select(key) {
    selected = key;
    try { localStorage.setItem("vc_selected", key); } catch (_) {}
    document.querySelectorAll(".link").forEach((l) => l.classList.toggle("selected", l.dataset.key === key));
    const m = MODULES.find((x) => x.key === key) || MODULES[0];
    const root = $("#module");
    root.innerHTML = "";
    meterSubs.forEach((list, k) => meterSubs.set(k, list.filter((fn) => fn.persistent)));
    P.subs.forEach((list, k) => P.subs.set(k, list.filter((fn) => fn._scope !== "module")));
    resizeObservers.forEach((ro) => ro.disconnect());
    resizeObservers.length = 0;
    P.scope = "module";
    try { buildModule(m, root); } finally { P.scope = "app"; }
  }

  const resizeObservers = [];
  function buildModule(m, root) {
    root.append(h("div", { class: "module-head" },
      h("h1", { class: "module-title" }, m.name),
      h("span", { class: "module-role" }, m.role),
      h("p", { class: "module-desc" }, m.desc)));
    if (m.eq) {
      root.append(eqPanel(m.eq));
      requestAnimationFrame(() => eqRedraw.get(m.eq)());
      return;
    }
    const sections = h("div", { class: "sections" });
    for (const sec of m.sections) {
      const title = h("div", { class: "section-head" }, h("h2", { class: "section-title" }, sec.title),
                      sec.toggle ? toggle(sec.toggle, { label: "Вкл" }) : null);
      let body;
      if (sec.rows) {
        body = h("div", { class: "rows" }, sec.rows.map((r) =>
          h("div", { class: "row" }, h("div", { class: "row-label" }, r.label), h("div", { class: "controls" }, r.items.map(control)))));
      } else {
        body = h("div", { class: "controls" }, sec.items.map(control));
      }
      sections.append(h("section", { class: "section" }, title, body));
    }
    root.append(sections);
  }

  function markPersistentMeters() {
    meterSubs.forEach((list) => list.forEach((fn) => { fn.persistent = true; }));
  }

  // ===================================================================== Тип дорожки
  let fineOpen = false;
  try { fineOpen = localStorage.getItem("vc_fine") === "1"; } catch (_) {}
  function setFine(open) {
    fineOpen = open;
    try { localStorage.setItem("vc_fine", open ? "1" : "0"); } catch (_) {}
    $("#fine").hidden = !open;
    const b = $("#btn-fine");
    b.setAttribute("aria-expanded", open ? "true" : "false");
    b.textContent = open ? "Скрыть тонкую настройку ▴" : "Тонкая настройка ▾";
    if (open) select(MODULES.some((m) => m.key === selected) ? selected : "ns");
  }

  function buildTypes() {
    const row = $("#types");
    row.innerHTML = "";
    const selects = [];
    const cards = TYPES.map((t, i) => {
      const sel = h("select", { "aria-label": "Вариант" }, t.variants.map((v) => h("option", null, v)));
      sel.addEventListener("click", (e) => e.stopPropagation());
      sel.addEventListener("change", () => Backend.emit("vc_setType", { type: i, variant: sel.selectedIndex }));
      selects[i] = sel;
      const card = h("div", { class: "type" + (t.soon ? " disabled" : ""), role: "radio", tabindex: t.soon ? "-1" : "0", "aria-disabled": t.soon ? "true" : null },
        h("div", { class: "type-head" }, h("span", { class: "type-dot" }), h("span", { class: "type-name" }, t.name),
          t.soon ? h("span", { class: "type-soon" }, "скоро") : null),
        h("p", { class: "type-desc" }, t.desc),
        t.variants.length ? h("div", { class: "type-variant" }, h("label", null, "Вариант"), sel) : null);
      const pick = () => {
        if (t.soon) return;
        if (Math.round(P.get("vc_type").value) !== i) Backend.emit("vc_setType", { type: i, variant: 0 });
      };
      card.addEventListener("click", pick);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      row.append(card);
      return card;
    });
    // быстрые ручки бэков
    const quick = $("#quick");
    quick.innerHTML = "";
    const groups = QUICK.map((g) => {
      const el = h("section", { class: "section quick-group" },
        h("div", { class: "section-head" }, h("h2", { class: "section-title" }, g.title), toggle(g.power, { label: "Вкл" })),
        h("div", { class: "controls" }, g.items.map(control)));
      quick.append(el);
      return { g, el };
    });
    const bpmEl = h("div", { class: "quick-bpm" }, h("span", { class: "bpm-value" }, "—"), h("span", { class: "bpm-unit" }, "BPM из проекта"));
    quick.append(bpmEl);
    onMeter("bpm", (v) => { bpmEl.firstChild.textContent = v ? v.toFixed(1) : "—"; });

    function refresh() {
      const cur = Math.round(P.get("vc_type").value), vr = Math.round(P.get("vc_variant").value);
      cards.forEach((c, i) => { c.classList.toggle("on", i === cur); c.setAttribute("aria-checked", i === cur ? "true" : "false"); });
      if (selects[cur]) selects[cur].selectedIndex = Math.min(vr, TYPES[cur].variants.length - 1);
      quick.hidden = cur !== 2;
      groups.forEach(({ g, el }) => { el.hidden = !!g.variants && !g.variants.includes(vr); });
      const vname = TYPES[cur].variants[Math.min(vr, TYPES[cur].variants.length - 1)] || "";
      $("#type-note").textContent = `Сейчас: ${TYPES[cur].name}${vname ? " — " + vname : ""}. При смене типа или варианта все ручки выставляются под него; «Сбросить к пресету» возвращает этот пресет.`;
    }
    P.on("vc_type", refresh);
    P.on("vc_variant", refresh);
    $("#btn-fine").onclick = () => setFine(!fineOpen);
  }

  function buildTop() {
    $("#io-in").append(knob("g_in", { label: "Вход" }));
    $("#io-out").append(knob("g_out", { label: "Выход" }));
    ioMeter("m-in", "in");
    ioMeter("m-out", "out");
    $("#btn-reset").onclick = () => Backend.emit("vc_resetAll");
  }

  // связка Mid/High Air
  let airLast = null;
  function wireAirLink() {
    P.on("air_mid", (pp) => {
      if (airLast !== null && P.isOn("air_link") && !wireAirLink.busy) {
        const delta = pp.value - airLast;
        const hp = P.get("air_high");
        if (Math.abs(delta) > 1e-6) {
          wireAirLink.busy = true;
          P.setValue("air_high", Math.max(0, Math.min(100, hp.value + delta)));
          wireAirLink.busy = false;
        }
      }
      airLast = pp.value;
    });
  }

  // ===================================================================== События от плагина
  Backend.on("vc_init", (data) => {
    P.map.clear();
    for (const d of data.params) P.map.set(d.id, { desc: d, norm: d.norm, value: d.value, text: d.text });
    eqData.freqs = data.eqFreqs || [];
    const sr = data.sampleRate ? `${(data.sampleRate / 1000).toFixed(1).replace(".0", "")} кГц` : "";
    $("#status").textContent = `Задержка ${Math.round(data.latencyMs || 0)} мс, ${sr}${Backend.live ? "" : ", предпросмотр"}`;
    $("#io-in").innerHTML = ""; $("#io-out").innerHTML = "";
    buildTop();
    buildChain();
    buildTypes();
    markPersistentMeters();
    wireAirLink();
    setFine(fineOpen);
    if (!fineOpen) select(MODULES.some((m) => m.key === selected) ? selected : "ns");
  });
  Backend.on("vc_values", (data) => data.changes.forEach((c) => P.update(c)));
  Backend.on("vc_meters", handleMeters);
  Backend.on("vc_eq", (data) => {
    Object.assign(eqData, data);
    const m = MODULES.find((x) => x.key === selected);
    if (m && m.eq && eqRedraw.has(m.eq)) eqRedraw.get(m.eq)();
  });

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
    const freqs = Array.from({ length: 160 }, (_, i) => 20 * Math.pow(1000, i / 159));

    function setNorm(id, norm) {
      const p = byId.get(id);
      if (!p) return;
      p.norm = Math.min(1, Math.max(0, norm));
      p.value = fromNorm(p, p.norm);
      p.norm = toNorm(p, p.value);
      p.text = formatValue(p, p.value);
      fire("vc_values", { changes: [{ id, norm: p.norm, value: p.value, text: p.text }] });
      if (id.startsWith("eq")) sendCurves();
    }
    // упрощённый расчёт АЧХ (формулы RBJ), только для предпросмотра
    function bandDb(type, f0, gain, q, slope, f, sr) {
      const w = 2 * Math.PI * f / sr, w0 = 2 * Math.PI * Math.min(f0, sr * 0.49) / sr;
      const A = Math.pow(10, gain / 40), al = Math.sin(w0) / (2 * q), c = Math.cos(w0);
      let b0, b1, b2, a0, a1, a2;
      if (type === 3 || type === 4) {
        const order = slope / 6;
        const ratio = type === 3 ? f / f0 : f0 / f;
        return -10 * Math.log10(1 + Math.pow(1 / ratio, 2 * order));
      }
      if (type === 0) { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
      else if (type === 5) { b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
      else {
        const sA = 2 * Math.sqrt(A) * al, s = type === 1 ? -1 : 1;
        b0 = A * ((A + 1) - s * (A - 1) * c + sA); b1 = 2 * s * A * ((A - 1) - s * (A + 1) * c); b2 = A * ((A + 1) - s * (A - 1) * c - sA);
        a0 = (A + 1) + s * (A - 1) * c + sA; a1 = -2 * s * ((A - 1) + s * (A + 1) * c); a2 = (A + 1) + s * (A - 1) * c - sA;
      }
      const re = (x0, x1, x2) => x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w);
      const im = (x1, x2) => -(x1 * Math.sin(w) + x2 * Math.sin(2 * w));
      const n = Math.hypot(re(b0, b1, b2), im(b1, b2)), dd = Math.hypot(re(a0, a1, a2), im(a1, a2));
      return 20 * Math.log10(n / dd);
    }
    function sendCurves() {
      const out = {};
      for (const pre of ["eq1", "eq2"]) {
        out[pre] = freqs.map((f) => {
          let db = 0;
          for (let b = 1; b <= 8; b++) {
            const g = (k) => byId.get(`${pre}_b${b}_${k}`).value;
            if (g("on") < 0.5) continue;
            db += bandDb(Math.round(g("type")), g("freq"), g("gain"), g("q"), [6, 12, 18, 24, 30, 36, 48][Math.round(g("slope"))], f, 48000);
          }
          return db;
        });
        out[pre + "Dyn"] = new Array(8).fill(0);
      }
      fire("vc_eq", out);
    }
    const handlers = {
      vc_ready: () => {
        fire("vc_init", { params: params.map((p) => Object.assign({}, p)), eqFreqs: freqs, sampleRate: 48000, latencyMs: 30 });
        sendCurves();
        setInterval(() => {
          const t = Date.now() / 1000, wob = (x) => Math.max(0, Math.sin(t * x) * 0.5 + 0.5);
          fire("vc_meters", { in: 0.3 * wob(2.1), out: 0.4 * wob(2.1), nsVoice: wob(1.3), ds: 4 * wob(5), sslComp: 3 * wob(2), sslGate: 0,
                              rc: 6 * wob(2.3), fet: 8 * wob(2.7), vox: 3 * wob(1.9), voxGate: 0, bpm: 161 });
        }, 33);
      },
      vc_set: (o) => setNorm(o.id, o.norm),
      vc_setValue: (o) => { const p = byId.get(o.id); if (p) setNorm(o.id, toNorm(p, Math.min(p.max, Math.max(p.min, o.value)))); },
      vc_default: (o) => { const p = byId.get(o.id); if (p) setNorm(o.id, p.defNorm); },
      vc_resetAll: () => handlers.vc_setType({ type: Math.round(byId.get("vc_type").value), variant: Math.round(byId.get("vc_variant").value) }),
      vc_setType: (o) => {
        const key = o.type + ":" + (o.variant || 0);
        const ov = (window.VC_MOCK_TYPES || {})[key] || {};
        params.forEach((p) => setNorm(p.id, ov[p.id] !== undefined ? toNorm(p, ov[p.id]) : p.defNorm));
      },
    };
    return {
      live: false,
      on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      emit: (ev, obj) => { if (handlers[ev]) setTimeout(() => handlers[ev](obj || {}), 0); },
    };
  }
})();
