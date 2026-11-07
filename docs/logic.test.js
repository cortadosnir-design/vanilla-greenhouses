// node site/logic.test.js
const assert = require('assert');
const VG = require('./logic.js');

const now = new Date(2026, 10, 7, 15, 0).getTime();
const day = (d) => new Date(2026, 10, d).getTime();
const greenhouses = [{ id: 'GH1', name: 'חממה 1' }, { id: 'GH2', name: 'חממה 2' }];
const works = [
  { code: 'W09', name: 'ניטור', interval: 7, track: true, location: 'חממה' },
  { code: 'W01', name: 'האבקה', interval: 1, track: false, location: 'חממה' },
  { code: 'W12', name: 'מיון', interval: 1, track: true, location: 'מחסן' },
];
const log = [
  { 'תאריך': day(5), 'חממה': 'חממה 1', 'קוד עבודה': 'W09', 'עובד': 'דנה', 'שעות': 1.5 },
  { 'תאריך': day(1), 'חממה': 'חממה 1', 'קוד עבודה': 'W09', 'עובד': 'דנה', 'שעות': 2 },
  { 'תאריך': day(1), 'חממה': 'חממה 2', 'קוד עבודה': 'W09', 'עובד': 'יוסי', 'שעות': '' },
];

const due = VG.dueList(works, greenhouses, log, now);
assert.deepStrictEqual(due, [], 'GH1 monitored 2 days ago, GH2 6 days ago: nothing due yet; W01 untracked, W12 not in a greenhouse');

const due8 = VG.dueList(works, greenhouses, log, new Date(2026, 10, 8, 9).getTime());
assert.deepStrictEqual(due8.map((d) => d.gh), ['חממה 2'], '7 days since = due');
assert.strictEqual(VG.dueList(works, [{ id: 'GH3', name: 'חממה 3' }], log, now)[0].late, Infinity, 'never done is most urgent');

assert.deepStrictEqual(VG.sumBy(log, 'עובד', 'שעות'), { 'דנה': 3.5, 'יוסי': 0 });
assert.strictEqual(VG.lastVisit(log, 'חממה 1'), day(5));
assert.strictEqual(VG.relDay(day(5), now), 'לפני 2 ימים');
assert.strictEqual(VG.relDay(null, now), 'אף פעם');
assert.strictEqual(VG.hoursText(1.75), '1:45');
assert.strictEqual(VG.rangeStart('7', now), day(1));
assert.strictEqual(VG.driveId('https://drive.google.com/file/d/AbC_12-x/view?usp=drivesdk'), 'AbC_12-x');
assert.deepStrictEqual(VG.photoLinks('https://drive.google.com/file/d/A1/view\nhttps://drive.google.com/file/d/B2/view').map((x) => x.id), ['A1', 'B2']);
assert.deepStrictEqual(VG.photoLinks(''), []);
assert.strictEqual(VG.photoLinks('javascript:alert(1)//\/d/X9').map((x) => x.url)[0], 'https://drive.google.com/file/d/X9/view', 'links rebuilt from the id');
console.log('logic ok');
