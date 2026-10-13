import { t, localeFor } from './i18n.js';
import { financeAttr } from './finance-colors.js';
import { escapeHtml as e, escapeAttr as a, formatAmount, formatDateTime, formatPercent } from './utils.js';
import { lineChart } from './charts.js';
import { pageChartMotion } from './page-chart-motion.js';
import { ASSET_PERIODS, ACCOUNT_TYPES, assetCurrency, assetDisplayCurrency, assetNumber, assetsData, findAssetAccount, japanInputTime, incomeFormValues, assetHistorySeries, assetHistoryScopeChanged } from './assets-model.js';

const versions = new WeakMap();
let chartObserver;
const text = (ctx, key, vars) => t(ctx.language, key, vars);
const money = (ctx, value, code = assetDisplayCurrency(ctx.state)) => assetNumber(value) === null ? text(ctx, 'assetUnknown') : formatAmount(Number(value), code, ctx.language);
const currencyLabel = code => code === 'RMB' ? 'CNY' : code;
export function assetAxisOptions(ctx, width) {
  return { maxAxisLabels: Math.max(2, Math.min(7, Math.floor(((width || 760) - 74) / 60) + 1)),
    axisValueFormatter(value, step) {
      const unit = Math.abs(value) >= 1e6 ? 1e6 : Math.abs(value) >= 1e3 ? 1e3 : 1;
      const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step / unit))));
      const rounded = Number((value / unit).toFixed(digits));
      return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString(localeFor(ctx.language), { maximumFractionDigits: digits }) + (unit === 1e6 ? 'm' : unit === 1e3 ? 'k' : '');
    } };
}
const option = (value, label, current) => '<option value="' + a(value) + '"' + (String(value) === String(current) ? ' selected' : '') + '>' + e(label) + '</option>';
const button = (ctx, kind, key, id = '', primary = false) => '<button type="button" class="button compact' + (primary ? ' primary' : '') + '" data-assets-open="' + kind + '" data-id="' + a(id) + '">' + e(text(ctx, key)) + '</button>';
const note = (value, error = false) => value ? '<p class="asset-notice' + (error ? ' is-error' : '') + '"' + (error ? ' role="alert"' : '') + '>' + e(value) + '</p>' : '';
const field = (ctx, key, content) => '<label class="field"><span>' + e(text(ctx, key)) + '</span>' + content + '</label>';
const creditFacts = (ctx, account) => account?.account_type === 'credit' ? '<dl class="readonly-grid">' +
  [['assetCreditLimit', 'credit_limit'], ['assetOutstanding', 'outstanding_balance'], ['assetAvailableCredit', 'available_credit']].map(([key, name]) =>
    '<div><dt>' + e(text(ctx, key)) + '</dt><dd>' + e(money(ctx, account[name], account.currency)) + '</dd></div>').join('') + '</dl>' : '';
const input = (name, value = '', extra = '') => '<input name="' + name + '" value="' + a(value ?? '') + '" ' + extra + ' />';
export const accountOptions = (ctx, current, accounts = ctx.state.assets.accounts) => accounts.map((account) => option(account.account_number, '#' + account.account_number + ' ' + account.name + ' · ' + account.currency, current)).join('');

export function assetScopeSelect(ctx) {
  return '<select class="context-select" data-asset-account aria-label="' + a(text(ctx, 'assetAccountScope')) + '">' +
    option('all', text(ctx, 'assetAllAccounts'), ctx.state.assetPreview.account) + accountOptions(ctx, ctx.state.assetPreview.account) + '</select>';
}

function statusView(ctx, data) {
  const state = ctx.state.assets;
  const cached = Object.values(state.cachedAt || {}).some(Boolean);
  const unconverted = data.accounts.filter(account => assetNumber(account.balance) !== null &&
    account.currency !== data.currency && assetNumber(account.converted_balance) === null);
  const excluded = data.accounts.filter(account => account.included_in_assets === false);
  return '<span class="asset-preview-label">' + e(text(ctx, state.error ? 'assetLoadError' : !data.overview ? 'assetLoading' : cached ? 'assetCached' : 'assetConnected')) + '</span>' +
    (cached && state.error ? note(text(ctx, 'assetCached')) : '') +
    (data.overview?.as_of ? '<span>' + e(text(ctx, 'assetAsOf', { date: formatDateTime(data.overview.as_of, ctx.language) })) + '</span>' : '') +
    // ExchangeRate-API's free endpoint requires this exact attribution wherever its rates are shown.
    (String(data.overview?.fx?.source || '').includes('open.er-api.com') ? '<a class="asset-fx-credit" href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Rates By Exchange Rate API</a>' : '') +
    note(state.error, true) + (state.error ? '<button class="button compact" data-assets-refresh>' + e(text(ctx, 'assetRefresh')) + '</button>' : '') +
    (data.overview && !data.complete ? note(text(ctx, 'assetPartial')) : '') +
    (excluded.length ? note(text(ctx, 'assetUncalibratedExcluded', { accounts: excluded.map(account => account.name).join(' · ') })) : '') +
    (data.overview?.fx?.status === 'stale' ? note(text(ctx, 'assetFxStale') + ' · ' + (data.overview.fx.as_of || '')) : '') +
    (data.overview?.fx?.status === 'missing' && unconverted.length ?
      '<div class="asset-currency-notice">' + note(text(ctx, 'assetFxUnavailable', { currency: currencyLabel(data.currency) })) +
      [...new Set(unconverted.map(account => account.currency))]
        .filter(code => ['JPY', 'CNY'].includes(code)).map(code => '<button type="button" class="button compact" data-assets-display-currency="' + code + '">' +
          e(text(ctx, 'assetViewCurrency', { currency: currencyLabel(code) })) + '</button>').join('') + '</div>' : '') +
    (ctx.state.assetPreview.currency ? '<div class="asset-currency-notice">' + note(text(ctx, 'assetTemporaryCurrency', { currency: currencyLabel(data.currency) })) +
      '<button type="button" class="button compact" data-assets-display-currency="">' + e(text(ctx, 'assetRestoreCurrency', { currency: currencyLabel(assetCurrency(ctx.state.settings.contextCurrency)) })) + '</button></div>' : '');
}

function summaryView(ctx, data) {
  const value = assetNumber(data.summary.net);
  return '<div class="asset-net-worth"><span class="section-label">' + e(text(ctx, 'assetNet')) +
    '</span><div class="asset-net-value"><strong data-asset-net' + financeAttr(value) + '>' + e(value === null ? '—' : value.toLocaleString(localeFor(ctx.language), { maximumFractionDigits: data.currency === 'JPY' ? 0 : 2 })) +
    '</strong><span>' + currencyLabel(data.currency) + '</span></div>' +
    '<div class="asset-net-change"><span>' + e(text(ctx, 'assetChange')) + '</span><strong' + financeAttr(data.change) + '>' + e(data.change === null ? '—' : (data.change > 0 ? '+' : '') + money(ctx, data.change)) + '</strong></div>' +
    (!data.complete && data.overview && ctx.state.assetPreview.account === 'all' && data.accounts.some(account => assetNumber(account.converted_balance) !== null) ? '<p class="asset-known-subtotal">' + e(text(ctx, 'assetKnownSubtotal')) + ': <span' + financeAttr(data.overview.known_subtotal?.net) + '>' + e(money(ctx, data.overview.known_subtotal?.net)) + '</span></p>' : '') +
    '</div>' +
    '<dl class="asset-summary-facts">' + [['assetTotal', 'assets'], ['assetDebt', 'liabilities']].map(([label, key]) =>
      '<div><dt>' + e(text(ctx, label)) + '</dt><dd data-asset-metric="' + key + '"' + financeAttr(data.summary[key], key === 'liabilities' ? 'liability' : 'balance') + '>' + e(money(ctx, data.summary[key])) + '</dd></div>').join('') +
    '</dl>';
}

function trendView(ctx, data, width) {
  const history = data.history;
  const error = ctx.state.assets.historyError;
  const partial = history.some(point => point.knownValue !== null);
  const chart = history.some(point => point.value !== null || point.knownValue !== null) && data.accounts.length
    ? '<div class="asset-chart-meta"><span>' + e(history[0].date + ' / ' + history.at(-1).date) + '</span><span>' + e(data.currency) + '</span></div><div class="asset-trend-plot">' +
      lineChart(assetHistorySeries(history.map(point => ({ ...point, label: point.date.slice(5) })), text(ctx, 'assetNet'), text(ctx, 'assetKnownSubtotal')),
        { ...assetAxisOptions(ctx, width), language: ctx.language, height: 250, width, gaps: true, includeZero: false, label: text(ctx, 'assetTrend'), motionKey: 'assets-trend',
          valueFormatter: (value, point) => point.date + ' · ' + (point.partial ? text(ctx, 'assetKnownSubtotal') + ' · ' : '') + money(ctx, value) }) + '</div>'
    : '<div class="asset-empty-trend"><span>—</span><p>' + e(text(ctx, ctx.state.assets.historyLoading || !ctx.state.assets.history && !error ? 'assetLoading' : 'assetHistoryEmpty')) + '</p></div>';
  return note(error, true) + chart + (partial ? note(text(ctx, 'assetHistoryPartial')) : '') +
    (assetHistoryScopeChanged(history) ? note(text(ctx, 'assetHistoryScopeChanged')) : '') +
    (history.some(point => point.value === null && point.knownValue === null) ? note(text(ctx, 'assetHistoryMissing')) : '') +
    '<div class="asset-trend-footer">' + (history.length && data.accounts.length ? button(ctx, 'history', 'assetHistoryOpen') : '') + '</div>';
}

function accountRows(ctx, data) {
  if (!data.visibleAccounts.length) return '<tr><td colspan="5"><div class="asset-no-matches"><p>' +
    e(text(ctx, !ctx.state.assets.accountsLoaded && !data.overview ? ctx.state.assets.error ? 'assetLoadError' : 'assetLoading' : data.accounts.length ? 'assetNoMatches' : 'assetNoAccounts')) + '</p>' +
    (data.accounts.length ? '<button class="button compact" data-asset-clear>' + e(text(ctx, 'assetClearSearch')) + '</button>' : ctx.state.assets.accountsLoaded ? button(ctx, 'account', 'assetAddAccount', '', true) : '') + '</div></td></tr>';
  return data.visibleAccounts.map((account) => '<tr data-asset-row="' + account.account_number + '"><td><button type="button" class="asset-account-link" data-assets-open="detail" data-id="' + account.account_number + '">' +
    '<span class="asset-account-mark">' + e(account.currency) + '</span><span><strong>' + e(account.name) + '</strong><small>#' + account.account_number + ' · ' + e(account.institution) + '</small>' +
    (account.balance === null ? '<small class="is-warning">' + e(text(ctx, 'assetNeedsOpening')) + '</small>' : '') + '</span></button></td>' +
    '<td>' + e(text(ctx, 'assetType_' + account.account_type)) + '</td><td class="numeric"' + financeAttr(account.balance) + '>' + e(money(ctx, account.balance, account.currency)) + '</td>' +
    '<td class="numeric asset-account-total"' + financeAttr(account.converted_balance) + '>' + e(money(ctx, account.converted_balance)) +
    (assetNumber(account.converted_balance) === null && assetNumber(account.balance) !== null ? '<small class="asset-original-fallback">' + e(text(ctx, 'assetOriginalBalance')) +
      '<strong' + financeAttr(account.balance) + '>' + e(money(ctx, account.balance, account.currency)) + '</strong></small>' : '') +
    '</td><td>' + button(ctx, 'detail', 'assetDetails', account.account_number) + '</td></tr>').join('');
}

function allocationView(ctx, data) {
  if (!data.allocation.length) return '<p class="asset-empty-compact">' + e(text(ctx, data.overview && !data.complete ? 'assetAllocationUnknown' : 'assetNoAllocation')) + '</p>';
  return (data.complete ? '' : note(text(ctx, data.allocation.some(account => account.percent !== null) ? 'assetAllocationPartial' : 'assetAllocationUnknown'))) + '<div class="asset-allocation-list" data-page-chart="assets-allocation" data-page-chart-type="allocation" data-page-chart-version="' + a(JSON.stringify([data.currency, data.allocation.map(account => [account.account_number, account.name, account.value])])) + '">' + data.allocation.map(account =>
    '<div class="asset-allocation-item" data-asset-allocation-account="' + a(account.account_number) + '"><div><span class="asset-allocation-name" title="' + a(account.name + ' · #' + account.account_number) + '">' + e(account.name) + '</span><strong title="' + a(text(ctx, 'assetAllocationShare')) + '">' + e(account.percent === null ? '—' : formatPercent(account.percent, ctx.language)) +
    '</strong></div><div class="asset-allocation-track" aria-hidden="true"><i class="finance-fill"' + financeAttr(account.value) + ' style="width:' + (account.percent ?? 0).toFixed(3) + '%"></i></div><span class="asset-allocation-value"' + financeAttr(account.value) + '>' +
    e(money(ctx, account.value)) + '</span></div>').join('') + '</div>';
}

function regions(ctx, width) {
  const data = assetsData(ctx.state);
  return { status: statusView(ctx, data), summary: summaryView(ctx, data), trend: trendView(ctx, data, width),
    rows: accountRows(ctx, data), allocation: allocationView(ctx, data),
    matches: e(text(ctx, 'assetMatches', { count: data.visibleAccounts.length, amount: money(ctx, data.matchingTotal) })) };
}

export function assetsView(ctx, { pageHeader, icon }) {
  const slots = regions(ctx), filters = ctx.state.assetPreview;
  const region = (key) => '<div data-asset-region="' + key + '">' + slots[key] + '</div>';
  return '<section class="page assets-page">' + pageHeader(ctx, 'assetKicker', 'assetTitle', '',
    button(ctx, 'income', 'assetAddIncome') + button(ctx, 'account', 'assetAddAccount', '', true)) +
    '<div class="asset-page-meta">' + region('status') + '<div class="asset-local-scope">' + assetScopeSelect(ctx) + '</div></div>' +
    '<section class="asset-balance-summary" data-asset-region="summary">' + slots.summary + '</section>' +
    '<section class="editorial-section asset-trend-section"><header class="section-header"><h2>' + e(text(ctx, 'assetTrend')) +
    '</h2><div class="segmented-control asset-periods">' + ASSET_PERIODS.map((period) => '<button data-asset-period="' + period + '" class="' +
      (period === filters.period ? 'is-active' : '') + '">' + e(text(ctx, { '1m': 'assetPeriod1m', '3m': 'assetPeriod3m', '6m': 'assetPeriod6m', '1y': 'assetPeriod1y' }[period])) +
      '</button>').join('') + '</div></header>' + region('trend') + '</section>' +
    '<div class="asset-inspect-layout"><section class="editorial-section asset-accounts-section"><header class="section-header"><h2>' + e(text(ctx, 'assetAccountsTitle')) +
    '</h2></header><div class="asset-account-controls"><label class="asset-search">' + icon('search') + '<input type="search" data-asset-query value="' + a(filters.query) +
    '" placeholder="' + a(text(ctx, 'assetSearch')) + '" aria-label="' + a(text(ctx, 'assetSearch')) + '" /></label><select data-asset-sort aria-label="' + a(text(ctx, 'assetSortLabel')) + '">' +
    [['value-desc', 'assetSortDesc'], ['value-asc', 'assetSortAsc'], ['name', 'assetSortName']].map(([value, label]) => option(value, text(ctx, label), filters.sort)).join('') +
    '</select></div><div class="asset-kind-tabs">' + ['all', ...ACCOUNT_TYPES, 'liability'].map((kind) => '<button class="text-button' + (kind === filters.kind ? ' is-active' : '') +
      '" data-asset-kind="' + kind + '">' + e(text(ctx, kind === 'all' ? 'assetKindAll' : kind === 'liability' ? 'assetKindLiability' : 'assetType_' + kind)) + '</button>').join('') +
    '</div><div class="table-scroll"><table class="asset-account-table"><thead><tr>' + ['account', 'assetAccountType', 'assetOriginalBalance', 'assetConvertedValue', 'actions'].map((key) =>
      '<th' + (key === 'assetConvertedValue' ? ' data-asset-currency-heading' : '') + '>' + e(text(ctx, key, { currency: currencyLabel(assetDisplayCurrency(ctx.state)) })) + '</th>').join('') + '</tr></thead><tbody data-asset-region="rows">' + slots.rows +
    '</tbody></table></div><div class="asset-account-matches" data-asset-region="matches">' + slots.matches + '</div></section><aside class="editorial-section asset-allocation-section"><header class="section-header"><h2>' +
    e(text(ctx, 'assetAllocation')) + '</h2></header>' + region('allocation') + '</aside></div>' +
    '<section class="asset-market-band"><div data-market-slot></div></section></section>';
}

export function primeAssetsView(ctx) {
  chartObserver?.disconnect();
  const root = ctx.state.route === 'assets' && document.querySelector('.assets-page');
  if (!root) return;
  patchAssetsView(ctx);
  chartObserver = new ResizeObserver(() => patchAssetsView(ctx));
  chartObserver.observe(root);
}

export function patchAssetsView(ctx) {
  const root = document.querySelector('.assets-page');
  if (ctx.state.route !== 'assets' || !root) return false;
  const slots = regions(ctx, Math.round(root.querySelector('.asset-trend-section')?.clientWidth || root.clientWidth));
  for (const node of root.querySelectorAll('[data-asset-region]')) {
    const html = slots[node.dataset.assetRegion];
    if (versions.get(node) === html) continue;
    node.innerHTML = html;
    versions.set(node, html);
  }
  for (const select of document.querySelectorAll('[data-asset-account]')) {
    const html = option('all', text(ctx, 'assetAllAccounts'), ctx.state.assetPreview.account) + accountOptions(ctx, ctx.state.assetPreview.account);
    if (versions.get(select) !== html) { select.innerHTML = html; versions.set(select, html); }
  }
  for (const node of root.querySelectorAll('[data-asset-period], [data-asset-kind]')) {
    const active = node.hasAttribute('data-asset-period') ? node.dataset.assetPeriod === ctx.state.assetPreview.period :
      node.dataset.assetKind === ctx.state.assetPreview.kind;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-pressed', String(active));
  }
  const heading = root.querySelector('[data-asset-currency-heading]');
  if (heading) heading.textContent = text(ctx, 'assetConvertedValue', { currency: currencyLabel(assetDisplayCurrency(ctx.state)) });
  for (const node of root.querySelectorAll('[data-asset-query], [data-asset-sort]')) {
    const value = node.hasAttribute('data-asset-query') ? ctx.state.assetPreview.query : ctx.state.assetPreview.sort;
    if (node !== document.activeElement && node.value !== value) node.value = value;
  }
  pageChartMotion.sync(ctx.state.route, root);
  return true;
}

function changesView(ctx, data) {
  const rows = data.items || [];
  return note(data.error, true) + '<div class="asset-change-list">' + (rows.map((row) => '<article class="asset-change-row"><div><strong>' +
    e(text(ctx, 'assetChange_' + row.change_type)) + '</strong><span>' + e(formatDateTime(row.effective_at, ctx.language)) + '</span></div><b' + financeAttr(row.change_type === 'opening' ? row.confirmed_balance : row.amount) + '>' +
    e(row.change_type === 'opening' ? money(ctx, row.confirmed_balance, row.currency) : money(ctx, row.amount, row.currency)) +
    '</b><p>' + e(row.note || '') + (row.dealing_number ? ' <button class="text-button" data-assets-deal="' + row.dealing_number + '">#' + row.dealing_number + '</button>' : '') +
    '</p></article>').join('') || note(text(ctx, data.loading ? 'loading' : 'assetRecordsEmpty'))) + '</div>' +
    (data.has_more || data.error ? '<button class="button compact" data-assets-changes-more' + (data.loading ? ' disabled' : '') + '>' + e(text(ctx, data.error ? 'retry' : 'assetMore')) + '</button>' : '');
}

export function assetModalContent(ctx, { modalHeader }) {
  const modal = ctx.state.modal, data = modal.data || {}, kind = modal.type.slice(6);
  const account = findAssetAccount(ctx.state, data.account_number || data.id);
  const heading = (title, body = '') => modalHeader(ctx, text(ctx, 'assets'), title, body);
  if (kind === 'income-detail') {
    const original = incomeFormValues(data);
    return heading(text(ctx, 'assetIncome') + ' #' + data.income_id) + '<dl class="readonly-grid">' + [
      ['assetIncomeSource', original.source_name || '—'], ['account', account?.name || '#' + data.account_number],
      ['assetIncomeAmount', money(ctx, original.amount, original.currency)], ['assetSettled', money(ctx, data.amount, data.currency)],
      ['assetEffective', formatDateTime(data.effective_at, ctx.language)], ['assetNote', data.note || '—'],
    ].map(([key, value]) => '<div><dt>' + e(text(ctx, key)) + '</dt><dd>' + e(value) + '</dd></div>').join('') +
      '</dl><div class="button-row">' + button(ctx, 'income', 'edit', data.income_id) + '<button class="button danger-quiet" data-assets-revoke="' + a(data.income_id) + '">' + e(text(ctx, 'assetRevoke')) + '</button></div>';
  }
  if (kind === 'detail') return heading(account?.name || '#' + data.id, account?.institution || '') +
    '<div class="asset-detail-balance"><span>' + e(text(ctx, 'assetOriginalBalance')) + '</span><strong' + financeAttr(account?.balance) + '>' + e(money(ctx, account?.balance, account?.currency)) + '</strong></div>' +
    creditFacts(ctx, account) +
    '<div class="button-row">' + button(ctx, 'account', 'assetEditAccount', data.id) + button(ctx, 'calibrate', 'assetCalibrate', data.id) + button(ctx, 'income', 'assetAddIncome') + '</div>' +
    '<h3>' + e(text(ctx, 'assetChanges')) + '</h3>' + note(text(ctx, 'assetChangesAudit')) +
    '<form data-assets-changes-filter class="asset-record-filters">' + field(ctx, 'startDate', input('start', data.start, 'type="date"')) +
    field(ctx, 'endDate', input('end', data.end, 'type="date"')) + '<button class="button">' + e(text(ctx, 'assetFilterApply')) + '</button></form>' +
    '<div data-assets-changes>' + changesView(ctx, data) + '</div>';
  if (kind === 'history') {
    const history = ctx.state.assets.history;
    return heading(text(ctx, 'assetHistory'), text(ctx, 'assetHistoryBasis')) + '<div class="asset-history-tables">' +
      (history?.accounts || []).map((row) => '<section><h3>' + e(findAssetAccount(ctx.state, row.account_number)?.name || '#' + row.account_number) + ' · ' + e(row.currency) +
      '</h3><div class="asset-valuation-history">' + [...row.items].reverse().map((day) => '<div><time>' + day.date + '</time><strong' + financeAttr(day.closing_balance) + '>' +
        e(money(ctx, day.closing_balance, row.currency)) + '</strong><span' + financeAttr(day.converted_balance) + '>' + e(money(ctx, day.converted_balance)) + '</span></div>').join('') + '</div></section>').join('') + '</div>';
  }
  const title = { account: account ? 'assetEditAccount' : 'assetAddAccount', calibrate: 'assetCalibrate', income: data.income_id ? 'edit' : 'assetAddIncome' }[kind];
  let fields = '', hint = '';
  if (kind === 'account') {
    hint = text(ctx, account ? 'assetCurrencyHint' : 'assetCreateHint');
    fields = field(ctx, 'assetAccountName', input('name', account?.name, 'required maxlength="100" autofocus')) +
      field(ctx, 'assetInstitution', input('institution', account?.institution, 'maxlength="100"')) +
      field(ctx, 'assetAccountType', '<select name="account_type">' + ACCOUNT_TYPES.map((type) => option(type, text(ctx, 'assetType_' + type), account?.account_type || 'bank')).join('') + '</select>');
    fields += '<label class="field" data-asset-credit-field' + (account?.account_type === 'credit' ? '' : ' hidden') + '><span>' + e(text(ctx, 'assetCreditLimit')) +
      '</span>' + input('credit_limit', account?.credit_limit, 'inputmode="decimal"') + '</label>';
    if (!account) fields += field(ctx, 'assetAccountNumber', input('account_number', '', 'type="number" min="1" step="1" placeholder="' + a(text(ctx, 'assetAutoNumber')) + '"')) +
      field(ctx, 'assetCurrency', '<select name="currency">' + ['JPY', 'CNY'].map((code) => option(code, code, assetCurrency(ctx.state.settings.contextCurrency))).join('') + '</select>') +
      '<label class="field"><span data-asset-balance-label>' + e(text(ctx, 'assetOpening')) + '</span><span data-asset-debt-label hidden>' + e(text(ctx, 'assetOpeningDebt')) + '</span>' +
        input('opening_balance', '', 'inputmode="decimal" placeholder="' + a(text(ctx, 'assetOptionalOpening')) + '"') + '</label>' + field(ctx, 'assetEffective', input('effective_at', japanInputTime(), 'type="datetime-local" step="1" required'));
  } else if (kind === 'calibrate') {
    // A credit account is reconciled by what is owed (a positive amount), not by its negative balance.
    const credit = account?.account_type === 'credit';
    hint = text(ctx, credit ? 'assetCalibrationDebtHint' : 'assetCalibrationHint');
    fields = '<p class="full">' + e(account?.name || '') + ' · ' + e(account?.currency || '') + '</p>' +
      field(ctx, credit ? 'assetConfirmedDebt' : 'assetConfirmed', input('confirmed_balance', credit ? account?.outstanding_balance ?? '' : '', 'inputmode="decimal" required autofocus')) +
      field(ctx, 'assetEffective', input('effective_at', japanInputTime(), 'type="datetime-local" step="1" required')) +
      field(ctx, 'assetNote', input('note', '', 'maxlength="1000"'));
  } else if (kind === 'income') {
    const original = incomeFormValues(data);
    const selected = data.account_number || (ctx.state.assetPreview.account !== 'all' ? ctx.state.assetPreview.account : ctx.state.assets.accounts[0]?.account_number);
    const selectedAccount = findAssetAccount(ctx.state, selected);
    fields = field(ctx, 'account', '<select name="account_number" required>' + accountOptions(ctx, selected) + '</select>') +
      field(ctx, 'assetIncomeSource', input('source_name', original.source_name, 'maxlength="300"')) +
      field(ctx, 'assetIncomeAmount', input('amount', original.amount, 'inputmode="decimal" required')) +
      field(ctx, 'assetCurrency', '<select name="currency">' + ['JPY', 'CNY'].map((code) => option(code, code, original.currency || selectedAccount?.currency || 'JPY')).join('') + '</select>') +
      field(ctx, 'assetSettled', input('settled_amount', original.settled_amount, 'inputmode="decimal"')) +
      field(ctx, 'assetEffective', input('effective_at', japanInputTime(data.effective_at || new Date()), 'type="datetime-local" step="1" required')) +
      field(ctx, 'assetNote', input('note', data.note, 'maxlength="1000"'));
    hint = text(ctx, 'assetSettlementHint') + (original.needsVerification ? ' ' + text(ctx, 'assetIncomeVerify') : '');
  }
  return heading(text(ctx, title), hint) + '<form class="modal-form" data-assets-form="' + kind + '">' + fields +
    '<p class="asset-form-error full" role="alert" data-assets-form-error></p><footer><button type="button" class="button" data-close-modal>' + e(text(ctx, 'cancel')) +
    '</button><button class="button primary" type="submit"' + (kind === 'income' && !ctx.state.assets.accounts.length ? ' disabled' : '') + '>' +
    e(text(ctx, 'save')) + '</button></footer></form>';
}

export function patchAssetChanges(ctx) {
  const node = document.querySelector('[data-assets-changes]');
  if (node && ctx.state.modal?.type === 'asset-detail') node.innerHTML = changesView(ctx, ctx.state.modal.data);
}
