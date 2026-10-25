const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { db, DB_PATH, STORAGE_TEMPORARY, hashPassword, checkPassword, getSettings, backup } = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
// no-cache: browsers re-check (cheaply, by ETag) so an update shows up without a hard refresh
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: res => res.set('Cache-Control', 'no-cache') }));

const SESSION_DAYS = 30;
const PARASHOT = [
  'בראשית', 'נח', 'לך לך', 'וירא', 'חיי שרה', 'תולדות', 'ויצא', 'וישלח', 'וישב', 'מקץ', 'ויגש', 'ויחי',
  'שמות', 'וארא', 'בא', 'בשלח', 'יתרו', 'משפטים', 'תרומה', 'תצוה', 'כי תשא', 'ויקהל', 'פקודי',
  'ויקרא', 'צו', 'שמיני', 'תזריע', 'מצורע', 'אחרי מות', 'קדושים', 'אמור', 'בהר', 'בחוקותי',
];

// ---------- dates (all as YYYY-MM-DD strings, Israel time) ----------

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}
function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStart(date) {
  return addDays(date, -weekday(date));
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
// The week people report on by default: on Sunday they still report the week that just ended.
function reportDay() {
  const t = today();
  return weekday(t) === 0 ? addDays(t, -7) : t;
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------- helpers ----------

function audit(userId, action, detail) {
  db.prepare('INSERT INTO audit (at, user_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), userId, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function examPoints(grade, rules) {
  for (const r of rules) if (grade >= r.min) return r.points;
  return 0;
}

function pointsFor(item, value, rules) {
  if (value == null) return 0;
  // daily items hold the number of times attended that week; weekly items hold 1
  return item.kind === 'exam' ? examPoints(value, rules) : item.points * value;
}

// Daily items used to be stored one row per day. They are now one row per week holding a count,
// so any per-day rows are folded into their week once.
function migrateToWeeklyCounts() {
  if (getSettings().entry_mode === 'weekly_counts') return;
  const rows = db.prepare(`SELECT e.* FROM entries e JOIN items i ON i.id = e.item_id WHERE i.kind = 'daily'`).all();
  const merged = new Map();
  for (const r of rows) {
    const key = `${r.student_id}:${r.item_id}:${weekStart(r.date)}`;
    const m = merged.get(key);
    if (m) { m.value += r.value; if (r.updated_at > m.updated_at) Object.assign(m, { updated_at: r.updated_at, updated_by: r.updated_by }); }
    else merged.set(key, { ...r, date: weekStart(r.date) });
  }
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM entries WHERE item_id IN (SELECT id FROM items WHERE kind = 'daily')`);
    const ins = db.prepare('INSERT INTO entries (student_id, item_id, date, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of merged.values()) ins.run(m.student_id, m.item_id, m.date, m.value, m.updated_by, m.updated_at);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('entry_mode', 'weekly_counts')`).run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (rows.length) console.log(`Folded ${rows.length} daily entries into ${merged.size} weekly counts`);
}
migrateToWeeklyCounts();

// How many study days of the week an item can be attended on (its weekdays, minus days off).
function maxCount(item, ws, daysOff) {
  return item.days.split(',').filter(Boolean)
    .filter(d => !daysOff.has(addDays(ws, Number(d)))).length;
}

function wrap(fn) {
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  };
}
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

// ---------- auth ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function auth(req, res, next) {
  const token = parseCookies(req).sid;
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires > ? AND u.active = 1`).get(token, Date.now());
    if (row) {
      req.user = row;
      return next();
    }
  }
  res.status(401).json({ error: 'יש להתחבר מחדש' });
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'אין הרשאה' });
const staff = requireRole('admin', 'secretary');
const adminOnly = requireRole('admin');

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role,
           can_office: !!u.can_office, must_change: !!u.must_change };
}

const needsSetup = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;

app.get('/api/public', wrap(() => {
  const s = getSettings();
  return { program_name: s.program_name, logo: s.logo, needs_setup: needsSetup(), storage_temporary: STORAGE_TEMPORARY };
}));

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now() + SESSION_DAYS * 86400000);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}

// First run only: creates the admin account while the system has no users.
app.post('/api/setup', wrap((req, res) => {
  if (!needsSetup()) fail(403, 'המערכת כבר הוגדרה');
  const { username, display_name, password } = req.body || {};
  if (!username || !password) fail(400, 'יש למלא שם משתמש וסיסמה');
  if (String(password).length < 6) fail(400, 'הסיסמה צריכה להיות לפחות 6 תווים');
  const id = db.prepare(`INSERT INTO users (username, password_hash, display_name, role, can_office)
                         VALUES (?, ?, ?, 'admin', 1)`)
    .run(String(username).trim(), hashPassword(String(password)), String(display_name || 'מנהל').trim()).lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  startSession(req, res, user);
  return { user: publicUser(user) };
}));

app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user || !checkPassword(String(password || ''), user.password_hash)) fail(401, 'שם משתמש או סיסמה שגויים');
  startSession(req, res, user);
  return { user: publicUser(user) };
}));

app.post('/api/logout', wrap((req, res) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
}));

// ---------- phone line (Yemot HaMashiach API extension) ----------

// Israeli numbers in any form (+972-50..., 050-...) become 05.... Several numbers are kept comma-separated.
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  if (d && !d.startsWith('0')) d = '0' + d;
  return d.length >= 9 ? d : '';
}
function cleanPhones(v) {
  return [...new Set(String(v || '').split(/[,;/\n]|\s{2,}/).map(normPhone).filter(Boolean))].join(', ');
}

// A number may belong to one student only, so the line knows whose points to read.
function checkPhonesFree(phones, exceptId) {
  if (!phones) return;
  const mine = phones.split(', ');
  for (const s of db.prepare('SELECT id, first_name, last_name, phone FROM students WHERE active = 1 AND id != ?').all(exceptId || 0)) {
    const dup = s.phone.split(',').map(x => x.trim()).find(x => mine.includes(x));
    if (dup) fail(400, `המספר ${dup} כבר רשום אצל ${`${s.first_name} ${s.last_name}`.trim()}`);
  }
}

function yemotToken() {
  let t = getSettings().yemot_token;
  if (!t) {
    t = crypto.randomBytes(12).toString('hex');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('yemot_token', ?)").run(t);
  }
  return t;
}

// Yemot calls this with the caller's number (ApiPhone) and reads the answer aloud.
// The reply is Yemot's API text format: parts separated by '.', 't-' = text to speech.
app.all('/yemot/points', express.urlencoded({ extended: false }), (req, res) => {
  const q = { ...req.query, ...(req.body || {}) };
  const say = parts => parts.map(p => 't-' + String(p).replace(/[.,&=\-"]/g, ' ').replace(/\s+/g, ' ').trim()).join('.');
  res.type('text/plain; charset=utf-8');
  try {
  if (!q.token || q.token !== yemotToken()) return res.status(403).send('id_list_message=' + say(['אין הרשאה']) + '&go_to_folder=/hangup');
  const phone = normPhone(q.ApiPhone);
  const student = phone && db.prepare('SELECT * FROM students WHERE active = 1').all()
    .find(s => s.phone.split(',').map(x => x.trim()).includes(phone));
  if (!student) {
    return res.send('id_list_message=' + say(['מספר הטלפון שממנו התקשרת לא רשום במערכת הנקודות', 'לרישום יש לפנות למזכירות']) + '&go_to_folder=/hangup');
  }
  const { perStudent, weeks, target } = computeTotals();
  const st = perStudent.get(student.id) || { total: 0, byWeek: {} };
  const cur = progressInfo(weeks, target).current;
  const week = cur ? (st.byWeek[cur.start_date] || 0) : 0;
  const left = Math.max(0, target - st.total);
  const parts = [`צברת עד עכשיו ${st.total} נקודות`];
  if (cur) parts.push(`השבוע צברת ${week} נקודות`);
  parts.push(left ? `נשארו לך ${left} נקודות כדי להגיע ליעד` : 'כל הכבוד הגעת ליעד');
  audit(null, 'phone-check', { student: student.id });
  res.send('id_list_message=' + say(parts) + '&go_to_folder=/hangup');
  } catch (e) {
    console.error('yemot', e);
    res.send('id_list_message=' + say(['אירעה תקלה', 'נא לנסות שוב מאוחר יותר']) + '&go_to_folder=/hangup');
  }
});

app.use('/api', auth);

app.get('/api/me', wrap(req => {
  const s = getSettings();
  return {
    user: publicUser(req.user),
    settings: { program_name: s.program_name, logo: s.logo, target: Number(s.target),
                edit_days: Number(s.edit_days), exam_rules: JSON.parse(s.exam_rules) },
    today: today(),
    report_day: reportDay(),
  };
}));

app.post('/api/me/password', wrap(req => {
  const { current, password } = req.body || {};
  if (!checkPassword(String(current || ''), req.user.password_hash)) fail(400, 'הסיסמה הנוכחית שגויה');
  if (!password || String(password).length < 6) fail(400, 'הסיסמה צריכה להיות לפחות 6 תווים');
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(String(password)), req.user.id);
  return { ok: true };
}));

// ---------- program data used everywhere ----------

function programWeeks() {
  return db.prepare('SELECT * FROM weeks ORDER BY start_date').all();
}

function weekFor(date) {
  return db.prepare('SELECT * FROM weeks WHERE start_date = ?').get(weekStart(date)) || null;
}

// Groups a teacher may work with: their own, and those an admin added them to as an extra teacher.
function teacherClassIds(userId) {
  return new Set(db.prepare(`SELECT id FROM classes WHERE teacher_id = ?
    UNION SELECT class_id FROM class_helpers WHERE user_id = ?`).all(userId, userId).map(r => r.id));
}

// Each group has one shift; office items (Friday/Shabbat) are open to staff and authorised teachers in every group.
function shiftsFor(user, cls) {
  const out = [];
  if (user.role !== 'teacher' || teacherClassIds(user.id).has(cls.id)) out.push(cls.shift);
  if (user.role !== 'teacher' || user.can_office) out.push('office');
  return out;
}

const groupColumn = cls => cls.shift === 'afternoon' ? 'afternoon_class_id' : 'morning_class_id';

function accessibleClasses(user) {
  const all = db.prepare('SELECT * FROM classes ORDER BY shift DESC, sort, name').all();
  return all
    .map(c => ({ ...c, shifts: shiftsFor(user, c) }))
    .filter(c => c.shifts.length > 0);
}

// Teachers may change a week up to edit_days after its Saturday.
function isLocked(user, lastDay) {
  if (user.role !== 'teacher') return false;
  const t = today();
  const age = daysBetween(lastDay, t);
  const edit = Number(getSettings().edit_days);
  return age > edit;
}

// ---------- daily / weekly entry ----------

app.get('/api/entry/classes', wrap(req => ({
  classes: accessibleClasses(req.user).map(c => ({ id: c.id, name: c.name, shift: c.shift, shifts: c.shifts })),
})));

function entryContext(req, classId, date) {
  if (!isDate(date)) fail(400, 'תאריך לא תקין');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(classId));
  if (!cls) fail(404, 'קבוצה לא נמצאה');
  const shifts = shiftsFor(req.user, cls);
  if (!shifts.length) fail(403, 'אין הרשאה לקבוצה זו');

  const key = weekStart(date);
  const lastDay = addDays(key, 6);
  const daysOff = weekDaysOff(key);
  const items = weekItems(key, daysOff).filter(it => !it.general && shifts.includes(it.shift));
  return { cls, items, key, lastDay, daysOff };
}

// Active items with the most a student can get in the given week
function weekItems(key, daysOff) {
  return db.prepare('SELECT * FROM items WHERE active = 1 ORDER BY sort, id').all()
    .map(it => ({ ...it, max: it.kind === 'daily' ? maxCount(it, key, daysOff) : it.kind === 'weekly' ? 1 : 100 }))
    .filter(it => it.max > 0);
}

function weekDaysOff(key) {
  return new Set(db.prepare('SELECT date FROM days_off WHERE date BETWEEN ? AND ?').all(key, addDays(key, 6)).map(d => d.date));
}

function readValues(key, items, students) {
  const values = {};
  if (items.length && students.length) {
    const rows = db.prepare(`SELECT student_id, item_id, value FROM entries
      WHERE date = ? AND item_id IN (${items.map(() => '?').join(',')})
      AND student_id IN (${students.map(() => '?').join(',')})`)
      .all(key, ...items.map(i => i.id), ...students.map(s => s.id));
    for (const r of rows) values[`${r.student_id}:${r.item_id}`] = r.value;
  }
  return values;
}

function saveChanges(user, items, studentIds, key, changes) {
  if (!Array.isArray(changes)) fail(400, 'נתונים חסרים');
  const allowedItems = new Map(items.map(i => [i.id, i]));
  const upsert = db.prepare(`INSERT INTO entries (student_id, item_id, date, value, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (student_id, item_id, date)
    DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM entries WHERE student_id = ? AND item_id = ? AND date = ?');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const c of changes) {
      const item = allowedItems.get(Number(c.item_id));
      if (!item || !studentIds.has(Number(c.student_id))) fail(400, 'שינוי לא מורשה');
      if (c.value === null || c.value === '' || c.value === 0 && item.kind !== 'exam') {
        del.run(c.student_id, item.id, key);
      } else {
        const v = Number(c.value);
        const min = item.kind === 'exam' ? 0 : 1;
        if (!Number.isInteger(v) || v < min || v > item.max) fail(400, `ערך לא תקין ב${item.name}`);
        upsert.run(c.student_id, item.id, key, v, user.id, now);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

app.get('/api/entry', wrap(req => {
  const { class_id, date } = req.query;
  const { cls, items, key, lastDay, daysOff } = entryContext(req, class_id, date);
  const students = db.prepare(`SELECT id, first_name, last_name FROM students
                               WHERE ${groupColumn(cls)} = ? AND active = 1 ORDER BY last_name, first_name`).all(cls.id);
  const values = readValues(key, items, students);
  return {
    class: { id: cls.id, name: cls.name, shift: cls.shift },
    items, students, values,
    locked: isLocked(req.user, lastDay),
    future: key > today(),
    days_off: db.prepare('SELECT * FROM days_off WHERE date IN (' + [...daysOff].map(() => '?').join(',') + ') ORDER BY date').all(...daysOff),
    week: weekFor(key),
    week_start: key,
  };
}));

app.post('/api/entry', wrap(req => {
  const { class_id, date, changes } = req.body || {};
  const { cls, items, key, lastDay } = entryContext(req, class_id, date);
  if (isLocked(req.user, lastDay)) fail(403, 'הזמן לעדכון השבוע הזה עבר. פנה למזכיר.');
  if (key > today()) fail(400, 'אי אפשר להזין שבוע עתידי');
  const studentIds = new Set(db.prepare(`SELECT id FROM students WHERE ${groupColumn(cls)} = ?`).all(cls.id).map(s => s.id));
  saveChanges(req.user, items, studentIds, key, changes);
  audit(req.user.id, 'entry', { class: cls.name, week: key, count: changes.length });
  return { ok: true };
}));

// Staff fix entries saved on the wrong week: move a group's values for this screen's items to another week.
app.post('/api/entry/move', staff, wrap(req => {
  const { class_id, from, to, overwrite } = req.body || {};
  if (!isDate(to)) fail(400, 'יש לבחור שבוע יעד');
  const { cls, items, key } = entryContext(req, class_id, from);
  const target = weekStart(to);
  if (target === key) fail(400, 'זה אותו שבוע');
  if (target > today()) fail(400, 'אי אפשר להעביר לשבוע עתידי');
  const targetMax = new Map(weekItems(target, weekDaysOff(target)).map(it => [it.id, it.max]));
  const ids = items.map(i => i.id);
  const students = db.prepare(`SELECT id FROM students WHERE ${groupColumn(cls)} = ?`).all(cls.id).map(s => s.id);
  if (!ids.length || !students.length) fail(400, 'אין מה להעביר');
  const where = `item_id IN (${ids.map(() => '?').join(',')}) AND student_id IN (${students.map(() => '?').join(',')})`;
  const rows = db.prepare(`SELECT * FROM entries WHERE date = ? AND ${where}`).all(key, ...ids, ...students);
  if (!rows.length) fail(400, 'אין ערכים בשבוע הזה להעברה');
  const clash = db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE date = ? AND ${where}`).get(target, ...ids, ...students).n;
  if (clash && !overwrite) fail(409, `בשבוע היעד כבר יש ${clash} ערכים לקבוצה הזו. סמן "להחליף" כדי שהערכים מהשבוע הזה יחליפו אותם.`);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO entries (student_id, item_id, date, value, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (student_id, item_id, date)
    DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  let moved = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const max = targetMax.get(r.item_id);
      if (max) { ins.run(r.student_id, r.item_id, target, Math.min(r.value, max), req.user.id, now); moved++; }
    }
    db.prepare(`DELETE FROM entries WHERE date = ? AND ${where}`).run(key, ...ids, ...students);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit(req.user.id, 'entry-move', { class: cls.name, from: key, to: target, count: moved });
  return { moved, to: target };
}));

// ---------- general list (secretary): all students A-Z ----------

const staffOnly = user => { if (user.role === 'teacher') fail(403, 'רק למזכיר ולמנהל'); };
const hebSort = (a, b) => a.name.localeCompare(b.name, 'he');

// reg: 'yes' = only registered students, 'no' = only unregistered, otherwise everyone
const regFilter = reg => s => reg === 'yes' ? s.registered : reg === 'no' ? !s.registered : true;

function generalContext(date, reg) {
  if (!isDate(date)) fail(400, 'תאריך לא תקין');
  const key = weekStart(date);
  const daysOff = weekDaysOff(key);
  const items = weekItems(key, daysOff).filter(it => it.general);
  const names = new Map(db.prepare('SELECT id, name FROM classes').all().map(c => [c.id, c.name]));
  const students = db.prepare('SELECT * FROM students WHERE active = 1').all().filter(regFilter(reg)).map(s => ({
    id: s.id, first_name: s.first_name, last_name: s.last_name,
    name: `${s.first_name} ${s.last_name}`.trim(),
    morning: names.get(s.morning_class_id) || '', afternoon: names.get(s.afternoon_class_id) || '',
  })).sort(hebSort);
  return { key, daysOff, items, students };
}

app.get('/api/general', wrap(req => {
  staffOnly(req.user);
  const { key, daysOff, items, students } = generalContext(req.query.date, req.query.reg);
  return {
    items, students, values: readValues(key, items, students),
    locked: false, future: key > today(),
    days_off: db.prepare('SELECT * FROM days_off WHERE date IN (' + [...daysOff].map(() => '?').join(',') + ') ORDER BY date').all(...daysOff),
    week: weekFor(key), week_start: key,
  };
}));

app.post('/api/general', wrap(req => {
  staffOnly(req.user);
  const { date, changes } = req.body || {};
  const { key, items, students } = generalContext(date);
  if (key > today()) fail(400, 'אי אפשר להזין שבוע עתידי');
  saveChanges(req.user, items, new Set(students.map(s => s.id)), key, changes);
  audit(req.user.id, 'entry', { class: 'רשימה כללית', week: key, count: changes.length });
  return { ok: true };
}));

// ---------- scoring ----------

function computeTotals() {
  const s = getSettings();
  const rules = JSON.parse(s.exam_rules);
  const items = new Map(db.prepare('SELECT * FROM items').all().map(i => [i.id, i]));
  const weeks = programWeeks();
  const vacation = new Set(weeks.filter(w => w.vacation).map(w => w.start_date));
  const perStudent = new Map(); // id -> { total, byWeek: {start: pts}, byItem: {id: pts} }
  const get = id => {
    if (!perStudent.has(id)) perStudent.set(id, { total: 0, byWeek: {}, byItem: {} });
    return perStudent.get(id);
  };
  for (const e of db.prepare('SELECT student_id, item_id, date, value FROM entries').all()) {
    const item = items.get(e.item_id);
    if (!item) continue;
    const ws = weekStart(e.date);
    if (vacation.has(ws)) continue;
    const pts = pointsFor(item, e.value, rules);
    const st = get(e.student_id);
    st.total += pts;
    st.byWeek[ws] = (st.byWeek[ws] || 0) + pts;
    st.byItem[item.id] = (st.byItem[item.id] || 0) + pts;
  }
  for (const b of db.prepare('SELECT student_id, week_start, points FROM bonuses').all()) {
    const st = get(b.student_id);
    st.total += b.points;
    st.byWeek[b.week_start] = (st.byWeek[b.week_start] || 0) + b.points;
    st.byItem.bonus = (st.byItem.bonus || 0) + b.points;
  }
  return { perStudent, weeks, target: Number(s.target) };
}

function progressInfo(weeks, target) {
  const t = today();
  const active = weeks.filter(w => !w.vacation);
  const totalWeeks = active.length || 19;
  const current = weeks.find(w => w.start_date <= t && t < addDays(w.start_date, 7)) || null;
  const completed = active.filter(w => addDays(w.start_date, 7) <= t).length;
  const weekly = target / totalWeeks;
  return { current, totalWeeks, completed, weekly, expectedSoFar: Math.round(weekly * completed) };
}

app.get('/api/dashboard', wrap(req => {
  const { perStudent, weeks, target } = computeTotals();
  const info = progressInfo(weeks, target);
  const visible = req.user.role === 'teacher'
    ? teacherClassIds(req.user.id)
    : null;
  const classes = db.prepare('SELECT * FROM classes ORDER BY shift DESC, sort, name').all()
    .filter(c => !visible || visible.has(c.id));
  const students = db.prepare('SELECT * FROM students WHERE active = 1').all()
    .filter(s => !visible || visible.has(s.morning_class_id) || visible.has(s.afternoon_class_id));
  const allById = new Map(db.prepare('SELECT id, name FROM classes').all().map(c => [c.id, c]));
  const curStart = info.current?.start_date;

  const rows = students.map(s => {
    const st = perStudent.get(s.id) || { total: 0, byWeek: {} };
    return {
      id: s.id, name: `${s.first_name} ${s.last_name}`.trim(),
      morning_class_id: s.morning_class_id, afternoon_class_id: s.afternoon_class_id,
      class_name: [allById.get(s.morning_class_id)?.name, allById.get(s.afternoon_class_id)?.name].filter(Boolean).join(' / '),
      total: st.total, week: curStart ? (st.byWeek[curStart] || 0) : 0,
      on_track: st.total >= info.expectedSoFar,
    };
  });

  const classStats = classes.map(c => {
    const members = rows.filter(r => r[groupColumn(c)] === c.id);
    const n = members.length || 1;
    return {
      id: c.id, name: c.name, shift: c.shift, students: members.length,
      avg_total: Math.round(members.reduce((a, r) => a + r.total, 0) / n),
      avg_week: Math.round(members.reduce((a, r) => a + r.week, 0) / n),
      on_track: members.filter(r => r.on_track).length,
    };
  }).sort((a, b) => b.avg_total - a.avg_total);

  // From Thursday on: groups with nothing entered yet for this week
  const t = today();
  const missing = [];
  if (weekday(t) >= 4) {
    const ws = weekStart(t);
    for (const c of classes) {
      const ids = db.prepare(`SELECT id FROM items WHERE active = 1 AND general = 0 AND shift = ?`).all(c.shift).map(i => i.id);
      if (!ids.length) continue;
      const has = db.prepare(`SELECT 1 FROM entries e JOIN students s ON s.id = e.student_id
        WHERE s.${groupColumn(c)} = ? AND e.date = ? AND e.item_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`)
        .get(c.id, ws, ...ids);
      if (!has) missing.push({ class_name: c.name, shift: c.shift });
    }
  }

  const sum = rows.reduce((a, r) => a + r.total, 0);
  return {
    target, ...info,
    total_points: sum,
    student_count: rows.length,
    on_track_count: rows.filter(r => r.on_track).length,
    reached_target: rows.filter(r => r.total >= target).length,
    classes: classStats,
    top_week: [...rows].sort((a, b) => b.week - a.week).slice(0, 10),
    top_total: [...rows].sort((a, b) => b.total - a.total).slice(0, 10),
    missing_week: missing,
  };
}));

function canSeeClass(user, classId) {
  if (user.role !== 'teacher') return true;
  const c = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  return !!c && teacherClassIds(user.id).has(c.id);
}

app.get('/api/classes/:id/summary', wrap(req => {
  const id = Number(req.params.id);
  if (!canSeeClass(req.user, id)) fail(403, 'אין הרשאה');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) fail(404, 'קבוצה לא נמצאה');
  const { perStudent, weeks, target } = computeTotals();
  const students = db.prepare(`SELECT * FROM students WHERE ${groupColumn(cls)} = ? AND active = 1 ORDER BY last_name, first_name`).all(id);
  return {
    class: cls, weeks, target, ...progressInfo(weeks, target),
    students: students.map(s => {
      const st = perStudent.get(s.id) || { total: 0, byWeek: {} };
      return { id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), total: st.total, byWeek: st.byWeek };
    }),
  };
}));

app.get('/api/students/:id/card', wrap(req => {
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(req.params.id));
  if (!s || !(canSeeClass(req.user, s.morning_class_id) || canSeeClass(req.user, s.afternoon_class_id))) fail(404, 'תלמיד לא נמצא');
  const { perStudent, weeks, target } = computeTotals();
  const st = perStudent.get(s.id) || { total: 0, byWeek: {}, byItem: {} };
  const name = id => db.prepare('SELECT name FROM classes WHERE id = ?').get(id)?.name || '';
  const bonuses = db.prepare('SELECT * FROM bonuses WHERE student_id = ? ORDER BY week_start').all(s.id);
  return {
    student: { ...s, morning_class_name: name(s.morning_class_id), afternoon_class_name: name(s.afternoon_class_id) },
    total: st.total, byWeek: st.byWeek, byItem: st.byItem, bonuses,
    items: db.prepare('SELECT id, name FROM items ORDER BY sort, id').all(),
    weeks, target, ...progressInfo(weeks, target),
  };
}));

// ---------- weekly report ----------

// Points for the chosen week and the running total up to the end of that week.
app.get('/api/report', wrap(req => {
  const { perStudent, weeks, target } = computeTotals();
  const week = weeks.find(w => w.start_date === req.query.week)
    || weeks.find(w => w.start_date === weekStart(reportDay()))
    || progressInfo(weeks, target).current || weeks[weeks.length - 1] || null;
  const own = req.user.role === 'teacher'
    ? teacherClassIds(req.user.id)
    : null;
  const groups = db.prepare('SELECT id, name, shift FROM classes ORDER BY shift DESC, sort, name').all()
    .filter(c => !own || own.has(c.id));
  const groupId = Number(req.query.class_id) || null;
  const group = groupId ? groups.find(c => c.id === groupId) : null;
  if (groupId && !group) fail(403, 'אין הרשאה לקבוצה זו');
  const names = new Map(db.prepare('SELECT id, name FROM classes').all().map(c => [c.id, c.name]));

  const students = db.prepare('SELECT * FROM students WHERE active = 1').all().filter(s => group
    ? s[groupColumn(group)] === group.id
    : !own || own.has(s.morning_class_id) || own.has(s.afternoon_class_id)).filter(regFilter(req.query.reg));
  const ws = week?.start_date;
  const rows = students.map(s => {
    const st = perStudent.get(s.id) || { byWeek: {} };
    const total = Object.entries(st.byWeek).filter(([d]) => !ws || d <= ws).reduce((a, [, p]) => a + p, 0);
    return {
      id: s.id, name: `${s.first_name} ${s.last_name}`.trim(),
      morning: names.get(s.morning_class_id) || '', afternoon: names.get(s.afternoon_class_id) || '',
      week: ws ? (st.byWeek[ws] || 0) : 0, total,
      remaining_pct: Math.max(0, Math.round(100 * (target - total) / target)),
    };
  });
  const active = weeks.filter(w => !w.vacation);
  return {
    week, week_number: week ? active.findIndex(w => w.start_date === week.start_date) + 1 : 0,
    total_weeks: active.length, target, weeks, groups, group, rows,
  };
}));

// ---------- bonuses (secretary + admin) ----------

app.post('/api/bonuses', staff, wrap(req => {
  const { student_id, date, points, reason } = req.body || {};
  if (!isDate(date) || !Number.isInteger(Number(points))) fail(400, 'נתונים חסרים');
  db.prepare('INSERT INTO bonuses (student_id, week_start, points, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Number(student_id), weekStart(date), Number(points), String(reason || ''), req.user.id, new Date().toISOString());
  audit(req.user.id, 'bonus', { student_id, points, reason });
  return { ok: true };
}));

app.delete('/api/bonuses/:id', staff, wrap(req => {
  db.prepare('DELETE FROM bonuses WHERE id = ?').run(Number(req.params.id));
  audit(req.user.id, 'bonus-delete', req.params.id);
  return { ok: true };
}));

// ---------- admin: users ----------

app.get('/api/admin/users', staff, wrap(() => ({
  users: db.prepare('SELECT id, username, display_name, role, can_office, active FROM users ORDER BY role, display_name').all(),
})));

app.post('/api/admin/users', adminOnly, wrap(req => {
  const { username, display_name, role, password, can_office } = req.body || {};
  if (!username || !display_name || !password) fail(400, 'יש למלא שם משתמש, שם וסיסמה');
  if (!['admin', 'secretary', 'teacher'].includes(role)) fail(400, 'תפקיד לא תקין');
  if (String(password).length < 6) fail(400, 'הסיסמה צריכה להיות לפחות 6 תווים');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(String(username).trim())) fail(400, 'שם המשתמש כבר קיים');
  db.prepare(`INSERT INTO users (username, password_hash, display_name, role, can_office, must_change)
              VALUES (?, ?, ?, ?, ?, 1)`)
    .run(String(username).trim(), hashPassword(String(password)), display_name, role, can_office ? 1 : 0);
  // Groups imported under this teacher's name are linked to the new account
  if (role === 'teacher') {
    const uid = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim()).id;
    db.prepare('UPDATE classes SET teacher_id = ? WHERE teacher_id IS NULL AND TRIM(name) = TRIM(?)').run(uid, display_name);
  }
  audit(req.user.id, 'user-create', username);
  return { ok: true };
}));

app.put('/api/admin/users/:id', adminOnly, wrap(req => {
  const id = Number(req.params.id);
  const { display_name, role, can_office, active, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) fail(404, 'משתמש לא נמצא');
  if (id === req.user.id && (role !== 'admin' || !active)) fail(400, 'אי אפשר להוריד הרשאת מנהל מעצמך');
  db.prepare('UPDATE users SET display_name = ?, role = ?, can_office = ?, active = ? WHERE id = ?')
    .run(display_name || u.display_name, role || u.role, can_office ? 1 : 0, active ? 1 : 0, id);
  if (password) {
    if (String(password).length < 6) fail(400, 'הסיסמה צריכה להיות לפחות 6 תווים');
    db.prepare('UPDATE users SET password_hash = ?, must_change = 1 WHERE id = ?').run(hashPassword(String(password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(id, req.user.id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(req.user.id, 'user-update', u.username);
  return { ok: true };
}));

// ---------- admin: classes ----------

app.get('/api/admin/classes', wrap(req => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.active = 1 AND
      (CASE c.shift WHEN 'afternoon' THEN s.afternoon_class_id ELSE s.morning_class_id END) = c.id) AS student_count
    FROM classes c ORDER BY shift DESC, sort, name`).all();
  const helpers = db.prepare('SELECT class_id, user_id FROM class_helpers').all();
  for (const c of rows) c.helpers = helpers.filter(h => h.class_id === c.id).map(h => h.user_id);
  return { classes: req.user.role === 'teacher' ? rows.filter(c => canSeeClass(req.user, c.id)) : rows };
}));

const SHIFTS = ['morning', 'afternoon'];

function setHelpers(classId, helpers, mainTeacher) {
  db.prepare('DELETE FROM class_helpers WHERE class_id = ?').run(classId);
  const ins = db.prepare('INSERT OR IGNORE INTO class_helpers (class_id, user_id) VALUES (?, ?)');
  for (const u of Array.isArray(helpers) ? helpers : []) if (Number(u) && Number(u) !== mainTeacher) ins.run(classId, Number(u));
}

app.post('/api/admin/classes', staff, wrap(req => {
  const { name, shift, teacher_id, sort, helpers } = req.body || {};
  if (!name) fail(400, 'יש למלא שם קבוצה');
  if (!SHIFTS.includes(shift)) fail(400, 'יש לבחור בוקר או אחה"צ');
  const r = db.prepare('INSERT INTO classes (name, shift, teacher_id, sort) VALUES (?, ?, ?, ?)')
    .run(name, shift, teacher_id || null, Number(sort) || 0);
  setHelpers(Number(r.lastInsertRowid), helpers, teacher_id);
  audit(req.user.id, 'class-create', name);
  return { ok: true };
}));

app.put('/api/admin/classes/:id', staff, wrap(req => {
  const { name, shift, teacher_id, sort, helpers } = req.body || {};
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cur) fail(404, 'קבוצה לא נמצאה');
  if (!SHIFTS.includes(shift)) fail(400, 'יש לבחור בוקר או אחה"צ');
  if (shift !== cur.shift && db.prepare(`SELECT 1 FROM students WHERE ${groupColumn(cur)} = ?`).get(id)) {
    fail(400, 'אי אפשר לשנות בוקר/אחה"צ לקבוצה שיש בה תלמידים');
  }
  db.prepare('UPDATE classes SET name = ?, shift = ?, teacher_id = ?, sort = ? WHERE id = ?')
    .run(name, shift, teacher_id || null, Number(sort) || 0, id);
  setHelpers(id, helpers, teacher_id);
  audit(req.user.id, 'class-update', name);
  return { ok: true };
}));

app.delete('/api/admin/classes/:id', staff, wrap(req => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM students WHERE active = 1 AND (morning_class_id = ? OR afternoon_class_id = ?)').get(id, id)) {
    fail(400, 'יש תלמידים בקבוצה. העבר אותם קודם.');
  }
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  audit(req.user.id, 'class-delete', id);
  return { ok: true };
}));

// ---------- admin: students ----------

app.get('/api/admin/students', staff, wrap(() => ({
  students: db.prepare(`SELECT s.*, m.name AS morning_class_name, a.name AS afternoon_class_name FROM students s
    LEFT JOIN classes m ON m.id = s.morning_class_id LEFT JOIN classes a ON a.id = s.afternoon_class_id
    ORDER BY s.active DESC, s.last_name, s.first_name`).all(),
})));

app.post('/api/admin/students', staff, wrap(req => {
  const { first_name, last_name, morning_class_id, afternoon_class_id, phone, registered } = req.body || {};
  if (!first_name) fail(400, 'יש למלא שם');
  checkPhonesFree(cleanPhones(phone));
  db.prepare('INSERT INTO students (first_name, last_name, morning_class_id, afternoon_class_id, phone, registered) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(first_name).trim(), String(last_name || '').trim(), morning_class_id || null, afternoon_class_id || null,
         cleanPhones(phone), registered ? 1 : 0);
  audit(req.user.id, 'student-create', `${first_name} ${last_name || ''}`);
  return { ok: true };
}));

app.put('/api/admin/students/:id', staff, wrap(req => {
  const { first_name, last_name, morning_class_id, afternoon_class_id, active, phone, registered } = req.body || {};
  checkPhonesFree(cleanPhones(phone), Number(req.params.id));
  db.prepare('UPDATE students SET first_name = ?, last_name = ?, morning_class_id = ?, afternoon_class_id = ?, active = ?, phone = ?, registered = ? WHERE id = ?')
    .run(String(first_name).trim(), String(last_name || '').trim(), morning_class_id || null, afternoon_class_id || null,
         active ? 1 : 0, cleanPhones(phone), registered ? 1 : 0, Number(req.params.id));
  audit(req.user.id, 'student-update', `${first_name} ${last_name || ''}`);
  return { ok: true };
}));

// Quick toggle from the students table
app.put('/api/admin/students/:id/registered', staff, wrap(req => {
  const s = db.prepare('SELECT first_name, last_name FROM students WHERE id = ?').get(Number(req.params.id));
  if (!s) fail(404, 'תלמיד לא נמצא');
  const registered = req.body?.registered ? 1 : 0;
  db.prepare('UPDATE students SET registered = ? WHERE id = ?').run(registered, Number(req.params.id));
  audit(req.user.id, 'student-update', `${s.first_name} ${s.last_name} · ${registered ? 'נרשם' : 'לא נרשם'}`);
  return { ok: true };
}));

// rows: [{ first_name, last_name, morning_class, afternoon_class, phone }]. Unknown groups are created,
// and a group named exactly like a teacher's display name is linked to that teacher.
// A row whose name matches an existing student only fills in that student's phone, so a list can be re-imported.
app.post('/api/admin/students/import', staff, wrap(req => {
  const { rows, phones_only, mark_registered } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) fail(400, 'אין שורות לייבוא');
  const notFound = [];
  const groups = new Map(db.prepare('SELECT id, name, shift FROM classes').all().map(c => [`${c.shift}:${c.name.trim()}`, c.id]));
  const teachers = new Map(db.prepare("SELECT id, display_name FROM users WHERE role = 'teacher'").all()
    .map(u => [u.display_name.trim(), u.id]));
  const insGroup = db.prepare('INSERT INTO classes (name, shift, teacher_id) VALUES (?, ?, ?)');
  const insStudent = db.prepare('INSERT INTO students (first_name, last_name, morning_class_id, afternoon_class_id, phone, registered) VALUES (?, ?, ?, ?, ?, ?)');
  const setRegistered = db.prepare('UPDATE students SET registered = 1 WHERE id = ?');
  const existing = new Map(db.prepare('SELECT id, first_name, last_name FROM students').all()
    .map(s => [`${s.first_name} ${s.last_name}`.replace(/\s+/g, ' ').trim(), s.id]));
  const setPhone = db.prepare('UPDATE students SET phone = ? WHERE id = ?');
  let added = 0, newGroups = 0, updated = 0, registered = 0;
  const groupId = (name, shift) => {
    name = String(name || '').trim();
    if (!name) return null;
    const key = `${shift}:${name}`;
    if (!groups.has(key)) {
      groups.set(key, Number(insGroup.run(name, shift, teachers.get(name) || null).lastInsertRowid));
      newGroups++;
    }
    return groups.get(key);
  };
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const first = String(r.first_name || '').trim();
      if (!first) continue;
      const last = String(r.last_name || '').trim();
      const phone = cleanPhones(r.phone);
      const known = existing.get(`${first} ${last}`.replace(/\s+/g, ' ').trim());
      if (known) {
        if (phone) { checkPhonesFree(phone, known); setPhone.run(phone, known); updated++; }
        if (mark_registered) { setRegistered.run(known); registered++; }
        continue;
      }
      if (phones_only) { notFound.push(`${first} ${last}`.trim()); continue; }
      insStudent.run(first, last, groupId(r.morning_class, 'morning'), groupId(r.afternoon_class, 'afternoon'), phone, mark_registered ? 1 : 0);
      added++;
      if (mark_registered) registered++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit(req.user.id, 'student-import', { added, newGroups, updated, registered });
  return { added, new_classes: newGroups, updated, registered, not_found: notFound };
}));

app.get('/api/admin/yemot', adminOnly, wrap(() => ({ token: yemotToken() })));
app.post('/api/admin/yemot/regenerate', adminOnly, wrap(req => {
  db.prepare("DELETE FROM settings WHERE key = 'yemot_token'").run();
  audit(req.user.id, 'settings', 'yemot_token');
  return { token: yemotToken() };
}));

// ---------- admin: scoring items + settings ----------

app.get('/api/admin/items', staff, wrap(() => ({ items: db.prepare('SELECT * FROM items ORDER BY sort, id').all() })));

app.post('/api/admin/items', adminOnly, wrap(req => {
  const { name, kind, shift, points, days, general } = req.body || {};
  if (!name) fail(400, 'יש למלא שם סעיף');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM items').get().n;
  db.prepare('INSERT INTO items (name, kind, shift, points, days, sort, general) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, kind, shift, Number(points) || 0, days ?? '0,1,2,3,4', sort, general ? 1 : 0);
  audit(req.user.id, 'item-create', name);
  return { ok: true };
}));

app.put('/api/admin/items/:id', adminOnly, wrap(req => {
  const { name, kind, shift, points, days, sort, active, general } = req.body || {};
  db.prepare('UPDATE items SET name = ?, kind = ?, shift = ?, points = ?, days = ?, sort = ?, active = ?, general = ? WHERE id = ?')
    .run(name, kind, shift, Number(points) || 0, days ?? '', Number(sort) || 0, active ? 1 : 0, general ? 1 : 0, Number(req.params.id));
  audit(req.user.id, 'item-update', { name, points });
  return { ok: true };
}));

app.put('/api/admin/settings', adminOnly, wrap(req => {
  const allowed = ['program_name', 'target', 'edit_days', 'logo', 'exam_rules'];
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  for (const k of allowed) {
    if (!(k in (req.body || {}))) continue;
    let v = req.body[k];
    if (k === 'exam_rules') {
      if (!Array.isArray(v)) fail(400, 'כללי מבחן לא תקינים');
      v = JSON.stringify(v.map(r => ({ min: Number(r.min), points: Number(r.points) })).sort((a, b) => b.min - a.min));
    }
    if (k === 'logo' && v && !/^data:image\//.test(v)) fail(400, 'קובץ לוגו לא תקין');
    up.run(k, String(v));
  }
  audit(req.user.id, 'settings', Object.keys(req.body || {}).filter(k => k !== 'logo').join(','));
  return { ok: true };
}));

// ---------- admin: weeks + days off ----------

app.get('/api/admin/weeks', wrap(() => ({
  weeks: programWeeks(),
  days_off: db.prepare('SELECT * FROM days_off ORDER BY date').all(),
  parashot: PARASHOT,
})));

// Creates `count` study weeks from start_date (moved back to Sunday), naming them from the parasha list.
app.post('/api/admin/weeks/generate', adminOnly, wrap(req => {
  const { start_date, count, first_parasha } = req.body || {};
  if (!isDate(start_date)) fail(400, 'תאריך לא תקין');
  const n = Math.min(Number(count) || 19, 40);
  let p = Math.max(0, PARASHOT.indexOf(first_parasha));
  const ins = db.prepare('INSERT OR IGNORE INTO weeks (start_date, parasha) VALUES (?, ?)');
  let d = weekStart(start_date);
  for (let i = 0; i < n; i++, d = addDays(d, 7)) ins.run(d, PARASHOT[p++] || '');
  audit(req.user.id, 'weeks-generate', { start_date, n });
  return { ok: true };
}));

app.post('/api/admin/weeks', adminOnly, wrap(req => {
  const { start_date, parasha } = req.body || {};
  if (!isDate(start_date)) fail(400, 'תאריך לא תקין');
  db.prepare('INSERT OR IGNORE INTO weeks (start_date, parasha) VALUES (?, ?)').run(weekStart(start_date), parasha || '');
  return { ok: true };
}));

app.put('/api/admin/weeks/:id', adminOnly, wrap(req => {
  const { parasha, vacation } = req.body || {};
  db.prepare('UPDATE weeks SET parasha = ?, vacation = ? WHERE id = ?').run(parasha || '', vacation ? 1 : 0, Number(req.params.id));
  audit(req.user.id, 'week-update', { id: req.params.id, parasha, vacation });
  return { ok: true };
}));

app.delete('/api/admin/weeks/:id', adminOnly, wrap(req => {
  db.prepare('DELETE FROM weeks WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
}));

app.post('/api/admin/days-off', staff, wrap(req => {
  const { date, note } = req.body || {};
  if (!isDate(date)) fail(400, 'תאריך לא תקין');
  db.prepare('INSERT OR REPLACE INTO days_off (date, note) VALUES (?, ?)').run(date, note || '');
  audit(req.user.id, 'day-off', date);
  return { ok: true };
}));

app.delete('/api/admin/days-off/:date', staff, wrap(req => {
  db.prepare('DELETE FROM days_off WHERE date = ?').run(req.params.date);
  return { ok: true };
}));

// ---------- admin: backup + audit ----------

app.get('/api/admin/backup', adminOnly, (req, res) => {
  const file = path.join(path.dirname(DB_PATH), `download-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  res.download(file, `mivtza-backup-${today()}.db`, () => fs.unlink(file, () => {}));
});

app.get('/api/admin/audit', staff, wrap(() => ({
  rows: db.prepare(`SELECT a.at, a.action, a.detail, u.display_name FROM audit a LEFT JOIN users u ON u.id = a.user_id
                    ORDER BY a.id DESC LIMIT 300`).all(),
})));

app.use('/api', (req, res) => res.status(404).json({ error: 'לא נמצא' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

backup();
setInterval(() => { try { backup(); } catch (e) { console.error('backup failed', e); } }, 6 * 3600 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
