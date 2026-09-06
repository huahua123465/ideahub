/**
 * IdeaHub UI 基础验收：npm run test:ui
 *
 * 自动发现当前分支真正存在的导航能力，在桌面与手机逐项走查；同时验证生产
 * bundle、导航/ARIA、键盘、弹窗焦点、触控尺寸和本地网络边界。证据写入
 * scripts/.uidiff/，不连接生产环境，也不修改被 Git 跟踪的文件。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true };
const harness = await createUiHarness();
const { report } = harness;

try {
  const desktop = await harness.newPage('desktop', DESKTOP);
  const desktopNav = await discoverNavigation(desktop, 'desktop');
  await assertStaticDialogSemantics(desktop);
  await assertFormControlNames(desktop);
  await assertHeaderControls(desktop, 'desktop');
  await exerciseAccountMenu(desktop, 'desktop');
  await exerciseGroupKeyboard(desktop);
  await traverseNavigation(desktop, desktopNav, { mobile: false });
  await exerciseRovingTabs(desktop, desktopNav);
  await assertFormControlNames(desktop, 'desktop-after-navigation');
  await navigateTo(desktop, navByKey(desktopNav, 'home'), { mobile: false });
  await harness.screenshot(desktop, 'home-desktop-1440x900');
  await exerciseSmartImport(desktop, 'desktop');
  await exerciseIdeaModal(desktop, desktopNav, 'desktop');
  await exerciseRemainingDialogs(desktop);
  await desktop.close();

  const mobile = await harness.newPage('mobile', MOBILE);
  const mobileNav = await discoverNavigation(mobile, 'mobile');
  await assertHeaderControls(mobile, 'mobile');
  await exerciseAccountMenu(mobile, 'mobile');
  await exerciseMobileNavigationTargets(mobile);
  assert.deepEqual(
    mobileNav.map(item => item.key),
    desktopNav.map(item => item.key),
    'desktop and mobile must expose the same navigation capabilities',
  );
  harness.recordCheck('navigation-capabilities-match', 'navigation', {
    count: mobileNav.length,
    keys: mobileNav.map(item => item.key),
  });
  await traverseNavigation(mobile, mobileNav, { mobile: true });
  await assertFormControlNames(mobile, 'mobile-after-navigation');
  await navigateTo(mobile, navByKey(mobileNav, 'home'), { mobile: true });
  const reducedMotion = await mobile.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  assert.equal(reducedMotion, true, 'mobile QA must exercise the reduced-motion media mode');
  harness.recordCheck('mobile-reduced-motion', 'accessibility', { matches: reducedMotion });
  await assertTouchTargets(mobile);
  await harness.screenshot(mobile, 'home-mobile-390x844');
  await exerciseSmartImport(mobile, 'mobile');
  await exerciseIdeaModal(mobile, mobileNav, 'mobile');
  await mobile.close();

  assert.deepEqual(
    report.browserErrors,
    [],
    `browser errors must fail UI QA:\n${formatErrors(report.browserErrors)}`,
  );
  assert.deepEqual(
    report.networkErrors,
    [],
    `network errors or external requests must fail UI QA:\n${formatErrors(report.networkErrors)}`,
  );
  harness.recordCheck('runtime-and-network-clean', 'runtime', {
    browserErrors: report.browserErrors.length,
    networkErrors: report.networkErrors.length,
    requests: report.network.requests,
    responses: report.network.responses,
  });

  await harness.writeReport();
  console.log(
    `UI QA passed: ${report.checks.length} checks, ${report.screenshots.length} screenshots, ` +
    `${report.capabilities.navigation.length} navigation capabilities`,
  );
  console.log(`Bundle: ${Math.round(report.bundleBytes / 1024)} KB`);
  console.log(`Evidence: ${harness.outputDir}`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}

async function discoverNavigation(page, scene) {
  const result = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#appNav [data-go]')].map(node => ({
      key: node.dataset.go,
      id: node.id,
      label: node.textContent.replace(/\s+/g, ' ').trim(),
      tag: node.tagName,
      viewExists: Boolean(document.querySelector(`#v-${CSS.escape(node.dataset.go)}`)),
    }));
    return {
      items,
      duplicateKeys: items.map(item => item.key).filter((key, index, keys) => keys.indexOf(key) !== index),
      duplicateIds: [...document.querySelectorAll('[id]')]
        .map(node => node.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index),
    };
  });

  assert.ok(result.items.length > 0, 'the application must expose at least one navigation capability');
  assert.deepEqual(result.duplicateKeys, [], 'navigation data-go values must be unique');
  assert.deepEqual(result.duplicateIds, [], 'document ids must be unique');
  assert.ok(result.items.every(item => item.tag === 'BUTTON'), 'navigation entries must be native buttons');
  assert.ok(result.items.every(item => item.id === `tab-${item.key}`), 'navigation ids must match data-go');
  assert.ok(result.items.every(item => item.label), 'navigation buttons must have an accessible text label');
  assert.ok(result.items.every(item => item.viewExists), 'every navigation entry must have a matching view');

  report.capabilities.navigation ||= result.items;
  harness.recordCheck(`${scene}-navigation-discovery`, 'capability', {
    count: result.items.length,
    keys: result.items.map(item => item.key),
  });
  return result.items;
}

async function traverseNavigation(page, items, { mobile }) {
  const current = await page.$eval('#appNav [data-go][aria-current="page"]', node => node.dataset.go);
  const ordered = [...items.filter(item => item.key !== current), ...items.filter(item => item.key === current)];
  for (const item of ordered) {
    await navigateTo(page, item, { mobile });
    await assertNoOverflow(page, `${mobile ? 'mobile' : 'desktop'}-${item.key}`);
  }
}

async function navigateTo(page, item, { mobile }) {
  assert.ok(item, 'requested navigation capability does not exist');
  const alreadyCurrent = await page.$eval(
    '#appNav [data-go][aria-current="page"]',
    (node, key) => node.dataset.go === key,
    item.key,
  );
  if (mobile && !alreadyCurrent) {
    const open = await page.$eval('#appNav', node => node.classList.contains('mobile-open'));
    if (!open) {
      await page.click('#navToggle');
      await page.waitForFunction(() =>
        document.querySelector('#appNav')?.classList.contains('mobile-open') &&
        document.querySelector('#navToggle')?.getAttribute('aria-expanded') === 'true',
      );
    }
  }

  if (!alreadyCurrent) await page.click(`#tab-${item.key}`);
  await page.waitForFunction(key => {
    const view = document.querySelector(`#v-${CSS.escape(key)}`);
    const tab = document.querySelector(`#tab-${CSS.escape(key)}`);
    return view?.classList.contains('on') && view.getClientRects().length > 0 &&
      view.childElementCount > 0 && tab?.classList.contains('on') &&
      tab.getAttribute('aria-current') === 'page';
  }, { timeout: 15_000 }, item.key);
  await settleDom(page);

  const state = await page.evaluate(key => ({
    activeViews: [...document.querySelectorAll('.view.on')].map(node => node.id.replace(/^v-/, '')),
    activeTabs: [...document.querySelectorAll('#appNav [data-go].on')].map(node => node.dataset.go),
    currentTabs: [...document.querySelectorAll('#appNav [data-go][aria-current="page"]')]
      .map(node => node.dataset.go),
    context: document.querySelector('#pageContext')?.textContent.trim(),
    title: document.title,
    viewChildren: document.querySelector(`#v-${CSS.escape(key)}`)?.childElementCount || 0,
    navOpen: document.querySelector('#appNav')?.classList.contains('mobile-open'),
    navExpanded: document.querySelector('#navToggle')?.getAttribute('aria-expanded'),
  }), item.key);

  assert.deepEqual(state.activeViews, [item.key], `${item.key} must be the only active view`);
  assert.deepEqual(state.activeTabs, [item.key], `${item.key} must be the only active nav button`);
  assert.deepEqual(state.currentTabs, [item.key], `${item.key} must own aria-current`);
  assert.ok(state.context, `${item.key} must publish page context`);
  assert.ok(state.title.includes(state.context), `${item.key} document title must match page context`);
  assert.ok(state.viewChildren > 0, `${item.key} must render visible content`);
  if (mobile) {
    assert.equal(state.navOpen, false, `${item.key} must close the mobile navigation after selection`);
    assert.equal(state.navExpanded, 'false', `${item.key} must reset mobile navigation ARIA state`);
  }
  harness.recordCheck(`${mobile ? 'mobile' : 'desktop'}-${item.key}-navigation`, 'navigation', state);
}

async function exerciseGroupKeyboard(page) {
  const toggle = await page.$('#appNav .navtop');
  if (!toggle) return;
  await toggle.focus();
  await page.keyboard.press('Enter');
  let state = await toggle.evaluate(node => ({
    focused: document.activeElement === node,
    expanded: node.getAttribute('aria-expanded'),
    collapsed: node.closest('.navgrp')?.classList.contains('collapsed'),
  }));
  assert.equal(state.focused, true, 'keyboard navigation toggle must retain focus');
  assert.equal(state.expanded, String(!state.collapsed), 'group ARIA state must match its visual state');
  await page.keyboard.press('Enter');
  state = await toggle.evaluate(node => ({
    expanded: node.getAttribute('aria-expanded'),
    collapsed: node.closest('.navgrp')?.classList.contains('collapsed'),
  }));
  assert.equal(state.expanded, String(!state.collapsed), 'restored group ARIA state must stay synchronized');
  harness.recordCheck('desktop-navigation-keyboard-and-aria', 'keyboard', state);
}

async function exerciseRovingTabs(page, items) {
  const boardKey = await page.evaluate(keys => keys.find(key =>
    document.querySelector(`#v-${CSS.escape(key)} .bd-tabs [role="tab"]`)), items.map(item => item.key));
  assert.ok(boardKey, 'at least one lazily rendered board must expose its tab contract');
  await navigateTo(page, navByKey(items, boardKey), { mobile: false });

  const selector = `#v-${boardKey} .bd-tabs`;
  const count = await page.$$eval(`${selector} > [role="tab"]`, tabs => tabs.length);
  assert.ok(count > 1, 'representative board tablist must have at least two tabs');

  await page.focus(`${selector} > [role="tab"][aria-selected="true"]`);
  const pressAndExpect = async (key, index) => {
    await page.keyboard.press(key);
    await page.waitForFunction((barSelector, expected) => {
      const tabs = [...document.querySelectorAll(`${barSelector} > [role="tab"]`)];
      return tabs[expected]?.getAttribute('aria-selected') === 'true'
        && tabs[expected]?.tabIndex === 0
        && document.activeElement === tabs[expected];
    }, { timeout: 3_000 }, selector, index);
  };

  await pressAndExpect('End', count - 1);
  await pressAndExpect('Home', 0);
  await pressAndExpect('ArrowLeft', count - 1);
  await pressAndExpect('ArrowRight', 0);
  await settleDom(page);

  const state = await page.$eval(selector, bar => {
    const tabs = [...bar.querySelectorAll(':scope > [role="tab"]')];
    const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
    const panel = document.getElementById(selected[0]?.getAttribute('aria-controls'));
    const duplicateIds = [...document.querySelectorAll('[id]')]
      .map(node => node.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    return {
      role: bar.getAttribute('role'),
      label: bar.getAttribute('aria-label'),
      selectedCount: selected.length,
      selectedId: selected[0]?.id,
      tabIndexes: tabs.map(tab => tab.tabIndex),
      controls: tabs.map(tab => tab.getAttribute('aria-controls')),
      focusedId: document.activeElement?.id,
      panelId: panel?.id,
      panelRole: panel?.getAttribute('role'),
      panelLabelledBy: panel?.getAttribute('aria-labelledby'),
      duplicateIds,
    };
  });

  assert.equal(state.role, 'tablist', 'tab group must expose tablist semantics');
  assert.ok(state.label, 'tablist must have an accessible name');
  assert.equal(state.selectedCount, 1, 'tablist must expose exactly one selected tab');
  assert.deepEqual(state.tabIndexes, [0, ...Array(count - 1).fill(-1)], 'only selected tab may be in the Tab order');
  assert.ok(state.controls.every(id => id === state.panelId), 'every tab must control the shared tabpanel');
  assert.equal(state.panelRole, 'tabpanel', 'controlled content must expose tabpanel semantics');
  assert.equal(state.panelLabelledBy, state.selectedId, 'tabpanel must be labelled by the active tab');
  assert.equal(state.focusedId, state.selectedId, 'keyboard activation must retain focus on the active tab');
  assert.deepEqual(state.duplicateIds, [], 'lazy tab enhancement must not create duplicate ids');
  harness.recordCheck('desktop-board-roving-tabs-and-aria', 'accessibility', state);
}

async function exerciseSmartImport(page, scene) {
  if (!await page.$('#smartImportBtn')) return;
  await page.focus('#smartImportBtn');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const dialog = document.querySelector('#smartImportModal.on');
    return dialog?.contains(document.activeElement);
  }, { timeout: 3_000 });

  const state = await page.$eval('#smartImportModal', dialog => {
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const box = dialog.getBoundingClientRect();
    return {
      role: dialog.getAttribute('role'),
      ariaModal: dialog.getAttribute('aria-modal'),
      label: labelledBy ? document.getElementById(labelledBy)?.textContent.trim() : '',
      focusInside: dialog.contains(document.activeElement),
      focusId: document.activeElement?.id || '',
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      viewport: [innerWidth, innerHeight],
    };
  });
  assert.equal(state.role, 'dialog');
  assert.equal(state.ariaModal, 'true');
  assert.ok(state.label, 'dialog must have a valid accessible label');
  assert.equal(state.focusInside, true, 'opening a dialog must move focus inside it');
  assertBoxInViewport(state.box, state.viewport, `${scene} smart import dialog`);
  harness.recordCheck(`${scene}-dialog-aria-and-focus`, 'dialog', state);
  await assertDialogFocusLoop(page, '#smartImportModal', `${scene}-smart-import`);

  if (scene === 'mobile') {
    await assertTouchTargets(page, '#smartImportModal .btn', {
      label: 'smart-import-dialog',
      minimum: 44,
    });
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#smartImportModal')?.classList.contains('on'));
  await page.waitForFunction(() => document.activeElement?.id === 'smartImportBtn');
  harness.recordCheck(`${scene}-dialog-keyboard-close`, 'keyboard', {
    key: 'Escape',
    closed: true,
    focusReturnedTo: 'smartImportBtn',
  });
}

async function exerciseIdeaModal(page, items, scene) {
  const pool = items.find(item => item.key === 'pool');
  if (!pool || !await page.$('#btnNew') || !await page.$('#modal')) return;
  await navigateTo(page, pool, { mobile: scene === 'mobile' });
  if (scene === 'mobile') {
    await assertTouchTargets(page, '#btnNew', { label: 'primary-create', minimum: 44 });
  }
  await page.focus('#btnNew');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (
    document.querySelector('#modal')?.classList.contains('on') && document.activeElement?.id === 'fTitle'
  ), { timeout: 3_000 });
  const state = await page.$eval('#modal', dialog => {
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const box = dialog.getBoundingClientRect();
    return {
      role: dialog.getAttribute('role'),
      ariaModal: dialog.getAttribute('aria-modal'),
      label: labelledBy ? document.getElementById(labelledBy)?.textContent.trim() : '',
      focusId: document.activeElement?.id || '',
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      viewport: [innerWidth, innerHeight],
    };
  });
  assert.equal(state.role, 'dialog');
  assert.equal(state.ariaModal, 'true');
  assert.ok(state.label, 'idea dialog must have a valid accessible label');
  assert.equal(state.focusId, 'fTitle');
  assertBoxInViewport(state.box, state.viewport, `${scene} idea modal`);
  harness.recordCheck(`${scene}-idea-modal-focus-and-viewport`, 'dialog', state);
  await harness.screenshot(page, `idea-modal-${scene}-${scene === 'mobile' ? '390x844' : '1440x900'}`);
  await page.focus('#anon');
  await page.keyboard.press('Space');
  assert.deepEqual(
    await page.$eval('#anon', node => ({
      role: node.getAttribute('role'),
      checked: node.getAttribute('aria-checked'),
      selected: node.classList.contains('on'),
    })),
    { role: 'checkbox', checked: 'true', selected: true },
  );
  await page.keyboard.press('Space');
  assert.equal(await page.$eval('#anon', node => node.getAttribute('aria-checked')), 'false');
  harness.recordCheck(`${scene}-idea-anonymous-keyboard-checkbox`, 'accessibility', {
    key: 'Space',
    role: 'checkbox',
  });
  await assertDialogFocusLoop(page, '#modal', `${scene}-idea-modal`);
  if (scene === 'mobile') {
    await harness.screenshot(page, 'idea-modal-actions-mobile-390x844');
  }
  if (scene === 'mobile') {
    await assertTouchTargets(page, '#modal .btn', { label: 'idea-dialog', minimum: 44 });
  }
  if (scene === 'desktop') await exerciseNestedConfirm(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#modal')?.classList.contains('on'));
  await page.waitForFunction(() => document.activeElement?.id === 'btnNew');
  harness.recordCheck(`${scene}-idea-modal-keyboard-close`, 'keyboard', {
    key: 'Escape',
    closed: true,
    focusReturnedTo: 'btnNew',
  });
}

async function exerciseNestedConfirm(page) {
  await page.focus('#fTitle');
  await page.evaluate(async () => {
    const { confirmAction } = await import('/src/confirm.js');
    globalThis.__IDEAHUB_QA_CONFIRM__ = confirmAction({
      title: '验收嵌套确认层',
      message: '确认层必须保持最上层焦点。',
      confirmLabel: '继续',
    });
  });
  await page.waitForFunction(() => (
    document.querySelector('#confirmLayer')?.classList.contains('on') &&
    document.activeElement?.id === 'confirmSubmit'
  ));
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => Boolean(document.activeElement?.matches('[data-confirm-cancel]'))),
    true,
    'nested confirm Tab must remain in the alertdialog instead of falling into the underlying modal',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (
    !document.querySelector('#confirmLayer')?.classList.contains('on') && document.activeElement?.id === 'fTitle'
  ));
  harness.recordCheck('desktop-nested-confirm-focus-priority', 'accessibility', {
    alertdialogStayedTopmost: true,
    focusReturnedTo: 'fTitle',
  });
}

async function assertStaticDialogSemantics(page) {
  const { dialogs, checks } = await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('.modal')].map(node => {
      const labelledBy = node.getAttribute('aria-labelledby');
      return {
        id: node.id,
        role: node.getAttribute('role'),
        ariaModal: node.getAttribute('aria-modal'),
        labelledBy,
        label: labelledBy ? document.getElementById(labelledBy)?.textContent.trim() || '' : '',
      };
    }),
    checks: [...document.querySelectorAll('.check[id]')].map(node => ({
      id: node.id,
      role: node.getAttribute('role'),
      tabindex: node.getAttribute('tabindex'),
      checked: node.getAttribute('aria-checked'),
    })),
  }));
  assert.ok(dialogs.length > 0, 'the application must expose at least one dialog');
  assert.ok(dialogs.every(dialog => dialog.id), `every dialog needs a stable id: ${JSON.stringify(dialogs)}`);
  assert.ok(dialogs.every(dialog => dialog.role === 'dialog'), `every modal needs role=dialog: ${JSON.stringify(dialogs)}`);
  assert.ok(dialogs.every(dialog => dialog.ariaModal === 'true'), `every modal needs aria-modal=true: ${JSON.stringify(dialogs)}`);
  assert.ok(dialogs.every(dialog => dialog.label), `every modal needs a valid accessible title: ${JSON.stringify(dialogs)}`);
  assert.ok(checks.length > 0, 'custom check controls must be discoverable');
  assert.ok(checks.every(check => check.role === 'checkbox'), `custom checks need role=checkbox: ${JSON.stringify(checks)}`);
  assert.ok(checks.every(check => check.tabindex === '0'), `custom checks must be keyboard focusable: ${JSON.stringify(checks)}`);
  assert.ok(checks.every(check => ['true', 'false'].includes(check.checked)), `custom checks need aria-checked: ${JSON.stringify(checks)}`);
  harness.recordCheck('static-dialog-semantics', 'accessibility', {
    count: dialogs.length,
    ids: dialogs.map(dialog => dialog.id),
    customChecks: checks.map(check => check.id),
  });
}

async function assertFormControlNames(page, label = 'initial') {
  const controls = await page.$$eval('input,select,textarea', nodes => nodes
    .filter(node => node.getAttribute('type') !== 'hidden')
    .map(node => ({
      id: node.id,
      tag: node.tagName,
      type: node.getAttribute('type') || '',
      field: node.getAttribute('name') || '',
      classes: node.className,
      view: node.closest('.view')?.id || '',
      modal: node.closest('.modal')?.id || '',
      sample: node.outerHTML.slice(0, 220),
      name: node.getAttribute('aria-label') ||
        (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .map(id => document.getElementById(id)?.textContent.trim() || '').join(' ').trim() ||
        [...(node.labels || [])].map(label => label.textContent.trim()).join(' ').trim(),
    })));
  const unnamed = controls.filter(control => !control.name);
  assert.deepEqual(unnamed, [], `every form control needs an associated or ARIA label: ${JSON.stringify(unnamed)}`);
  harness.recordCheck(`${label}-form-control-accessible-names`, 'accessibility', {
    controls: controls.length,
  });
}

async function assertTouchTargets(
  page,
  selector = '#navToggle,#mobileSearchBtn,#smartImportBtn,#notifBtn,#meAvatar',
  { label = 'chrome', minimum = 44 } = {},
) {
  const targets = await page.$$eval(selector, nodes => nodes
    .filter(node => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    })
    .map(node => {
      const box = node.getBoundingClientRect();
      return { id: node.id || node.textContent.trim(), width: box.width, height: box.height };
    }));
  assert.ok(targets.length > 0, `touch target selector did not match visible controls: ${selector}`);
  assert.ok(
    targets.every(target => target.width >= minimum && target.height >= minimum),
    `touch targets must be at least ${minimum}×${minimum} CSS pixels: ${JSON.stringify(targets)}`,
  );
  harness.recordCheck(`mobile-touch-targets-${label}`, 'touch', {
    minimum,
    targets,
  });
}

async function assertHeaderControls(page, scene) {
  const controls = await page.$$eval(
    '#navToggle,#mobileSearchBtn,#smartImportBtn,#notifBtn,#meAvatar',
    nodes => nodes.map(node => ({
      id: node.id,
      tag: node.tagName,
      name: node.getAttribute('aria-label') || node.textContent.trim() || node.getAttribute('title') || '',
    })),
  );
  assert.equal(controls.length, 5, 'the global header must expose five stable controls');
  assert.ok(controls.every(control => control.tag === 'BUTTON'), `header controls must use native buttons: ${JSON.stringify(controls)}`);
  assert.ok(controls.every(control => control.name), `header controls need accessible names: ${JSON.stringify(controls)}`);
  harness.recordCheck(`${scene}-header-accessible-controls`, 'accessibility', { controls });
}

async function exerciseAccountMenu(page, scene) {
  await page.focus('#meAvatar');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (
    document.querySelector('#userMenu')?.classList.contains('on') &&
    document.querySelector('#meAvatar')?.getAttribute('aria-expanded') === 'true'
  ));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (
    !document.querySelector('#userMenu')?.classList.contains('on') &&
    document.querySelector('#meAvatar')?.getAttribute('aria-expanded') === 'false' &&
    document.activeElement?.id === 'meAvatar'
  ));
  harness.recordCheck(`${scene}-account-menu-keyboard`, 'accessibility', {
    openedWith: 'Enter',
    closedWith: 'Escape',
    focusReturnedTo: 'meAvatar',
  });
}

async function exerciseMobileNavigationTargets(page) {
  await page.click('#navToggle');
  await page.waitForFunction(() => document.querySelector('#appNav')?.classList.contains('mobile-open'));
  await assertTouchTargets(page, '#appNav .navtop,#appNav [data-go],#navClose', {
    label: 'navigation',
    minimum: 44,
  });
  await page.click('#navClose');
  await page.waitForFunction(() => (
    !document.querySelector('#appNav')?.classList.contains('mobile-open') &&
    document.querySelector('#navToggle')?.getAttribute('aria-expanded') === 'false'
  ));
}

async function assertDialogFocusLoop(page, selector, label) {
  const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const count = await page.$eval(selector, (dialog, innerSelector) => {
    const nodes = [...dialog.querySelectorAll(innerSelector)]
      .filter(node => !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    nodes.at(-1)?.focus();
    return nodes.length;
  }, focusableSelector);
  assert.ok(count >= 1, `${label} needs at least one focusable control`);
  if (count === 1) {
    harness.recordCheck(`${label}-focus-contained`, 'accessibility', { focusableControls: count });
    return;
  }
  await page.keyboard.press('Tab');
  const forward = await page.$eval(selector, (dialog, innerSelector) => {
    const nodes = [...dialog.querySelectorAll(innerSelector)]
      .filter(node => !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    return {
      index: nodes.indexOf(document.activeElement),
      active: document.activeElement?.id || document.activeElement?.textContent.trim() || '',
      controls: nodes.map(node => node.id || node.textContent.trim() || node.tagName),
    };
  }, focusableSelector);
  assert.equal(forward.index, 0, `${label} must wrap Tab from last to first: ${JSON.stringify(forward)}`);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  const backward = await page.$eval(selector, (dialog, innerSelector) => {
    const nodes = [...dialog.querySelectorAll(innerSelector)]
      .filter(node => !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    return {
      index: nodes.indexOf(document.activeElement),
      active: document.activeElement?.id || document.activeElement?.textContent.trim() || '',
      controls: nodes.map(node => node.id || node.textContent.trim() || node.tagName),
    };
  }, focusableSelector);
  assert.equal(backward.index, count - 1, `${label} must wrap Shift+Tab from first to last: ${JSON.stringify(backward)}`);
  harness.recordCheck(`${label}-focus-loop`, 'accessibility', { focusableControls: count });
}

async function exerciseRemainingDialogs(page) {
  const ids = await page.$$eval('.modal', nodes => nodes.map(node => node.id)
    .filter(id => !['smartImportModal', 'modal'].includes(id)));
  for (const id of ids) {
    await page.focus('#meAvatar');
    await page.$eval(`#${id}`, dialog => dialog.classList.add('on'));
    await page.waitForFunction(dialogId => (
      document.querySelector(`#${CSS.escape(dialogId)}`)?.contains(document.activeElement)
    ), { timeout: 3_000 }, id);
    await assertDialogFocusLoop(page, `#${id}`, `desktop-${id}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(dialogId => (
      !document.querySelector(`#${CSS.escape(dialogId)}`)?.classList.contains('on')
    ), { timeout: 3_000 }, id);
    await page.waitForFunction(() => document.activeElement?.id === 'meAvatar', { timeout: 3_000 });
    harness.recordCheck(`desktop-${id}-escape-and-focus-return`, 'accessibility', {
      opened: true,
      closedWith: 'Escape',
      focusReturnedTo: 'meAvatar',
    });
  }
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  const overflow = Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.clientWidth;
  assert.ok(overflow <= 1, `${label} has ${overflow}px horizontal page overflow: ${JSON.stringify(metrics)}`);
  harness.recordCheck(`${label}-overflow`, 'horizontal-overflow', metrics);
}

function assertBoxInViewport(box, viewport, label) {
  assert.ok(
    box.left >= -1 && box.right <= viewport[0] + 1 && box.top >= -1 && box.bottom <= viewport[1] + 1,
    `${label} must remain inside the viewport: ${JSON.stringify({ box, viewport })}`,
  );
}

function navByKey(items, key) {
  return items.find(item => item.key === key);
}

function formatErrors(errors) {
  return errors.map(item => `${item.scene}: ${item.type}: ${item.message || item.url}`).join('\n');
}
