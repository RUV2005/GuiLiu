import { escapeHtml as h, escapeAttr as a } from './utils.js';
import { planForecastChart } from './plans-chart.js';
import { financeAttr } from './finance-colors.js';
import { createPlansState, displayCurrency, apiCurrency, japanDay, visiblePlan, PLAN_CURRENCIES } from './plans-model.js';
import { planText, planMoney } from './plans-copy.js';
import { allocationScale } from './plans-allocation.js';
const state = ctx => ctx.state.plans || createPlansState();
const tx = (ctx, key) => planText(ctx.language, key);
const money = (ctx, value, currency) => h(planMoney(value, currency, ctx.language));
const button = (ctx, key, action, id = '', extra = '') => '<button type="button" class="button" data-plan-action="' + action + '" data-id="' + a(id) + '"' + extra + '>' + h(tx(ctx, key)) + '</button>';
const option = (value, label, selected) => '<option value="' + a(value) + '"' + (String(value) === String(selected) ? ' selected' : '') + '>' + h(label) + '</option>';
const field = (ctx, key, label, value, type = 'text', extra = '') => '<label class="field"><span>' + h(tx(ctx, label)) + '</span><input data-plan-field="' + key + '" type="' + type + '" value="' + a(value ?? '') + '"' + extra + '></label>';
const amountField = (ctx, key, label, value, extra = '') => field(ctx, key, label, value, 'text', ' inputmode="decimal" autocomplete="off"' + extra);
const fact = (label, value) => '<div><dt>' + h(label) + '</dt><dd>' + value + '</dd></div>';
const blocked = s => s.busy || s.pending ? ' disabled' : '';
function accountName(s, number) { return s.accounts.find(row => row.account_number === number)?.name || '#' + number; }
function cards(ctx) {
  const s = state(ctx);
  const list = s.items.filter(visiblePlan).map(plan => {
    const progress = plan.progress || {}, ratio = progress.progress_percent;
    return '<button type="button" class="plan-card" data-plan-action="select" data-id="' + a(plan.id) + '" aria-pressed="' + (s.selected === plan.id) + '">' +
      '<span class="plan-card-top"><span>' + h(tx(ctx, plan.type)) + '</span></span>' +
      '<strong class="plan-card-title">' + h(plan.title) + '</strong><span class="plan-card-amount"><span' + financeAttr(progress.current_amount) + '>' + money(ctx, progress.current_amount, plan.currency) + '</span><small> / ' + (plan.target_amount == null ? h(tx(ctx, 'noTarget')) : money(ctx, plan.target_amount, plan.currency)) + '</small></span>' +
      '<span class="plan-card-progress mini-progress" data-page-chart="plan-card-' + a(plan.id) + '" data-page-chart-type="progress" data-page-chart-version="' + a(ratio) + '" role="progressbar" aria-label="' + a(plan.title) + '" aria-valuemin="0" aria-valuemax="100"' + (ratio == null ? ' aria-valuetext="' + a(tx(ctx, 'noTarget')) + '"' : ' aria-valuenow="' + Math.min(100, Math.max(0, Number(ratio))) + '"') + '><i class="finance-fill"' + financeAttr(progress.current_amount) + ' style="--plan-progress:' + Math.min(100, Math.max(0, Number(ratio || 0))) + '%"></i></span>' +
      '<span class="plan-card-bottom"><span>' + h(plan.end_date || tx(ctx, 'noDeadline')) + '</span><strong>' + (ratio == null ? '—' : Number(ratio).toFixed(0) + '%') + '</strong></span></button>';
  }).join('');
  return (list ? '<div class="plans-grid">' + list + '</div>' + (s.items.length < s.total ? button(ctx, 'loadMorePlans', 'morePlans', '', s.loading.list ? ' disabled' : '') : '') :
      '<div class="plans-empty"><h2>' + h(tx(ctx, s.loading.list ? 'loading' : s.errors.list ? 'loadFailed' : 'empty')) + '</h2>' +
      (!s.loading.list && !s.errors.list ? '<p>' + h(tx(ctx, 'emptyHint')) + '</p>' + button(ctx, 'create', 'create', '', blocked(s)) : '') + '</div>');
}
function chartMarkup(ctx, plan, forecast) {
  const s = state(ctx);
  return planForecastChart(plan, s.chart, forecast, { language: ctx.language, width: s.chartWidth || 600 });
}
function fundingRow(ctx, plan, number, disabled) {
  const s = state(ctx), account = s.accounts.find(row => row.account_number === number);
  const known = s.allocations?.id === plan.id && s.allocations.version === plan.version && !s.errors.allocations;
  const saved = known ? s.allocations.amounts[number] : null;
  const draft = s.allocationDraft?.id === plan.id && s.allocationDraft.version === plan.version && s.allocationDraft.account === number ? s.allocationDraft : null;
  const value = draft?.amount ?? saved, scale = allocationScale(plan, saved), actual = allocationScale(plan, value);
  const locked = disabled || (!scale || s.loading.allocations || s.loading.detail || s.loading.accounts || s.errors.accounts || !account || account.balance == null || account.account_type === 'credit' ? ' disabled' : '');
  return '<div class="plan-funding-row" data-plan-funding="' + number + '"><strong>' + h(accountName(s, number)) + '</strong>' +
    '<div class="plan-allocation-value"><span>' + h(tx(ctx, 'assigned')) + '</span><output data-allocation-money>' + money(ctx, value, plan.currency) + '</output></div>' +
    '<div class="plan-allocation-caption"><span>' + h(tx(ctx, 'targetShare')) + '</span><output data-allocation-percent>' + (actual ? actual.percent + '%' : '—') + '</output></div>' +
    '<input class="plan-allocation-slider" type="range" min="0" max="' + (scale?.max ?? 100) + '" step="0.01" value="' + (draft?.percent ?? scale?.percent ?? 0) +
    '" data-plan-allocation="' + number + '" aria-label="' + a(accountName(s, number) + ' · ' + tx(ctx, 'targetShare')) +
    '" aria-valuetext="' + a(actual ? actual.percent + '% · ' + planMoney(value, plan.currency, ctx.language) : tx(ctx, 'unknown')) + '" style="--allocation-fill:' + (scale ? (draft?.percent ?? scale.percent) / scale.max * 100 : 0) + '%"' + locked + '>' +
    '<div class="plan-allocation-actions button-row" data-allocation-actions' + (!draft || draft.amount === saved ? ' hidden' : '') + '>' + button(ctx, 'reviewAllocation', 'allocation', number, locked) + button(ctx, 'cancel', 'cancelAllocation', number, blocked(s)) + '</div>' +
    (plan.target_amount == null ? '<small>' + h(tx(ctx, 'allocationNoTarget')) + '</small>' : !known ? '<small>' + h(tx(ctx, s.loading.allocations ? 'loading' : 'allocationIncomplete')) + '</small>' : '') +
    '<small>' + h(tx(ctx, 'available')) + ': ' + money(ctx, account?.available_amount, plan.currency) + ' · ' + h(tx(ctx, 'allAllocated')) + ': ' + money(ctx, account?.allocated_amount, plan.currency) + '</small>' +
    (account?.over_allocated ? '<p class="plan-notice">' + h(tx(ctx, 'overAllocated')) + '</p>' : '') + '</div>';
}
function funding(ctx) {
  const s = state(ctx), plan = s.detail;
  if (!plan || plan.id !== s.selected || !visiblePlan(plan)) return '';
  const disabled = blocked(s), entryDisabled = disabled || (plan.status !== 'active' || plan.start_date > japanDay() ? ' disabled' : '');
  return '<header class="plan-section-heading"><h3>' + h(tx(ctx, 'accounts')) + '</h3>' + button(ctx, 'chooseAccounts', 'accounts', plan.id, disabled) + '</header>' +
    (plan.account_numbers.map(number => fundingRow(ctx, plan, number, entryDisabled)).join('') || '<p class="plan-muted">' + h(tx(ctx, 'noLinkedAccounts')) + '</p>');
}
// How far along: the share of the target as a bar under the two headline metrics, which stay as they are (running total
// and projected completion, without outlook captions).
function progressLine(ctx, plan, p) {
  if (p.progress_percent == null || plan.target_amount == null) return '';
  const ratio = Math.min(100, Math.max(0, Number(p.progress_percent)));
  return '<div class="plan-progress-line"><span class="plan-summary-bar mini-progress" data-page-chart="plan-summary-' + a(plan.id) + '" data-page-chart-type="progress" data-page-chart-version="' + a(ratio) +
    '" role="progressbar" aria-label="' + a(plan.title) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + ratio + '"><i class="finance-fill"' + financeAttr(p.current_amount) + ' style="--plan-progress:' + ratio + '%"></i></span>' +
    '<span class="plan-progress-caption"><strong>' + ratio.toFixed(0) + '%</strong> · ' + h(tx(ctx, 'targetOf').replace('{amount}', planMoney(plan.target_amount, plan.currency, ctx.language))) + '</span></div>';
}
function detail(ctx, fundingHtml = '') {
  const s = state(ctx), plan = s.detail;
  if (!plan || plan.id !== s.selected || !visiblePlan(plan)) return s.loading.detail ? '<p class="plan-muted" role="status">' + h(tx(ctx, 'loading')) + '</p>' : '';
  const p = plan.progress, forecast = s.chart?.forecast || plan.forecast, disabled = blocked(s), entryDisabled = disabled || (plan.status !== 'active' || plan.start_date > japanDay() ? ' disabled' : '');
  return '<article class="plan-report" data-plan-detail="' + a(plan.id) + '"><header class="plan-detail-heading"><h2>' + h(plan.title) + '</h2>' + button(ctx, 'edit', 'edit', plan.id, disabled) + '</header>' +
    (plan.profile_sync === 'pending' ? '<p class="plan-notice" role="status">' + h(tx(ctx, 'profilePending')) + '</p>' : '') +
    '<dl class="plan-metrics">' + fact(tx(ctx, 'accumulated'), money(ctx, p.current_amount, plan.currency)) +
    fact(tx(ctx, 'expected'), h(forecast?.projected_completion_date || tx(ctx, 'unknown'))) + '</dl>' + progressLine(ctx, plan, p) +
    '<div class="plan-progress-controls button-row">' + button(ctx, 'increaseProgress', 'increase', plan.id, entryDisabled) + button(ctx, 'decreaseProgress', 'decrease', plan.id, entryDisabled) + '</div>' +
    '<div class="plan-analysis"><section class="plan-trend"><header class="plan-section-heading"><h3>' + h(tx(ctx, 'progress')) + '</h3></header>' +
    (s.loading.chart && !s.chart ? '<p class="plan-muted">' + h(tx(ctx, 'loading')) + '</p>' : s.errors.chart ? '<p role="alert">' + h(tx(ctx, s.errors.chart)) + '</p>' : chartMarkup(ctx, plan, forecast)) +
    '</section>' +
    '<section class="plan-funding" data-plans-part="funding">' + fundingHtml + '</section></div>' +
    '<section class="plan-activity"><header class="plan-section-heading"><h3>' + h(tx(ctx, 'activity')) + '</h3></header>' +
    (s.entries.length ? '<div class="plan-activity-scroll"><table><thead><tr>' + ['date', 'entryKind', 'account', 'amount', 'note', 'operation'].map(key => '<th>' + h(tx(ctx, key)) + '</th>').join('') + '</tr></thead><tbody>' +
      s.entries.map(entry => '<tr><td>' + h(entry.date) + '</td><td>' + h(tx(ctx, entry.type)) + (entry.change_id ? '<small>' + h(tx(ctx, 'linked')) + ' #' + h(entry.change_id) + '</small>' : '') + '</td><td>' + h(entry.account_number == null ? tx(ctx, 'unassigned') : accountName(s, entry.account_number)) +
        '</td><td class="plan-numeric"' + financeAttr(entry.type === 'contribution' ? entry.amount : '-' + entry.amount) + '>' + (entry.type === 'contribution' ? '+' : '−') + money(ctx, entry.amount, plan.currency) + '</td><td>' + h(entry.note || '—') + '</td><td>' + button(ctx, 'undo', 'undo', entry.id, disabled) + '</td></tr>').join('') +
      '</tbody></table></div>' : '<p class="plan-muted">' + h(tx(ctx, s.loading.entries ? 'loading' : 'noActivity')) + '</p>') +
    (s.entries.length < s.entryTotal ? button(ctx, 'loadMore', 'more', '', s.loading.entries ? ' disabled' : '') : '') + '</section>' +
    (plan.status === 'paused' ? '<footer class="plan-manage">' + button(ctx, 'resume', 'restore', plan.id, disabled) + '</footer>' : '') + '</article>';
}
function fields(ctx, d) {
  const s = state(ctx), e = s.dialog, creating = e.type === 'create', reduction = d.type === 'spending_reduction';
  const choices = s.accounts.filter(row => PLAN_CURRENCIES.includes(apiCurrency(row.currency)) && row.balance != null && row.account_type !== 'credit');
  const types = e.original?.type === 'investment' && !creating
    ? '<div class="plan-form-full field"><span>' + h(tx(ctx, 'kind')) + '</span><strong>' + h(tx(ctx, 'legacyInvestment')) + '</strong></div>'
    : '<div class="plan-form-full plan-kind-choice" role="group" aria-label="' + a(tx(ctx, 'kind')) + '">' + ['saving', 'spending_reduction'].map(type =>
      '<button type="button" class="button" data-plan-action="kind" data-id="' + type + '" aria-pressed="' + (d.type === type) + '">' + h(tx(ctx, type)) + '</button>').join('') + '</div>';
  const accountField = creating ? '<label class="field"><span>' + h(tx(ctx, 'applicableAccount')) + '</span><select data-plan-field="funding_account"' + (s.loading.accounts ? ' disabled' : '') + '>' +
    option('', tx(ctx, 'noFundingAccount'), d.funding_account) + choices.map(row => option(row.account_number, row.name + ' · ' + displayCurrency(row.currency), d.funding_account)).join('') + '</select></label>' : '';
  return '<p class="plan-notice">' + h(tx(ctx, 'prepareCost')) + '</p><div class="plan-form-grid">' +
    types + (reduction ? '<p class="plan-notice plan-form-full" role="status">' + h(tx(ctx, 'reductionUnavailable')) + '</p>' : '') +
    '<label class="field plan-form-full"><span>' + h(tx(ctx, 'request')) + '</span><textarea data-plan-field="prompt" rows="3" maxlength="8000">' + h(d.prompt) + '</textarea></label>' +
    '<div class="plan-form-full">' + field(ctx, 'title', 'name', d.title, 'text', ' maxlength="120"') + '</div>' +
    accountField + '<div class="field plan-currency"><span>' + h(tx(ctx, 'currency')) + '</span><output data-plan-currency>' + h(displayCurrency(d.currency)) + '</output><small>' + h(tx(ctx, creating ? d.funding_account ? 'currencyFromAccount' : 'currencyFromSettings' : 'currencyUnchanged')) + '</small></div>' +
    amountField(ctx, 'target_amount', reduction ? 'reductionTarget' : 'target', d.target_amount, !reduction && d.noTarget ? ' disabled' : '') + amountField(ctx, 'contribution_amount', reduction ? 'monthlyReduction' : 'monthly', d.contribution_amount) +
    (!reduction ? '<label class="plan-switch plan-form-full"><input type="checkbox" data-plan-field="noTarget"' + (d.noTarget ? ' checked' : '') + '><span>' + h(tx(ctx, 'noTarget')) + '</span></label>' + amountField(ctx, 'opening_amount', 'opening', d.opening_amount) : '') +
    field(ctx, 'start_date', 'startDate', d.start_date, 'date') + field(ctx, 'end_date', 'deadlineOptional', d.end_date, 'date') +
    '<label class="field plan-form-full"><span>' + h(tx(ctx, 'descriptionPlain')) + '</span><textarea data-plan-field="description" rows="2" maxlength="2000">' + h(d.description) + '</textarea></label>' +
    (!reduction ? '<label class="plan-switch plan-form-full"><input type="checkbox" data-plan-field="spending_reduces_progress"' + (d.spending_reduces_progress ? ' checked' : '') + '><span>' + h(tx(ctx, 'spending')) + '</span></label>' +
    '<p class="plan-muted plan-form-full">' + h(tx(ctx, 'spendingHint')) + '</p><p class="plan-muted plan-form-full">' + h(tx(ctx, 'openingHint')) + '</p>' : '') + '</div>';
}
export function planQuestions(ctx) {
  const questions = state(ctx).dialog?.questions || [];
  return questions.length ? '<ul class="plan-questions">' + questions.map(question => '<li>' + h(typeof question === 'string' ? question : JSON.stringify(question)) + '</li>').join('') + '</ul>' : '';
}
function dialog(ctx) {
  const s = state(ctx), e = s.dialog;
  if (!e) return '';
  const d = e.draft, plan = s.detail || e.original;
  let body = '', title = tx(ctx, e.type);
  if (['create', 'edit'].includes(e.type)) {
    body = fields(ctx, d);
  } else if (e.type === 'accounts') {
    title = tx(ctx, 'chooseAccounts');
    const choices = s.accounts.filter(account => apiCurrency(account.currency) === apiCurrency(plan.currency));
    for (const number of e.accountNumbers) if (!choices.some(account => account.account_number === number)) choices.push({ account_number: number, name: '#' + number, currency: plan.currency, balance: null });
    body = '<p class="plan-notice">' + h(tx(ctx, 'accountsHint')) + '</p>' +
      (choices.map(account => '<label class="plan-account-choice"><input type="checkbox" data-plan-account="' + account.account_number + '"' + (e.accountNumbers.includes(account.account_number) ? ' checked' : '') + '><span><strong>' + h(account.name) + '</strong><small>' + h(tx(ctx, 'balance')) + ': ' + money(ctx, account.balance, plan.currency) + ' · ' + h(tx(ctx, 'available')) + ': ' + money(ctx, account.available_amount, plan.currency) + '</small>' + (account.over_allocated ? '<small>' + h(tx(ctx, 'overAllocated')) + '</small>' : '') + '</span></label>').join('') ||
      '<p class="plan-muted">' + h(tx(ctx, s.loading.accounts ? 'loading' : 'noAccountsLive')) + '</p>');
  } else if (e.type === 'progress') {
    title = tx(ctx, d.type === 'contribution' ? 'increaseProgress' : 'decreaseProgress');
    const sync = d.type === 'contribution' && d.sync_assets === true;
    body = '<p class="plan-notice">' + h(tx(ctx, sync ? 'syncIncomeNotice' : d.type === 'withdrawal' ? 'decreaseOnlyHint' : 'progressOnlyHint')) + '</p>' +
      (e.allocation ? '<p class="plan-allocation-summary">' + h(tx(ctx, 'assigned')) + ': ' + money(ctx, e.allocation.from, plan.currency) + ' → ' + money(ctx, e.allocation.amount, plan.currency) + '</p>' : '') +
      '<p class="plan-muted">' + h(plan.title) + ' · ' + h(displayCurrency(plan.currency)) + '</p><div class="plan-form-grid">' + amountField(ctx, 'amount', 'amount', d.amount, e.allocation ? ' readonly' : '') +
      '<label class="field"><span>' + h(tx(ctx, 'account')) + '</span><select data-plan-field="account_number"' + (e.allocation ? ' disabled' : '') + '>' + option('', tx(ctx, sync ? 'choose' : 'unassigned'), d.account_number) +
      plan.account_numbers.map(number => option(number, accountName(s, number), d.account_number)).join('') + '</select></label><div class="plan-form-full">' + field(ctx, 'note', 'note', d.note, 'text', ' maxlength="1000"') + '</div>' +
      // Whether a contribution also books account income is decided per entry, where it takes effect; the choice is
      // remembered as the next default for this plan.
      (d.type === 'contribution' ? '<label class="plan-switch plan-form-full"><input type="checkbox" data-plan-field="sync_assets"' + (sync ? ' checked' : '') + '><span>' + h(tx(ctx, 'syncAssets')) + '</span></label>' : '') + '</div>';
  }
  return '<form data-plan-form novalidate><header class="plan-dialog-heading"><h2 id="plan-dialog-title">' + h(title) + '</h2>' + button(ctx, 'cancel', 'close') + '</header>' +
    '<div data-plan-dialog-error role="alert" tabindex="-1"></div><div data-plan-questions role="status">' + planQuestions(ctx) + '</div><div data-plan-pending-message class="plan-notice" hidden>' + h(tx(ctx, 'uncertain')) + '</div><fieldset>' + body + '</fieldset><footer class="button-row">' +
    (e.type === 'edit' ? '<div class="plan-edit-actions">' + button(ctx, 'finish', 'finish', e.id, ' data-plan-manage-action' + blocked(s)) + button(ctx, 'remove', 'delete', e.id, ' data-plan-manage-action' + blocked(s)) + '</div>' : '') +
    button(ctx, 'keepIncome', 'keepIncome', '', ' hidden') + button(ctx, 'retrySame', 'retry', '', ' hidden') + '<button type="submit" class="button primary">' + h(tx(ctx, ['create', 'edit'].includes(e.type) ? 'done' : 'save')) + '</button></footer></form>';
}
export function plansParts(ctx) {
  const s = state(ctx), errors = [...new Set(Object.values(s.errors).filter(Boolean))];
  return {
    status: errors.map(error => '<p class="plan-notice" role="alert">' + h(tx(ctx, error)) + '</p>').join('') +
      (s.notice ? '<p role="status" class="plan-muted">' + h(tx(ctx, s.notice)) + '</p>' : '') +
      (s.pending ? '<div class="plan-notice">' + h(tx(ctx, s.pending.action === 'syncProgress' && s.pending.stage !== 'income' ? 'incomeSavedPending' : 'uncertain')) +
        (s.pending.action === 'syncProgress' ? '<p>' + money(ctx, s.pending.body.amount, s.pending.incomeBody.currency) + ' · ' + h(accountName(s, s.pending.body.account_number)) + '</p>' : '') +
        button(ctx, s.pending.stage === 'review' ? 'retryProgress' : 'retrySame', 'retry', '', s.busy ? ' disabled' : '') +
        (s.pending.stage === 'review' ? button(ctx, 'keepIncome', 'keepIncome', '', s.busy ? ' disabled' : '') : '') + '</div>' : ''),
    cards: cards(ctx), detail: detail(ctx), funding: funding(ctx), dialog: dialog(ctx),
  };
}
export function plansView(ctx, { pageHeader }) {
  const parts = plansParts(ctx);
  return '<section class="page goals-page plans-page" data-plans-root>' + pageHeader(ctx, '', 'goals', '', button(ctx, 'create', 'create')) +
    '<div data-plans-part="status">' + parts.status + '</div><div class="plans-layout">' +
    '<aside class="plans-list" aria-label="' + a(tx(ctx, 'all')) + '" data-plans-part="cards">' + parts.cards + '</aside>' +
    '<div class="plan-detail-pane" data-plans-part="detail">' + detail(ctx, parts.funding) + '</div></div>' +
    '<dialog class="plan-dialog" data-plan-dialog aria-labelledby="plan-dialog-title"><div data-plans-part="dialog">' + parts.dialog + '</div></dialog></section>';
}
