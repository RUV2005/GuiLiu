import { reportEntryBands, reportEntryFrames, reportEntryDeadline } from '../report-entry-motion.js';

export function createSetupMotion(root, win = globalThis.window, doc = root.ownerDocument) {
  const active = new Set();
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  let deadline;
  function finish() {
    win.clearTimeout(deadline);
    for (const animation of active) animation.cancel();
    active.clear();
  }
  function play(page) {
    finish();
    if (reduced.matches || doc.hidden) return;
    try {
      for (const band of reportEntryBands(page, root, doc)) {
        if (!band.node.animate) continue;
        const animation = band.node.animate(reportEntryFrames(band), {
          duration: band.duration, delay: band.delay, easing: 'cubic-bezier(.32, 0, .14, 1)', fill: 'both',
        });
        active.add(animation);
        animation.finished.then(() => { animation.cancel(); active.delete(animation); }, () => active.delete(animation));
      }
      deadline = win.setTimeout(finish, reportEntryDeadline);
    } catch { finish(); }
  }
  const events = ['pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart', 'scroll'];
  for (const event of events) root.addEventListener(event, finish, { capture: true, passive: true });
  win.addEventListener('resize', finish);
  doc.addEventListener('visibilitychange', finish);
  reduced.addEventListener('change', finish);
  return { play, finish, dispose() {
    finish();
    for (const event of events) root.removeEventListener(event, finish, true);
    win.removeEventListener('resize', finish);
    doc.removeEventListener('visibilitychange', finish);
    reduced.removeEventListener('change', finish);
  } };
}
