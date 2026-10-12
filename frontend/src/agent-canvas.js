import { escapeHtml as html, escapeAttr as attr, currencyName } from './utils.js';
import { financeAttr, financeColumnMeaning } from './finance-colors.js';
import { lineChart, renderAgentPanelVisual, interactivePieSlice, niceScale, axisNumberFormatter } from './charts.js';
import { chartHoverAttrs, prepareChartHover } from './agent-chart-hover.js';
import { agentText } from './agent-copy.js';
import { prepareCanvasMotion, queueChartMotion, forgetChartMotion } from './agent-motion.js';
import { normalizeCanvasReport } from './agent-canvas-report.js';

// Water palette for the AI canvas (UI texture brief: white-led, cool, a few coloured lines). Dark fallbacks here,
// light values in theme.css. Hues are spaced for distinction; none carries a financial gain or loss meaning.
const palette = ['#e6ecf2', '#6ec6e0', '#9d8fe0', '#59a796', '#8aa4c2', '#c7a7e3', '#4f86c6', '#a9d8c9']
  .map((shade, index) => 'var(--chart-series-' + (index + 1) + ', ' + shade + ')');
const axisFormat = language => (value, step, ticks) => axisNumberFormatter(language, ticks || [0, step])(value);
const color = (label) => {
  let hash = 0;
  for (const char of String(label)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return palette[hash % palette.length];
};
export function categoryColors(labels) {
  const assigned = new Map(); const used = new Set();
  for (const label of [...new Set(labels.map(String))].sort()) {
    const first = palette.indexOf(color(label));
    let next = color(label);
    for (let offset = 0; offset < palette.length; offset++) {
      const candidate = palette[(first + offset) % palette.length];
      if (!used.has(candidate)) { next = candidate; break; }
    }
    if (used.has(next)) next = 'hsl(' + (assigned.size * 137.508 % 360).toFixed(3) + ' 32% var(--chart-extra-lightness, 65%))';
    assigned.set(label, next); used.add(next);
  }
  return assigned;
}
const text = (language, key) => agentText(language, key);

// Pair only adjacent, compact results. The Agent's reading order stays intact.
export function canvasLayout(charts, datasets = [], mode = 'auto') {
  const data = new Map(datasets.map(item => [item.id, item]));
  const compact = chart => {
    const dataset = data.get(chart.dataset_id);
    return dataset && dataset.rows.length <= 8 && (chart.type === 'pie' ||
      chart.type === 'table' && (chart.encoding.columns || dataset.columns).length <= 3);
  };
  const layout = charts.map(() => 'full');
  if (mode === 'full') return layout;
  for (let i = 0; i < charts.length - 1; i++) {
    if (charts[i].type === 'metric' && charts[i + 1].type === 'metric') {
      layout[i] = 'metric-start'; layout[++i] = 'metric-end';
    } else if (compact(charts[i]) && compact(charts[i + 1])) {
      layout[i] = 'pair-start'; layout[++i] = 'pair-end';
    } else if (mode === 'paired' && charts[i].type !== 'metric' && charts[i + 1].type !== 'metric') {
      const fits = chart => {
        const dataset = data.get(chart.dataset_id);
        return dataset && dataset.rows.length <= 16 &&
          (chart.type !== 'table' || (chart.encoding.columns || dataset.columns).length <= 3);
      };
      if (fits(charts[i]) && fits(charts[i + 1])) { layout[i] = 'wide-start'; layout[++i] = 'wide-end'; }
    }
  }
  return layout;
}

export function canvasBlocks(charts, datasets = [], reportValue) {
  const report = normalizeCanvasReport(reportValue, charts);
  const blocks = [];
  if (report?.title || report?.summary) blocks.push({ key: 'intro', type: 'intro', title: report.title, summary: report.summary });
  const groups = report?.sections.length ? report.sections : [{ chart_ids: charts.map(chart => chart.id), layout: 'auto' }];
  const byId = new Map(charts.map(chart => [chart.id, chart]));
  for (const group of groups) {
    if (group.id) blocks.push({ key: 'section:' + group.id, type: 'section', title: group.title, summary: group.summary });
    const members = group.chart_ids.map(id => byId.get(id));
    const layout = canvasLayout(members, datasets, group.layout);
    const primary = members.findIndex(chart => chart.type !== 'metric');
    members.forEach((chart, index) => blocks.push({ key: 'chart:' + chart.id, type: 'chart', chart, layout: layout[index],
      grouped: Boolean(group.id), primary: index === primary && layout[index] === 'full',
      related: /^(pair-start|pair-end)$/.test(layout[index]) && chart.dataset_id === members[index + (layout[index] === 'pair-start' ? 1 : -1)]?.dataset_id }));
  }
  return blocks;
}

export function renderReportBlock(block) {
  return (block.title ? '<h2>' + html(block.title) + '</h2>' : '') +
    (block.summary ? '<p>' + html(block.summary) + '</p>' : '');
}
export function chartValue(value, column, dataset, language, includeCurrency = true) {
  if (value === null || value === undefined) return text(language, 'unknown');
  if (column?.type === 'money' || column?.type === 'number') {
    const digits = column.type === 'money' ? Math.min(8, String(value).split('.')[1]?.length || 0) : 4;
    const amount = new Intl.NumberFormat(language, { minimumFractionDigits: column.type === 'money' ? digits : 0, maximumFractionDigits: digits }).format(value);
    return amount + (column.type === 'money' && includeCurrency ? ' ' + currencyName(dataset.meta.currency) : '');
  }
  return String(value);
}

// A dataset has one currency: name it once in the column header instead of repeating it in every cell.
function dataTable(dataset, columns, language, title) {
  const alignment = column => ['money', 'number'].includes(column.type) ? ' class="agent-table-number"' : '';
  const heading = column => html(column.label) + (column.type === 'money' ? '<small class="agent-table-unit">' + html(currencyName(dataset.meta.currency)) + '</small>' : '');
  return '<div class="agent-data-table" tabindex="0" role="region" aria-label="' + attr(title) + '"><table aria-label="' + attr(title) + '"><thead><tr>' + columns.map((column) => '<th scope="col"' + alignment(column) + '>' + heading(column) + '</th>').join('') +
    '</tr></thead><tbody>' + dataset.rows.map((row) => '<tr>' + columns.map((column) => '<td' + alignment(column) + financeAttr(row[column.key], financeColumnMeaning(column)) + '>' + html(chartValue(row[column.key], column, dataset, language, false)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}

function pieTotal(rows, key, column) {
  if (column?.type !== 'money') return rows.reduce((sum, row) => sum + Math.max(0, Number(row[key]) || 0), 0);
  const parts = rows.filter(row => row[key] != null && Number(row[key]) >= 0).map(row => String(row[key]).split('.'));
  const scale = Math.max(0, ...parts.map(([, fraction = '']) => fraction.length));
  const unit = 10n ** BigInt(scale);
  const total = parts.reduce((sum, [whole, fraction = '']) => sum + BigInt(whole) * unit + BigInt(fraction.padEnd(scale, '0') || '0'), 0n);
  if (!scale) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  return digits.slice(0, -scale) + '.' + digits.slice(-scale);
}

function dataStatus(warnings, language) {
  if (!warnings.length) return '';
  return '<span class="agent-data-status"' + chartHoverAttrs(text(language, 'dataStatus'), warnings.join('\n')) + '><span aria-hidden="true">i</span></span>';
}

function pie(chart, dataset, language) {
  const { label, value } = chart.encoding;
  const column = dataset.columns.find((item) => item.key === value);
  const colors = categoryColors(dataset.rows.map((row) => row[label]));
  const total = dataset.rows.reduce((sum, row) => sum + Math.max(0, Number(row[value]) || 0), 0);
  if (!total) return '<p class="agent-chart-empty">' + html(text(language, 'noData')) + '</p>';
  let cursor = 0;
  const donut = chart.options?.variant !== 'pie';
  const segments = dataset.rows.map((row, index) => {
    const share = Math.max(0, Number(row[value]) || 0) / total;
    if (!share) return '';
    const start = cursor; cursor += share;
    return interactivePieSlice({ cx: 100, cy: 100, outer: donut ? 86 : 84, inner: donut ? 66 : 0,
      start: start * 360, end: cursor * 360, index, label: row[label], fill: colors.get(String(row[label])),
      value: chartValue(row[value], column, dataset, language) + ' (' + (share * 100).toFixed(1) + '%)' });
  }).join('');
  const legend = dataset.rows.map((row, index) => {
    const amount = chartValue(row[value], column, dataset, language);
    const percent = row[value] == null ? text(language, 'unknown') : (Math.max(0, Number(row[value]) || 0) / total * 100).toFixed(1) + '%';
    const share = Math.max(0, Number(row[value]) || 0) / total * 100;
    return '<li data-agent-pie-index="' + index + '"' + chartHoverAttrs(row[label], amount + ' (' + percent + ')') + ' style="--slice-color:' + colors.get(String(row[label])) + ';--slice-share:' + share.toFixed(3) + '%"><i></i><span>' + html(row[label]) +
      '</span><strong>' + html(chartValue(row[value], column, dataset, language, false)) + '</strong><small>' + html(percent) + '</small><div class="agent-pie-share" aria-hidden="true"><b></b></div></li>';
  }).join('');
  const totalLabel = text(language, 'chartTotal') + (column?.type === 'money' ? ' · ' + currencyName(dataset.meta.currency) : '');
  const center = donut ? '<div class="agent-pie-center" aria-hidden="true"><div class="agent-pie-readout is-default"><strong>' +
    html(chartValue(pieTotal(dataset.rows, value, column), column, dataset, language, false)) + '</strong><span>' + html(totalLabel) + '</span></div>' + dataset.rows.map((row, index) => {
    const percent = row[value] == null ? html(text(language, 'unknown')) : (Math.max(0, Number(row[value]) || 0) / total * 100).toFixed(1) + '<small>%</small>';
    return '<div class="agent-pie-readout" data-agent-pie-index="' + index + '"><strong>' + percent + '</strong><span>' + html(row[label]) + '</span></div>';
  }).join('') + '</div>' : '';
  // One value-column width for every row, so each share track has the same length.
  const valueWidth = Math.min(16, Math.max(4, ...dataset.rows.map((row) => chartValue(row[value], column, dataset, language, false).length)));
  return '<div class="agent-pie"><div class="agent-pie-plot"><svg viewBox="0 0 200 200" role="group" aria-label="' + attr(chart.title) + '">' + segments + '</svg>' + center + '</div><ul class="agent-pie-legend" style="--legend-value-ch:' + valueWidth + '">' + legend + '</ul></div>';
}

function seriesData(chart, dataset) {
  const { x, y, series } = chart.encoding;
  const xColumn = dataset.columns.find((column) => column.key === x);
  const xs = [...new Set(dataset.rows.map((row) => row[x]))];
  if (['date', 'datetime'].includes(xColumn.type)) xs.sort((a, b) => Date.parse(a) - Date.parse(b));
  else if (['number', 'money'].includes(xColumn.type)) xs.sort((a, b) => Number(a) - Number(b));
  const names = series ? [...new Set(dataset.rows.map((row) => row[series]))] : [dataset.columns.find((column) => column.key === y).label];
  return names.map((name) => {
    const rows = new Map(dataset.rows.filter((row) => !series || row[series] === name).map((row) => [row[x], row]));
    return { name: String(name), data: xs.map((label) => ({ label: String(label), value: rows.get(label)?.[y] ?? null })) };
  });
}

function barChart(chart, dataset, language) {
  const series = seriesData(chart, dataset);
  const colors = categoryColors(series.map(item => item.name));
  const horizontal = chart.options?.orientation === 'horizontal';
  const stacked = chart.options?.mode === 'stacked';
  const groups = series[0]?.data || [];
  const column = dataset.columns.find((item) => item.key === chart.encoding.y);
  const extent = groups.flatMap((_, index) => {
    const values = series.map((item) => Number(item.data[index].value));
    return stacked ? [values.filter((v) => v > 0).reduce((a, b) => a + b, 0), values.filter((v) => v < 0).reduce((a, b) => a + b, 0)] : values;
  });
  const nice = niceScale(Math.min(0, ...extent), Math.max(1, ...extent));
  const min = nice.min; const max = nice.max;
  const formatTick = axisNumberFormatter(language, nice.ticks);
  const width = horizontal ? 640 : Math.max(640, groups.length * 80);
  const height = horizontal ? Math.max(260, groups.length * Math.max(38, (stacked ? 1 : series.length) * 18)) + 40 : 300;
  const left = horizontal ? 140 : 65; const right = 20; const top = 20; const bottom = 40;
  const magnitude = horizontal ? width - left - right : height - top - bottom;
  const scale = (value) => (value - min) / (max - min) * magnitude;
  const band = (horizontal ? height - top - bottom : width - left - right) / Math.max(groups.length, 1);
  let elements = '';
  for (const value of nice.ticks) {
    const p = horizontal ? left + scale(value) : height - bottom - scale(value);
    elements += horizontal
      ? '<line x1="' + p + '" x2="' + p + '" y1="' + top + '" y2="' + (height - bottom) + '" class="chart-grid"/><text x="' + p + '" y="' + (height - 15) + '" text-anchor="middle">'
      : '<line x1="' + left + '" x2="' + (width - right) + '" y1="' + p + '" y2="' + p + '" class="chart-grid"/><text x="' + (left - 8) + '" y="' + (p + 4) + '" text-anchor="end">';
    elements += html(formatTick(value)) + '</text>';
  }
  groups.forEach((group, index) => {
    const pos = (horizontal ? top : left) + index * band;
    let positive = 0; let negative = 0;
    series.forEach((item, si) => {
      const raw = item.data[index].value;
      if (raw === null) return;
      const value = Number(raw);
      const start = stacked ? value >= 0 ? positive : negative : 0;
      if (value >= 0) positive += value; else negative += value;
      const a = scale(start); const b = scale(start + value);
      const count = stacked ? 1 : series.length;
      const thickness = Math.max(1, Math.min(count === 1 ? 32 : 22, band * .66 / count));
      const offset = pos + (band - thickness * count) / 2 + (stacked ? 0 : si * thickness);
      elements += '<g class="agent-bar-hover"' + chartHoverAttrs(group.label + ' / ' + item.name, chartValue(raw, column, dataset, language)) + '>' +
        '<rect class="agent-chart-hit" ' + (horizontal
        ? 'x="' + (left + Math.min(a, b) - (Math.abs(b - a) < 6 ? 3 : 0)) + '" y="' + offset + '" width="' + Math.max(6, Math.abs(b - a)) + '" height="' + Math.max(1, thickness - 1) + '"'
        : 'x="' + offset + '" y="' + (height - bottom - Math.max(a, b) - (Math.abs(b - a) < 6 ? 3 : 0)) + '" width="' + Math.max(1, thickness - 1) + '" height="' + Math.max(6, Math.abs(b - a)) + '"') + '/>' +
        '<rect class="agent-bar-mark" rx="2" data-bar-axis="' + (horizontal ? 'x' : 'y') + '" style="transform-origin:' +
        (horizontal ? left + a : offset) + 'px ' + (horizontal ? offset : height - bottom - a) + 'px" fill="' + colors.get(item.name) + '" ' + (horizontal
        ? 'x="' + (left + Math.min(a, b)) + '" y="' + offset + '" width="' + Math.abs(b - a) + '" height="' + Math.max(1, thickness - 1) + '"'
        : 'x="' + offset + '" y="' + (height - bottom - Math.max(a, b)) + '" width="' + Math.max(1, thickness - 1) + '" height="' + Math.abs(b - a) + '"') + '/></g>';
    });
    elements += '<text ' + (horizontal ? 'x="' + (left - 10) + '" y="' + (pos + band / 2 + 4) + '" text-anchor="end"' : 'x="' + (pos + band / 2) + '" y="' + (height - 14) + '" text-anchor="middle"') + '><title>' + html(group.label) + '</title>' + html(group.label.length > 14 ? group.label.slice(0, 12) + '…' : group.label) + '</text>';
  });
  return '<div class="agent-plot-scroll" tabindex="0" role="region" aria-label="' + attr(chart.title) + '"><svg class="agent-bar-chart" style="min-width:' + (horizontal || groups.length <= 8 ? 440 : width) + 'px" viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="' + attr(chart.title) + '">' + elements + '</svg></div>' +
    (series.length > 1 ? '<div class="agent-series-legend">' + series.map((item) => '<span><i style="background:' + colors.get(item.name) + '"></i>' + html(item.name) + '</span>').join('') + '</div>' : '');
}

export function renderCanvasChart(chart, dataset, language) {
  const column = dataset.columns.find((item) => item.key === (chart.encoding.value || chart.encoding.y));
  let body;
  if (chart.type === 'table') body = dataTable(dataset, chart.encoding.columns ? chart.encoding.columns.map((key) => dataset.columns.find((item) => item.key === key)) : dataset.columns, language, chart.title);
  else if (chart.type === 'metric') body = '<p class="agent-metric-value"' + financeAttr(dataset.rows[0][chart.encoding.value], financeColumnMeaning(column)) + '><span class="agent-metric-amount">' + html(chartValue(dataset.rows[0][chart.encoding.value], column, dataset, language, false)) + '</span>' +
    (column?.type === 'money' ? ' <span class="agent-metric-unit">' + html(currencyName(dataset.meta.currency)) + '</span>' : '') + '</p>';
  else if (!dataset.rows.length) body = '<p class="agent-chart-empty">' + html(text(language, 'noData')) + '</p>';
  else if (chart.type === 'pie') body = pie(chart, dataset, language);
  else if (chart.type === 'bar') body = barChart(chart, dataset, language);
  else {
    const xType = dataset.columns.find((item) => item.key === chart.encoding.x).type;
    const series = seriesData(chart, dataset);
    const inspectColumns = (series[0]?.data || []).map((point, index) => ({
      label: point.label,
      value: series.map(item => item.name + ': ' + chartValue(item.data[index].value, column, dataset, language)).join('\n'),
      available: series.map(item => item.data[index].value !== null),
    }));
    body = lineChart(series, { label: chart.title, language, gaps: true, hoverDetails: true, inspectColumns, width: 640, height: 300,
      includeZero: dataset.rows.every((row) => row[chart.encoding.y] === null || Number(row[chart.encoding.y]) >= 0),
      niceTicks: true, evenLabels: true, paddingLeft: 76, axisValueFormatter: axisFormat(language),
      axisLabelFormatter: (label) => xType === 'date' ? label.slice(5) : label.length > 12 ? label.slice(0, 10) + '…' : label,
      valueFormatter: (value, row) => chartValue(row?.value ?? value, column, dataset, language) });
  }
  const meta = dataset.meta;
  const warnings = [...meta.warnings];
  if (meta.status === 'partial') warnings.unshift(text(language, 'partial'));
  const unknowns = dataset.rows.some(row => (column ? [column] : dataset.columns).some(item => row[item.key] === null));
  if (unknowns) warnings.push(text(language, 'unknown'));
  return '<header><h3>' + html(chart.title) + '</h3><div class="agent-chart-context">' + (column?.type === 'money' && chart.type !== 'metric' ? '<span class="agent-unit">' + html(currencyName(meta.currency)) + '</span>' : '') +
    dataStatus(warnings, language) + '</div></header><div class="agent-chart-body">' + body + '</div>';
}

// SVG charts scale with their box. Keep axis text at one apparent size at any canvas width (it used to range from
// about 7px in a narrow split to 16px when wide); only a CSS variable changes, nothing is rebuilt or requested.
const textObservers = new WeakMap();
function fitChartText(container) {
  const fit = () => container.querySelectorAll?.('svg.line-chart, svg.agent-bar-chart').forEach((svg) => {
    const width = svg.getBoundingClientRect?.().width, box = svg.viewBox?.baseVal?.width;
    if (width > 0 && box > 0) svg.style?.setProperty('--chart-scale', (box / width).toFixed(4));
  });
  fit();
  if (!textObservers.has(container) && typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    textObservers.set(container, observer);
  }
}

const signatures = new WeakMap();
const canvasKeys = new WeakMap();
export function patchCanvas(container, state, language, { animateCharts = false } = {}) {
  prepareCanvasMotion(container);
  const hover = prepareChartHover(container);
  if (!container) return;
  const key = [state.agentCanvas, state.agentVisuals, language];
  if (canvasKeys.get(container)?.every((value, index) => value === key[index])) return;
  const charts = state.agentCanvas?.charts || [];
  const legacy = charts.length ? [] : state.agentVisuals || [];
  const items = charts.length ? charts : legacy;
  const blocks = canvasBlocks(items, state.agentCanvas?.datasets, charts.length ? state.agentCanvas?.report : null);
  const previous = new Map([...container.querySelectorAll(':scope > [data-canvas-block]')].map((node) => [node.dataset.canvasBlock, node]));
  for (const [index, block] of blocks.entries()) {
    let node = previous.get(block.key);
    if (!node) { node = document.createElement('section'); node.dataset.canvasBlock = block.key; }
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    previous.delete(block.key);
    if (block.type !== 'chart') {
      node.classList.add('agent-report-' + block.type);
      const signature = JSON.stringify(block);
      if (signatures.get(node) !== signature) {
        forgetChartMotion(node);
        node.innerHTML = renderReportBlock(block);
        signatures.set(node, signature);
        if (animateCharts) queueChartMotion(node, 'report');
      }
      continue;
    }
    const chart = block.chart;
    const dataset = state.agentCanvas?.datasets.find((item) => item.id === chart.dataset_id);
    const signature = JSON.stringify([chart, dataset, language]);
    node.classList.add('agent-canvas-chart'); node.dataset.canvasChart = chart.id;
    node.dataset.layout = block.layout;
    node.dataset.emphasis = block.primary ? 'primary' : 'supporting';
    node.dataset.grouped = String(block.grouped);
    node.dataset.related = String(block.related);
    if (signatures.get(node) !== signature) {
      hover.clearWithin(node);
      forgetChartMotion(node);
      node.dataset.chartType = chart.type;
      node.innerHTML = dataset ? renderCanvasChart(chart, dataset, language) : dataStatus([text(language, 'local')], language) + renderAgentPanelVisual(chart, language, { hoverDetails: true });
      if (dataset && chart.type === 'line') {
        const series = seriesData(chart, dataset);
        const colors = categoryColors(series.map(item => item.name));
        node.querySelectorAll('.chart-series').forEach((item, index) => item.style.setProperty('--agent-series', colors.get(series[index].name)));
        node.querySelectorAll('.chart-legend span i').forEach((item, index) => { item.style.background = colors.get(series[index].name); });
      }
      // Legacy rendering used clickable drill-down bars. The Agent canvas is read-only.
      node.querySelectorAll('button').forEach((button) => { const replacement = document.createElement('div'); replacement.className = button.className; replacement.innerHTML = button.innerHTML; button.replaceWith(replacement); });
      signatures.set(node, signature);
      if (animateCharts) queueChartMotion(node, chart.type);
    }
  }
  previous.forEach((node) => { hover.clearWithin(node); forgetChartMotion(node); node.remove(); });
  let empty = container.querySelector(':scope > .agent-canvas-empty');
  if (items.length) empty?.remove();
  else if (!empty) { empty = document.createElement('p'); empty.className = 'agent-canvas-empty'; container.append(empty); }
  if (empty && !items.length) empty.textContent = text(language, 'empty');
  fitChartText(container);
  canvasKeys.set(container, key);
}
