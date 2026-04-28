require('dotenv').config();
const path         = require('path');
const fs           = require('fs');
const http         = require('http');
const express      = require('express');
const { Server: SocketServer } = require('socket.io');
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer       = require('multer');

// ── CONFIG ─────────────────────────────────────────────────────────
const PORT           = process.env.PORT          || 3000;
const JWT_SECRET     = process.env.JWT_SECRET    || 'dev_only_change_me';
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'glom').toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD  || 'glom123';
const DB_PATH        = process.env.DB_PATH         || path.join(__dirname, 'db.sqlite');
const UPLOADS_DIR    = process.env.UPLOADS_DIR     || path.join(__dirname, 'public', 'uploads');
const SITE_URL       = process.env.SITE_URL        || 'http://localhost:3000';

if (JWT_SECRET === 'dev_only_change_me')
  console.warn('⚠  JWT_SECRET не задан — небезопасный дефолт');

// ── TELEGRAM (необязательно) ────────────────────────────────────────
let tgBot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  try   { tgBot = require('./bot'); console.log('✓ Telegram бот'); }
  catch (e) { console.warn('Telegram бот не загружен:', e.message); }
}
const tgEsc = s => String(s||'').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
function tgNotify(userId, text) {
  if (!tgBot) return;
  try { const l = db.prepare('SELECT tg_id FROM tg_links WHERE user_id=?').get(userId); if (l?.tg_id) tgBot.sendNotification(l.tg_id, text); } catch {}
}
function tgNotifyOwner(text) { if (tgBot) try { tgBot.notifyOwner(text); } catch {} }

// ── UPLOAD DIRS ─────────────────────────────────────────────────────
const DIRS = {
  avatars:  path.join(UPLOADS_DIR, 'avatars'),
  profiles: path.join(UPLOADS_DIR, 'profiles'),
  comments: path.join(UPLOADS_DIR, 'comments'),
  posts:    path.join(UPLOADS_DIR, 'posts'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// ── DATABASE ────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── AUTO BACKUP ─────────────────────────────────────────────────────
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
function makeBackup() {
  const name = `backup_${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`;
  db.backup(path.join(BACKUP_DIR, name))
    .then(() => {
      console.log('✓ Бекап создан:', name);
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite')).sort();
      if (files.length > 5) files.slice(0, files.length - 5).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      });
    })
    .catch(e => console.error('Бекап ошибка:', e));
}
makeBackup();
setInterval(makeBackup, 6 * 60 * 60 * 1000);
db.pragma('foreign_keys = ON');

// ── SAFE DB BACKUP BEFORE MIGRATIONS ───────────────────────────────
// Перед любыми CREATE/ALTER TABLE делаем копию текущей SQLite БД.
function backupDatabaseBeforeMigrations() {
  if (process.env.AUTO_DB_BACKUP === '0') return;
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const backupDir = path.join(path.dirname(DB_PATH), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(DB_PATH);
    const dst = path.join(backupDir, `.before-migration-`);
    fs.copyFileSync(DB_PATH, dst);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = DB_PATH + suffix;
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, dst + suffix);
    }
    console.log('✓ DB backup created before migrations:', dst);
  } catch (e) {
    console.warn('DB backup before migrations failed:', e.message);
  }
}
backupDatabaseBeforeMigrations();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  emoji         TEXT    DEFAULT '👤',
  avatar        TEXT    DEFAULT NULL,
  banner        TEXT    DEFAULT NULL,
  accent        TEXT    DEFAULT NULL,
  status        TEXT    DEFAULT NULL,
  location      TEXT    DEFAULT NULL,
  socials       TEXT    DEFAULT '{}',
  bio           TEXT    DEFAULT '',
  anon_mode     INTEGER NOT NULL DEFAULT 0,
  banned        INTEGER NOT NULL DEFAULT 0,
  tg_link_code  TEXT    DEFAULT NULL,
  tg_id         INTEGER DEFAULT NULL,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL,
  age        INTEGER,
  emoji      TEXT    DEFAULT '👤',
  color      TEXT    DEFAULT '#e8632a',
  bio        TEXT    DEFAULT '',
  tags       TEXT    DEFAULT '[]',
  avatar     TEXT    DEFAULT NULL,
  photos     TEXT    DEFAULT '[]',
  anon       INTEGER NOT NULL DEFAULT 0,
  show_in_profile INTEGER NOT NULL DEFAULT 1,
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author       TEXT    NOT NULL,
  text         TEXT    NOT NULL DEFAULT '',
  image        TEXT    DEFAULT NULL,
  user_avatar  TEXT    DEFAULT NULL,
  user_emoji   TEXT    DEFAULT NULL,
  is_anon_mode INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author     TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author       TEXT    NOT NULL,
  text         TEXT    NOT NULL DEFAULT '',
  image        TEXT    DEFAULT NULL,
  user_avatar  TEXT    DEFAULT NULL,
  user_emoji   TEXT    DEFAULT NULL,
  is_anon_mode INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings  (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER,
  actor_name   TEXT,
  real_name    TEXT,
  is_anon_mode INTEGER NOT NULL DEFAULT 0,
  action       TEXT    NOT NULL,
  target       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tg_links (
  tg_id       INTEGER PRIMARY KEY,
  tg_username TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  linked_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_friends_from   ON friends(from_id, status);
CREATE INDEX IF NOT EXISTS idx_friends_to     ON friends(to_id, status);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);

CREATE INDEX IF NOT EXISTS idx_profiles_created ON profiles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topics_created   ON topics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_topic      ON posts(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_profile ON comments(profile_id, created_at);
`);

// ── MIGRATIONS (для существующих БД) ───────────────────────────────
function addCol(t, c, d) { try { db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`).run(); } catch {} }
addCol('users', 'avatar',        'TEXT DEFAULT NULL');
addCol('users', 'banner',        'TEXT DEFAULT NULL');
addCol('users', 'accent',        'TEXT DEFAULT NULL');
addCol('users', 'status',        'TEXT DEFAULT NULL');
addCol('users', 'location',      'TEXT DEFAULT NULL');
addCol('users', 'socials',       "TEXT DEFAULT '{}'");
addCol('users', 'anon_mode',     'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'tg_link_code',  'TEXT DEFAULT NULL');
addCol('users', 'tg_id',         'INTEGER DEFAULT NULL');
addCol('profiles', 'avatar',     'TEXT DEFAULT NULL');
addCol('profiles', 'photos',     "TEXT DEFAULT '[]'");
addCol('profiles', 'anon',       'INTEGER NOT NULL DEFAULT 0');
addCol('profiles', 'show_in_profile', 'INTEGER NOT NULL DEFAULT 1');
addCol('comments', 'image',      'TEXT DEFAULT NULL');
addCol('comments', 'user_avatar','TEXT DEFAULT NULL');
addCol('comments', 'user_emoji', 'TEXT DEFAULT NULL');
addCol('comments', 'is_anon_mode','INTEGER NOT NULL DEFAULT 0');
addCol('posts',    'image',      'TEXT DEFAULT NULL');
addCol('posts',    'user_avatar','TEXT DEFAULT NULL');
addCol('posts',    'user_emoji', 'TEXT DEFAULT NULL');
addCol('posts',    'is_anon_mode','INTEGER NOT NULL DEFAULT 0');
addCol('audit_log','real_name',  'TEXT');
addCol('audit_log','is_anon_mode','INTEGER NOT NULL DEFAULT 0');
addCol('users', 'friends_privacy', "TEXT DEFAULT 'all'"); // all | friends | none
// tg_links может не существовать в старых БД
try { db.exec(`CREATE TABLE IF NOT EXISTS tg_links (tg_id INTEGER PRIMARY KEY, tg_username TEXT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, linked_at INTEGER NOT NULL)`); } catch {}
// friends / blocks — создаём если нет
try { db.exec(`CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(from_id, to_id))`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(blocker_id, blocked_id))`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS dm_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER DEFAULT NULL)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_dm_from ON dm_messages(from_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_dm_to ON dm_messages(to_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_from ON friends(from_id,status)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_to ON friends(to_id,status)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id)`); } catch {}

// ── BOOTSTRAP ───────────────────────────────────────────────────────
(function ensureOwner() {
  const now = Date.now();
  const ex  = db.prepare('SELECT id, role FROM users WHERE username=?').get(OWNER_USERNAME);
  if (!ex) {
    db.prepare(`INSERT INTO users(username,display_name,password_hash,role,emoji,created_at,last_seen)
                VALUES(?,?,?,'owner','👑',?,?)`)
      .run(OWNER_USERNAME, OWNER_USERNAME, bcrypt.hashSync(OWNER_PASSWORD, 10), now, now);
    console.log('✓ Создан главный админ:', OWNER_USERNAME);
  } else if (ex.role !== 'owner') {
    db.prepare('UPDATE users SET role=? WHERE id=?').run('owner', ex.id);
  }
})();

const DEFAULT_SETTINGS = { siteName:'ANKETA.FORUM', welcome:'Анонимные анкеты и форум', accent:'#e8632a' };
const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); if (!r) return d; try { return JSON.parse(r.value); } catch { return d; } };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (getSetting(k, undefined) === undefined) setSetting(k, v);

// ── HELPERS ─────────────────────────────────────────────────────────
const ROLE_RANK = { user:0, moderator:1, admin:2, owner:3 };
const rank = u => ROLE_RANK[u?.role] ?? 0;

// audit — всегда пишет реальное имя; если анон-режим — помечает
function audit(actor, action, target = '') {
  db.prepare(`INSERT INTO audit_log(actor_id,actor_name,real_name,is_anon_mode,action,target,created_at)
              VALUES(?,?,?,?,?,?,?)`)
    .run(
      actor?.id   || null,
      actor?.username || 'system',
      actor?.display_name || actor?.username || 'system',
      (actor?.anon_mode && rank(actor) >= 1) ? 1 : 0,
      action, target, Date.now()
    );
}

// Публичные имя/аватарка/эмодзи с учётом индивидуального anon_mode
function resolveAuthor(u) { return (u.anon_mode && rank(u) >= 1) ? 'Анонимный администратор' : u.display_name; }
function resolveAvatar(u) { return (u.anon_mode && rank(u) >= 1) ? null : (u.avatar || null); }
function resolveEmoji(u)  { return (u.anon_mode && rank(u) >= 1) ? '🛡️' : (u.emoji || '👤'); }

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.display_name, role: u.role,
    emoji: u.emoji, avatar: u.avatar || null, banner: u.banner || null,
    accent: u.accent || null, status: u.status || null, location: u.location || null,
    socials: safeJSON(u.socials, {}), bio: u.bio || '',
    banned: !!u.banned, anonMode: !!u.anon_mode,
    friendsPrivacy: u.friends_privacy || 'all',
    createdAt: u.created_at, lastSeen: u.last_seen,
  };
}

function publicProfile(p) {
  const isAnon = !!p.anon;
  return {
    id: p.id,
    ownerId:       isAnon ? null : p.owner_id,
    _ownerId:      p.owner_id,          // для проверок прав (не отдаётся клиенту напрямую — но нужен при patch)
    authorName:    isAnon ? null : null, // заполняется ниже через JOIN если нужно
    name: p.name, age: p.age, emoji: p.emoji, color: p.color, bio: p.bio,
    tags: safeJSON(p.tags, []), avatar: p.avatar || null, photos: safeJSON(p.photos, []),
    anon: isAnon, showInProfile: !!p.show_in_profile,
    pinned: !!p.pinned, hidden: !!p.hidden, createdAt: p.created_at,
  };
}

function publicTopic(t) {
  return { id:t.id, userId:t.user_id, author:t.author, title:t.title, body:t.body,
           pinned:!!t.pinned, hidden:!!t.hidden, createdAt:t.created_at };
}

// publicComment — скрывает user_id и аватарку для анонимных постов
function publicComment(c) {
  const anon = !!c.is_anon_mode;
  return {
    id: c.id, profileId: c.profile_id,
    userId:     anon ? null : c.user_id,
    author:     c.author,
    text:       c.text, image: c.image || null,
    userAvatar: anon ? null : (c.user_avatar || null),
    userEmoji:  anon ? '🛡️' : (c.user_emoji || '👤'),
    isAnonMode: anon,
    createdAt:  c.created_at,
  };
}

function publicPost(p) {
  const anon = !!p.is_anon_mode;
  return {
    id: p.id, topicId: p.topic_id,
    userId:     anon ? null : p.user_id,
    author:     p.author,
    text:       p.text, image: p.image || null,
    userAvatar: anon ? null : (p.user_avatar || null),
    userEmoji:  anon ? '🛡️' : (p.user_emoji || '👤'),
    isAnonMode: anon,
    createdAt:  p.created_at,
  };
}

function safeJSON(s, d) { try { return JSON.parse(s); } catch { return d; } }
function removeFile(rel) { if (!rel) return; try { fs.unlinkSync(path.join(__dirname, 'public', rel)); } catch {} }

// ── EXPRESS + HTTP + SOCKET.IO ──────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new SocketServer(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());

// ── MULTER ──────────────────────────────────────────────────────────
function makeUpload(subdir, maxMB) {
  return multer({
    storage: multer.diskStorage({
      destination: DIRS[subdir],
      filename:    (_, f, cb) => cb(null, Date.now() + '_' + Math.random().toString(36).slice(2) + (path.extname(f.originalname).toLowerCase() || '.jpg')),
    }),
    limits:     { fileSize: maxMB * 1024 * 1024 },
    fileFilter: (_, f, cb) => { const ok = /^image\/(jpeg|png|gif|webp)$/.test(f.mimetype); cb(ok ? null : new Error('Только jpg/png/gif/webp'), ok); },
  });
}
const uploadAvatar  = makeUpload('avatars',  5);
const uploadBanner  = makeUpload('avatars',  8);
const uploadProfile = makeUpload('profiles', 8);
const uploadComment = makeUpload('comments', 8);
const uploadPost    = makeUpload('posts',    8);

async function tryCompress(fp, maxW) {
  try { const sh = require('sharp'), tmp = fp + '.tmp'; await sh(fp).resize(maxW, maxW, { fit:'inside', withoutEnlargement:true }).jpeg({ quality:82 }).toFile(tmp); fs.renameSync(tmp, fp); } catch {}
}

// ── SOCKET.IO ───────────────────────────────────────────────────────
io.use((socket, next) => {
  try {
    let token = socket.handshake.auth?.token;
    if (!token) { const m = (socket.handshake.headers?.cookie||'').split(';').find(c=>c.trim().startsWith('token=')); if (m) token = m.split('=')[1]; }
    if (token) { const p = jwt.verify(token, JWT_SECRET); const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.uid); if (u && !u.banned) socket.user = u; }
  } catch {}
  next();
});
io.on('connection', socket => {
  socket.on('join:profile',  id => socket.join('profile:' + id));
  socket.on('leave:profile', id => socket.leave('profile:' + id));
  socket.on('join:topic',    id => socket.join('topic:' + id));
  socket.on('leave:topic',   id => socket.leave('topic:' + id));
  // Персональная комната для уведомлений (заявки в друзья и т.д.)
  if (socket.user) socket.join('user:' + socket.user.id);
});

// ── HTTP AUTH ───────────────────────────────────────────────────────
function authMiddleware(req, _res, next) {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) token = req.headers.authorization.slice(7);
  if (token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.uid);
      if (u && !u.banned) { req.user = u; db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), u.id); }
    } catch {}
  }
  next();
}
app.use(authMiddleware);

const requireAuth  = (q,r,n) => q.user         ? n() : r.status(401).json({error:'Нужен вход'});
const requireMod   = (q,r,n) => rank(q.user)>=1 ? n() : r.status(403).json({error:'Нужна роль модератора'});
const requireAdmin = (q,r,n) => rank(q.user)>=2 ? n() : r.status(403).json({error:'Нужна роль админа'});
const requireOwner = (q,r,n) => q.user?.role==='owner' ? n() : r.status(403).json({error:'Только главный админ'});

function issueToken(u, res) {
  const token = jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure: process.env.NODE_ENV==='production', maxAge: 30*24*60*60*1000 });
  return token;
}

// ══════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', (req,res) => {
  const { username, password, displayName } = req.body||{};
  if (!username||!password) return res.status(400).json({error:'Логин и пароль обязательны'});
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:'Логин 3-20 символов: a-z, 0-9, _'});
  if (password.length<6) return res.status(400).json({error:'Пароль минимум 6 символов'});
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username.toLowerCase())) return res.status(409).json({error:'Логин занят'});
  const now  = Date.now();
  const info = db.prepare(`INSERT INTO users(username,display_name,password_hash,role,created_at,last_seen) VALUES(?,?,?,'user',?,?)`)
    .run(username.toLowerCase(), (displayName||username).slice(0,30), bcrypt.hashSync(password,10), now, now);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  const token = issueToken(u, res);
  audit(u, 'register');
  io.emit('stats:update');
  tgNotifyOwner(`👤 Новый пользователь: *${tgEsc(u.display_name)}* \\(@${tgEsc(u.username)}\\)`);
  res.json({ user: publicUser(u), token });
});

app.post('/api/auth/login', (req,res) => {
  const { username, password } = req.body||{};
  if (!username||!password) return res.status(400).json({error:'Логин и пароль обязательны'});
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).toLowerCase());
  if (!u) return res.status(401).json({error:'Неверный логин или пароль'});
  if (u.banned) return res.status(403).json({error:'Аккаунт заблокирован'});
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({error:'Неверный логин или пароль'});
  const token = issueToken(u, res);
  audit(u, 'login');
  res.json({ user: publicUser(u), token });
});

app.post('/api/auth/logout', (req,res) => { res.clearCookie('token'); res.json({ok:true}); });
app.get('/api/auth/me', (req,res) => res.json({ user: req.user ? publicUser(req.user) : null }));

app.post('/api/auth/change-password', requireAuth, (req,res) => {
  const { oldPassword, newPassword } = req.body||{};
  if (!newPassword||newPassword.length<6) return res.status(400).json({error:'Новый пароль минимум 6 символов'});
  if (!bcrypt.compareSync(oldPassword||'', req.user.password_hash)) return res.status(401).json({error:'Старый пароль неверен'});
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword,10), req.user.id);
  audit(req.user, 'change_password');
  res.json({ok:true});
});

app.patch('/api/auth/me', requireAuth, (req,res) => {
  const { displayName, emoji, bio, accent, status, location, socials } = req.body||{};
  db.prepare(`UPDATE users SET
    display_name=COALESCE(?,display_name), emoji=COALESCE(?,emoji), bio=COALESCE(?,bio),
    accent=COALESCE(?,accent), status=COALESCE(?,status), location=COALESCE(?,location),
    socials=COALESCE(?,socials) WHERE id=?`)
    .run(displayName?.slice(0,30)??null, emoji?.slice(0,8)??null, bio?.slice(0,500)??null,
         accent?.slice(0,16)??null, status?.slice(0,60)??null, location?.slice(0,60)??null,
         socials ? JSON.stringify(socials) : null, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

// ── Индивидуальный анон-режим ────────────────────────────────────────
// Доступен любому модератору / админу / owner для СЕБЯ только
app.post('/api/auth/anon-mode', requireMod, (req,res) => {
  const { enabled } = req.body||{};
  db.prepare('UPDATE users SET anon_mode=? WHERE id=?').run(enabled ? 1 : 0, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  // В лог пишем реальное имя — чтобы главный админ видел кто включил анонимность
  audit(req.user, enabled ? 'anon_mode_on' : 'anon_mode_off', `real:${req.user.display_name}`);
  io.emit('user:anon_changed', { userId: req.user.id, anonMode: !!enabled });
  res.json({ user: publicUser(u) });
});

// ── Аватарка / баннер пользователя ──────────────────────────────────
app.post('/api/auth/avatar', requireAuth, (req,res) => {
  uploadAvatar.single('avatar')(req, res, async err => {
    if (err) return res.status(400).json({error:err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/avatars/' + req.file.filename;
    await tryCompress(req.file.path, 400);
    const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
    if (old?.avatar) removeFile(old.avatar);
    db.prepare('UPDATE users SET avatar=? WHERE id=?').run(rel, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  });
});
app.delete('/api/auth/avatar', requireAuth, (req,res) => {
  const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
  if (old?.avatar) removeFile(old.avatar);
  db.prepare('UPDATE users SET avatar=NULL WHERE id=?').run(req.user.id);
  res.json({ok:true});
});
app.post('/api/auth/banner', requireAuth, (req,res) => {
  uploadBanner.single('banner')(req, res, async err => {
    if (err) return res.status(400).json({error:err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/avatars/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    const old = db.prepare('SELECT banner FROM users WHERE id=?').get(req.user.id);
    if (old?.banner) removeFile(old.banner);
    db.prepare('UPDATE users SET banner=? WHERE id=?').run(rel, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  });
});
app.delete('/api/auth/banner', requireAuth, (req,res) => {
  const old = db.prepare('SELECT banner FROM users WHERE id=?').get(req.user.id);
  if (old?.banner) removeFile(old.banner);
  db.prepare('UPDATE users SET banner=NULL WHERE id=?').run(req.user.id);
  res.json({ok:true});
});

// ── Telegram linking ─────────────────────────────────────────────────
app.post('/api/auth/tg-link-code', requireAuth, (req,res) => {
  const code = require('crypto').randomBytes(8).toString('hex');
  db.prepare('UPDATE users SET tg_link_code=? WHERE id=?').run(code, req.user.id);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  res.json({ code, deepLink: botUsername ? `https://t.me/${botUsername}?start=link_${code}` : null });
});
app.get('/api/auth/tg-status', requireAuth, (req,res) => {
  const l = db.prepare('SELECT tg_id, tg_username, linked_at FROM tg_links WHERE user_id=?').get(req.user.id);
  res.json({ linked: !!l, tgUsername: l?.tg_username||null, linkedAt: l?.linked_at||null });
});
app.delete('/api/auth/tg-link', requireAuth, (req,res) => {
  db.prepare('DELETE FROM tg_links WHERE user_id=?').run(req.user.id);
  db.prepare('UPDATE users SET tg_id=NULL, tg_link_code=NULL WHERE id=?').run(req.user.id);
  res.json({ok:true});
});

// ── Telegram Mini App ────────────────────────────────────────────────
app.post('/api/tg/auth', (req,res) => {
  const { initData } = req.body||{};
  if (!initData) return res.status(400).json({error:'нет initData'});
  try {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(503).json({error:'бот не настроен'});
    const crypto = require('crypto');
    const params  = new URLSearchParams(initData), hash = params.get('hash');
    params.delete('hash');
    const check = [...params.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
    const sk    = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    if (crypto.createHmac('sha256',sk).update(check).digest('hex') !== hash) return res.status(403).json({error:'Невалидный initData'});
    const tgUser = JSON.parse(params.get('user')||'{}');
    const l = db.prepare('SELECT user_id FROM tg_links WHERE tg_id=?').get(tgUser.id);
    if (!l) return res.json({ linked:false, tgUser });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(l.user_id);
    if (!u||u.banned) return res.status(403).json({error:'Аккаунт заблокирован'});
    const token = jwt.sign({ uid:u.id }, JWT_SECRET, { expiresIn:'30d' });
    res.cookie('token', token, { httpOnly:true, sameSite:'none', secure:true, maxAge:30*24*60*60*1000 });
    res.json({ linked:true, user:publicUser(u), token });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════════════════
app.get('/api/users', requireMod, (req,res) =>
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(publicUser) }));

app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const pattern = `%${q}%`;
  const users = db.prepare(`SELECT * FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND banned=0 LIMIT 20`).all(pattern, pattern);
  res.json(users.map(publicUser));
});

app.get('/api/users/:id/public', (req,res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.status(404).json({error:'Не найден'});
  const isMod = rank(req.user) >= 1, isOwn = req.user?.id === u.id;
  const profs = db.prepare(`SELECT * FROM profiles WHERE owner_id=? ${isMod?'':'AND hidden=0'} ORDER BY pinned DESC, created_at DESC`).all(u.id)
    .filter(p => {
      // Модер и сам автор видят всё
      if (isMod || isOwn) return true;
      // Обычные пользователи видят только show_in_profile=1 и не анонимные
      return p.show_in_profile && !p.anon;
    });
  const postsCount    = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(u.id).c;
  const commentsCount = db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id=?').get(u.id).c;
  res.json({ user:publicUser(u), profiles:profs.map(publicProfile), postsCount, commentsCount });
});

app.post('/api/users/:id/role', requireAdmin, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!target) return res.status(404).json({error:'Не найден'});
  if (target.role==='owner') return res.status(403).json({error:'Нельзя менять роль главного админа'});
  if (target.id===req.user.id) return res.status(400).json({error:'Нельзя менять роль себе'});
  const { role } = req.body||{};
  if (req.user.role==='owner') { if (!['user','moderator','admin'].includes(role)) return res.status(400).json({error:'Недопустимая роль'}); }
  else { if (!['user','moderator'].includes(role)) return res.status(403).json({error:'Нет прав'}); if (rank(target)>=2) return res.status(403).json({error:'Нельзя понижать другого админа'}); }
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, target.id);
  audit(req.user, 'set_role', `${target.username} -> ${role}`);
  io.emit('user:role_changed', { userId:target.id, role });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id)) });
});

app.post('/api/users/:id/ban', requireMod, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!target) return res.status(404).json({error:'Не найден'});
  if (rank(target)>=rank(req.user)) return res.status(403).json({error:'Нет прав'});
  const { banned } = req.body||{};
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(banned?1:0, target.id);
  audit(req.user, banned?'ban':'unban', target.username);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id)) });
});

app.delete('/api/users/:id', requireOwner, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!target) return res.status(404).json({error:'Не найден'});
  if (target.role==='owner') return res.status(403).json({error:'Нельзя удалить главного админа'});
  if (target.avatar) removeFile(target.avatar);
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  audit(req.user, 'delete_user', target.username);
  io.emit('stats:update');
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════
//  PROFILES
// ══════════════════════════════════════════════════════════════════════
app.get('/api/profiles', (req,res) => {
  const isMod = rank(req.user) >= 1;
  const rows = db.prepare(`
    SELECT p.*, u.display_name as author_display_name, u.avatar as author_avatar, u.emoji as author_emoji
    FROM profiles p
    LEFT JOIN users u ON u.id = p.owner_id
    ${isMod?'':'WHERE p.hidden=0'}
    ORDER BY p.pinned DESC, p.created_at DESC
  `).all();
  res.json({ profiles: rows.map(p => {
    const pub = publicProfile(p);
    // Если анкета не анонимная — добавляем данные автора
    if (!pub.anon && p.owner_id) {
      pub.authorName   = p.author_display_name || null;
      pub.authorAvatar = p.author_avatar || null;
      pub.authorEmoji  = p.author_emoji || '👤';
    }
    return pub;
  }) });
});

app.get('/api/profiles/:id', (req,res) => {
  const row = db.prepare(`
    SELECT p.*, u.display_name as author_display_name, u.avatar as author_avatar, u.emoji as author_emoji
    FROM profiles p LEFT JOIN users u ON u.id = p.owner_id
    WHERE p.id=?`).get(+req.params.id);
  if (!row) return res.status(404).json({error:'Не найдено'});
  if (row.hidden && rank(req.user)<1) return res.status(404).json({error:'Скрыта'});
  const pub = publicProfile(row);
  if (!pub.anon && row.owner_id) {
    pub.authorName   = row.author_display_name || null;
    pub.authorAvatar = row.author_avatar || null;
    pub.authorEmoji  = row.author_emoji || '👤';
  }
  const comments = db.prepare('SELECT * FROM comments WHERE profile_id=? ORDER BY created_at ASC').all(row.id);
  res.json({ profile: pub, comments: comments.map(publicComment) });
});

app.post('/api/profiles', requireAuth, (req,res) => {
  const { name, age, emoji, color, bio, tags, anon, showInProfile } = req.body||{};
  if (!name||!String(name).trim()) return res.status(400).json({error:'Имя обязательно'});
  const info = db.prepare(`INSERT INTO profiles(owner_id,name,age,emoji,color,bio,tags,anon,show_in_profile,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, String(name).slice(0,50), +age||null,
         emoji?.slice(0,8)||'👤', color?.slice(0,16)||'#e8632a',
         (bio||'').slice(0,2000), JSON.stringify(Array.isArray(tags)?tags.slice(0,10):[]),
         anon ? 1 : 0, showInProfile===false ? 0 : 1, Date.now());
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(info.lastInsertRowid);
  io.emit('profile:created', publicProfile(p));
  io.emit('stats:update');
  audit(req.user, 'create_profile', `#${p.id} anon=${p.anon} show_in_profile=${p.show_in_profile}`);
  res.json({ profile: publicProfile(p) });
});

app.patch('/api/profiles/:id', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  const isOwn = p.owner_id === req.user.id, isMod = rank(req.user) >= 1;
  if (!isOwn && !isMod) return res.status(403).json({error:'Нет прав'});
  const { name, age, emoji, color, bio, tags, anon, showInProfile, pinned, hidden } = req.body||{};

  // Логируем изменение статуса анонимности / показа в профиле
  const anonChanged = anon != null && (anon?1:0) !== p.anon;
  const showChanged = showInProfile != null && (showInProfile?1:0) !== p.show_in_profile;
  if (anonChanged || showChanged) {
    const details = [];
    if (anonChanged) details.push(`anon: ${!!p.anon} → ${!!anon}`);
    if (showChanged) details.push(`show_in_profile: ${!!p.show_in_profile} → ${!!showInProfile}`);
    audit(req.user, 'profile_status_changed', `#${p.id} ${p.name} | ${details.join(', ')}`);
  }

  db.prepare(`UPDATE profiles SET
    name=COALESCE(?,name), age=COALESCE(?,age), emoji=COALESCE(?,emoji),
    color=COALESCE(?,color), bio=COALESCE(?,bio), tags=COALESCE(?,tags),
    anon=COALESCE(?,anon), show_in_profile=COALESCE(?,show_in_profile),
    pinned=?, hidden=? WHERE id=?`)
    .run(name?.slice(0,50)??null, age!=null?+age:null, emoji?.slice(0,8)??null,
         color?.slice(0,16)??null, bio!=null?String(bio).slice(0,2000):null,
         Array.isArray(tags)?JSON.stringify(tags.slice(0,10)):null,
         anon!=null?(anon?1:0):null,
         showInProfile!=null?(showInProfile?1:0):null,
         isMod&&pinned!=null?(pinned?1:0):p.pinned,
         isMod&&hidden!=null?(hidden?1:0):p.hidden, p.id);
  const updated = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
  if (isMod && (pinned!=null||hidden!=null)) audit(req.user, 'profile_mod', `#${p.id}`);
  io.emit('profile:updated', publicProfile(updated));
  res.json({ profile: publicProfile(updated) });
});

app.post('/api/profiles/:id/avatar', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  uploadProfile.single('avatar')(req, res, async err => {
    if (err) return res.status(400).json({error:err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/profiles/' + req.file.filename;
    await tryCompress(req.file.path, 600);
    if (p.avatar) removeFile(p.avatar);
    db.prepare('UPDATE profiles SET avatar=? WHERE id=?').run(rel, p.id);
    const up = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
    io.emit('profile:updated', publicProfile(up));
    res.json({ profile: publicProfile(up) });
  });
});

app.post('/api/profiles/:id/photos', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  const photos = safeJSON(p.photos, []);
  if (photos.length >= 10) return res.status(400).json({error:'Максимум 10 фото'});
  uploadProfile.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({error:err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/profiles/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    photos.push(rel);
    db.prepare('UPDATE profiles SET photos=? WHERE id=?').run(JSON.stringify(photos), p.id);
    const up = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
    io.emit('profile:updated', publicProfile(up));
    res.json({ profile: publicProfile(up) });
  });
});

app.delete('/api/profiles/:id/photos', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  const { url } = req.body||{};
  let photos = safeJSON(p.photos, []);
  if (photos.includes(url)) { removeFile(url); photos = photos.filter(x=>x!==url); }
  db.prepare('UPDATE profiles SET photos=? WHERE id=?').run(JSON.stringify(photos), p.id);
  const up = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
  io.emit('profile:updated', publicProfile(up));
  res.json({ profile: publicProfile(up) });
});

app.post('/api/profiles/:id/clone', requireMod, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  const info = db.prepare(`INSERT INTO profiles(owner_id,name,age,emoji,color,bio,tags,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(req.user.id, p.name+' (копия)', p.age, p.emoji, p.color, p.bio, p.tags, Date.now());
  const np = db.prepare('SELECT * FROM profiles WHERE id=?').get(info.lastInsertRowid);
  audit(req.user, 'clone_profile', `#${p.id}`);
  io.emit('profile:created', publicProfile(np));
  io.emit('stats:update');
  res.json({ profile: publicProfile(np) });
});

app.delete('/api/profiles/:id', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  if (p.avatar) removeFile(p.avatar);
  for (const ph of safeJSON(p.photos,[])) removeFile(ph);
  db.prepare('DELETE FROM profiles WHERE id=?').run(p.id);
  audit(req.user, 'delete_profile', `#${p.id} ${p.name}`);
  io.emit('profile:deleted', { id: p.id });
  io.emit('stats:update');
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════
//  COMMENTS
// ══════════════════════════════════════════════════════════════════════
app.post('/api/profiles/:id/comments', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Анкета не найдена'});
  const { text } = req.body||{};
  if (!text||!String(text).trim()) return res.status(400).json({error:'Текст обязателен'});
  const isAnon  = !!req.user.anon_mode && rank(req.user) >= 1;
  const author  = resolveAuthor(req.user);
  const avatar  = resolveAvatar(req.user);
  const emoji   = resolveEmoji(req.user);
  const info = db.prepare(`INSERT INTO comments(profile_id,user_id,author,text,user_avatar,user_emoji,is_anon_mode,created_at)
                           VALUES(?,?,?,?,?,?,?,?)`)
    .run(p.id, req.user.id, author, String(text).slice(0,1000), avatar, emoji, isAnon?1:0, Date.now());
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(info.lastInsertRowid);
  io.to('profile:'+p.id).emit('comment:new', publicComment(c));
  if (p.owner_id && p.owner_id !== req.user.id)
    tgNotify(p.owner_id, `💬 *${tgEsc(author)}* прокомментировал анкету *${tgEsc(p.name)}*:\n\n_${tgEsc(String(text).slice(0,200))}_\n\n🌐 [Открыть](${tgEsc(SITE_URL)})`);
  res.json({ comment: publicComment(c) });
});

app.post('/api/profiles/:id/comments/image', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Анкета не найдена'});
  uploadComment.single('image')(req, res, async err => {
    if (err) return res.status(400).json({error:err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/comments/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    const isAnon = !!req.user.anon_mode && rank(req.user) >= 1;
    const author = resolveAuthor(req.user), avatar = resolveAvatar(req.user), emoji = resolveEmoji(req.user);
    const text   = (req.body?.text||'').slice(0,500);
    const info   = db.prepare(`INSERT INTO comments(profile_id,user_id,author,text,image,user_avatar,user_emoji,is_anon_mode,created_at)
                               VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(p.id, req.user.id, author, text, rel, avatar, emoji, isAnon?1:0, Date.now());
    const c = db.prepare('SELECT * FROM comments WHERE id=?').get(info.lastInsertRowid);
    io.to('profile:'+p.id).emit('comment:new', publicComment(c));
    res.json({ comment: publicComment(c) });
  });
});

app.delete('/api/comments/:id', requireAuth, (req,res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(+req.params.id);
  if (!c) return res.status(404).json({error:'Не найден'});
  if (c.user_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  if (c.image) removeFile(c.image);
  db.prepare('DELETE FROM comments WHERE id=?').run(c.id);
  io.to('profile:'+c.profile_id).emit('comment:deleted', { id: c.id });
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════
//  FORUM
// ══════════════════════════════════════════════════════════════════════
app.get('/api/topics', (req,res) => {
  const isMod = rank(req.user) >= 1;
  const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM posts WHERE topic_id=t.id) as posts_count
    FROM topics t ${isMod?'':'WHERE t.hidden=0'} ORDER BY t.pinned DESC, t.created_at DESC`).all();
  res.json({ topics: rows.map(t => ({...publicTopic(t), postsCount:t.posts_count})) });
});

app.get('/api/topics/:id', (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Тема не найдена'});
  if (t.hidden && rank(req.user)<1) return res.status(404).json({error:'Скрыта'});
  const posts = db.prepare('SELECT * FROM posts WHERE topic_id=? ORDER BY created_at ASC').all(t.id);
  res.json({ topic: publicTopic(t), posts: posts.map(publicPost) });
});

app.post('/api/topics', requireAuth, (req,res) => {
  const { title, body } = req.body||{};
  if (!title||!body) return res.status(400).json({error:'Заголовок и текст обязательны'});
  const author = resolveAuthor(req.user);
  const info = db.prepare('INSERT INTO topics(user_id,author,title,body,created_at) VALUES(?,?,?,?,?)')
    .run(req.user.id, author, String(title).slice(0,120), String(body).slice(0,5000), Date.now());
  const topic = db.prepare('SELECT * FROM topics WHERE id=?').get(info.lastInsertRowid);
  io.emit('topic:created', {...publicTopic(topic), postsCount:0});
  io.emit('stats:update');
  res.json({ topic: publicTopic(topic) });
});

app.patch('/api/topics/:id', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Не найдено'});
  const isMod = rank(req.user) >= 1;
  if (t.user_id!==req.user.id && !isMod) return res.status(403).json({error:'Нет прав'});
  const { title, body, pinned, hidden } = req.body||{};
  db.prepare(`UPDATE topics SET title=COALESCE(?,title),body=COALESCE(?,body),pinned=?,hidden=? WHERE id=?`)
    .run(title?.slice(0,120)??null, body?.slice(0,5000)??null,
         isMod&&pinned!=null?(pinned?1:0):t.pinned,
         isMod&&hidden!=null?(hidden?1:0):t.hidden, t.id);
  const updated = db.prepare('SELECT * FROM topics WHERE id=?').get(t.id);
  const cnt     = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(t.id).c;
  io.emit('topic:updated', {...publicTopic(updated), postsCount:cnt});
  res.json({ topic: publicTopic(updated) });
});

app.delete('/api/topics/:id', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Не найдено'});
  if (t.user_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
  audit(req.user, 'delete_topic', `#${t.id} ${t.title}`);
  io.emit('topic:deleted', { id: t.id });
  io.emit('stats:update');
  res.json({ok:true});
});

app.post('/api/topics/:id/posts', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Тема не найдена'});
  const { text } = req.body||{};
  if (!text||!String(text).trim()) return res.status(400).json({error:'Текст обязателен'});
  const isAnon = !!req.user.anon_mode && rank(req.user) >= 1;
  const author = resolveAuthor(req.user), avatar = resolveAvatar(req.user), emoji = resolveEmoji(req.user);
  const info = db.prepare(`INSERT INTO posts(topic_id,user_id,author,text,user_avatar,user_emoji,is_anon_mode,created_at)
                           VALUES(?,?,?,?,?,?,?,?)`)
    .run(t.id, req.user.id, author, String(text).slice(0,3000), avatar, emoji, isAnon?1:0, Date.now());
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(info.lastInsertRowid);
  io.to('topic:'+t.id).emit('post:new', publicPost(post));
  const cnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(t.id).c;
  io.emit('topic:posts_count', { topicId:t.id, count:cnt });
  if (t.user_id && t.user_id!==req.user.id)
    tgNotify(t.user_id, `✉️ *${tgEsc(author)}* ответил в теме *${tgEsc(t.title)}*:\n\n_${tgEsc(String(text).slice(0,200))}_\n\n🌐 [Открыть](${tgEsc(SITE_URL)})`);
  res.json({ post: publicPost(post) });
});

app.post('/api/topics/:id/posts/image', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Тема не найдена'});
  uploadPost.single('image')(req, res, async err => {
    if (err) return res.status(400).json({error:err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel  = '/uploads/posts/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    const isAnon = !!req.user.anon_mode && rank(req.user) >= 1;
    const author = resolveAuthor(req.user), avatar = resolveAvatar(req.user), emoji = resolveEmoji(req.user);
    const text   = (req.body?.text||'').slice(0,1000);
    const info   = db.prepare(`INSERT INTO posts(topic_id,user_id,author,text,image,user_avatar,user_emoji,is_anon_mode,created_at)
                               VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(t.id, req.user.id, author, text, rel, avatar, emoji, isAnon?1:0, Date.now());
    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(info.lastInsertRowid);
    io.to('topic:'+t.id).emit('post:new', publicPost(post));
    const cnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(t.id).c;
    io.emit('topic:posts_count', { topicId:t.id, count:cnt });
    res.json({ post: publicPost(post) });
  });
});

app.delete('/api/posts/:id', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найден'});
  if (p.user_id!==req.user.id && rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  if (p.image) removeFile(p.image);
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  io.to('topic:'+p.topic_id).emit('post:deleted', { id: p.id });
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════
//  FRIENDS
// ══════════════════════════════════════════════════════════════════════

// Вспомогательные функции
function getFriendStatus(meId, otherId) {
  if (!meId) return 'none';
  // Проверяем блокировки
  const blocked = db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(meId,otherId,otherId,meId);
  if (blocked) {
    const iBlockedThem = db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(meId,otherId);
    return iBlockedThem ? 'blocked_by_me' : 'blocked_by_them';
  }
  const row = db.prepare('SELECT * FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').get(meId,otherId,otherId,meId);
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  if (row.from_id === meId) return 'pending_sent';
  return 'pending_received';
}

function areFriends(a, b) {
  return !!db.prepare('SELECT 1 FROM friends WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND status=\'accepted\'').get(a,b,b,a);
}

function isBlocked(meId, otherId) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(meId,otherId,otherId,meId);
}

// Лимит заявок в друзья — 20 в сутки
function checkFriendRequestLimit(userId) {
  const since = Date.now() - 24*60*60*1000;
  const cnt = db.prepare('SELECT COUNT(*) c FROM friends WHERE from_id=? AND created_at>?').get(userId, since).c;
  return cnt < 20;
}

// Получить статус дружбы с конкретным пользователем
app.get('/api/friends/status/:id', requireAuth, (req,res) => {
  const otherId = +req.params.id;
  if (otherId === req.user.id) return res.json({ status:'self' });
  res.json({ status: getFriendStatus(req.user.id, otherId) });
});

// Список друзей пользователя
app.get('/api/friends/:userId', (req,res) => {
  const userId = +req.params.userId;
  const targetUser = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!targetUser) return res.status(404).json({error:'Пользователь не найден'});

  const meId = req.user?.id;
  const privacy = targetUser.friends_privacy || 'all';

  // Проверяем доступ по приватности
  if (privacy === 'none' && meId !== userId && rank(req.user) < 1) {
    return res.json({ friends:[], hidden:true });
  }
  if (privacy === 'friends' && meId !== userId && rank(req.user) < 1) {
    if (!areFriends(meId, userId)) return res.json({ friends:[], hidden:true });
  }

  const rows = db.prepare(`
    SELECT u.*, f.created_at as friend_since
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END
    WHERE (f.from_id=? OR f.to_id=?) AND f.status='accepted'
    ORDER BY f.created_at DESC
  `).all(userId, userId, userId);

  res.json({ friends: rows.map(u => ({...publicUser(u), friendSince:u.friend_since})), hidden:false });
});

// Список входящих заявок
app.get('/api/friends/requests/incoming', requireAuth, (req,res) => {
  const rows = db.prepare(`
    SELECT u.*, f.id as request_id, f.created_at as request_at
    FROM friends f JOIN users u ON u.id=f.from_id
    WHERE f.to_id=? AND f.status='pending'
    ORDER BY f.created_at DESC
  `).all(req.user.id);
  res.json({ requests: rows.map(u => ({...publicUser(u), requestId:u.request_id, requestAt:u.request_at})) });
});

// Список исходящих заявок
app.get('/api/friends/requests/outgoing', requireAuth, (req,res) => {
  const rows = db.prepare(`
    SELECT u.*, f.id as request_id, f.created_at as request_at
    FROM friends f JOIN users u ON u.id=f.to_id
    WHERE f.from_id=? AND f.status='pending'
    ORDER BY f.created_at DESC
  `).all(req.user.id);
  res.json({ requests: rows.map(u => ({...publicUser(u), requestId:u.request_id, requestAt:u.request_at})) });
});

// Отправить заявку в друзья
app.post('/api/friends/request/:id', requireAuth, (req,res) => {
  const toId = +req.params.id;
  if (toId === req.user.id) return res.status(400).json({error:'Нельзя добавить себя'});
  if (isBlocked(req.user.id, toId)) return res.status(403).json({error:'Действие недоступно'});
  const existing = db.prepare('SELECT * FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').get(req.user.id,toId,toId,req.user.id);
  if (existing) {
    if (existing.status==='accepted') return res.status(409).json({error:'Уже в друзьях'});
    if (existing.from_id===req.user.id) return res.status(409).json({error:'Заявка уже отправлена'});
    // Если они нам отправили — принимаем
    db.prepare('UPDATE friends SET status=?,updated_at=? WHERE id=?').run('accepted',Date.now(),existing.id);
    const toUser = db.prepare('SELECT * FROM users WHERE id=?').get(toId);
    io.to('user:'+toId).emit('friend:accepted', { user: publicUser(req.user) });
    io.to('user:'+req.user.id).emit('friend:accepted', { user: publicUser(toUser) });
    return res.json({ status:'friends' });
  }
  if (!checkFriendRequestLimit(req.user.id)) return res.status(429).json({error:'Лимит заявок: 20 в сутки'});
  const toUser = db.prepare('SELECT * FROM users WHERE id=?').get(toId);
  if (!toUser) return res.status(404).json({error:'Пользователь не найден'});
  const now = Date.now();
  db.prepare('INSERT INTO friends(from_id,to_id,status,created_at,updated_at) VALUES(?,?,\'pending\',?,?)').run(req.user.id,toId,now,now);
  io.to('user:'+toId).emit('friend:request', { user: publicUser(req.user) });
  res.json({ status:'pending_sent' });
});

// Принять заявку
app.post('/api/friends/accept/:id', requireAuth, (req,res) => {
  const fromId = +req.params.id;
  const row = db.prepare('SELECT * FROM friends WHERE from_id=? AND to_id=? AND status=\'pending\'').get(fromId, req.user.id);
  if (!row) return res.status(404).json({error:'Заявка не найдена'});
  db.prepare('UPDATE friends SET status=?,updated_at=? WHERE id=?').run('accepted',Date.now(),row.id);
  const fromUser = db.prepare('SELECT * FROM users WHERE id=?').get(fromId);
  io.to('user:'+fromId).emit('friend:accepted', { user: publicUser(req.user) });
  io.to('user:'+req.user.id).emit('friend:accepted', { user: publicUser(fromUser) });
  res.json({ status:'friends' });
});

// Отклонить заявку
app.post('/api/friends/decline/:id', requireAuth, (req,res) => {
  const fromId = +req.params.id;
  const row = db.prepare('SELECT * FROM friends WHERE from_id=? AND to_id=? AND status=\'pending\'').get(fromId, req.user.id);
  if (!row) return res.status(404).json({error:'Заявка не найдена'});
  db.prepare('DELETE FROM friends WHERE id=?').run(row.id);
  res.json({ status:'none' });
});

// Отменить исходящую заявку
app.post('/api/friends/cancel/:id', requireAuth, (req,res) => {
  const toId = +req.params.id;
  const row = db.prepare('SELECT * FROM friends WHERE from_id=? AND to_id=? AND status=\'pending\'').get(req.user.id, toId);
  if (!row) return res.status(404).json({error:'Заявка не найдена'});
  db.prepare('DELETE FROM friends WHERE id=?').run(row.id);
  res.json({ status:'none' });
});

// Удалить из друзей
app.delete('/api/friends/:id', requireAuth, (req,res) => {
  const otherId = +req.params.id;
  db.prepare('DELETE FROM friends WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND status=\'accepted\'').run(req.user.id,otherId,otherId,req.user.id);
  io.to('user:'+otherId).emit('friend:removed', { userId: req.user.id });
  io.to('user:'+req.user.id).emit('friend:removed', { userId: otherId });
  res.json({ status:'none' });
});

// Заблокировать пользователя
app.post('/api/friends/block/:id', requireAuth, (req,res) => {
  const blockId = +req.params.id;
  if (blockId === req.user.id) return res.status(400).json({error:'Нельзя заблокировать себя'});
  // Удаляем дружбу/заявки если есть
  db.prepare('DELETE FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(req.user.id,blockId,blockId,req.user.id);
  try { db.prepare('INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(req.user.id,blockId,Date.now()); } catch {}
  audit(req.user,'block_user',`user_id:${blockId}`);
  res.json({ status:'blocked_by_me' });
});

// Разблокировать
app.post('/api/friends/unblock/:id', requireAuth, (req,res) => {
  const unblockId = +req.params.id;
  db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id,unblockId);
  res.json({ status:'none' });
});

// Список заблокированных
app.get('/api/friends/blocked/list', requireAuth, (req,res) => {
  const rows = db.prepare(`
    SELECT u.* FROM blocks b JOIN users u ON u.id=b.blocked_id
    WHERE b.blocker_id=? ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json({ blocked: rows.map(publicUser) });
});

// Обновить приватность списка друзей
app.patch('/api/friends/privacy', requireAuth, (req,res) => {
  const { privacy } = req.body||{};
  if (!['all','friends','none'].includes(privacy)) return res.status(400).json({error:'Неверное значение'});
  db.prepare('UPDATE users SET friends_privacy=? WHERE id=?').run(privacy, req.user.id);
  res.json({ ok:true, friendsPrivacy:privacy });
});

// ══════════════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════════════
app.get('/api/settings', (req,res) => {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k, DEFAULT_SETTINGS[k]);
  res.json({ settings: out });
});
app.patch('/api/settings', requireAdmin, (req,res) => {
  const upd = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (req.body && k in req.body) { setSetting(k, req.body[k]); upd[k] = req.body[k]; }
  audit(req.user, 'update_settings', JSON.stringify(upd));
  io.emit('settings:updated', upd);
  res.json({ ok:true, settings:upd });
});

// ══════════════════════════════════════════════════════════════════════
//  STATS & AUDIT
// ══════════════════════════════════════════════════════════════════════
app.get('/api/stats', (req,res) => res.json({
  users:    db.prepare('SELECT COUNT(*) c FROM users').get().c,
  profiles: db.prepare('SELECT COUNT(*) c FROM profiles').get().c,
  topics:   db.prepare('SELECT COUNT(*) c FROM topics').get().c,
  posts:    db.prepare('SELECT COUNT(*) c FROM posts').get().c,
}));

// Аудит-лог — главный админ видит real_name и is_anon_mode
app.get('/api/audit', requireAdmin, (req,res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all();
  res.json({ log: rows });
});

// ── STATIC ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// Отдаём uploads из UPLOADS_DIR (на Railway это /data/uploads)
app.use('/uploads', express.static(UPLOADS_DIR));
// Fallback — отдаём из public/uploads если файл там
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ── DIRECT MESSAGES ─────────────────────────────────────────────────
app.get('/api/dm/conversations', requireAuth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.emoji, u.last_seen,
      (SELECT text FROM dm_messages WHERE (from_id=? AND to_id=u.id) OR (from_id=u.id AND to_id=?) ORDER BY created_at DESC LIMIT 1) as last_text,
      (SELECT created_at FROM dm_messages WHERE (from_id=? AND to_id=u.id) OR (from_id=u.id AND to_id=?) ORDER BY created_at DESC LIMIT 1) as last_at,
      (SELECT COUNT(*) FROM dm_messages WHERE from_id=u.id AND to_id=? AND read_at IS NULL) as unread
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END
    WHERE (f.from_id=? OR f.to_id=?) AND f.status='accepted' AND u.banned=0
    ORDER BY last_at DESC NULLS LAST
  `).all(me,me,me,me,me,me,me,me);
  res.json({ conversations: rows.map(u => ({ ...publicUser(u), lastText: u.last_text, lastAt: u.last_at, unread: u.unread })) });
});

app.get('/api/dm/:userId', requireAuth, (req, res) => {
  const me = req.user.id, other = +req.params.userId;
  if (!areFriends(me, other)) return res.status(403).json({ error: 'Не в друзьях' });
  const msgs = db.prepare(`SELECT m.*, u.username, u.display_name, u.avatar, u.emoji FROM dm_messages m JOIN users u ON u.id=m.from_id WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY created_at ASC LIMIT 100`).all(me,other,other,me);
  db.prepare(`UPDATE dm_messages SET read_at=? WHERE to_id=? AND from_id=? AND read_at IS NULL`).run(Date.now(),me,other);
  res.json({ messages: msgs });
});

app.post('/api/dm/:userId', requireAuth, (req, res) => {
  const me = req.user.id, other = +req.params.userId;
  if (!areFriends(me, other)) return res.status(403).json({ error: 'Не в друзьях' });
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  const now = Date.now();
  const info = db.prepare(`INSERT INTO dm_messages(from_id,to_id,text,created_at) VALUES(?,?,?,?)`).run(me,other,text,now);
  const msg = { id: info.lastInsertRowid, from_id: me, to_id: other, text, created_at: now, username: req.user.username, display_name: req.user.display_name, avatar: req.user.avatar, emoji: req.user.emoji };
  io.to('user:'+other).emit('dm:message', msg);
  io.to('user:'+me).emit('dm:message', msg);
  res.json({ message: msg });
});
app.use((err,_req,res,_next) => { console.error(err); res.status(500).json({error:'Внутренняя ошибка'}); });


server.listen(PORT, () => {
  console.log(`✓ Сервер: http://localhost:${PORT}`);
  console.log(`  БД: ${DB_PATH}`);
});
