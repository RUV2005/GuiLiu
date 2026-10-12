import { escapeAttr as attr } from './utils.js';

export function chartHoverAttrs(label, value) {
  return ' data-agent-chart-tip data-tip-label="' + attr(label) + '" data-tip-value="' + attr(value) +
    '" tabindex="0" role="img" aria-label="' + attr(label + ': ' + value) + '"';
}

export function tooltipPosition(x, y, width, height, viewportWidth, viewportHeight) {
  // Prefer the right of the point; near the right edge flip to its left instead of sliding over it.
  const flipped = x - 14 - width;
  const left = x + 14 + width > viewportWidth - 8 && flipped >= 8 ? flipped : Math.max(8, Math.min(x + 14, viewportWidth - width - 8));
  const preferredTop = y + 16 + height <= viewportHeight - 8 ? y + 16 : y - height - 14;
  return { left, top: Math.max(8, Math.min(preferredTop, viewportHeight - height - 8)) };
}

// One delegated controller per canvas; pointer movement never touches application state.
// anchor: 'pointer' follows the cursor; 'column' pins the tooltip to the top of a date column's guide line, so it
// moves only between dates and never sits on the lines being read.
export function createChartHover(root, { selector = '[data-agent-chart-tip]', getContent, tooltipClass = '', anchor: anchorMode = 'pointer' } = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  let active = null;
  let highlighted = [];
  let tip;
  let label;
  let value;
  let list;
  let frame = 0;
  let anchor = null;
  let tracking = false;
  let disposed = false;

  function target(node) {
    const mark = node?.closest?.(selector);
    return mark && root.contains(mark) ? mark : null;
  }
  function track(enabled) {
    if (enabled === tracking) return;
    tracking = enabled;
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    doc[method]('scroll', hide, true);
    doc[method]('pointerdown', outside, true);
    win[method]('resize', hide);
    win[method]('blur', hide);
  }
  function hide() {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    highlighted.forEach((mark) => mark.classList.remove('is-chart-active'));
    highlighted = [];
    active = null;
    if (tip) tip.hidden = true;
    track(false);
  }
  function outside(event) { if (!target(event.target)) hide(); }
  function position() {
    frame = 0;
    if (!active?.isConnected) { hide(); return; }
    const bounds = active.getBoundingClientRect();
    const guide = anchorMode === 'column' ? active.querySelector?.('.chart-reference-line')?.getBoundingClientRect?.() : null;
    const point = guide ? { x: guide.left, y: bounds.top } : anchor || { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const size = tip.getBoundingClientRect();
    // A column tooltip stays over its own chart: past the chart's right edge it flips to the left of the guide line.
    const right = guide ? Math.min(win.innerWidth, root.getBoundingClientRect().right + 8) : win.innerWidth;
    const p = tooltipPosition(point.x, point.y, size.width, size.height, right, win.innerHeight);
    tip.style.left = p.left + 'px';
    tip.style.top = p.top + 'px';
  }
  function show(mark, point = null) {
    if (disposed || !mark) return;
    anchor = point;
    if (mark !== active) {
      hide();
      active = mark;
      const index = mark.dataset.agentPieIndex;
      highlighted = index === undefined ? [mark] : [...mark.closest('.agent-canvas-chart')
        .querySelectorAll('[data-agent-pie-index]')].filter((item) => item.dataset.agentPieIndex === index);
      highlighted.forEach((item) => item.classList.add('is-chart-active'));
      if (!tip) {
        tip = doc.createElement('div'); tip.className = 'agent-chart-tooltip' + (tooltipClass ? ' ' + tooltipClass : ''); tip.setAttribute('role', 'tooltip');
        label = doc.createElement('span'); value = doc.createElement('strong');
        list = doc.createElement('div'); list.className = 'chart-tip-rows'; list.hidden = true;
        tip.append(label, value, list); doc.body.append(tip);
      }
      const content = getContent?.(mark) || { label: mark.dataset.tipLabel, value: mark.dataset.tipValue, rows: parseRows(mark.dataset.tipRows) };
      label.textContent = content.label;
      value.textContent = content.value;
      const structured = Array.isArray(content.rows) && content.rows.length > 0;
      value.hidden = structured; list.hidden = !structured;
      tip.dataset.layout = structured ? 'rows' : 'text';
      if (structured) renderRows(content.rows);
      tip.hidden = false;
      track(true);
      position();
    } else if (!frame) frame = win.requestAnimationFrame(position);
  }
  function parseRows(json) {
    if (!json) return null;
    try { return JSON.parse(json); } catch { return null; }
  }
  // Structured rows: text only (textContent), one per period plus an optional difference line.
  function renderRows(rows) {
    list.replaceChildren(...rows.map((row) => {
      const item = doc.createElement('div');
      item.className = 'chart-tip-row'; item.dataset.kind = String(row.kind || '');
      if (row.tone) item.dataset.financeTone = String(row.tone);
      const add = (tag, className, text) => {
        if (!text) return;
        const node = doc.createElement(tag); node.className = className; node.textContent = String(text); item.append(node);
      };
      if (row.kind === 'delta') add('span', 'chart-tip-delta', row.text);
      else {
        const swatch = doc.createElement('i'); swatch.className = 'chart-tip-swatch'; swatch.setAttribute('aria-hidden', 'true'); item.append(swatch);
        add('span', 'chart-tip-name', row.name); add('b', 'chart-tip-amount', row.amount);
        add('small', 'chart-tip-meta', row.meta); add('small', 'chart-tip-note', row.note);
      }
      return item;
    }));
  }
  function pointer(event) {
    const mark = target(event.target);
    if (mark) show(mark, { x: event.clientX, y: event.clientY });
    else hide();
  }
  function leave(event) { if (target(event.relatedTarget) !== active) hide(); }
  function focus(event) { show(target(event.target)); }
  function blur(event) { if (target(event.relatedTarget) !== active) hide(); }
  function key(event) { if (event.key === 'Escape') hide(); }
  const listeners = { pointerover: pointer, pointermove: pointer, pointerout: leave,
    pointerleave: hide, focusin: focus, focusout: blur, keydown: key };
  Object.entries(listeners).forEach(([type, listener]) => root.addEventListener(type, listener));
  return {
    clearWithin(node) { if (active && node.contains(active)) hide(); },
    dispose() {
      if (disposed) return;
      disposed = true; hide(); tip?.remove();
      Object.entries(listeners).forEach(([type, listener]) => root.removeEventListener(type, listener));
    },
  };
}

let canvas;
let hover;
export function prepareChartHover(container) {
  if (canvas !== container) {
    disposeChartHover(); canvas = container;
    if (container) hover = createChartHover(container);
  }
  return hover;
}
export function disposeChartHover() {
  hover?.dispose(); hover = null; canvas = null;
}
