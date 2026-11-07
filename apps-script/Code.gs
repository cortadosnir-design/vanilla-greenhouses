/**
 * מעקב חממות וניל — שרת (Google Apps Script, צמוד לגיליון).
 * האתר ב-GitHub Pages שולח POST עם JSON: { action, code, ...payload } ומקבל { ok, role, data } או { ok:false, error }.
 * עמודות נקראות לפי שם הכותרת, כך שאפשר לשנות סדר עמודות בגיליון בלי לשבור את הקוד.
 */

const SHEETS = {
  greenhouses: 'חממות',
  works: 'עבודות',
  workers: 'עובדים',
  log: 'יומן עבודה',
  attendance: 'נוכחות',
  photos: 'תמונות',
  tasks: 'משימות',
  issues: 'בעיות',
  settings: 'הגדרות',
};
const SETTING = {
  workerCode: 'קוד עובדים',
  managerCode: 'קוד מנהל',
  photoFolder: 'מזהה תיקיית תמונות ב-Drive',
  digestEmail: 'אימייל לעדכון יומי',
};
const MANAGER_ONLY = ['dashboard', 'resolveIssue', 'report', 'photoSet', 'photo', 'taskAdd'];

/** להריץ פעם אחת מהעורך כדי לאשר הרשאות גיליון ו-Drive (זה מה שחסר בגרסה הקודמת). */
function authorize() {
  SpreadsheetApp.getActive().getName();
  DriveApp.getRootFolder().getName();
}

function doGet() {
  return json({ ok: true, app: 'vanilla-greenhouses' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const role = roleFor(req.code);
    if (!role) return json({ ok: false, error: 'קוד שגוי' });
    if (MANAGER_ONLY.indexOf(req.action) >= 0 && role !== 'manager') return json({ ok: false, error: 'נדרש קוד מנהל' });
    const fn = ACTIONS[req.action];
    if (!fn) return json({ ok: false, error: 'פעולה לא מוכרת: ' + req.action });
    return json({ ok: true, role: role, data: fn(req) });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

const ACTIONS = {
  bootstrap: function () {
    return {
      greenhouses: readTable(SHEETS.greenhouses).rows.filter(isActive).map(ghOut),
      works: readTable(SHEETS.works).rows.map(workOut),
      workers: readTable(SHEETS.workers).rows.filter(isActive).map(function (r) { return String(r['שם']); }),
      tasks: readTable(SHEETS.tasks).rows.filter(function (r) { return r['סטטוס'] !== 'בוצע'; }).map(plain),
    };
  },

  taskAdd: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.tasks);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      if (!String(req.text || '').trim()) throw new Error('חסר תיאור משימה');
      const gh = greenhouse(req.gh);
      const row = appendObj(t, { 'מזהה': req.id, 'תאריך ביצוע': new Date(req.due), 'חממה': gh ? gh.name : text(req.gh), 'משימה': text(req.text), 'קוד עבודה': text(req.work), 'עובד': text(req.worker), 'סטטוס': 'פתוח', 'נוצר': new Date() });
      t.sh.getRange(row, col(t, 'תאריך ביצוע')).setNumberFormat('dd/mm/yyyy');
      t.sh.getRange(row, col(t, 'נוצר')).setNumberFormat('dd/mm/yyyy hh:mm');
      return { id: req.id };
    });
  },

  taskDone: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.tasks);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit) throw new Error('המשימה לא נמצאה');
      setCells(t, hit._row, { 'סטטוס': 'בוצע', 'בוצע': new Date(), 'בוצע ע"י': text(req.by) });
      t.sh.getRange(hit._row, col(t, 'בוצע')).setNumberFormat('dd/mm/yyyy hh:mm');
      return { id: req.id };
    });
  },

  checkIn: function (req) {
    return withLock(function () {
      const log = readTable(SHEETS.log);
      if (findBy(log, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const gh = greenhouse(req.gh);
      const work = workByCode(req.work);
      const start = new Date(req.ts);
      const row = appendObj(log, {
        'מזהה': req.id,
        'תאריך': dayOf(start),
        'עובד': text(req.worker),
        'חממה': gh ? gh.name : text(req.gh),
        'קוד עבודה': work ? work.code : req.work,
        'עבודה': work ? work.name : '',
        'קטגוריה': work ? work.category : '',
        'כניסה': start,
        'יחידה': work ? work.unit : '',
        'סטטוס': 'פתוח',
        'עודכן': new Date(),
      });
      formatLogRow(log, row);
      return { id: req.id, row: row };
    });
  },

  checkOut: function (req) {
    const photo = savePhoto(req.photo, req.id); // Drive upload stays outside the lock
    return withLock(function () {
      const log = readTable(SHEETS.log);
      const hit = findBy(log, 'מזהה', req.id);
      if (!hit) throw new Error('לא נמצאה כניסה פתוחה (' + req.id + ')');
      if (hit['סטטוס'] === 'סגור') return { id: req.id, duplicate: true };
      setCells(log, hit._row, {
        'יציאה': new Date(req.ts),
        'כמות': req.qty === '' || req.qty == null || isNaN(Number(req.qty)) ? '' : Number(req.qty),
        'הערות': text(req.notes),
        'תמונה': photo,
        'סטטוס': 'סגור',
        'עודכן': new Date(),
      });
      return { id: req.id };
    });
  },

  shiftIn: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.attendance);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const start = new Date(req.ts);
      const row = appendObj(t, { 'מזהה': req.id, 'תאריך': dayOf(start), 'עובד': text(req.worker), 'כניסה': start, 'סטטוס': 'פתוח' });
      formatTimeRow(t, row);
      return { id: req.id };
    });
  },

  shiftOut: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.attendance);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit) throw new Error('לא נמצאה כניסה לעבודה (' + req.id + ')');
      if (hit['סטטוס'] === 'סגור') return { id: req.id, duplicate: true };
      setCells(t, hit._row, { 'יציאה': new Date(req.ts), 'סטטוס': 'סגור' });
      return { id: req.id };
    });
  },

  /** The manager opens a photo set for a greenhouse and date; the photos follow one per request. */
  photoSet: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.photos);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const gh = greenhouse(req.gh);
      const row = appendObj(t, { 'מזהה': req.id, 'תאריך': new Date(req.date), 'חממה': gh ? gh.name : text(req.gh), 'הערה': text(req.note), 'הועלה ע"י': text(req.by) });
      t.sh.getRange(row, col(t, 'תאריך')).setNumberFormat('dd/mm/yyyy');
      return { id: req.id };
    });
  },

  /** One photo per request (up to 20 per set), appended to the row's תמונה cell. */
  photo: function (req) {
    const url = savePhoto(req.photo, req.id + '-' + (req.idx || 0));
    if (!url) throw new Error('תמונה לא תקינה');
    return withLock(function () {
      const kind = String(req.id).charAt(0);
      const t = readTable(kind === 'P' ? SHEETS.photos : kind === 'B' ? SHEETS.issues : SHEETS.log);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit) throw new Error('לא נמצאה רשומה (' + req.id + ')');
      const cur = String(hit['תמונה'] || '');
      if (cur.indexOf(url) < 0) t.sh.getRange(hit._row, col(t, 'תמונה')).setValue(cur ? cur + '\n' + url : url);
      return { id: req.id, idx: req.idx, url: url };
    });
  },

  issue: function (req) {
    const photo = savePhoto(req.photo, req.id);
    return withLock(function () {
      const t = readTable(SHEETS.issues);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const gh = greenhouse(req.gh);
      const row = appendObj(t, {
        'מזהה': req.id,
        'תאריך': new Date(req.ts),
        'חממה': gh ? gh.name : req.gh,
        'מדווח': text(req.worker),
        'קטגוריה': text(req.category),
        'חומרה': text(req.severity),
        'תיאור': text(req.desc),
        'תמונה': photo,
        'סטטוס': 'פתוח',
      });
      t.sh.getRange(row, col(t, 'תאריך')).setNumberFormat('dd/mm/yyyy');
      return { id: req.id };
    });
  },

  dashboard: function () {
    return {
      greenhouses: readTable(SHEETS.greenhouses).rows.filter(isActive).map(ghOut),
      works: readTable(SHEETS.works).rows.map(workOut),
      workers: readTable(SHEETS.workers).rows.filter(isActive).map(function (r) { return String(r['שם']); }),
      log: readTable(SHEETS.log).rows.map(plain),
      issues: readTable(SHEETS.issues).rows.map(plain),
      attendance: readTable(SHEETS.attendance).rows.map(plain),
      photos: readTable(SHEETS.photos).rows.map(plain),
      tasks: readTable(SHEETS.tasks).rows.map(plain),
    };
  },

  resolveIssue: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.issues);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit) throw new Error('הבעיה לא נמצאה');
      setCells(t, hit._row, {
        'סטטוס': ['פתוח', 'בטיפול', 'טופל'].indexOf(req.status) >= 0 ? req.status : 'פתוח',
        'תאריך טיפול': req.status === 'טופל' ? new Date() : '',
        'טופל ע"י': text(req.by),
        'פתרון': text(req.solution),
      });
      t.sh.getRange(hit._row, col(t, 'תאריך טיפול')).setNumberFormat('dd/mm/yyyy');
      return { id: req.id };
    });
  },

  /** יוצר קובץ Google Sheets חדש עם דוח לטווח תאריכים ומחזיר קישור. */
  report: function (req) {
    const from = req.from ? new Date(req.from) : new Date(0);
    const to = req.to ? new Date(req.to) : new Date();
    const inRange = function (d) { return d instanceof Date && d >= from && d <= to; };
    const tz = Session.getScriptTimeZone();
    const fmt = function (d) { return Utilities.formatDate(d, tz, 'dd/MM/yyyy'); };

    const ghs = readTable(SHEETS.greenhouses).rows.filter(isActive).map(ghOut);
    const log = readTable(SHEETS.log).rows.filter(function (r) { return inRange(r['תאריך']); });
    const issues = readTable(SHEETS.issues).rows.filter(function (r) { return inRange(r['תאריך']); });
    const sum = function (rows, key) { return rows.reduce(function (a, r) { return a + (Number(r[key]) || 0); }, 0); };

    const title = 'דוח חממות וניל ' + fmt(from.getTime() ? from : firstDate(log)) + ' - ' + fmt(to);
    const book = SpreadsheetApp.create(title);
    moveNextToMain(book);
    try { DriveApp.getFileById(book.getId()).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* domain policy */ }

    const summary = book.getSheets()[0].setName('סיכום');
    const sumRows = ghs.map(function (g) {
      const mine = log.filter(function (r) { return r['חממה'] === g.name; });
      return [
        g.name,
        round(sum(mine, 'שעות')),
        mine.length,
        sum(mine.filter(function (r) { return r['קוד עבודה'] === 'W01'; }), 'כמות'),
        sum(mine.filter(function (r) { return r['קוד עבודה'] === 'W11'; }), 'כמות'),
        issues.filter(function (r) { return r['חממה'] === g.name && r['סטטוס'] !== 'טופל'; }).length,
      ];
    });
    writeSheet(summary, ['חממה', 'שעות עבודה', 'ביקורים', 'פרחים שהואבקו', 'תרמילים שנקטפו', 'בעיות פתוחות'], sumRows);
    const workers = {};
    log.forEach(function (r) { workers[r['עובד']] = (workers[r['עובד']] || 0) + (Number(r['שעות']) || 0); });
    const wRows = Object.keys(workers).map(function (k) { return [k, round(workers[k])]; });
    const wStart = sumRows.length + 3;
    summary.getRange(wStart, 1, 1, 2).setValues([['עובד', 'שעות עבודה']]);
    styleHeader(summary.getRange(wStart, 1, 1, 2));
    if (wRows.length) summary.getRange(wStart + 1, 1, wRows.length, 2).setValues(wRows);

    const logCols = ['תאריך', 'עובד', 'חממה', 'קוד עבודה', 'עבודה', 'קטגוריה', 'כניסה', 'יציאה', 'שעות', 'כמות', 'יחידה', 'הערות', 'תמונה'];
    const logSheet = writeSheet(book.insertSheet('יומן עבודה'), logCols, log.map(function (r) { return logCols.map(function (c) { return r[c]; }); }));
    numberFormats(logSheet, logCols, log.length, { 'תאריך': 'dd/mm/yyyy', 'כניסה': 'hh:mm', 'יציאה': 'hh:mm', 'שעות': '0.00' });

    const attCols = ['תאריך', 'עובד', 'כניסה', 'יציאה', 'שעות'];
    const att = readTable(SHEETS.attendance).rows.filter(function (r) { return inRange(r['תאריך']); });
    const attSheet = writeSheet(book.insertSheet('נוכחות'), attCols, att.map(function (r) { return attCols.map(function (c) { return r[c]; }); }));
    numberFormats(attSheet, attCols, att.length, { 'תאריך': 'dd/mm/yyyy', 'כניסה': 'hh:mm', 'יציאה': 'hh:mm', 'שעות': '0.00' });

    const issueCols = ['תאריך', 'חממה', 'מדווח', 'קטגוריה', 'חומרה', 'תיאור', 'סטטוס', 'תאריך טיפול', 'טופל ע"י', 'פתרון', 'תמונה'];
    const issueSheet = writeSheet(book.insertSheet('בעיות'), issueCols, issues.map(function (r) { return issueCols.map(function (c) { return r[c]; }); }));
    numberFormats(issueSheet, issueCols, issues.length, { 'תאריך': 'dd/mm/yyyy', 'תאריך טיפול': 'dd/mm/yyyy' });

    return { url: book.getUrl(), title: title };
  },
};

// ---------- sheet helpers ----------

function ss() { return SpreadsheetApp.getActive(); }

function readTable(name) {
  const sh = ss().getSheetByName(name);
  if (!sh) throw new Error('חסרה לשונית: ' + name);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i].every(function (c) { return c === '' || c === null; })) continue;
    const o = { _row: i + 1 };
    head.forEach(function (h, j) { if (h) o[h] = values[i][j]; });
    rows.push(o);
  }
  return { sh: sh, head: head, rows: rows };
}

function col(t, name) {
  const i = t.head.indexOf(name);
  if (i < 0) throw new Error('חסרה עמודה "' + name + '" בלשונית ' + t.sh.getName());
  return i + 1;
}

function appendObj(t, obj) {
  t.sh.appendRow(t.head.map(function (h) { return h in obj ? obj[h] : ''; }));
  return t.sh.getLastRow();
}

function setCells(t, row, obj) {
  Object.keys(obj).forEach(function (k) { t.sh.getRange(row, col(t, k)).setValue(obj[k]); });
}

function findBy(t, key, value) {
  for (let i = 0; i < t.rows.length; i++) if (String(t.rows[i][key]) === String(value)) return t.rows[i];
  return null;
}

function formatLogRow(t, row) {
  const c = function (n) { return t.sh.getRange(row, col(t, n)); };
  c('תאריך').setNumberFormat('dd/mm/yyyy');
  c('כניסה').setNumberFormat('hh:mm');
  c('יציאה').setNumberFormat('hh:mm');
  c('עודכן').setNumberFormat('dd/mm/yyyy hh:mm');
  const inA1 = c('כניסה').getA1Notation();
  const outA1 = c('יציאה').getA1Notation();
  // both cells hold full date-times, so a shift across midnight or a check-out the next day is still right
  c('שעות').setFormula('=IF(OR(' + inA1 + '="",' + outA1 + '=""),"",ROUND((' + outA1 + '-' + inA1 + ')*24,2))').setNumberFormat('0.00');
}

function formatTimeRow(t, row) {
  const c = function (n) { return t.sh.getRange(row, col(t, n)); };
  c('תאריך').setNumberFormat('dd/mm/yyyy');
  c('כניסה').setNumberFormat('hh:mm');
  c('יציאה').setNumberFormat('hh:mm');
  const inA1 = c('כניסה').getA1Notation(), outA1 = c('יציאה').getA1Notation();
  c('שעות').setFormula('=IF(OR(' + inA1 + '="",' + outA1 + '=""),"",ROUND((' + outA1 + '-' + inA1 + ')*24,2))').setNumberFormat('0.00');
}

function writeSheet(sh, headers, rows) {
  sh.setRightToLeft(true);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader(sh.getRange(1, 1, 1, headers.length));
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, rows.length + 1, headers.length).setFontFamily('Arial').setHorizontalAlignment('right')
    .applyRowBanding(SpreadsheetApp.BandingTheme.GREEN, true, false);
  sh.autoResizeColumns(1, headers.length);
  return sh;
}

function styleHeader(range) {
  range.setFontWeight('bold').setFontColor('#ffffff').setBackground('#2E6B4F').setHorizontalAlignment('center');
}

function numberFormats(sh, cols, n, formats) {
  if (!n) return;
  Object.keys(formats).forEach(function (k) {
    const i = cols.indexOf(k);
    if (i >= 0) sh.getRange(2, i + 1, n, 1).setNumberFormat(formats[k]);
  });
}

function moveNextToMain(book) {
  const parents = DriveApp.getFileById(ss().getId()).getParents();
  if (parents.hasNext()) DriveApp.getFileById(book.getId()).moveTo(parents.next());
}

// ---------- domain helpers ----------

function isActive(r) { return String(r['פעילה'] || r['פעיל'] || 'כן').trim() !== 'לא'; }

function ghOut(r) { return { id: String(r['מזהה']), name: String(r['שם']) }; }

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

function greenhouse(id) {
  return readTable(SHEETS.greenhouses).rows.map(ghOut).filter(function (g) { return g.id === id || g.name === id; })[0] || null;
}

function workByCode(code) {
  return readTable(SHEETS.works).rows.map(workOut).filter(function (w) { return w.code === code; })[0] || null;
}

function plain(r) {
  const o = {};
  Object.keys(r).forEach(function (k) { if (k !== '_row') o[k] = r[k] instanceof Date ? r[k].getTime() : r[k]; });
  return o;
}

function settings() {
  const t = readTable(SHEETS.settings);
  const m = {};
  t.rows.forEach(function (r) { m[String(r['הגדרה'])] = { value: String(r['ערך']).trim(), row: r._row }; });
  return m;
}

function roleFor(code) {
  if (code == null || String(code).trim() === '') return null;
  const cache = CacheService.getScriptCache();
  if (Number(cache.get('badCodes') || 0) >= 20) throw new Error('יותר מדי ניסיונות. נסו שוב בעוד כמה דקות');
  const s = settings();
  const c = String(code).trim();
  if (s[SETTING.managerCode] && c === s[SETTING.managerCode].value) return 'manager';
  if (s[SETTING.workerCode] && c === s[SETTING.workerCode].value) return 'worker';
  cache.put('badCodes', String(Number(cache.get('badCodes') || 0) + 1), 600);
  return null;
}

/** Free text from the phone: never let a cell start with a formula character. */
function text(v) {
  const t = v == null ? '' : String(v).trim();
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function savePhoto(dataUrl, name) {
  if (!dataUrl) return '';
  const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return '';
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + '.jpg');
  const file = photoFolder().createFile(blob);
  try {
    // the dashboard shows thumbnails, which needs view-by-link
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* domain policy may forbid link sharing; the file is still saved */ }
  return file.getUrl();
}

function photoFolder() {
  const s = settings();
  const entry = s[SETTING.photoFolder];
  if (entry && entry.value) return DriveApp.getFolderById(entry.value);
  const folder = DriveApp.createFolder('חממות וניל - תמונות');
  if (entry) ss().getSheetByName(SHEETS.settings).getRange(entry.row, 2).setValue(folder.getId());
  return folder;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- weather: daily email digest and a climate log, free via Open-Meteo (ECMWF model) ----------

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=33.2375&longitude=35.6697&models=ecmwf_ifs025&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,relative_humidity_2m_max,relative_humidity_2m_min&timezone=Asia%2FJerusalem&forecast_days=3';

/** להריץ פעם אחת מהעורך: מתקין טריגר יומי ב-06:00 לעדכון מזג האוויר. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'weatherDigest') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weatherDigest').timeBased().everyDays(1).atHour(6).create();
}

function weatherDigest() {
  const w = JSON.parse(UrlFetchApp.fetch(WEATHER_URL).getContentText()).daily;
  if (!w) return;
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy');

  // climate log row (one per day) so weather sits next to the work log for later analysis
  const sh = ss().getSheetByName('מזג אוויר');
  if (sh) {
    const last = sh.getLastRow() > 1 ? sh.getRange(sh.getLastRow(), 1).getDisplayValue() : '';
    if (last !== today) {
      sh.appendRow([new Date(), w.temperature_2m_max[0], w.temperature_2m_min[0], w.relative_humidity_2m_max[0], w.relative_humidity_2m_min[0], w.precipitation_sum[0], w.wind_speed_10m_max[0]]);
      sh.getRange(sh.getLastRow(), 1).setNumberFormat('dd/mm/yyyy');
    }
  }

  const lines = [];
  for (let i = 0; i < 3; i++) {
    const when = i === 0 ? 'היום' : i === 1 ? 'מחר' : 'מחרתיים';
    lines.push(when + ': ' + Math.round(w.temperature_2m_min[i]) + '° עד ' + Math.round(w.temperature_2m_max[i]) + '°, לחות ' + w.relative_humidity_2m_min[i] + '-' + w.relative_humidity_2m_max[i] + '%' +
      (w.precipitation_sum[i] >= 1 ? ', גשם ' + Math.round(w.precipitation_sum[i]) + ' מ"מ (' + w.precipitation_probability_max[i] + '%)' : '') +
      (w.wind_speed_10m_max[i] >= 30 ? ', רוח עד ' + Math.round(w.wind_speed_10m_max[i]) + ' קמ"ש' : ''));
  }
  const alerts = [];
  for (let i = 0; i < 3; i++) {
    const when = i === 0 ? 'היום' : i === 1 ? 'מחר' : 'מחרתיים';
    if (w.temperature_2m_max[i] >= 35) alerts.push(when + ' חום של ' + Math.round(w.temperature_2m_max[i]) + '°. לבדוק קירור וערפול.');
    if (w.temperature_2m_min[i] <= 10) alerts.push(when + ' לילה קר (' + Math.round(w.temperature_2m_min[i]) + '°). לבדוק חימום.');
    if (w.wind_speed_10m_max[i] >= 45) alerts.push(when + ' רוח חזקה. לבדוק יריעות ורשתות.');
  }
  const openIssues = readTable(SHEETS.issues).rows.filter(function (r) { return r['סטטוס'] !== 'טופל'; });

  const email = (settings()[SETTING.digestEmail] || {}).value;
  if (!email) return;
  const body = ['מזג אוויר בשניר, ' + today, '', lines.join('\n'), '',
    alerts.length ? 'שימו לב:\n' + alerts.join('\n') : 'אין אזהרות.', '',
    'בעיות פתוחות: ' + openIssues.length, '', (settings()['כתובת האתר'] || {}).value || ''].join('\n');
  MailApp.sendEmail({ to: email, subject: (alerts.length ? '⚠️ ' : '') + 'חממות וניל: מזג אוויר ' + today, body: body });
}

function dayOf(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function round(n) { return Math.round(n * 100) / 100; }

function firstDate(rows) {
  const ds = rows.map(function (r) { return r['תאריך']; }).filter(function (d) { return d instanceof Date; });
  return ds.length ? new Date(Math.min.apply(null, ds)) : new Date();
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
