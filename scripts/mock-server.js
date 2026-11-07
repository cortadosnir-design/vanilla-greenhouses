// Serves docs/ and mocks the Apps Script API so the site can be exercised without Google.
// node scripts/mock-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8787;
const SITE = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const day = (d, h = 9) => new Date(2026, 10, d, h).getTime();
const greenhouses = [{ id: 'GH1', name: 'חממה 1' }, { id: 'GH2', name: 'חממה 2' }, { id: 'GH3', name: 'חממה 3' }];
const works = [
  { code: 'W01', category: 'האבקה ופריחה', name: 'האבקה ידנית של פרחים', unit: 'פרחים', location: 'חממה', interval: 1, track: false },
  { code: 'W03', category: 'עיצוב וצימוח', name: 'עיצוב לולאות וליפוף ענפים (Looping)', unit: '', location: 'חממה', interval: 7, track: true },
  { code: 'W07', category: 'השקיה ואקלים', name: 'שטיפת מצע ובדיקת EC/pH', unit: '', location: 'חממה', interval: 7, track: true },
  { code: 'W09', category: 'הגנת הצומח', name: 'ניטור מזיקים ומחלות', unit: '', location: 'חממה', interval: 7, track: true },
  { code: 'W11', category: 'קטיף ואסיף', name: 'קטיף תרמילים בהבשלה', unit: 'תרמילים', location: 'חממה', interval: 2, track: false },
  { code: 'W12', category: 'קטיף ואסיף', name: 'מיון, שקילה ושטיפת תרמילים', unit: 'ק"ג', location: 'מחסן', interval: 1, track: false },
];
const workers = ['דנה', 'יוסי', 'מאור'];
const state = {
  log: [
    { 'מזהה': 'L-1', 'תאריך': day(6), 'עובד': 'דנה', 'חממה': 'חממה 1', 'קוד עבודה': 'W09', 'עבודה': 'ניטור מזיקים ומחלות', 'קטגוריה': 'הגנת הצומח', 'כניסה': day(6, 7), 'יציאה': day(6, 9), 'שעות': 2, 'כמות': '', 'יחידה': '', 'הערות': 'נקי', 'תמונה': '', 'סטטוס': 'סגור' },
    { 'מזהה': 'L-2', 'תאריך': day(5), 'עובד': 'יוסי', 'חממה': 'חממה 2', 'קוד עבודה': 'W01', 'עבודה': 'האבקה ידנית של פרחים', 'קטגוריה': 'האבקה ופריחה', 'כניסה': day(5, 6), 'יציאה': day(5, 10), 'שעות': 4.25, 'כמות': 180, 'יחידה': 'פרחים', 'הערות': '', 'תמונה': 'https://drive.google.com/file/d/1abcDEF_ghi/view', 'סטטוס': 'סגור' },
    { 'מזהה': 'L-3', 'תאריך': day(1), 'עובד': 'מאור', 'חממה': 'חממה 3', 'קוד עבודה': 'W03', 'עבודה': 'עיצוב לולאות וליפוף ענפים (Looping)', 'קטגוריה': 'עיצוב וצימוח', 'כניסה': day(1, 8), 'יציאה': day(1, 11), 'שעות': 3, 'כמות': '', 'יחידה': '', 'הערות': '', 'תמונה': '', 'סטטוס': 'סגור' },
    { 'מזהה': 'L-4', 'תאריך': day(7), 'עובד': 'דנה', 'חממה': 'חממה 1', 'קוד עבודה': 'W01', 'עבודה': 'האבקה ידנית של פרחים', 'קטגוריה': 'האבקה ופריחה', 'כניסה': day(7, 6), 'יציאה': '', 'שעות': '', 'כמות': '', 'יחידה': 'פרחים', 'הערות': '', 'תמונה': '', 'סטטוס': 'פתוח' },
  ],
  photos: [],
  tasks: [{ 'מזהה': 'T-1', 'תאריך ביצוע': day(8, 12), 'חממה': 'חממה 1', 'משימה': 'ניטור מזיקים', 'קוד עבודה': 'W09', 'עובד': '', 'סטטוס': 'פתוח' }],
  attendance: [
    { 'מזהה': 'S-1', 'תאריך': day(7), 'עובד': 'דנה', 'כניסה': day(7, 5), 'יציאה': '', 'שעות': '', 'סטטוס': 'פתוח' },
  ],
  issues: [
    { 'מזהה': 'B-1', 'תאריך': day(4), 'חממה': 'חממה 2', 'מדווח': 'יוסי', 'קטגוריה': 'מזיקים', 'חומרה': 'גבוהה', 'תיאור': 'כנימות מגן על שורה 2', 'תמונה': 'https://drive.google.com/file/d/1zzzYYY_xxx/view', 'סטטוס': 'פתוח', 'פתרון': '' },
    { 'מזהה': 'B-2', 'תאריך': day(2), 'חממה': 'חממה 1', 'מדווח': 'דנה', 'קטגוריה': 'השקיה', 'חומרה': 'בינונית', 'תיאור': 'טפטפת סתומה', 'תמונה': '', 'סטטוס': 'טופל', 'פתרון': 'הוחלפה' },
  ],
};
const CODES = { 1234: 'worker', 9876: 'manager' };
const calls = [];

function handle(req) {
  const role = CODES[req.code];
  if (!role) return { ok: false, error: 'קוד שגוי' };
  if (['dashboard', 'resolveIssue', 'report', 'photoSet', 'photo', 'taskAdd', 'backup'].includes(req.action) && role !== 'manager') return { ok: false, error: 'נדרש קוד מנהל' };
  calls.push(req.action);
  const base = { greenhouses, works, workers };
  switch (req.action) {
    case 'bootstrap': return { ok: true, role, data: Object.assign({ tasks: state.tasks.filter((t) => t['סטטוס'] !== 'בוצע') }, base) };
    case 'checkIn':
      state.log.push({ 'מזהה': req.id, 'תאריך': req.ts, 'עובד': req.worker, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'קוד עבודה': req.work, 'עבודה': (works.find((w) => w.code === req.work) || {}).name, 'כניסה': req.ts, 'יציאה': '', 'שעות': '', 'כמות': '', 'סטטוס': 'פתוח', 'תמונה': '' });
      return { ok: true, role, data: { id: req.id } };
    case 'checkOut': {
      const r = state.log.find((x) => x['מזהה'] === req.id);
      if (!r) return { ok: false, error: 'לא נמצאה כניסה פתוחה' };
      Object.assign(r, { 'יציאה': req.ts, 'שעות': (req.ts - r['כניסה']) / 3600000, 'כמות': req.qty, 'הערות': req.notes, 'סטטוס': 'סגור', 'תמונה': req.photo ? 'https://drive.google.com/file/d/1newPHOTO/view' : '' });
      return { ok: true, role, data: { id: req.id, photoBytes: (req.photo || '').length } };
    }
    case 'photoSet':
      state.photos.push({ 'מזהה': req.id, 'תאריך': req.date, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'הערה': req.note, 'תמונה': '', 'הועלה ע"י': req.by });
      return { ok: true, role, data: { id: req.id } };
    case 'photo': {
      const r = state.photos.find((x) => x['מזהה'] === req.id) || state.log.find((x) => x['מזהה'] === req.id) || state.issues.find((x) => x['מזהה'] === req.id);
      if (!r) return { ok: false, error: 'לא נמצאה רשומה' };
      const url = 'https://drive.google.com/file/d/m-' + req.id + '-' + req.idx + '/view';
      r['תמונה'] = r['תמונה'] ? r['תמונה'] + '\n' + url : url;
      return { ok: true, role, data: { url } };
    }
      case 'taskAdd': state.tasks.push({ 'מזהה': req.id, 'תאריך ביצוע': req.due, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'משימה': req.text, 'קוד עבודה': req.work, 'עובד': req.worker, 'סטטוס': 'פתוח' }); return { ok: true, role, data: { id: req.id } };
      case 'taskDone': { const r = state.tasks.find((x) => x['מזהה'] === req.id); if (!r) return { ok: false, error: 'המשימה לא נמצאה' }; r['סטטוס'] = 'בוצע'; return { ok: true, role, data: { id: req.id } }; }
      case 'backup': return { ok: true, role, data: { at: Date.now(), url: 'https://docs.google.com/spreadsheets/d/backup', kept: 1, removed: 0 } };
      case 'shiftIn': state.attendance.push({ 'מזהה': req.id, 'תאריך': req.ts, 'עובד': req.worker, 'כניסה': req.ts, 'יציאה': '', 'שעות': '', 'סטטוס': 'פתוח' }); return { ok: true, role, data: { id: req.id } };
      case 'shiftOut': { const r = state.attendance.find((x) => x['מזהה'] === req.id); if (!r) return { ok: false, error: 'לא נמצאה כניסה לעבודה' }; Object.assign(r, { 'יציאה': req.ts, 'שעות': Math.round((req.ts - r['כניסה']) / 36000) / 100, 'סטטוס': 'סגור' }); return { ok: true, role, data: { id: req.id } }; }
    case 'issue':
      state.issues.push({ 'מזהה': req.id, 'תאריך': req.ts, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'מדווח': req.worker, 'קטגוריה': req.category, 'חומרה': req.severity, 'תיאור': req.desc, 'תמונה': '', 'סטטוס': 'פתוח' });
      return { ok: true, role, data: { id: req.id } };
    case 'dashboard': return { ok: true, role, data: Object.assign({ log: state.log, issues: state.issues, attendance: state.attendance, photos: state.photos, tasks: state.tasks, system: { lastBackup: null, driveUsed: 3.2e9, driveLimit: 16106127360, secondOwner: false } }, base) };
    case 'resolveIssue': {
      const r = state.issues.find((x) => x['מזהה'] === req.id);
      Object.assign(r, { 'סטטוס': req.status, 'פתרון': req.solution });
      return { ok: true, role, data: { id: req.id } };
    }
    case 'report': return { ok: true, role, data: { url: 'https://docs.google.com/spreadsheets/d/mock', title: 'דוח' } };
    default: return { ok: false, error: 'פעולה לא מוכרת' };
  }
}

http.createServer((req, res) => {
  if (req.url === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(handle(JSON.parse(body)))); });
    return;
  }
  if (req.url === '/__calls') { res.end(JSON.stringify({ calls, log: state.log, issues: state.issues, attendance: state.attendance, photos: state.photos, tasks: state.tasks })); return; }
  const url = req.url.split('?')[0];
  if (url === '/config.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`window.APP_CONFIG={apiUrl:'http://localhost:${PORT}/api'};`); return; }
  const file = path.join(SITE, url === '/' ? 'index.html' : url);
  if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('mock on http://localhost:' + PORT));
