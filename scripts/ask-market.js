#!/usr/bin/env node
/* Запрос к MarketLLM (OpenAI-совместимый /chat/completions) без ограничений по именам моделей.
   node scripts/ask-market.js --prompt "текст" [--model gpt-6.1-sol | gpt-6-astra | gpt-6-luna | gpt-5.6-terra | …]
   Ключ — см. scripts/market-lib.js. */
const { fail, parseArgs, postJSON } = require('./market-lib');

(async () => {
  const { model, prompt } = parseArgs(process.argv.slice(2), { model: 'gpt-6.1-sol', prompt: '' });
  if (!prompt) fail('Нужен --prompt "текст запроса"', 2);
  const data = await postJSON('/chat/completions', { model, messages: [{ role: 'user', content: prompt }] });
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (content == null) fail('В ответе нет choices[0].message.content: ' + JSON.stringify(data).slice(0, 500));
  process.stdout.write(content + '\n');
})();
