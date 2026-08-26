/**
 * IdeaHub motion adapter.
 *
 * Keeps the existing .on state contract intact and mirrors it to the portable
 * transitions.dev hooks. New UI can keep using the same helpers without each
 * feature owning a different duration or easing curve.
 * Source recipes: https://github.com/Jakubantalik/transitions.dev
 */

const modalState = new WeakMap();
const modalTimers = new WeakMap();
const wiredTabs = new WeakSet();
let observer;

function cssMs(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value * (raw.endsWith('s') && !raw.endsWith('ms') ? 1000 : 1) : fallback;
}

function syncModal(modal, initial = false) {
  const open = modal.classList.contains('on');
  const known = modalState.has(modal);
  const wasOpen = modalState.get(modal) ?? false;
  // Ignore the class mutations produced by our own is-open/is-closing hooks.
  // Only a real change to the app's existing .on state starts a new phase.
  if (known && open === wasOpen) return;
  modalState.set(modal, open);

  clearTimeout(modalTimers.get(modal));
  if (open) {
    modal.classList.remove('is-closing');
    modal.classList.add('is-open');
    return;
  }

  modal.classList.remove('is-open');
  if (!initial && wasOpen) {
    modal.classList.add('is-closing');
    const timer = setTimeout(() => modal.classList.remove('is-closing'), cssMs('--modal-close-dur', 150));
    modalTimers.set(modal, timer);
  } else {
    modal.classList.remove('is-closing');
  }
}

function enhanceModal(modal) {
  if (modal.classList.contains('t-modal')) return;
  modal.classList.add('t-modal');
  syncModal(modal, true);
}

function syncDrawer(drawer) {
  const open = drawer.classList.contains('on');
  drawer.querySelectorAll(':scope > .dhead, :scope > .dbody, :scope > .dfoot').forEach((part) => {
    part.classList.add('t-panel-slide');
    part.dataset.open = String(open);
  });
}

function activeTab(bar) {
  return [...bar.querySelectorAll(':scope > button')].find(tab =>
    tab.classList.contains('on') || tab.getAttribute('aria-selected') === 'true');
}

function movePill(bar, animate = true) {
  const pill = bar.querySelector(':scope > .t-tabs-pill');
  const tab = activeTab(bar);
  if (!pill || !tab) return;

  for (const button of bar.querySelectorAll(':scope > button')) {
    button.setAttribute('aria-selected', String(button === tab));
  }

  if (!animate) {
    const previous = pill.style.transition;
    pill.style.transition = 'none';
    pill.style.transform = `translateX(${tab.offsetLeft}px)`;
    pill.style.width = `${tab.offsetWidth}px`;
    void pill.offsetWidth;
    pill.style.transition = previous;
    return;
  }
  pill.style.transform = `translateX(${tab.offsetLeft}px)`;
  pill.style.width = `${tab.offsetWidth}px`;
}

function enhanceTabs(bar) {
  if (wiredTabs.has(bar)) return;
  wiredTabs.add(bar);
  bar.classList.add('t-tabs');

  const pill = document.createElement('span');
  pill.className = 't-tabs-pill';
  pill.setAttribute('aria-hidden', 'true');
  bar.prepend(pill);

  for (const tab of bar.querySelectorAll(':scope > button')) tab.classList.add('t-tab');
  bar.addEventListener('click', () => requestAnimationFrame(() => movePill(bar, true)));
  requestAnimationFrame(() => movePill(bar, false));
}

function enhance(root = document) {
  const query = selector => [
    ...(root.matches?.(selector) ? [root] : []),
    ...(root.querySelectorAll?.(selector) || []),
  ];

  query('.modal').forEach(enhanceModal);
  query('.drawer').forEach(syncDrawer);
  query('.bd-tabs, .learning-tabs').forEach(enhanceTabs);
  query('.view').forEach(view => view.classList.add('t-view-motion'));
}

export function initMotion() {
  if (observer) return;
  enhance();

  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) if (node.nodeType === 1) enhance(node);
        continue;
      }
      const el = record.target;
      if (el.matches('.modal')) syncModal(el);
      if (el.matches('.drawer')) syncDrawer(el);
      if (el.matches('.bd-tab, .learning-tabs > button')) {
        const bar = el.closest('.t-tabs');
        if (bar) requestAnimationFrame(() => movePill(bar, true));
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => {
    for (const bar of document.querySelectorAll('.t-tabs')) movePill(bar, false);
  }, { passive: true });
}
