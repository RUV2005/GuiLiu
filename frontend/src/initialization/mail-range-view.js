// Vector step mail filter: a date-range slider (one year by default) and an optional custom search under "Advanced".
// Once indexing has started the Backend keeps the first filter for every retry, so the step shows that filter instead.
import { e, field } from './fields.js';
import { localeFor } from '../i18n.js';
import { MAIL_RANGES, DEFAULT_MAIL_RANGE, rangeStart, describeQuery } from './model.js';

const STOPS = ['range3m', 'range6m', 'range1y', 'range2y', 'range3y', 'rangeAll'];
const dateText = (language, date) => new Intl.DateTimeFormat(localeFor(language), { year: 'numeric', month: 'long', day: 'numeric' }).format(date);

export const lockedMailQuery = status => typeof status?.vector_query === 'string' ? status.vector_query : null;

function summary(t, language, range, custom) {
  if (custom) return t('rangeCustomActive');
  const start = rangeStart(range);
  return start ? t('rangeSummaryAfter').replace('{date}', dateText(language, start)) : t('rangeSummaryAll');
}

export function mailRangeMarkup(t, language, { providers, locked, range = DEFAULT_MAIL_RANGE, custom = '' }) {
  if (locked !== null) {
    const saved = describeQuery(locked);
    const text = saved.kind === 'all' ? t('rangeSummaryAll')
      : saved.kind === 'after' ? t('rangeSummaryAfter').replace('{date}', dateText(language, saved.date))
      : t('rangeLockedCustom').replace('{query}', saved.query);
    return `<div class="setup-range" data-mail-range-locked><p class="setup-range-locked"><span>${e(t('rangeLocked'))}</span><strong>${e(text)}</strong></p></div>`;
  }
  const hint = providers.includes('163') ? providers.includes('gmail') ? 'queryHintBoth' : 'queryHint163' : 'queryHint';
  return `<div class="setup-range" data-mail-range>
    <div class="setup-range-head"><label for="setup-mail-range">${e(t('mailRange'))}</label><strong data-range-summary aria-live="polite">${e(summary(t, language, range, custom))}</strong></div>
    <input id="setup-mail-range" type="range" name="mail_range" min="0" max="${MAIL_RANGES.length - 1}" step="1" value="${range}" aria-valuetext="${e(t(STOPS[range]))}"${custom ? ' disabled' : ''}>
    <div class="setup-range-stops" aria-hidden="true">${STOPS.map((stop, i) => `<button type="button" tabindex="-1" data-range-stop="${i}"${i === range && !custom ? ' data-active' : ''}${custom ? ' disabled' : ''}>${e(t(stop))}</button>`).join('')}</div>
    <p class="setup-note">${e(t('rangeNote'))}</p>
    <details class="setup-advanced"${custom ? ' open' : ''}><summary>${e(t('queryAdvanced'))}</summary>
      ${field(t('query'), 'query', custom, 'maxlength="2000" autocomplete="off" spellcheck="false" placeholder="from:notice@bank.example after:2026/01/01" aria-describedby="setup-query-hint"')}
      <p class="setup-note" id="setup-query-hint">${e(t(hint))}</p>
    </details>
  </div>`;
}

// Keeps the summary, the slider's spoken value and the highlighted stop in step with the controls.
export function syncMailRange(root, t, language) {
  const slider = root.querySelector('[name="mail_range"]');
  if (!slider) return null;
  const range = Number(slider.value), custom = root.querySelector('[name="query"]')?.value.trim() || '';
  slider.disabled = Boolean(custom);
  slider.setAttribute('aria-valuetext', t(STOPS[range]));
  root.querySelector('[data-range-summary]').textContent = summary(t, language, range, custom);
  for (const stop of root.querySelectorAll('[data-range-stop]')) {
    stop.toggleAttribute('data-active', !custom && Number(stop.dataset.rangeStop) === range);
    stop.disabled = Boolean(custom);
  }
  return range;
}
