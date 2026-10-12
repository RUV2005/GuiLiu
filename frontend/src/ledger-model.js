import { amountToJpy, dealHasAdr, endOfDay, startOfDay, toDate } from './utils.js';

// One entry per selector, so changing filters cannot grow the cache indefinitely.
export function createMemo() {
  const entries = new Map();
  return (name, dependencies, compute) => {
    const previous = entries.get(name);
    if (previous && dependencies.length === previous.dependencies.length &&
        dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) return previous.value;
    const value = compute();
    entries.set(name, { dependencies, value });
    return value;
  };
}

export function equalData(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && equalData(left[key], right[key]));
}

export function reconcileDeals(previous, incoming) {
  const byId = new Map(previous.map((row) => [String(row.DealingNumber), row]));
  const changedIds = new Set();
  const rows = incoming.map((row) => {
    const id = String(row.DealingNumber);
    const old = byId.get(id);
    byId.delete(id);
    if (old && equalData(old, row)) return old;
    changedIds.add(id);
    return row;
  });
  for (const id of byId.keys()) changedIds.add(id);
  const changed = rows.length !== previous.length || rows.some((row, index) => row !== previous[index]);
  return { rows: changed ? rows : previous, changed, changedIds };
}

export function transactionIndex(deals, rates) {
  return deals.map((deal) => ({
    deal,
    time: toDate(deal.ISOtime)?.getTime() ?? null,
    amount: amountToJpy(deal.price, deal.CurrencyTypeNumber, rates),
    id: String(deal.DealingNumber).toLowerCase(),
    shop: String(deal.ShopName || '').toLowerCase(),
    mainCategory: String(deal.MainCategory || '').toLowerCase(),
    subCategory: String(deal.SubCategory || '').toLowerCase(),
  }));
}

export function filterTransactions(index, filters, sort) {
  const queries = ['id', 'shop', 'mainCategory', 'subCategory'].map((key) => [key, String(filters[key] || '').trim().toLowerCase()]);
  const start = filters.startDate ? startOfDay(filters.startDate)?.getTime() : null;
  const end = filters.endDate ? endOfDay(filters.endDate)?.getTime() : null;
  const direction = sort.direction === 'asc' ? 1 : -1;
  const field = sort.field === 'amount' ? 'amount' : 'time';
  return index.filter((row) => queries.every(([key, query]) => !query || row[key].includes(query)) &&
    (start == null || (row.time !== null && row.time >= start)) &&
    (end == null || (row.time !== null && row.time <= end)))
    .sort((left, right) => direction * ((left[field] || 0) - (right[field] || 0)))
    .map((row) => row.deal);
}

export const INITIAL_TRANSACTION_ROWS = 40;
export const ESTIMATED_TRANSACTION_HEIGHT = 56;

export function todayTransactionDeals(deals, account = 'all', now = new Date()) {
  const start = startOfDay(now)?.getTime(), end = endOfDay(now)?.getTime();
  return deals.filter(deal => {
    const time = toDate(deal.ISOtime)?.getTime();
    return time >= start && time <= end && (account === 'all' || String(deal.AccountNumber) === String(account));
  }).sort((a, b) => toDate(b.ISOtime) - toDate(a.ISOtime));
}

export function transactionAdrState(state, deal) {
  const id = String(deal.DealingNumber);
  const rows = state.adrByDeal[id] || [];
  const loading = Boolean(state.adrLoading[id]);
  const expandable = rows.length > 0 || dealHasAdr(deal) || loading;
  return { rows, loading, expandable, expanded: expandable && !state.collapsedAdrDeals?.has(id) };
}

export function transactionWindow(rows, items, totalSize, scrollMargin = 0) {
  const first = items[0];
  const last = items.at(-1);
  return {
    rows: items.map((item) => rows[item.index]).filter(Boolean),
    top: Math.max(0, (first?.start ?? scrollMargin) - scrollMargin),
    bottom: Math.max(0, totalSize - ((last?.end ?? scrollMargin) - scrollMargin)),
  };
}
