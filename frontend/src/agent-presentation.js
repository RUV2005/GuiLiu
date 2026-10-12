import { playAgentParticles } from './agent-particles.js';
import { cloneAgentSnapshot } from './agent-snapshot.js';
import { AGENT_TRANSITION_MS, AGENT_GATHER_RATIO } from './agent-presentation-state.js';

const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
let active, sequence = 0;
const ease = 'cubic-bezier(.22,.68,.18,1)';
const valid = (r) => r && r.width > 1 && r.height > 1;
const rect = (node) => node?.getBoundingClientRect?.();
const sidePanel = (node) => globalThis.innerWidth > 980 && node?.matches?.('.app-shell > #agent-panel');
const chatSurface = (node) => node?.matches?.('.agent-panel, .agent-chat-column, #scroll-dock-popover.is-agent');
export const agentTransitionActive = () => Boolean(active);
export const refreshAgentPresentation = () => active?.refresh?.();

export function agentAnchor() {
  return [...document.querySelectorAll('.app-shell [data-dock-action="agent"], .app-shell [data-route="agent"]')]
    .find((node) => !node.hidden && !node.closest('[hidden], [inert]') && valid(rect(node)));
}

export function visibleAgentSurface() {
  return [...document.querySelectorAll('.app-shell #scroll-dock-popover.is-agent, .app-shell .agent-chat-column, .app-shell #agent-panel')]
    .find((node) => !node.hidden && !node.inert && !node.closest('[hidden]') && valid(rect(node))) || agentAnchor();
}

function snapshot(node, bounds) {
  if (!node || !valid(bounds)) return;
  const ghost = cloneAgentSnapshot(node), styles = getComputedStyle(node);
  // Snapshots never participate in application selectors, focus, forms or live regions.
  for (const item of [ghost, ...ghost.querySelectorAll('*')]) {
    for (const attr of [...item.attributes]) if (/^(id$|data-|on|name$|aria-live$)/.test(attr.name)) item.removeAttribute(attr.name);
    item.removeAttribute('autofocus');
  }
  ghost.className += ' agent-flight-surface'; ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { position: 'fixed', inset: 'auto', margin: '0', left: bounds.left + 'px', top: bounds.top + 'px',
    width: bounds.width + 'px', height: bounds.height + 'px', minWidth: '0', minHeight: '0', maxHeight: 'none',
    display: styles.display, gridTemplateRows: styles.gridTemplateRows, gridTemplateColumns: styles.gridTemplateColumns,
    background: styles.backgroundColor, border: styles.border, borderRadius: styles.borderRadius, overflow: 'hidden', transform: 'none' });
  document.body.append(ghost);
  ghost.scrollTop = node.scrollTop;
  const originals = node.querySelectorAll('.agent-panel-scroll, .agent-report-stream, textarea');
  ghost.querySelectorAll('.agent-panel-scroll, .agent-report-stream, textarea').forEach((item, i) => {
    item.scrollTop = originals[i]?.scrollTop || 0;
    if (item.tagName === 'TEXTAREA') item.value = originals[i]?.value || '';
  });
  return ghost;
}

export function finishAgentTransition() { active?.finish(); }

// Logical state commits once; only this controller owns its visual handover.
export function transitionAgentSurface({ source = visibleAgentSurface(), target, update = () => {}, complete = () => {}, reveal = true, bridgePage = false } = {}) {
  // Capture the source kind before the retained chat node moves to its new layout.
  const sourceSide = sidePanel(source), sourceChat = chatSurface(source);
  const origin = active?.currentRect || rect(source);
  const seeds = active?.particles?.points;
  const ghost = active?.ghost || snapshot(source, origin);
  const ghostOpacity = ghost ? getComputedStyle(ghost).opacity : 1;
  const oldPage = bridgePage ? document.querySelector('.app-shell > #main-view') : null;
  const bridge = oldPage ? snapshot(oldPage, rect(oldPage)) : null;
  if (bridge) { bridge.classList.add('agent-page-bridge'); bridge.classList.remove('agent-flight-surface'); }
  if (active?.ghost === ghost) active.ghost = null;
  finishAgentTransition();
  const id = ++sequence;
  const job = { id, ghost, currentRect: origin, effects: [], particles: null, finish };
  let done = false, resolve, revealTarget, originalVisibility, originalInert, assembled = false, committed = false;
  job.finished = new Promise((settled) => { resolve = settled; });
  active = job;
  function finish() {
    if (done) return;
    done = true;
    job.particles?.cancel(); job.effects.forEach((effect) => effect.cancel()); job.ghost?.remove(); bridge?.remove();
    if (revealTarget) { revealTarget.style.visibility = originalVisibility; revealTarget.inert = originalInert; }
    if (active === job) {
      active = null;
      document.documentElement.classList.remove('agent-surface-transition');
      document.documentElement.removeAttribute('data-agent-transition');
    }
    complete(); resolve();
    document.dispatchEvent?.(new Event('agent-presentation-settled'));
  }
  try {
    document.documentElement.classList.add('agent-surface-transition');
    update();
    committed = true;
    const destination = () => typeof target === 'function' ? target() : target;
    if (preference?.matches || document.hidden || !valid(origin)) { finish(); return job; }
    document.documentElement.classList.add('agent-surface-transition');
    document.documentElement.dataset.agentTransition = String(id);
    if (bridge?.animate) job.effects.push(bridge.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: ease, fill: 'both' }));
    job.refresh = () => {
      const next = destination();
      if (!reveal || !next || next === revealTarget) return;
      const opacity = revealTarget ? getComputedStyle(revealTarget).opacity : 0;
      if (revealTarget) { revealTarget.style.visibility = originalVisibility; revealTarget.inert = originalInert; }
      revealTarget = next; originalVisibility = next.style.visibility; originalInert = next.inert;
      if (!assembled) { next.style.visibility = 'hidden'; next.inert = true; }
      else if (next.animate) job.effects.push(next.animate([{ opacity }, { opacity: 1 }],
        { duration: 160, easing: ease, fill: 'both' }));
    };
    job.refresh();
    // The destination pools out from where the stream enters and condenses from mist into a sharp surface,
    // following the arrival order of the droplets instead of fading in everywhere at once.
    function condense(node) {
      const box = rect(node);
      if (!valid(box)) return [{ opacity: 0 }, { opacity: 1 }];
      const cx = origin.left + origin.width / 2, cy = origin.top + origin.height / 2;
      const x = route === 'bottom' ? box.width / 2 : Math.min(box.width, Math.max(0, cx - box.left));
      const y = route === 'bottom' ? box.height : Math.min(box.height, Math.max(0, cy - box.top));
      const r = Math.ceil(Math.max(Math.hypot(x, y), Math.hypot(box.width - x, y), Math.hypot(x, box.height - y),
        Math.hypot(box.width - x, box.height - y))) + 2;
      const at = 'px at ' + x.toFixed(1) + 'px ' + y.toFixed(1) + 'px)';
      return [{ opacity: 0, filter: 'blur(8px)', clipPath: 'circle(0' + at },
        { opacity: .85, filter: 'blur(2px)', clipPath: 'circle(' + Math.round(r * .72) + at, offset: .55 },
        { opacity: 1, filter: 'blur(0px)', clipPath: 'circle(' + r + at }];
    }
    function assemble() {
      if (assembled || done) return;
      assembled = true;
      if (!revealTarget) return;
      revealTarget.style.visibility = originalVisibility; revealTarget.inert = originalInert;
      if (revealTarget.animate) job.effects.push(revealTarget.animate(condense(revealTarget),
        { duration: AGENT_TRANSITION_MS * (1 - AGENT_GATHER_RATIO), easing: 'cubic-bezier(.22,.68,.18,1)', fill: 'both' }));
    }
    // The source melts: it softens and clears while the same area turns into droplets, then the stream carries it away.
    if (ghost?.animate) job.effects.push(ghost.animate([
      { opacity: ghostOpacity, filter: 'blur(0px)', offset: 0 }, { opacity: ghostOpacity * .5, filter: 'blur(3px)', offset: .12 },
      { opacity: 0, filter: 'blur(10px)', offset: .26 }, { opacity: 0, filter: 'blur(10px)', offset: 1 },
    ], { duration: AGENT_TRANSITION_MS, easing: ease, fill: 'both' }));
    const route = sourceSide || sidePanel(destination()) ? 'bottom' : 'direct';
    job.particles = playAgentParticles(origin, () => rect(destination()) || origin, {
      seeds, route, fromBottom: route === 'bottom' && !sourceChat, toBottom: route === 'bottom' && !chatSurface(destination()),
      onFrame: (p, { end: endRect, bounds }) => {
        job.refresh();
        if (p >= AGENT_GATHER_RATIO) assemble();
        const q = p * p * (3 - 2 * p);
        job.currentRect = Object.fromEntries(['left', 'top', 'width', 'height'].map((key) => [key, origin[key] + (endRect[key] - origin[key]) * q]));
        if (job.ghost) {
          const clip = `inset(0 0 0 ${Math.max(0, bounds.left - origin.left)}px)`;
          if (job.ghost.style.clipPath !== clip) job.ghost.style.clipPath = clip;
        }
      },
    });
    if (!job.particles) assemble();
    Promise.resolve(job.particles?.finished).then(() => Promise.all(job.effects.map((effect) => effect.finished.catch(() => {})))).then(finish);
  } catch (error) {
    finish();
    if (!committed) throw error;
    console.warn('Agent animation unavailable; showing the committed layout.', error);
  }
  return job;
}

preference?.addEventListener('change', () => { if (preference.matches) finishAgentTransition(); });
globalThis.document?.addEventListener('visibilitychange', () => { if (document.hidden) finishAgentTransition(); });
