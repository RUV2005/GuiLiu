import { normalizePrimaryCurrency } from './config.js';
import { importOperationKey } from './import-model.js';

export const ASSET_PERIODS = ['1m', '3m', '6m', '1y'];
export const ACCOUNT_TYPES = ['bank', 'cash', 'ewallet', 'credit', 'other'];
export const assetCurrency = (value) => normalizePrimaryCurrency(value) === 'RMB' ? 'CNY' : 'JPY';
export const assetDisplayCurrency = state => assetCurrency(state.assetPreview.currency || state.settings.contextCurrency);
export const assetNumber = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export const japanDay = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const japanInputTime = (value = new Date()) => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 19);

export function historyRange(period, now = new Date()) {
  const end = japanDay(now);
  const first = new Date(end + 'T00:00:00Z');
  first.setUTCDate(first.getUTCDate() - ({ '1m': 29, '3m': 89, '6m': 179, '1y': 365 }[period] ?? 179));
  return { start_date: first.toISOString().slice(0, 10), end_date: end };
}

export function overviewAssetQuery(state, now = new Date()) {
  const account = state.settings.contextAccount || 'all';
  return { ...historyRange('1m', now), primary_currency: assetCurrency(state.settings.contextCurrency),
    account_number: account === 'all' ? undefined : String(account) };
}

export function assetHistoryPoint(row, date = row?.date) {
  return { date, value: row?.complete === true ? assetNumber(row.net_assets) : null,
    knownValue: row?.complete === false ? assetNumber(row.known_net_assets) : null,
    scope: Array.isArray(row?.included_accounts) ? [...new Set(row.included_accounts.map(String))].sort().join(',') : null };
}

export function assetHistoryScopeChanged(points) {
  return new Set(points.map(point => point.scope).filter(scope => scope !== null && scope !== undefined)).size > 1;
}

export function assetHistoryChange(points) {
  const first = points[0]?.value, last = points.at(-1)?.value;
  // This is the net-worth snapshot difference, including any disclosed account-scope changes.
  return first != null && last != null ? last - first : null;
}

export function assetHistorySeries(points, name, partialName) {
  const series = [{ name, data: points }];
  if (points.some(point => point.knownValue != null)) {
    // Bridge to complete neighbours without filling unknown days or treating subtotals as totals.
    series.push({ name: partialName, muted: true, dashed: true, data: points.map((point, index) => ({ ...point,
      partial: point.knownValue != null, value: point.knownValue ??
        (points[index - 1]?.knownValue != null || points[index + 1]?.knownValue != null ? point.value : null) })) });
  }
  return series;
}

export function decimalAmount(value, currency, { positive = false, nonnegative = false } = {}) {
  const raw = String(value ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  const places = assetCurrency(currency) === 'JPY' ? 0 : 2;
  if (!match || (match[3] || '').slice(places).replace(/0/g, '')) throw new Error('assetInvalidAmount');
  const whole = BigInt(match[2]);
  const fraction = (match[3] || '').slice(0, places).padEnd(places, '0');
  const minor = (whole * 10n ** BigInt(places) + BigInt(fraction || '0')) * (match[1] ? -1n : 1n);
  if ((positive && minor <= 0n) || (nonnegative && minor < 0n)) throw new Error('assetInvalidAmount');
  return (minor < 0n ? '-' : '') + whole.toString() + (places ? '.' + fraction : '');
}

// Aggregate API decimals without binary rounding in displayed subtotals.
export function sumAmounts(values, currency) {
  if (values.some((value) => assetNumber(value) === null)) return null;
  const places = assetCurrency(currency) === 'JPY' ? 0 : 2;
  const total = values.reduce((sum, value) => sum + BigInt(decimalAmount(value, currency).replace('.', '')), 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(places + 1, '0');
  return (total < 0n ? '-' : '') + (places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits);
}

export function createAssetState() {
  return { accounts: [], accountsLoaded: false, overview: null, history: null, loading: false, historyLoading: false, error: '', historyError: '',
    cachedAt: { accounts: 0, overview: 0, history: 0 },
    historyKey: '' };
}

export function findAssetAccount(state, id) {
  return state.assets.accounts.find((account) => String(account.account_number) === String(id));
}

export function incomeFormValues(row = {}) {
  const source = row.source && typeof row.source === 'object' && !Array.isArray(row.source) ? row.source : {};
  return { source_name: source.source_name ?? row.source_name ?? '', amount: source.amount ?? row.amount ?? '',
    currency: source.currency || row.currency ? assetCurrency(source.currency || row.currency) : '', settled_amount: source.settled_amount ?? (row.income_id != null ? row.amount : '') ?? '',
    needsVerification: row.income_id != null && (source.amount == null || !source.currency) };
}

export function assetsData(state) {
  const { assets, assetPreview: filters } = state;
  const currency = assetDisplayCurrency(state);
  const overview = assets.overview?.primary_currency === currency ? assets.overview : null;
  const accounts = assets.accounts.map(account => {
    const current = overview?.accounts?.find(item => String(item.account_number) === String(account.account_number));
    return { ...account, converted_balance: current?.converted_balance ?? null, included_in_assets: current?.included_in_assets };
  });
  const scoped = filters.account === 'all' ? accounts : accounts.filter((account) => String(account.account_number) === filters.account);
  const query = filters.query.toLocaleLowerCase();
  const visibleAccounts = scoped.filter((account) => (!query || [account.name, account.institution, account.account_number].join(' ').toLocaleLowerCase().includes(query)) &&
    (filters.kind === 'all' || (filters.kind === 'liability' ? assetNumber(account.balance) !== null && Number(account.balance) < 0 : account.account_type === filters.kind)));
  const nativeSort = visibleAccounts.every(account => assetNumber(account.converted_balance) === null) &&
    new Set(visibleAccounts.map(account => account.currency)).size === 1;
  visibleAccounts.sort((left, right) => {
    if (filters.sort === 'name') return left.name.localeCompare(right.name);
    const a = assetNumber(nativeSort ? left.balance : left.converted_balance), b = assetNumber(nativeSort ? right.balance : right.converted_balance);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return filters.sort === 'value-asc' ? a - b : b - a;
  });
  let summary = overview?.summary || { net: null, assets: null, liabilities: null };
  if (filters.account !== 'all') {
    const amount = scoped[0]?.converted_balance ?? null;
    summary = { net: amount, assets: amount === null ? null : Number(amount) > 0 ? amount : '0',
      liabilities: amount === null ? null : Number(amount) < 0 ? String(amount).replace('-', '') : '0' };
  }
  const expectedKey = JSON.stringify({ ...historyRange(filters.period), primary_currency: currency, account_number: filters.account === 'all' ? undefined : filters.account });
  const history = assets.historyKey === expectedKey && assets.history ? assets.history.items.map(item => assetHistoryPoint(item)) : [];
  const originalHistory = assets.historyKey === expectedKey && assets.history ? (assets.history.accounts || [])
    .filter(row => filters.account === 'all' || String(row.account_number) === filters.account)
    .map(row => ({ account_number: row.account_number, name: accounts.find(account => String(account.account_number) === String(row.account_number))?.name || '#' + row.account_number,
      currency: row.currency, points: (row.items || []).map(day => ({ date: day.date, value: assetNumber(day.closing_balance) })) }))
    .filter(row => row.points.some(point => point.value !== null)) : [];
  const change = assetHistoryChange(history);
  // Use gross balances for bar lengths so assets and debts cannot cancel out.
  const total = Number(sumAmounts(scoped.filter(account => assetNumber(account.converted_balance) !== null)
    .map(account => String(account.converted_balance).replace(/^-/, '')), currency));
  const allocation = scoped.map(account => {
    const value = assetNumber(account.converted_balance);
    return { account_number: account.account_number, name: account.name, value: account.converted_balance,
      percent: value === null ? null : total > 0 ? Math.abs(value) / total * 100 : 0 };
  }).sort((left, right) => {
    const a = assetNumber(left.value), b = assetNumber(right.value);
    return a === null || b === null ? a === b ? 0 : a === null ? 1 : -1 : b - a;
  });
  const includedMatches = visibleAccounts.filter(account => account.included_in_assets !== false);
  return { currency, overview, accounts: scoped, visibleAccounts, summary, history, originalHistory, change, allocation,
    complete: Boolean(overview) && (filters.account !== 'all' || overview.complete === true) &&
      scoped.every(account => filters.account === 'all' && account.included_in_assets === false || assetNumber(account.converted_balance) !== null),
    matchingTotal: (assets.accountsLoaded || overview) && includedMatches.length ? sumAmounts(includedMatches.map(account => account.converted_balance), currency) : null };
}

export function operationKey(registry, scope, payload) {
  const fingerprint = JSON.stringify(payload);
  const old = registry.get(scope);
  if (old?.fingerprint === fingerprint) return old.key;
  const key = importOperationKey();
  registry.set(scope, { fingerprint, key });
  return key;
}
