// Runs worker/index.js against a fake Google (Sheets + Drive + OAuth) holding the farm's real layout,
// so tab, column, time-zone and behaviour mistakes surface before deploying.
// node scripts/worker-test.mjs
import assert from 'node:assert';
import worker from '../worker/index.js';

const DAY = 86400000;
const serialOf = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) / DAY + 25569; // wall-clock serial
const wall = (serial) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' }).format(new Date(Math.round((serial - 25569) * DAY)));
const israel = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));

// ---- the farm's file, as the Sheets API stores it (dates are serial numbers) ----
const LOG_HEAD = ['תאריך', 'עובד / מדווח', 'מספר חממה', 'זמן הגעה (כניסה)', 'זמן יציאה', 'סה"כ שעות עבודה', 'קטגוריית טיפול', 'פירוט עבודה ומיקום', 'כמות / תפוקה', 'חומרים / תמונות', 'הערות / בעיות שנצפו',
  'סטטוס', 'מזהה', 'קוד עבודה', 'יחידה', 'חומרה', 'פתרון'];
const OLD_PHOTO = 'https://drive.google.com/file/d/1lngmWYujOqXTPMvCekcK81G7BoUBUhM8/view?usp=drivesdk';
const tabs = {
  'Code': [[], ['Deployment ID', 'AKfy'], ['URL', 'https://script.google.com/x/exec'], [], ['כתובת האתר', 'https://site/'], ['קוד עובדים', '•••'], ['קוד מנהל', '•••'],
    ['עובדים'], ['מזהה תיקיית תמונות ב-Drive', 'PHOTOS-folder-1234'], ['אימייל לעדכון יומי'], ['מזהה תיקיית גיבוי ב-Drive', 'BACKUPS-folder-1234'], ['אימייל בעלים שני', 'owner2@example.com'],
    ['גיבוי אחרון', serialOf(2026, 11, 7, 2, 0)], ['ימים לשמירת גיבויים', 30]],
  'Master Data': [['סעיף / מאפיין', 'חממה 1', 'חממה 2', 'חממה 3'], ['שטח החממה (מ"ר)', 50, 50, 50]],
  'Work': [
    ['קוד עבודה', 'קטגוריית עבודה', 'שם העבודה / טיפול אגרוטכני', 'תיאור מפורט והנחיות ביצוע', 'עונה / שלב פנולוגי מומלץ', 'תדירות / מחזוריות', 'כל כמה ימים', 'יחידת כמות', 'מיקום', 'מעקב תדירות'],
    ['W01', 'האבקה ופריחה', 'האבקה ידנית של פרחים', 'תיאור', 'אביב', 'יומי', 1, 'פרחים', 'חממה', 'לא'],
    ['W09', 'הגנת הצומח', 'ניטור מזיקים ומחלות', 'תיאור', 'כל השנה', 'שבועי', 7, '', 'חממה', 'כן'],
    ['W12', 'קטיף והאסיף', 'מיון, שקילה ושטיפת תרמילים', 'תיאור', 'קטיף', 'יומי', 1, 'ק"ג', 'מחסן', 'לא'],
  ],
  // the old form's row: date, time-only entry/exit and duration
  'Log data': [LOG_HEAD, [serialOf(2026, 11, 7), 'מגדל', 'חממה 2', 15.5 / 24, 16.75 / 24, 1.25 / 24, 'דילול וספירת פרחים/אשכולות', '', '', OLD_PHOTO, '', 'Pending']],
  'Calendar': [['מזהה', 'תאריך ביצוע', 'חממה', 'משימה', 'קוד עבודה', 'עובד', 'סטטוס', 'נוצר', 'בוצע', 'בוצע ע"י']],
};
const before = JSON.stringify(tabs);
const sheetIds = Object.fromEntries(Object.keys(tabs).map((n, i) => [n, 100 + i]));
const byId = Object.fromEntries(Object.entries(sheetIds).map(([n, id]) => [id, n]));
const formulas = {}, formats = {};
const files = [{ id: 'B-OLD', name: 'גיבוי חממות וניל 2026-09-01 02:00', parents: ['BACKUPS-folder-1234'], createdTime: '2026-09-01T00:00:00Z' },
  { id: 'MINE', name: 'מסמך של הבעלים', parents: ['BACKUPS-folder-1234'], createdTime: '2020-01-01T00:00:00Z' }];
const perms = [], created = [], patches = [];
let tokenCalls = 0;

const titleOf = (range) => { const m = /^'((?:[^']|'')+)'/.exec(range); return m[1].replace(/''/g, "'"); };
const trim = (rows) => {
  const out = rows.map((r) => { const c = (r || []).slice(); while (c.length && (c[c.length - 1] === '' || c[c.length - 1] == null)) c.pop(); return c; });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
};
// Sheets computes the hours formula; the fake does the same for the one formula the server writes
const evaluate = () => Object.entries(formulas).forEach(([k, f]) => {
  const [t, rc] = k.split('!'); const [i, j] = rc.split(',').map(Number);
  const m = /ROUND\(\(([A-Z])(\d+)-([A-Z])(\d+)\)\*24,2\)/.exec(f);
  const get = (c, rr) => tabs[t][rr - 1][c.charCodeAt(0) - 65];
  const out = get(m[1], +m[2]), inn = get(m[3], +m[4]);
  tabs[t][i][j] = out === '' || inn === '' || out == null ? '' : Math.round((out - inn) * 24 * 100) / 100;
});
const ok = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, opt = {}) => {
  const url = new URL(String(input));
  const method = opt.method || 'GET';
  const body = typeof opt.body === 'string' ? opt.body : null;
  const path = decodeURIComponent(url.pathname);
  if (url.host === 'oauth2.googleapis.com') {
    const p = new URLSearchParams(String(opt.body));
    if (p.get('grant_type') === 'authorization_code') {
      const email = p.get('code') === 'GOOD' ? 'cortado.snir@gmail.com' : 'someone@evil.com';
      const idt = 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.y';
      return ok({ refresh_token: 'R-' + email, id_token: idt });
    }
    tokenCalls++;
    assert.strictEqual(p.get('refresh_token'), 'R-cortado.snir@gmail.com', 'uses the stored refresh token');
    return ok({ access_token: 'AT', expires_in: 3600 });
  }
  assert.strictEqual(opt.headers.Authorization, 'Bearer AT', 'every Google call is authorized');
  if (url.host === 'sheets.googleapis.com') {
    if (method === 'GET' && path.endsWith('/values:batchGet')) {
      assert.strictEqual(url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
      evaluate();
      return ok({ valueRanges: url.searchParams.getAll('ranges').map((r) => ({ range: r, values: trim(tabs[titleOf(r)]) })) });
    }
    if (method === 'GET') return ok({ sheets: Object.keys(tabs).map((t) => ({ properties: { title: t, sheetId: sheetIds[t] } })) });
    if (path.endsWith(':append')) {
      assert.strictEqual(url.searchParams.get('valueInputOption'), 'RAW', 'values are never parsed as formulas');
      assert.notStrictEqual(url.searchParams.get('insertDataOption'), 'OVERWRITE', 'new rows never overwrite cells');
      const t = titleOf(path.split('/values/')[1]);
      const rows = tabs[t];
      let last = rows.length; while (last > 0 && !(rows[last - 1] || []).some((c) => c !== '' && c != null)) last--;
      const row = JSON.parse(body).values[0];
      rows[last] = row;
      return ok({ updates: { updatedRange: "'" + t + "'!A" + (last + 1) + ':Q' + (last + 1) } });
    }
    if (path.endsWith(':batchUpdate')) {
      for (const r of JSON.parse(body).requests) {
        const x = r.updateCells || r.repeatCell;
        if (!x) continue;
        const t = byId[x.range.sheetId], i = x.range.startRowIndex, j = x.range.startColumnIndex;
        const cell = r.updateCells ? x.rows[0].values[0] : x.cell;
        if (r.updateCells) {
          const v = cell.userEnteredValue || {};
          tabs[t][i] = tabs[t][i] || [];
          tabs[t][i][j] = 'numberValue' in v ? v.numberValue : 'stringValue' in v ? v.stringValue : '';
          if (v.formulaValue) formulas[t + '!' + i + ',' + j] = v.formulaValue;
        }
        if (cell.userEnteredFormat && cell.userEnteredFormat.numberFormat) formats[t + '!' + i + ',' + j] = cell.userEnteredFormat.numberFormat.pattern;
      }
      return ok({});
    }
    if (method === 'POST' && path === '/v4/spreadsheets/') {
      const spec = JSON.parse(body); created.push(spec);
      return ok({ spreadsheetId: 'REPORT', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/REPORT', sheets: spec.sheets.map((s, i) => ({ properties: { sheetId: i } })) });
    }
  }
  if (url.host === 'www.googleapis.com') {
    if (path.startsWith('/upload/drive/v3/files')) {
      const text = await new Blob([opt.body]).text();
      const meta = JSON.parse(text.split('\r\n\r\n')[1].split('\r\n')[0]);
      const f = { id: 'F' + files.length, ...meta, createdTime: new Date().toISOString() };
      files.push(f);
      return ok({ id: f.id, webViewLink: 'https://drive.google.com/file/d/' + f.id + '/view?usp=drivesdk' });
    }
    if (path.endsWith('/permissions')) { perms.push({ file: path.split('/')[4], ...JSON.parse(body) }); return ok({}); }
    if (path.endsWith('/copy')) { const f = { id: 'C' + files.length, ...JSON.parse(body), createdTime: new Date().toISOString(), source: path.split('/')[4] }; files.push(f); return ok({ id: f.id, webViewLink: 'https://docs/' + f.id }); }
    if (path === '/drive/v3/about') return ok({ storageQuota: { usage: '1000', limit: '16106127360' } });
    if (path === '/drive/v3/files' && method === 'GET') {
      const folder = /'([^']+)' in parents/.exec(url.searchParams.get('q'))[1];
      return ok({ files: files.filter((f) => (f.parents || []).includes(folder) && !f.trashed) });
    }
    if (path === '/drive/v3/files' && method === 'POST') { const f = { id: 'FOLDER' + files.length, ...JSON.parse(body) }; files.push(f); return ok({ id: f.id }); }
    if (method === 'PATCH') {
      const id = path.split('/')[4]; patches.push({ id, query: url.search, body: JSON.parse(body) });
      const f = files.find((x) => x.id === id); if (f) Object.assign(f, JSON.parse(body));
      return ok({});
    }
    if (method === 'GET') return ok({ parents: [path.includes('REPORT') ? 'root' : 'FARM-FOLDER'] });
  }
  throw new Error('unexpected request ' + method + ' ' + url);
};

const kv = new Map();
const env = {
  SHEET_ID: 'SHEET', ALLOWED_EMAIL: 'cortado.snir@gmail.com', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec',
  WORKER_CODE: 'WORK2468AB', MANAGER_CODE: 'MGR13579XYZ',
  STORE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
};
const W = env.WORKER_CODE, M = env.MANAGER_CODE;
const call = async (body) => (await worker.fetch(new Request('https://vg.workers.dev/', { method: 'POST', body: JSON.stringify(body) }), env)).json();
const get = (path) => worker.fetch(new Request('https://vg.workers.dev' + path), env);
const log = tabs['Log data'];
const logCol = (name) => LOG_HEAD.indexOf(name);
const lastLog = () => log[log.length - 1];

// ---- one-time connect: only the farm's account ----
let r = await call({ action: 'bootstrap', code: W });
assert.match(r.error, /לא מחובר/, 'before connecting');
assert.strictEqual(r.retry, false);
let res = await get('/connect');
assert.strictEqual(res.status, 302);
const auth = new URL(res.headers.get('Location'));
assert.match(auth.searchParams.get('scope'), /spreadsheets/);
assert.strictEqual(auth.searchParams.get('redirect_uri'), 'https://vg.workers.dev/oauth');
assert.strictEqual(auth.searchParams.get('access_type'), 'offline');
res = await get('/oauth?state=wrong&code=GOOD');
assert.strictEqual(res.status, 400, 'state must match');
res = await get('/oauth?state=' + auth.searchParams.get('state') + '&code=EVIL');
assert.strictEqual(res.status, 403, 'another Google account is refused');
assert.strictEqual(kv.get('refresh_token'), undefined);
res = await get('/connect');
res = await get('/oauth?state=' + new URL(res.headers.get('Location')).searchParams.get('state') + '&code=GOOD');
assert.strictEqual(res.status, 200);
assert.match(await res.text(), /מחובר/);
assert.strictEqual(kv.get('refresh_token'), 'R-cortado.snir@gmail.com');
assert.strictEqual((await (await get('/')).json()).connected, true);
assert.match(await (await get('/privacy')).text(), /פרטית/);

// ---- codes ----
assert.strictEqual((await call({ action: 'bootstrap', code: 'nope' })).error, 'קוד שגוי');
assert.strictEqual((await call({ action: 'bootstrap', code: '' })).error, 'קוד שגוי');
assert.strictEqual((await call({ action: 'bootstrap', code: W })).role, 'worker');
assert.strictEqual((await call({ action: 'bootstrap', code: M })).role, 'manager');
assert.strictEqual((await call({ action: 'dashboard', code: W })).error, 'נדרש קוד מנהל');
assert.strictEqual((await call({ action: 'checkIn', code: W, id: '=cmd' })).error, 'מזהה לא תקין');
for (const action of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
  const x = await call({ action, code: W });
  assert.strictEqual(x.ok, false, action + ' is not an action');
  assert.ok(!JSON.stringify(x).includes(env.MANAGER_CODE) && !JSON.stringify(x).includes('sec'), 'secrets never leak (' + action + ')');
}
for (let i = 0; i < 50; i++) await call({ action: 'bootstrap', code: 'bad' + i });
assert.strictEqual((await call({ action: 'bootstrap', code: W })).role, 'worker', 'no lockout after a flood');
const shortEnv = { ...env, WORKER_CODE: '1234' };
assert.strictEqual(await (await worker.fetch(new Request('https://vg.workers.dev/', { method: 'POST', body: JSON.stringify({ action: 'bootstrap', code: '1234' }) }), shortEnv)).json().then((x) => x.error), 'קוד שגוי', 'a short code is never accepted');

// ---- bootstrap reads the farm's tabs ----
const boot = (await call({ action: 'bootstrap', code: W })).data;
assert.deepStrictEqual(boot.greenhouses.map((x) => x.id + ':' + x.name), ['GH1:חממה 1', 'GH2:חממה 2', 'GH3:חממה 3']);
const w09 = boot.works.find((w) => w.code === 'W09');
assert.deepStrictEqual([w09.name, w09.category, w09.interval, w09.track], ['ניטור מזיקים ומחלות', 'הגנת הצומח', 7, true]);
assert.strictEqual(boot.works.find((w) => w.code === 'W12').location, 'מחסן');
assert.deepStrictEqual(boot.workers, ['מגדל'], 'until the workers row is filled, names already in Log data');
tabs['Code'][7][1] = 'גרשון';
assert.deepStrictEqual((await call({ action: 'bootstrap', code: W })).data.workers, ['גרשון']);
assert.strictEqual(tokenCalls, 1, 'the access token is reused');

// ---- work in a greenhouse ----
const t0 = Date.now() - 10 * 3600000;
assert.ok((await call({ action: 'checkIn', code: W, id: 'L-1', worker: 'גרשון', gh: 'GH1', work: 'W01', ts: t0 })).ok);
assert.strictEqual((await call({ action: 'checkIn', code: W, id: 'L-1', worker: 'גרשון', gh: 'GH1', work: 'W01', ts: t0 })).data.duplicate, true, 'idempotent');
let row = lastLog();
const n = log.length - 1;
assert.strictEqual(row[logCol('עובד / מדווח')], 'גרשון');
assert.strictEqual(row[logCol('מספר חממה')], 'חממה 1');
assert.strictEqual(row[logCol('קטגוריית טיפול')], 'האבקה ידנית של פרחים');
assert.strictEqual(row[logCol('קוד עבודה')], 'W01');
assert.strictEqual(row[logCol('יחידה')], 'פרחים');
assert.strictEqual(row[logCol('סטטוס')], 'פתוח');
assert.strictEqual(wall(row[logCol('זמן הגעה (כניסה)')]), israel(t0), 'entry stored as Israel wall-clock time');
assert.strictEqual(Number.isInteger(row[logCol('תאריך')]), true, 'date cell is a whole day');
assert.match(formulas['Log data!' + n + ',' + logCol('סה"כ שעות עבודה')], /^=IF\(OR\(D\d+="",E\d+=""\),"",ROUND\(\(E\d+-D\d+\)\*24,2\)\)$/, 'hours formula on its own row');
assert.strictEqual(formats['Log data!' + n + ',' + logCol('תאריך')], 'dd/mm/yyyy');
assert.strictEqual(formats['Log data!' + n + ',' + logCol('זמן הגעה (כניסה)')], 'hh:mm');
assert.ok((await call({ action: 'checkOut', code: W, id: 'L-1', ts: t0 + 2.5 * 3600000, qty: '120', notes: '=HYPERLINK("x")' })).ok);
row = log[n];
assert.strictEqual(row[logCol('כמות / תפוקה')], 120);
assert.strictEqual(row[logCol('הערות / בעיות שנצפו')], '=HYPERLINK("x")', 'stored as text');
assert.strictEqual(formulas['Log data!' + n + ',' + logCol('הערות / בעיות שנצפו')], undefined, 'never a formula');
assert.strictEqual(row[logCol('סטטוס')], 'סגור');
assert.ok(Math.abs((row[logCol('זמן יציאה')] - row[logCol('זמן הגעה (כניסה)')]) * 24 - 2.5) < 1e-6, '2.5 hours apart');
assert.strictEqual((await call({ action: 'checkOut', code: W, id: 'L-1', ts: t0 + 3 * 3600000 })).data.duplicate, true);
assert.match((await call({ action: 'checkOut', code: W, id: 'L-9', ts: t0 })).error, /לא נמצאה/);
assert.ok((await call({ action: 'checkIn', code: W, id: 'L-2', worker: 'גרשון', gh: 'מחסן', work: 'W12', ts: t0 })).ok);
assert.strictEqual(lastLog()[logCol('מספר חממה')], 'מחסן');
assert.match((await call({ action: 'checkOut', code: W, id: 'L-2', ts: t0 - 3600000 })).error, /לפני שעת כניסה/);

// a check-in half an hour after midnight belongs to that day in Israel, not the UTC day before
const midnight = (() => { const now = Date.now(); for (let ms = now - DAY; ; ms += 60000) if (israel(ms).endsWith('00:30')) return ms; })();
assert.ok((await call({ action: 'checkIn', code: W, id: 'L-3', worker: 'גרשון', gh: 'GH2', work: 'W09', ts: midnight })).ok);
const dserial = lastLog()[logCol('תאריך')];
assert.strictEqual(new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'short' }).format(new Date((dserial - 25569) * DAY)), israel(midnight).split(',')[0]);

// ---- work day ----
assert.ok((await call({ action: 'shiftIn', code: W, id: 'S-1', worker: 'גרשון', ts: t0 - 3600000 })).ok);
assert.strictEqual(lastLog()[logCol('קוד עבודה')], 'SHIFT');
assert.strictEqual(lastLog()[logCol('קטגוריית טיפול')], 'יום עבודה');
assert.ok((await call({ action: 'shiftOut', code: W, id: 'S-1', ts: t0 + 8 * 3600000 })).ok);
assert.strictEqual(lastLog()[logCol('סטטוס')], 'סגור');
assert.match((await call({ action: 'shiftOut', code: W, id: 'L-2', ts: t0 })).error, /לא נמצאה/, 'shiftOut only closes work days');
assert.match((await call({ action: 'shiftIn', code: W, id: 'S-2', worker: 'גרשון', ts: Date.now() + 3600000 })).error, /זמן לא תקין/);
assert.match((await call({ action: 'shiftIn', code: W, id: 'S-2', worker: 'גרשון', ts: Date.now() - 30 * DAY })).error, /זמן לא תקין/);

// ---- problems ----
assert.ok((await call({ action: 'issue', code: W, id: 'B-1', ts: t0, gh: 'GH2', worker: 'גרשון', category: 'מזיקים', severity: 'גבוהה', desc: 'אקריות' })).ok);
row = lastLog();
assert.strictEqual(row[logCol('קוד עבודה')], 'ISSUE');
assert.strictEqual(row[logCol('פירוט עבודה ומיקום')], 'מזיקים');
assert.strictEqual(row[logCol('חומרה')], 'גבוהה');
assert.strictEqual((await call({ action: 'resolveIssue', code: W, id: 'B-1', status: 'טופל' })).error, 'נדרש קוד מנהל');
assert.ok((await call({ action: 'resolveIssue', code: M, id: 'B-1', status: 'טופל', by: 'מנהל', solution: 'רוסס' })).ok);
assert.strictEqual(lastLog()[logCol('סטטוס')], 'טופל');
assert.strictEqual(lastLog()[logCol('פתרון')], 'רוסס (מנהל)');
await call({ action: 'resolveIssue', code: M, id: 'B-1', status: 'hack' });
assert.strictEqual(lastLog()[logCol('סטטוס')], 'פתוח', 'unknown status falls back');
assert.match((await call({ action: 'resolveIssue', code: M, id: 'L-1', status: 'טופל' })).error, /לא נמצאה/);
assert.match((await call({ action: 'checkOut', code: W, id: 'B-1', ts: t0 })).error, /לא נמצאה/, 'checkOut cannot overwrite a problem report');

// ---- photos go to the farm's Drive folder, links and upload time in Log data ----
const jpg = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');
assert.strictEqual((await call({ action: 'photoSet', code: W, id: 'P-1', gh: 'GH3' })).error, 'נדרש קוד מנהל');
assert.ok((await call({ action: 'photoSet', code: M, id: 'P-1', gh: 'GH3', note: 'פריחה', by: 'מנהל' })).ok);
const pRow = log.length - 1;
assert.strictEqual(formats['Log data!' + pRow + ',' + logCol('תאריך')], 'dd/mm/yyyy hh:mm', 'photo row shows date and time');
assert.ok(Math.abs((log[pRow][logCol('תאריך')] - 25569) * DAY - Date.now() - (israelOffset())) < 120000, 'row date is the upload time');
for (let i = 0; i < 3; i++) assert.ok((await call({ action: 'photo', code: M, id: 'P-1', idx: i, photo: jpg })).ok);
row = log[pRow];
assert.strictEqual(row[logCol('מספר חממה')], 'חממה 3');
assert.strictEqual(row[logCol('חומרים / תמונות')].split('\n').length, 3);
const photos = files.filter((f) => f.mimeType === 'image/jpeg');
assert.strictEqual(photos.length, 3);
assert.deepStrictEqual(photos[0].parents, ['PHOTOS-folder-1234'], 'into the folder from the Code tab');
assert.match(photos[2].name, /^חממה 3 \d{4}-\d\d-\d\d \d\d-\d\d \(3\)\.jpg$/, 'named by greenhouse, upload time and number');
assert.ok(perms.some((p) => p.file === photos[0].id && p.type === 'anyone' && p.role === 'reader'), 'thumbnail can be shown');
assert.match((await call({ action: 'photo', code: M, id: 'P-404', idx: 0, photo: jpg })).error, /לא נמצאה/);
assert.match((await call({ action: 'photo', code: M, id: 'P-1', idx: 3, photo: 'garbage' })).error, /לא תקינה/);
assert.match((await call({ action: 'photo', code: M, id: 'P-1', idx: 3, photo: 'data:image/svg+xml;base64,PHN2Zz4=' })).error, /לא תקינה/, 'JPEG only');
assert.strictEqual(files.filter((f) => f.mimeType === 'image/jpeg').length, 3, 'nothing uploaded for refused photos');

// ---- planned works go to Calendar ----
const cal = tabs['Calendar'];
assert.strictEqual((await call({ action: 'taskAdd', code: W, id: 'T-1', gh: 'GH1', text: 'x', due: t0 })).error, 'נדרש קוד מנהל');
assert.ok((await call({ action: 'taskAdd', code: M, id: 'T-1', gh: 'GH2', work: 'W09', text: 'ניטור', due: t0 + DAY, worker: 'גרשון' })).ok);
assert.match((await call({ action: 'taskAdd', code: M, id: 'T-2', gh: 'GH2', text: ' ', due: t0 })).error, /חסר/);
assert.strictEqual(cal[1][2], 'חממה 2');
assert.strictEqual(formats['Calendar!1,1'], 'dd/mm/yyyy');
assert.strictEqual((await call({ action: 'bootstrap', code: W })).data.tasks.length, 1);
assert.strictEqual((await call({ action: 'bootstrap', code: W })).data.tasks[0]['תאריך ביצוע'], Math.round(t0 + DAY), 'due date comes back as the same moment');
assert.ok((await call({ action: 'taskDone', code: W, id: 'T-1', by: 'גרשון' })).ok);
assert.strictEqual(cal[1][6], 'בוצע');
assert.strictEqual((await call({ action: 'bootstrap', code: W })).data.tasks.length, 0);
const doneAt = cal[1][8];
assert.strictEqual((await call({ action: 'taskDone', code: W, id: 'T-1', by: 'אחר' })).data.duplicate, true);
assert.deepStrictEqual([cal[1][8], cal[1][9]], [doneAt, 'גרשון'], 'a done task keeps who and when');

// ---- dashboard: work rows, work days, problems; the old form's row reads right ----
const d = await call({ action: 'dashboard', code: M });
assert.ok(d.ok, d.error);
assert.deepStrictEqual(d.data.log.map((x) => x['מזהה'] || 'old'), ['old', 'L-1', 'L-2', 'L-3', 'P-1']);
const old = d.data.log[0];
assert.strictEqual(israel(old['כניסה']), '07/11/2026, 15:30', 'old time-only entry placed on its date');
assert.strictEqual(israel(old['יציאה']), '07/11/2026, 16:45');
assert.strictEqual(old['שעות'], 1.25, 'old duration in hours');
assert.strictEqual(old['תמונה'], OLD_PHOTO);
assert.strictEqual(d.data.attendance.length, 1);
assert.strictEqual(d.data.issues[0]['מדווח'], 'גרשון');
assert.strictEqual(israel(d.data.system.lastBackup), '07/11/2026, 02:00');
assert.strictEqual(d.data.system.driveLimit, 16106127360);
assert.strictEqual(d.data.system.secondOwner, true);

// ---- backup ----
const b = await call({ action: 'backup', code: M });
assert.ok(b.ok, b.error);
const copy = files.find((f) => f.source === 'SHEET');
assert.deepStrictEqual(copy.parents, ['BACKUPS-folder-1234']);
assert.match(copy.name, /^גיבוי חממות וניל \d{4}-\d\d-\d\d \d\d:\d\d$/);
assert.strictEqual(files.find((f) => f.id === 'B-OLD').trashed, true, 'old backup to the trash');
assert.ok(!files.find((f) => f.id === 'MINE').trashed, "the owner's own files are never touched");
assert.deepStrictEqual([b.data.kept, b.data.removed], [1, 1]);
assert.ok(perms.some((p) => p.file === 'SHEET' && p.emailAddress === 'owner2@example.com' && p.role === 'writer'));
assert.ok(Math.abs((tabs['Code'][12][1] - 25569) * DAY - Date.now() - israelOffset()) < 120000, 'last backup time written');
assert.strictEqual(formats['Code!12,1'], 'dd/mm/yyyy hh:mm');
// the nightly cron runs the same backup
let waited;
await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } });
await waited;
assert.strictEqual(files.filter((f) => f.source === 'SHEET').length, 2);

// ---- report: a new file next to the main one, private ----
const rep = await call({ action: 'report', code: M, from: Date.now() - 30 * DAY, to: Date.now() });
assert.ok(rep.ok, rep.error);
assert.strictEqual(rep.data.url, 'https://docs.google.com/spreadsheets/d/REPORT');
assert.deepStrictEqual(created[0].sheets.map((s) => s.properties.title), ['סיכום', 'יומן עבודה', 'נוכחות', 'בעיות']);
assert.ok(created[0].sheets.every((s) => s.properties.rightToLeft));
const sumRows = created[0].sheets[0].data[0].rowData;
assert.strictEqual(sumRows[1].values[0].userEnteredValue.stringValue, 'חממה 1');
assert.strictEqual(sumRows[1].values[1].userEnteredValue.numberValue, 2.5, 'hours from the hours column');
assert.ok(patches.some((p) => p.id === 'REPORT' && /addParents=FARM-FOLDER/.test(p.query)), 'moved next to the main file');
assert.ok(perms.some((p) => p.file === 'REPORT' && p.emailAddress === 'owner2@example.com' && p.role === 'reader'));
assert.ok(!perms.some((p) => p.file === 'REPORT' && p.type === 'anyone'), 'never public by link');

// ---- Google trouble is reported as retryable, so the phone keeps the report ----
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => (String(u).includes('sheets.googleapis.com') ? new Response('{"error":{"message":"busy"}}', { status: 503 }) : realFetch(u, o));
const busy = await call({ action: 'checkIn', code: W, id: 'L-9', worker: 'גרשון', gh: 'GH1', work: 'W01', ts: t0 });
assert.deepStrictEqual([busy.ok, busy.retry], [false, true]);
globalThis.fetch = realFetch;

// ---- nothing that was there before is changed or removed ----
const was = JSON.parse(before);
assert.deepStrictEqual(tabs['Master Data'], was['Master Data']);
assert.deepStrictEqual(tabs['Work'], was['Work']);
assert.deepStrictEqual(log[1], was['Log data'][1], 'the old row untouched');
assert.deepStrictEqual(tabs['Code'].slice(0, 7), was['Code'].slice(0, 7));
console.log('worker test ok');

function israelOffset() { const now = Date.now(); const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now)).forEach((x) => { p[x.type] = x.value; }); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(now / 1000) * 1000; }
