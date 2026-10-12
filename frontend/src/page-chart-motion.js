const ease = 'cubic-bezier(.32,0,.14,1)';
const selectors = {
  line: '.chart-series', bars: '.bar-fill', delta: '.delta-fill', donut: '.donut-slice',
  progress: '.goal-progress-fill, .mini-progress > i', allocation: '.asset-allocation-track > i',
  heatmap: '.daily-heatmap-week',
};

export function createPageChartMotion({ preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'), Observer = globalThis.IntersectionObserver } = {}) {
  const records = new Map();
  const owners = new WeakMap();
  let route;

  const clearPending = (record) => record.targets.forEach((target) => target.classList.remove('page-chart-mark-pending'));
  function stop(record) {
    observer?.unobserve(record.node);
    record.animations.forEach((animation) => animation.cancel());
    record.animations = [];
    clearPending(record);
    record.pending = false;
    record.redraw = false;
  }
  function reveal(record, delay = 0) {
    observer?.unobserve(record.node);
    record.pending = false;
    clearPending(record);
    if (!record.node.isConnected) return;
    const entering = !record.seen || record.redraw;
    record.redraw = false;
    record.seen = true;
    if (preference?.matches) return;
    const type = record.node.dataset.pageChartType;
    // Sweep weeks, not individual days. Data-only updates fade the single grid.
    const targets = type === 'heatmap' && !entering
      ? [...record.node.querySelectorAll('.daily-heatmap-days')].slice(0, 1)
      : record.targets.slice(0, type === 'heatmap' ? 72 : 24);
    const animations = targets.flatMap((target, index) => {
      if (!target.animate) return [];
      let frames = [{ opacity: .55 }, { opacity: 1 }];
      let duration = 300;
      let targetDelay = entering ? delay + Math.min(index, 6) * 45 : 0;
      if (entering) {
        duration = type === 'line' ? 1600 : 800;
        if (type === 'line') frames = [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0)' }];
        else if (type === 'heatmap') {
          frames = [{ opacity: 0 }, { opacity: 1 }];
          duration = 280;
          const position = Number(target.dataset.heatmapPosition);
          targetDelay = delay + (Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0) * 440;
        }
        else if (type === 'donut') frames = [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }];
        else {
          const transformOrigin = type === 'delta' && target.classList.contains('negative') ? 'right center' : 'left center';
          frames = [{ transformOrigin, transform: 'scaleX(0)' }, { transformOrigin, transform: 'none' }];
        }
      }
      return [target.animate(frames, { duration, easing: ease, delay: targetDelay, fill: 'both' })];
    });
    record.animations = animations;
    Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
      if (record.animations !== animations) return;
      record.animations = [];
      animations.forEach((animation) => animation.cancel());
    });
  }
  const observer = Observer ? new Observer((entries) => {
    entries.filter((entry) => entry.isIntersecting && entry.intersectionRatio > 0).forEach((entry, index) => {
      const record = owners.get(entry.target);
      if (record?.pending && record.node === entry.target) reveal(record, Math.min(index, 3) * 80);
    });
  }, { threshold: 0 }) : null;

  function sync(nextRoute, root, { animate = true } = {}) {
    if (route !== nextRoute) {
      records.forEach(stop); records.clear(); observer?.disconnect(); route = nextRoute;
    }
    const present = new Set();
    for (const node of root?.querySelectorAll('[data-page-chart]') || []) {
      if (node.closest('.agent-workspace-page, #agent-panel')) continue;
      const key = node.dataset.pageChart;
      const version = node.dataset.pageChartVersion;
      const domain = node.dataset.pageChartDomain;
      present.add(key);
      let record = records.get(key);
      if (animate && record?.node === node && record.version === version && record.domain === domain && (record.pending || record.seen || !record.targets.length)) continue;
      const changed = record && record.version !== version;
      // A new time axis redraws the chart; ordinary polling only fades changed values.
      const redraw = ['line', 'heatmap'].includes(node.dataset.pageChartType) && record &&
        ((record.pending && record.redraw) || (domain !== undefined && record.domain !== domain));
      if (record) stop(record);
      else { record = { seen: false, targets: [], animations: [], pending: false }; records.set(key, record); }
      record.node = node; record.version = version; record.domain = domain;
      record.redraw = animate && Boolean(redraw);
      record.targets = [...node.querySelectorAll(selectors[node.dataset.pageChartType] || ':not(*)')];
      owners.set(node, record);
      if (!animate) { if (record.targets.length) record.seen = true; continue; }
      if (!record.targets.length || (record.seen && !changed && !record.redraw)) continue;
      if (!observer || preference?.matches) { record.seen = true; continue; }
      record.pending = true;
      if (!record.seen || record.redraw) record.targets.forEach((target) => target.classList.add('page-chart-mark-pending'));
      observer.observe(node);
    }
    records.forEach((record, key) => { if (!present.has(key)) stop(record); });
  }
  const reduce = () => {
    if (!preference?.matches) return;
    records.forEach((record) => { stop(record); if (record.targets.length) record.seen = true; });
  };
  preference?.addEventListener('change', reduce);
  function dispose() {
    records.forEach(stop); records.clear(); observer?.disconnect(); route = undefined;
    preference?.removeEventListener('change', reduce);
  }
  return { sync, dispose };
}

export const pageChartMotion = createPageChartMotion();
