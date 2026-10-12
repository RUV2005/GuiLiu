import { Virtualizer, elementScroll, observeElementOffset, observeElementRect, observeWindowOffset, observeWindowRect, windowScroll } from './vendor/tanstack-virtual-core/index.js';
import { ESTIMATED_TRANSACTION_HEIGHT, transactionAdrState, transactionWindow } from './ledger-model.js';

// Each virtual item owns one main row and all of its expanded ADR rows.
export function createTransactionScroller(body, initialContext, renderWindow, restoreEditors) {
  const main = body.closest('#main-view');
  const table = body.closest('table');
  let context = initialContext;
  let rows = context.filteredDeals;
  let reset = context.state.transactionScrollReset;
  let getItemKey = keyGetter(rows);
  let root;
  let virtualizer;
  let unmount;
  let frame = 0;
  let disposed = false;
  let drawing = false;

  function keyGetter(items) {
    return (index) => String(items[index].DealingNumber);
  }

  function scrollRoot() {
    return getComputedStyle(main).overflowY === 'visible' ? window : main;
  }

  function offset() {
    return root === window ? window.scrollY : root.scrollTop;
  }

  function viewportTop() {
    return root === window ? 0 : root.getBoundingClientRect().top + root.clientTop;
  }

  function margin() {
    return table.tHead.getBoundingClientRect().bottom - viewportTop() + offset();
  }

  function estimate(index) {
    const adr = transactionAdrState(context.state, rows[index]);
    const children = adr.expanded ? Math.max(1, adr.rows.length) : 0;
    return ESTIMATED_TRANSACTION_HEIGHT * (children + 1);
  }

  function options() {
    const windowRoot = root === window;
    return {
      count: rows.length,
      getScrollElement: () => root,
      estimateSize: estimate,
      getItemKey,
      overscan: 12,
      scrollMargin: margin(),
      initialOffset: offset(),
      initialRect: { width: windowRoot ? window.innerWidth : root.clientWidth, height: windowRoot ? window.innerHeight : root.clientHeight },
      observeElementRect: windowRoot ? observeWindowRect : observeElementRect,
      observeElementOffset: windowRoot ? observeWindowOffset : observeElementOffset,
      scrollToFn: windowRoot ? windowScroll : elementScroll,
      onChange: schedule,
    };
  }

  function configure() {
    const nextRoot = scrollRoot();
    if (root !== nextRoot || !virtualizer) {
      unmount?.();
      root = nextRoot;
      virtualizer = new Virtualizer(options());
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => item.end <= (instance.scrollOffset || 0);
      unmount = virtualizer._didMount();
    } else virtualizer.setOptions(options());
    virtualizer._willUpdate();
  }

  function groupBottom(row) {
    let last = row;
    while (last.nextElementSibling?.dataset.adrRowFor === row.dataset.dealRow) last = last.nextElementSibling;
    return last.getBoundingClientRect().bottom;
  }

  function visibleAnchors() {
    const top = viewportTop();
    const height = root === window ? window.innerHeight : root.clientHeight;
    return [...body.querySelectorAll('[data-deal-row]')].filter((row) => groupBottom(row) > top && row.getBoundingClientRect().top < top + height)
      .map((row) => ({ id: row.dataset.dealRow, top: row.getBoundingClientRect().top - top }));
  }

  function draw() {
    if (disposed || !body.isConnected || drawing) return;
    drawing = true;
    try {
      configure();
      const items = virtualizer.getVirtualItems();
      const window = transactionWindow(rows, items, virtualizer.getTotalSize(), virtualizer.options.scrollMargin);
      if (renderWindow(context, window)) restoreEditors?.();
      const indexes = new Map(items.map((item) => [String(item.key), item.index]));
      const measurements = [...body.querySelectorAll('[data-deal-row]')].map((row) => ({
        index: indexes.get(row.dataset.dealRow),
        height: Math.max(1, groupBottom(row) - row.getBoundingClientRect().top),
      }));
      for (const { index, height } of measurements) if (index !== undefined) virtualizer.resizeItem(index, height);
    } finally {
      drawing = false;
    }
  }

  function schedule() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // ADR completions can replace a record without rendering the whole view.
      if (context.filteredDeals !== rows || reset !== context.state.transactionScrollReset) update(context);
      else draw();
    });
  }

  function update(nextContext) {
    const nextRows = nextContext.filteredDeals;
    const resetScroll = reset !== nextContext.state.transactionScrollReset;
    const anchors = !resetScroll && nextRows !== rows && root ? visibleAnchors() : [];
    context = nextContext;
    reset = context.state.transactionScrollReset;
    if (nextRows !== rows) {
      rows = nextRows;
      getItemKey = keyGetter(rows);
    }
    if (resetScroll && root) root.scrollTo({ top: 0, behavior: 'instant' });
    draw();
    if (anchors.length) {
      const indexes = new Map(rows.map((row, index) => [String(row.DealingNumber), index]));
      const anchor = anchors.find((item) => indexes.has(item.id));
      if (anchor) {
        const location = virtualizer.getOffsetForIndex(indexes.get(anchor.id), 'start');
        if (location) root.scrollTo({ top: Math.max(0, location[0] - anchor.top), behavior: 'instant' });
      }
    }
    schedule();
  }

  const resize = new ResizeObserver(schedule);
  for (const element of [table, main.querySelector('.page-header'), main.querySelector('[data-ledger-filters]')]) {
    if (element) resize.observe(element);
  }
  window.addEventListener('resize', schedule, { passive: true });
  draw();
  return {
    update,
    schedule,
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      unmount?.();
    },
  };
}
