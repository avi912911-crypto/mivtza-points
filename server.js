const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { db, DB_PATH, hashPassword, checkPassword, getSettings, backup } = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  return item.kind === 'exam' ? examPoints(value, rules) : (value ? item.points : 0);
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
  return { program_name: s.program_name, logo: s.logo, needs_setup: needsSetup() };
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

app.use('/api', auth);

app.get('/api/me', wrap(req => {
  const s = getSettings();
  return {
    user: publicUser(req.user),
    settings: { program_name: s.program_name, logo: s.logo, target: Number(s.target),
                edit_days: Number(s.edit_days), exam_rules: JSON.parse(s.exam_rules) },
    today: today(),
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

function shiftsFor(user, cls) {
  if (user.role !== 'teacher') return ['morning', 'afternoon', 'office'];
  const out = [];
  if (cls.morning_teacher_id === user.id) out.push('morning');
  if (cls.afternoon_teacher_id === user.id) out.push('afternoon');
  if (user.can_office) out.push('office');
  return out;
}

function accessibleClasses(user) {
  const all = db.prepare('SELECT * FROM classes ORDER BY sort, name').all();
  return all
    .map(c => ({ ...c, shifts: shiftsFor(user, c) }))
    .filter(c => c.shifts.length > 0);
}

// Teachers may change a day up to edit_days after it; weekly items count from the week's Saturday.
function isLocked(user, lastDay) {
  if (user.role !== 'teacher') return false;
  const t = today();
  const age = daysBetween(lastDay, t);
  const edit = Number(getSettings().edit_days);
  return age > edit;
}

// ---------- daily / weekly entry ----------

app.get('/api/entry/classes', wrap(req => ({
  classes: accessibleClasses(req.user).map(c => ({ id: c.id, name: c.name, shifts: c.shifts })),
})));

function entryContext(req, classId, date, mode) {
  if (!isDate(date)) fail(400, 'תאריך לא תקין');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(classId));
  if (!cls) fail(404, 'כיתה לא נמצאה');
  const shifts = shiftsFor(req.user, cls);
  if (!shifts.length) fail(403, 'אין הרשאה לכיתה זו');

  const wd = weekday(date);
  const items = db.prepare('SELECT * FROM items WHERE active = 1 ORDER BY sort, id').all()
    .filter(it => shifts.includes(it.shift))
    .filter(it => mode === 'daily'
      ? it.kind === 'daily' && it.days.split(',').includes(String(wd))
      : it.kind !== 'daily');
  const key = mode === 'daily' ? date : weekStart(date);
  const lastDay = mode === 'daily' ? date : addDays(key, 6);
  return { cls, items, key, lastDay };
}

app.get('/api/entry', wrap(req => {
  const { class_id, date, mode = 'daily' } = req.query;
  const { cls, items, key, lastDay } = entryContext(req, class_id, date, mode);
  const students = db.prepare(`SELECT id, first_name, last_name FROM students
                               WHERE class_id = ? AND active = 1 ORDER BY last_name, first_name`).all(cls.id);
  const values = {};
  if (items.length && students.length) {
    const rows = db.prepare(`SELECT student_id, item_id, value FROM entries
      WHERE date = ? AND item_id IN (${items.map(() => '?').join(',')})
      AND student_id IN (${students.map(() => '?').join(',')})`)
      .all(key, ...items.map(i => i.id), ...students.map(s => s.id));
    for (const r of rows) values[`${r.student_id}:${r.item_id}`] = r.value;
  }
  const dayOff = mode === 'daily' ? db.prepare('SELECT * FROM days_off WHERE date = ?').get(date) : null;
  const week = weekFor(date);
  return {
    class: { id: cls.id, name: cls.name },
    items, students, values,
    locked: isLocked(req.user, lastDay),
    future: date > today() && mode === 'daily',
    day_off: dayOff || null,
    week,
  };
}));

app.post('/api/entry', wrap(req => {
  const { class_id, date, mode = 'daily', changes } = req.body || {};
  const { cls, items, key, lastDay } = entryContext(req, class_id, date, mode);
  if (isLocked(req.user, lastDay)) fail(403, 'הזמן לעדכון היום הזה עבר. פנה למזכיר.');
  if (mode === 'daily' && date > today()) fail(400, 'אי אפשר להזין יום עתידי');
  if (!Array.isArray(changes)) fail(400, 'נתונים חסרים');

  const allowedItems = new Map(items.map(i => [i.id, i]));
  const studentIds = new Set(db.prepare('SELECT id FROM students WHERE class_id = ?').all(cls.id).map(s => s.id));
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
        if (item.kind === 'exam' ? !(v >= 0 && v <= 100) : v !== 1) fail(400, 'ערך לא תקין');
        upsert.run(c.student_id, item.id, key, Math.round(v), req.user.id, now);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit(req.user.id, 'entry', { class: cls.name, date: key, mode, count: changes.length });
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
    ? new Set(db.prepare('SELECT id FROM classes WHERE morning_teacher_id = ? OR afternoon_teacher_id = ?')
        .all(req.user.id, req.user.id).map(c => c.id))
    : null;
  const classes = db.prepare('SELECT * FROM classes ORDER BY sort, name').all()
    .filter(c => !visible || visible.has(c.id));
  const students = db.prepare('SELECT * FROM students WHERE active = 1').all()
    .filter(s => !visible || visible.has(s.class_id));
  const classById = new Map(classes.map(c => [c.id, c]));
  const curStart = info.current?.start_date;

  const rows = students.map(s => {
    const st = perStudent.get(s.id) || { total: 0, byWeek: {} };
    return {
      id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), class_id: s.class_id,
      class_name: classById.get(s.class_id)?.name || '',
      total: st.total, week: curStart ? (st.byWeek[curStart] || 0) : 0,
      on_track: st.total >= info.expectedSoFar,
    };
  });

  const classStats = classes.map(c => {
    const members = rows.filter(r => r.class_id === c.id);
    const n = members.length || 1;
    return {
      id: c.id, name: c.name, students: members.length,
      avg_total: Math.round(members.reduce((a, r) => a + r.total, 0) / n),
      avg_week: Math.round(members.reduce((a, r) => a + r.week, 0) / n),
      on_track: members.filter(r => r.on_track).length,
    };
  }).sort((a, b) => b.avg_total - a.avg_total);

  // Classes with no entry today, per shift (only on study days)
  const t = today();
  const missing = [];
  const off = db.prepare('SELECT 1 FROM days_off WHERE date = ?').get(t);
  if (!off && weekday(t) <= 4) {
    const shiftItems = shift => db.prepare(`SELECT id FROM items WHERE active = 1 AND kind = 'daily' AND shift = ?`)
      .all(shift).map(i => i.id);
    for (const shift of ['morning', 'afternoon']) {
      const ids = shiftItems(shift);
      if (!ids.length) continue;
      for (const c of classes) {
        const has = db.prepare(`SELECT 1 FROM entries e JOIN students s ON s.id = e.student_id
          WHERE s.class_id = ? AND e.date = ? AND e.item_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`)
          .get(c.id, t, ...ids);
        if (!has) missing.push({ class_name: c.name, shift });
      }
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
    missing_today: missing,
  };
}));

function canSeeClass(user, classId) {
  if (user.role !== 'teacher') return true;
  const c = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  return c && (c.morning_teacher_id === user.id || c.afternoon_teacher_id === user.id);
}

app.get('/api/classes/:id/summary', wrap(req => {
  const id = Number(req.params.id);
  if (!canSeeClass(req.user, id)) fail(403, 'אין הרשאה');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) fail(404, 'כיתה לא נמצאה');
  const { perStudent, weeks, target } = computeTotals();
  const students = db.prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY last_name, first_name').all(id);
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
  if (!s || !canSeeClass(req.user, s.class_id)) fail(404, 'תלמיד לא נמצא');
  const { perStudent, weeks, target } = computeTotals();
  const st = perStudent.get(s.id) || { total: 0, byWeek: {}, byItem: {} };
  const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(s.class_id);
  const bonuses = db.prepare('SELECT * FROM bonuses WHERE student_id = ? ORDER BY week_start').all(s.id);
  return {
    student: { ...s, class_name: cls?.name || '' },
    total: st.total, byWeek: st.byWeek, byItem: st.byItem, bonuses,
    items: db.prepare('SELECT id, name FROM items ORDER BY sort, id').all(),
    weeks, target, ...progressInfo(weeks, target),
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
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.active = 1) AS student_count
                           FROM classes c ORDER BY sort, name`).all();
  return { classes: req.user.role === 'teacher' ? rows.filter(c => canSeeClass(req.user, c.id)) : rows };
}));

app.post('/api/admin/classes', staff, wrap(req => {
  const { name, morning_teacher_id, afternoon_teacher_id, sort } = req.body || {};
  if (!name) fail(400, 'יש למלא שם כיתה');
  db.prepare('INSERT INTO classes (name, morning_teacher_id, afternoon_teacher_id, sort) VALUES (?, ?, ?, ?)')
    .run(name, morning_teacher_id || null, afternoon_teacher_id || null, Number(sort) || 0);
  audit(req.user.id, 'class-create', name);
  return { ok: true };
}));

app.put('/api/admin/classes/:id', staff, wrap(req => {
  const { name, morning_teacher_id, afternoon_teacher_id, sort } = req.body || {};
  db.prepare('UPDATE classes SET name = ?, morning_teacher_id = ?, afternoon_teacher_id = ?, sort = ? WHERE id = ?')
    .run(name, morning_teacher_id || null, afternoon_teacher_id || null, Number(sort) || 0, Number(req.params.id));
  audit(req.user.id, 'class-update', name);
  return { ok: true };
}));

app.delete('/api/admin/classes/:id', staff, wrap(req => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM students WHERE class_id = ? AND active = 1').get(id)) fail(400, 'יש תלמידים בכיתה. העבר אותם קודם.');
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  audit(req.user.id, 'class-delete', id);
  return { ok: true };
}));

// ---------- admin: students ----------

app.get('/api/admin/students', staff, wrap(() => ({
  students: db.prepare(`SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id
                        ORDER BY s.active DESC, c.sort, c.name, s.last_name, s.first_name`).all(),
})));

app.post('/api/admin/students', staff, wrap(req => {
  const { first_name, last_name, class_id } = req.body || {};
  if (!first_name) fail(400, 'יש למלא שם');
  db.prepare('INSERT INTO students (first_name, last_name, class_id) VALUES (?, ?, ?)')
    .run(String(first_name).trim(), String(last_name || '').trim(), class_id || null);
  audit(req.user.id, 'student-create', `${first_name} ${last_name || ''}`);
  return { ok: true };
}));

app.put('/api/admin/students/:id', staff, wrap(req => {
  const { first_name, last_name, class_id, active } = req.body || {};
  db.prepare('UPDATE students SET first_name = ?, last_name = ?, class_id = ?, active = ? WHERE id = ?')
    .run(String(first_name).trim(), String(last_name || '').trim(), class_id || null, active ? 1 : 0, Number(req.params.id));
  audit(req.user.id, 'student-update', `${first_name} ${last_name || ''}`);
  return { ok: true };
}));

// rows: [{ first_name, last_name, class_name }]; unknown classes are created
app.post('/api/admin/students/import', staff, wrap(req => {
  const rows = (req.body || {}).rows;
  if (!Array.isArray(rows) || !rows.length) fail(400, 'אין שורות לייבוא');
  const classes = new Map(db.prepare('SELECT id, name FROM classes').all().map(c => [c.name.trim(), c.id]));
  const insClass = db.prepare('INSERT INTO classes (name) VALUES (?)');
  const insStudent = db.prepare('INSERT INTO students (first_name, last_name, class_id) VALUES (?, ?, ?)');
  let added = 0, newClasses = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const first = String(r.first_name || '').trim();
      if (!first) continue;
      const cname = String(r.class_name || '').trim();
      let cid = null;
      if (cname) {
        if (!classes.has(cname)) {
          classes.set(cname, Number(insClass.run(cname).lastInsertRowid));
          newClasses++;
        }
        cid = classes.get(cname);
      }
      insStudent.run(first, String(r.last_name || '').trim(), cid);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit(req.user.id, 'student-import', { added, newClasses });
  return { added, new_classes: newClasses };
}));

// ---------- admin: scoring items + settings ----------

app.get('/api/admin/items', staff, wrap(() => ({ items: db.prepare('SELECT * FROM items ORDER BY sort, id').all() })));

app.post('/api/admin/items', adminOnly, wrap(req => {
  const { name, kind, shift, points, days } = req.body || {};
  if (!name) fail(400, 'יש למלא שם סעיף');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM items').get().n;
  db.prepare('INSERT INTO items (name, kind, shift, points, days, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, kind, shift, Number(points) || 0, days ?? '0,1,2,3,4', sort);
  audit(req.user.id, 'item-create', name);
  return { ok: true };
}));

app.put('/api/admin/items/:id', adminOnly, wrap(req => {
  const { name, kind, shift, points, days, sort, active } = req.body || {};
  db.prepare('UPDATE items SET name = ?, kind = ?, shift = ?, points = ?, days = ?, sort = ?, active = ? WHERE id = ?')
    .run(name, kind, shift, Number(points) || 0, days ?? '', Number(sort) || 0, active ? 1 : 0, Number(req.params.id));
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
