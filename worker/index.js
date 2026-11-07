/**
 * מעקב חממות וניל: השרת (Cloudflare Worker). קורא וכותב בקובץ Google Sheets של המשק, בלשוניות הקיימות בלבד.
 * האתר שולח POST עם JSON: { action, code, ...payload } ומקבל { ok, role, data } או { ok:false, error }.
 * השרת פונה לגוגל בשם חשבון החווה (חיבור חד-פעמי ב-/connect), כך שהתמונות נשמרות בתיקייה של הבעלים ב-Drive.
 *
 * Settings (Cloudflare dashboard, Worker > Settings):
 *   vars:    SHEET_ID, ALLOWED_EMAIL, GOOGLE_CLIENT_ID
 *   secrets: GOOGLE_CLIENT_SECRET, WORKER_CODE, MANAGER_CODE (8+ letters and digits)
 *   KV:      STORE (holds the Google refresh token)
 *   cron:    0 0 * * *  (nightly backup, 02:00 in Israel in winter)
 */

const TZ = 'Asia/Jerusalem';
const DAY = 86400000;
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const DRIVE = 'https://www.googleapis.com/drive/v3/';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPES = 'openid email https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';

// Only the farm's existing tabs are used (nothing is created or deleted):
//   Master Data = greenhouses (one per column) · Work = the work catalogue · Log data = every daily action
//   (work in a greenhouse, start/end of the work day, problem reports, photos) · Calendar = planned works · Code = settings
const SHEET_NAMES = { greenhouses: 'Master Data', works: 'Work', log: 'Log data', tasks: 'Calendar', settings: 'Code' };
// The farm's own column titles, mapped to the names the code uses. Columns not listed keep their own title.
const ALIASES = {
  works: {
    'קוד עבודה': 'קוד', 'קטגוריית עבודה': 'קטגוריה', 'שם העבודה / טיפול אגרוטכני': 'שם העבודה',
    'תיאור מפורט והנחיות ביצוע': 'תיאור והנחיות ביצוע', 'עונה / שלב פנולוגי מומלץ': 'עונה / שלב פנולוגי', 'תדירות / מחזוריות': 'תדירות',
  },
  log: {
    'עובד / מדווח': 'עובד', 'מספר חממה': 'חממה', 'זמן הגעה (כניסה)': 'כניסה', 'זמן יציאה': 'יציאה', 'סה"כ שעות עבודה': 'שעות',
    'קטגוריית טיפול': 'עבודה', 'פירוט עבודה ומיקום': 'פירוט', 'כמות / תפוקה': 'כמות', 'חומרים / תמונות': 'תמונה', 'הערות / בעיות שנצפו': 'הערות',
  },
};
// "קוד עבודה" values of Log data rows that are not greenhouse work.
const KIND = { shift: 'SHIFT', issue: 'ISSUE', photo: 'PHOTO' };
const SETTING = {
  workers: 'עובדים',
  photoFolder: 'מזהה תיקיית תמונות ב-Drive',
  backupFolder: 'מזהה תיקיית גיבוי ב-Drive',
  secondOwner: 'אימייל בעלים שני',
  lastBackup: 'גיבוי אחרון',
  keepDays: 'ימים לשמירת גיבויים',
};
// photo is checked inside: the worker may add photos to his own greenhouse visit, the manager to any row
const MANAGER_ONLY = ['dashboard', 'resolveIssue', 'report', 'photoSet', 'taskAdd', 'backup'];
// Columns that hold a date or time, with the format the sheet shows them in. In the code they are milliseconds.
const DATE_COLS = {
  'תאריך': 'dd/mm/yyyy', 'כניסה': 'hh:mm', 'יציאה': 'hh:mm', 'עודכן': 'dd/mm/yyyy hh:mm',
  'תאריך ביצוע': 'dd/mm/yyyy', 'נוצר': 'dd/mm/yyyy hh:mm', 'בוצע': 'dd/mm/yyyy hh:mm',
};
const BACKUP_PREFIX = 'גיבוי חממות וניל ';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/connect') return connect(url, env);
    if (url.pathname === '/oauth') return oauth(url, env);
    if (url.pathname === '/privacy') return page('מעקב חממות וניל היא אפליקציה פרטית של משק הוניל בקיבוץ שניר. היא קוראת וכותבת רק בקובץ הגיליון של המשק ובתיקיות שלו ב-Google Drive, ולא מעבירה נתונים לאף אחד אחר.');
    if (request.method !== 'POST') {
      // health check: yes/no only, never data
      const connected = !!(await env.STORE.get('refresh_token'));
      const sheet = connected && (await g(env, DRIVE + 'files/' + env.SHEET_ID + '?fields=id').then(() => true, () => false));
      return json({ ok: true, app: 'vanilla-greenhouses', connected, sheet });
    }
    return json(await api(request, env));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(load(env).then(backupNow));
  },
};

async function api(request, env) {
  try {
    if (Number(request.headers.get('content-length')) > 6e6) return { ok: false, error: 'הבקשה גדולה מדי' };
    const req = JSON.parse(await request.text());
    const role = await roleFor(req.code, env);
    if (!role) return { ok: false, error: 'קוד שגוי' };
    if (req.id != null && !/^[A-Z]-[a-z0-9]{1,24}$/.test(String(req.id))) return { ok: false, error: 'מזהה לא תקין' };
    if (MANAGER_ONLY.includes(req.action) && role !== 'manager') return { ok: false, error: 'נדרש קוד מנהל' };
    const fn = Object.hasOwn(ACTIONS, String(req.action)) ? ACTIONS[req.action] : null; // never inherited keys like "constructor"
    if (!fn) return { ok: false, error: 'פעולה לא מוכרת: ' + req.action };
    return { ok: true, role, data: await fn(await load(env, ACTION_TABS[req.action]), req, role) };
  } catch (err) {
    // retry: the phone keeps the report in its queue and sends it again later, instead of dropping it
    if (err && err.google) console.error(err.google);
    return { ok: false, error: String((err && err.message) || err), retry: !!(err && err.retry) };
  }
}

// ---------- codes ----------

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// No lockout: a lockout would let anyone block the farm. Codes of 8+ random characters make guessing hopeless.
async function roleFor(code, env) {
  const c = String(code == null ? '' : code).trim();
  if (!c) return null;
  const h = await sha(c);
  for (const [secret, role] of [[env.MANAGER_CODE, 'manager'], [env.WORKER_CODE, 'worker']]) {
    if (secret && String(secret).trim().length >= 8 && h === (await sha(String(secret).trim()))) return role;
  }
  return null;
}

// ---------- Google: one-time connect, then a refresh token in KV ----------

async function connect(url, env) {
  const state = crypto.randomUUID();
  // one key per attempt, so repeated hits on /connect can't cancel the owner's sign-in
  await env.STORE.put('oauth_state:' + state, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/oauth', response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', login_hint: env.ALLOWED_EMAIL || '', state,
  });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}

async function oauth(url, env) {
  const state = String(url.searchParams.get('state') || '');
  if (!/^[\w-]{36}$/.test(state) || !(await env.STORE.get('oauth_state:' + state))) return page('הקישור פג תוקף. לפתוח שוב את /connect', 400);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + '/oauth', grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();
  if (!j.refresh_token) return page('החיבור נכשל: ' + (j.error_description || j.error || 'אין refresh token'), 400);
  // only the farm's account may connect, so nobody can swap in their own Google account
  const email = String(jwtPayload(j.id_token).email || '').toLowerCase();
  if (!env.ALLOWED_EMAIL || email !== String(env.ALLOWED_EMAIL).toLowerCase()) return page('החשבון ' + email + ' לא מורשה. להתחבר עם ' + env.ALLOWED_EMAIL, 403);
  await env.STORE.put('refresh_token', j.refresh_token);
  await env.STORE.delete('oauth_state:' + state);
  token = null;
  return page('השרת מחובר לגוגל בתור ' + email + '. אפשר לסגור את הדף.');
}

function jwtPayload(jwt) {
  try {
    const b = atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
  } catch (e) { return {}; }
}

let token = null; // { value, exp }, reused while the Worker instance lives
let pending = null; // one refresh at a time, even when calls run in parallel

function accessToken(env) {
  if (token && token.exp > Date.now() + 60000) return Promise.resolve(token.value);
  if (!pending) pending = refreshToken(env).finally(() => { pending = null; });
  return pending;
}

async function refreshToken(env) {
  const refresh = await env.STORE.get('refresh_token');
  if (!refresh) throw new Error('השרת עוד לא מחובר לגוגל');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw retryable('החיבור לגוגל נכשל: ' + (j.error_description || j.error || r.status));
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

function retryable(msg) { const e = new Error(msg); e.retry = true; return e; }

async function g(env, url, opt = {}) {
  const headers = { Authorization: 'Bearer ' + (await accessToken(env)) };
  if (typeof opt.body === 'string') headers['Content-Type'] = 'application/json';
  let r;
  try { r = await fetch(url, { ...opt, headers: { ...headers, ...opt.headers } }); } catch (e) { throw retryable('אין חיבור לגוגל'); }
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    // Google's own text (file ids, permissions) stays in the Worker log, never in the reply
    const e = new Error('שגיאה בגוגל (' + r.status + ')');
    e.google = r.status + ' ' + url.split('?')[0] + ' ' + ((j.error && j.error.message) || '');
    e.retry = r.status === 429 || r.status >= 500;
    throw e;
  }
  return j;
}

// ---------- time: the sheet keeps Israel local time as serial day numbers ----------

const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function local(ms) {
  const p = {};
  partsFmt.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p;
}

/** Israel minus UTC at that moment, in ms (Intl is slow, so it is asked only twice a year). */
function intlOffset(ms) {
  const p = local(ms);
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
const dstYears = new Map();
/** The year's standard and summer offsets, and when summer time starts and ends (found once, to the minute). */
function dstYear(y) {
  let info = dstYears.get(y);
  if (info) return info;
  const jan = Date.UTC(y, 0, 1), jul = Date.UTC(y, 6, 1), next = Date.UTC(y + 1, 0, 1);
  const std = intlOffset(jan), dst = intlOffset(jul);
  // first minute in (lo, hi] whose offset is `want`; the offset changes once in that span
  const edge = (lo, hi, want) => { while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 120000) * 60000; if (intlOffset(mid) === want) hi = mid; else lo = mid; } return hi; };
  info = std === dst ? { std, dst, start: Infinity, end: -Infinity } : { std, dst, start: edge(jan, jul, dst), end: edge(jul, next, std) };
  dstYears.set(y, info);
  return info;
}
function offset(ms) {
  const i = dstYear(new Date(ms).getUTCFullYear());
  return ms >= i.start && ms < i.end ? i.dst : i.std;
}

function toSerial(ms) { return (ms + offset(ms)) / DAY + 25569; }

function fromSerial(s) {
  const wall = (s - 25569) * DAY;
  return Math.round(wall - offset(wall - offset(wall)));
}

function dayOf(ms) { return fromSerial(Math.floor(toSerial(ms))); }

function fmtLocal(ms, withTime) {
  const p = local(ms);
  return p.year + '-' + p.month + '-' + p.day + (withTime ? ' ' + p.hour + ':' + p.minute : '');
}

function fmtDay(ms) { const p = local(ms); return p.day + '/' + p.month + '/' + p.year; }

/** A time sent by a phone. The offline queue may hold it a few days, but it is never in the future. */
function when(ts) {
  const d = Number(ts), now = Date.now();
  if (!isFinite(d) || d > now + 5 * 60000 || d < now - 7 * DAY) throw new Error('זמן לא תקין');
  return d;
}

/** Exit time: valid, and not before the entry. */
function exitAfter(hit, ts) {
  const d = when(ts);
  const entry = plain(hit)['כניסה'];
  if (typeof entry === 'number' && entry > d + 60000) throw new Error('שעת יציאה לפני שעת כניסה');
  return d;
}

// ---------- sheet access ----------

const quote = (n) => "'" + n.replace(/'/g, "''") + "'";
let sheetIdCache = null;

// The tabs each action reads; anything not listed reads all of them. Log data grows every day, so it is read only when needed.
const ACTION_TABS = {
  bootstrap: ['greenhouses', 'works', 'tasks', 'settings'],
  taskAdd: ['greenhouses', 'tasks', 'settings'],
  taskDone: ['tasks', 'settings'],
  checkIn: ['greenhouses', 'works', 'log', 'settings'],
  checkOut: ['log', 'settings'],
  shiftIn: ['log', 'settings'],
  shiftOut: ['log', 'settings'],
  photoSet: ['greenhouses', 'log', 'settings'],
  photo: ['log', 'settings'],
  issue: ['greenhouses', 'log', 'settings'],
  resolveIssue: ['log', 'settings'],
  stamp: [],
};

/** What an action reads, in two calls: the tab ids and the tabs at once. */
async function load(env, only) {
  const keys = only || Object.keys(SHEET_NAMES);
  const q = keys.map((k) => 'ranges=' + encodeURIComponent(quote(SHEET_NAMES[k]))).join('&');
  if (!keys.length) return { env, raw: { settings: [], greenhouses: [[]] }, t: {} };
  const [ids, data] = await Promise.all([
    sheetIdCache || g(env, SHEETS_API + env.SHEET_ID + '?fields=sheets.properties(sheetId,title)').then((j) => {
      sheetIdCache = {};
      j.sheets.forEach((s) => { sheetIdCache[s.properties.title] = s.properties.sheetId; });
      return sheetIdCache;
    }),
    g(env, SHEETS_API + env.SHEET_ID + '/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'),
  ]);
  const db = { env, raw: { settings: [], greenhouses: [[]] }, t: {} };
  Object.keys(SHEET_NAMES).forEach((k) => { db.t[k] = table(k, [[]], ids[SHEET_NAMES[k]]); });
  keys.forEach((k, i) => {
    db.raw[k] = data.valueRanges[i].values || [[]];
    db.t[k] = table(k, db.raw[k], ids[SHEET_NAMES[k]]);
  });
  return db;
}

function table(key, values, sheetId) {
  const alias = ALIASES[key] || {};
  const head = (values[0] || []).map((h) => { h = String(h).trim(); return alias[h] || h; });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i] || [];
    if (v.every((c) => c === '' || c == null)) continue;
    const o = { _row: i + 1 };
    head.forEach((h, j) => { if (h) o[h] = v[j] === undefined ? '' : v[j]; });
    rows.push(o);
  }
  return { key, name: SHEET_NAMES[key], sheetId, head, rows };
}

function col(t, name) {
  const i = t.head.indexOf(name);
  if (i < 0) throw new Error('חסרה עמודה "' + name + '" בלשונית ' + t.name);
  return i;
}

function findBy(t, key, value) { return t.rows.find((r) => String(r[key]) === String(value)) || null; }

function cellValue(h, v) { return DATE_COLS[h] && typeof v === 'number' ? toSerial(v) : v; }

function cellData(v) {
  if (typeof v === 'number') return { userEnteredValue: { numberValue: v } };
  if (v === '' || v == null) return {};
  return { userEnteredValue: { stringValue: String(v) } };
}

function patternType(p) { return /y/.test(p) && /h/.test(p) ? 'DATE_TIME' : /y/.test(p) ? 'DATE' : /h/.test(p) ? 'TIME' : 'NUMBER'; }

function cellRange(t, row, c) { return { sheetId: t.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: c, endColumnIndex: c + 1 }; }

function formatReq(t, row, c, pattern) {
  return { repeatCell: { range: cellRange(t, row, c), cell: { userEnteredFormat: { numberFormat: { type: patternType(pattern), pattern } } }, fields: 'userEnteredFormat.numberFormat' } };
}

function batch(db, requests) {
  if (!requests.length) return Promise.resolve({});
  return g(db.env, SHEETS_API + db.env.SHEET_ID + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
}

const colA1 = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/**
 * Appends a row (Google picks the row, so two phones never write over each other), then formats its date cells.
 * logRow also writes the hours formula, as the old script did.
 */
async function append(db, t, obj, opts = {}) {
  const values = t.head.map((h) => (h in obj ? cellValue(h, obj[h]) : ''));
  const j = await g(db.env, SHEETS_API + db.env.SHEET_ID + '/values/' + encodeURIComponent(quote(t.name) + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST', body: JSON.stringify({ values: [values] }),
  });
  const row = Number(/!\D+(\d+)/.exec(j.updates.updatedRange)[1]);
  const reqs = [];
  const fmt = Object.assign({}, opts.formats);
  Object.keys(obj).forEach((h) => { if (!(h in fmt) && DATE_COLS[h]) fmt[h] = DATE_COLS[h]; });
  if (opts.logRow) ['תאריך', 'כניסה', 'יציאה', 'עודכן'].forEach((h) => { if (!(h in fmt)) fmt[h] = DATE_COLS[h]; });
  Object.keys(fmt).forEach((h) => { if (t.head.includes(h)) reqs.push(formatReq(t, row, col(t, h), fmt[h])); });
  if (opts.logRow && t.head.includes('שעות')) {
    const inA1 = colA1(col(t, 'כניסה')) + row, outA1 = colA1(col(t, 'יציאה')) + row;
    // both cells hold full date-times, so a shift across midnight or a check-out the next day is still right
    reqs.push({ updateCells: {
      range: cellRange(t, row, col(t, 'שעות')),
      rows: [{ values: [{ userEnteredValue: { formulaValue: '=IF(OR(' + inA1 + '="",' + outA1 + '=""),"",ROUND((' + outA1 + '-' + inA1 + ')*24,2))' }, userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } } }] }],
      fields: 'userEnteredValue,userEnteredFormat.numberFormat',
    } });
  }
  await batch(db, reqs);
  return row;
}

/** Writes cells of an existing row; date cells get their format. Columns the tab doesn't have are skipped. */
function setCells(db, t, row, obj) {
  const reqs = [];
  Object.keys(obj).forEach((h) => {
    if (!t.head.includes(h)) return;
    const cell = cellData(cellValue(h, obj[h]));
    let fields = 'userEnteredValue';
    if (DATE_COLS[h] && typeof obj[h] === 'number') {
      cell.userEnteredFormat = { numberFormat: { type: patternType(DATE_COLS[h]), pattern: DATE_COLS[h] } };
      fields += ',userEnteredFormat.numberFormat';
    }
    reqs.push({ updateCells: { range: cellRange(t, row, col(t, h)), rows: [{ values: [cell] }], fields } });
  });
  return batch(db, reqs);
}

// ---------- settings (Code tab: key in column A, value in column B) ----------

function settingEntry(db, key) {
  const i = db.raw.settings.findIndex((r) => String((r && r[0]) || '').trim() === key);
  return i < 0 ? null : { raw: db.raw.settings[i][1], value: String(db.raw.settings[i][1] == null ? '' : db.raw.settings[i][1]).trim(), row: i + 1 };
}

function setting(db, key) { const e = settingEntry(db, key); return e ? e.value : ''; }

async function setSetting(db, key, value, pattern) {
  const t = { name: SHEET_NAMES.settings, sheetId: db.t.settings.sheetId };
  const e = settingEntry(db, key);
  if (!e) {
    await g(db.env, SHEETS_API + db.env.SHEET_ID + '/values/' + encodeURIComponent(quote(t.name) + '!A1') + ':append?valueInputOption=RAW', { method: 'POST', body: JSON.stringify({ values: [[key, value]] }) });
    return;
  }
  const cell = cellData(value);
  if (pattern) cell.userEnteredFormat = { numberFormat: { type: patternType(pattern), pattern } };
  await batch(db, [{ updateCells: { range: cellRange(t, e.row, 1), rows: [{ values: [cell] }], fields: 'userEnteredValue' + (pattern ? ',userEnteredFormat.numberFormat' : '') } }]);
}

// ---------- domain ----------

/** Free text from the phone. Cells are written as plain values (never as formulas), so "=..." stays text. */
function text(v) { return v == null ? '' : String(v).trim().slice(0, 2000); }

function round(n) { return Math.round(n * 100) / 100; }

/** A row as the site expects it: dates as milliseconds; time-only cells from the old form placed on the row's date. */
function plain(r) {
  const o = {};
  Object.keys(r).forEach((k) => {
    if (k === '_row') return;
    const v = r[k];
    if (k === 'שעות' && typeof v === 'number' && !r['מזהה'] && v < 1) { o[k] = round(v * 24); return; } // old form: a duration
    if (!DATE_COLS[k] || typeof v !== 'number') { o[k] = v; return; }
    if (v >= 1) o[k] = fromSerial(v);
    else if (typeof r['תאריך'] === 'number' && r['תאריך'] >= 1) o[k] = fromSerial(Math.floor(r['תאריך']) + v);
    else o[k] = '';
  });
  return o;
}

/** Master Data lists one greenhouse per column (row 1 holds the names). */
function greenhouseList(db) {
  const head = db.raw.greenhouses[0] || [];
  if (String(head[0] || '').trim() === 'סעיף / מאפיין') {
    return head.slice(1).map((n, i) => ({ id: 'GH' + (i + 1), name: String(n).trim() })).filter((x) => x.name);
  }
  return db.t.greenhouses.rows.filter((r) => String(r['פעילה'] || r['פעיל'] || 'כן').trim() !== 'לא').map((r) => ({ id: String(r['מזהה']), name: String(r['שם']) }));
}

function greenhouse(db, id) { return greenhouseList(db).find((x) => x.id === id || x.name === id) || null; }

function workOut(r) {
  return {
    code: String(r['קוד']),
    category: String(r['קטגוריה']),
    name: String(r['שם העבודה']),
    unit: String(r['יחידת כמות'] || ''),
    location: String(r['מיקום'] || 'חממה'),
    interval: Number(r['כל כמה ימים']) || 0,
    track: String(r['מעקב תדירות']).trim() === 'כן',
  };
}

function workByCode(db, code) { return db.t.works.rows.map(workOut).find((w) => w.code === code) || null; }

const isKind = (kind) => (r) => r['קוד עבודה'] === kind;
const isSpecial = (r) => [KIND.shift, KIND.issue, KIND.photo].includes(r['קוד עבודה']);
/** Log data rows that are work (and photo sets), without work-day and problem rows. */
const workRows = (rows) => rows.filter((r) => r['קוד עבודה'] !== KIND.shift && r['קוד עבודה'] !== KIND.issue);

function issueOut(r) {
  const o = plain(r);
  return { 'מזהה': o['מזהה'], 'תאריך': o['תאריך'], 'חממה': o['חממה'], 'מדווח': o['עובד'], 'קטגוריה': o['פירוט'], 'חומרה': o['חומרה'],
    'תיאור': o['הערות'], 'תמונה': o['תמונה'], 'סטטוס': o['סטטוס'] || 'פתוח', 'פתרון': o['פתרון'] };
}

/** Names from the "עובדים" row in Code (comma separated); until it is filled, the names already in Log data. */
function workerList(db) {
  const listed = setting(db, SETTING.workers).split(/[,،\n]/).map((x) => x.trim()).filter(String);
  if (listed.length) return listed;
  return [...new Set(db.t.log.rows.map((r) => String(r['עובד'] || '').trim()).filter(String))];
}

// ---------- actions ----------

const ACTIONS = {
  bootstrap: async (db) => {
    if (!setting(db, SETTING.workers)) Object.assign(db, await load(db.env)); // no names in Code yet: take them from Log data
    return {
      greenhouses: greenhouseList(db),
      works: db.t.works.rows.map(workOut),
      workers: workerList(db),
      tasks: db.t.tasks.rows.filter((r) => r['סטטוס'] !== 'בוצע').map(plain),
    };
  },

  /** When the file last changed (by the app or by hand), so the phones re-read only after a change. */
  stamp: async (db) => {
    const f = await g(db.env, DRIVE + 'files/' + db.env.SHEET_ID + '?fields=modifiedTime,version');
    return { v: String(f.version || f.modifiedTime) };
  },

  taskAdd: async (db, req) => {
    const t = db.t.tasks;
    if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
    if (!String(req.text || '').trim()) throw new Error('חסר תיאור משימה');
    const due = Number(req.due);
    if (!isFinite(due)) throw new Error('תאריך לא תקין');
    const gh = greenhouse(db, req.gh);
    await append(db, t, { 'מזהה': req.id, 'תאריך ביצוע': due, 'חממה': gh ? gh.name : text(req.gh), 'משימה': text(req.text), 'קוד עבודה': text(req.work), 'עובד': text(req.worker), 'סטטוס': 'פתוח', 'נוצר': Date.now() });
    return { id: req.id };
  },

  taskDone: async (db, req) => {
    const t = db.t.tasks;
    const hit = findBy(t, 'מזהה', req.id);
    if (!hit) throw new Error('המשימה לא נמצאה');
    if (hit['סטטוס'] === 'בוצע') return { id: req.id, duplicate: true }; // who and when stay as first written
    await setCells(db, t, hit._row, { 'סטטוס': 'בוצע', 'בוצע': Date.now(), 'בוצע ע"י': text(req.by) });
    return { id: req.id };
  },

  checkIn: async (db, req) => {
    const t = db.t.log;
    if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
    const gh = greenhouse(db, req.gh);
    const work = workByCode(db, req.work);
    const start = when(req.ts);
    const row = await append(db, t, {
      'מזהה': req.id, 'תאריך': dayOf(start), 'עובד': text(req.worker), 'חממה': gh ? gh.name : text(req.gh),
      'קוד עבודה': work ? work.code : text(req.work), 'עבודה': work ? work.name : '', 'קטגוריה': work ? work.category : '',
      'כניסה': start, 'יחידה': work ? work.unit : '', 'סטטוס': 'פתוח', 'עודכן': Date.now(),
    }, { logRow: true });
    return { id: req.id, row };
  },

  checkOut: async (db, req) => {
    const t = db.t.log;
    const hit = findBy(t, 'מזהה', req.id);
    if (!hit || isSpecial(hit)) throw new Error('לא נמצאה כניסה פתוחה (' + req.id + ')');
    if (hit['סטטוס'] === 'סגור') return { id: req.id, duplicate: true };
    await setCells(db, t, hit._row, {
      'יציאה': exitAfter(hit, req.ts),
      'כמות': req.qty === '' || req.qty == null || !isFinite(Number(req.qty)) ? '' : Number(req.qty),
      'הערות': text(req.notes), 'סטטוס': 'סגור', 'עודכן': Date.now(),
    });
    return { id: req.id };
  },

  shiftIn: async (db, req) => {
    const t = db.t.log;
    if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
    const start = when(req.ts);
    await append(db, t, { 'מזהה': req.id, 'תאריך': dayOf(start), 'עובד': text(req.worker), 'עבודה': 'יום עבודה', 'קוד עבודה': KIND.shift, 'כניסה': start, 'סטטוס': 'פתוח' }, { logRow: true });
    return { id: req.id };
  },

  shiftOut: async (db, req) => {
    const t = db.t.log;
    const hit = findBy(t, 'מזהה', req.id);
    if (!hit || hit['קוד עבודה'] !== KIND.shift) throw new Error('לא נמצאה כניסה לעבודה (' + req.id + ')');
    if (hit['סטטוס'] === 'סגור') return { id: req.id, duplicate: true };
    await setCells(db, t, hit._row, { 'יציאה': exitAfter(hit, req.ts), 'סטטוס': 'סגור' });
    return { id: req.id };
  },

  /** The manager opens a photo set for a greenhouse; the photos follow one per request. The date is the upload time. */
  photoSet: async (db, req) => {
    const t = db.t.log;
    if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
    const gh = greenhouse(db, req.gh);
    await append(db, t, { 'מזהה': req.id, 'תאריך': Date.now(), 'עובד': text(req.by), 'חממה': gh ? gh.name : text(req.gh),
      'עבודה': 'תמונות', 'קוד עבודה': KIND.photo, 'הערות': text(req.note), 'סטטוס': 'סגור' }, { formats: { 'תאריך': 'dd/mm/yyyy hh:mm' } });
    return { id: req.id };
  },

  /**
   * One photo per request (the site sends them one after another), its link added to the row's תמונה cell:
   * a photo taken during a greenhouse visit lands in that visit's row, next to its time.
   */
  photo: async (db, req, role) => {
    const t = db.t.log;
    const set = findBy(t, 'מזהה', req.id);
    if (!set) throw new Error('לא נמצאה רשומה (' + req.id + ')');
    const visit = !isSpecial(set);
    if (role !== 'manager' && !visit) throw new Error('נדרש קוד מנהל');
    const p = plain(set);
    const at = visit && typeof p['כניסה'] === 'number' ? p['כניסה'] : typeof p['תאריך'] === 'number' ? p['תאריך'] : Date.now();
    // file name in Drive: greenhouse, upload date and time, number in the set
    const name = (set['חממה'] || 'תמונה') + ' ' + fmtLocal(at, true).replace(':', '-') + ' (' + ((Number(req.idx) || 0) + 1) + ')';
    const url = await savePhoto(db, req.photo, name);
    if (!url) throw new Error('תמונה לא תקינה');
    const cur = String(set['תמונה'] || '');
    if (!cur.includes(url)) await setCells(db, t, set._row, { 'תמונה': cur ? cur + '\n' + url : url });
    return { id: req.id, idx: req.idx, url };
  },

  issue: async (db, req) => {
    const t = db.t.log;
    if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
    const gh = greenhouse(db, req.gh);
    await append(db, t, {
      'מזהה': req.id, 'תאריך': when(req.ts), 'חממה': gh ? gh.name : text(req.gh), 'עובד': text(req.worker), 'עבודה': 'דיווח בעיה',
      'קוד עבודה': KIND.issue, 'פירוט': text(req.category), 'חומרה': text(req.severity), 'הערות': text(req.desc), 'סטטוס': 'פתוח',
    });
    return { id: req.id };
  },

  dashboard: async (db) => ({
    greenhouses: greenhouseList(db),
    works: db.t.works.rows.map(workOut),
    workers: workerList(db),
    log: workRows(db.t.log.rows).map(plain),
    issues: db.t.log.rows.filter(isKind(KIND.issue)).map(issueOut),
    attendance: db.t.log.rows.filter(isKind(KIND.shift)).map(plain),
    tasks: db.t.tasks.rows.map(plain),
    system: await systemStatus(db),
  }),

  backup: (db) => backupNow(db),

  resolveIssue: async (db, req) => {
    const t = db.t.log;
    const hit = findBy(t, 'מזהה', req.id);
    if (!hit || hit['קוד עבודה'] !== KIND.issue) throw new Error('הבעיה לא נמצאה');
    const status = ['פתוח', 'בטיפול', 'טופל'].includes(req.status) ? req.status : 'פתוח';
    const by = text(req.by), solution = text(req.solution);
    await setCells(db, t, hit._row, { 'סטטוס': status, 'פתרון': solution ? solution + (by ? ' (' + by + ')' : '') : '' });
    return { id: req.id };
  },

  report: (db, req) => report(db, req),
};

// ---------- Drive ----------

async function ensureFolder(db, key, name) {
  const id = setting(db, key);
  if (id && !/^[\w-]{10,}$/.test(id)) throw new Error('מזהה תיקייה לא תקין בלשונית Code');
  if (id) return id;
  const f = await g(db.env, DRIVE + 'files?fields=id', { method: 'POST', body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }) });
  await setSetting(db, key, f.id);
  return f.id;
}

async function savePhoto(db, dataUrl, name) {
  // the site always sends a resized JPEG; anything else (SVG, huge files) is refused
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || m[1].length > 4000000) return '';
  const folder = await ensureFolder(db, SETTING.photoFolder, 'חממות וניל - תמונות');
  const boundary = 'vg' + crypto.randomUUID();
  const meta = JSON.stringify({ name: name + '.jpg', parents: [folder], mimeType: 'image/jpeg' });
  const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  const body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: image/jpeg\r\n\r\n', bytes, '\r\n--' + boundary + '--']);
  const f = await g(db.env, DRIVE_UP + '?uploadType=multipart&fields=id,webViewLink', { method: 'POST', body, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary } });
  // the dashboard shows thumbnails, which needs view-by-link
  await g(db.env, DRIVE + 'files/' + f.id + '/permissions', { method: 'POST', body: JSON.stringify({ role: 'reader', type: 'anyone' }) }).catch(() => {});
  return f.webViewLink || 'https://drive.google.com/file/d/' + f.id + '/view';
}

async function share(db, fileId, email, role) {
  await g(db.env, DRIVE + 'files/' + fileId + '/permissions?sendNotificationEmail=false', { method: 'POST', body: JSON.stringify({ role, type: 'user', emailAddress: email }) }).catch(() => {});
}

// ---------- backup: a dated copy of the whole spreadsheet every night, old copies trashed (still recoverable for 30 days) ----------

async function backupNow(db) {
  const env = db.env;
  const folder = await ensureFolder(db, SETTING.backupFolder, 'חממות וניל - גיבויים');
  const now = Date.now();
  const copy = await g(env, DRIVE + 'files/' + env.SHEET_ID + '/copy?fields=id,webViewLink', {
    method: 'POST', body: JSON.stringify({ name: BACKUP_PREFIX + fmtLocal(now, true), parents: [folder] }),
  });
  const cutoff = now - Math.max(7, Number(setting(db, SETTING.keepDays)) || 30) * DAY; // never trash this week's backups
  const list = await g(env, DRIVE + 'files?pageSize=1000&fields=files(id,name,createdTime)&q=' + encodeURIComponent("'" + folder + "' in parents and trashed=false"));
  let kept = 0, removed = 0;
  for (const f of list.files || []) {
    if (!String(f.name).startsWith(BACKUP_PREFIX)) continue; // never touch files the owner put there
    if (Date.parse(f.createdTime) < cutoff) {
      await g(env, DRIVE + 'files/' + f.id, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
      removed++;
    } else kept++;
  }
  // a second owner keeps access to the data, the backups and the photos if the main account is lost
  const second = setting(db, SETTING.secondOwner);
  if (second) {
    const photos = setting(db, SETTING.photoFolder);
    for (const id of [env.SHEET_ID, folder, photos].filter(Boolean)) await share(db, id, second, 'writer');
  }
  await setSetting(db, SETTING.lastBackup, toSerial(now), 'dd/mm/yyyy hh:mm');
  return { at: now, url: copy.webViewLink, kept, removed };
}

async function systemStatus(db) {
  const e = settingEntry(db, SETTING.lastBackup);
  const raw = e && e.raw;
  const last = typeof raw === 'number' ? fromSerial(raw) : raw ? Date.parse(raw) : null;
  let used = null, limit = null;
  try {
    const q = (await g(db.env, DRIVE + 'about?fields=storageQuota(usage,limit)')).storageQuota;
    used = Number(q.usage); limit = q.limit ? Number(q.limit) : null;
  } catch (err) { /* not available */ }
  return { lastBackup: last && !isNaN(last) ? last : null, driveUsed: used, driveLimit: limit, secondOwner: !!setting(db, SETTING.secondOwner) };
}

// ---------- report: a new Google Sheets file for a date range, next to the main file ----------

const GREEN = { red: 0.18, green: 0.42, blue: 0.31 };

function sheetSpec(title, blocks) {
  const rowData = [];
  blocks.forEach(({ at, headers, rows, formats = {} }) => {
    while (rowData.length < at) rowData.push({ values: [] });
    rowData.push({ values: headers.map((h) => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: 'Arial' }, backgroundColor: GREEN, horizontalAlignment: 'CENTER' } })) });
    rows.forEach((r) => rowData.push({ values: r.map((v, i) => {
      const f = formats[headers[i]];
      const isDateFmt = f && f !== '0.00';
      const cell = cellData(isDateFmt && typeof v === 'number' ? toSerial(v) : v);
      cell.userEnteredFormat = { textFormat: { fontFamily: 'Arial' }, horizontalAlignment: 'RIGHT' };
      if (f) cell.userEnteredFormat.numberFormat = { type: patternType(f), pattern: f };
      return cell;
    }) }));
  });
  return { properties: { title, rightToLeft: true, gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData }] };
}

async function report(db, req) {
  const env = db.env;
  const from = req.from ? Number(req.from) : 0;
  const to = req.to ? Number(req.to) : Date.now();
  const all = db.t.log.rows.filter((r) => { const d = plain(r)['תאריך']; return typeof d === 'number' && d >= from && d <= to; });
  const log = workRows(all).map(plain);
  const issues = all.filter(isKind(KIND.issue)).map(issueOut);
  const att = all.filter(isKind(KIND.shift)).map(plain);
  const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
  const first = log.length ? Math.min(...log.map((r) => r['תאריך'])) : Date.now();
  const title = 'דוח חממות וניל ' + fmtDay(from || first) + ' - ' + fmtDay(to);

  const ghs = greenhouseList(db);
  const sumRows = ghs.map((x) => {
    const mine = log.filter((r) => r['חממה'] === x.name);
    return [x.name, round(sum(mine, 'שעות')), mine.length,
      sum(mine.filter((r) => r['קוד עבודה'] === 'W01'), 'כמות'), sum(mine.filter((r) => r['קוד עבודה'] === 'W11'), 'כמות'),
      issues.filter((r) => r['חממה'] === x.name && r['סטטוס'] !== 'טופל').length];
  });
  const hours = {};
  log.forEach((r) => { hours[r['עובד']] = (hours[r['עובד']] || 0) + (Number(r['שעות']) || 0); });
  const pick = (rows, cols) => rows.map((r) => cols.map((c) => (r[c] == null ? '' : r[c])));
  const times = { 'תאריך': 'dd/mm/yyyy', 'כניסה': 'hh:mm', 'יציאה': 'hh:mm', 'שעות': '0.00' };
  const logCols = ['תאריך', 'עובד', 'חממה', 'קוד עבודה', 'עבודה', 'קטגוריה', 'כניסה', 'יציאה', 'שעות', 'כמות', 'יחידה', 'הערות', 'תמונה'];
  const attCols = ['תאריך', 'עובד', 'כניסה', 'יציאה', 'שעות'];
  const issueCols = ['תאריך', 'חממה', 'מדווח', 'קטגוריה', 'חומרה', 'תיאור', 'סטטוס', 'פתרון', 'תמונה'];

  const book = await g(env, SHEETS_API, { method: 'POST', body: JSON.stringify({
    properties: { title, locale: 'iw_IL', timeZone: TZ },
    sheets: [
      sheetSpec('סיכום', [
        { at: 0, headers: ['חממה', 'שעות עבודה', 'ביקורים', 'פרחים שהואבקו', 'תרמילים שנקטפו', 'בעיות פתוחות'], rows: sumRows },
        { at: sumRows.length + 2, headers: ['עובד', 'שעות עבודה'], rows: Object.keys(hours).map((k) => [k, round(hours[k])]) },
      ]),
      sheetSpec('יומן עבודה', [{ at: 0, headers: logCols, rows: pick(log, logCols), formats: times }]),
      sheetSpec('נוכחות', [{ at: 0, headers: attCols, rows: pick(att, attCols), formats: times }]),
      sheetSpec('בעיות', [{ at: 0, headers: issueCols, rows: pick(issues, issueCols), formats: { 'תאריך': 'dd/mm/yyyy' } }]),
    ],
  }) });
  await batch({ env }, book.sheets.map((s) => ({ autoResizeDimensions: { dimensions: { sheetId: s.properties.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 13 } } }))).catch(() => {});

  // next to the main file; hours per worker stay private: only the second owner is added, never "anyone with the link"
  try {
    const [main, mine] = await Promise.all([
      g(env, DRIVE + 'files/' + env.SHEET_ID + '?fields=parents'),
      g(env, DRIVE + 'files/' + book.spreadsheetId + '?fields=parents'),
    ]);
    if (main.parents && main.parents[0]) {
      await g(env, DRIVE + 'files/' + book.spreadsheetId + '?addParents=' + main.parents[0] + '&removeParents=' + (mine.parents || []).join(','), { method: 'PATCH', body: '{}' });
    }
  } catch (err) { /* the report stays in My Drive */ }
  const second = setting(db, SETTING.secondOwner);
  if (second) await share(db, book.spreadsheetId, second, 'reader');
  return { url: book.spreadsheetUrl, title };
}

// ---------- responses ----------

function json(o) {
  return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
}

function page(msg, status = 200) {
  const esc = String(msg).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Response('<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>חממות וניל</title>' +
    '<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0 16px;font-size:20px;text-align:center">' + esc + '</body></html>',
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

