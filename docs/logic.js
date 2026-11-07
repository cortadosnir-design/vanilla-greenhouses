// Pure dashboard logic, shared by the browser (window.VG) and the node test (logic.test.js).
(function (root) {
  const DAY = 86400000;

  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

  // Tracked greenhouse works whose interval has passed since the last time they were logged for that greenhouse.
  function dueList(works, greenhouses, log, now) {
    const tracked = works.filter((w) => w.track && w.interval > 0 && w.location === 'חממה');
    const last = {};
    for (const r of log) {
      if (!r['תאריך']) continue;
      const k = r['חממה'] + '|' + r['קוד עבודה'];
      if (!(k in last) || r['תאריך'] > last[k]) last[k] = r['תאריך'];
    }
    const out = [];
    for (const g of greenhouses) {
      for (const w of tracked) {
        const done = last[g.name + '|' + w.code];
        const since = done == null ? null : daysBetween(done, now);
        if (since === null || since >= w.interval) {
          out.push({ gh: g.name, code: w.code, work: w.name, interval: w.interval, since, late: since === null ? Infinity : since - w.interval });
        }
      }
    }
    return out.sort((a, b) => b.late - a.late);
  }

  const inRange = (t, from, to) => t != null && t >= from && t <= to;

  function sumBy(rows, key, valueKey) {
    const m = {};
    for (const r of rows) {
      const k = r[key];
      if (k === '' || k == null) continue;
      m[k] = (m[k] || 0) + (Number(r[valueKey]) || 0);
    }
    return m;
  }

  function lastVisit(log, ghName) {
    let max = null;
    for (const r of log) if (r['חממה'] === ghName && r['תאריך'] && (max === null || r['תאריך'] > max)) max = r['תאריך'];
    return max;
  }

  function rangeStart(key, now) {
    if (key === 'all') return 0;
    return startOfDay(now) - (Number(key) - 1) * DAY;
  }

  function relDay(t, now) {
    if (t == null) return 'אף פעם';
    const d = daysBetween(t, now);
    if (d <= 0) return 'היום';
    if (d === 1) return 'אתמול';
    return 'לפני ' + d + ' ימים';
  }

  function hoursText(h) {
    const total = Math.round((Number(h) || 0) * 60);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function driveId(url) {
    const m = String(url || '').match(/\/d\/([\w-]+)/) || String(url || '').match(/[?&]id=([\w-]+)/);
    return m ? m[1] : null;
  }
  // a cell may hold several links, one per line
  function photoLinks(cell) {
    // the link is rebuilt from the file id, so a cell can never carry a javascript: or foreign URL
    return String(cell || '').split(/\s+/).map(driveId).filter(Boolean).map((id) => ({ id, url: 'https://drive.google.com/file/d/' + id + '/view' }));
  }

  const api = { DAY, startOfDay, daysBetween, dueList, inRange, sumBy, lastVisit, rangeStart, relDay, hoursText, driveId, photoLinks };
  if (typeof module !== 'undefined') module.exports = api;
  else root.VG = api;
})(this);
