import { createImportState, validateImportFile, validateJob, validateRows, processingImport, editableImport,
  planImportBatches, importOperationKey, correctionValues, canEditImportRow, presetTemplate, parseImportPreset,
  defaultImportFilter, IMPORT_SHOWN_STEP } from './import-model.js';
const IMPORT_ROWS_PAGE = 500;

export function createImportService({ api, state, source, changed = () => {}, afterCommit = async () => {},
  storage = globalThis.sessionStorage, preferences = globalThis.localStorage, visible = () => !globalThis.document?.hidden,
  uuid = importOperationKey, schedule = setTimeout, unschedule = clearTimeout }) {
  let timer = null, statusFlight = null, setupFlight = null, rowEpoch = 0;
  const reads = new Set();
  const current = () => state.importData;
  const key = scope => 'abk-import-task-v1:' + encodeURIComponent(scope);
  // The account used last time is offered again (a per-browser convenience).
  const accountKey = scope => 'guiliu-import-account-v1:' + encodeURIComponent(scope);
  const live = s => current() === s && source() === s.scope;
  const paint = s => { if (live(s)) changed(); };
  const message = error => error?.message || String(error);
  const active = () => state.route === 'import' && visible();
  function persist(s) {
    try {
      if (!s.job) storage?.removeItem(key(s.scope));
      else storage?.setItem(key(s.scope), JSON.stringify({ id: s.job.import_id, pending: s.pendingCommit }));
    } catch { s.notice = 'storageUnavailable'; }
  }
  function ensureScope() {
    const scope = source();
    if (current().scope === scope) return current();
    unschedule(timer); timer = null;
    for (const read of reads) read.abort();
    reads.clear(); rowEpoch++; statusFlight = null; setupFlight = null;
    const s = state.importData = createImportState(); s.scope = scope;
    try { s.form.account_number = preferences?.getItem(accountKey(scope)) || ''; } catch { /* Optional. */ }
    try {
      const saved = JSON.parse(storage?.getItem(key(scope)) || 'null');
      if (/^[a-f0-9]{32}$/.test(saved?.id || '')) {
        s.resumeId = saved.id;
        if (saved.pending?.id === saved.id && typeof saved.pending.key === 'string' && Number.isInteger(saved.pending.body?.revision) && Array.isArray(saved.pending.body?.rows)) s.pendingCommit = saved.pending;
      }
    } catch { /* A damaged tab cache must not block a fresh preview. */ }
    return s;
  }
  async function read(s, callback) {
    const controller = new AbortController(); reads.add(controller);
    try { return await callback({ signal: controller.signal }); }
    finally { reads.delete(controller); }
  }
  function applyJob(s, data, own = false) {
    const job = validateJob(data, s.job?.import_id || s.resumeId);
    if (s.job && job.revision < s.job.revision) return false;
    if (s.job && job.revision !== s.job.revision && !own) {
      const reviewing = editableImport(s.job) && (s.choices.size || s.editor || s.confirming);
      s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.confirming = false;
      if (reviewing) s.conflict = true;
      if (s.editor) s.editor.conflict = true;
    }
    s.job = job; s.resumeId = job.import_id;
    if (job.state === 'mapping_required' && s.mappingFor !== job.import_id) {
      s.mappingFor = job.import_id; s.presetOpen = true;
      s.presetText = JSON.stringify(job.mapping_suggestion || presetTemplate(/\.xlsx$/i.test(job.filename) ? '.xlsx' : '.csv'), null, 2);
      s.presetDirty = false;
    }
    persist(s); return true;
  }
  // The whole preview is read once it is ready, so the filter bar can count and filter every row on the page.
  async function loadRows() {
    const s = ensureScope();
    if (!s.job || processingImport(s.job.state) || s.job.state === 'mapping_required') return false;
    const id = s.job.import_id, revision = s.job.revision, token = ++rowEpoch;
    s.rowsLoading = true; paint(s);
    try {
      const rows = [];
      for (let offset = 0; ;) {
        const page = validateRows((await read(s, options => api.getImportRows(id, { offset, limit: IMPORT_ROWS_PAGE }, options))).result, offset);
        if (!live(s) || token !== rowEpoch || s.job?.revision !== revision) return false;
        rows.push(...page.rows); s.total = page.total;
        if (page.next_offset === null) break;
        offset = page.next_offset;
      }
      s.rows = rows; s.rowCache.clear();
      for (const row of rows) s.rowCache.set(row.row_id, row);
      s.nextOffset = null; s.rowsRevision = revision;
      if (s.editor) s.editor.latest = s.rowCache.get(s.editor.id)?.normalized;
      return true;
    } catch (error) { if (live(s) && token === rowEpoch) s.error = message(error); return false; }
    finally { if (live(s) && token === rowEpoch) { s.rowsLoading = false; paint(s); } }
  }
  // A new file starts with the default filters and every row ticked.
  function resetReview(s) {
    s.importFilter = defaultImportFilter(); s.unchecked.clear(); s.shown = IMPORT_SHOWN_STEP; s.noticeVars = null;
  }
  function arm(delay) {
    unschedule(timer); timer = null;
    if (active() && (current().job || current().resumeId)) timer = schedule(() => { timer = null; void poll(); }, delay);
  }
  async function poll(force = false) {
    const s = ensureScope(), id = s.job?.import_id || s.resumeId;
    if (!id || (!force && (!active() || s.busy))) { arm(2000); return false; }
    if (statusFlight) return statusFlight;
    const flight = (async () => {
      try {
        const job = (await read(s, options => api.getImport(id, options))).result;
        if (!live(s) || (s.job?.import_id || s.resumeId) !== id) return false;
        const previousRevision = s.job?.revision, previousState = s.job?.state;
        if (!applyJob(s, job)) return false;
        s.pollingError = ''; paint(s);
        if (!processingImport(job.state) && job.state !== 'mapping_required' && (force || previousRevision !== job.revision || previousState !== job.state || s.rowsRevision === null)) await loadRows();
        return true;
      } catch (error) { if (live(s) && (s.job?.import_id || s.resumeId) === id) { s.pollingError = message(error); paint(s); } return false; }
      finally { if (live(s)) arm(s.pollingError ? 10000 : processingImport(s.job?.state) ? 2000 : 8000); }
    })();
    statusFlight = flight;
    try { return await flight; } finally { if (statusFlight === flight) statusFlight = null; }
  }
  async function setup(force = false) {
    const s = ensureScope();
    if (s.setupLoaded && !force) return true;
    if (setupFlight) return setupFlight;
    s.setupLoading = true; s.setupError = ''; paint(s);
    const flight = (async () => {
      const results = await Promise.allSettled([read(s, options => api.listImportPresets(options)), read(s, () => api.listAccounts())]);
      if (!live(s)) return false;
      const [presets, accounts] = results;
      if (presets.status === 'fulfilled' && Array.isArray(presets.value.result)) s.presets = presets.value.result;
      else s.setupError = presets.status === 'rejected' ? 'GET /imports/presets: ' + message(presets.reason) : 'invalidResponse';
      if (accounts.status === 'fulfilled' && Array.isArray(accounts.value.result?.items)) {
        s.accounts = accounts.value.result.items;
        if (!s.accounts.some(account => String(account.account_number) === String(s.form.account_number))) s.form.account_number = '';
      }
      else s.setupError = accounts.status === 'rejected' ? 'GET /DB/accounts: ' + message(accounts.reason) : 'invalidResponse';
      s.setupLoaded = !s.setupError; s.setupLoading = false; paint(s); return s.setupLoaded;
    })();
    setupFlight = flight;
    try { return await flight; } finally { if (setupFlight === flight) setupFlight = null; }
  }
  async function upload() {
    const s = ensureScope();
    if (s.busy || s.pendingCommit || s.editor || !s.setupLoaded || s.job) return false;
    const invalid = validateImportFile(s.file);
    if (invalid) { s.error = invalid; paint(s); return false; }
    const account = s.accounts.find(account => String(account.account_number) === String(s.form.account_number));
    if (!account) { s.error = 'accountRequired'; paint(s); return false; }
    if (account.balance == null || account.balance_status === 'needs_opening_balance') { s.error = 'accountNeedsOpening'; paint(s); return false; }
    const body = new FormData(); body.append('file', s.file);
    body.append('account_number', s.form.account_number); body.append('use_agent', String(s.form.use_agent));
    for (const field of ['preset_id', 'timezone', 'default_currency', 'sheet_name']) if (s.form[field]) body.append(field, s.form[field]);
    s.busy = 'uploading'; s.error = ''; s.notice = ''; paint(s);
    try {
      const job = validateJob((await api.createImportPreview(body)).result);
      if (!live(s)) return false;
      try { preferences?.setItem(accountKey(s.scope), String(s.form.account_number)); } catch { /* Optional. */ }
      s.job = null; s.resumeId = ''; s.rows = []; s.rowCache.clear(); s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.expanded.clear();
      s.rowsRevision = null; s.filter = ''; s.query = ''; s.confirming = false; s.conflict = false; s.mappingFor = '';
      resetReview(s); applyJob(s, job, true); return true;
    } catch (error) { if (live(s)) s.error = message(error); return false; }
    finally { if (live(s)) { s.busy = ''; paint(s); arm(200); } }
  }
  async function selectPreset(id) {
    const s = ensureScope(); s.form.preset_id = id;
    if (!id) { paint(s); return null; }
    try {
      const preset = (await api.getImportPreset(id)).result;
      if (!live(s) || s.form.preset_id !== id) return null;
      s.form.timezone = preset.default_timezone || 'Asia/Shanghai'; s.form.default_currency = preset.default_currency || 'CNY';
      if (!s.presetDirty && s.job?.state !== 'mapping_required') s.presetText = JSON.stringify(preset, null, 2);
      paint(s); return preset;
    } catch (error) { if (live(s)) { s.error = message(error); paint(s); } return null; }
  }
  async function savePreset(mapping = false) {
    const s = ensureScope();
    if (s.busy || s.pendingCommit || s.editor) return false;
    let preset;
    try {
      preset = parseImportPreset(s.presetText);
      if ((!mapping || s.savePreset) && s.presets.some(item => item.preset_id === preset.preset_id)) throw new Error('presetExists');
    } catch (error) { s.error = message(error); paint(s); return false; }
    s.busy = mapping ? 'mapping' : 'preset'; s.error = ''; paint(s);
    try {
      if (mapping) {
        const data = (await api.mapImport(s.job.import_id, { preset, save_preset: s.savePreset })).result;
        if (!live(s)) return false;
        applyJob(s, data, true); s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.rowCache.clear(); s.rowsRevision = null; s.presetDirty = false;
        await loadRows();
      } else {
        await api.saveImportPreset(preset);
        if (!live(s)) return false;
        s.form.preset_id = preset.preset_id; s.presetDirty = false; s.notice = 'presetSaved';
      }
      if (!mapping || s.savePreset) await setup(true);
      return true;
    } catch (error) {
      if (live(s)) { s.error = message(error); if (mapping) await poll(true); }
      return false;
    } finally { if (live(s)) { s.busy = ''; paint(s); arm(2000); } }
  }
  async function saveEditor() {
    const s = ensureScope(), editor = s.editor;
    if (!editor || !editableImport(s.job) || s.busy || s.pendingCommit || s.rowsLoading || s.rowsRevision !== s.job?.revision) return false;
    let values;
    try {
      if (!canEditImportRow(s.rowCache.get(editor.id) || {})) throw new Error('rowLocked');
      values = correctionValues(editor.draft, s.rowCache.get(editor.id));
    } catch (error) { editor.error = message(error); paint(s); return false; }
    s.busy = 'saving'; editor.error = ''; s.error = ''; paint(s);
    try {
      const data = (await api.editImportRows(s.job.import_id, { revision: s.job.revision, rows: [{ row_id: editor.id, values }] })).result;
      if (!live(s)) return false;
      applyJob(s, data, true); s.editor = null; s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.confirming = false; s.conflict = false; s.notice = 'saved';
      await loadRows(); return true;
    } catch (error) {
      if (live(s)) {
        editor.error = message(error);
        if (error.status === 409) {
          editor.conflict = true; s.conflict = true; s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.confirming = false;
        }
        if (statusFlight) await statusFlight;
        await poll(true);
      }
      return false;
    } finally { if (live(s)) { s.busy = ''; paint(s); arm(8000); } }
  }
  async function sendPending(s) {
    const pending = s.pendingCommit;
    // Persist before POST. A timeout never gets a new key or a rebuilt request body.
    persist(s); paint(s);
    try {
      const data = (await api.commitImport(pending.id, pending.body, pending.key)).result;
      if (!live(s)) return false;
      const job = validateJob(data, pending.id);
      if (processingImport(job.state)) throw new Error('commitUncertain');
      applyJob(s, job, true);
      for (const row of pending.body.rows) { s.choices.delete(row.row_id); s.distinct.delete(row.row_id); s.externalIncome.delete(row.row_id); }
      s.pendingCommit = null; s.completedBatches++; persist(s);
      const loaded = await loadRows();
      try { await afterCommit(); } catch { s.notice = 'refreshFailed'; }
      return loaded;
    } catch (error) {
      if (!live(s)) return false;
      s.error = message(error);
      if (statusFlight) await statusFlight;
      await poll(true);
      if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) && s.job && !processingImport(s.job.state) && !s.pollingError) {
        s.pendingCommit = null; s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.conflict = true; persist(s);
      }
      try { await afterCommit(); } catch { /* The import result remains authoritative. */ }
      return false;
    }
  }
  async function commit(retry = false) {
    const s = ensureScope();
    if (s.busy || (!retry && s.pendingCommit)) return false;
    let choices;
    try { choices = retry ? null : planImportBatches(s); }
    catch (error) { s.error = message(error); paint(s); return false; }
    if (retry && !s.pendingCommit) return false;
    s.busy = 'committing'; s.error = ''; s.notice = ''; s.confirming = false; s.conflict = false; paint(s);
    try {
      if (retry) return await sendPending(s);
      for (let index = 0; index < choices.length; index++) {
        if (!live(s)) return false;
        s.pendingCommit = { id: s.job.import_id, key: uuid(), body: { revision: s.job.revision, rows: choices[index] } };
        if (!await sendPending(s)) return false;
        if (s.conflict || !editableImport(s.job) && index + 1 < choices.length) return false;
      }
      return true;
    } catch (error) { if (live(s)) s.error = message(error); return false; }
    finally { if (live(s)) { s.busy = ''; paint(s); arm(8000); } }
  }
  function newFile(file) {
    const s = ensureScope();
    if (s.busy || s.pendingCommit || s.editor) return false;
    const error = validateImportFile(file);
    if (error) { s.error = error; paint(s); return false; }
    unschedule(timer); timer = null; rowEpoch++;
    for (const read of reads) read.abort();
    s.job = null; s.resumeId = ''; s.file = file; s.rows = []; s.rowCache.clear(); s.rowsRevision = null;
    s.choices.clear(); s.distinct.clear(); s.externalIncome.clear(); s.confirming = false; s.error = ''; s.notice = ''; s.conflict = false;
    s.rowsLoading = false; s.nextOffset = null; s.total = 0; s.pollingError = ''; s.expanded.clear();
    s.mappingFor = ''; s.filter = ''; s.query = ''; s.completedBatches = 0; resetReview(s);
    persist(s); paint(s); return true;
  }
  // Read the same file again into another account (the preview said its rows were imported there before).
  async function switchAccount(number) {
    const s = ensureScope();
    if (s.busy || s.pendingCommit || s.editor || !s.accounts.some(account => String(account.account_number) === String(number))) return false;
    const file = s.file;
    s.form.account_number = String(number);
    if (!file) {
      s.job = null; s.resumeId = ''; s.rows = []; s.rowCache.clear(); s.choices.clear(); s.filter = ''; s.notice = 'chooseFileAgain';
      persist(s); paint(s); return false;
    }
    newFile(file);
    s.form.account_number = String(number);
    return upload();
  }
  function syncActive() {
    const s = ensureScope();
    if (!active()) { unschedule(timer); timer = null; return; }
    void setup();
    if (!timer && !statusFlight && (s.job || s.resumeId)) arm(200);
  }
  function dispose() { unschedule(timer); for (const read of reads) read.abort(); reads.clear(); }
  return { ensureScope, setup, poll, loadRows, upload, selectPreset, savePreset, saveEditor, commit, newFile, syncActive, dispose, switchAccount };
}
