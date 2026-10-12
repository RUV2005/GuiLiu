const KEY = 'abk-editorial-assets-cache-v1';
const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 1500000;
const amount = value => value === null || typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
const account = row => row && Number.isInteger(row.account_number) && typeof row.name === 'string' &&
  ['JPY', 'CNY'].includes(row.currency) && amount(row.balance);
const accounts = rows => Array.isArray(rows) && rows.every(account);

function valid(kind, data) {
  if (!data || typeof data !== 'object') return false;
  if (kind === 'view') return ['', 'JPY', 'CNY'].includes(data.currency);
  if (kind === 'accounts') return accounts(data.items);
  if (kind === 'overview') return accounts(data.accounts) && ['JPY', 'CNY'].includes(data.primary_currency) &&
    ['net', 'assets', 'liabilities'].every(key => amount(data.summary?.[key]));
  if (kind === 'history') return Array.isArray(data.items) && data.items.length <= 366 &&
    data.items.every(row => typeof row?.date === 'string' && amount(row.net_assets)) &&
    Array.isArray(data.accounts) && data.accounts.every(row => Array.isArray(row.items));
  return false;
}

// Reload snapshots are display-only and expire with the tab or after one day.
export function createAssetCache({ storage, now = Date.now } = {}) {
  const store = () => storage || globalThis.sessionStorage;
  function read() {
    try {
      const raw = store()?.getItem(KEY);
      if (!raw || raw.length > LIMIT) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.filter(entry => entry && typeof entry.base === 'string' &&
        typeof entry.key === 'string' && Number.isFinite(entry.at) && entry.at <= now() && now() - entry.at < TTL && valid(entry.kind, entry.data)) : [];
    } catch { return []; }
  }
  function save(entries) {
    try {
      let raw = JSON.stringify(entries);
      while (entries.length && raw.length > LIMIT) { entries.shift(); raw = JSON.stringify(entries); }
      store()?.setItem(KEY, raw);
    } catch { /* Storage restrictions must not block live API data. */ }
  }
  return {
    get(base, kind, key = '') { return read().find(entry => entry.base === base && entry.kind === kind && entry.key === key); },
    put(base, kind, key, data) {
      if (!valid(kind, data)) return;
      const entries = read().filter(entry => !(entry.base === base && entry.kind === kind && entry.key === key));
      entries.push({ base, kind, key, data, at: now() });
      save(entries.slice(-12));
    },
    clear(base) { save(read().filter(entry => entry.base !== base || entry.kind === 'view')); },
  };
}
