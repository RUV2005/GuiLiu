import { copy } from './copy.js';
import { UI_STEPS, busyStatus, completed, canVisit, canSubmit, stepPayload, stepProgress, savedKeys } from './model.js';
import { describeSetupError, serviceProblem, joinSentences } from './setup-errors.js';
import { e, button, field } from './fields.js';
import { mountBankReview } from './bank-review-view.js';
import { translateSetupRegion, captureSetupPosition } from './language.js';
import { createSetupMotion } from './motion.js';
import { providerPickerMarkup, mountProviderPickers, updateProviderModels } from './provider-picker.js';
import { beginGmailAuthorization } from './gmail-authorization.js';
import { vectorProgressMarkup, updateVectorProgress } from './vector-progress.js';
import { MAIL_PROVIDERS, mailboxMarkup, syncMailbox, mailboxNames, mailReady, defaultMailPanel, defaultGmailMethod } from './mailbox-view.js';

export function mountInitializationView({ root, controller, language = 'zh', backendPath, local = true,
  onLanguage = () => {}, onBackend = () => {}, query = '', onQuery = () => {} }) {
  let current = controller.state, key = '', bankView;
  let disposed = false, gmailWindow, mailConnecting = '', mailPanel = '', gmailMethod = '';
  const bankDraft = {};
  const t = name => copy(language, name);
  let motion;
  const providerPickers = mountProviderPickers(root);
  function readFields() {
    return Object.fromEntries(new FormData(root.querySelector('[data-setup-form]')));
  }
  function shell() {
    root.innerHTML = `<main class="setup-shell">
      <aside class="setup-rail"><div class="setup-brand"><img src="/assets/app-icon.svg?v=f9-s4-1" width="38" height="38" data-brand-theme="dark" alt=""><img src="/assets/app-icon-light.svg?v=f9-s4-1" width="38" height="38" data-brand-theme="light" alt=""><strong>${e(t('brand'))}</strong></div>
      <p class="setup-caption">${e(t('setup'))}</p><nav aria-label="${e(t('setup'))}" data-setup-nav>${UI_STEPS.map(s => `<button type="button" data-setup-step="${s}"><span></span><b></b></button>`).join('')}</nav>
      <div class="setup-language" role="group" aria-label="${e(t('language'))}">${[['zh', '中文'], ['ja', '日本語'], ['en', 'English']].map(([lang, label]) => `<button type="button" data-setup-language="${lang}" aria-pressed="${lang === language}">${label}</button>`).join('')}</div></aside>
      <section class="setup-workspace"><div class="setup-reading"><header><p class="setup-step-number" data-setup-number></p><h1 tabindex="-1" data-setup-title></h1></header>
      <p class="setup-local" ${local ? 'hidden' : ''}>${e(t('localOnly'))}</p>
      <div class="setup-feedback" data-setup-errors role="alert" hidden></div>
      <div class="setup-live" data-setup-live aria-live="polite"></div>
      ${vectorProgressMarkup()}
      <div data-setup-content></div></div></section></main>`;
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    bankView?.dispose(); bankView = null; key = '';
  }
  function content(step) {
    if (!current.status) return `<form data-setup-connect>${field(t('backend'), 'backendPath', backendPath, 'type="url" required autocomplete="url"')}<footer class="setup-actions"><button class="setup-button primary" type="submit">${e(t('connect'))}</button></footer></form>`;
    if (step === 'welcome') return `<p class="setup-lead">${e(t('welcomeNote'))}</p><ol class="setup-outline">${UI_STEPS.slice(0, -1).map(s => `<li>${e(t(s))}</li>`).join('')}</ol><footer class="setup-actions">${button(t('start'), 'next', 'primary')}</footer>`;
    if (step === 'account_confirmation') return '<div data-setup-bank-review></div>';
    let body = '';
    if (step === 'api_keys') body = `<p class="setup-lead">${e(t('apiIntro'))}</p>
      <section class="setup-api-service" aria-labelledby="setup-llm-title">
        <h2 id="setup-llm-title">${e(t('llmTitle'))}</h2>
        <p class="setup-api-purpose" id="setup-llm-purpose">${e(t('llmPurpose'))}</p>
        <div class="setup-api-credentials">
          ${providerPickerMarkup('llm', t, current)}
          ${field(t('llmKey'), 'dashscope_api_key', '', 'type="password" autocomplete="off" spellcheck="false" required aria-describedby="setup-llm-purpose setup-llm-check"')}
        </div>
        <p class="setup-api-check" id="setup-llm-check" data-api-check="llm" role="status" hidden></p>
      </section>
      <section class="setup-api-service" aria-labelledby="setup-embedding-title">
        <h2 id="setup-embedding-title">${e(t('embeddingTitle'))}</h2>
        <p class="setup-api-purpose" id="setup-embedding-purpose">${e(t('embeddingPurpose'))}</p>
        <div class="setup-api-credentials">
          ${providerPickerMarkup('embedding', t, current)}
          ${field(t('embeddingKey'), 'openai_api_key', '', 'type="password" autocomplete="off" spellcheck="false" required aria-describedby="setup-embedding-purpose setup-embedding-check"')}
        </div>
        <p class="setup-api-check" id="setup-embedding-check" data-api-check="embedding" role="status" hidden></p>
      </section><p class="setup-note">${e(t('apiNote'))}</p>`;
    if (step === 'gmail') {
      if (!mailPanel) mailPanel = defaultMailPanel(current.status);
      if (!gmailMethod) gmailMethod = defaultGmailMethod(current.status);
      body = mailboxMarkup(t, current.status, mailPanel, gmailMethod);
    }
    if (step === 'ocr_source') body = `<p class="setup-lead">${e(t('ocrSourceNote'))}</p>${field(t('receiptSenderEmail'), 'email', current.ocrDraft, 'type="email" maxlength="254" autocomplete="email" spellcheck="false" required')}`;
    if (step === 'vector_db') {
      // The same filter goes to every connected mailbox, so the hint describes the syntax they all accept.
      const providers = current.status.mail?.providers || ['gmail'];
      const hint = providers.includes('163') ? providers.includes('gmail') ? 'queryHintBoth' : 'queryHint163' : 'queryHint';
      body = `<p class="setup-lead">${e(t('vectorNote'))}</p>${field(t('query'), 'query', query, 'maxlength="2000" autocomplete="off" spellcheck="false" placeholder="after:2026/01/01" aria-describedby="setup-query-hint"')}<p class="setup-note" id="setup-query-hint">${e(t(hint))}</p>`;
    }
    if (step === 'bank_rules') body = `<p class="setup-lead">${e(t('bankNote'))}</p><p class="setup-note">${e(t('bankNextNote'))}</p>`;
    if (step === 'complete') body = `<p class="setup-lead">${e(t('finishNote'))}</p><dl class="setup-summary">${UI_STEPS.slice(0, -1).map(s => `<div><dt>${e(t(s))}</dt><dd>${e(s === 'bank_rules' && !current.status.sources.length ? t('emptyBankConfirmed') : s === 'account_confirmation' ? t(current.reviewed ? 'reviewDone' : 'waiting') : t(completed(current.status, s) ? 'saved' : 'waiting'))}</dd></div>`).join('')}</dl><div data-setup-missing></div>`;
    return `<form data-setup-form autocomplete="off"><fieldset class="setup-form-fields">${body}</fieldset><footer class="setup-actions"><button class="setup-button primary" type="submit" data-setup-submit></button>${button(t('next'), 'next', 'primary')}${button(t('retry'), 'refresh')}</footer></form>`;
  }
  function sync(state) {
    if (disposed) return;
    current = state;
    if (current.status?.initialized) {
      motion?.finish();
      bankView?.dispose(); bankView = null;
      root.querySelector('[data-setup-title]').textContent = t('complete');
      root.querySelector('[data-setup-live]').textContent = '';
      root.querySelector('[data-vector-progress]').hidden = true;
      root.querySelector('[data-setup-errors]').hidden = true;
      root.querySelector('[data-setup-content]').innerHTML = `<p class="setup-lead">${e(t(current.error || 'saved'))}</p>`;
      for (const b of root.querySelectorAll('button')) b.disabled = true;
      return;
    }
    const step = current.step || 'connection';
    const changed = key !== step;
    if (changed) {
      gmailWindow?.cancel(); gmailWindow = null;
      motion?.finish();
      bankView?.dispose(); bankView = null;
      query = root.querySelector('[name="query"]')?.value ?? query;
      const contentNode = document.createElement('div');
      contentNode.dataset.setupContent = '';
      contentNode.innerHTML = content(step);
      root.querySelector('[data-setup-content]').replaceWith(contentNode);
      key = step;
      contentNode.classList.toggle('setup-content-wide', step === 'account_confirmation');
      if (step === 'account_confirmation') bankView = mountBankReview({ root: contentNode.querySelector('[data-setup-bank-review]'), controller, t, language: () => language, local, draft: bankDraft });
      root.querySelector('.setup-workspace').scrollTop = 0;
      root.querySelector('[data-setup-title]').textContent = t(current.status ? step : current.checkError ? 'connectionError' : 'checking');
      root.querySelector('[data-setup-title]').focus({ preventScroll: true });
    }
    const nav = root.querySelector('[data-setup-nav]');
    nav.hidden = !current.status;
    for (const [i, item] of [...nav.querySelectorAll('button')].entries()) {
      const s = item.dataset.setupStep;
      item.disabled = !canVisit(current.status, s) || current.posting || Boolean(current.confirmationPending) || Boolean(current.ocrPending) || current.accountEditing || Boolean(current.accountPending) || current.sourceEditing || (s === 'complete' && (!current.reviewed || current.ocrDirty));
      if (s === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
      const done = Boolean(s === 'account_confirmation' ? current.reviewed : completed(current.status, s));
      item.dataset.done = String(done);
      item.querySelector('span').textContent = done ? '✓' : String(i + 1).padStart(2, '0');
      item.querySelector('b').textContent = t(s);
    }
    // Phone layout turns the steps into one scrollable strip; keep the current step in it without moving the page.
    const active = changed && nav.querySelector('[aria-current]');
    if (active && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft += active.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - active.offsetWidth) / 2;
    }
    root.querySelector('[data-setup-title]').textContent = t(current.status ? step : current.checkError ? 'connectionError' : 'checking');
    root.querySelector('[data-setup-number]').textContent = UI_STEPS.includes(step) ? `${String(UI_STEPS.indexOf(step) + 1).padStart(2, '0')} / ${String(UI_STEPS.length).padStart(2, '0')}` : '';
    const messages = [current.error, current.checkError, current.status?.error, current.accountsError].filter(Boolean);
    const errors = root.querySelector('[data-setup-errors]');
    errors.hidden = !messages.length;
    const errorMarkup = [...new Set(messages)].map(m => `<p>${e(describeSetupError(t, m, step))}</p>`).join('')
      + (messages.length ? button(t('retry'), 'refresh') : '');
    if (errors.innerHTML !== errorMarkup) errors.innerHTML = errorMarkup;
    const live = root.querySelector('[data-setup-live]'), p = stepProgress(current.status);
    const processing = busyStatus(current.status);
    if (current.posting || processing || current.finishing) providerPickers.close();
    const liveMarkup = current.posting ? `<p>${e(t(step === 'api_keys' ? 'testingKeys' : 'submitting'))}${step === 'api_keys' ? '' : '...'}</p>` : step === 'vector_db' && (!processing || current.status.active_step === 'vector_db') ? '' : processing ? `<p>${e(t('running'))} · ${e(t(current.status.active_step))}${p ? ` <strong>${p.done} / ${p.total}</strong>` : ''}</p><progress aria-label="${e(t(current.status.active_step))}" ${p?.total ? `value="${p.done}" max="${p.total}"` : ''}></progress>`
      : step === 'bank_rules' && completed(current.status, step) ? `<p>${e(t(current.status.sources.length ? 'recognitionFinished' : 'emptyBankTitle'))}</p>`
      : completed(current.status, step) ? `<p class="setup-success">${e(t(step === 'gmail' ? 'gmailConnected' : 'saved'))}${step === 'gmail' && mailboxNames(t, current.status) ? ' · ' + e(mailboxNames(t, current.status)) : ''}</p>` : '';
    if (live.innerHTML !== liveMarkup) live.innerHTML = liveMarkup;
    updateVectorProgress(root, current, t, language);
    if (step === 'account_confirmation') root.querySelector('[data-vector-progress]').hidden = true;
    const fieldset = root.querySelector('.setup-form-fields');
    if (fieldset && step !== 'account_confirmation') fieldset.disabled = current.posting || processing || current.finishing || !local || Boolean(current.ocrPending) || (completed(current.status, step) && !['api_keys', 'gmail', 'ocr_source'].includes(step));
    const email = step === 'ocr_source' && root.querySelector('[name="email"]');
    if (email && email.value !== current.ocrDraft) email.value = current.ocrDraft;
    const submit = root.querySelector('[data-setup-submit]');
    if (submit) {
      const done = completed(current.status, step), repair = done && ['api_keys', 'gmail', 'ocr_source'].includes(step);
      submit.hidden = done && !repair;
      submit.disabled = current.checking || current.posting || current.finishing || Boolean(current.checkError) || current.uncertain || !canSubmit(current.status, step) || !local;
      submit.textContent = t(current.posting ? step === 'api_keys' ? 'testingKeys' : 'submitting' : step === 'api_keys' ? 'saveKeys' : step === 'gmail' ? 'connectMail' : step === 'ocr_source' ? (current.ocrPending ? 'retryOcrSource' : 'saveOcrSource') : repair ? 'repair' : step === 'api_keys' ? 'saveKeys' : step === 'vector_db' ? (current.status?.error ? 'retryStep' : 'startVector') : step === 'bank_rules' ? (current.status?.error ? 'retryStep' : 'startBank') : 'enter');
      submit.classList.toggle('primary', !done);
    }
    for (const next of root.querySelectorAll('[data-setup-action="next"]')) {
      next.hidden = step !== 'welcome' && step !== 'bank_rules' && step !== 'vector_db' && !completed(current.status, step);
      next.disabled = current.posting || current.finishing || Boolean(current.ocrPending) || (step === 'ocr_source' && current.ocrDirty);
      next.textContent = t(step === 'welcome' ? 'start' : 'next');
      next.classList.toggle('primary', step !== 'bank_rules' || completed(current.status, step));
      if (step === 'bank_rules') { next.disabled ||= processing || !completed(current.status, 'bank_rules'); next.textContent = t('openReview'); }
      if (step === 'vector_db') next.disabled ||= !completed(current.status, step) || current.checking || Boolean(current.checkError)
        || current.uncertain || !canVisit(current.status, current.status?.next_step) || current.status?.next_step === step;
    }
    for (const retry of root.querySelectorAll('[data-setup-action="refresh"]')) {
      retry.disabled = current.checking || current.posting || current.finishing; retry.textContent = t('retry');
      if (retry.closest('[data-setup-form]')) retry.hidden = step === 'gmail';
    }
    for (const lang of root.querySelectorAll('[data-setup-language]')) { lang.disabled = current.posting || current.accountPosting; lang.setAttribute('aria-pressed', String(lang.dataset.setupLanguage === language)); }
    const connect = root.querySelector('[data-setup-connect]');
    if (connect) {
      connect.querySelector('button').disabled = current.checking;
      root.querySelector('[data-setup-title]').textContent = t(current.checkError ? 'connectionError' : 'checking');
    }
    const oauth = root.querySelector('[data-setup-oauth]');
    if (oauth) {
      const active = current.authorizationUrl && Date.now() < current.authorizationExpires;
      const markup = active ? `<a class="setup-button primary" href="${e(current.authorizationUrl)}" target="_blank" rel="noopener noreferrer">${e(t('openGoogle'))}</a><p class="setup-note">${e(t('authWaiting'))}</p>` : current.authorizationUrl ? `<p>${e(t('authExpired'))}</p>` : '';
      if (oauth.innerHTML !== markup) oauth.innerHTML = markup;
    }
    updateMailFields();
    updateApiCheck();
    updateProviderModels(root, t, current);
    bankView?.sync(current);
    const missing = root.querySelector('[data-setup-missing]');
    if (missing) missing.textContent = current.status.ready_to_complete ? '' : `${t('missing')}: ${(current.status.missing || []).map(t).join(', ')}`;
    if (changed) motion?.play(root.querySelector('.setup-reading'));
  }
  async function onSubmit(event) {
    const form = event.target;
    if (!form.matches('[data-setup-form], [data-setup-connect]')) return;
    event.preventDefault();
    if (form.matches('[data-setup-connect]')) { onBackend(new FormData(form).get('backendPath')); return; }
    if (!local || current.checking || current.posting || current.uncertain || current.checkError || !canSubmit(current.status, current.step)) return;
    let data;
    const fields = readFields();
    if (current.step === 'gmail') {
      if (!event.submitter?.dataset.mailConnect) return;
      fields.connect_provider = event.submitter.dataset.mailConnect;
      fields.gmail_method = event.submitter.dataset.mailMethod || 'oauth';
      fields.connected_providers = (current.status.mail?.accounts || []).filter(a => a.selected && a.authorized).map(a => a.provider);
    }
    if (current.step === 'vector_db') fields.mail_providers = current.status.mail?.providers || ['gmail'];
    if (current.step === 'api_keys') fields.saved_keys = savedKeys(current.status);
    try { data = current.step === 'ocr_source' && current.ocrPending ? current.ocrPending : stepPayload(current.step, fields, current.status.sources, current.accounts); }
    catch (error) { controller.error(error.message); return; }
    if (current.step === 'vector_db') { query = data.query; onQuery(query); }
    const attempt = current.step === 'gmail' && data.connect_provider !== '163' && data.gmail_method !== 'imap' && data.providers?.includes('gmail') && !current.status.gmail?.authorized
      ? beginGmailAuthorization({ message: t('gmailOpening') }) : null;
    if (attempt) gmailWindow = attempt;
    mailConnecting = current.step === 'gmail' ? data.connect_provider || '' : '';
    const pending = controller.submit(current.step, data);
    // Secrets leave the DOM immediately after the request starts, including on failure.
    for (const input of form.querySelectorAll('input[type="password"]')) {
      if (input.name !== 'netease_code' || data.authorization_code) input.value = '';
    }
    let success = false;
    try { success = await pending; }
    finally {
      mailConnecting = '';
      if (!disposed) updateMailFields();
      if (attempt) {
        if (success && !disposed && current.step === 'gmail') attempt.navigate(current.authorizationUrl);
        else attempt.cancel();
        if (gmailWindow === attempt) gmailWindow = null;
      }
    }
  }
  function onClick(event) {
    const item = event.target.closest('button');
    if (!item || item.disabled) return;
    if (item.dataset.mailTab) selectMailPanel(item.dataset.mailTab);
    if (item.dataset.gmailMethod) { gmailMethod = item.dataset.gmailMethod; updateMailFields(); }
    if (item.dataset.setupStep) controller.select(item.dataset.setupStep);
    if (item.dataset.setupAction === 'next') controller.next();
    if (item.dataset.setupAction === 'refresh') { void controller.refresh(); if (['bank_rules', 'account_confirmation', 'complete'].includes(current.step)) void controller.accounts(); }
    if (item.dataset.setupLanguage) {
      motion.finish();
      const restore = captureSetupPosition(root);
      query = root.querySelector('[name="query"]')?.value ?? query;
      language = item.dataset.setupLanguage;
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
      root.querySelector('.setup-brand strong').textContent = t('brand');
      root.querySelector('.setup-caption').textContent = t('setup');
      root.querySelector('[data-setup-nav]').setAttribute('aria-label', t('setup'));
      root.querySelector('.setup-language').setAttribute('aria-label', t('language'));
      root.querySelector('.setup-local').textContent = t('localOnly');
      const translated = document.createElement('div'); translated.innerHTML = content(key);
      for (const selector of ['.setup-form-fields', '[data-setup-connect]', '.setup-lead', '.setup-outline']) {
        const live = root.querySelector(`[data-setup-content] ${selector}`), next = translated.querySelector(selector);
        if (live && next) translateSetupRegion(live, next);
      }
      bankView?.relocalize();
      sync(current); onLanguage(language); restore();
    }
  }
  function beforeUnload(event) {
    if (!controller.state.accountPending && !controller.state.confirmationPending && !controller.state.ocrPending && !controller.state.ocrDirty) return;
    event.preventDefault(); event.returnValue = '';
  }
  function onInput(event) {
    if (current.step === 'ocr_source' && event.target.name === 'email') controller.editOcrEmail(event.target.value);
    if (current.step === 'gmail') updateMailFields();
  }
  // Each service shows its own connection result; a saved key may be left blank to test it again.
  function updateApiCheck() {
    if (current.step !== 'api_keys' || !current.status) return;
    const saved = savedKeys(current.status), check = current.status.api_check || {};
    for (const [service, name, flag] of [['llm', 'dashscope_api_key', 'dashscope'], ['embedding', 'openai_api_key', 'openai']]) {
      const input = root.querySelector(`[name="${name}"]`), line = root.querySelector(`[data-api-check="${service}"]`);
      if (!input || !line) continue;
      input.required = !saved[flag];
      input.placeholder = saved[flag] ? t('apiKeySavedPlaceholder') : '';
      const result = check[service];
      const [state, message] = current.posting ? ['testing', t('testingKeys')]
        : result?.ok ? ['ok', t('apiCheckOk').replace('{model}', result.model || '')]
        : result ? ['failed', joinSentences(serviceProblem(t, service, result.error_code, { model: result.model, status: result.http_status }),
          result.source === 'entered' && saved[flag] ? t('apiCheckKept') : '')]
        : saved[flag] ? ['saved', t('apiCheckSaved')] : ['', ''];
      line.dataset.state = state; line.hidden = !message;
      if (line.textContent !== message) line.textContent = message;
    }
  }
  function selectMailPanel(provider, focus = false) {
    if (!MAIL_PROVIDERS.includes(provider)) return;
    mailPanel = provider;
    updateMailFields();
    if (focus) root.querySelector(`[data-mail-tab="${provider}"]`)?.focus();
  }
  function updateMailFields() {
    if (!root.querySelector('[data-mail-panel]')) return;
    const blocked = current.checking || current.posting || current.finishing || Boolean(current.checkError)
      || current.uncertain || !canSubmit(current.status, 'gmail') || !local;
    syncMailbox(root, t, { status: current.status, panel: mailPanel, connecting: current.posting ? mailConnecting : '', blocked, gmailMethod });
    const submit = root.querySelector('[data-setup-submit]');
    if (submit) { submit.hidden = true; submit.disabled = true; }
    const ready = Boolean(current.status.mail?.authorized ?? mailReady(current.status, 'gmail')) && completed(current.status, 'gmail');
    const next = root.querySelector('[data-setup-form] [data-setup-action="next"]');
    if (next) { next.hidden = false; next.disabled = blocked || !ready; }
    for (const nav of root.querySelectorAll('[data-setup-step]')) {
      if (!['api_keys', 'gmail'].includes(nav.dataset.setupStep)) nav.disabled = !ready || blocked || !canVisit(current.status, nav.dataset.setupStep);
    }
  }
  function onPointerDown(event) {
    if (event.target.closest('[data-setup-language]')) event.preventDefault();
  }
  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.isComposing && event.target.matches('[name="netease_email"], [name="netease_code"], [name="gmail_email"], [name="gmail_app_password"]')) {
      const connect = root.querySelector(event.target.name.startsWith('gmail') ? '[data-mail-connect="gmail"][data-mail-method="imap"]' : '[data-mail-connect="163"]');
      if (connect && !connect.disabled) { event.preventDefault(); connect.form.requestSubmit(connect); }
    }
    // Provider tabs follow the ARIA tabs pattern: arrows, Home and End move between them.
    const tab = event.target.closest?.('[data-mail-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = MAIL_PROVIDERS.indexOf(tab.dataset.mailTab), count = MAIL_PROVIDERS.length;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
    selectMailPanel(MAIL_PROVIDERS[target], true);
  }
  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', beforeUnload);
  shell(); motion = createSetupMotion(root.querySelector('.setup-workspace')); sync(current);
  return { sync, dispose() {
    disposed = true;
    gmailWindow?.cancel(); gmailWindow = null;
    root.removeEventListener('submit', onSubmit); root.removeEventListener('click', onClick); bankView?.dispose();
    root.removeEventListener('pointerdown', onPointerDown); motion.dispose(); providerPickers.dispose();
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('beforeunload', beforeUnload);
    for (const input of root.querySelectorAll('input[type="password"]')) input.value = '';
  } };
}
