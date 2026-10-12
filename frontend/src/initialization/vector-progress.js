import { completed, safeError, STEPS } from './model.js';
import { describeSetupError } from './setup-errors.js';
import { MAIL_PROVIDERS } from './mailbox-view.js';

function counts(total, done, finished = false) {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(done) || total < 0 || done < 0) return null;
  return { total, done, percent: total ? Math.min(100, done / total * 100) : finished ? 100 : 0 };
}

export function vectorProgress(status) {
  const sync = status?.vector_sync;
  const ready = completed(status, 'vector_db');
  const progress = status?.active_step === 'vector_db' ? status.progress : null;
  const byProvider = sync?.bootstrap_by_provider;
  const providers = MAIL_PROVIDERS.filter(provider => byProvider && Object.hasOwn(byProvider, provider))
    .map(provider => ({ provider, progress: counts(byProvider[provider]?.total, byProvider[provider]?.vectorized, true) }));
  return {
    ready, providers,
    bootstrap: counts(sync?.bootstrap_total, sync?.bootstrap_vectorized, ready)
      || counts(progress?.total, progress?.vectorized, ready),
    full: counts(sync?.total, sync?.vectorized, sync?.status === 'completed'),
    status: sync?.status || '', error: sync?.error ? safeError(sync.error) : '',
  };
}

export function vectorProgressMarkup() {
  const row = kind => `<div class="setup-vector-row" data-vector-row="${kind}" hidden>
    <div class="setup-vector-heading"><span data-vector-label></span><strong data-vector-count></strong></div>
    <progress max="100" data-vector-bar></progress></div>`;
  return `<section class="setup-vector-progress" data-vector-progress hidden>
    ${row('bootstrap')}${MAIL_PROVIDERS.map(row).join('')}${row('full')}
    <p class="setup-note" data-vector-note role="status"></p>
    <p class="setup-rule-error" data-vector-error hidden></p></section>`;
}

// Keep the bars mounted so polling changes their value without replacing the form or replaying entry animations.
export function updateVectorProgress(root, state, t, language = 'zh') {
  const panel = root.querySelector('[data-vector-progress]');
  if (!panel) return;
  const data = vectorProgress(state.status), vectorStep = state.step === 'vector_db';
  const laterStep = STEPS.indexOf(state.step) > STEPS.indexOf('vector_db');
  const showFull = Boolean(data.full || data.status);
  panel.hidden = Boolean(state.status?.initialized) || (!vectorStep && !(laterStep && showFull));
  if (panel.hidden) return;
  const format = new Intl.NumberFormat(language);
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  for (const kind of ['bootstrap', ...MAIL_PROVIDERS, 'full']) {
    const provider = data.providers.find(item => item.provider === kind);
    const row = panel.querySelector(`[data-vector-row="${kind}"]`), value = provider ? provider.progress : data[kind];
    row.hidden = kind === 'full' ? !showFull : !vectorStep || (kind === 'bootstrap' ? data.providers.length > 0 : !provider);
    const name = kind === 'gmail' ? 'Gmail' : t('mailNeteaseName');
    const label = MAIL_PROVIDERS.includes(kind) ? t('vectorProviderBootstrap').replace('{provider}', name)
      : t(kind === 'bootstrap' ? 'vectorBootstrap' : 'vectorFull');
    text(row.querySelector('[data-vector-label]'), label);
    // Do not round incomplete progress up to 100%, or invent totals while mail is being listed.
    const count = value ? `${format.format(value.done)} / ${format.format(value.total)} ${t('mailUnit')} · ${Math.floor(value.percent)}%` : t('vectorCounting');
    text(row.querySelector('[data-vector-count]'), count);
    const bar = row.querySelector('[data-vector-bar]');
    bar.setAttribute('aria-label', label);
    bar.setAttribute('aria-valuetext', count);
    if (value) bar.value = value.percent; else bar.removeAttribute('value');
  }
  const noteKey = data.status === 'failed' || data.status === 'interrupted'
    ? data.ready ? 'vectorBackgroundStopped' : 'vectorBootstrapStopped'
    : data.ready && state.step === 'complete' && state.status?.ready_to_complete && data.status === 'running' ? 'vectorFinishReady'
    // Past the index step only the background sync is shown; "you can continue" no longer applies there.
    : data.ready && laterStep ? data.status === 'completed' ? 'vectorBackgroundDone' : 'vectorBackgroundRunning'
    : data.ready ? data.bootstrap?.total === 0 ? 'vectorEmpty'
      : data.status === 'completed' ? 'vectorAllDone' : 'vectorReady'
    : data.bootstrap && data.bootstrap.done >= data.bootstrap.total ? 'vectorChecking' : 'vectorThreshold';
  text(panel.querySelector('[data-vector-note]'), t(noteKey));
  const error = panel.querySelector('[data-vector-error]');
  error.hidden = !data.error;
  text(error, data.error ? describeSetupError(t, data.error, 'vector_db') : '');
}
