export const MAIL_SOURCES = Object.freeze(['bank_mail', 'ocr_mail']);
export const MAIL_ACTIVE = ['queued', 'waiting', 'running'];
export const MAIL_TERMINAL = ['completed', 'completed_with_pending', 'failed', 'interrupted', 'cancelled'];
export const MAIL_COUNTERS = ['total', 'checked', 'completed', 'skipped_done', 'pending', 'failed'];

export function createFullMailImportState(source) {
  return { source, task: null, available: null, checked: false, busy: '', confirming: false,
    uncertain: false, beforeTaskId: null, notice: '', error: null, startError: null, failures: 0 };
}

export const mailImportActive = task => MAIL_ACTIVE.includes(task?.status);
export const mailImportCanStart = state => state.available === true && state.checked && !state.busy &&
  state.task?.scope === 'inbox' && !mailImportActive(state.task);

export function readFullMailImport(response) {
  const value = response?.result;
  if (response?.success !== true || !value || !['idle', ...MAIL_ACTIVE, ...MAIL_TERMINAL].includes(value.status)) throw new Error('invalidResponse');
  if (value.status !== 'idle' && (typeof value.task_id !== 'string' || !value.task_id.trim())) throw new Error('invalidResponse');
  if (value.status === 'idle' && (value.task_id != null || value.sources?.length)) throw new Error('invalidResponse');
  if (!value.results || typeof value.results !== 'object' || Array.isArray(value.results)) throw new Error('invalidResponse');
  if (!Array.isArray(value.sources) || new Set(value.sources).size !== value.sources.length ||
    value.sources.some(source => !MAIL_SOURCES.includes(source)) || value.status !== 'idle' && !value.sources.length) throw new Error('invalidResponse');
  if (value.stage != null && !value.sources.includes(value.stage)) throw new Error('invalidResponse');
  const results = {};
  for (const source of value.sources) {
    const row = value.results?.[source];
    if (row == null) continue;
    if (typeof row !== 'object' || Array.isArray(row)) throw new Error('invalidResponse');
    results[source] = {};
    for (const key of MAIL_COUNTERS) {
      const count = row[key];
      if (count != null && (!Number.isSafeInteger(count) || count < 0)) throw new Error('invalidResponse');
      results[source][key] = count ?? null;
    }
    if (row.skipped_bank != null && (!Number.isSafeInteger(row.skipped_bank) || row.skipped_bank < 0)) throw new Error('invalidResponse');
    results[source].skipped_bank = row.skipped_bank ?? null;
  }
  const date = key => {
    if (value[key] == null) return null;
    if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) throw new Error('invalidResponse');
    return value[key];
  };
  return { task_id: value.task_id || null, status: value.status, scope: value.scope === 'inbox' ? 'inbox' : null,
    sources: [...value.sources], stage: value.stage || null,
    created_at: date('created_at'), finished_at: date('finished_at'), results, cancelling: value.cancelling === true,
    error: value.error == null ? '' : String(value.error).slice(0, 1500) };
}

export function fullMailImportError(error) {
  const key = error?.message === 'invalidResponse' ? 'invalidResponse'
    : ({ 403: 'localOnly', 404: 'unavailable', 405: 'unavailable', 409: 'conflict', 422: 'invalidSource', 501: 'unavailable', 503: 'startUnavailable' })[error?.status]
      || (error?.name === 'TimeoutError' ? 'timeout' : 'requestFailed');
  return { key, detail: error?.status && !['unavailable', 'localOnly'].includes(key) ? String(error.message || '').slice(0, 1500) : '' };
}
