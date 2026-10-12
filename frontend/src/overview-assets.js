import { t } from './i18n.js';
import { escapeHtml as e, formatAmount } from './utils.js';
import { assetNumber, overviewAssetQuery, assetHistoryPoint, assetHistoryChange, assetHistorySeries, assetHistoryScopeChanged } from './assets-model.js';
import { assetAxisOptions } from './assets-view.js';
import { financeAttr } from './finance-colors.js';
import { lineChart } from './charts.js';
import { createChartHover } from './agent-chart-hover.js';
import { pageChartMotion } from './page-chart-motion.js';

export function overviewAssetsData(state, now = new Date()) {
  const query = overviewAssetQuery(state, now), assets = state.assets || {};
  const overview = assets.overview?.primary_currency === query.primary_currency ? assets.overview : null;
  const history = assets.historyKey === JSON.stringify(query) ? assets.history : null;
  const account = query.account_number === undefined ? null
    : overview?.accounts.find(row => String(row.account_number) === query.account_number);
  const net = query.account_number === undefined
    ? overview?.complete === true ? assetNumber(overview.summary.net) : null
    : assetNumber(account?.converted_balance);
  const known = new Map((history?.items || []).map(row => [row.date, row]));
  const days = [];
  const date = new Date(query.start_date + 'T00:00:00Z');
  // Calendar holes remain null; neither missing snapshots nor future dates imply zero.
  while (date.toISOString().slice(0, 10) <= query.end_date) {
    const key = date.toISOString().slice(0, 10), row = known.get(key);
    days.push({ key, label: key, ...assetHistoryPoint(row, key) });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return { query, overview, history, days, net, change: assetHistoryChange(days),
    scope: query.account_number === undefined ? '' : account?.name || '#' + query.account_number,
    hasValues: days.some(day => day.value !== null || day.knownValue !== null) };
}

function regions(ctx, width, now) {
  const data = overviewAssetsData(ctx.state, now), assets = ctx.state.assets || {};
  const text = key => t(ctx.language, key);
  const amount = value => value === null ? '—' : formatAmount(value, data.query.primary_currency, ctx.language);
  const summary = '<dl class="overview-assets-metrics"><div><dt>' + e(text('overviewAssetNet')) +
    '</dt><dd><span data-overview-asset-net' + financeAttr(data.net) + '>' + e(amount(data.net)) + '</span>' +
    '<small class="overview-assets-change" data-overview-asset-change aria-label="' + e(text('overviewAssetChange')) + '"' +
    financeAttr(data.change) + '>' + e((data.change > 0 ? '+' : '') + amount(data.change)) + '</small></dd></div></dl>';
  const errors = [...new Set([assets.error, assets.historyError].filter(Boolean))];
  const notices = errors.length ? [text('assetLoadError') + ': ' + errors.join(' · ')] : [];
  const excluded = data.overview?.accounts.filter(account => account.included_in_assets === false) || [];
  if (excluded.length && data.query.account_number === undefined) notices.push(t(ctx.language, 'assetUncalibratedExcluded', { accounts: excluded.map(account => account.name).join(' · ') }));
  if ((data.overview && assets.cachedAt?.overview) || (data.history && assets.cachedAt?.history)) notices.push(text('assetCached'));
  if (data.overview?.fx?.status === 'stale') notices.push(text('assetFxStale'));
  if (data.days.some(day => day.knownValue !== null)) notices.push(text('assetHistoryPartial'));
  if (assetHistoryScopeChanged(data.days)) notices.push(text('assetHistoryScopeChanged'));
  if (data.hasValues && data.days.some(day => day.value === null && day.knownValue === null)) notices.push(text('assetHistoryMissing'));
  const status = notices.map(message => '<p class="overview-assets-notice" role="status">' + e(message) + '</p>').join('');
  const pending = !data.history && !assets.historyError;
  const hasPartial = data.days.some(day => day.knownValue !== null);
  const plot = data.hasValues ? lineChart(assetHistorySeries(data.days, hasPartial ? text('assetNet') : '', text('assetKnownSubtotal')), {
    ...assetAxisOptions(ctx, width), width, height: 332, language: ctx.language, gaps: true, includeZero: false,
    label: text('overviewAssetTrend') + ' · ' + data.query.primary_currency, motionKey: 'overview-assets', hoverDetails: true,
    axisLabelFormatter: label => label.slice(5).replace('-', '/'),
    valueFormatter: (value, point) => (point.partial ? text('assetKnownSubtotal') + ' · ' : '') + amount(value),
  }) : '<div class="overview-assets-empty" role="status">' + e(text(errors.length ? 'assetLoadError' :
    pending ? 'assetLoading' : data.overview?.accounts.length === 0 ? 'assetNoAccounts' : 'overviewAssetEmpty')) + '</div>';
  return { summary, status, plot, scope: e([data.query.start_date, data.query.end_date].join(' / ') + ' · ' +
    data.query.primary_currency + (data.scope ? ' · ' + data.scope : '')) };
}

export function overviewAssetsView(ctx, now = new Date()) {
  const slots = regions(ctx, 900, now);
  const slot = key => '<div data-overview-assets-region="' + key + '">' + slots[key] + '</div>';
  return '<section class="editorial-section overview-assets-section" data-overview-assets><header class="section-header">' +
    '<h2>' + e(t(ctx.language, 'overviewAssetTrend')) + '</h2>' + slot('summary') + '</header>' +
    '<p class="overview-assets-scope" data-overview-assets-region="scope">' + slots.scope + '</p>' + slot('status') +
    '<div class="overview-assets-plot" data-overview-assets-region="plot">' + slots.plot + '</div></section>';
}

let host, hover, observer, context;
const versions = new WeakMap();
export function patchOverviewAssets(ctx, root = globalThis.document, now = new Date()) {
  if (ctx.state.route !== 'overview') return false;
  context = ctx;
  const section = root?.querySelector('[data-overview-assets]');
  if (!section) return false;
  const width = Math.max(240, Math.round(section.querySelector('.overview-assets-plot').clientWidth || 900));
  const slots = regions(ctx, width, now);
  let changed = false;
  for (const node of section.querySelectorAll('[data-overview-assets-region]')) {
    const html = slots[node.dataset.overviewAssetsRegion];
    if (versions.get(node) === html) continue;
    hover?.clearWithin(node);
    node.innerHTML = html;
    versions.set(node, html);
    changed = true;
  }
  return changed;
}

export function mountOverviewAssets(ctx, root) {
  context = ctx;
  const next = ctx.state.route === 'overview' ? root?.querySelector('[data-overview-assets]') : null;
  if (host !== next) {
    observer?.disconnect(); hover?.dispose(); host = next;
    hover = host ? createChartHover(host) : null;
    observer = host ? new ResizeObserver(() => {
      if (host?.isConnected && patchOverviewAssets(context, root)) {
        pageChartMotion.sync(context.state.route, root.querySelector('#main-view') || root);
      }
    }) : null;
    if (host) observer.observe(host.querySelector('.overview-assets-plot'));
  }
  if (host) patchOverviewAssets(ctx, root);
}
