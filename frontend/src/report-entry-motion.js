export const reportRoutes = new Set(['overview', 'assets', 'transactions', 'import', 'settings']);
export const reportEntryDuration = 360;
export const reportEntryStagger = 55;
export const reportEntryMaxDelay = 550;
export const reportEntryDeadline = 1200;
const maxTargets = 64, maxVisits = 260, maxLines = 6;
const units = 'h1, h2, h3, p, label, button, input, select, textarea, summary, img, tr, ' +
  '.metric-block, .page-actions, .section-header, .ledger-toolbar, .ledger-meta, .ledger-end, ' +
  '.goal-snapshot-value, .goal-meta, .recent-row, .field, .setting-switch, .connection-results, ' +
  '.financial-color-preview, .asset-page-meta, .asset-net-worth, .asset-summary-facts > div, ' +
  '.asset-account-controls, .asset-kind-tabs, .asset-account-matches, .import-metrics > div, ' +
  '.import-drop, .import-toolbar, .import-footer, .import-job';
const plots = '[data-page-chart], .chart-wrap, .asset-trend-plot, .daily-heatmap, svg, canvas';
const hidden = 'script, style, template, [hidden], [aria-hidden="true"], [data-ledger-spacer]';
const box = rect => ({ top: rect.top, left: rect.left, width: rect.width, height: rect.height,
  bottom: rect.top + rect.height, right: rect.left + rect.width });
const overlaps = (a, b) => a.width > 0 && a.height > 0 && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;

// Range rectangles describe the existing line breaks; text nodes and selection stay intact.
export function reportTextBands(node, bounds, doc) {
  const fallback = [{ top: 0, height: bounds.height }];
  if (!node.matches('h1, h2, h3, p') || !doc?.createRange || (node.textContent?.length || 0) > 2400) return fallback;
  try {
    const range = doc.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && rect.height <= bounds.height)
      .sort((a, b) => a.top - b.top);
    const tops = [];
    for (const rect of rects) if (!tops.length || rect.top - tops.at(-1) > 5) tops.push(rect.top);
    if (tops.length < 2 || tops.length > maxLines) return fallback;
    return tops.map((top, index) => {
      const start = index ? Math.max(0, top - bounds.top - 2) : 0;
      const end = index + 1 < tops.length ? Math.max(start, tops[index + 1] - bounds.top - 2) : bounds.height;
      return { top: start, height: end - start };
    });
  } catch { return fallback; }
}

export function reportEntryBands(page, root, doc = globalThis.document) {
  const viewport = { top: 0, left: 0, right: doc?.defaultView?.innerWidth || 10000, bottom: doc?.defaultView?.innerHeight || 1000 };
  const rootBox = root?.getBoundingClientRect?.();
  if (rootBox) {
    viewport.top = Math.max(0, rootBox.top); viewport.left = Math.max(0, rootBox.left);
    viewport.right = Math.min(viewport.right, rootBox.right); viewport.bottom = Math.min(viewport.bottom, rootBox.bottom);
  }
  const targets = [];
  let visits = 0;
  function visit(node, clip, depth = 0) {
    if (++visits > maxVisits || targets.length >= maxTargets || depth > 14 || node.hidden || node.matches(hidden)) return;
    const rect = box(node.getBoundingClientRect());
    if (!overlaps(rect, clip)) return;
    if (node.matches('details:not([open])')) { const summary = node.querySelector('summary'); if (summary) visit(summary, clip, depth + 1); return; }
    if (node.matches(units) || node.matches(plots) || !node.children.length) {
      targets.push({ node, rect, bands: reportTextBands(node, rect, doc), plot: node.matches(plots) });
      return;
    }
    const scrolls = node.matches('.table-scroll, .import-table-scroll, .recent-list');
    const childClip = scrolls ? { top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom),
      left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right) } : clip;
    for (const child of node.children) {
      if (visits >= maxVisits || targets.length >= maxTargets) break;
      visit(child, childClip, depth + 1);
    }
  }
  for (const child of page.children) {
    if (visits >= maxVisits || targets.length >= maxTargets) break;
    visit(child, viewport);
  }
  targets.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  let row = -1, top = -Infinity;
  return targets.map(target => {
    if (target.rect.top - top > 10) { row++; top = target.rect.top; }
    return { ...target, delay: Math.min(row * reportEntryStagger, reportEntryMaxDelay),
      duration: Math.min(650, reportEntryDuration + (target.bands.length - 1) * reportEntryStagger) };
  });
}

export function reportEntryFrames({ bands, plot, rect }, softMask = Boolean(globalThis.CSS?.supports?.('mask-image', 'linear-gradient(#000, transparent)'))) {
  // Axes and chart labels retain their geometry; their existing controller draws the marks.
  if (plot) return [{ opacity: 0 }, { opacity: 1 }];
  if (!softMask) return [{ clipPath: 'inset(0 100% 0 0)', opacity: 0 }, { clipPath: 'inset(0)', opacity: 1 }];
  const mask = {
    maskImage: bands.map(() => 'linear-gradient(to right, #000 64%, transparent 66.666667%)').join(', '),
    maskSize: bands.map(band => '300% ' + band.height + 'px').join(', '), maskRepeat: 'no-repeat',
  };
  // Animate positions directly: variables inside WAAPI gradient keyframes resolve only once.
  const position = end => bands.map((band, index) => {
    const offset = end ? -.92 + (bands.length - 1 - index) * .18 : -2 - index * .18;
    return (offset * rect.width).toFixed(3) + 'px ' + band.top + 'px';
  }).join(', ');
  return [{ ...mask, maskPosition: position(false) }, { ...mask, maskPosition: position(true) }];
}
