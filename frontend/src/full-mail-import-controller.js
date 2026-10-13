import { createFullMailImportState, readFullMailImport, fullMailImportError, MAIL_SOURCES, MAIL_TERMINAL,
  mailImportActive, mailImportCanStart } from './full-mail-import-model.js';
import { patchFullMailImport } from './full-mail-import-view.js';
import { fullMailText } from './full-mail-import-copy.js';

export function createFullMailImportController({ state, api, source, context, root = () => document,
  visible = () => !document.hidden, afterSettled = async () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, pollDelayMs = 2500, requestTimeoutMs = 15000,
  confirmAction = message => window.confirm(message) }) {
  const scopes = new Map(), mounted = new WeakSet(), refreshed = new Set();
  let epoch = 0, request, requestTimer, timer, entered = false;

  function halt() {
    epoch += 1;
    clearTimer(timer); clearTimer(requestTimer); timer = requestTimer = null;
    request?.abort(); request = null;
    if (state.fullMailImport) { state.fullMailImport.busy = ''; state.fullMailImport.confirming = false; state.fullMailImport.checked = false; }
  }
  function activate() {
    const key = source();
    if (state.fullMailImport?.source !== key) {
      halt(); entered = false;
      if (!scopes.has(key)) scopes.set(key, createFullMailImportState(key));
      state.fullMailImport = scopes.get(key);
    }
    return state.fullMailImport;
  }
  function live(current, version = epoch) {
    return version === epoch && state.route === 'settings' && visible() && current === state.fullMailImport && current.source === source();
  }
  function patch() {
    if (state.route !== 'settings') return false;
    activate(); return patchFullMailImport(root(), context());
  }
  function schedule(current) {
    clearTimer(timer); timer = null;
    if (!live(current) || current.available === false || !mailImportActive(current.task)) return;
    timer = setTimer(() => { timer = null; void load(); }, Math.min(30000, pollDelayMs * 2 ** Math.min(current.failures, 4)));
  }
  function accept(current, task, method) {
    const previous = current.task;
    if (method === 'GET' && previous?.task_id && !task.task_id) current.notice = 'reset';
    else if (method === 'GET' && previous?.task_id && task.task_id !== previous.task_id) current.notice = 'replaced';
    if (task.task_id && (task.task_id !== current.beforeTaskId || mailImportActive(task))) {
      current.uncertain = false; current.startError = null;
    }
    current.task = task; current.available = true; current.checked = true; current.failures = 0;
    if (mailImportActive(task)) current.confirming = false;
  }
  async function notifySettled(current, task) {
    if (!task?.task_id || !MAIL_TERMINAL.includes(task.status)) return;
    const key = JSON.stringify([current.source, task.task_id, task.status]);
    if (refreshed.has(key)) return;
    refreshed.add(key);
    try { await afterSettled(current.source); }
    catch {
      refreshed.delete(key);
      if (live(current) && current.task?.task_id === task.task_id) { current.notice = 'refreshFailed'; patch(); }
    }
  }

  async function exchange(method) {
    const current = activate();
    if (!live(current) || current.busy) return false;
    const version = epoch, controller = new AbortController();
    request = controller; clearTimer(timer); timer = null;
    current.busy = method; current.error = null;
    if (method === 'POST') {
      current.beforeTaskId = current.task?.task_id || null; current.uncertain = true; current.startError = null; current.notice = '';
    }
    patch();
    const timeout = setTimer(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), requestTimeoutMs);
    requestTimer = timeout;
    let onAbort, failed = false;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason || new DOMException('Aborted', 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const response = await Promise.race([aborted, Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return method === 'POST' ? api.startFullMailImport(current.source, { signal: controller.signal })
          : api.getFullMailImport(current.source, { signal: controller.signal });
      })]);
      if (!live(current, version)) return false;
      const task = readFullMailImport(response);
      if (method === 'POST' && (task.scope !== 'inbox' || !task.task_id || task.task_id === current.beforeTaskId ||
        task.sources.length !== MAIL_SOURCES.length || task.sources.some(key => !MAIL_SOURCES.includes(key)))) throw new Error('invalidResponse');
      accept(current, task, method);
      if (method === 'POST') { current.uncertain = false; current.confirming = false; }
      return true;
    } catch (error) {
      if (!live(current, version) || error?.name === 'AbortError') return false;
      failed = true; current.failures += 1; current.checked = false;
      const feedback = fullMailImportError(error);
      if (feedback.key === 'unavailable' || feedback.key === 'localOnly') current.available = false;
      if (method === 'POST') {
        current.startError = feedback; current.confirming = false;
        if ([403, 404, 405, 409, 422, 501, 503].includes(error?.status)) current.uncertain = false;
      } else current.error = feedback;
      return false;
    } finally {
      clearTimer(timeout); controller.signal.removeEventListener('abort', onAbort);
      if (requestTimer === timeout) requestTimer = null;
      if (live(current, version)) {
        current.busy = ''; request = null; patch();
        // A start request has no idempotency contract: reconcile with GET, never resend POST.
        if (method === 'POST' && failed && current.available !== false) void load();
        else {
          schedule(current);
          if (!failed) void notifySettled(current, current.task);
        }
      }
    }
  }
  function load() { return exchange('GET'); }
  function askStart() {
    const current = activate();
    if (!live(current) || !mailImportCanStart(current)) return false;
    current.confirming = true; patch();
    root()?.querySelector('[data-mail-full-confirm]')?.focus({ preventScroll: true });
    return true;
  }
  function start() {
    const current = activate();
    if (!current.confirming || !mailImportCanStart(current)) return Promise.resolve(false);
    return exchange('POST');
  }
  function back() {
    const current = activate();
    if (current.busy === 'POST') return;
    current.confirming = false; patch(); root()?.querySelector('[data-mail-full-start]')?.focus({ preventScroll: true });
  }
  // Stopping returns at once; the task reads "stopping" until the worker has finished the mail in hand.
  async function stop() {
    const current = activate();
    if (!live(current) || current.busy || !mailImportActive(current.task) || current.task.cancelling) return false;
    if (!confirmAction(fullMailText(context().language, 'stopConfirm'))) return false;
    const version = epoch;
    current.busy = 'STOP'; current.error = null; patch();
    try {
      const task = readFullMailImport(await api.cancelFullMailImport(current.source));
      if (!live(current, version)) return false;
      accept(current, task, 'GET');
      return true;
    } catch (error) {
      if (live(current, version)) current.error = fullMailImportError(error);
      return false;
    } finally {
      if (live(current, version)) { current.busy = ''; patch(); schedule(current); }
    }
  }
  function leave() { halt(); entered = false; }
  function mount() {
    if (state.route !== 'settings') { leave(); return; }
    activate();
    const host = root()?.querySelector('[data-full-mail-import]');
    if (!host) return;
    if (!mounted.has(host)) {
      mounted.add(host);
      host.addEventListener('click', event => {
        for (const [key, action] of Object.entries({ start: askStart, confirm: start, back, refresh: load, stop })) {
          const button = event.target.closest('[data-mail-full-' + key + ']');
          if (button && !button.disabled) { event.preventDefault(); void action(); break; }
        }
      });
    }
    patch();
    if (!entered && visible()) { entered = true; void load(); }
  }
  activate();
  return { activate, mount, patch, leave, load, askStart, start, back, stop };
}
