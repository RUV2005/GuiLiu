import { DEFAULT_RATES } from "./config.js";
import { localeFor } from "./i18n.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll(String.fromCharCode(96), "&#096;");
}

export function normalizeServiceBase(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) return String(fallback || "").replace(/\/+$/, "");
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  if (raw.startsWith("/")) return raw.replace(/\/+$/, "");
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+):\d+$/i.test(raw)) {
    return ("http://" + raw).replace(/\/+$/, "");
  }
  return raw.replace(/\/+$/, "");
}

export function currencyName(code) {
  if (code === undefined || code === null || code === "") return "-";
  const raw = String(code).trim();
  if (!raw) return "-";
  const numeric = Number(raw);
  if (numeric === 101) return "JPY";
  if (numeric === 100 || numeric === 1 || numeric === 0) return "CNY";
  const upper = raw.toUpperCase();
  if (upper === "JPY" || raw === "日元" || raw === "円") return "JPY";
  if (upper === "RMB" || upper === "CNY" || raw === "人民币" || raw === "元") return "CNY";
  return upper || "-";
}

export function exchangeRateToJpy(currency, rates = DEFAULT_RATES) {
  const name = currencyName(currency);
  if (name === "JPY") return 1;
  if (name === "CNY") {
    const rate = Number(rates.RMB || rates.CNY || DEFAULT_RATES.CNY);
    return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_RATES.RMB;
  }
  return null;
}

export function amountToJpy(value, currency, rates = DEFAULT_RATES) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  const rate = exchangeRateToJpy(currency, rates);
  return rate ? amount * rate : amount;
}

export function formatAmount(value, currency, language = "zh") {
  if (value === null || value === undefined || String(value).trim() === '') return "-";
  const amount = Number(value);
  const name = currencyName(currency);
  if (!Number.isFinite(amount)) return String(value ?? "-");
  const fraction = Math.abs(amount % 1) > 0.000001;
  const digits = fraction ? 2 : 0;
  return amount.toLocaleString(localeFor(language), {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  }) + " " + name;
}

export function formatJpy(value, language = "zh") {
  const amount = Number(value);
  const rounded = Number.isFinite(amount) ? Math.round(amount) : 0;
  return rounded.toLocaleString(localeFor(language), {
    maximumFractionDigits: 0,
  }) + " JPY";
}

export function formatSignedJpy(value, language = "zh") {
  const amount = Number(value);
  const prefix = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return prefix + formatJpy(Math.abs(amount), language);
}

export function formatDealAmount(value, currency, language, rates) {
  const original = formatAmount(value, currency, language);
  if (currencyName(currency) === "JPY") return original;
  return formatJpy(amountToJpy(value, currency, rates), language) + " (" + original + ")";
}

export function formatPercent(value, language = "zh", digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(localeFor(language), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }) + "%";
}

export function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value, language = "zh") {
  const date = toDate(value);
  if (!date) return String(value || "—");
  return date.toLocaleString(localeFor(language), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(value, language = "zh") {
  const date = toDate(value);
  if (!date) return String(value || "—");
  return date.toLocaleDateString(localeFor(language), {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function formatShortDate(value, language = "zh") {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString(localeFor(language), {
    month: "numeric",
    day: "numeric",
  });
}

export function formatTime(value, language = "zh") {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleTimeString(localeFor(language), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function dateInputValue(value) {
  const date = toDate(value);
  if (!date) return String(value || "").slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day].join("-");
}

export function datetimeInputValue(value) {
  const date = toDate(value);
  if (!date) return String(value || "").slice(0, 16);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return dateInputValue(date) + "T" + hours + ":" + minutes;
}

export function todayKey() {
  return dateInputValue(new Date());
}

export function monthKey(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

export function startOfDay(value) {
  const date = toDate(value);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function endOfDay(value) {
  const date = toDate(value);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

export function addDays(value, days) {
  const date = toDate(value) || new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

export function addCycle(dateText, frequency) {
  const date = startOfDay(dateText) || startOfDay(new Date());
  if (frequency === "daily") date.setDate(date.getDate() + 1);
  else if (frequency === "weekly") date.setDate(date.getDate() + 7);
  else if (frequency === "yearly") date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  return dateInputValue(date);
}

export function looksLikeShiftedDeal(deal) {
  const isoValue = Number(deal?.ISOtime);
  return Number.isFinite(isoValue) && (isoValue === 100 || isoValue === 101);
}

export function dealHasAdr(deal) {
  const value = deal?.ADRresult;
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) ? number > 0 : true;
}

export function normalizeDeal(input) {
  const deal = input || {};
  const normalized = looksLikeShiftedDeal(deal)
    ? {
        DealingNumber: deal.DealingNumber,
        ShopName: deal.ShopName,
        price: deal.CurrencyTypeNumber,
        CurrencyTypeNumber: deal.ISOtime,
        ISOtime: deal.MainCategory,
        MainCategory: deal.SubCategory,
        SubCategory: deal.AccountNumber,
        AccountNumber: deal.price,
        DetailCategory: deal.DetailCategory || "",
        ADRresult: deal.ADRresult,
      }
    : { ...deal };

  normalized.DealingNumber = normalized.DealingNumber ?? normalized.dealing_number ?? normalized.id;
  normalized.ShopName = normalized.ShopName ?? normalized.shop_name ?? "";
  normalized.price = Number(normalized.price ?? normalized.Price ?? normalized.amount ?? 0);
  normalized.CurrencyTypeNumber = normalized.CurrencyTypeNumber ?? normalized.currency_type_number ?? 101;
  normalized.ISOtime = normalized.ISOtime ?? normalized.isotime ?? normalized.iso_time ?? "";
  normalized.MainCategory = normalized.MainCategory ?? normalized.main_category ?? "";
  normalized.SubCategory = normalized.SubCategory ?? normalized.sub_category ?? "";
  normalized.DetailCategory = normalized.DetailCategory ?? normalized.detail_category ?? "";
  normalized.AccountNumber = normalized.AccountNumber ?? normalized.account_number ?? "";
  normalized.ADRresult = normalized.ADRresult ?? normalized.adr_result ?? null;
  return normalized;
}

export function dealUpdatePayload(deal, overrides = {}) {
  return {
    shop_name: String(overrides.ShopName ?? deal.ShopName ?? ""),
    price: Number(overrides.price ?? deal.price ?? 0),
    CurrencyTypeNumber: Number(overrides.CurrencyTypeNumber ?? deal.CurrencyTypeNumber ?? 101),
    isotime: String(overrides.ISOtime ?? deal.ISOtime ?? new Date().toISOString()),
    main_category: String(overrides.MainCategory ?? deal.MainCategory ?? ""),
    sub_category: String(overrides.SubCategory ?? deal.SubCategory ?? ""),
    AccountNumber: String(overrides.AccountNumber ?? deal.AccountNumber ?? ""),
  };
}

export function contextRange(range, now = new Date()) {
  const end = endOfDay(now);
  if (range === "all") return { start: null, end, label: "all" };
  if (range === "today") return { start: startOfDay(end), end, label: "today" };
  if (range === "7d") return { start: startOfDay(addDays(end, -6)), end, label: "7d" };
  if (range === "30d") return { start: startOfDay(addDays(end, -29)), end, label: "30d" };
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { start, end, label: "month" };
}

export function previousRange(range, now = new Date()) {
  const current = contextRange(range, now);
  if (!current.start) return { start: null, end: null, label: "none" };
  if (range === "month") {
    const end = new Date(current.start.getTime() - 1);
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return { start, end, label: "previous-month" };
  }
  const duration = current.end.getTime() - current.start.getTime() + 1;
  const end = new Date(current.start.getTime() - 1);
  return {
    start: new Date(end.getTime() - duration + 1),
    end,
    label: "previous",
  };
}

// Headlines compare month-to-date with the same calendar days, not a full month.
// The full previousRange remains available for monthly charts and the Engel ratio.
export function comparablePreviousRange(range, now = new Date()) {
  const previous = previousRange(range, now);
  if (range !== 'month') return previous;
  const day = Math.min(now.getDate(), previous.end.getDate());
  return { ...previous, end: endOfDay(new Date(previous.start.getFullYear(), previous.start.getMonth(), day)), label: 'previous-month-to-date' };
}

export function dealInRange(deal, range) {
  const date = toDate(deal.ISOtime);
  if (!date) return false;
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

export function filterByContext(deals, settings, now = new Date()) {
  const range = contextRange(settings.contextRange, now);
  return deals.filter((deal) => {
    if (!dealInRange(deal, range)) return false;
    if (settings.contextAccount !== "all" && String(deal.AccountNumber) !== String(settings.contextAccount)) {
      return false;
    }
    return true;
  });
}

export function totalJpy(deals, rates) {
  return deals.reduce((sum, deal) => sum + amountToJpy(deal.price, deal.CurrencyTypeNumber, rates), 0);
}

export function numberOfDays(range, deals = []) {
  if (range.start && range.end) {
    return Math.max(1, Math.ceil((range.end - range.start + 1) / 86400000));
  }
  let first = Infinity;
  let last = -Infinity;
  for (const deal of deals) {
    const date = toDate(deal.ISOtime)?.getTime();
    if (date === undefined) continue;
    first = Math.min(first, date);
    last = Math.max(last, date);
  }
  return Number.isFinite(first) ? Math.max(1, Math.ceil((last - first + 1) / 86400000)) : 1;
}

export function groupSpend(deals, keyGetter, rates) {
  const map = new Map();
  for (const deal of deals) {
    const key = String(keyGetter(deal) || "Unclassified").trim() || "Unclassified";
    map.set(key, (map.get(key) || 0) + amountToJpy(deal.price, deal.CurrencyTypeNumber, rates));
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export function dailySeries(deals, range, rates) {
  if (!range.start || !range.end) return [];
  const values = new Map();
  for (const deal of deals) {
    const key = dateInputValue(deal.ISOtime);
    values.set(key, (values.get(key) || 0) + amountToJpy(deal.price, deal.CurrencyTypeNumber, rates));
  }
  const result = [];
  const cursor = new Date(range.start);
  while (cursor <= range.end && result.length < 366) {
    const key = dateInputValue(cursor);
    result.push({ key, label: key.slice(5).replace("-", "/"), value: values.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

export function hourlySeries(deals, day, rates) {
  const start = startOfDay(day?.start || day || new Date());
  if (!start) return [];
  const values = new Array(24).fill(0);
  for (const deal of Array.isArray(deals) ? deals : []) {
    const date = toDate(deal.ISOtime);
    if (!date || dateInputValue(date) !== dateInputValue(start)) continue;
    values[date.getHours()] += amountToJpy(deal.price, deal.CurrencyTypeNumber, rates);
  }
  return values.map((value, hour) => ({
    key: dateInputValue(start) + "T" + String(hour).padStart(2, "0"),
    label: String(hour).padStart(2, "0") + ":00",
    value,
  }));
}

export function monthlySeries(deals, rates, limit = 12) {
  const map = new Map();
  for (const deal of deals) {
    const key = monthKey(deal.ISOtime);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + amountToJpy(deal.price, deal.CurrencyTypeNumber, rates));
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-limit)
    .map(([label, value]) => ({ label, value }));
}

export function comparisonByGroup(currentDeals, previousDeals, keyGetter, rates) {
  const current = new Map(groupSpend(currentDeals, keyGetter, rates).map((item) => [item.label, item.value]));
  const previous = new Map(groupSpend(previousDeals, keyGetter, rates).map((item) => [item.label, item.value]));
  const keys = new Set([...current.keys(), ...previous.keys()]);
  return [...keys]
    .map((label) => ({
      label,
      current: current.get(label) || 0,
      previous: previous.get(label) || 0,
      delta: (current.get(label) || 0) - (previous.get(label) || 0),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export function isUnclassified(deal) {
  const main = String(deal.MainCategory || "").trim().toLowerCase();
  const sub = String(deal.SubCategory || "").trim().toLowerCase();
  const invalid = new Set(["", "-", "unknown", "unclassified", "待分类", "未分类", "不明"]);
  return invalid.has(main) || invalid.has(sub);
}

export function isFoodDeal(deal) {
  const source = [deal.MainCategory, deal.SubCategory, deal.ShopName].join(" ").toLowerCase();
  return [
    "food",
    "dining",
    "restaurant",
    "meal",
    "餐",
    "饮食",
    "飲食",
    "外卖",
    "外食",
    "コンビニ",
    "便利店",
    "uber",
  ].some((keyword) => source.includes(keyword));
}

export function engelCoefficient(deals, rates) {
  const total = totalJpy(deals, rates);
  const food = totalJpy(deals.filter(isFoodDeal), rates);
  if (!Number.isFinite(total) || !Number.isFinite(food) || total <= 0 || food < 0 || food > total) return null;
  return food / total * 100;
}

export function detectDuplicateGroups(deals, maxMinutes = 30) {
  const sorted = deals.map((deal) => ({ deal, time: toDate(deal.ISOtime)?.getTime() || 0, price: Number(deal.price) }))
    .sort((left, right) => left.time - right.time);
  const buckets = new Map();
  for (const [index, row] of sorted.entries()) {
    row.index = index;
    row.key = JSON.stringify([String(row.deal.ShopName || '').trim().toLowerCase(), currencyName(row.deal.CurrencyTypeNumber)]);
    row.bin = Math.floor(row.price * 1000);
    if (!row.time || !Number.isFinite(row.price)) continue;
    if (!buckets.has(row.key)) buckets.set(row.key, new Map());
    const amounts = buckets.get(row.key);
    if (!amounts.has(row.bin)) amounts.set(row.bin, []);
    amounts.get(row.bin).push(row);
  }
  const groups = [];
  const used = new Set();
  for (const left of sorted) {
    if (used.has(String(left.deal.DealingNumber)) || !left.time || !Number.isFinite(left.price)) continue;
    const matches = [left];
    const amounts = buckets.get(left.key);
    // Only inspect nearby amounts at this merchant, then bound the scan by time.
    for (const bin of new Set([left.bin - 2, left.bin - 1, left.bin, left.bin + 1, left.bin + 2])) {
      const candidates = amounts.get(bin) || [];
      let low = 0;
      let high = candidates.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (candidates[middle].index <= left.index) low = middle + 1;
        else high = middle;
      }
      for (let cursor = low; cursor < candidates.length; cursor += 1) {
        const right = candidates[cursor];
        const minutes = (right.time - left.time) / 60000;
        if (minutes > maxMinutes) break;
        if (Math.abs(left.price - right.price) < 0.001 && minutes <= maxMinutes) matches.push(right);
      }
    }
    if (matches.length > 1) {
      matches.sort((left, right) => left.index - right.index);
      matches.forEach((row) => used.add(String(row.deal.DealingNumber)));
      groups.push(matches.map((row) => row.deal));
    }
  }
  return groups;
}

export function normalizeChatHistory(messages, now = Date.now()) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && ['user', 'assistant'].includes(message.role))
    .map((message) => ({
      ...message,
      id: String(message.id || "chat-" + now + "-" + Math.random().toString(36).slice(2, 8)),
      role: ["user", "assistant", "tool"].includes(message.role) ? message.role : "assistant",
      content: String(message.content || "").trim(),
      timestamp: message.timestamp || new Date(now).toISOString(),
      retryable: Boolean(message.retryable),
    }))
    .filter((message) => {
      const timestamp = toDate(message.timestamp)?.getTime();
      return timestamp !== undefined && Number.isFinite(timestamp);
    });
}

export function parseMaybeJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

export function isVisualPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return Boolean(
    payload.abk_visual ||
      payload.visual ||
      Array.isArray(payload.panels) ||
      Array.isArray(payload.visual_panels) ||
      Array.isArray(payload.visualPanels) ||
      Array.isArray(payload.charts) ||
      (payload.type && (payload.data || payload.rows || payload.values || payload.series)),
  );
}

function visualFenceRegex() {
  const fence = String.fromCharCode(96).repeat(3);
  return new RegExp(fence + "(?:abk_visual|chart|json)?\\s*([\\s\\S]*?)" + fence, "gi");
}

export function extractVisualPayloads(text) {
  const source = String(text || "");
  const payloads = [];
  const pattern = visualFenceRegex();
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const parsed = parseMaybeJson(match[1]);
    if (Array.isArray(parsed)) payloads.push(...parsed.filter(isVisualPayload));
    else if (isVisualPayload(parsed)) payloads.push(parsed);
  }
  const trimmed = source.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseMaybeJson(trimmed);
    if (Array.isArray(parsed)) payloads.push(...parsed.filter(isVisualPayload));
    else if (isVisualPayload(parsed)) payloads.push(parsed);
  }
  return payloads;
}

export function visualPanelsFromPayload(payload, index = 0) {
  const charts =
    payload.panels ||
    payload.visual_panels ||
    payload.visualPanels ||
    payload.charts ||
    payload.chart ||
    (payload.type ? payload : []);
  const list = Array.isArray(charts) ? charts : [charts];
  return list
    .filter((item) => item && typeof item === "object")
    .map((item, chartIndex) => {
      const type = String(item.type || item.chart_type || item.kind || "line").toLowerCase();
      return {
        id: String(item.id || "agent-" + Date.now() + "-" + index + "-" + chartIndex),
        type: ["line", "bar", "pie", "table"].includes(type) ? type : "line",
        title: String(item.title || item.name || "Analysis"),
        subtitle: String(item.subtitle || item.description || ""),
        data: item.data || item.values || item.rows || item.series || [],
        columns: item.columns || null,
      };
    });
}

export function visualMessage(text, payloads) {
  const explicit = payloads
    .map((payload) => payload.message || payload.answer || payload.text || payload.summary)
    .find((value) => String(value || "").trim());
  if (explicit) return String(explicit).trim();
  const stripped = String(text || "")
    .replace(visualFenceRegex(), (full, body) => {
      return isVisualPayload(parseMaybeJson(body)) ? "" : full;
    })
    .trim();
  return stripped || "";
}

export function simpleRichText(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const output = [];
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    output.push("<ul>" + list.map((item) => "<li>" + inlineText(item) + "</li>").join("") + "</ul>");
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    flushList();
    if (/^#{1,3}\s+/.test(line)) {
      const level = Math.min(4, line.match(/^#+/)[0].length + 1);
      output.push("<h" + level + ">" + inlineText(line.replace(/^#{1,3}\s+/, "")) + "</h" + level + ">");
    } else {
      output.push("<p>" + inlineText(line) + "</p>");
    }
  }
  flushList();
  return output.join("");
}

function inlineText(value) {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function stableFingerprint(value) {
  return JSON.stringify(value ?? null);
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    const normalized = text.toLowerCase();
    if (!text || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(text);
  }
  return result;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}
