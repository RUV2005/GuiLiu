export function createHeatmapNavigation(root, onPan = () => {}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  let drag;
  const maximum = node => Math.max(0, node.scrollWidth - node.clientWidth);
  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  const viewport = target => {
    const node = target.closest?.('.daily-heatmap-scroll');
    return node && root.contains(node) ? node : null;
  };

  function wheel(event) {
    const node = viewport(event.target);
    if (!node || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
    if (!Number.isFinite(delta) || !delta) return;
    const left = clamp(node.scrollLeft + delta * unit, maximum(node));
    if (left === node.scrollLeft) return;
    event.preventDefault();
    onPan(node);
    node.scrollLeft = left;
  }

  function cancel() {
    if (!drag) return;
    const { node, pointerId } = drag;
    drag = null;
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', end, true);
    doc.removeEventListener('pointercancel', end, true);
    doc.removeEventListener('lostpointercapture', end, true);
    win.removeEventListener('blur', cancel);
    node.classList.remove('is-dragging');
    if (node.hasPointerCapture?.(pointerId)) node.releasePointerCapture(pointerId);
  }

  function end(event) {
    if (event.pointerId === drag?.pointerId) cancel();
  }

  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { node } = drag;
    if (!node.isConnected || event.buttons === 0) { cancel(); return; }
    if (!drag.active) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.active = true;
      drag.left = node.scrollLeft;
      node.classList.add('is-dragging');
      node.setPointerCapture?.(drag.pointerId);
    }
    // Keep hover tips quiet while the captured pointer pans across calendar cells.
    event.preventDefault();
    event.stopPropagation();
    onPan(node);
    drag.left = clamp(drag.left + drag.lastX - event.clientX, maximum(node));
    node.scrollLeft = drag.left;
    drag.lastX = event.clientX;
  }

  function start(event) {
    if (drag || event.defaultPrevented || event.pointerType !== 'mouse' || event.button !== 0) return;
    const node = viewport(event.target);
    if (!node || maximum(node) <= 0) return;
    drag = { node, pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, active: false };
    doc.addEventListener('pointermove', move, { capture: true, passive: false });
    doc.addEventListener('pointerup', end, true);
    doc.addEventListener('pointercancel', end, true);
    doc.addEventListener('lostpointercapture', end, true);
    win.addEventListener('blur', cancel);
  }

  root.addEventListener('wheel', wheel, { passive: false });
  root.addEventListener('pointerdown', start);
  return {
    cancel,
    dispose() {
      cancel();
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('pointerdown', start);
    },
  };
}
