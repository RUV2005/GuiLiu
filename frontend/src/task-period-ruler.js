import { escapeHtml as h, escapeAttr as a } from './utils.js';

export const PERIOD_MIN = 3600;
export const PERIOD_MAX = 30 * 86400;
const PIXELS_PER_DOUBLING = 240;
const LOG_SPAN = Math.log2(PERIOD_MAX / PERIOD_MIN);
export const PERIOD_SPAN = Math.ceil(LOG_SPAN * PIXELS_PER_DOUBLING);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function periodPosition(seconds) {
  return Math.log2(clamp(Number(seconds) || PERIOD_MIN, PERIOD_MIN, PERIOD_MAX) / PERIOD_MIN) / LOG_SPAN * PERIOD_SPAN;
}
export function periodAtPosition(position) {
  const seconds = PERIOD_MIN * 2 ** (clamp(position, 0, PERIOD_SPAN) / PERIOD_SPAN * LOG_SPAN);
  return clamp(Math.round(seconds / 3600) * 3600, PERIOD_MIN, PERIOD_MAX);
}
export function taskPeriodValue(draft) {
  return draft.kind === 'interval' ? Number(draft.interval_seconds) : draft.kind === 'weekly' ? 604800 : 86400;
}
export function taskPeriodLabel(seconds, language = 'en') {
  const raw = Math.max(0, Number(seconds) || 0);
  let remaining = Math.round(raw / 3600) * 3600;
  const units = { zh: ['天', '小时'], ja: ['日', '時間'], en: ['d', 'h'] };
  if (raw > 0 && raw < PERIOD_MIN) return '< 1 ' + (units[language] || units.en)[1];
  return (remaining !== raw ? '≈ ' : '') + ([86400, 3600].flatMap((size, index) => {
    const count = Math.floor(remaining / size);
    remaining %= size;
    return count ? [count + ' ' + (units[language] || units.en)[index]] : [];
  }).join(' ') || '0');
}

const majorPeriods = [3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800, 1209600, PERIOD_MAX];
const ticks = majorPeriods.map(seconds => ({ seconds, position: periodPosition(seconds), major: true }));
for (let position = 0; position < PERIOD_SPAN; position += 16) {
  if (ticks.some(tick => tick.major && Math.abs(tick.position - position) < 8)) continue;
  ticks.push({ position, major: false, medium: position % 64 === 0 });
}
ticks.sort((left, right) => left.position - right.position);

export function taskPeriodRulerMarkup(seconds, language, label, displayLabel) {
  return '<div class="information-period-ruler" data-task-period-ruler style="--period-span:' + PERIOD_SPAN + 'px">' +
    '<div id="task-period" class="information-period-scroll" data-period-scroll role="slider" tabindex="0" aria-orientation="horizontal" aria-label="' + a(label) +
    '" aria-valuemin="' + PERIOD_MIN + '" aria-valuemax="' + PERIOD_MAX + '" aria-valuenow="' + a(seconds) + '" aria-valuetext="' + a(displayLabel || taskPeriodLabel(seconds, language)) + '">' +
    '<div class="information-period-space" aria-hidden="true"><div class="information-period-strip">' + ticks.map(tick =>
      '<span class="information-period-mark" style="left:' + tick.position + 'px" data-major="' + tick.major + '" data-medium="' + Boolean(tick.medium) + '"' +
      (tick.major ? ' data-period-mark="' + tick.seconds + '"' : '') + '>' +
      (tick.major ? '<small>' + h(taskPeriodLabel(tick.seconds, language)) + '</small>' : '') + '</span>').join('') + '</div></div></div>' +
    '<span class="information-period-needle" aria-hidden="true"></span></div>';
}

export function createTaskPeriodRuler({ window: win = globalThis.window, onChange }) {
  let root, scroll, output, observer, listeners = [], frame, settleTimer;
  let language = 'en', value, displayLabel, disabled = false, active = false, gesture, touching = false, wheelTarget, exactTarget, motionTarget;
  const reduced = () => win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const usable = () => root?.isConnected && !disabled;
  function readout() {
    const label = displayLabel || taskPeriodLabel(value, language);
    if (output) output.textContent = label;
    scroll?.setAttribute('aria-valuenow', String(value));
    scroll?.setAttribute('aria-valuemin', String(Math.min(PERIOD_MIN, value)));
    scroll?.setAttribute('aria-valuemax', String(Math.max(PERIOD_MAX, value)));
    scroll?.setAttribute('aria-valuetext', label);
  }
  function emit() {
    if (!active || !usable()) return;
    // Scroll offsets have browser pixel precision; explicit tick/key choices retain their exact duration.
    const next = exactTarget && Math.abs(scroll.scrollLeft - exactTarget.position) < .6 ? exactTarget.seconds : periodAtPosition(scroll.scrollLeft);
    displayLabel = '';
    root.parentElement.querySelector('.information-period-hint')?.remove();
    if (value !== next || root.dataset.interacted !== 'true') {
      value = next;
      root.dataset.interacted = 'true';
      onChange(next);
    }
    readout();
  }
  function finish() {
    if (!scroll) return;
    scroll.scrollTo({ left: scroll.scrollLeft, behavior: 'instant' });
    emit();
    active = false; wheelTarget = exactTarget = motionTarget = undefined;
    if (frame) win.cancelAnimationFrame(frame);
    win?.clearTimeout(settleTimer); frame = undefined;
  }
  function settled() {
    if (gesture || touching) return;
    // A cancelled scroll can finish after the next gesture has already started.
    if (motionTarget != null && Math.abs(scroll.scrollLeft - motionTarget) >= .6) return;
    emit(); active = false; wheelTarget = exactTarget = motionTarget = undefined;
    if (root) root.dataset.dragging = 'false';
  }
  function onScroll() {
    if (!active || !usable()) return;
    if (!frame) frame = win.requestAnimationFrame(() => { frame = undefined; emit(); });
    win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(settled, 180);
  }
  function moveTo(position, smooth = true, seconds) {
    active = true;
    const target = clamp(position, 0, PERIOD_SPAN);
    motionTarget = target;
    const immediate = !smooth || reduced(), unchanged = Math.abs(target - scroll.scrollLeft) < .1;
    exactTarget = seconds == null ? undefined : { position: target, seconds: clamp(seconds, PERIOD_MIN, PERIOD_MAX) };
    scroll.scrollTo({ left: target, behavior: immediate ? 'instant' : 'smooth' });
    if (immediate || unchanged) settled();
  }
  function pointerDown(event) {
    if (!usable() || event.button !== 0) return;
    finish(); active = true;
    if (event.pointerType === 'touch') { touching = true; return; }
    event.preventDefault();
    scroll.focus({ preventScroll: true });
    gesture = { id: event.pointerId, x: event.clientX, start: scroll.scrollLeft, last: scroll.scrollLeft, time: event.timeStamp, velocity: 0,
      tick: event.target.closest('[data-period-mark]')?.dataset.periodMark, moved: false };
    root.dataset.dragging = 'true';
    scroll.setPointerCapture(event.pointerId);
  }
  function pointerMove(event) {
    if (!gesture || gesture.id !== event.pointerId || !usable()) return;
    const position = clamp(gesture.start + gesture.x - event.clientX, 0, PERIOD_SPAN);
    const elapsed = Math.max(1, event.timeStamp - gesture.time);
    gesture.velocity = .65 * ((position - gesture.last) / elapsed) + .35 * gesture.velocity;
    gesture.last = position; gesture.time = event.timeStamp;
    gesture.moved ||= Math.abs(event.clientX - gesture.x) > 3;
    scroll.scrollLeft = position;
    onScroll();
  }
  function pointerEnd(event) {
    touching = false;
    if (!gesture || gesture.id !== event.pointerId) return;
    const ended = gesture; gesture = undefined;
    if (scroll.hasPointerCapture(event.pointerId)) scroll.releasePointerCapture(event.pointerId);
    root.dataset.dragging = 'false';
    emit();
    if (event.type !== 'pointerup' || !usable()) { finish(); return; }
    if (!ended.moved) {
      const rect = scroll.getBoundingClientRect();
      moveTo(ended.tick ? periodPosition(ended.tick) : scroll.scrollLeft + event.clientX - rect.left - rect.width / 2, true, ended.tick ? Number(ended.tick) : undefined);
    } else if (!reduced() && event.timeStamp - ended.time < 100 && Math.abs(ended.velocity) > .15) {
      moveTo(scroll.scrollLeft + clamp(ended.velocity * 150, -280, 280));
    } else settled();
  }
  function wheel(event) {
    if (!usable() || event.ctrlKey || event.metaKey || gesture) return;
    const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientWidth : 1);
    const previous = wheelTarget ?? scroll.scrollLeft;
    const next = clamp(previous + clamp(delta, -240, 240), 0, PERIOD_SPAN);
    if (Math.abs(next - previous) < .1) return;
    event.preventDefault();
    wheelTarget = next; moveTo(next);
  }
  function keydown(event) {
    if (!usable() || event.ctrlKey || event.metaKey || event.altKey) return;
    const increment = event.shiftKey ? 36000 : 3600;
    const positions = { Home: 0, End: PERIOD_SPAN, PageUp: scroll.scrollLeft + 240, PageDown: scroll.scrollLeft - 240,
      ArrowRight: periodPosition(value + increment), ArrowUp: periodPosition(value + increment),
      ArrowLeft: periodPosition(value - increment), ArrowDown: periodPosition(value - increment) };
    if (!(event.key in positions)) return;
    const exact = { Home: PERIOD_MIN, End: PERIOD_MAX, ArrowRight: value + increment, ArrowUp: value + increment,
      ArrowLeft: value - increment, ArrowDown: value - increment };
    event.preventDefault(); finish(); moveTo(positions[event.key], false, exact[event.key]);
  }
  function dispose() {
    if (frame) win.cancelAnimationFrame(frame);
    win?.clearTimeout(settleTimer);
    observer?.disconnect();
    for (const [name, handler, options] of listeners) scroll.removeEventListener(name, handler, options);
    if (gesture && scroll?.hasPointerCapture(gesture.id)) scroll.releasePointerCapture(gesture.id);
    root = scroll = output = observer = gesture = frame = undefined;
    active = touching = false; listeners = []; wheelTarget = exactTarget = motionTarget = undefined;
  }
  function mount(next, options = {}) {
    if (!next) { dispose(); return; }
    const fresh = next !== root;
    if (fresh) {
      dispose(); root = next; scroll = root.querySelector('[data-period-scroll]');
      output = root.parentElement.querySelector('[data-task-period-label]');
      const measure = () => { if (root?.isConnected) root.style.setProperty('--period-width', scroll.clientWidth + 'px'); };
      measure();
      if (win?.ResizeObserver) { observer = new win.ResizeObserver(measure); observer.observe(scroll); }
      listeners = [['scroll', onScroll, { passive: true }], ['scrollend', settled], ['pointerdown', pointerDown], ['pointermove', pointerMove],
        ['pointerup', pointerEnd], ['pointercancel', pointerEnd], ['lostpointercapture', pointerEnd], ['wheel', wheel, { passive: false }], ['keydown', keydown]];
      for (const [name, handler, settings] of listeners) scroll.addEventListener(name, handler, settings);
    }
    language = options.language || 'en';
    disabled = Boolean(options.disabled);
    root.dataset.disabled = String(disabled);
    scroll.tabIndex = disabled ? -1 : 0;
    scroll.setAttribute('aria-disabled', String(disabled));
    if (fresh || (options.value !== value && !active)) {
      value = options.value;
      scroll.scrollTo({ left: periodPosition(value), behavior: 'instant' });
    }
    displayLabel = options.displayLabel || '';
    for (const mark of root.querySelectorAll('[data-period-mark]')) mark.querySelector('small').textContent = taskPeriodLabel(Number(mark.dataset.periodMark), language);
    readout(); root.dataset.ready = 'true';
    if (disabled && active) finish();
  }
  return { mount, finish, dispose };
}
