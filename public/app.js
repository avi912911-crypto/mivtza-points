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
  $app.innerHTML = `<div class="login-wrap"><div class="card login-card">
    ${logoHtml()}
    <h1>${esc(state.settings?.program_name || 'מבצע')}</h1>
    <p class="sub">מערכת עדכון נקודות</p>
    <form id="login">
      <label class="field">שם משתמש<input type="text" name="username" autocomplete="username" required></label>
      <label class="field">סיסמה<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="error"></div>
      <button class="btn">כניסה</button>
    </form></div></div>`;
  const form = document.getElementById('login');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/login', { body: Object.fromEntries(new FormData(form)) });
      await boot();
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
    }
  });
}

// ---------- shell ----------

function navLinks() {
  const links = [['#/entry', 'הזנת נקודות'], ['#/dashboard', 'דשבורד']];
  if (isStaff()) links.push(['#/admin/students', 'תלמידים'], ['#/admin/classes', 'כיתות'], ['#/admin/weeks', 'לוח שבועות']);
  if (isAdmin()) links.push(['#/admin/users', 'משתמשים'], ['#/admin/items', 'הגדרת ניקוד'], ['#/admin/settings', 'הגדרות']);
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
  if (!location.hash) location.hash = state.me.role === 'teacher' ? '#/entry' : '#/dashboard';
  await route();
  if (state.me.must_change) changePassword(true);
}

// ---------- entry (daily / weekly table) ----------

async function viewEntry() {
  const { classes } = await api('/api/entry/classes');
  const e = state.entry;
  if (!classes.length) {
    shell(`<h1>הזנת נקודות</h1><div class="card empty">עדיין לא שויכה אליך כיתה. פנה למנהל.</div>`);
    return;
  }
  if (!classes.find(c => c.id === e.classId)) e.classId = classes[0].id;
  e.date ||= state.today;
  e.mode ||= 'daily';
  const main = shell(`<h1>הזנת נקודות</h1><p class="sub">לחיצה על תא מסמנת או מבטלת. הכול נשמר אוטומטית.</p>
    <div class="card"><div class="toolbar">
      ${classes.length > 1 ? `<select id="cls">${classes.map(c =>
        `<option value="${c.id}" ${c.id === e.classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
        : `<strong>${esc(classes[0].name)}</strong>`}
      <div class="seg"><button data-mode="daily" class="${e.mode === 'daily' ? 'on' : ''}">יומי</button>
        <button data-mode="weekly" class="${e.mode === 'weekly' ? 'on' : ''}">שבועי ומבחנים</button></div>
      <div class="datebox"><button class="btn secondary small" id="prev">→</button>
        <input type="date" id="date" value="${e.date}">
        <button class="btn secondary small" id="next">←</button>
        <button class="btn ghost small" id="today">היום</button></div>
      <span class="spacer"></span><span id="datelabel" class="muted"></span>
    </div><div id="grid"></div></div>`);
  main.querySelector('#cls')?.addEventListener('change', ev => { e.classId = Number(ev.target.value); loadGrid(); });
  main.querySelectorAll('.seg button').forEach(b => b.onclick = () => { e.mode = b.dataset.mode; viewEntry(); });
  const step = e.mode === 'daily' ? 1 : 7;
  main.querySelector('#prev').onclick = () => { e.date = addDays(e.date, -step); viewEntry(); };
  main.querySelector('#next').onclick = () => { e.date = addDays(e.date, step); viewEntry(); };
  main.querySelector('#today').onclick = () => { e.date = state.today; viewEntry(); };
  main.querySelector('#date').onchange = ev => { if (ev.target.value) { e.date = ev.target.value; viewEntry(); } };
  await loadGrid();
}

async function loadGrid() {
  const e = state.entry;
  const grid = document.getElementById('grid');
  const data = await api(`/api/entry?class_id=${e.classId}&date=${e.date}&mode=${e.mode}`);
  const rules = state.settings.exam_rules;
  const examPts = g => { for (const r of rules) if (g >= r.min) return r.points; return 0; };
  const label = document.getElementById('datelabel');
  label.textContent = e.mode === 'daily'
    ? `${dayName(e.date)} · ${hebDate(e.date)}${data.week ? ' · ' + weekLabel(data.week) : ''}`
    : `${data.week ? weekLabel(data.week) : 'שבוע'} · ${dateRange(weekStart(e.date), addDays(weekStart(e.date), 6))}`;

  let notice = '';
  if (data.week?.vacation) notice = '<div class="notice">שבוע זה מסומן כחופשה, והנקודות בו לא נספרות.</div>';
  if (data.day_off) notice += `<div class="notice">יום ללא לימודים${data.day_off.note ? ': ' + esc(data.day_off.note) : ''}.</div>`;
  if (data.future) notice += '<div class="notice">זה יום עתידי. אפשר להזין רק עד היום.</div>';
  if (data.locked) notice += '<div class="notice bad">הזמן לעדכון עבר. לתיקון פנה למזכיר.</div>';
  if (!data.items.length) {
    grid.innerHTML = notice + `<div class="empty">${e.mode === 'daily'
      ? 'אין סעיפים יומיים להזנה ביום זה.' : 'אין סעיפים שבועיים שלך להזנה.'}</div>`;
    return;
  }
  if (!data.students.length) { grid.innerHTML = notice + '<div class="empty">אין תלמידים בכיתה.</div>'; return; }

  const readOnly = data.locked || data.future;
  const values = data.values;
  const ptsOf = (it, v) => v == null ? 0 : it.kind === 'exam' ? examPts(v) : (v ? it.points : 0);
  const rowTotal = s => data.items.reduce((a, it) => a + ptsOf(it, values[`${s.id}:${it.id}`]), 0);

  grid.innerHTML = notice + `<div class="table-wrap"><table class="entry"><thead><tr><th class="name">תלמיד</th>
    ${data.items.map(it => `<th class="num">${esc(it.name)}<span class="pts">${it.kind === 'exam' ? 'ציון' : it.points + ' נק\''}</span>
      ${it.kind !== 'exam' && !readOnly ? `<button class="btn secondary small all" data-all="${it.id}">כולם</button>` : ''}</th>`).join('')}
    <th class="num">סה"כ</th></tr></thead><tbody>
    ${data.students.map(s => `<tr><td class="name">${esc(s.first_name)} ${esc(s.last_name)}</td>
      ${data.items.map(it => {
        const v = values[`${s.id}:${it.id}`];
        return `<td class="num">${it.kind === 'exam'
          ? `<input type="number" class="grade-input" min="0" max="100" data-s="${s.id}" data-i="${it.id}" value="${v ?? ''}" ${readOnly ? 'disabled' : ''}><span class="grade-pts" id="gp-${s.id}-${it.id}">${v != null ? examPts(v) + ' נק\'' : ''}</span>`
          : `<button class="cell-toggle ${v ? 'on' : ''}" data-s="${s.id}" data-i="${it.id}" ${readOnly ? 'disabled' : ''}>✓</button>`}</td>`;
      }).join('')}
      <td class="num rowtotal" id="rt-${s.id}">${rowTotal(s)}</td></tr>`).join('')}
    </tbody></table></div>`;

  const pending = new Map();
  const refreshRow = sid => {
    const s = data.students.find(x => x.id === sid);
    document.getElementById(`rt-${sid}`).textContent = rowTotal(s);
  };
  const queue = (sid, iid, value) => {
    values[`${sid}:${iid}`] = value;
    pending.set(`${sid}:${iid}`, { student_id: sid, item_id: iid, value });
    refreshRow(sid);
    clearTimeout(queue.t);
    queue.t = setTimeout(flush, 500);
  };
  const flush = async () => {
    if (!pending.size) return;
    const changes = [...pending.values()];
    pending.clear();
    try {
      await api('/api/entry', { body: { class_id: e.classId, date: e.date, mode: e.mode, changes } });
      toast('✓ נשמר');
    } catch (err) {
      toast('שגיאה בשמירה: ' + err.message, 4000);
    }
  };

  grid.querySelectorAll('.cell-toggle').forEach(btn => btn.onclick = () => {
    const on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    queue(Number(btn.dataset.s), Number(btn.dataset.i), on ? 1 : null);
  });
  grid.querySelectorAll('[data-all]').forEach(btn => btn.onclick = () => {
    const iid = Number(btn.dataset.all);
    const cells = [...grid.querySelectorAll(`.cell-toggle[data-i="${iid}"]`)];
    const allOn = cells.every(c => c.classList.contains('on'));
    cells.forEach(c => {
      c.classList.toggle('on', !allOn);
      queue(Number(c.dataset.s), iid, allOn ? null : 1);
    });
  });
  grid.querySelectorAll('.grade-input').forEach(inp => inp.onchange = () => {
    const sid = Number(inp.dataset.s), iid = Number(inp.dataset.i);
    let v = inp.value === '' ? null : Math.max(0, Math.min(100, Math.round(Number(inp.value))));
    if (v != null) inp.value = v;
    document.getElementById(`gp-${sid}-${iid}`).textContent = v != null ? examPts(v) + ' נק\'' : '';
    queue(sid, iid, v);
  });
  window.onbeforeunload = () => { if (pending.size) { flush(); return 'יש שינויים שלא נשמרו'; } };
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
    ${d.missing_today.length ? `<div class="card"><h2>עדיין לא הוזן היום</h2>
      ${d.missing_today.map(m => `<span class="badge bad" style="margin:3px">${esc(m.class_name)} · ${SHIFT[m.shift]}</span>`).join('')}</div>` : ''}
    <div class="card"><h2>דירוג כיתות</h2>
      ${d.classes.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>כיתה</th><th class="num">תלמידים</th>
        <th class="num">ממוצע השבוע</th><th class="num">ממוצע מצטבר</th><th class="num">בקצב</th><th>התקדמות ליעד</th></tr></thead><tbody>
        ${d.classes.map((c, i) => `<tr style="cursor:pointer" onclick="location.hash='#/class/${c.id}'">
          <td><span class="rank ${i === 0 ? 'r1' : ''}">${i + 1}</span></td><td><a href="#/class/${c.id}">${esc(c.name)}</a></td>
          <td class="num">${c.students}</td><td class="num">${fmt(c.avg_week)}</td><td class="num"><strong>${fmt(c.avg_total)}</strong></td>
          <td class="num">${c.on_track}/${c.students}</td>
          <td style="min-width:140px"><div class="progress"><div style="width:${Math.min(100, Math.round(100 * c.avg_total / d.target))}%"></div></div></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">אין עדיין כיתות</div>'}</div>
    <div class="grid grid-2">
      <div class="card"><h2>מצטייני השבוע</h2>${topList(d.top_week, 'week')}</div>
      <div class="card"><h2>מובילים מצטבר</h2>${topList(d.top_total, 'total')}</div>
    </div>`);
  return main;
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
  shell(`<a href="#/dashboard">→ חזרה לדשבורד</a><h1 style="margin-top:8px">${esc(d.class.name)}</h1>
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
  const main = shell(`<a href="#/class/${d.student.class_id}">→ ${esc(d.student.class_name)}</a>
    <h1 style="margin-top:8px">${esc(d.student.first_name)} ${esc(d.student.last_name)}</h1>
    <p class="sub">${esc(d.student.class_name)}</p>
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

// ---------- admin ----------

async function viewAdmin(tab) {
  const views = { users: adminUsers, classes: adminClasses, students: adminStudents, items: adminItems,
                  weeks: adminWeeks, settings: adminSettings, log: adminLog };
  if (!views[tab]) tab = 'students';
  if (['users', 'items', 'settings'].includes(tab) && !isAdmin()) tab = 'students';
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
  const main = shell(`<div class="toolbar"><h1>כיתות</h1><span class="spacer"></span>
    <button class="btn" id="add">+ כיתה חדשה</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>כיתה</th><th>מורה בוקר</th><th>מורה אחה"צ</th>
      <th class="num">תלמידים</th><th></th></tr></thead><tbody>
      ${classes.map(c => `<tr><td><a href="#/class/${c.id}">${esc(c.name)}</a></td><td>${name(c.morning_teacher_id)}</td>
        <td>${name(c.afternoon_teacher_id)}</td><td class="num">${c.student_count}</td>
        <td><button class="btn secondary small" data-edit="${c.id}">עריכה</button>
        <button class="btn danger small" data-del="${c.id}">מחיקה</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">אין כיתות. אפשר להוסיף ידנית או לייבא תלמידים מאקסל.</td></tr>'}
    </tbody></table></div></div>`);
  const teacherOpts = sel => '<option value="">—</option>' + users.filter(u => u.role === 'teacher')
    .map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.display_name)}</option>`).join('');
  const form = c => `<label class="field">שם כיתה<input type="text" name="name" value="${esc(c?.name)}" required></label>
    <label class="field">מורה בוקר<select name="morning_teacher_id">${teacherOpts(c?.morning_teacher_id)}</select></label>
    <label class="field">מורה אחה"צ<select name="afternoon_teacher_id">${teacherOpts(c?.afternoon_teacher_id)}</select></label>
    <label class="field">סדר תצוגה<input type="number" name="sort" value="${c?.sort ?? 0}"></label>`;
  const body = d => ({ ...d, morning_teacher_id: Number(d.morning_teacher_id) || null, afternoon_teacher_id: Number(d.afternoon_teacher_id) || null });
  main.querySelector('#add').onclick = () => openDialog('כיתה חדשה', form(null), async d => {
    await api('/api/admin/classes', { body: body(d) }); adminClasses();
  });
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const c = classes.find(x => x.id === Number(b.dataset.edit));
    openDialog('עריכת כיתה', form(c), async d => {
      await api('/api/admin/classes/' + c.id, { method: 'PUT', body: body(d) }); adminClasses();
    });
  });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('למחוק את הכיתה?')) return;
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
      <select id="fc"><option value="">כל הכיתות</option>${classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="inactive"> הצג לא פעילים</label>
      <span class="spacer"></span><span class="muted" id="count"></span></div>
      <div class="table-wrap"><table><thead><tr><th>שם פרטי</th><th>שם משפחה</th><th>כיתה</th><th class="num">מצב</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div></div>`);
  const draw = () => {
    const q = main.querySelector('#q').value.trim();
    const fc = Number(main.querySelector('#fc').value);
    const showInactive = main.querySelector('#inactive').checked;
    const list = students.filter(s => (showInactive || s.active) && (!fc || s.class_id === fc)
      && (!q || `${s.first_name} ${s.last_name}`.includes(q)));
    main.querySelector('#count').textContent = `${list.length} תלמידים`;
    main.querySelector('#rows').innerHTML = list.map(s => `<tr><td><a href="#/student/${s.id}">${esc(s.first_name)}</a></td>
      <td>${esc(s.last_name)}</td><td>${esc(s.class_name || '—')}</td>
      <td class="num">${s.active ? '' : '<span class="badge bad">לא פעיל</span>'}</td>
      <td><button class="btn secondary small" data-edit="${s.id}">עריכה</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">אין תלמידים</td></tr>';
    main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(students.find(s => s.id === Number(b.dataset.edit))));
  };
  const classOpts = sel => '<option value="">—</option>' + classes.map(c =>
    `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const form = s => `<label class="field">שם פרטי<input type="text" name="first_name" value="${esc(s?.first_name)}" required></label>
    <label class="field">שם משפחה<input type="text" name="last_name" value="${esc(s?.last_name)}"></label>
    <label class="field">כיתה<select name="class_id">${classOpts(s?.class_id)}</select></label>
    ${s ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> פעיל (הסרה מהרשימה שומרת את הנקודות)</label>` : ''}`;
  const edit = s => openDialog('עריכת תלמיד', form(s), async d => {
    await api('/api/admin/students/' + s.id, { method: 'PUT', body: { ...d, class_id: Number(d.class_id) || null, active: !!d.active } });
    adminStudents();
  });
  main.querySelector('#add').onclick = () => openDialog('תלמיד חדש', form(null), async d => {
    await api('/api/admin/students', { body: { ...d, class_id: Number(d.class_id) || null } }); adminStudents();
  });
  main.querySelector('#import').onclick = importStudents;
  ['#q', '#fc', '#inactive'].forEach(sel => main.querySelector(sel).addEventListener('input', draw));
  draw();
}

function importStudents() {
  const dlg = openDialog('ייבוא תלמידים מאקסל', `
    <p class="muted">בחר קובץ אקסל או CSV. השורה הראשונה צריכה להיות כותרות. אחר כך בחר איזו עמודה היא מה.</p>
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div id="map"></div>`, async () => {
    if (!dlg.rows) throw new Error('יש לבחור קובץ');
    const pick = n => Number(dlg.querySelector(`[name=${n}]`).value);
    const [fi, li, ci] = [pick('c_first'), pick('c_last'), pick('c_class')];
    const split = dlg.querySelector('[name=split]')?.checked;
    const rows = dlg.rows.slice(1).map(r => {
      let first = String(r[fi] ?? '').trim(), last = li >= 0 ? String(r[li] ?? '').trim() : '';
      if (split && li < 0) { const parts = first.split(/\s+/); last = parts.pop() || ''; first = parts.join(' ') || last; if (first === last) last = ''; }
      return { first_name: first, last_name: last, class_name: ci >= 0 ? String(r[ci] ?? '').trim() : '' };
    }).filter(r => r.first_name);
    const res = await api('/api/admin/students/import', { body: { rows } });
    toast(`נוספו ${res.added} תלמידים ו-${res.new_classes} כיתות חדשות`, 4000);
    adminStudents();
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
    const gf = guess(/פרטי|שם$/), gl = guess(/משפחה/), gc = guess(/כית|שיעור|קבוצ/);
    dlg.querySelector('#map').innerHTML = `
      <label class="field">עמודת שם פרטי (או שם מלא)<select name="c_first">${opts(gf >= 0 ? gf : 0)}</select></label>
      <label class="field">עמודת שם משפחה<select name="c_last">${opts(gl, true)}</select></label>
      <label class="check"><input type="checkbox" name="split"> אין עמודת משפחה: לפצל שם מלא (המילה האחרונה = משפחה)</label>
      <label class="field">עמודת כיתה<select name="c_class">${opts(gc, true)}</select></label>
      <p class="muted">נמצאו ${rows.length - 1} שורות. כיתות שלא קיימות ייווצרו אוטומטית.</p>`;
  };
}

async function adminItems() {
  const { items } = await api('/api/admin/items');
  const rules = state.settings.exam_rules;
  const weekly = items.filter(i => i.active).reduce((a, i) =>
    a + (i.kind === 'daily' ? i.points * i.days.split(',').filter(Boolean).length : i.kind === 'weekly' ? i.points : 0), 0);
  const main = shell(`<div class="toolbar"><h1>הגדרת ניקוד</h1><span class="spacer"></span>
    <button class="btn" id="add">+ סעיף</button></div>
    <p class="sub">שינוי נקודות חל גם על ימים שכבר הוזנו. מקסימום שבועי בלי מבחנים: <strong>${weekly}</strong></p>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>סעיף</th><th>סוג</th><th>מי מזין</th>
      <th class="num">נקודות</th><th>ימים</th><th class="num">פעיל</th><th></th></tr></thead><tbody>
      ${items.map(i => `<tr><td>${esc(i.name)}</td><td>${KIND[i.kind]}</td><td>${SHIFT[i.shift]}</td>
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
    <label class="field">מי מזין<select name="shift">${Object.entries(SHIFT).map(([k, v]) => `<option value="${k}" ${(i?.shift || 'morning') === k ? 'selected' : ''}>${v === 'מזכירות' ? 'מזכיר + מורה מורשה' : 'מורה ' + v}</option>`).join('')}</select></label>
    <label class="field">נקודות לפעם (במבחן לא בשימוש)<input type="number" name="points" value="${i?.points ?? 0}"></label>
    <div class="field">ימים (לסעיף יומי: ימי לימוד; לשבועי: היום שבו הוא מתקיים)<div class="form-row">${DAYS.map((d, n) =>
      `<label class="check"><input type="checkbox" name="d${n}" ${(i ? i.days.split(',') : ['0', '1', '2', '3', '4']).includes(String(n)) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
    <label class="field">סדר<input type="number" name="sort" value="${i?.sort ?? 0}"></label>
    ${i ? `<label class="check"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> פעיל</label>` : ''}`;
  const body = d => ({ ...d, days: DAYS.map((_, n) => d['d' + n] ? n : null).filter(n => n !== null).join(','), active: !!d.active });
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
      <label class="field">ימים שמורה יכול לתקן אחורה<input type="number" id="edit" value="${s.edit_days}" min="0" style="width:120px"></label>
      <button class="btn" id="save">שמירה</button></div></div>
    <div class="card"><h2>לוגו המבצע</h2>
      <div class="form-row">${s.logo ? `<img class="logo-preview" src="${esc(s.logo)}">` : '<span class="muted">לא הועלה לוגו</span>'}
        <input type="file" id="logo" accept="image/*">${s.logo ? '<button class="btn danger small" id="nologo">הסרה</button>' : ''}</div>
      <p class="muted">הלוגו יופיע בראש כל דף ובמסך הכניסה. מומלץ PNG עם רקע שקוף.</p></div>
    <div class="card"><h2>גיבוי</h2><p class="muted">המערכת שומרת גיבוי אוטומטי כל יום (14 הימים האחרונים). אפשר גם להוריד עותק למחשב.</p>
      <a class="btn secondary" href="/api/admin/backup">הורדת גיבוי</a></div>`);
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

async function adminLog() {
  const { rows } = await api('/api/admin/audit');
  const ACT = { entry: 'הזנת נקודות', bonus: 'נקודות מיוחדות', 'bonus-delete': 'מחיקת נקודות מיוחדות', 'user-create': 'משתמש חדש',
    'user-update': 'עדכון משתמש', 'class-create': 'כיתה חדשה', 'class-update': 'עדכון כיתה', 'class-delete': 'מחיקת כיתה',
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
