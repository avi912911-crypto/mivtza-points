const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// On Railway only an attached Volume survives a redeploy, so its mount path wins over everything else.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const STORAGE_TEMPORARY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME)
  && !process.env.RAILWAY_VOLUME_MOUNT_PATH;
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

// v2: a class ("group") belongs to one teacher and one shift, and each student has a
// morning group and an afternoon group that can differ.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    return true;
  }
  return false;
}
if (addColumn('classes', 'shift', "TEXT NOT NULL DEFAULT 'morning'")) {
  db.exec('ALTER TABLE classes ADD COLUMN teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  db.exec('UPDATE classes SET teacher_id = morning_teacher_id');
}
if (addColumn('students', 'morning_class_id', 'INTEGER REFERENCES classes(id) ON DELETE SET NULL')) {
  db.exec('ALTER TABLE students ADD COLUMN afternoon_class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL');
  db.exec('UPDATE students SET morning_class_id = class_id');
}
// v3: items entered by the secretary on one list of all students (e.g. the Tuesday talk)
if (addColumn('items', 'general', 'INTEGER NOT NULL DEFAULT 0')) {
  db.exec(`UPDATE items SET general = 1, shift = 'office' WHERE name = 'שיחה יום ג''' OR name LIKE 'שיחה%'`);
}
// v4: phone numbers for the points phone line (several allowed, separated by commas)
addColumn('students', 'phone', "TEXT NOT NULL DEFAULT ''");
// v5: extra teachers who may enter points for a group besides its own teacher
db.exec(`CREATE TABLE IF NOT EXISTS class_helpers (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, user_id)
)`);

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

module.exports = { db, DB_PATH, STORAGE_TEMPORARY, hashPassword, checkPassword, getSettings, backup };
