import { escapeHtml as h, escapeAttr as a, simpleRichText, formatAmount, formatShortDate } from './utils.js';
import { informationText, informationWeekdays } from './agent-information-copy.js';
import { createAgentInformationState, RUN_ACTIVE, RUN_TERMINAL } from './agent-information-model.js';
import { taskPeriodLabel, taskPeriodValue, taskPeriodRulerMarkup } from './task-period-ruler.js';
import { canReply, REPLY_STATES } from './agent-insight-replies.js';

const model = ctx => ctx.state.agentInformation || createAgentInformationState();
const text = (ctx, key) => informationText(ctx.language, key);
const button = (ctx, key, action, id = '', disabled = false, extra = '') => '<button class="button" type="button" data-information-action="' + action +
  '" data-id="' + a(id) + '"' + (disabled ? ' disabled' : '') + extra + '>' + h(text(ctx, key)) + '</button>';
const note = (ctx, key) => '<p class="information-note">' + h(text(ctx, key)) + '</p>';
const empty = (ctx, key) => '<p class="information-empty">' + h(text(ctx, key)) + '</p>';
export function taskCreateButton(ctx) {
  return '<button class="button information-create-button" type="button" data-information-action="new-task" aria-haspopup="dialog">' + h(text(ctx, 'newTask')) + '</button>';
}
export function informationDate(value, language) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString({ zh: 'zh-CN', ja: 'ja-JP', en: 'en-GB' }[language] || 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const time = (ctx, value) => '<time title="' + a(value || '') + '">' + h(informationDate(value, ctx.language)) + '</time>';
// A data period reads in days; minutes on both ends only add noise.
export function informationDay(value, language) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString({ zh: 'zh-CN', ja: 'ja-JP', en: 'en-GB' }[language] || 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
// List rows drop the year within the current year; the full time stays in the tooltip.
export function informationListTime(value, language, now = new Date()) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '—';
  const locale = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-GB' }[language] || 'en-GB';
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}
const day = (ctx, value) => '<time title="' + a(value || '') + '">' + h(informationDay(value, ctx.language)) + '</time>';
const quiet = (ctx, key, action, id = '', disabled = false) => '<button class="button compact ghost" type="button" data-information-action="' + action +
  '" data-id="' + a(id) + '"' + (disabled ? ' disabled' : '') + '>' + h(text(ctx, key)) + '</button>';
function status(ctx, value) {
  const known = RUN_ACTIVE.has(value) || RUN_TERMINAL.has(value);
  return '<span class="information-status" data-run-status="' + a(known ? value : 'unknown') + '">' + h(text(ctx, known ? value : 'unknownStatus')) + '</span>';
}
function facts(items) { return '<dl class="information-facts">' + items.map(([key, value]) => '<div><dt>' + h(key) + '</dt><dd>' + value + '</dd></div>').join('') + '</dl>'; }
function replyBadge(ctx, item) {
  const value = item?.reply_state;
  return !value || value === 'none' ? '' : '<span class="information-status" data-reply-state="' + a(REPLY_STATES.has(value) ? value : 'unknown') + '">' + h(text(ctx, REPLY_STATES.has(value) ? 'reply_' + value : 'unknownStatus')) + '</span>';
}
function pager(ctx, offset, total, prefix, loading) {
  return '<div class="information-pagination"><span>' + (total ? offset + 1 : 0) + '–' + Math.min(offset + 20, total) + ' / ' + total + ' ' + h(text(ctx, 'total')) + '</span><div class="button-row">' +
    button(ctx, 'previous', prefix + '-previous', '', loading || offset === 0) + button(ctx, 'next', prefix + '-next', '', loading || offset + 20 >= total) + '</div></div>';
}
function insightList(ctx) {
  const s = model(ctx);
  const feed = s.insightFeed, busy = s.loading.insights || feed.loadingMore;
  const rows = s.insights.map(item => '<div class="information-list-entry" data-selected="' + (s.insightId === item.id) + '" data-insight-entry="' + a(item.id) + '"><button type="button" class="information-list-item" data-information-action="insight" data-id="' + a(item.id) + '" aria-current="' + (s.insightId === item.id) + '">' +
    // Unread is a dot and a heavier title inside the button (the list patcher refreshes button contents only); the
    // words stay for screen readers.
    '<span class="information-insight-meta" data-kind="' + a(item.data?.kind || '') + '"><span class="information-list-meta">' + h(text(ctx, item.data?.kind)) + '</span><time title="' + a(item.updated_at || '') + '">' + h(informationListTime(item.updated_at, ctx.language)) + '</time></span>' +
    '<strong class="information-insight-title" data-unread="' + !item.is_read + '">' + h(item.data?.title) + '</strong>' +
    '<span class="information-sr">' + h(text(ctx, item.is_read ? 'read' : 'unread')) + '</span>' +
    (replyBadge(ctx, item) ? '<span class="information-insight-bottom">' + replyBadge(ctx, item) + '</span>' : '') + '</button></div>').join('');
  const end = feed.error ? '<p role="alert">' + h(text(ctx, feed.error)) + '</p>' + button(ctx, 'retry', 'insights-retry', '', busy) :
    busy ? '<span class="information-feed-loading" role="status">' + h(text(ctx, 'loading')) + '</span>' :
    !s.insights.length ? empty(ctx, s.insightsLoaded ? 'emptyInsights' : 'selectInsight') :
    '<span>' + h(text(ctx, feed.hasMore ? 'scrollForMore' : 'allInsightsLoaded')) + '</span>';
  return '<div class="information-feed-count" data-insight-feed-count><span>' + s.insights.length + ' / ' + s.total + ' ' + h(text(ctx, 'total')) + '</span></div>' +
    '<div class="information-list information-insight-list" data-insight-scroll data-filter="' + a(JSON.stringify(s.filter)) + '" tabindex="0" aria-label="' + a(text(ctx, 'existingInsights')) + '" aria-busy="' + Boolean(busy) + '">' + rows +
    '<div class="information-feed-end" data-insight-feed-end>' + end + '</div></div>';
}
// With nothing open, say what is waiting instead of showing an empty frame; opening an item marks it read, so the
// overview points at it rather than opening it.
export function insightOverview(ctx) {
  const s = model(ctx);
  if (!s.insights.length) return empty(ctx, s.insightsLoaded ? 'emptyInsights' : 'loading');
  const unread = s.insights.filter(item => !item.is_read), pending = unread.filter(item => item.data?.kind === 'pending_confirmation');
  const next = pending[0] || unread[0] || s.insights[0];
  return '<div class="information-overview" role="status"><h2>' + h(unread.length ? text(ctx, 'overviewUnread').replace('{count}', Math.max(unread.length, Number(s.unreadCount) || 0)) : text(ctx, 'overviewAllRead')) + '</h2>' +
    (pending.length ? '<p>' + h(text(ctx, 'overviewPending').replace('{count}', pending.length)) + '</p>' : '') +
    button(ctx, pending.length ? 'openFirstPending' : unread.length ? 'openFirstUnread' : 'openLatest', 'insight', next.id) + '</div>';
}
// A linked deal reads as merchant, amount and day when the ledger has it loaded; the bare number otherwise.
function dealLabel(ctx, id) {
  const deal = (ctx.state.deals || []).find(row => String(row.DealingNumber) === String(id));
  return deal ? [deal.ShopName, formatAmount(deal.price, deal.CurrencyTypeNumber, ctx.language), formatShortDate(deal.ISOtime, ctx.language)].filter(Boolean).join(' · ') : '#' + id;
}
function insightDetail(ctx) {
  const s = model(ctx), item = s.insight, data = item?.data;
  if (!data) return s.loading.insight || s.replies?.checking[s.insightId] ? empty(ctx, 'loading') : insightOverview(ctx);
  const period = data.period_start || data.period_end ? day(ctx, data.period_start) + '<span class="information-date-separator"> — </span>' + day(ctx, data.period_end) : '—';
  const deals = data.dealing_numbers || [], calls = item.source_calls || [];
  // A confirmation without a reply session cannot be answered here; offer the two ways forward instead of a dead end.
  const legacyConfirm = data.needs_confirmation && (!item.reply_state || item.reply_state === 'none');
  return '<article class="information-article information-insight-detail"><header class="information-detail-header">' +
    '<button class="information-back" type="button" data-information-action="insight-back">' + h(text(ctx, 'backToList')) + '</button>' +
    '<div class="information-article-actions"><div class="information-detail-meta"><span class="information-kind">' + h(text(ctx, data.kind)) + '</span><span>' + h(text(ctx, item.task_id ? 'sourceTask' : 'sourceChat')) +
    '</span></div>' + quiet(ctx, item.is_read ? 'markUnread' : 'markRead', 'read', item.id, Boolean(s.busy)) + '</div><h2>' + h(data.title) + '</h2></header>' +
    (legacyConfirm ? '<section class="information-confirm"><p>' + h(text(ctx, deals.length ? 'confirmWithDeal' : 'confirmInChat')) + '</p><div class="button-row">' +
      (deals.length ? '<button class="button primary" type="button" data-information-action="deal" data-id="' + a(deals[0]) + '">' + h(text(ctx, 'openDeal')) + '</button>' : '') +
      button(ctx, 'askAgent', 'ask-agent', item.id) + '</div></section>' : '') +
    facts([[text(ctx, 'period'), period], [text(ctx, 'updated'), time(ctx, item.updated_at)]]) +
    '<div class="information-prose">' + simpleRichText(data.content) + '</div>' +
    (deals.length ? '<section class="information-section"><h3>' + h(text(ctx, 'relatedDeals')) + '</h3><div class="information-links">' + deals.map(id =>
      '<button class="button information-deal" type="button" data-information-action="deal" data-id="' + a(id) + '">' + h(dealLabel(ctx, id)) + '</button>').join('') + '</div></section>' : '') +
    // Where it came from, on one quiet line: the run that produced it and the reads behind it.
    '<footer class="information-source">' + (item.run_id ? quiet(ctx, 'sourceRun', 'source-run', item.run_id) : '') +
    '<details class="information-disclosure" data-information-details="sources"><summary>' + h(text(ctx, 'sourceCalls')) + (calls.length ? ' · ' + calls.length : '') + '</summary>' + note(ctx, 'sourceHint') +
    (calls.length ? '<ul class="information-source-list">' + calls.map(call => '<li><div><strong>' + h(call.tool_name) + '</strong>' + time(ctx, call.created_at) + '</div><code>' + h(call.tool_call_id) + '</code></li>').join('') + '</ul>' : '') +
    (data.evidence_ids?.length ? '<h3>' + h(text(ctx, 'evidence')) + '</h3><ul>' + data.evidence_ids.map(id => '<li><code>' + h(id) + '</code></li>').join('') + '</ul>' : '') + '</details></footer></article>';
}
function replyStatus(ctx) {
  const s = model(ctx), item = s.insight, id = s.insightId, r = s.replies;
  if (!id || !r) return '';
  const reply = item?.reply || {}, pending = r.pending[id], busy = r.busy[id];
  if ((!item?.reply_state || item.reply_state === 'none') && !pending && !busy && !r.errors[id] && !r.loadErrors[id] && !r.unavailable[id] && !r.notices[id]) return '';
  return '<section class="information-reply-status" aria-live="polite">' +
    (item?.reply_state && item.reply_state !== 'none' ? '<header class="information-reply-heading"><h3>' + h(text(ctx, 'replyProgress')) + '</h3>' + replyBadge(ctx, item) + '</header>' : '') +
    (reply.message ? '<h3>' + h(text(ctx, 'replyYourMessage')) + '</h3><p class="information-reply-message">' + h(reply.message) + '</p>' + (reply.submitted_at ? '<p class="information-note">' + time(ctx, reply.submitted_at) + '</p>' : '') : '') +
    (reply.answer ? '<h3>' + h(text(ctx, 'replyAnswer')) + '</h3><div class="information-prose">' + simpleRichText(reply.answer) + '</div>' : '') +
    (reply.error ? '<p class="information-warning" role="alert">' + h(typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error)) + '</p>' : '') +
    (item?.reply_state === 'failed' ? note(ctx, 'replyFailedHint') : '') +
    (item?.reply_state === 'cancelled' || r.unavailable[id] === 410 ? note(ctx, 'replyCancelledHint') : '') +
    (r.unavailable[id] === 404 ? note(ctx, 'replyMissing') : '') +
    (r.errors[id] ? '<p class="information-warning" data-insight-reply-error role="alert">' + h(text(ctx, r.errors[id])) + '</p>' : '') +
    (r.loadErrors[id] ? '<p class="information-warning" role="alert">' + h(text(ctx, r.loadErrors[id])) + '</p>' : '') +
    (r.notices[id] ? note(ctx, r.notices[id]) : '') +
    (busy || item?.reply_state === 'running' ? '<p class="information-reply-running" role="status">' + h(text(ctx, 'replyRunningHint')) + '</p>' : '') +
    (pending && !busy && item?.reply_state !== 'running' && !r.unavailable[id] ? note(ctx, 'replyUncertain') + '<p class="information-reply-message">' + h(pending.message) + '</p>' : '') +
    '<div class="button-row">' + (pending && !busy && canReply(item) && !r.unavailable[id] ? button(ctx, 'replyRetry', 'reply-retry', id, Boolean(r.checking[id])) : '') +
    ((pending || r.errors[id] || r.loadErrors[id] || item?.reply_state === 'running') ? button(ctx, 'replyCheck', 'reply-refresh', id, Boolean(r.checking[id])) : '') +
    (reply.next_insight_id ? button(ctx, 'replyContinue', 'insight', reply.next_insight_id) : '') + '</div></section>';
}
function replyEditor(ctx) {
  const s = model(ctx), item = s.insight, r = s.replies;
  if (!canReply(item) || !r || r.unavailable[item.id]) return '';
  const id = item.id, locked = r.busy[id] || r.pending[id];
  return '<form class="information-reply-editor" data-insight-reply-form data-id="' + a(id) + '" novalidate>' +
    '<label class="field"><span>' + h(text(ctx, 'replyLabel')) + '</span><textarea data-insight-reply-input rows="4" maxlength="8000" aria-describedby="insight-reply-hint"' + (locked ? ' readonly' : '') + '>' + h(r.pending[id]?.message ?? r.drafts[id] ?? '') + '</textarea></label>' +
    '<p class="information-note" id="insight-reply-hint">' + h(text(ctx, 'replyHint')) + '</p><footer class="button-row"><button type="submit" class="button primary"' + (locked ? ' disabled' : '') + '>' + h(text(ctx, r.busy[id] ? 'replySending' : 'replySend')) + '</button></footer></form>';
}
function taskList(ctx) {
  const s = model(ctx);
  return s.tasks.length ? '<div class="information-list">' + s.tasks.map(task => '<div class="information-list-entry information-task-item" data-selected="' + (s.taskId === task.id) + '"><button type="button" class="information-list-item" data-information-action="task" data-id="' + a(task.id) + '" aria-current="' + (s.taskId === task.id) + '"' + (s.busy ? ' disabled' : '') + '>' +
    '<span class="information-list-meta">' + h(text(ctx, task.config.enabled ? 'enabled' : 'disabled')) + ' · ' + h(text(ctx, task.config.schedule.kind)) + '</span><strong>' + h(task.config.name) +
    '</strong><span>' + h(text(ctx, 'nextRun')) + ': ' + (task.next_run_at ? time(ctx, task.next_run_at) : h(text(ctx, 'noNext'))) + '</span></button>' +
    '<button class="button compact ghost icon-only danger-quiet information-task-delete" type="button" data-information-action="delete-task" data-id="' + a(task.id) + '" title="' + a(text(ctx, 'deleteTask')) + '" aria-label="' + a(text(ctx, 'deleteTask') + ': ' + task.config.name) + '"' + (s.busy ? ' disabled' : '') + '><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg></button></div>').join('') + '</div>' : empty(ctx, s.loading.tasks ? 'loading' : 'emptyTasks');
}
function taskDetail(ctx) {
  const s = model(ctx), task = s.task, config = task?.config;
  if (!config) return empty(ctx, s.loading.task ? 'loading' : s.taskRemoved ? 'removedTaskHistory' : 'selectTask');
  const schedule = config.schedule, pending = s.pending[task.id], active = Boolean(pending?.runId) || s.runs.some(run => RUN_ACTIVE.has(run.status));
  const extra = schedule.kind === 'weekly' ? informationWeekdays(ctx.language)[schedule.weekday] + ' ' + schedule.at :
    schedule.kind === 'daily' ? schedule.at : schedule.kind === 'once' ? informationDate(schedule.run_at, ctx.language) : '';
  const cycle = schedule.kind === 'interval' ? text(ctx, 'everyPeriod').replace('{period}', taskPeriodLabel(schedule.interval_seconds, ctx.language)) :
    [text(ctx, schedule.kind), extra].filter(Boolean).join(' ');
  return '<article class="information-article information-task-detail"><header class="information-detail-header"><div class="information-detail-meta"><span class="information-status" data-schedule-enabled="' + Boolean(config.enabled) + '">' + h(text(ctx, config.enabled ? 'enabled' : 'disabled')) + '</span></div><h2>' + h(config.name) + '</h2><div class="button-row information-task-actions">' + button(ctx, 'edit', 'edit-task', task.id, Boolean(s.busy)) +
    button(ctx, config.enabled ? 'pause' : 'resume', 'toggle-task', task.id, Boolean(s.busy)) +
    button(ctx, pending && !pending.runId ? 'retryRun' : 'runNow', 'run', task.id, Boolean(s.busy) || active || s.workerEnabled !== true, ' data-primary-action') + '</div></header>' +
    (pending && !pending.runId ? '<p class="information-warning">' + h(text(ctx, 'pendingRetry')) + '</p>' : '') +
    facts([[text(ctx, 'executionCycle'), h(cycle)],
      [text(ctx, 'nextRun'), task.next_run_at ? time(ctx, task.next_run_at) : h(text(ctx, 'noNext'))]]) +
    '<section class="information-task-prompt"><h3>' + h(text(ctx, 'prompt')) + '</h3><div class="information-prose">' + simpleRichText(config.prompt) + '</div></section></article>';
}
function editor(ctx) {
  const s = model(ctx), e = s.editor;
  if (!e) return '';
  const d = e.draft;
  const legacy = e.id && d.kind !== 'interval';
  const selectedPeriod = legacy ? text(ctx, d.kind) : taskPeriodLabel(d.interval_seconds, ctx.language);
  return '<form data-task-form novalidate class="information-editor"><h2 id="task-editor-title">' + h(text(ctx, e.id ? 'edit' : 'newTask')) + '</h2><fieldset' + (s.busy ? ' disabled' : '') + '>' +
    '<label class="field"><span>' + h(text(ctx, 'prompt')) + '</span><textarea name="prompt" data-task-field="prompt" rows="6" required maxlength="8000" placeholder="' + a(text(ctx, 'promptHint')) + '">' + h(d.prompt) + '</textarea></label>' +
    '<div class="information-period"><div class="information-period-heading"><label for="task-period">' + h(text(ctx, 'cycle')) + '</label><output data-task-period-label for="task-period">' + h(selectedPeriod) + '</output></div>' +
    taskPeriodRulerMarkup(taskPeriodValue(d), ctx.language, text(ctx, 'cycle'), selectedPeriod) +
    (legacy ? '<p class="information-period-hint">' + h(text(ctx, 'legacyCycle')) + '</p>' : '') + '</div>' +
    note(ctx, e.id ? 'cycleHint' : 'createHint') +
    '<footer class="button-row">' + button(ctx, 'cancel', 'cancel-edit', '', Boolean(s.busy)) + '<button class="button primary" type="submit"' + (e.uncertain || s.busy ? ' disabled' : '') + '>' + h(text(ctx, s.busy === 'save' ? 'saving' : 'save')) + '</button></footer></fieldset></form>';
}
function runHistory(ctx) {
  const s = model(ctx);
  if (!s.taskId) return '';
  return '<section class="information-section information-history"><h3>' + h(text(ctx, 'history')) + '</h3>' + (s.runs.length ? '<div class="information-run-list" tabindex="0" role="region" aria-label="' + a(text(ctx, 'history')) + '">' + s.runs.map(run =>
    '<button type="button" data-information-action="run-detail" data-id="' + a(run.id) + '" aria-haspopup="dialog" aria-controls="information-run-dialog" aria-current="' + (s.runOpen && s.runId === run.id) + '">' + status(ctx, run.status) +
    '<span>' + time(ctx, run.created_at) + '</span><span>' + h(text(ctx, run.trigger_type === 'schedule' ? 'scheduleTrigger' : 'manualTrigger')) + '</span></button>').join('') + '</div>' : empty(ctx, s.loading.runs ? 'loading' : 'noRuns')) +
    pager(ctx, s.runsOffset, s.runsTotal, 'runs', s.loading.runs) + '</section>';
}
function runDetail(ctx) {
  const s = model(ctx), run = s.run;
  if (!s.runOpen || !s.runId) return '';
  const error = s.runError ? '<div class="information-warning" role="alert">' + h(text(ctx, s.runError)) + '</div>' +
    button(ctx, 'retry', 'retry-run-detail', s.runId, Boolean(s.loading.run)) : '';
  if (!run) return error || '<div role="status">' + empty(ctx, 'loading') + '</div>';
  const times = run.started_at ? [[text(ctx, 'started'), time(ctx, run.started_at)]] : [[text(ctx, 'created'), time(ctx, run.created_at)]];
  if (run.finished_at) times.push([text(ctx, 'finished'), time(ctx, run.finished_at)]);
  return '<article class="information-article information-run-detail"><div class="information-run-heading" role="status">' + status(ctx, run.status) + '</div>' +
    facts(times) + error +
    (run.status === 'interrupted' ? note(ctx, 'interruptedHint') : '') +
    (run.error ? '<h3>' + h(text(ctx,'error')) + '</h3><p class="information-warning" role="alert">' + h(typeof run.error === 'string' ? run.error : JSON.stringify(run.error)) + '</p>' : '') +
    '<section class="information-run-result"><h3>' + h(text(ctx,'result')) + '</h3><div class="information-prose">' + (run.result ? simpleRichText(typeof run.result === 'string' ? run.result : JSON.stringify(run.result,null,2)) : empty(ctx,'noResult')) + '</div></section>' +
    (run.status === 'waiting_reply' ? button(ctx, 'replyOpenWaiting', 'waiting-run', run.id) : '') + '</article>';
}
export function informationParts(ctx) {
  const s = model(ctx), tasks = ctx.state.route === 'agent-tasks';
  const feedback = (s.error ? '<div class="information-warning" role="alert">' + h(text(ctx,s.error)) + '</div>' : '') +
    (s.notice ? '<p role="status">' + h(text(ctx,s.notice)) + '</p>' : '');
  const editorStatus = feedback +
    (s.editor?.uncertain ? '<p class="information-warning">' + h(text(ctx,'createUncertain')) + '</p>' + button(ctx,'checkCreated','check-created','',Boolean(s.busy)) : '');
  return {
    controls: tasks ? '' :
      '<div class="information-filters"><div class="information-kinds" role="radiogroup" aria-label="' + a(text(ctx,'informationType')) + '">' +
      [['',text(ctx,'allKinds')],...['pending_confirmation','anomaly','analysis'].map(v => [v,text(ctx,v)])].map(([value,label]) =>
        '<label class="information-chip"><input type="radio" name="information-kind" data-information-filter="kind" value="' + a(value) + '"' + (String(s.filter.kind || '') === value ? ' checked' : '') + '><span>' + h(label) + '</span></label>').join('') + '</div>' +
      '<div class="information-filter-row"><label class="information-check"><input type="checkbox" data-information-filter="unread_only"' + (s.filter.unread_only ? ' checked' : '') + '> ' + h(text(ctx,'unreadOnly')) +
      (s.unreadCount ? ' <span class="information-unread-count">' + s.unreadCount + '</span>' : '') + '</label>' + quiet(ctx,'refresh','refresh') + '</div></div>',
    status: (tasks && s.editor ? '' : feedback) +
      (tasks && s.deleteRetry ? '<p class="information-note">' + h(text(ctx, 'deleteUncertain')) + ' ' + h(s.deleteRetry.name) + '</p>' + button(ctx, 'retryDelete', 'retry-delete', s.deleteRetry.id, Boolean(s.busy)) : '') +
      (tasks && s.workerEnabled !== true ? note(ctx,s.workerEnabled === false ? 'workerOff' : 'workerUnknown') : ''),
    editorStatus: tasks && s.editor ? editorStatus : '',
    list: tasks ? taskList(ctx) : insightList(ctx),
    detail: tasks ? taskDetail(ctx) : insightDetail(ctx),
    replyStatus: tasks ? '' : replyStatus(ctx),
    replyEditor: tasks ? '' : replyEditor(ctx),
    editor: tasks ? editor(ctx) : '',
    history: tasks ? runHistory(ctx) : '',
    run: tasks ? runDetail(ctx) : '',
  };
}
export function agentInformationView(ctx) {
  const parts = informationParts(ctx), tasks = ctx.state.route === 'agent-tasks';
  const region = key => '<div data-information-part="' + key + '">' + parts[key] + '</div>';
  return '<div class="information-workspace" data-information-root data-mode="' + (tasks ? 'tasks' : 'information') + '">' + region('status') +
    '<div class="information-layout"><aside class="information-index"><h2 class="information-index-title">' + h(text(ctx, tasks ? 'existingTasks' : 'existingInsights')) + '</h2>' + region('controls') + region('list') + '</aside><section class="information-detail">' +
    ['detail','replyStatus','replyEditor','history'].map(region).join('') + '</section></div>' +
    (tasks ? '<dialog class="information-task-dialog" data-task-dialog aria-labelledby="task-editor-title">' +
      '<button class="icon-button modal-close" type="button" data-information-action="cancel-edit" aria-label="' + a(text(ctx, 'cancel')) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      region('editorStatus') + region('editor') + '</dialog>' +
      '<dialog class="information-run-dialog" id="information-run-dialog" data-run-dialog aria-labelledby="run-dialog-title">' +
      '<header class="information-run-dialog-header"><h2 id="run-dialog-title">' + h(text(ctx, 'runDetail')) + '</h2>' +
      '<button class="icon-button" type="button" data-information-action="close-run" aria-label="' + a(text(ctx, 'closeRun')) + '" autofocus>' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>' +
      '<div class="information-run-dialog-body" tabindex="0" role="region" aria-labelledby="run-dialog-title">' + region('run') + '</div></dialog>' : '') + '</div>';
}
