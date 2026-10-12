export const MARKET_INTERVAL_MS = 60_000;
export const MARKET_DEFAULT_SYMBOLS = ['^GSPC', 'VOO', 'SPY', 'AAPL'];
export const MARKET_MAX_SYMBOLS = 8;
export const TROY_OUNCE_GRAMS = 31.1034768;

export function marketSymbols(value = MARKET_DEFAULT_SYMBOLS) {
  const items = Array.isArray(value) ? value : String(value).split(/[\s,;\uFF0C]+/);
  const symbols = [...new Set(items.map((item) => String(item).trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length || symbols.length > MARKET_MAX_SYMBOLS || symbols.some((symbol) =>
    !/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol) && !['^GSPC', '^IXIC', '^DJI'].includes(symbol))) {
    throw new RangeError('marketSymbolsInvalid');
  }
  return symbols;
}

export function marketCurrency(value) {
  return value === 'RMB' ? 'CNY' : value;
}

export function convertMarketPrice(value, from, to, fx) {
  from = marketCurrency(from);
  to = marketCurrency(to);
  if (!Number.isFinite(value)) return null;
  if (from === to) return value;
  const source = fx?.rates?.[from];
  const target = fx?.rates?.[to];
  return Number.isFinite(source) && source > 0 && Number.isFinite(target) && target > 0 ? value / source * target : null;
}

export function marketDisplayPrice(quote, currency, fx) {
  if (quote?.kind === 'index') return null;
  const amount = convertMarketPrice(quote?.price, quote?.currency, currency, fx);
  return amount === null ? null : quote.kind === 'gold' ? amount / TROY_OUNCE_GRAMS : amount;
}

// Cached responses are untrusted input; never promote absent values to zero.
export function validMarketSnapshot(data) {
  return data && Array.isArray(data.quotes) && data.quotes.length <= MARKET_MAX_SYMBOLS + 1 &&
    data.quotes.every((quote) => quote && typeof quote.symbol === 'string' && quote.symbol.length <= 12 &&
      ['stock', 'etf', 'index', 'gold'].includes(quote.kind) && ['ok', 'stale', 'unavailable'].includes(quote.status) &&
      (quote.price === null || Number.isFinite(quote.price) && quote.price > 0) &&
      (quote.previousClose === null || Number.isFinite(quote.previousClose) && quote.previousClose > 0) &&
      (quote.changePercent === null || Number.isFinite(quote.changePercent)) &&
      (quote.asOf === null || Number.isFinite(Date.parse(quote.asOf))) &&
      typeof quote.name === 'string' && typeof quote.currency === 'string') &&
    data.fx && ['ok', 'stale', 'unavailable'].includes(data.fx.status) &&
    (data.fx.rates === null || ['USD', 'JPY', 'CNY'].every((key) => Number.isFinite(data.fx.rates[key]) && data.fx.rates[key] > 0)) &&
    Number.isFinite(Date.parse(data.checkedAt));
}

export function staleMarketSnapshot(data) {
  return { ...data,
    quotes: data.quotes.map((quote) => ({ ...quote, status: quote.price === null ? 'unavailable' : 'stale' })),
    fx: { ...data.fx, status: data.fx.rates ? 'stale' : 'unavailable' },
  };
}
