#!/usr/bin/env node
/* Генерация картинки через MarketLLM (OpenAI-совместимый /images/generations) и сохранение в файл.
   node scripts/generate-image.js --prompt "описание" --out assets/img/knob.png
     [--model gpt-image-2.5-flare | gpt-image-2.5-sunburst] [--size 1024x1024]
   Ответ может прийти ссылкой (data[0].url) или base64 (data[0].b64_json) — сохраняются оба варианта.
   Ключ — см. scripts/market-lib.js. */
const fs = require('fs');
const path = require('path');
const { fail, parseArgs, postJSON } = require('./market-lib');

(async () => {
  const o = parseArgs(process.argv.slice(2), { prompt: '', model: 'gpt-image-2.5-flare', out: '', size: '1024x1024' });
  if (!o.prompt) fail('Нужен --prompt "описание картинки"', 2);
  if (!o.out) fail('Нужен --out путь/к/файлу.png', 2);
  if (!/^\d+x\d+$/.test(o.size)) fail('--size в виде ШИРИНАxВЫСОТА, например 1024x1024', 2);

  const data = await postJSON('/images/generations', { model: o.model, prompt: o.prompt, size: o.size, n: 1 });
  const item = data.data && data.data[0];
  if (!item || (!item.b64_json && !item.url)) fail('В ответе нет data[0].url или data[0].b64_json: ' + JSON.stringify(data).slice(0, 500));

  let bytes;
  if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
  else {
    let res;
    try { res = await fetch(item.url); } catch (e) { fail('Не удалось скачать картинку: ' + e.message); }
    if (!res.ok) fail('Не удалось скачать картинку: HTTP ' + res.status);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (!bytes.length) fail('Пустая картинка в ответе');

  const out = path.resolve(o.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(out + ' (' + Math.round(bytes.length / 1024) + ' КБ, ' + o.model + ', ' + o.size + ')');
  if (item.revised_prompt) console.log('Уточнённый запрос: ' + item.revised_prompt);
})();
