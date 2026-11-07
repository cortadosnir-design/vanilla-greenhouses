// End-to-end walk of the site against the mock server. node scripts/e2e.js (mock-server must be running on 8787)
const { chromium, devices } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787/';
const SHOTS = path.join(__dirname, '..', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const WEATHER = { current: { temperature_2m: 16.4, relative_humidity_2m: 90, weather_code: 61, wind_speed_10m: 9, is_day: 1, precipitation: 0.3 },
  daily: { time: ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], weather_code: [61, 3, 0, 0, 2, 95, 45],
    temperature_2m_max: [18.7, 22, 36, 25, 24, 20, 19], temperature_2m_min: [12, 6, 14, 13, 12, 11, 10], precipitation_sum: [14.5, 0, 0, 0, 0, 20, 0],
    precipitation_probability_max: [100, 10, 0, 0, 20, 80, 30], wind_speed_10m_max: [12.4, 50, 10, 10, 15, 40, 10], relative_humidity_2m_max: [98, 80, 60, 70, 75, 95, 99], relative_humidity_2m_min: [86, 40, 30, 50, 55, 70, 90] } };

const HISTORY = { daily: { time: Array.from({ length: 31 }, (_, i) => new Date(Date.now() - (30 - i) * 86400000).toISOString().slice(0, 10)),
  temperature_2m_max: Array.from({ length: 31 }, (_, i) => 22 + (i % 7)), temperature_2m_min: Array.from({ length: 31 }, (_, i) => 12 + (i % 5)),
  precipitation_sum: Array.from({ length: 31 }, (_, i) => (i % 9 === 0 ? 6 : 0)), relative_humidity_2m_mean: Array.from({ length: 31 }, () => 72), weather_code: Array.from({ length: 31 }, () => 2) } };
const meteo = (r) => r.fulfill({ json: /past_days/.test(r.request().url()) ? HISTORY : WEATHER });
// the opening scene plays on every launch; a tap skips it
// stands in for Google's sign-in script: the button signs in as whatever email the test put in window.TEST_EMAIL
const GSI = `window.google={accounts:{id:{initialize:function(o){window.__gsi=o},disableAutoSelect:function(){},
  renderButton:function(el){var b=document.createElement('button');b.type='button';b.id='gsiBtn';b.textContent='Sign in with Google';
  b.onclick=function(){window.__gsi.callback({credential:'g.'+window.TEST_EMAIL})};el.innerHTML='';el.appendChild(b)}}}};`;
const gsi = (r) => r.fulfill({ body: GSI, contentType: 'text/javascript' });

// the common works are tiles; the rest of the catalogue is behind "עבודה אחרת"
async function pickWork(p, code) {
  if (await p.$(`#workTiles button[data-v=${code}]`)) return p.click(`#workTiles button[data-v=${code}]`);
  await p.click('#workTiles button[data-v="*"]');
  await p.selectOption('#workSel', code);
}

async function skipIntro(p) {
  await p.waitForSelector('#intro');
  if (!(await p.$('#intro.gone'))) await p.click('#intro').catch(() => {});
  await p.waitForSelector('#intro.gone', { state: 'attached', timeout: 5000 });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  // serviceWorkers: 'block' so ctx.route() can simulate "no reception" (a SW-controlled fetch bypasses Playwright routes)
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'he-IL', timezoneId: 'Asia/Jerusalem', acceptDownloads: true, serviceWorkers: 'block' });
  // the sandbox cannot reach cdnjs; serve the same library versions from node_modules
  await ctx.route('**/exceljs.min.js', (r) => r.fulfill({ path: path.join(__dirname, 'node_modules/exceljs/dist/exceljs.min.js'), contentType: 'text/javascript' }));
  await ctx.route('**/qrcode.min.js', (r) => r.fulfill({ path: path.join(__dirname, 'node_modules/qrcodejs2/qrcode.min.js'), contentType: 'text/javascript' }));
  await ctx.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await ctx.route('**/api.open-meteo.com/**', meteo);
  await ctx.route('**/accounts.google.com/**', gsi);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // resource failures are expected here (Drive thumbnails are unreachable, and the offline step aborts /api); JS errors are not
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  // 1. gate + QR deep link
  await page.goto(BASE + '?gh=GH2');
  assert.ok(!(await page.$('#intro.gone')), 'opening scene shows on launch');
  await page.screenshot({ path: path.join(SHOTS, '00-intro.png') });
  await skipIntro(page);
  await page.waitForSelector('#gsiBtn');
  await page.click('#codeBox summary');
  await page.fill('#gateCode', '0000');
  await page.click('#gateForm button[type=submit]');
  await page.waitForSelector('#gateErr:has-text("קוד שגוי")');
  await page.screenshot({ path: path.join(SHOTS, '01-gate.png') });
  await page.fill('#gateCode', '1234');
  await page.click('#gateForm button[type=submit]');
  await page.waitForSelector('#whoDlg[open]');
  await page.screenshot({ path: path.join(SHOTS, '02-who.png') });
  await page.click('#whoList button:has-text("דנה")');
  assert.strictEqual(await page.textContent('#who'), 'דנה');
  assert.strictEqual(await page.getAttribute('#ghSeg button[data-v=GH2]', 'aria-checked'), 'true', 'QR link preselects greenhouse');
  assert.ok(await page.isDisabled('#inBtn'), 'check-in disabled until work chosen');
  await page.waitForSelector('#wxStrip:not([hidden])');
  assert.match(await page.textContent('#wxStrip'), /16°/);
  await page.screenshot({ path: path.join(SHOTS, '03-report-idle.png') });

  // 1b. a stale/bad greenhouse id from a QR is dropped
  await page.goto(BASE + '?gh=GH9');
  await skipIntro(page);
  await page.waitForSelector('#idle:not([hidden])');
  assert.strictEqual((await page.$$('#ghSeg [aria-checked="true"]')).length, 0, 'bad QR id not selected');
  await pickWork(page, 'W01');
  assert.ok(await page.isDisabled('#inBtn'), 'no check-in without a valid greenhouse');
  await page.click('#ghSeg button[data-v=GH2]');

  // 1c. one pair on the screen: into the greenhouse and out of it
  assert.strictEqual(await page.$('#shiftInBtn'), null, 'no separate work-day clock');
  assert.ok(await page.isDisabled('#outBtn'), 'greenhouse exit waits for an entry');

  // 2. check in
  await pickWork(page, 'W01');
  assert.ok(!(await page.isDisabled('#inBtn')));
  await page.click('#inBtn');
  await page.waitForSelector('#active:not([hidden])');
  assert.strictEqual(await page.textContent('#liveGh'), 'חממה 2');
  assert.ok(!(await page.isHidden('#qtyRow')), 'qty row visible for W01');
  assert.strictEqual(await page.textContent('#qtyUnit'), 'כמה פרחים?');
  await page.waitForTimeout(1500);
  assert.match(await page.textContent('#timer'), /^0:00:0[1-9]$/);
  await page.screenshot({ path: path.join(SHOTS, '04-active.png') });

  // persistence: reload keeps the session
  await page.reload();
  await skipIntro(page);
  await page.waitForSelector('#active:not([hidden])');
  assert.ok(await page.isDisabled('#inBtn') && !(await page.isDisabled('#outBtn')), 'inside: only exit is active');
  assert.strictEqual(await page.textContent('#liveGh'), 'חממה 2', 'active session survives reload');

  // 3. a photo inside the greenhouse goes into the visit's own row; then check out with qty
  const visitPng = path.join(__dirname, '..', 'docs', 'icons', 'icon-180.png');
  await page.setInputFiles('#camInput', [visitPng, visitPng]);
  await page.waitForSelector('#toast.show:has-text("בשורת הביקור")', { timeout: 30000 });
  assert.match(await page.textContent('#camLabel'), /2 תמונות/);
  let visitRow = (await (await page.request.get(BASE + '__calls')).json()).log.slice(-1)[0];
  assert.strictEqual(visitRow['תמונה'].split('\n').length, 2, 'both photos in the visit row');
  await page.fill('#qty', '42');
  await page.fill('#notes', 'פרחים יפים');
  await page.click('#outBtn');
  await page.waitForSelector('#idle:not([hidden])');
  await page.waitForSelector('#toast.show:has-text("היציאה")', { timeout: 30000 });
  await page.waitForSelector('#pending', { state: 'hidden', timeout: 30000 });
  const toast1 = await page.textContent('#toast');
  assert.match(toast1, /היציאה נרשמה/, toast1);
  let server = await (await page.request.get(BASE + '__calls')).json();
  const mine = server.log[server.log.length - 1];
  assert.strictEqual(mine['כמות'], '42');
  assert.strictEqual(mine['סטטוס'], 'סגור');

  // my day shows the finished greenhouse work with qty
  const dayText = await page.textContent('#dayList');
  assert.match(dayText, /האבקה ידנית של פרחים/);
  assert.match(dayText, /42 פרחים/);
  assert.match(await page.textContent('#daySum'), /1 עבודות/);
  await page.screenshot({ path: path.join(SHOTS, '04c-my-day.png'), fullPage: true });

  // 3b. tap a line of my day to change it: the quantity, a photo
  await page.click('#dayBox summary');
  await page.click('#dayList [data-edit]');
  await page.waitForSelector('#editDlg[open]');
  assert.strictEqual(await page.inputValue('#eQty'), '42');
  await page.fill('#eQty', '50');
  await page.fill('#eNotes', 'תיקון');
  const photosBefore = (await page.$$('#ePhotos .thumb')).length;
  assert.ok(photosBefore >= 1, 'the visit photos are shown to edit');
  await page.click('#ePhotos .del');
  assert.strictEqual(await page.textContent('#ePhotos .del'), 'למחוק?', 'a photo is removed on the second tap');
  await page.click('#ePhotos .del');
  await page.waitForFunction((n) => document.querySelectorAll('#ePhotos .thumb').length === n - 1, photosBefore);
  await page.screenshot({ path: path.join(SHOTS, '04d-edit.png') });
  await page.click('#eSave');
  await page.waitForFunction(() => !document.getElementById('editDlg').open);
  assert.match(await page.textContent('#dayList'), /50 פרחים/);
  assert.match(await page.textContent('#dayList'), /תיקון/);
  server = await (await page.request.get(BASE + '__calls')).json();
  assert.strictEqual(server.log.find((r) => r['מזהה'] === mine['מזהה'])['כמות'], 50, 'the change reached the sheet');

  // 4. warehouse work hides greenhouse picker
  await pickWork(page, 'W12');
  assert.ok(await page.isHidden('#ghSeg'));
  assert.strictEqual(await page.textContent('#inBtn'), 'התחלת עבודה');

  // 5. offline queue: block API, check in, verify pending, unblock, verify flush
  await ctx.route('**/api', (r) => r.abort());
  await pickWork(page, 'W09');
  const [failed1] = await Promise.all([page.waitForEvent('requestfailed', (r) => r.url().endsWith('/api')), page.click('#inBtn')]);
  assert.ok(failed1, 'check-in request was blocked');
  await page.waitForSelector('#active:not([hidden])');
  await page.waitForSelector('#pending:not([hidden])');
  assert.match(await page.textContent('#pending'), /ממתין/);
  const [failed2] = await Promise.all([page.waitForEvent('requestfailed', (r) => r.url().endsWith('/api')), page.click('#outBtn')]);
  assert.ok(failed2, 'check-out flush was blocked');
  await page.waitForSelector('#toast.show');
  const toast2 = await page.textContent('#toast');
  const calls0 = await (await page.request.get(BASE + '__calls')).json();
  assert.match(toast2, /נשמרה במכשיר/, toast2 + ' | server calls: ' + calls0.calls.join(','));
  await page.screenshot({ path: path.join(SHOTS, '05-pending.png') });
  await ctx.unroute('**/api');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#pending', { state: 'hidden', timeout: 5000 });
  server = await (await page.request.get(BASE + '__calls')).json();
  assert.strictEqual(server.calls.filter((c) => c === 'checkIn').length, 2, 'queued check-in flushed');
  assert.strictEqual(server.calls.filter((c) => c === 'checkOut').length, 2, 'queued check-out flushed');

  // 5b. enqueue while a send is in flight: slow the API, check in and out back to back, both must arrive
  await ctx.route('**/api', async (r) => { await new Promise((ok) => setTimeout(ok, 1200)); r.continue(); });
  await pickWork(page, 'W03');
  await page.click('#inBtn');
  await page.waitForSelector('#active:not([hidden])');
  await page.click('#outBtn');
  await page.waitForSelector('#idle:not([hidden])');
  await page.waitForSelector('#pending', { state: 'hidden', timeout: 10000 });
  await ctx.unroute('**/api');
  server = await (await page.request.get(BASE + '__calls')).json();
  assert.strictEqual(server.calls.filter((c) => c === 'checkIn').length, 3, 'in-flight check-in arrived');
  assert.strictEqual(server.calls.filter((c) => c === 'checkOut').length, 3, 'check-out enqueued during the in-flight send was not lost');
  assert.strictEqual(server.log[server.log.length - 1]['סטטוס'], 'סגור');

  // 6. issue
  await page.click('.tabs button[data-tab=issue]');
  await page.waitForSelector('#issue:not([hidden])');
  assert.ok(await page.isDisabled('#issueBtn'));
  await page.click('#issueCat button[data-v=מזיקים]');
  await page.fill('#issueDesc', 'אקריות בשורה 1');
  assert.ok(!(await page.isDisabled('#issueBtn')));
  await page.screenshot({ path: path.join(SHOTS, '06-issue.png') });
  await page.click('#issueBtn');
  await page.waitForSelector('#toast.show');
  server = await (await page.request.get(BASE + '__calls')).json();
  assert.strictEqual(server.issues[server.issues.length - 1]['תיאור'], 'אקריות בשורה 1');

  // 7. dashboard: worker code is refused, manager code opens
  await page.click('.tabs button[data-tab=dash]');
  await page.waitForSelector('#mgrForm:not([hidden])');
  await page.fill('#mgrCode', '1234');
  await page.click('#mgrForm button[type=submit]');
  await page.waitForSelector('#mgrErr:has-text("קוד עובדים")');
  await page.fill('#mgrCode', '9876');
  await page.click('#mgrForm button[type=submit]');
  await page.waitForSelector('#dashBody:not([hidden])');
  // the dashboard opens on "today": who is in, the numbers, what is late, problems, weather
  assert.strictEqual(await page.getAttribute('#dashBody', 'data-pane'), 'today');
  assert.ok(await page.isHidden('#ghCards'), 'one pane at a time');
  assert.ok((await page.textContent('#dueList')).includes('חממה'), 'due list has items');
  await page.waitForSelector('#wxCard:not([hidden])');
  assert.ok((await page.$$('#wxCard .wx-day')).length === 7, '7 forecast days');
  assert.match(await page.textContent('#wxCard .wx-alerts'), /חום של 36/);
  assert.strictEqual((await page.$$('#kpis .kpi')).length, 5, 'five numbers on top');
  assert.ok((await page.textContent('#nowCard')).length > 3, 'who is in the greenhouse now');
  await page.screenshot({ path: path.join(SHOTS, '07-dash-phone.png'), fullPage: true });
  await page.click('#paneSeg button[data-pane=gh]');
  await page.waitForSelector('#ghCards .gh');
  assert.strictEqual((await page.$$('#ghCards .gh')).length, 3);
  assert.ok((await page.$$('#compareBody tr')).length === 3, 'comparison rows');
  assert.strictEqual((await page.$$('#journey .vine')).length, 3, 'vanilla journey per greenhouse');
  assert.ok((await page.$$('#compareBody .delta')).length >= 15, 'comparison deltas');
  await page.screenshot({ path: path.join(SHOTS, '07a-dash-gh.png'), fullPage: true });
  await page.click('#paneSeg button[data-pane=log]');
  await page.waitForSelector('#hoursChart svg rect.b');
  await page.waitForSelector('#wxHistory svg polyline.hi');
  await page.click('#paneSeg button[data-pane=photos]');
  await page.waitForSelector('#gallery button');
  assert.match(await page.textContent('#gallery'), /לחות 72%/, "each gallery day shows that day's weather");
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'the dashboard never widens the phone page');
  await page.click('#rangeSeg button[data-range=all]');
  assert.strictEqual((await page.$$('#compareBody .delta')).length, 0, 'no deltas for "all"');
  await page.click('#rangeSeg button[data-range="30"]');
  assert.ok((await page.textContent('#issueList')).includes('אקריות'));
  assert.ok((await page.$$('#logBody tr')).length >= 5);
  await page.click('#paneSeg button[data-pane=log]');
  // delete a record from the work log: two taps, and it is gone from the dashboard (marked in the sheet)
  const logRows = (await page.$$('#logBody tr')).length;
  await page.click('#logBody [data-edit="L-3"]');
  await page.waitForSelector('#editDlg[open]');
  await page.click('#eDelete');
  assert.strictEqual(await page.textContent('#eDelete'), 'למחוק את הרשומה?');
  await page.click('#eDelete');
  await page.waitForFunction(() => !document.getElementById('editDlg').open);
  await page.waitForFunction((n) => document.querySelectorAll('#logBody tr').length === n - 1, logRows);
  server = await (await page.request.get(BASE + '__calls')).json();
  assert.strictEqual(server.log.find((r) => r['מזהה'] === 'L-3')['סטטוס'], 'נמחק', 'kept in the sheet, marked deleted');

  // a change made elsewhere (in the sheet) shows up without reloading
  const before = Number(await page.textContent('#tasksCount'));
  await page.request.post(BASE + 'api', { data: JSON.stringify({ action: 'taskAdd', code: '9876', id: 'T-sync1', gh: 'GH1', text: 'נוסף בגיליון', due: Date.now() + 86400000 }) });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((n) => Number(document.querySelector('#tasksCount').textContent) === n + 1, before, { timeout: 10000 });
  assert.match(await page.textContent('#syncState'), /מסונכרן/);
  await page.request.post(BASE + 'api', { data: JSON.stringify({ action: 'taskDone', code: '9876', id: 'T-sync1' }) });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((n) => Number(document.querySelector('#tasksCount').textContent) === n, before, { timeout: 10000 });

  // comparison has a date column before hours
  assert.strictEqual(await page.textContent('table.compare thead th:nth-child(2)'), 'תאריך אחרון');

  // future tasks: add one, see the count, mark one done
  assert.strictEqual(await page.textContent('#tasksCount'), '1');
  await page.click('#tasksBtn');
  await page.waitForSelector('#tasksDlg[open]');
  assert.ok(await page.isDisabled('#tAdd'));
  await page.click('#tGh button[data-v=GH2]');
  await page.selectOption('#tWork', 'W03');
  await page.fill('#tDate', '2026-11-20');
  await page.selectOption('#tWorker', 'יוסי');
  await page.click('#tAdd');
  await page.waitForSelector('#tList li:has-text("עיצוב לולאות")');
  assert.strictEqual(await page.textContent('#tasksCount'), '2');
  await page.screenshot({ path: path.join(SHOTS, '07c-tasks.png') });
  server = await (await page.request.get(BASE + '__calls')).json();
  const added = server.tasks.find((t) => t['עובד'] === 'יוסי');
  assert.ok(added && added['חממה'] === 'חממה 2' && new Date(added['תאריך ביצוע']).getDate() === 20, 'task stored with date');
  await page.click('#tList li:has-text("ניטור מזיקים") [data-done]');
  await page.waitForFunction(() => document.querySelector('#tasksCount').textContent === '1');
  await page.click('#tasksDlg [data-close]');

  // manager photo upload: up to 20, attached to a greenhouse and date
  const png = path.join(__dirname, '..', 'docs', 'icons', 'icon-512.png');
  const png2 = path.join(__dirname, '..', 'docs', 'icons', 'icon-180.png');
  await page.click('#paneSeg button[data-pane=photos]');
  await page.click('.upload-box summary');
  assert.ok(await page.isDisabled('#upBtn'), 'upload disabled without photos');
  await page.click('#upGh button[data-v=GH3]');
  await page.fill('#upNote', 'פריחה ראשונה');
  await page.setInputFiles('#upPhoto', [png, png2, png]);
  await page.waitForFunction(() => document.querySelectorAll('#upThumbs .thumb').length === 3);
  await page.click('#upThumbs .thumb:nth-child(2) button');
  await page.waitForFunction(() => document.querySelectorAll('#upThumbs .thumb').length === 2);
  assert.strictEqual(await page.textContent('#upPhotoLabel'), 'תמונות 2/20');
  await page.setInputFiles('#upPhoto', Array(25).fill(png));
  await page.waitForFunction(() => document.querySelectorAll('#upThumbs .thumb').length === 20, null, { timeout: 30000 });
  assert.ok(await page.isDisabled('#upPhoto'), 'picker disabled at 20');
  await page.locator('#upThumbs').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '07b-upload.png') });
  await page.click('#upBtn');
  await page.waitForSelector('#toast.show:has-text("הועלו")', { timeout: 30000 });
  server = await (await page.request.get(BASE + '__calls')).json();
  const set = server.photos[server.photos.length - 1];
  assert.strictEqual(set['חממה'], 'חממה 3');
  assert.strictEqual(set['הערה'], 'פריחה ראשונה');
  assert.strictEqual(set['תמונה'].split('\n').length, 20, 'all 20 photos reached the server');
  await page.waitForFunction(() => document.querySelectorAll('#gallery img').length >= 20);
  await page.click('#gallery button[data-id]');
  await page.waitForSelector('#lightbox[open]');
  assert.match(await page.getAttribute('#lbLink', 'href'), /^https:\/\/drive\.google\.com\/file\/d\//);
  await page.click('#lightbox [data-close]');

  // resolve an issue
  await page.click('#paneSeg button[data-pane=today]');
  await page.click('#issueList button[data-id]');
  await page.waitForSelector('#resolveDlg[open]');
  await page.click('#resolveSeg button[data-status=טופל]');
  await page.fill('#resolveText', 'רוסס');
  await page.click('#resolveBtn');
  await page.waitForSelector('#resolveDlg[open]', { state: 'hidden' });
  server = await (await page.request.get(BASE + '__calls')).json();
  assert.ok(server.issues.some((i) => i['פתרון'] === 'רוסס'));

  // excel export downloads a real xlsx
  await page.click('.more summary');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#xlsBtn')]);
  assert.ok(!(await page.$('details.more[open]')), 'menu closes after an action');
  const xlsx = path.join(SHOTS, 'export.xlsx');
  await dl.saveAs(xlsx);
  assert.ok(fs.statSync(xlsx).size > 5000, 'xlsx has content');

  // 8. desktop layout + dark mode
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', colorScheme: 'dark', serviceWorkers: 'block' });
  await desk.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await desk.route('**/api.open-meteo.com/**', meteo);
  await desk.route('**/accounts.google.com/**', gsi);
  const dp = await desk.newPage();
  dp.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message));
  const callsBeforeDemo = (await (await dp.request.get(BASE + '__calls')).json()).calls.length;
  await dp.goto(BASE + '?demo');
  await skipIntro(dp);
  assert.match(await dp.textContent('#gateErr'), /מצב הדגמה/);
  await dp.fill('#gateCode', '9876');
  await dp.click('#gateForm button[type=submit]');
  await dp.waitForSelector('#whoDlg[open]');
  await dp.click('#whoList button:has-text("מאור")');
  await dp.click('.tabs button[data-tab=dash]');
  await dp.waitForSelector('#nowCard .main');
  await dp.waitForTimeout(700);
  await dp.screenshot({ path: path.join(SHOTS, '08-dash-desktop-dark.png'), fullPage: true });
  await dp.click('#rangeSeg button[data-range=all]');
  await dp.waitForTimeout(700);
  await dp.screenshot({ path: path.join(SHOTS, '09-dash-desktop-all.png'), fullPage: true });
  const demoCalls = await (await dp.request.get(BASE + '__calls')).json();
  assert.strictEqual(demoCalls.calls.length, callsBeforeDemo, 'demo mode never hit the server');
  await dp.goto(BASE + '?demo=off');
  await skipIntro(dp);
  await dp.waitForSelector('#gate:not([hidden])');
  assert.strictEqual(await dp.textContent('#gateErr'), '', 'leaving the demo shows the real code screen, not demo data');

  // 9. Google sign-in and the users screen
  const gp = await desk.newPage();
  gp.on('pageerror', (e) => errors.push('google pageerror: ' + e.message));
  await gp.goto(BASE);
  await skipIntro(gp);
  await gp.evaluate(() => { window.TEST_EMAIL = 'stranger@gmail.com'; });
  await gp.click('#gsiBtn');
  await gp.waitForSelector('#gateErr:has-text("stranger@gmail.com")');
  await gp.evaluate(() => { window.TEST_EMAIL = 'owner@gmail.com'; });
  await gp.click('#gsiBtn');
  await gp.waitForSelector('#app:not([hidden])');
  assert.ok(await gp.isHidden('#who'), 'the signed-in account reports, no worker picker');
  assert.match(await gp.textContent('#signOutBtn'), /מנהל/);
  await gp.waitForSelector('#nowCard .main');
  assert.ok(await gp.isHidden('#mgrForm'), 'a manager opens straight on the dashboard, without a code');
  await gp.click('#paneSeg button[data-pane=gh]');
  await gp.waitForSelector('#ghCards .gh');
  assert.match(await gp.textContent('#ghCards .gh .facts'), /90 צמחים.*50 מ"ר.*3 שורות.*נטיעה 2023/, 'Master Data on the greenhouse card');
  assert.strictEqual(await gp.getAttribute('.tabs button:first-child', 'data-tab'), 'dash', 'the dashboard is the first tab');
  await gp.click('.more summary');
  await gp.click('#usersBtn');
  await gp.waitForSelector('#uList li:has-text("gershon@gmail.com")');
  await gp.fill('#uEmail', 'Shahar@gmail.com');
  await gp.fill('#uName', 'שחר');
  await gp.click('#uRole button[data-v=manager]');
  await gp.click('#uAdd');
  await gp.waitForSelector('#uList li:has-text("shahar@gmail.com")');
  assert.strictEqual(await gp.inputValue('#uList select[data-role="shahar@gmail.com"]'), 'manager');
  await gp.selectOption('#uList select[data-role="shahar@gmail.com"]', 'worker');
  await gp.waitForTimeout(300);
  await gp.click('#uList [data-del="gershon@gmail.com"]');
  assert.strictEqual(await gp.textContent('#uList [data-del="gershon@gmail.com"]'), 'להסיר?', 'removing asks for a second tap');
  await gp.click('#uList [data-del="gershon@gmail.com"]');
  await gp.waitForSelector('#uList li:has-text("gershon@gmail.com")', { state: 'detached' });
  await gp.screenshot({ path: path.join(SHOTS, '10-users.png') });
  const u = (await (await gp.request.get(BASE + '__calls')).json());
  assert.deepStrictEqual(u.calls.filter((c) => /^user/.test(c)), ['users', 'userSet', 'userSet', 'userDel']);
  await gp.click('#usersDlg [data-close]');
  await gp.click('.tabs button[data-tab=report]');
  await gp.click('#signOutBtn');
  await gp.waitForSelector('#gate:not([hidden])');
  await gp.evaluate(() => { window.TEST_EMAIL = 'shahar@gmail.com'; });
  await gp.click('#gsiBtn');
  await gp.waitForSelector('#app:not([hidden])');
  assert.ok(await gp.isHidden('#dashTab'), 'a worker account has no dashboard tab');
  assert.ok(!(await gp.isHidden('#report')), 'a worker opens on the work screen');

  await browser.close();
  assert.deepStrictEqual(errors, [], errors.join('\n'));
  console.log('e2e ok');
})().catch((e) => { console.error(e); process.exit(1); });
