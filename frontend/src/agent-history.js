import { emptyCanvas, reduceCanvas } from './agent-protocol.js';

export const validSessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const validSessionTitle = value => typeof value === 'string' && value.trim().length > 0
  && [...value.trim()].length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
export const sessionTitle = (history, sessionId, fallback = '') => history.metadata?.[sessionId]?.title || fallback;
const validSessionMeta = meta => validSessionId(meta?.session_id) && typeof meta.title === 'string'
  && Number.isFinite(Date.parse(meta.created_at)) && Number.isFinite(Date.parse(meta.updated_at));
export const validChatMessage = message => message && ['user', 'assistant'].includes(message.role)
  && typeof message.id === 'string' && message.id.length > 0 && typeof message.content === 'string' && Number.isFinite(Date.parse(message.timestamp));
export const historySendBlocked = state => Boolean(state.agentLoading || state.agentHistory?.loading || state.agentHistory?.remoteRunning || state.agentHistory?.remoteWaiting
  || state.agentHistory?.removal?.pending || (state.agentHistory?.removal && state.agentHistory.removal.sessionId === state.agentHistory.sessionId)
  || (state.agentHistory?.listLoading && !state.agentHistory.hadSelection && !state.agentHistory.isNew));
const statuses = new Set(['running', 'waiting_reply', 'completed', 'failed', 'cancelled', 'limit_reached', 'interrupted']);
const unwrap = response => response && Object.hasOwn(response, 'result') ? response.result : response;
const invalid = () => { throw new Error('Invalid chat history response'); };
export function historyPage(response, sessionId) {
  const page = unwrap(response);
  if (page?.session?.session_id !== sessionId || !Array.isArray(page.turns) || typeof page.has_more !== 'boolean') invalid();
  for (const turn of page.turns) {
    if (!Number.isSafeInteger(turn.history_id) || turn.history_id < 1 || !statuses.has(turn.status)
      || !validChatMessage(turn.user) || turn.user.role !== 'user'
      || (turn.assistant !== null && (!validChatMessage(turn.assistant) || turn.assistant.role !== 'assistant'))) invalid();
  }
  if (page.has_more && (!page.turns.length || !Number.isSafeInteger(page.next_before_id)
    || page.next_before_id !== Math.min(...page.turns.map(turn => turn.history_id)))) invalid();
  return page;
}
export function mergeHistoryTurns(previous, incoming) {
  const turns = new Map(previous.map(turn => [turn.history_id, turn]));
  incoming.forEach(turn => turns.set(turn.history_id, turn));
  return [...turns.values()].sort((a, b) => a.history_id - b.history_id);
}

export function historyCanvas(turns, previous = emptyCanvas()) {
  let canvas = previous, canvasAt = null, anchored = false, invalidCanvas = false;
  const snapshots = new Map();
  for (const turn of turns) {
    const update = turn.assistant?.canvas;
    if (!update) continue;
    try {
      const next = update.version === 1 && update.action === 'replace' && Array.isArray(update.charts) && !update.charts.length && Array.isArray(update.datasets) && !update.datasets.length
        ? emptyCanvas() : reduceCanvas(canvas, update);
      if (['replace', 'clear'].includes(update.action)) anchored = true;
      if (next !== canvas) {
        canvas = next; canvasAt = turn.assistant.timestamp;
        snapshots.set(turn.history_id, canvas);
      }
    } catch { invalidCanvas = true; }
  }
  return { canvas, canvasAt, anchored, invalidCanvas, snapshots };
}

export function historyMessages(turns, previous = [], snapshots = new Map()) {
  const byHistory = new Map(previous.filter(message => message.historyId).map(message => [message.historyId + ':' + message.role, message]));
  const byId = new Map(previous.map(message => [message.id, message]));
  const byRequest = new Map(previous.filter(message => message.requestId).map(message => [message.requestId + ':' + message.role, message]));
  const answers = new Map(previous.filter(message => message.serverRequestId).map(message => [message.serverRequestId, message]));
  const localUsers = previous.filter(message => message.role === 'user' && !message.historyId);
  const used = new Set();
  return turns.flatMap(turn => {
    const oldAnswer = byHistory.get(turn.history_id + ':assistant') || byId.get(turn.assistant?.id) || answers.get(turn.assistant?.request_id);
    const localUser = localUsers.findLast(message => !used.has(message) && message.content === turn.user.content
      && Math.abs(Date.parse(message.timestamp) - Date.parse(turn.user.timestamp)) < 60000);
    return [turn.user, turn.assistant].filter(Boolean).map(raw => {
      const candidate = byHistory.get(turn.history_id + ':' + raw.role) || byId.get(raw.id)
        || byRequest.get(oldAnswer?.requestId + ':' + raw.role) || (raw.role === 'assistant' ? oldAnswer : localUser);
      const existing = candidate && !used.has(candidate) && candidate.role === raw.role
        && (!candidate.historyId || candidate.historyId === turn.history_id) ? candidate : null;
      if (existing) used.add(existing);
      const message = { id: existing?.id || 'history_' + turn.history_id + '_' + raw.role, role: raw.role, content: raw.content, timestamp: raw.timestamp,
        historyId: turn.history_id, turnId: turn.turn_id, status: turn.status, retryable: false,
        ...(raw.request_id ? { serverRequestId: raw.request_id } : {}) };
      if (raw.role === 'assistant' && snapshots.has(turn.history_id)) message.canvas = snapshots.get(turn.history_id);
      // Keep an in-progress reply animation and its DOM node when the saved reply arrives.
      if (existing && existing.content === raw.content) {
        for (const field of ['errorKey', 'publicError', 'canvas', 'legacyVisuals']) delete existing[field];
        return Object.assign(existing, message);
      }
      return message;
    });
  });
}

const freshState = (sessionId, isNew, hadSelection) => ({ sessionId, isNew, hadSelection, sessions: [], total: 0, offset: 0,
  listLoading: false, listError: null, loading: false, loadingMore: false, error: null, canvasError: null,
  turns: [], hasMore: false, cursor: null, confirmed: false, open: false, remoteRunning: false, remoteWaiting: false, scrollMode: 'latest', removal: null, deleteNotice: false,
  metadata: Object.create(null), rename: null, renameNotice: false });
const publicError = error => ({ status: Number(error.status) || 0, message: String(error.message || 'Request failed').slice(0, 1000) });

export function createChatHistory({ state, api, getSession, getService, getPending = () => null, getSessionMeta = () => null, cacheSessionMeta = () => {}, isSending, activate, forget, persist, changed }) {
  let epoch = 0, listEpoch = 0, request, listRequest, canvasRequest, pollTimer, visible = false, opening;
  const removals = new Map();
  let canvasTurns = [], canvasComplete = false;
  const supported = () => typeof api.getChatHistory === 'function' && typeof api.listChatSessions === 'function';
  const notify = () => { persist(); changed(); };
  const invalidate = () => {
    epoch++; request?.abort(); canvasRequest?.abort(); request = canvasRequest = null; clearTimeout(pollTimer);
    if (state.agentHistory) { state.agentHistory.loading = false; state.agentHistory.loadingMore = false; }
  };
  function reset({ isNew = false, hadSelection = true, keepList = false, removal = null } = {}) {
    invalidate(); listEpoch++; listRequest?.abort(); opening = null; canvasTurns = []; canvasComplete = false;
    visible = false;
    const old = state.agentHistory;
    state.agentHistory = freshState(getSession(), isNew, hadSelection);
    if (!removals.has(getService()) && validSessionId(removal?.sessionId)) {
      removals.set(getService(), { sessionId: removal.sessionId, title: String(removal.title || '').slice(0, 120), pending: false,
        error: removal.pending ? { status: 0, message: '' } : publicError(removal.error || {}) });
    }
    state.agentHistory.removal = removals.get(getService()) || null;
    if (keepList && old) Object.assign(state.agentHistory, { sessions: old.sessions, total: old.total, offset: old.offset });
    loadMetadata();
  }
  function loadMetadata() {
    const h = state.agentHistory;
    for (const sid of new Set([getSession(), ...h.sessions.map(item => item.session_id)])) {
      const meta = getSessionMeta(sid);
      if (validSessionMeta(meta) && meta.session_id === sid) acceptMetadata(meta, false);
    }
  }
  function acceptMetadata(meta, cache = true) {
    if (!validSessionMeta(meta)) return;
    const h = state.agentHistory, old = h.metadata[meta.session_id];
    // A GET started before PATCH must never roll a confirmed title back.
    const next = old && Date.parse(old.updated_at) > Date.parse(meta.updated_at) ? old
      : { session_id: meta.session_id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at };
    h.metadata[meta.session_id] = next;
    if (h.session?.session_id === meta.session_id) Object.assign(h.session, next);
    const row = h.sessions.find(item => item.session_id === meta.session_id);
    if (row) Object.assign(row, next);
    if (cache) cacheSessionMeta(next);
  }
  function apply({ prepend = false, latest = false, canvasOnly = false } = {}) {
    const h = state.agentHistory;
    const result = historyCanvas(mergeHistoryTurns(canvasTurns, h.turns));
    // While earlier pages are being searched, retain only this session's cached canvas.
    if (result.anchored || (!h.hasMore && !result.invalidCanvas)) {
      state.agentCanvas = result.canvas; state.agentCanvasAt = result.canvasAt; state.agentVisuals = [];
    }
    if (result.invalidCanvas) h.canvasError = { status: 0, message: '' };
    if (!canvasOnly) {
      const pending = getPending();
      const unsaved = pending?.body?.session_id === h.sessionId ? state.agentMessages.filter(message => !message.historyId && message.requestId === pending.body.request_id) : [];
      const messages = historyMessages(h.turns, state.agentMessages, result.snapshots);
      const acknowledged = unsaved.some(message => messages.some(saved => saved.id === message.id));
      state.agentMessages = acknowledged ? messages : [...messages, ...unsaved];
      h.remoteRunning = h.turns.some(turn => turn.status === 'running');
      h.remoteWaiting = h.turns.at(-1)?.status === 'waiting_reply';
      if (latest) h.scrollMode = 'latest'; else if (prepend) h.scrollMode = 'prepend';
    }
    notify();
    return result.anchored;
  }
  function poll() {
    clearTimeout(pollTimer);
    if (visible && (state.agentHistory.remoteRunning || state.agentHistory.remoteWaiting) && !state.agentHistory.error && !state.agentHistory.removal && !state.agentHistory.rename?.saving && !isSending()) {
      pollTimer = setTimeout(() => { void refresh(); }, state.agentHistory.remoteWaiting ? 15000 : 4000);
    }
  }
  async function recoverCanvas(startPage, token) {
    if (canvasComplete || historyCanvas(mergeHistoryTurns(canvasTurns, state.agentHistory.turns)).anchored || !startPage.has_more) return;
    const h = state.agentHistory, service = getService(), sid = getSession();
    canvasRequest?.abort(); const controller = new AbortController(); canvasRequest = controller;
    let cursor = startPage.next_before_id;
    try {
      while (cursor != null && token === epoch && !isSending()) {
        const page = historyPage(await api.getChatHistory(sid, { limit: 50, before_id: cursor }, controller.signal, service), sid);
        if (token !== epoch || controller.signal.aborted) return;
        if (page.has_more && page.next_before_id >= cursor) invalid();
        canvasTurns = mergeHistoryTurns(canvasTurns, page.turns);
        const result = historyCanvas(mergeHistoryTurns(canvasTurns, h.turns));
        if (result.anchored || !page.has_more) {
          canvasComplete = !page.has_more;
          if (!result.invalidCanvas || result.anchored) {
            state.agentCanvas = result.canvas; state.agentCanvasAt = result.canvasAt; state.agentVisuals = [];
          }
          apply({ canvasOnly: true }); return;
        }
        cursor = page.next_before_id;
      }
    } catch (error) {
      if (token === epoch && !controller.signal.aborted) { h.canvasError = publicError(error); notify(); }
    }
  }
  async function refresh({ older = false, latest = false } = {}) {
    const h = state.agentHistory;
    if (!supported() || isSending() || h.rename?.saving || h.removal?.pending || h.removal?.sessionId === h.sessionId || h.isNew || h.loading || h.loadingMore || (older && (!h.hasMore || h.error))) return;
    const token = epoch, sid = getSession(), service = getService(), cursor = h.cursor;
    const controller = new AbortController(); request = controller;
    if (older) h.loadingMore = true; else h.loading = true;
    h.error = null; h.canvasError = null; changed();
    try {
      const page = historyPage(await api.getChatHistory(sid, { limit: 20, ...(older ? { before_id: cursor } : {}) }, controller.signal, service), sid);
      if (token !== epoch || controller.signal.aborted || isSending()) return;
      if (older && page.has_more && page.next_before_id >= cursor) invalid();
      // A long absence can put more than one page between the cached and latest turns.
      // Start a contiguous newest window rather than leaving an unreachable gap.
      const first = !h.confirmed || (!older && h.turns.length && page.turns.length && page.has_more
        && page.turns[0].history_id > h.turns.at(-1).history_id);
      h.turns = mergeHistoryTurns(first ? [] : h.turns, page.turns);
      if (first || older) { h.hasMore = page.has_more; h.cursor = page.next_before_id; }
      h.confirmed = true; h.session = page.session;
      acceptMetadata(page.session);
      apply({ prepend: older, latest: latest || first });
      if (!older) void recoverCanvas(page, token);
    } catch (error) {
      if (token === epoch && !controller.signal.aborted) h.error = publicError(error);
    } finally {
      if (token === epoch) { h.loading = false; h.loadingMore = false; notify(); poll(); }
    }
  }
  async function list({ more = false } = {}) {
    if (!supported()) return false;
    const h = state.agentHistory;
    if (h.listLoading || h.removal?.pending || h.rename?.saving) return false;
    const token = ++listEpoch, service = getService(), offset = more ? h.offset : 0;
    const controller = new AbortController(); listRequest = controller;
    h.listLoading = true; h.listError = null; changed();
    try {
      const result = unwrap(await api.listChatSessions({ limit: 20, offset }, controller.signal, service));
      if (token !== listEpoch || controller.signal.aborted) return false;
      if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0
        || result.items.some(item => !validSessionId(item.session_id) || typeof item.title !== 'string')) invalid();
      const items = new Map((more ? h.sessions : []).map(item => [item.session_id, item]));
      result.items.forEach(item => items.set(item.session_id, item));
      h.sessions = [...items.values()]; h.total = result.total; h.offset = offset + result.items.length;
      result.items.forEach(item => acceptMetadata(item));
      return true;
    } catch (error) {
      if (token === listEpoch && !controller.signal.aborted) h.listError = publicError(error);
      return false;
    } finally {
      if (token === listEpoch) { h.listLoading = false; changed(); }
    }
  }
  async function select(sessionId) {
    if (!validSessionId(sessionId) || isSending() || state.agentHistory.removal?.pending || state.agentHistory.rename?.saving) return;
    persist(); activate(sessionId); reset({ keepList: true });
    notify(); await refresh({ latest: true });
  }
  async function open() {
    if (!supported()) return;
    if (opening) return opening;
    const h = state.agentHistory;
    const work = (async () => {
      await list();
      if (h !== state.agentHistory || isSending()) return;
      if (!h.hadSelection && !h.isNew && h.sessions.length) return select(h.sessions[0].session_id);
      if (h.hadSelection && !h.isNew) return refresh();
    })();
    opening = work;
    try { await work; } finally { if (opening === work) opening = null; }
  }
  function setVisible(next) {
    const opened = next && !visible; visible = next;
    if (opened) void open();
    poll();
  }
  async function remove(sessionId) {
    const h = state.agentHistory, service = getService(), previous = removals.get(service);
    const item = h.sessions.find(item => item.session_id === sessionId);
    if (!validSessionId(sessionId) || typeof api.deleteChatSession !== 'function' || isSending() || h.rename?.saving || previous?.pending
      || (previous && previous.sessionId !== sessionId) || (!item && previous?.sessionId !== sessionId)) return false;
    if (item?.status === 'running' || (sessionId === getSession() && h.remoteRunning)) return false;
    const removal = { sessionId, title: sessionTitle(h, sessionId, previous?.title || item.title), pending: true, error: null };
    h.rename = null;
    removals.set(service, removal); h.removal = removal; h.deleteNotice = false; h.renameNotice = false;
    // Stop stale history and list reads before they can restore a deleted session.
    invalidate(); listEpoch++; listRequest?.abort(); h.listLoading = false; opening = null;
    notify();
    try {
      const response = await api.deleteChatSession(sessionId, service), result = unwrap(response);
      if (response?.success === false || result?.session_id !== sessionId || result.deleted !== true
        || typeof result.already_deleted !== 'boolean' || !Number.isSafeInteger(result.deleted_turns) || result.deleted_turns < 0) invalid();
      removals.delete(service);
      const wasCurrent = forget(sessionId, service);
      if (service === getService()) {
        const current = state.agentHistory;
        const removed = current.sessions.some(item => item.session_id === sessionId);
        current.sessions = current.sessions.filter(item => item.session_id !== sessionId);
        delete current.metadata[sessionId];
        if (removed) { current.total = Math.max(0, current.total - 1); current.offset = Math.max(0, current.offset - 1); }
        current.removal = null;
        const wasOpen = current.open;
        if (wasCurrent) reset({ isNew: true, keepList: true });
        state.agentHistory.open = wasOpen; state.agentHistory.deleteNotice = true;
        notify(); await list();
      }
      return true;
    } catch (error) {
      removal.pending = false; removal.error = publicError(error);
      if (service === getService()) { state.agentHistory.removal = removal; notify(); }
      return false;
    }
  }
  function dismissRemoval() {
    const removal = state.agentHistory.removal;
    if (!removal || removal.pending || ![404, 409, 422].includes(removal.error?.status)) return;
    removals.delete(getService()); state.agentHistory.removal = null; notify(); poll();
  }
  function beginRename(sessionId, fallback = '', place = 'list') {
    const h = state.agentHistory, item = h.sessions.find(item => item.session_id === sessionId);
    if (!validSessionId(sessionId) || h.rename?.saving || h.removal?.pending || h.removal?.sessionId === sessionId
      || (!item && !(sessionId === getSession() && !h.isNew && (h.confirmed || h.metadata[sessionId])))) return false;
    const title = sessionTitle(h, sessionId, item?.title || (sessionId === getSession() ? h.session?.title : '') || fallback);
    h.rename = { sessionId, place, value: [...title.replace(/\s+/g, ' ').trim()].slice(0, 120).join(''), error: '', detail: '', saving: false };
    h.renameNotice = false; h.deleteNotice = false;
    if (place === 'current') h.open = false;
    changed(); return true;
  }
  async function commitRename() {
    const h = state.agentHistory, draft = h.rename, service = getService();
    if (!draft) return true;
    if (draft.saving) return false;
    if (!validSessionTitle(draft.value)) { draft.error = 'titleInvalid'; changed(); return false; }
    draft.saving = true; draft.error = ''; draft.detail = '';
    clearTimeout(pollTimer); listEpoch++; listRequest?.abort(); h.listLoading = false; opening = null; changed();
    try {
      const response = await api.renameChatSession(draft.sessionId, draft.value.trim(), service), result = unwrap(response);
      if (response?.success === false || !validSessionMeta(result) || result.session_id !== draft.sessionId || !validSessionTitle(result.title)) {
        throw new Error('Invalid rename response');
      }
      cacheSessionMeta(result, service, true);
      draft.saving = false;
      if (service === getService()) {
        acceptMetadata(result);
        if (state.agentHistory.rename === draft) state.agentHistory.rename = null;
        state.agentHistory.renameNotice = true; notify();
        // updated_at can reorder the list; its pagination must restart at zero.
        listEpoch++; listRequest?.abort(); state.agentHistory.listLoading = false;
        await list(); poll();
      }
      return true;
    } catch (error) {
      draft.saving = false;
      draft.error = ({ 404: 'titleMissing', 422: 'titleInvalid', 503: 'titleUnavailable' })[error.status] || 'titleFailed';
      draft.detail = publicError(error).message;
      if (state.agentHistory === h) { changed(); poll(); }
      return false;
    }
  }
  function cancelRename() { if (!state.agentHistory.rename?.saving) { state.agentHistory.rename = null; changed(); } }
  return { reset, open, select, list, refresh, invalidate, setVisible, remove, dismissRemoval, beginRename, commitRename, cancelRename,
    editTitle(value) { if (state.agentHistory.rename && !state.agentHistory.rename.saving) state.agentHistory.rename.value = value; },
    loadMore: () => refresh({ older: true }),
    sent() {
      state.agentHistory.isNew = false; state.agentHistory.hadSelection = true;
      listEpoch++; listRequest?.abort(); state.agentHistory.listLoading = false; opening = null; invalidate();
    },
    async reconcile() { if (!supported()) return; await refresh(); await list(); },
    dispose() { invalidate(); listEpoch++; listRequest?.abort(); },
  };
}
