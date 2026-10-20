# WOK Studio — как менять дизайн (для Gemini и других ИИ)

Этот файл — инструкция для нейросети или дизайнера, который будет менять внешний вид студии.
Цель: свободно менять дизайн и не сломать звук и логику.

## Готовый запрос для нейросети

Можно скопировать как есть:

> Ты меняешь дизайн браузерной DAW «WOK Studio» (папка проекта приложена).
> Правила в файле DESIGN.md — прочитай его первым.
> Меняй только `css/theme.css`, `css/app.css` и тексты/порядок элементов в `index.html`.
> Не переименовывай id и классы из списков в DESIGN.md и не трогай файлы в `js/`.
> Студия должна работать и на компьютере, и на телефоне (ширина 390 px).
> Проверяй результат, открывая `index.html` через локальный сервер (`python -m http.server`).
> В конце перечисли, какие переменные и правила ты поменял.

## Что можно менять свободно

| Файл | Что внутри |
|---|---|
| `css/theme.css` | **Все** цвета, градиенты, тени, шрифты и размеры. Начинать с него. |
| `css/app.css` | Форма элементов: раскладка, скругления, отступы, вид окон, кнопок, ручек, фейдеров. |
| `index.html` | Порядок и подписи кнопок верхней панели, браузера, нижних вкладок телефона. |

## Что трогать нельзя (или только вместе с Claude)

- `js/engine.js` — звуковой движок, микшер, посылы, плагины, запись, экспорт.
- `js/worklets.js` — автотюн, де-эссер, VocalChain и запись в аудиопотоке.
- `js/project.js` — сохранение, открытие, отмена действий.
- `js/ui.js` — можно менять тексты, но не имена классов и id ниже.
- `js/shka-worker.js` — фоновая часть ShkaFX.
- `js/vc-bundle.js`, `js/shka-bundle.js` — генерируются, руками не править. Окна плагинов — их родные интерфейсы:
  дизайн VocalChain меняется в `plugins/vocalchain/ui/style.css`, ShkaFX — в `plugins/shkafx/ui/style.css`
  (правила в UI_API.md каждого плагина), затем `pack.py` в папке плагина.

## Как устроен объём

Дизайн не плоский: кнопки выпуклые, поля утоплены, ручки и фейдеры объёмные. Всё это задаётся
переменными в `theme.css`, поэтому стиль меняется целиком в одном месте:

| Переменная | Где применяется |
|---|---|
| `--grad-raised`, `--grad-raised-hover`, `--grad-pressed` | все обычные кнопки: обычное состояние, наведение, нажатие |
| `--shadow-raised`, `--shadow-pressed` | тени выпуклых и нажатых кнопок |
| `--shadow-inset` | утопленные поля: LCD, списки, графики, индикаторы |
| `--grad-panel`, `--shadow-panel`, `--shadow-window` | панели и плавающие окна |
| `--grad-title`, `--grad-title-active` | заголовки окон |
| `--grad-topbar` | верхняя панель и нижние вкладки телефона |
| `--grad-accent`, `--grad-rec` | оранжевые активные кнопки, кнопка записи |
| `--grad-lcd` | дисплеи (BPM, время, графики EQ и клиппера) |
| `--grad-strip`, `--grad-strip-ret` | каналы микшера и каналы-возвраты |
| `--knob-cap`, `--shadow-knob`, `--knob-ring`, `--knob-track`, `--knob-send` | ручки |
| `--fader-cap`, `--fader-groove`, `--shadow-fader` | фейдеры микшера |
| `--grad-step`, `--grad-step-b`, `--grad-step-on`, `--step-on-glow` | шаги Channel Rack (группы по 4: серые / красноватые; включённый — оранжевый со свечением) |
| `--glow-accent`, `--glow-led`, `--text-emboss` | свечение и тиснение текста |
| `--accent`, `--accent-soft`, `--led-on`, `--route` | оранжевый акцент FL (#ff8800), неоновый лайм индикаторов, цвет активного маршрута |
| `--gutter`, `--mtabs-h`, `--sheet-radius` | поля страницы, высота нижнего таб-бара, скругление шторки (телефон) |

Хочешь плоский стиль — замени градиенты на однотонные цвета, а тени на `none`.

## Имена, на которые опирается код

Если переименовать их в HTML или CSS, кнопки перестанут работать.

**id в index.html:** `app`, `topbar`, `btnProject`, `projName`, `projMenu`, `projNameInput`, `mSave`, `mOpen`,
`mNew`, `mExport`, `btnUndo`, `btnRedo`, `projOpenInput`, `btnPlay`, `btnStop`, `btnRec`, `bpm`, `lcdTime`,
`btnMetro`, `btnMonitor`, `btnPattern`, `wbBrowser`, `wbRack`, `wbMixer`, `masterMeter`, `btnExport`, `hint`,
`workspace`, `browser`, `brPlugins`, `brAudio`, `fileImport`, `latencyMs`, `audioInfo`, `micMeter`, `playlist`,
`zoomOut`, `zoomIn`, `delBtn`, `splitBtn`, `dupBtn`, `addTrack`, `plHeads`, `plScroll`, `plContent`, `ruler`,
`lanes`, `playhead`, `windows`, `mtabs`.

Атрибут `data-tab` у `#app` и у кнопок в `#mtabs` (playlist / rack / mixer / browser) переключает разделы на телефоне.

**Классы, которые создаёт ui.js** (их можно стилизовать как угодно):

- окна: `.win`, `.win.front`, `.win-title`, `.w-name`, `.w-sub`, `.w-close`, `.win-body`; у окна атрибут `data-win` (`rack`, `mixer`, `plug-<канал>-<слот>`)
- плейлист: `.head`, `.head.selected`, `.swatch`, `.h-main`, `.h-name`, `.h-route`, `.h-btns`,
  `.lane`, `.lane.drop`, `.pattern-lane`, `.pattern-head`, `.pattern-block`, `.lane-empty`,
  `.clip`, `.clip.selected`, `.c-name`, `.trim.l`, `.trim.r`, `.fade.fi`, `.fade.fo`
- кнопки-квадраты: `.sq`, `.sq.on`, `.sq.arm`, `.sq.solo`; светодиоды `.led`, `.led.off`
- Channel Rack: `.rack`, `.rack-row`, `.r-name`, `.steps`, `.step`, `.step.b`, `.step.on`, `.step.now`
- Channel Rack на телефоне: `.m-rack`, `.m-rack-row`, `.m-rack-row.muted`, `.m-rack-head`, `.m-led`, `.r-title`, `.r-meta`, `.m-steps`
  (шаг — прозрачная зона нажатия, видимый квадрат рисуется в `.step::before`)
- панель канала снизу (bottom sheet): `.sheet-back`, `.sheet`, `.sheet-head`, `.sheet-grip`, `.sheet-title`, `.sheet-sub`,
  `.sheet-acts`, `.sheet-btn`, `.sheet-btn.primary`, `.sheet-ctl`, `.sheet-row`, `.sheet-val`, `.hfader` (горизонтальный фейдер, CSS-переменная `--p` 0..1)
- микшер: `.mixer`, `.strips`, `.strip`, `.strip.master`, `.strip.ret`, `.strip.selected`, `.strip.add-ret`, `.s-num`, `.s-name`,
  `.s-sends`, `.knob.send`, `.s-retlabel`, `.s-addnote`, `.s-btns`, `.s-db`, `.fader-wrap`, `.fader`, `.cap`, `.strip-meter`,
  `.fx-rack`, `.fr-title`, `.fx-slot`, `.open`, `.fx-note`
- маршрутизация в микшере: `.s-route` (низ канала), `.s-route-src` (подпись у выбранного), `.route-btn`, `.route-btn.on`, `.knob.route-level`,
  `.strip.routed` (сюда идёт выбранный канал), `.strip.feeds` (этот канал приходит в выбранный)
- плагины: `.plug`, `.plug-row`, `.plug-sec`, `.ps-title`, `.plug-field`, `.seg`, `.plug-foot`, `.plug-frame-box`, `.plug-frame`
- автотюн: `.at-display`, `.at-note`, `.at-note.idle`, `.at-bar`, `.at-cap`, `.at-knobs`
- EQ: `.eq-graph`, `.eq-bands`, `.eq-band`, `.eq-band.sel`, `.eq-band.out`, `.eq-band-head` (цвет полосы — переменная `--band`)
- Soft Clipper: `.clip-top`, `.clip-graph`, `.clip-meter`, `.gr-label`, `.gr-bar`, `.gr-val`
- ручка: `.knob`, `.knob.small`, `.knob-dial` (CSS-переменная `--p` от 0 до 1 = положение), `.knob-label`, `.knob-val`
- меню и окна: `.menu-wrap`, `.menu`, `.menu-field`, `.menu-item`, `.menu-note`, `.modal-back`, `.modal`, `.m-btns`, `.hintbar.restore`, `.hint-actions`
- состояния верхней панели: `.tbtn.active`, `.tog.on`, `.wbtn.on`

## Переменные, которые читает JavaScript

Эти переменные можно менять, но не удалять:

- `--beat-px` — стартовый масштаб плейлиста (зум меняет его на элементе `#playlist`).
- `--meter-lo`, `--meter-mid`, `--meter-hi` — цвета индикаторов уровня (рисуются на canvas).
- `--clip-1` … `--clip-6` — цвета дорожек и клипов.
- `--accent`, `--text`, `--text-faint`, `--bg-inset`, `--font-mono` — графики EQ и клиппера.
- `--eq-grid`, `--eq-fill`, `--eq-band-1` … `--eq-band-7` — сетка, заливка и точки полос EQ.

## Телефон

Ниже 820 px студия переходит в мобильный режим (см. `@media (max-width: 820px)` в `app.css` и `theme.css`):
нижний таб-бар в духе FL Studio Mobile (кнопки `#mtabs button` с `<svg>` и `<span>`, активная — `.on`), один раздел на экране,
Rack и Микшер во всю ширину, окна плагинов на весь экран, крупные кнопки (`--tap`).
Channel Rack на телефоне — сетка 8×2 без прокрутки вбок; размеры задают `--tap-step` (зона нажатия шага, 44 px),
`--step-inset` (отступ видимого квадрата) и `--rack-pad-x` (поля по бокам). Условие: `8 × --tap-step + 2 × --rack-pad-x ≤ 360 px`.
Любые изменения проверяй и на ширине 390 px.
