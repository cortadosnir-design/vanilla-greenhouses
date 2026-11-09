/* מעקב חממות וניל — אפליקציית האתר. נתונים: השרת ב-Cloudflare (config.js), מזג אוויר: Open-Meteo (weather.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const VG = window.VG, WX = window.WX;

  // ---------- opening scene: on every launch; a tap skips it, and the app loads underneath meanwhile ----------
  (function intro() {
    const el = $('intro');
    if (!el) return;
    const end = () => el.classList.add('gone');
    const skip = () => { el.classList.add('skip'); setTimeout(end, 220); };
    el.addEventListener('animationend', (e) => { if (e.target === el) end(); });
    el.addEventListener('pointerdown', skip, { once: true });
    addEventListener('keydown', skip, { once: true });
    setTimeout(end, 3600); // in case animations never run
  })();
  const CATEGORIES = ['מזיקים', 'מחלה', 'השקיה', 'אקלים', 'תשתית', 'אחר'];
  const SEVERITIES = ['נמוכה', 'בינונית', 'גבוהה'];
  const WAREHOUSE = 'מחסן';
  const LONG_SHIFT = 14 * 3600000; // a session older than this was probably never checked out

  // ---------- storage ----------
  // the demo keeps its own keys, so its sample code and lists never leak into the real app on the same phone
  const KEY = window.DEMO_API ? 'vgdemo.' : 'vg.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) {
      try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch (e) { toast('אין מספיק מקום במכשיר לשמירה'); return false; }
    },
    del(k) { try { localStorage.removeItem(KEY + k); } catch (e) { /* ignore */ } },
  };

  const state = {
    code: store.get('code', ''),
    session: store.get('session', ''), // Google sign-in; the code is the fallback
    me: store.get('me', null), // { name, email } of the signed-in account
    role: store.get('role', ''),
    boot: store.get('boot', null),
    worker: store.get('worker', ''),
    gh: store.get('gh', ''),
    active: store.get('active', null),
    shift: null, // the work day is no longer clocked separately; a greenhouse visit is the unit of work
    dash: null,
    range: store.get('range', '30'),
    issue: { gh: '', cat: '', sev: 'בינונית' },
    upPhotos: [],
    upGh: '',
    weather: null,
  };

  // ---------- api ----------
  // NetError: try again later (the queue keeps the report). server=true: the server answered with the reason, so it is shown as is
  class NetError extends Error { constructor(msg, server) { super(msg); this.server = !!server; } }
  // the text for a failed call: the server's own reason when it gave one, otherwise the plain "no reception" line
  const errText = (e, offline) => (e instanceof NetError && !e.server ? offline || 'אין קליטה. נסה שוב בעוד רגע' : esc(e.message));
  const SLOW = ['checkOut', 'issue', 'dashboard', 'photo', 'photoSet', 'report', 'backup'];
  async function api(action, payload, code) {
    const body = Object.assign({ action }, state.session && !code ? { session: state.session } : { code: code || state.code }, payload);
    let j;
    if (window.DEMO_API) {
      j = await window.DEMO_API(body);
    } else {
      let res;
      const ctrl = new AbortController();
      // the dashboard reads every tab of the sheet; on a weak signal 20 seconds was not enough
      const timer = setTimeout(() => ctrl.abort(), SLOW.includes(action) ? 60000 : 25000);
      try {
        // text/plain body keeps it a "simple" request, with no CORS preflight
        res = await fetch(window.APP_CONFIG.apiUrl, { method: 'POST', body: JSON.stringify(body), signal: ctrl.signal });
      } catch (e) { throw new NetError('אין חיבור'); } finally { clearTimeout(timer); }
      try { j = await res.json(); } catch (e) { throw new NetError('השרת לא זמין כרגע (' + res.status + ')', true); }
    }
    // retry: Google was busy or unreachable, so the report stays in the queue instead of being dropped
    if (j.signin) signOut(j.error);
    if (!j.ok) throw j.retry ? new NetError(j.error || 'שגיאה', true) : new Error(j.error || 'שגיאה');
    if (j.name && state.me && j.name !== state.me.name) { state.me.name = j.name; store.set('me', state.me); }
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
  const authed = () => !!(state.session || state.code);
  function enter(j) {
    Object.assign(state, { role: j.role, boot: j.data });
    store.set('role', j.role); store.set('boot', j.data);
    showApp();
  }
  async function onGoogle(resp) {
    $('gateErr').textContent = '';
    try {
      const j = await quietly(() => api('login', { credential: resp.credential }, '-'));
      Object.assign(state, { session: j.data.session, me: { name: j.data.name, email: j.data.email }, code: '' });
      store.set('session', state.session); store.set('me', state.me); store.del('code');
      enter(await quietly(() => api('bootstrap', {})));
    } catch (err) {
      $('gateErr').innerHTML = errText(err, 'אין חיבור. נסה שוב כשיש קליטה.');
    }
  }
  // Google's script loads on its own; whichever comes last (it, or the gate) draws the button
  window.onGsi = () => { if (!$('gate').hidden) initGoogle(); };
  function initGoogle() {
    const id = window.APP_CONFIG.googleClientId;
    if (!id || window.DEMO_API || !(window.google && google.accounts && google.accounts.id)) return;
    google.accounts.id.initialize({ client_id: id, callback: onGoogle, ux_mode: 'popup', use_fedcm_for_prompt: true });
    google.accounts.id.renderButton($('gsi'), { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'he', width: 280 });
  }
  function signOut(msg) {
    if (state.session) api('logout', {}).catch(() => {});
    Object.assign(state, { session: '', me: null, code: '', boot: null, dash: null });
    ['session', 'me', 'code', 'boot', 'role'].forEach((k) => store.del(k));
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    $('app').hidden = true;
    $('gate').hidden = false;
    $('gateErr').textContent = msg || '';
    initGoogle();
  }
  $('signOutBtn').onclick = () => {
    if (state.active || state.shift) { toast('אפשר להתנתק אחרי היציאה מהעבודה'); return; }
    signOut();
  };

  $('gateForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('gateCode').value.trim();
    $('gateErr').textContent = '';
    try {
      const j = await quietly(() => api('bootstrap', {}, code));
      state.code = code;
      store.set('code', code);
      enter(j);
    } catch (err) {
      $('gateErr').innerHTML = errText(err, 'אין חיבור. נסה שוב כשיש קליטה.');
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

  const workerList = () => (state.boot && state.boot.workers) || [];
  function renderReport() {
    const list = workerList();
    // signed in with Google: the account's name reports; with one worker on the farm, he does
    if (state.me) { state.worker = state.me.name; store.set('worker', state.worker); } else if (list.length === 1 && state.worker !== list[0] && !state.active && !state.shift) { state.worker = list[0]; store.set('worker', state.worker); }
    $('who').hidden = !!state.me || list.length === 1;
    $('signOutBtn').hidden = !state.me;
    $('signOutBtn').textContent = state.me ? 'התנתקות · ' + state.me.name : '';
    $('who').textContent = state.worker || 'מי מדווח?';
    renderWeatherStrip();
    renderDay();
    renderMyTasks();
    $('outBtn').disabled = !state.active;
    if (state.active) return renderActive();
    $('idle').hidden = false;
    $('active').hidden = true;
    $('activeLive').hidden = true;

    radios($('ghSeg'), ghs().map((g) => ({ v: g.id, t: g.name })), state.gh, (v) => { state.gh = v; store.set('gh', v); validateIn(); });

    const sel = $('workSel');
    const prev = sel.value;
    const groups = {};
    works().forEach((w) => (groups[w.category] = groups[w.category] || []).push(w));
    sel.innerHTML = '<option value="">בחירת עבודה</option>' + Object.keys(groups).map((c) =>
      `<optgroup label="${esc(c)}">${groups[c].map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join('')}</optgroup>`).join('');
    sel.value = prev;
    sel.onchange = () => { drawTiles(); validateIn(); };
    drawTiles();
    validateIn();
  }

  // the works Gershon does most, as big tiles; the rest of the catalogue behind "עבודה אחרת"
  const FAVORITES = ['W01', 'W03', 'W09', 'W07', 'W11'];
  function topWorks() {
    const use = store.get('workUse', {});
    const rank = (c) => (FAVORITES.includes(c) ? FAVORITES.length - FAVORITES.indexOf(c) : 0) / 100 + (use[c] || 0);
    return works().map((w) => w.code).sort((a, b) => rank(b) - rank(a)).slice(0, 5);
  }
  function drawTiles() {
    const sel = $('workSel'), top = topWorks();
    const cur = sel.value ? (top.includes(sel.value) ? sel.value : '*') : (!$('workMore').hidden ? '*' : '');
    $('workMore').hidden = cur !== '*';
    radios($('workTiles'), top.map((c) => ({ v: c, t: workBy(c).name })).concat([{ v: '*', t: 'עבודה אחרת' }]), cur, (v) => {
      if (v === '*') { sel.value = ''; $('workMore').hidden = false; sel.focus(); } else { sel.value = v; $('workMore').hidden = true; }
      validateIn();
    });
  }
  $('qtyRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    $('qty').value = String(Math.max(0, (Number($('qty').value) || 0) + Number(b.dataset.step)));
  });

  function validateIn() {
    if (state.gh && !ghs().some((g) => g.id === state.gh)) { state.gh = ''; store.del('gh'); radios($('ghSeg'), ghs().map((g) => ({ v: g.id, t: g.name })), '', (v) => { state.gh = v; store.set('gh', v); validateIn(); }); }
    const w = workBy($('workSel').value);
    const warehouse = w && w.location === WAREHOUSE;
    $('ghSeg').hidden = !!warehouse;
    $('inBtn').textContent = warehouse ? 'התחלת עבודה' : 'כניסה לחממה';
    $('inBtn').disabled = !!state.active || !w || (!warehouse && !state.gh);
  }

  $('inBtn').onclick = () => {
    if (!state.worker) return pickWorker();
    const w = workBy($('workSel').value);
    const warehouse = w.location === WAREHOUSE;
    const gh = warehouse ? { id: WAREHOUSE, name: WAREHOUSE } : ghs().find((g) => g.id === state.gh);
    const use = store.get('workUse', {});
    use[w.code] = (use[w.code] || 0) + 1;
    store.set('workUse', use);
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
    $('activeLive').hidden = false;
    $('inBtn').disabled = true;
    $('inBtn').textContent = a.gh === WAREHOUSE ? 'התחלת עבודה' : 'כניסה לחממה';
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
    drawCam();
  }

  let camShots = []; // thumbnails of this visit, in memory only
  function drawCam() {
    const n = (state.active && state.active.photos) || 0;
    $('camLabel').textContent = n ? (n === 1 ? 'תמונה אחת · עוד צילום' : `${n} תמונות · עוד צילום`) : 'צילום בחממה';
    const more = camShots.length - 4;
    $('camThumbs').innerHTML = camShots.slice(-4).map((src, i) => `<span class="thumb"><img src="${src}" alt="תמונה ${i + 1}"></span>`).join('') + (more > 0 ? `<span class="thumb more">+${more}</span>` : '');
    $('camThumbs').hidden = !camShots.length;
    $('camInput').disabled = n >= MAX_PHOTOS;
  }
  $('camInput').onchange = async () => {
    const a = state.active;
    const files = Array.from($('camInput').files || []);
    $('camInput').value = '';
    if (!a) return;
    let added = 0;
    for (const f of files.slice(0, MAX_PHOTOS - (a.photos || 0))) {
      let photo;
      try { photo = await compress(f); } catch (e) { toast('לא הצלחתי לקרוא את התמונה'); continue; }
      if (!queuePut('photo', { id: a.id, idx: a.photos || 0, photo })) { toast('אין מקום במכשיר לתמונה'); break; }
      a.photos = (a.photos || 0) + 1;
      store.set('active', a);
      camShots.push(photo);
      added++;
    }
    drawCam();
    if (!added) return;
    const sent = await flush();
    toast(sent ? (added === 1 ? 'התמונה נשמרה בשורת הביקור' : `${added} תמונות נשמרו בשורת הביקור`) : 'התמונות נשמרו במכשיר ויעלו כשתהיה קליטה');
  };

  $('outBtn').onclick = async () => {
    const a = state.active;
    if (!a) return;
    const ts = Date.now();
    const payload = { id: a.id, ts, qty: $('qty').value, notes: $('notes').value.trim() };
    if (!queuePut('checkOut', payload)) { toast('אין מקום במכשיר'); return; }
    journal({ t: ts, who: state.worker, kind: 'out', id: a.id, gh: a.ghName, work: a.workName, mins: Math.round((ts - a.start) / 60000), qty: payload.qty, unit: a.unit, notes: payload.notes, photos: a.photos || 0 });
    camShots = [];
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
          if (e.photos) bits.push(e.photos === 1 ? 'תמונה' : e.photos + ' תמונות');
          return `<li>${t}<div class="ev" data-edit="${esc(e.id)}" role="button" tabindex="0"><strong>${esc(e.work)}</strong><span class="sub">${bits.map((b) => `<bdi class="nw">${b}</bdi>`).join(' · ')}</span>${e.notes ? `<span class="sub">${esc(e.notes)}</span>` : ''}</div></li>`;
        }
        case 'issue': return `<li>${t}<div class="ev issue"${e.id ? ` data-edit="${esc(e.id)}" role="button" tabindex="0"` : ''}><strong>דיווח בעיה: ${esc(e.cat)}</strong><span class="sub">${esc(e.gh || '')} · חומרה ${esc(e.sev)}</span></div></li>`;
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
`;
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
    journal({ t: payload.ts, who: state.worker, kind: 'issue', id: payload.id, gh: (ghs().find((g) => g.id === s.gh) || {}).name, cat: s.cat, sev: s.sev });
    state.issue = { gh: s.gh, cat: '', sev: 'בינונית' };
    $('issueDesc').value = '';
    renderIssue();
    const sent = await flush();
    toast(sent ? 'הבעיה נשלחה' : 'הבעיה נשמרה במכשיר ותישלח כשתהיה קליטה');
  };

  // ---------- dashboard ----------
  function openDash() {
    const isMgr = state.role === 'manager';
    $('mgrForm').hidden = isMgr || !!state.session;
    $('mgrNo').hidden = isMgr || !state.session;
    $('dashBody').hidden = !isMgr || !state.dash;
    if (isMgr) loadDash();
  }
  $('mgrForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('mgrCode').value.trim();
    $('mgrErr').textContent = '';
    try {
      const j = await quietly(() => api('bootstrap', {}, code));
      if (j.role !== 'manager') { $('mgrErr').textContent = 'זה קוד עובדים, לא קוד מנהל'; return; }
      Object.assign(state, { code, role: 'manager', boot: j.data });
      store.set('code', code); store.set('role', 'manager'); store.set('boot', j.data);
      $('mgrCode').value = '';
      openDash();
    } catch (err) { $('mgrErr').textContent = err.message; }
  };

  // A phone that just woke up often has no network for the first second or two, so the first call failing says nothing.
  // Network failures are retried quietly; only a failure that outlasts the retries is shown, and then as the pill, not a pop-up.
  const RETRY_MS = [1500, 4000, 9000];
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function quietly(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!(e instanceof NetError) || e.server || i >= RETRY_MS.length) throw e;
        await wait(RETRY_MS[i]);
      }
    }
  }
  let dashLoading = null;
  function loadDash() {
    if (dashLoading) return dashLoading; // the opening, the sync and a tap on refresh share one request
    $('refreshBtn').disabled = true;
    markSync('busy');
    if (!state.dash) { $('dashWait').hidden = false; $('dashWait').innerHTML = '<span class="spinner" role="progressbar" aria-label="טוען"></span>'; }
    renderWeatherCard();
    dashLoading = quietly(() => api('dashboard', {})).then((j) => {
      state.dash = j.data;
      $('dashBody').hidden = false;
      $('dashWait').hidden = true;
      renderDash();
      lastSync = Date.now();
      markSync('');
    }, (e) => {
      markSync('off');
      $('dashWait').hidden = !!state.dash;
      $('dashWait').innerHTML = state.dash ? '' : `<p>${errText(e, 'אין חיבור לשרת כרגע')}</p><button type="button" class="btn primary" id="dashRetry">ניסיון נוסף</button>`;
      // the server's reason (Google, a missing tab) is worth a pop-up; a weak signal is already on the pill
      if (e instanceof NetError && !e.server) return;
      toast(errText(e));
    }).finally(() => { dashLoading = null; $('refreshBtn').disabled = false; });
    return dashLoading;
  }
  document.addEventListener('click', (e) => { if (e.target.closest('#dashRetry')) loadDash(); });
  $('refreshBtn').onclick = () => { state.weather = null; store.del('weather'); loadDash(); };

  $('rangeSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.range = b.dataset.range;
    store.set('range', state.range);
    renderDash();
  };

  // one pane of the dashboard at a time, remembered on this phone
  let pane = store.get('pane', 'today');
  const PANES = ['today', 'gh', 'log', 'charts', 'photos', 'wx'];
  if (!PANES.includes(pane)) pane = 'today';
  function showPane() {
    $('dashBody').dataset.pane = pane;
    setChecked($('paneSeg'), 'pane', pane);
    if (window.FIT) FIT.first($('deck'));
  }
  showPane();
  $('paneSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    pane = b.dataset.pane;
    store.set('pane', pane);
    showPane();
    renderDash(); // charts are drawn at the width they now have
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

    renderNow(d, now);
    renderKpis(R);
    $('ghCards').innerHTML = d.greenhouses.map((g) => {
      const late = due.filter((x) => x.gh === g.name).length;
      const iss = openIssues.filter((r) => r['חממה'] === g.name).length;
      // the greenhouse's own facts from Master Data, the headline ones on the card and all of them behind a tap
      const info = g.info || [];
      const fact = (re) => (info.find(([k]) => re.test(k)) || [])[1];
      const head = [[fact(/סה"כ צמחים/), 'צמחים'], [fact(/שטח/), 'מ"ר'], [fact(/מספר שורות/), 'שורות'], [fact(/נטיעה/), '']]
        .filter(([v]) => v).map(([v, u]) => `<span>${esc(u ? v + ' ' + u : 'נטיעה ' + v)}</span>`).join('');
      const all = info.length ? `<details class="gh-info"><summary>נתוני החממה</summary><dl>${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : '';
      return `<div class="gh" style="--gh:${ghColor(g.name)}"><h3><i class="dot"></i>${esc(g.name)}</h3>${head ? `<p class="facts">${head}</p>` : ''}<dl>
        <dt>טיפול אחרון</dt><dd>${VG.relDay(VG.lastVisit(d.log, g.name), now)}</dd>
        <dt>מתעכבות</dt><dd class="${late ? 'late' : ''}">${late}</dd>
        <dt>בעיות</dt><dd class="${iss ? 'late' : ''}">${iss}</dd>
        <dt>שעות</dt><dd>${VG.hoursText(hoursByGh[g.name] || 0)}</dd></dl>${all}</div>`;
    }).join('');

    renderJourney(d, R, now);
    renderHours(d, R);
    renderCompare(R, d);
    renderUpload(d);
    renderTasks();
    renderSystem(d.system || {});

    $('dueCount').hidden = !due.length;
    $('dueCount').textContent = due.length;
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

    fillFilter($('fGh'), 'כל החממות', d.greenhouses.map((g) => g.name).concat(R.log.some((r) => r['חממה'] === WAREHOUSE) ? [WAREHOUSE] : []));
    fillFilter($('fWorker'), 'כל העובדים', Array.from(new Set(d.log.map((r) => r['עובד']).filter(Boolean))));
    renderLog();
    renderGallery(d, R);
    renderWxHistory(d, R);
    // later re-renders (the live sync) don't replay the entrance animation
    setTimeout(() => $('dashBody').classList.add('settled'), 900);
  }

  const isWork = (r) => r['קוד עבודה'] !== 'PHOTO';
  function ghColor(name) {
    if (name === WAREHOUSE) return 'var(--gh-wh)';
    const list = (state.dash || state.boot || {}).greenhouses || [];
    const i = list.findIndex((g) => g.name === name || g.id === name);
    return i < 0 ? 'var(--text-2)' : `var(--gh${(i % 6) + 1})`;
  }
  const sumHours = (rows) => rows.reduce((a, r) => a + (Number(r['שעות']) || 0), 0);
  const sumQty = (rows, code) => rows.filter((r) => r['קוד עבודה'] === code).reduce((a, r) => a + (Number(r['כמות']) || 0), 0);

  // who is in the greenhouse right now (one worker on the farm, so one line)
  function renderNow(d, now) {
    const byStart = (a, b) => (b['כניסה'] || 0) - (a['כניסה'] || 0);
    const visit = d.log.filter((r) => r['סטטוס'] === 'פתוח' && isWork(r)).sort(byStart)[0];
    const who = (visit && visit['עובד']) || (d.workers || [])[0] || '';
    const el = $('nowCard');
    const avatar = `<span class="avatar" aria-hidden="true">${esc(String(who).slice(0, 1))}</span>`;
    if (visit) {
      const since = visit['כניסה'];
      const forgot = now - since > LONG_SHIFT ? ' · שכח לצאת?' : '';
      el.className = 'now in';
      el.innerHTML = `${avatar}<div class="main"><strong>${esc(who)} ב${esc(visit['חממה'])}</strong><span class="sub">${esc(visit['עבודה'] || '')} · מ-${hhmm(since)}${forgot}</span></div><span class="clock">${VG.hoursText((now - since) / 3600000)}</span>`;
    } else {
      const last = d.log.filter((r) => isWork(r) && r['כניסה']).sort(byStart)[0];
      el.className = 'now';
      el.innerHTML = `${avatar}<div class="main"><strong>${esc(who || 'אין עובד')} לא בחממה עכשיו</strong><span class="sub">${last ? 'ביקור אחרון: ' + esc(last['חממה']) + ' · ' + VG.relDay(last['כניסה'], now) + ' ב-' + hhmm(last['כניסה']) : 'עוד לא נרשם ביקור'}</span></div>`;
    }
  }

  function renderKpis(R) {
    const cur = R.log.filter(isWork), prev = R.prevLog.filter(isWork);
    const hasPrev = state.range !== 'all';
    const openNow = (state.dash.issues || []).filter((r) => r['סטטוס'] !== 'טופל').length;
    const tiles = [
      { t: 'שעות', v: sumHours(cur), p: sumHours(prev), hours: true, c: 'hours' },
      { t: 'ביקורים', v: cur.length, p: prev.length, c: 'visits' },
      { t: 'פרחים הואבקו', v: sumQty(cur, 'W01'), p: sumQty(prev, 'W01'), c: 'flower' },
      { t: 'תרמילים נקטפו', v: sumQty(cur, 'W11'), p: sumQty(prev, 'W11'), c: 'pod' },
      { t: 'ק"ג מוינו', v: sumQty(cur, 'W12'), p: sumQty(prev, 'W12'), c: 'kg' },
      { t: 'בעיות פתוחות', v: openNow, p: openNow, c: 'issue', now: true },
    ];
    $('kpis').innerHTML = tiles.map((x) => {
      const val = x.hours ? VG.hoursText(x.v) : fmtNum(x.v);
      const diff = x.v - x.p;
      const dt = x.hours ? (diff === 0 ? 'ללא שינוי' : (diff > 0 ? '+' : '-') + VG.hoursText(Math.abs(diff))) : deltaText(x.v, x.p);
      return `<div class="kpi ${x.c}"><span class="t">${x.t}</span><span class="v">${val}</span>${hasPrev && !x.now ? `<span class="delta ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}">${dt}</span>` : ''}</div>`;
    }).join('');
  }

  // ---------- vanilla journey: pollinated flower, pod on the vine, ripe pod, harvested ----------
  const STAGE_ICON = {
    flower: '<svg viewBox="0 0 24 24" aria-hidden="true"><g style="fill:var(--flower)">' + [0, 72, 144, 216, 288].map((a) => `<ellipse cx="12" cy="6.5" rx="3" ry="5" transform="rotate(${a} 12 12)"/>`).join('') + '</g><circle cx="12" cy="12" r="2.4" fill="#9a7446"/></svg>',
    pod: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3c3 5 4 11 3 18M12 3c2 5 3 11 2 18" fill="none" style="stroke:var(--leaf)" stroke-width="2.4" stroke-linecap="round"/></svg>',
    ripe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3c3 5 4 11 3 18M12 3c2 5 3 11 2 18" fill="none" stroke="#b5a332" stroke-width="2.4" stroke-linecap="round"/></svg>',
    cured: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5c4 4 7 9 8 16M9 4c4 4 6 9 7 16M13 4c3 4 5 9 6 15" fill="none" style="stroke:var(--pod)" stroke-width="2.2" stroke-linecap="round"/></svg>',
  };
  const fmtMonth = (t) => new Date(t).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
  function renderJourney(d, R, now) {
    const M = 30.44 * VG.DAY;
    const stage = (icon, n, label) => `<div class="stage"><span class="ico">${STAGE_ICON[icon]}</span><strong>${fmtNum(n)}</strong><span>${label}</span></div>`;
    const rows = d.greenhouses.map((g) => {
      const mine = d.log.filter((r) => r['חממה'] === g.name && typeof r['תאריך'] === 'number');
      const q = (code, from, to) => mine.filter((r) => r['קוד עבודה'] === code && r['תאריך'] >= from && r['תאריך'] <= to).reduce((a, r) => a + (Number(r['כמות']) || 0), 0);
      const pol = mine.filter((r) => r['קוד עבודה'] === 'W01' && Number(r['כמות']) > 0 && r['תאריך'] >= now - 7.5 * M).map((r) => r['תאריך']).sort((a, b) => a - b);
      return `<div class="row" style="--gh:${ghColor(g.name)}"><h3><i class="dot"></i>${esc(g.name)}</h3><div class="vine" role="list">
        ${stage('flower', q('W01', R.from, R.to), 'הואבקו בטווח')}
        ${stage('pod', q('W01', now - 7.5 * M, now), 'תרמילים בהתפתחות')}
        ${stage('ripe', q('W01', now - 9.5 * M, now - 7.5 * M), 'מבשילים לקטיף')}
        ${stage('cured', q('W11', R.from, R.to), 'נקטפו בטווח')}
      </div>${pol.length ? `<p class="foot">הקטיף הבא צפוי ב${fmtMonth(pol[0] + 8 * M)}</p>` : ''}</div>`;
    });
    $('journey').innerHTML = rows.join('');
  }

  // ---------- charts (SVG, newest on the left as Hebrew reads) ----------
  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) || v; }
  const chartWidth = (el) => Math.max(320, Math.round(el.clientWidth || 640));
  function stackedBars(groups, series, aria, fmt, W) {
    const H = 220, padL = 6, padR = 40, padT = 10, padB = 26;
    const total = (g) => series.reduce((a, x) => a + (g.values[x.key] || 0), 0);
    const max = niceMax(Math.max(1, ...groups.map(total)));
    const n = Math.max(1, groups.length), bw = (W - padL - padR) / n, gap = Math.min(8, bw * 0.28);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const step = Math.ceil(n / Math.max(3, Math.floor(W / 80)));
    let out = '';
    for (let i = 0; i <= 4; i++) { const v = (max * i) / 4, yy = y(v).toFixed(1); out += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="axis" x="${W - padR + 6}" y="${+yy + 4}">${fmt(v)}</text>`; }
    groups.forEach((g, i) => {
      const x = W - padR - (i + 1) * bw + gap / 2;
      let acc = 0;
      series.forEach((sr) => {
        const v = g.values[sr.key] || 0;
        if (!v) return;
        const y1 = y(acc + v), y0 = y(acc);
        out += `<rect class="b" x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" rx="2" style="fill:${sr.color}"><title>${esc(g.title)} · ${esc(sr.name)}: ${fmt(v)}</title></rect>`;
        acc += v;
      });
      if (i % step === 0) out += `<text class="axis" x="${(x + (bw - gap) / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(g.label)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${out}</svg>`;
  }

  // the range split into days, weeks or months
  function periods(R) {
    const first = Math.min(R.to, ...R.log.map((r) => r['תאריך']).filter((t) => typeof t === 'number'));
    const from = state.range === 'all' ? first : R.from;
    const span = (R.to - from) / VG.DAY;
    const unit = span <= 31 ? 'day' : span <= 190 ? 'week' : 'month';
    const start = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); if (unit === 'week') d.setDate(d.getDate() - d.getDay()); if (unit === 'month') d.setDate(1); return d.getTime(); };
    const next = (t) => { const d = new Date(t); if (unit === 'day') d.setDate(d.getDate() + 1); else if (unit === 'week') d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1); return d.getTime(); };
    const out = [];
    for (let t = start(from); t <= R.to && out.length < 400; t = next(t)) out.push({ from: t, to: next(t) - 1, label: unit === 'month' ? new Date(t).toLocaleDateString('he-IL', { month: 'short' }) : new Date(t).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) });
    return { unit, list: out };
  }

  function renderHours(d, R) {
    const names = d.greenhouses.map((g) => g.name).concat(R.log.some((r) => r['חממה'] === WAREHOUSE) ? [WAREHOUSE] : []);
    const series = names.map((n) => ({ key: n, name: n, color: ghColor(n) }));
    const P = periods(R);
    const work = R.log.filter(isWork);
    const unitName = { day: 'יום', week: 'שבוע', month: 'חודש' }[P.unit];
    const groups = P.list.map((p) => {
      const rows = work.filter((r) => r['תאריך'] >= p.from && r['תאריך'] <= p.to);
      const values = {};
      rows.forEach((r) => { values[r['חממה']] = (values[r['חממה']] || 0) + (Number(r['שעות']) || 0); });
      return { label: p.label, values, title: `${unitName} ${p.label} · ${rows.length} ביקורים` };
    });
    const total = sumHours(work);
    $('chartLegend').innerHTML = series.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('');
    $('hoursChart').innerHTML = work.length ? stackedBars(groups, series, `שעות בחממות לפי ${unitName}: סך הכול ${VG.hoursText(total)} שעות ב-${work.length} ביקורים`, (v) => VG.hoursText(v), chartWidth($('hoursChart'))) : '<p class="empty">אין ביקורים בטווח הזה</p>';

    const byWork = Object.entries(VG.sumBy(work, 'עבודה', 'שעות')).filter((x) => x[0]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = Math.max(1, ...byWork.map((x) => x[1]));
    $('workBars').innerHTML = byWork.map(([n, h]) =>
      `<div class="row" role="img" aria-label="${esc(n)}: ${VG.hoursText(h)} שעות"><span class="nm">${esc(n)}</span><div class="track"><div class="fill" style="width:${(h / max) * 100}%"></div></div><span class="val">${VG.hoursText(h)}</span></div>`).join('');
  }

  async function renderWxHistory(d, R) {
    const el = $('wxHistory');
    const days = state.range === 'all' ? 92 : Math.min(92, Number(state.range));
    let h;
    try { h = await WX.fetchHistory(days); } catch (e) { el.innerHTML = '<p class="empty">אין נתוני מזג אוויר כרגע</p>'; return; }
    const first = !state.wxHist;
    state.wxHist = h;
    if (first) renderGallery(state.dash, rangeRows()); // the gallery shows each day's weather
    const keys = Object.keys(h).sort().slice(-(days + 1));
    const visits = {};
    d.log.filter(isWork).forEach((r) => { if (typeof r['תאריך'] === 'number') { const k = isoDay(r['תאריך']); visits[k] = (visits[k] || 0) + 1; } });
    const W = chartWidth(el), H = 220, padR = 40, padL = 6, padT = 26, padB = 26;
    const temps = keys.flatMap((k) => [h[k].hi, h[k].lo]).filter((v) => v != null);
    const lo = Math.floor(Math.min(...temps) / 5) * 5, hi = Math.ceil(Math.max(...temps) / 5) * 5 || lo + 5;
    const n = keys.length, bw = (W - padL - padR) / n;
    const x = (i) => W - padR - (i + 0.5) * bw;
    const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / Math.max(1, hi - lo));
    let out = '';
    for (let v = lo; v <= hi; v += 5) out += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${W - padR + 6}" y="${(y(v) + 4).toFixed(1)}">${v}°</text>`;
    keys.forEach((k, i) => {
      const r = h[k].rain || 0;
      if (r >= 0.5) { const bh = Math.min(40, r * 2); out += `<rect class="rain" x="${(x(i) - bw * 0.3).toFixed(1)}" y="${(H - padB - bh).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${bh.toFixed(1)}"><title>${k}: גשם ${Math.round(r)} מ"מ</title></rect>`; }
      if (visits[k]) out += `<circle class="visit" cx="${x(i).toFixed(1)}" cy="12" r="${Math.min(7, 3 + visits[k])}"><title>${k}: ${visits[k]} ביקורים</title></circle>`;
    });
    const line = (key, cls) => `<polyline class="${cls}" fill="none" stroke-width="2.2" stroke-linejoin="round" points="${keys.map((k, i) => h[k][key] == null ? '' : x(i).toFixed(1) + ',' + y(h[k][key]).toFixed(1)).filter(Boolean).join(' ')}"/>`;
    out += line('hi', 'hi') + line('lo', 'lo');
    const step = Math.ceil(n / Math.max(3, Math.floor(W / 80)));
    keys.forEach((k, i) => { if (i % step === 0) out += `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${new Date(k + 'T12:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}</text>`; });
    const days30 = keys.slice(-30);
    const avg = (key) => days30.reduce((a, k) => a + (h[k][key] || 0), 0) / Math.max(1, days30.length);
    el.innerHTML = `<div class="legend" style="margin-bottom:8px"><span><i style="background:#d0612f"></i>מקסימום</span><span><i style="background:#3d7fb8"></i>מינימום</span><span><i style="background:var(--accent);border-radius:50%"></i>ביקורים</span><span>ממוצע לחות ${Math.round(avg('rh'))}%</span></div>` +
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="טמפרטורה בשניר ב-${n} הימים האחרונים, בין ${lo} ל-${hi} מעלות, עם הביקורים בכל יום">${out}</svg>`;
  }

  // ---------- gallery: photos by day, with that day's weather ----------
  let galGh = '';
  function renderGallery(d, R) {
    if (!d) return;
    radios($('galGh'), [{ v: '', t: 'הכול' }].concat(d.greenhouses.map((g) => ({ v: g.name, t: g.name }))), galGh, (v) => { galGh = v; renderGallery(state.dash, rangeRows()); });
    const sets = (d.photos || []).filter((r) => VG.inRange(r['תאריך'], R.from, R.to)); // the demo keeps photo sets apart
    const items = R.log.concat(R.issues, sets).filter((r) => !galGh || r['חממה'] === galGh)
      .flatMap((r) => VG.photoLinks(r['תמונה']).map((p) => ({ r, p, t: r['כניסה'] || r['תאריך'] })))
      .filter((x) => typeof x.t === 'number').sort((a, b) => b.t - a.t).slice(0, 120);
    const wx = state.wxHist || {};
    $('gallery').innerHTML = items.map(({ r, p, t }) => {
      const w = wx[isoDay(t)];
      const cap = [`${r['חממה'] || ''} · ${fmtDate(t)} ${hhmm(t)}`, r['עבודה'] || r['קטגוריה'] || '', w ? `${Math.round(w.hi)}°/${Math.round(w.lo)}° · לחות ${Math.round(w.rh)}%` : ''].filter(Boolean).join(' · ');
      const thumb = window.DEMO_API ? 'icons/icon.svg' : 'https://drive.google.com/thumbnail?id=' + p.id + '&sz=w400';
      return `<button type="button" style="--gh:${ghColor(r['חממה'])}" data-id="${esc(p.id)}" data-row="${esc(r['מזהה'] || '')}" data-cap="${esc(cap)}"><img loading="lazy" src="${thumb}" alt="${esc(cap)}"><figcaption>${esc((r['חממה'] || '') + ' · ' + fmtDate(t))}</figcaption></button>`;
    }).join('') || '<p class="empty">אין תמונות בטווח הזה</p>';
  }
  $('gallery').onclick = (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const id = b.dataset.id;
    $('lbImg').src = window.DEMO_API ? 'icons/icon.svg' : 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1600';
    $('lbImg').alt = b.dataset.cap;
    $('lbCap').textContent = b.dataset.cap;
    $('lbLink').href = 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view';
    $('lbEdit').hidden = !b.dataset.row;
    $('lbEdit').dataset.edit = b.dataset.row;
    $('lightbox').showModal();
  };

  // ---------- change or delete something already reported ----------
  // the server keeps the rules (a worker: his own rows from the last week); a deleted row stays in the sheet, marked
  let editing = null;
  const timeOf = (ms) => (typeof ms === 'number' ? hhmm(ms) : '');
  const atTime = (base, hm) => { const [h, m] = hm.split(':').map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); return d.getTime(); };
  const armed = (b, label, again) => {
    if (b.dataset.armed) return true;
    b.dataset.armed = '1'; b.textContent = again;
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; } }, 3000);
    return false;
  };
  function drawEdit() {
    const r = editing;
    const visit = typeof r['כניסה'] === 'number';
    $('editTitle').textContent = [r['עבודה'] || r['קטגוריה'], r['חממה'], fmtDate(r['כניסה'] || r['תאריך'])].filter(Boolean).join(' · ');
    $('eTimes').hidden = !visit;
    $('eStart').value = timeOf(r['כניסה']);
    $('eEnd').value = timeOf(r['יציאה']);
    $('eEndRow').hidden = r['סטטוס'] === 'פתוח';
    $('eQtyRow').hidden = !(r['יחידה'] || (r['כמות'] !== '' && r['כמות'] != null));
    $('eQtyUnit').textContent = r['יחידה'] ? 'כמה ' + r['יחידה'] + '?' : 'כמות';
    $('eQty').value = r['כמות'] == null ? '' : r['כמות'];
    $('eNotes').value = r['הערות'] || '';
    drawEditPhotos();
    $('eDelete').textContent = 'מחיקת הרשומה';
    delete $('eDelete').dataset.armed;
  }
  function drawEditPhotos() {
    $('ePhotos').innerHTML = VG.photoLinks(editing['תמונה']).map((p) => `<span class="thumb"><img src="${window.DEMO_API ? 'icons/icon.svg' : 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(p.id) + '&sz=w200'}" alt="תמונה">
      <button type="button" class="del" data-url="${esc(p.url)}" aria-label="מחיקת התמונה">מחיקה</button></span>`).join('');
    $('ePhotos').hidden = !$('ePhotos').children.length;
  }
  async function openEdit(id) {
    if (!id) return;
    try {
      editing = (await api('rowGet', { id, worker: state.worker })).data;
      drawEdit();
      if (!$('editDlg').open) $('editDlg').showModal();
    } catch (e) { toast(errText(e, 'אין חיבור. אפשר לערוך כשיש קליטה')); }
  }
  // after a change: the journal of today and the dashboard show what the sheet now holds
  function afterEdit(id, row) {
    const j = store.get('journal', { day: '', items: [] });
    j.items = row ? j.items.map((e) => (e.id !== id ? e : Object.assign(e, e.kind === 'out' && typeof row['כניסה'] === 'number' && typeof row['יציאה'] === 'number'
      ? { t: row['יציאה'], mins: Math.round((row['יציאה'] - row['כניסה']) / 60000) } : {}, { qty: row['כמות'], notes: row['הערות'], photos: VG.photoLinks(row['תמונה']).length })))
      : j.items.filter((e) => e.id !== id);
    store.set('journal', j);
    renderDay();
    if (state.dash) loadDash();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (!b || !b.dataset.edit) return;
    if ($('lightbox').open) $('lightbox').close();
    openEdit(b.dataset.edit);
  });
  $('dayList').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.edit) { e.preventDefault(); openEdit(e.target.dataset.edit); } });
  $('eSave').onclick = async () => {
    const r = editing, out = { id: r['מזהה'], worker: state.worker, notes: $('eNotes').value.trim() };
    if (!$('eQtyRow').hidden) out.qty = $('eQty').value;
    if (!$('eTimes').hidden && $('eStart').value) out.start = atTime(r['כניסה'], $('eStart').value);
    if (!$('eTimes').hidden && !$('eEndRow').hidden && $('eEnd').value) {
      out.end = atTime(r['יציאה'] || r['כניסה'], $('eEnd').value);
      if (out.start && out.end < out.start) out.end += VG.DAY; // past midnight
    }
    $('eSave').disabled = true;
    try {
      const j = await api('rowEdit', out);
      $('editDlg').close();
      toast('השינוי נשמר');
      afterEdit(out.id, j.data);
    } catch (e) { toast(errText(e, 'אין חיבור. נסה שוב כשיש קליטה')); } finally { $('eSave').disabled = false; }
  };
  $('eDelete').onclick = async () => {
    const b = $('eDelete');
    if (!armed(b, 'מחיקת הרשומה', 'למחוק את הרשומה?')) return;
    try {
      await api('rowDelete', { id: editing['מזהה'], worker: state.worker });
      $('editDlg').close();
      toast('הרשומה נמחקה');
      afterEdit(editing['מזהה'], null);
    } catch (e) { toast(errText(e, 'אין חיבור. נסה שוב כשיש קליטה')); }
  };
  $('ePhotos').onclick = async (e) => {
    const b = e.target.closest('button[data-url]');
    if (!b || !armed(b, 'מחיקה', 'למחוק?')) return;
    try {
      const j = await api('photoDelete', { id: editing['מזהה'], worker: state.worker, url: b.dataset.url });
      editing['תמונה'] = j.data.photos.join('\n');
      drawEditPhotos(); // the fields keep what was typed
      toast('התמונה נמחקה');
      afterEdit(editing['מזהה'], editing);
    } catch (err) { toast(errText(err, 'אין חיבור. נסה שוב כשיש קליטה')); }
  };

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
  // the reports menu closes once an action is picked
  document.querySelector('.more .menu').addEventListener('click', (e) => { if (e.target.closest('button')) e.currentTarget.closest('details').open = false; });
  $('backupBtn').onclick = async () => {
    $('backupBtn').disabled = true;
    toast('מגבה…');
    try {
      const j = await api('backup', {});
      state.dash.system = Object.assign({}, state.dash.system, { lastBackup: j.data.at });
      renderSystem(state.dash.system);
      toast(`הגיבוי נשמר · <a href="${esc(j.data.url)}" target="_blank" rel="noopener">פתיחה</a>`);
    } catch (e) { toast(errText(e, 'אין חיבור לשרת')); } finally { $('backupBtn').disabled = false; }
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
    } catch (e) { toast(errText(e, 'אין חיבור. נסה שוב כשיש קליטה')); return false; }
  }
  $('tList').onclick = async (e) => { const b = e.target.closest('[data-done]'); if (b && await markDone(b.dataset.done, state.dash.tasks)) renderTasks(); };

  // ---------- users: who may sign in, and as what ----------
  const ROLES = [{ v: 'worker', t: 'עובד' }, { v: 'manager', t: 'מנהל' }];
  let uRole = 'worker';
  function renderUsers(list) {
    radios($('uRole'), ROLES, uRole, (v) => { uRole = v; });
    $('uList').innerHTML = list.map((u) => `<li><div class="main">${esc(u.name)}<div class="sub" dir="ltr">${esc(u.email)}</div></div>
      ${u.owner ? '<span class="pill">בעלים</span>' : `<select data-role="${esc(u.email)}" data-name="${esc(u.name)}" aria-label="תפקיד של ${esc(u.name)}">${ROLES.map((r) => `<option value="${r.v}"${r.v === u.role ? ' selected' : ''}>${r.t}</option>`).join('')}</select>
      <button type="button" class="btn plain danger" data-del="${esc(u.email)}" aria-label="הסרת ${esc(u.name)}">הסרה</button>`}</li>`).join('');
  }
  async function usersCall(action, payload) {
    try { renderUsers((await api(action, payload)).data); return true; } catch (e) { toast(errText(e, 'אין חיבור')); return false; }
  }
  $('usersBtn').onclick = () => { $('uList').innerHTML = ''; $('usersDlg').showModal(); usersCall('users', {}); };
  $('uForm').onsubmit = async (e) => {
    e.preventDefault();
    $('uAdd').disabled = true;
    if (await usersCall('userSet', { email: $('uEmail').value, name: $('uName').value, role: uRole })) { $('uEmail').value = ''; $('uName').value = ''; toast('נוסף. הוא נכנס עם Google'); }
    $('uAdd').disabled = false;
  };
  $('uList').onchange = (e) => { const s = e.target.closest('[data-role]'); if (s) usersCall('userSet', { email: s.dataset.role, name: s.dataset.name, role: s.value }); };
  $('uList').onclick = (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    // a second tap confirms; the viewer has no confirm() dialog
    if (b.dataset.armed) { usersCall('userDel', { email: b.dataset.del }); return; }
    b.dataset.armed = '1'; b.textContent = 'להסיר?';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'הסרה'; } }, 3000);
  };

  // a worker sees open tasks for them (or for anyone) in the coming week
  function renderMyTasks() {
    const list = openTasks(state.boot && state.boot.tasks).filter((t) => (!t['עובד'] || t['עובד'] === state.worker) && VG.daysBetween(Date.now(), t['תאריך ביצוע']) <= 7);
    $('myTasks').hidden = !list.length;
    $('myTasksList').innerHTML = list.map((t) => taskRow(t, true)).join('');
  }
  $('myTasksList').onclick = async (e) => { const b = e.target.closest('[data-done]'); if (b && await markDone(b.dataset.done, state.boot.tasks)) { store.set('boot', state.boot); renderMyTasks(); } };

  // ---------- manager photo upload ----------
  const upPicker = photoInput($('upPhoto'), $('upThumbs'), $('upPhotoLabel'), state.upPhotos, () => validateUpload());
  function validateUpload() { $('upBtn').disabled = !(state.upGh && state.upPhotos.length); }
  function renderUpload(d) {
    if (!state.upGh || !d.greenhouses.some((g) => g.id === state.upGh)) state.upGh = (d.greenhouses[0] || {}).id || '';
    radios($('upGh'), d.greenhouses.map((g) => ({ v: g.id, t: g.name })), state.upGh, (v) => { state.upGh = v; validateUpload(); });
    validateUpload();
  }
  $('upOpen').onclick = () => { renderUpload(state.dash); $('uploadDlg').showModal(); };
  $('upBtn').onclick = async () => {
    const n = state.upPhotos.length;
    const payload = { id: uid('P'), gh: state.upGh, date: Date.now(), note: $('upNote').value.trim(), by: state.worker || 'מנהל' };
    if (!queueWithPhotos('photoSet', payload, state.upPhotos)) { toast('אין מקום במכשיר לכל התמונות. הסר כמה ונסה שוב'); return; }
    state.upPhotos = [];
    upPicker.reset(state.upPhotos);
    $('upNote').value = '';
    $('upBtn').disabled = true;
    $('uploadDlg').close();
    toast(`מעלה ${n} תמונות…`);
    const sent = await flush();
    toast(sent ? `${n} תמונות הועלו` : `${n} תמונות נשמרו ויעלו כשתהיה קליטה`);
    if (sent) loadDash();
  };

  const deltaText = (cur, prev) => (cur === prev ? 'ללא שינוי' : (cur > prev ? '+' : '') + fmtNum(cur - prev));

  // greenhouse vs greenhouse for the range, each number with its change against the previous window
  function renderCompare(R, d) {
    const rowsFor = (log, issues) => d.greenhouses.map((g) => {
      const mine = log.filter((r) => r['חממה'] === g.name && r['קוד עבודה'] !== 'PHOTO');
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
    $('compareBody').innerHTML = cur.map((r, i) => `<tr style="--gh:${ghColor(r.gh)}"><th scope="row"><i class="dot"></i>${esc(r.gh)}</th><td class="num last">${r.last ? fmtDate(r.last) : '–'}</td>${keys.map((k) => cell(k, r, prev[i])).join('')}</tr>`).join('');
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
    $('logBody').innerHTML = rows.map((r) => {
      const bits = [fmtDate(r['תאריך']), esc(r['עובד'])];
      if (r['שעות'] !== '' && r['שעות'] != null) bits.push(VG.hoursText(r['שעות']) + ' ש\'');
      if (r['כמות'] !== '' && r['כמות'] != null) bits.push(esc(r['כמות']) + ' ' + esc(r['יחידה'] || ''));
      const pics = VG.photoLinks(r['תמונה']);
      if (pics.length) bits.push(`<a href="${esc(pics[0].url)}" target="_blank" rel="noopener">${pics.length === 1 ? 'תמונה' : pics.length + ' תמונות'}</a>`);
      return `<li style="--gh:${ghColor(r['חממה'])}"><span class="gh-tag">${esc(r['חממה'] || '')}</span>
        <div class="main">${esc(r['עבודה'] || r['קוד עבודה'] || '')}${r['סטטוס'] === 'פתוח' ? ' <span class="pill doing">בחממה</span>' : ''}<div class="sub">${bits.map((b) => `<bdi class="nw">${b}</bdi>`).join(' · ')}</div></div>
        ${r['מזהה'] ? `<button type="button" class="btn plain" data-edit="${esc(r['מזהה'])}">עריכה</button>` : ''}</li>`;
    }).join('') || '<li class="empty">אין רשומות</li>';
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

  // ---------- live sync: what changes in the sheet shows up here, and what is done here reaches the sheet ----------
  const SYNC_MS = 20000;
  let lastSync = 0, syncing = false, lastStamp = '', syncFails = 0;
  function markSync(cls) {
    const el = $('syncState');
    el.className = 'sync ' + cls;
    el.textContent = cls === 'off' ? 'אין חיבור' : lastSync ? 'מסונכרן ' + hhmm(lastSync) : '';
  }
  async function sync(force) {
    if (syncing || document.hidden || !authed()) return;
    if (!force && Date.now() - lastSync < SYNC_MS - 1000) return;
    syncing = true;
    markSync('busy');
    try {
      await flush();
      // a tiny request first: the data is re-read only when the file changed (in the app or by hand)
      const st = await api('stamp', {});
      const onDash = !$('dash').hidden && state.role === 'manager';
      const key = st.data.v + (onDash ? ':dash' : ':boot');
      if (key === lastStamp) { lastSync = Date.now(); markSync(''); return; }
      lastStamp = key;
      if (onDash) {
        const j = await api('dashboard', {});
        if (JSON.stringify(j.data) !== JSON.stringify(state.dash)) { state.dash = j.data; $('dashBody').hidden = false; renderDash(); }
      } else {
        const j = await api('bootstrap', {});
        const changed = JSON.stringify(j.data) !== JSON.stringify(state.boot);
        state.boot = j.data; state.role = j.role;
        store.set('boot', j.data); store.set('role', j.role);
        if (changed) { if (state.active) renderMyTasks(); else renderReport(); }
      }
      lastSync = Date.now();
      markSync('');
      syncFails = 0;
    } catch (e) {
      // one missed round on a weak signal is normal; the pill turns orange only when it keeps failing
      markSync(++syncFails >= 2 || (e instanceof NetError && e.server) ? 'off' : '');
    } finally { syncing = false; }
  }
  setInterval(() => sync(), SYNC_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(true); });

  // ---------- boot ----------
  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
    // a worker's Google account has no dashboard; a manager opens on it
    $('dashTab').hidden = !!state.session && state.role !== 'manager';
    renderReport();
    showTab(state.role === 'manager' ? 'dash' : 'report');
    renderPending();
    if (!state.worker && workerList().length > 1) pickWorker();
    flush();
  }

  const qs = new URLSearchParams(location.search);
  if (qs.get('gh')) {
    state.gh = qs.get('gh');
    store.set('gh', state.gh);
    history.replaceState(null, '', location.pathname);
  }
  if (window.DEMO_API) $('gateErr').textContent = 'מצב הדגמה · קוד עובדים 1234 · קוד מנהל 9876';

  if (!authed() || !state.boot) {
    $('gate').hidden = false;
    initGoogle();
    if (window.DEMO_API) { $('codeBox').hidden = false; $('codeBox').open = true; }
  } else {
    showApp();
    // refresh lists in the background; a changed code sends people back to the gate
    quietly(() => api('bootstrap', {})).then((j) => {
      state.boot = j.data; state.role = j.role;
      store.set('boot', j.data); store.set('role', j.role);
      if (!state.active) renderReport();
    }).catch((e) => {
      if (!(e instanceof NetError) && $('gate').hidden) signOut(e.message);
    });
  }

  if ('serviceWorker' in navigator && !window.DEMO_API) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
