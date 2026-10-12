import { deltaBars, lineChart, axisNumberFormatter } from './charts.js';
import { localeFor, t } from './i18n.js';
import { dailyHeatmapData, dailyHeatmapView, heatmapText } from './daily-heatmap.js';
import { contextRange, dateInputValue, escapeAttr, escapeHtml, formatJpy, formatSignedJpy } from './utils.js';
import { createChartHover } from './agent-chart-hover.js';
import { createHeatmapNavigation } from './heatmap-navigation.js';
import { pageChartMotion } from './page-chart-motion.js';
import { overviewTrendDetails } from './overview-trend-details.js';
import { comparisonLabels } from './report-scope.js';

function chartContent(ctx, now) {
  return '<div class="overview-heatmap-content">' + dailyHeatmapView(ctx, now) + '</div>';
}

const trendTimeKey = (ctx, now) => dateInputValue(now) + (ctx.state.settings.contextRange === 'today' ?
  'T' + String(now.getHours()).padStart(2, '0') : '');

export function overviewChartView(ctx, now = new Date(), width = 600) {
  const motionKey = ctx.state.route === 'insights' ? 'insights-trend' : 'overview-trend';
  const allTime = ctx.state.settings.contextRange === 'all';
  const current = allTime
    ? dailyHeatmapData(ctx.currentDeals, contextRange('all', now), ctx.state.rates, now)
      .map(day => ({ key: day.key, label: day.key, value: day.amount }))
    : ctx.dailyCurrent;
  const key = trendTimeKey(ctx, now);
  const previous = allTime ? [] : ctx.dailyPrevious;
  let axisLabels;
  if (ctx.state.settings.contextRange === 'month') {
    const days = Math.max(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), ctx.dailyPrevious.length);
    const dayFormat = new Intl.DateTimeFormat(localeFor(ctx.language), { day: 'numeric' });
    // Use day-of-month labels: February and January can share day 31 without inventing February 31.
    axisLabels = Array.from({ length: days }, (_, index) => dayFormat.format(new Date(2000, 0, index + 1)));
  }
  return '<div class="overview-chart-content" data-overview-width="' + width + '" data-overview-now="' + escapeAttr(key) + '">' + lineChart([
    { name: t(ctx.language, ctx.state.settings.contextRange === 'month' ? 'thisMonth' : 'currentPeriod'), data: current },
    { name: t(ctx.language, ctx.state.settings.contextRange === 'month' ? 'lastMonth' : 'previousPeriod'), data: previous, muted: true },
  ], { language: ctx.language, label: ctx.summary.chartTitle || ctx.summary.title, width, height: 332, gaps: allTime, motionKey, axisLabels,
    maxAxisLabels: Math.max(2, Math.min(7, Math.floor((width - 74) / 60) + 1)),
    // Round steps with one unit per axis; quarter splits were rounded into labels that missed their grid lines.
    niceTicks: true, axisValueFormatter: (value, step, ticks) => axisNumberFormatter(ctx.language, ticks)(value),
    inspectColumns: allTime ? undefined : overviewTrendDetails(ctx, current, previous, axisLabels, now) }) + '</div>';
}

export function refreshOverviewTrend(ctx, root, now = new Date()) {
  const content = root?.querySelector('.overview-chart-content');
  if (!content) return false;
  const width = Math.max(240, Math.round(content.clientWidth || 600));
  if (content.dataset.overviewNow === trendTimeKey(ctx, now) && Number(content.dataset.overviewWidth || 600) === width) return false;
  const selector = '[data-page-chart="' + (ctx.state.route === 'insights' ? 'insights-trend' : 'overview-trend') + '"]';
  const frame = content.querySelector(selector);
  if (!frame) return false;
  const template = content.ownerDocument.createElement('template');
  template.innerHTML = overviewChartView(ctx, now, width);
  const next = template.content.querySelector(selector);
  // Keep the chart owner and page position when its calendar or column width changes.
  trendHover?.clearWithin(content);
  frame.replaceChildren(...next.childNodes);
  for (const name of ['data-page-chart-version', 'data-page-chart-domain']) frame.setAttribute(name, next.getAttribute(name));
  content.dataset.overviewNow = trendTimeKey(ctx, now);
  content.dataset.overviewWidth = String(width);
  return true;
}

export const overviewHeatmapView = (ctx) => '<section class="editorial-section heatmap-section"><header class="section-header"><div><h2>' +
  escapeHtml(heatmapText(ctx.language, 'title')) + '</h2></div></header><div data-overview-chart>' + chartContent(ctx) + '</div></section>';

export function overviewCategoryDriversView(ctx) {
  const label = key => t(ctx.language, key);
  const periods = comparisonLabels(ctx);
  const data = ctx.categoryComparison || [];
  const comparable = ctx.state.settings.contextRange !== 'all' && ctx.summary.previousCount > 0 && data.length > 0;
  const scope = [ctx.state.settings.contextRange, ctx.state.settings.contextAccount].join('|');
  const content = comparable
    ? '<div class="overview-driver-legend"><span>' + escapeHtml(label('spendingDecrease')) +
      '</span><span>' + escapeHtml(label('spendingIncrease')) + '</span></div>' +
      deltaBars(data, { language: ctx.language, limit: data.length, meaning: 'expense-change', motionKey: 'overview-categories',
        hoverDetails: true, valueFormatter: value => formatSignedJpy(value, ctx.language),
        hoverFormatter: item => periods.current + ': ' + formatJpy(item.current, ctx.language) + ' · ' +
          periods.previous + ': ' + formatJpy(item.previous, ctx.language) + ' · ' + formatSignedJpy(item.delta, ctx.language) })
    : '<div class="chart-empty">' + escapeHtml(label('noComparison')) + '</div>';
  return '<section class="editorial-section overview-category-drivers"><header class="section-header compact"><div><h2>' +
    escapeHtml(label('categoryDrivers')) + '</h2></div></header><p class="overview-driver-period">' +
    escapeHtml(periods.current + ' − ' + periods.previous + ' · JPY') +
    '</p><div data-overview-drivers data-driver-scope="' + escapeAttr(scope) + '">' + content + '</div></section>';
}

function createDriverScrollbar(root) {
  const win = root.ownerDocument.defaultView;
  let active, timer;
  function hide() {
    win.clearTimeout(timer);
    timer = null;
    active?.classList.remove('is-scrolling');
    active = null;
  }
  function onScroll(event) {
    const scroll = event.target;
    if (!scroll.matches?.('.delta-bars')) return;
    if (scroll.scrollHeight <= scroll.clientHeight) { hide(); return; }
    win.clearTimeout(timer);
    if (active !== scroll) active?.classList.remove('is-scrolling');
    active = scroll;
    active.classList.add('is-scrolling');
    timer = win.setTimeout(hide, 900);
  }
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return { dispose() { root.removeEventListener('scroll', onScroll, true); hide(); } };
}

let host, hover, navigation, drivers, driverHover, driverScrollbar, trendHost, trendObserver, trendContext, trendHover;
function onDayFocus(event) {
  const day = event.target.closest?.('[data-day]');
  if (!day || !host?.contains(day)) return;
  host.querySelectorAll('[data-day][tabindex="0"]').forEach((node) => { node.tabIndex = -1; });
  day.tabIndex = 0;
}
function onDayKey(event) {
  const day = event.target.closest?.('[data-day]');
  if (!day) return;
  const days = [...host.querySelectorAll('[data-day]')], index = days.indexOf(day);
  const weekday = (new Date(day.dataset.day + 'T00:00:00').getDay() + 6) % 7;
  const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: weekday > 0 ? -1 : 0, ArrowDown: weekday < 6 ? 1 : 0 }[event.key];
  let next = step === undefined ? undefined : Math.max(0, Math.min(days.length - 1, index + step));
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = days.length - 1;
  if (next === undefined) return;
  event.preventDefault(); days[next]?.focus();
}
function onDayPointer(event) {
  if (event.pointerType === 'touch') event.target.closest?.('[data-day]')?.focus({ preventScroll: true });
}
const events = { focusin: onDayFocus, keydown: onDayKey, pointerdown: onDayPointer };

export function captureOverviewChart(root) {
  const chart = root?.querySelector('[data-overview-chart]');
  const scroll = chart?.querySelector('.daily-heatmap-scroll');
  const focus = chart?.ownerDocument.activeElement;
  const driverChart = root?.querySelector('[data-overview-drivers]');
  return { scope: scroll?.dataset.heatmapScope, top: scroll?.scrollTop || 0, left: scroll?.scrollLeft || 0,
    driverScope: driverChart?.dataset.driverScope, driverTop: driverChart?.querySelector('.delta-bars')?.scrollTop || 0,
    day: chart?.contains(focus) ? focus.dataset.day : null };
}

export function mountOverviewChart(root, saved, ctx) {
  trendContext = ctx;
  const nextTrend = ctx ? root?.querySelector('.overview-chart-content') : null;
  if (trendHost !== nextTrend) {
    trendObserver?.disconnect();
    trendHover?.dispose();
    trendHost = nextTrend;
    trendHover = trendHost ? createChartHover(trendHost, { tooltipClass: 'overview-trend-tooltip', anchor: 'column' }) : null;
    trendObserver = trendHost ? new ResizeObserver(() => {
      if (trendHost?.isConnected && trendContext && refreshOverviewTrend(trendContext, root)) {
        pageChartMotion.sync(trendContext.state.route, root.querySelector('#main-view') || root);
      }
    }) : null;
    if (trendHost) trendObserver.observe(trendHost);
  }
  if (trendHost) refreshOverviewTrend(ctx, root);
  const nextDrivers = root?.querySelector('[data-overview-drivers]');
  if (drivers !== nextDrivers) {
    driverHover?.dispose();
    driverScrollbar?.dispose();
    drivers = nextDrivers; driverHover = drivers ? createChartHover(drivers) : null;
    driverScrollbar = drivers ? createDriverScrollbar(drivers) : null;
  }
  if (saved && drivers?.dataset.driverScope === saved.driverScope) {
    const scroll = drivers?.querySelector('.delta-bars');
    if (scroll) scroll.scrollTop = saved.driverTop || 0;
  }
  const next = root?.querySelector('[data-overview-chart]');
  if (host !== next) {
    navigation?.dispose();
    hover?.dispose();
    if (host) Object.entries(events).forEach(([name, callback]) => host.removeEventListener(name, callback));
    host = next; hover = host ? createChartHover(host) : null;
    navigation = host ? createHeatmapNavigation(host, node => hover?.clearWithin(node)) : null;
    if (host) Object.entries(events).forEach(([name, callback]) => host.addEventListener(name, callback));
  }
  if (!host || !saved) return;
  const scroll = host.querySelector('.daily-heatmap-scroll');
  const restoreScroll = () => {
    if (scroll && scroll.dataset.heatmapScope === saved.scope) { scroll.scrollTop = saved.top; scroll.scrollLeft = saved.left || 0; }
  };
  restoreScroll();
  const focus = [...host.querySelectorAll('[data-day]')].find((node) => node.dataset.day === saved.day);
  if (focus) {
    focus.focus({ preventScroll: true });
    restoreScroll();
  }
}

export function patchOverviewChart(ctx, root, now) {
  const chart = root?.querySelector('[data-overview-chart]');
  if (!chart) return;
  navigation?.cancel();
  const saved = captureOverviewChart(root);
  hover?.clearWithin(chart);
  chart.innerHTML = chartContent(ctx, now);
  mountOverviewChart(root, saved, ctx);
}

export function refreshOverviewCalendar(ctx, root, now = new Date()) {
  const calendar = root?.querySelector('[data-calendar-day]');
  if (!calendar || calendar.dataset.calendarDay === dateInputValue(now)) return false;
  patchOverviewChart(ctx, root, now);
  return true;
}
