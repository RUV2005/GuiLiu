import { normalizePrimaryCurrency } from './config.js';
import { assetCurrency, assetDisplayCurrency, assetNumber, decimalAmount, findAssetAccount, historyRange, overviewAssetQuery, operationKey, createAssetState, debtBalance } from './assets-model.js';
import { patchAssetChanges } from './assets-view.js';
import { createAssetCache } from './assets-cache.js';

const result = (response) => response.result;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function createAssetsController({ api, state, context, render, renderOverview, renderModal, openModal, closeModal, notify, refreshDeals, findDeal, persistSettings, cache = createAssetCache() }) {
  let generation = 0, changesGeneration = 0, settingsBase = '', refreshPromise = null, refreshKey = '', sourceBase = null;
  const operations = new Map();
  const tx = (key, vars) => context().t(key, vars);
  const busy = () => Boolean(state.modal?.type.startsWith('asset-') && state.modal.type !== 'asset-detail' && state.modal.type !== 'asset-history');
  const visible = () => state.route === 'assets' || state.route === 'overview';
  const paint = () => { if (state.route === 'assets') render(); else if (state.route === 'overview') renderOverview?.(); };
  const base = () => state.settings.backendPath;
  const query = () => state.route === 'overview' ? overviewAssetQuery(state) : ({ ...historyRange(state.assetPreview.period), primary_currency: assetDisplayCurrency(state),
    account_number: state.assetPreview.account === 'all' ? undefined : state.assetPreview.account });

  function restore() {
    if (sourceBase !== base()) {
      if (sourceBase !== null) state.assetPreview.account = 'all';
      state.assetPreview.currency = cache.get(base(), 'view')?.data.currency || '';
      sourceBase = base(); state.assets = createAssetState();
      generation++; refreshPromise = null;
      const saved = cache.get(base(), 'accounts');
      if (saved) { state.assets.accounts = saved.data.items; state.assets.accountsLoaded = true; state.assets.cachedAt.accounts = saved.at; }
    }
    const assets = state.assets, params = query(), historyKey = JSON.stringify(params);
    if (!assets.overview || assets.overview.primary_currency !== params.primary_currency) {
      const saved = cache.get(base(), 'overview', params.primary_currency);
      if (saved) {
        assets.overview = saved.data; assets.cachedAt.overview = saved.at;
        if (!assets.accountsLoaded) { assets.accounts = saved.data.accounts; assets.accountsLoaded = true; assets.cachedAt.accounts = saved.at; }
      }
    }
    if (assets.historyKey !== historyKey) {
      const saved = cache.get(base(), 'history', historyKey);
      if (saved) { assets.history = saved.data; assets.historyKey = historyKey; assets.cachedAt.history = saved.at; }
    }
  }

  async function loadSettings() {
    if (settingsBase === base()) return;
    const requestedBase = base();
    try {
      const data = result(await api.assetsSettings());
      if (requestedBase !== base() || !data?.primary_currency) return;
      const previous = state.settings.contextCurrency;
      state.settings.contextCurrency = normalizePrimaryCurrency(data.primary_currency);
      persistSettings();
      settingsBase = requestedBase;
      if (previous !== state.settings.contextCurrency) await refresh({ force: true });
    } catch (error) { if (requestedBase === base()) { state.assets.error = error.message; paint(); } }
  }

  async function refresh({ force = false } = {}) {
    if (!force && (!visible() || busy() || state.dealDrafts.size)) return false;
    restore();
    const params = query(), requestedBase = base();
    const requestedRoute = state.route, wantsHistory = visible();
    const key = JSON.stringify([requestedBase, params, requestedRoute]);
    if (refreshPromise && refreshKey === key) return refreshPromise;
    const epoch = ++generation;
    refreshKey = key;
    state.assets.loading = true;
    state.assets.historyLoading = wantsHistory;
    paint();
    refreshPromise = (async () => {
      const current = () => epoch === generation && requestedBase === base() && requestedRoute === state.route && same(params, query());
      let overviewArrived = false;
      const overview = (async () => {
        try {
          const data = result(await api.assetsOverview(params.primary_currency));
          if (!current()) return;
          if (!data || !Array.isArray(data.accounts) || !data.summary) throw new Error(tx('assetLoadError'));
          state.assets.overview = data; state.assets.accounts = data.accounts; state.assets.accountsLoaded = true;
          state.assets.cachedAt.overview = 0; state.assets.cachedAt.accounts = 0; state.assets.error = ''; overviewArrived = true;
          cache.put(base(), 'overview', params.primary_currency, data);
          cache.put(base(), 'accounts', '', { items: data.accounts });
        } catch (error) { if (current()) state.assets.error = error.message; }
        finally { if (current()) { state.assets.loading = false; paint(); } }
      })();
      const history = (async () => {
        if (!wantsHistory) return;
        try {
          const data = result(await api.assetsHistory(params));
          if (!current()) return;
          if (!Array.isArray(data?.items) || !Array.isArray(data?.accounts)) throw new Error(tx('assetLoadError'));
          state.assets.history = data; state.assets.historyKey = JSON.stringify(params);
          state.assets.cachedAt.history = 0; state.assets.historyError = '';
          cache.put(base(), 'history', JSON.stringify(params), data);
        } catch (error) { if (current()) state.assets.historyError = error.message; }
        finally { if (current()) { state.assets.historyLoading = false; paint(); } }
      })();
      const accounts = (async () => {
        if (!force && state.assets.accountsLoaded && !state.assets.cachedAt.accounts) return;
        try {
          const data = result(await api.listAccounts());
          if (!current() || overviewArrived) return;
          if (!Array.isArray(data?.items)) throw new Error(tx('assetLoadError'));
          state.assets.accounts = data.items; state.assets.accountsLoaded = true; state.assets.cachedAt.accounts = 0;
          cache.put(base(), 'accounts', '', data); paint();
        } catch (error) { if (current() && !overviewArrived) { state.assets.error = error.message; paint(); } }
      })();
      await Promise.allSettled([overview, history, accounts]);
      return current() && !state.assets.error;
    })().finally(() => {
      if (epoch === generation) { state.assets.loading = false; state.assets.historyLoading = false; refreshPromise = null; paint(); }
    });
    return refreshPromise;
  }

  function timeFilters(start, end) {
    const filters = {};
    if (start) filters.start_time = start + 'T00:00:00+09:00';
    if (end) {
      const next = new Date(end + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      filters.end_time = next.toISOString().slice(0, 10) + 'T00:00:00+09:00';
    }
    if (start && end && start > end) throw new Error(tx('assetInvalidDate'));
    return filters;
  }

  async function loadChanges(append = false) {
    const modal = state.modal;
    if (modal?.type !== 'asset-detail') return;
    const data = modal.data;
    if (append && data.loading) return;
    const epoch = ++changesGeneration;
    data.loading = true;
    data.error = '';
    patchAssetChanges(context());
    try {
      const response = result(await api.accountChanges(data.id, { ...timeFilters(data.start, data.end), limit: 50, offset: append ? data.items.length : 0 }));
      if (state.modal !== modal || epoch !== changesGeneration) return;
      data.items = append ? [...data.items, ...response.items] : response.items;
      data.has_more = response.has_more;
    } catch (error) { if (epoch === changesGeneration) data.error = error.message; }
    finally { if (epoch === changesGeneration) { data.loading = false; if (state.modal === modal) patchAssetChanges(context()); } }
  }

  async function afterWrite() {
    cache.clear(base());
    generation += 1;
    refreshPromise = null;
    const ok = await refresh({ force: true });
    if (!ok || visible() && state.assets.historyError) notify(tx('assetReadAfterWrite'), 'error');
    if (state.importData) state.importData.setupLoaded = false;
    return ok;
  }

  async function openIncome(id, normalized = {}) {
    const requestedBase = base(), requestedRoute = state.route, requestedModal = state.modal;
    const current = () => requestedBase === base() && requestedRoute === state.route && requestedModal === state.modal;
    const parameters = { account_number: normalized.AccountNumber, limit: 100, offset: 0 };
    const time = Date.parse(normalized.isotime);
    if (Number.isFinite(time)) {
      parameters.start_time = new Date(time).toISOString();
      parameters.end_time = new Date(time + 1000).toISOString();
    }
    // Imports retain their original account/time even after the income is edited.
    const queries = parameters.account_number != null || parameters.start_time ? [parameters, { limit: 100, offset: 0 }] : [parameters];
    for (const query of queries) {
      while (current()) {
        const data = result(await api.listIncome(query));
        if (!current()) return;
        if (!Array.isArray(data?.items)) throw new Error(tx('assetLoadError'));
        const income = data.items.find(row => String(row.income_id) === String(id));
        if (income) { openModal('asset-income-detail', income); return; }
        if (!data.has_more || !data.items.length) break;
        query.offset += data.items.length;
      }
    }
    if (!current()) return;
    throw new Error(tx('assetIncomeMissing'));
  }

  function dateValue(value) {
    const date = new Date(value + '+09:00');
    if (!value || Number.isNaN(date.getTime()) || date > new Date()) throw new Error(tx('assetInvalidDate'));
    return date.toISOString();
  }

  async function submit(form) {
    if (form.dataset.saving) return;
    const modal = state.modal;
    const data = new FormData(form), kind = form.dataset.assetsForm;
    const original = modal.data || {};
    const value = (key) => String(data.get(key) || '').trim();
    const errorNode = form.querySelector('[data-assets-form-error]');
    try {
      let payload, write;
      if (kind === 'account') {
        payload = { name: value('name'), account_type: value('account_type'), institution: value('institution') };
        if (payload.account_type === 'credit') payload.credit_limit = value('credit_limit') ? decimalAmount(value('credit_limit'),
          original.id ? findAssetAccount(state, original.id)?.currency : value('currency'), { nonnegative: true }) : null;
        if (original.id) write = (key) => api.updateAccount(original.id, payload, key);
        else {
          const opening = !value('opening_balance') ? null : payload.account_type === 'credit' ? debtBalance(value('opening_balance'), value('currency')) : decimalAmount(value('opening_balance'), value('currency'));
          Object.assign(payload, { currency: value('currency'), opening_balance: opening,
            effective_at: dateValue(value('effective_at')) });
          if (value('account_number')) payload.account_number = Number(value('account_number'));
          write = (key) => api.createAccount(payload, key);
        }
      } else if (kind === 'calibrate') {
        const account = findAssetAccount(state, original.id);
        const confirmed = account.account_type === 'credit' ? debtBalance(value('confirmed_balance'), account.currency) : decimalAmount(value('confirmed_balance'), account.currency);
        payload = { confirmed_balance: confirmed, effective_at: dateValue(value('effective_at')), note: value('note') };
        write = (key) => api.calibrateAccount(original.id, payload, key);
      } else if (kind === 'income') {
        const account = findAssetAccount(state, value('account_number'));
        if (!account || assetNumber(account.balance) === null) throw new Error(tx('assetNeedAccount'));
        const effective = dateValue(value('effective_at'));
        const unchangedTime = original.effective_at && Math.floor(Date.parse(original.effective_at) / 1000) === Math.floor(Date.parse(effective) / 1000);
        payload = { account_number: Number(account.account_number), amount: decimalAmount(value('amount'), value('currency'), { positive: true }), currency: value('currency'),
          effective_at: unchangedTime ? original.effective_at : effective, source_name: value('source_name'), note: value('note') };
        if (value('settled_amount') || assetCurrency(account.currency) !== assetCurrency(payload.currency)) payload.settled_amount = decimalAmount(value('settled_amount'), account.currency, { positive: true });
        write = (key) => original.income_id ? api.updateIncome(original.income_id, payload, key) : api.createIncome(payload, key);
      } else return;
      const operationId = operationKey(operations, modal, payload);
      form.dataset.saving = 'true';
      errorNode.textContent = '';
      for (const input of form.elements) input.disabled = true;
      cache.clear(base());
      await write(operationId);
      operations.delete(modal);
      delete form.dataset.saving;
      if (state.modal === modal) closeModal();
      notify(tx('assetSaved'), 'success');
      await afterWrite();
    } catch (error) {
      errorNode.textContent = tx('assetWriteFailed') + ': ' + (error.message === 'assetInvalidAmount' ? tx(error.message) : error.message);
    } finally {
      delete form.dataset.saving;
      for (const input of form.elements) input.disabled = false;
    }
  }

  async function click(target) {
    const currency = target.closest('[data-assets-display-currency]');
    if (currency && ['', 'JPY', 'CNY'].includes(currency.dataset.assetsDisplayCurrency)) {
      state.assetPreview.currency = currency.dataset.assetsDisplayCurrency;
      cache.put(base(), 'view', '', { currency: state.assetPreview.currency });
      await refresh(); return true;
    }
    const open = target.closest('[data-assets-open]');
    if (open) {
      const kind = open.dataset.assetsOpen, id = open.dataset.id;
      let data = { id };
      if (kind === 'income' && !id && state.modal?.type === 'asset-detail') data = { account_number: Number(state.modal.data.id) };
      if (kind === 'income' && id) {
        data = state.modal?.type === 'asset-income-detail' && String(state.modal.data.income_id) === id ? state.modal.data : null;
        if (!data) { notify(tx('assetIncomeMissing'), 'error'); return true; }
      }
      if (kind === 'detail') data = { id, items: [], start: '', end: '' };
      openModal('asset-' + kind, data);
      if (kind === 'detail') {
        const modal = state.modal;
        try {
          const account = result(await api.getAccount(id));
          if (state.modal === modal) { state.assets.accounts = state.assets.accounts.map((row) => row.account_number === account.account_number ? account : row); renderModal(); }
        } catch (error) { if (state.modal === modal) modal.data.error = error.message; }
        if (state.modal === modal) await loadChanges();
      }
      return true;
    }
    if (target.closest('[data-assets-changes-more]')) { await loadChanges(!state.modal?.data.error); return true; }
    if (target.closest('[data-assets-refresh]')) { await refresh({ force: true }); return true; }
    const revoke = target.closest('[data-assets-revoke]');
    if (revoke) {
      if (revoke.disabled || !window.confirm(tx('assetRevokeHint'))) return true;
      const id = revoke.dataset.assetsRevoke, scope = 'income-delete:' + id;
      revoke.disabled = true;
      try {
        cache.clear(base());
        await api.deleteIncome(id, operationKey(operations, scope, { id })); operations.delete(scope);
        if (state.modal?.type === 'asset-income-detail' && String(state.modal.data.income_id) === id) closeModal();
        notify(tx('assetCancelled'), 'success'); await afterWrite();
      }
      catch (error) { notify(error.message, 'error'); }
      finally { revoke.disabled = false; }
      return true;
    }
    const dealing = target.closest('[data-assets-deal]');
    if (dealing) { const deal = findDeal(dealing.dataset.assetsDeal); if (deal) openModal('deal-detail', deal); else notify(tx('assetMissingDeal')); return true; }
    return false;
  }

  function balanceFeedback(response, fallback) {
    const sync = response?.result?.balance_sync;
    if (sync?.status === 'unlinked') notify(tx('assetSavedUnlinked') + (sync.reason ? ' · ' + sync.reason : ''), 'warning');
    else notify(fallback || tx('assetSaved'), 'success');
    afterWrite();
  }

  return { restore, loadSettings, refresh, loadChanges, afterWrite, openIncome, submit, click, balanceFeedback,
    poll: async () => { if (visible() && !busy() && !state.dealDrafts.size) await refresh(); },
    filterChanges: async (form) => {
      const data = new FormData(form), target = state.modal.data;
      const start = String(data.get('start') || ''), end = String(data.get('end') || '');
      try { timeFilters(start, end); } catch (error) { notify(error.message, 'error'); return; }
      target.start = start; target.end = end;
      await loadChanges();
    },
    saveCurrency: async (currency, requestedBase) => {
      await api.saveAssetsSettings(assetCurrency(currency), requestedBase);
      state.assetPreview.currency = '';
      cache.put(requestedBase, 'view', '', { currency: '' });
      settingsBase = requestedBase;
    },
  };
}
