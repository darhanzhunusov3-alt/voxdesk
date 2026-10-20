# WOK Studio — как менять дизайн (для Gemini и других ИИ)

Этот файл — инструкция для нейросети или дизайнера, который будет менять внешний вид студии.
Цель: свободно менять дизайн и не сломать звук и логику.

Текущий стиль (с 2026-10-20) — **в духе BandLab**: матовый угольный фон, графитовые карточки треков с тонким бордером,
изумрудный акцент для вокала и активных эффектов, янтарный — для бита, белые круглые бегунки ползунков,
транспорт по центру шапки, эффекты трека — в нижней панели, окна плагинов — модальные поверх студии.

## Готовый запрос для нейросети

Можно скопировать как есть:

> Ты меняешь дизайн браузерной DAW «WOK Studio» (папка проекта приложена).
> Правила в файле DESIGN.md — прочитай его первым.
> Меняй только `css/theme.css`, `css/app.css` и тексты/порядок элементов в `index.html`.
> Не переименовывай id и классы из списков в DESIGN.md и не трогай файлы в `js/`.
> Студия должна работать и на компьютере (от 1024 px), и на телефоне (ширина 360–430 px).
> Проверяй результат, открывая `index.html` через локальный сервер (`python -m http.server`).
> В конце перечисли, какие переменные и правила ты поменял.

## Что можно менять свободно

| Файл | Что внутри |
|---|---|
| `css/theme.css` | **Все** цвета, градиенты, тени, шрифты и размеры. Начинать с него. |
| `css/app.css` | Форма элементов: раскладка, скругления, отступы, вид окон, кнопок, ручек, ползунков. |
| `index.html` | Порядок и подписи кнопок верхней панели, библиотеки, нижней панели и бара режимов телефона. |

## Что трогать нельзя (или только вместе с Claude)

- `js/engine.js` — звуковой движок, микшер, посылы, плагины, запись, цикл, экспорт.
- `js/worklets.js` — автотюн, де-эссер, VocalChain и запись в аудиопотоке.
- `js/project.js` — сохранение, открытие, отмена действий.
- `js/ui.js` — можно менять тексты, но не имена классов и id ниже.
- `js/shka-worker.js` — фоновая часть ShkaFX.
- `js/vc-bundle.js`, `js/shka-bundle.js` — генерируются, руками не править. Окна плагинов — их родные интерфейсы:
  дизайн VocalChain меняется в `plugins/vocalchain/ui/style.css`, ShkaFX — в `plugins/shkafx/ui/style.css`
  (правила в UI_API.md каждого плагина), затем `pack.py` в папке плагина.

## Палитра и объём

Всё задаётся переменными в `theme.css`, стиль меняется целиком в одном месте:

| Переменная | Где применяется |
|---|---|
| `--bg-app`, `--bg-panel`, `--bg-panel-2`, `--bg-panel-3`, `--bg-inset` | фон приложения (#0f1115), панели и карточки (#16181d), наведение, нажатие, утопленные поля |
| `--bg-lane`, `--bg-lane-alt`, `--bg-head-sel`, `--bg-overlay` | дорожки таймлайна, выбранный заголовок трека, фон под окнами плагинов и шторками |
| `--line`, `--line-soft` | микро-бордер карточек (#252a34) и разделители |
| `--accent`, `--accent-hi`, `--accent-soft`, `--accent-text` | изумрудный акцент (#00c875): вокал, Fx-капсулы, активные вкладки, Solo, цикл |
| `--accent-2`, `--accent-2-soft`, `--accent-2-text` | янтарный (#ff9900): бит/инструментал, Mute, «Бит в песне» |
| `--rec`, `--glow-rec`, `--grad-rec` | алая запись (#ff3b30) |
| `--slider-track`, `--slider-fill`, `--slider-thumb` | ползунки: дорожка, заполненная часть, белый круглый бегунок |
| `--playhead`, `--loop`, `--loop-soft` | курсор воспроизведения, область цикла на линейке |
| `--grad-raised`, `--grad-raised-hover`, `--grad-pressed`, `--shadow-raised`, `--shadow-pressed`, `--shadow-inset` | кнопки и поля (мягкий объём) |
| `--grad-panel`, `--shadow-panel`, `--shadow-window`, `--grad-topbar` | панели, окна, верхняя панель |
| `--grad-accent`, `--grad-accent-2`, `--glow-accent`, `--glow-accent-2`, `--glow-led` | заливки и свечения акцентов |
| `--grad-lcd` | графики автотюна, EQ и клиппера |
| `--knob-cap`, `--shadow-knob`, `--knob-ring`, `--knob-track`, `--knob-send` | ручки (в окнах плагинов, панорама, Rack) |
| `--fader-cap`, `--shadow-fader` | белый бегунок |
| `--grad-step`, `--grad-step-b`, `--grad-step-on`, `--step-on-glow` | шаги Channel Rack (группы по 4; включённый — изумрудный со свечением) |
| `--fx-autotune` … `--fx-clipper` | цвет полоски у карточки эффекта в цепочке (по типу эффекта) |
| `--clip-1` … `--clip-6` | цвета треков и клипов: 1 — изумрудный (вокал), 5 — янтарный (бит), 3 — фиолетовый и т. д. |
| `--radius`, `--radius-s`, `--radius-pill`, `--sheet-radius` | скругления |
| `--topbar-h`, `--track-h`, `--track-head-w`, `--ruler-h`, `--drawer-h`, `--gutter` | размеры шапки, трека, колонки заголовков, линейки, нижней панели, поля |
| `--tap`, `--tap-step`, `--step-inset`, `--rack-pad-x`, `--mtabs-h` | зоны нажатия и размеры на телефоне |

## Раскладка

```
#topbar  .tb-left (бренд, проект, ↶ ↷) · .tb-info (BPM, 4/4, KEY) · .transport (⏮ ● ▶ ⟳ таймер) · .tb-right (мастер, метроном, библиотека, Сохранить, Экспорт)
#hint    строка подсказок (под рабочей областью)
#workspace
  #browser   библиотека слева (эффекты, аудио), показывается кнопкой #wbBrowser
  .studio
    #playlist   панель инструментов + заголовки треков (#plHeads) + линейка (#ruler, в ней #loopRegion) + дорожки (#lanes)
    #drawer     нижняя панель трека: вкладки Эффекты / Бит / Запись (data-pane на #drawer), выбор канала #drChannel, свернуть #drClose
#windows   слой модальных окон плагинов (класс .open — есть открытое окно)
#mtabs     бар режимов телефона: Треки / Эффекты / Бит / Запись (data-view)
```

## Имена, на которые опирается код

Если переименовать их в HTML или CSS, кнопки перестанут работать.

**id в index.html:** `app`, `topbar`, `btnProject`, `projName`, `projMenu`, `projNameInput`, `mSave`, `mOpen`, `mNew`, `mExport`,
`btnUndo`, `btnRedo`, `projOpenInput`, `bpm`, `sigChip`, `projKey`, `btnRewind`, `btnRec`, `btnPlay`, `btnLoop`, `lcdTime`,
`masterVol`, `masterMeter`, `btnMetro`, `wbBrowser`, `btnSave`, `btnExport`, `workspace`, `browser`, `brPlugins`, `brAudio`, `fileImport`,
`playlist`, `addTrack`, `splitBtn`, `dupBtn`, `delBtn`, `btnPattern`, `zoomOut`, `zoomIn`, `plHeads`, `plScroll`, `plContent`, `ruler`,
`lanes`, `loopRegion`, `playhead`, `drawer`, `drChannel`, `drClose`, `paneFx`, `paneBeat`, `paneRec`, `recBig`, `recTrack`, `micMeter`,
`btnMonitor`, `latencyMs`, `audioInfo`, `hint`, `windows`, `mtabs`.

**Атрибуты-переключатели:** `data-pane` у `#drawer` и у кнопок `.dr-tab` (fx / beat / rec) — какая вкладка нижней панели открыта;
`data-view` у `#app` и у кнопок в `#mtabs` (tracks / fx / beat / rec) — режим на телефоне.
Иконки Play/Pause — два `<svg>` в `#btnPlay` с классами `.i-play` и `.i-pause`.

**Классы, которые создаёт ui.js** (их можно стилизовать как угодно):

- верхняя панель: `.tbtn`, `.tbtn.icon`, `.tbtn.play.playing` (идёт воспроизведение), `.tbtn.rec.active` (идёт запись), `#btnLoop.on`, `.tbtn.on` (метроном, библиотека), `.chip`, `.chip-unit`, `.timer`, `.master`, `.master-col`
- ползунок: `.hslider` (input range; CSS-переменная `--p` 0..1 = положение), `.hslider.send` (посыл), `.hslider.center` (панорама)
- заголовок трека: `.head`, `.head.selected`, `.head.muted` (цвет трека — переменная `--c`), `.h-top`, `.h-num`, `.h-ico`, `.h-grip` (иконка = ручка переноса трека),
  `.head.dragging` (трек тянут), `.head.drop-before` / `.head.drop-after` (куда встанет), `.h-name`, `.h-more`, `.rename` (поле переименования),
  `.h-mid`, `.fx-badge`, `.fx-badge.on`, `.h-btns`, `.h-bot`, `.h-meter` (canvas уровня), `.pan-knob`
- строка бита: `.head.pattern-head`, `.pattern-lane`, `.pattern-block`
- таймлайн: `.lane`, `.lane.drop`, `.lane-empty`, `.clip`, `.clip.selected`, `.c-name`, `.trim.l`, `.trim.r`, `.fade.fi`, `.fade.fo`,
  линейка `.ruler span.bar` / `span.tick`, `.ruler.scrub` (идёт перетаскивание курсора), цикл `.loop-region` (скрыт атрибутом hidden, когда цикл выключен),
  `.loop-region.on`, ручки краёв `.lh.l`, `.lh.r`; `#playlist.looping`
- кнопки-квадраты: `.sq`, `.sq.on`, `.sq.solo`, `.sq.arm` (точка — `<i>`); светодиоды `.led`, `.led.off`
- нижняя панель: `.drawer.collapsed`, `.dr-head`, `.dr-tabs`, `.dr-tab`, `.dr-tab.on`, `.dr-ch`, `.dr-ch-label`, `.dr-body`, `.dr-pane`
- эффекты трека: `.fxp-ch`, `.fxp-name`, `.fxp-sub`, `.fxp-row`, `.fxp-db`, `.fxp-meter`, `.fxp-chain`, `.fxp-title`, `.fxp-hint`, `.fxp-note`,
  карточки `.fx-cards`, `.fx-card`, `.fx-card.bypass`, `.fx-card.add` (цвет полоски — `--fxc`), `.fx-pow`, `.fx-pow.on`, `.fx-open`, `.fx-num`, `.fx-name`, `.fx-sub`, `.fx-rm`
- посылы и маршрут: `.fxp-sends`, `.route-row`, `.route-row.on`, `.rr-led`, `.send-row`, `.send-row.ret`, `.sr-name` (кнопка: имя + `.sr-gear`, открывает эффект канала), `.sr-db`, `.sr-rm`, `.send-add`
- тост: `.toast`, `.toast.show` (короткое уведомление снизу по центру, например об автокее)
- запись: `.rec-pane`, `.rec-main`, `.rec-big`, `.rec-big.active`, `.rec-info`, `.rec-field`, `.rec-settings`
- Channel Rack: `.rack`, `.rack-row`, `.r-name`, `.steps`, `.step`, `.step.b`, `.step.on`, `.step.now`
- Channel Rack на телефоне: `.m-rack`, `.m-rack-row`, `.m-rack-row.muted`, `.m-rack-head`, `.m-led`, `.r-title`, `.r-meta`, `.m-steps`
  (шаг — прозрачная зона нажатия, видимый квадрат рисуется в `.step::before`)
- шторка (настройки трека и канала Rack; на компьютере — диалог по центру, на телефоне — снизу): `.sheet-back`, `.sheet`, `.sheet-head`, `.sheet-grip`,
  `.sheet-title`, `.sheet-sub`, `.sheet-acts`, `.sheet-acts.three`, `.sheet-btn`, `.sheet-btn.primary`, `.sheet-btn.danger`, `.sheet-btn.tog`,
  `.sheet-ctl`, `.sheet-row`, `.sheet-val`, `.sheet-name`, `.swatches`, `.swatch`, `.swatch.on`
- окна плагинов (модальные): `.windows-layer.open`, `.win` (атрибут `data-win` = `plug-<канал>-<слот>`), `.win-title`, `.w-name`, `.w-sub`, `.w-close`, `.win-body`
- плагины: `.plug`, `.plug-row`, `.plug-sec`, `.ps-title`, `.plug-field`, `.seg`, `.plug-foot`, `.plug-frame-box`, `.plug-frame`
- автотюн: `.at-display`, `.at-note`, `.at-note.idle`, `.at-bar`, `.at-cap`, `.at-knobs`, опорная частота `.at-ref`, `.at-ref-box`, `.at-unit`, `.at-cents`
- EQ: `.eq-graph`, `.eq-bands`, `.eq-band`, `.eq-band.sel`, `.eq-band.out`, `.eq-band-head` (цвет полосы — переменная `--band`)
- Soft Clipper: `.clip-top`, `.clip-graph`, `.clip-meter`, `.gr-label`, `.gr-bar`, `.gr-val`
- ручка: `.knob`, `.knob.small`, `.knob-dial` (CSS-переменная `--p` от 0 до 1 = положение), `.knob-label`, `.knob-val`
- меню и окна: `.menu-wrap`, `.menu`, `.menu-field`, `.menu-item`, `.menu-note`, `.modal-back`, `.modal`, `.m-btns`, `.hintbar.restore`, `.hint-actions`
- библиотека: `.br-list li .dot`, `.dot.audio`, `.br-list li.empty`

## Переменные, которые читает JavaScript

Эти переменные можно менять, но не удалять:

- `--beat-px` — стартовый масштаб таймлайна (зум меняет его на элементе `#playlist`).
- `--meter-lo`, `--meter-mid`, `--meter-hi` — цвета индикаторов уровня (рисуются на canvas).
- `--clip-1` … `--clip-6` — цвета треков и клипов.
- `--fx-<тип эффекта>` — цвет карточки эффекта (`autotune`, `vocalchain`, `shkafx`, `eq`, `reverb`, `delay`, `chorus`, `clipper`).
- `--accent`, `--text`, `--text-faint`, `--bg-inset`, `--font-mono` — графики EQ и клиппера.
- `--eq-grid`, `--eq-fill`, `--eq-band-1` … `--eq-band-7` — сетка, заливка и точки полос EQ.

## Телефон

Ниже 820 px студия переходит в мобильный режим (см. `@media (max-width: 820px)` в `app.css` и `theme.css`):
внизу лаконичный бар режимов `#mtabs` (Треки / Эффекты / Бит / Запись; активная кнопка — `.on`), один режим на экране.
В шапке первым идёт транспорт, остальное прокручивается вбок. Заголовки треков компактные: имя, Fx, M/S/●;
громкость, панорама, цвет и канал — в шторке трека (тап по имени или ⋯). Окна плагинов — на весь экран.
Channel Rack — сетка 8×2 без прокрутки вбок; размеры задают `--tap-step` (зона нажатия шага, 44 px),
`--step-inset` (отступ видимого квадрата) и `--rack-pad-x` (поля по бокам). Условие: `8 × --tap-step + 2 × --rack-pad-x ≤ 360 px`.
Любые изменения проверяй на ширине 360 и 390 px.
