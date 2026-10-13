// These regions have their own keyed/data renderers. Never replace their live
// contents with the initial shell template during a locale-only update.
const ownedRegions = '[data-ledger-body], [data-ledger-selection], [data-ledger-structure], ' +
  '[data-asset-region], [data-agent-messages], ' +
  '[data-agent-loading], [data-agent-notice], [data-agent-canvas], .agent-suggestions-slot, [data-scroll-dock], ' +
  '#scroll-dock-popover, [data-overview-chart], [data-overview-assets-region], [data-import-page], [data-information-root], [data-runtime-settings], [data-full-mail-import], .toast-region, .is-editing';
const labelAttributes = ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'placeholder', 'alt', 'data-empty-label', 'data-page-chart-version'];

export function localizeView(current, translated, root = true) {
  if (!current || !translated) return;
  if (!root && current.nodeType === 1 && current.matches(ownedRegions)) return;
  if (current.nodeType !== translated.nodeType || current.nodeName !== translated.nodeName) {
    current.replaceWith(translated.cloneNode(true));
    return;
  }
  // Search results can change their route targets when the navigation labels
  // are translated. They contain no draft controls and must update together.
  if (current.nodeType === 1 && current.matches('.search-popover')) {
    current.replaceChildren(...[...translated.childNodes].map((node) => node.cloneNode(true)));
    return;
  }
  if (current.nodeType === 3) {
    if (current.nodeValue !== translated.nodeValue) current.nodeValue = translated.nodeValue;
    return;
  }
  if (current.nodeType !== 1) return;
  const attributes = current.closest?.('[data-overview-drivers]') ? [...labelAttributes, 'data-tip-label', 'data-tip-value'] : labelAttributes;
  for (const name of attributes) {
    const value = translated.getAttribute(name);
    if (current.getAttribute(name) === value) continue;
    if (value === null) current.removeAttribute(name);
    else current.setAttribute(name, value);
  }
  // Values, selection, focus, open details, runtime classes and inline sizing
  // belong to the current interaction, not to the translated shell template.
  if (current.matches('input, textarea, [contenteditable="true"]')) return;
  const before = [...current.childNodes], after = [...translated.childNodes];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (!before[index]) current.append(after[index].cloneNode(true));
    else if (!after[index]) before[index].remove();
    else localizeView(before[index], after[index], false);
  }
}

export function localizeMarkup(current, markup) {
  if (!current) return;
  const template = current.ownerDocument.createElement('template');
  template.innerHTML = markup;
  localizeView(current, template.content.firstElementChild);
}

// Hold the visible item, not just the raw scroll offset: translated headings
// can wrap differently, including on the window-scrolling mobile layout.
export function captureLanguagePosition(shell, win = globalThis.window) {
  const main = shell.querySelector('#main-view');
  const windowRoot = main && win.getComputedStyle(main).overflowY === 'visible';
  const viewportTop = () => windowRoot ? 0 : main.getBoundingClientRect().top + main.clientTop;
  const scrollers = [shell, ...shell.querySelectorAll('*')].filter((node) => node.scrollTop || node.scrollLeft)
    .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
  const windowPosition = { top: win.scrollY, left: win.scrollX };
  const rows = [...(main?.querySelectorAll('[data-deal-row]') || [])];
  const candidates = rows.length ? rows : [...(main?.querySelectorAll('.page-header, .editorial-section, .asset-balance-summary, [data-page-chart]') || [])];
  const top = main ? viewportTop() : 0;
  const height = windowRoot ? win.innerHeight : main?.clientHeight || 0;
  const anchor = candidates.find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > top && rect.top < top + height;
  });
  const anchorTop = anchor?.getBoundingClientRect().top;
  const dealId = anchor?.getAttribute('data-deal-row');
  return () => {
    for (const { node, top, left } of scrollers) {
      if (!node.isConnected) continue;
      node.scrollTop = top; node.scrollLeft = left;
    }
    if (win.scrollY !== windowPosition.top || win.scrollX !== windowPosition.left) {
      win.scrollTo({ ...windowPosition, behavior: 'instant' });
    }
    const target = dealId !== null && dealId !== undefined
      ? [...main.querySelectorAll('[data-deal-row]')].find((node) => node.getAttribute('data-deal-row') === dealId) : anchor;
    if (!target?.isConnected) return;
    const delta = target.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) < 1) return;
    if (windowRoot) win.scrollTo({ top: win.scrollY + delta, left: win.scrollX, behavior: 'instant' });
    else main.scrollTop += delta;
  };
}
