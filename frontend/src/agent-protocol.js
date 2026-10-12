import { normalizeCanvasReport } from './agent-canvas-report.js';

export const CHART_TYPES = Object.freeze(['metric', 'table', 'pie', 'line', 'bar']);
export const MAX_EVENT_BYTES = 1024 * 1024;
const fieldTypes = ['text', 'date', 'datetime', 'number', 'money'];
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (detail) => { throw new Error(detail); };
const check = (ok, detail) => { if (!ok) fail(detail); };
const short = (value, max = 120) => typeof value === 'string' && value.length > 0 && value.length <= max;
const identifier = (value) => short(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
export const emptyCanvas = () => ({ version: 1, action: 'replace', datasets: [], charts: [] });
export function eventSize(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }

export function validateDataset(dataset) {
  check(object(dataset) && identifier(dataset.id), 'dataset.id');
  check(Array.isArray(dataset.columns) && dataset.columns.length > 0 && dataset.columns.length <= 32, 'dataset.columns');
  const keys = new Set();
  for (const column of dataset.columns) {
    check(object(column) && identifier(column.key) && !keys.has(column.key) && short(column.label) && fieldTypes.includes(column.type), 'dataset.column');
    keys.add(column.key);
  }
  check(Array.isArray(dataset.rows) && dataset.rows.length <= 1000, 'dataset.rows');
  for (const row of dataset.rows) {
    check(object(row), 'dataset.row');
    for (const column of dataset.columns) {
      check(own(row, column.key), 'dataset.missing_field');
      const value = row[column.key];
      if (value === null) continue;
      if (column.type === 'money') check(typeof value === 'string' && value.length <= 40 && decimal.test(value) && Number.isFinite(Number(value)) && Math.abs(Number(value)) < 1e15, 'dataset.money');
      else if (column.type === 'number') check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15, 'dataset.number');
      else check(typeof value === 'string' && value.length <= 2000, 'dataset.text');
      if (column.type === 'date' || column.type === 'datetime') check(Number.isFinite(Date.parse(value)), 'dataset.date');
    }
  }
  const meta = dataset.meta;
  check(object(meta) && ['complete', 'partial'].includes(meta.status), 'dataset.meta.status');
  check(short(meta.source) && short(meta.grain) && short(meta.aggregation), 'dataset.meta.source');
  const coverage = meta.coverage;
  check(object(coverage) && Number.isSafeInteger(coverage.matched_count) && Number.isSafeInteger(coverage.processed_count)
    && coverage.processed_count >= 0 && coverage.processed_count <= coverage.matched_count && typeof coverage.truncated === 'boolean', 'dataset.coverage');
  check(meta.status !== 'complete' || (!coverage.truncated && coverage.matched_count === coverage.processed_count), 'dataset.incomplete_total');
  check(Array.isArray(meta.warnings) && meta.warnings.length <= 20 && meta.warnings.every((warning) => short(warning, 2000)), 'dataset.warnings');
  check(typeof meta.as_of === 'string' && Number.isFinite(Date.parse(meta.as_of)), 'dataset.as_of');
  if (dataset.columns.some((column) => column.type === 'money')) {
    check(typeof meta.currency === 'string' && /^[A-Z]{3}$/.test(meta.currency), 'dataset.currency');
    check(object(meta.fx) && short(meta.fx.policy) && short(meta.fx.status), 'dataset.fx');
    const nativeCurrency = meta.fx.policy === 'native_currency_only' && meta.fx.status === 'not_applied';
    check(meta.status !== 'complete' || nativeCurrency || ['complete', 'not_required'].includes(meta.fx.status), 'dataset.incomplete_fx');
    const currencyColumn = dataset.columns.find((column) => ['currency', 'CurrencyTypeNumber'].includes(column.key));
    if (currencyColumn) check(dataset.rows.every((row) => row[currencyColumn.key] === meta.currency), 'dataset.mixed_currency');
  }
  if (meta.period != null) {
    check(object(meta.period) && short(meta.period.timezone) && meta.period.end_exclusive === true, 'dataset.period');
    const { start_time: start, end_time: end } = meta.period;
    check((start === null || Number.isFinite(Date.parse(start))) && (end === null || Number.isFinite(Date.parse(end))) && (start === null || end === null || Date.parse(start) <= Date.parse(end)), 'dataset.period.range');
  }
  return dataset;
}

export function validateChart(chart, datasets) {
  check(object(chart) && identifier(chart.id) && CHART_TYPES.includes(chart.type) && short(chart.title), 'chart.type_or_id');
  const dataset = datasets.find((item) => item.id === chart.dataset_id);
  check(Boolean(dataset), 'chart.dataset_id');
  const encoding = chart.encoding;
  check(object(encoding), 'chart.encoding');
  const field = (key, numeric = false) => {
    const column = dataset.columns.find((item) => item.key === key);
    check(column && (!numeric || ['number', 'money'].includes(column.type)), 'chart.encoding.field');
    return column;
  };
  const options = chart.options || {};
  check(object(options), 'chart.options');
  if (chart.type === 'table') {
    if (encoding.columns !== undefined) {
      check(Array.isArray(encoding.columns) && encoding.columns.length > 0 && new Set(encoding.columns).size === encoding.columns.length, 'chart.columns');
      encoding.columns.forEach((key) => field(key));
    }
  } else if (chart.type === 'metric') {
    field(encoding.value, true);
    check(dataset.rows.length === 1, 'chart.metric.rows');
  } else if (chart.type === 'pie') {
    field(encoding.label); field(encoding.value, true);
    check(options.variant === undefined || ['pie', 'donut'].includes(options.variant), 'chart.pie.variant');
    check(dataset.rows.every((row) => row[encoding.value] !== null && Number(row[encoding.value]) >= 0 && row[encoding.label] !== null), 'chart.pie.unknown_or_negative');
    check(new Set(dataset.rows.map((row) => row[encoding.label])).size === dataset.rows.length, 'chart.pie.duplicate_label');
  } else {
    field(encoding.x); field(encoding.y, true);
    if (encoding.series !== undefined) field(encoding.series);
    const cells = dataset.rows.map((row) => JSON.stringify([row[encoding.x], encoding.series ? row[encoding.series] : null]));
    check(new Set(cells).size === cells.length, 'chart.duplicate_point');
    check(dataset.rows.every((row) => row[encoding.x] !== null && (!encoding.series || row[encoding.series] !== null)), 'chart.missing_dimension');
    if (chart.type === 'bar') {
      check(options.mode === undefined || ['plain', 'grouped', 'stacked'].includes(options.mode), 'chart.bar.mode');
      check(options.orientation === undefined || ['horizontal', 'vertical'].includes(options.orientation), 'chart.bar.orientation');
      check(!encoding.series || options.mode !== 'plain', 'chart.bar.series');
      if (options.mode === 'stacked') {
        check(dataset.rows.every((row) => row[encoding.y] !== null), 'chart.bar.incomplete_stack');
        if (encoding.series) check(new Set(dataset.rows.map((row) => row[encoding.x])).size * new Set(dataset.rows.map((row) => row[encoding.series])).size === dataset.rows.length, 'chart.bar.incomplete_stack');
      }
    }
  }
  return chart;
}

// Validate the whole update before mutating visible state. An invalid replace never erases evidence.
export function reduceCanvas(previous, update) {
  check(object(update) && update.version === 1 && ['replace', 'append', 'keep', 'clear'].includes(update.action), 'canvas.version_or_action');
  check(eventSize(update) <= MAX_EVENT_BYTES, 'canvas.size');
  if (update.action === 'keep') return previous;
  if (update.action === 'clear') return emptyCanvas();
  check(Array.isArray(update.charts) && update.charts.length > 0 && update.charts.length <= 8, 'canvas.charts');
  check(Array.isArray(update.datasets) && update.datasets.length <= 8, 'canvas.datasets');
  check(new Set(update.datasets.map((item) => item?.id)).size === update.datasets.length, 'canvas.duplicate_dataset');
  check(new Set(update.charts.map((item) => item?.id)).size === update.charts.length, 'canvas.duplicate_chart');
  update.datasets.forEach(validateDataset);
  update.charts.forEach((chart) => validateChart(chart, update.datasets));
  const merge = (oldItems, items) => {
    const map = new Map(oldItems.map((item) => [item.id, item]));
    items.forEach((item) => map.set(item.id, item));
    return [...map.values()];
  };
  const charts = update.action === 'append' ? merge(previous.charts, update.charts) : update.charts;
  const datasets = (update.action === 'append' ? merge(previous.datasets, update.datasets) : update.datasets)
    .filter((dataset) => charts.some((chart) => chart.dataset_id === dataset.id));
  check(charts.length <= 8 && eventSize({ charts, datasets }) <= MAX_EVENT_BYTES, 'canvas.limit');
  charts.forEach((chart) => validateChart(chart, datasets));
  // A data update without a new report drops old conclusions rather than showing stale analysis.
  const report = normalizeCanvasReport(update.report, charts);
  const result = { version: 1, action: 'replace', charts, datasets, ...(report ? { report } : {}) };
  check(eventSize(result) <= MAX_EVENT_BYTES, 'canvas.limit');
  return structuredClone(result);
}

export function renderableCanvas(canvas) {
  return canvas.charts.some((chart) => {
    const rows = canvas.datasets.find((dataset) => dataset.id === chart.dataset_id)?.rows || [];
    if (chart.type === 'table') return rows.length > 0;
    const key = chart.encoding.value || chart.encoding.y;
    return rows.some((row) => row[key] !== null && (chart.type !== 'pie' || Number(row[key]) > 0));
  });
}

export function validateEvent(event, request) {
  check(object(event) && event.schema_version === 1, 'event.version');
  if (event.session_id !== request.session_id || event.request_id !== request.request_id) return false;
  check(identifier(event.event_id) && Number.isSafeInteger(event.sequence) && event.sequence > 0 && identifier(event.message_id)
    && Number.isSafeInteger(event.turn_id) && event.turn_id >= 0 && Number.isFinite(Date.parse(event.created_at)) && object(event.payload), 'event.envelope');
  return true;
}

// SSE frames can span arbitrary UTF-8 chunks, including between CR and LF.
export function createSseParser(onEvent) {
  let buffer = '';
  let frame = { event: 'message', id: '', data: [] };
  let size = 0;
  const line = (value) => {
    size += new TextEncoder().encode(value).length;
    check(size <= MAX_EVENT_BYTES, 'event.size');
    if (value === '') {
      if (frame.data.length) onEvent({ event: frame.event, id: frame.id, data: frame.data.join('\n') });
      frame = { event: 'message', id: '', data: [] }; size = 0; return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const key = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (key === 'data') frame.data.push(content);
    if (key === 'event') frame.event = content;
    if (key === 'id' && !content.includes('\0')) frame.id = content;
  };
  return {
    push(chunk) {
      buffer += chunk;
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
      check(size + new TextEncoder().encode(buffer).length <= MAX_EVENT_BYTES, 'event.size');
    },
    finish() {
      if (buffer.endsWith('\r')) { line(buffer.slice(0, -1)); buffer = ''; }
      // An unterminated event is not committed; the request can resume safely.
      check(!buffer && !frame.data.length, 'event.truncated');
    },
  };
}
