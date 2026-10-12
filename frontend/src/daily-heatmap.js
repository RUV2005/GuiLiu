import { localeFor } from './i18n.js';
import { amountToJpy, dateInputValue, dealInRange, endOfDay, escapeAttr, escapeHtml,
  exchangeRateToJpy, startOfDay, toDate } from './utils.js';

const copy = {
  zh: { count: '交易笔数', title: '账单数量分布', orders: '笔交易', empty: '没有可显示的日期', future: '尚未到来' },
  ja: { count: '取引件数', title: '取引件数の分布', orders: '件', empty: '表示できる日付がありません', future: 'まだ到来していません' },
  en: { count: 'Transaction count', title: 'Transaction count distribution', orders: 'transactions', empty: 'No dates to display', future: 'Upcoming date' },
};
export const heatmapText = (language, key) => (copy[language] || copy.en)[key];

// Calendar days, not fixed 24-hour intervals, keep DST and local dates aligned.
export function dailyHeatmapData(deals, range, rates, now = new Date()) {
  const end = startOfDay(range?.end || now);
  if (!end) return [];
  const buckets = new Map();
  let earliest = null;
  for (const deal of deals || []) {
    const date = toDate(deal.ISOtime);
    if (!date || !dealInRange(deal, range || { end })) continue;
    const key = dateInputValue(date);
    if (!earliest || date < earliest) earliest = date;
    const day = buckets.get(key) || { key, amount: 0, count: 0, unavailable: false };
    day.count++;
    const raw = deal.price;
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)) ||
        exchangeRateToJpy(deal.CurrencyTypeNumber, rates) === null) day.unavailable = true;
    else {
      const total = day.amount + amountToJpy(raw, deal.CurrencyTypeNumber, rates);
      if (Number.isFinite(total)) day.amount = total;
      else day.unavailable = true;
    }
    buckets.set(key, day);
  }
  const start = startOfDay(range?.start || earliest || new Date(end.getFullYear(), end.getMonth(), 1));
  if (!start || start > end) return [];
  const result = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = dateInputValue(cursor);
    const day = buckets.get(key) || { key, amount: 0, count: 0, unavailable: false };
    result.push({ ...day, amount: day.unavailable ? null : day.amount });
  }
  return result;
}

export function rollingHeatmapRange(now = new Date()) {
  return {
    start: new Date(now.getFullYear(), now.getMonth() - 11, 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
  };
}

export function rollingHeatmapData(deals, account = 'all', now = new Date()) {
  const today = dateInputValue(now);
  const observed = { end: endOfDay(now) };
  const rows = (deals || []).filter(deal => dealInRange(deal, observed) &&
    (account === 'all' || String(deal.AccountNumber) === String(account)));
  // Reserve the rest of this month without presenting future days as zero activity.
  return dailyHeatmapData(rows, rollingHeatmapRange(now), undefined, now)
    .map(day => day.key > today ? { ...day, count: null, amount: null, future: true } : { ...day, future: false });
}

export function heatmapLevel(value, max) {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value === 0 || max === 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil(Math.abs(value) / max * 5)));
}

export function weeklyHeatmapBands(days) {
  if (!days.length) return [];
  const offset = (new Date(days[0].key + 'T00:00:00').getDay() + 6) % 7;
  return [{ offset, weeks: Math.ceil((offset + days.length) / 7), entries: days }];
}

export function monthlyHeatmapBands(days) {
  const months = new Map();
  for (const day of days) {
    const month = day.key.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(day);
  }
  return [...months].map(([month, entries]) => ({ month, ...weeklyHeatmapBands(entries)[0] }));
}

export function dailyHeatmapView(ctx, now = new Date()) {
  const language = ctx.language, label = (key) => heatmapText(language, key);
  const days = rollingHeatmapData(ctx.state.deals, ctx.state.settings.contextAccount, now);
  if (!days.length) return '<div class="chart-empty">' + escapeHtml(label('empty')) + '</div>';
  const max = days.reduce((largest, day) => Math.max(largest, day.count), 0);
  const bands = monthlyHeatmapBands(days);
  const number = (value) => value.toLocaleString(localeFor(language));
  const valueText = (day) => day.future ? label('future') : number(day.count) + ' ' + label('orders');
  const monthFormat = new Intl.DateTimeFormat(localeFor(language), { month: 'short' });
  const periodFormat = new Intl.DateTimeFormat(localeFor(language), { year: 'numeric', month: 'short' });
  const dayFormat = new Intl.DateTimeFormat(localeFor(language), { year: 'numeric', month: 'short', day: '2-digit', weekday: 'long' });
  const version = JSON.stringify(['count', days.map((day) => [day.key, day.count])]);
  const scope = [days[0].key, days.at(-1).key, ctx.state.settings.contextAccount].join('|');
  const period = periodFormat.format(new Date(days[0].key + 'T00:00:00')) + ' - ' +
    periodFormat.format(new Date(days.at(-1).key + 'T00:00:00'));
  const months = bands.map(({ month, weeks }) => '<span style="--heatmap-weeks:' + weeks + '">' +
    escapeHtml(monthFormat.format(new Date(month + '-01T00:00:00'))) + '</span>').join('');
  const totalWeeks = bands.reduce((sum, band) => sum + band.weeks, 0);
  let weekIndex = 0;
  let first = true;
  const grids = bands.map(({ month, offset, weeks, entries }) => {
    const cells = Array.from({ length: weeks * 7 }, (_, index) => {
      const day = entries[index - offset];
      if (!day) return '<span class="daily-heatmap-outside" aria-hidden="true"></span>';
      const tab = first ? 0 : -1; first = false;
      const text = valueText(day), title = dayFormat.format(new Date(day.key + 'T00:00:00'));
      return '<span class="daily-heatmap-day" data-day="' + day.key + '" data-level="' + (day.future ? 'future' : heatmapLevel(day.count, max)) + '"' +
        ' data-agent-chart-tip data-tip-label="' + escapeAttr(title) + '" data-tip-value="' + escapeAttr(text) +
        '" tabindex="' + tab + '" role="img" aria-label="' + escapeAttr(title + ': ' + text) + '"></span>';
    });
    const columns = Array.from({ length: weeks }, (_, column) =>
      '<div class="daily-heatmap-week" data-heatmap-position="' + weekIndex++ / Math.max(1, totalWeeks - 1) + '">' +
      cells.slice(column * 7, column * 7 + 7).join('') + '</div>').join('');
    return '<div class="daily-heatmap-month" data-month="' + month + '" style="--heatmap-weeks:' + weeks + '">' + columns + '</div>';
  }).join('');
  const calendar = '<section class="daily-heatmap-band">' +
    '<div class="daily-heatmap-calendar"><div class="daily-heatmap-months" aria-hidden="true">' + months + '</div>' +
    '<div class="daily-heatmap-days">' + grids + '</div></div></section>';
  const unit = number(max) + ' ' + label('orders');
  return '<div class="daily-heatmap" data-calendar-day="' + dateInputValue(now) + '" data-page-chart="overview-heatmap" data-page-chart-type="heatmap" data-page-chart-version="' +
    escapeAttr(version) + '" data-page-chart-domain="' + days[0].key + '|' + days.at(-1).key +
    '"><h3 class="daily-heatmap-period">' + escapeHtml(period) + '</h3>' +
    '<div class="daily-heatmap-scroll" data-heatmap-scope="' + escapeAttr(scope) + '">' + calendar +
    '</div><div class="daily-heatmap-legend"><span>' + escapeHtml(label('count')) +
    '</span><span>0</span><span class="daily-heatmap-scale" aria-hidden="true">' +
    [0, 1, 2, 3, 4, 5].map((level) => '<i data-level="' + level + '"></i>').join('') + '</span><span>' + escapeHtml(unit) +
    '</span></div></div>';
}
