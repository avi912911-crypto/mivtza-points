// The attendance tablet: the camera stays open, a student is recognised, checked for liveness,
// checked in, and sees a short greeting with his points.
import { loadFaceApi, startCamera, detectFace, bestMatch, LivenessCheck } from '/face.js';

const KEY = location.hash.slice(1);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('he-IL');

const FEEDBACK_MS = 5000;     // how long the greeting stays
const REPEAT_MS = 30000;      // the same student is not checked in again within this time
const CHECK_MS = 6000;        // time allowed to pass the liveness check
const UNKNOWN_MS = 2500;      // a face not recognised for this long gets "see your teacher"
const MIN_SIZE = 0.16;        // face width as a share of the frame; smaller = too far away

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

let data = store.get('kiosk-data');
let queue = store.get('kiosk-queue') || [];
const recent = new Map();     // student id -> last check-in time
let track = null;             // { id, hits, live, since }
let unknownSince = 0;
let pausedUntil = 0;

function say(msg, hint = '', cls = '') {
  $('msg').textContent = msg;
  $('hint').textContent = hint;
  $('cam').className = 'cam ' + cls;
}

function fail(message) {
  $('stage').innerHTML = `<div class="error">${esc(message)}</div>`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Kiosk-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(out.error || 'שגיאה'); e.status = res.status; throw e; }
  return out;
}

async function refreshData() {
  try {
    data = await api('/kiosk/api/data');
    store.set('kiosk-data', data);
  } catch (err) {
    if (err.status === 403) { store.set('kiosk-data', null); data = null; fail(err.message); throw err; }
    // offline: keep working with the copy from last time
  }
  if (data) {
    $('program').textContent = data.program_name || '';
    if (data.logo) { $('logo').src = data.logo; $('logo').hidden = false; }
  }
}

function showOffline() {
  const el = $('offline');
  el.textContent = `אין חיבור לאינטרנט · ${queue.length} רישומים ממתינים לשליחה`;
  el.classList.toggle('show', queue.length > 0 || !navigator.onLine);
}

async function flushQueue() {
  while (queue.length) {
    try {
      await api('/kiosk/api/checkin', queue[0]);
    } catch (err) {
      if (!err.status) break;          // still offline
    }
    queue.shift();                     // sent, or refused by the server (nothing to retry)
    store.set('kiosk-queue', queue);
  }
  showOffline();
}

function feedback(r, person) {
  const first = person.first_name;
  let cls = '', big = r.greeting, what = '';
  if (r.status === 'present') what = `נרשמת ל${r.item} ✓`;
  else if (r.status === 'late') { cls = 'late'; what = `נרשמת ל${r.item} באיחור`; }
  else if (r.status === 'already') { cls = 'info'; big = `שלום ${first}`; what = `כבר נרשמת היום ל${r.item}`; }
  else if (r.status === 'none') { cls = 'info'; big = `שלום ${first}`; what = 'אין כרגע תפילה או שיעור לרישום'; }
  else if (r.status === 'queued') { big = `שלום ${first}`; what = 'נרשמת. הנקודות יתעדכנו כשהחיבור יחזור.'; }
  const pct = r.target ? Math.min(100, Math.round(r.total / r.target * 100)) : 0;
  const el = $('feedback');
  el.className = `feedback show ${cls}`;
  el.innerHTML = `<div class="big">${esc(big)}</div><div class="what">${esc(what)}</div>
    ${r.total != null ? `<div class="points">
      ${r.week != null ? `<div><b>${fmt(r.week)}</b><span>נקודות השבוע</span></div>` : ''}
      <div><b>${fmt(r.total)}</b><span>סה"כ נקודות</span></div>
      <div><b>${pct}%</b><span>מהיעד (${fmt(r.target)})</span></div></div>
      <div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    ${r.trial ? '<div class="tag">מצב ניסיון: הרישום נשמר, אבל הנקודות עוד לא משתנות</div>' : ''}`;
  pausedUntil = Date.now() + FEEDBACK_MS;
  setTimeout(() => { el.className = 'feedback'; }, FEEDBACK_MS);
}

async function checkIn(person) {
  recent.set(person.id, Date.now());
  pausedUntil = Date.now() + FEEDBACK_MS;   // no new recognition while the greeting is up
  try {
    feedback(await api('/kiosk/api/checkin', { student_id: person.id }), person);
  } catch (err) {
    if (err.status) { say(err.message, '', 'warn'); pausedUntil = Date.now() + 3000; return; }
    queue.push({ student_id: person.id, at: new Date().toISOString() });
    store.set('kiosk-queue', queue);
    showOffline();
    feedback({ status: 'queued' }, person);
  }
}

async function step() {
  const now = Date.now();
  if (now < pausedUntil || !data) return;
  const f = await detectFace($('video'));
  if (!f) { track = null; unknownSince = 0; say('עמוד מול המצלמה', 'הרישום לנוכחות נעשה אוטומטית'); return; }
  if (f.size < MIN_SIZE) { track = null; say('התקרב קצת למצלמה'); return; }

  const m = bestMatch(f.descriptor, data.students);
  if (!m) {
    track = null;
    unknownSince ||= now;
    if (now - unknownSince > UNKNOWN_MS) {
      say('לא זוהית', 'פנה למורה והוא יסמן אותך', 'warn');
      unknownSince = 0;
      pausedUntil = now + 3000;
    } else say('מזהה...', '', 'busy');
    return;
  }
  unknownSince = 0;
  const person = m.person;
  if (now - (recent.get(person.id) || 0) < REPEAT_MS) { say(`שלום ${person.first_name}`, 'כבר נרשמת עכשיו'); return; }
  if (track?.id !== person.id) track = { id: person.id, hits: 0, live: new LivenessCheck(), since: now };
  track.hits++;
  track.live.add(f);
  if (track.hits >= 3 && track.live.passed) { track = null; await checkIn(person); return; }
  if (now - track.since > CHECK_MS) { track = null; say('לא הצלחנו לאמת', 'נסה שוב: הבט במצלמה והזז מעט את הראש', 'warn'); pausedUntil = now + 1500; return; }
  say('הזז מעט את הראש מצד לצד', 'או מצמץ פעם אחת', 'busy');
}

async function loop() {
  try { await step(); } catch (err) { console.error(err); }
  setTimeout(loop, 120);
}

function clock() {
  $('clock').textContent = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }).format(new Date());
}

async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}

async function boot() {
  clock(); setInterval(clock, 10000);
  if (!KEY) return fail('חסר קוד עמדה בכתובת. יש לפתוח את הקישור המלא מעמוד "זיהוי פנים" באתר.');
  $('fs').onclick = () => document.documentElement.requestFullscreen?.();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  keepAwake();
  try { await refreshData(); } catch { return; }
  if (!data) return fail('אין חיבור לאתר, ועדיין לא נשמרו נתונים בעמדה. יש לחבר לאינטרנט ולרענן.');
  say('טוען את מנגנון הזיהוי...');
  try {
    await loadFaceApi();
    await startCamera($('video'));
  } catch (err) {
    return fail(err.message || 'טעינת הזיהוי נכשלה');
  }
  if (!data.students.length) say('עדיין לא נרשמו פנים של תלמידים', 'הרישום נעשה בעמוד "זיהוי פנים" באתר');
  setInterval(refreshData, 10 * 60 * 1000);
  setInterval(flushQueue, 30 * 1000);
  window.addEventListener('online', flushQueue);
  window.addEventListener('offline', showOffline);
  flushQueue();
  loop();
}

boot();
