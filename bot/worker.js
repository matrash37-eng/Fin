// Бот «Финансы» для Cloudflare Workers (бесплатно, без сервера).
//
// Переменные в Cloudflare (Settings → Variables and Secrets):
//   BOT_TOKEN  — токен от @BotFather (тип Secret!)
//   WEBAPP_URL — адрес мини-аппа, например https://matrash37-eng.github.io/Fin/
//   FIN_KV     — привязка Workers KV (Bindings → KV namespace): там хранится сводка для /level
//
// После публикации один раз откройте в браузере  https://<ваш-воркер>.workers.dev/setup
// — бот подключится к Telegram сам.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN || !env.WEBAPP_URL) {
      return text('Не заданы переменные BOT_TOKEN и WEBAPP_URL. Добавьте их в Settings → Variables and Secrets.', 500);
    }
    const secret = await webhookSecret(env.BOT_TOKEN);

    if (url.pathname === '/setup') return setup(url, env, secret);
    if (url.pathname === '/sync') return sync(request, env);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      // принимаем только запросы от Telegram
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return text('forbidden', 403);
      const update = await request.json();
      ctx.waitUntil(handle(update, env).catch(e => console.error(e)));
      return text('ok');
    }
    return text('Бот «Финансы» работает ✅');
  }
};

// ---------- Ответы ----------
const T = {
  start: (name) =>
`Привет${name ? ', ' + name : ''}! 👋

Я помогаю вести учёт денег: сколько заработал, сколько потратил и куда ушли деньги.

В приложении можно:
• записывать доходы и расходы
• загружать выписку Сбера в PDF — операции сами разложатся по категориям
• ставить лимиты на категории и видеть советы

Нажмите кнопку ниже, чтобы открыть.`,

  help:
`Что умеет приложение «Финансы»:

💰 Баланс месяца, доходы и расходы
📊 Траты по категориям и динамика за 6–12 месяцев
🎯 Лимиты на категории — предупредит, если подходите к пределу
💡 Советы по вашим тратам
👥 Доходы по клиентам
🔎 Поиск по операциям
📄 Импорт выписки Сбера из PDF

Команда /level покажет уровень месяца, сколько осталось до следующего и диаграмму доходов.
Команда /stats покажет, сколько вы заработали и потратили, диаграмму за 6 месяцев и главные траты.

Все данные хранятся в вашем аккаунте Telegram и видны только вам.`,

  statement:
`Как загрузить выписку Сбера:

1. В СберОнлайн откройте карту → «Выписки и справки» → выписка по счёту карты, выберите период.
2. Нажмите «Поделиться» → «Сохранить в Файлы».
3. Откройте приложение → «Загрузить выписку» → выберите файл.

Повторная загрузка не создаёт дублей, так что выписки за пересекающиеся периоды можно загружать спокойно.`,

  pdf:
`Вижу выписку 📄 Загрузить её нужно в самом приложении — так данные останутся только у вас.

Если файл пришёл в Telegram: нажмите на него → «Поделиться» → «Сохранить в Файлы». Потом откройте приложение → «Загрузить выписку» → выберите файл.`,

  quickAdd: (amount, what) =>
`Записать ${what ? `«${what}» ` : ''}на ${amount} ₽ можно в приложении: «Добавить» → сумма → категория. Это займёт пару секунд 👇`,

  thanks: 'Пожалуйста! Хорошего дня 🙂',
  hello: 'Привет! Чем помочь? Можно открыть приложение или посмотреть, как загрузить выписку.',
  media: 'Я понимаю только текст и PDF-выписки. Чем помочь?',
  fallback: 'Не совсем понял 🙂 Вот что я могу:',
};

const KB = (env, extra = []) => ({
  inline_keyboard: [
    [{text: '💰 Открыть финансы', web_app: {url: env.WEBAPP_URL}}],
    ...extra,
  ]
});
const MENU = [
  [{text: '📄 Как загрузить выписку', callback_data: 'statement'}],
  [{text: '❓ Что умеет приложение', callback_data: 'help'}],
];

async function handle(update, env) {
  if (update.widget_query) return onWidgetQuery(update.widget_query, env);
  // нажатия на кнопки под сообщениями
  if (update.callback_query) {
    const q = update.callback_query;
    await tg(env, 'answerCallbackQuery', {callback_query_id: q.id});
    const chat = q.message.chat.id;
    if (q.data === 'statement') return send(env, chat, T.statement, KB(env));
    if (q.data === 'help') return send(env, chat, T.help, KB(env, [MENU[0]]));
    return;
  }

  const m = update.message;
  if (!m || m.chat.type !== 'private') return;
  const chat = m.chat.id;
  const raw = (m.text || m.caption || '').trim();
  const t = raw.toLowerCase().replace(/ё/g, 'е');

  if (m.document) {
    const isPdf = m.document.mime_type === 'application/pdf' || /\.pdf$/i.test(m.document.file_name || '');
    return send(env, chat, isPdf ? T.pdf : T.media, KB(env, isPdf ? [] : MENU));
  }
  if (!m.text) return send(env, chat, T.media, KB(env, MENU));

  if (t.startsWith('/level') || /^(уровень|level|мой уровень|прогресс)/.test(t)) return sendLevel(env, chat, m.from.id);
  if (t.startsWith('/stats') || /^(статистика|итоги|сколько (я )?(потратил|заработал)|траты|расходы|доходы|stats)/.test(t)) return sendStats(env, chat, m.from.id);
  if (t.startsWith('/start')) return send(env, chat, T.start(m.from && m.from.first_name), KB(env, MENU));
  if (t.startsWith('/help') || /что (ты )?умеешь|помощ|помоги|как пользоват/.test(t)) return send(env, chat, T.help, KB(env, [MENU[0]]));
  if (/выписк|сбер|pdf|пдф|импорт|загруз/.test(t)) return send(env, chat, T.statement, KB(env));
  if (/^(спасибо|спс|благодарю|thanks|thx)/.test(t)) return send(env, chat, T.thanks);
  if ((/^(привет\S*|здравств\S*|хай|hi|hello|ку|салют)(?=[\s!,.?)]|$)/.test(t) || /^добр(ый|ое|ого)\s/.test(t))) return send(env, chat, T.hello, KB(env, MENU));

  // «кофе 250», «250 такси», «+5000 зарплата»
  const num = t.match(/(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:р|руб|₽)?/);
  if (num) {
    const amount = num[1].replace(/\s/g, '').replace('.', ',');
    const what = raw.replace(num[0], '').replace(/^[+\-−\s]+|\s+$/g, '').slice(0, 40);
    return send(env, chat, T.quickAdd(amount, what), KB(env));
  }

  return send(env, chat, T.fallback, KB(env, MENU));
}

// ---------- Уровень месяца: виджет в сообщении ----------
const LEVELS = [[60000, 'Бронза'], [80000, 'Серебро'], [100000, 'Золото']];
const rub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';

async function getSummary(env, userId) {
  if (!env.FIN_KV) return null;
  return env.FIN_KV.get('u:' + userId);
}

async function sendLevel(env, chat, userId) {
  const raw = await getSummary(env, userId);
  if (!raw) return send(env, chat, 'Пока не вижу ваших данных. Откройте приложение один раз — и команда /level заработает.', KB(env));
  const r = await tg(env, 'sendWidget', {chat_id: chat, html: WIDGET_HTML, chat_data: raw, allow_queries: true, height: 0, width: 0,
    reply_markup: {inline_keyboard: [[{text: '💰 Открыть финансы', web_app: {url: env.WEBAPP_URL}}]]}});
  if (r.ok) return r;
  // запасной вариант для старых версий Telegram: текстом
  const s = JSON.parse(raw), i = s.i;
  const next = LEVELS.find(l => i < l[0]);
  const cur = [...LEVELS].reverse().find(l => i >= l[0]);
  const filled = Math.round(Math.min(1, i / 100000) * 10);
  return send(env, chat,
`Уровень месяца (${s.m}): ${cur ? cur[1] : 'Старт'}
${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}
Пришло ${rub(i)}. ${next ? `До уровня «${next[1]}» ещё ${rub(next[0] - i)}` : 'Максимальный уровень!'}`, KB(env));
}

async function sendStats(env, chat, userId) {
  const raw = await getSummary(env, userId);
  const s = raw ? JSON.parse(raw) : null;
  if (!s) return send(env, chat, 'Пока не вижу ваших данных. Откройте приложение один раз, и команда /stats заработает.', KB(env));
  if (s.e == null) return send(env, chat, 'У вас открыта старая версия приложения, она не присылает расходы. Полностью закройте приложение (свайпом вниз или кнопкой «Закрыть»), откройте его снова и через пару секунд повторите /stats.', KB(env));
  const r = await tg(env, 'sendWidget', {chat_id: chat, html: STATS_HTML, chat_data: raw, allow_queries: true, height: 0, width: 0,
    reply_markup: {inline_keyboard: [[{text: '💰 Открыть финансы', web_app: {url: env.WEBAPP_URL}}]]}});
  if (r.ok) return r;
  const b = s.i - s.e;
  return send(env, chat,
`Итоги месяца (${s.m})
Заработал: ${rub(s.i)}
Потратил: ${rub(s.e)}
${b >= 0 ? 'Осталось' : 'Ушли в минус на'}: ${rub(Math.abs(b))}
${(s.c || []).length ? '\nКуда ушли деньги:\n' + s.c.map(c => `• ${c[0]} — ${rub(c[1])}`).join('\n') : ''}`, KB(env));
}

async function onWidgetQuery(q, env) {
  const raw = await getSummary(env, q.from.id);
  if (raw && q.data === 'refresh' && q.chat && q.message_id) {
    await tg(env, 'editMessageWidgetData', {chat_id: q.chat.id, message_id: q.message_id, chat_data: raw});
  }
  return tg(env, 'answerWidgetQuery', {widget_query_id: q.id});
}

// приложение присылает короткую сводку; проверяем подпись Telegram (initData)
async function sync(request, env) {
  const origin = new URL(env.WEBAPP_URL).origin;
  const cors = {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
  if (request.method === 'OPTIONS') return new Response(null, {headers: cors});
  if (request.method !== 'POST') return new Response('method', {status: 405, headers: cors});
  if (!env.FIN_KV) return new Response('no kv', {status: 500, headers: cors});
  let body;
  try { body = await request.json(); } catch (e) { return new Response('bad json', {status: 400, headers: cors}); }
  const user = await checkInitData(body.initData || '', env.BOT_TOKEN);
  if (!user) return new Response('forbidden', {status: 403, headers: cors});
  const s = body.summary || {};
  // старые версии приложения не присылают расходы: тогда e = null, а не 0
  const clean = JSON.stringify({m: String(s.m || '').slice(0, 20), i: +s.i || 0, e: s.e == null ? null : +s.e || 0,
    mo: (Array.isArray(s.mo) ? s.mo : []).slice(-6).map(x => [String(x[0]).slice(0, 4), +x[1] || 0, +x[2] || 0]),
    c: (Array.isArray(s.c) ? s.c : []).slice(0, 5).map(x => [String(x[0]).slice(0, 18), +x[1] || 0])});
  if (clean.length > 1000) return new Response('too large', {status: 413, headers: cors});
  const key = 'u:' + user.id;
  if ((await env.FIN_KV.get(key)) !== clean) await env.FIN_KV.put(key, clean);
  return new Response('ok', {headers: cors});
}

async function checkInitData(initData, token) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const hmac = async (key, data) => {
    const k = await crypto.subtle.importKey('raw', key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  };
  const secret = await hmac(enc.encode('WebAppData'), token);
  const sig = [...await hmac(secret, check)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 86400 * 7) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

// ---------- Подключение к Telegram ----------
async function setup(url, env, secret) {
  const hook = `${url.origin}/webhook`;
  const steps = [];
  const run = async (name, method, params) => {
    const r = await tg(env, method, params);
    steps.push(`${r.ok ? '✅' : '❌'} ${name}${r.ok ? '' : ': ' + r.description}`);
    return r.ok;
  };
  const okHook = await run('Вебхук', 'setWebhook', {url: hook, secret_token: secret, allowed_updates: ['message', 'callback_query', 'widget_query'], drop_pending_updates: true});
  await run('Кнопка меню', 'setChatMenuButton', {menu_button: {type: 'web_app', text: 'Финансы', web_app: {url: env.WEBAPP_URL}}});
  await run('Команды', 'setMyCommands', {commands: [
    {command: 'start', description: 'Открыть финансы'},
    {command: 'level', description: 'Уровень месяца и диаграмма'},
    {command: 'stats', description: 'Сколько заработал и потратил'},
    {command: 'help', description: 'Что умеет приложение'},
  ]});
  const me = await tg(env, 'getMe', {});
  return text(`${steps.join('\n')}\n\n${okHook && me.ok ? `Готово! Напишите боту @${me.result.username} что-нибудь.` : 'Что-то не получилось. Проверьте BOT_TOKEN: он должен выглядеть как 123456789:AAF…'}`);
}

async function send(env, chat_id, textMsg, reply_markup) {
  return tg(env, 'sendMessage', {chat_id, text: textMsg, ...(reply_markup ? {reply_markup} : {}), link_preview_options: {is_disabled: true}});
}

async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(params),
  });
  return r.json();
}

// секрет вебхука выводится из токена, чтобы не заводить лишнюю переменную
async function webhookSecret(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('webhook:' + token));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

const text = (s, status = 200) => new Response(s, {status, headers: {'Content-Type': 'text/plain; charset=utf-8'}});

// HTML виджетов (исходники: bot/widget.html и bot/stats.html)
const WIDGET_HTML = "<style>\n:root{color-scheme:light dark;--a:var(--tg-theme-button-color,#9d7bff);--t:var(--tg-theme-text-color,#eee);--h:var(--tg-theme-hint-color,#999);--s:var(--tg-theme-section-separator-color,rgba(128,128,128,.25))}\nbody{margin:0;font:14px/1.35 system-ui,sans-serif;color:var(--t)}\n.w{padding:12px 12px calc(10px + env(safe-area-inset-bottom))}\n.r{display:flex;justify-content:space-between;align-items:center}\n.h{color:var(--h);font-size:12px}\n.n{display:flex;align-items:center;gap:10px;margin:8px 0 12px;font-size:22px;font-weight:600}\n.m{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;color:#3a2a08}\n.b0{background:#555;color:#ccc}.b1{background:radial-gradient(circle at 35% 30%,#f4c39a,#c27a45 60%,#8e5126)}.b2{background:radial-gradient(circle at 35% 30%,#fff,#c4cad3 55%,#8a929e)}.b3{background:radial-gradient(circle at 35% 30%,#fff1b8,#f2c14e 55%,#b9821b)}\n.tr{position:relative;height:6px;border-radius:3px;background:var(--s);margin:10px 8px 6px}\n.f{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:3px;background:linear-gradient(90deg,#e9a93b,#f7d774);transition:width 1.2s cubic-bezier(.2,.8,.2,1)}\n.d{position:absolute;top:50%;width:12px;height:12px;margin:-6px;border-radius:50%;background:var(--s);transition:background .3s .9s}\n.d.on{background:#f2c14e}\n.lb{position:relative;height:14px;font-size:11px;color:var(--h);margin:0 8px 10px}.lb span{position:absolute;transform:translateX(-50%)}\n.x{margin:0 0 12px}.x b{font-weight:600}\n.c{display:flex;align-items:flex-end;gap:6px;height:90px;position:relative;border-bottom:1px solid var(--s)}\n.c i{flex:1;border-radius:4px 4px 0 0;background:var(--a);opacity:.45;transform-origin:bottom;animation:g .9s cubic-bezier(.2,.8,.2,1) both}\n.c i.cur{opacity:1}\n.c u{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--s);font-size:9px;color:var(--h);text-decoration:none;z-index:1}.c u s{position:relative;top:-12px;text-decoration:none}\n@keyframes g{from{transform:scaleY(0)}}\n.ml{display:flex;gap:6px;font-size:10px;color:var(--h);margin-top:4px}.ml span{flex:1;text-align:center}\nbutton{margin-top:10px;width:100%;padding:8px;border:0;border-radius:10px;background:var(--a);color:var(--tg-theme-button-text-color,#fff);font:inherit;font-weight:600}\n@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}\n</style>\n<div class=\"w\" id=\"w\"></div>\n<script>\nconst W=window.TelegramWidget,L=[[0,'Старт'],[6e4,'Бронза'],[8e4,'Серебро'],[1e5,'Золото']],R=n=>Math.round(n).toLocaleString('ru-RU')+'\\u00a0₽',K=n=>n>=1e3?Math.round(n/1e3)+'к':n,$=document.getElementById('w');\nfunction draw(){let s=null;try{s=JSON.parse(W&&W.chatData)}catch(e){}\nif(!s){$.innerHTML='<div class=\"h\">Нет данных. Откройте приложение, и бот увидит ваши операции.</div>';return}\nconst i=s.i,lv=L.reduce((a,l,k)=>i>=l[0]?k:a,0),nx=L[lv+1],p=Math.min(100,i/1e5*100),mx=Math.max(1e5,...s.mo.map(x=>x[1]))*1.05;\n$.innerHTML=`<div class=\"r h\"><span>Уровень месяца, ${s.m}</span><span>${lv} из 3</span></div><div class=\"n\"><span class=\"m b${lv}\">${lv?K(L[lv][0]):'0'}</span>${L[lv][1]}</div><div class=\"tr\"><div class=\"f\" id=\"f\"></div>${L.map((l,k)=>`<span class=\"d${i>=l[0]?' on':''}\" style=\"left:${l[0]/1e3}%\"></span>`).join('')}</div><div class=\"lb\">${L.map(l=>`<span style=\"left:${l[0]/1e3}%\">${K(l[0])}</span>`).join('')}</div><div class=\"x\">Пришло <b>${R(i)}</b>. ${nx?`До уровня «${nx[1]}» ещё <b>${R(nx[0]-i)}</b>`:'Максимальный уровень!'}</div><div class=\"c\">${[6e4,8e4,1e5].map(t=>`<u style=\"bottom:${t/mx*100}%\"><s>${K(t)}</s></u>`).join('')}${s.mo.map((x,k)=>`<i class=\"${k==s.mo.length-1?'cur':''}\" style=\"height:${x[1]/mx*100}%;animation-delay:${k*.06}s\"></i>`).join('')}</div><div class=\"ml\">${s.mo.map(x=>`<span>${x[0]}</span>`).join('')}</div><button id=\"u\">Обновить</button>`;\nrequestAnimationFrame(()=>requestAnimationFrame(()=>{document.getElementById('f').style.width=p+'%'}));\ndocument.getElementById('u').onclick=e=>{const b=e.target;b.textContent='Обновляю…';W.request('refresh').then(()=>{W.HapticFeedback.notificationOccurred('success')},()=>{b.textContent='Обновить'})};\nif(lv&&W.HapticFeedback)W.HapticFeedback.impactOccurred('light')}\nif(W){W.onEvent('chatDataChanged',draw);W.ready()}draw();\n</script>\n";
const STATS_HTML = "<style>\n:root{color-scheme:light dark;--t:var(--tg-theme-text-color,#eee);--h:var(--tg-theme-hint-color,#999);--s:var(--tg-theme-section-separator-color,rgba(128,128,128,.25));--in:#26a08a;--ex:#e06a55}\nbody{margin:0;font:14px/1.35 system-ui,sans-serif;color:var(--t)}\n.w{padding:12px 12px calc(10px + env(safe-area-inset-bottom))}\n.h{color:var(--h);font-size:12px}\n.p{display:flex;gap:10px;margin:8px 0 4px}.p div{flex:1}\n.p b{display:block;font-size:19px;font-weight:600;margin-top:2px;white-space:nowrap}\n.k{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}\n.bl{margin:6px 0 12px}.bl b{font-weight:600}\n.rb{display:flex;gap:3px;height:8px;margin-bottom:14px}.rb i{border-radius:3px;transition:flex-grow 1s cubic-bezier(.2,.8,.2,1)}\n.c{display:flex;align-items:flex-end;gap:8px;height:96px;border-bottom:1px solid var(--s)}\n.g{flex:1;display:flex;align-items:flex-end;justify-content:center;gap:2px;height:100%}\n.g i{flex:1;max-width:14px;border-radius:4px 4px 0 0;transform-origin:bottom;animation:u .9s cubic-bezier(.2,.8,.2,1) both}\n@keyframes u{from{transform:scaleY(0)}}\n.ml{display:flex;gap:8px;font-size:10px;color:var(--h);margin:4px 0 14px}.ml span{flex:1;text-align:center}\n.ml .on{color:var(--t);font-weight:600}\n.lg{display:flex;gap:12px;font-size:11px;color:var(--h);margin-bottom:8px}\n.ct{display:grid;grid-template-columns:8px 1fr auto;gap:4px 8px;align-items:center;margin-bottom:6px;font-size:13px}\n.ct .d{width:8px;height:8px;border-radius:50%}.ct .tk{grid-column:2/-1;height:4px;border-radius:2px;background:var(--s);overflow:hidden}.ct .tk i{display:block;height:100%;border-radius:2px}\nbutton{margin-top:8px;width:100%;padding:8px;border:0;border-radius:10px;background:var(--tg-theme-button-color,#8774e1);color:var(--tg-theme-button-text-color,#fff);font:inherit;font-weight:600}\n@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}\n</style>\n<div class=\"w\" id=\"w\"></div>\n<script>\nconst W=window.TelegramWidget,R=n=>Math.round(n).toLocaleString('ru-RU')+' ₽',C=['#a98bff','#7fb2f0','#e6c590','#d68fd6','#8fd4b4'],$=document.getElementById('w');\nfunction draw(){let s=null;try{s=JSON.parse(W&&W.chatData)}catch(e){}\nif(!s||s.e==null){$.innerHTML='<div class=\"h\">Нет данных. Откройте приложение, и бот увидит ваши операции.</div>';return}\nconst i=s.i,e=s.e,b=i-e,mo=s.mo,mx=Math.max(1,...mo.flatMap(x=>[x[1],x[2]||0])),ct=s.c||[],cm=ct.length?ct[0][1]:1;\n$.innerHTML=`<div class=\"h\">Итоги месяца, ${s.m}</div><div class=\"p\"><div class=\"h\"><span class=\"k\" style=\"background:var(--in)\"></span>Заработал<b style=\"color:var(--t)\">${R(i)}</b></div><div class=\"h\"><span class=\"k\" style=\"background:var(--ex)\"></span>Потратил<b style=\"color:var(--t)\">${R(e)}</b></div></div><div class=\"bl\">${b>=0?'Осталось':'Ушли в минус на'} <b>${R(Math.abs(b))}</b>${i>0?`, это ${Math.round(Math.abs(b)/i*100)}% дохода`:''}</div><div class=\"rb\"><i id=\"ri\" style=\"background:var(--in);flex-grow:1\"></i><i id=\"re\" style=\"background:var(--ex);flex-grow:1\"></i></div><div class=\"lg\"><span><span class=\"k\" style=\"background:var(--in)\"></span>Доходы</span><span><span class=\"k\" style=\"background:var(--ex)\"></span>Расходы</span></div><div class=\"c\">${mo.map((x,k)=>`<div class=\"g\"><i style=\"background:var(--in);height:${x[1]/mx*100}%;animation-delay:${k*.05}s\"></i><i style=\"background:var(--ex);height:${(x[2]||0)/mx*100}%;animation-delay:${k*.05+.03}s\"></i></div>`).join('')}</div><div class=\"ml\">${mo.map((x,k)=>`<span class=\"${k==mo.length-1?'on':''}\">${x[0]}</span>`).join('')}</div>${ct.length?'<div class=\"h\" style=\"margin-bottom:8px\">Куда ушли деньги</div>'+ct.map((c,k)=>`<div class=\"ct\"><span class=\"d\" style=\"background:${C[k]}\"></span><span>${c[0]}</span><b>${R(c[1])}</b><span class=\"tk\"><i style=\"width:${c[1]/cm*100}%;background:${C[k]}\"></i></span></div>`).join(''):''}<button id=\"u\">Обновить</button>`;\nrequestAnimationFrame(()=>requestAnimationFrame(()=>{document.getElementById('ri').style.flexGrow=i||1;document.getElementById('re').style.flexGrow=e||1}));\ndocument.getElementById('u').onclick=ev=>{const t=ev.target;t.textContent='Обновляю…';W.request('refresh').then(()=>W.HapticFeedback.notificationOccurred('success'),()=>{t.textContent='Обновить'})}}\nif(W){W.onEvent('chatDataChanged',draw);W.ready()}draw();\n</script>\n";
