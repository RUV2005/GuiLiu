// Clone only the visible chat for a visual handover; never trim the live history.
export function cloneAgentSnapshot(source) {
  const lists = new Set(source.querySelectorAll('.agent-messages'));
  const branches = new Set();
  for (const list of lists) {
    for (let parent = list.parentElement; parent; parent = parent.parentElement) {
      branches.add(parent);
      if (parent === source) break;
    }
  }

  function cloneList(list) {
    const clone = list.cloneNode(false), box = list.getBoundingClientRect();
    const scroller = list.closest('.agent-panel-scroll, .agent-report-stream');
    if (!scroller) return list.cloneNode(true);
    const viewport = scroller.getBoundingClientRect();
    const top = Math.max(0, viewport.top), bottom = Math.min(innerHeight, viewport.bottom);
    const children = list.children;
    // Messages are vertically ordered. Find the first visible one without walking history.
    let low = 0, high = children.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (children[mid].getBoundingClientRect().bottom < top) low = mid + 1;
      else high = mid;
    }
    Object.assign(clone.style, { position: 'relative', boxSizing: 'border-box', display: 'block',
      height: box.height + 'px', minHeight: box.height + 'px', width: box.width + 'px' });
    for (let i = low; i < children.length; i++) {
      const child = children[i], r = child.getBoundingClientRect();
      if (r.top > bottom) break;
      const copy = child.cloneNode(true);
      // Fixed geometry preserves partially visible messages and the original scroll offset.
      Object.assign(copy.style, { position: 'absolute', margin: '0', boxSizing: 'border-box',
        left: (r.left - box.left) + 'px', top: (r.top - box.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
      clone.append(copy);
    }
    return clone;
  }

  function clone(node) {
    if (lists.has(node)) return cloneList(node);
    if (!branches.has(node)) return node.cloneNode(true);
    const copy = node.cloneNode(false);
    for (const child of node.childNodes) copy.append(clone(child));
    return copy;
  }
  return clone(source);
}
