import { t } from './i18n.js';
import { normalizePrimaryCurrency } from './config.js';
import { contextRange, comparablePreviousRange, currencyName, dateInputValue, escapeHtml } from './utils.js';

// Accounts read by name. The number is added only when two saved accounts share a name; an account that no saved
// account describes reads as unlisted, with its number so it can still be told apart.
export function reportAccountLabel(ctx, value = ctx.state.settings.contextAccount) {
  if (!value || value === 'all') return t(ctx.language, 'allAccounts');
  const accounts = ctx.state.assets?.accounts || [];
  const account = accounts.find(item => String(item.account_number) === String(value));
  if (!account?.name) return t(ctx.language, 'unlistedAccount', { number: value });
  return accounts.some(item => item !== account && item.name === account.name) ? account.name + ' · #' + value : account.name;
}

export function comparisonLabels(ctx) {
  const month = ctx.state.settings.contextRange === 'month';
  return { current: t(ctx.language, month ? 'monthToDate' : 'currentPeriod'),
    previous: t(ctx.language, month ? 'lastMonthSamePeriod' : 'previousPeriod') };
}

export function reportScopeView(ctx, now = new Date()) {
  const range = contextRange(ctx.state.settings.contextRange, now);
  const previous = comparablePreviousRange(ctx.state.settings.contextRange, now);
  const dates = period => dateInputValue(period.start) + ' ~ ' + dateInputValue(period.end);
  return '<div class="report-scope" data-report-scope><span>' +
    escapeHtml(range.start ? dates(range) : t(ctx.language, 'allTime')) + '</span><span>' +
    escapeHtml(reportAccountLabel(ctx)) + '</span><span>' + escapeHtml(t(ctx.language, 'spendingCurrency')) +
    '</span>' + (ctx.state.route === 'overview' ? '<span data-asset-basis>' + escapeHtml(t(ctx.language, 'assetBasis', {
      currency: currencyName(normalizePrimaryCurrency(ctx.state.settings.contextCurrency)) })) + '</span>' : '') + (previous.start ? '<span class="report-comparison">' + escapeHtml(comparisonLabels(ctx).previous + ': ' + dates(previous)) + '</span>' : '') +
    '<button class="text-button" type="button" data-route-button="settings">' + escapeHtml(t(ctx.language, 'adjustScope')) + '</button></div>';
}
