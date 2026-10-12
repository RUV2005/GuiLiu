import { transitionAgentSurface, agentAnchor, visibleAgentSurface } from './agent-presentation.js';
const ease = 'cubic-bezier(.28,0,.16,1)';
const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const active = new Map();
const disclosures = new WeakMap();

function cancel(owner) {
  const previous = active.get(owner);
  active.delete(owner);
  previous?.forEach((animation) => animation.cancel());
}

function run(owner, specs, complete = () => {}) {
  cancel(owner);
  if (preference?.matches || !owner?.animate) { complete(); return; }
  const animations = specs.filter((spec) => spec.target).map(({ target, frames, duration, delay = 0 }) =>
    target.animate(frames, { duration, delay, easing: ease, fill: 'both' }));
  active.set(owner, animations);
  Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
    if (active.get(owner) !== animations) return;
    active.delete(owner);
    complete();
    animations.forEach((animation) => animation.cancel());
  });
}

export function disposeInterfaceMotion() {
  [...active.keys()].forEach(cancel);
}
preference?.addEventListener('change', () => {
  if (preference.matches) active.forEach((animations) => animations.forEach((animation) => animation.finish()));
});

export function patchTransient(root, markup, kind, enter = true) {
  if (!root) return;
  const old = root.firstElementChild;
  if (!markup) {
    if (!old || old.inert) return;
    old.inert = true; old.setAttribute('aria-hidden', 'true');
    const sheet = kind === 'modal' ? old.querySelector('.modal-sheet') : old;
    run(root, [
      { target: old, frames: [{ opacity: getComputedStyle(old).opacity }, { opacity: 0 }], duration: 240 },
      { target: sheet, frames: [{ transform: 'none' }, { transform: 'translateY(10px)' }], duration: 240 },
    ], () => { if (old.parentNode === root) old.remove(); });
    return;
  }
  cancel(root);
  root.innerHTML = markup;
  if (!enter) return;
  const surface = root.firstElementChild;
  const sheet = kind === 'modal' ? surface?.querySelector('.modal-sheet') : surface;
  run(root, [
    { target: surface, frames: [{ opacity: 0 }, { opacity: 1 }], duration: 420 },
    { target: sheet, frames: [{ transform: kind === 'modal' ? 'translateY(22px)' : 'translateY(12px)' }, { transform: 'none' }], duration: kind === 'modal' ? 580 : 460 },
  ]);
}

export function animateMiniPanel(panel, opening, complete, update = () => {}) {
  if (!panel) { update(); complete?.(); return; }
  return transitionAgentSurface({ source: opening ? visibleAgentSurface() : panel,
    target: () => opening ? document.querySelector('.app-shell > #agent-panel') : agentAnchor(), reveal: opening,
    update: () => { update(); panel.inert = !opening; }, complete });
}

export function patchDisclosure(container, open, markup) {
  if (!container) return;
  let state = disclosures.get(container);
  if (!state) { state = { open: Boolean(container.firstElementChild) }; disclosures.set(container, state); }
  if (state.open === open) return;
  const start = container.getBoundingClientRect().height;
  state.open = open;
  if (open && !container.firstElementChild) container.innerHTML = markup();
  const content = container.firstElementChild;
  if (!content) return;
  content.inert = !open;
  const end = open ? content.getBoundingClientRect().height : 0;
  const opacity = active.has(container) ? getComputedStyle(content).opacity : open ? 0 : 1;
  container.style.overflow = 'hidden';
  run(container, [
    { target: container, frames: [{ height: start + 'px' }, { height: end + 'px' }], duration: open ? 520 : 360 },
    { target: content, frames: [{ opacity }, { opacity: open ? 1 : 0 }], duration: open ? 440 : 260 },
  ], () => {
    container.style.overflow = '';
    if (!state.open && content.parentNode === container) content.remove();
  });
}

export function revealAdrRows(rows) {
  // Never animate virtual row height or all rows during automatic synchronization.
  rows.slice(0, 8).forEach((row, index) => run(row, [{ target: row,
    frames: [{ opacity: 0 }, { opacity: 1 }], duration: 480, delay: index * 35 }]));
}
