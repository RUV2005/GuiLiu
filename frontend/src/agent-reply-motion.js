import { chatFollowsLatest } from './agent-chat-navigation.js';

const BLOCKS = new Set(['P', 'UL', 'LI', 'H2', 'H3', 'H4']);
const segmenter = globalThis.Intl?.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function textPlan(prose) {
  const walker = prose.ownerDocument.createTreeWalker(prose, 4);
  const entries = [];
  const blocks = new Map();
  let node;
  let total = 0;
  while ((node = walker.nextNode())) {
    const text = node.data;
    if (!text) continue;
    const ends = [];
    if (segmenter) {
      for (const part of segmenter.segment(text)) ends.push(part.index + part.segment.length);
    } else {
      let offset = 0;
      for (const part of text) { offset += part.length; ends.push(offset); }
    }
    const parents = [];
    for (let parent = node.parentElement; parent && parent !== prose; parent = parent.parentElement) {
      if (!BLOCKS.has(parent.tagName)) continue;
      parents.push(parent);
      if (!blocks.has(parent)) blocks.set(parent, parent.hidden);
    }
    entries.push({ node, text, ends, parents, start: total, offset: 0 });
    total += ends.length;
  }
  for (const entry of entries) entry.node.data = '';
  for (const block of blocks.keys()) block.hidden = true;
  prose.setAttribute('aria-busy', 'true');
  let index = 0;
  return {
    total,
    show(count, animate = true) {
      while (index < entries.length) {
        const entry = entries[index];
        const length = Math.min(entry.ends.length, Math.max(0, count - entry.start));
        const end = entry.ends[length - 1] || 0;
        if (end > entry.offset) {
          for (const parent of entry.parents) {
            if (parent.hidden && !blocks.get(parent)) {
              parent.hidden = false;
              if (animate) parent.classList.add('agent-reply-block-enter');
            }
          }
          entry.node.appendData(entry.text.slice(entry.offset, end));
          entry.offset = end;
        }
        if (length < entry.ends.length) break;
        index++;
      }
    },
    finish() {
      for (const entry of entries) if (entry.node.data !== entry.text) entry.node.data = entry.text;
      for (const [block, hidden] of blocks) {
        block.hidden = hidden;
        block.classList.remove('agent-reply-block-enter');
      }
      prose.removeAttribute('aria-busy');
    },
  };
}

export function createReplyMotion({
  now = () => performance.now(),
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  onStatus = () => {},
} = {}) {
  let job = null;
  const seen = new WeakMap();
  const following = (scroll) => scroll && chatFollowsLatest(scroll);
  const finish = () => {
    if (!job) return;
    const current = job;
    job = null;
    if (current.frame !== null) cancelFrame?.(current.frame);
    const follow = following(current.scroll);
    current.plan?.finish();
    if (follow) current.scroll.scrollTop = current.scroll.scrollHeight;
    onStatus();
  };
  const paint = () => {
    if (!job?.plan) return;
    job.frame = null;
    if (reducedMotion() || job.prose.ownerDocument.hidden || !job.prose.isConnected) { finish(); return; }
    const elapsed = now() - job.started;
    if (elapsed >= job.duration) { finish(); return; }
    if (now() - job.painted >= 32) {
      const follow = following(job.scroll);
      job.plan.show(Math.max(1, Math.floor(job.plan.total * elapsed / job.duration)));
      if (follow) job.scroll.scrollTop = job.scroll.scrollHeight;
      job.painted = now();
    }
    job.frame = requestFrame(paint);
  };
  return {
    queue(message) {
      if (!message || message.role !== 'assistant' || seen.get(message) === message.content) return;
      finish();
      seen.set(message, message.content);
      if (!requestFrame || reducedMotion() || globalThis.document?.hidden || !message.content || message.content.length > 20000) return;
      job = { message, content: message.content, started: now(), painted: -Infinity, duration: Math.min(8000, Math.max(500, message.content.length * 10)),
        frame: null, plan: null, prose: null, scroll: null };
    },
    sync(messages) {
      if (job && (messages.at(-1) !== job.message || job.message.content !== job.content || job.message.errorKey)) finish();
    },
    attach(prose, scroll) {
      if (!job || prose === job.prose) return;
      if (!prose || reducedMotion() || prose.ownerDocument.hidden || !prose.isConnected ||
        (prose.getClientRects && !prose.getClientRects().length) || now() - job.started >= job.duration) { finish(); return; }
      if (job.frame !== null) cancelFrame?.(job.frame);
      job.plan?.finish();
      job.prose = prose; job.scroll = scroll; job.plan = textPlan(prose);
      if (!job.plan.total) { finish(); return; }
      job.plan.show(Math.max(1, Math.floor(job.plan.total * (now() - job.started) / job.duration)), false);
      job.frame = requestFrame(paint);
      onStatus();
    },
    finish,
    get message() { return job?.message; },
    get active() { return Boolean(job); },
  };
}
