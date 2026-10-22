// Draggable desk pet with state poses, a radial menu and the first-visit guide.
// Only a non-sensitive "guide seen" flag is persisted; no credentials or chat.

const POSES = {
  idle: './assets/pet-idle.webp', casting: './assets/pet-casting.webp', success: './assets/pet-success.webp',
  drag: './assets/pet-drag.webp', bottom: './assets/pet-bottom.webp', error: './assets/pet-error.webp',
};
const GUIDE_KEY = 'guanxiang-guide-v1';
const EDGE = 6;

export const guideSeen = {
  get() { try { return localStorage.getItem(GUIDE_KEY) === 'done'; } catch { return false; } },
  set() { try { localStorage.setItem(GUIDE_KEY, 'done'); } catch { /* private mode: show again next time */ } },
};

export function createPet({ onSelect, avoid }) {
  const root = document.getElementById('pet');
  const button = document.getElementById('pet-button');
  const img = document.getElementById('pet-img');
  const menu = document.getElementById('pet-menu');
  const orbs = [...menu.querySelectorAll('.orb')];
  for (const src of Object.values(POSES)) { const preload = new Image(); preload.src = src; }

  let x = 0, y = 0, dragging = false, atBottom = false, nearBottom = false;
  let activity = null, activityTimer = 0, start = null, suppressClick = false, menuTimer = 0;
  const size = () => ({ w: root.offsetWidth, h: root.offsetHeight });
  const clamp = () => {
    const { w, h } = size();
    x = Math.min(Math.max(EDGE, x), innerWidth - w - EDGE);
    y = Math.min(Math.max(EDGE, y), innerHeight - h);
    if (atBottom && !dragging) y = innerHeight - h;
  };
  const place = () => { clamp(); root.style.setProperty('--x', `${x}px`); root.style.setProperty('--y', `${y}px`); };

  function render() {
    const state = dragging ? (nearBottom ? 'bottom' : 'drag') : activity || (atBottom ? 'bottom' : 'idle');
    if (root.dataset.state === state) return;
    const before = size();
    root.dataset.state = state;
    img.src = POSES[state];
    // Keep the pet's feet where they were when the pose changes size.
    const after = size();
    x += (before.w - after.w) / 2;
    y += before.h - after.h;
    place();
  }

  function home() {
    const { w, h } = size();
    x = innerWidth - w - (innerWidth <= 760 ? 8 : Math.max(24, innerWidth * 0.06));
    y = innerHeight - h - 24;
    // Never start on top of the composer (send button, input).
    const box = avoid?.getBoundingClientRect();
    if (box && x < box.right && x + w > box.left && y + h > box.top) y = box.top - h - 8;
    place();
  }

  // Radial menu: fan the orbs out toward the middle of the screen so none land off-canvas.
  function layoutMenu() {
    const rect = root.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    // Ellipse hugging the (tall) pet so orbs sit just outside its silhouette.
    const orb = orbs[0].offsetWidth || 58;
    const rx = rect.width / 2 + orb / 2 + 10, ry = rect.height / 2 + orb / 2 + 2;
    const toward = Math.atan2(innerHeight / 2 - cy, innerWidth / 2 - cx);
    const spread = Math.PI * 0.95;
    orbs.forEach((orb, i) => {
      const angle = toward - spread / 2 + (spread * i) / Math.max(1, orbs.length - 1);
      let ox = Math.cos(angle) * rx, oy = Math.sin(angle) * ry;
      ox = Math.min(Math.max(ox, 34 - cx), innerWidth - 34 - cx);
      oy = Math.min(Math.max(oy, 34 - cy), innerHeight - 34 - cy);
      orb.style.setProperty('--ox', `${ox}px`);
      orb.style.setProperty('--oy', `${oy}px`);
      orb.style.setProperty('--i', i);
    });
  }
  const isOpen = () => !menu.hidden && menu.classList.contains('open');
  function openMenu(focusFirst) {
    clearTimeout(menuTimer);
    layoutMenu();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('open')));
    if (focusFirst) orbs[0].focus({ preventScroll: true });
  }
  function closeMenu(returnFocus) {
    if (menu.hidden) return;
    menu.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    menuTimer = setTimeout(() => { menu.hidden = true; }, 260);
    if (returnFocus) button.focus({ preventScroll: true });
  }
  function squish() {
    root.classList.remove('squish');
    void root.offsetWidth;
    root.classList.add('squish');
    setTimeout(() => root.classList.remove('squish'), 520);
  }

  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    start = { px: event.clientX, py: event.clientY, dx: event.clientX - x, dy: event.clientY - y, id: event.pointerId };
    try { button.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
  });
  button.addEventListener('pointermove', event => {
    if (!start || event.pointerId !== start.id) return;
    if (!dragging && Math.hypot(event.clientX - start.px, event.clientY - start.py) < 6) return;
    if (!dragging) { dragging = true; root.classList.add('dragging'); closeMenu(false); }
    const { h } = size();
    x = event.clientX - start.dx;
    y = event.clientY - start.dy;
    nearBottom = y + h >= innerHeight - 4 || event.clientY >= innerHeight - 24;
    render();
    place();
  });
  const endDrag = event => {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    if (!dragging) return;
    // Swallow the click that follows a drag, but never a later real click.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 250);
    dragging = false;
    root.classList.remove('dragging');
    atBottom = nearBottom;
    nearBottom = false;
    render();
    place();
  };
  button.addEventListener('pointerup', endDrag);
  button.addEventListener('pointercancel', endDrag);
  button.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    squish();
    // Keyboard activation (detail === 0) moves focus into the menu.
    if (isOpen()) closeMenu(false); else setTimeout(() => openMenu(event.detail === 0), 160);
  });
  // Keyboard alternative to dragging.
  button.addEventListener('keydown', event => {
    const step = event.shiftKey ? 64 : 24;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (event.key === 'Escape') { closeMenu(true); return; }
    if (!moves[event.key]) return;
    event.preventDefault();
    closeMenu(false);
    const { h } = size();
    x += moves[event.key][0];
    y += moves[event.key][1];
    atBottom = y + h >= innerHeight;
    render();
    place();
  });
  menu.addEventListener('keydown', event => {
    const index = orbs.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
    else if (['ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); orbs[(index + 1) % orbs.length].focus(); }
    else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); orbs[(index - 1 + orbs.length) % orbs.length].focus(); }
  });
  orbs.forEach(orb => orb.addEventListener('click', () => { closeMenu(false); onSelect(orb.dataset.open || orb.dataset.action); }));
  document.addEventListener('pointerdown', event => { if (isOpen() && !root.contains(event.target)) closeMenu(false); });
  addEventListener('resize', () => { place(); if (isOpen()) layoutMenu(); });

  root.dataset.state = 'idle';
  home();
  return {
    element: button,
    get state() { return activity; },
    // Temporary activity pose; `ms` returns to rest afterwards (success lasts 2s).
    activity(state, ms) {
      clearTimeout(activityTimer);
      activity = state;
      render();
      if (state && ms) activityTimer = setTimeout(() => { activity = null; render(); }, ms);
    },
    closeMenu,
  };
}

// Spotlight walkthrough. Each step: { target: () => Element, title, text }.
export function runGuide(steps, { onDone } = {}) {
  const ring = document.getElementById('guide-ring');
  const card = document.getElementById('guide');
  let index = 0;
  const finish = () => {
    ring.hidden = true; card.hidden = true;
    removeEventListener('resize', show);
    document.removeEventListener('keydown', onKey);
    guideSeen.set();
    onDone?.();
  };
  function show() {
    const step = steps[index];
    const rect = step.target().getBoundingClientRect();
    const pad = 8;
    Object.assign(ring.style, { left: `${rect.left - pad}px`, top: `${rect.top - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
    document.getElementById('guide-step').textContent = `${index + 1} / ${steps.length}`;
    document.getElementById('guide-title').textContent = step.title;
    document.getElementById('guide-text').textContent = step.text;
    document.getElementById('guide-next').textContent = index === steps.length - 1 ? '开始使用' : '下一步';
    ring.hidden = false; card.hidden = false;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const below = rect.bottom + 16 + ch < innerHeight;
    const top = below ? rect.bottom + 16 : Math.max(12, rect.top - 16 - ch);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - cw / 2), innerWidth - cw - 12);
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    document.getElementById('guide-next').focus({ preventScroll: true });
  }
  const onKey = event => { if (event.key === 'Escape') finish(); };
  document.getElementById('guide-next').onclick = () => { if (++index >= steps.length) finish(); else show(); };
  document.getElementById('guide-skip').onclick = finish;
  addEventListener('resize', show);
  document.addEventListener('keydown', onKey);
  show();
}
