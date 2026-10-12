import { escapeHtml as e, escapeAttr as a } from './utils.js';
import { gmailText } from './gmail-settings-copy.js';
import { createGmailSettingsState } from './gmail-settings-model.js';
import { safeAuthorizationUrl } from './initialization/model.js';

export function gmailSettingsView(ctx) {
  const state = ctx.state.gmailSettings || createGmailSettingsState('');
  const text = key => gmailText(ctx.language, key), waiting = state.phase === 'waiting';
  const pending = state.operation?.state === 'pending';
  const disabled = !state.supported || state.busy || pending;
  const status = state.unreachable ? 'unreachable' : state.connection;
  const message = state.error || (state.busy ? state.phase : waiting ? 'waiting' : state.notice);
  const url = pending && state.phase !== 'expired' ? safeAuthorizationUrl(state.operation.url) : '';
  return '<section class="settings-group gmail-settings" data-gmail-settings aria-labelledby="settings-gmail">' +
    '<header><h2 id="settings-gmail">' + e(text('title')) + '</h2><span class="settings-behavior">' + e(text('independent')) + '</span></header>' +
    '<div data-gmail-content aria-busy="' + Boolean(state.busy) + '"><dl class="gmail-settings-summary"><div><dt>' + e(text('email')) +
    '</dt><dd data-gmail-email>' + e(state.email || text('noEmail')) + '</dd></div><div><dt>' + e(text('status')) +
    '</dt><dd><span class="gmail-settings-status" data-gmail-status="' + a(state.supported ? status : 'unsupported') + '">' +
    e(text(state.supported ? status : 'unsupported')) + '</span></dd></div></dl>' +
    (!state.supported ? '<p class="gmail-settings-note">' + e(text('unsupportedHint')) + '</p><details class="gmail-settings-missing"><summary>' +
      e(text('missingTitle')) + '</summary><ul>' + ['missingRead', 'missingVerify', 'missingBegin', 'missingPoll'].map(key => '<li>' + e(text(key)) + '</li>').join('') + '</ul></details>' : '') +
    '<p class="gmail-settings-note">' + e(text('sameAccount')) + '</p>' +
    '<div class="gmail-settings-actions"><button class="button" type="button" data-gmail-check' + (disabled ? ' disabled' : '') + '>' + e(text('check')) +
    '</button><button class="button" type="button" data-gmail-authorize' + (disabled || !state.email ? ' disabled' : '') + '>' + e(text('reauthorize')) + '</button>' +
    (waiting || state.phase === 'opening' ? '<button class="text-button" type="button" data-gmail-stop>' + e(text('stop')) + '</button>' : '') +
    (pending && state.phase === 'paused' ? '<button class="button" type="button" data-gmail-resume' + (state.busy ? ' disabled' : '') + '>' + e(text('resume')) + '</button>' : '') + '</div>' +
    '<p class="gmail-settings-feedback" data-gmail-feedback role="' + (state.error ? 'alert' : 'status') + '" aria-live="polite">' + e(message ? text(message) : '') + '</p>' +
    (url ? (state.popupBlocked ? '<p class="gmail-settings-note" role="status">' + e(text('blocked')) + '</p>' : '') +
      '<a class="gmail-settings-link" href="' + a(url) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' + e(text('openLink')) + '</a>' : '') +
    '</div></section>';
}

const versions = new WeakMap();
export function patchGmailSettings(root, ctx) {
  const host = root?.querySelector('[data-gmail-settings]');
  if (!host) return false;
  const html = gmailSettingsView(ctx);
  if (versions.get(host) === html) return true;
  const doc = host.ownerDocument, active = doc.activeElement;
  const focusKey = active && host.contains(active) ? ['check', 'authorize', 'stop', 'resume'].find(key => active.hasAttribute('data-gmail-' + key)) : '';
  const expanded = host.querySelector('details')?.open;
  const template = doc.createElement('template'); template.innerHTML = html;
  host.replaceChildren(...template.content.firstElementChild.childNodes);
  if (expanded && host.querySelector('details')) host.querySelector('details').open = true;
  if (focusKey) host.querySelector('[data-gmail-' + focusKey + ']:not(:disabled)')?.focus({ preventScroll: true });
  versions.set(host, html);
  return true;
}
