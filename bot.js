// ════════════════════════════════════════════════════════════════════
//  ANKETA.FORUM — Telegram Bot
//  Запуск: node bot.js (отдельно от server.js)
//  Или оба сразу через npm start (если настроен concurrently)
// ════════════════════════════════════════════════════════════════════
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Database    = require('better-sqlite3');
const path        = require('path');
const fs          = require('fs');

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL     = process.env.SITE_URL || 'http://localhost:3000';
const DB_PATH      = process.env.DB_PATH  || path.join(__dirname, 'db.sqlite');
const OWNER_TG_ID  = process.env.OWNER_TELEGRAM_ID || null; // Telegram ID главного админа

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан в .env');
  process.exit(1);
}

// ── DB ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Таблица привязки Telegram → пользователь сайта
db.exec(`
CREATE TABLE IF NOT EXISTS tg_links (
  tg_id       INTEGER PRIMARY KEY,
  tg_username TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  linked_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id      INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  sent       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tgn_tgid ON tg_notifications(tg_id, sent);
`);

// Миграция — добавляем tg_link_code в users
try { db.prepare('ALTER TABLE users ADD COLUMN tg_link_code TEXT DEFAULT NULL').run(); } catch {}
try { db.prepare('ALTER TABLE users ADD COLUMN tg_id INTEGER DEFAULT NULL').run(); } catch {}

// ── HELPERS ───────────────────────────────────────────────────────
function getLinkedUser(tgId) {
  const link = db.prepare('SELECT user_id FROM tg_links WHERE tg_id=?').get(tgId);
  if (!link) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(link.user_id);
}

function getSetting(k, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  if (!r) return def;
  try { return JSON.parse(r.value); } catch { return def; }
}

function safeJSON(s, def) { try { return JSON.parse(s); } catch { return def; } }

const ROLE_LABELS = { owner:'👑 Глав.Админ', admin:'🔴 Админ', moderator:'🟡 Модератор', user:'👤 Юзер' };

function escape(text) {
  return String(text||'').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ── BOT INIT ──────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('✓ Telegram бот запущен');

// Состояния пользователей (многошаговые диалоги)
const userState = new Map();
// { tgId: { step, data } }

function setState(tgId, state) { userState.set(tgId, state); }
function getState(tgId) { return userState.get(tgId) || null; }
function clearState(tgId) { userState.delete(tgId); }

// ── ГЛАВНОЕ МЕНЮ ──────────────────────────────────────────────────
function mainMenu(tgId) {
  const user = getLinkedUser(tgId);
  const linked = !!user;
  const SITE = process.env.SITE_URL || 'http://localhost:3000';
  const keyboard = {
    keyboard: [
      ['📋 Создать анкету', '💬 Создать тему'],
      ['👤 Мой профиль',    '🔔 Мои анкеты'],
      linked
        ? ['⚙ Настройки',   '🔓 Отвязать аккаунт']
        : ['🔗 Привязать аккаунт', '📊 Статистика'],
      ['📊 Статистика', '🌐 Открыть сайт'],
    ],
    resize_keyboard: true
  };
  return keyboard;
}

// Inline кнопка для открытия мини-аппа
function appButton() {
  const SITE = process.env.SITE_URL || 'http://localhost:3000';
  return {
    inline_keyboard: [[
      { text: '🚀 Открыть ANKETA.FORUM', web_app: { url: `${SITE}/app.html` } }
    ]]
  };
}

// ── /start ────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const tgId = msg.chat.id;
  const param = (match[1] || '').trim();
  clearState(tgId);

  // Если пришёл с deep link /start link_XXXX — автопривязка
  if (param.startsWith('link_')) {
    const code = param.replace('link_', '');
    const user = db.prepare('SELECT * FROM users WHERE tg_link_code=?').get(code);
    if (user) {
      db.prepare('DELETE FROM tg_links WHERE user_id=?').run(user.id);
      db.prepare('INSERT OR REPLACE INTO tg_links(tg_id,tg_username,user_id,linked_at) VALUES(?,?,?,?)')
        .run(tgId, msg.from.username||'', user.id, Date.now());
      db.prepare('UPDATE users SET tg_link_code=NULL, tg_id=? WHERE id=?').run(tgId, user.id);
      await bot.sendMessage(tgId,
        `✅ Аккаунт *${escape(user.display_name)}* успешно привязан\\!\n\nТеперь ты можешь создавать анкеты и получать уведомления прямо в Telegram\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: mainMenu(tgId) }
      );
      // Уведомить OWNER
      notifyOwner(`🔗 Пользователь *${escape(user.display_name)}* \\(@${escape(msg.from.username)}\\) привязал Telegram`);
      return;
    }
  }

  const user = getLinkedUser(tgId);
  const greeting = user
    ? `👋 С возвращением, *${escape(user.display_name)}*\\!\n\nЧто хочешь сделать?`
    : `👋 Привет\\! Я бот сайта *ANKETA\\.FORUM*\\.\n\nЗдесь ты можешь:\n• 📋 Создавать анкеты\n• 💬 Писать в форум\n• 🔔 Получать уведомления\n\nДля полного доступа привяжи свой аккаунт с сайта\\.`;

  await bot.sendMessage(tgId, greeting, {
    parse_mode: 'MarkdownV2',
    reply_markup: mainMenu(tgId)
  });

  // Отправляем кнопку мини-аппа отдельным сообщением
  await bot.sendMessage(tgId, '👇 Или открой полный сайт прямо здесь:', {
    reply_markup: appButton()
  });
});

// ── /app — открыть мини-апп ───────────────────────────────────────
bot.onText(/\/app|🚀 Открыть приложение/, async (msg) => {
  const tgId = msg.chat.id;
  await bot.sendMessage(tgId, '🚀 *ANKETA\\.FORUM Mini App*\n\nНажми кнопку ниже чтобы открыть сайт прямо в Telegram:', {
    parse_mode: 'MarkdownV2',
    reply_markup: appButton()
  });
});

// ── /link — привязка через код ────────────────────────────────────
bot.onText(/\/link (.+)/, async (msg, match) => {
  const tgId = msg.chat.id;
  const code = match[1].trim();
  const user = db.prepare('SELECT * FROM users WHERE tg_link_code=?').get(code);
  if (!user) {
    return bot.sendMessage(tgId, '❌ Код неверный или устарел\\. Получи новый на сайте в настройках профиля\\.', { parse_mode:'MarkdownV2' });
  }
  db.prepare('DELETE FROM tg_links WHERE user_id=?').run(user.id);
  db.prepare('INSERT OR REPLACE INTO tg_links(tg_id,tg_username,user_id,linked_at) VALUES(?,?,?,?)')
    .run(tgId, msg.from.username||'', user.id, Date.now());
  db.prepare('UPDATE users SET tg_link_code=NULL, tg_id=? WHERE id=?').run(tgId, user.id);
  await bot.sendMessage(tgId,
    `✅ Аккаунт *${escape(user.display_name)}* привязан\\!`,
    { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) }
  );
});

// ── /stats ────────────────────────────────────────────────────────
bot.onText(/\/stats|📊 Статистика/, async (msg) => {
  const tgId = msg.chat.id;
  const users    = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const profiles = db.prepare('SELECT COUNT(*) c FROM profiles WHERE hidden=0').get().c;
  const topics   = db.prepare('SELECT COUNT(*) c FROM topics WHERE hidden=0').get().c;
  const posts    = db.prepare('SELECT COUNT(*) c FROM posts').get().c;
  const siteName = getSetting('siteName', 'ANKETA.FORUM');
  await bot.sendMessage(tgId,
    `📊 *Статистика ${escape(siteName)}*\n\n` +
    `👥 Пользователей: *${users}*\n` +
    `📋 Анкет: *${profiles}*\n` +
    `💬 Тем: *${topics}*\n` +
    `✉️ Сообщений: *${posts}*\n\n` +
    `🌐 [Открыть сайт](${escape(SITE_URL)})`,
    { parse_mode:'MarkdownV2' }
  );
});

// ── МОЙ ПРОФИЛЬ ──────────────────────────────────────────────────
bot.onText(/👤 Мой профиль/, async (msg) => {
  const tgId = msg.chat.id;
  const user = getLinkedUser(tgId);
  if (!user) return sendNotLinked(tgId);
  const profiles = db.prepare('SELECT COUNT(*) c FROM profiles WHERE owner_id=?').get(user.id).c;
  const posts    = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(user.id).c;
  const comments = db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id=?').get(user.id).c;
  await bot.sendMessage(tgId,
    `👤 *${escape(user.display_name)}*\n` +
    `@${escape(user.username)} · ${ROLE_LABELS[user.role]||user.role}\n\n` +
    `📋 Анкет: *${profiles}*\n` +
    `✉️ Постов: *${posts}*\n` +
    `💬 Комментов: *${comments}*\n\n` +
    `🌐 [Профиль на сайте](${escape(SITE_URL)})`,
    { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) }
  );
});

// ── МОИ АНКЕТЫ ───────────────────────────────────────────────────
bot.onText(/🔔 Мои анкеты/, async (msg) => {
  const tgId = msg.chat.id;
  const user = getLinkedUser(tgId);
  if (!user) return sendNotLinked(tgId);
  const list = db.prepare('SELECT * FROM profiles WHERE owner_id=? ORDER BY created_at DESC LIMIT 10').all(user.id);
  if (!list.length) return bot.sendMessage(tgId, '📋 У тебя пока нет анкет\\.\n\nНажми *📋 Создать анкету* чтобы добавить\\.', { parse_mode:'MarkdownV2' });

  const keyboard = {
    inline_keyboard: list.map(p => [{
      text: `${p.emoji||'👤'} ${p.name}${p.pinned?' 📌':''}${p.hidden?' 🙈':''}`,
      callback_data: `profile_${p.id}`
    }])
  };
  await bot.sendMessage(tgId, `📋 *Твои анкеты* \\(${list.length}\\):`, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard
  });
});

// Callback — просмотр анкеты
bot.on('callback_query', async (query) => {
  const tgId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data.startsWith('profile_')) {
    const id = +data.replace('profile_', '');
    const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
    if (!p) return bot.sendMessage(tgId, '❌ Анкета не найдена');
    const comments = db.prepare('SELECT COUNT(*) c FROM comments WHERE profile_id=?').get(id).c;
    const keyboard = {
      inline_keyboard: [[
        { text: '🗑 Удалить', callback_data: `del_profile_${id}` },
        { text: '🌐 На сайте', url: `${SITE_URL}` }
      ]]
    };
    await bot.sendMessage(tgId,
      `${p.emoji||'👤'} *${escape(p.name)}*\n` +
      `${p.age ? `Возраст: ${p.age}\n` : ''}` +
      `${p.bio ? `\n${escape(p.bio)}\n` : ''}` +
      `\n💬 Комментариев: *${comments}*` +
      `${p.hidden ? '\n🙈 Скрыта' : ''}${p.pinned ? '\n📌 Закреплена' : ''}`,
      { parse_mode:'MarkdownV2', reply_markup: keyboard }
    );
  }

  if (data.startsWith('del_profile_')) {
    const id = +data.replace('del_profile_', '');
    const user = getLinkedUser(tgId);
    const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
    if (!p) return bot.sendMessage(tgId, '❌ Не найдено');
    if (p.owner_id !== user?.id) return bot.sendMessage(tgId, '❌ Это не твоя анкета');
    const keyboard = { inline_keyboard: [[
      { text: '✅ Да, удалить', callback_data: `confirm_del_${id}` },
      { text: '❌ Отмена', callback_data: 'cancel' }
    ]]};
    await bot.sendMessage(tgId, `⚠️ Удалить анкету *${escape(p.name)}*?`, { parse_mode:'MarkdownV2', reply_markup: keyboard });
  }

  if (data.startsWith('confirm_del_')) {
    const id = +data.replace('confirm_del_', '');
    const user = getLinkedUser(tgId);
    const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
    if (!p || p.owner_id !== user?.id) return bot.sendMessage(tgId, '❌ Ошибка');
    db.prepare('DELETE FROM profiles WHERE id=?').run(id);
    await bot.sendMessage(tgId, `✅ Анкета *${escape(p.name)}* удалена\\.`, { parse_mode:'MarkdownV2' });
  }

  if (data === 'cancel') {
    await bot.sendMessage(tgId, '❌ Отменено', { reply_markup: mainMenu(tgId) });
  }

  if (data.startsWith('topic_')) {
    const id = +data.replace('topic_', '');
    const t = db.prepare('SELECT * FROM topics WHERE id=?').get(id);
    if (!t) return bot.sendMessage(tgId, '❌ Тема не найдена');
    const cnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(id).c;
    const keyboard = { inline_keyboard: [[{ text: '🌐 Открыть на сайте', url: SITE_URL }]] };
    await bot.sendMessage(tgId,
      `💬 *${escape(t.title)}*\n@${escape(t.author)}\n\n${escape(t.body.slice(0,300))}${t.body.length>300?'\\.\\.\\.'  :''}\n\n✉️ Ответов: *${cnt}*`,
      { parse_mode:'MarkdownV2', reply_markup: keyboard }
    );
  }
});

// ── СОЗДАТЬ АНКЕТУ (многошаговый диалог) ──────────────────────────
bot.onText(/📋 Создать анкету/, async (msg) => {
  const tgId = msg.chat.id;
  const user = getLinkedUser(tgId);
  if (!user) return sendNotLinked(tgId);
  setState(tgId, { step:'profile_name', data:{} });
  await bot.sendMessage(tgId, '📋 *Создание анкеты*\n\n*Шаг 1/4*: Напиши своё имя', {
    parse_mode:'MarkdownV2',
    reply_markup: { keyboard:[['❌ Отмена']], resize_keyboard:true }
  });
});

// ── СОЗДАТЬ ТЕМУ (многошаговый диалог) ────────────────────────────
bot.onText(/💬 Создать тему/, async (msg) => {
  const tgId = msg.chat.id;
  const user = getLinkedUser(tgId);
  if (!user) return sendNotLinked(tgId);
  setState(tgId, { step:'topic_title', data:{} });
  await bot.sendMessage(tgId, '💬 *Создание темы на форуме*\n\n*Шаг 1/2*: Напиши заголовок темы', {
    parse_mode:'MarkdownV2',
    reply_markup: { keyboard:[['❌ Отмена']], resize_keyboard:true }
  });
});

// ── ПРИВЯЗАТЬ АККАУНТ ─────────────────────────────────────────────
bot.onText(/🔗 Привязать аккаунт/, async (msg) => {
  const tgId = msg.chat.id;
  if (getLinkedUser(tgId)) {
    return bot.sendMessage(tgId, '✅ Аккаунт уже привязан\\. Используй *👤 Мой профиль* для просмотра\\.', { parse_mode:'MarkdownV2' });
  }
  await bot.sendMessage(tgId,
    `🔗 *Привязка аккаунта*\n\n` +
    `1\\. Зайди на сайт: [${escape(SITE_URL)}](${escape(SITE_URL)})\n` +
    `2\\. Войди в аккаунт → Настройки профиля\n` +
    `3\\. Нажми кнопку *"Привязать Telegram"*\n` +
    `4\\. Получи код и отправь его сюда командой:\n\`/link КОД\``,
    { parse_mode:'MarkdownV2' }
  );
});

// ── ОТВЯЗАТЬ ──────────────────────────────────────────────────────
bot.onText(/🔓 Отвязать аккаунт/, async (msg) => {
  const tgId = msg.chat.id;
  const user = getLinkedUser(tgId);
  if (!user) return sendNotLinked(tgId);
  db.prepare('DELETE FROM tg_links WHERE tg_id=?').run(tgId);
  db.prepare('UPDATE users SET tg_id=NULL WHERE id=?').run(user.id);
  await bot.sendMessage(tgId, '🔓 Аккаунт отвязан\\.', { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) });
});

// ── ОТКРЫТЬ САЙТ ─────────────────────────────────────────────────
bot.onText(/🌐 Открыть сайт/, async (msg) => {
  const tgId = msg.chat.id;
  await bot.sendMessage(tgId, `🌐 [${escape(SITE_URL)}](${escape(SITE_URL)})`, {
    parse_mode:'MarkdownV2'
  });
});

// ── ОТМЕНА ────────────────────────────────────────────────────────
bot.onText(/❌ Отмена/, async (msg) => {
  const tgId = msg.chat.id;
  clearState(tgId);
  await bot.sendMessage(tgId, '❌ Отменено\\.', { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) });
});

// ── ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ (диалоги) ──────────────────────
bot.on('message', async (msg) => {
  const tgId  = msg.chat.id;
  const text  = msg.text || '';
  const state = getState(tgId);
  if (!state) return;
  if (text === '❌ Отмена') return; // уже обработано выше

  const user = getLinkedUser(tgId);

  // ── СОЗДАНИЕ АНКЕТЫ ──────────────────────────────
  if (state.step === 'profile_name') {
    if (!text.trim()) return bot.sendMessage(tgId, '⚠️ Имя не может быть пустым');
    state.data.name = text.trim().slice(0, 50);
    state.step = 'profile_age';
    setState(tgId, state);
    return bot.sendMessage(tgId,
      `*Шаг 2/4*: Укажи возраст \\(или напиши *"нет"* чтобы пропустить\\)`,
      { parse_mode:'MarkdownV2' }
    );
  }

  if (state.step === 'profile_age') {
    const age = parseInt(text);
    state.data.age = (age > 0 && age < 120) ? age : null;
    state.step = 'profile_bio';
    setState(tgId, state);
    return bot.sendMessage(tgId, `*Шаг 3/4*: Напиши о себе \\(до 2000 символов\\)`, { parse_mode:'MarkdownV2' });
  }

  if (state.step === 'profile_bio') {
    state.data.bio = text.trim().slice(0, 2000);
    state.step = 'profile_tags';
    setState(tgId, state);
    return bot.sendMessage(tgId,
      `*Шаг 4/4*: Напиши теги через запятую\n_Пример: музыка, кино, спорт_\n\nИли напиши *"нет"* чтобы пропустить`,
      { parse_mode:'MarkdownV2' }
    );
  }

  if (state.step === 'profile_tags') {
    const tags = text.toLowerCase() === 'нет' ? [] : text.split(',').map(s=>s.trim()).filter(Boolean).slice(0,10);
    state.data.tags = tags;
    clearState(tgId);

    // Создаём анкету в БД
    const now = Date.now();
    const info = db.prepare(`INSERT INTO profiles(owner_id,name,age,emoji,color,bio,tags,created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(user.id, state.data.name, state.data.age||null, '👤', '#e8632a',
           state.data.bio||'', JSON.stringify(tags), now);

    await bot.sendMessage(tgId,
      `✅ *Анкета создана\\!*\n\n` +
      `👤 *${escape(state.data.name)}*\n` +
      `${state.data.age ? `Возраст: ${state.data.age}\n` : ''}` +
      `${state.data.bio ? `\n${escape(state.data.bio.slice(0,200))}\n` : ''}` +
      `\n🌐 [Смотреть на сайте](${escape(SITE_URL)})`,
      { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) }
    );
    // Уведомить владельца
    notifyOwner(`📋 Новая анкета от *${escape(user.display_name)}*: *${escape(state.data.name)}*`);
    return;
  }

  // ── СОЗДАНИЕ ТЕМЫ ─────────────────────────────────
  if (state.step === 'topic_title') {
    if (!text.trim()) return bot.sendMessage(tgId, '⚠️ Заголовок не может быть пустым');
    state.data.title = text.trim().slice(0, 120);
    state.step = 'topic_body';
    setState(tgId, state);
    return bot.sendMessage(tgId, `*Шаг 2/2*: Напиши текст темы`, { parse_mode:'MarkdownV2' });
  }

  if (state.step === 'topic_body') {
    if (!text.trim()) return bot.sendMessage(tgId, '⚠️ Текст не может быть пустым');
    state.data.body = text.trim().slice(0, 5000);
    clearState(tgId);

    const now = Date.now();
    db.prepare(`INSERT INTO topics(user_id,author,title,body,created_at) VALUES(?,?,?,?,?)`)
      .run(user.id, user.display_name, state.data.title, state.data.body, now);

    await bot.sendMessage(tgId,
      `✅ *Тема опубликована\\!*\n\n💬 *${escape(state.data.title)}*\n\n🌐 [Смотреть на сайте](${escape(SITE_URL)})`,
      { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) }
    );
    notifyOwner(`💬 Новая тема от *${escape(user.display_name)}*: *${escape(state.data.title)}*`);
    return;
  }
});

// ── УВЕДОМЛЕНИЯ ──────────────────────────────────────────────────
function notifyOwner(text) {
  if (!OWNER_TG_ID) return;
  bot.sendMessage(OWNER_TG_ID, text, { parse_mode:'MarkdownV2' }).catch(()=>{});
}

// Экспортируем функцию для отправки уведомлений — используется из server.js
function sendNotification(tgId, text) {
  return bot.sendMessage(tgId, text, { parse_mode:'MarkdownV2' }).catch(()=>{});
}

function sendNotLinked(tgId) {
  return bot.sendMessage(tgId,
    '🔗 Сначала привяжи аккаунт с сайта\\.\n\nНажми *🔗 Привязать аккаунт*',
    { parse_mode:'MarkdownV2', reply_markup: mainMenu(tgId) }
  );
}

// ── ЭКСПОРТ ДЛЯ server.js ────────────────────────────────────────
module.exports = { sendNotification, notifyOwner, db, getLinkedUser };
