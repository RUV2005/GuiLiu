import { ApiClient } from './api.js';
import { normalizeServiceBase } from './utils.js';
import { createPlansApi } from './plans-api.js';
import { createPlansState, planDraft, planFunding, preparePayload, progressOperation, historicalRange, japanDay, planResult, resultList, visiblePlan, apiCurrency } from './plans-model.js';
import { planText, planMoney } from './plans-copy.js';
import { loadAllocations, allocationPreview, allocationScale, allocationDelta } from './plans-allocation.js';
import { plansParts, planQuestions } from './plans-view.js';
import { localizeMarkup } from './language-view.js';
import { createChartHover } from './agent-chart-hover.js';

export function createPlansController({ state, api, context, changed = () => {}, document: doc = globalThis.document,
  storage = globalThis.localStorage, uuid = () => crypto.randomUUID(), confirm = message => globalThis.confirm(message),
  afterAssetsWrite = async () => {} }) {
  const requests = new Map(), cache = new WeakMap();
  let owner, signature, opener, observedRoot, hoverRoot, hover, sliderPointer, lastRoute = '', disposed = false;
  const resize = globalThis.ResizeObserver ? new ResizeObserver(() => paint()) : null;
  const current = () => state.plans;
  const tx = key => planText(state.settings.language, key);
  const source = () => JSON.stringify([normalizeServiceBase(api.settings().agentPath), normalizeServiceBase(api.settings().backendPath)]);
  const keyFor = s => 'abk-plan-pending-v1:' + encodeURIComponent(s.source);
  const syncKeyFor = s => 'abk-plan-progress-sync-v1:' + encodeURIComponent(s.source);
  const client = s => createPlansApi(new ApiClient(() => s.settings));
  const valid = s => !disposed && s === current() && s.source === source();
  function ensureSource() {
    if (current().source === source()) return;
    for (const request of requests.values()) request.abort();
    requests.clear();
    const s = createPlansState(); s.source = source(); s.settings = { ...api.settings() };
    try {
      const raw = JSON.parse(storage.getItem(keyFor(s)) || 'null');
      if (raw && ['create', 'update', 'accounts', 'entry', 'undo', 'delete', 'syncProgress'].includes(raw.action) && typeof raw.key === 'string') s.pending = raw;
    } catch { s.errors.storage = 'storageError'; }
    try { s.syncAssets = Object.fromEntries(Object.entries(JSON.parse(storage.getItem(syncKeyFor(s)) || '{}')).filter(([, value]) => value === true)); }
    catch { s.syncAssets = {}; }
    state.plans = s; owner = null;
  }
  function paint() {
    const s = current(), root = doc?.querySelector('[data-plans-root]');
    if (disposed || state.route !== 'goals' || !root) return;
    if (root !== hoverRoot) { hover?.dispose(); hoverRoot = root; hover = createChartHover(root); }
    const width = root.querySelector('.plan-trend')?.clientWidth || root.querySelector('.plan-detail-pane')?.clientWidth || 600;
    s.chartWidth = Math.max(260, Math.round(width));
    if (resize && root !== observedRoot) { resize.disconnect(); resize.observe(root); observedRoot = root; }
    const dialog = root.querySelector('[data-plan-dialog]'), active = doc.activeElement;
    const focusAction = active?.dataset?.planAction, focusId = active?.dataset?.id;
    const focusedSlider = active?.dataset?.planAllocation;
    const focusedField = active?.dataset?.planField;
    const selection = focusedField && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    if (dialog.open && !s.dialog) dialog.close();
    const nextSignature = s.dialog ? s.dialog.revision || 0 : '';
    for (const [key, html] of Object.entries(plansParts(context()))) {
      const node = root.querySelector('[data-plans-part="' + key + '"]');
      if (!node) continue;
      // A resize or read must not replace a range input while it owns a drag.
      if (['detail', 'funding'].includes(key) && sliderPointer?.isConnected && !s.busy && sliderPointer.closest('[data-plan-detail]')?.dataset.planDetail === s.selected) continue;
      if (key === 'dialog' && owner === s.dialog && signature === nextSignature && node.querySelector('form')) {
        if (node.dataset.language !== state.settings.language) localizeMarkup(node, '<div>' + html + '</div>');
      } else if (cache.get(node) !== html) { hover?.clearWithin(node); node.innerHTML = html; cache.set(node, html); }
      node.dataset.language = state.settings.language;
    }
    owner = s.dialog; signature = nextSignature;
    const e = s.dialog, error = dialog.querySelector('[data-plan-dialog-error]');
    if (error) error.textContent = e?.error ? tx(e.error) : e && ['accounts', 'create', 'progress'].includes(e.type) ? tx(s.errors.accounts || '') : '';
    const questions = dialog.querySelector('[data-plan-questions]'), questionHtml = planQuestions(context());
    if (questions && cache.get(questions) !== questionHtml) { questions.innerHTML = questionHtml; cache.set(questions, questionHtml); }
    const retry = dialog.querySelector('[data-plan-action="retry"]'), pendingMessage = dialog.querySelector('[data-plan-pending-message]');
    const keepIncome = dialog.querySelector('[data-plan-action="keepIncome"]');
    if (keepIncome) { keepIncome.hidden = s.pending?.stage !== 'review'; keepIncome.disabled = Boolean(s.busy); }
    if (retry) { retry.hidden = !s.pending; retry.disabled = Boolean(s.busy); retry.textContent = tx(s.pending?.stage === 'review' ? 'retryProgress' : 'retrySame'); }
    if (pendingMessage) { pendingMessage.hidden = !s.pending; pendingMessage.textContent = tx(s.pending?.action === 'syncProgress' && s.pending.stage !== 'income' ? 'incomeSavedPending' : 'uncertain'); }
    const fieldset = dialog.querySelector('fieldset');
    if (fieldset) fieldset.disabled = Boolean(s.busy || s.pending);
    const submit = dialog.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = Boolean(s.busy || s.pending || e?.draft.type === 'spending_reduction' || (['create', 'progress'].includes(e?.type) && s.loading.accounts));
      submit.setAttribute('aria-busy', String(Boolean(s.busy)));
      submit.textContent = tx(s.busy ? s.busy === 'prepare' ? 'preparing' : 'working' :
        ['create', 'edit'].includes(e?.type) ? 'done' : e?.type === 'progress' ? e.draft.sync_assets ? 'saveSyncedProgress' : 'saveProgress' : 'save');
    }
    for (const close of dialog.querySelectorAll('[data-plan-action="close"]')) close.disabled = Boolean(s.busy || s.pending);
    for (const manage of dialog.querySelectorAll('[data-plan-manage-action]')) manage.disabled = Boolean(s.busy || s.pending);
    const primaryCreate = root.querySelector('.page-header [data-plan-action="create"]');
    if (primaryCreate) primaryCreate.disabled = Boolean(s.busy || s.pending);
    if (e && !dialog.open) { dialog.showModal(); dialog.querySelector('[data-plan-field="title"], [data-plan-field], input')?.focus({ preventScroll: true }); }
    if (active && !active.isConnected) {
      const next = [...root.querySelectorAll('[data-plan-action], [data-plan-field], [data-plan-allocation]')].find(node => focusedSlider ? node.dataset.planAllocation === focusedSlider : focusedField ? node.dataset.planField === focusedField : focusAction && node.dataset.planAction === focusAction && node.dataset.id === focusId);
      next?.focus({ preventScroll: true });
      if (selection && next?.setSelectionRange) next.setSelectionRange(...selection);
    }
    changed();
  }
  async function read(slot, execute, accept, options = {}) {
    ensureSource();
    const s = current(), abort = new AbortController();
    requests.get(slot)?.abort(); requests.set(slot, abort);
    s.loading[slot] = true; delete s.errors[slot]; paint();
    try {
      const response = await execute(client(s), { signal: abort.signal });
      if (!valid(s) || abort.signal.aborted) return false;
      accept(response, s); return true;
    } catch (error) {
      if (valid(s) && !abort.signal.aborted) {
        s.errors[slot] = error.status === 404 ? slot === 'list' || slot === 'accounts' ? 'endpointMissing' : 'planMissing' : error.message || 'loadFailed';
        options.onError?.(error, s);
      }
      return false;
    } finally {
      if (requests.get(slot) === abort) { requests.delete(slot); if (valid(s)) { s.loading[slot] = false; paint(); } }
    }
  }
  async function list(append = false) {
    const s = current(), offset = append ? s.items.length : 0;
    return read('list', async (api, options) => {
      let response, result, items = [];
      // Count server rows (including hidden completed plans) for pagination.
      do {
        response = await api.list({ limit: 20, offset: offset + items.length }, options);
        result = resultList(response);
        items.push(...result.items);
      } while (result.items.length && !items.some(visiblePlan) && offset + items.length < result.total);
      return { ...response, result: { ...result, items } };
    }, (response, next) => {
      const result = resultList(response);
      next.items = append ? [...new Map([...next.items, ...result.items].map(row => [row.id, row])).values()] : result.items;
      next.total = result.total; next.loaded = true;
      // A selected plan can be outside the first page after refresh or creation.
      const selected = next.items.find(row => row.id === next.selected) || next.detail;
      if (!next.selected || selected && !visiblePlan(selected)) {
        next.selected = next.items.find(visiblePlan)?.id || ''; next.detail = null; next.chart = null; next.entries = []; next.entryTotal = 0;
      }
    });
  }
  const accounts = () => read('accounts', (api, options) => api.accounts(options), (response, s) => { s.accounts = resultList(response).items; s.accountsLoaded = true; });
  async function allocations(plan) {
    return read('allocations', (api, options) => loadAllocations(api, plan, options), (snapshot, s) => {
      if (s.selected === plan.id && s.detail?.version === plan.version) s.allocations = snapshot;
    });
  }
  async function entries(append = false) {
    const s = current(), id = s.selected, offset = append ? s.entries.length : 0;
    if (!id) return;
    return read('entries', (api, options) => api.entries(id, { limit: 20, offset }, options), (response, next) => {
      if (id !== next.selected) return;
      const result = resultList(response);
      next.entries = append ? [...new Map([...next.entries, ...result.items].map(row => [row.id, row])).values()] : result.items;
      next.entryTotal = result.total;
    });
  }
  async function detail(id = current().selected) {
    if (!id) return;
    let hiddenPlan = false;
    const ok = await read('detail', (api, options) => api.get(id, options), (response, s) => {
      if (id !== s.selected) return;
      const plan = planResult(response);
      if (!plan.id || !Number.isInteger(plan.version) || !plan.progress || !Array.isArray(plan.account_numbers)) throw new Error('invalidResponse');
      s.detail = plan;
      if (s.allocationDraft && (s.allocationDraft.id !== plan.id || s.allocationDraft.version !== plan.version)) {
        s.allocationDraft = null; s.notice = 'allocationChanged';
      }
      s.items = s.items.map(row => row.id === id ? plan : row);
      if (!visiblePlan(plan)) {
        hiddenPlan = true;
        s.selected = s.items.find(visiblePlan)?.id || ''; s.detail = null; s.chart = null; s.entries = []; s.entryTotal = 0;
      }
    }, { onError(error, s) { if (error.status === 404 && id === s.selected) { s.detail = null; s.chart = null; s.entries = []; } } });
    const s = current();
    if (ok && hiddenPlan && s.selected) return detail(s.selected);
    if (ok && id === s.selected && s.detail) {
      await read('chart', (api, options) => api.progress(id, historicalRange(s.detail), options), (response, next) => {
        if (id === next.selected) next.chart = planResult(response);
      });
      if (id === current().selected) await entries();
      if (valid(s) && id === s.selected && s.detail?.id === id && s.detail.account_numbers.length) await allocations(s.detail);
    }
  }
  async function refresh({ afterWrite = false } = {}) {
    ensureSource();
    if (state.route !== 'goals' || current().busy && !afterWrite) return;
    const s = current();
    await list();
    if (!valid(s)) return;
    await accounts();
    if (valid(s)) await detail();
    if (valid(s) && s.notice === 'profilePending' && s.detail?.profile_sync === 'synced') { s.notice = 'saved'; paint(); }
  }
  async function select(id) {
    const s = current();
    if (s.selected !== id) { requests.get('allocations')?.abort(); s.allocations = null; s.allocationDraft = null; delete s.errors.allocations; s.selected = id; s.detail = null; s.chart = null; s.entries = []; s.entryTotal = 0; s.notice = ''; paint(); }
    await detail(id);
  }
  function close(force = false) {
    const s = current();
    if (!force && (s.busy || s.pending || (s.dialog?.dirty && !confirm(tx('discard'))))) return;
    s.dialog = null; paint(); opener?.focus({ preventScroll: true });
  }
  function open(type, allocation = null) {
    const s = current(), plan = type === 'create' ? null : s.detail;
    if (s.busy || s.pending || (type !== 'create' && !plan)) return;
    opener = doc?.activeElement;
    let draft = type === 'create' ? planDraft(state.settings.contextCurrency) : planDraft(plan.currency, plan);
    if (type === 'increase' || type === 'decrease') {
      if (plan.status !== 'active' || plan.start_date > japanDay()) throw new Error('inactivePlan');
      draft = { type: type === 'increase' ? 'contribution' : 'withdrawal', amount: '', note: '',
        account_number: plan.account_numbers.length === 1 ? String(plan.account_numbers[0]) : '',
        sync_assets: type === 'increase' && s.syncAssets[plan.id] === true };
      if (allocation) Object.assign(draft, allocationDelta(plan, allocation));
      type = 'progress';
    }
    s.dialog = { type, id: plan?.id, original: plan ? structuredClone(plan) : null, draft, questions: [], dirty: false, error: '',
      accountNumbers: [...(plan?.account_numbers || [])], revision: 0, allocation };
    s.notice = ''; paint();
    const dialog = s.dialog;
    const loading = ['create', 'accounts', 'progress'].includes(type)
      ? accounts().then(() => { if (valid(s) && s.dialog === dialog) { dialog.revision++; paint(); } }) : undefined;
    return loading;
  }
  function storePending(s, operation) {
    try { storage.setItem(keyFor(s), JSON.stringify(operation)); }
    catch { throw new Error('storageError'); }
    s.pending = operation;
  }
  function clearPending(s) {
    s.pending = null;
    try { storage.removeItem(keyFor(s)); } catch { /* A stale record can only replay the same idempotent operation. */ }
  }
  async function mutate(operation, retry = false) {
    ensureSource();
    const s = current();
    if (s.busy || (!retry && s.pending)) return;
    if (!retry) storePending(s, { ...operation, key: uuid(), ...(operation.action === 'syncProgress' ? { incomeKey: uuid() } : {}) });
    let op = s.pending;
    if (!op) return;
    s.busy = 'save'; s.errors.write = ''; paint();
    try {
      const api = client(s);
      if (op.action === 'syncProgress') {
        if (op.stage === 'income') {
          const receipt = planResult(await api.createIncome(op.incomeBody, op.incomeKey));
          if (!Number.isSafeInteger(receipt.income_id) || receipt.income_id <= 0 || !Number.isSafeInteger(receipt.change_id) || receipt.change_id <= 0) throw new Error('invalidResponse');
          // Income and plan entries use separate services. Keep the durable receipt before proceeding.
          storePending(s, { ...op, stage: 'entry', incomeId: receipt.income_id, body: { ...op.body, change_id: receipt.change_id } });
          op = s.pending;
          if (!valid(s)) return;
        } else if (op.stage === 'review') {
          // Only an explicitly retried, definitively rejected entry can use a new version/key.
          const latest = planResult(await api.get(op.id));
          if (!Number.isInteger(latest.version) || latest.status !== 'active' || !latest.account_numbers?.includes(op.body.account_number) || apiCurrency(latest.currency) !== apiCurrency(op.incomeBody.currency)) throw new Error('syncPlanChanged');
          if (!valid(s)) return;
          storePending(s, { ...op, stage: 'entry', key: uuid(), body: { ...op.body, expected_version: latest.version } });
          op = s.pending;
        }
      }
      const response = await ({
        create: () => api.create(op.body, op.key), update: () => api.update(op.id, op.body, op.key),
        accounts: () => api.setAccounts(op.id, op.body, op.key), entry: () => api.addEntry(op.id, op.body, op.key),
        undo: () => api.removeEntry(op.id, op.entryId, op.version, op.key), delete: () => api.remove(op.id, op.version, op.key),
        syncProgress: () => api.addEntry(op.id, op.body, op.key),
      }[op.action])();
      const result = planResult(response);
      if (op.action === 'syncProgress' && (result.id !== op.id || !Number.isInteger(result.version))) throw new Error('invalidResponse');
      if (op.action === 'create' && op.accountNumbers?.length) {
        if (!result.id || !Number.isInteger(result.version)) throw new Error('invalidResponse');
        // Persist the second step before discarding the idempotent creation receipt.
        storePending(s, { action: 'accounts', id: result.id, key: uuid(), afterCreate: true, profilePending: result.profile_sync === 'pending',
          body: { expected_version: result.version, account_numbers: op.accountNumbers, mode: 'partial' } });
        if (!valid(s)) return;
        s.selected = result.id; s.dialog = null; s.busy = false;
        await mutate(null, true);
        return;
      }
      clearPending(s);
      if (!valid(s)) return;
      s.notice = result.profile_sync === 'pending' || op.profilePending ? 'profilePending' : op.action === 'syncProgress' ? 'syncedProgressSaved' : 'saved';
      s.allocationDraft = null; s.allocations = null;
      s.dialog = null;
      if (op.action === 'create' || op.afterCreate) s.selected = op.afterCreate ? op.id : result.id;
      if (op.action === 'delete') {
        if (s.items.some(plan => plan.id === op.id)) s.total = Math.max(0, s.total - 1);
        s.items = s.items.filter(plan => plan.id !== op.id);
        s.selected = s.items.find(visiblePlan)?.id || ''; s.detail = null; s.chart = null; s.entries = []; s.entryTotal = 0; s.notice = 'deletedNotice';
      }
      if (op.action === 'update' && op.body.status && !visiblePlan({ status: op.body.status })) {
        s.items = s.items.map(row => row.id === op.id ? { ...row, status: op.body.status } : row);
        s.selected = s.items.find(visiblePlan)?.id || ''; s.detail = null; s.chart = null; s.entries = []; s.entryTotal = 0;
      }
      await refresh({ afterWrite: true });
    } catch (error) {
      if (!valid(s)) return;
      const definitive = op.action === 'syncProgress' ? [400, 401, 403, 404, 409, 422].includes(error.status) : error.status >= 400 && error.status < 500;
      const incomeSaved = op.action === 'syncProgress' && op.stage !== 'income';
      let storageMessage = '';
      if (definitive && incomeSaved) {
        try { storePending(s, { ...op, stage: 'review' }); } catch { storageMessage = ' ' + tx('storageError'); }
      } else if (definitive) clearPending(s);
      const message = (incomeSaved ? tx('incomeSavedPending') + ' ' : op.afterCreate ? tx('accountLinkIncomplete') + ' ' : '') + (error.status === 409 ? tx('conflict') + ' ' + error.message : tx(error.message)) + storageMessage;
      s.errors.write = message;
      if (op.afterCreate) { s.selected = op.id; s.dialog = null; }
      if (s.dialog) {
        s.dialog.error = message;
        if (error.status === 409) s.dialog.questions = [];
      }
      if (definitive || op.afterCreate) await refresh({ afterWrite: true });
    } finally {
      if (op.action === 'syncProgress' && valid(s)) {
        try { if (await afterAssetsWrite() === false) s.errors.assetsRefresh = 'assetRefreshFailed'; else delete s.errors.assetsRefresh; }
        catch { s.errors.assetsRefresh = 'assetRefreshFailed'; }
      }
      s.busy = false;
      if (valid(s)) paint();
    }
  }
  async function submit() {
    const s = current(), e = s.dialog;
    if (!e || s.busy || s.pending) return;
    try {
      e.error = '';
      if (['create', 'edit'].includes(e.type)) {
        if (e.draft.type === 'spending_reduction') throw new Error('reductionUnavailable');
        if (e.type === 'create') {
          if (s.loading.accounts) return;
          const funding = planFunding(e.draft, s.accounts, state.settings.contextCurrency);
          e.draft.currency = funding.currency; e.accountNumbers = funding.accountNumbers;
        }
        const body = preparePayload(e.draft, e.type === 'edit' ? e.original : null);
        e.questions = []; s.busy = 'prepare'; paint();
        const result = planResult(await client(s).prepare(body));
        if (!valid(s) || s.dialog !== e) return;
        if (!result.draft_id || !result.fields || !Array.isArray(result.questions) || typeof result.ready !== 'boolean' || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('invalidResponse');
        e.questions = result.questions;
        if (!result.ready || result.questions.length) throw new Error('needsAnswers');
        if (result.fields.type !== e.draft.type || apiCurrency(result.fields.currency) !== apiCurrency(e.draft.currency)) throw new Error('draftMismatch');
        if (Date.parse(result.expires_at) <= Date.now()) throw new Error('expired');
        if (e.type === 'edit' && !Number.isInteger(result.base_version)) throw new Error('invalidResponse');
        // The same click prepares and saves; mutate immediately takes over the busy lock.
        s.busy = false;
        await mutate({ action: e.type === 'create' ? 'create' : 'update', id: e.id, ...(e.type === 'create' ? { accountNumbers: [...e.accountNumbers] } : {}),
          body: e.type === 'create' ? { draft_id: result.draft_id } : { expected_version: result.base_version, draft_id: result.draft_id } });
      } else if (e.type === 'accounts') {
        await mutate({ action: 'accounts', id: e.id, body: { expected_version: s.detail.version, account_numbers: e.accountNumbers, mode: 'partial' } });
      } else if (e.type === 'progress') {
        if (s.loading.accounts || s.errors.accounts && (e.draft.account_number || e.draft.sync_assets)) throw new Error('syncAccountsUnavailable');
        if (e.allocation) {
          // Check before recording income; a stale absolute allocation must not create a new deposit.
          s.busy = 'check'; paint();
          const latest = planResult(await client(s).get(e.id));
          if (!valid(s) || s.dialog !== e) return;
          if (latest.id !== e.id || latest.version !== e.original.version) {
            await refresh({ afterWrite: true });
            throw new Error('allocationChanged');
          }
          s.busy = false;
        }
        await mutate(progressOperation(e.original, e.draft, s.accounts));
      }
    } catch (error) { if (valid(s) && s.dialog === e) e.error = error.message; }
    finally {
      s.busy = false;
      if (valid(s)) {
        paint();
        if (s.dialog === e && e.error) doc?.querySelector('[data-plan-dialog-error]')?.focus();
      }
    }
  }
  async function action(action, id = '') {
    ensureSource();
    const s = current();
    try {
      if (action === 'close') return close();
      if (action === 'retry') return await mutate(null, true);
      if (action === 'keepIncome') {
        if (s.busy || s.pending?.action !== 'syncProgress' || s.pending.stage !== 'review' || !confirm(tx('confirmKeepIncome'))) return;
        clearPending(s); s.dialog = null; s.errors.write = ''; s.notice = 'incomeKept'; paint(); return;
      }
      if (action === 'select') return await select(id);
      if (action === 'more') return await entries(true);
      if (action === 'morePlans') return await list(true);
      if (s.busy || s.pending) return;
      if (action === 'finish' || action === 'delete') {
        const e = s.dialog;
        if (e?.type !== 'edit' || !e.id || e.id !== id || e.original?.id !== id) return;
        if (s.detail?.id !== id || s.detail.version !== e.original.version) {
          e.error = 'managementChanged'; paint(); return;
        }
        const question = tx(action === 'finish' ? 'confirmFinish' : 'confirmDelete') + (e.dirty ? '\n\n' + tx('managementUnsaved') : '');
        if (!confirm(question)) return;
        e.error = '';
        return await mutate(action === 'delete' ? { action, id, version: e.original.version }
          : { action: 'update', id, body: { expected_version: e.original.version, status: 'completed' } });
      }
      if (action === 'cancelAllocation') { s.allocationDraft = null; paint(); return; }
      if (action === 'allocation') {
        const d = s.allocationDraft, plan = s.detail;
        if (!d || d.account !== Number(id) || d.id !== plan?.id || d.version !== plan.version || s.loading.allocations || s.loading.detail || s.errors.allocations) throw new Error('allocationChanged');
        const delta = allocationDelta(plan, d);
        if (delta) return open(delta.type === 'contribution' ? 'increase' : 'decrease', { ...d });
        return;
      }
      if (action === 'kind') {
        const e = s.dialog;
        if (!e || !['create', 'edit'].includes(e.type) || e.original?.type === 'investment' || !['saving', 'spending_reduction'].includes(id)) return;
        e.draft.type = id; e.questions = []; e.error = ''; e.dirty = true; e.revision++; paint(); return;
      }
      if (['create', 'edit', 'accounts', 'increase', 'decrease'].includes(action)) return open(action);
      const plan = s.detail;
      if (!plan) return;
      if (action === 'undo') {
        if (!confirm(tx('confirmUndo'))) return;
        return await mutate({ action, id: plan.id, version: plan.version, entryId: id });
      }
      if (action === 'restore') {
        await mutate({ action: 'update', id: plan.id, body: { expected_version: plan.version, status: 'active' } });
      }
    } catch (error) { s.errors.write = error.message; paint(); }
  }
  function input(event) {
    const field = event.target, s = current(), e = s.dialog;
    if (field.matches('[data-plan-allocation]') && event.type === 'input') {
      if (!field.disabled) previewAllocation(Number(field.dataset.planAllocation), field.value);
      return;
    }
    if (!e || s.busy || s.pending || !field.closest('[data-plan-form]')) return;
    const name = field.dataset.planField;
    if (name) {
      if (e.allocation && ['amount', 'account_number', 'type'].includes(name)) return;
      e.draft[name] = field.type === 'checkbox' ? field.checked : field.value;
      e.dirty = true;
      if (name === 'funding_account' && e.type === 'create' && event.type === 'change') {
        try {
          const funding = planFunding(e.draft, s.accounts, state.settings.contextCurrency);
          e.draft.currency = funding.currency; e.accountNumbers = funding.accountNumbers; e.error = '';
        } catch (error) { e.error = error.message; }
        e.questions = []; e.revision++; paint();
      }
      // Syncing a contribution to account income is chosen in the entry dialog and remembered as this plan's default.
      if (name === 'sync_assets' && e.id) setSyncPreference(e.id, field.checked);
      if (['currency', 'noTarget', 'sync_assets'].includes(name)) { e.revision++; paint(); }
    } else if (field.dataset.planAccount) {
      const id = Number(field.dataset.planAccount);
      e.accountNumbers = field.checked ? [...new Set([...e.accountNumbers, id])] : e.accountNumbers.filter(number => number !== id);
      e.dirty = true;
    }
  }
  function previewAllocation(account, percent) {
    const s = current(), plan = s.detail;
    if (s.busy || s.pending || !plan || plan.status !== 'active' || plan.start_date > japanDay() || s.loading.allocations || s.loading.detail || s.errors.allocations) return;
    try {
      const draft = allocationPreview(plan, s.allocations, account, percent);
      s.allocationDraft = draft;
      // Update only labels and the track. No requests or report rerenders on input.
      for (const row of doc?.querySelectorAll('[data-plan-funding]') || []) {
        const number = Number(row.dataset.planFunding), selected = number === account;
        const value = selected ? draft.amount : s.allocations.amounts[number];
        const scale = allocationScale(plan, value), slider = row.querySelector('[data-plan-allocation]');
        if (!scale || !slider) continue;
        if (!selected) slider.value = scale.percent;
        row.querySelector('[data-allocation-money]').textContent = planMoney(value, plan.currency, state.settings.language);
        row.querySelector('[data-allocation-percent]').textContent = scale.percent + '%';
        slider.setAttribute('aria-valuetext', scale.percent + '% · ' + planMoney(value, plan.currency, state.settings.language));
        slider.style.setProperty('--allocation-fill', Number(slider.value) / Number(slider.max) * 100 + '%');
        row.querySelector('[data-allocation-actions]').hidden = !selected || draft.amount === draft.from;
      }
    } catch (error) { s.errors.write = error.message; paint(); }
  }
  const pointerDown = event => { if (event.target.matches('[data-plan-allocation]')) sliderPointer = event.target; };
  const pointerEnd = () => { if (sliderPointer) { sliderPointer = null; globalThis.requestAnimationFrame?.(() => paint()); } };
  function setSyncPreference(id, enabled) {
    const s = current();
    if (s.busy || s.pending || !s.items.some(plan => plan.id === id)) return;
    const preferences = { ...s.syncAssets, [id]: enabled === true };
    try { storage.setItem(syncKeyFor(s), JSON.stringify(preferences)); s.syncAssets = preferences; delete s.errors.storage; }
    catch { s.errors.storage = 'storageError'; }
    paint();
  }
  const click = event => {
    const button = event.target.closest('[data-plan-action]');
    if (state.route === 'goals' && button && !button.disabled) void action(button.dataset.planAction, button.dataset.id);
  };
  const onSubmit = event => { if (event.target.matches('[data-plan-form]')) { event.preventDefault(); void submit(); } };
  const cancel = event => { if (event.target.matches('[data-plan-dialog]')) { event.preventDefault(); close(); } };
  doc?.addEventListener('click', click); doc?.addEventListener('input', input); doc?.addEventListener('change', input);
  doc?.addEventListener('submit', onSubmit); doc?.addEventListener('cancel', cancel, true);
  doc?.addEventListener('pointerdown', pointerDown); doc?.addEventListener('pointerup', pointerEnd); doc?.addEventListener('pointercancel', pointerEnd);
  function mount() {
    const entering = lastRoute !== 'goals'; lastRoute = state.route;
    if (state.route === 'goals') { ensureSource(); paint(); if (entering || !current().loaded && !current().loading.list) void refresh(); }
    else { resize?.disconnect(); observedRoot = null; hover?.dispose(); hover = null; hoverRoot = null; }
  }
  return { mount, paint, action, submit, refresh, setSyncPreference, previewAllocation, patch() { if (state.route !== 'goals' || !doc?.querySelector('[data-plans-root]')) return false; ensureSource(); paint(); return true; },
    dispose() { disposed = true; resize?.disconnect(); hover?.dispose(); for (const request of requests.values()) request.abort(); doc?.removeEventListener('click', click); doc?.removeEventListener('input', input); doc?.removeEventListener('change', input); doc?.removeEventListener('submit', onSubmit); doc?.removeEventListener('cancel', cancel, true); doc?.removeEventListener('pointerdown', pointerDown); doc?.removeEventListener('pointerup', pointerEnd); doc?.removeEventListener('pointercancel', pointerEnd); } };
}
