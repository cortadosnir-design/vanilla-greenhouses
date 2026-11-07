// מצב הדגמה: נטען רק עם ?demo בכתובת. מחליף את השרת בנתונים לדוגמה בתוך הדפדפן, בלי לכתוב לשום גיליון.
(function () {
  const day = (d, h = 9) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, 0, 0, 0); return t.getTime(); };
  const greenhouses = [{ id: 'GH1', name: 'חממה 1' }, { id: 'GH2', name: 'חממה 2' }, { id: 'GH3', name: 'חממה 3' }];
  const works = [
    { code: 'W01', category: 'האבקה ופריחה', name: 'האבקה ידנית של פרחים', unit: 'פרחים', location: 'חממה', interval: 1, track: false },
    { code: 'W02', category: 'האבקה ופריחה', name: 'דילול וספירת פרחים/אשכולות', unit: 'אשכולות', location: 'חממה', interval: 0, track: false },
    { code: 'W03', category: 'עיצוב וצימוח', name: 'עיצוב לולאות וליפוף ענפים (Looping)', unit: '', location: 'חממה', interval: 7, track: true },
    { code: 'W05', category: 'הזנה ודישון', name: 'יישום דשן בשחרור מבוקר', unit: 'ק"ג', location: 'חממה', interval: 180, track: true },
    { code: 'W07', category: 'השקיה ואקלים', name: 'שטיפת מצע ובדיקת EC/pH', unit: '', location: 'חממה', interval: 7, track: true },
    { code: 'W08', category: 'השקיה ואקלים', name: 'בדיקת וניקוי טפטפות וערפול', unit: '', location: 'חממה', interval: 7, track: true },
    { code: 'W09', category: 'הגנת הצומח', name: 'ניטור מזיקים ומחלות', unit: '', location: 'חממה', interval: 7, track: true },
    { code: 'W11', category: 'קטיף ואסיף', name: 'קטיף תרמילים בהבשלה', unit: 'תרמילים', location: 'חממה', interval: 2, track: false },
    { code: 'W12', category: 'קטיף ואסיף', name: 'מיון, שקילה ושטיפת תרמילים', unit: 'ק"ג', location: 'מחסן', interval: 1, track: false },
    { code: 'W13', category: 'תהליך Curing', name: 'חליטה בחום (Killing)', unit: 'ק"ג', location: 'מחסן', interval: 0, track: false },
  ];
  const workers = ['דנה', 'יוסי', 'מאור'];
  const W = Object.fromEntries(works.map((w) => [w.code, w]));
  const row = (d, h, hrs, who, gh, code, qty, notes, photo) => ({ 'מזהה': 'L-' + d + code, 'תאריך': day(d), 'עובד': who, 'חממה': gh, 'קוד עבודה': code, 'עבודה': W[code].name, 'קטגוריה': W[code].category, 'כניסה': day(d, h), 'יציאה': day(d, h) + hrs * 3600000, 'שעות': hrs, 'כמות': qty, 'יחידה': W[code].unit, 'הערות': notes || '', 'תמונה': photo ? 'https://drive.google.com/file/d/demo' + d + code + '/view' : '', 'סטטוס': 'סגור' });
  const log = [
    row(0, 6, 3.5, 'דנה', 'חממה 1', 'W01', 210, 'פריחה חזקה בשורה 2'),
    row(0, 6, 2.75, 'יוסי', 'חממה 2', 'W01', 160),
    row(1, 7, 2, 'מאור', 'חממה 3', 'W09', '', 'נקי'),
    row(1, 6, 4, 'דנה', 'חממה 1', 'W01', 240),
    row(2, 6, 3, 'יוסי', 'חממה 2', 'W01', 190),
    row(3, 8, 1.5, 'מאור', 'חממה 1', 'W07'),
    row(4, 8, 2.5, 'מאור', 'חממה 2', 'W03'),
    row(6, 6, 3, 'דנה', 'חממה 3', 'W01', 120),
    row(8, 7, 2, 'יוסי', 'חממה 1', 'W09'),
    row(9, 7, 2, 'יוסי', 'חממה 2', 'W09', '', 'כנימות בשורה 2', true),
    row(12, 8, 3, 'דנה', 'חממה 1', 'W08'),
    row(15, 6, 4, 'דנה', 'חממה 2', 'W01', 260),
    row(20, 6, 3.5, 'יוסי', 'חממה 1', 'W01', 230),
    row(24, 8, 2, 'מאור', 'חממה 3', 'W03'),
    row(33, 6, 3, 'דנה', 'חממה 1', 'W01', 150),
    row(40, 6, 2.5, 'יוסי', 'חממה 2', 'W01', 140),
    row(45, 8, 2, 'מאור', 'חממה 3', 'W09'),
  ];
  log.push({ 'מזהה': 'L-open', 'תאריך': day(0), 'עובד': 'מאור', 'חממה': 'חממה 3', 'קוד עבודה': 'W03', 'עבודה': W.W03.name, 'קטגוריה': W.W03.category, 'כניסה': Date.now() - 50 * 60000, 'יציאה': '', 'שעות': '', 'כמות': '', 'יחידה': '', 'הערות': '', 'תמונה': '', 'סטטוס': 'פתוח' });
  const issues = [
    { 'מזהה': 'B-1', 'תאריך': day(9), 'חממה': 'חממה 2', 'מדווח': 'יוסי', 'קטגוריה': 'מזיקים', 'חומרה': 'גבוהה', 'תיאור': 'כנימות מגן על שורה 2, כ-10 צמחים', 'תמונה': 'https://drive.google.com/file/d/demoB1/view', 'סטטוס': 'בטיפול', 'פתרון': 'רוסס שמן, לבדוק שוב בעוד שבוע' },
    { 'מזהה': 'B-2', 'תאריך': day(3), 'חממה': 'חממה 1', 'מדווח': 'מאור', 'קטגוריה': 'השקיה', 'חומרה': 'בינונית', 'תיאור': 'טפטפת סתומה בשורה 1', 'תמונה': '', 'סטטוס': 'טופל', 'פתרון': 'הוחלפה' },
    { 'מזהה': 'B-3', 'תאריך': day(1), 'חממה': 'חממה 3', 'מדווח': 'דנה', 'קטגוריה': 'אקלים', 'חומרה': 'גבוהה', 'תיאור': 'הערפול לא עבד בלילה, הלחות ירדה ל-55%', 'תמונה': '', 'סטטוס': 'פתוח', 'פתרון': '' },
  ];
  const attendance = [
    { 'מזהה': 'S-d', 'תאריך': day(0), 'עובד': 'דנה', 'כניסה': day(0, 5) + 45 * 60000, 'יציאה': day(0, 10), 'שעות': 4.25, 'סטטוס': 'סגור' },
    { 'מזהה': 'S-y', 'תאריך': day(0), 'עובד': 'יוסי', 'כניסה': day(0, 6) - 10 * 60000, 'יציאה': day(0, 9) + 30 * 60000, 'שעות': 3.67, 'סטטוס': 'סגור' },
    { 'מזהה': 'S-m', 'תאריך': day(0), 'עובד': 'מאור', 'כניסה': Date.now() - 2.5 * 3600000, 'יציאה': '', 'שעות': '', 'סטטוס': 'פתוח' },
    { 'מזהה': 'S-d1', 'תאריך': day(1), 'עובד': 'דנה', 'כניסה': day(1, 6) - 15 * 60000, 'יציאה': day(1, 13), 'שעות': 7.25, 'סטטוס': 'סגור' },
  ];
  const photos = [
    { 'מזהה': 'P-1', 'תאריך': day(2), 'חממה': 'חממה 1', 'הערה': 'פריחה בשורה 2', 'תמונה': ['a', 'b', 'c'].map((x) => 'https://drive.google.com/file/d/demoP' + x + '/view').join('\n'), 'הועלה ע"י': 'מנהל' },
  ];
  const ahead = (n) => { const t = new Date(); t.setDate(t.getDate() + n); t.setHours(12, 0, 0, 0); return t.getTime(); };
  const tasks = [
    { 'מזהה': 'T-1', 'תאריך ביצוע': ahead(0), 'חממה': 'חממה 2', 'משימה': 'ריסוס חוזר נגד כנימות, שורה 2', 'קוד עבודה': 'W10', 'עובד': 'יוסי', 'סטטוס': 'פתוח' },
    { 'מזהה': 'T-2', 'תאריך ביצוע': ahead(2), 'חממה': 'חממה 3', 'משימה': 'בדיקת וניקוי טפטפות וערפול', 'קוד עבודה': 'W08', 'עובד': '', 'סטטוס': 'פתוח' },
    { 'מזהה': 'T-3', 'תאריך ביצוע': ahead(9), 'חממה': 'חממה 1', 'משימה': 'יישום דשן בשחרור מבוקר', 'קוד עבודה': 'W05', 'עובד': 'דנה', 'סטטוס': 'פתוח' },
    { 'מזהה': 'T-4', 'תאריך ביצוע': ahead(-1), 'חממה': 'חממה 1', 'משימה': 'שטיפת מצע ובדיקת EC/pH', 'קוד עבודה': 'W07', 'עובד': 'מאור', 'סטטוס': 'פתוח' },
  ];
  const CODES = { 1234: 'worker', 9876: 'manager' };
  const base = { greenhouses, works, workers };

  window.DEMO_API = async (req) => {
    await new Promise((ok) => setTimeout(ok, 250));
    const role = CODES[req.code];
    if (!role) return { ok: false, error: 'קוד שגוי' };
    if (['dashboard', 'resolveIssue', 'report', 'photoSet', 'photo', 'taskAdd'].includes(req.action) && role !== 'manager') return { ok: false, error: 'נדרש קוד מנהל' };
    switch (req.action) {
      case 'bootstrap': return { ok: true, role, data: Object.assign({ tasks: tasks.filter((t) => t['סטטוס'] !== 'בוצע') }, base) };
      case 'checkIn': {
        const w = W[req.work] || {};
        log.push({ 'מזהה': req.id, 'תאריך': req.ts, 'עובד': req.worker, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'קוד עבודה': req.work, 'עבודה': w.name, 'קטגוריה': w.category, 'כניסה': req.ts, 'יציאה': '', 'שעות': '', 'כמות': '', 'יחידה': w.unit || '', 'הערות': '', 'תמונה': '', 'סטטוס': 'פתוח' });
        return { ok: true, role, data: { id: req.id } };
      }
      case 'checkOut': {
        const r = log.find((x) => x['מזהה'] === req.id);
        if (!r) return { ok: false, error: 'לא נמצאה כניסה פתוחה' };
        Object.assign(r, { 'יציאה': req.ts, 'שעות': Math.round((req.ts - r['כניסה']) / 36000) / 100, 'כמות': req.qty, 'הערות': req.notes, 'סטטוס': 'סגור' });
        return { ok: true, role, data: { id: req.id } };
      }
      case 'photoSet':
        photos.push({ 'מזהה': req.id, 'תאריך': req.date, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'הערה': req.note, 'תמונה': '', 'הועלה ע"י': req.by });
        return { ok: true, role, data: { id: req.id } };
      case 'photo': {
        const r = photos.find((x) => x['מזהה'] === req.id) || log.find((x) => x['מזהה'] === req.id) || issues.find((x) => x['מזהה'] === req.id);
        if (!r) return { ok: false, error: 'לא נמצאה רשומה' };
        const url = 'https://drive.google.com/file/d/demo-' + req.id + '-' + req.idx + '/view';
        r['תמונה'] = r['תמונה'] ? r['תמונה'] + '\n' + url : url;
        return { ok: true, role, data: { id: req.id, idx: req.idx, url } };
      }
      case 'taskAdd': tasks.push({ 'מזהה': req.id, 'תאריך ביצוע': req.due, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'משימה': req.text, 'קוד עבודה': req.work, 'עובד': req.worker, 'סטטוס': 'פתוח' }); return { ok: true, role, data: { id: req.id } };
      case 'taskDone': { const r = tasks.find((x) => x['מזהה'] === req.id); if (!r) return { ok: false, error: 'המשימה לא נמצאה' }; r['סטטוס'] = 'בוצע'; return { ok: true, role, data: { id: req.id } }; }
      case 'shiftIn': attendance.push({ 'מזהה': req.id, 'תאריך': req.ts, 'עובד': req.worker, 'כניסה': req.ts, 'יציאה': '', 'שעות': '', 'סטטוס': 'פתוח' }); return { ok: true, role, data: { id: req.id } };
      case 'shiftOut': { const r = attendance.find((x) => x['מזהה'] === req.id); if (!r) return { ok: false, error: 'לא נמצאה כניסה לעבודה' }; Object.assign(r, { 'יציאה': req.ts, 'שעות': Math.round((req.ts - r['כניסה']) / 36000) / 100, 'סטטוס': 'סגור' }); return { ok: true, role, data: { id: req.id } }; }
      case 'issue':
        issues.push({ 'מזהה': req.id, 'תאריך': req.ts, 'חממה': (greenhouses.find((g) => g.id === req.gh) || { name: req.gh }).name, 'מדווח': req.worker, 'קטגוריה': req.category, 'חומרה': req.severity, 'תיאור': req.desc, 'תמונה': '', 'סטטוס': 'פתוח', 'פתרון': '' });
        return { ok: true, role, data: { id: req.id } };
      case 'dashboard': return { ok: true, role, data: Object.assign({ log, issues, attendance, photos, tasks }, base) };
      case 'resolveIssue': {
        const r = issues.find((x) => x['מזהה'] === req.id);
        if (r) Object.assign(r, { 'סטטוס': req.status, 'פתרון': req.solution });
        return { ok: true, role, data: { id: req.id } };
      }
      case 'report': return { ok: false, error: 'במצב הדגמה אין גיליון. השתמשו בייצוא ל-Excel.' };
      default: return { ok: false, error: 'פעולה לא מוכרת' };
    }
  };
})();
