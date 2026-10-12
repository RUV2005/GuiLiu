import { informationResult } from './agent-information-model.js';

export const REPLY_STATES = new Set(['none', 'waiting_reply', 'running', 'completed', 'failed', 'cancelled']);
export const REPLY_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const canReply = item => item?.can_reply === true && item.reply_state === 'waiting_reply';
export const replyStorageKey = source => 'abk-insight-replies-v1:' + encodeURIComponent(source);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
export function replyMessage(value) {
  const message = String(value || '').trim();
  if (!message || [...message].length > 8000) throw new Error('replyRequired');
  return message;
}
export function storedReplies(raw) {
  const drafts = {}, pending = {};
  for (const [id, value] of Object.entries(raw?.drafts || {})) if (validId(id) && typeof value === 'string' && value.length <= 32000) drafts[id] = value;
  for (const [id, value] of Object.entries(raw?.pending || {})) {
    if (!validId(id) || typeof value?.key !== 'string' || !/^[a-f\d-]{36}$/i.test(value.key)) continue;
    try { if (replyMessage(value.message) === value.message) pending[id] = { key: value.key, message: value.message }; } catch { /* Invalid cached requests are never posted. */ }
  }
  return { drafts, pending, selected: validId(raw?.selected) ? raw.selected : '' };
}

// One operation per insight. GETs recover state; only an explicit user action can POST.
export function createInsightReplies({ current, valid, client, storage, uuid, changed, onSettled = () => {} }) {
  const reads = new Map(), posts = new Map();
  let disposed = false;
  function persist(s) {
    try { storage.setItem(replyStorageKey(s.source), JSON.stringify({ drafts: s.replies.drafts, pending: s.replies.pending, selected: s.insightId })); return true; }
    catch { return false; }
  }
  function restore(s) {
    for (const task of reads.values()) task.abort(); reads.clear();
    for (const task of posts.values()) task.abort(); posts.clear();
    try {
      const saved = storedReplies(JSON.parse(storage.getItem(replyStorageKey(s.source)) || 'null'));
      s.replies.drafts = saved.drafts; s.replies.pending = saved.pending; s.insightId = saved.selected;
    } catch { /* A failed cache read never triggers a write or clears server history. */ }
  }
  const live = s => !disposed && valid(s);
  function rememberSelection() { persist(current()); }
  function draft(id, value) {
    const s = current(), r = s.replies;
    if (!validId(id) || r.busy[id] || r.pending[id]) return;
    r.drafts[id] = value; delete r.errors[id];
    if (!persist(s)) { r.errors[id] = 'replyStorage'; changed(); }
  }
  function observe(item, s = current()) {
    if (!validId(item?.id)) throw new Error('invalidResponse');
    const r = s.replies, old = r.items[item.id], before = old?.reply_state || 'none', after = item.reply_state || 'none';
    // A list request started before the reply must not roll the completed checkpoint back.
    if (old && (Date.parse(old.updated_at) > Date.parse(item.updated_at) ||
      (REPLY_TERMINAL.has(before) && !REPLY_TERMINAL.has(after)) || (before === 'running' && ['none', 'waiting_reply'].includes(after)))) return old;
    r.items[item.id] = item;
    return item;
  }
  function accept(item, s) {
    item = observe(item, s);
    if (s.insightId === item.id) s.insight = item;
    s.insights = s.insights.map(row => row.id === item.id ? item : row);
    const r = s.replies, pending = r.pending[item.id];
    if (pending && (REPLY_TERMINAL.has(item.reply_state) || (item.reply?.key && item.reply.key !== pending.key))) {
      delete r.pending[item.id];
      if (item.reply?.key === pending.key && (r.drafts[item.id] || '').trim() === pending.message) delete r.drafts[item.id];
      delete r.errors[item.id];
      if (item.reply?.key && item.reply.key !== pending.key) r.notices[item.id] = 'replyElsewhere';
      persist(s);
      // Settlement callbacks only follow our confirmed operation, not arbitrary list reads.
      if (item.reply?.key === pending.key && REPLY_TERMINAL.has(item.reply_state)) {
        Promise.resolve().then(() => { if (live(s)) return onSettled(item, s); }).catch(() => {});
      }
    }
    return item;
  }
  async function refresh(id) {
    const s = current(), r = s.replies;
    if (!validId(id) || !live(s)) return null;
    const abort = new AbortController(); reads.get(id)?.abort(); reads.set(id, abort);
    r.checking[id] = true; changed();
    try {
      const item = informationResult(await client(s).getAgentInsight(id, { signal: abort.signal }));
      if (!live(s) || abort.signal.aborted) return null;
      if (item.id !== id) throw new Error('invalidResponse');
      delete r.unavailable[id];
      delete r.loadErrors[id];
      return accept(item, s);
    } catch (error) {
      if (live(s) && !abort.signal.aborted) {
        r.loadErrors[id] = error.message || 'requestFailed';
        if ([404, 410].includes(error.status)) r.unavailable[id] = error.status;
      }
      return null;
    } finally {
      if (reads.get(id) === abort) { reads.delete(id); if (live(s)) { r.checking[id] = false; changed(); } }
    }
  }
  async function send(id, retry = false) {
    const s = current(), r = s.replies;
    if (!validId(id) || r.busy[id] || (r.pending[id] && !retry)) return;
    let message;
    try { message = r.pending[id]?.message ?? replyMessage(r.drafts[id]); }
    catch (error) { r.errors[id] = error.message; changed(); return; }
    r.busy[id] = 'checking'; delete r.errors[id]; delete r.notices[id]; changed();
    try {
      // Always check the server first, including after reload and all manual retries.
      const item = await refresh(id);
      if (!live(s) || !item) return;
      if (!canReply(item)) { if (!REPLY_TERMINAL.has(item.reply_state)) r.notices[id] = 'replyNotReady'; return; }
      if (retry && !r.pending[id]) return;
      if (!r.pending[id]) r.pending[id] = { key: uuid(), message };
      if (!persist(s)) { delete r.pending[id]; r.errors[id] = 'replyStorage'; return; }
      const operation = r.pending[id], abort = new AbortController();
      r.busy[id] = 'sending'; posts.set(id, abort); changed();
      try {
        const result = informationResult(await client(s).replyAgentInsight(id, operation.message, operation.key, { signal: abort.signal }));
        if (!live(s)) return;
        if (result.id !== id || !REPLY_STATES.has(result.reply_state)) throw new Error('invalidResponse');
        accept(result, s);
      } catch (error) {
        if (!live(s)) return;
        r.errors[id] = error.status === 409 ? 'replyConflict' : error.message || 'requestFailed';
        if (error.status === 422) { delete r.pending[id]; persist(s); }
        if (error.status === 410) r.unavailable[id] = 410;
        await refresh(id);
      } finally { if (posts.get(id) === abort) posts.delete(id); }
    } finally { if (live(s)) { delete r.busy[id]; changed(); } }
  }
  async function poll() {
    const s = current(), r = s.replies;
    const ids = new Set(Object.keys(r.pending));
    const selected = r.items[s.insightId] || s.insight;
    if (selected?.reply_state === 'running') ids.add(s.insightId);
    for (const id of ids) {
      if (!live(s)) return;
      if (!r.checking[id] && !r.unavailable[id]) await refresh(id);
    }
  }
  return { restore, persist, rememberSelection, draft, observe, refresh, send, poll,
    dispose() { disposed = true; for (const task of reads.values()) task.abort(); for (const task of posts.values()) task.abort(); reads.clear(); posts.clear(); } };
}
