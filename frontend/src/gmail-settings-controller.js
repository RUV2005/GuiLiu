import { beginGmailAuthorization } from './initialization/gmail-authorization.js';
import { createGmailSettingsState, gmailFailure, readGmailConnection, readGmailOperation, unavailableGmailAdapter } from './gmail-settings-model.js';
import { gmailText } from './gmail-settings-copy.js';
import { patchGmailSettings } from './gmail-settings-view.js';

export function createGmailSettingsController({ state, source, context, root = () => document,
  adapter = unavailableGmailAdapter, beginAuthorization = beginGmailAuthorization,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, requestTimeoutMs = 15000, pollDelayMs = 2000,
  newId = () => globalThis.crypto.randomUUID() }) {
  const scopes = new Map(), mounted = new WeakSet();
  const supported = adapter.supported === true && ['read', 'verify', 'begin', 'poll'].every(key => typeof adapter[key] === 'function');
  let epoch = 0, request, requestTimer, timer, popup, host, entered = false;

  function halt() {
    epoch += 1;
    clearTimer(timer); timer = null;
    clearTimer(requestTimer); requestTimer = null;
    request?.abort(); request = null;
    popup?.cancel(); popup = null;
    const current = state.gmailSettings;
    if (current) {
      current.busy = false;
      current.phase = current.operation?.state === 'pending' ? 'paused' : 'idle';
    }
  }
  function activate() {
    const key = source();
    if (state.gmailSettings?.source !== key) {
      halt(); entered = false;
      if (!scopes.has(key)) scopes.set(key, createGmailSettingsState(key, supported));
      state.gmailSettings = scopes.get(key);
    }
    return state.gmailSettings;
  }
  function patch() {
    if (state.route !== 'settings') return false;
    activate();
    return patchGmailSettings(root(), context());
  }
  function live(current, version) {
    return version === epoch && state.route === 'settings' && source() === current.source && state.gmailSettings === current;
  }
  function ready() {
    const current = activate();
    return state.route === 'settings' && current.supported && !current.busy;
  }
  function setConnection(current, value) {
    const connection = readGmailConnection(value);
    current.email = connection.email; current.connection = connection.state; current.unreachable = false;
  }
  function expire(current) {
    current.operation = { ...current.operation, state: 'expired', url: '' };
    current.phase = 'idle'; current.notice = 'expired'; current.popupBlocked = false; current.attemptId = '';
  }
  function schedule(current) {
    clearTimer(timer); timer = null;
    if (!['waiting', 'paused'].includes(current.phase) || current.operation?.state !== 'pending') return;
    const remaining = current.operation.expiresAt - now();
    if (remaining <= 0) { expire(current); patch(); return; }
    timer = setTimer(() => {
      timer = null;
      if (current.phase === 'paused') { expire(current); patch(); }
      else void poll();
    }, current.phase === 'paused' ? remaining : Math.min(pollDelayMs, remaining));
  }

  // Adapter calls are abortable and source-pinned. No initialization endpoint is used here.
  async function perform(phase, action) {
    if (!ready()) return false;
    const current = activate(), version = epoch, controller = new AbortController();
    request = controller; clearTimer(timer); timer = null;
    current.busy = true; current.attempted = true; current.phase = phase; current.error = ''; current.notice = ''; patch();
    const remaining = current.operation?.state === 'pending' ? current.operation.expiresAt - now() : requestTimeoutMs;
    const timeout = setTimer(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      Math.max(1, Math.min(requestTimeoutMs, remaining)));
    requestTimer = timeout;
    const call = async (name, args = {}) => {
      let listener;
      const aborted = new Promise((_, reject) => {
        listener = () => reject(controller.signal.reason || new DOMException('Aborted', 'AbortError'));
        if (controller.signal.aborted) listener();
        else controller.signal.addEventListener('abort', listener, { once: true });
      });
      try {
        const result = await Promise.race([aborted, Promise.resolve().then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return adapter[name]({ source: current.source, signal: controller.signal, ...args });
        })]);
        if (!live(current, version)) throw new DOMException('Stale request', 'AbortError');
        return result;
      } finally { controller.signal.removeEventListener('abort', listener); }
    };
    try {
      await action(current, call);
      return live(current, version);
    } catch (error) {
      if (!live(current, version) || error.name === 'AbortError') return false;
      const key = gmailFailure(error);
      current.error = key;
      current.phase = current.operation?.state === 'pending' ? 'paused' : 'idle';
      if (key === 'unsupported') { current.supported = false; current.operation = null; }
      current.unreachable = ['requestFailed', 'requestTimeout'].includes(key);
      if (current.operation?.state === 'pending' && current.operation.expiresAt <= now()) {
        expire(current); current.error = '';
      }
      return false;
    } finally {
      clearTimer(timeout);
      if (requestTimer === timeout) requestTimer = null;
      if (live(current, version)) {
        request = null; current.busy = false;
        popup?.cancel(); popup = null;
        patch(); schedule(current);
      }
    }
  }
  async function load() {
    return perform('loading', async (current, call) => {
      const value = await call('read');
      const connection = readGmailConnection(value?.connection);
      const operation = value?.operation ? readGmailOperation(value.operation) : null;
      setConnection(current, connection);
      if (operation?.state === 'pending') {
        if (current.operation?.id !== operation.id || !current.expectedEmail) current.expectedEmail = connection.email;
        current.operation = operation;
      }
      current.phase = current.operation?.state === 'pending' ? 'waiting' : 'idle';
    });
  }
  async function check() {
    if (!ready() || state.gmailSettings.operation?.state === 'pending') return false;
    return perform('checking', async (current, call) => {
      setConnection(current, await call('verify'));
      current.phase = 'idle'; current.notice = 'checked';
    });
  }
  async function authorize() {
    if (!ready() || state.gmailSettings.operation?.state === 'pending' || !state.gmailSettings.email) return false;
    const current = activate();
    // Reserve the window within the click, before any request or await.
    popup = beginAuthorization({ message: gmailText(context().language, 'openingWindow') });
    current.attemptId ||= newId(); current.expectedEmail = current.email; current.popupBlocked = false;
    return perform('opening', async (active, call) => {
      const operation = readGmailOperation(await call('begin', { attemptId: active.attemptId }));
      if (operation.state !== 'pending' || !operation.url) throw new Error('invalidResponse');
      active.operation = operation;
      if (operation.expiresAt <= now()) { expire(active); return; }
      active.popupBlocked = !popup.navigate(operation.url);
      active.phase = 'waiting';
    });
  }
  async function poll() {
    if (!ready() || state.gmailSettings.operation?.state !== 'pending') return false;
    const current = activate();
    if (current.operation.expiresAt <= now()) { expire(current); patch(); return false; }
    return perform('waiting', async (active, call) => {
      const id = active.operation.id;
      const result = readGmailOperation(await call('poll', { operationId: id }));
      if (result.id !== id) throw new Error('operationMismatch');
      if (result.state === 'pending') { active.unreachable = false; return; }
      if (result.state === 'succeeded') {
        const connection = readGmailConnection(result.connection);
        if (connection.state !== 'valid') throw new Error('invalidResponse');
        if (!active.expectedEmail || connection.email.toLowerCase() !== active.expectedEmail.toLowerCase()) throw new Error('accountMismatch');
        setConnection(active, connection);
      }
      active.operation = { ...result, url: '' }; active.attemptId = ''; active.popupBlocked = false;
      active.phase = 'idle'; active.unreachable = false;
      active.notice = result.state === 'succeeded' ? 'success' : result.state;
    });
  }
  function stopWaiting() {
    halt();
    const current = activate(); current.notice = 'stopped'; current.error = ''; patch(); schedule(current);
  }
  function leave() { halt(); host = null; entered = false; }
  function mount() {
    if (state.route !== 'settings') { leave(); return; }
    activate();
    host = root()?.querySelector('[data-gmail-settings]');
    if (!host) return;
    if (!mounted.has(host)) {
      mounted.add(host);
      host.addEventListener('click', event => {
        const actions = { check, authorize, stop: stopWaiting, resume: poll };
        for (const [key, action] of Object.entries(actions)) {
          const button = event.target.closest('[data-gmail-' + key + ']');
          if (button && !button.disabled) { event.preventDefault(); void action(); break; }
        }
      });
    }
    patch();
    if (!entered) { entered = true; void load(); }
  }
  activate();
  return { activate, patch, mount, leave, load, check, authorize, poll, stopWaiting };
}
