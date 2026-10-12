import { MARKET_INTERVAL_MS, marketSymbols } from './market-data.js';

const DAY = 86_400_000;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const iso = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) throw new Error('invalid_timestamp');
  return date.toISOString();
};

export function parseYahooQuote(data, symbol) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (data?.chart?.error || !meta || meta.symbol !== symbol || !positive(meta.regularMarketPrice) ||
    !positive(meta.regularMarketTime) || !['EQUITY', 'ETF', 'INDEX'].includes(meta.instrumentType) || meta.currency !== 'USD') {
    throw new Error('invalid_quote');
  }
  const price = meta.regularMarketPrice;
  let previousClose = meta.previousClose ?? meta.regularMarketPreviousClose;
  if (!positive(previousClose)) {
    // chartPreviousClose is the start of the requested range, NOT yesterday's close.
    const sessionDay = (time) => Math.floor((time + (Number(meta.gmtoffset) || 0)) / 86400);
    const today = sessionDay(meta.regularMarketTime);
    const closes = result.indicators?.quote?.[0]?.close || [];
    previousClose = null;
    for (let index = (result.timestamp?.length || 0) - 1; index >= 0; index -= 1) {
      if (sessionDay(result.timestamp[index]) < today && positive(closes[index])) {
        previousClose = closes[index];
        break;
      }
    }
  }
  return { symbol, name: String(meta.shortName || meta.longName || symbol).slice(0, 100),
    kind: { EQUITY: 'stock', ETF: 'etf', INDEX: 'index' }[meta.instrumentType], price,
    currency: meta.instrumentType === 'INDEX' ? 'POINTS' : 'USD',
    previousClose, changePercent: positive(previousClose) ? (price / previousClose - 1) * 100 : null,
    asOf: iso(meta.regularMarketTime * 1000), source: 'yahoo' };
}

export function parseGoldQuote(data) {
  if (data?.symbol !== 'XAU' || (data.currency && data.currency !== 'USD') || !positive(data.price)) throw new Error('invalid_quote');
  return { symbol: 'XAU', name: 'Gold', kind: 'gold', price: data.price, currency: 'USD',
    previousClose: null, changePercent: null, asOf: iso(data.updatedAt), source: 'gold' };
}

export function parseMarketFx(data) {
  if (data?.result !== 'success' || data.base_code !== 'USD' || data.rates?.USD !== 1 ||
    !positive(data.rates?.JPY) || !positive(data.rates?.CNY)) throw new Error('invalid_rates');
  return { rates: { USD: 1, JPY: data.rates.JPY, CNY: data.rates.CNY },
    asOf: iso(data.time_last_update_unix * 1000), nextUpdate: iso(data.time_next_update_unix * 1000), source: 'fx' };
}

export function createMarketService({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();

  async function json(url) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw new Error('upstream_' + response.status);
    return response.json();
  }

  async function cached(key, fetchValue, empty, isFx = false) {
    const old = cache.get(key);
    if (old && old.expiresAt > now()) return old.value;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      let value;
      let expiresAt = now() + MARKET_INTERVAL_MS;
      try {
        const data = await fetchValue();
        const age = now() - Date.parse(data.asOf);
        const stale = age > (isFx ? 2 * DAY : 7 * DAY);
        value = { ...data, status: stale ? 'stale' : 'ok', error: stale ? 'old_quote' : null };
        expiresAt = isFx
          ? Math.max(now() + MARKET_INTERVAL_MS, Math.min(Date.parse(data.nextUpdate), now() + DAY))
          : now() + MARKET_INTERVAL_MS;
      } catch (error) {
        const recent = old && now() - Date.parse(old.value.asOf) <= 7 * DAY;
        value = { ...(recent ? old.value : empty), status: recent ? 'stale' : 'unavailable',
          error: /^upstream_\d+$/.test(error.message) ? error.message : 'source_unavailable' };
      }
      cache.delete(key);
      cache.set(key, { value, expiresAt });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
      return value;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }

  return {
    async snapshot(requested) {
      const symbols = marketSymbols(requested);
      const quotes = [];
      // A small worker pool also bounds the public provider load on a cold cache.
      for (let index = 0; index < symbols.length; index += 3) {
        quotes.push(...await Promise.all(symbols.slice(index, index + 3).map((symbol) => cached('quote:' + symbol,
          async () => parseYahooQuote(await json('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=5d'), symbol),
          { symbol, name: symbol, kind: symbol.startsWith('^') ? 'index' : 'stock', price: null,
            currency: symbol.startsWith('^') ? 'POINTS' : 'USD', previousClose: null, changePercent: null, asOf: null, source: 'yahoo' }))));
      }
      const [gold, fx] = await Promise.all([
        cached('gold', async () => parseGoldQuote(await json('https://api.gold-api.com/price/XAU')),
          { symbol: 'XAU', name: 'Gold', kind: 'gold', price: null, currency: 'USD', previousClose: null, changePercent: null, asOf: null, source: 'gold' }),
        cached('fx', async () => parseMarketFx(await json('https://open.er-api.com/v6/latest/USD')),
          { rates: null, asOf: null, nextUpdate: null, source: 'fx' }, true),
      ]);
      return { quotes: [...quotes, gold], fx, checkedAt: new Date(now()).toISOString(), refreshAfterMs: MARKET_INTERVAL_MS };
    },
  };
}

export function createMarketHandler(options) {
  const service = createMarketService(options);
  return async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') return send(405, { success: false, error: 'Method not allowed' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/market/quotes') return send(404, { success: false, error: 'Not found' });
    try {
      const result = await service.snapshot(url.searchParams.has('symbols') ? url.searchParams.get('symbols') : undefined);
      send(200, { success: true, result, status_code: 200, error: null });
    } catch (error) {
      const status = error instanceof RangeError ? 400 : 502;
      send(status, { success: false, error: status === 400 ? 'marketSymbolsInvalid' : 'Market data unavailable', status_code: status });
    }
  };
}
