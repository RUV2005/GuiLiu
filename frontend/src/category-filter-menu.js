export function matchingCategories(values, query = '') {
  const needle = query.trim().toLowerCase();
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))]
    .filter((value) => value.toLowerCase().includes(needle));
}

export function categoryMenuPosition(anchor, viewport, contentHeight) {
  const edge = 8, gap = 6;
  const width = Math.max(0, Math.min(anchor.width, viewport.width - edge * 2));
  const bottom = viewport.top + viewport.height - edge;
  const below = Math.max(0, bottom - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - viewport.top - edge - gap);
  const flip = below < Math.min(160, contentHeight) && above > below;
  const maxHeight = Math.min(280, flip ? above : below);
  return {
    width, maxHeight,
    left: Math.max(viewport.left + edge, Math.min(anchor.left, viewport.left + viewport.width - edge - width)),
    top: flip ? anchor.top - gap - Math.min(contentHeight, maxHeight) : anchor.bottom + gap,
  };
}

export function createCategoryFilterMenu({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  let input, menu, options = [], active = -1, query = '', version = '', animation, frame, committing = false;
  const listeners = [];
  const asInput = (node) => node?.matches?.('input[data-category-list]') ? node : null;
  const listen = (node, type, handler, capture = false) => {
    node?.addEventListener(type, handler, capture);
    listeners.push(() => node?.removeEventListener(type, handler, capture));
  };
  const observer = win.ResizeObserver ? new win.ResizeObserver(() => schedulePosition()) : null;

  function close() {
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
    input?.removeAttribute('aria-controls');
    animation?.cancel(); animation = null;
    observer?.disconnect();
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
    menu?.remove(); menu = null; input = null; options = []; active = -1; version = '';
  }

  function position() {
    if (!input?.isConnected || input.closest('[inert]')) { close(); return; }
    const rect = input.getBoundingClientRect();
    const visual = win.visualViewport;
    const viewport = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
      width: visual?.width || win.innerWidth, height: visual?.height || win.innerHeight };
    if (rect.bottom <= viewport.top || rect.top >= viewport.top + viewport.height) { close(); return; }
    menu.style.width = Math.min(rect.width, viewport.width - 16) + 'px';
    const layout = categoryMenuPosition(rect, viewport, menu.scrollHeight + 2);
    for (const key of ['left', 'top', 'width', 'maxHeight']) menu.style[key] = layout[key] + 'px';
  }

  function schedulePosition(event) {
    if (!input || frame !== undefined) return;
    if (event?.target?.nodeType && menu.contains(event.target)) return;
    frame = win.requestAnimationFrame(() => { frame = undefined; position(); });
  }

  function highlight(index, scroll = false) {
    active = index;
    options.forEach((option, offset) => option.classList.toggle('is-active', offset === active));
    const selected = options[active];
    if (selected) {
      input.setAttribute('aria-activedescendant', selected.id);
      if (scroll) selected.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function sync() {
    if (!input) return;
    if (!input.isConnected || input.closest('[inert]')) { close(); return; }
    const values = matchingCategories([...(doc.getElementById(input.dataset.categoryList)?.options || [])].map((option) => option.value), query);
    const nextVersion = JSON.stringify([values, input.value]);
    if (nextVersion !== version) {
      const previous = options[active]?.dataset.value;
      version = nextVersion;
      options = values.map((value, index) => {
        const option = doc.createElement('button');
        option.type = 'button'; option.tabIndex = -1;
        option.className = 'category-filter-option'; option.dataset.value = value;
        option.id = menu.id + '-' + index;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(value === input.value));
        const label = doc.createElement('span'); label.textContent = value;
        const check = doc.createElement('span'); check.className = 'category-filter-check'; check.setAttribute('aria-hidden', 'true');
        option.append(label, check);
        return option;
      });
      menu.replaceChildren(...options);
      if (!options.length) {
        const empty = doc.createElement('p'); empty.className = 'category-filter-empty';
        empty.setAttribute('role', 'status'); empty.textContent = input.dataset.emptyLabel;
        menu.append(empty);
      }
      highlight(values.indexOf(previous ?? input.value));
    }
    position();
  }

  function open(target, search = '') {
    if (target.disabled || target.closest('[inert]')) return;
    if (input !== target) {
      close(); input = target;
      menu = doc.createElement('div');
      menu.id = target.dataset.categoryList + '-menu'; menu.className = 'category-filter-menu';
      menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', target.getAttribute('aria-label'));
      // Use the top layer to escape the animated filter container and sticky table headers.
      if (menu.showPopover) menu.setAttribute('popover', 'manual');
      doc.body.append(menu);
      menu.showPopover?.();
      input.setAttribute('aria-controls', menu.id); input.setAttribute('aria-expanded', 'true');
      observer?.observe(input);
      if (!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        animation = menu.animate?.([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
          { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    }
    query = search;
    sync();
  }

  function choose(option) {
    const target = input;
    target.value = option.dataset.value;
    target.focus({ preventScroll: true });
    close();
    // Notify the existing debounced local filter once; no API calls or full-page render.
    committing = true;
    try {
      target.dispatchEvent(new win.Event('input', { bubbles: true }));
      target.dispatchEvent(new win.Event('change', { bubbles: true }));
    } finally { committing = false; }
  }

  listen(doc, 'focusin', (event) => { const target = asInput(event.target); if (target && target !== input) open(target); });
  listen(doc, 'click', (event) => {
    const option = event.target.closest?.('.category-filter-option');
    if (option && menu?.contains(option)) { choose(option); return; }
    const target = asInput(event.target);
    if (target && target !== input) open(target);
  });
  listen(doc, 'pointerdown', (event) => {
    if (!input) return;
    if (menu.contains(event.target)) {
      if (event.pointerType !== 'touch' && event.target.closest?.('.category-filter-option')) event.preventDefault();
    } else if (event.target !== input) close();
  });
  listen(doc, 'focusout', () => queueMicrotask(() => {
    if (input && doc.activeElement !== input && !menu.contains(doc.activeElement)) close();
  }));
  const search = (event) => {
    const target = asInput(event.target);
    if (target && !event.isComposing && !committing) open(target, target.value);
  };
  listen(doc, 'input', search);
  listen(doc, 'compositionend', search);
  listen(doc, 'keydown', (event) => {
    const target = asInput(event.target);
    if (!target || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (input !== target) open(target);
      if (options.length) highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) :
        (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length, true);
    } else if (input === target && event.key === 'Enter' && options.length) {
      event.preventDefault(); choose(options[active < 0 ? 0 : active]);
    } else if (input === target && event.key === 'Escape') {
      event.preventDefault(); close();
    } else if (event.key === 'Tab') close();
  });
  listen(doc, 'scroll', schedulePosition, true);
  listen(win, 'resize', schedulePosition);
  listen(win.visualViewport, 'resize', schedulePosition);
  listen(win.visualViewport, 'scroll', schedulePosition);
  return { close, sync, dispose() { close(); listeners.forEach((remove) => remove()); } };
}
