export { AGENT_TRANSITION_MS as WORKSPACE_ENTER_MS } from './agent-presentation-state.js';
const ease = 'cubic-bezier(.32,0,.14,1)';
const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const active = new Map();
const queued = new Map();
let canvasRoot;
let observer;
let revealAfter = 0;
let canvasDeferred = false;

function play(owner, target, frames, duration, delay = 0) {
  if (!target?.animate || preference?.matches) return;
  const animation = target.animate(frames, { duration, delay, easing: ease, fill: 'backwards' });
  animation.finished?.catch(() => {});
  const animations = active.get(owner) || new Set();
  active.set(owner, animations); animations.add(animation);
  const release = () => { animations.delete(animation); if (!animations.size && active.get(owner) === animations) active.delete(owner); };
  animation.onfinish = release; animation.oncancel = release;
  return animation;
}

export function forgetChartMotion(node) {
  observer?.unobserve(node); queued.delete(node);
  node.classList.remove('agent-chart-pending');
  active.get(node)?.forEach((animation) => animation.cancel());
  active.delete(node);
}

export function disposeAgentMotion() {
  observer?.disconnect(); observer = null;
  queued.forEach((job, node) => node.classList.remove('agent-chart-pending'));
  queued.clear(); canvasRoot = null; revealAfter = 0;
  active.forEach((animations) => animations.forEach((animation) => animation.cancel()));
  active.clear();
}
preference?.addEventListener('change', () => { if (preference.matches) disposeAgentMotion(); });

function revealChart(node, type, delay) {
  node.classList.remove('agent-chart-pending');
  if (!node.isConnected || preference?.matches) return;
  delay += Math.max(0, revealAfter - performance.now());
  play(node, node, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], 800, delay);
  if (type === 'line') {
    node.querySelectorAll('.chart-line').forEach((path) => {
      const length = path.getTotalLength();
      if (length > 0) play(node, path, [{ strokeDasharray: length + ' ' + length, strokeDashoffset: length },
        { strokeDasharray: length + ' ' + length, strokeDashoffset: 0 }], 2000, delay + 120);
    });
    [...node.querySelectorAll('.chart-point.is-isolated')].slice(0, 80).forEach((point) => play(node, point, [{ opacity: 0 }, { opacity: 1 }], 520, delay + 1020));
  } else if (type === 'pie') {
    node.querySelectorAll('.agent-pie-segment').forEach((segment, index) => {
      // Hover translates the parent group; entry animates the inner sector independently.
      play(node, segment, [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], 1240, delay + Math.min(index, 7) * 55);
    });
  } else if (type === 'bar') {
    const bars = [...node.querySelectorAll('.agent-bar-mark')];
    if (bars.length <= 60) bars.forEach((bar, index) => play(node, bar,
      [{ transform: bar.dataset.barAxis === 'x' ? 'scaleX(0)' : 'scaleY(0)' }, { transform: 'none' }], 1160, delay + Math.min(index, 8) * 50));
    else play(node, node.querySelector('.agent-plot-scroll'), [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], 1160, delay);
  } else if (type === 'table') {
    [...node.querySelectorAll('tbody tr')].slice(0, 8).forEach((row, index) => play(node, row,
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 620, delay + index * 65));
  } else if (type === 'metric') {
    play(node, node.querySelector('.agent-metric-value'), [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], 1020, delay + 160);
  }
}

export function prepareCanvasMotion(container) {
  if (canvasRoot === container) return;
  disposeAgentMotion(); canvasRoot = container;
  if (!container || preference?.matches || !globalThis.IntersectionObserver) return;
  observer = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry, index) => {
      const job = queued.get(entry.target);
      observer?.unobserve(entry.target); queued.delete(entry.target);
      if (job) revealChart(entry.target, job.type, Math.min(index, 4) * 90);
    });
  }, { root: container.closest('.agent-evidence-column'), threshold: 0.06 });
}

export function queueChartMotion(node, type) {
  forgetChartMotion(node);
  if (preference?.matches) return;
  if (canvasDeferred) {
    queued.set(node, { type }); node.classList.add('agent-chart-pending'); return;
  }
  if (observer) { queued.set(node, { type }); observer.observe(node); }
  else revealChart(node, type, 0);
}

export function deferCanvasMotion() { canvasDeferred = true; }
export function revealCanvasScrollbar(delay = 0) {
  const canvas = globalThis.document?.querySelector('.agent-evidence-column');
  if (!canvas?.isConnected) return;
  play(canvas, canvas, [{ '--agent-scrollbar-alpha': 0 }, { '--agent-scrollbar-alpha': 1 }], 360, delay);
}

function revealCanvasIntro(delay = 0) {
  const canvas = globalThis.document?.querySelector('.agent-evidence-column');
  if (!canvas?.isConnected) return;
  const heading = canvas.querySelector?.('.agent-canvas-heading');
  const empty = canvas.querySelector?.('.agent-canvas-empty');
  [heading, empty].forEach((node, index) => play(node, node,
    [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], 800, delay + index * 90));
}

export function resumeCanvasMotion({ revealScrollbar = false } = {}) {
  const wasDeferred = canvasDeferred;
  canvasDeferred = false;
  if (revealScrollbar && wasDeferred) {
    revealAfter = performance.now() + 90;
    const canvas = globalThis.document?.querySelector('.app-shell .agent-evidence-column');
    play(canvas, canvas, [{ opacity: 0 }, { opacity: 1 }], 800);
    revealCanvasIntro();
    revealCanvasScrollbar();
  }
  let index = 0;
  queued.forEach((job, node) => {
    if (observer) observer.observe(node);
    else { queued.delete(node); revealChart(node, job.type, Math.min(index++, 4) * 90); }
  });
}
