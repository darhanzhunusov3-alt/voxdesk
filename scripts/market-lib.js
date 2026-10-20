/* Общее для scripts/ask-market.js и scripts/generate-image.js: ключ, разбор флагов, POST-запрос к MarketLLM.
   Ключ: переменная MARKETLLM_API_KEY или файл scripts/.market-key (он в .gitignore — в репозиторий не попадает). */
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.marketllmapi.ru/v1';

function fail(msg, code) { console.error(msg); process.exit(code == null ? 1 : code); }

// --name value или --name=value; defaults задаёт и список допустимых флагов
function parseArgs(argv, defaults) {
  const o = Object.assign({}, defaults);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], eq = a.indexOf('=');
    const key = a.startsWith('--') ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    if (key == null || !(key in defaults)) fail('Неизвестный аргумент: ' + a + '. Можно: ' + Object.keys(defaults).map((k) => '--' + k).join(', '), 2);
    o[key] = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (o[key] == null) fail('Нет значения для --' + key, 2);
  }
  return o;
}

function apiKey() {
  if (process.env.MARKETLLM_API_KEY) return process.env.MARKETLLM_API_KEY.trim();
  try { return fs.readFileSync(path.join(__dirname, '.market-key'), 'utf8').trim(); } catch (e) { return ''; }
}

// POST JSON на BASE + route; возвращает разобранный ответ или завершает процесс с понятной ошибкой
async function postJSON(route, body) {
  const key = apiKey();
  if (!key) fail('Нет ключа: задай MARKETLLM_API_KEY или положи ключ в scripts/.market-key', 2);
  let res;
  try {
    res = await fetch(BASE + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body)
    });
  } catch (e) { fail('Сеть: ' + e.message); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (!res.ok) fail('HTTP ' + res.status + ': ' + (data && data.error ? (data.error.message || JSON.stringify(data.error)) : text.slice(0, 500)));
  if (!data) fail('Ответ не JSON: ' + text.slice(0, 500));
  return data;
}

module.exports = { BASE, fail, parseArgs, postJSON };
