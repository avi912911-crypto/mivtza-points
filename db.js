const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'mivtza.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','secretary','teacher')),
  can_office INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  morning_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  afternoon_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1
);
-- kind: daily = every study day; weekly = once a week; exam = once a week, entered as a grade
-- shift: morning / afternoon teacher of the class, or office (secretary + authorised teacher)
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly','exam')),
  shift TEXT NOT NULL CHECK (shift IN ('morning','afternoon','office')),
  points INTEGER NOT NULL DEFAULT 0,
  days TEXT NOT NULL DEFAULT '0,1,2,3,4',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS weeks (
  id INTEGER PRIMARY KEY,
  start_date TEXT UNIQUE NOT NULL,
  parasha TEXT NOT NULL DEFAULT '',
  vacation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS days_off (
  date TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT ''
);
-- daily items: date = the day; weekly/exam items: date = the week's Sunday
CREATE TABLE IF NOT EXISTS entries (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (student_id, item_id, date)
);
CREATE TABLE IF NOT EXISTS bonuses (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

const DEFAULT_SETTINGS = {
  program_name: 'מבצע חורף תשפ"ז',
  target: '3800',
  edit_days: '2',
  logo: '',
  // grade >= min gives points; checked from the top down
  exam_rules: JSON.stringify([
    { min: 90, points: 50 },
    { min: 80, points: 40 },
    { min: 70, points: 30 },
  ]),
};

const DEFAULT_ITEMS = [
  ['שחרית', 'daily', 'morning', 5],
  ["סדר א'", 'daily', 'morning', 4],
  ['שיעור בוקר', 'daily', 'morning', 4],
  ['מנחה', 'daily', 'afternoon', 3],
  ["סדר ב'", 'daily', 'afternoon', 4],
  ['שיעור אחה"צ', 'daily', 'afternoon', 4],
  ['מעריב', 'daily', 'afternoon', 3],
  ["סדר ג'", 'daily', 'afternoon', 4],
  ['שחרית עש"ק', 'weekly', 'office', 8, '5'],
  ["שיחה יום ג'", 'weekly', 'afternoon', 8, '2'],
  ['שחרית שב"ק', 'weekly', 'office', 8, '6'],
  ['מבחן בוקר', 'exam', 'morning', 50, ''],
  ['מבחן אחה"צ', 'exam', 'afternoon', 50, ''],
];

function seed() {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  if (db.prepare('SELECT COUNT(*) AS n FROM items').get().n === 0) {
    const ins = db.prepare('INSERT INTO items (name, kind, shift, points, days, sort) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_ITEMS.forEach(([name, kind, shift, points, days], i) =>
      ins.run(name, kind, shift, points, days ?? '0,1,2,3,4', i));
  }

  // Without ADMIN_PASSWORD the first visitor to the site creates the admin account (see /api/setup).
  if (process.env.ADMIN_PASSWORD && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    db.prepare(`INSERT INTO users (username, password_hash, display_name, role, can_office, must_change)
                VALUES (?, ?, 'מנהל', 'admin', 1, 1)`)
      .run(process.env.ADMIN_USERNAME || 'admin', hashPassword(process.env.ADMIN_PASSWORD));
  }
}
seed();

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function backup() {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mivtza-${new Date().toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().slice(0, -14);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return file;
}

module.exports = { db, DB_PATH, hashPassword, checkPassword, getSettings, backup };
