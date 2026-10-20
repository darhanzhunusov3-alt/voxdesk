# Сторонний код

| Компонент | Откуда | Лицензия | Как используется |
|---|---|---|---|
| JUCE 8.0.9 | https://github.com/juce-framework/JUCE | AGPLv3 / коммерческая | каркас плагина, VST3, WebView; скачивается при сборке |
| Шрифт Inter (Rasmus Andersson) | https://rsms.me/inter | SIL Open Font License 1.1 (текст — `ui/fonts/OFL-Inter.txt`) | шрифт интерфейса и заставки, вшит в плагин (подмножества: латиница + кириллица; для заставки — `resources/*.ttf`) |
| Monocypher 4.0.3 (Loup Vaillant и др.) | https://monocypher.org | CC0 / BSD-2-Clause (текст — `third_party/monocypher/LICENCE.md`) | подпись и проверка ключей Ed25519 |
| Audio EQ Cookbook | Robert Bristow-Johnson | общеизвестные формулы | фильтры в ревербе и delay |

Реверб (FDN-сеть с диффузией и модуляцией), delay и автопанорама написаны с нуля, чужой код не использовался.
