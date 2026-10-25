'use strict';

// ---------- basics ----------

const $app = document.getElementById('app');
const state = { me: null, settings: null, today: null, entry: {} };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('he-IL');
const ROLE = { admin: 'מנהל', secretary: 'מזכיר', teacher: 'מורה' };
const SHIFT = { morning: 'בוקר', afternoon: 'אחה"צ', office: 'מזכירות' };
const KIND = { daily: 'יומי', weekly: 'שבועי', exam: 'מבחן (ציון)' };
const DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
    state.me = null;
    renderLogin();
    throw new Error(data.error || 'יש להתחבר');
  }
  if (!res.ok) throw new Error(data.error || 'שגיאה');
  return data;
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
const weekStart = date => addDays(date, -weekday(date));
function hebDate(date) {
  try {
    return new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(new Date(date + 'T00:00:00Z'));
  } catch { return ''; }
}
const dayName = date => 'יום ' + new Intl.DateTimeFormat('he-IL', { weekday: 'long', timeZone: 'UTC' })
  .format(new Date(date + 'T00:00:00Z')).replace('יום ', '');
const shortDate = date => date.slice(8, 10) + '/' + date.slice(5, 7);
const dateRange = (a, b) => `${shortDate(a)} עד ${shortDate(b)}`;
const weekLabel = w => w ? (w.parasha ? `פרשת ${w.parasha}` : `שבוע ${shortDate(w.start_date)}`) : '';

function toast(msg, ms = 1800) {
  const bar = document.getElementById('savebar');
  bar.textContent = msg;
  bar.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => bar.classList.remove('show'), ms);
}

function logoHtml(cls = '') {
  return state.settings?.logo
    ? `<img class="${cls}" src="${esc(state.settings.logo)}" alt="לוגו">`
    : `<div class="placeholder-logo ${cls}">✡</div>`;
}

const isStaff = () => ['admin', 'secretary'].includes(state.me?.role);
const isAdmin = () => state.me?.role === 'admin';

// ---------- dialog helper ----------

function openDialog(title, bodyHtml, onSubmit, submitLabel = 'שמירה') {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${bodyHtml}
    <div class="error"></div>
    <div class="actions"><button class="btn" value="ok">${esc(submitLabel)}</button>
    <button class="btn ghost" value="cancel" formnovalidate>ביטול</button></div></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  form.addEventListener('submit', async e => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      dlg.close();
    } catch (err) {
      dlg.querySelector('.error').textContent = err.message;
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

// ---------- login ----------

async function renderLogin() {
  try { state.settings = { ...(state.settings || {}), ...(await api('/api/public')) }; } catch {}
  const setup = !!state.settings?.needs_setup;
  $app.innerHTML = `<div class="login-wrap"><div class="card login-card">
    ${logoHtml()}
    <h1>${esc(state.settings?.program_name || 'מבצע')}</h1>
    <p class="sub">${setup ? 'הגדרה ראשונה: צור את חשבון המנהל' : 'מערכת עדכון נקודות'}</p>
    <form id="login">
      ${setup ? '<label class="field">השם שלך<input type="text" name="display_name" required></label>' : ''}
      <label class="field">שם משתמש${setup ? ' (באנגלית)' : ''}<input type="text" name="username" dir="ltr" autocomplete="username" required></label>
      <label class="field">סיסמה${setup ? ' (לפחות 6 תווים)' : ''}<input type="password" name="password" minlength="${setup ? 6 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}" required></label>
      <div class="error"></div>
      <button class="btn">${setup ? 'יצירת חשבון וכניסה' : 'כניסה'}</button>
    </form></div></div>`;
  const form = document.getElementById('login');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api(setup ? '/api/setup' : '/api/login', { body: Object.fromEntries(new FormData(form)) });
      await boot();
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  });
}

// ---------- shell ----------

function navLinks() {
  const links = [['#/entry', 'הזנת נקודות'], ['#/dashboard', 'דשבורד'], ['#/report', 'דוחות']];
  if (isStaff()) links.splice(1, 0, ['#/general', 'רשימה כללית']);
  if (isStaff()) links.push(['#/admin/students', 'תלמידים'], ['#/admin/classes', 'קבוצות'], ['#/admin/weeks', 'לוח שבועות']);
  if (isAdmin()) links.push(['#/admin/users', 'משתמשים'], ['#/admin/items', 'הגדרת ניקוד'], ['#/admin/faces', 'זיהוי פנים'], ['#/admin/settings', 'הגדרות']);
  if (isStaff()) links.push(['#/admin/log', 'יומן שינויים']);
  return links;
}

function shell(content) {
  const hash = location.hash || '#/entry';
  $app.innerHTML = `
    <header class="topbar">
      <div class="brand">${logoHtml()}<span>${esc(state.settings.program_name)}</span></div>
      <button class="menu-toggle" id="menu">☰</button>
      <nav class="nav" id="nav">${navLinks().map(([h, t]) =>
        `<a href="${h}" class="${hash.startsWith(h) ? 'active' : ''}">${t}</a>`).join('')}</nav>
      <div class="userbox"><span>${esc(state.me.display_name)} · ${ROLE[state.me.role]}</span>
        <button id="pw">סיסמה</button><button id="logout">יציאה</button></div>
    </header>
    ${state.settings.storage_temporary && state.me.role !== 'teacher' ? `<div class="storage-warning">
      שים לב: לשרת לא מחובר אחסון קבוע (Volume) ב-Railway, ולכן כל הנתונים יימחקו בעדכון הבא של האתר.
      יש לחבר Volume לשירות לפני שממשיכים להזין נתונים.</div>` : ''}
    <main id="main">${content}</main>`;
  document.getElementById('menu').onclick = () => document.getElementById('nav').classList.toggle('open');
  document.getElementById('logout').onclick = async () => { await api('/api/logout', { body: {} }); state.me = null; renderLogin(); };
  document.getElementById('pw').onclick = () => changePassword(false);
  return document.getElementById('main');
}

function changePassword(forced) {
  const dlg = openDialog(forced ? 'יש לבחור סיסמה חדשה' : 'החלפת סיסמה', `
    ${forced ? '<p class="muted">זו הכניסה הראשונה שלך. בחר סיסמה אישית.</p>' : ''}
    <label class="field">סיסמה נוכחית<input type="password" name="current" required></label>
    <label class="field">סיסמה חדשה (לפחות 6 תווים)<input type="password" name="password" minlength="6" required></label>`,
    async data => {
      await api('/api/me/password', { body: data });
      state.me.must_change = false;
      toast('הסיסמה עודכנה');
    });
  if (forced) dlg.addEventListener('cancel', e => e.preventDefault());
}

// ---------- router ----------

async function route() {
  if (!state.me) return;
  const [, page, arg] = (location.hash || '#/entry').slice(1).split('/');
  try {
    if (page === 'dashboard') return await viewDashboard();
    if (page === 'class') return await viewClass(Number(arg));
    if (page === 'student') return await viewStudent(Number(arg));
    if (page === 'report') return await viewReport();
    if (page === 'general') return await viewGeneral();
    if (page === 'admin') return await viewAdmin(arg || 'students');
    return await viewEntry();
  } catch (err) {
    if (state.me) shell(`<div class="notice bad">${esc(err.message)}</div>`);
  }
}
window.addEventListener('hashchange', route);

async function boot() {
  try {
    const me = await api('/api/me');
    Object.assign(state, { me: me.user, settings: me.settings, today: me.today });
  } catch { return; }
  // Every login or reopening of the site starts on the dashboard, not the last page visited.
  history.replaceState(null, '', '#/dashboard');
  await route();
  if (state.me.must_change) changePassword(true);
}

// ---------- entry (weekly table) ----------

async function viewEntry() {
  const { classes } = await api('/api/entry/classes');
  const e = state.entry;
  if (!classes.length) {
    shell(`<h1>הזנת נקודות</h1><div class="card empty">עדיין לא שויכה אליך קבוצה. פנה למנהל.</div>`);
    return;
  }
  if (!classes.find(c => c.id === e.classId)) e.classId = classes[0].id;
  e.date = weekStart(e.date || state.today);
  const main = shell(`<h1>הזנת נקודות</h1>
    <p class="sub">${state.settings.daily_mode
      ? 'בכל סעיף מסמנים באילו ימים התלמיד נכח. הכי מהיר: "מלא הכול", ואז לחיצה רק על הימים החריגים. הכול נשמר אוטומטית.'
      : 'בכל סעיף רושמים כמה פעמים התלמיד נכח השבוע. לחיצה על תא מוסיפה פעם אחת (אחרי המקסימום חוזר לאפס), ואפשר גם להקליד מספר. הכול נשמר אוטומטית.'}</p>
    <div class="card"><div class="toolbar">
      ${classes.length > 1 ? `<select id="cls">${classes.map(c =>
        `<option value="${c.id}" ${c.id === e.classId ? 'selected' : ''}>${esc(c.name)} · ${SHIFT[c.shift]}</option>`).join('')}</select>`
        : `<strong>${esc(classes[0].name)} · ${SHIFT[classes[0].shift]}</strong>`}
      <div class="datebox"><button class="btn secondary small" id="prev" title="שבוע קודם">→</button>
        <input type="date" id="date" value="${e.date}">
        <button class="btn secondary small" id="next" title="שבוע הבא">←</button>
        <button class="btn ghost small" id="today">השבוע</button></div>
      <span class="spacer"></span><span id="datelabel" class="muted"></span>
    </div><div id="grid"></div></div>`);
  main.querySelector('#cls')?.addEventListener('change', ev => { e.classId = Number(ev.target.value); loadGrid(); });
  main.querySelector('#prev').onclick = () => { e.date = addDays(e.date, -7); viewEntry(); };
  main.querySelector('#next').onclick = () => { e.date = addDays(e.date, 7); viewEntry(); };
  main.querySelector('#today').onclick = () => { e.date = state.today; viewEntry(); };
  main.querySelector('#date').onchange = ev => { if (ev.target.value) { e.date = ev.target.value; viewEntry(); } };
  await loadGrid();
}

async function loadGrid() {
  const e = state.entry;
  const grid = document.getElementById('grid');
  const data = await api(`/api/entry?class_id=${e.classId}&date=${e.date}`);
  document.getElementById('datelabel').textContent =
    `${data.week ? weekLabel(data.week) : 'שבוע'} · ${dateRange(data.week_start, addDays(data.week_start, 6))}`;
  renderGrid(grid, data, changes => api('/api/entry', { body: { class_id: e.classId, date: data.week_start, changes } }),
    'אין סעיפים שלך להזנה בשבוע זה.');
}

// The entry table shared by the group screen and the general list. save(changes) stores a batch.
// Daily items are marked per day (data.att); the weekly count in values follows the days marked present.
function renderGrid(grid, data, save, emptyText) {
  const rules = state.settings.exam_rules;
  const examPts = g => { for (const r of rules) if (g >= r.min) return r.points; return 0; };

  let notice = '';
  if (data.week?.vacation) notice = '<div class="notice">שבוע זה מסומן כחופשה, והנקודות בו לא נספרות.</div>';
  if (data.days_off.length) notice += `<div class="notice">ימים ללא לימודים השבוע: ${data.days_off.map(d =>
    `${dayName(d.date)}${d.note ? ' (' + esc(d.note) + ')' : ''}`).join(', ')}. ימים אלה מסומנים באפור ולא נספרים.</div>`;
  if (data.future) notice += '<div class="notice">זה שבוע עתידי. אפשר להזין רק עד השבוע הנוכחי.</div>';
  if (data.locked) notice += '<div class="notice bad">הזמן לעדכון השבוע הזה עבר. לתיקון פנה למזכיר.</div>';
  if (!data.items.length) { grid.innerHTML = notice + `<div class="empty">${emptyText}</div>`; return; }
  if (!data.students.length) { grid.innerHTML = notice + '<div class="empty">אין תלמידים בקבוצה.</div>'; return; }

  const readOnly = data.locked || data.future;
  const values = data.values;
  const att = data.att || {};
  const itemById = new Map(data.items.map(it => [it.id, it]));
  const daily = data.items.filter(it => it.dates);
  const ptsOf = (it, v) => v == null ? 0 : it.kind === 'exam' ? examPts(v) : v * it.points;
  const rowTotal = s => data.items.reduce((a, it) => a + ptsOf(it, values[`${s.id}:${it.id}`]), 0);
  const counterHtml = (it, v) => it.kind === 'weekly' ? '✓' : (v || '');
  // Days that can be marked now: a study day of the item that has already come
  const openDates = it => it.dates.filter(d => !d.off && d.date <= data.today).map(d => d.date);
  const dayOf = (sid, iid, date) => att[`${sid}:${iid}`]?.[date];
  const countOf = (sid, iid) => Object.values(att[`${sid}:${iid}`] || {}).filter(([st]) => st === 'present').length;

  const dayBtn = (s, it, d) => {
    const rec = dayOf(s.id, it.id, d.date);
    const cls = d.off ? 'off' : rec ? (rec[0] === 'present' ? 'on' : 'late') + (rec[1] === 'camera' ? ' cam' : '') : '';
    const title = d.off ? 'אין לימודים' : `${dayName(d.date)}${rec?.[1] === 'camera' ? ' · נרשם במצלמה' : ''}`;
    return `<button class="day ${cls}" data-s="${s.id}" data-i="${it.id}" data-d="${d.date}" title="${title}"
      ${readOnly || d.off || d.date > data.today ? 'disabled' : ''}>${DAYS[weekday(d.date)]}</button>`;
  };
  const dailyCell = (s, it) => `<div class="days">${it.dates.map(d => dayBtn(s, it, d)).join('')}</div>
    <span class="cnt" id="cnt-${s.id}-${it.id}">${countOf(s.id, it.id)}/${it.max}</span>`;

  const canFill = !readOnly && daily.length > 0;
  grid.innerHTML = notice + (canFill ? `<div class="grid-actions">
      <button class="btn small" id="fill-all">מלא הכול</button>
      <span class="muted small">מסמן "נוכח" לכולם בכל הימים שכבר עברו. אחר כך לוחצים רק על החריגים: לחיצה אחת "איחר", לחיצה שנייה "חסר".</span>
      <span class="legend"><i class="day on"></i>נוכח <i class="day late"></i>איחר <i class="day"></i>חסר <i class="day on cam"></i>מצלמה</span>
    </div>` : '') + `<div class="table-wrap"><table class="entry"><thead><tr><th class="name">תלמיד</th>
    ${data.items.map(it => `<th class="num">${esc(it.name)}<span class="pts">${it.kind === 'exam' ? 'ציון'
        : it.kind === 'daily' ? `עד ${it.max} · ${it.points} נק'` : it.points + ' נק\''}</span>
      ${it.kind !== 'exam' && !readOnly ? `<button class="btn secondary small all" data-all="${it.id}">${it.kind === 'daily' ? 'מלא' : 'כולם'}</button>` : ''}</th>`).join('')}
    <th class="num">סה"כ</th></tr></thead><tbody>
    ${data.students.map(s => `<tr><td class="name">${canFill ? `<button class="btn ghost small rowfill" data-row="${s.id}" title="מלא את כל הימים לתלמיד זה">מלא</button>` : ''}${esc(s.first_name)} ${esc(s.last_name)}${s.morning !== undefined
      ? `<div class="muted small">${esc([s.morning, s.afternoon].filter(Boolean).join(' · '))}</div>` : ''}</td>
      ${data.items.map(it => {
        const v = values[`${s.id}:${it.id}`];
        return `<td class="num">${it.kind === 'exam'
          ? `<input type="number" class="grade-input" min="0" max="100" data-s="${s.id}" data-i="${it.id}" value="${v ?? ''}" ${readOnly ? 'disabled' : ''}><span class="grade-pts" id="gp-${s.id}-${it.id}">${v != null ? examPts(v) + ' נק\'' : ''}</span>`
          : it.dates ? dailyCell(s, it)
          : `<button class="cell-toggle ${cellClass(it, v)}" data-s="${s.id}" data-i="${it.id}" ${readOnly ? 'disabled' : ''}>${counterHtml(it, v)}</button>`}</td>`;
      }).join('')}
      <td class="num rowtotal" id="rt-${s.id}">${rowTotal(s)}</td></tr>`).join('')}
    </tbody></table></div>`;

  const pending = new Map();
  const refreshRow = sid => {
    document.getElementById(`rt-${sid}`).textContent = rowTotal(data.students.find(x => x.id === sid));
  };
  const schedule = () => { clearTimeout(schedule.t); schedule.t = setTimeout(flush, 500); };
  const queue = (sid, iid, value) => {
    values[`${sid}:${iid}`] = value;
    pending.set(`${sid}:${iid}`, { student_id: sid, item_id: iid, value });
    refreshRow(sid);
    schedule();
  };
  const flush = async () => {
    if (!pending.size) return;
    const changes = [...pending.values()];
    pending.clear();
    try {
      await save(changes);
      toast('✓ נשמר');
    } catch (err) {
      toast('שגיאה בשמירה: ' + err.message, 4000);
    }
  };
  const setCell = (btn, v) => {
    const it = itemById.get(Number(btn.dataset.i));
    v = v ? Math.min(v, it.max) : null;
    btn.className = `cell-toggle ${cellClass(it, v)}`;
    btn.textContent = counterHtml(it, v);
    queue(Number(btn.dataset.s), it.id, v);
  };
  // status: 'present' | 'late' | null (absent). Marking by the teacher replaces a camera mark.
  const setDay = (sid, it, date, status) => {
    const key = `${sid}:${it.id}`;
    if (status) (att[key] ??= {})[date] = [status, 'teacher'];
    else if (att[key]) delete att[key][date];
    const btn = grid.querySelector(`.day[data-s="${sid}"][data-i="${it.id}"][data-d="${date}"]`);
    if (btn) btn.className = `day ${status === 'present' ? 'on' : status === 'late' ? 'late' : ''}`;
    const n = countOf(sid, it.id);
    values[key] = n || null;
    document.getElementById(`cnt-${sid}-${it.id}`).textContent = `${n}/${it.max}`;
    pending.set(`${key}:${date}`, { student_id: sid, item_id: it.id, date, status });
    refreshRow(sid);
    schedule();
  };
  // Fill = mark present every open day that has no mark yet. Days already marked (late, or by the camera) stay.
  // When everything is already present, the column / row button clears what the teacher filled.
  const fill = (pairs, toggle) => {
    const empty = pairs.flatMap(([sid, it]) => openDates(it).filter(d => !dayOf(sid, it.id, d)).map(d => [sid, it, d]));
    if (empty.length || !toggle) { empty.forEach(([sid, it, d]) => setDay(sid, it, d, 'present')); return; }
    pairs.forEach(([sid, it]) => openDates(it).forEach(d => {
      const rec = dayOf(sid, it.id, d);
      if (rec && rec[0] === 'present' && rec[1] !== 'camera') setDay(sid, it, d, null);
    }));
  };

  grid.querySelectorAll('.day:not(:disabled)').forEach(btn => btn.onclick = () => {
    const sid = Number(btn.dataset.s), it = itemById.get(Number(btn.dataset.i));
    const cur = dayOf(sid, it.id, btn.dataset.d)?.[0];
    // present -> late -> absent -> present
    setDay(sid, it, btn.dataset.d, cur === 'present' ? 'late' : cur === 'late' ? null : 'present');
  });
  grid.querySelectorAll('.cell-toggle').forEach(btn => {
    btn.onclick = () => {
      const it = itemById.get(Number(btn.dataset.i));
      const v = values[`${btn.dataset.s}:${it.id}`] || 0;
      setCell(btn, v >= it.max ? 0 : v + 1);
    };
    // Typing a digit on a focused cell sets the count directly
    btn.onkeydown = ev => {
      if (/^[0-9]$/.test(ev.key)) { ev.preventDefault(); setCell(btn, Number(ev.key)); }
      else if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); setCell(btn, 0); }
    };
  });
  grid.querySelectorAll('[data-all]').forEach(btn => btn.onclick = () => {
    const it = itemById.get(Number(btn.dataset.all));
    if (it.dates) { fill(data.students.map(s => [s.id, it]), true); return; }
    const cells = [...grid.querySelectorAll(`.cell-toggle[data-i="${it.id}"]`)];
    const allFull = cells.every(c => values[`${c.dataset.s}:${it.id}`] === it.max);
    cells.forEach(c => setCell(c, allFull ? 0 : it.max));
  });
  grid.querySelectorAll('[data-row]').forEach(btn => btn.onclick = () =>
    fill(daily.map(it => [Number(btn.dataset.row), it]), true));
  grid.querySelector('#fill-all')?.addEventListener('click', () =>
    fill(data.students.flatMap(s => daily.map(it => [s.id, it])), false));
  grid.querySelectorAll('.grade-input').forEach(inp => inp.onchange = () => {
    const sid = Number(inp.dataset.s), iid = Number(inp.dataset.i);
    let v = inp.value === '' ? null : Math.max(0, Math.min(100, Math.round(Number(inp.value))));
    if (v != null) inp.value = v;
    document.getElementById(`gp-${sid}-${iid}`).textContent = v != null ? examPts(v) + ' נק\'' : '';
    queue(sid, iid, v);
  });
  window.onbeforeunload = () => { if (pending.size) { flush(); return 'יש שינויים שלא נשמרו'; } };
}

// ---------- general list (secretary): all students A-Z ----------

async function viewGeneral() {
  if (!isStaff()) { location.hash = '#/entry'; return; }
  const e = state.entry;
  e.date = weekStart(e.date || state.today);
  const main = shell(`<h1>רשימה כללית</h1>
    <p class="sub">כל התלמידים מכל הקבוצות לפי א"ב, לסעיפים שהמזכיר מזין (כמו שיחה ביום ג'). לרשימה ריקה להדפסה: דוחות ← רשימה ריקה.</p>
    <div class="card"><div class="toolbar">
      <div class="datebox"><button class="btn secondary small" id="prev" title="שבוע קודם">→</button>
        <input type="date" id="date" value="${e.date}">
        <button class="btn secondary small" id="next" title="שבוע הבא">←</button>
        <button class="btn ghost small" id="today">השבוע</button></div>
      <input type="search" id="find" placeholder="חיפוש תלמיד" style="width:180px">
      <span class="spacer"></span><span id="datelabel" class="muted"></span>
    </div><div id="grid"></div></div>`);
  main.querySelector('#prev').onclick = () => { e.date = addDays(e.date, -7); viewGeneral(); };
  main.querySelector('#next').onclick = () => { e.date = addDays(e.date, 7); viewGeneral(); };
  main.querySelector('#today').onclick = () => { e.date = state.today; viewGeneral(); };
  main.querySelector('#date').onchange = ev => { if (ev.target.value) { e.date = ev.target.value; viewGeneral(); } };
  const data = await api(`/api/general?date=${e.date}`);
  main.querySelector('#datelabel').textContent =
    `${data.week ? weekLabel(data.week) : 'שבוע'} · ${dateRange(data.week_start, addDays(data.week_start, 6))}`;
  const grid = main.querySelector('#grid');
  renderGrid(grid, data, changes => api('/api/general', { body: { date: data.week_start, changes } }),
    'אין סעיפים ברשימה הכללית. בהגדרת ניקוד בוחרים בסעיף "מזכיר, רשימה כללית".');
  main.querySelector('#find').oninput = ev => {
    const q = ev.target.value.trim();
    grid.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = !q || tr.cells[0].textContent.includes(q) ? '' : 'none'; });
  };
}

// Full = green, partly attended = soft colour, none = empty
function cellClass(it, v) {
  if (!v) return '';
  return v >= it.max ? 'on' : 'part';
}

// ---------- dashboard ----------

async function viewDashboard() {
  const d = await api('/api/dashboard');
  const pctTotal = d.student_count ? Math.round(100 * d.on_track_count / d.student_count) : 0;
  const weekNo = d.current ? d.completed + 1 : d.completed;
  const main = shell(`
    <h1>דשבורד</h1>
    <p class="sub">${d.current ? `${weekLabel(d.current)} · שבוע ${weekNo} מתוך ${d.totalWeeks}` : 'אין כרגע שבוע פעיל בלוח השבועות'}</p>
    <div class="grid grid-4">
      <div class="card stat accent"><div class="label">יעד לתלמיד</div><div class="value">${fmt(d.target)}</div>
        <div class="hint">צפוי עד עכשיו: ${fmt(d.expectedSoFar)}</div></div>
      <div class="card stat"><div class="label">תלמידים בקצב</div><div class="value">${fmt(d.on_track_count)} / ${fmt(d.student_count)}</div>
        <div class="progress" style="margin-top:10px"><div style="width:${pctTotal}%"></div></div></div>
      <div class="card stat"><div class="label">סה"כ נקודות במבצע</div><div class="value">${fmt(d.total_points)}</div>
        <div class="hint">ממוצע לתלמיד: ${fmt(d.student_count ? Math.round(d.total_points / d.student_count) : 0)}</div></div>
      <div class="card stat"><div class="label">הגיעו ליעד</div><div class="value">${fmt(d.reached_target)}</div>
        <div class="hint">${d.totalWeeks} שבועות במבצע</div></div>
    </div>
    ${d.missing_week.length ? `<div class="card"><h2>עדיין לא הוזן השבוע</h2>
      ${d.missing_week.map(m => `<span class="badge bad" style="margin:3px">${esc(m.class_name)} · ${SHIFT[m.shift]}</span>`).join('')}</div>` : ''}
    ${['morning', 'afternoon'].map(sh => groupRanking(d, sh)).join('')}
    <div class="grid grid-2">
      <div class="card"><h2>מצטייני השבוע</h2>${topList(d.top_week, 'week')}</div>
      <div class="card"><h2>מובילים מצטבר</h2>${topList(d.top_total, 'total')}</div>
    </div>`);
  return main;
}

function groupRanking(d, shift) {
  const list = d.classes.filter(c => c.shift === shift);
  if (!list.length) return '';
  return `<div class="card"><h2>דירוג קבוצות ${SHIFT[shift]}</h2>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>קבוצה</th><th class="num">תלמידים</th>
      <th class="num">ממוצע השבוע</th><th class="num">ממוצע מצטבר</th><th class="num">בקצב</th><th>התקדמות ליעד</th></tr></thead><tbody>
      ${list.map((c, i) => `<tr style="cursor:pointer" onclick="location.hash='#/class/${c.id}'">
        <td><span class="rank ${i === 0 ? 'r1' : ''}">${i + 1}</span></td><td><a href="#/class/${c.id}">${esc(c.name)}</a></td>
        <td class="num">${c.students}</td><td class="num">${fmt(c.avg_week)}</td><td class="num"><strong>${fmt(c.avg_total)}</strong></td>
        <td class="num">${c.on_track}/${c.students}</td>
        <td style="min-width:140px"><div class="progress"><div style="width:${Math.min(100, Math.round(100 * c.avg_total / d.target))}%"></div></div></td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function topList(rows, key) {
  if (!rows.length || !rows.some(r => r[key])) return '<div class="empty">אין עדיין נתונים</div>';
  return rows.filter(r => r[key]).map((r, i) => `<div class="list-row">
    <div><span class="rank ${i === 0 ? 'r1' : ''}">${i + 1}</span><a href="#/student/${r.id}">${esc(r.name)}</a>
      <span class="muted"> · ${esc(r.class_name)}</span></div><strong>${fmt(r[key])}</strong></div>`).join('');
}

// ---------- class summary ----------

async function viewClass(id) {
  const d = await api(`/api/classes/${id}/summary`);
  const weeks = d.weeks;
  const expected = d.expectedSoFar;
  shell(`<a href="#/dashboard">→ חזרה לדשבורד</a><h1 style="margin-top:8px">${esc(d.class.name)} · ${SHIFT[d.class.shift]}</h1>
    <p class="sub">נקודות לפי שבוע. יעד: ${fmt(d.target)} · צפוי עד עכשיו: ${fmt(expected)}</p>
    <div class="card"><div class="table-wrap"><table><thead><tr><th class="name">תלמיד</th>
      ${weeks.map(w => `<th class="num" title="${shortDate(w.start_date)}">${esc(w.parasha || shortDate(w.start_date))}${w.vacation ? '<br><span class="badge gold">חופשה</span>' : ''}</th>`).join('')}
      <th class="num">סה"כ</th><th class="num">מצב</th></tr></thead><tbody>
      ${d.students.map(s => `<tr><td class="name"><a href="#/student/${s.id}">${esc(s.name)}</a></td>
        ${weeks.map(w => `<td class="num">${w.vacation ? '–' : (s.byWeek[w.start_date] ?? '')}</td>`).join('')}
        <td class="num"><strong>${fmt(s.total)}</strong></td>
        <td class="num">${s.total >= d.target ? '<span class="badge gold">הגיע ליעד</span>'
          : s.total >= expected ? '<span class="badge ok">בקצב</span>' : '<span class="badge bad">מאחור</span>'}</td></tr>`).join('')
      || `<tr><td colspan="${weeks.length + 3}" class="empty">אין תלמידים</td></tr>`}
    </tbody></table></div></div>`);
}

// ---------- student card ----------

async function viewStudent(id) {
  const d = await api(`/api/students/${id}/card`);
  const pct = Math.min(100, Math.round(100 * d.total / d.target));
  const itemRows = d.items.filter(it => d.byItem[it.id]).map(it => [it.name, d.byItem[it.id]]);
  if (d.byItem.bonus) itemRows.push(['נקודות מיוחדות', d.byItem.bonus]);
  const groupLink = (gid, gname, sh) => gid ? `<a href="#/class/${gid}">${esc(gname)}</a> (${SHIFT[sh]})` : '';
  const main = shell(`<a href="#/dashboard">→ חזרה לדשבורד</a>
    <h1 style="margin-top:8px">${esc(d.student.first_name)} ${esc(d.student.last_name)}</h1>
    <p class="sub">${[groupLink(d.student.morning_class_id, d.student.morning_class_name, 'morning'),
      groupLink(d.student.afternoon_class_id, d.student.afternoon_class_name, 'afternoon')].filter(Boolean).join(' · ')}</p>
    <div class="grid grid-2">
      <div class="card stat accent"><div class="label">סה"כ נקודות</div><div class="value">${fmt(d.total)} / ${fmt(d.target)}</div>
        <div class="progress gold" style="margin-top:12px;background:rgba(255,255,255,.25)"><div style="width:${pct}%"></div></div>
        <div class="hint">${pct}% מהיעד · צפוי עד עכשיו: ${fmt(d.expectedSoFar)}</div></div>
      <div class="card"><h2>לפי סעיף</h2>${itemRows.length ? itemRows.map(([n, p]) =>
        `<div class="list-row"><span>${esc(n)}</span><strong>${fmt(p)}</strong></div>`).join('') : '<div class="empty">אין עדיין נקודות</div>'}</div>
    </div>
    <div class="card"><h2>לפי שבוע</h2><div class="table-wrap"><table><thead><tr>
      ${d.weeks.map(w => `<th class="num">${esc(w.parasha || shortDate(w.start_date))}</th>`).join('')}</tr></thead>
      <tbody><tr>${d.weeks.map(w => `<td class="num">${w.vacation ? '–' : (d.byWeek[w.start_date] ?? 0)}</td>`).join('')}</tr></tbody>
    </table></div></div>
    ${isStaff() ? `<div class="card"><div class="toolbar"><h2 style="margin:0">נקודות מיוחדות</h2><span class="spacer"></span>
      <button class="btn secondary" id="addbonus">+ הוספה</button></div>
      ${d.bonuses.length ? d.bonuses.map(b => `<div class="list-row"><span>${shortDate(b.week_start)} · ${esc(b.reason || 'ללא סיבה')}</span>
        <span><strong>${b.points > 0 ? '+' : ''}${b.points}</strong> <button class="btn danger small" data-del="${b.id}">מחיקה</button></span></div>`).join('')
        : '<div class="muted">אין</div>'}</div>` : ''}`);
  main.querySelector('#addbonus')?.addEventListener('click', () => openDialog('נקודות מיוחדות', `
    <label class="field">תאריך<input type="date" name="date" value="${state.today}" required></label>
    <label class="field">נקודות (אפשר גם מינוס)<input type="number" name="points" required></label>
    <label class="field">סיבה<input type="text" name="reason"></label>`,
    async data => { await api('/api/bonuses', { body: { ...data, student_id: id } }); viewStudent(id); }));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('למחוק?')) return;
    await api('/api/bonuses/' + b.dataset.del, { method: 'DELETE' });
    viewStudent(id);
  });
}

// ---------- weekly report ----------

const REPORT_SORT = {
  week: ['נקודות השבוע, מהגבוה לנמוך', (a, b) => b.week - a.week || b.total - a.total],
  total: ['מצטבר מתחילת המבצע, מהגבוה לנמוך', (a, b) => b.total - a.total || b.week - a.week],
  name: ['לפי שם', (a, b) => a.name.localeCompare(b.name, 'he')],
};

const reportTypeSelect = type => isStaff() ? `<select id="r-type">
  <option value="weekly" ${type === 'weekly' ? 'selected' : ''}>דוח שבועי</option>
  <option value="blank" ${type === 'blank' ? 'selected' : ''}>רשימה ריקה למילוי ביד</option></select>` : '';

const REG = { '': 'כל התלמידים', yes: 'רק מי שנרשמו', no: 'רק מי שלא נרשמו' };
const regSelect = reg => `<select id="r-reg">${Object.entries(REG).map(([k, v]) =>
  `<option value="${k}" ${k === (reg || '') ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
const regLabel = reg => reg === 'yes' ? 'נרשמו' : reg === 'no' ? 'לא נרשמו' : '';

// Save-as-PDF through the browser print dialog; the document title becomes the file name.
function printAsPdf(fileName) {
  const prev = document.title;
  document.title = fileName;
  toast('בחלון שנפתח בחר "שמירה כ-PDF" ולחץ שמירה', 5000);
  setTimeout(() => { window.print(); document.title = prev; }, 300);
}

function downloadSheet(aoa, cols, fileName) {
  if (!window.XLSX) { toast('רכיב האקסל לא נטען. רענן את הדף.', 4000); return; }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = cols.map(wch => ({ wch }));
  ws['!merges'] = [0, 1, 2].map(r => ({ s: { r, c: 0 }, e: { r, c: cols.length - 1 } }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'דוח');
  XLSX.writeFile(wb, fileName + '.xlsx');
}

async function viewReport() {
  const r = state.report ||= { sort: 'week', type: 'weekly' };
  if (r.type === 'blank' && isStaff()) return viewBlankList(r);
  const q = new URLSearchParams();
  if (r.week) q.set('week', r.week);
  if (r.classId) q.set('class_id', r.classId);
  if (r.reg) q.set('reg', r.reg);
  const d = await api('/api/report?' + q);
  r.week = d.week?.start_date || '';
  const rows = [...d.rows].sort(REPORT_SORT[r.sort][1]);
  const title = d.week ? `דוח שבועי · ${weekLabel(d.week)}` : 'דוח שבועי';
  const range = d.week ? dateRange(d.week.start_date, addDays(d.week.start_date, 6)) : '';
  const scope = [d.group ? `${d.group.name} · ${SHIFT[d.group.shift]}` : (r.reg ? '' : 'כל התלמידים'), regLabel(r.reg)]
    .filter(Boolean).join(' · ');
  const avg = k => rows.length ? Math.round(rows.reduce((a, x) => a + x[k], 0) / rows.length) : 0;

  const main = shell(`<h1>דוחות</h1><p class="sub">בחר שבוע וקבוצה, והורד את הדוח ל-PDF או לאקסל.</p>
    <div class="card no-print"><div class="toolbar">
      ${reportTypeSelect('weekly')}
      <select id="r-week">${d.weeks.map(w => `<option value="${w.start_date}" ${w.start_date === r.week ? 'selected' : ''}>
        ${esc(weekLabel(w))} (${shortDate(w.start_date)})${w.vacation ? ' · חופשה' : ''}</option>`).join('')}</select>
      <select id="r-group"><option value="">${state.me.role === 'teacher' ? 'כל התלמידים שלי' : 'כל התלמידים'}</option>
        ${d.groups.map(c => `<option value="${c.id}" ${c.id === r.classId ? 'selected' : ''}>${esc(c.name)} · ${SHIFT[c.shift]}</option>`).join('')}</select>
      ${isStaff() ? regSelect(r.reg) : ''}
      <select id="r-sort">${Object.entries(REPORT_SORT).map(([k, [label]]) =>
        `<option value="${k}" ${k === r.sort ? 'selected' : ''}>מיון: ${label}</option>`).join('')}</select>
      <span class="spacer"></span>
      <button class="btn" id="r-pdf">הורדת PDF</button>
      <button class="btn secondary" id="r-xlsx">הורדת אקסל</button>
      <button class="btn ghost" id="r-print">הדפסה</button>
    </div></div>
    <div class="card report-doc" id="report-doc">
      <div class="report-head">
        ${state.settings.logo ? `<img src="${esc(state.settings.logo)}" alt="לוגו">` : ''}
        <div><div class="report-program">${esc(state.settings.program_name)}</div>
          <h2>${esc(title)}</h2>
          <div class="muted">${range}${d.week_number ? ` · שבוע ${d.week_number} מתוך ${d.total_weeks}` : ''} · ${esc(scope)}</div></div>
      </div>
      <div class="report-summary">
        <span>תלמידים: <strong>${rows.length}</strong></span>
        <span>ממוצע השבוע: <strong>${fmt(avg('week'))}</strong></span>
        <span>ממוצע מצטבר: <strong>${fmt(avg('total'))}</strong></span>
        <span>יעד: <strong>${fmt(d.target)}</strong></span>
      </div>
      <table class="report-table"><thead><tr><th class="num">#</th><th>שם התלמיד</th><th>קבוצת בוקר</th><th>קבוצת אחה"צ</th>
        <th class="num">נקודות השבוע</th><th class="num">מצטבר מתחילת המבצע</th><th class="num">נשאר ליעד</th></tr></thead>
      <tbody>${rows.map((x, i) => `<tr><td class="num">${i + 1}</td><td>${esc(x.name)}</td>
        <td>${esc(x.morning)}</td><td>${esc(x.afternoon)}</td>
        <td class="num"><strong>${fmt(x.week)}</strong></td><td class="num">${fmt(x.total)}</td>
        <td class="num">${x.remaining_pct === 0 ? '<span class="badge gold">הגיע ליעד</span>'
          : `<div class="pct"><div class="progress">${x.remaining_pct < 100 ? `<div style="width:${100 - x.remaining_pct}%"></div>` : ''}</div><span>${x.remaining_pct}%</span></div>`}</td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">אין תלמידים</td></tr>'}</tbody></table>
      <div class="report-foot muted">הופק ב-${new Date().toLocaleDateString('he-IL')} · ${hebDate(state.today)}</div>
    </div>`);

  main.querySelector('#r-type')?.addEventListener('change', ev => { r.type = ev.target.value; viewReport(); });
  main.querySelector('#r-week').onchange = ev => { r.week = ev.target.value; viewReport(); };
  main.querySelector('#r-group').onchange = ev => { r.classId = Number(ev.target.value) || null; viewReport(); };
  main.querySelector('#r-sort').onchange = ev => { r.sort = ev.target.value; viewReport(); };
  main.querySelector('#r-reg')?.addEventListener('change', ev => { r.reg = ev.target.value; viewReport(); });
  main.querySelector('#r-print').onclick = () => window.print();
  const fileName = `${title} - ${scope}`.replace(/[\\/:*?"<>|·]/g, '').replace(/\s+/g, ' ').trim();

  main.querySelector('#r-pdf').onclick = () => printAsPdf(fileName);
  main.querySelector('#r-xlsx').onclick = () => downloadSheet([
    [state.settings.program_name], [title], [`${range} · ${scope}`], [],
    ['#', 'שם התלמיד', 'קבוצת בוקר', 'קבוצת אחה"צ', 'נקודות השבוע', 'מצטבר מתחילת המבצע', 'נשאר ליעד (%)'],
    ...rows.map((x, i) => [i + 1, x.name, x.morning, x.afternoon, x.week, x.total, x.remaining_pct]),
  ], [5, 24, 16, 16, 13, 18, 14], fileName);
}

// All students A-Z with empty columns for the general-list items, to fill in by hand and copy in later.
async function viewBlankList(r) {
  const d = await api('/api/general?date=' + (r.week || state.today) + (r.reg ? '&reg=' + r.reg : ''));
  const cols = d.items.length ? d.items.map(it => it.name) : ['נוכחות'];
  const title = `רשימה למילוי · ${cols.join(', ')}`;
  const range = dateRange(d.week_start, addDays(d.week_start, 6));
  const sub = `${d.week ? weekLabel(d.week) + ' · ' : ''}${range}${r.reg ? ' · ' + regLabel(r.reg) : ''}`;
  const main = shell(`<h1>דוחות</h1><p class="sub">רשימה של כל התלמידים לפי א"ב, עם עמודות ריקות לרישום ביד. אחר כך מעתיקים למסך "רשימה כללית".</p>
    <div class="card no-print"><div class="toolbar">
      ${reportTypeSelect('blank')}
      <input type="date" id="r-date" value="${d.week_start}" title="שבוע">
      ${regSelect(r.reg)}
      <span class="spacer"></span>
      <button class="btn" id="r-pdf">הורדת PDF</button>
      <button class="btn secondary" id="r-xlsx">הורדת אקסל</button>
      <button class="btn ghost" id="r-print">הדפסה</button>
    </div></div>
    <div class="card report-doc" id="report-doc">
      <div class="report-head">
        ${state.settings.logo ? `<img src="${esc(state.settings.logo)}" alt="לוגו">` : ''}
        <div><div class="report-program">${esc(state.settings.program_name)}</div>
          <h2>${esc(title)}</h2>
          <div class="muted">${esc(sub)} · ${d.students.length} תלמידים</div></div>
      </div>
      <table class="report-table blank-table"><thead><tr><th class="num">#</th><th>שם התלמיד</th><th>קבוצת בוקר</th><th>קבוצת אחה"צ</th>
        ${cols.map(c => `<th class="blank-col">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${d.students.map((x, i) => `<tr><td class="num">${i + 1}</td><td>${esc(x.name)}</td>
        <td>${esc(x.morning)}</td><td>${esc(x.afternoon)}</td>${cols.map(() => '<td class="blank-col"></td>').join('')}</tr>`).join('')
        || `<tr><td colspan="${4 + cols.length}" class="empty">אין תלמידים</td></tr>`}</tbody></table>
    </div>`);
  const fileName = `רשימה למילוי ${cols.join(' ')} ${d.week ? weekLabel(d.week) : ''} ${regLabel(r.reg)}`.replace(/[\\/:*?"<>|·]/g, '').replace(/\s+/g, ' ').trim();
  main.querySelector('#r-type').onchange = ev => { r.type = ev.target.value; viewReport(); };
  main.querySelector('#r-date').onchange = ev => { if (ev.target.value) { r.week = weekStart(ev.target.value); viewReport(); } };
  main.querySelector('#r-reg').onchange = ev => { r.reg = ev.target.value; viewReport(); };
  main.querySelector('#r-print').onclick = () => window.print();
  main.querySelector('#r-pdf').onclick = () => printAsPdf(fileName);
  main.querySelector('#r-xlsx').onclick = () => downloadSheet([
    [state.settings.program_name], [title], [sub], [],
    ['#', 'שם התלמיד', 'קבוצת בוקר', 'קבוצת אחה"צ', ...cols],
    ...d.students.map((x, i) => [i + 1, x.name, x.morning, x.afternoon, ...cols.map(() => '')]),
  ], [5, 24, 16, 16, ...cols.map(() => 18)], fileName);
}

// ---------- admin ----------

async function viewAdmin(tab) {
  const views = { users: adminUsers, classes: adminClasses, students: adminStudents, items: adminItems,
                  weeks: adminWeeks, settings: adminSettings, faces: adminFaces, log: adminLog };
  if (!views[tab]) tab = 'students';
  if (['users', 'items', 'settings', 'faces'].includes(tab) && !isAdmin()) tab = 'students';
  if (!isStaff()) { location.hash = '#/entry'; return; }
  await views[tab]();
}

async function teachersList() {
  const { users } = await api('/api/admin/users');
  return users.filter(u => u.active);
}

async function adminUsers() {
  const { users } = await api('/api/admin/users');
  const main = shell(`<div class="toolbar"><h1>משתמשים</h1><span class="spacer"></span>
    <button class="btn" id="add">+ משתמש חדש</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>שם</th><th>שם משתמש</th><th>תפקיד</th>
      <th class="num">מורשה שחרית עש"ק/שב"ק</th><th class="num">פעיל</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td>${esc(u.display_name)}</td><td dir="ltr" style="text-align:right">${esc(u.username)}</td>
        <td>${ROLE[u.role]}</td><td class="num">${u.can_office ? '✓' : ''}</td>
        <td class="num">${u.active ? '<span class="badge ok">פעיל</span>' : '<span class="badge bad">מושבת</span>'}</td>
        <td><button class="btn secondary small" data-edit="${u.id}">עריכה</button></td></tr>`).join('')}
    </tbody></table></div></div>
    <p class="muted">משתמש חדש מתבקש לבחור סיסמה אישית בכניסה הראשונה.</p>`);
  const form = u => `
    ${u ? '' : '<label class="field">שם משתמש (באנגלית)<input type="text" name="username" dir="ltr" required></label>'}
    <label class="field">שם מלא<input type="text" name="display_name" value="${esc(u?.display_name)}" required></label>
    <label class="field">תפקיד<select name="role">${Object.entries(ROLE).map(([k, v]) =>
      `<option value="${k}" ${(u?.role || 'teacher') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field">${u ? 'סיסמה חדשה (ריק = ללא שינוי)' : 'סיסמה ראשונית'}<input type="text" name="password" ${u ? '' : 'required'} minlength="6"></label>
    <label class="check"><input type="checkbox" name="can_office" ${u?.can_office ? 'checked' : ''}> מורשה להזין שחרית עש"ק ושב"ק</label>
    ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> פעיל</label>` : ''}`;
  main.querySelector('#add').onclick = () => openDialog('משתמש חדש', form(null), async d => {
    await api('/api/admin/users', { body: { ...d, can_office: !!d.can_office } }); adminUsers();
  });
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.id === Number(b.dataset.edit));
    openDialog('עריכת משתמש', form(u), async d => {
      await api('/api/admin/users/' + u.id, { method: 'PUT', body: { ...d, can_office: !!d.can_office, active: !!d.active } });
      adminUsers();
    });
  });
}

async function adminClasses() {
  const [{ classes }, users] = await Promise.all([api('/api/admin/classes'), teachersList()]);
  const name = id => esc(users.find(u => u.id === id)?.display_name || '—');
  const main = shell(`<div class="toolbar"><h1>קבוצות</h1><span class="spacer"></span>
    <button class="btn" id="add">+ קבוצה חדשה</button></div>
    <p class="sub">לכל קבוצה מורה אחד, בבוקר או אחה"צ, ואפשר להוסיף מורים נוספים שיוכלו להזין לה נקודות. לכל תלמיד יש קבוצת בוקר וקבוצת אחה"צ.</p>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>קבוצה</th><th>זמן</th><th>מורה</th>
      <th class="num">תלמידים</th><th></th></tr></thead><tbody>
      ${classes.map(c => `<tr><td><a href="#/class/${c.id}">${esc(c.name)}</a></td><td>${SHIFT[c.shift]}</td>
        <td>${c.teacher_id ? name(c.teacher_id) : '<span class="badge bad">לא שויך מורה</span>'}${c.helpers?.length
          ? `<div class="muted small">גם: ${c.helpers.map(name).join(', ')}</div>` : ''}</td><td class="num">${c.student_count}</td>
        <td><button class="btn secondary small" data-edit="${c.id}">עריכה</button>
        <button class="btn danger small" data-del="${c.id}">מחיקה</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">אין קבוצות. הן נוצרות לבד בייבוא תלמידים מאקסל.</td></tr>'}
    </tbody></table></div></div>`);
  const teacherOpts = sel => '<option value="">—</option>' + users.filter(u => u.role === 'teacher')
    .map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.display_name)}</option>`).join('');
  const form = c => `<label class="field">שם הקבוצה<input type="text" name="name" value="${esc(c?.name)}" required></label>
    <label class="field">זמן<select name="shift">${['morning', 'afternoon'].map(sh =>
      `<option value="${sh}" ${(c?.shift || 'morning') === sh ? 'selected' : ''}>${SHIFT[sh]}</option>`).join('')}</select></label>
    <label class="field">מורה<select name="teacher_id">${teacherOpts(c?.teacher_id)}</select></label>
    <div class="field">מורים נוספים שיכולים להזין נקודות לקבוצה<div class="form-row">${users.filter(u => u.role === 'teacher').map(u =>
      `<label class="check"><input type="checkbox" name="h${u.id}" ${c?.helpers?.includes(u.id) ? 'checked' : ''}>${esc(u.display_name)}</label>`).join('')
      || '<span class="muted">אין מורים במערכת</span>'}</div></div>
    <label class="field">סדר תצוגה<input type="number" name="sort" value="${c?.sort ?? 0}"></label>`;
  const body = d => ({ ...d, teacher_id: Number(d.teacher_id) || null,
    helpers: Object.keys(d).filter(k => /^h\d+$/.test(k) && d[k]).map(k => Number(k.slice(1))) });
  main.querySelector('#add').onclick = () => openDialog('קבוצה חדשה', form(null), async d => {
    await api('/api/admin/classes', { body: body(d) }); adminClasses();
  });
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const c = classes.find(x => x.id === Number(b.dataset.edit));
    openDialog('עריכת קבוצה', form(c), async d => {
      await api('/api/admin/classes/' + c.id, { method: 'PUT', body: body(d) }); adminClasses();
    });
  });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('למחוק את הקבוצה?')) return;
    try { await api('/api/admin/classes/' + b.dataset.del, { method: 'DELETE' }); adminClasses(); }
    catch (err) { alert(err.message); }
  });
}

async function adminStudents() {
  const [{ students }, { classes }] = await Promise.all([api('/api/admin/students'), api('/api/admin/classes')]);
  const main = shell(`<div class="toolbar"><h1>תלמידים</h1><span class="spacer"></span>
    <button class="btn secondary" id="import">ייבוא מאקסל</button><button class="btn" id="add">+ תלמיד</button></div>
    <div class="card"><div class="toolbar">
      <input type="text" id="q" placeholder="חיפוש שם">
      <select id="fc"><option value="">כל הקבוצות</option>${classes.map(c =>
        `<option value="${c.id}">${esc(c.name)} · ${SHIFT[c.shift]}</option>`).join('')}</select>
      <select id="freg"><option value="">נרשמו ולא נרשמו</option><option value="yes">רק נרשמו</option><option value="no">רק לא נרשמו</option></select>
      <label class="check"><input type="checkbox" id="inactive"> הצג לא פעילים</label>
      <span class="spacer"></span><span class="muted" id="count"></span></div>
      <div class="table-wrap"><table><thead><tr><th>שם</th><th>קבוצת בוקר</th><th>קבוצת אחה"צ</th><th>טלפון</th><th class="num">נרשם</th><th class="num">מצב</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div></div>`);
  const draw = () => {
    const q = main.querySelector('#q').value.trim();
    const fc = Number(main.querySelector('#fc').value);
    const showInactive = main.querySelector('#inactive').checked;
    const freg = main.querySelector('#freg').value;
    const list = students.filter(s => (showInactive || s.active)
      && (!freg || (freg === 'yes') === !!s.registered)
      && (!fc || s.morning_class_id === fc || s.afternoon_class_id === fc)
      && (!q || `${s.first_name} ${s.last_name} ${s.phone}`.includes(q)));
    main.querySelector('#count').textContent = `${list.length} תלמידים · ${list.filter(s => s.registered).length} נרשמו`;
    main.querySelector('#rows').innerHTML = list.map(s => `<tr>
      <td><a href="#/student/${s.id}">${esc(s.first_name)} ${esc(s.last_name)}</a></td>
      <td>${s.morning_class_name ? esc(s.morning_class_name) : '<span class="badge bad">חסר</span>'}</td>
      <td>${s.afternoon_class_name ? esc(s.afternoon_class_name) : '<span class="badge bad">חסר</span>'}</td>
      <td dir="ltr" style="text-align:right">${esc(s.phone) || '<span class="muted">—</span>'}</td>
      <td class="num"><input type="checkbox" data-reg="${s.id}" ${s.registered ? 'checked' : ''} title="נרשם"></td>
      <td class="num">${s.active ? '' : '<span class="badge bad">לא פעיל</span>'}</td>
      <td><button class="btn secondary small" data-edit="${s.id}">עריכה</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">אין תלמידים</td></tr>';
    main.querySelectorAll('[data-reg]').forEach(b => b.onchange = async () => {
      const s = students.find(x => x.id === Number(b.dataset.reg));
      try {
        await api(`/api/admin/students/${s.id}/registered`, { method: 'PUT', body: { registered: b.checked } });
        s.registered = b.checked ? 1 : 0;
        main.querySelector('#count').textContent = `${list.length} תלמידים · ${list.filter(x => x.registered).length} נרשמו`;
      } catch (err) { b.checked = !b.checked; toast(err.message, 4000); }
    });
    main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(students.find(s => s.id === Number(b.dataset.edit))));
  };
  const groupOpts = (shift, sel) => '<option value="">—</option>' + classes.filter(c => c.shift === shift).map(c =>
    `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const form = s => `<label class="field">שם (למשל: כהן יוסף)<input type="text" name="first_name" value="${esc(s?.first_name)}" required></label>
    <label class="field">שם נוסף (לא חובה)<input type="text" name="last_name" value="${esc(s?.last_name)}"></label>
    <label class="field">קבוצת בוקר<select name="morning_class_id">${groupOpts('morning', s?.morning_class_id)}</select></label>
    <label class="field">קבוצת אחה"צ<select name="afternoon_class_id">${groupOpts('afternoon', s?.afternoon_class_id)}</select></label>
    <label class="field">טלפון לבדיקת נקודות בקו (כמה מספרים מפרידים בפסיק)<input type="tel" name="phone" dir="ltr" value="${esc(s?.phone)}"></label>
    <label class="check"><input type="checkbox" name="registered" ${s?.registered ? 'checked' : ''}> נרשם למבצע</label>
    ${s ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> פעיל (הסרה מהרשימה שומרת את הנקודות)</label>` : ''}`;
  const body = d => ({ ...d, morning_class_id: Number(d.morning_class_id) || null, afternoon_class_id: Number(d.afternoon_class_id) || null,
    registered: !!d.registered });
  const edit = s => openDialog('עריכת תלמיד', form(s), async d => {
    await api('/api/admin/students/' + s.id, { method: 'PUT', body: { ...body(d), active: !!d.active } });
    adminStudents();
  });
  main.querySelector('#add').onclick = () => openDialog('תלמיד חדש', form(null), async d => {
    await api('/api/admin/students', { body: body(d) }); adminStudents();
  });
  main.querySelector('#import').onclick = importStudents;
  ['#q', '#fc', '#freg', '#inactive'].forEach(sel => main.querySelector(sel).addEventListener('input', draw));
  draw();
}

function importStudents() {
  const dlg = openDialog('ייבוא תלמידים מאקסל', `
    <p class="muted">בחר קובץ אקסל או CSV. השורה הראשונה צריכה להיות כותרות. אחר כך בחר איזו עמודה היא מה.</p>
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div id="map"></div>`, async () => {
    if (!dlg.rows) throw new Error('יש לבחור קובץ');
    const pick = n => Number(dlg.querySelector(`[name=${n}]`).value);
    const [fi, li, mi, ai, pi] = [pick('c_first'), pick('c_last'), pick('c_morning'), pick('c_afternoon'), pick('c_phone')];
    const cell = (r, i) => i >= 0 ? String(r[i] ?? '').trim() : '';
    const rows = dlg.rows.slice(1).map(r => ({
      first_name: cell(r, fi), last_name: cell(r, li), morning_class: cell(r, mi), afternoon_class: cell(r, ai), phone: cell(r, pi),
    })).filter(r => r.first_name);
    const phonesOnly = !!dlg.querySelector('[name=phones_only]')?.checked;
    const markRegistered = !!dlg.querySelector('[name=mark_registered]')?.checked;
    const res = await api('/api/admin/students/import', { body: { rows, phones_only: phonesOnly, mark_registered: markRegistered } });
    adminStudents();
    if (phonesOnly) {
      openDialog('עדכון תלמידים קיימים', `<p>עודכנו טלפונים ל-<strong>${res.updated}</strong> תלמידים.</p>${markRegistered
        ? `<p>סומנו כנרשמו: <strong>${res.registered}</strong> תלמידים.</p>` : ''}${res.not_found.length
        ? `<p>השמות האלה לא נמצאו במערכת, ולא נוספו (אפשר להוסיף להם טלפון ביד בעריכת תלמיד):</p><p class="muted">${res.not_found.map(esc).join('<br>')}</p>` : ''}`,
        async () => {}, 'סגירה');
    } else {
      toast(`נוספו ${res.added} תלמידים ו-${res.new_classes} קבוצות חדשות${res.updated ? `, ועודכנו טלפונים ל-${res.updated} תלמידים קיימים` : ''}${res.registered ? `. סומנו ${res.registered} כנרשמו` : ''}`, 6000);
    }
  }, 'ייבוא');
  dlg.querySelector('#file').onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    if (!window.XLSX) { dlg.querySelector('.error').textContent = 'רכיב האקסל לא נטען. נסה לרענן את הדף.'; return; }
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      .filter(r => r.some(c => String(c).trim()));
    dlg.rows = rows;
    const head = rows[0] || [];
    const guess = re => head.findIndex(h => re.test(String(h)));
    const opts = (sel, allowNone) => (allowNone ? '<option value="-1">— אין —</option>' : '') +
      head.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || 'עמודה ' + (i + 1))}</option>`).join('');
    const gf = guess(/שם/), gm = guess(/בוקר|סדר א/), ga = guess(/אחה|סדר ב/), gp = guess(/טל|פלאפון|נייד|phone/i);
    dlg.querySelector('#map').innerHTML = `
      <label class="field">עמודת השם<select name="c_first">${opts(gf >= 0 ? gf : 0)}</select></label>
      <label class="field">עמודת שם נוסף (אם השם מפוצל לשתי עמודות)<select name="c_last">${opts(-1, true)}</select></label>
      <label class="field">עמודת קבוצת בוקר<select name="c_morning">${opts(gm, true)}</select></label>
      <label class="field">עמודת קבוצת אחה"צ<select name="c_afternoon">${opts(ga, true)}</select></label>
      <label class="field">עמודת טלפון<select name="c_phone">${opts(gp, true)}</select></label>
      <label class="check"><input type="checkbox" name="mark_registered"> כל התלמידים בקובץ נרשמו למבצע (לסמן אותם כנרשמו)</label>
      <label class="check"><input type="checkbox" name="phones_only"> רק לעדכן תלמידים שכבר קיימים (לא להוסיף תלמידים חדשים)</label>
      <p class="muted">נמצאו ${rows.length - 1} תלמידים. קבוצות שלא קיימות ייווצרו לבד, וקבוצה ששמה זהה לשם של מורה במערכת תשויך אליו.
        תלמיד שכבר קיים במערכת באותו שם לא ייווסף שוב, רק יעודכן לו הטלפון.</p>`;
  };
}

async function adminItems() {
  const { items } = await api('/api/admin/items');
  const rules = state.settings.exam_rules;
  const weekly = items.filter(i => i.active).reduce((a, i) =>
    a + (i.kind === 'daily' ? i.points * i.days.split(',').filter(Boolean).length : i.kind === 'weekly' ? i.points : 0), 0);
  const main = shell(`<div class="toolbar"><h1>הגדרת ניקוד</h1><span class="spacer"></span>
    <button class="btn" id="add">+ סעיף</button></div>
    <p class="sub">שינוי נקודות חל גם על שבועות שכבר הוזנו. מקסימום שבועי בלי מבחנים: <strong>${weekly}</strong></p>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>סעיף</th><th>סוג</th><th>מי מזין</th>
      <th class="num">נקודות</th><th>ימים</th><th class="num">פעיל</th><th></th></tr></thead><tbody>
      ${items.map(i => `<tr><td>${esc(i.name)}</td><td>${KIND[i.kind]}</td><td>${i.general ? 'רשימה כללית' : SHIFT[i.shift]}</td>
        <td class="num">${i.kind === 'exam' ? 'לפי ציון' : i.points}</td>
        <td>${i.kind === 'exam' ? '' : i.days.split(',').filter(Boolean).map(d => DAYS[d]).join(' ')}</td>
        <td class="num">${i.active ? '✓' : ''}</td><td><button class="btn secondary small" data-edit="${i.id}">עריכה</button></td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>המרת ציון מבחן לנקודות</h2>
      <div id="rules">${rules.map(r => ruleRow(r)).join('')}</div>
      <div class="toolbar" style="margin-top:12px"><button class="btn secondary small" id="addrule">+ שורה</button>
        <button class="btn" id="saverules">שמירת כללים</button></div>
      <p class="muted">ציון מתחת לשורה הנמוכה ביותר מקבל 0.</p></div>`);
  const form = i => `<label class="field">שם<input type="text" name="name" value="${esc(i?.name)}" required></label>
    <label class="field">סוג<select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${(i?.kind || 'daily') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field">מי מזין<select name="shift">${Object.entries(SHIFT).map(([k, v]) => `<option value="${k}" ${!i?.general && (i?.shift || 'morning') === k ? 'selected' : ''}>${v === 'מזכירות' ? 'מזכיר + מורה מורשה, בטבלת הקבוצה' : 'מורה ' + v}</option>`).join('')}
      <option value="general" ${i?.general ? 'selected' : ''}>מזכיר, רשימה כללית של כל התלמידים</option></select></label>
    <label class="field">נקודות לפעם (במבחן לא בשימוש)<input type="number" name="points" value="${i?.points ?? 0}"></label>
    <div class="field">ימים (לסעיף יומי: ימי לימוד; לשבועי: היום שבו הוא מתקיים)<div class="form-row">${DAYS.map((d, n) =>
      `<label class="check"><input type="checkbox" name="d${n}" ${(i ? i.days.split(',') : ['0', '1', '2', '3', '4']).includes(String(n)) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
    <label class="field">סדר<input type="number" name="sort" value="${i?.sort ?? 0}"></label>
    ${i ? `<label class="check"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> פעיל</label>` : ''}`;
  const body = d => ({ ...d, shift: d.shift === 'general' ? 'office' : d.shift, general: d.shift === 'general', days: DAYS.map((_, n) => d['d' + n] ? n : null).filter(n => n !== null).join(','), active: !!d.active });
  main.querySelector('#add').onclick = () => openDialog('סעיף חדש', form(null), async d => {
    await api('/api/admin/items', { body: body(d) }); adminItems();
  });
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const it = items.find(x => x.id === Number(b.dataset.edit));
    openDialog('עריכת סעיף', form(it), async d => {
      await api('/api/admin/items/' + it.id, { method: 'PUT', body: body(d) }); adminItems();
    });
  });
  main.querySelector('#addrule').onclick = () => main.querySelector('#rules').insertAdjacentHTML('beforeend', ruleRow({ min: '', points: '' }));
  main.querySelector('#saverules').onclick = async () => {
    const list = [...main.querySelectorAll('.rule')].map(r => ({
      min: Number(r.querySelector('[name=min]').value), points: Number(r.querySelector('[name=pts]').value) }))
      .filter(r => r.min > 0 || r.points > 0);
    await api('/api/admin/settings', { method: 'PUT', body: { exam_rules: list } });
    state.settings.exam_rules = list.sort((a, b) => b.min - a.min);
    toast('הכללים נשמרו');
    adminItems();
  };
}
const ruleRow = r => `<div class="form-row rule" style="margin-bottom:8px">
  <label class="field">ציון מינימלי<input type="number" name="min" value="${r.min}" min="0" max="100" style="width:110px"></label>
  <label class="field">נקודות<input type="number" name="pts" value="${r.points}" style="width:110px"></label></div>`;

async function adminWeeks() {
  const { weeks, days_off, parashot } = await api('/api/admin/weeks');
  const active = weeks.filter(w => !w.vacation).length;
  const main = shell(`<h1>לוח שבועות</h1>
    <p class="sub">${weeks.length ? `${active} שבועות לימוד${weeks.length > active ? ` ו-${weeks.length - active} שבועות חופשה` : ''}` : 'עדיין לא נוצר לוח שבועות'}</p>
    ${isAdmin() ? `<div class="card"><h2>${weeks.length ? 'הוספת שבועות' : 'יצירת לוח שבועות'}</h2>
      <div class="form-row">
        <label class="field">תאריך תחילה<input type="date" id="g-start" value="${weeks.length ? addDays(weeks[weeks.length - 1].start_date, 7) : weekStart(state.today)}"></label>
        <label class="field">פרשת השבוע הראשון<select id="g-par">${parashot.map(p => `<option>${p}</option>`).join('')}</select></label>
        <label class="field">מספר שבועות<input type="number" id="g-count" value="${weeks.length ? 1 : 19}" min="1" max="40" style="width:90px"></label>
        <button class="btn" id="gen">יצירה</button></div>
      <p class="muted">אפשר לתקן את שם הפרשה בכל שבוע. שבוע שמסומן כחופשה לא נספר.</p></div>` : ''}
    <div class="card"><div class="table-wrap"><table><thead><tr><th class="num">#</th><th>תאריכים</th><th>פרשה</th>
      <th class="num">חופשה</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${(() => { let n = 0; return weeks.map(w => `<tr><td class="num">${w.vacation ? '' : ++n}</td>
        <td>${dateRange(w.start_date, addDays(w.start_date, 6))} <span class="muted">${hebDate(w.start_date)}</span></td>
        <td>${isAdmin() ? `<input type="text" value="${esc(w.parasha)}" data-par="${w.id}" style="width:130px">` : esc(w.parasha)}</td>
        <td class="num"><input type="checkbox" data-vac="${w.id}" ${w.vacation ? 'checked' : ''} ${isAdmin() ? '' : 'disabled'}></td>
        ${isAdmin() ? `<td><button class="btn danger small" data-del="${w.id}">מחיקה</button></td>` : ''}</tr>`).join(''); })()
      || '<tr><td colspan="5" class="empty">אין שבועות</td></tr>'}
    </tbody></table></div></div>
    <div class="card"><h2>ימים ללא לימודים</h2>
      <div class="form-row"><label class="field">תאריך<input type="date" id="off-date"></label>
        <label class="field">הערה<input type="text" id="off-note" placeholder="למשל: תענית"></label>
        <button class="btn secondary" id="off-add">הוספה</button></div>
      <div style="margin-top:12px">${days_off.map(d => `<div class="list-row"><span>${shortDate(d.date)} · ${dayName(d.date)} · ${hebDate(d.date)} ${d.note ? '· ' + esc(d.note) : ''}</span>
        <button class="btn danger small" data-off="${d.date}">הסרה</button></div>`).join('') || '<div class="muted">אין</div>'}</div></div>`);
  const save = async id => {
    const w = weeks.find(x => x.id === id);
    await api('/api/admin/weeks/' + id, { method: 'PUT', body: {
      parasha: main.querySelector(`[data-par="${id}"]`)?.value ?? w.parasha,
      vacation: main.querySelector(`[data-vac="${id}"]`).checked } });
    toast('נשמר');
  };
  main.querySelector('#gen')?.addEventListener('click', async () => {
    await api('/api/admin/weeks/generate', { body: { start_date: main.querySelector('#g-start').value,
      first_parasha: main.querySelector('#g-par').value, count: main.querySelector('#g-count').value } });
    adminWeeks();
  });
  main.querySelectorAll('[data-par]').forEach(i => i.onchange = () => save(Number(i.dataset.par)));
  main.querySelectorAll('[data-vac]').forEach(i => i.onchange = async () => { await save(Number(i.dataset.vac)); adminWeeks(); });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('למחוק את השבוע מהלוח? הנקודות שהוזנו בו יישמרו.')) return;
    await api('/api/admin/weeks/' + b.dataset.del, { method: 'DELETE' }); adminWeeks();
  });
  main.querySelector('#off-add').onclick = async () => {
    const date = main.querySelector('#off-date').value;
    if (!date) return;
    await api('/api/admin/days-off', { body: { date, note: main.querySelector('#off-note').value } }); adminWeeks();
  };
  main.querySelectorAll('[data-off]').forEach(b => b.onclick = async () => {
    await api('/api/admin/days-off/' + b.dataset.off, { method: 'DELETE' }); adminWeeks();
  });
}

async function adminSettings() {
  const s = state.settings;
  const main = shell(`<h1>הגדרות</h1>
    <div class="card"><h2>כללי</h2><div class="form-row">
      <label class="field">שם המבצע<input type="text" id="name" value="${esc(s.program_name)}" style="width:240px"></label>
      <label class="field">יעד נקודות לתלמיד<input type="number" id="target" value="${s.target}" style="width:120px"></label>
      <label class="field">ימים אחרי סוף השבוע שמורה עדיין יכול לתקן<input type="number" id="edit" value="${s.edit_days}" min="0" style="width:120px"></label>
      <button class="btn" id="save">שמירה</button></div></div>
    <div class="card"><h2>לוגו המבצע</h2>
      <div class="form-row">${s.logo ? `<img class="logo-preview" src="${esc(s.logo)}">` : '<span class="muted">לא הועלה לוגו</span>'}
        <input type="file" id="logo" accept="image/*">${s.logo ? '<button class="btn danger small" id="nologo">הסרה</button>' : ''}</div>
      <p class="muted">הלוגו יופיע בראש כל דף ובמסך הכניסה. מומלץ PNG עם רקע שקוף.</p></div>
    <div class="card"><h2>קו טלפון לבדיקת נקודות (ימות המשיח)</h2>
      <p class="muted">זו הכתובת שמגדירים בשלוחת API בימות המשיח. התלמיד מתקשר, והמערכת מזהה אותו לפי הטלפון הרשום אצלו ומקריאה לו את הנקודות. אל תפרסם את הכתובת.</p>
      <div class="form-row"><input type="text" id="yemot" dir="ltr" readonly style="width:100%;max-width:560px" value="טוען...">
        <button class="btn secondary small" id="ycopy">העתקה</button>
        <button class="btn ghost small" id="ynew">יצירת כתובת חדשה</button></div></div>
    <div class="card"><h2>גיבוי</h2><p class="muted">המערכת שומרת גיבוי אוטומטי כל יום (14 הימים האחרונים). אפשר גם להוריד עותק למחשב.</p>
      <a class="btn secondary" href="/api/admin/backup">הורדת גיבוי</a></div>`);
  const yemotInput = main.querySelector('#yemot');
  const showYemot = t => { yemotInput.value = `${location.origin}/yemot/points?token=${t}`; };
  api('/api/admin/yemot').then(r => showYemot(r.token));
  main.querySelector('#ycopy').onclick = () => { navigator.clipboard?.writeText(yemotInput.value); yemotInput.select(); toast('הכתובת הועתקה'); };
  main.querySelector('#ynew').onclick = async () => {
    if (!confirm('הכתובת הקודמת תפסיק לעבוד, וצריך יהיה לעדכן אותה בימות המשיח. להמשיך?')) return;
    showYemot((await api('/api/admin/yemot/regenerate', { body: {} })).token);
  };
  main.querySelector('#save').onclick = async () => {
    const body = { program_name: main.querySelector('#name').value, target: main.querySelector('#target').value,
                   edit_days: main.querySelector('#edit').value };
    await api('/api/admin/settings', { method: 'PUT', body });
    Object.assign(state.settings, { ...body, target: Number(body.target), edit_days: Number(body.edit_days) });
    toast('נשמר');
    adminSettings();
  };
  main.querySelector('#logo').onchange = ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      // shrink to keep the database small
      const scale = Math.min(1, 400 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const logo = c.toDataURL('image/png');
      await api('/api/admin/settings', { method: 'PUT', body: { logo } });
      state.settings.logo = logo;
      adminSettings();
    };
    img.src = URL.createObjectURL(file);
  };
  main.querySelector('#nologo')?.addEventListener('click', async () => {
    await api('/api/admin/settings', { method: 'PUT', body: { logo: '' } });
    state.settings.logo = '';
    adminSettings();
  });
}

// ---------- admin: face recognition tablet ----------

async function adminFaces() {
  const d = await api('/api/admin/faces');
  const kioskUrl = key => `${location.origin}/kiosk#${key}`;
  const main = shell(`<h1>זיהוי פנים</h1>
    <p class="sub">עמדת טאבלט שבה תלמידים שאושרו נרשמים לנוכחות מול המצלמה. התמונות עצמן לא נשמרות, רק "טביעה מספרית" של הפנים.</p>
    <div class="card"><h2>עמדת הטאבלט</h2>
      <p class="muted">פותחים את הקישור בטאבלט ב-Chrome או ב-Edge, מאשרים שימוש במצלמה, ולוחצים "מסך מלא". אל תפרסם את הקישור.</p>
      <div class="form-row"><input type="text" id="kiosk" dir="ltr" readonly style="width:100%;max-width:560px" value="${esc(kioskUrl(d.kiosk_key))}">
        <button class="btn secondary small" id="kcopy">העתקה</button>
        <a class="btn secondary small" id="kopen" href="${esc(kioskUrl(d.kiosk_key))}" target="_blank">פתיחה</a>
        <button class="btn ghost small" id="knew">יצירת קישור חדש</button></div>
      <label class="check-row"><input type="checkbox" id="daily" ${d.daily_mode ? 'checked' : ''}>
        <span><strong>נוכחות יומית פעילה</strong><br><span class="muted">${d.daily_mode
          ? 'פעיל: המורים מסמנים לפי ימים, ורישום במצלמה נכנס מיד לנקודות.'
          : 'כבוי (מצב ניסיון): המורים ממשיכים להזין מספר לשבוע כמו היום. רישומי המצלמה נשמרים ומוצגים כאן, אבל לא משנים נקודות.'}</span></span></label>
    </div>
    <div class="card"><h2>תלמידים</h2>
      <div class="toolbar"><input type="search" id="find" placeholder="חיפוש תלמיד" style="width:200px">
        <label><input type="checkbox" id="onlyAllowed"> רק מי שרשאי</label>
        <span class="spacer"></span><span class="muted" id="fcount"></span></div>
      <div class="table-wrap"><table><thead><tr><th>תלמיד</th><th>קבוצות</th><th class="num">רשאי למצלמה</th><th>פנים</th><th></th></tr></thead>
        <tbody id="frows"></tbody></table></div></div>
    <div class="card"><h2>שעות רישום במצלמה</h2>
      <p class="muted">לכל סעיף: מתי העמדה מתחילה לרשום, עד מתי נחשב "נוכח", ועד מתי "איחר" (0 נקודות, המורה יכול לתקן). אחרי זה לא נרשם כלום. סעיף בלי שעות לא נרשם במצלמה.</p>
      <div id="wins"></div><button class="btn" id="wsave">שמירת השעות</button></div>
    <div class="card"><h2>משפטי משוב</h2>
      <p class="muted">משפט אחד בכל שורה, והמערכת בוחרת אחד באקראי. {שם} מוחלף בשם הפרטי של התלמיד.</p>
      <div class="grid grid-2">
        <label class="field">למי שהגיע בזמן<textarea id="gp" rows="5">${esc(d.greetings_present)}</textarea></label>
        <label class="field">למי שאיחר<textarea id="gl" rows="5">${esc(d.greetings_late)}</textarea></label></div>
      <button class="btn" id="gsave">שמירת המשפטים</button></div>
    <div class="card"><h2>נרשמו במצלמה היום</h2>
      ${d.log.length ? `<div class="table-wrap"><table><thead><tr><th>שעה</th><th>תלמיד</th><th>סעיף</th><th>מצב</th></tr></thead><tbody>
        ${d.log.map(r => `<tr><td>${esc(r.at)}</td><td>${esc(r.name)}</td><td>${esc(r.item)}</td>
          <td>${r.status === 'present' ? 'נוכח' : '<span class="late-tag">איחר</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">עדיין אין רישומים היום.</div>'}</div>`);

  main.querySelector('#kcopy').onclick = () => { navigator.clipboard?.writeText(main.querySelector('#kiosk').value); toast('הקישור הועתק'); };
  main.querySelector('#knew').onclick = async () => {
    if (!confirm('הקישור הקודם יפסיק לעבוד, וצריך יהיה לפתוח את החדש בטאבלט. להמשיך?')) return;
    await api('/api/admin/kiosk/regenerate', { body: {} });
    adminFaces();
  };
  main.querySelector('#daily').onchange = async ev => {
    const on = ev.target.checked;
    if (!confirm(on
      ? 'להפעיל נוכחות יומית? המורים יראו מיד ריבועי ימים במקום מספר, ורישומי המצלמה ייכנסו לנקודות. הנקודות שכבר הוזנו לא משתנות.'
      : 'לכבות נוכחות יומית? המורים יחזרו להזין מספר לשבוע, והמצלמה תעבור למצב ניסיון.')) { ev.target.checked = !on; return; }
    await api('/api/admin/settings', { method: 'PUT', body: { daily_mode: on ? '1' : '0' } });
    state.settings.daily_mode = on;
    toast('נשמר');
    adminFaces();
  };

  // students
  const drawStudents = () => {
    const q = main.querySelector('#find').value.trim();
    const only = main.querySelector('#onlyAllowed').checked;
    const rows = d.students.filter(st => (!q || st.name.includes(q)) && (!only || st.face_allowed));
    main.querySelector('#fcount').textContent = `${d.students.filter(st => st.face_allowed).length} רשאים · ${d.students.filter(st => st.faces).length} עם פנים רשומות`;
    main.querySelector('#frows').innerHTML = rows.map(st => `<tr><td>${esc(st.name)}</td><td class="muted">${esc(st.groups)}</td>
      <td class="num"><input type="checkbox" data-allow="${st.id}" ${st.face_allowed ? 'checked' : ''}></td>
      <td>${st.faces ? `<span class="ok-tag">רשום</span>` : st.face_allowed ? '<span class="muted">לא נרשם</span>' : ''}</td>
      <td>${st.face_allowed ? `<button class="btn secondary small" data-enroll="${st.id}">${st.faces ? 'רישום מחדש' : 'רישום פנים'}</button>
        ${st.faces ? `<button class="btn ghost small" data-unenroll="${st.id}">מחיקת פנים</button>` : ''}` : ''}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">אין תלמידים להצגה</td></tr>';
    main.querySelectorAll('[data-allow]').forEach(cb => cb.onchange = async () => {
      const st = d.students.find(x => x.id === Number(cb.dataset.allow));
      if (!cb.checked && st.faces && !confirm(`להסיר את ${st.name}? הפנים הרשומות שלו יימחקו.`)) { cb.checked = true; return; }
      await api(`/api/admin/faces/${st.id}`, { method: 'PUT', body: { face_allowed: cb.checked } });
      st.face_allowed = cb.checked;
      if (!cb.checked) st.faces = 0;
      drawStudents();
    });
    main.querySelectorAll('[data-enroll]').forEach(b => b.onclick = () =>
      enrollFace(d.students.find(x => x.id === Number(b.dataset.enroll)), drawStudents));
    main.querySelectorAll('[data-unenroll]').forEach(b => b.onclick = async () => {
      const st = d.students.find(x => x.id === Number(b.dataset.unenroll));
      if (!confirm(`למחוק את הפנים הרשומות של ${st.name}?`)) return;
      await api(`/api/admin/faces/${st.id}/enroll`, { method: 'DELETE' });
      st.faces = 0;
      drawStudents();
    });
  };
  main.querySelector('#find').oninput = drawStudents;
  main.querySelector('#onlyAllowed').onchange = drawStudents;
  drawStudents();

  // time windows
  const wins = d.windows.map(w => ({ ...w, weekday: w.weekday ?? '' }));
  const drawWindows = () => {
    main.querySelector('#wins').innerHTML = `<div class="table-wrap"><table><thead><tr><th>סעיף</th><th>יום</th><th>פתיחה</th>
      <th>נוכח עד</th><th>איחור עד</th><th></th></tr></thead><tbody>
      ${d.items.map(it => {
        const mine = wins.filter(w => w.item_id === it.id);
        const days = it.days.split(',').filter(Boolean).map(Number);
        const row = (w, first) => `<tr><td>${first ? `<strong>${esc(it.name)}</strong>` : ''}</td>
          <td><select data-w="${wins.indexOf(w)}" data-f="weekday"><option value="">${days.length > 1 ? 'כל הימים' : 'יום ' + DAYS[days[0]]}</option>
            ${days.length > 1 ? days.map(n => `<option value="${n}" ${String(w.weekday) === String(n) ? 'selected' : ''}>יום ${DAYS[n]}</option>`).join('') : ''}</select></td>
          ${['start', 'present_until', 'late_until'].map(f => `<td><input type="time" data-w="${wins.indexOf(w)}" data-f="${f}" value="${w[f]}"></td>`).join('')}
          <td><button class="btn ghost small" data-wdel="${wins.indexOf(w)}">הסרה</button></td></tr>`;
        return (mine.length ? mine.map((w, i) => row(w, i === 0)).join('')
          : `<tr><td><strong>${esc(it.name)}</strong></td><td colspan="4" class="muted">לא נרשם במצלמה</td><td></td></tr>`)
          + `<tr class="addrow"><td></td><td colspan="5"><button class="btn ghost small" data-wadd="${it.id}">+ ${mine.length ? 'שעה ליום מסוים' : 'הוספת שעות'}</button></td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted small">שורה של "כל הימים" חלה בכל ימי הסעיף. שורה של יום מסוים (למשל שחרית ביום ו') גוברת עליה באותו יום אם השעות חופפות.</p>`;
    main.querySelectorAll('#wins [data-f]').forEach(inp => inp.onchange = () => { wins[Number(inp.dataset.w)][inp.dataset.f] = inp.value; });
    main.querySelectorAll('[data-wdel]').forEach(b => b.onclick = () => { wins.splice(Number(b.dataset.wdel), 1); drawWindows(); });
    main.querySelectorAll('[data-wadd]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.wadd);
      const prev = wins.find(w => w.item_id === id);
      wins.push({ item_id: id, weekday: '', start: prev?.start || '', present_until: prev?.present_until || '', late_until: prev?.late_until || '' });
      drawWindows();
    });
  };
  drawWindows();
  main.querySelector('#wsave').onclick = async () => {
    try {
      await api('/api/admin/windows', { method: 'PUT', body: { windows: wins } });
      toast('השעות נשמרו');
    } catch (err) { toast(err.message, 4000); }
  };
  main.querySelector('#gsave').onclick = async () => {
    await api('/api/admin/settings', { method: 'PUT', body: {
      greetings_present: main.querySelector('#gp').value, greetings_late: main.querySelector('#gl').value } });
    toast('המשפטים נשמרו');
  };
}

// Takes 5 samples of the student's face from the camera of this device and saves them.
function enrollFace(st, done) {
  const SAMPLES = 5;
  const samples = [];
  let running = true;
  let face;
  const dlg = openDialog(`רישום פנים: ${st.name}`, `
    <p class="muted">התלמיד עומד מול המצלמה במרחק של כחצי מטר, באור טוב ובלי כובע. בין צילום לצילום מזיזים מעט את הראש.</p>
    <div class="enroll-cam"><video id="ev" playsinline muted></video></div>
    <div class="enroll-status" id="es">טוען את מנגנון הזיהוי...</div>
    <div class="enroll-dots">${Array.from({ length: SAMPLES }, (_, i) => `<i id="ed${i}"></i>`).join('')}</div>`,
    async () => {
      if (samples.length < SAMPLES) throw new Error('הצילום עוד לא הסתיים');
      const r = await api(`/api/admin/faces/${st.id}/enroll`, { body: { descriptors: samples } });
      st.faces = samples.length;
      done();
      if (r.similar) toast(`נשמר. שים לב: הפנים דומות מאוד לפנים של ${r.similar}. כדאי לוודא שצולם התלמיד הנכון.`, 7000);
      else toast('הפנים נרשמו');
    }, 'שמירה');
  const video = dlg.querySelector('#ev');
  const status = dlg.querySelector('#es');
  dlg.addEventListener('close', () => { running = false; face?.stopCamera(video); });
  (async () => {
    try {
      face = await import('/face.js');
      await face.loadFaceApi();
      await face.startCamera(video);
    } catch (err) { status.textContent = err.message || 'טעינת הזיהוי נכשלה'; return; }
    status.textContent = 'מחפש פנים...';
    while (running && samples.length < SAMPLES) {
      const f = await face.detectFace(video).catch(() => null);
      if (!f) status.textContent = 'לא נראות פנים. עמוד מול המצלמה.';
      else if (f.size < 0.16) status.textContent = 'התקרב קצת למצלמה';
      else if (f.score < 0.7) status.textContent = 'התמונה לא ברורה. כדאי אור טוב יותר.';
      // each sample should differ a little from the previous one (a slightly different angle)
      else if (samples.length && face.faceDistance(f.descriptor, samples[samples.length - 1]) < 0.06) status.textContent = 'הזז מעט את הראש';
      else {
        samples.push(f.descriptor);
        dlg.querySelector(`#ed${samples.length - 1}`).classList.add('on');
        status.textContent = samples.length < SAMPLES ? `צולם ${samples.length} מתוך ${SAMPLES}. הזז מעט את הראש.` : '';
        await new Promise(r => setTimeout(r, 600));
      }
      await new Promise(r => setTimeout(r, 150));
    }
    if (samples.length >= SAMPLES) {
      status.textContent = 'הצילום הסתיים. לחץ "שמירה".';
      face.stopCamera(video);
    }
  })();
}

async function adminLog() {
  const { rows } = await api('/api/admin/audit');
  const ACT = { entry: 'הזנת נקודות', 'phone-check': 'בדיקת נקודות בטלפון', bonus: 'נקודות מיוחדות', 'bonus-delete': 'מחיקת נקודות מיוחדות', 'user-create': 'משתמש חדש',
    'user-update': 'עדכון משתמש', 'class-create': 'קבוצה חדשה', 'class-update': 'עדכון קבוצה', 'class-delete': 'מחיקת קבוצה',
    'student-create': 'תלמיד חדש', 'student-update': 'עדכון תלמיד', 'student-import': 'ייבוא תלמידים', 'item-create': 'סעיף חדש',
    'item-update': 'עדכון סעיף', settings: 'הגדרות', 'weeks-generate': 'יצירת שבועות', 'week-update': 'עדכון שבוע', 'day-off': 'יום ללא לימודים' };
  const detail = d => {
    try {
      const o = JSON.parse(d);
      if (o.class) return `${o.class} · ${shortDate(o.date)} · ${o.count} שינויים`;
      return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ');
    } catch { return d; }
  };
  shell(`<h1>יומן שינויים</h1><p class="sub">300 הפעולות האחרונות</p>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>זמן</th><th>משתמש</th><th>פעולה</th><th>פרטים</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${new Date(r.at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${esc(r.display_name || '')}</td><td>${ACT[r.action] || esc(r.action)}</td><td style="white-space:normal">${esc(detail(r.detail))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">אין</td></tr>'}</tbody></table></div></div>`);
}

boot().then(() => { if (!state.me) renderLogin(); });
