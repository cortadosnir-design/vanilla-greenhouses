// Runs apps-script/Code.gs against in-memory stubs of the Apps Script services, with the real sheet headers
// from vanilla-greenhouses.xlsx, so header/column mismatches and reference errors surface before deploying.
// node scripts/gas-harness.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const headers = JSON.parse(execFileSync('python3', ['-I', '-c', `
import json, openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(path.join(root, 'vanilla-greenhouses.xlsx'))})
print(json.dumps({ws.title: [c.value for c in ws[1]] for ws in wb}, ensure_ascii=False))`]).toString());

// ---- minimal Sheets model ----
class Range {
  constructor(sh, r, c, nr = 1, nc = 1) { Object.assign(this, { sh, r, c, nr, nc }); }
  setValue(v) { this.sh.cell(this.r, this.c, v); return this; }
  setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => this.sh.cell(this.r + i, this.c + j, v))); return this; }
  getValue() { return this.sh.rows[this.r - 1]?.[this.c - 1] ?? ''; }
  getDisplayValue() { const v = this.getValue(); return Object.prototype.toString.call(v) === '[object Date]' ? v.toLocaleDateString('en-GB') : String(v); }
  getValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sh.rows[this.r - 1 + i]?.[this.c - 1 + j] ?? '')); }
  getA1Notation() { return String.fromCharCode(64 + this.c) + this.r; }
  setFormula(f) { this.sh.formulas[this.getA1Notation()] = f; this.sh.cell(this.r, this.c, 0.5); return this; }
  setNumberFormat() { return this; } setFontWeight() { return this; } setFontColor() { return this; } setBackground() { return this; }
  setHorizontalAlignment() { return this; } setFontFamily() { return this; } applyRowBanding() { return this; }
}
class Sheet {
  constructor(name, head) { this.name = name; this.rows = [head.map((h) => h ?? '')]; this.formulas = {}; }
  getName() { return this.name; }
  cell(r, c, v) { while (this.rows.length < r) this.rows.push([]); const row = this.rows[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getDataRange() { return new Range(this, 1, 1, this.rows.length, Math.max(...this.rows.map((r) => r.length))); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(vals) { this.rows.push(vals.slice()); return this; }
  getLastRow() { return this.rows.length; }
  setName(n) { this.name = n; return this; } setRightToLeft() { return this; } setFrozenRows() { return this; } autoResizeColumns() { return this; }
}
class Spreadsheet {
  constructor(name, sheets) { this.name = name; this.sheets = sheets; this.id = 'ss-' + name; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets; }
  insertSheet(n) { const s = new Sheet(n, []); s.rows = []; this.sheets.push(s); return s; }
  getId() { return this.id; } getUrl() { return 'https://sheets/' + this.id; } getName() { return this.name; }
}
const main = new Spreadsheet('main', Object.entries(headers).map(([n, h]) => new Sheet(n, h)));
// seed data as the owner would fill it
const put = (sheetName, row) => main.getSheetByName(sheetName).appendRow(row);
const H = (n) => headers[n];
const obj = (n, o) => H(n).map((h) => (h in o ? o[h] : ''));
put('חממות', obj('חממות', { 'מזהה': 'GH1', 'שם': 'חממה 1', 'פעילה': 'כן' }));
put('חממות', obj('חממות', { 'מזהה': 'GH2', 'שם': 'חממה 2', 'פעילה': 'כן' }));
put('חממות', obj('חממות', { 'מזהה': 'GH3', 'שם': 'חממה 3', 'פעילה': 'לא' }));
put('עבודות', obj('עבודות', { 'קוד': 'W01', 'קטגוריה': 'האבקה', 'שם העבודה': 'האבקה ידנית', 'יחידת כמות': 'פרחים', 'מיקום': 'חממה', 'כל כמה ימים': 1, 'מעקב תדירות': 'לא' }));
put('עבודות', obj('עבודות', { 'קוד': 'W12', 'קטגוריה': 'קטיף', 'שם העבודה': 'מיון', 'יחידת כמות': 'ק"ג', 'מיקום': 'מחסן', 'כל כמה ימים': '', 'מעקב תדירות': 'לא' }));
put('עובדים', obj('עובדים', { 'שם': 'דנה', 'פעיל': 'כן' }));
put('עובדים', obj('עובדים', { 'שם': 'ישן', 'פעיל': 'לא' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'קוד עובדים', 'ערך': 'abc123' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'קוד מנהל', 'ערך': 'mgr987' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'מזהה תיקיית תמונות ב-Drive', 'ערך': '' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'אימייל לעדכון יומי', 'ערך': 'owner@example.com' }));

const drive = { files: [], folders: [], editors: [] };
const sandbox = {
  SpreadsheetApp: { getActive: () => main, create: (name) => new Spreadsheet(name, [new Sheet('Sheet1', [])]), BandingTheme: { GREEN: 1 } },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
    getRootFolder: () => ({ getName: () => 'root' }),
    createFolder: (n) => { const f = { id: 'folder-' + drive.folders.length, name: n, files: [], getId() { return this.id; }, addEditor(e) { drive.editors.push([this.name, e]); },
      getFiles() { let i = 0; const list = this.files; return { hasNext: () => i < list.length, next: () => list[i++] }; }, createFile(b) { const file = { id: 'file-' + drive.files.length, blob: b, shared: null, setSharing(a, p) { this.shared = [a, p]; }, getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; } }; drive.files.push(file); return file; } }; drive.folders.push(f); return f; },
    getFolderById: (id) => drive.folders.find((f) => f.id === id) || (() => { throw new Error('no folder ' + id); })(),
    getFileById: (id) => ({ getParents: () => ({ hasNext: () => false }), setSharing() {}, moveTo() {}, addEditor(e) { drive.editors.push(['file:' + id, e]); },
      makeCopy(name, folder) { const f = { name, created: new Date(), trashed: false, getName() { return this.name; }, getDateCreated() { return this.created; }, setTrashed(v) { this.trashed = v; }, getUrl() { return 'https://sheets/copy-' + name; } }; folder.files.push(f); return f; } }),
    getStorageUsed: () => 3e9, getStorageLimit: () => 15e9,
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: (() => { const store = {}; const c = { get: (k) => store[k] ?? null, put: (k, v) => { store[k] = v; } }; return { getScriptCache: () => c }; })(),
  ContentService: { createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Utilities: { newBlob: (bytes, type, name) => ({ bytes, type, name }), base64Decode: (s) => Buffer.from(s, 'base64'), formatDate: (d, tz, f) => d.toLocaleDateString('en-GB') },
  Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
  UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify({ daily: { weather_code: [3, 3, 3], temperature_2m_max: [36, 20, 20], temperature_2m_min: [12, 8, 12], precipitation_sum: [0, 5, 0], precipitation_probability_max: [0, 60, 0], wind_speed_10m_max: [10, 50, 10], relative_humidity_2m_max: [90, 90, 90], relative_humidity_2m_min: [40, 60, 60] } }) }) },
  MailApp: { sent: [], sendEmail(m) { this.sent.push(m); } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased() { return this; }, everyDays() { return this; }, atHour() { return this; }, create() {} }) },
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script', 'Code.gs'), 'utf8'), sandbox);

const call = (req) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(req) } }).text);
const W = 'abc123', M = 'mgr987';

// auth
assert.strictEqual(call({ action: 'bootstrap', code: 'nope' }).error, 'קוד שגוי');
assert.strictEqual(call({ action: 'dashboard', code: W }).error, 'נדרש קוד מנהל');
const boot = call({ action: 'bootstrap', code: W });
assert.strictEqual(boot.role, 'worker');
assert.deepStrictEqual(boot.data.greenhouses.map((g) => g.id), ['GH1', 'GH2'], 'inactive greenhouse hidden');
assert.deepStrictEqual(boot.data.workers, ['דנה']);
assert.strictEqual(boot.data.works[1].location, 'מחסן');

// check in / out with a photo; unit comes from the work
const t0 = new Date(2026, 10, 7, 22, 30).getTime();
let r = call({ action: 'checkIn', code: W, id: 'L-1', worker: 'דנה', gh: 'GH1', work: 'W01', ts: t0 });
assert.ok(r.ok, r.error);
const log = main.getSheetByName('יומן עבודה');
const col = (n) => headers['יומן עבודה'].indexOf(n);
let row = log.rows[log.rows.length - 1];
assert.strictEqual(row[col('חממה')], 'חממה 1');
assert.strictEqual(row[col('עבודה')], 'האבקה ידנית');
assert.strictEqual(row[col('יחידה')], 'פרחים');
assert.strictEqual(row[col('סטטוס')], 'פתוח');
assert.ok(row[col('כניסה')]  && Object.prototype.toString.call(row[col('כניסה')]) === '[object Date]');
assert.match(log.formulas['J' + log.rows.length], /ROUND\(\(I\d+-H\d+\)\*24,2\)/, 'hours formula without MOD');
assert.strictEqual(call({ action: 'checkIn', code: W, id: 'L-1', worker: 'דנה', gh: 'GH1', work: 'W01', ts: t0 }).data.duplicate, true, 'idempotent');

const png = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');
r = call({ action: 'checkOut', code: W, id: 'L-1', ts: t0 + 2 * 3600000, qty: '42', notes: '=HYPERLINK("x")', photo: png });
assert.ok(r.ok, r.error);
row = log.rows[log.rows.length - 1];
assert.strictEqual(row[col('כמות')], 42);
assert.strictEqual(row[col('הערות')], "'=HYPERLINK(\"x\")", 'formula injection neutralised');
assert.match(row[col('תמונה')], /drive\.google\.com\/file\/d\/file-0/);
assert.strictEqual(row[col('סטטוס')], 'סגור');
assert.strictEqual(drive.folders.length, 1, 'photo folder created once');
assert.strictEqual(main.getSheetByName('הגדרות').rows[3][1], 'folder-0', 'folder id written back to settings');
assert.strictEqual(call({ action: 'checkOut', code: W, id: 'L-1', ts: t0 }).data.duplicate, true);
assert.match(call({ action: 'checkOut', code: W, id: 'L-9', ts: t0 }).error, /לא נמצאה/);

// photos are manager-only: a set per greenhouse and date, one photo per request
assert.strictEqual(call({ action: 'photoSet', code: W, id: 'P-1', gh: 'GH1', date: t0 }).error, 'נדרש קוד מנהל');
assert.strictEqual(call({ action: 'photo', code: W, id: 'P-1', idx: 0, photo: png }).error, 'נדרש קוד מנהל');
r = call({ action: 'photoSet', code: M, id: 'P-1', gh: 'GH1', date: t0, note: 'פריחה', by: 'מנהל' });
assert.ok(r.ok, r.error);
for (let i = 0; i < 3; i++) assert.ok(call({ action: 'photo', code: M, id: 'P-1', idx: i, photo: png }).ok);
const ph = main.getSheetByName('תמונות');
const pcol = (n) => headers['תמונות'].indexOf(n);
assert.strictEqual(ph.rows[1][pcol('חממה')], 'חממה 1');
assert.strictEqual(ph.rows[1][pcol('תמונה')].split('\n').length, 3);
assert.match(call({ action: 'photo', code: M, id: 'P-404', idx: 0, photo: png }).error, /לא נמצאה/);
assert.match(call({ action: 'photo', code: M, id: 'P-1', idx: 3, photo: 'garbage' }).error, /לא תקינה/);

// future tasks: manager adds, anyone marks done; bootstrap carries open ones
assert.strictEqual(call({ action: 'taskAdd', code: W, id: 'T-1', gh: 'GH1', text: 'x', due: t0 }).error, 'נדרש קוד מנהל');
r = call({ action: 'taskAdd', code: M, id: 'T-1', gh: 'GH2', work: 'W01', text: 'האבקה', due: t0 + 86400000, worker: 'דנה' });
assert.ok(r.ok, r.error);
assert.match(call({ action: 'taskAdd', code: M, id: 'T-2', gh: 'GH2', text: ' ', due: t0 }).error, /חסר/);
const tk = main.getSheetByName('משימות');
const tcol = (n) => headers['משימות'].indexOf(n);
assert.strictEqual(tk.rows[1][tcol('חממה')], 'חממה 2');
assert.strictEqual(call({ action: 'bootstrap', code: W }).data.tasks.length, 1);
assert.ok(call({ action: 'taskDone', code: W, id: 'T-1', by: 'דנה' }).ok);
assert.strictEqual(tk.rows[1][tcol('סטטוס')], 'בוצע');
assert.strictEqual(call({ action: 'bootstrap', code: W }).data.tasks.length, 0);

// attendance clock
r = call({ action: 'shiftIn', code: W, id: 'S-1', worker: 'דנה', ts: t0 - 3600000 });
assert.ok(r.ok, r.error);
const att = main.getSheetByName('נוכחות');
const acol = (n) => headers['נוכחות'].indexOf(n);
assert.strictEqual(att.rows[1][acol('עובד')], 'דנה');
assert.strictEqual(att.rows[1][acol('סטטוס')], 'פתוח');
assert.match(att.formulas['F2'], /ROUND\(\(E2-D2\)\*24,2\)/);
assert.strictEqual(call({ action: 'shiftIn', code: W, id: 'S-1', worker: 'דנה', ts: t0 }).data.duplicate, true);
r = call({ action: 'shiftOut', code: W, id: 'S-1', ts: t0 + 8 * 3600000 });
assert.ok(r.ok, r.error);
assert.strictEqual(att.rows[1][acol('סטטוס')], 'סגור');
assert.match(call({ action: 'shiftOut', code: W, id: 'S-x', ts: t0 }).error, /לא נמצאה/);

// warehouse work
r = call({ action: 'checkIn', code: W, id: 'L-2', worker: 'דנה', gh: 'מחסן', work: 'W12', ts: t0 });
assert.ok(r.ok, r.error);
assert.strictEqual(log.rows[log.rows.length - 1][col('חממה')], 'מחסן');

// issue + resolve
r = call({ action: 'issue', code: W, id: 'B-1', ts: t0, gh: 'GH2', worker: 'דנה', category: 'מזיקים', severity: 'גבוהה', desc: '-אקריות', photo: png });
assert.ok(r.ok, r.error);
const issues = main.getSheetByName('בעיות');
const icol = (n) => headers['בעיות'].indexOf(n);
assert.strictEqual(issues.rows[1][icol('חממה')], 'חממה 2');
assert.strictEqual(issues.rows[1][icol('תיאור')], "'-אקריות");
assert.strictEqual(call({ action: 'resolveIssue', code: W, id: 'B-1', status: 'טופל' }).error, 'נדרש קוד מנהל');
r = call({ action: 'resolveIssue', code: M, id: 'B-1', status: 'טופל', by: 'מנהל', solution: 'רוסס' });
assert.ok(r.ok, r.error);
assert.strictEqual(issues.rows[1][icol('סטטוס')], 'טופל');
assert.strictEqual(Object.prototype.toString.call(issues.rows[1][icol('תאריך טיפול')]), '[object Date]');
r = call({ action: 'resolveIssue', code: M, id: 'B-1', status: 'hack' });
assert.strictEqual(issues.rows[1][icol('סטטוס')], 'פתוח', 'unknown status falls back');

// dashboard serialises dates as epoch ms
const d = call({ action: 'dashboard', code: M });
assert.ok(d.ok, d.error);
assert.strictEqual(typeof d.data.log[0]['כניסה'], 'number');
assert.strictEqual(d.data.log.length, 2);
assert.strictEqual(d.data.issues.length, 1);
assert.strictEqual(d.data.attendance.length, 1);
assert.strictEqual(d.data.photos.length, 1);

// report builds a workbook with the three tabs
r = call({ action: 'report', code: M, from: t0 - 86400000, to: t0 + 86400000 });
assert.ok(r.ok, r.error);
assert.match(r.data.url, /sheets\/ss-/);

// backup: dated copy, old copies trashed, owner's own files untouched, second owner added, status reported
put('הגדרות', obj('הגדרות', { 'הגדרה': 'מזהה תיקיית גיבוי ב-Drive', 'ערך': '' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'אימייל בעלים שני', 'ערך': 'second@example.com' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'גיבוי אחרון', 'ערך': '' }));
put('הגדרות', obj('הגדרות', { 'הגדרה': 'ימים לשמירת גיבויים', 'ערך': 30 }));
assert.strictEqual(call({ action: 'backup', code: W }).error, 'נדרש קוד מנהל');
r = call({ action: 'backup', code: M });
assert.ok(r.ok, r.error);
const bfolder = drive.folders.find((f) => f.name === 'חממות וניל - גיבויים');
assert.ok(bfolder && bfolder.files.length === 1, 'backup copy in its folder');
const oldCopy = bfolder.files[0]; oldCopy.created = new Date(Date.now() - 40 * 86400000);
const mine = { name: 'קובץ שלי', created: new Date(0), trashed: false, getName() { return this.name; }, getDateCreated() { return this.created; }, setTrashed(v) { this.trashed = v; } };
bfolder.files.push(mine);
r = call({ action: 'backup', code: M });
assert.ok(r.ok, r.error);
assert.strictEqual(oldCopy.trashed, true, 'copy older than 30 days trashed');
assert.strictEqual(mine.trashed, false, "owner's own file untouched");
assert.strictEqual(r.data.removed, 1);
assert.ok(drive.editors.some(([, e]) => e === 'second@example.com'), 'second owner added');
const sys = call({ action: 'dashboard', code: M }).data.system;
assert.ok(sys.lastBackup > Date.now() - 60000 && sys.secondOwner && sys.driveLimit === 15e9);

// rate limit after 20 bad codes
for (let i = 0; i < 20; i++) call({ action: 'bootstrap', code: 'bad' + i });
assert.match(call({ action: 'bootstrap', code: W }).error, /יותר מדי/);

// weather digest: climate row + email with alerts
sandbox.weatherDigest();
const wx = main.getSheetByName('מזג אוויר');
assert.ok(wx, 'weather tab exists in workbook');
assert.strictEqual(wx.rows.length, 2);
assert.strictEqual(sandbox.MailApp.sent.length, 1);
assert.match(sandbox.MailApp.sent[0].body, /חום של 36/);
assert.match(sandbox.MailApp.sent[0].body, /לילה קר \(8/);
sandbox.weatherDigest();
assert.strictEqual(wx.rows.length, 2, 'one climate row per day');

console.log('gas harness ok');
