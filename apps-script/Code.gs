/**
 * מעקב חממות וניל — שרת (Google Apps Script, צמוד לגיליון).
 * האתר ב-GitHub Pages שולח POST עם JSON: { action, code, ...payload } ומקבל { ok, role, data } או { ok:false, error }.
 * עמודות נקראות לפי שם הכותרת, כך שאפשר לשנות סדר עמודות בגיליון בלי לשבור את הקוד.
 */

// Only the farm's existing tabs are used (nothing is created or deleted):
//   Master Data = greenhouses (one per column) · Work = the work catalogue · Log data = every daily action
//   (work in a greenhouse, start/end of the work day, problem reports, photos) · Calendar = planned works
//   Code = settings (key in column A, value in column B) · Barcode = QR links per greenhouse
const SHEETS = { greenhouses: 'greenhouses', works: 'works', log: 'log', tasks: 'tasks', settings: 'settings', barcode: 'barcode' };
const SHEET_NAMES = {
  greenhouses: ['Master Data'], works: ['Work'], log: ['Log data'], tasks: ['Calendar'], settings: ['Code'], barcode: ['Barcode'],
};
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
// Columns the app needs on top of the farm's own (added after the last titled column; existing data untouched).
const EXTRA_COLUMNS = {
  works: ['כל כמה ימים', 'יחידת כמות', 'מיקום', 'מעקב תדירות'],
  log: ['סטטוס', 'מזהה', 'קוד עבודה', 'יחידה', 'חומרה', 'פתרון'],
};
const CALENDAR_HEAD = ['מזהה', 'תאריך ביצוע', 'חממה', 'משימה', 'קוד עבודה', 'עובד', 'סטטוס', 'נוצר', 'בוצע', 'בוצע ע"י'];
// "קוד עבודה" values of Log data rows that are not greenhouse work.
const KIND = { shift: 'SHIFT', issue: 'ISSUE', photo: 'PHOTO' };
// Defaults written once into the new Work columns: [every N days, quantity unit, location, show in "due"].
const WORK_DEFAULTS = {
  W01: [1, 'פרחים', 'חממה', 'לא'], W02: ['', 'אשכולות', 'חממה', 'לא'], W03: [7, '', 'חממה', 'כן'], W04: [90, '', 'חממה', 'לא'],
  W05: [180, 'ק"ג', 'חממה', 'כן'], W06: [14, 'ליטר', 'חממה', 'כן'], W07: [7, '', 'חממה', 'כן'], W08: [7, '', 'חממה', 'כן'],
  W09: [7, '', 'חממה', 'כן'], W10: ['', 'ליטר', 'חממה', 'לא'], W11: [2, 'תרמילים', 'חממה', 'לא'], W12: [1, 'ק"ג', 'מחסן', 'לא'],
  W13: ['', 'ק"ג', 'מחסן', 'לא'], W14: [1, '', 'מחסן', 'לא'], W15: [1, '', 'מחסן', 'לא'], W16: [90, '', 'חממה', 'כן'],
};
const SITE_URL = 'https://cortadosnir-design.github.io/vanilla-greenhouses/';
const SETTING_DEFAULTS = [
  ['כתובת האתר', SITE_URL], ['קוד עובדים', ''], ['קוד מנהל', ''], ['עובדים', ''],
  ['מזהה תיקיית תמונות ב-Drive', ''], ['אימייל לעדכון יומי', ''],
  ['מזהה תיקיית גיבוי ב-Drive', ''], ['אימייל בעלים שני', ''], ['גיבוי אחרון', ''], ['ימים לשמירת גיבויים', 30],
];
const SCHEMA_VERSION = '3';
const SETTING = {
  workerCode: 'קוד עובדים',
  managerCode: 'קוד מנהל',
  photoFolder: 'מזהה תיקיית תמונות ב-Drive',
  digestEmail: 'אימייל לעדכון יומי',
  workers: 'עובדים',
  backupFolder: 'מזהה תיקיית גיבוי ב-Drive',
  secondOwner: 'אימייל בעלים שני',
  lastBackup: 'גיבוי אחרון',
  keepDays: 'ימים לשמירת גיבויים',
};
const MANAGER_ONLY = ['dashboard', 'resolveIssue', 'report', 'photoSet', 'photo', 'taskAdd', 'backup'];

/** להריץ פעם אחת מהעורך: מאשר הרשאות גיליון ו-Drive ומוסיף לגיליון את הלשוניות והעמודות שהאפליקציה צריכה. */
function authorize() {
  SpreadsheetApp.getActive().getName();
  DriveApp.getRootFolder().getName();
  setup();
}

/** Adds what the app needs to the farm's file: columns, settings rows, Calendar titles, QR links. Never deletes. Safe to run again. */
function setup() {
  Object.keys(EXTRA_COLUMNS).forEach(function (key) {
    const sh = findSheet(key);
    if (!sh) return;
    const t = readTable(key);
    let last = t.head.length;
    while (last > 0 && !t.head[last - 1]) last--; // a blank title at the end (the old status column) is reused
    EXTRA_COLUMNS[key].forEach(function (name) {
      if (t.head.indexOf(name) >= 0) return;
      last++;
      sh.getRange(1, last, 1, 1).setValue(name);
      styleHeader(sh.getRange(1, last, 1, 1));
    });
  });

  const works = readTable(SHEETS.works);
  works.rows.forEach(function (r) {
    const d = WORK_DEFAULTS[String(r['קוד'])];
    if (!d) return;
    ['כל כמה ימים', 'יחידת כמות', 'מיקום', 'מעקב תדירות'].forEach(function (k, i) {
      if (r[k] === '' || r[k] == null) works.sh.getRange(r._row, col(works, k)).setValue(d[i]);
    });
  });

  const cal = findSheet(SHEETS.tasks);
  if (cal && !String(cal.getRange(1, 1, 1, 1).getValue()).trim()) {
    cal.getRange(1, 1, 1, CALENDAR_HEAD.length).setValues([CALENDAR_HEAD]);
    styleHeader(cal.getRange(1, 1, 1, CALENDAR_HEAD.length));
  }

  const have = settings();
  SETTING_DEFAULTS.forEach(function (d) {
    if (d[0] in have) return;
    // a fresh install gets random codes, never a guessable default
    const v = d[0] === SETTING.workerCode ? randomCode(10) : d[0] === SETTING.managerCode ? randomCode(14) : d[1];
    findSheet(SHEETS.settings).appendRow([d[0], v]);
  });

  const bc = findSheet(SHEETS.barcode);
  if (bc && bc.getLastRow() <= 1 && !String(bc.getRange(1, 1, 1, 1).getValue()).trim()) {
    const rows = [['חממה', 'קישור לדיווח (להפוך ל-QR ולהדביק על הדלת)']].concat(greenhouseList().map(function (g) { return [g.name, SITE_URL + '?gh=' + g.id]; }));
    bc.getRange(1, 1, rows.length, 2).setValues(rows);
    styleHeader(bc.getRange(1, 1, 1, 2));
  }

  PropertiesService.getScriptProperties().setProperty('schema', SCHEMA_VERSION);
}

function doGet() {
  return json({ ok: true, app: 'vanilla-greenhouses' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (PropertiesService.getScriptProperties().getProperty('schema') !== SCHEMA_VERSION) setup();
    const role = roleFor(req.code);
    if (!role) return json({ ok: false, error: 'קוד שגוי' });
    if (req.id != null && !/^[A-Z]-[a-z0-9]{1,24}$/.test(String(req.id))) return json({ ok: false, error: 'מזהה לא תקין' });
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
      greenhouses: greenhouseList(),
      works: readTable(SHEETS.works).rows.map(workOut),
      workers: workerList(),
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
      const start = when(req.ts);
      const row = appendObj(log, {
        'מזהה': req.id,
        'תאריך': dayOf(start),
        'עובד': text(req.worker),
        'חממה': gh ? gh.name : text(req.gh),
        'קוד עבודה': work ? work.code : text(req.work),
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
    return withLock(function () {
      const log = readTable(SHEETS.log);
      const hit = findBy(log, 'מזהה', req.id);
      if (!hit || isSpecial(hit)) throw new Error('לא נמצאה כניסה פתוחה (' + req.id + ')');
      if (hit['סטטוס'] === 'סגור') return { id: req.id, duplicate: true };
      setCells(log, hit._row, {
        'יציאה': exitAfter(hit, req.ts),
        'כמות': req.qty === '' || req.qty == null || !isFinite(Number(req.qty)) ? '' : Number(req.qty),
        'הערות': text(req.notes),
        'סטטוס': 'סגור',
        'עודכן': new Date(),
      });
      return { id: req.id };
    });
  },

  shiftIn: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.log);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const start = when(req.ts);
      const row = appendObj(t, { 'מזהה': req.id, 'תאריך': dayOf(start), 'עובד': text(req.worker), 'עבודה': 'יום עבודה', 'קוד עבודה': KIND.shift, 'כניסה': start, 'סטטוס': 'פתוח' });
      formatLogRow(t, row);
      return { id: req.id };
    });
  },

  shiftOut: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.log);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit || hit['קוד עבודה'] !== KIND.shift) throw new Error('לא נמצאה כניסה לעבודה (' + req.id + ')');
      if (hit['סטטוס'] === 'סגור') return { id: req.id, duplicate: true };
      setCells(t, hit._row, { 'יציאה': exitAfter(hit, req.ts), 'סטטוס': 'סגור' });
      return { id: req.id };
    });
  },

  /** The manager opens a photo set for a greenhouse and date; the photos follow one per request. */
  photoSet: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.log);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const gh = greenhouse(req.gh);
      // the date is when the photos were uploaded
      const row = appendObj(t, { 'מזהה': req.id, 'תאריך': new Date(), 'עובד': text(req.by), 'חממה': gh ? gh.name : text(req.gh),
        'עבודה': 'תמונות', 'קוד עבודה': KIND.photo, 'הערות': text(req.note), 'סטטוס': 'סגור' });
      t.sh.getRange(row, col(t, 'תאריך')).setNumberFormat('dd/mm/yyyy hh:mm');
      return { id: req.id };
    });
  },

  /** One photo per request (up to 20 per set), appended to the row's תמונה cell. */
  photo: function (req) {
    const set = findBy(readTable(SHEETS.log), 'מזהה', req.id);
    if (!set) throw new Error('לא נמצאה רשומה (' + req.id + ')');
    // file name in Drive: greenhouse, upload date and time, number in the set
    const when = isDate(set['תאריך']) ? set['תאריך'] : new Date();
    const name = (set['חממה'] || 'תמונה') + ' ' + Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm') + ' (' + ((Number(req.idx) || 0) + 1) + ')';
    const url = savePhoto(req.photo, name);
    if (!url) throw new Error('תמונה לא תקינה');
    return withLock(function () {
      const t = readTable(SHEETS.log);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit) throw new Error('לא נמצאה רשומה (' + req.id + ')');
      const cur = String(hit['תמונה'] || '');
      if (cur.indexOf(url) < 0) t.sh.getRange(hit._row, col(t, 'תמונה')).setValue(cur ? cur + '\n' + url : url);
      return { id: req.id, idx: req.idx, url: url };
    });
  },

  issue: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.log);
      if (findBy(t, 'מזהה', req.id)) return { id: req.id, duplicate: true };
      const gh = greenhouse(req.gh);
      const row = appendObj(t, {
        'מזהה': req.id,
        'תאריך': when(req.ts),
        'חממה': gh ? gh.name : text(req.gh),
        'עובד': text(req.worker),
        'עבודה': 'דיווח בעיה',
        'קוד עבודה': KIND.issue,
        'פירוט': text(req.category),
        'חומרה': text(req.severity),
        'הערות': text(req.desc),
        'סטטוס': 'פתוח',
      });
      t.sh.getRange(row, col(t, 'תאריך')).setNumberFormat('dd/mm/yyyy');
      return { id: req.id };
    });
  },

  dashboard: function () {
    return {
      greenhouses: greenhouseList(),
      works: readTable(SHEETS.works).rows.map(workOut),
      workers: workerList(),
      log: workRows(readTable(SHEETS.log).rows).map(plain),
      issues: readTable(SHEETS.log).rows.filter(isKind(KIND.issue)).map(issueOut),
      attendance: readTable(SHEETS.log).rows.filter(isKind(KIND.shift)).map(plain),
      tasks: readTable(SHEETS.tasks).rows.map(plain),
      system: systemStatus(),
    };
  },

  backup: function () { return backupNow(); },

  resolveIssue: function (req) {
    return withLock(function () {
      const t = readTable(SHEETS.log);
      const hit = findBy(t, 'מזהה', req.id);
      if (!hit || hit['קוד עבודה'] !== KIND.issue) throw new Error('הבעיה לא נמצאה');
      const status = ['פתוח', 'בטיפול', 'טופל'].indexOf(req.status) >= 0 ? req.status : 'פתוח';
      const by = text(req.by), solution = text(req.solution);
      setCells(t, hit._row, { 'סטטוס': status, 'פתרון': solution ? solution + (by ? ' (' + by + ')' : '') : '' });
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

    const ghs = greenhouseList();
    const all = readTable(SHEETS.log).rows.filter(function (r) { return inRange(r['תאריך']); });
    const log = workRows(all);
    const issues = all.filter(isKind(KIND.issue)).map(issueOut).map(function (r) { r['תאריך'] = new Date(r['תאריך']); return r; });
    const sum = function (rows, key) { return rows.reduce(function (a, r) { return a + (Number(r[key]) || 0); }, 0); };

    const title = 'דוח חממות וניל ' + fmt(from.getTime() ? from : firstDate(log)) + ' - ' + fmt(to);
    const book = SpreadsheetApp.create(title);
    moveNextToMain(book);
    // hours per worker stay private: only the second owner is added, never "anyone with the link"
    const second = (settings()[SETTING.secondOwner] || {}).value;
    if (second) try { DriveApp.getFileById(book.getId()).addViewer(second); } catch (e) { /* bad address */ }

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
    const att = all.filter(isKind(KIND.shift));
    const attSheet = writeSheet(book.insertSheet('נוכחות'), attCols, att.map(function (r) { return attCols.map(function (c) { return r[c]; }); }));
    numberFormats(attSheet, attCols, att.length, { 'תאריך': 'dd/mm/yyyy', 'כניסה': 'hh:mm', 'יציאה': 'hh:mm', 'שעות': '0.00' });

    const issueCols = ['תאריך', 'חממה', 'מדווח', 'קטגוריה', 'חומרה', 'תיאור', 'סטטוס', 'פתרון', 'תמונה'];
    const issueSheet = writeSheet(book.insertSheet('בעיות'), issueCols, issues.map(function (r) { return issueCols.map(function (c) { return r[c]; }); }));
    numberFormats(issueSheet, issueCols, issues.length, { 'תאריך': 'dd/mm/yyyy' });

    return { url: book.getUrl(), title: title };
  },
};

// ---------- sheet helpers ----------

function ss() { return SpreadsheetApp.getActive(); }

function findSheet(key) {
  const names = SHEET_NAMES[key] || [key];
  for (let i = 0; i < names.length; i++) { const sh = ss().getSheetByName(names[i]); if (sh) return sh; }
  return null;
}

function readTable(key) {
  const sh = findSheet(key);
  if (!sh) throw new Error('חסרה לשונית: ' + (SHEET_NAMES[key] || [key])[0]);
  const values = sh.getDataRange().getValues();
  const alias = ALIASES[key] || {};
  const head = values[0].map(function (h) { h = String(h).trim(); return alias[h] || h; });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i].every(function (c) { return c === '' || c === null; })) continue;
    const o = { _row: i + 1 };
    head.forEach(function (h, j) { if (h) o[h] = values[i][j]; });
    rows.push(o);
  }
  return { sh: sh, head: head, rows: rows };
}

function hasCol(t, name) { return t.head.indexOf(name) >= 0; }

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
  Object.keys(obj).forEach(function (k) { if (hasCol(t, k)) t.sh.getRange(row, col(t, k)).setValue(obj[k]); });
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
  if (hasCol(t, 'עודכן')) c('עודכן').setNumberFormat('dd/mm/yyyy hh:mm');
  const inA1 = c('כניסה').getA1Notation();
  const outA1 = c('יציאה').getA1Notation();
  // both cells hold full date-times, so a shift across midnight or a check-out the next day is still right
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

/** Master Data lists one greenhouse per column (row 1 holds the names); a table with one row per greenhouse also works. */
function greenhouseList() {
  const sh = findSheet(SHEETS.greenhouses);
  if (!sh) throw new Error('חסרה לשונית Master Data');
  const values = sh.getDataRange().getValues();
  if (String(values[0][0]).trim() === 'סעיף / מאפיין') {
    return values[0].slice(1).map(function (n, i) { return { id: 'GH' + (i + 1), name: String(n).trim() }; }).filter(function (g) { return g.name; });
  }
  return readTable(SHEETS.greenhouses).rows.filter(isActive).map(ghOut);
}

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
  return greenhouseList().filter(function (g) { return g.id === id || g.name === id; })[0] || null;
}

function isKind(kind) { return function (r) { return r['קוד עבודה'] === kind; }; }

/** Log data rows that are work (and photo sets), without work-day and problem rows. */
function workRows(rows) { return rows.filter(function (r) { return r['קוד עבודה'] !== KIND.shift && r['קוד עבודה'] !== KIND.issue; }); }

function issueOut(r) {
  const o = plain(r);
  return { 'מזהה': o['מזהה'], 'תאריך': o['תאריך'], 'חממה': o['חממה'], 'מדווח': o['עובד'], 'קטגוריה': o['פירוט'], 'חומרה': o['חומרה'],
    'תיאור': o['הערות'], 'תמונה': o['תמונה'], 'סטטוס': o['סטטוס'] || 'פתוח', 'פתרון': o['פתרון'] };
}

/** Names from the "עובדים" row in Code (comma separated); until it is filled, the names already in Log data. */
function workerList() {
  const v = (settings()[SETTING.workers] || {}).value || '';
  const listed = v.split(/[,،\n]/).map(function (x) { return x.trim(); }).filter(String);
  if (listed.length) return listed;
  const seen = {};
  readTable(SHEETS.log).rows.forEach(function (r) { const n = String(r['עובד'] || '').trim(); if (n) seen[n] = true; });
  return Object.keys(seen);
}

function workByCode(code) {
  return readTable(SHEETS.works).rows.map(workOut).filter(function (w) { return w.code === code; })[0] || null;
}

function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

function plain(r) {
  const o = {};
  Object.keys(r).forEach(function (k) {
    if (k === '_row') return;
    const v = r[k];
    if (!isDate(v)) { o[k] = v; return; }
    if (v.getFullYear() > 1900) { o[k] = v.getTime(); return; }
    // a time or duration with no date (rows from the old form): hours as a number, times on the row's date
    const mins = v.getHours() * 60 + v.getMinutes();
    if (k === 'שעות') o[k] = Math.round(mins / 60 * 100) / 100;
    else if (isDate(r['תאריך'])) { const d = new Date(r['תאריך'].getTime()); d.setHours(0, mins, 0, 0); o[k] = d.getTime(); }
    else o[k] = '';
  });
  return o;
}

/** Settings live in the Code tab: the key in column A, the value in column B, one per row. */
function settings() {
  const sh = findSheet(SHEETS.settings);
  if (!sh) throw new Error('חסרה לשונית Code');
  const values = sh.getDataRange().getValues();
  const m = {};
  values.forEach(function (r, i) { const k = String(r[0] || '').trim(); if (k) m[k] = { value: String(r[1] == null ? '' : r[1]).trim(), row: i + 1 }; });
  return m;
}

// The codes never stay readable in the sheet: a code typed into the Code tab is turned into a salted SHA-256 hash
// in Script Properties and the cell is masked. To change a code, type the new one over the mask.
const CODE_MASK = '•••••• (שמור מוצפן. להחלפה כותבים כאן קוד חדש)';
const CODE_PROPS = [['managerCode', 'managerHash', 'manager'], ['workerCode', 'workerHash', 'worker']];

function hashCode(c) {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('codeSalt');
  if (!salt) { salt = Utilities.getUuid(); props.setProperty('codeSalt', salt); }
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + c, Utilities.Charset.UTF_8));
}

const CODE_SHORT = 'קוד קצר מדי, הקוד הקודם נשאר. כותבים כאן לפחות 8 אותיות ומספרים';
function absorbCodes(s) {
  const props = PropertiesService.getScriptProperties();
  CODE_PROPS.forEach(function (p) {
    const e = s[SETTING[p[0]]];
    const v = e && String(e.value || '').trim();
    if (!v || v === CODE_MASK || v === CODE_SHORT) return;
    const ok = v.length >= 8;
    if (ok) props.setProperty(p[1], hashCode(v));
    findSheet(SHEETS.settings).getRange(e.row, 2).setValue(ok ? CODE_MASK : CODE_SHORT);
  });
}

function randomCode(n) {
  return Utilities.getUuid().replace(/-/g, '').slice(0, n).toUpperCase();
}

function roleFor(code) {
  if (code == null || String(code).trim() === '') return null;
  // No lockout and no delay: a lockout lets anyone block the farm, and a delay helps flood the script.
  // Codes of 8+ random characters are what make guessing hopeless.
  absorbCodes(settings());
  const props = PropertiesService.getScriptProperties();
  const h = hashCode(String(code).trim());
  for (let i = 0; i < CODE_PROPS.length; i++) if (props.getProperty(CODE_PROPS[i][1]) === h) return CODE_PROPS[i][2];
  return null;
}

/** A time sent by a phone. The offline queue may hold it a few days, but it is never in the future. */
function when(ts) {
  const d = new Date(Number(ts)), now = Date.now();
  if (isNaN(d.getTime()) || d.getTime() > now + 5 * 60000 || d.getTime() < now - 7 * 86400000) throw new Error('זמן לא תקין');
  return d;
}

/** Exit time: valid, and not before the entry. */
function exitAfter(hit, ts) {
  const d = when(ts);
  if (isDate(hit['כניסה']) && hit['כניסה'].getTime() > d.getTime() + 60000) throw new Error('שעת יציאה לפני שעת כניסה');
  return d;
}

/** Work days, problems and photo sets share Log data with work rows. */
function isSpecial(r) { return [KIND.shift, KIND.issue, KIND.photo].indexOf(r['קוד עבודה']) >= 0; }

/** Free text from the phone: never let a cell start with a formula character. */
function text(v) {
  const t = v == null ? '' : String(v).trim().slice(0, 2000);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function savePhoto(dataUrl, name) {
  if (!dataUrl) return '';
  // the site always sends a resized JPEG; anything else (SVG, huge files) is refused
  const m = String(dataUrl).match(/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/);
  if (!m || m[1].length > 4000000) return '';
  const blob = Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/jpeg', name + '.jpg');
  const file = photoFolder().createFile(blob);
  try {
    // the dashboard shows thumbnails, which needs view-by-link
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* domain policy may forbid link sharing; the file is still saved */ }
  return file.getUrl();
}

function photoFolder() { return ensureFolder(SETTING.photoFolder, 'חממות וניל - תמונות'); }

/** The folder whose id is in a settings row; created (and its id written back) when the row is empty. */
function ensureFolder(key, name) {
  const entry = settings()[key];
  if (entry && entry.value) return DriveApp.getFolderById(entry.value);
  const folder = DriveApp.createFolder(name);
  setSetting(key, folder.getId());
  return folder;
}

function setSetting(key, value) {
  const entry = settings()[key];
  if (entry) findSheet(SHEETS.settings).getRange(entry.row, 2).setValue(value);
  else findSheet(SHEETS.settings).appendRow([key, value]);
}

// ---------- backup: a dated copy of the whole spreadsheet every night, old copies trashed (still recoverable for 30 days) ----------

const BACKUP_PREFIX = 'גיבוי חממות וניל ';

function backupNow() {
  const folder = ensureFolder(SETTING.backupFolder, 'חממות וניל - גיבויים');
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const copy = DriveApp.getFileById(ss().getId()).makeCopy(BACKUP_PREFIX + Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm'), folder);

  const keep = Number((settings()[SETTING.keepDays] || {}).value) || 30;
  const cutoff = new Date(now.getTime() - keep * 86400000);
  let kept = 0, removed = 0;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (String(f.getName()).indexOf(BACKUP_PREFIX) !== 0) continue; // never touch files the owner put there
    if (f.getDateCreated() < cutoff) { f.setTrashed(true); removed++; } else kept++;
  }

  // a second owner keeps access to the data, the backups and the photos if the main account is lost
  const second = (settings()[SETTING.secondOwner] || {}).value;
  if (second) {
    [ss().getId()].forEach(function (id) { try { DriveApp.getFileById(id).addEditor(second); } catch (e) { /* already shared or policy */ } });
    [folder, photoFolder()].forEach(function (f) { try { f.addEditor(second); } catch (e) { /* already shared or policy */ } });
  }

  setSetting(SETTING.lastBackup, now);
  return { at: now.getTime(), url: copy.getUrl(), kept: kept, removed: removed };
}

function systemStatus() {
  const last = settings()[SETTING.lastBackup];
  let used = null, limit = null;
  try { used = DriveApp.getStorageUsed(); limit = DriveApp.getStorageLimit(); } catch (e) { /* not available */ }
  const t = last && last.value ? new Date(last.value).getTime() : null;
  return { lastBackup: t && !isNaN(t) ? t : null, driveUsed: used, driveLimit: limit, secondOwner: !!((settings()[SETTING.secondOwner] || {}).value) };
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
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['weatherDigest', 'backupNow'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('weatherDigest').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
}

function weatherDigest() {
  const w = JSON.parse(UrlFetchApp.fetch(WEATHER_URL).getContentText()).daily;
  if (!w) return;
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy');

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
  const openIssues = readTable(SHEETS.log).rows.filter(isKind(KIND.issue)).filter(function (r) { return r['סטטוס'] !== 'טופל'; });

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
