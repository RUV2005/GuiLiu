import { localeFor, t } from './i18n.js';
import { amountToJpy, dateInputValue, formatJpy, toDate } from './utils.js';
import { financeTone } from './finance-colors.js';

function dailyDetails(deals, rates, hourly) {
  const days = new Map();
  for (const deal of deals || []) {
    const date = toDate(deal.ISOtime);
    if (!date) continue;
    const key = dateInputValue(date) + (hourly ? 'T' + String(date.getHours()).padStart(2, '0') : '');
    const summary = days.get(key) || { count: 0, largest: null };
    const amount = amountToJpy(deal.price, deal.CurrencyTypeNumber, rates);
    summary.count++;
    if (!summary.largest || amount > summary.largest.amount) {
      summary.largest = { shop: String(deal.ShopName || '').trim(), amount };
    }
    days.set(key, summary);
  }
  return days;
}

// Hover summary for one date column. The lines keep each day's spending; the tooltip names the date once, with the
// weekday because "the same date last month" usually falls on another weekday, gives both days side by side as
// structured rows (amount, count, largest purchase), and closes with how the day compares. `value` is the same
// content as plain text for screen readers and the text-only tooltip.
export function overviewTrendDetails(ctx, current, previous, axisLabels, now) {
  const range = ctx.state.settings.contextRange, monthly = range === 'month', hourly = range === 'today';
  const label = (key, args) => t(ctx.language, key, args);
  const money = value => formatJpy(value, ctx.language);
  const groups = [dailyDetails(ctx.currentDeals, ctx.state.rates, hourly), dailyDetails(ctx.previousDeals, ctx.state.rates, hourly)];
  const names = hourly ? [label('trendToday'), label('trendYesterday')]
    : monthly ? [label('thisMonth'), label('lastMonth')] : [label('currentPeriod'), label('previousPeriod')];
  const locale = localeFor(ctx.language);
  const dayFormat = new Intl.DateTimeFormat(locale, monthly ? { month: 'long', day: 'numeric', weekday: 'short' }
    : { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
  const midSentence = name => ctx.language === 'en' ? name.charAt(0).toLowerCase() + name.slice(1) : name;
  const size = Math.max(axisLabels?.length || 0, current.length, previous.length);
  const today = dateInputValue(now) + (hourly ? 'T' + String(now.getHours()).padStart(2, '0') : '');
  const when = key => {
    const date = key && toDate(key.slice(0, 10) + 'T00:00:00');
    return date ? dayFormat.format(date) + (hourly ? ' ' + key.slice(11) + ':00' : '') : '';
  };
  const percent = (difference, base) => {
    if (!(base > 0)) return '';
    const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: 'always' }).format(difference / base * 100) + '%';
    return ctx.language === 'en' ? ' (' + value + ')' : '（' + value + '）';
  };
  return Array.from({ length: size }, (_, index) => {
    const days = [current, previous].map((series, period) => {
      const point = series[index];
      const date = monthly ? new Date(now.getFullYear(), now.getMonth() - period, index + 1) : null;
      const validDay = !monthly || date.getDate() === index + 1;
      const key = point?.key || (monthly && validDay ? dateInputValue(date) : '');
      const future = period === 0 && Boolean(key) && key > today;
      return { point, key, validDay, future, available: Boolean(point) && point.value != null && !future && validDay };
    });
    const rows = days.map((day, period) => {
      const details = day.available ? groups[period].get(day.key) : null, largest = details?.largest;
      return { kind: period ? 'previous' : 'current',
        name: names[period] + (period && day.key && !hourly ? ' · ' + when(day.key) : ''),
        amount: day.available ? money(day.point.value) : '—',
        meta: day.available ? label('transactionsEnd', { count: details?.count || 0 }) + (largest ? ' · ' + label('trendLargestTransaction') + ' ' +
          (largest.shop ? largest.shop.slice(0, 60) + ' ' : '') + money(largest.amount) : '') : '',
        note: !day.validDay ? label('trendNoDay') : day.future ? label('trendFutureDay') : !day.available ? label('trendNoData')
          : period === 0 && day.key === today ? label('trendInProgress') : '' };
    });
    const [currentDay, previousDay] = days;
    if (currentDay.available && previousDay.available) {
      const difference = currentDay.point.value - previousDay.point.value;
      const comparator = label(hourly ? 'trendSameHour' : 'trendSameDay', { period: midSentence(names[1]) });
      rows.push({ kind: 'delta', tone: financeTone(difference, 'expense-change'),
        text: difference === 0 ? label('trendEven', { period: comparator })
          : label(difference > 0 ? 'trendMore' : 'trendLess', { period: comparator, amount: money(Math.abs(difference)) }) + percent(difference, previousDay.point.value) });
    }
    const title = when(currentDay.key) || when(previousDay.key) || axisLabels?.[index] || '';
    const value = rows.map(row => row.kind === 'delta' ? row.text
      : [row.name + ' ' + row.amount, row.meta, row.note].filter(Boolean).join(' · ')).join('\n');
    return { label: title, value, rows, available: [currentDay.available, previousDay.available] };
  });
}
