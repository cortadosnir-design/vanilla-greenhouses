/* מעקב חממות וניל — אפליקציית האתר. נתונים: Apps Script (config.js), מזג אוויר: Open-Meteo (weather.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const VG = window.VG, WX = window.WX;
  const CATEGORIES = ['מזיקים', 'מחלה', 'השקיה', 'אקלים', 'תשתית', 'אחר'];
  const SEVERITIES = ['נמוכה', 'בינונית', 'גבוהה'];
  const WAREHOUSE = 'מחסן';
  const LONG_SHIFT = 14 * 3600000; // a session older than this was probably never checked out

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('vg.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) {
      try { localStorage.setItem('vg.' + k, JSON.stringify(v)); return true; } catch (e) { toast('אין מספיק מקום במכשיר לשמירה'); return false; }
    },
    del(k) { try { localStorage.removeItem('vg.' + k); } catch (e) { /* ignore */ } },
  };

  const state = {
    code: store.get('code', ''),
    role: store.get('role', ''),
    boot: store.get('boot', null),
    worker: store.get('worker', ''),
    gh: store.get('gh', ''),
    active: store.get('active', null),
    shift: store.get('shift', null),
    dash: null,
    range: store.get('range', '30'),
    issue: { gh: '', cat: '', sev: 'בינונית' },
    upPhotos: [],
    upGh: '',
    weather: null,
  };

  // ---------- api ----------
  class NetError extends Error {}
  async function api(action, payload, code) {
    const body = Object.assign({ action, code: code || state.code }, payload);
    let j;
    if (window.DEMO_API) {
      j = await window.DEMO_API(body);
    } else {
      let res;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), action === 'checkOut' || action === 'issue' ? 60000 : 20000);
      try {
        // text/plain body keeps it a "simple" request, so Apps Script needs no CORS preflight
        res = await fetch(window.APP_CONFIG.apiUrl, { method: 'POST', body: JSON.stringify(body), signal: ctrl.signal });
      } catch (e) { throw new NetError('אין חיבור'); } finally { clearTimeout(timer); }
      // an HTML page means the deployment is misconfigured (access not "anyone") or the old script is still at this URL
      try { j = await res.json(); } catch (e) { throw new NetError('השרת החזיר דף במקום נתונים. לבדוק את הפריסה של Apps Script'); }
    }
    if (!j.ok) throw new Error(j.error || 'שגיאה');
    return j;
  }

  // offline queue: every write goes through it so nothing is lost without reception
  let flushing = false, flushAgain = false;
  // returns false (and keeps the screen as it was) when the phone has no room to store the report
  function queuePut(action, payload) {
    const q = store.get('queue', []);
    q.push({ action, payload });
    if (!store.set('queue', q)) return false;
    renderPending();
    return true;
  }
  function enqueue(action, payload) { return queuePut(action, payload) ? flush() : Promise.resolve(false); }
  // Re-reads the queue from storage after every send, so an item enqueued while a send is in flight is never overwritten.
  // A send the server rejects (not a network failure) is moved aside so it cannot block everything behind it.
  async function flush() {
    if (flushing) { flushAgain = true; return false; }
    flushing = true;
    let sentAll = true;
    try {
      do {
        flushAgain = false;
        for (;;) {
          const q = store.get('queue', []);
          if (!q.length) break;
          try {
            await api(q[0].action, q[0].payload);
          } catch (e) {
            if (e instanceof NetError) { sentAll = false; break; }
            const failed = store.get('failed', []);
            failed.push(Object.assign({ error: e.message, at: Date.now() }, q[0]));
            store.set('failed', failed.slice(-20));
            toast('השרת דחה דיווח: ' + esc(e.message));
          }
          const rest = store.get('queue', []);
          rest.shift();
          store.set('queue', rest);
        }
      } while (flushAgain && sentAll);
    } finally {
      flushing = false;
      renderPending();
    }
    return sentAll;
  }
  window.addEventListener('online', flush);

  // ---------- ui helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer;
  function toast(html) {
    const t = $('toast');
    t.innerHTML = html;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // "היום שלי": a per-device journal, so the worker sees the day even with no reception.
  // shortcut: lives on this phone only; switching phones mid-day starts a new journal.
  const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function journal(ev) {
    const j = store.get('journal', { day: '', items: [] });
    const day = dayKey(ev.t);
    const items = j.day === day ? j.items : [];
    items.push(ev);
    store.set('journal', { day, items: items.slice(-200) });
  }
  const todayItems = () => { const j = store.get('journal', { day: '', items: [] }); return j.day === dayKey(Date.now()) ? j.items.filter((e) => e.who === state.worker) : []; };
  const hhmm = (t) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');
  const fmtNum = (n) => Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 1 });
  const MAX_PHOTOS = 20;
  const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  // radio-like segmented controls and chips
  function radios(el, items, value, onPick) {
    el.innerHTML = items.map((it) => `<button type="button" role="radio" data-v="${esc(it.v)}" aria-checked="${it.v === value}">${esc(it.t)}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      onPick(b.dataset.v);
    };
  }
  function setChecked(el, attr, value) {
    el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === value)));
  }

  async function compress(file) {
    const img = await createImageBitmap(file);
    // 1024px at 0.62 is ~100-150 KB, so 20 photos fit in the offline queue
    const s = Math.min(1, 1024 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.62);
  }
  // multi-photo picker: list is the state array, strip shows thumbnails with a remove button each
  function photoInput(input, strip, label, list, onChange) {
    const draw = () => {
      label.textContent = list.length ? `תמונות ${list.length}/${MAX_PHOTOS}` : 'הוספת תמונות';
      strip.innerHTML = list.map((src, i) => `<span class="thumb"><img src="${src}" alt="תמונה ${i + 1}"><button type="button" data-i="${i}" aria-label="הסרת תמונה ${i + 1}">×</button></span>`).join('');
      strip.hidden = !list.length;
      input.disabled = list.length >= MAX_PHOTOS;
      onChange();
    };
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      input.value = '';
      const room = MAX_PHOTOS - list.length;
      if (files.length > room) toast(`אפשר עד ${MAX_PHOTOS} תמונות. נוספו ${room}`);
      for (const f of files.slice(0, room)) {
        try { list.push(await compress(f)); draw(); } catch (e) { toast('לא הצלחתי לקרוא אחת התמונות'); }
      }
    };
    strip.onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) { list.splice(Number(b.dataset.i), 1); draw(); } };
    draw();
    return { reset: (next) => { list = next; draw(); } };
  }
  // the record first, then one request per photo; written to the queue in a single step so nothing is half-saved
  function queueWithPhotos(action, payload, photos) {
    const items = [{ action, payload }].concat(photos.map((photo, idx) => ({ action: 'photo', payload: { id: payload.id, idx, photo } })));
    const q = store.get('queue', []).concat(items);
    if (!store.set('queue', q)) return false;
    renderPending();
    return true;
  }

  // ---------- gate ----------
  $('gateForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('gateCode').value.trim();
    $('gateErr').textContent = '';
    try {
      const j = await api('bootstrap', {}, code);
      Object.assign(state, { code, role: j.role, boot: j.data });
      store.set('code', code); store.set('role', j.role); store.set('boot', j.data);
      showApp();
    } catch (err) {
      $('gateErr').textContent = err instanceof NetError ? 'אין חיבור. נסה שוב כשיש קליטה.' : err.message;
    }
  };

  // ---------- tabs ----------
  function showTab(name) {
    const apply = () => {
      document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.tab === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
      document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== name));
      window.scrollTo(0, 0);
    };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !reduce) document.startViewTransition(apply); else apply();
    if (name === 'dash') openDash();
    if (name === 'issue') renderIssue();
  }
  document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };

  // ---------- worker picker ----------
  function pickWorker() {
    const list = (state.boot && state.boot.workers) || [];
    $('whoList').innerHTML = list.map((n) => `<li><button type="button" data-n="${esc(n)}">${esc(n)}</button></li>`).join('') || '<li class="empty">אין עובדים פעילים בגיליון</li>';
    $('whoDlg').showModal();
  }
  $('whoList').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.worker = b.dataset.n;
    store.set('worker', state.worker);
    $('whoDlg').close();
    renderReport();
  };
  $('who').onclick = () => { if (state.active || state.shift) toast('אפשר להחליף עובד אחרי היציאה מהעבודה'); else pickWorker(); };
  document.querySelectorAll('dialog [data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

  // ---------- report ----------
  const works = () => (state.boot && state.boot.works) || [];
  const ghs = () => (state.boot && state.boot.greenhouses) || [];
  const workBy = (code) => works().find((w) => w.code === code);

  function renderReport() {
    $('who').textContent = state.worker || 'מי מדווח?';
    renderWeatherStrip();
    renderShift();
    renderDay();
    renderMyTasks();
    if (state.active) return renderActive();
    $('idle').hidden = false;
    $('active').hidden = true;

    radios($('ghSeg'), ghs().map((g) => ({ v: g.id, t: g.name })), state.gh, (v) => { state.gh = v; store.set('gh', v); validateIn(); });

    const sel = $('workSel');
    const prev = sel.value;
    const groups = {};
    works().forEach((w) => (groups[w.category] = groups[w.category] || []).push(w));
    sel.innerHTML = '<option value="">בחירת עבודה</option>' + Object.keys(groups).map((c) =>
      `<optgroup label="${esc(c)}">${groups[c].map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join('')}</optgroup>`).join('');
    sel.value = prev;
    sel.onchange = validateIn;
    validateIn();
  }

  function validateIn() {
    if (state.gh && !ghs().some((g) => g.id === state.gh)) { state.gh = ''; store.del('gh'); radios($('ghSeg'), ghs().map((g) => ({ v: g.id, t: g.name })), '', (v) => { state.gh = v; store.set('gh', v); validateIn(); }); }
    const w = workBy($('workSel').value);
    const warehouse = w && w.location === WAREHOUSE;
    $('ghSeg').hidden = !!warehouse;
    $('inBtn').textContent = warehouse ? 'התחלת עבודה' : 'כניסה לחממה';
    $('inBtn').disabled = !w || (!warehouse && !state.gh);
  }

  $('inBtn').onclick = () => {
    if (!state.worker) return pickWorker();
    const w = workBy($('workSel').value);
    const warehouse = w.location === WAREHOUSE;
    const gh = warehouse ? { id: WAREHOUSE, name: WAREHOUSE } : ghs().find((g) => g.id === state.gh);
    if (!state.shift) startShift();
    const active = { id: uid('L'), gh: gh.id, ghName: gh.name, work: w.code, workName: w.name, unit: w.unit, start: Date.now() };
    state.active = active;
    store.set('active', active);
    journal({ t: active.start, who: state.worker, kind: 'in', id: active.id, gh: gh.name, work: w.name });
    enqueue('checkIn', { id: active.id, worker: state.worker, gh: gh.id, work: w.code, ts: active.start });
    renderReport();
  };

  let tick;
  function renderActive() {
    const a = state.active;
    $('idle').hidden = true;
    $('active').hidden = false;
    $('liveGh').textContent = a.ghName;
    $('liveWork').textContent = a.workName + (Date.now() - a.start > LONG_SHIFT ? ' · כניסה ב-' + fmtDate(a.start) + ', נראה ששכחת לצאת' : '');
    $('qtyRow').hidden = !a.unit;
    $('qtyUnit').textContent = a.unit ? 'כמה ' + a.unit + '?' : '';
    const draw = () => {
      const s = Math.max(0, Math.floor((Date.now() - a.start) / 1000));
      $('timer').textContent = Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    };
    draw();
    clearInterval(tick);
    tick = setInterval(draw, 1000);
  }

  $('outBtn').onclick = async () => {
    const a = state.active;
    const ts = Date.now();
    const payload = { id: a.id, ts, qty: $('qty').value, notes: $('notes').value.trim() };
    if (!queuePut('checkOut', payload)) { toast('אין מקום במכשיר'); return; }
    journal({ t: ts, who: state.worker, kind: 'out', id: a.id, gh: a.ghName, work: a.workName, mins: Math.round((ts - a.start) / 60000), qty: payload.qty, unit: a.unit, notes: payload.notes });
    clearInterval(tick);
    state.active = null;
    store.del('active');
    $('qty').value = '';
    $('notes').value = '';
    renderReport();
    const sent = await flush();
    const hrs = VG.hoursText((ts - a.start) / 3600000);
    toast(sent ? `היציאה נרשמה · ${hrs} שעות` : `היציאה נשמרה במכשיר · ${hrs} שעות`);
  };

  // ---------- attendance clock ----------
  function startShift() {
    const shift = { id: uid('S'), start: Date.now(), who: state.worker };
    if (!queuePut('shiftIn', { id: shift.id, worker: state.worker, ts: shift.start })) { toast('אין מקום במכשיר'); return false; }
    state.shift = shift;
    store.set('shift', shift);
    journal({ t: shift.start, who: state.worker, kind: 'start' });
    flush();
    return true;
  }
  $('shiftInBtn').onclick = () => {
    if (!state.worker) return pickWorker();
    if (startShift()) { renderReport(); toast('כניסה לעבודה נרשמה · ' + hhmm(state.shift.start)); }
  };
  $('shiftOutBtn').onclick = async () => {
    if (state.active) { toast('קודם צריך לצאת מהחממה'); return; }
    const sh = state.shift, ts = Date.now();
    if (!queuePut('shiftOut', { id: sh.id, ts })) { toast('אין מקום במכשיר'); return; }
    journal({ t: ts, who: sh.who, kind: 'end', mins: Math.round((ts - sh.start) / 60000) });
    state.shift = null;
    store.del('shift');
    renderReport();
    const sent = await flush();
    toast((sent ? 'יציאה מהעבודה נרשמה' : 'היציאה נשמרה במכשיר') + ' · ' + VG.hoursText((ts - sh.start) / 3600000) + ' שעות היום');
  };

  let shiftTick;
  function renderShift() {
    const sh = state.shift;
    $('shiftOff').hidden = !!sh || !!state.active;
    $('shiftOn').hidden = !sh;
    clearInterval(shiftTick);
    if (!sh) return;
    const long = Date.now() - sh.start > LONG_SHIFT;
    $('shiftStart').textContent = hhmm(sh.start) + (dayKey(sh.start) !== dayKey(Date.now()) ? ' (' + fmtDate(sh.start) + ')' : '') + (long ? ' · שכחת לצאת?' : '');
    const draw = () => { $('shiftTimer').textContent = VG.hoursText((Date.now() - sh.start) / 3600000); };
    draw();
    shiftTick = setInterval(draw, 30000);
  }

  function renderDay() {
    const items = todayItems();
    const inGh = items.filter((e) => e.kind === 'out').reduce((a, e) => a + e.mins, 0);
    const n = items.filter((e) => e.kind === 'out').length;
    $('daySum').textContent = n ? `${n} עבודות · ${VG.hoursText(inGh / 60)} בחממות` : '';
    const rows = items.filter((e) => e.kind !== 'in' || !items.some((o) => o.kind === 'out' && o.id === e.id)).map((e) => {
      const t = `<time>${hhmm(e.kind === 'out' ? e.t - e.mins * 60000 : e.t)}</time>`;
      switch (e.kind) {
        case 'start': return `<li>${t}<div class="ev start"><strong>כניסה לעבודה</strong></div></li>`;
        case 'end': return `<li>${t}<div class="ev end"><strong>יציאה מהעבודה</strong><span class="sub">${VG.hoursText(e.mins / 60)} שעות היום</span></div></li>`;
        case 'in': return `<li>${t}<div class="ev now"><strong>${esc(e.work)}</strong><span class="sub">${esc(e.gh)} · עכשיו</span></div></li>`;
        case 'out': {
          const bits = [esc(e.gh), hhmm(e.t - e.mins * 60000) + '–' + hhmm(e.t), VG.hoursText(e.mins / 60)];
          if (e.qty !== '' && e.qty != null) bits.push(esc(e.qty) + ' ' + esc(e.unit || ''));
          return `<li>${t}<div class="ev"><strong>${esc(e.work)}</strong><span class="sub">${bits.map((b) => `<bdi class="nw">${b}</bdi>`).join(' · ')}</span>${e.notes ? `<span class="sub">${esc(e.notes)}</span>` : ''}</div></li>`;
        }
        case 'issue': return `<li>${t}<div class="ev issue"><strong>דיווח בעיה: ${esc(e.cat)}</strong><span class="sub">${esc(e.gh || '')} · חומרה ${esc(e.sev)}</span></div></li>`;
        default: return '';
      }
    });
    $('dayList').innerHTML = rows.join('') || '<li><span class="empty">עוד לא נרשמה פעולה היום</span></li>';
  }

  function renderPending() {
    const n = store.get('queue', []).length;
    $('pending').hidden = !n;
    $('pending').textContent = (n === 1 ? 'דיווח אחד ממתין לשליחה' : `${n} דיווחים ממתינים לשליחה`) + ' · יישלח לבד כשתהיה קליטה';
  }

  // ---------- install ----------
  let installEvent = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('installBtn').hidden = false; });
  if (isIOS && !standalone) $('installBtn').hidden = false;
  $('installBtn').onclick = async () => {
    if (installEvent) { installEvent.prompt(); const r = await installEvent.userChoice; if (r.outcome === 'accepted') $('installBtn').hidden = true; installEvent = null; }
    else $('installDlg').showModal();
  };

  // ---------- weather ----------
  async function weather() {
    if (state.weather) return state.weather;
    state.weather = await WX.fetchWeather();
    return state.weather;
  }
  async function renderWeatherStrip() {
    const el = $('wxStrip');
    try {
      const w = await weather();
      const c = w.current, d = WX.describe(c.weather_code, c.is_day);
      const al = WX.alerts(w);
      el.innerHTML = `${WX.icon(d.kind)}<span><strong>${Math.round(c.temperature_2m)}°</strong> ${esc(d.text)} · לחות ${c.relative_humidity_2m}% · היום ${Math.round(w.daily.temperature_2m_min[0])}° עד ${Math.round(w.daily.temperature_2m_max[0])}°</span>${al.some((a) => a.level === 'danger') ? '<span class="alert-dot" title="יש אזהרה בדשבורד"></span>' : ''}`;
      el.hidden = false;
    } catch (e) { el.hidden = true; }
  }
  async function renderWeatherCard() {
    const el = $('wxCard');
    try {
      const w = await weather();
      const c = w.current, now = WX.describe(c.weather_code, c.is_day), d = w.daily;
      const al = WX.alerts(w);
      el.innerHTML = `
        <div class="wx-now">${WX.icon(now.kind)}
          <div><div class="temp">${Math.round(c.temperature_2m)}<sup>°</sup></div>
            <div class="place">קיבוץ שניר · ${esc(now.text)}</div>
            <div class="meta">לחות ${c.relative_humidity_2m}% · רוח ${Math.round(c.wind_speed_10m)} קמ"ש · היום ${Math.round(d.temperature_2m_min[0])}° עד ${Math.round(d.temperature_2m_max[0])}°</div></div>
        </div>
        ${al.length ? `<div class="wx-alerts">${al.map((a) => `<div class="${a.level}">${esc(a.text)}</div>`).join('')}</div>` : ''}
        <div class="wx-days">${d.time.map((t, i) => {
          const dd = WX.describe(d.weather_code[i], 1);
          const rain = d.precipitation_probability_max[i] >= 30 ? `${d.precipitation_probability_max[i]}%` : '';
          return `<div class="wx-day" title="${esc(dd.text)}"><span class="nm">${i === 0 ? 'היום' : DAY_NAMES[new Date(t + 'T12:00').getDay()]}</span>${WX.icon(dd.kind)}<span class="hi">${Math.round(d.temperature_2m_max[i])}°</span><span>${Math.round(d.temperature_2m_min[i])}°</span><span class="rain">${rain}</span></div>`;
        }).join('')}</div>
        <div class="wx-foot">תחזית ${w.model === 'ecmwf_ifs025' ? 'ECMWF, המודל שנמדד כמדויק ביותר לשניר' : 'Open-Meteo'} · מתעדכן כל חצי שעה</div>`;
      el.hidden = false;
    } catch (e) { el.hidden = true; }
  }

  // ---------- issue ----------
  function renderIssue() {
    const s = state.issue;
    if (!s.gh) s.gh = state.gh;
    radios($('issueGh'), ghs().map((g) => ({ v: g.id, t: g.name })), s.gh, (v) => { s.gh = v; validateIssue(); });
    radios($('issueCat'), CATEGORIES.map((c) => ({ v: c, t: c })), s.cat, (v) => { s.cat = v; validateIssue(); });
    radios($('issueSev'), SEVERITIES.map((c) => ({ v: c, t: 'חומרה ' + c })), s.sev, (v) => { s.sev = v; });
    validateIssue();
  }
  function validateIssue() {
    const s = state.issue;
    $('issueBtn').disabled = !(s.gh && s.cat && $('issueDesc').value.trim());
  }
  $('issueDesc').oninput = validateIssue;

  $('issueBtn').onclick = async () => {
    if (!state.worker) return pickWorker();
    const s = state.issue;
    const payload = { id: uid('B'), ts: Date.now(), gh: s.gh, worker: state.worker, category: s.cat, severity: s.sev, desc: $('issueDesc').value.trim() };
    if (!queuePut('issue', payload)) { toast('אין מקום במכשיר'); return; }
    journal({ t: payload.ts, who: state.worker, kind: 'issue', gh: (ghs().find((g) => g.id === s.gh) || {}).name, cat: s.cat, sev: s.sev });
    state.issue = { gh: s.gh, cat: '', sev: 'בינונית' };
    $('issueDesc').value = '';
    renderIssue();
    const sent = await flush();
    toast(sent ? 'הבעיה נשלחה' : 'הבעיה נשמרה במכשיר ותישלח כשתהיה קליטה');
  };

  // ---------- dashboard ----------
  function openDash() {
    const isMgr = state.role === 'manager';
    $('mgrForm').hidden = isMgr;
    $('dashBody').hidden = !isMgr || !state.dash;
    if (isMgr) loadDash();
  }
  $('mgrForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('mgrCode').value.trim();
    $('mgrErr').textContent = '';
    try {
      const j = await api('bootstrap', {}, code);
      if (j.role !== 'manager') { $('mgrErr').textContent = 'זה קוד עובדים, לא קוד מנהל'; return; }
      Object.assign(state, { code, role: 'manager', boot: j.data });
      store.set('code', code); store.set('role', 'manager'); store.set('boot', j.data);
      $('mgrCode').value = '';
      openDash();
    } catch (err) { $('mgrErr').textContent = err.message; }
  };

  async function loadDash() {
    $('refreshBtn').disabled = true;
    renderWeatherCard();
    try {
      const j = await api('dashboard', {});
      state.dash = j.data;
      $('dashBody').hidden = false;
      renderDash();
    } catch (e) {
      toast(e instanceof NetError ? 'אין חיבור לשרת' : esc(e.message));
    } finally { $('refreshBtn').disabled = false; }
  }
  $('refreshBtn').onclick = () => { state.weather = null; store.del('weather'); loadDash(); };

  $('rangeSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.range = b.dataset.range;
    store.set('range', state.range);
    renderDash();
  };

  function rangeRows() {
    const now = Date.now();
    const from = VG.rangeStart(state.range, now);
    const d = state.dash;
    const len = state.range === 'all' ? 0 : now - from;
    return {
      from, to: now,
      log: d.log.filter((r) => VG.inRange(r['תאריך'], from, now)),
      issues: d.issues.filter((r) => VG.inRange(r['תאריך'], from, now)),
      // the same-length window just before this one, for comparisons
      prevLog: len ? d.log.filter((r) => VG.inRange(r['תאריך'], from - len, from - 1)) : [],
      prevIssues: len ? d.issues.filter((r) => VG.inRange(r['תאריך'], from - len, from - 1)) : [],
    };
  }

  function renderDash() {
    const d = state.dash;
    if (!d) return;
    const now = Date.now();
    setChecked($('rangeSeg'), 'range', state.range);
    const R = rangeRows();
    const due = VG.dueList(d.works, d.greenhouses, d.log, now);
    const openIssues = d.issues.filter((r) => r['סטטוס'] !== 'טופל');
    const hoursByGh = VG.sumBy(R.log, 'חממה', 'שעות');

    $('ghCards').innerHTML = d.greenhouses.map((g) => {
      const late = due.filter((x) => x.gh === g.name).length;
      const iss = openIssues.filter((r) => r['חממה'] === g.name).length;
      return `<div class="gh"><h3>${esc(g.name)}</h3><dl>
        <dt>טיפול אחרון</dt><dd>${VG.relDay(VG.lastVisit(d.log, g.name), now)}</dd>
        <dt>עבודות שמגיעות</dt><dd class="${late ? 'late' : ''}">${late}</dd>
        <dt>בעיות פתוחות</dt><dd class="${iss ? 'late' : ''}">${iss}</dd>
        <dt>שעות</dt><dd>${VG.hoursText(hoursByGh[g.name] || 0)}</dd></dl></div>`;
    }).join('');

    renderCompare(R, d);
    renderPresence(d, now);
    renderUpload(d);
    renderTasks();
    renderSystem(d.system || {});

    $('dueList').innerHTML = due.slice(0, 12).map((x) =>
      `<li><div class="main">${esc(x.work)}<div class="sub">${esc(x.gh)} · ${x.since === null ? 'לא בוצע מעולם' : 'בוצע ' + VG.relDay(now - x.since * VG.DAY, now) + ', כל ' + x.interval + ' ימים'}</div></div>
       ${x.late === Infinity ? '<span class="pill late">מעולם לא</span>' : x.late > 0 ? `<span class="pill late">באיחור ${x.late} ימים</span>` : '<span class="pill doing">היום</span>'}</li>`).join('')
      || '<li class="empty">הכול בזמן</li>';

    const issues = d.issues.slice().sort((a, b) => (a['סטטוס'] === 'טופל') - (b['סטטוס'] === 'טופל') || b['תאריך'] - a['תאריך']).slice(0, 15);
    const pillClass = { 'פתוח': 'open', 'בטיפול': 'doing', 'טופל': 'done' };
    $('issueList').innerHTML = issues.map((r) => {
      const age = r['סטטוס'] === 'טופל' ? '' : ' · פתוח ' + VG.daysBetween(r['תאריך'], now) + ' ימים';
      return `<li><button type="button" class="main" data-id="${esc(r['מזהה'])}">${esc(r['קטגוריה'])} · ${esc(r['חממה'])}<div class="sub">${esc(r['תיאור'] || '')} · ${fmtDate(r['תאריך'])}${age}</div></button>
       <span class="pill ${pillClass[r['סטטוס']] || 'open'}">${esc(r['סטטוס'] || 'פתוח')}</span></li>`;
    }).join('') || '<li class="empty">אין בעיות</li>';

    const byWorker = Object.entries(VG.sumBy(R.log, 'עובד', 'שעות')).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...byWorker.map((x) => x[1]));
    $('workerBars').innerHTML = byWorker.map(([n, h]) =>
      `<div class="row" role="img" aria-label="${esc(n)}: ${VG.hoursText(h)} שעות"><span>${esc(n)}</span><div class="track"><div class="fill" style="width:${(h / max) * 100}%"></div></div><span class="val">${VG.hoursText(h)}</span></div>`).join('')
      || '<p class="empty">אין שעות בטווח הזה</p>';

    const qty = (rows, code) => rows.filter((r) => r['קוד עבודה'] === code).reduce((a, r) => a + (Number(r['כמות']) || 0), 0);
    $('yield').innerHTML = [['W01', 'פרחים הואבקו'], ['W11', 'תרמילים נקטפו'], ['W12', 'ק"ג מוינו']].map(([c, t]) => {
      const cur = qty(R.log, c), prev = qty(R.prevLog, c);
      return `<div><strong>${fmtNum(cur)}</strong><span>${t}</span>${R.prevLog.length || prev ? `<span class="delta ${cur > prev ? 'up' : cur < prev ? 'down' : 'flat'}">${deltaText(cur, prev)}</span>` : ''}</div>`;
    }).join('');

    fillFilter($('fGh'), 'כל החממות', d.greenhouses.map((g) => g.name).concat(R.log.some((r) => r['חממה'] === WAREHOUSE) ? [WAREHOUSE] : []));
    fillFilter($('fWorker'), 'כל העובדים', Array.from(new Set(d.log.map((r) => r['עובד']).filter(Boolean))));
    renderLog();

    const sets = (d.photos || []).filter((r) => VG.inRange(r['תאריך'], R.from, R.to));
    const photos = sets.concat(R.log, R.issues).sort((a, b) => b['תאריך'] - a['תאריך'])
      .flatMap((r) => VG.photoLinks(r['תמונה']).map((p) => ({ r, p }))).slice(0, 48);
    $('photoGrid').innerHTML = photos.map(({ r, p }) =>
      `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img loading="lazy" src="${window.DEMO_API ? 'icons/icon.svg' : 'https://drive.google.com/thumbnail?id=' + p.id + '&sz=w400'}" alt="${esc((r['חממה'] || '') + ' ' + fmtDate(r['תאריך']))}"></a>`).join('')
      || '<p class="empty">אין תמונות בטווח הזה</p>';
  }

  // ---------- backup status ----------
  function renderSystem(s) {
    const bits = [];
    if (s.lastBackup) {
      const h = (Date.now() - s.lastBackup) / 3600000;
      const when = h < 1 ? 'לפני פחות משעה' : h < 24 ? 'לפני ' + Math.round(h) + ' שעות' : 'לפני ' + Math.round(h / 24) + ' ימים';
      bits.push(h > 48 ? `<span class="warn">גיבוי אחרון ${when}</span>` : 'גיבוי אחרון ' + when);
    } else bits.push('<span class="warn">עוד לא נעשה גיבוי</span>');
    if (!s.secondOwner) bits.push('<span class="warn">אין בעלים שני</span>');
    if (s.driveUsed != null && s.driveLimit) {
      const pct = s.driveUsed / s.driveLimit;
      const gb = (n) => (n / 1073741824).toLocaleString('he-IL', { maximumFractionDigits: 1 });
      const txt = `Drive ${gb(s.driveUsed)} מתוך ${gb(s.driveLimit)} GB`;
      bits.push(pct > 0.8 ? `<span class="warn">${txt}</span>` : txt);
    }
    $('sysLine').innerHTML = bits.join(' · ');
  }
  $('backupBtn').onclick = async () => {
    $('backupBtn').disabled = true;
    toast('מגבה…');
    try {
      const j = await api('backup', {});
      state.dash.system = Object.assign({}, state.dash.system, { lastBackup: j.data.at });
      renderSystem(state.dash.system);
      toast(`הגיבוי נשמר · <a href="${esc(j.data.url)}" target="_blank" rel="noopener">פתיחה</a>`);
    } catch (e) { toast(e instanceof NetError ? 'אין חיבור לשרת' : esc(e.message)); } finally { $('backupBtn').disabled = false; }
  };

  // ---------- future tasks ----------
  const isoDay = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const openTasks = (list) => (list || []).filter((t) => t['סטטוס'] !== 'בוצע').sort((a, b) => a['תאריך ביצוע'] - b['תאריך ביצוע']);
  function dueText(t) {
    const d = VG.daysBetween(Date.now(), t);
    if (d < 0) return { cls: 'late', text: 'באיחור ' + -d + ' ימים' };
    if (d === 0) return { cls: 'doing', text: 'היום' };
    if (d === 1) return { cls: 'flat', text: 'מחר' };
    return { cls: 'flat', text: fmtDate(t) };
  }
  const taskRow = (t, withDone) => {
    const due = dueText(t['תאריך ביצוע']);
    return `<li><div class="main">${esc(t['משימה'])}<div class="sub">${esc(t['חממה'] || '')}${t['עובד'] ? ' · ' + esc(t['עובד']) : ''}</div></div>
      <span class="pill ${due.cls}">${due.text}</span>${withDone ? `<button type="button" class="btn" data-done="${esc(t['מזהה'])}">בוצע</button>` : ''}</li>`;
  };
  let tGh = '';
  function renderTasks() {
    const d = state.dash;
    const open = openTasks(d.tasks);
    $('tasksCount').textContent = open.length;
    $('tasksCount').hidden = !open.length;
    if (!$('tasksDlg').open) return;
    if (!tGh || !d.greenhouses.some((g) => g.id === tGh)) tGh = (d.greenhouses[0] || {}).id || '';
    radios($('tGh'), d.greenhouses.map((g) => ({ v: g.id, t: g.name })), tGh, (v) => { tGh = v; });
    if (!$('tWork').options.length) {
      $('tWork').innerHTML = '<option value="">בחירת עבודה</option>' + d.works.map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join('');
      $('tWorker').innerHTML = '<option value="">כל עובד</option>' + d.workers.map((n) => `<option>${esc(n)}</option>`).join('');
    }
    if (!$('tDate').value) $('tDate').value = isoDay(Date.now() + VG.DAY);
    validateTask();
    $('tList').innerHTML = open.map((t) => taskRow(t, true)).join('') || '<li class="empty">אין משימות פתוחות</li>';
  }
  function validateTask() { $('tAdd').disabled = !(($('tWork').value || $('tText').value.trim()) && $('tDate').value); }
  $('tWork').onchange = validateTask;
  $('tText').oninput = validateTask;
  $('tDate').onchange = validateTask;
  $('tasksBtn').onclick = () => { $('tasksDlg').showModal(); renderTasks(); };
  $('tAdd').onclick = async () => {
    const w = state.dash.works.find((x) => x.code === $('tWork').value);
    const [y, m, dd] = $('tDate').value.split('-').map(Number);
    const task = { id: uid('T'), gh: tGh, work: w ? w.code : '', text: $('tText').value.trim() || (w ? w.name : ''), due: new Date(y, m - 1, dd, 12).getTime(), worker: $('tWorker').value };
    $('tAdd').disabled = true;
    try {
      await api('taskAdd', task);
      state.dash.tasks = (state.dash.tasks || []).concat([{ 'מזהה': task.id, 'תאריך ביצוע': task.due, 'חממה': (state.dash.greenhouses.find((g) => g.id === tGh) || {}).name, 'משימה': task.text, 'קוד עבודה': task.work, 'עובד': task.worker, 'סטטוס': 'פתוח' }]);
      $('tText').value = '';
      $('tWork').value = '';
      renderTasks();
      toast('המשימה נוספה');
    } catch (e) { toast(esc(e.message)); validateTask(); }
  };
  async function markDone(id, list) {
    try {
      await api('taskDone', { id, by: state.worker });
      const t = (list || []).find((x) => x['מזהה'] === id);
      if (t) t['סטטוס'] = 'בוצע';
      toast('סומן כבוצע');
      return true;
    } catch (e) { toast(e instanceof NetError ? 'אין חיבור. נסה שוב כשיש קליטה' : esc(e.message)); return false; }
  }
  $('tList').onclick = async (e) => { const b = e.target.closest('[data-done]'); if (b && await markDone(b.dataset.done, state.dash.tasks)) renderTasks(); };

  // a worker sees open tasks for them (or for anyone) in the coming week
  function renderMyTasks() {
    const list = openTasks(state.boot && state.boot.tasks).filter((t) => (!t['עובד'] || t['עובד'] === state.worker) && VG.daysBetween(Date.now(), t['תאריך ביצוע']) <= 7);
    $('myTasks').hidden = !list.length;
    $('myTasksList').innerHTML = list.map((t) => taskRow(t, true)).join('');
  }
  $('myTasksList').onclick = async (e) => { const b = e.target.closest('[data-done]'); if (b && await markDone(b.dataset.done, state.boot.tasks)) { store.set('boot', state.boot); renderMyTasks(); } };

  // ---------- manager photo upload ----------
  const upPicker = photoInput($('upPhoto'), $('upThumbs'), $('upPhotoLabel'), state.upPhotos, () => validateUpload());
  function validateUpload() { $('upBtn').disabled = !(state.upGh && $('upDate').value && state.upPhotos.length); }
  function renderUpload(d) {
    if (!state.upGh || !d.greenhouses.some((g) => g.id === state.upGh)) state.upGh = (d.greenhouses[0] || {}).id || '';
    radios($('upGh'), d.greenhouses.map((g) => ({ v: g.id, t: g.name })), state.upGh, (v) => { state.upGh = v; validateUpload(); });
    if (!$('upDate').value) $('upDate').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    validateUpload();
  }
  $('upDate').onchange = validateUpload;
  $('upBtn').onclick = async () => {
    const n = state.upPhotos.length;
    const [y, m, dd] = $('upDate').value.split('-').map(Number);
    const payload = { id: uid('P'), gh: state.upGh, date: new Date(y, m - 1, dd, 12).getTime(), note: $('upNote').value.trim(), by: state.worker || 'מנהל' };
    if (!queueWithPhotos('photoSet', payload, state.upPhotos)) { toast('אין מקום במכשיר לכל התמונות. הסר כמה ונסה שוב'); return; }
    state.upPhotos = [];
    upPicker.reset(state.upPhotos);
    $('upNote').value = '';
    $('upBtn').disabled = true;
    toast(`מעלה ${n} תמונות…`);
    const sent = await flush();
    toast(sent ? `${n} תמונות הועלו` : `${n} תמונות נשמרו ויעלו כשתהיה קליטה`);
    if (sent) loadDash();
  };

  function renderPresence(d, now) {
    const att = (d.attendance || []).filter((r) => r['תאריך'] && VG.daysBetween(r['תאריך'], now) === 0 || r['סטטוס'] === 'פתוח');
    const inside = d.log.filter((r) => r['סטטוס'] === 'פתוח');
    $('presence').innerHTML = att.sort((a, b) => a['כניסה'] - b['כניסה']).map((r) => {
      const open = r['סטטוס'] === 'פתוח';
      const where = inside.find((x) => x['עובד'] === r['עובד']);
      const hrs = open ? (now - r['כניסה']) / 3600000 : Number(r['שעות']) || 0;
      return `<li><div class="main">${esc(r['עובד'])}<div class="sub">${hhmm(r['כניסה'])}–${open ? 'עכשיו' : hhmm(r['יציאה'])} · ${VG.hoursText(hrs)}${where ? ' · ' + esc(where['חממה']) + ': ' + esc(where['עבודה'] || '') : ''}</div></div>
        <span class="pill ${open ? 'done' : 'flat'}">${open ? (hrs * 3600000 > LONG_SHIFT ? 'שכח לצאת?' : 'בעבודה') : 'סיים'}</span></li>`;
    }).join('') || '<li class="empty">אף אחד לא נכנס היום</li>';
  }

  const deltaText = (cur, prev) => (cur === prev ? 'ללא שינוי' : (cur > prev ? '+' : '') + fmtNum(cur - prev));

  // greenhouse vs greenhouse for the range, each number with its change against the previous window
  function renderCompare(R, d) {
    const rowsFor = (log, issues) => d.greenhouses.map((g) => {
      const mine = log.filter((r) => r['חממה'] === g.name);
      const q = (c) => mine.filter((r) => r['קוד עבודה'] === c).reduce((a, r) => a + (Number(r['כמות']) || 0), 0);
      return { gh: g.name, last: mine.reduce((m, r) => Math.max(m, r['תאריך'] || 0), 0), hours: mine.reduce((a, r) => a + (Number(r['שעות']) || 0), 0), visits: mine.length, flowers: q('W01'), pods: q('W11'), issues: issues.filter((r) => r['חממה'] === g.name).length };
    });
    const cur = rowsFor(R.log, R.issues), prev = rowsFor(R.prevLog, R.prevIssues);
    const hasPrev = state.range !== 'all';
    const keys = ['hours', 'visits', 'flowers', 'pods', 'issues'];
    const best = {};
    keys.forEach((k) => { best[k] = Math.max(...cur.map((r) => r[k])); });
    const cell = (k, r, p) => {
      const v = k === 'hours' ? VG.hoursText(r[k]) : fmtNum(r[k]);
      const diff = r[k] - p[k];
      const cls = k === 'issues' ? (diff > 0 ? 'down' : diff < 0 ? 'up' : 'flat') : (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
      const dt = k === 'hours' ? (diff === 0 ? 'ללא שינוי' : (diff > 0 ? '+' : '-') + VG.hoursText(Math.abs(diff))) : deltaText(r[k], p[k]);
      return `<td class="num ${r[k] === best[k] && r[k] > 0 ? 'best' : ''}">${v}${hasPrev ? `<span class="delta ${cls}">${dt}</span>` : ''}</td>`;
    };
    $('compareBody').innerHTML = cur.map((r, i) => `<tr><td>${esc(r.gh)}</td><td class="num">${r.last ? fmtDate(r.last) : '–'}</td>${keys.map((k) => cell(k, r, prev[i])).join('')}</tr>`).join('');
    const labels = { 7: 'השבוע מול השבוע שלפניו', 30: '30 הימים האחרונים מול 30 הימים שלפניהם', 365: 'השנה האחרונה מול השנה שלפניה' };
    $('compareNote').textContent = hasPrev ? labels[state.range] + '. הערך הגבוה בכל עמודה מודגש.' : 'כל התקופה. הערך הגבוה בכל עמודה מודגש.';
  }

  function fillFilter(sel, all, values) {
    const v = sel.value;
    sel.innerHTML = `<option value="">${all}</option>` + values.map((x) => `<option>${esc(x)}</option>`).join('');
    sel.value = values.includes(v) ? v : '';
  }
  function renderLog() {
    const R = rangeRows();
    const gh = $('fGh').value, w = $('fWorker').value;
    const rows = R.log.filter((r) => (!gh || r['חממה'] === gh) && (!w || r['עובד'] === w))
      .sort((a, b) => (b['כניסה'] || b['תאריך']) - (a['כניסה'] || a['תאריך'])).slice(0, 200);
    $('logBody').innerHTML = rows.map((r) => `<tr>
      <td>${fmtDate(r['תאריך'])}</td><td>${esc(r['עובד'])}</td><td>${esc(r['חממה'])}</td>
      <td>${esc(r['עבודה'] || r['קוד עבודה'] || '')}${r['סטטוס'] === 'פתוח' ? ' <span class="pill doing">בחממה</span>' : ''}</td>
      <td class="num">${r['שעות'] === '' || r['שעות'] == null ? '' : VG.hoursText(r['שעות'])}</td>
      <td class="num">${r['כמות'] === '' || r['כמות'] == null ? '' : esc(r['כמות']) + ' ' + esc(r['יחידה'] || '')}</td>
      <td>${VG.photoLinks(r['תמונה']).map((p, i) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${i + 1}</a>`).join(' ')}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">אין רשומות</td></tr>';
  }
  $('fGh').onchange = renderLog;
  $('fWorker').onchange = renderLog;

  // resolve issue sheet
  let resolving = null;
  $('issueList').onclick = (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    resolving = state.dash.issues.find((r) => String(r['מזהה']) === b.dataset.id);
    if (!resolving) return;
    $('resolveTitle').textContent = `${resolving['קטגוריה']} · ${resolving['חממה']}`;
    $('resolveDesc').textContent = resolving['תיאור'] || '';
    setChecked($('resolveSeg'), 'status', resolving['סטטוס'] || 'פתוח');
    $('resolveText').value = resolving['פתרון'] || '';
    $('resolveDlg').showModal();
  };
  $('resolveSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setChecked($('resolveSeg'), 'status', b.dataset.status); };
  $('resolveBtn').onclick = async () => {
    const status = ($('resolveSeg').querySelector('[aria-checked="true"]') || {}).dataset ? $('resolveSeg').querySelector('[aria-checked="true"]').dataset.status : 'פתוח';
    $('resolveBtn').disabled = true;
    try {
      await api('resolveIssue', { id: resolving['מזהה'], status, solution: $('resolveText').value.trim(), by: state.worker });
      Object.assign(resolving, { 'סטטוס': status, 'פתרון': $('resolveText').value.trim() });
      $('resolveDlg').close();
      renderDash();
      toast('הבעיה עודכנה');
    } catch (e) { toast(esc(e.message)); } finally { $('resolveBtn').disabled = false; }
  };

  // ---------- exports ----------
  function loadScript(src) {
    return new Promise((ok, fail) => {
      if (document.querySelector(`script[src="${src}"]`)) return ok();
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error('לא הצלחתי לטעון את רכיב הייצוא'));
      document.head.appendChild(s);
    });
  }
  // ExcelJS writes Date in UTC; shift so the sheet shows Israel local time
  const xlDate = (t) => { if (!t) return null; const d = new Date(t); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes())); };

  $('xlsBtn').onclick = async () => {
    $('xlsBtn').disabled = true;
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
      const d = state.dash, R = rangeRows();
      const wb = new window.ExcelJS.Workbook();
      wb.creator = 'חממות וניל';
      const head = (ws, cols) => {
        ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
        ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width, style: { font: { name: 'Arial', size: 11 }, numFmt: fmt, alignment: { horizontal: 'right', vertical: 'top', wrapText: key === 'notes' } } }));
        const r = ws.getRow(1);
        r.height = 26;
        r.eachCell((c) => { c.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E6B4F' } }; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
      };
      const band = (ws) => ws.eachRow((row, i) => { if (i > 1 && i % 2 === 0) row.eachCell({ includeEmpty: true }, (c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF4EF' } })); });

      const sum = wb.addWorksheet('סיכום');
      head(sum, [['חממה', 'gh', 14], ['שעות עבודה', 'h', 13, '0.00'], ['ביקורים', 'n', 10], ['פרחים שהואבקו', 'p', 15], ['תרמילים שנקטפו', 'k', 15], ['בעיות פתוחות', 'i', 13], ['טיפול אחרון', 'last', 13, 'dd/mm/yyyy']]);
      d.greenhouses.forEach((g) => {
        const mine = R.log.filter((r) => r['חממה'] === g.name);
        const q = (c) => mine.filter((r) => r['קוד עבודה'] === c).reduce((a, r) => a + (Number(r['כמות']) || 0), 0);
        sum.addRow({ gh: g.name, h: mine.reduce((a, r) => a + (Number(r['שעות']) || 0), 0), n: mine.length, p: q('W01'), k: q('W11'),
          i: d.issues.filter((r) => r['חממה'] === g.name && r['סטטוס'] !== 'טופל').length, last: xlDate(VG.lastVisit(d.log, g.name)) });
      });
      const totalRow = sum.addRow({ gh: 'סה"כ' });
      const n = d.greenhouses.length + 1;
      ['B', 'C', 'D', 'E', 'F'].forEach((c) => (totalRow.getCell(c).value = { formula: `SUM(${c}2:${c}${n})` }));
      totalRow.font = { name: 'Arial', bold: true };
      totalRow.getCell('B').numFmt = '0.00';

      const ws = wb.addWorksheet('יומן עבודה');
      head(ws, [['תאריך', 'date', 12, 'dd/mm/yyyy'], ['עובד', 'worker', 14], ['חממה', 'gh', 11], ['קוד', 'code', 8], ['עבודה', 'work', 30], ['קטגוריה', 'cat', 16],
        ['כניסה', 'in', 9, 'hh:mm'], ['יציאה', 'out', 9, 'hh:mm'], ['שעות', 'h', 8, '0.00'], ['כמות', 'q', 9], ['יחידה', 'u', 9], ['הערות', 'notes', 40], ['תמונה', 'photo', 12]]);
      R.log.slice().sort((a, b) => a['תאריך'] - b['תאריך']).forEach((r) => {
        const row = ws.addRow({ date: xlDate(r['תאריך']), worker: r['עובד'], gh: r['חממה'], code: r['קוד עבודה'], work: r['עבודה'], cat: r['קטגוריה'], in: xlDate(r['כניסה']), out: xlDate(r['יציאה']),
          h: r['שעות'] === '' ? null : Number(r['שעות']), q: r['כמות'] === '' ? null : Number(r['כמות']), u: r['יחידה'], notes: r['הערות'] });
        const links = VG.photoLinks(r['תמונה']);
        if (links.length) row.getCell('photo').value = { text: links.length === 1 ? 'תמונה' : links.length + ' תמונות', hyperlink: links[0].url };
      });
      band(ws);

      const at = wb.addWorksheet('נוכחות');
      head(at, [['תאריך', 'date', 12, 'dd/mm/yyyy'], ['עובד', 'worker', 14], ['כניסה', 'in', 9, 'hh:mm'], ['יציאה', 'out', 9, 'hh:mm'], ['שעות', 'h', 8, '0.00']]);
      (d.attendance || []).filter((r) => VG.inRange(r['תאריך'], R.from, R.to)).sort((a, b) => a['כניסה'] - b['כניסה'])
        .forEach((r) => at.addRow({ date: xlDate(r['תאריך']), worker: r['עובד'], in: xlDate(r['כניסה']), out: xlDate(r['יציאה']), h: r['שעות'] === '' ? null : Number(r['שעות']) }));
      band(at);

      const ts = wb.addWorksheet('משימות');
      head(ts, [['תאריך ביצוע', 'due', 13, 'dd/mm/yyyy'], ['חממה', 'gh', 11], ['משימה', 'notes', 36], ['עובד', 'who', 14], ['סטטוס', 'st', 10]]);
      (d.tasks || []).slice().sort((a, b) => a['תאריך ביצוע'] - b['תאריך ביצוע']).forEach((r) => ts.addRow({ due: xlDate(r['תאריך ביצוע']), gh: r['חממה'], notes: r['משימה'], who: r['עובד'], st: r['סטטוס'] }));
      band(ts);

      const is = wb.addWorksheet('בעיות');
      head(is, [['תאריך', 'date', 12, 'dd/mm/yyyy'], ['חממה', 'gh', 11], ['מדווח', 'who', 14], ['קטגוריה', 'cat', 12], ['חומרה', 'sev', 10], ['תיאור', 'notes', 40], ['סטטוס', 'st', 10], ['פתרון', 'sol', 36], ['תמונה', 'photo', 12]]);
      R.issues.forEach((r) => {
        const row = is.addRow({ date: xlDate(r['תאריך']), gh: r['חממה'], who: r['מדווח'], cat: r['קטגוריה'], sev: r['חומרה'], notes: r['תיאור'], st: r['סטטוס'], sol: r['פתרון'] });
        const links = VG.photoLinks(r['תמונה']);
        if (links.length) row.getCell('photo').value = { text: links.length === 1 ? 'תמונה' : links.length + ' תמונות', hyperlink: links[0].url };
      });
      band(is);

      const buf = await wb.xlsx.writeBuffer();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = `דוח חממות וניל ${new Date().toLocaleDateString('he-IL').replace(/\./g, '-')}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(esc(e.message)); } finally { $('xlsBtn').disabled = false; }
  };

  $('gsBtn').onclick = async () => {
    const win = window.open('', '_blank'); // opened synchronously so popup blockers allow it
    $('gsBtn').disabled = true;
    toast('יוצר דוח ב-Google Sheets…');
    try {
      const R = rangeRows();
      const j = await api('report', { from: R.from, to: R.to });
      if (win) win.location = j.data.url;
      toast(`הדוח נוצר · <a href="${esc(j.data.url)}" target="_blank" rel="noopener">פתיחה</a>`);
    } catch (e) { if (win) win.close(); toast(esc(e.message)); } finally { $('gsBtn').disabled = false; }
  };

  $('qrBtn').onclick = async () => {
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
      const base = location.origin + location.pathname;
      const sheet = $('qrSheet');
      sheet.innerHTML = state.dash.greenhouses.map((g, i) => `<div class="qr-card"><h2>${esc(g.name)}</h2><div class="qr" id="qr${i}"></div></div>`).join('');
      state.dash.greenhouses.forEach((g, i) => new window.QRCode($('qr' + i), { text: base + '?gh=' + encodeURIComponent(g.id), width: 260, height: 260, correctLevel: window.QRCode.CorrectLevel.M }));
      setTimeout(() => window.print(), 300);
    } catch (e) { toast(esc(e.message)); }
  };

  // ---------- boot ----------
  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
    renderReport();
    renderPending();
    if (!state.worker && ghs().length) pickWorker();
    flush();
  }

  const qs = new URLSearchParams(location.search);
  if (qs.get('gh')) {
    state.gh = qs.get('gh');
    store.set('gh', state.gh);
    history.replaceState(null, '', location.pathname);
  }
  if (window.DEMO_API) $('gateErr').textContent = 'מצב הדגמה · קוד עובדים 1234 · קוד מנהל 9876';

  if (!state.code || !state.boot) {
    $('gate').hidden = false;
  } else {
    showApp();
    // refresh lists in the background; a changed code sends people back to the gate
    api('bootstrap', {}).then((j) => {
      state.boot = j.data; state.role = j.role;
      store.set('boot', j.data); store.set('role', j.role);
      if (!state.active) renderReport();
    }).catch((e) => {
      if (!(e instanceof NetError)) { store.del('code'); state.code = ''; $('app').hidden = true; $('gate').hidden = false; $('gateErr').textContent = e.message; }
    });
  }

  if ('serviceWorker' in navigator && !window.DEMO_API) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
