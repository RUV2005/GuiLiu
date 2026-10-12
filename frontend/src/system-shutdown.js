import { escapeHtml as e, escapeAttr as a } from './utils.js';
import { shutdownText } from './system-shutdown-copy.js';

const services = ['backend', 'agent', 'frontend'];
export function readShutdownResponse(response) {
  const result = response?.result;
  if (response?.success !== true || response.status_code !== 202 || result?.status !== 'shutting_down' ||
    !['standalone', 'supervised'].includes(result.mode)) throw new Error('Unconfirmed shutdown');
  for (const key of ['services', 'not_running']) {
    if (!Array.isArray(result[key]) || result[key].some(name => !services.includes(name)) ||
      new Set(result[key]).size !== result[key].length) throw new Error('Unconfirmed shutdown');
  }
  if (result.services.some(name => result.not_running.includes(name))) throw new Error('Unconfirmed shutdown');
  return { mode: result.mode, services: [...result.services], not_running: [...result.not_running] };
}

export function shutdownSettingsView(ctx) {
  const current = ctx.state.systemShutdown || {}, text = key => shutdownText(ctx.language, key);
  return '<div class="settings-exit" data-system-shutdown><button class="button danger-quiet" type="button" data-shutdown-open' +
    (['submitting', 'accepted'].includes(current.phase) ? ' disabled' : '') + '>' + e(text('exit')) + '</button>' +
    '<p class="settings-exit-feedback" role="alert" data-shutdown-feedback' + (!current.error ? ' hidden' : '') + '>' +
    e(current.error ? text(current.error) : '') + '</p></div>';
}

export function shutdownExitDocument({ language, theme, result, returnUrl }) {
  const url = new URL(returnUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid return URL');
  const text = key => shutdownText(language, key), light = theme === 'light';
  return '<!doctype html><html lang="' + (language === 'ja' ? 'ja' : language === 'en' ? 'en' : 'zh-CN') + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">' +
    '<title>' + e(text('accepted')) + '</title><style>:root{color-scheme:' + (light ? 'light' : 'dark') + '}*{box-sizing:border-box}body{margin:0;background:' +
    (light ? '#f8f9fb;color:#25292f' : '#0b0c0e;color:#f1f0ec') + ';font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}' +
    'main{max-width:660px;margin:12vh auto;padding:32px}h1{font-size:28px;line-height:1.4;margin:0 0 24px}p{margin:16px 0;overflow-wrap:anywhere}' +
    'a{display:inline-block;margin-top:20px;padding:8px 16px;border:1px solid currentColor;border-radius:6px;color:inherit;text-decoration:none;font-size:14px}' +
    'ul{padding-left:24px}</style></head><body><main><h1>' + e(text('accepted')) + '</h1><p>' + e(text('acceptedBody')) + '</p>' +
    (result.not_running.length ? '<p>' + e(text('missing')) + '</p><ul>' + result.not_running.map(name => '<li>' + e(text(name)) + '</li>').join('') + '</ul>' : '') +
    '<p>' + e(text('restart')) + '</p><a href="' + a(url.href) + '">' + e(text('reconnect')) + '</a></main></body></html>';
}

export function showShutdownExit(ctx, result, win = window) {
  // A network-free document replaces the app realm, terminating all polling, streams and timers.
  // It remains readable even when the frontend server has already exited.
  const html = shutdownExitDocument({ language: ctx.language, theme: ctx.state.theme, result,
    returnUrl: win.location.origin + '/#settings' });
  const url = win.URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  try { win.location.replace(url); }
  catch (error) { win.URL.revokeObjectURL(url); throw error; }
}

export function createSystemShutdownController({ state, api, context, source, blocked = () => '',
  root = () => document, beforeExit = () => {}, exit = result => showShutdownExit(context(), result),
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 15000 }) {
  const current = state.systemShutdown = { phase: 'idle', error: '', source: '' };
  let dialog, request, timer, epoch = 0, opener;
  const text = key => shutdownText(context().language, key);
  const pending = () => ['submitting', 'accepted'].includes(current.phase);
  function patch() {
    if (['confirming', 'submitting'].includes(current.phase) && current.source !== source()) { leave(); current.error = 'changed'; }
    const button = root()?.querySelector('[data-shutdown-open]'), feedback = root()?.querySelector('[data-shutdown-feedback]');
    if (button) { button.disabled = pending(); button.textContent = text('exit'); }
    if (feedback) { feedback.hidden = !current.error; feedback.textContent = current.error ? text(current.error) : ''; }
    if (dialog) {
      for (const node of dialog.querySelectorAll('[data-shutdown-label]')) node.textContent = text(node.dataset.shutdownLabel);
      for (const button of dialog.querySelectorAll('button')) button.disabled = pending();
      dialog.querySelector('[data-shutdown-pending]').hidden = current.phase !== 'submitting';
    }
  }
  function close() { dialog?.close(); dialog?.remove(); dialog = null; }
  function cancel() {
    if (pending()) return;
    current.phase = 'idle'; close(); patch();
    (opener?.isConnected ? opener : root()?.querySelector('[data-shutdown-open]'))?.focus({ preventScroll: true });
  }
  function open() {
    if (pending() || current.phase === 'confirming' || state.route !== 'settings') return false;
    current.error = blocked();
    if (current.error) { patch(); return false; }
    current.phase = 'confirming'; current.source = source();
    const doc = root(); opener = doc?.activeElement;
    if (doc?.createElement) {
      dialog = doc.createElement('dialog'); dialog.className = 'settings-exit-dialog'; dialog.dataset.shutdownDialog = '';
      dialog.setAttribute('aria-labelledby', 'shutdown-title'); dialog.setAttribute('aria-describedby', 'shutdown-warning');
      dialog.innerHTML = '<h2 id="shutdown-title" data-shutdown-label="confirmTitle"></h2><p id="shutdown-warning" data-shutdown-label="warning"></p>' +
        '<p class="settings-exit-note" data-shutdown-label="kept"></p><p role="status" data-shutdown-pending data-shutdown-label="pending" hidden></p>' +
        '<footer><button type="button" class="button" data-shutdown-cancel data-shutdown-label="cancel" autofocus></button>' +
        '<button type="button" class="button danger" data-shutdown-confirm data-shutdown-label="confirm"></button></footer>';
      dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
      dialog.querySelector('[data-shutdown-cancel]').addEventListener('click', cancel);
      dialog.querySelector('[data-shutdown-confirm]').addEventListener('click', () => { void submit(); });
      doc.body.append(dialog); patch(); dialog.showModal();
    }
    patch(); return true;
  }
  async function submit() {
    if (current.phase !== 'confirming' || state.route !== 'settings') return false;
    current.error = current.source !== source() ? 'changed' : blocked();
    if (current.error) { current.phase = 'idle'; close(); patch(); return false; }
    current.phase = 'submitting'; patch();
    const controller = request = new AbortController(), version = epoch;
    const deadline = timer = setTimer(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
    let abort;
    try {
      const response = await Promise.race([
        new Promise((_, reject) => { abort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', abort, { once: true }); }),
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return api.shutdownServices(current.source, { signal: controller.signal }); }),
      ]);
      if (version !== epoch) return false;
      if (source() !== current.source || state.route !== 'settings') { leave(); current.error = 'changed'; patch(); return false; }
      const result = readShutdownResponse(response);
      current.phase = 'accepted'; close(); patch();
      try { beforeExit(); } catch { /* A local cache error cannot cancel an accepted shutdown. */ }
      exit(result);
      return true;
    } catch (error) {
      if (version !== epoch) return false;
      current.error = ({ 403: 'forbidden', 404: 'unavailable', 405: 'unavailable', 409: 'conflict', 422: 'invalid', 503: 'dependency' })[error?.status] || 'uncertain';
      if (current.phase !== 'accepted') current.phase = 'idle';
      close(); patch(); return false;
    } finally {
      clearTimer(deadline); controller.signal.removeEventListener('abort', abort);
      if (timer === deadline) timer = null;
      if (request === controller) request = null;
    }
  }
  function leave() {
    if (current.phase === 'accepted') return;
    epoch += 1; clearTimer(timer); request?.abort(); request = null;
    if (current.phase === 'submitting') current.error = 'uncertain';
    current.phase = 'idle'; close();
  }
  root()?.addEventListener('click', event => {
    const button = event.target.closest?.('[data-shutdown-open]');
    if (button && !button.disabled) { event.preventDefault(); open(); }
  });
  return { open, submit, cancel, leave, patch };
}
