export const RUN_ACTIVE = new Set(['queued', 'running', 'waiting_reply']);
export const RUN_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const SCHEDULE_KINDS = ['manual', 'once', 'interval', 'daily', 'weekly'];
export const TASK_FIELDS = ['prompt', 'schedule'];
export const createInsightFeed = () => ({ offset: 0, hasMore: false, loadingMore: false, error: '', retryAppend: false, head: '', scrollTop: 0 });
export function createAgentInformationState() {
  return { tasks: [], tasksLoaded: false, workerEnabled: null, unreadCount: 0,
    insights: [], total: 0, insightsLoaded: false, filter: { kind: '', unread_only: false }, insightFeed: createInsightFeed(),
    taskId: '', task: null, taskRemoved: false, deleteRetry: null, insightId: '', insight: null, runs: [], runsTotal: 0, runsOffset: 0,
    runId: '', run: null, runOpen: false, runError: '', editor: null, pending: {}, busy: '', loading: {}, error: '', notice: '', source: '',
    replies: { drafts: {}, pending: {}, items: {}, busy: {}, checking: {}, errors: {}, loadErrors: {}, unavailable: {}, notices: {} } };
}
export function taskDraft(task) {
  const config = task?.config || {};
  return { prompt: config.prompt || '', enabled: task ? config.enabled === true : true,
    kind: config.schedule?.kind || 'interval', timezone: config.schedule?.timezone || 'Asia/Tokyo',
    at: config.schedule?.at || '21:00', weekday: config.schedule?.weekday ?? 6,
    interval_seconds: config.schedule?.interval_seconds ?? 86400, run_at: config.schedule?.run_at || '' };
}
export function taskPayload(draft, now = Date.now()) {
  const result = { prompt: String(draft.prompt || '').trim() };
  if (!result.prompt || result.prompt.length > 8000) throw new Error('requiredPrompt');
  const kind = draft.kind, timezone = String(draft.timezone || '').trim();
  if (!SCHEDULE_KINDS.includes(kind)) throw new Error('invalidSchedule');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('invalidTimezone'); }
  const schedule = { kind, timezone };
  if (kind === 'daily' || kind === 'weekly') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.at)) throw new Error('invalidTime');
    schedule.at = draft.at;
  }
  if (kind === 'weekly') {
    const value = Number(draft.weekday);
    if (!Number.isInteger(value) || value < 0 || value > 6) throw new Error('invalidSchedule');
    schedule.weekday = value;
  }
  if (kind === 'interval') {
    const value = Number(draft.interval_seconds);
    if (!Number.isInteger(value) || value < 60 || value > 31536000) throw new Error('invalidInterval');
    schedule.interval_seconds = value;
  }
  if (kind === 'once') {
    const value = String(draft.run_at || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('timezoneRequired');
    if (draft.enabled && Date.parse(value) <= now) throw new Error('futureRequired');
    schedule.run_at = value;
  }
  result.schedule = schedule;
  return result;
}
export function changedTaskFields(before, after) {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => {
    if (!TASK_FIELDS.includes(key)) return false;
    if (key === 'schedule') return Object.entries(value).some(([k, v]) => before?.schedule?.[k] !== v) ||
      Object.entries(before?.schedule || {}).some(([k, v]) => v != null && !(k in value));
    return before?.[key] !== value;
  }));
}
export function informationResult(response) {
  if (response?.success !== true || response.result == null) throw new Error('invalidResponse');
  return response.result;
}
export function informationList(response) {
  const result = informationResult(response);
  if (!Array.isArray(result.items)) throw new Error('invalidResponse');
  return result;
}
export function safePending(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([id, item]) => id && item &&
    typeof item.key === 'string' && /^[\da-f-]{36}$/i.test(item.key) && (item.runId == null || typeof item.runId === 'string'))
    .map(([id, item]) => [id, { key: item.key, runId: item.runId || null }]));
}
