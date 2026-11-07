// Runs apps-script/Code.gs against an in-memory copy of the farm's real file ("Vanilla grow assitant":
// Code, Master Data, Work, Calendar, Barcode, Log data) so tab, column and behaviour mistakes surface before deploying.
// node scripts/gas-harness.js
const assert = require('assert');
const { Sheet, Spreadsheet, load } = require('./gas-stubs');

const tab = (name, rows) => { const s = new Sheet(name, rows[0]); rows.slice(1).forEach((r) => s.appendRow(r)); return s; };
const time = (h, m) => new Date(1899, 11, 30, h, m);
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

const code = tab('Code', [[''], ['Deployment ID', 'AKfy-old'], ['URL', 'https://script.google.com/macros/s/old/exec']]);
const master = tab('Master Data', [['סעיף / מאפיין', 'חממה 1', 'חממה 2', 'חממה 3'], ['שטח החממה (מ"ר)', 50, 50, 50], ['סה"כ צמחים בחממה', 90, 90, 90]]);
const work = tab('Work', [
  ['קוד עבודה', 'קטגוריית עבודה', 'שם העבודה / טיפול אגרוטכני', 'תיאור מפורט והנחיות ביצוע', 'עונה / שלב פנולוגי מומלץ', 'תדירות / מחזוריות'],
  ['W01', 'האבקה ופריחה', 'האבקה ידנית של פרחים', 'תיאור', 'אביב', 'יומי'],
  ['W09', 'הגנת הצומח', 'ניטור מזיקים ומחלות', 'תיאור', 'כל השנה', 'שבועי'],
  ['W12', 'קטיף והאסיף', 'מיון, שקילה ושטיפת תרמילים', 'תיאור', 'קטיף', 'יומי'],
]);
const calendar = new Sheet('Calendar', []); calendar.rows = [[]];
const barcode = new Sheet('Barcode', []); barcode.rows = [[]];
const LOG_HEAD = ['תאריך', 'עובד / מדווח', 'מספר חממה', 'זמן הגעה (כניסה)', 'זמן יציאה', 'סה"כ שעות עבודה', 'קטגוריית טיפול', 'פירוט עבודה ומיקום', 'כמות / תפוקה', 'חומרים / תמונות', 'הערות / בעיות שנצפו'];
const old = [new Date(2026, 10, 7), 'מגדל', 'חממה 2', time(15, 30), time(16, 45), time(1, 15), 'דילול וספירת פרחים/אשכולות', '', '', 'https://drive.google.com/file/d/1lngmWYujOqXTPMvCekcK81G7BoUBUhM8/view?usp=drivesdk', '', 'Pending'];
const log = tab('Log data', [LOG_HEAD, old]);
const main = new Spreadsheet('Vanilla grow assitant', [code, master, work, calendar, barcode, log]);
const tabsBefore = main.getSheets().map((s) => s.getName());
const snapshot = () => JSON.stringify({ code: code.rows.slice(0, 3), master: master.rows, work: work.rows.map((r) => r.slice(0, 6)), log: log.rows[1].slice(0, 12) });
const before = snapshot();

const { sandbox, drive, call } = load(main);
const W = '1234', M = '9876';
const logCol = (name) => log.rows[0].indexOf(name);
const lastLog = () => log.rows[log.rows.length - 1];
const codeRow = (k) => code.rows.find((r) => r[0] === k);

// ---- first request runs setup: only existing tabs, nothing deleted or overwritten ----
let boot = call({ action: 'bootstrap', code: W });
assert.ok(boot.ok, boot.error);
assert.deepStrictEqual(main.getSheets().map((s) => s.getName()), tabsBefore, 'no tab created or removed');
assert.strictEqual(snapshot(), before, 'existing data untouched');
assert.deepStrictEqual(work.rows[0].slice(6), ['כל כמה ימים', 'יחידת כמות', 'מיקום', 'מעקב תדירות']);
assert.deepStrictEqual(log.rows[0].slice(11), ['סטטוס', 'מזהה', 'קוד עבודה', 'יחידה', 'חומרה', 'פתרון'], 'blank status column named, the rest after it');
assert.strictEqual(log.rows[1][11], 'Pending', 'old status value kept');
assert.strictEqual(calendar.rows[0][1], 'תאריך ביצוע', 'Calendar titles written into the empty tab');
assert.ok(codeRow('קוד עובדים') && codeRow('עובדים'), 'settings rows added to Code');
assert.deepStrictEqual(barcode.rows.slice(1).map((r) => r[0]), ['חממה 1', 'חממה 2', 'חממה 3']);
assert.match(barcode.rows[1][1], /\?gh=GH1$/);

assert.deepStrictEqual(boot.data.greenhouses.map((g) => g.id + ':' + g.name), ['GH1:חממה 1', 'GH2:חממה 2', 'GH3:חממה 3'], 'greenhouses from Master Data columns');
const w09 = boot.data.works.find((w) => w.code === 'W09');
assert.deepStrictEqual([w09.name, w09.category, w09.interval, w09.track], ['ניטור מזיקים ומחלות', 'הגנת הצומח', 7, true]);
assert.strictEqual(boot.data.works.find((w) => w.code === 'W12').location, 'מחסן');
assert.deepStrictEqual(boot.data.workers, ['מגדל'], 'until the workers row is filled, names already in Log data');

// fill the workers row the way the owner would; setup runs again without duplicating anything
codeRow('עובדים')[1] = 'דנה, יוסי';
const cols = log.rows[0].length, codeRows = code.rows.length;
sandbox.setup();
assert.strictEqual(log.rows[0].length, cols);
assert.strictEqual(code.rows.length, codeRows);
assert.deepStrictEqual(call({ action: 'bootstrap', code: W }).data.workers, ['דנה', 'יוסי']);

// ---- auth ----
assert.strictEqual(call({ action: 'bootstrap', code: 'nope' }).error, 'קוד שגוי');
assert.strictEqual(call({ action: 'dashboard', code: W }).error, 'נדרש קוד מנהל');

// ---- work in a greenhouse lands in Log data under the farm's own titles ----
const t0 = new Date(2026, 10, 8, 22, 30).getTime();
assert.ok(call({ action: 'checkIn', code: W, id: 'L-1', worker: 'דנה', gh: 'GH1', work: 'W01', ts: t0 }).ok);
assert.strictEqual(call({ action: 'checkIn', code: W, id: 'L-1', worker: 'דנה', gh: 'GH1', work: 'W01', ts: t0 }).data.duplicate, true, 'idempotent');
assert.ok(call({ action: 'checkOut', code: W, id: 'L-1', ts: t0 + 2.5 * 3600000, qty: '120', notes: '=HYPERLINK("x")' }).ok);
let row = lastLog();
const at = (h) => row[LOG_HEAD.indexOf(h)];
assert.strictEqual(at('עובד / מדווח'), 'דנה');
assert.strictEqual(at('מספר חממה'), 'חממה 1');
assert.strictEqual(at('קטגוריית טיפול'), 'האבקה ידנית של פרחים');
assert.strictEqual(at('כמות / תפוקה'), 120);
assert.strictEqual(at('הערות / בעיות שנצפו'), "'=HYPERLINK(\"x\")", 'formula injection neutralised');
assert.ok(isDate(at('זמן הגעה (כניסה)')));
assert.strictEqual(row[logCol('סטטוס')], 'סגור');
assert.strictEqual(row[logCol('קוד עבודה')], 'W01');
assert.strictEqual(row[logCol('יחידה')], 'פרחים');
assert.match(log.formulas['F' + log.rows.length], /ROUND\(\(E\d+-D\d+\)\*24,2\)/, 'hours across midnight without MOD');
assert.match(call({ action: 'checkOut', code: W, id: 'L-9', ts: t0 }).error, /לא נמצאה/);
assert.ok(call({ action: 'checkIn', code: W, id: 'L-2', worker: 'דנה', gh: 'מחסן', work: 'W12', ts: t0 }).ok);
assert.strictEqual(lastLog()[LOG_HEAD.indexOf('מספר חממה')], 'מחסן');

// ---- work day (attendance) is a Log data row ----
assert.ok(call({ action: 'shiftIn', code: W, id: 'S-1', worker: 'דנה', ts: t0 - 3600000 }).ok);
row = lastLog();
assert.strictEqual(row[logCol('קוד עבודה')], 'SHIFT');
assert.strictEqual(row[LOG_HEAD.indexOf('קטגוריית טיפול')], 'יום עבודה');
assert.ok(call({ action: 'shiftOut', code: W, id: 'S-1', ts: t0 + 8 * 3600000 }).ok);
assert.strictEqual(lastLog()[logCol('סטטוס')], 'סגור');
assert.match(call({ action: 'shiftOut', code: W, id: 'S-x', ts: t0 }).error, /לא נמצאה/);

// ---- problem report is a Log data row; the manager resolves it ----
const png = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');
assert.ok(call({ action: 'issue', code: W, id: 'B-1', ts: t0, gh: 'GH2', worker: 'דנה', category: 'מזיקים', severity: 'גבוהה', desc: '-אקריות' }).ok);
row = lastLog();
assert.strictEqual(row[logCol('קוד עבודה')], 'ISSUE');
assert.strictEqual(row[LOG_HEAD.indexOf('פירוט עבודה ומיקום')], 'מזיקים');
assert.strictEqual(row[LOG_HEAD.indexOf('הערות / בעיות שנצפו')], "'-אקריות");
assert.strictEqual(row[logCol('חומרה')], 'גבוהה');
assert.strictEqual(call({ action: 'resolveIssue', code: W, id: 'B-1', status: 'טופל' }).error, 'נדרש קוד מנהל');
assert.ok(call({ action: 'resolveIssue', code: M, id: 'B-1', status: 'טופל', by: 'מנהל', solution: 'רוסס' }).ok);
assert.strictEqual(lastLog()[logCol('סטטוס')], 'טופל');
assert.strictEqual(lastLog()[logCol('פתרון')], 'רוסס (מנהל)');
call({ action: 'resolveIssue', code: M, id: 'B-1', status: 'hack' });
assert.strictEqual(lastLog()[logCol('סטטוס')], 'פתוח', 'unknown status falls back');
assert.match(call({ action: 'resolveIssue', code: M, id: 'L-1', status: 'טופל' }).error, /לא נמצאה/, 'only problem rows can be resolved');

// ---- photos: manager only, a Log data row with every link in "חומרים / תמונות" ----
assert.strictEqual(call({ action: 'photoSet', code: W, id: 'P-1', gh: 'GH3', date: t0 }).error, 'נדרש קוד מנהל');
assert.ok(call({ action: 'photoSet', code: M, id: 'P-1', gh: 'GH3', date: t0, note: 'פריחה', by: 'מנהל' }).ok);
for (let i = 0; i < 3; i++) assert.ok(call({ action: 'photo', code: M, id: 'P-1', idx: i, photo: png }).ok);
row = lastLog();
assert.strictEqual(row[LOG_HEAD.indexOf('מספר חממה')], 'חממה 3');
assert.strictEqual(row[LOG_HEAD.indexOf('חומרים / תמונות')].split('\n').length, 3);
assert.strictEqual(drive.folders.length, 1, 'photo folder created once');
assert.ok(codeRow('מזהה תיקיית תמונות ב-Drive')[1], 'folder id saved in Code');
assert.match(call({ action: 'photo', code: M, id: 'P-404', idx: 0, photo: png }).error, /לא נמצאה/);
assert.match(call({ action: 'photo', code: M, id: 'P-1', idx: 3, photo: 'garbage' }).error, /לא תקינה/);

// ---- planned works go to Calendar ----
assert.strictEqual(call({ action: 'taskAdd', code: W, id: 'T-1', gh: 'GH1', text: 'x', due: t0 }).error, 'נדרש קוד מנהל');
assert.ok(call({ action: 'taskAdd', code: M, id: 'T-1', gh: 'GH2', work: 'W09', text: 'ניטור', due: t0 + 86400000, worker: 'יוסי' }).ok);
assert.match(call({ action: 'taskAdd', code: M, id: 'T-2', gh: 'GH2', text: ' ', due: t0 }).error, /חסר/);
assert.strictEqual(calendar.rows[1][2], 'חממה 2');
assert.strictEqual(call({ action: 'bootstrap', code: W }).data.tasks.length, 1);
assert.ok(call({ action: 'taskDone', code: W, id: 'T-1', by: 'יוסי' }).ok);
assert.strictEqual(calendar.rows[1][6], 'בוצע');
assert.strictEqual(call({ action: 'bootstrap', code: W }).data.tasks.length, 0);

// ---- dashboard splits Log data into work, work days and problems ----
const d = call({ action: 'dashboard', code: M });
assert.ok(d.ok, d.error);
assert.deepStrictEqual(d.data.log.map((x) => x['מזהה'] || 'old'), ['old', 'L-1', 'L-2', 'P-1'], 'work rows + photo set, no SHIFT/ISSUE');
assert.strictEqual(d.data.attendance.length, 1);
assert.strictEqual(d.data.issues.length, 1);
assert.deepStrictEqual([d.data.issues[0]['קטגוריה'], d.data.issues[0]['מדווח'], d.data.issues[0]['תיאור']], ['מזיקים', 'דנה', "'-אקריות"]);
const legacy = d.data.log[0];
assert.strictEqual(legacy['שעות'], 1.25, 'old time-only hours read as a number');
assert.strictEqual(new Date(legacy['כניסה']).getHours(), 15);
assert.strictEqual(new Date(legacy['כניסה']).getDate(), 7);
assert.strictEqual(typeof d.data.log[1]['כניסה'], 'number');

// ---- Google Sheets report ----
const rep = call({ action: 'report', code: M, from: t0 - 86400000 * 5, to: t0 + 86400000 });
assert.ok(rep.ok, rep.error);

// ---- backup: dated copy, old copies trashed, owner's own files untouched, second owner added ----
codeRow('אימייל בעלים שני')[1] = 'second@example.com';
assert.strictEqual(call({ action: 'backup', code: W }).error, 'נדרש קוד מנהל');
let r = call({ action: 'backup', code: M });
assert.ok(r.ok, r.error);
const bfolder = drive.folders.find((f) => f.name === 'חממות וניל - גיבויים');
assert.ok(bfolder && bfolder.files.length === 1);
const oldCopy = bfolder.files[0]; oldCopy.created = new Date(Date.now() - 40 * 86400000);
const mine = { name: 'קובץ שלי', created: new Date(0), trashed: false, getName() { return this.name; }, getDateCreated() { return this.created; }, setTrashed(v) { this.trashed = v; } };
bfolder.files.push(mine);
r = call({ action: 'backup', code: M });
assert.ok(r.ok, r.error);
assert.strictEqual(oldCopy.trashed, true);
assert.strictEqual(mine.trashed, false, "owner's own file untouched");
assert.ok(drive.editors.some(([, e]) => e === 'second@example.com'));
const sys = call({ action: 'dashboard', code: M }).data.system;
assert.ok(sys.lastBackup > Date.now() - 60000 && sys.secondOwner && sys.driveLimit === 15e9);

// ---- weather digest: email only, no tab ----
codeRow('אימייל לעדכון יומי')[1] = 'owner@example.com';
sandbox.weatherDigest();
assert.strictEqual(sandbox.MailApp.sent.length, 1);
assert.match(sandbox.MailApp.sent[0].body, /חום של 36/);
assert.match(sandbox.MailApp.sent[0].body, /לילה קר \(8/);
assert.deepStrictEqual(main.getSheets().map((s) => s.getName()), tabsBefore, 'still no new tab');

// ---- rate limit after 20 bad codes (last: it locks everyone out for 10 minutes) ----
for (let i = 0; i < 20; i++) call({ action: 'bootstrap', code: 'bad' + i });
assert.match(call({ action: 'bootstrap', code: W }).error, /יותר מדי/);

assert.strictEqual(snapshot(), before, 'existing data still untouched at the end');
console.log('gas harness ok');
