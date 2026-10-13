import { escapeHtml as e, escapeAttr as a, formatDateTime } from './utils.js';
import { fullMailText } from './full-mail-import-copy.js';
import { MAIL_COUNTERS, createFullMailImportState, mailImportActive, mailImportCanStart } from './full-mail-import-model.js';

export function fullMailImportView(ctx) {
  const state = ctx.state.fullMailImport || createFullMailImportState(''), text = key => fullMailText(ctx.language, key);
  const task = state.task, active = mailImportActive(task);
  const status = state.busy === 'POST' ? 'starting' : task?.cancelling || state.busy === 'STOP' ? 'cancelling'
    : task?.status || (state.busy ? 'loading' : 'unknown');
  const errors = [state.startError, state.error].filter(Boolean).map(error => text(error.key) + (error.detail ? ' ' + error.detail : ''));
  const notice = value => value ? '<p class="mail-full-note">' + e(value) + '</p>' : '';
  return '<section class="settings-group mail-full-settings" data-full-mail-import aria-labelledby="settings-full-mail"><header><h2 id="settings-full-mail">' +
    e(text('title')) + '</h2></header>' +
    (state.available === true && task?.scope !== 'inbox' ? '<p class="mail-full-feedback">' + e(text('scopeUnavailable')) + '</p>' : '') +
    '<div class="mail-full-actions"><button class="button" type="button" data-mail-full-start' + (!mailImportCanStart(state) || state.confirming ? ' disabled' : '') + '>' +
      e(text('start')) + '</button><button class="button" type="button" data-mail-full-refresh' + (state.busy ? ' disabled' : '') + '>' + e(text('refresh')) + '</button>' +
    (active ? '<button class="button" type="button" data-mail-full-stop' + (state.busy || task.cancelling ? ' disabled' : '') + '>' + e(text('stop')) + '</button>' : '') +
    '<span class="mail-full-status" role="status" aria-live="polite"><span class="mail-full-state" data-mail-full-status="' + a(task?.status || 'unknown') + '">' +
    e(text(status)) + (task?.stage && active && status !== 'cancelling' ? ' · ' + e(text(task.stage)) : '') + '</span></span></div>' +
    (state.confirming ? '<div class="mail-full-confirm" role="group" aria-labelledby="mail-full-confirm-title"><h3 id="mail-full-confirm-title">' +
      e(text('confirmTitle')) + '</h3><p>' + e(text('warning')) + '</p>' +
      (state.uncertain ? notice(text('uncertain')) : '') + '<div class="mail-full-actions"><button class="button primary" type="button" data-mail-full-confirm' +
      (!mailImportCanStart(state) ? ' disabled' : '') + '>' + e(text('confirm')) + '</button><button class="button" type="button" data-mail-full-back' +
      (state.busy === 'POST' ? ' disabled' : '') + '>' + e(text('back')) + '</button></div></div>' : '') +
    '<div class="mail-full-feedback" role="alert">' + errors.map(message => '<p>' + e(message) + '</p>').join('') + '</div>' +
    (state.uncertain && !state.confirming ? notice(text('uncertain')) : '') + notice(state.notice ? text(state.notice) : '') +
    (active ? notice(text('leaveHint')) : '') +
    (task?.status === 'completed_with_pending' ? notice(text('pendingHint')) : '') +
    (['failed', 'interrupted'].includes(task?.status) ? notice(text('failureHint')) : '') +
    (task?.error ? '<p class="mail-full-feedback">' + e(task.error) + '</p>' : '') +
    (task?.task_id ? '<dl class="mail-full-meta">' + [['created', task.created_at], ['finished', task.finished_at]].filter(([, value]) => value).map(([key, value]) =>
      '<div><dt>' + e(text(key)) + '</dt><dd>' + e(formatDateTime(value, ctx.language)) + '</dd></div>').join('') +
      '<div><dt>' + e(text('taskId')) + '</dt><dd>' + e(task.task_id) + '</dd></div></dl>' : '') +
    (task?.sources.length ? '<div class="table-scroll mail-full-table"><table><thead><tr><th scope="col">' + e(text('source')) + '</th>' +
      MAIL_COUNTERS.map(key => '<th scope="col">' + e(text(key === 'completed' ? 'completedCount' : key === 'failed' ? 'failedCount' : key)) + '</th>').join('') +
      '</tr></thead><tbody>' + task.sources.map(source => '<tr><th scope="row">' + e(text(source)) + '</th>' + MAIL_COUNTERS.map(key =>
        '<td>' + e(task.results[source]?.[key] ?? '—') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' +
      notice(text('countsHint')) + (task.results.ocr_mail?.skipped_bank > 0 ? notice(text('skippedBank') + ': ' + task.results.ocr_mail.skipped_bank) : '') +
      (active ? notice(text('waitingResults')) : '') : '') + '</section>';
}

const versions = new WeakMap();
export function patchFullMailImport(root, ctx) {
  const host = root?.querySelector('[data-full-mail-import]');
  if (!host) return false;
  const html = fullMailImportView(ctx);
  if (versions.get(host) === html) return true;
  const doc = host.ownerDocument, active = doc.activeElement;
  const action = host.contains(active) ? ['start', 'refresh', 'confirm', 'back'].find(key => active.hasAttribute('data-mail-full-' + key)) : null;
  const scroll = host.querySelector('.mail-full-table')?.scrollLeft || 0;
  const template = doc.createElement('template'); template.innerHTML = html;
  host.replaceChildren(...template.content.firstElementChild.childNodes);
  if (action) host.querySelector('[data-mail-full-' + action + ']:not(:disabled)')?.focus({ preventScroll: true });
  if (host.querySelector('.mail-full-table')) host.querySelector('.mail-full-table').scrollLeft = scroll;
  versions.set(host, html);
  return true;
}
