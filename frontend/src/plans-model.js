export const PLAN_PREVIEW_KEY = 'abk-plans-preview-v1'; // Preserved, never imported or uploaded.
export const PLAN_STATUSES = ['active', 'paused', 'completed', 'archived'];
export const PLAN_CURRENCIES = ['JPY', 'RMB'];
export const apiCurrency = value => value === 'CNY' ? 'RMB' : value;
export const displayCurrency = value => value === 'RMB' ? 'CNY' : value;
export function japanDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalidDate');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-');
}
export function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && value >= '1900-01-01' && value <= '2100-12-31' &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
// Decimal strings stay exact in validation and requests; only chart coordinates use Number.
export function planDecimal(value, currency, positive = false) {
  const raw = String(value ?? '').trim(), decimals = apiCurrency(currency) === 'JPY' ? 0 : 2;
  if (raw.length > 40 || !PLAN_CURRENCIES.includes(apiCurrency(currency)) || !/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('invalidMoney');
  const [integer, fraction = ''] = raw.split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error('invalidMoney');
  const units = BigInt(integer) * 100n + BigInt((fraction.slice(0, 2) + '00').slice(0, 2));
  if (units > 100000000000000n || (positive && units === 0n)) throw new Error('invalidMoney');
  return BigInt(integer).toString() + (decimals ? '.' + (fraction + '00').slice(0, 2) : '');
}
export function createPlansState() {
  return { source: '', items: [], total: 0, selected: '', detail: null, chart: null, entries: [], entryTotal: 0,
    accounts: [], accountsLoaded: false, loaded: false, loading: {}, errors: {}, notice: '', dialog: null, pending: null, busy: false, syncAssets: {},
    allocations: null, allocationDraft: null };
}
export function planDraft(currency = 'JPY', plan = null) {
  return plan ? { ...plan, prompt: '', noTarget: plan.target_amount === null } : {
    title: '', type: 'saving', description: '', currency: apiCurrency(currency || 'JPY'), funding_account: '',
    target_amount: '', opening_amount: '0', contribution_amount: '', frequency: 'monthly', start_date: japanDay(), end_date: '',
    spending_reduces_progress: true, prompt: '', noTarget: false,
  };
}
export function preparePayload(draft, original = null) {
  if (draft.type === 'spending_reduction') throw new Error('reductionUnavailable');
  if (draft.type !== 'saving' && !(original?.type === 'investment' && draft.type === 'investment')) throw new Error('invalidPlan');
  const fields = {}, prompt = String(draft.prompt || '').trim();
  if (prompt.length > 8000) throw new Error('invalidPrompt');
  for (const key of ['title', 'description']) {
    const value = String(draft[key] || '').trim();
    if (value.length > (key === 'title' ? 120 : 2000)) throw new Error('invalidName');
    if (value || (original && key === 'description')) fields[key] = value;
  }
  if (!['saving', 'investment'].includes(draft.type) || !PLAN_CURRENCIES.includes(apiCurrency(draft.currency))) throw new Error('invalidPlan');
  Object.assign(fields, { type: draft.type, currency: apiCurrency(draft.currency), frequency: 'monthly', spending_reduces_progress: draft.spending_reduces_progress !== false });
  for (const key of ['target_amount', 'opening_amount', 'contribution_amount']) {
    if (key === 'target_amount' && draft.noTarget) fields[key] = null;
    else if (draft[key] !== '' && draft[key] != null) fields[key] = planDecimal(draft[key], fields.currency, key === 'target_amount');
  }
  for (const key of ['start_date', 'end_date']) {
    if (draft[key]) { if (!validDay(draft[key])) throw new Error('invalidDate'); fields[key] = draft[key]; }
    else if (key === 'end_date') fields[key] = null;
  }
  if (fields.end_date && fields.start_date && fields.end_date < fields.start_date) throw new Error('invalidDate');
  if (!fields.title && !prompt) throw new Error('missingDescription');
  if (original) for (const [key, value] of Object.entries(fields)) {
    let before = original[key] ?? null;
    if (key.endsWith('_amount') && before !== null) before = planDecimal(before, original.currency);
    if (key === 'currency') before = apiCurrency(before);
    if (JSON.stringify(before) === JSON.stringify(value)) delete fields[key];
  }
  if (!prompt && !Object.keys(fields).length) throw new Error('noChanges');
  return { prompt, fields, ...(original ? { plan_id: original.id } : {}) };
}
export function planFunding(draft, accounts, primaryCurrency = 'JPY') {
  if (!draft.funding_account) {
    const currency = apiCurrency(primaryCurrency || 'JPY');
    if (!PLAN_CURRENCIES.includes(currency)) throw new Error('planCurrencyUnsupported');
    return { currency, accountNumbers: [] };
  }
  const number = Number(draft.funding_account);
  const account = accounts.find(row => row.account_number === number);
  if (!Number.isSafeInteger(number) || !account || account.account_type === 'credit' || account.balance == null) throw new Error('invalidAccount');
  const currency = apiCurrency(account.currency);
  if (!PLAN_CURRENCIES.includes(currency)) throw new Error('planCurrencyUnsupported');
  return { currency, accountNumbers: [number] };
}
export function progressOperation(plan, draft, accounts, now = new Date()) {
  if (plan.status !== 'active') throw new Error('inactivePlan');
  const type = draft.type;
  if (!['contribution', 'withdrawal'].includes(type)) throw new Error('invalidEntry');
  const date = japanDay(now);
  if (!validDay(date) || date < plan.start_date || date > japanDay()) throw new Error('invalidDate');
  const amount = planDecimal(draft.amount, plan.currency, true);
  const number = draft.account_number ? Number(draft.account_number) : null;
  if (number !== null && (!Number.isSafeInteger(number) || !plan.account_numbers.includes(number))) throw new Error('invalidAccount');
  const note = String(draft.note || '').trim();
  if (note.length > 1000) throw new Error('invalidNote');
  const body = { expected_version: plan.version, type, amount, date, note, ...(number !== null ? { account_number: number } : {}) };
  if (draft.type !== 'contribution' || draft.sync_assets !== true) return { action: 'entry', id: plan.id, body };
  const account = accounts.find(row => row.account_number === body.account_number);
  if (!account || account.balance == null || account.account_type === 'credit' || apiCurrency(account.currency) !== apiCurrency(plan.currency)) throw new Error('syncAccountRequired');
  return { action: 'syncProgress', id: plan.id, stage: 'income', body,
    incomeBody: { account_number: body.account_number, amount: body.amount, currency: displayCurrency(plan.currency),
      effective_at: now.toISOString(), source_name: plan.title + ' [' + plan.id + ']', note: body.note } };
}
export function historicalRange(plan) {
  const end = japanDay(), earliest = new Date(end + 'T00:00:00Z');
  earliest.setUTCDate(earliest.getUTCDate() - 365);
  return { start_date: [plan.start_date < end ? plan.start_date : end, earliest.toISOString().slice(0, 10)].sort().at(-1), end_date: end };
}
export function planChart(plan, history, forecast = plan.forecast) {
  const today = history?.summary?.as_of || plan.progress?.as_of || japanDay();
  const points = (rows, dateKey, amountKey) => [...new Map((rows || []).flatMap(row => {
    const date = String(row[dateKey] || '').slice(0, 10), amount = row[amountKey];
    if (!validDay(date)) return [];
    return [[date, { date, time: Date.parse(date + 'T00:00:00Z'), amount,
      value: amount == null || amount === '' || !Number.isFinite(Number(amount)) ? null : Number(amount) }]];
  })).values()].sort((a, b) => a.time - b.time);
  const actual = points(history?.series, 'as_of', 'current_amount').filter(row => row.date <= today);
  const summary = history?.summary || plan.progress;
  // Keep today's measured point separate from this month's future projection.
  if (summary?.as_of === today && !actual.some(row => row.date === today)) actual.push(...points([summary], 'as_of', 'current_amount'));
  return { today, actual, forecast: points(forecast?.series, 'date', 'amount').filter(row => row.date >= today) };
}
export const visiblePlan = plan => !['completed', 'archived'].includes(plan?.status);
export function planResult(response) {
  if (response?.success !== true || response.result == null) throw new Error('invalidResponse');
  return response.result;
}
export function resultList(response) {
  const result = planResult(response);
  if (!Array.isArray(result.items)) throw new Error('invalidResponse');
  return result;
}
