require('dotenv').config();
const path        = require('path');
const fs          = require('fs');
const http        = require('http');
const express     = require('express');
const { Server: SocketServer } = require('socket.io');
const Database    = require('better-sqlite3');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const cookieParser= require('cookie-parser');
const multer      = require('multer');

// CONFIG
const PORT           = process.env.PORT || 3000;
const JWT_SECRET     = process.env.JWT_SECRET || 'dev_only_change_me';
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'glom').toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'glom123';
const DB_PATH        = process.env.DB_PATH || path.join(__dirname, 'db.sqlite');
const UPLOADS_DIR    = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');

if (JWT_SECRET === 'dev_only_change_me') {
  console.warn('JWT_SECRET не задан. Задай переменную окружения!');
}

// Папки для загрузок
const DIRS = {
  avatars:  path.join(UPLOADS_DIR, 'avatars'),
  profiles: path.join(UPLOADS_DIR, 'profiles'),
  comments: path.join(UPLOADS_DIR, 'comments'),
  posts:    path.join(UPLOADS_DIR, 'posts'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// DATABASE
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  emoji         TEXT DEFAULT '👤',
  avatar        TEXT DEFAULT NULL,
  bio           TEXT DEFAULT '',
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  age        INTEGER,
  emoji      TEXT DEFAULT '👤',
  color      TEXT DEFAULT '#e8632a',
  bio        TEXT DEFAULT '',
  tags       TEXT DEFAULT '[]',
  avatar     TEXT DEFAULT NULL,
  photos     TEXT DEFAULT '[]',
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  image      TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author     TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  image      TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  actor_name TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_created ON profiles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topics_created   ON topics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_topic      ON posts(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_profile ON comments(profile_id, created_at);
`);

// Миграции — добавляем колонки если их нет (для существующих БД)
function addColIfMissing(table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch {}
}
addColIfMissing('users',    'avatar',   'TEXT DEFAULT NULL');
addColIfMissing('users',    'banner',   'TEXT DEFAULT NULL');
addColIfMissing('users',    'accent',   'TEXT DEFAULT NULL');
addColIfMissing('users',    'status',   'TEXT DEFAULT NULL');
addColIfMissing('users',    'location', 'TEXT DEFAULT NULL');
addColIfMissing('users',    'socials',  'TEXT DEFAULT \'{}\'');
addColIfMissing('profiles', 'avatar',   'TEXT DEFAULT NULL');
addColIfMissing('profiles', 'photos',   'TEXT DEFAULT \'[]\'');
addColIfMissing('comments', 'image',    'TEXT DEFAULT NULL');
addColIfMissing('posts',    'image',    'TEXT DEFAULT NULL');

// BOOTSTRAP
function ensureOwner() {
  const now = Date.now();
  const ex = db.prepare('SELECT id,role FROM users WHERE username=?').get(OWNER_USERNAME);
  if (!ex) {
    const hash = bcrypt.hashSync(OWNER_PASSWORD, 10);
    db.prepare(`INSERT INTO users(username,display_name,password_hash,role,emoji,created_at,last_seen) VALUES(?,?,?,'owner','👑',?,?)`)
      .run(OWNER_USERNAME, OWNER_USERNAME, hash, now, now);
    console.log('Created owner:', OWNER_USERNAME);
  } else if (ex.role !== 'owner') {
    db.prepare('UPDATE users SET role=? WHERE id=?').run('owner', ex.id);
  }
}
ensureOwner();

const DEFAULT_SETTINGS = { siteName:'ANKETA.FORUM', welcome:'Анонимные анкеты и форум', accent:'#e8632a', adminAnon:false };
function getSetting(k, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  if (!r) return def;
  try { return JSON.parse(r.value); } catch { return def; }
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
}
for (const [k,v] of Object.entries(DEFAULT_SETTINGS)) {
  if (getSetting(k, undefined) === undefined) setSetting(k, v);
}

function audit(actor, action, target) {
  db.prepare('INSERT INTO audit_log(actor_id,actor_name,action,target,created_at) VALUES(?,?,?,?,?)')
    .run(actor?.id||null, actor?.username||'system', action, target||'', Date.now());
}

// HELPERS
const ROLE_RANK = { user:0, moderator:1, admin:2, owner:3 };
const rank = u => ROLE_RANK[u?.role] ?? 0;
function publicUser(u) {
  if (!u) return null;
  return { id:u.id, username:u.username, displayName:u.display_name, role:u.role,
           emoji:u.emoji, avatar:u.avatar||null, banner:u.banner||null,
           accent:u.accent||null, status:u.status||null, location:u.location||null,
           socials:safeJSON(u.socials,{}),
           bio:u.bio, banned:!!u.banned, createdAt:u.created_at, lastSeen:u.last_seen };
}
function publicProfile(p) {
  return { id:p.id, ownerId:p.owner_id, name:p.name, age:p.age, emoji:p.emoji, color:p.color, bio:p.bio,
           tags:safeJSON(p.tags,[]), avatar:p.avatar||null, photos:safeJSON(p.photos,[]),
           pinned:!!p.pinned, hidden:!!p.hidden, createdAt:p.created_at };
}
function publicTopic(t) {
  return { id:t.id, userId:t.user_id, author:t.author, title:t.title, body:t.body,
           pinned:!!t.pinned, hidden:!!t.hidden, createdAt:t.created_at };
}
function safeJSON(s, def) { try { return JSON.parse(s); } catch { return def; } }

// Удалить старый файл из uploads
function removeFile(relPath) {
  if (!relPath) return;
  try { fs.unlinkSync(path.join(__dirname, 'public', relPath)); } catch {}
}

// EXPRESS + HTTP + SOCKET.IO
const app    = express();
const server = http.createServer(app);
const io     = new SocketServer(server, { cors: { origin:'*', methods:['GET','POST'] } });

app.use(express.json({ limit:'512kb' }));
app.use(cookieParser());

// MULTER — сохраняем файлы по категориям
function makeUpload(subdir, maxMB) {
  const storage = multer.diskStorage({
    destination: DIRS[subdir],
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g,'') || '.jpg';
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2) + ext);
    }
  });
  return multer({
    storage,
    limits: { fileSize: maxMB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
      cb(ok ? null : new Error('Только изображения: jpg, png, gif, webp'), ok);
    }
  });
}

const uploadAvatar  = makeUpload('avatars',  5);
const uploadProfile = makeUpload('profiles', 8);
const uploadComment = makeUpload('comments', 8);
const uploadPost    = makeUpload('posts',    8);

// Middleware: попытаться сжать изображение через sharp (опционально)
async function tryCompress(filePath, maxW) {
  try {
    const sharp = require('sharp');
    const tmp = filePath + '.tmp';
    await sharp(filePath).resize(maxW, maxW, { fit:'inside', withoutEnlargement:true })
      .jpeg({ quality:82 }).toFile(tmp);
    fs.renameSync(tmp, filePath);
  } catch { /* sharp не установлен или ошибка — оставляем как есть */ }
}

// Socket.io auth
io.use((socket, next) => {
  try {
    let token = socket.handshake.auth?.token;
    if (!token) {
      const raw = socket.handshake.headers?.cookie || '';
      const match = raw.split(';').find(c => c.trim().startsWith('token='));
      if (match) token = match.split('=')[1];
    }
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
      if (u && !u.banned) socket.user = u;
    }
  } catch {}
  next();
});

io.on('connection', socket => {
  socket.on('join:profile', id => socket.join('profile:' + id));
  socket.on('leave:profile', id => socket.leave('profile:' + id));
  socket.on('join:topic',   id => socket.join('topic:' + id));
  socket.on('leave:topic',  id => socket.leave('topic:' + id));
});

// HTTP AUTH
function authMiddleware(req, _res, next) {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) token = req.headers.authorization.slice(7);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
      if (u && !u.banned) {
        req.user = u;
        db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), u.id);
      }
    } catch {}
  }
  next();
}
app.use(authMiddleware);

const requireAuth  = (q,r,n) => q.user         ? n() : r.status(401).json({error:'Нужен вход'});
const requireMod   = (q,r,n) => rank(q.user)>=1 ? n() : r.status(403).json({error:'Нужна роль модератора'});
const requireAdmin = (q,r,n) => rank(q.user)>=2 ? n() : r.status(403).json({error:'Нужна роль админа'});
const requireOwner = (q,r,n) => q.user?.role==='owner' ? n() : r.status(403).json({error:'Только главный админ'});

function issueToken(user, res) {
  const token = jwt.sign({ uid:user.id }, JWT_SECRET, { expiresIn:'30d' });
  res.cookie('token', token, {
    httpOnly:true, sameSite:'lax',
    secure: process.env.NODE_ENV==='production',
    maxAge: 30*24*60*60*1000
  });
  return token;
}

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/auth/register', (req,res) => {
  const { username, password, displayName } = req.body||{};
  if (!username||!password) return res.status(400).json({error:'Логин и пароль обязательны'});
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:'Логин 3-20 символов: a-z, 0-9, _'});
  if (password.length<6) return res.status(400).json({error:'Пароль минимум 6 символов'});
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username.toLowerCase())) return res.status(409).json({error:'Логин уже занят'});
  const hash = bcrypt.hashSync(password,10);
  const now  = Date.now();
  const info = db.prepare(`INSERT INTO users(username,display_name,password_hash,role,created_at,last_seen) VALUES(?,?,?,'user',?,?)`)
    .run(username.toLowerCase(), (displayName||username).slice(0,30), hash, now, now);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  const token = issueToken(u,res);
  audit(u,'register');
  io.emit('stats:update');
  res.json({ user:publicUser(u), token });
});

app.post('/api/auth/login', (req,res) => {
  const { username, password } = req.body||{};
  if (!username||!password) return res.status(400).json({error:'Логин и пароль обязательны'});
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).toLowerCase());
  if (!u) return res.status(401).json({error:'Неверный логин или пароль'});
  if (u.banned) return res.status(403).json({error:'Аккаунт заблокирован'});
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({error:'Неверный логин или пароль'});
  const token = issueToken(u,res);
  audit(u,'login');
  res.json({ user:publicUser(u), token });
});

app.post('/api/auth/logout', (req,res) => { res.clearCookie('token'); res.json({ok:true}); });
app.get('/api/auth/me', (req,res) => res.json({user: req.user ? publicUser(req.user) : null}));

app.post('/api/auth/change-password', requireAuth, (req,res) => {
  const { oldPassword, newPassword } = req.body||{};
  if (!newPassword||newPassword.length<6) return res.status(400).json({error:'Новый пароль минимум 6 символов'});
  if (!bcrypt.compareSync(oldPassword||'', req.user.password_hash)) return res.status(401).json({error:'Старый пароль неверен'});
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword,10), req.user.id);
  audit(req.user,'change_password');
  res.json({ok:true});
});

app.patch('/api/auth/me', requireAuth, (req,res) => {
  const { displayName, emoji, bio, accent, status, location, socials } = req.body||{};
  db.prepare(`UPDATE users SET
    display_name=COALESCE(?,display_name),
    emoji=COALESCE(?,emoji),
    bio=COALESCE(?,bio),
    accent=COALESCE(?,accent),
    status=COALESCE(?,status),
    location=COALESCE(?,location),
    socials=COALESCE(?,socials)
    WHERE id=?`)
    .run(
      displayName?.slice(0,30)??null,
      emoji?.slice(0,8)??null,
      bio?.slice(0,500)??null,
      accent?.slice(0,16)??null,
      status?.slice(0,60)??null,
      location?.slice(0,60)??null,
      socials ? JSON.stringify(socials) : null,
      req.user.id
    );
  res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))});
});

// Загрузка баннера пользователя
const uploadBanner = makeUpload('avatars', 8);
app.post('/api/auth/banner', requireAuth, (req,res) => {
  uploadBanner.single('banner')(req, res, async err => {
    if (err) return res.status(400).json({error: err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/avatars/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    const old = db.prepare('SELECT banner FROM users WHERE id=?').get(req.user.id);
    if (old?.banner) removeFile(old.banner);
    db.prepare('UPDATE users SET banner=? WHERE id=?').run(rel, req.user.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    curUser = publicUser(u);
    res.json({user:publicUser(u)});
  });
});

app.delete('/api/auth/banner', requireAuth, (req,res) => {
  const old = db.prepare('SELECT banner FROM users WHERE id=?').get(req.user.id);
  if (old?.banner) removeFile(old.banner);
  db.prepare('UPDATE users SET banner=NULL WHERE id=?').run(req.user.id);
  res.json({ok:true});
});

// Загрузка аватарки пользователя
app.post('/api/auth/avatar', requireAuth, (req,res) => {
  uploadAvatar.single('avatar')(req, res, async err => {
    if (err) return res.status(400).json({error: err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/avatars/' + req.file.filename;
    await tryCompress(req.file.path, 400);
    // Удаляем старую аватарку
    const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
    if (old?.avatar) removeFile(old.avatar);
    db.prepare('UPDATE users SET avatar=? WHERE id=?').run(rel, req.user.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    res.json({user: publicUser(u)});
  });
});

// Удалить аватарку пользователя
app.delete('/api/auth/avatar', requireAuth, (req,res) => {
  const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
  if (old?.avatar) removeFile(old.avatar);
  db.prepare('UPDATE users SET avatar=NULL WHERE id=?').run(req.user.id);
  res.json({ok:true});
});

// ── USERS ─────────────────────────────────────────────────────────
// Публичный профиль пользователя (доступен всем)
app.get('/api/users/:id/public', (req,res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.status(404).json({error:'Пользователь не найден'});
  // Анкеты пользователя
  const isMod = rank(req.user)>=1;
  const profiles = db.prepare(`SELECT * FROM profiles WHERE owner_id=? ${isMod?'':'AND hidden=0'} ORDER BY pinned DESC, created_at DESC`).all(u.id);
  // Статистика
  const postsCount = db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(u.id).c;
  const commentsCount = db.prepare('SELECT COUNT(*) c FROM comments WHERE user_id=?').get(u.id).c;
  res.json({ user:publicUser(u), profiles:profiles.map(publicProfile), postsCount, commentsCount });
});

app.get('/api/users', requireMod, (req,res) => res.json({users: db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(publicUser)}));

app.post('/api/users/:id/role', requireAdmin, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!target) return res.status(404).json({error:'Не найден'});
  if (target.role==='owner') return res.status(403).json({error:'Нельзя менять роль главного админа'});
  if (target.id===req.user.id) return res.status(400).json({error:'Нельзя менять роль себе'});
  const { role } = req.body||{};
  if (req.user.role==='owner') {
    if (!['user','moderator','admin'].includes(role)) return res.status(400).json({error:'Недопустимая роль'});
  } else {
    if (!['user','moderator'].includes(role)) return res.status(403).json({error:'Нет прав'});
    if (rank(target)>=2) return res.status(403).json({error:'Нельзя понижать другого админа'});
  }
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, target.id);
  audit(req.user,'set_role',`${target.username} -> ${role}`);
  io.emit('user:role_changed', { userId:target.id, role });
  res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id))});
});

app.post('/api/users/:id/ban', requireMod, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!target) return res.status(404).json({error:'Не найден'});
  if (rank(target)>=rank(req.user)) return res.status(403).json({error:'Нет прав'});
  const { banned } = req.body||{};
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(banned?1:0, target.id);
  audit(req.user, banned?'ban':'unban', target.username);
  res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id))});
});

app.delete('/api/users/:id', requireOwner, (req,res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!target) return res.status(404).json({error:'Не найден'});
  if (target.role==='owner') return res.status(403).json({error:'Нельзя удалить главного админа'});
  if (target.avatar) removeFile(target.avatar);
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  audit(req.user,'delete_user',target.username);
  io.emit('stats:update');
  res.json({ok:true});
});

// ── PROFILES ──────────────────────────────────────────────────────
app.get('/api/profiles', (req,res) => {
  const isMod = rank(req.user)>=1;
  const rows = db.prepare(`SELECT * FROM profiles ${isMod?'':'WHERE hidden=0'} ORDER BY pinned DESC, created_at DESC`).all();
  res.json({profiles: rows.map(publicProfile)});
});

app.get('/api/profiles/:id', (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.hidden&&rank(req.user)<1) return res.status(404).json({error:'Скрыта'});
  const comments = db.prepare('SELECT * FROM comments WHERE profile_id=? ORDER BY created_at ASC').all(p.id);
  res.json({profile:publicProfile(p), comments});
});

app.post('/api/profiles', requireAuth, (req,res) => {
  const { name, age, emoji, color, bio, tags } = req.body||{};
  if (!name||!String(name).trim()) return res.status(400).json({error:'Имя обязательно'});
  const info = db.prepare(`INSERT INTO profiles(owner_id,name,age,emoji,color,bio,tags,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(req.user.id, String(name).slice(0,50), +age||null, emoji?.slice(0,8)||'👤',
         color?.slice(0,16)||'#e8632a', (bio||'').slice(0,2000),
         JSON.stringify(Array.isArray(tags)?tags.slice(0,10):[]), Date.now());
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(info.lastInsertRowid);
  io.emit('profile:created', publicProfile(p));
  io.emit('stats:update');
  res.json({profile:publicProfile(p)});
});

app.patch('/api/profiles/:id', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  const isOwn = p.owner_id===req.user.id;
  const isMod = rank(req.user)>=1;
  if (!isOwn&&!isMod) return res.status(403).json({error:'Нет прав'});
  const { name, age, emoji, color, bio, tags, pinned, hidden } = req.body||{};
  db.prepare(`UPDATE profiles SET name=COALESCE(?,name),age=COALESCE(?,age),emoji=COALESCE(?,emoji),
    color=COALESCE(?,color),bio=COALESCE(?,bio),tags=COALESCE(?,tags),pinned=?,hidden=? WHERE id=?`)
    .run(name?.slice(0,50)??null, age!=null?+age:null, emoji?.slice(0,8)??null, color?.slice(0,16)??null,
         bio!=null?String(bio).slice(0,2000):null, Array.isArray(tags)?JSON.stringify(tags.slice(0,10)):null,
         isMod&&pinned!=null?(pinned?1:0):p.pinned, isMod&&hidden!=null?(hidden?1:0):p.hidden, p.id);
  const updated = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
  if (isMod&&(pinned!=null||hidden!=null)) audit(req.user,'profile_mod',`#${p.id}`);
  io.emit('profile:updated', publicProfile(updated));
  res.json({profile:publicProfile(updated)});
});

// Загрузка аватарки анкеты
app.post('/api/profiles/:id/avatar', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  uploadProfile.single('avatar')(req, res, async err => {
    if (err) return res.status(400).json({error: err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/profiles/' + req.file.filename;
    await tryCompress(req.file.path, 600);
    if (p.avatar) removeFile(p.avatar);
    db.prepare('UPDATE profiles SET avatar=? WHERE id=?').run(rel, p.id);
    const updated = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
    io.emit('profile:updated', publicProfile(updated));
    res.json({profile:publicProfile(updated)});
  });
});

// Загрузка фото в галерею анкеты (макс 10 фото)
app.post('/api/profiles/:id/photos', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  const photos = safeJSON(p.photos,[]);
  if (photos.length>=10) return res.status(400).json({error:'Максимум 10 фото в анкете'});
  uploadProfile.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({error: err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/profiles/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    photos.push(rel);
    db.prepare('UPDATE profiles SET photos=? WHERE id=?').run(JSON.stringify(photos), p.id);
    const updated = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
    io.emit('profile:updated', publicProfile(updated));
    res.json({profile:publicProfile(updated)});
  });
});

// Удалить фото из галереи
app.delete('/api/profiles/:id/photos', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  const { url } = req.body||{};
  let photos = safeJSON(p.photos,[]);
  if (photos.includes(url)) { removeFile(url); photos = photos.filter(x=>x!==url); }
  db.prepare('UPDATE profiles SET photos=? WHERE id=?').run(JSON.stringify(photos), p.id);
  const updated = db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id);
  io.emit('profile:updated', publicProfile(updated));
  res.json({profile:publicProfile(updated)});
});

app.post('/api/profiles/:id/clone', requireMod, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  const info = db.prepare(`INSERT INTO profiles(owner_id,name,age,emoji,color,bio,tags,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(req.user.id, p.name+' (копия)', p.age, p.emoji, p.color, p.bio, p.tags, Date.now());
  const newP = db.prepare('SELECT * FROM profiles WHERE id=?').get(info.lastInsertRowid);
  audit(req.user,'clone_profile',`#${p.id}`);
  io.emit('profile:created', publicProfile(newP));
  io.emit('stats:update');
  res.json({profile:publicProfile(newP)});
});

app.delete('/api/profiles/:id', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найдено'});
  if (p.owner_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  // Удаляем все файлы анкеты
  if (p.avatar) removeFile(p.avatar);
  for (const ph of safeJSON(p.photos,[])) removeFile(ph);
  db.prepare('DELETE FROM profiles WHERE id=?').run(p.id);
  audit(req.user,'delete_profile',`#${p.id} ${p.name}`);
  io.emit('profile:deleted', { id:p.id });
  io.emit('stats:update');
  res.json({ok:true});
});

// ── COMMENTS ──────────────────────────────────────────────────────
// Текстовый комментарий
app.post('/api/profiles/:id/comments', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Анкета не найдена'});
  const { text } = req.body||{};
  if (!text||!String(text).trim()) return res.status(400).json({error:'Текст обязателен'});
  const adminAnon = !!getSetting('adminAnon',false);
  const author = (adminAnon&&rank(req.user)>=2)?'Анонимный админ':req.user.display_name;
  const info = db.prepare('INSERT INTO comments(profile_id,user_id,author,text,created_at) VALUES(?,?,?,?,?)')
    .run(p.id, req.user.id, author, String(text).slice(0,1000), Date.now());
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(info.lastInsertRowid);
  io.to('profile:'+p.id).emit('comment:new', c);
  res.json({comment:c});
});

// Комментарий с картинкой
app.post('/api/profiles/:id/comments/image', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Анкета не найдена'});
  uploadComment.single('image')(req, res, async err => {
    if (err) return res.status(400).json({error: err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/comments/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    const adminAnon = !!getSetting('adminAnon',false);
    const author = (adminAnon&&rank(req.user)>=2)?'Анонимный админ':req.user.display_name;
    const text = (req.body?.text||'').slice(0,500);
    const info = db.prepare('INSERT INTO comments(profile_id,user_id,author,text,image,created_at) VALUES(?,?,?,?,?,?)')
      .run(p.id, req.user.id, author, text, rel, Date.now());
    const c = db.prepare('SELECT * FROM comments WHERE id=?').get(info.lastInsertRowid);
    io.to('profile:'+p.id).emit('comment:new', c);
    res.json({comment:c});
  });
});

app.delete('/api/comments/:id', requireAuth, (req,res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(+req.params.id);
  if (!c) return res.status(404).json({error:'Не найден'});
  if (c.user_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  if (c.image) removeFile(c.image);
  db.prepare('DELETE FROM comments WHERE id=?').run(c.id);
  io.to('profile:'+c.profile_id).emit('comment:deleted', { id:c.id });
  res.json({ok:true});
});

// ── FORUM ─────────────────────────────────────────────────────────
app.get('/api/topics', (req,res) => {
  const isMod = rank(req.user)>=1;
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM posts WHERE topic_id=t.id) as posts_count
    FROM topics t ${isMod?'':'WHERE t.hidden=0'}
    ORDER BY t.pinned DESC, t.created_at DESC
  `).all();
  res.json({topics: rows.map(t=>({...publicTopic(t), postsCount:t.posts_count}))});
});

app.get('/api/topics/:id', (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Тема не найдена'});
  if (t.hidden&&rank(req.user)<1) return res.status(404).json({error:'Скрыта'});
  const posts = db.prepare('SELECT * FROM posts WHERE topic_id=? ORDER BY created_at ASC').all(t.id);
  res.json({topic:publicTopic(t), posts});
});

app.post('/api/topics', requireAuth, (req,res) => {
  const { title, body } = req.body||{};
  if (!title||!body) return res.status(400).json({error:'Заголовок и текст обязательны'});
  const adminAnon = !!getSetting('adminAnon',false);
  const author = (adminAnon&&rank(req.user)>=2)?'Анонимный админ':req.user.display_name;
  const info = db.prepare('INSERT INTO topics(user_id,author,title,body,created_at) VALUES(?,?,?,?,?)')
    .run(req.user.id, author, String(title).slice(0,120), String(body).slice(0,5000), Date.now());
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(info.lastInsertRowid);
  io.emit('topic:created', {...publicTopic(t), postsCount:0});
  io.emit('stats:update');
  res.json({topic:publicTopic(t)});
});

app.patch('/api/topics/:id', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Не найдено'});
  const isMod = rank(req.user)>=1;
  if (t.user_id!==req.user.id&&!isMod) return res.status(403).json({error:'Нет прав'});
  const { title, body, pinned, hidden } = req.body||{};
  db.prepare(`UPDATE topics SET title=COALESCE(?,title),body=COALESCE(?,body),pinned=?,hidden=? WHERE id=?`)
    .run(title?.slice(0,120)??null, body?.slice(0,5000)??null,
         isMod&&pinned!=null?(pinned?1:0):t.pinned, isMod&&hidden!=null?(hidden?1:0):t.hidden, t.id);
  const updated = db.prepare('SELECT * FROM topics WHERE id=?').get(t.id);
  const cnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(t.id).c;
  io.emit('topic:updated', {...publicTopic(updated), postsCount:cnt});
  res.json({topic:publicTopic(updated)});
});

app.delete('/api/topics/:id', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Не найдено'});
  if (t.user_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
  audit(req.user,'delete_topic',`#${t.id} ${t.title}`);
  io.emit('topic:deleted', { id:t.id });
  io.emit('stats:update');
  res.json({ok:true});
});

// Пост только текст
app.post('/api/topics/:id/posts', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Тема не найдена'});
  const { text } = req.body||{};
  if (!text||!String(text).trim()) return res.status(400).json({error:'Текст обязателен'});
  const adminAnon = !!getSetting('adminAnon',false);
  const author = (adminAnon&&rank(req.user)>=2)?'Анонимный админ':req.user.display_name;
  const info = db.prepare('INSERT INTO posts(topic_id,user_id,author,text,created_at) VALUES(?,?,?,?,?)')
    .run(t.id, req.user.id, author, String(text).slice(0,3000), Date.now());
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(info.lastInsertRowid);
  io.to('topic:'+t.id).emit('post:new', p);
  const cnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(t.id).c;
  io.emit('topic:posts_count', { topicId:t.id, count:cnt });
  res.json({post:p});
});

// Пост с картинкой
app.post('/api/topics/:id/posts/image', requireAuth, (req,res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(+req.params.id);
  if (!t) return res.status(404).json({error:'Тема не найдена'});
  uploadPost.single('image')(req, res, async err => {
    if (err) return res.status(400).json({error: err.message});
    if (!req.file) return res.status(400).json({error:'Файл не получен'});
    const rel = '/uploads/posts/' + req.file.filename;
    await tryCompress(req.file.path, 1200);
    const adminAnon = !!getSetting('adminAnon',false);
    const author = (adminAnon&&rank(req.user)>=2)?'Анонимный админ':req.user.display_name;
    const text = (req.body?.text||'').slice(0,1000);
    const info = db.prepare('INSERT INTO posts(topic_id,user_id,author,text,image,created_at) VALUES(?,?,?,?,?,?)')
      .run(t.id, req.user.id, author, text, rel, Date.now());
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(info.lastInsertRowid);
    io.to('topic:'+t.id).emit('post:new', p);
    const cnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE topic_id=?').get(t.id).c;
    io.emit('topic:posts_count', { topicId:t.id, count:cnt });
    res.json({post:p});
  });
});

app.delete('/api/posts/:id', requireAuth, (req,res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(+req.params.id);
  if (!p) return res.status(404).json({error:'Не найден'});
  if (p.user_id!==req.user.id&&rank(req.user)<1) return res.status(403).json({error:'Нет прав'});
  if (p.image) removeFile(p.image);
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  io.to('topic:'+p.topic_id).emit('post:deleted', { id:p.id });
  res.json({ok:true});
});

// ── SETTINGS ──────────────────────────────────────────────────────
app.get('/api/settings', (req,res) => {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k, DEFAULT_SETTINGS[k]);
  res.json({settings:out});
});

app.patch('/api/settings', requireAdmin, (req,res) => {
  const upd = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (req.body&&k in req.body) { setSetting(k,req.body[k]); upd[k]=req.body[k]; }
  audit(req.user,'update_settings',JSON.stringify(upd));
  io.emit('settings:updated', upd);
  res.json({ok:true, settings:upd});
});

app.get('/api/stats', (req,res) => res.json({
  users:    db.prepare('SELECT COUNT(*) c FROM users').get().c,
  profiles: db.prepare('SELECT COUNT(*) c FROM profiles').get().c,
  topics:   db.prepare('SELECT COUNT(*) c FROM topics').get().c,
  posts:    db.prepare('SELECT COUNT(*) c FROM posts').get().c
}));

app.get('/api/audit', requireAdmin, (req,res) => {
  res.json({log: db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all()});
});

// STATIC
app.use(express.static(path.join(__dirname, 'public')));
app.use((err,_req,res,_next) => { console.error(err); res.status(500).json({error:'Внутренняя ошибка'}); });

server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Uploads: ${UPLOADS_DIR}`);
});
