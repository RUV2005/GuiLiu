import { busyStatus, canSubmit, canVisit, completed, safeAuthorizationUrl, safeError, statusSnapshot } from './model.js';
import { accountPayload, canReview, reviewFingerprint } from './accounts.js';
import { configuredReceiptEmail, receiptEmail } from './receipt-sender.js';

function requestError(error, secrets = []) {
  const message = safeError(error, secrets);
  if (error.status === 403) {
    if (['Initialization is local-only', 'Untrusted initialization origin'].includes(message)) return 'localOnly';
    if (['Mailbox authorization test only; imports and business writes are disabled',
      'Model calls are disabled for mailbox authorization testing'].includes(message)) return 'mailboxTestOnly';
  }
  return message;
}

// No background writes: polling can discover completion but never starts another step.
export function createInitializationController({ api, onChange = () => {}, onComplete = () => {},
  visible = () => true, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, uuid = () => crypto.randomUUID() }) {
  const state = { status: null, step: '', checking: false, posting: false, error: '', checkError: '',
    uncertain: false, accounts: [], accountsError: '', accountsLoaded: false, accountsLoading: false, accountPosting: false,
    accountPending: null, accountEditing: false, accountError: '', accountNotice: '', sourceEditing: false, reviewed: '',
    authorizationUrl: '', authorizationExpires: 0, finishing: false, confirmationPending: null, confirmationResult: null,
    ocrDraft: '', ocrDirty: false, ocrPending: null, models: null, modelsLoaded: false };
  const abort = new AbortController();
  let disposed = false, timer, accountRequest = null, modelRequest = null;
  const notify = () => {
    if (!state.status?.initialized && state.reviewed && state.reviewed !== reviewFingerprint(state)) {
      state.reviewed = '';
      if (state.step === 'complete') { state.step = 'account_confirmation'; state.error = 'reviewChanged'; }
    }
    if (!disposed) onChange(state);
  };
  function confirmationApplied(data) {
    state.confirmationPending = null;
    state.confirmationResult = { version: (state.confirmationResult?.version || 0) + 1,
      sourceIds: (data.confirmations || []).map(choice => choice.source_id) };
  }
  function schedule() {
    clearTimer(timer);
    if (disposed || state.finishing) return;
    timer = setTimer(() => { if (visible()) void refresh(); else schedule(); },
      state.checkError ? 15000 : busyStatus(state.status) || state.status?.vector_sync?.status === 'running' || state.step === 'gmail' ? 2500 : 10000);
  }
  async function finish() {
    if (disposed || state.finishing) return;
    state.finishing = true;
    clearTimer(timer);
    notify();
    try { await onComplete(); }
    catch { state.error = 'appFailed'; state.finishing = false; notify(); }
  }
  async function accounts() {
    if (accountRequest || disposed) return accountRequest;
    state.accountsLoading = true; notify();
    accountRequest = (async () => {
      try {
        const items = await api.accounts(abort.signal);
        if (disposed) return;
        state.accounts = items;
        state.accountsLoaded = true;
        state.accountsError = '';
      } catch { if (!disposed) state.accountsError = 'accountsFailed'; }
      finally { accountRequest = null; state.accountsLoading = false; notify(); }
    })();
    return accountRequest;
  }
  async function models(force = false) {
    if (disposed || modelRequest || (!force && state.modelsLoaded)) return modelRequest;
    modelRequest = (async () => {
      try {
        const value = await api.models?.(abort.signal);
        if (!disposed) state.models = value || null;
      } catch { /* Model labels must not block setup or clear the API key fields. */ }
      finally {
        modelRequest = null;
        if (!disposed) { state.modelsLoaded = true; notify(); }
      }
    })();
    return modelRequest;
  }
  async function accept(value, reloadAccounts = true) {
    const next = statusSnapshot(value);
    if (disposed) return;
    const previous = state.status;
    state.status = next;
    if (next.initialized) { await finish(); return; }
    if (!state.step) state.step = next.active_step || (['ocr_source', 'complete'].includes(next.next_step) ? 'account_confirmation'
      : next.completed_steps.length ? next.next_step : 'welcome');
    if (state.step === 'api_keys') void models();
    if (next.gmail?.authorized || (completed(next, 'gmail') && !completed(previous, 'gmail') && !next.mail)) state.authorizationUrl = '';
    const email = configuredReceiptEmail(next);
    if (state.ocrPending && completed(next, 'ocr_source') && email === state.ocrPending.email) {
      state.ocrPending = null; state.ocrDirty = false;
    }
    if (!state.ocrDirty && !state.ocrPending) state.ocrDraft = email;
    if (state.confirmationPending) {
      const data = state.confirmationPending;
      const applied = completed(next, 'account_confirmation') || (data.confirmations?.length && data.confirmations.every(choice => {
        const source = next.sources.find(s => s.source_id === choice.source_id);
        return source?.confirmed === true && (choice.action === 'skip' ? source.status === 'skipped'
          : source.account_number != null && (choice.account_number == null || String(source.account_number) === String(choice.account_number))
            && (choice.account_ref == null || source.account_ref === choice.account_ref));
      }));
      if (applied) confirmationApplied(data);
    }
    if (reloadAccounts && ['bank_rules', 'account_confirmation', 'complete'].includes(state.step)
      && (!previous || next.account_count !== previous.account_count || JSON.stringify(next.sources) !== JSON.stringify(previous.sources))) void accounts();
  }
  async function refresh() {
    if (disposed || state.checking || state.posting || state.finishing) return;
    state.checking = true;
    notify();
    try {
      const result = await api.status(abort.signal);
      if (disposed) return;
      await accept(result);
      state.checkError = '';
      if (state.uncertain) state.error = '';
      state.uncertain = false;
    } catch (error) {
      if (!disposed) state.checkError = error.status === 404 ? 'endpointMissing' : requestError(error);
    } finally {
      state.checking = false;
      notify();
      schedule();
    }
  }
  async function submit(step, data) {
    if (disposed || state.accountPosting || state.accountPending || state.accountEditing || state.checking || state.posting || state.uncertain || state.checkError || !canSubmit(state.status, step)) return false;
    if (state.ocrPending && step !== 'ocr_source') return false;
    if (state.confirmationPending && step !== 'account_confirmation') return false;
    if (step === 'bank_rules' && Object.keys(data).length) { state.error = 'invalidStatus'; notify(); return false; }
    if (step === 'complete' && (!canReview(state) || state.reviewed !== reviewFingerprint(state))) {
      state.error = 'reviewRequired'; state.step = 'account_confirmation'; notify(); return false;
    }
    if (step === 'complete' && state.ocrDirty) { state.error = 'receiptRequired'; state.step = 'ocr_source'; notify(); return false; }
    if (!['complete', 'ocr_source'].includes(step)) state.reviewed = '';
    if (step === 'ocr_source') {
      try { data = structuredClone(state.ocrPending || { email: receiptEmail(data.email) }); }
      catch (error) { state.error = safeError(error); notify(); return false; }
      state.ocrPending = structuredClone(data);
    }
    if (step === 'account_confirmation') {
      data = structuredClone(state.confirmationPending || data);
      state.confirmationPending = structuredClone(data);
    }
    state.posting = true;
    state.error = '';
    clearTimer(timer);
    notify();
    const secrets = [data.dashscope_api_key, data.openai_api_key, data.authorization_code].filter(Boolean);
    let successful = false, resync = false;
    try {
      // An older account read must finish before confirmation can create a new account.
      if (step === 'account_confirmation' && accountRequest) await accountRequest;
      if (disposed) return false;
      const result = await api.submit(step, data, abort.signal);
      if (disposed) return false;
      await accept(result, step !== 'account_confirmation');
      if (step === 'ocr_source' && state.ocrPending) throw new Error('receiptSettingsInvalid');
      if (step === 'account_confirmation') { if (state.confirmationPending) confirmationApplied(data); await accounts(); }
      if (step === 'gmail' && !result.initialized) {
        const provider = data.connect_provider;
        const connected = result.mail?.accounts?.find(account => account.provider === provider);
        if (provider === '163') {
          if (!connected?.authorized || !connected.selected || connected.email !== data.email) throw new Error('invalidStatus');
        } else {
          state.authorizationUrl = safeAuthorizationUrl(result.authorization_url);
          state.authorizationExpires = now() + Math.max(0, Math.min(600, Number(result.expires_in) || 600)) * 1000;
          const confirmed = provider === 'gmail' ? connected?.authorized && connected.selected
            : completed(result, 'gmail') && result.mail?.authorized;
          if (!state.authorizationUrl && !confirmed) throw new Error('invalidStatus');
        }
      }
      successful = true;
      if (step === 'bank_rules') void accounts();
    } catch (error) {
      if (disposed) return false;
      const uncertain = !error.status || error.status >= 500;
      if (step === 'account_confirmation' && !uncertain && error.status !== 409) state.confirmationPending = null;
      if (step === 'ocr_source' && !uncertain) state.ocrPending = null;
      state.uncertain = uncertain;
      state.error = uncertain ? 'uncertain' : requestError(error, secrets);
      resync = true;
    } finally {
      state.posting = false;
      notify();
      if (!disposed) { if (resync) void refresh(); else schedule(); }
    }
    return successful;
  }
  function select(step) {
    if (disposed || state.posting || state.accountPosting || state.accountPending || state.confirmationPending || state.accountEditing || state.sourceEditing || !canVisit(state.status, step)) return;
    if (state.ocrPending) return;
    if (step === 'complete' && state.ocrDirty) { state.step = 'ocr_source'; state.error = 'receiptRequired'; notify(); return; }
    if (step === 'complete' && (!state.reviewed || state.reviewed !== reviewFingerprint(state))) step = 'account_confirmation';
    state.step = step;
    state.error = '';
    if (step === 'api_keys') void models(true);
    if (step === 'bank_rules' || step === 'account_confirmation') void accounts();
    notify();
  }
  async function saveAccount(kind, id, fields) {
    if (disposed || state.accountPosting || state.posting || state.confirmationPending || state.checking || busyStatus(state.status) || state.finishing
      || state.ocrPending
      || state.status?.initialized || state.step !== 'account_confirmation' || !state.accountsLoaded || state.checkError
      || (state.accountsError && !state.accountPending)) return false;
    let operation = state.accountPending;
    if (!operation) {
      try {
        const account = state.accounts.find(a => String(a.account_number) === String(id));
        operation = { kind, id, payload: accountPayload(kind, fields, account, state.accounts, now()), key: uuid() };
      } catch (error) { state.accountError = safeError(error); notify(); return false; }
    }
    state.accountPending = operation;
    state.accountPosting = true; state.accountError = ''; state.accountNotice = ''; state.reviewed = '';
    notify();
    try {
      // Finish an older read before refreshing after a successful write.
      if (accountRequest) await accountRequest;
      if (disposed) return false;
      const account = await api.saveAccount(operation.kind, operation.id, operation.payload, operation.key);
      if (disposed) return false;
      state.accountPending = null;
      state.accountEditing = false;
      state.accountNotice = 'accountSaved';
      state.accounts = [...state.accounts.filter(a => String(a.account_number) !== String(account.account_number)), account];
      await accounts();
      return true;
    } catch (error) {
      if (disposed) return false;
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) state.accountPending = null;
      state.accountError = uncertain ? 'accountWriteUncertain' : safeError(error);
      return false;
    } finally { state.accountPosting = false; notify(); }
  }
  return {
    state, start: refresh, refresh, submit, select, accounts, saveAccount,
    editOcrEmail(value) {
      if (disposed || state.posting || state.ocrPending || state.finishing) return;
      state.ocrDraft = String(value); state.ocrDirty = state.ocrDraft.trim() !== configuredReceiptEmail(state.status);
      state.error = ''; notify();
    },
    next() { select(state.status?.next_step); },
    confirmReview({ checked, skipEmpty } = {}) {
      if (disposed || !checked || !canReview(state)) {
        state.error = 'reviewRequired'; notify(); return false;
      }
      state.reviewed = reviewFingerprint(state);
      state.step = state.ocrDirty || !completed(state.status, 'ocr_source') ? 'ocr_source' : 'complete';
      state.error = ''; notify(); return true;
    },
    editingAccount(value) {
      if (state.accountPosting || state.accountPending || state.confirmationPending || (value && state.sourceEditing) || state.posting) return false;
      state.accountEditing = value; state.accountError = ''; state.accountNotice = ''; state.reviewed = ''; notify(); return true;
    },
    editingSources(value) { state.sourceEditing = value; if (value) state.reviewed = ''; notify(); },
    error(message) { state.error = message; notify(); },
    dispose() { disposed = true; clearTimer(timer); abort.abort(); },
  };
}
