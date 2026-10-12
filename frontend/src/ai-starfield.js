// Ambient particles inside the AI glass: a slow field of fine particles and a few stars that swell, sparkle and fade.
// One canvas per glass surface, exactly its box and under its content, so nothing is drawn past the window. The hosts
// are re-rendered wholesale, so a MutationObserver re-attaches canvases; one shared loop draws every live field at about
// 30 fps and stops when none is left. Under reduced motion each field is drawn once, still.
import { particleRgb, particleTints } from './agent-particles.js';

export const STARFIELD_HOSTS = '.agent-panel, .agent-chat-column, .scroll-dock-popover.is-agent, .scroll-dock';
const TAU = Math.PI * 2;
const FRAME_MS = 1000 / 30;
const ease = x => x * x * (3 - 2 * x);

// The chat panel hosted inside the popover shares the popover's field instead of stacking a second one.
export const isStarfieldHost = host => host.matches(STARFIELD_HOSTS) && !host.matches('.scroll-dock-content > .agent-panel');

export function starfieldCounts(width, height) {
  const area = Math.max(0, width) * Math.max(0, height);
  if (!area) return { dust: 0, stars: 0 };
  return { dust: Math.min(70, Math.max(4, Math.round(area / 5200))), stars: Math.min(8, Math.max(1, Math.round(area / 48000))) };
}

// Brighter at the head and the foot of a surface, calmer behind the text in the middle.
export function calmMask(ratio) {
  const edge = Math.min(1, Math.abs(ratio - .5) * 2);
  return .5 + .5 * edge * edge;
}

// A star waits unseen, swells, holds, fades, then reports -1 so it can reappear elsewhere.
export function twinkle(star, now) {
  const u = now - star.start - star.wait;
  if (u < 0) return 0;
  if (u < star.rise) return ease(u / star.rise);
  if (u < star.rise + star.hold) return 1;
  if (u < star.rise + star.hold + star.fall) return 1 - ease((u - star.rise - star.hold) / star.fall);
  return -1;
}

export function placeStar(star, width, height, random, now) {
  return Object.assign(star, {
    x: 8 + random() * Math.max(1, width - 16), y: 8 + random() * Math.max(1, height - 16), start: now,
    wait: 1200 + random() * 5200, rise: 500 + random() * 500, hold: 150 + random() * 450, fall: 900 + random() * 900,
    peak: .7 + random() * .3, core: 1 + random() * .6, glow: 5 + random() * 5, arm: 6 + random() * 6, tint: random() < .5 ? 0 : 1,
  });
}

export function makeDust(width, height, random) {
  return {
    x: random() * width, y: random() * height, r: .45 + random() * .7, alpha: .14 + random() * .26,
    rise: 2 + random() * 5, sway: 3 + random() * 6, period: 7000 + random() * 9000, phase: random() * TAU,
    shimmer: 2600 + random() * 4200, tint: random() < .18 ? (random() < .5 ? 0 : 1) : -1,
  };
}

// Particles drift upward like motes in liquid and re-enter from the bottom at a new column.
export function stepDust(particle, dt, width, height, random) {
  particle.y -= particle.rise * dt / 1000;
  if (particle.y < -3) { particle.y = height + 3; particle.x = random() * width; }
  return particle;
}

export function createAiStarfield({ root = document, doc = document, win = window, random = Math.random } = {}) {
  const fields = new Map();
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const still = () => Boolean(reduced?.matches);
  let frame = 0, last = 0, queued = false, mutations, theme, sizes;

  function fit(field) {
    const width = field.host.clientWidth, height = field.host.clientHeight;
    const ratio = Math.min(win.devicePixelRatio || 1, 2);
    if (width === field.width && height === field.height && ratio === field.ratio) return;
    const scaleX = field.width ? width / field.width : 1, scaleY = field.height ? height / field.height : 1;
    Object.assign(field, { width, height, ratio });
    field.canvas.width = Math.round(width * ratio); field.canvas.height = Math.round(height * ratio);
    field.ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    const counts = starfieldCounts(width, height), now = win.performance.now();
    field.dust.forEach(p => { p.x *= scaleX; p.y *= scaleY; });
    field.stars.forEach(s => { s.x *= scaleX; s.y *= scaleY; });
    while (field.dust.length < counts.dust) field.dust.push(makeDust(width, height, random));
    field.dust.length = counts.dust;
    // New stars start part-way through a cycle so they do not all appear together.
    while (field.stars.length < counts.stars) field.stars.push(placeStar({}, width, height, random, now - random() * 7000));
    field.stars.length = counts.stars;
    if (still()) draw(field, now);
  }

  function draw(field, now) {
    const { ctx, width, height } = field;
    if (!ctx || !width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const light = doc.documentElement.dataset.theme === 'light';
    const base = particleRgb(light ? 'light' : 'dark'), tints = particleTints(light ? 'light' : 'dark');
    const calm = still();
    for (const p of field.dust) {
      const x = p.x + (calm ? 0 : Math.sin(now / p.period * TAU + p.phase) * p.sway);
      const shimmer = calm ? .8 : .65 + .35 * Math.sin(now / p.shimmer * TAU + p.phase);
      const alpha = p.alpha * (light ? .7 : 1) * shimmer * calmMask(p.y / height);
      ctx.fillStyle = `rgba(${p.tint < 0 ? base : tints[p.tint]},${alpha.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, TAU); ctx.fill();
    }
    for (const s of field.stars) {
      let k = calm ? .6 : twinkle(s, now);
      if (k < 0) { placeStar(s, width, height, random, now); k = 0; }
      if (k <= 0) continue;
      const alpha = s.peak * k * (.45 + .55 * calmMask(s.y / height));
      const glow = tints[s.tint], core = light ? tints[s.tint] : '255,255,255';
      const halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.glow);
      halo.addColorStop(0, `rgba(${glow},${(alpha * .55).toFixed(3)})`); halo.addColorStop(1, `rgba(${glow},0)`);
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(s.x, s.y, s.glow, 0, TAU); ctx.fill();
      // Sparkle: four arms that lengthen with the swell and taper to nothing.
      const arm = s.arm * k;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const ray = ctx.createLinearGradient(s.x - dx * arm, s.y - dy * arm, s.x + dx * arm, s.y + dy * arm);
        ray.addColorStop(0, `rgba(${core},0)`); ray.addColorStop(.5, `rgba(${core},${(alpha * .7).toFixed(3)})`); ray.addColorStop(1, `rgba(${core},0)`);
        ctx.strokeStyle = ray; ctx.lineWidth = .8;
        ctx.beginPath(); ctx.moveTo(s.x - dx * arm, s.y - dy * arm); ctx.lineTo(s.x + dx * arm, s.y + dy * arm); ctx.stroke();
      }
      ctx.fillStyle = `rgba(${core},${alpha.toFixed(3)})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.core, 0, TAU); ctx.fill();
    }
  }

  function tick(now) {
    frame = 0;
    if (!fields.size || still()) return;
    if (now - last >= FRAME_MS - 1) {
      for (const field of fields.values()) {
        const dt = Math.min(100, now - (field.time || now)); field.time = now;
        field.dust.forEach(p => stepDust(p, dt, field.width, field.height, random));
        draw(field, now);
      }
      last = now;
    }
    frame = win.requestAnimationFrame(tick);
  }
  const run = () => { if (!frame && fields.size && !still()) frame = win.requestAnimationFrame(tick); };

  function attach(host) {
    let canvas = host.querySelector(':scope > canvas.ai-starfield');
    if (!canvas) {
      canvas = doc.createElement('canvas'); canvas.className = 'ai-starfield'; canvas.setAttribute('aria-hidden', 'true');
      host.prepend(canvas);
    }
    if (fields.get(host)?.canvas === canvas) return;
    const field = { host, canvas, ctx: canvas.getContext('2d'), width: 0, height: 0, ratio: 0, dust: [], stars: [] };
    fields.set(host, field); sizes.observe(host); fit(field);
  }

  function sync() {
    queued = false;
    // A host can be moved rather than re-rendered (the side chat moves into the popover), so drop its field and canvas
    // as soon as it stops qualifying, and sweep any canvas left under a non-host.
    for (const [host, field] of fields) {
      if (field.canvas.isConnected && field.canvas.parentElement === host && isStarfieldHost(host)) continue;
      sizes.unobserve(host); field.canvas.remove(); fields.delete(host);
    }
    for (const canvas of root.querySelectorAll('canvas.ai-starfield')) if (!isStarfieldHost(canvas.parentElement)) canvas.remove();
    for (const host of root.querySelectorAll(STARFIELD_HOSTS)) if (isStarfieldHost(host)) attach(host);
    run();
  }
  const queue = () => { if (!queued) { queued = true; win.requestAnimationFrame(sync); } };

  return {
    start() {
      sizes = new win.ResizeObserver(entries => entries.forEach(entry => { const field = fields.get(entry.target); if (field) fit(field); }));
      mutations = new win.MutationObserver(queue);
      mutations.observe(root, { childList: true, subtree: true });
      // An in-place theme switch keeps the canvases; a still frame must be redrawn in the new colours.
      theme = new win.MutationObserver(() => { if (still()) fields.forEach(field => draw(field, win.performance.now())); });
      theme.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      reduced?.addEventListener?.('change', () => { fields.forEach(field => draw(field, win.performance.now())); run(); });
      sync();
    },
    stop() {
      mutations?.disconnect(); theme?.disconnect(); sizes?.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0; fields.forEach(field => field.canvas.remove()); fields.clear();
    },
    fields,
  };
}
