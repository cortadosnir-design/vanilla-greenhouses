/* No screen ever scrolls. Anything marked data-fit shows only what fits in its box:
 *   data-fit="deck"  a column of cards: the cards that fit make a page, the rest wait on the next one (dots, swipe)
 *   data-fit         a list, a table body or a grid: the rows that fit make a page (‹ 2/5 › in the card's head, swipe)
 * It runs by itself: after any change inside a box, when a box changes size, and when a hidden box appears. */
(function () {
  'use strict';
  const PAGED = 'paged-out';
  const pages = new WeakMap(); // box -> current page index

  // a deck's cards (ghCards is display:contents, so its cards count one by one), a table's rows, otherwise the children
  function items(box) {
    if (box.querySelector(':scope > table, :scope > .table')) return Array.from(box.querySelectorAll('tbody > tr'));
    const out = [];
    const walk = (el) => { for (const c of el.children) { if (c.classList.contains('contents')) walk(c); else out.push(c); } };
    walk(box);
    return out;
  }
  const shown = (el) => el.getClientRects().length > 0;

  function pagerFor(box) {
    if (box.dataset.fit === 'deck') {
      let dots = box.nextElementSibling;
      if (!dots || !dots.classList.contains('dots')) {
        dots = document.createElement('div');
        dots.className = 'dots';
        dots.setAttribute('role', 'tablist');
        box.after(dots);
        dots.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(box, Number(b.dataset.i)); });
      }
      return dots;
    }
    const host = box.closest('.card, dialog, .view');
    const head = host && host.querySelector('.card-head, .sheet-head, .bar');
    let p = head && head.querySelector(`.pager[data-for="${box.id}"]`);
    if (!p && head) {
      p = document.createElement('span');
      p.className = 'pager';
      p.dataset.for = box.id;
      p.innerHTML = '<button type="button" data-d="-1" aria-label="הקודם"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button><span class="n"></span><button type="button" data-d="1" aria-label="הבא"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>';
      const close = head.querySelector('[data-close]');
      if (close) close.before(p); else head.appendChild(p);
      p.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(box, (pages.get(box) || 0) + Number(b.dataset.d)); });
    }
    return p;
  }

  // splits the box's items into pages by where each one ends; items on one row (a grid) stay together
  function layout(box) {
    const list = items(box);
    list.forEach((el) => el.classList.remove(PAGED));
    box.classList.add('fitting');
    const avail = box.clientHeight;
    const top0 = box.getBoundingClientRect().top + box.clientTop;
    const vis = list.filter(shown);
    const firstTop = vis.length ? vis[0].getBoundingClientRect().top - top0 : 0; // a table's header row
    const groups = [];
    let start = null, cur = [];
    vis.forEach((el) => {
      const r = el.getBoundingClientRect();
      const t = r.top - top0, b = r.bottom - top0;
      if (start === null) start = t;
      else if (b - start + firstTop > avail + 1 && cur.length && t > start + 1) { groups.push(cur); cur = []; start = t; }
      cur.push(el);
    });
    if (cur.length) groups.push(cur);
    box.classList.remove('fitting');
    return { list, groups: groups.length ? groups : [[]] };
  }

  function go(box, i) {
    pages.set(box, i);
    apply(box);
  }

  function apply(box, keep) {
    const { groups } = box.__fit || layout(box);
    const n = groups.length;
    let i = Math.max(0, Math.min(n - 1, pages.get(box) || 0));
    pages.set(box, i);
    groups.forEach((g, k) => g.forEach((el) => el.classList.toggle(PAGED, k !== i)));
    box.dataset.pages = n;
    const p = pagerFor(box);
    if (!p) return;
    p.hidden = n < 2;
    if (box.dataset.fit === 'deck') {
      if (p.children.length !== n) p.innerHTML = groups.map((_, k) => `<button type="button" role="tab" data-i="${k}" aria-label="עמוד ${k + 1} מתוך ${n}"></button>`).join('');
      Array.from(p.children).forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
    } else {
      p.querySelector('.n').textContent = `${i + 1}/${n}`;
      p.querySelector('[data-d="-1"]').disabled = i === 0;
      p.querySelector('[data-d="1"]').disabled = i === n - 1;
    }
    if (!keep) refitInside(box);
  }

  function fit(box) {
    if (!shown(box)) return;
    box.__fit = null;
    box.__fit = layout(box);
    apply(box, true);
    box.__fit = null;
  }
  // after a deck changes page, the lists in the cards now on screen fit themselves to their new height
  function refitInside(box) { box.querySelectorAll('[data-fit]').forEach(fit); }

  let queued = false;
  function refit() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // outer boxes first: a deck decides which cards are on screen, then their lists use the room left
      document.querySelectorAll('[data-fit]').forEach(fit);
    });
  }

  // a change of content (not our own paging, which only flips a class) re-fits
  new MutationObserver((muts) => {
    if (muts.some((m) => !(m.target.closest && m.target.closest('.pager, .dots')))) refit();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-pane'] });
  addEventListener('resize', refit);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(refit);
    const watch = () => document.querySelectorAll('[data-fit]').forEach((b) => { if (!b.__ro) { b.__ro = 1; ro.observe(b); } });
    watch();
    new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);

  // swipe between pages: in Hebrew the next page comes from the left, so a drag to the right moves forward
  let sx = 0, sy = 0, sbox = null;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sbox = e.target.closest('[data-fit]');
    // a list inside a card wins over the deck around it, but only when it has pages of its own
    while (sbox && Number(sbox.dataset.pages || 1) < 2) sbox = sbox.parentElement && sbox.parentElement.closest('[data-fit]');
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!sbox) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const rtl = getComputedStyle(sbox).direction === 'rtl';
      go(sbox, (pages.get(sbox) || 0) + ((dx > 0) === rtl ? 1 : -1));
    }
    sbox = null;
  }, { passive: true });

  // turns every box around el to the page that holds it (a deck, then the list in the card)
  function reveal(el) {
    const boxes = [];
    for (let b = el.closest('[data-fit]'); b; b = b.parentElement && b.parentElement.closest('[data-fit]')) boxes.unshift(b);
    boxes.forEach((box) => {
      if (!shown(box)) return;
      const { groups } = layout(box);
      const i = groups.findIndex((g) => g.some((it) => it === el || it.contains(el)));
      if (i >= 0) pages.set(box, i);
      fit(box);
    });
  }

  window.FIT = { refit, reveal, first: (box) => { pages.set(box, 0); fit(box); } };
})();
