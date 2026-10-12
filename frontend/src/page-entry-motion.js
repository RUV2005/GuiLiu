import { reportRoutes, reportEntryBands, reportEntryFrames, reportEntryDeadline } from './report-entry-motion.js';

const duration = 800;
const stagger = 90;
const maxDelay = 450;
const maxTargets = 18;
const ease = 'cubic-bezier(.32,0,.14,1)';
const layouts = '.overview-grid, .insight-grid, .settings-form, .asset-inspect-layout, .goals-layout, .plans-layout, .prompt-layout, .review-layout';

function pageBands(page) {
  const candidates = [];
  for (const child of page.children) {
    if (child.matches(layouts)) candidates.push(...child.children);
    else candidates.push(child);
  }
  // Measure sections only, never the rows in a ledger or marks in a chart.
  const bands = candidates.filter((node) => !node.hidden && !node.matches('script, style, template'))
    .slice(0, maxTargets).map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  let row = -1;
  let rowTop = -Infinity;
  return bands.map(({ node, rect }) => {
    if (rect.top - rowTop > 10) { row++; rowTop = rect.top; }
    return { node, delay: Math.min(row * stagger, maxDelay) };
  });
}

export function createPageEntryMotion({
  preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),
  document: doc = globalThis.document,
  now = () => globalThis.performance.now(),
} = {}) {
  let route;
  let startedAt = 0;
  let ended = true;
  let currentPage;
  let currentRoot;
  let active = [];

  function clear() {
    const previous = active;
    active = [];
    previous.forEach((animation) => animation.cancel());
  }

  function finish() {
    ended = true;
    clear();
  }

  function sync(nextRoute, root) {
    if (route !== nextRoute) {
      clear();
      route = nextRoute;
      startedAt = now();
      currentPage = null;
      ended = nextRoute === 'agent';
    }
    if (ended) return;
    const elapsed = Math.max(0, now() - startedAt);
    const report = reportRoutes.has(nextRoute);
    if (preference?.matches || doc?.hidden || elapsed >= (report ? reportEntryDeadline : duration + maxDelay)) { finish(); return; }
    const page = root?.querySelector('.page');
    if (!page) { clear(); currentPage = null; return; }
    if (page === currentPage) return;
    clear();
    currentPage = page;
    currentRoot = root;
    if (page.matches('.agent-workspace-page')) { finish(); return; }

    const animations = [];
    for (const band of report ? reportEntryBands(page, root, doc) : pageBands(page)) {
      const { node, delay } = band;
      const time = report ? band.duration : duration;
      if (!node.animate || elapsed >= time + delay) continue;
      try {
        const animation = node.animate(report ? reportEntryFrames(band) : [
          { opacity: 0, transform: 'translateY(14px)' },
          { opacity: 1, transform: 'none' },
        ], { duration: time, delay, easing: ease, fill: 'both' });
        animations.push(animation);
        // An async data render continues this entrance instead of starting over.
        animation.currentTime = elapsed;
      } catch {
        animations.forEach((animation) => animation.cancel());
        finish();
        return;
      }
    }
    if (!animations.length) { finish(); return; }
    active = animations;
    Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
      if (active === animations) finish();
    });
  }

  const reduce = () => { if (preference?.matches) finish(); };
  const visibility = () => { if (doc?.hidden) finish(); };
  const interact = event => { if (!ended && reportRoutes.has(route) && currentRoot?.contains?.(event.target)) finish(); };
  const resize = () => { if (reportRoutes.has(route)) finish(); };
  const interactionEvents = ['pointerdown', 'focusin', 'wheel', 'touchstart', 'scroll'];
  interactionEvents.forEach(type => doc?.addEventListener(type, interact, { capture: true, passive: true }));
  doc?.defaultView?.addEventListener('resize', resize);
  doc?.addEventListener('abk-sidebar-change', resize);
  preference?.addEventListener('change', reduce);
  doc?.addEventListener('visibilitychange', visibility);
  function dispose() {
    finish();
    currentPage = null;
    currentRoot = null;
    route = undefined;
    preference?.removeEventListener('change', reduce);
    doc?.removeEventListener('visibilitychange', visibility);
    interactionEvents.forEach(type => doc?.removeEventListener(type, interact, true));
    doc?.defaultView?.removeEventListener('resize', resize);
    doc?.removeEventListener('abk-sidebar-change', resize);
  }
  return { sync, finish, dispose };
}

export const pageEntryMotion = createPageEntryMotion();
