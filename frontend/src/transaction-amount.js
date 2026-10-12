import { DEFAULT_RATES, normalizePrimaryCurrency } from './config.js';
import { localeFor, t } from './i18n.js';
import { currencyName, escapeAttr, formatAmount, formatJpy } from './utils.js';

export function transactionConversion(value, currency, primaryCurrency, rates = DEFAULT_RATES) {
  const amount = Number(value);
  const from = currencyName(currency);
  const to = currencyName(normalizePrimaryCurrency(primaryCurrency));
  if (value == null || String(value).trim() === '' || !Number.isFinite(amount)) return null;
  if (from === to) return { amount, from, to, rate: 1, fallback: false };
  if (!['JPY', 'CNY'].includes(from)) return null;
  const supplied = [rates?.RMB, rates?.CNY].map(Number).find(rate => Number.isFinite(rate) && rate > 0);
  const cnyToJpy = supplied ?? DEFAULT_RATES.CNY;
  const rate = from === 'CNY' ? cnyToJpy : 1 / cnyToJpy;
  const converted = amount * rate;
  return Number.isFinite(converted)
    ? { amount: converted, from, to, rate, fallback: supplied == null || rates?.source === 'fallback' }
    : null;
}

export function transactionAmountHint(ctx, value, currency) {
  const conversion = transactionConversion(value, currency, ctx.state.settings?.contextCurrency, ctx.state.rates);
  if (!conversion) return { label: t(ctx.language, 'primaryCurrency'), value: t(ctx.language, 'conversionUnavailable') };
  if (conversion.from === conversion.to) return {
    label: t(ctx.language, 'primaryCurrency'), value: formatAmount(conversion.amount, conversion.to, ctx.language),
  };
  const formatted = conversion.to === 'JPY'
    ? formatJpy(conversion.amount, ctx.language) : formatAmount(conversion.amount, conversion.to, ctx.language);
  const rate = conversion.rate.toLocaleString(localeFor(ctx.language), { maximumFractionDigits: 6 });
  return {
    label: t(ctx.language, conversion.fallback ? 'convertedPrimaryFallback' : 'convertedPrimary') +
      ' · 1 ' + conversion.from + ' ≈ ' + rate + ' ' + conversion.to,
    value: '≈ ' + formatted,
  };
}

export function transactionAmountAttrs(ctx, value, currency) {
  const hint = transactionAmountHint(ctx, value, currency);
  return ' data-money-tip data-money-amount="' + escapeAttr(value ?? '') + '" data-money-currency="' + escapeAttr(currency ?? '') +
    '" data-tip-label="' + escapeAttr(hint.label) + '" data-tip-value="' + escapeAttr(hint.value) +
    '" tabindex="0" aria-description="' + escapeAttr(hint.label + ': ' + hint.value) + '"';
}
