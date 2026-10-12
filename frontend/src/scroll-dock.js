import { t } from './i18n.js';
import { escapeAttr } from './utils.js';
import { transitionAgentSurface } from './agent-presentation.js';

const tools = [
  ['search', 'search', 'search'],
  ['review', 'review', 'review'], ['agent-tasks', 'automatedTasks', 'calendar'], ['goals', 'goals', 'goals'], ['insights', 'insights', 'insights'], ['agent', 'agent', 'agent'],
];
const dockName = { zh: '快捷控制', ja: 'クイック操作', en: 'Quick controls' };
const pageActions = new Set(['review', 'agent-tasks', 'goals', 'insights']);

export function scrollDockMarkup(ctx, icon, fields = '') {
  const label = (key) => t(ctx.language, key);
  const agentRunning = Boolean(ctx.state?.agentLoading);
  const reviewCount = Math.max(0, Number(ctx.state?.agentInformation?.unreadCount ?? ctx.reviewGroups?.total) || 0);
  return '<div data-dock-fields hidden>' + fields + '</div>' +
    '<nav class="scroll-dock" data-scroll-dock aria-label="' + escapeAttr(dockName[ctx.language] || dockName.en) + '">' +
    tools.map(([key, text, image]) => '<button type="button" class="scroll-dock-button" data-dock-action="' + key + '" title="' + escapeAttr(label(text)) +
      '" aria-label="' + escapeAttr(label(text)) + '"' + (pageActions.has(key) ? ' data-route-button="' + key + '" aria-current="' + (ctx.state?.route === key ? 'page' : 'false') + '"' : ' aria-expanded="false" aria-controls="scroll-dock-popover"') +
      (key === 'agent' ? ' data-running="' + agentRunning + '" aria-busy="' + agentRunning + '"' : '') + '>' + icon(image) +
      (key === 'review' ? '<span class="scroll-dock-badge" data-dock-review-count data-count="' + reviewCount + '" aria-hidden="true"' + (reviewCount ? '' : ' hidden') + '>' + (reviewCount > 99 ? '99+' : reviewCount) + '</span>' : '') + '</button>').join('') + '</nav>' +
    '<div class="scroll-dock-hint" id="scroll-dock-hint" role="tooltip" hidden></div>' +
    '<section class="scroll-dock-popover" id="scroll-dock-popover" hidden role="dialog" aria-labelledby="scroll-dock-title">' +
    '<header><h2 id="scroll-dock-title"></h2><button class="icon-button" type="button" data-dock-close aria-label="' + escapeAttr(label('close')) + '">' +
    icon('close') + '</button></header><div class="scroll-dock-content"></div></section>';
}

export function dockPopupPosition(anchor, viewport, width = 320, height = 340) {
  const leftEdge = viewport.left + 8, topEdge = viewport.top + 8;
  const rightEdge = viewport.left + viewport.width - 8, bottomEdge = viewport.top + viewport.height - 8;
  const room = rightEdge - anchor.right - 12;
  const left = room >= 260 ? anchor.right + 12 : leftEdge;
  width = Math.max(1, Math.min(width, rightEdge - left));
  const maxHeight = Math.max(1, bottomEdge - topEdge);
  height = Math.min(height, maxHeight);
  return { left, top: Math.max(topEdge, Math.min(anchor.top, bottomEdge - height)), width, maxHeight };
}

export function createScrollDock({ document: doc = globalThis.document, window: win = globalThis.window,
  getState = () => ({}), onToggleAgent = () => {}, onAgentVisibility = () => {}, transition = transitionAgentSurface } = {}) {
  let shell, main, panel, dock, popup, content, route, active = '', snapshot, popupMotion, popupParticles;
  let panelScroll = 0;
  let hint, hintButton;
  const moved = [];
  const preference = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const panelExpanded = () => Boolean(shell?.classList.contains('agent-open'));
  const buttonFor = (key) => dock?.querySelector('[data-dock-action="' + key + '"]');
  const viewport = () => ({ left: win.visualViewport?.offsetLeft || 0, top: win.visualViewport?.offsetTop || 0,
    width: win.visualViewport?.width || win.innerWidth, height: win.visualViewport?.height || win.innerHeight });

  function hideHint() {
    if (hint) hint.hidden = true;
    if (hintButton) {
      hintButton.title = hintButton.getAttribute('aria-label');
      hintButton.removeAttribute('aria-describedby');
    }
    hintButton = null;
  }
  function showHint(event) {
    const button = event.target?.closest?.('[data-dock-action]');
    if (!hint || !button || !dock?.contains(button) || event.pointerType === 'touch') return;
    hideHint(); hintButton = button;
    hint.textContent = button.getAttribute('aria-label');
    button.title = '';
    button.setAttribute('aria-describedby', 'scroll-dock-hint');
    hint.hidden = false;
    const rect = button.getBoundingClientRect(), area = viewport();
    const width = hint.getBoundingClientRect().width, height = hint.getBoundingClientRect().height;
    hint.style.left = Math.max(area.left + 8, Math.min(rect.right + 14, area.left + area.width - width - 8)) + 'px';
    hint.style.top = Math.max(area.top + 8, Math.min(rect.top + (rect.height - height) / 2, area.top + area.height - height - 8)) + 'px';
  }
  function leaveHint(event) { if (hintButton && !hintButton.contains(event.relatedTarget)) hideHint(); }

  function source(key) {
    if (key === 'search') return shell?.querySelector('.global-search-wrap');
  }

  function clearMotion() { popupMotion?.cancel(); popupMotion = null; }

  function take(node) {
    if (!node) return;
    const placeholder = doc.createComment('dock-field-slot');
    node.before(placeholder); moved.push({ node, placeholder, inert: node.inert });
    content.append(node); node.inert = false;
  }

  function close(restoreFocus = true, motion = true) {
    hideHint();
    if (!popup) return;
    if (active === 'agent' && !popup.hidden && motion && !preference?.matches) {
      popupParticles = transition({ source: popup, target: () => buttonFor('agent'), reveal: false,
        update: () => close(restoreFocus, false) });
      return;
    }
    clearMotion();
    const previous = active;
    active = '';
    for (const { node, placeholder, inert } of moved.splice(0)) {
      const scroller = node.querySelector('.agent-panel-scroll');
      const scroll = scroller?.scrollTop;
      if (node === panel && scroll !== undefined) panelScroll = scroll;
      if (placeholder.isConnected) placeholder.replaceWith(node);
      node.inert = inert;
      if (scroller) scroller.scrollTop = scroll;
    }
    popup.hidden = true; popup.classList.remove('is-agent');
    content.replaceChildren();
    for (const button of dock.querySelectorAll('[aria-expanded]')) button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && previous) buttonFor(previous)?.focus({ preventScroll: true });
    onAgentVisibility(panelExpanded() || route === 'agent');
  }

  function position() {
    if (!active || !popup || popup.hidden) return;
    const rect = dock.getBoundingClientRect(), anchor = buttonFor(active).getBoundingClientRect();
    const area = viewport();
    const origin = { right: rect.right, top: anchor.top };
    const sidebarWidth = parseFloat(win.getComputedStyle?.(shell).getPropertyValue('--sidebar-width'));
    if (win.innerWidth > 720 && Number.isFinite(sidebarWidth)) origin.right = sidebarWidth + 64;
    const width = active === 'agent' ? 420 : active === 'search' ? 380 : 300;
    popup.style.width = dockPopupPosition(origin, area, width, 0).width + 'px';
    const geometry = dockPopupPosition(origin, area, width, active === 'agent' ? 620 : popup.scrollHeight + 2);
    Object.assign(popup.style, { left: geometry.left + 'px', top: geometry.top + 'px', width: geometry.width + 'px', maxHeight: geometry.maxHeight + 'px' });
    popup.style.height = active === 'agent' ? Math.min(620, geometry.maxHeight) + 'px' : '';
  }

  function open(key, { motion = true, focus: moveFocus = true } = {}) {
    if (!dock?.isConnected || !tools.some(([name]) => name === key) || pageActions.has(key)) return;
    if (key === 'agent' && (panelExpanded() || route === 'agent')) {
      close(false, false);
      (panel || main)?.querySelector('[data-agent-input]')?.focus({ preventScroll: true });
      return;
    }
    if (active === key) { close(); return; }
    if (key === 'agent' && !panel) return;
    if (key === 'agent' && motion && !preference?.matches) {
      popupParticles = transition({ source: buttonFor(key), target: () => popup,
        update: () => open(key, { motion: false, focus: moveFocus }) });
      return;
    }
    close(false, false); active = key;
    const item = tools.find(([name]) => name === key);
    popup.querySelector('h2').textContent = t(getState().settings?.language || 'en', item[1]);
    if (key === 'search') take(source(key));
    if (key === 'agent') { popup.classList.add('is-agent'); take(panel); }
    popup.hidden = false;
    if (key === 'agent') onAgentVisibility(true);
    buttonFor(key)?.setAttribute('aria-expanded', 'true');
    position();
    if (key === 'agent') panel.querySelector('.agent-panel-scroll').scrollTop = panelScroll;
    if (motion && popup.animate && !preference?.matches) {
      popupMotion = popup.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 280, easing: 'cubic-bezier(.28,0,.16,1)' });
      popupMotion.finished.catch(() => {});
    }
    const focus = key === 'agent' ? content.querySelector('[data-agent-input]') : content.querySelector('input,button');
    if (moveFocus) (focus || popup.querySelector('[data-dock-close]'))?.focus({ preventScroll: true });
  }

  function sync() {
    if (!dock?.isConnected) return;
    const state = getState(), language = state.settings?.language || 'en';
    onAgentVisibility(panelExpanded() || route === 'agent' || active === 'agent');
    dock.hidden = false;
    dock.setAttribute('aria-label', dockName[language] || dockName.en);
    popup.querySelector('[data-dock-close]')?.setAttribute('aria-label', t(language, 'close'));
    buttonFor('agent').setAttribute('aria-pressed', String(panelExpanded() || route === 'agent' || active === 'agent'));
    const reviewCount = Number(buttonFor('review')?.querySelector('[data-dock-review-count]')?.dataset.count || 0);
    const values = {
      review: reviewCount ? String(reviewCount) : '',
    };
    for (const [key, label] of tools) {
      const button = buttonFor(key);
      button.title = t(language, label) + (values[key] ? ' · ' + values[key] : '');
      button.setAttribute('aria-label', button.title);
      if (button === hintButton && hint && !hint.hidden) { hint.textContent = button.title; button.title = ''; }
      if (pageActions.has(key)) button.setAttribute('aria-current', (state.route || route) === key ? 'page' : 'false');
    }
    buttonFor('agent').dataset.status = state.agentLoading ? 'checking' : state.status?.agent || 'idle';
    buttonFor('agent').dataset.running = String(Boolean(state.agentLoading));
    buttonFor('agent').setAttribute('aria-busy', String(Boolean(state.agentLoading)));
    if (active) {
      popup.querySelector('h2').textContent = t(language, tools.find(([key]) => key === active)[1]);
      position();
    }
  }

  function onPointer(event) {
    // Navigation captures the chat surface before borrowed nodes return to their slots.
    if (event.target?.closest?.('a[href^="#"], [data-route-button], [data-open-agent-workspace], [data-toggle-sidebar]')) return;
    if (active && !popup.contains(event.target) && !dock.contains(event.target)) close(false);
  }
  function onClick(event) {
    hideHint();
    const button = event.target?.closest?.('[data-dock-action]');
    if (button && dock?.contains(button)) {
      if (pageActions.has(button.dataset.dockAction)) {
        // Route changes use the same handler as page links, including draft and particle handover.
        if ((getState().route || route) === button.dataset.dockAction) {
          event.preventDefault(); event.stopImmediatePropagation(); close(false);
        }
        return;
      }
      if (button.dataset.dockAction === 'agent' && (panelExpanded() || route === 'agent')) {
        event.preventDefault();
        onToggleAgent();
        return;
      }
      event.preventDefault(); open(button.dataset.dockAction);
    } else if (event.target?.closest?.('[data-dock-close]')) close();
    else if (active === 'agent' && popup.contains(event.target) && event.target.closest('[data-toggle-agent]')) {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
  }
  function onKey(event) {
    if (event.key === 'Escape') hideHint();
    if (event.key === 'Escape' && event.target?.closest?.('[data-agent-session-editor]')) return;
    if (event.key === 'Escape' && active) { event.preventDefault(); close(); return; }
    const button = event.target?.closest?.('[data-dock-action]');
    if (!button || !dock?.contains(button)) return;
    const buttons = [...dock.querySelectorAll('button')].filter(item => !item.hidden && !item.disabled);
    const index = buttons.indexOf(button);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next].focus(); }
  }
  function onResize() { hideHint(); if (preference?.matches) clearMotion(); position(); }

  function beforeRender() {
    if (shell?.isConnected && main) snapshot = { route, active, top: main.scrollTop, windowTop: win.scrollY || 0,
      focusKey: doc.activeElement?.closest?.('[data-dock-action]')?.dataset.dockAction,
      tables: [...main.querySelectorAll('.table-scroll')].map(table => table.scrollTop) };
    close(false, false);
    beforeAgentToggle();
    if (snapshot) snapshot.panelScroll = panelScroll;
    shell = main = panel = dock = popup = content = hint = null;
  }

  function mount(nextRoute) {
    route = nextRoute;
    shell = doc.querySelector('.app-shell'); dock = shell?.querySelector('[data-scroll-dock]');
    if (!dock) { snapshot = null; return; }
    main = shell.querySelector('#main-view'); panel = shell.querySelector('#agent-panel');
    hint = shell.querySelector('#scroll-dock-hint');
    popup = shell.querySelector('#scroll-dock-popover'); content = popup.querySelector('.scroll-dock-content');
    panelScroll = panel?.querySelector('.agent-panel-scroll')?.scrollTop || 0;
    const previous = snapshot; snapshot = null;
    if (previous?.route === route) {
      main.scrollTop = previous.top; panelScroll = previous.panelScroll;
      main.querySelectorAll('.table-scroll').forEach((table, index) => { table.scrollTop = previous.tables[index] || 0; });
      if (win.scrollY !== previous.windowTop) win.scrollTo({ top: previous.windowTop, behavior: 'instant' });
      if (previous.active) open(previous.active, { motion: false });
      else if (previous.focusKey) buttonFor(previous.focusKey)?.focus({ preventScroll: true });
    }
    sync();
  }

  const events = [[doc, 'pointerdown', onPointer, true], [doc, 'click', onClick, true], [doc, 'keydown', onKey, true],
    [doc, 'pointerover', showHint, false], [doc, 'pointerout', leaveHint, false],
    [doc, 'focusin', showHint, false], [doc, 'focusout', leaveHint, false],
    [doc, 'abk-sidebar-change', onResize, false], [doc, 'agent-presentation-settled', sync, false],
    [win, 'resize', onResize, false], [win?.visualViewport, 'resize', onResize, false],
    [win?.visualViewport, 'scroll', position, false], [preference, 'change', onResize, false]];
  events.forEach(([target, type, callback, options]) => target?.addEventListener(type, callback, options));
  function beforeAgentToggle() {
    if (panelExpanded() && panel?.querySelector('.agent-panel-scroll')) panelScroll = panel.querySelector('.agent-panel-scroll').scrollTop;
  }
  function relocalize(update) {
    const previous = active, focus = doc.activeElement;
    close(false, false);
    try { update(); }
    finally {
      if (previous) open(previous, { motion: false, focus: false });
      sync();
      if (focus?.isConnected && !focus.inert && doc.activeElement !== focus) focus.focus?.({ preventScroll: true });
    }
  }
  function dispose() { popupParticles?.finish(); beforeRender(); snapshot = null; events.forEach(([target, type, callback, options]) => target?.removeEventListener(type, callback, options)); }
  return { mount, beforeRender, beforeAgentToggle, relocalize, sync, close, dispose };
}
