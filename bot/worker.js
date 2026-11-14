// Бот «Финансы» для Cloudflare Workers (бесплатно, без сервера).
//
// Переменные в Cloudflare (Settings → Variables and Secrets):
//   BOT_TOKEN  — токен от @BotFather (тип Secret!)
//   WEBAPP_URL — адрес мини-аппа, например https://matrash37-eng.github.io/Fin/
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

// ---------- Подключение к Telegram ----------
async function setup(url, env, secret) {
  const hook = `${url.origin}/webhook`;
  const steps = [];
  const run = async (name, method, params) => {
    const r = await tg(env, method, params);
    steps.push(`${r.ok ? '✅' : '❌'} ${name}${r.ok ? '' : ': ' + r.description}`);
    return r.ok;
  };
  const okHook = await run('Вебхук', 'setWebhook', {url: hook, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true});
  await run('Кнопка меню', 'setChatMenuButton', {menu_button: {type: 'web_app', text: 'Финансы', web_app: {url: env.WEBAPP_URL}}});
  await run('Команды', 'setMyCommands', {commands: [
    {command: 'start', description: 'Открыть финансы'},
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
