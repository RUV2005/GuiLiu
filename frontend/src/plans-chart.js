import { escapeHtml as h, escapeAttr as a } from './utils.js';
import { chartHoverAttrs } from './agent-chart-hover.js';
import { planChart, displayCurrency, validDay } from './plans-model.js';
import { planText, planMoney } from './plans-copy.js';

const day = 86400000;
const stamp = date => Date.parse(date + 'T00:00:00Z');
const n = value => Number(value).toFixed(2);

export function planChartGeometry(plan, history, forecast, width = 600) {
  const data = planChart(plan, history, forecast);
  const target = plan.target_amount == null || plan.target_amount === '' ? null : Number(plan.target_amount);
  const deadline = validDay(plan.end_date) ? plan.end_date : null;
  const points = [...data.actual, ...data.forecast];
  const dates = [...points.map(point => point.time), stamp(data.today), ...(deadline ? [stamp(deadline)] : [])];
  let start = Math.min(...dates), end = Math.max(...dates);
  if (end === start) { start -= day; end += day; }
  const values = points.map(point => point.value).filter(value => value !== null);
  if (Number.isFinite(target)) values.push(target);
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const span = high - low || 1;
  const roughStep = span * 1.16 / 4, magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= roughStep) * magnitude;
  const min = low < 0 ? Math.floor((low - span * .08) / step) * step : 0;
  const max = Math.ceil((high + span * .16) / step) * step;
  const w = Math.max(240, width), height = 280;
  const plot = { left: 48, right: w - 18, top: 34, bottom: height - 38 };
  const x = time => plot.left + (time - start) / (end - start) * (plot.right - plot.left);
  const y = value => plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top);
  return { ...data, target: Number.isFinite(target) ? target : null, deadline, start, end, min, max, step, w, height, plot, x, y };
}

export function planForecastChart(plan, history, forecast = plan.forecast, { language = 'zh', width = 600 } = {}) {
  const tx = key => planText(language, key), money = value => planMoney(value, plan.currency, language);
  const g = planChartGeometry(plan, history, forecast, width);
  const { plot, x, y, w, height } = g;
  const locale = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' }[language] || 'en-US';
  const dates = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const axisDates = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', ...(g.end - g.start < 90 * day ? { day: 'numeric' } : {}), timeZone: 'UTC' });
  const numbers = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: g.step < 1 ? Math.min(8, -Math.floor(Math.log10(g.step)) + 1) : 1 });
  const dateLabel = time => dates.format(new Date(time));
  const rows = [{ key: 'actual', name: tx('actual'), data: g.actual }, { key: 'forecast', name: tx('projected'), data: g.forecast }];
  if (!rows.some(row => row.data.some(point => point.value !== null))) return '<div class="chart-empty">' + h(tx('chartEmpty')) + '</div>';
  const grid = Array.from({ length: Math.round((g.max - g.min) / g.step) + 1 }, (_, index) => {
    const value = g.min + g.step * index, cy = y(value);
    return '<line class="chart-grid" x1="' + plot.left + '" x2="' + plot.right + '" y1="' + n(cy) + '" y2="' + n(cy) + '"/>' +
      '<text class="chart-axis-label chart-axis-y" text-anchor="end" x="' + (plot.left - 10) + '" y="' + n(cy + 4) + '">' + h(numbers.format(value)) + '</text>';
  }).join('');
  const tickCount = w < 440 ? 2 : 4;
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const time = g.start + (g.end - g.start) * index / (tickCount - 1);
    return '<text class="chart-axis-label" x="' + n(x(time)) + '" y="' + (height - 10) + '" text-anchor="' + (index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle') + '">' + h(axisDates.format(new Date(time))) + '</text>';
  }).join('');
  const paths = rows.map(row => {
    let previous;
    const path = row.data.map(point => {
      if (point.value === null) { previous = null; return ''; }
      const move = !previous || row.key === 'actual' && point.time - previous.time > day;
      previous = point;
      return (move ? 'M' : 'L') + n(x(point.time)) + ' ' + n(y(point.value));
    }).join(' ');
    const points = row.data.map((point, index) => {
      if (point.value === null) return '';
      const isolated = row.key === 'actual' &&
        (row.data[index - 1]?.value == null || point.time - row.data[index - 1].time > day) &&
        (row.data[index + 1]?.value == null || row.data[index + 1].time - point.time > day);
      const endpoint = point.date === g.today || index === row.data.length - 1 || isolated;
      return '<g class="agent-line-hover"' + chartHoverAttrs(dateLabel(point.time) + ' · ' + row.name, money(point.amount)) + '>' +
        '<circle class="agent-chart-hit" cx="' + n(x(point.time)) + '" cy="' + n(y(point.value)) + '" r="9"/>' +
        '<circle class="chart-point' + (endpoint ? ' is-isolated' : '') + '" cx="' + n(x(point.time)) + '" cy="' + n(y(point.value)) + '" r="' + (point.date === g.today ? 4 : 3) + '"/></g>';
    }).join('');
    return '<g class="chart-series plan-series-' + row.key + '"><path class="chart-line" d="' + path + '"/>' + points + '</g>';
  }).join('');
  const todayX = x(stamp(g.today));
  const targetLine = g.target === null ? '' : '<line class="plan-target-line" x1="' + plot.left + '" x2="' + plot.right + '" y1="' + n(y(g.target)) + '" y2="' + n(y(g.target)) + '"/>';
  const deadlineLine = !g.deadline ? '' : '<line class="plan-deadline-line" x1="' + n(x(stamp(g.deadline))) + '" x2="' + n(x(stamp(g.deadline))) + '" y1="' + plot.top + '" y2="' + plot.bottom + '"/>';
  const version = a(JSON.stringify([rows.map(row => row.data.map(point => [point.date, point.value])), g.target, g.today, g.deadline]));
  const fact = (label, value) => '<div><dt>' + h(label) + '</dt><dd>' + h(value) + '</dd></div>';
  return '<div class="plan-forecast-chart chart-frame" data-page-chart="plan-progress-' + a(plan.id) + '" data-page-chart-type="line" data-page-chart-version="' + version + '" data-page-chart-domain="' + a(JSON.stringify([g.start, g.end])) + '">' +
    '<div class="plan-chart-key">' + rows.map(row => '<span><i class="plan-key-' + row.key + '"></i>' + h(row.name) + '</span>').join('') +
    '<span class="plan-chart-currency">' + h(displayCurrency(plan.currency)) + '</span></div>' +
    '<div class="plan-chart-target"><span><i></i>' + h(tx('target')) + '</span><strong>' + h(g.target === null ? tx('noTarget') : money(plan.target_amount)) + '</strong></div>' +
    '<svg class="line-chart" viewBox="0 0 ' + w + ' ' + height + '" role="group" aria-label="' + a(tx('progress')) + '">' +
    '<rect class="plan-forecast-region" x="' + n(todayX) + '" y="' + plot.top + '" width="' + n(plot.right - todayX) + '" height="' + (plot.bottom - plot.top) + '"/>' +
    grid + targetLine + deadlineLine + '<line class="plan-today-line" x1="' + n(todayX) + '" x2="' + n(todayX) + '" y1="' + plot.top + '" y2="' + plot.bottom + '"/>' +
    '<text class="plan-today-label" x="' + n(Math.max(plot.left + 22, Math.min(plot.right - 22, todayX))) + '" y="19" text-anchor="middle">' + h(tx('today')) + '</text>' + paths + ticks + '</svg>' +
    '<dl class="plan-chart-dates">' + fact(tx('deadline'), g.deadline || tx('noDeadline')) + fact(tx('expected'), forecast?.projected_completion_date || tx('unknown')) + '</dl></div>';
}
