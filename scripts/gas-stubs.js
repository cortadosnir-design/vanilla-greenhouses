// In-memory stand-ins for the Apps Script services Code.gs uses. Shared by gas-harness.js and gas-legacy.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function load(main) {
  const drive = { files: [], folders: [], editors: [] };
  const sandbox = {
    PropertiesService: (() => { const p = {}; const o = { getProperty: (k) => p[k] ?? null, setProperty: (k, v) => { p[k] = v; } }; return { getScriptProperties: () => o }; })(),
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
    Utilities: { newBlob: (bytes, type, name) => ({ bytes, type, name }), base64Decode: (s) => Buffer.from(s, 'base64'), formatDate: (d, tz, f) => d.toLocaleDateString('en-GB'),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => require('crypto').randomUUID(), sleep: () => {},
      computeDigest: (alg, s) => Array.from(require('crypto').createHash(alg).update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64') },
    Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
    UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify({ daily: { weather_code: [3, 3, 3], temperature_2m_max: [36, 20, 20], temperature_2m_min: [12, 8, 12], precipitation_sum: [0, 5, 0], precipitation_probability_max: [0, 60, 0], wind_speed_10m_max: [10, 50, 10], relative_humidity_2m_max: [90, 90, 90], relative_humidity_2m_min: [40, 60, 60] } }) }) },
    MailApp: { sent: [], sendEmail(m) { this.sent.push(m); } },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased() { return this; }, everyDays() { return this; }, atHour() { return this; }, create() {} }) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox);

  const call = (req) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(req) } }).text);
  return { sandbox, drive, call };
}

module.exports = { Range, Sheet, Spreadsheet, load };
