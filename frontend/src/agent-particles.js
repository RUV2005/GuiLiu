import { AGENT_TRANSITION_MS, AGENT_GATHER_RATIO } from './agent-presentation-state.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const noise = (i, salt) => { const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return x - Math.floor(x); };
const jobs = new Set();
// Water, not dust: white droplets in dark mode, blue-black ink in light mode. One in TINT_EVERY droplets
// carries a cool tint and a longer wake: the sparse coloured lines that mark AI in the UI texture brief.
export const particleRgb = theme => theme === 'light' ? '22,30,42' : '255,255,255';
export const particleTints = theme => theme === 'light' ? ['14,116,144', '91,74,190'] : ['132,214,255', '188,170,255'];
export const particleBudget = (route, width) => width <= 720 ? 1000 : route === 'bottom' ? 4200 : 2400;
const TINT_EVERY = 41;
const SMALL_AREA = 6400;
const LEVELS = 4;
const BAND_WIDTH = [.9, 1.5, 2.4];
const R2 = [.7548776662466927, .5698402909980532];

function bottomPortal(rect, index, count, height) {
  return { x: rect.left + rect.width * ((index + .5) / count), y: height + 8 + noise(index, 6) * 56 };
}
const portalRect = (rect, height) => ({ left: rect.left, top: height + 8, width: rect.width, height: 56 });

function bezier(a, c1, c2, b, t) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * b;
}

// A water silhouette instead of a stipple grid: a third of the droplets bead along the rounded rim (the meniscus),
// the rest fill the body on a low-discrepancy sequence, so neither rows nor columns show.
export function samplePanel(rect, i, count) {
  const w = Math.max(1, rect.width), h = Math.max(1, rect.height), radius = Math.min(29, w / 2, h / 2);
  let x, y;
  if (i % 3 === 0) {
    const perimeter = 2 * (w + h), inset = 1 + noise(i, 2) ** 2 * Math.min(8, w / 4, h / 4);
    const distance = (((i / 3 + noise(i, 1) * .7) / Math.ceil(count / 3)) * perimeter) % perimeter;
    if (distance < w) { x = distance; y = inset; }
    else if (distance < w + h) { x = w - inset; y = distance - w; }
    else if (distance < w * 2 + h) { x = w - (distance - w - h); y = h - inset; }
    else { x = inset; y = h - (distance - w * 2 - h); }
  } else {
    x = w * ((.5 + i * R2[0]) % 1);
    y = h * ((.5 + i * R2[1]) % 1);
  }
  const cx = clamp(x, radius, w - radius), cy = clamp(y, radius, h - radius);
  const distance = Math.hypot(x - cx, y - cy);
  if (distance > radius) { x = cx + (x - cx) * radius / distance; y = cy + (y - cy) * radius / distance; }
  return { x: rect.left + x, y: rect.top + y };
}

function particleParams(index) {
  const size = noise(index, 5), tint = index % TINT_EVERY === 0 ? 1 + Math.floor(index / TINT_EVERY) % 2 : 0;
  return { brightness: .72 + noise(index, 4) * .28,
    // Mostly fine mist with a few large droplets.
    radius: .55 + size * size * size * 1.9, band: size < .5 ? 0 : size < .82 ? 1 : 2, tint,
    wake: tint ? .03 + noise(index, 9) * .02 : .012 + noise(index, 9) * .016,
    early: noise(index, 3), late: noise(index, 10), flow: 10 + noise(index, 11) * 22,
    laneOffset: 18 + noise(index, 7) * 48, spread: (noise(index, 8) - .5) * 52,
    sin: Math.sin(index * 2.399), cos: Math.cos(index * 2.399) };
}

const middle = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const along = (rect, ux, uy) => (Math.abs(ux) * rect.width + Math.abs(uy) * rect.height) / 2 || 1;

// Shared geometry of one flight. Droplets leave front first, squeeze through one neck (water seeping through a gap)
// and fill the destination from the side they enter, so the flight reads as a single stream rather than a cloud.
export function particleFlight(from, to, bottom) {
  const a = middle(from), b = middle(to);
  let ux = b.x - a.x, uy = b.y - a.y;
  const distance = Math.hypot(ux, uy) || 1;
  ux /= distance; uy /= distance;
  const sign = ux >= 0 ? -1 : 1, px = -uy * sign, py = ux * sign; // the bow always rises
  const bow = Math.min(140, distance * .16);
  return { bottom: Number.isFinite(bottom), ax: a.x, ay: a.y, bx: b.x, by: b.y, ux, uy, px, py,
    mx: (a.x + b.x) / 2 + px * bow, my: (a.y + b.y) / 2 + py * bow,
    neck: clamp(Math.min(from.width, from.height, to.width, to.height) * .22 + 18, 18, 72),
    sourceAlong: along(from, ux, uy), sourceAcross: along(from, px, py), targetAlong: along(to, ux, uy),
    sourceTop: from.top, sourceHeight: Math.max(1, from.height), targetTop: to.top, targetHeight: Math.max(1, to.height),
    smallSource: from.width * from.height < SMALL_AREA, smallTarget: to.width * to.height < SMALL_AREA };
}

function preparePath(a, b, q, bottom, flight) {
  q.dx = b.x - a.x; q.dy = b.y - a.y;
  const route = Number.isFinite(bottom);
  if (flight) {
    // Lead: 1 for droplets that leave first. Fill: 0 for droplets that arrive first.
    const lead = route ? clamp((a.y - flight.sourceTop) / flight.sourceHeight, 0, 1)
      : clamp(((a.x - flight.ax) * flight.ux + (a.y - flight.ay) * flight.uy) / (2 * flight.sourceAlong) + .5, 0, 1);
    const fill = route ? 1 - clamp((b.y - flight.targetTop) / flight.targetHeight, 0, 1)
      : clamp(((b.x - flight.bx) * flight.ux + (b.y - flight.by) * flight.uy) / (2 * flight.targetAlong) + .5, 0, 1);
    q.start = .06 + (1 - lead) * .09 + q.early * .02;
    q.end = Math.min(AGENT_GATHER_RATIO, .62 + fill * .13 + q.late * .03);
  } else {
    q.start = .08 + q.early * .08;
    q.end = q.start + AGENT_GATHER_RATIO - .16;
  }
  let mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  if (route) {
    q.middleX = mx + q.spread; q.tangent = q.dx * .14; q.lane = bottom - q.laneOffset;
  } else {
    let nx, ny;
    if (flight) {
      // Keep each droplet's side of the stream so currents do not cross while squeezing through the neck.
      const side = clamp(((a.x - flight.ax) * flight.px + (a.y - flight.ay) * flight.py) / flight.sourceAcross, -1, 1);
      const drift = (q.late - .5) * flight.neck * 1.6;
      nx = flight.mx + flight.px * side * flight.neck + flight.ux * drift;
      ny = flight.my + flight.py * side * flight.neck + flight.uy * drift;
    } else {
      const bend = Math.min(110, Math.hypot(q.dx, q.dy) * .18 + 14);
      nx = mx + q.sin * bend; ny = my + q.cos * bend * .65;
    }
    // Quadratic control point that makes the path pass the neck at mid-travel.
    q.cx = 2 * nx - mx; q.cy = 2 * ny - my; mx = nx; my = ny;
  }
  // Coherent currents: neighbouring droplets sample the same smooth field, so they bend together like water.
  const angle = Math.sin(mx * .0047 + Math.cos(my * .0061) * 1.9) * 2.6 + Math.cos(my * .0039 - mx * .0021) * 1.5;
  const c = Math.cos(angle), s = Math.sin(angle);
  q.fx = c * q.flow; q.fy = s * q.flow * (route ? .35 : 1);
  q.gx = -s * q.flow * .8; q.gy = route ? 0 : c * q.flow * .8;
}

// Per frame: polynomials only, no trigonometry or random numbers.
function writePosition(a, b, progress, q, bottom, alpha, point) {
  const t = smooth((progress - q.start) / (q.end - q.start)), u = 1 - t;
  const swell = 4 * t * u, swirl = 10.4 * t * u * (1 - 2 * t);
  point.alpha = alpha * q.brightness;
  if (Number.isFinite(bottom)) {
    const { lane, spread, middleX, tangent } = q;
    // Two cubic arcs share a horizontal tangent along the lower screen edge: water draining along a gutter.
    const arriving = t >= .5, k = arriving ? t * 2 - 1 : t * 2;
    const c1x = arriving ? middleX + tangent : a.x + spread;
    const c2x = arriving ? b.x - spread : middleX - tangent;
    point.x = bezier(arriving ? middleX : a.x, c1x, c2x, arriving ? b.x : middleX, k);
    point.y = bezier(arriving ? lane : a.y, lane, lane, arriving ? b.y : lane, k);
  } else {
    point.x = u * u * a.x + 2 * u * t * q.cx + t * t * b.x;
    point.y = u * u * a.y + 2 * u * t * q.cy + t * t * b.y;
  }
  point.x += q.fx * swell + q.gx * swirl;
  point.y += q.fy * swell + q.gy * swirl;
  return point;
}

// Surfaces cross-fade with the whole stream; a trigger icon releases and absorbs droplets one by one instead.
function alphaAt(progress, q, flight) {
  const appear = flight?.smallSource ? smooth((progress - q.start + .05) / .05) : smooth(progress / .19);
  const vanish = flight?.smallTarget ? 1 - smooth((progress - q.end + .02) / .06)
    : 1 - smooth((progress - AGENT_GATHER_RATIO) / (1 - AGENT_GATHER_RATIO));
  return appear * vanish;
}

export function particlePosition(a, b, progress, index, bottom, flight) {
  const params = particleParams(index);
  preparePath(a, b, params, bottom, flight);
  return writePosition(a, b, progress, params, bottom, alphaAt(progress, params, flight), {});
}

export function agentBounds(doc = document) {
  const sidebar = doc.querySelector('.app-shell > .sidebar')?.getBoundingClientRect();
  const mobile = globalThis.matchMedia?.('(max-width: 720px)')?.matches;
  const left = !mobile && sidebar ? clamp(sidebar.right, 0, innerWidth) : 0;
  return { left, top: 0, width: Math.max(0, innerWidth - left), height: innerHeight };
}

// A job owns its canvas. Unrelated UI cleanup must not cancel an Agent flight.
export function cancelAgentParticles() { [...jobs].forEach((job) => job.cancel()); }

export function playAgentParticles(from, to, { duration = AGENT_TRANSITION_MS, seeds, onFrame, route = 'direct', fromBottom = false, toBottom = false } = {}) {
  if (!from?.width || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.className = 'agent-particle-layer'; canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const count = seeds?.length || particleBudget(route, innerWidth);
  const startRect = fromBottom ? (typeof to === 'function' ? to() : to) || from : from;
  const start = seeds || Array.from({ length: count }, (_, i) => fromBottom ? bottomPortal(startRect, i, count, innerHeight) : samplePanel(from, i, count));
  const sourceRect = fromBottom ? portalRect(startRect, innerHeight) : from;
  const points = start.map(point => ({ ...point }));
  const tails = start.map(() => ({ x: 0, y: 0, alpha: 0 }));
  const params = Array.from({ length: count }, (_, i) => particleParams(i));
  // Counting sort by colour, size and alpha level: each batched path walks only its own droplets.
  const BUCKETS = 9 * LEVELS, buckets = new Uint8Array(count), order = new Uint32Array(count);
  const offsets = new Uint32Array(BUCKETS + 1), cursor = new Uint32Array(BUCKETS);
  let targets, targetRect, targetHeight, flight, raf = 0, stopped = false, began, width = 0, height = 0, dpr = 0, resolve;
  const finished = new Promise((done) => { resolve = done; });
  function cancel() {
    if (stopped) return;
    stopped = true; cancelAnimationFrame(raf); canvas.remove(); jobs.delete(job); resolve();
  }
  const job = { cancel, finished, get points() { return points; }, get flight() { return flight; } };
  jobs.add(job);
  function draw(now) {
    if (stopped) return;
    began ??= now;
    const p = clamp((now - began) / duration, 0, 1);
    const bounds = agentBounds();
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    if (width !== innerWidth || height !== innerHeight || dpr !== ratio) {
      width = innerWidth; height = innerHeight; dpr = ratio;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.save(); ctx.beginPath(); ctx.rect(bounds.left, 0, bounds.width, bounds.height); ctx.clip();
    const end = (typeof to === 'function' ? to() : to) || from;
    const target = toBottom ? from : end;
    const lane = route === 'bottom' ? height : undefined;
    // Layout may move during a flight. Rebuild geometry only when it actually changes.
    if (!targetRect || targetHeight !== height || targetRect.left !== target.left || targetRect.top !== target.top ||
      targetRect.width !== target.width || targetRect.height !== target.height) {
      targetRect = { left: target.left, top: target.top, width: target.width, height: target.height }; targetHeight = height;
      flight = particleFlight(sourceRect, toBottom ? portalRect(from, height) : end, lane);
      targets = start.map((a, i) => {
        const b = toBottom ? bottomPortal(from, i, count, height) : samplePanel(end, i, count);
        preparePath(a, b, params[i], lane, flight);
        return b;
      });
    }
    const seedAlpha = seeds && p < .19 ? 1 - smooth(p / .19) : 0;
    for (let i = 0; i < count; i++) {
      const q = params[i], point = points[i];
      writePosition(start[i], targets[i], p, q, lane, alphaAt(p, q, flight), point);
      if (seedAlpha) point.alpha += (start[i].alpha || 0) * seedAlpha;
      if (point.alpha < .02) { buckets[i] = 255; continue; }
      writePosition(start[i], targets[i], Math.max(0, p - q.wake), q, lane, 0, tails[i]);
      buckets[i] = (q.tint * 3 + q.band) * LEVELS + Math.min(LEVELS - 1, point.alpha * LEVELS | 0);
    }
    offsets.fill(0);
    for (let i = 0; i < count; i++) if (buckets[i] !== 255) offsets[buckets[i] + 1]++;
    for (let k = 0; k < BUCKETS; k++) { offsets[k + 1] += offsets[k]; cursor[k] = offsets[k]; }
    for (let i = 0; i < count; i++) if (buckets[i] !== 255) order[cursor[buckets[i]]++] = i;
    const theme = document.documentElement?.dataset?.theme;
    const rgb = particleRgb(theme), tints = particleTints(theme);
    ctx.lineCap = 'round';
    // A few batched paths per colour, size and alpha level: never one draw call or shadow per droplet.
    function layer(color, tint, band, level, part) {
      const id = (tint * 3 + band) * LEVELS + level, alpha = (level + .6) / LEVELS;
      if (offsets[id] === offsets[id + 1]) return;
      ctx.beginPath();
      for (let n = offsets[id]; n < offsets[id + 1]; n++) {
        const i = order[n], point = points[i], r = params[i].radius;
        const x = clamp(point.x, bounds.left + r, width - r), y = route === 'bottom' ? point.y : clamp(point.y, r, height - r);
        if (part === 'wake') { ctx.moveTo(tails[i].x, tails[i].y); ctx.lineTo(x, y); }
        else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
      }
      if (part === 'wake') {
        ctx.lineWidth = BAND_WIDTH[band] * (tint ? 1 : .8);
        ctx.strokeStyle = `rgba(${color},${alpha * (tint ? .55 : .26)})`; ctx.stroke();
      } else { ctx.fillStyle = `rgba(${color},${alpha})`; ctx.fill(); }
    }
    for (let tint = 1; tint <= 2; tint++) for (let band = 0; band < 3; band++) for (let level = 0; level < LEVELS; level++) layer(tints[tint - 1], tint, band, level, 'drop');
    for (let band = 0; band < 3; band++) for (let level = 0; level < LEVELS; level++) layer(rgb, 0, band, level, 'wake');
    for (let band = 0; band < 3; band++) for (let level = 0; level < LEVELS; level++) layer(rgb, 0, band, level, 'drop');
    // Tinted wakes last: the coloured lines stay legible on top of the white stream.
    for (let tint = 1; tint <= 2; tint++) for (let band = 0; band < 3; band++) for (let level = 0; level < LEVELS; level++) layer(tints[tint - 1], tint, band, level, 'wake');
    ctx.restore(); onFrame?.(p, { end, bounds, flight });
    if (p >= 1 || document.hidden) cancel();
    else raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);
  return job;
}
