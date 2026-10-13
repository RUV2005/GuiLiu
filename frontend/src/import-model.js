export const IMPORT_LIMITS = { bytes: 10 * 1024 * 1024 };
export const IMPORT_BATCH_SIZE = 100;
export const IMPORT_EDIT_FIELDS = ['shop_name', 'main_category', 'sub_category', 'detail_category'];
export const IMPORT_FIELDS = ['shop_name', 'product_name', 'price', 'isotime', 'main_category', 'sub_category', 'detail_category'];
export const IMPORT_STATUSES = ['new', 'suspected_duplicate', 'duplicate', 'excluded', 'needs_review', 'invalid', 'imported', 'skipped', 'failed'];
export function importOperationKey(crypto = globalThis.crypto) {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export const processingImport = state => ['queued', 'parsing', 'analyzing', 'importing'].includes(state);
export const editableImport = job => ['ready', 'partial_failed'].includes(job?.state);
export const rowStatus = row => row.commit_status || row.status;
export const rowDone = row => ['imported', 'skipped'].includes(rowStatus(row));
export const isIncomeRow = row => row?.normalized?.transaction_kind === 'income';
export const needsIncomeConfirmation = row => isIncomeRow(row) && Boolean(row.income_confirmation_required || row.issues?.includes('confirm_external_income_required'));
const unclassified = value => !String(value ?? '').trim() || ['未分类', '未分類', 'unclassified'].includes(String(value).trim().toLowerCase());

export function createImportState() {
  return { scope: '', job: null, file: null, form: { account_number: '', preset_id: '', use_agent: true,
    timezone: 'Asia/Shanghai', default_currency: 'CNY', sheet_name: '' },
    presets: [], accounts: [], setupLoaded: false, setupLoading: false, setupError: '',
    rows: [], rowCache: new Map(), rowsRevision: null, nextOffset: null, total: 0, filter: '', query: '',
    choices: new Map(), distinct: new Set(), externalIncome: new Set(), editor: null, expanded: new Set(),
    busy: '', rowsLoading: false, error: '', notice: '', conflict: false, confirming: false,
    pendingCommit: null, completedBatches: 0, pollingError: '',
    presetOpen: false, presetText: '', presetDirty: false, savePreset: false, mappingFor: '',
    advancedOpen: false, payment: null, importFilter: defaultImportFilter(), unchecked: new Set(), shown: IMPORT_SHOWN_STEP, noticeVars: null,
  };
}
export function validateImportFile(file) {
  if (/\.xls$/i.test(file?.name || '')) return 'legacyFile';
  if (!file || !/\.(xlsx|csv)$/i.test(file.name)) return 'fileType';
  if (file.size === 0) return 'emptyFile';
  if (file.size > IMPORT_LIMITS.bytes) return 'fileSize';
  return '';
}
export function missingClassification(row) {
  if (isIncomeRow(row)) return false;
  const n = row.normalized || {};
  return (row.issues || []).includes('classification_required') || unclassified(n.main_category) || unclassified(n.sub_category);
}
export function canEditImportRow(row) {
  return !rowDone(row) && ['new', 'suspected_duplicate'].includes(row.status);
}
export function canImportRow(row, distinct = false, externalIncome = false) {
  if (!row || rowDone(row) || row.commit_status === 'needs_review' || missingClassification(row) || !String(row.normalized?.shop_name || '').trim()) return false;
  if (!['expense', 'income'].includes(row.normalized?.transaction_kind ?? 'expense') || (needsIncomeConfirmation(row) && !externalIncome)) return false;
  return row.status === 'new' || (row.status === 'suspected_duplicate' && distinct);
}
export function correctionValues(draft, row) {
  const values = Object.fromEntries(IMPORT_EDIT_FIELDS.map(field => [field, String(draft[field] ?? '').trim()]));
  if (IMPORT_EDIT_FIELDS.some(field => values[field].length > 300) || !values.shop_name) throw new Error(isIncomeRow(row) ? 'incomeEditRequired' : 'editRequired');
  if (!isIncomeRow(row) && (unclassified(values.main_category) || unclassified(values.sub_category))) throw new Error('editRequired');
  return values;
}
export function currencyLabel(code) {
  if ([100, 0, 1, '100', '0', '1', 'CNY', 'RMB'].includes(code)) return 'CNY';
  if ([101, '101', 'JPY'].includes(code)) return 'JPY';
  return String(code ?? '');
}
export function selectImportRow(state, row, action) {
  if (!row || rowDone(row) || state.editor || state.busy || state.pendingCommit || !editableImport(state.job)) return false;
  const id = String(row.row_id);
  if (!action) { state.choices.delete(id); state.confirming = false; return true; }
  if (!['import', 'skip'].includes(action)) return false;
  if (action === 'import' && !canImportRow(row, state.distinct.has(id), state.externalIncome.has(id))) return false;
  state.choices.set(id, { row_id: id, action, ...(action === 'import' && row.status === 'suspected_duplicate' ? { confirm_distinct: true } : {}),
    ...(action === 'import' && needsIncomeConfirmation(row) ? { confirm_external_income: true } : {}) });
  state.confirming = false;
  return true;
}
export function buildImportChoices(state) {
  if (!editableImport(state.job) || !Number.isInteger(state.job.revision) || state.job.revision < 1 || state.rowsRevision !== state.job.revision || state.editor || state.rowsLoading) throw new Error('notReady');
  const choices = [...state.choices.values()];
  if (!choices.length) throw new Error('notSelected');
  for (const choice of choices) {
    const row = state.rowCache.get(choice.row_id);
    if (!row || rowDone(row) || (choice.action === 'import' && !canImportRow(row, choice.confirm_distinct && state.distinct.has(choice.row_id), choice.confirm_external_income && state.externalIncome.has(choice.row_id)))) throw new Error('reconfirm');
  }
  return choices.map(choice => ({ ...choice }));
}
export function planImportBatches(state) {
  const choices = buildImportChoices(state), terminal = [], others = [];
  for (const choice of choices) {
    const row = state.rowCache.get(choice.row_id);
    (['new', 'suspected_duplicate'].includes(row.status) ? terminal : others).push(choice);
  }
  // The current backend closes the task once all candidate expenses are done,
  // even when excluded rows remain. Keep a candidate until the final batch.
  if (!terminal.length && !(state.job.counts?.new || state.job.counts?.suspected_duplicate)) return [others];
  const ordered = [...others, ...terminal], batches = [];
  for (let offset = 0; offset < ordered.length; offset += IMPORT_BATCH_SIZE) batches.push(ordered.slice(offset, offset + IMPORT_BATCH_SIZE));
  return batches;
}
export function presetTemplate(extension = '.csv') {
  return { preset_id: 'custom_import_v1', name: 'Custom import', provider: 'custom', version: 1, extensions: [extension],
    encodings: ['utf-8-sig', 'gb18030'], default_currency: 'CNY', default_timezone: 'Asia/Shanghai',
    columns: { time: '', shop_name: '', amount: '', direction: '' }, expense_values: ['支出'], success_statuses: [], review_statuses: [],
    excluded_type_patterns: [], refund_patterns: ['退款|退还|refund'], time_formats: ['%Y-%m-%d %H:%M:%S'], replace_rules: [], extract_patterns: {} };
}
export function parseImportPreset(value) {
  if (String(value).length > 131072) throw new Error('presetTooLarge');
  let preset;
  try { preset = JSON.parse(value); } catch { throw new Error('presetInvalid'); }
  if (!preset || typeof preset !== 'object' || Array.isArray(preset) || !/^[a-z][a-z0-9_]{0,63}$/.test(preset.preset_id || '') || !preset.columns || typeof preset.columns !== 'object' || Array.isArray(preset.columns)) throw new Error('presetInvalid');
  return preset;
}
// The review page groups rows the way people think about them; the Backend counts by the same groups.
export const IMPORT_GROUPS = ['ready', 'attention', 'existing', 'excluded', 'done'];
export const IMPORT_SHOWN_STEP = 200;
export function rowGroup(row) {
  const state = rowStatus(row);
  if (['imported', 'skipped'].includes(state)) return 'done';
  if (state === 'duplicate') return 'existing';
  if (state === 'excluded') return 'excluded';
  return state === 'new' && !missingClassification(row) && !needsIncomeConfirmation(row) ? 'ready' : 'attention';
}
// The filter bar: which groups to show, expense/income, payment methods and file types (null = all), dates, text.
export function defaultImportFilter() {
  return { groups: new Set(['ready', 'attention']), kinds: new Set(['expense', 'income']), payments: null, types: null, from: '', to: '', query: '' };
}
export const IMPORT_FACETS = {
  groups: rowGroup,
  kinds: row => isIncomeRow(row) ? 'income' : 'expense',
  payments: row => String(row.normalized?.payment_method || ''),
  types: row => String(row.normalized?.transaction_type || ''),
};
export function matchesFilter(row, filter, except = '') {
  for (const [facet, keyOf] of Object.entries(IMPORT_FACETS)) {
    if (facet !== except && filter[facet] && !filter[facet].has(keyOf(row))) return false;
  }
  const day = String(row.normalized?.isotime || '').slice(0, 10);
  if (day && ((filter.from && day < filter.from) || (filter.to && day > filter.to))) return false;
  const q = filter.query.trim().toLowerCase();
  return !q || [row.row_id, ...Object.values(row.normalized || {})].some(value => String(value ?? '').toLowerCase().includes(q));
}
// For each choice of one facet, how many rows the other filters leave: what ticking that choice would show.
export function facetCounts(rows, filter, facet) {
  const counts = new Map();
  for (const row of rows) if (matchesFilter(row, filter, facet)) counts.set(IMPORT_FACETS[facet](row), (counts.get(IMPORT_FACETS[facet](row)) || 0) + 1);
  return counts;
}
export const filteredRows = state => state.rows.filter(row => matchesFilter(row, state.importFilter));
export const importableRow = (state, row) => canImportRow(row, state.distinct.has(row.row_id), state.externalIncome.has(row.row_id));
// What will be imported: every row the filters show that can be imported, except the ones unticked by hand.
export const selectedRows = state => filteredRows(state).filter(row => importableRow(state, row) && !state.unchecked.has(row.row_id));
export function groupCounts(job) {
  if (job?.groups) return Object.fromEntries(IMPORT_GROUPS.map(group => [group, Number(job.groups[group] || 0)]));
  // A task saved before groups existed: estimate them from the row states.
  const c = job?.counts || {}, n = key => Number(c[key] || 0);
  return { ready: n('new'), attention: n('needs_review') + n('suspected_duplicate') + n('invalid') + n('failed'),
    existing: n('duplicate'), excluded: n('excluded'), done: n('imported') + n('skipped') };
}
const ISSUE_NOTES = { refund_requires_review: 'noteRefund', payment_requires_review: 'notePayment', account_currency_mismatch: 'account_currency_mismatch',
  conflicting_rows_with_same_identity: 'conflicting_rows_with_same_identity', row_processing_failed: 'row_processing_failed',
  classification_uncertain: 'noteCheckCategory' };
// Why a row is where it is, in plain words (keys of the import copy; vars fill them in).
export function rowReasons(row, account) {
  const state = rowStatus(row), issues = row.issues || [], candidates = row.duplicate_candidates || [], out = [];
  const has = reason => candidates.some(candidate => (candidate.reasons || []).includes(reason));
  if (state === 'imported') return [{ key: 'noteImported' }];
  if (state === 'skipped') return [{ key: 'noteSkipped' }];
  if (row.commit_error || state === 'failed') out.push({ key: 'noteFailed' });
  if (state === 'duplicate') {
    const elsewhere = candidates.find(candidate => (candidate.reasons || []).includes('imported_to_other_account'));
    if (elsewhere) return [{ key: 'noteInOtherAccount', vars: { account: elsewhere.AccountNumber } }];
    return [{ key: has('same_import_identity') ? 'noteImportedBefore' : 'noteDuplicate' }];
  }
  if (state === 'excluded') return [{ key: issues.includes('not_a_successful_payment') ? 'noteNotSuccessful' : 'noteNotSpending',
    vars: { type: row.normalized?.transaction_type || '' } }];
  const conflict = candidates.find(candidate => (candidate.reasons || []).includes('import_identity_conflict'));
  if (conflict) out.push(conflict.AccountNumber != null && String(conflict.AccountNumber) !== String(account)
    ? { key: 'noteOtherAccount', vars: { account: conflict.AccountNumber } } : { key: 'noteChanged' });
  if (has('previous_import_was_deleted') || has('previous_import_was_deleted_or_changed_kind')) out.push({ key: 'noteDeleted' });
  if (state === 'suspected_duplicate') out.push({ key: 'noteMaybeDuplicate' });
  for (const issue of issues) if (ISSUE_NOTES[issue]) out.push({ key: ISSUE_NOTES[issue] });
  if (needsIncomeConfirmation(row) && ['new', 'suspected_duplicate'].includes(row.status)) out.push({ key: 'noteIncomeConfirm' });
  // Only rows that can still be edited are asked for a category.
  if (missingClassification(row) && !rowDone(row) && ['new', 'suspected_duplicate'].includes(row.status)) out.push({ key: 'noteNeedsCategory' });
  if (state === 'invalid') out.push({ key: 'noteInvalid' });
  if (!out.length && state === 'new') out.push({ key: 'noteReady' });
  return out;
}
export function validateJob(job, id) {
  if (!job || !/^[a-f0-9]{32}$/.test(job.import_id || '') || (id && id !== job.import_id) || !Number.isInteger(job.revision) || !Number.isInteger(job.total) || job.total < 0 || !job.state) throw new Error('invalidResponse');
  return job;
}
export function validateRows(data, offset) {
  if (!data || !Array.isArray(data.rows) || !Number.isInteger(data.total) || data.total < 0 || data.offset !== offset ||
      (data.next_offset !== null && (!Number.isInteger(data.next_offset) || data.next_offset <= offset)) || data.rows.some(row => typeof row.row_id !== 'string' || !row.status || !row.normalized)) throw new Error('invalidResponse');
  return data;
}
