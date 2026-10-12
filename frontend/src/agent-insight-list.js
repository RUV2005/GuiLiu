// Keep the scroll container and keyed rows while new batches or status updates arrive.
export function patchInsightList(host, markup, feed) {
  const template = host.ownerDocument.createElement('template');
  template.innerHTML = markup;
  const next = template.content.querySelector('[data-insight-scroll]');
  let list = host.querySelector('[data-insight-scroll]');
  if (!list || list.dataset.filter !== next.dataset.filter) {
    host.replaceChildren(template.content);
    list = host.querySelector('[data-insight-scroll]');
    list.scrollTop = feed.scrollTop;
    return;
  }
  const rows = [...list.querySelectorAll('[data-insight-entry]')];
  const edge = list.getBoundingClientRect().top;
  const anchor = rows.find(node => node.getBoundingClientRect().bottom > edge + 1);
  const top = anchor?.getBoundingClientRect().top;
  const oldTop = list.scrollTop;
  const old = new Map(rows.map(node => [node.dataset.insightEntry, node]));
  const incoming = [...next.querySelectorAll('[data-insight-entry]')];
  const ids = new Set(incoming.map(node => node.dataset.insightEntry));
  for (const row of rows) if (!ids.has(row.dataset.insightEntry)) row.remove();
  const tail = list.querySelector('[data-insight-feed-end]');
  for (let i = 0; i < incoming.length; i++) {
    const incomingRow = incoming[i], id = incomingRow.dataset.insightEntry;
    const row = old.get(id) || incomingRow;
    if (row !== incomingRow) {
      row.dataset.selected = incomingRow.dataset.selected;
      const button = row.firstElementChild, updated = incomingRow.firstElementChild;
      button.setAttribute('aria-current', updated.getAttribute('aria-current'));
      if (button.innerHTML !== updated.innerHTML) button.innerHTML = updated.innerHTML;
    }
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] || tail);
  }
  const end = next.querySelector('[data-insight-feed-end]');
  if (tail.innerHTML !== end.innerHTML) tail.innerHTML = end.innerHTML;
  const count = host.querySelector('[data-insight-feed-count]'), nextCount = template.content.querySelector('[data-insight-feed-count]');
  if (count.innerHTML !== nextCount.innerHTML) count.innerHTML = nextCount.innerHTML;
  list.setAttribute('aria-busy', next.getAttribute('aria-busy'));
  list.setAttribute('aria-label', next.getAttribute('aria-label'));
  // Browser anchoring is disabled for this region; apply exactly one correction.
  list.scrollTop = anchor?.isConnected && oldTop > 0 ? list.scrollTop + anchor.getBoundingClientRect().top - top : oldTop;
  feed.scrollTop = list.scrollTop;
}
