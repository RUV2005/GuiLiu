export const awayFromLatest = (scroll) => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 80;
const atLatest = (scroll) => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 1;
const positions = new WeakMap();
const positionFor = (scroll) => {
  if (!positions.has(scroll)) positions.set(scroll, { following: true });
  return positions.get(scroll);
};
export const chatFollowsLatest = (scroll) => !scroll || (positions.get(scroll)?.following ?? atLatest(scroll));
export function setChatFollowLatest(scroll, following) {
  if (scroll) positionFor(scroll).following = following;
}

export function createChatNavigation(owner) {
  const scroll = owner.querySelector('.agent-panel-scroll, .agent-report-stream');
  const button = owner.querySelector('[data-agent-latest]');
  if (!scroll || !button) return { sync() {}, dispose() {} };
  const win = owner.ownerDocument.defaultView;
  const position = positionFor(scroll);
  let frame = 0, disposed = false, jumping = false;
  let height = scroll.clientHeight, contentHeight = scroll.scrollHeight, top = scroll.scrollTop;
  const sync = () => {
    frame = 0;
    if (disposed) return;
    // Hidden mini-panels have zero height. Keep the intent until layout is ready.
    if (position.following && !jumping && scroll.clientHeight > 0) {
      const latest = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (Math.abs(scroll.scrollTop - latest) > 1) scroll.scrollTop = latest;
    }
    height = scroll.clientHeight; contentHeight = scroll.scrollHeight; top = scroll.scrollTop;
    if (jumping && contentHeight - height - top <= 1) jumping = false;
    button.hidden = !awayFromLatest(scroll);
  };
  const queue = () => { if (!disposed && !frame) frame = win.requestAnimationFrame(sync); };
  const onScroll = () => {
    const layoutChanged = height !== scroll.clientHeight || contentHeight !== scroll.scrollHeight;
    if (!jumping && !layoutChanged && top !== scroll.scrollTop) {
      // Even a fractional upward movement releases follow; the button has a separate visibility threshold.
      position.following = scroll.scrollTop > top && atLatest(scroll);
    }
    top = scroll.scrollTop;
    queue();
  };
  const stopFollowing = () => { jumping = false; position.following = false; };
  const onWheel = (event) => { if (event.deltaY < 0) stopFollowing(); };
  const onKey = (event) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) stopFollowing();
  };
  const onScrollEnd = () => { jumping = false; queue(); };
  const jump = () => {
    position.following = true; jumping = true;
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'instant' : 'smooth' });
    queue();
  };
  const observer = win.ResizeObserver ? new win.ResizeObserver(queue) : null;
  observer?.observe(scroll);
  const messages = scroll.querySelector('[data-agent-messages]');
  if (messages) observer?.observe(messages);
  scroll.addEventListener('scroll', onScroll, { passive: true });
  scroll.addEventListener('scrollend', onScrollEnd, { passive: true });
  scroll.addEventListener('wheel', onWheel, { passive: true });
  scroll.addEventListener('keydown', onKey);
  button.addEventListener('click', jump);
  sync();
  return { sync: queue, dispose() {
    disposed = true; observer?.disconnect(); win.cancelAnimationFrame(frame); frame = 0;
    scroll.removeEventListener('scroll', onScroll); scroll.removeEventListener('scrollend', onScrollEnd);
    scroll.removeEventListener('wheel', onWheel); scroll.removeEventListener('keydown', onKey);
    button.removeEventListener('click', jump);
  } };
}

let owner;
let navigation;
export function syncChatNavigation(nextOwner) {
  if (owner !== nextOwner) {
    disposeChatNavigation(); owner = nextOwner;
    if (owner) navigation = createChatNavigation(owner);
  }
  navigation?.sync();
}
export function disposeChatNavigation() { navigation?.dispose(); navigation = null; owner = null; }
