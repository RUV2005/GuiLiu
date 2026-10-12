import { escapeAttr, escapeHtml, formatJpy } from "./utils.js";
import { financeAttr, financeColumnMeaning } from './finance-colors.js';
import { chartHoverAttrs } from './agent-chart-hover.js';

function motionAttrs(options, type, values, domain) {
  if (!options.motionKey) return '';
  return ' data-page-chart="' + escapeAttr(options.motionKey) + '" data-page-chart-type="' + type +
    '" data-page-chart-version="' + escapeAttr(JSON.stringify(values)) + '"' +
    (domain === undefined ? '' : ' data-page-chart-domain="' + escapeAttr(JSON.stringify(domain)) + '"');
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function pointsFrom(data, gaps = false) {
  return (Array.isArray(data) ? data : [])
    .map((item, index) => ({
      label: String(item?.label ?? item?.name ?? item?.x ?? index + 1),
      value: gaps && (item?.value === null || item?.value === undefined) ? null : finite(item?.value ?? item?.amount ?? item?.y),
      raw: item,
    }));
}

// Axis domain on round steps (1, 2, 2.5 or 5 × 10^n) that always contains min and max.
export function niceScale(min, max, count = 5) {
  let lo = Number(min) || 0, hi = Number(max) || 0;
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / count, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  const clean = value => Number(value.toPrecision(12)) || 0;
  lo = clean(Math.floor(lo / step + 1e-9) * step); hi = clean(Math.ceil(hi / step - 1e-9) * step);
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, index) => clean(lo + index * step));
  return { min: lo, max: hi, step, ticks };
}

// One unit and precision for a whole axis, so ticks never mix "8,532.8" with "1.1万".
export function axisNumberFormatter(language, ticks) {
  const largest = Math.max(0, ...ticks.map(value => Math.abs(Number(value) || 0)));
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : largest || 1;
  const east = /^(zh|ja)/.test(language);
  const [unit, suffix] = east ? largest >= 1e9 ? [1e8, language.startsWith('ja') ? '億' : '亿'] : largest >= 1e5 ? [1e4, '万'] : [1, '']
    : largest >= 1e7 ? [1e6, 'M'] : largest >= 1e4 ? [1e3, 'K'] : [1, ''];
  let digits = 0;
  while (digits < 4 && Math.abs(Math.round(step / unit * 10 ** digits) - step / unit * 10 ** digits) > 1e-6) digits++;
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: digits });
  return value => Number(value) === 0 ? '0' : format.format(Number(value) / unit) + suffix;
}

function compactNumber(value, language) {
  const amount = Math.abs(Number(value || 0));
  if (amount >= 1000000) {
    return (Number(value) / 1000000).toLocaleString(language === "ja" ? "ja-JP" : "en-US", {
      maximumFractionDigits: 1,
    }) + "m";
  }
  if (amount >= 1000) {
    return (Number(value) / 1000).toLocaleString(language === "ja" ? "ja-JP" : "en-US", {
      maximumFractionDigits: 0,
    }) + "k";
  }
  return Math.round(Number(value || 0)).toLocaleString();
}

export function lineChart(seriesInput, options = {}) {
  const width = Number.isFinite(options.width) ? Math.max(240, options.width) : 760;
  const height = Number(options.height || 270);
  const padding = { top: 22, right: 18, bottom: 38, left: Number(options.paddingLeft) || 56 };
  const series = (Array.isArray(seriesInput) ? seriesInput : [])
    .map((item, index) => ({
      name: String(item.name || ""),
      data: pointsFrom(item.data, options.gaps),
      muted: Boolean(item.muted),
      dashed: Boolean(item.dashed),
      index,
    }))
    .filter((item) => item.data.length);
  const values = series.flatMap((item) => item.data.map((point) => point.value)).filter((value) => value !== null);
  const observedMin = values.length ? Math.min(...values) : 0;
  const observedMax = values.length ? Math.max(...values) : 1;
  const margin = Math.max((observedMax - observedMin) * 0.08, Math.abs(observedMax) * 0.01, 1);
  const maxValue = options.includeZero === false ? observedMax + margin : Math.max(observedMax, 1);
  const minValue = options.includeZero === false ? observedMin - margin : 0;
  // Opt-in: round 1/2/2.5/5 steps instead of quarter splits such as 2,844.3.
  const nice = options.niceTicks ? niceScale(minValue, maxValue) : null;
  const lower = nice ? nice.min : minValue;
  const span = nice ? nice.max - nice.min : Math.max(maxValue - minValue, 1);
  const tickValues = nice ? [...nice.ticks].reverse() : [0, 1, 2, 3, 4].map((index) => minValue + span * (1 - index / 4));
  const tickStep = nice ? nice.step : span / 4;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  // The calendar domain can extend past observed points without inventing future values.
  const axisLabels = Array.isArray(options.axisLabels) ? options.axisLabels.map(String)
    : (series[0]?.data || []).map(point => point.label);
  const maxPoints = Math.max(axisLabels.length, ...series.map((item) => item.data.length), 1);
  const x = (index) => padding.left + (maxPoints <= 1 ? plotWidth / 2 : (index / (maxPoints - 1)) * plotWidth);
  const y = (value) => padding.top + plotHeight - ((value - lower) / span) * plotHeight;

  const grid = [];
  for (const value of tickValues) {
    const yValue = y(value);
    grid.push(
      '<line class="chart-grid" x1="' + padding.left + '" y1="' + yValue + '" x2="' + (width - padding.right) + '" y2="' + yValue + '"></line>' +
      '<text class="chart-axis-label chart-axis-y" x="' + (padding.left - 12) + '" y="' + (yValue + 4) + '">' +
      escapeHtml(typeof options.axisValueFormatter === 'function' ? options.axisValueFormatter(value, tickStep, tickValues) : compactNumber(value, options.language)) + "</text>",
    );
  }

  const labels = [];
  const labelCount = Math.min(axisLabels.length, Math.max(2, Math.floor(Number(options.maxAxisLabels) || 7)));
  // Opt-in: one fixed interval between labelled points, so dates are not spaced 4, 4, 3, 4 apart.
  const labelStep = options.evenLabels && axisLabels.length > labelCount ? Math.ceil((axisLabels.length - 1) / (labelCount - 1)) : 0;
  const labelIndexes = labelStep ? Array.from({ length: Math.floor((axisLabels.length - 1) / labelStep) + 1 }, (_, tick) => tick * labelStep)
    : Array.from({ length: labelCount }, (_, tick) => labelCount === 1 ? 0 : Math.round(tick * (axisLabels.length - 1) / (labelCount - 1)));
  for (const [tick, index] of labelIndexes.entries()) {
    const anchor = labelIndexes.length === 1 ? 'middle' : tick === 0 ? 'start' : index === axisLabels.length - 1 ? 'end' : 'middle';
    labels.push(
      '<text class="chart-axis-label chart-axis-x" text-anchor="' + anchor + '" x="' + x(index) + '" y="' + (height - 10) + '">' +
      escapeHtml(typeof options.axisLabelFormatter === 'function' ? options.axisLabelFormatter(axisLabels[index]) : axisLabels[index]) + "</text>",
    );
  }

  const paths = series.map((item) => {
    const path = item.data
      .map((point, index) => point.value === null ? '' : (index === 0 || item.data[index - 1].value === null ? "M" : "L") + x(index).toFixed(2) + " " + y(point.value).toFixed(2))
      .join(" ");
    const points = item.data
      .map((point, index) => {
        if (point.value === null) return '';
        const isolated = options.gaps && item.data[index - 1]?.value == null && item.data[index + 1]?.value == null;
        if (options.hoverDetails) {
          const amount = typeof options.valueFormatter === 'function' ? options.valueFormatter(point.value, point.raw) : formatJpy(point.value, options.language);
          return '<g class="agent-line-hover"' + chartHoverAttrs(point.label + (item.name ? ' / ' + item.name : ''), amount) + '>' +
            '<circle class="agent-chart-hit" cx="' + x(index) + '" cy="' + y(point.value) + '" r="10"/>' +
            '<circle class="chart-point' + (isolated ? ' is-isolated' : '') + '" cx="' + x(index) + '" cy="' + y(point.value) + '" r="3.5"/></g>';
        }
        return (
          '<circle class="chart-point' + (isolated ? ' is-isolated' : '') + '" cx="' + x(index) + '" cy="' + y(point.value) + '" r="3.5">' +
          (options.inspectColumns ? '' : "<title>" + escapeHtml(point.label + " · " + (typeof options.valueFormatter === 'function'
            ? options.valueFormatter(point.value, point.raw) : formatJpy(point.value, options.language))) + "</title>") + "</circle>"
        );
      })
      .join("");
    return (
      '<g class="chart-series ' + (item.muted ? "is-muted " : "") + (item.dashed ? "is-dashed" : "") + '">' +
      '<path class="chart-line" d="' + path + '"></path>' + points + "</g>"
    );
  });

  const legend = series.length > 1
    ? '<div class="chart-legend">' +
      series.map((item) => '<span class="' + (item.muted ? "muted-series" : "") + '"><i></i>' + escapeHtml(item.name) + "</span>").join("") +
      "</div>"
    : "";

  const reference = options.referenceLine;
  const referenceIndex = reference?.key == null ? -1 : (series[0]?.data || []).findIndex(point => point.raw?.key === reference.key);
  let referenceMarkup = '';
  if (referenceIndex >= 0) {
    const position = x(referenceIndex);
    const alignRight = position > padding.left + plotWidth / 2;
    referenceMarkup = '<g class="chart-reference" data-reference-key="' + escapeAttr(reference.key) + '">' +
      '<title>' + escapeHtml(reference.label + ' · ' + reference.key) + '</title>' +
      '<line class="chart-reference-line" x1="' + position + '" x2="' + position + '" y1="' + padding.top +
      '" y2="' + (height - padding.bottom) + '"/>' +
      '<text class="chart-reference-label" text-anchor="' + (alignRight ? 'end' : 'start') + '" x="' +
      (position + (alignRight ? -6 : 6)) + '" y="' + (padding.top - 8) + '">' + escapeHtml(reference.label) + '</text></g>';
  }

  const inspection = (options.inspectColumns || []).slice(0, maxPoints).map((details, index) => {
    const position = x(index);
    const left = index === 0 ? padding.left : (x(index - 1) + position) / 2;
    const right = index === maxPoints - 1 ? width - padding.right : (position + x(index + 1)) / 2;
    const dots = series.map(item => {
      const point = item.data[index];
      if (point?.value == null || details.available?.[item.index] === false) return '';
      return '<circle class="chart-inspect-point' + (item.muted ? ' is-muted' : '') + '" cx="' + position +
        '" cy="' + y(point.value) + '" r="4"/>';
    }).join('');
    return '<g class="chart-inspect-column" data-inspect-index="' + index + '"' + chartHoverAttrs(details.label, details.value) +
      (Array.isArray(details.rows) ? ' data-tip-rows="' + escapeAttr(JSON.stringify(details.rows)) + '"' : '') + '>' +
      '<rect class="chart-inspect-hit" x="' + left + '" y="' + padding.top + '" width="' + (right - left) + '" height="' + plotHeight + '"/>' +
      '<g class="chart-inspect-marker" aria-hidden="true"><line class="chart-reference-line" x1="' + position + '" x2="' + position +
      '" y1="' + padding.top + '" y2="' + (height - padding.bottom) + '"/>' + dots + '</g></g>';
  }).join('');

  return (
    '<div class="chart-frame"' + motionAttrs(options, 'line',
      series.map((item) => item.data.map((point) => [point.label, point.value])),
      series.map((item) => item.data.map((point) => String(point.raw?.key ?? point.raw?.date ?? point.label)))) + '>' +
    '<svg class="line-chart" viewBox="0 0 ' + width + " " + height + '" role="' + (options.hoverDetails || options.inspectColumns ? 'group' : 'img') + '" aria-label="' + escapeAttr(options.label || "Line chart") + '">' +
    grid.join("") + labels.join("") + paths.join("") + referenceMarkup + inspection +
    "</svg>" +
    legend +
    "</div>"
  );
}

export function horizontalBars(dataInput, options = {}) {
  const data = pointsFrom(dataInput).slice(0, Number(options.limit || 8));
  const max = Math.max(...data.map((item) => Math.abs(item.value)), 1);
  if (!data.length) return '<div class="chart-empty">—</div>';
  return (
    '<div class="horizontal-bars"' + motionAttrs(options, 'bars', data.map((item) => [item.label, item.value])) + '>' +
    data
      .map((item, index) => {
        const width = Math.max(2, (Math.abs(item.value) / max) * 100);
        const amount = typeof options.valueFormatter === 'function' ? options.valueFormatter(item.value, item.raw) : formatJpy(item.value, options.language);
        return (
          (options.hoverDetails ? '<div class="bar-row"' + chartHoverAttrs(item.label, amount) + '>' :
            '<button class="bar-row" type="button" data-chart-label="' + escapeAttr(item.label) + '">') +
          '<span class="bar-rank">' + String(index + 1).padStart(2, "0") + "</span>" +
          '<span class="bar-label">' + escapeHtml(item.label) + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="width:' + width.toFixed(2) + '%"></span></span>' +
          '<strong class="bar-value">' +
          escapeHtml(amount) +
          "</strong>" +
          (options.hoverDetails ? '</div>' : '</button>')
        );
      })
      .join("") +
    "</div>"
  );
}

export function deltaBars(dataInput, options = {}) {
  const data = (Array.isArray(dataInput) ? dataInput : []).slice(0, Number(options.limit || 7));
  const max = Math.max(...data.map((item) => Math.abs(finite(item.delta))), 1);
  if (!data.length) return '<div class="chart-empty">—</div>';
  return (
    '<div class="delta-bars"' + motionAttrs(options, 'delta', data.map((item) => [item.label, finite(item.delta)])) + '>' +
    data
      .map((item, index) => {
        const delta = finite(item.delta);
        const width = delta === 0 ? 0 : Math.max(2, (Math.abs(delta) / max) * 50);
        const side = delta >= 0 ? "positive" : "negative";
        const amount = options.valueFormatter ? options.valueFormatter(delta) : formatJpy(delta, options.language);
        const detail = options.hoverFormatter ? options.hoverFormatter(item) : amount;
        return (
          (options.hoverDetails ? '<div class="delta-row"' + chartHoverAttrs(item.label, detail) + '>' :
            '<button class="delta-row" type="button" data-chart-label="' + escapeAttr(item.label) + '">') +
          '<span class="bar-rank">' + String(index + 1).padStart(2, "0") + "</span>" +
          '<span class="bar-label">' + escapeHtml(item.label) + "</span>" +
          '<span class="delta-track"><span class="delta-fill finance-fill ' + side + '"' + financeAttr(delta, options.meaning || 'balance') + ' style="width:' + width.toFixed(2) + '%"></span></span>' +
          '<strong class="bar-value ' + side + '"' + financeAttr(delta, options.meaning || 'balance') + '>' + escapeHtml(amount) + "</strong>" +
          (options.hoverDetails ? '</div>' : '</button>')
        );
      })
      .join("") +
    "</div>"
  );
}

function polar(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function arcPath(cx, cy, outer, inner, start, end) {
  const outerStart = polar(cx, cy, outer, end);
  const outerEnd = polar(cx, cy, outer, start);
  const innerStart = polar(cx, cy, inner, start);
  const innerEnd = polar(cx, cy, inner, end);
  const large = end - start <= 180 ? 0 : 1;
  return [
    "M", outerStart.x, outerStart.y,
    "A", outer, outer, 0, large, 0, outerEnd.x, outerEnd.y,
    "L", innerStart.x, innerStart.y,
    "A", inner, inner, 0, large, 1, innerEnd.x, innerEnd.y,
    "Z",
  ].join(" ");
}

export function interactivePieSlice({ cx, cy, outer, inner, start, end, index, label, value, fill, className = 'agent-pie-segment', style = '' }) {
  if (!(end > start)) return '';
  // Two semicircles are needed for a complete ring; a single 360-degree SVG arc is empty.
  const ring = (radius) => ['M', cx, cy - radius, 'A', radius, radius, 0, 1, 1, cx, cy + radius,
    'A', radius, radius, 0, 1, 1, cx, cy - radius, 'Z'].join(' ');
  const path = end - start >= 360 - 1e-8 ? ring(outer) + (inner ? ' ' + ring(inner) : '') : arcPath(cx, cy, outer, inner, start, end);
  const offset = polar(0, 0, 7, (start + end) / 2);
  return '<g class="agent-pie-hover" data-agent-pie-index="' + index + '"' + chartHoverAttrs(label, value) +
    ' style="--pie-x:' + offset.x.toFixed(3) + 'px;--pie-y:' + offset.y.toFixed(3) + 'px">' +
    '<path class="agent-chart-hit" fill-rule="evenodd" d="' + path + '"/>' +
    '<g class="agent-pie-offset"><path class="' + className + '" fill-rule="evenodd" d="' + path + '"' +
    (fill ? ' fill="' + escapeAttr(fill) + '"' : '') + (style ? ' style="' + escapeAttr(style) + '"' : '') + '/></g></g>';
}

export function donutChart(dataInput, options = {}) {
  const data = pointsFrom(dataInput).filter((item) => item.value > 0);
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (!data.length || total <= 0) return '<div class="chart-empty">—</div>';
  let cursor = 0;
  const slices = data.map((item, index) => {
    const size = (item.value / total) * 360;
    const start = cursor;
    const end = cursor + size;
    cursor = end;
    const opacity = Math.max(0.24, 1 - index * 0.1);
    if (options.hoverDetails) return interactivePieSlice({ cx: 92, cy: 92, outer: 78, inner: 46, start, end, index,
      label: item.label, value: formatJpy(item.value, options.language) + ' (' + (size / 3.6).toFixed(1) + '%)',
      className: 'donut-slice', style: '--slice-opacity:' + opacity.toFixed(2) });
    return (
      '<path class="donut-slice" data-index="' + index + '" d="' + arcPath(92, 92, 78, 46, start, end) +
      '" style="--slice-opacity:' + opacity.toFixed(2) + '">' +
      "<title>" + escapeHtml(item.label + " · " + formatJpy(item.value, options.language)) + "</title></path>"
    );
  });
  const legend = data
    .slice(0, 7)
    .map((item, index) => {
      const percent = (item.value / total) * 100;
      return (
        '<div class="donut-legend-row"' + (options.hoverDetails ? ' data-agent-pie-index="' + index + '"' +
          chartHoverAttrs(item.label, formatJpy(item.value, options.language) + ' (' + percent.toFixed(1) + '%)') : '') + '><i style="opacity:' + Math.max(0.24, 1 - index * 0.1).toFixed(2) + '"></i>' +
        '<span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(percent.toFixed(1) + "%") + "</strong></div>"
      );
    })
    .join("");
  return (
    '<div class="donut-layout"' + motionAttrs(options, 'donut', data.map((item) => [item.label, item.value])) + '><div class="donut-figure"><svg viewBox="0 0 184 184" role="' + (options.hoverDetails ? 'group' : 'img') + '" aria-label="' +
    escapeAttr(options.label || "Distribution") + '">' + slices.join("") +
    '<text class="donut-total-label" x="92" y="86" text-anchor="middle">TOTAL</text>' +
    '<text class="donut-total" x="92" y="108" text-anchor="middle">' + escapeHtml(compactNumber(total, options.language)) +
    "</text></svg></div><div class=\"donut-legend\">" + legend + "</div></div>"
  );
}

export function progressChart(current, target, options = {}) {
  const safeTarget = Math.max(finite(target), 1);
  const ratio = Math.min(1, Math.max(0, finite(current) / safeTarget));
  const planned = Math.min(1, Math.max(0, finite(options.plannedRatio)));
  return (
    '<div class="goal-progress-chart"' + motionAttrs(options, 'progress', [finite(current), safeTarget, planned]) + '>' +
    '<div class="goal-progress-track"><span class="goal-progress-fill finance-fill"' + financeAttr(current) + ' style="width:' + (ratio * 100).toFixed(2) + '%"></span>' +
    '<i class="goal-progress-plan" style="left:' + (planned * 100).toFixed(2) + '%"></i></div>' +
    '<div class="goal-progress-labels"><span' + financeAttr(current) + '>' + escapeHtml(formatJpy(current, options.language)) + "</span><span>" +
    escapeHtml(formatJpy(target, options.language)) + "</span></div></div>"
  );
}

export function comparisonTable(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return '<div class="chart-empty">—</div>';
  const columns = options.columns || [
    { key: "label", label: "Item" },
    { key: "current", label: "Current" },
    { key: "previous", label: "Previous" },
    { key: "delta", label: "Delta" },
  ];
  return (
    '<div class="compact-table-wrap"><table class="compact-table"><thead><tr>' +
    columns.map((column) => "<th>" + escapeHtml(column.label) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows.map((row) => "<tr>" + columns.map((column) => {
      const raw = row[column.key];
      const value = column.format === "jpy" ? formatJpy(raw, options.language) : String(raw ?? "—");
      return '<td' + financeAttr(raw, financeColumnMeaning({ ...column, type: column.format === 'jpy' ? 'money' : column.type })) + '>' + escapeHtml(value) + "</td>";
    }).join("") + "</tr>").join("") +
    "</tbody></table></div>"
  );
}

export function renderAgentPanelVisual(panel, language, options = {}) {
  const type = String(panel?.type || "line").toLowerCase();
  let body = "";
  if (type === "bar") body = horizontalBars(panel.data, { ...options, language, limit: 10 });
  else if (type === "pie") body = donutChart(panel.data, { ...options, language });
  else if (type === "table") body = agentTable(panel, language);
  else body = lineChart([{ name: panel.title, data: panel.data }], { ...options, language, height: 230 });
  return (
    '<article class="agent-visual-card" data-visual-id="' + escapeAttr(panel.id || "") + '">' +
    '<header><div><p class="section-label">' + escapeHtml(type.toUpperCase()) + "</p><h3>" +
    escapeHtml(panel.title || "Analysis") + "</h3>" +
    (panel.subtitle ? "<p>" + escapeHtml(panel.subtitle) + "</p>" : "") +
    "</div></header>" + body + "</article>"
  );
}

function agentTable(panel, language) {
  const rows = Array.isArray(panel.data) ? panel.data : [];
  if (!rows.length) return '<div class="chart-empty">—</div>';
  const columns = Array.isArray(panel.columns) && panel.columns.length
    ? panel.columns
    : Object.keys(rows[0]).map((key) => ({ key, label: key }));
  return comparisonTable(rows, {
    language,
    columns: columns.map((column) => ({
      key: column.key || column.name,
      label: column.label || column.title || column.key || column.name,
      format: column.format,
      type: column.type,
    })),
  });
}
