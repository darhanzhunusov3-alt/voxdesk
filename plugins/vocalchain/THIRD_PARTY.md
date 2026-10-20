# Сторонний код

| Компонент | Откуда | Лицензия | Как используется |
|---|---|---|---|
| JUCE 8.0.9 | https://github.com/juce-framework/JUCE | AGPLv3 / коммерческая | каркас плагина, VST3, WebView; скачивается при сборке |
| RNNoise | Xiph.org, Jean-Marc Valin; копия из https://github.com/werman/noise-suppression-for-voice | BSD 3-Clause | нейросеть шумоподавления; скачивается при сборке |
| Airwindows Channel9 | https://github.com/airwindows/airwindows | MIT, (c) airwindows | окраска SSL-модуля, `source/dsp/airwindows/Channel9.h` |
| Airwindows Air3 | https://github.com/airwindows/airwindows | MIT, (c) airwindows | High Air, `source/dsp/airwindows/Air3.h` |
| Audio EQ Cookbook | Robert Bristow-Johnson | общеизвестные формулы | расчёт биквадратных фильтров |

Текст лицензии MIT для Airwindows:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
> and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions: The above copyright notice and this permission notice shall be
> included in all copies or substantial portions of the Software.
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

Названия Waves, FabFilter, Slate Digital, SSL и UREI/1176 упоминаются только для описания,
какой плагин заменяет каждый модуль. Код этих компаний не использовался.

Хорус, PanMan, Delay, LowPass и Карусель написаны с нуля; UJAM Finisher Micro, Soundtoys PanMan и EchoBoy,
Fruity Love Philter и Valhalla Supermassive упоминаются только как образцы звука, их код не использовался.
