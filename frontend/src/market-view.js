import { localeFor, t } from './i18n.js';
import { localizeMarkup } from './language-view.js';
import { financeAttr } from './finance-colors.js';
import { normalizePrimaryCurrency } from './config.js';
import { escapeAttr as a, escapeHtml as e, formatAmount, formatPercent } from './utils.js';
import { MARKET_DEFAULT_SYMBOLS, MARKET_INTERVAL_MS, MARKET_MAX_SYMBOLS,
  marketDisplayPrice, marketSymbols, staleMarketSnapshot, validMarketSnapshot } from './market-data.js';

const SNAPSHOT_KEY = 'abk-editorial-market-snapshot-v1';
const SYMBOLS_KEY = 'abk-editorial-market-symbols-v1';
const MAX_CACHE_AGE = 7 * 86_400_000;
const timers = new WeakMap();
const text = (ctx, key, vars) => t(ctx.language, key, vars);
const primaryCurrency = (ctx) => normalizePrimaryCurrency(ctx.state.settings.contextCurrency) === 'RMB' ? 'CNY' : 'JPY';

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* A live quote should still render without storage. */ }
}

function initialSnapshot() {
  const value = readJson(SNAPSHOT_KEY, null);
  if (!validMarketSnapshot(value) || Date.now() - Date.parse(value.checkedAt) > MAX_CACHE_AGE) return null;
  return staleMarketSnapshot(value);
}

function initialSymbols() {
  try { return marketSymbols(readJson(SYMBOLS_KEY, MARKET_DEFAULT_SYMBOLS)); } catch { return [...MARKET_DEFAULT_SYMBOLS]; }
}

function localizedDate(ctx, value) {
  if (!value) return '\u2014';
  return new Date(value).toLocaleString(localeFor(ctx.language), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function originalPrice(ctx, quote) {
  if (quote.price === null) return '\u2014';
  if (quote.kind === 'index') return quote.price.toLocaleString(localeFor(ctx.language), { maximumFractionDigits: 2 }) + ' ' + text(ctx, 'marketPoints');
  return formatAmount(quote.price, 'USD', ctx.language) + (quote.kind === 'gold' ? ' / oz t' : '');
}

function convertedPrice(ctx, quote, fx) {
  const value = marketDisplayPrice(quote, primaryCurrency(ctx), fx);
  if (value === null) return '\u2014';
  return formatAmount(value, primaryCurrency(ctx), ctx.language) + (quote.kind === 'gold' ? ' / g' : '');
}

function quoteRows(ctx, data) {
  if (!data) return '<tr><td colspan="6"><div class="market-loading"><i></i><span>' + e(text(ctx, 'marketLoading')) + '</span></div></td></tr>';
  return data.quotes.map((quote) => {
    const change = quote.changePercent === null ? '\u2014' : (quote.changePercent > 0 ? '+' : '') + formatPercent(quote.changePercent, ctx.language);
    return '<tr data-market-symbol="' + a(quote.symbol) + '" class="is-' + a(quote.status) + '"><td><span class="market-symbol">' +
      '<b>' + e(quote.symbol === '^GSPC' ? 'S5' : quote.kind === 'gold' ? 'Au' : quote.symbol.slice(0, 2)) + '</b><span><strong>' + e(quote.name) +
      '</strong><small>' + e(quote.symbol) + ' \u00b7 ' + e(text(ctx, 'marketType_' + quote.kind)) + '</small></span></span></td><td class="numeric">' +
      e(originalPrice(ctx, quote)) + '</td><td class="numeric market-converted">' + e(convertedPrice(ctx, quote, data.fx)) + '</td><td class="numeric"' + financeAttr(quote.changePercent) + '>' +
      e(change) + '</td><td><time datetime="' + a(quote.asOf || '') + '">' + e(localizedDate(ctx, quote.asOf)) + '</time></td><td><span class="market-status is-' +
      a(quote.status) + '">' + e(text(ctx, 'marketStatus_' + quote.status)) + '</span></td></tr>';
  }).join('');
}

export function marketPanelView(ctx, state) {
  const status = state.loading ? 'marketLoading' : state.error && !state.data ? 'marketUnavailable' : 'marketAutoUpdate';
  return '<section class="editorial-section asset-market-section" data-market-panel aria-labelledby="market-title"><header class="section-header">' +
    '<div><h2 id="market-title">' + e(text(ctx, 'marketTitle')) + '</h2></div><div class="market-sync" aria-live="polite">' +
    '<i class="' + (state.loading ? 'is-loading' : '') + '"></i><span>' + e(text(ctx, status)) + '</span>' +
    (state.data ? '<time datetime="' + a(state.data.checkedAt) + '">' + e(localizedDate(ctx, state.data.checkedAt)) + '</time>' : '') + '</div></header>' +
    '<form class="market-watch-form" data-market-watch-form><label for="market-symbols">' + e(text(ctx, 'marketWatchlist')) + '</label>' +
    '<div><input id="market-symbols" name="symbols" value="' + a(state.symbols.join(', ')) + '" spellcheck="false" autocomplete="off" />' +
    '<button class="button compact" type="submit">' + e(text(ctx, 'marketApply')) + '</button></div>' +
    (state.validationError ? '<p role="alert">' + e(text(ctx, 'marketSymbolsInvalid', { count: MARKET_MAX_SYMBOLS })) + '</p>' : '') + '</form>' +
    '<div class="table-scroll market-table-scroll"><table class="market-table"><thead><tr>' + ['marketInstrument', 'marketQuote', 'marketReferenceValue', 'marketDayChange', 'marketPriceTime', 'marketDataState']
      .map((key) => '<th>' + e(text(ctx, key, { currency: primaryCurrency(ctx) })) + '</th>').join('') + '</tr></thead><tbody>' + quoteRows(ctx, state.data) +
    '</tbody></table></div></section>';
}

export function createMarketPanelController({ api, getContext, render }) {
  const state = { data: initialSnapshot(), symbols: initialSymbols(), loading: false, error: '', validationError: false, active: false, lastAttempt: 0 };
  let timer = 0;

  function paint() {
    const panel = document.querySelector('[data-market-panel]');
    if (panel && state.active) {
      render(panel, marketPanelView(getContext(), state));
      return;
    }
    const slot = document.querySelector('[data-market-slot]');
    if (slot && state.active) slot.outerHTML = marketPanelView(getContext(), state);
  }

  function schedule(delay = MARKET_INTERVAL_MS) {
    clearTimeout(timer);
    if (!state.active) return;
    timer = window.setTimeout(refresh, delay);
    timers.set(document, timer);
  }

  async function refresh(force = false) {
    if (!state.active || state.loading) return;
    const age = Date.now() - state.lastAttempt;
    if (!force && age < MARKET_INTERVAL_MS - 500) return schedule(MARKET_INTERVAL_MS - age);
    state.loading = true;
    state.error = '';
    state.lastAttempt = Date.now();
    paint();
    try {
      const response = await api.marketSnapshot(state.symbols);
      if (!validMarketSnapshot(response.result)) throw new Error('invalid_snapshot');
      state.data = response.result;
      saveJson(SNAPSHOT_KEY, state.data);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      if (state.data) state.data = staleMarketSnapshot(state.data);
    } finally {
      state.loading = false;
      paint();
      schedule();
    }
  }

  function mount() {
    state.active = getContext().state.route === 'assets' && !document.hidden;
    clearTimeout(timer);
    if (!state.active) return;
    paint();
    refresh();
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-market-watch-form]')) return;
    event.preventDefault();
    try {
      state.symbols = marketSymbols(new FormData(form).get('symbols'));
      state.validationError = false;
      saveJson(SYMBOLS_KEY, state.symbols);
      state.lastAttempt = 0;
      refresh(true);
    } catch {
      state.validationError = true;
      paint();
    }
  });
  document.addEventListener('visibilitychange', mount);
  function relocalize() {
    localizeMarkup(document.querySelector('[data-market-panel]'), marketPanelView(getContext(), state));
  }
  return { mount, refresh, relocalize, state };
}
