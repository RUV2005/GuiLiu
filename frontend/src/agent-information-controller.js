import { ApiClient } from './api.js';
import { DEFAULT_SETTINGS } from './config.js';
import { normalizeServiceBase, normalizeDeal } from './utils.js';
import { localizeMarkup } from './language-view.js';
import { informationParts } from './agent-information-view.js';
import { createTaskPeriodRuler, taskPeriodValue } from './task-period-ruler.js';
import { informationText } from './agent-information-copy.js';
import { createInsightReplies } from './agent-insight-replies.js';
import { patchInsightList } from './agent-insight-list.js';
import { createAgentInformationState, createInsightFeed, taskDraft, taskPayload, changedTaskFields, informationResult,
  informationList, safePending, RUN_ACTIVE, RUN_TERMINAL } from './agent-information-model.js';

export function createAgentInformationController({ state, api, context, changed = () => {}, navigate,
  openDeal, document: doc = globalThis.document, window: win = globalThis.window, storage = globalThis.localStorage,
  uuid = () => crypto.randomUUID(), confirm = message => win.confirm(message), onReplySettled = () => {} }) {
  const requests = new Map(), cache = new WeakMap();
  let timer, fillFrame, disposed = false, lastRoute = '', editorOwner, editorLanguage, backdropPress = false;
  const current = () => state.agentInformation;
  const source = () => normalizeServiceBase(api.settings().agentPath, DEFAULT_SETTINGS.agentPath);
  const storageKey = s => 'abk-agent-task-requests-v1:' + encodeURIComponent(s.source);
  const tx = key => informationText(state.settings.language, key);
  const replies = createInsightReplies({ current, valid, storage, uuid, changed: paint,
    client: s => new ApiClient(() => ({ ...api.settings(), agentPath: s.source })),
    async onSettled(item, s) {
      const follow = state.route === 'review' && !doc?.hidden && s.insightId === item.id && item.reply?.next_insight_id;
      if (follow) await selectInsight(follow);
      if (!valid(s)) return;
      await insights(true);
      if (valid(s)) await onReplySettled(item, s.source);
    } });
  const periodRuler = createTaskPeriodRuler({ window: win, onChange(seconds) {
    const editor = current().editor;
    if (!editor || current().busy) return;
    editor.draft.kind = 'interval'; editor.draft.interval_seconds = seconds; editor.dirty = true;
  } });
  function persist(s) {
    try { storage.setItem(storageKey(s), JSON.stringify(s.pending)); return true; }
    catch { return false; }
  }
  function ensureSource() {
    if (current().source === source()) return;
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    const s = createAgentInformationState(); s.source = source();
    try { s.pending = safePending(JSON.parse(storage.getItem(storageKey(s)) || '{}')); } catch { /* No saved requests. */ }
    state.agentInformation = s;
    replies.restore(s);
    editorOwner = null;
  }
  function valid(s) { return !disposed && s === current() && s.source === source(); }
  function paint() {
    if (disposed) return;
    const s = current(), root = doc?.querySelector('[data-information-root]');
    if (root && ((state.route === 'agent-tasks' && root.dataset.mode === 'tasks') || (state.route === 'review' && root.dataset.mode === 'information'))) {
      const active = doc.activeElement;
      const dialog = root.querySelector('[data-task-dialog]');
      if (dialog?.open && !s.editor) dialog.close();
      const runDialog = root.querySelector('[data-run-dialog]');
      if (runDialog?.open && !s.runOpen) runDialog.close();
      const runBody = runDialog?.querySelector('.information-run-dialog-body');
      const detailScroll = runBody?.scrollTop;
      const action = active?.dataset?.informationAction, id = active?.dataset?.id;
      const field = active?.dataset?.taskField;
      const selection = field && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      const index = root.querySelector('.information-list'), scroll = index?.scrollTop;
      const runList = root.querySelector('.information-run-list'), runScroll = runList?.scrollTop;
      const open = new Set([...root.querySelectorAll('details[open][data-information-details]')].map(node => node.dataset.informationDetails));
      for (const [key, html] of Object.entries(informationParts(context()))) {
        const node = root.querySelector('[data-information-part="' + key + '"]');
        if (!node) continue;
        if (key === 'list' && state.route === 'review') {
          if (!cache.has(node)) {
            const list = node.querySelector('[data-insight-scroll]');
            if (list) list.scrollTop = s.insightFeed.scrollTop;
          }
          if (cache.get(node) !== html) { patchInsightList(node, html, s.insightFeed); cache.set(node, html); }
          continue;
        }
        if (key === 'editor' && s.editor && editorOwner === s.editor && node.querySelector('[data-task-form]')) {
          if (editorLanguage !== state.settings.language) localizeMarkup(node, '<div>' + html + '</div>');
          continue;
        }
        if (key === 'replyEditor' && html && node.querySelector('[data-insight-reply-form]')?.dataset.id === s.insightId) {
          if (node.dataset.language !== state.settings.language) localizeMarkup(node, '<div>' + html + '</div>');
          node.dataset.language = state.settings.language;
          continue;
        }
        if (cache.get(node) !== html) { node.innerHTML = html; cache.set(node, html); }
        node.dataset.language = state.settings.language;
      }
      editorOwner = s.editor; editorLanguage = state.settings.language;
      if (root.dataset.mode === 'information') root.dataset.selected = String(Boolean(s.insightId));
      const replyForm = root.querySelector('[data-insight-reply-form]'), r = s.replies, replyId = s.insightId;
      if (replyForm) {
        const input = replyForm.querySelector('textarea'), send = replyForm.querySelector('[type="submit"]');
        input.readOnly = Boolean(r.busy[replyId] || r.pending[replyId]);
        send.disabled = Boolean(input.readOnly || r.unavailable[replyId]);
        send.textContent = tx(r.busy[replyId] ? 'replySending' : 'replySend');
        send.setAttribute('aria-busy', String(Boolean(r.busy[replyId])));
      }
      for (const close of root.querySelectorAll('[data-information-action="cancel-edit"]')) close.disabled = Boolean(s.busy);
      const create = doc.querySelector('[data-information-action="new-task"]');
      if (create) create.disabled = Boolean(s.busy);
      if (dialog && s.editor && !dialog.open) {
        dialog.showModal();
        dialog.querySelector('[data-task-field="prompt"]')?.focus({ preventScroll: true });
      }
      if (runDialog && s.runOpen && !runDialog.open) {
        runDialog.showModal();
        runDialog.querySelector('[data-information-action="close-run"]')?.focus({ preventScroll: true });
      }
      if (runBody) {
        runBody.scrollTop = runDialog.dataset.runId === s.runId ? detailScroll : 0;
        runDialog.dataset.runId = s.runId;
      }
      const fieldset = root.querySelector('[data-task-form] fieldset');
      if (fieldset) fieldset.disabled = Boolean(s.busy);
      const submit = root.querySelector('[data-task-form] [type="submit"]');
      if (submit) { submit.disabled = Boolean(s.busy || s.editor?.uncertain); submit.textContent = tx(s.busy === 'save' ? 'saving' : 'save'); }
      const draft = s.editor?.draft;
      periodRuler.mount(root.querySelector('[data-task-period-ruler]'), draft ? {
        value: taskPeriodValue(draft), language: state.settings.language, disabled: Boolean(s.busy),
        displayLabel: s.editor.id && draft.kind !== 'interval' ? tx(draft.kind) : '',
      } : {});
      for (const node of root.querySelectorAll('[data-information-details]')) node.open = open.has(node.dataset.informationDetails);
      if (state.route === 'agent-tasks' && scroll != null && root.querySelector('.information-list')) root.querySelector('.information-list').scrollTop = scroll;
      if (runScroll != null && root.querySelector('.information-run-list')) root.querySelector('.information-run-list').scrollTop = runScroll;
      if (active && !active.isConnected) {
        const candidates = [...root.querySelectorAll('[data-information-action], [data-task-field]')];
        const next = candidates.find(node => field ? node.dataset.taskField === field : action && node.dataset.informationAction === action && node.dataset.id === id);
        if (!runDialog?.open || runDialog.contains(next)) next?.focus({ preventScroll: true });
        if (selection && next?.setSelectionRange) next.setSelectionRange(...selection);
      }
      queueFill();
    } else periodRuler.dispose();
    changed();
  }
  async function read(slot, execute, accept, { quiet = false, onError } = {}) {
    if (quiet && doc?.hidden) return false;
    ensureSource();
    const s = current(), controller = new AbortController();
    requests.get(slot)?.abort(); requests.set(slot, controller);
    if (!quiet) { s.loading[slot] = true; paint(); }
    const client = new ApiClient(() => ({ ...api.settings(), agentPath: s.source }));
    try {
      const value = await execute(client, { signal: controller.signal });
      if (!valid(s) || controller.signal.aborted) return false;
      accept(value, s);
      return true;
    } catch (e) {
      if (valid(s) && !controller.signal.aborted) { s.error = e.message || 'requestFailed'; onError?.(s, e); }
      return false;
    } finally {
      if (requests.get(slot) === controller) {
        requests.delete(slot);
        if (valid(s)) { s.loading[slot] = false; paint(); }
      }
    }
  }
  async function tasks(quiet = false) {
    return read('tasks', (client, options) => client.listAutomations(options), (response, s) => {
      const result = informationList(response);
      s.tasks = result.items; s.tasksLoaded = true; s.workerEnabled = result.worker_enabled === true;
      if (s.taskId && !s.editor) s.task = s.tasks.find(task => task.id === s.taskId) || s.task;
    }, { quiet });
  }
  async function insights(quiet = false, append = false) {
    ensureSource();
    const s = current(), feed = s.insightFeed, filter = { ...s.filter };
    if ((quiet || append) && requests.has('insights')) return false;
    if (append && (!feed.hasMore || feed.error || state.route !== 'review' || doc?.hidden)) return false;
    feed.loadingMore = append;
    if (!quiet) feed.error = '';
    // Refresh the complete loaded prefix atomically so polling never drops earlier batches.
    const target = append ? feed.offset + 20 : Math.max(20, feed.offset);
    const ok = await read('insights', async (client, options) => {
      let offset = append ? feed.offset : 0, total = Infinity, unread = 0, head = feed.head;
      const items = [];
      while (offset < Math.min(target, total)) {
        const limit = quiet && offset === 0 ? 20 : Math.min(100, target - offset);
        const result = informationList(await client.listAgentInsights({ ...filter, limit, offset }, options));
        if (!valid(s) || options.signal.aborted || feed !== s.insightFeed) return null;
        total = Number(result.total) || 0; unread = Number(result.unread_count) || 0;
        if (offset === 0) {
          head = JSON.stringify(result.items.slice(0, 20));
          // The API orders by updated_at. An unchanged head/total needs no older-page reads.
          if (quiet && !feed.error && head === feed.head && total === s.total) return { unchanged: true, unread };
        }
        items.push(...result.items);
        if (!result.items.length) { offset = total; break; }
        offset += result.items.length;
      }
      return { items, total, unread, offset, head };
    }, (result, next) => {
      if (!result || feed !== next.insightFeed) return;
      if (result.unchanged) { next.unreadCount = result.unread; return; }
      const merged = new Map((append ? next.insights : []).map(item => [item.id, item]));
      for (const item of result.items) merged.set(item.id, replies.observe(item, next));
      next.insights = [...merged.values()]; next.total = result.total; next.unreadCount = result.unread; next.insightsLoaded = true;
      feed.offset = result.offset; feed.hasMore = result.offset < result.total;
      if (!append) feed.head = result.head;
      if (next.insight) next.insight = next.insights.find(item => item.id === next.insightId) || next.insight;
    }, { quiet, onError(next, error) { if (next.insightFeed === feed) { feed.error = error.message || 'requestFailed'; feed.retryAppend = append; next.error = ''; } } });
    if (valid(s) && s.insightFeed === feed) { feed.loadingMore = false; paint(); }
    return ok;
  }
  function setInsightFilter(patch) {
    ensureSource();
    const s = current();
    requests.get('insights')?.abort(); requests.delete('insights');
    s.filter = { ...s.filter, ...patch }; s.insightFeed = createInsightFeed();
    s.insights = []; s.total = 0; s.insightsLoaded = false;
    return insights();
  }
  function checkFill() {
    if (disposed || doc?.hidden || state.route !== 'review') return;
    const list = doc?.querySelector('[data-insight-scroll]');
    if (!list || !list.clientHeight || !current().insightsLoaded) return;
    const rect = list.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= win.innerHeight) return;
    if (list.scrollHeight - list.clientHeight - list.scrollTop < 160) void insights(false, true);
  }
  function queueFill() {
    if (fillFrame != null || !win?.requestAnimationFrame) return;
    fillFrame = win.requestAnimationFrame(() => { fillFrame = null; checkFill(); });
  }
  function scroll(event) {
    if (state.route !== 'review') return;
    if (event.target.matches?.('[data-insight-scroll]')) current().insightFeed.scrollTop = event.target.scrollTop;
    queueFill();
  }
  const badge = () => read('badge', (client, options) => client.listAgentInsights({ limit: 1, offset: 0 }, options), (response, s) => {
    s.unreadCount = Number(informationList(response).unread_count) || 0;
  }, { quiet: true });
  async function runs(quiet = false) {
    const s = current(), id = s.taskId, offset = s.runsOffset;
    if (!id) return;
    const ok = await read('runs', (client, options) => client.listAutomationRuns(id, { limit: 20, offset }, options), (response, next) => {
      if (id !== next.taskId || offset !== next.runsOffset) return;
      const result = informationList(response); next.runs = result.items; next.runsTotal = Number(result.total) || 0;
    }, { quiet });
    if (ok && valid(s) && s.runsOffset > 0 && s.runsOffset >= s.runsTotal) { s.runsOffset = Math.max(0, Math.ceil(s.runsTotal / 20 - 1) * 20); return runs(quiet); }
  }
  function abandonEditor() {
    const e = current().editor;
    if (e?.dirty && !confirm(tx('discard'))) return false;
    current().editor = null; return true;
  }
  function closeEditor() {
    if (current().busy) return;
    periodRuler.finish();
    if (abandonEditor()) { current().error = ''; current().notice = ''; paint(); }
  }
  function closeRun(restoreFocus = true) {
    const s = current();
    s.runOpen = false; s.runError = '';
    requests.get('run')?.abort(); requests.delete('run'); s.loading.run = false;
    paint();
    if (restoreFocus && state.route === 'agent-tasks') {
      const rows = doc?.querySelectorAll?.('[data-information-action="run-detail"]') || [];
      [...rows].find(node => node.dataset.id === s.runId)?.focus({ preventScroll: true });
    }
  }
  async function selectTask(id) {
    if (current().busy) return;
    if (current().editor?.id && current().editor.id !== id && !abandonEditor()) return;
    const s = current(); s.taskId = id; s.task = null; s.taskRemoved = false; s.runs = []; s.runsTotal = 0; s.runsOffset = 0;
    s.run = null; s.runId = ''; s.runOpen = false; s.runError = ''; s.error = ''; s.notice = '';
    await read('task', (client, options) => client.getAutomation(id, options), (response, next) => {
      if (next.taskId === id) next.task = informationResult(response);
    });
    if (valid(s) && s.taskId === id) await runs();
  }
  async function selectInsight(id) {
    ensureSource();
    const s = current(); s.insightId = id; s.insight = null; s.error = ''; s.notice = '';
    replies.rememberSelection();
    // When the layout is stacked the list gives way to the notice (CSS hides it once a notice is selected), so bring the
    // notice's top into view.
    paint();
    const root = doc?.querySelector('[data-information-root]'), index = root?.querySelector('.information-index');
    if (index && win?.getComputedStyle?.(index).display === 'none') root.querySelector('.information-detail')?.scrollIntoView({ block: 'start' });
    const ok = await replies.refresh(id);
    if (ok && valid(s) && state.route === 'review' && !doc?.hidden && s.insightId === id && !s.insight?.is_read) await markRead(id, true);
  }
  // Back to the list on a narrow screen, with focus on the row that was open.
  function closeInsight() {
    const s = current(), id = s.insightId;
    s.insightId = ''; s.insight = null; replies.rememberSelection(); paint();
    [...(doc?.querySelectorAll('[data-insight-entry]') || [])].find(row => row.dataset.insightEntry === id)?.querySelector('button')?.focus();
  }
  // A confirmation without a reply session continues in the Agent chat, with the notice named in the draft.
  function askAgent() {
    const item = current().insight;
    if (!item?.data) return;
    state.agentDraft = tx('askAgentDraft').replace('{title}', item.data.title || '');
    navigate?.('agent');
  }
  async function markRead(id, isRead) {
    await mutate('read', async (client, s) => {
      const item = replies.observe(informationResult(await client.setAgentInsightRead(id, isRead)), s);
      if (!valid(s)) return;
      if (s.insightId === id) s.insight = item;
      await insights(true);
    });
  }
  async function loadRun(id, quiet = false) {
    if (!quiet) current().runError = '';
    return read('run', (client, options) => client.getAutomationRun(id, options), (response, s) => {
      const { context, ...run } = informationResult(response);
      if (s.runId === id) { s.run = run; s.runError = ''; }
    }, { quiet, onError(s, error) {
      s.error = '';
      if (s.runId === id) s.runError = error.message || 'requestFailed';
    } });
  }
  async function showRun(id, fromInsight = false) {
    if (current().busy) return;
    ensureSource();
    const s = current(); s.runId = id; s.run = null; s.runOpen = true; s.runError = ''; s.error = ''; s.notice = '';
    if (fromInsight) navigate('agent-tasks');
    const ok = await loadRun(id);
    if (ok && valid(s) && s.runOpen && s.runId === id && s.run?.task_id && s.taskId !== s.run.task_id) {
      const taskId = s.run.task_id;
      s.taskId = taskId; s.task = null; s.taskRemoved = false; s.runsOffset = 0; s.runs = [];
      await read('task', (client, options) => client.getAutomation(taskId, options), (response, next) => {
        if (next.taskId === taskId) next.task = informationResult(response);
      }, { onError(next, error) {
        if (next.taskId === taskId && error.status === 404) { next.taskRemoved = true; next.error = ''; }
      } });
      if (valid(s) && s.taskId === taskId) await runs();
    }
  }
  async function mutate(kind, work) {
    ensureSource(); const s = current();
    if (s.busy) return false;
    s.busy = kind; s.error = ''; s.notice = ''; paint();
    const client = new ApiClient(() => ({ ...api.settings(), agentPath: s.source }));
    try { await work(client, s); return valid(s); }
    catch (e) { if (valid(s)) s.error = e.message || 'requestFailed'; return false; }
    finally { if (valid(s)) { s.busy = ''; paint(); } }
  }
  async function editTask(id = '') {
    if (current().busy || !abandonEditor()) return;
    if (id && current().taskId !== id) await selectTask(id);
    const s = current(), original = id ? s.task : null;
    if (id && !original) return;
    s.editor = { id, original, draft: taskDraft(original), dirty: false, uncertain: false }; s.error = ''; s.notice = ''; paint();
    doc?.querySelector('[data-task-field="prompt"]')?.focus({ preventScroll: true });
  }
  async function saveTask() {
    const e = current().editor;
    if (!e || current().busy || e.uncertain) return;
    periodRuler.finish();
    let payload;
    try {
      payload = taskPayload(e.draft);
    } catch (error) { current().error = error.message; paint(); return; }
    if (!e.id && !confirm(tx('confirmCreate'))) return;
    const body = e.id ? changedTaskFields(e.original.config, payload) : payload;
    if (!Object.keys(body).length) { current().notice = 'noChanges'; paint(); return; }
    if (e.id && !confirm(tx('confirmEdit'))) return;
    await mutate('save', async (client, s) => {
      let response;
      try { response = e.id ? await client.updateAutomation(e.id, body) : await client.createAutomation(body); }
      catch (error) { if (!e.id && (!error.status || error.status >= 500)) e.uncertain = true; throw error; }
      const task = informationResult(response);
      if (!valid(s)) return;
      s.editor = null;
      s.taskId = task.id; s.task = task; s.taskRemoved = false; s.run = null; s.runId = ''; s.runOpen = false; s.runError = ''; s.runsOffset = 0; s.runs = []; s.notice = 'saved';
      await tasks(true); await runs(true);
    });
  }
  async function toggleTask(id) {
    const task = current().tasks.find(item => item.id === id) || current().task;
    if (!task || current().busy || !confirm(tx(task.config.enabled ? 'confirmPause' : 'confirmEnable'))) return;
    await mutate('toggle', async (client, s) => {
      const updated = informationResult(await client.updateAutomation(id, { enabled: !task.config.enabled }));
      if (!valid(s)) return;
      if (s.taskId === id) s.task = updated;
      s.notice = 'saved'; await tasks(true); await runs(true);
    });
  }
  function clearDeletedTask(s, id) {
    // Prevent reads started before deletion from restoring a removed selection.
    const slots = ['tasks'];
    if (s.taskId === id) slots.push('task', 'runs', 'run');
    if (s.pending[id]?.runId) slots.push('poll:' + s.pending[id].runId);
    for (const slot of slots) {
      requests.get(slot)?.abort(); requests.delete(slot); s.loading[slot] = false;
    }
    s.tasks = s.tasks.filter(task => task.id !== id);
    delete s.pending[id]; persist(s);
    if (s.deleteRetry?.id === id) s.deleteRetry = null;
    if (s.editor?.id === id) s.editor = null;
    if (s.taskId === id) {
      s.taskId = ''; s.task = null; s.taskRemoved = false; s.runs = []; s.runsTotal = 0; s.runsOffset = 0;
      s.run = null; s.runId = ''; s.runOpen = false; s.runError = '';
    }
  }
  async function deleteTask(id, retry = false) {
    ensureSource();
    const s = current(), task = s.tasks.find(item => item.id === id) || (s.taskId === id ? s.task : null);
    const previous = retry && s.deleteRetry?.id === id ? s.deleteRetry : null;
    if (s.busy || (!task && !previous)) return;
    const name = previous?.name || task.config.name;
    if (!previous && !confirm(name + '\n\n' + tx('confirmDelete'))) return;
    await mutate('delete', async (client, next) => {
      try {
        const result = informationResult(await client.deleteAutomation(id));
        if (result.task_id !== id || result.deleted !== true) throw new Error('invalidResponse');
        if (!valid(next)) return;
        clearDeletedTask(next, id); next.notice = 'taskDeleted'; paint();
        await tasks(true);
      } catch (error) {
        if (!valid(next)) return;
        if (error.status === 409) {
          if (next.deleteRetry?.id === id) next.deleteRetry = null;
          if (next.taskId === id) await runs(true);
          if (valid(next)) next.error = 'deleteRunning';
          return;
        }
        if (error.status === 404) {
          if (next.deleteRetry?.id === id) next.deleteRetry = null;
          const refreshed = await tasks(true);
          if (valid(next)) {
            if (refreshed && !next.tasks.some(item => item.id === id)) clearDeletedTask(next, id);
            next.error = 'deleteMissing';
          }
          return;
        }
        if (!error.status || error.status >= 500) next.deleteRetry = { id, name };
        throw error;
      }
    });
  }
  async function runTask(id) {
    ensureSource(); const s = current();
    if (s.busy || s.workerEnabled !== true || s.pending[id]?.runId || (s.taskId === id && s.runs.some(run => RUN_ACTIVE.has(run.status)))) return;
    if (!s.pending[id] && !confirm(tx('confirmRun'))) return;
    if (!s.pending[id]) s.pending[id] = { key: uuid(), runId: null };
    if (!persist(s)) { s.error = 'storageRequired'; paint(); return; }
    await mutate('run', async (client, next) => {
      let run;
      try { run = informationResult(await client.runAutomation(id, next.pending[id].key)); }
      catch (e) {
        if (e.status && e.status < 500) { delete next.pending[id]; persist(next); }
        if (e.status === 409 && valid(next)) { next.error = 'conflict'; await runs(true); await tasks(true); return; }
        throw e;
      }
      if (!run?.id) throw new Error('invalidResponse');
      next.pending[id].runId = run.id; persist(next);
      if (!valid(next)) return;
      next.runId = run.id; next.runOpen = true; next.runError = '';
      const { context, ...safe } = run; next.run = safe; next.notice = 'admitted';
      await runs(true); await pollRuns();
    });
    schedule();
  }
  async function pollRuns() {
    const s = current();
    const ids = new Set(Object.values(s.pending).map(value => value.runId).filter(Boolean));
    if (s.run && RUN_ACTIVE.has(s.run.status)) ids.add(s.runId);
    for (const run of s.runs) if (RUN_ACTIVE.has(run.status)) ids.add(run.id);
    let ended = false;
    for (const id of ids) {
      if (id === s.runId && requests.has('run')) continue;
      await read('poll:' + id, (client, options) => client.getAutomationRun(id, options), (response, next) => {
        const { context, ...run } = informationResult(response);
        if (next.runId === id) { next.run = run; next.runError = ''; }
        next.runs = next.runs.map(item => item.id === id ? { ...item, ...run } : item);
        if (RUN_TERMINAL.has(run.status)) {
          ended = true;
          for (const [taskId, pending] of Object.entries(next.pending)) if (pending.runId === id) delete next.pending[taskId];
          persist(next);
        } else if (!RUN_ACTIVE.has(run.status)) throw new Error('unknownStatus');
      }, { quiet: true, onError(next, error) {
        if (next.runId === id && next.runOpen) { next.error = ''; next.runError = error.message || 'requestFailed'; }
      } });
      if (!valid(s)) return;
    }
    if (ended) { await runs(true); await insights(true); await tasks(true); }
  }
  async function refresh() {
    ensureSource(); current().error = ''; current().notice = '';
    if (state.route === 'agent-tasks') { await tasks(); await runs(true); await pollRuns(); }
    else if (state.route === 'review') {
      await insights();
      if (current().insightId) {
        const id = current().insightId;
        await replies.refresh(id);
      }
      await replies.poll();
    } else await badge();
  }
  async function tick() {
    if (disposed || doc?.hidden) return;
    ensureSource();
    try {
      if (state.route === 'agent-tasks') { await tasks(true); await runs(true); await pollRuns(); }
      else if (state.route === 'review') { await insights(true); await replies.poll(); }
      else await badge();
    } finally { schedule(); }
  }
  function schedule() {
    win?.clearTimeout(timer);
    if (!disposed && !doc?.hidden) timer = win?.setTimeout(tick, ['review','agent-tasks'].includes(state.route) ? 5000 : 30000);
  }
  function mount() {
    ensureSource();
    if (state.route !== 'agent-tasks') current().runOpen = false;
    paint(); schedule();
    const route = state.route;
    if (lastRoute !== route) { lastRoute = route; void refresh(); }
  }
  function patch() {
    const node = doc?.querySelector('[data-information-root]');
    if (!node || !(['review','agent-tasks'].includes(state.route))) return false;
    if (node.dataset.mode !== (state.route === 'agent-tasks' ? 'tasks' : 'information')) return false;
    paint(); return true;
  }
  async function openWaiting({ sessionId, runId } = {}) {
    ensureSource();
    const s = current();
    void setInsightFilter({ kind: '', unread_only: false }); s.error = '';
    navigate('review');
    let found;
    const ok = await read('find-waiting', async (client, options) => {
      for (let offset = 0; ; offset += 100) {
        const result = informationList(await client.listAgentInsights({ limit: 100, offset }, options));
        found = result.items.find(item => (sessionId ? item.session_id === sessionId : item.run_id === runId) && ['waiting_reply', 'running'].includes(item.reply_state));
        if (found || !result.items.length || offset + result.items.length >= result.total) break;
      }
      return found;
    }, () => {});
    if (!valid(s) || !ok) return;
    if (found) await selectInsight(found.id);
    else { s.error = 'replyMissing'; paint(); }
  }
  async function click(event) {
    if (event.target.matches?.('[data-task-dialog]') && backdropPress) { backdropPress = false; closeEditor(); return; }
    if (event.target.matches?.('[data-run-dialog]') && backdropPress) { backdropPress = false; closeRun(); return; }
    backdropPress = false;
    const target = event.target.closest?.('[data-information-action]');
    if (!target || target.disabled) return;
    const { informationAction: action, id } = target.dataset, s = current();
    if (action === 'refresh' || action === 'check-created') return refresh();
    if (action === 'task') return selectTask(id);
    if (action === 'insight') return selectInsight(id);
    if (action === 'insight-back') return closeInsight();
    if (action === 'ask-agent') return askAgent();
    if (action === 'reply-retry') return replies.send(id, true);
    if (action === 'reply-refresh') return replies.refresh(id);
    if (action === 'waiting-run') { closeRun(false); return openWaiting({ runId: id }); }
    if (action === 'new-task') return editTask();
    if (action === 'edit-task') return editTask(id);
    if (action === 'cancel-edit') return closeEditor();
    if (action === 'toggle-task') return toggleTask(id);
    if (action === 'delete-task' || action === 'retry-delete') return deleteTask(id, action === 'retry-delete');
    if (action === 'run') return runTask(id);
    if (action === 'run-detail' || action === 'source-run') return showRun(id, action === 'source-run');
    if (action === 'close-run') return closeRun();
    if (action === 'retry-run-detail' && s.runOpen && s.runId === id) return loadRun(id);
    if (action === 'read') return markRead(id, !s.insight?.is_read);
    if (action === 'deal') return read('deal', async () => api.getDeal(id), response => { openDeal(normalizeDeal(informationResult(response))); });
    if (action === 'insights-retry') {
      s.insightFeed.error = '';
      return insights(false, s.insightFeed.retryAppend);
    }
    if (action.startsWith('runs-')) { s.runsOffset = Math.max(0, s.runsOffset + (action.endsWith('next') ? 20 : -20)); return runs(); }
  }
  function input(event) {
    const target = event.target, field = target.dataset?.taskField;
    if (target.matches?.('[data-insight-reply-input]')) { replies.draft(target.closest('[data-insight-reply-form]').dataset.id, target.value); return; }
    if (!field || !current().editor || !target.closest('[data-task-form]')) return;
    current().editor.draft[field] = target.type === 'checkbox' ? target.checked : target.value;
    current().editor.dirty = true;
    if (field === 'kind') paint();
  }
  function change(event) {
    input(event);
    const field = event.target.dataset?.informationFilter;
    if (field) void setInsightFilter({ [field]: field === 'unread_only' ? event.target.checked : event.target.value });
  }
  function submit(event) {
    if (event.target.matches?.('[data-task-form]')) { event.preventDefault(); void saveTask(); }
    if (event.target.matches?.('[data-insight-reply-form]')) { event.preventDefault(); void replies.send(event.target.dataset.id); }
  }
  function visibility() { win.clearTimeout(timer); if (!doc.hidden) void tick(); }
  function cancel(event) {
    if (event.target.matches?.('[data-task-dialog]')) { event.preventDefault(); closeEditor(); }
    if (event.target.matches?.('[data-run-dialog]')) { event.preventDefault(); closeRun(); }
  }
  function modalKeydown(event) {
    const dialog = event.target.closest?.('[data-task-dialog][open], [data-run-dialog][open]');
    if (!dialog || event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button, input, textarea, select, [href], [tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  function pointerDown(event) {
    backdropPress = false;
    if (!event.target.matches?.('[data-task-dialog], [data-run-dialog]')) return;
    const rect = event.target.getBoundingClientRect();
    backdropPress = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  const events = [['click',click],['input',input],['change',change],['submit',submit],['scroll',scroll,true],['visibilitychange',visibility],['cancel',cancel,true],['pointerdown',pointerDown],['keydown',modalKeydown]];
  events.forEach(([name, handler, options]) => doc?.addEventListener(name, handler, options));
  return { mount, patch, refresh, paint, selectTask, selectInsight, closeInsight, askAgent, editTask, saveTask, runTask, deleteTask, showRun, closeRun, pollRuns, tick, openWaiting, replies, setInsightFilter,
    loadMoreInsights: () => insights(false, true),
    dispose() { disposed = true; replies.dispose(); periodRuler.dispose(); doc?.querySelector('[data-task-dialog][open]')?.close(); doc?.querySelector('[data-run-dialog][open]')?.close(); win?.clearTimeout(timer); win?.cancelAnimationFrame?.(fillFrame); requests.forEach(controller => controller.abort()); events.forEach(([name,handler,options]) => doc?.removeEventListener(name,handler,options)); } };
}
