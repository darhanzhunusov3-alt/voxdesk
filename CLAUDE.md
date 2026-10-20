# VoxDesk — техническая сводка для Claude Code

Браузерная DAW в духе FL Studio для записи и сведения вокала. Автор — пользователь (битмейкер/вокалист,
пишет в FL Studio, свои VST: **VocalChain** и **ShkaFX**). Цель: своя студия в браузере с его плагинами,
позже — PWA / обёртка для Android и iOS (IPA через GitHub Actions).

Язык общения и интерфейса студии — **русский** (интерфейсы плагинов VocalChain/ShkaFX — их собственные, ShkaFX на английском).

---

## 1. Стек и общие принципы

- **Без сборщика и фреймворков:** чистый JS (ES2020), HTML, CSS. Все модули — IIFE, общий глобальный объект `window.Vox`.
- Порядок подключения в `index.html` важен:
  `vc-bundle.js` → `shka-bundle.js` → `shka-worker.js` → `worklets.js` → `engine.js` → `project.js` → `ui.js`.
- **Сборка одного файла:** `python3 build.py` → `dist/voxdesk.html` (всё встроено) и `dist/voxdesk-artifact.html`
  (фрагмент без `<html>/<head>/<body>` для публикации как артефакт Claude). В `build.py` внутри встроенных скриптов
  экранируются `</script` и `<!--` — строки с интерфейсами плагинов их содержат.
- **Запуск:** `python -m http.server 8000` в корне → `http://localhost:8000` (микрофон работает только на https/localhost).
  Хостинг — GitHub Pages.
- Плагины пользователя (C++) собраны в **WebAssembly** (wasi-sdk 24, `wasm32-wasip1`, reactor) и работают побитово
  так же, как VST (проверено сравнением с нативной сборкой: VocalChain ≈1e-4, ShkaFX ≈1e-14).

## 2. Структура файлов

```
index.html            разметка: верхняя панель, браузер, плейлист, слой окон, нижние вкладки (телефон)
css/theme.css         ВСЕ токены дизайна: цвета, градиенты, тени, шрифты, размеры (+ медиа для телефона)
css/app.css           раскладка и компоненты (использует только токены)
js/worklets.js        функция voxWorkletModule(): все AudioWorklet-процессоры (уходит в аудиопоток через toString)
                        vox-autotune, vox-deesser, vox-recorder, vox-vocalchain, vox-shkafx
js/engine.js          звуковой движок: состояние Vox.state, эффекты Vox.FX, микшер, посылы, транспорт,
                        запись, клипы, PDC, экспорт, загрузка wasm плагинов, хосты ShkaFX
js/project.js         отмена/повтор, сохранение/открытие .voxdesk.zip (свой zip-писатель/читатель), автосохранение IndexedDB
js/ui.js              весь интерфейс: окна, плейлист, Channel Rack, микшер, окна плагинов, мосты к iframe плагинов, вкладки телефона
js/shka-worker.js     функция voxShkaWorker(): фоновая часть ShkaFX (Web Worker из Blob URL)
js/vc-bundle.js       ГЕНЕРИРУЕТСЯ plugins/vocalchain/pack.py: window.VC = {data, ui, wasmGz}
js/shka-bundle.js     ГЕНЕРИРУЕТСЯ plugins/shkafx/pack.py: window.SHKA = {version, ui, wasmGz}
plugins/vocalchain/   ui/ (родной интерфейс), vocalchain.wasm, vc_data.json (параметры+пресеты), web/build.sh, web/vc_web.cpp, web/dump.cpp, pack.py
plugins/shkafx/       ui/ (+fonts/Inter), shkafx.wasm, web/build.sh, web/patch.py, web/shim/, web/shka_web.cpp, pack.py
DESIGN.md             правила правки дизайна другими ИИ (Gemini): что можно менять, список id/классов, готовый промпт
README.md             для пользователя: запуск, возможности, горячие клавиши, как обновлять плагины
build.py              сборка dist/
```

## 3. Архитектура

### 3.1 Состояние (`Vox.state`, engine.js)
```js
{ projectName, bpm, posBeats, playing, recording, metronome, monitor, patternInSong, latencyMs,
  selectedInsert, selectedTrack, selectedClip,
  tracks: [{ name, color(1..6), insert, armed, mute,
             clips: [{ id, bufferId, startBeat, offset(s), dur(s), name, fadeIn(s), fadeOut(s) }] }],
  mixer:  [{ name, vol(0..1, 0.8 = 0 dB), pan, mute, solo, ret(bool — канал-возврат),
             sends: { [busIndex]: 0..1 }, fx: [8 слотов: null | { type, bypass, params }] }],   // mixer[0] — Master
  rack:   { channels: [{ name, type(kick|clap|hat|ohat|b808), insert, vol, mute, steps[16] }] } }
```
- Аудиоданные: `Vox.buffers: Map<id, {buffer: AudioBuffer, name, uid}>` — неизменяемые, клипы ссылаются по `bufferId`.
- События: `Vox.on(ev, fn)` / `Vox.emit(ev)`; основные: `tracks`, `mixer`, `buffers`, `transport`, `project`, `history`,
  `hint`, `autotune-report`, `vc-meters`, `restore-available`.
- Проект по умолчанию: дорожки «Вокал Мейн/Даблы/Бэки/Адлибы/Бит»; инсерты 1–10, 11 «Send Reverb», 12 «Send Delay» (ret);
  на мастере Soft Clipper; на вокальных каналах автотюн + VocalChain (типы Мейн/Даблы/Бэки).

### 3.2 Эффекты (`Vox.FX[type]`)
Интерфейс эффекта: `{ title, defaults(), latency?(params, sr), create(ctx, params, info) → { input, output, apply(params), dispose?() } }`.
`info = { live, insert, slot, ahead }` (`ahead` — суммарная задержка эффектов ПОСЛЕ этого слота).
Список в браузере: `Vox.FX_ORDER = ['autotune','vocalchain','shkafx','eq','reverb','delay','chorus','clipper']`.

| type | Реализация |
|---|---|
| `autotune` | AudioWorklet `vox-autotune`: YIN (на децимированном ×2 сигнале + уточнение на полной частоте) + TD-PSOLA с историей измерений во времени, нормировка суммы окон. Ручки как Antares: Retune Speed, Humanize, Flex-Tune, Amount, Tracking, Transpose, тип голоса (fmin 75/100/150 Гц). Задержка `2·Tmax+64` сэмплов (≈13–27 мс), компенсируется. Защита от октавных ошибок (подтверждение начала ноты 3 измерения, скачок октавы ≥8 измерений, проверка соседней октавы). Пресет «Жёсткий» = Auto-Tune Pro Classic (Retune 0) — совпадение нот с Antares на тесте ≈98 %. |
| `vocalchain` | AudioWorklet `vox-vocalchain`, wasm из исходников VocalChain 1.2 (NS1 на RNNoise, EQ, DeEsser, SSL, RComp, FET-76, Fresh Air, RVox, Chorus/PanMan/Delay/LowPass/Carousel). params `{type, variant, values[293]}`. Задержка 30 мс (шумодав). Окно — родной UI в iframe. |
| `shkafx` | См. 3.5. params `{uid, values[47], data(base64 serialise SwellEngine)}`. |
| `eq` | 7 полос BiquadFilter (hp/ls/pk×3/hs/lp, срезы 12/24 дБ/окт), график через `getFrequencyResponse` на «пробных» фильтрах OfflineAudioContext. |
| `reverb` | ConvolverNode с импульсом, генерируемым из ручек (ранние отражения + хвост с разным RT для низа/середины/верха, ширина), dry/wet. |
| `delay` | DelayNode, синхронизация с BPM, пинг-понг, насыщение повторов, dry/wet. |
| `chorus` | 2 модулированные задержки (LFO в противофазе L/R), ширина, feedback. |
| `clipper` | WaveShaper `oversample='4x'` (мягкое колено, tanh) + страховочный жёсткий клип ровно по ceiling. Анализаторы до/после — индикатор «срезано». |

### 3.3 Микшер и маршрутизация
`buildChannel`: `input → [fx…] → fader(Gain) → pan(StereoPanner) → master.input` (+ анализаторы L/R для индикаторов в live).
Посылы — post-fader: `pan → Gain(send) → ret.input` (только в каналы `ret`). Solo не глушит каналы-возвраты.
`Vox.syncMixer()` приводит живой граф к `Vox.state.mixer`, пересобирая только каналы с изменившейся структурой эффектов
(ключ `fxKey`), остальным вызывает `apply(params)`; у удаляемых узлов вызывается `dispose()` (worklet-процессоры получают
`{dispose:true}` и возвращают `false`, чтобы не текла память).

### 3.4 AudioContext — принятые решения
- **Один `AudioContext({ latencyHint: 'interactive' })`**, создаётся лениво в `Vox.init()`; `Vox.resume()` — на первый жест
  (глобальный `pointerdown` в capture-фазе). Частота — та, что даёт устройство (44.1/48 кГц), не навязываем.
- **Все AudioWorklet-процессоры в одном модуле**: `voxWorkletModule.toString()` → Blob URL → `audioWorklet.addModule`.
  Тот же модуль грузится в `OfflineAudioContext` для экспорта.
- **wasm-модули компилируются один раз в главном потоке** (`WebAssembly.compile` из gzip+base64 через `DecompressionStream`)
  и передаются в процессоры через `processorOptions.module` (запасной путь — сырые байты `wasm`). Стартовые параметры тоже
  через `processorOptions`, чтобы офлайн-рендер сразу звучал правильно.
- **Транспорт:** планировщик с упреждением (`setInterval` 25 мс, окно 150 мс) для паттерна/метронома; клипы — `AudioBufferSourceNode.start(when, offset, dur)`,
  fade — автоматизация `GainNode`.
- **PDC (компенсация задержки):** `Vox.insertLatency(insert)` = сумма `latency()` эффектов; `Vox.maxPdc()` по звучащим дорожкам;
  `t0 = now + 0.08 + maxPdc`, клип дорожки стартует на `t0 + (cs − songPos) − pdc(дорожки)`. Экспорт: рендер с запасом `pre = maxPdc`,
  `Vox.offlineT0 = pre`, затем запас отрезается → микс ровно с 1-го такта.
- **Позиция песни в worklet:** процессоры, которым нужен темп/позиция (VocalChain, ShkaFX), получают `{transport: {playing, t0, startBeat, bpm, ahead}}`
  и считают `songSec = currentTime − t0 + ahead + startBeat·60/bpm` (`Vox.transportFor(ctx)`, рассылается на play/stop).
- **Запись:** `getUserMedia` без echoCancellation/noiseSuppression/AGC → `vox-recorder` пишет с точной позиции `t0`;
  смещение клипа = `outputLatency (или baseLatency) + latencyMs` (ручная поправка в «Настройки звука»).
- **Мониторинг:** вход микрофона в канал дорожки с ● через Gain (вкл/выкл).
- **Экспорт микса:** `OfflineAudioContext(2, …)`, тот же `buildMixer`, 16-bit WAV; сохранение через `Vox.saveBlob`
  (в артефакте Claude — capability `downloads`, разрешает только zip/json; иначе `<a download>`).

### 3.5 ShkaFX в браузере (самая сложная часть)
Исходник плагина: JUCE + `SwellEngine` (фоновый поток рендерит хвосты). В браузере:
- **Один wasm (`shkafx.wasm`, 160 КБ), два экземпляра:**
  - **Web Worker** (`shka-worker.js`, по одному на слот — «хост», `Vox.shkaHosts[uid]`): `SwellEngine` — запись волны, выделения,
    расчёт хвостов (`pump()` каждые 15 мс вместо `std::thread`), пики, офлайн-рендер, serialise/deserialise, снимки для отмены.
    Готовые хвосты (`live` TailSet) отправляются в worklet (transferable), список выделений — в окно.
  - **AudioWorklet `vox-shkafx`**: ThrowDelay A/B (C++), подмешивание хвостов по позиции песни, прослушивание (preview-буфер),
    запись волны — блоки по 1024 сэмпла идут в Worker напрямую через `MessageChannel`.
- **Сборка:** `web/patch.py` копирует `source/dsp` + `ParamTable` и правит две вещи (не запускать поток, добавить `pump()`);
  `web/shim/` — заглушки `<thread>/<mutex>/<condition_variable>` (wasi без потоков); `shka_web.cpp` использует `#define private public`
  для доступа к `live`. Исходники плагина не меняются.
- **Окно:** родной `ui/` в iframe (`srcdoc`, шрифты Inter вшиты data-URI), подменённый `window.__JUCE__.backend` → `postMessage`;
  протокол — `UI_API.md` плагина (vc_* и lf_*). Мост в `ui.js` (`shkaBridge`) реализует: параметры, выделения, пики, отмену
  (стек `{values, snapshot}` с объединением правок 1.5 с), свой файл/drag&drop, прослушивание, экспорт (24-bit WAV, несколько — zip,
  плюс добавление в «Аудио в проекте»). Лицензия в браузере всегда «licensed» (решение пользователя: в своей студии без ключа).
- **Проект:** `params.data` — base64 `SwellEngine::serialise()`; перед сохранением/автосохранением `Vox.shkaFlush()`.
  В историю отмены студии `data` НЕ входит (replacer в `snapJSON`) — у плагина своя отмена.
- У копии канала (дублирование) новый `uid` → свой хост.

### 3.6 VocalChain в браузере
`vc_web.cpp` — тонкая обёртка над `VocalChainDSP` (буферы, параметры, индикаторы, кривые EQ). `dump.cpp` нативно выгружает таблицу
параметров и пресеты в `vc_data.json`. Мост `vcBridge` в `ui.js`: iframe с родным UI, `vc_init/vc_values/vc_meters/vc_eq`,
форматирование значений как в `PluginProcessor.cpp`. На узком экране iframe масштабируется (`transform: scale`).

### 3.7 Проект, отмена, автосохранение (`project.js`)
- **История:** снимок `{projectName, bpm, patternInSong, tracks (без armed), mixer, rack}` в JSON; проверка изменений
  через 250 мс после `pointerup/change/keyup` и событий `tracks/mixer`; до 120 шагов. `Vox.applySnapshot()` + `Vox.syncMixer()`.
- **Файл проекта `.voxdesk.zip`:** собственный zip без сжатия (CRC32), `project.json` + `audio/<id> <name>.wav` (32-bit float).
  Чтение поддерживает stored и deflate (`DecompressionStream('deflate-raw')`).
- **Автосохранение:** IndexedDB `voxdesk` (`kv`: состояние, `buffers`: каналы по `uid`), раз в 2.5 с после изменения;
  при запуске — полоса «Найден прошлый проект… Восстановить».

## 4. Дизайн-система
- **Все токены — в `css/theme.css`** (`:root`), компоненты в `app.css` используют только их. Одна тёмная тема (`color-scheme: dark`) по образцу FL Studio.
- **Объём (не плоский дизайн — требование пользователя):** `--grad-raised / --grad-raised-hover / --grad-pressed`, `--shadow-raised / --shadow-pressed / --shadow-inset`,
  `--grad-panel`, `--shadow-panel`, `--shadow-window`, `--grad-title(-active)`, `--grad-topbar`, `--grad-accent`, `--grad-rec`, `--grad-lcd`,
  `--grad-strip(-ret)`, `--knob-cap`, `--shadow-knob`, `--fader-cap`, `--fader-groove`, `--grad-step(-b/-on)`, `--glow-accent/--glow-led`, `--text-emboss`.
- Акцент `--accent #f5a03a` (оранжевый), LED `--led-on #a6e15c`, каналы-возвраты `--ret #6fb3e8`; шрифты Barlow Semi Condensed (UI) и JetBrains Mono (LCD/цифры).
- Переменные, которые читает JS: `--beat-px`, `--meter-*`, `--clip-1..6`, `--accent`, `--text`, `--text-faint`, `--bg-inset`, `--font-mono`, `--eq-*`.
- **Правка дизайна другими ИИ** — по `DESIGN.md` (список id/классов, на которые опирается код, и готовый промпт). Нельзя переименовывать id/классы и трогать `js/`.
- **Телефон (`max-width: 820px`):** `--tap: 40px`, нижние вкладки `#mtabs` (playlist / rack / mixer / browser) переключают `#app[data-tab]`;
  окна Rack и Микшер растягиваются на всю область вкладки, окна плагинов — полноэкранные «листы»; верхняя панель — одна строка с горизонтальной прокруткой.
- Ручка: `.knob-dial` с CSS-переменной `--p` (0..1), conic-gradient кольцо + колпачок; перетаскивание вертикальное, Shift — точно, двойной клик — сброс.

## 5. Реализованные фичи (кратко)
Плейлист (клипы с волной, перенос между дорожками, привязка 1/4 доли, Alt — без привязки, обрезка краёв, fade, разрезать S, удалить, дублировать Ctrl+D,
зум, импорт drag&drop) · запись с микрофона и мониторинг · Channel Rack (5 синтезированных барабанов, 16 шагов, 1 паттерн) · микшер (фейдеры, панорама,
M/S, индикаторы, 8 FX-слотов, посылы, «+ Посыл») · 8 эффектов (см. 3.2) · проект (сохранить/открыть/новый, Ctrl+Z/Y, автосохранение) ·
экспорт WAV · горячие клавиши (Пробел, R, S, Ctrl+D/Z/Y/S/O, F6/F8/F9, Delete) · подсказки в строке состояния · мобильная раскладка.

## 6. Как проверялось
Headless Chromium через Playwright (`--use-fake-device-for-media-stream`, `--autoplay-policy=no-user-gesture-required`): загрузка без ошибок,
запись, клипы/отмена/сохранение/открытие/восстановление, экспорт (выравнивание PDC 0–2 мс, потолок клиппера −0.3 дБ), посылы (уровень на возврате),
окна плагинов, ширина 390 px без горизонтальной прокрутки страницы. Автотюн — офлайн в Node (мок `AudioWorkletProcessor`) против записи Antares пользователя.
Тестовые скрипты в репозиторий не входят — стоит завести `tests/` с Playwright.

## 7. Известные ограничения
- Окно ShkaFX рассчитано на 1180 px; на телефоне масштабируется целиком (≈0.33) и плохо читается — нужна мобильная раскладка в `plugins/shkafx/ui`.
- Автотюн: на тестовой фразе осталось ~5 коротких октавных ошибок; задержка живого мониторинга с автотюном 13–27 мс + звуковая карта.
- В предпросмотре артефакта Claude недоступны микрофон и скачивание WAV (только zip/json через capability `downloads`).
- iOS Safari не тестировался (мобильный Rack проверен только в эмуляции Chromium). Один паттерн в Rack, нет автоматизации, нет MIDI/синтов, нет выбора сэмплов для барабанов.
- `vc-bundle.js` ~7 МБ (wasm VocalChain с весами RNNoise) — первая загрузка заметна.

---

## 8. Мобильный Channel Rack — СДЕЛАНО (2026-10-20)

**Реализовано:** `buildRackMobile` в `ui.js` (выбор в `buildRack` по `Vox.isMobile()`, пересборка на `change` медиа 820 px):
сетка 8×2 (выбрана вместо страниц — подсветка шага видна всегда), ячейка шага без зазоров = зона нажатия ≥44 px (`--tap-step`),
видимый квадрат — `::before`; окно Rack на вкладке в край экрана (поля `#app`, кроме safe-area). Свайп — `paintSteps`:
`pointerdown` задаёт режим, `setPointerCapture` + `elementFromPoint` (с `getCoalescedEvents`) в пределах сетки канала; конец жеста →
`Vox.history.schedule()` (в т.ч. на `pointercancel`) — один шаг отмены. Панель канала `openRackSheet`: прослушать (`previewDrum`,
клик = жест пользователя → `resume` работает и на iOS), вкл/выкл, ручка громкости, канал микшера. Аудио при свайпе не трогается —
планировщик читает `c.steps`. Проверено Playwright: 390×844, 360×800, десктоп 1440×900.

**Исходная постановка (для истории):**

**Сейчас (`buildRack` в `ui.js`, стили `.rack*`, `.step*` в `app.css`):** строка канала = LED, кнопка-имя (прослушать), ручка громкости,
`<select>` канала микшера, сетка 16 шагов. На телефоне шаг 26×34 px → строка шире экрана (≈620 px), Rack прокручивается вбок,
ручка и select съедают место, тапать неудобно.

**Цель:** на ширине 360–430 px весь паттерн видно и редактируется пальцем без горизонтальной прокрутки.

**Предлагаемое решение:**
1. В мобильном режиме (`Vox.isMobile()` / медиа 820 px) строка канала = компактный заголовок (LED + имя) и под ним сетка шагов
   на всю ширину. Шаги — `grid-template-columns: repeat(8, 1fr)` в **двух рядах (1–8 / 9–16)** или переключатель страниц «1–8 | 9–16»
   (выбрать лучшее по удобству; квадрат шага ≥ 40 px, `--tap`).
2. Громкость, канал микшера, mute, прослушивание — в **панели настроек канала** (bottom sheet) по тапу на имя или долгому нажатию;
   в строке остаются только LED и имя.
3. **Рисование шагов свайпом:** `pointerdown` на шаге задаёт режим (вкл/выкл) по его состоянию, `pointermove` + `elementFromPoint`
   применяет его к шагам под пальцем (`touch-action: none` на сетке; вертикальная прокрутка списка каналов — за пределами сетки).
4. Подсветка текущего шага (`.step.now`, массив `rackSteps`) должна продолжать работать — функция `frame()` в `ui.js` обращается к `rackSteps[ch][step]`.
5. Изменения шагов уже попадают в историю отмены (глобальный `pointerup` → `Vox.history.schedule()`); при свайпе убедиться,
   что получается один шаг истории на жест.
6. Десктопную раскладку не менять. Новые классы и токены — в `app.css`/`theme.css`, добавить их в список `DESIGN.md`.

**Готово, когда:** на 390×844 (iPhone) и 360×800 (Android) нет горизонтальной прокрутки в Rack и страницы; все 16 шагов
каждого канала доступны и переключаются тапом и свайпом; громкость/канал/mute/прослушивание доступны из панели канала;
воспроизведение подсвечивает шаги; Ctrl+Z (кнопка ↶) отменяет свайп целиком; на десктопе всё как раньше; в консоли нет ошибок.
Проверить скриншотами Playwright в мобильном вьюпорте (`is_mobile=True, has_touch=True`).

**Дальше по списку пользователя:** мобильная раскладка окна ShkaFX, PWA и сборка IPA/APK (Capacitor + GitHub Actions на macOS-раннере;
подпись — бесплатный Apple ID + Sideloadly/AltStore на старте).