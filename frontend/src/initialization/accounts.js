import { ACCOUNT_TYPES, decimalAmount, debtBalance, exceedsLimit } from '../assets-model.js';

const clean = value => String(value ?? '').trim();
export const setupCurrency = value => clean(value).toUpperCase() === 'RMB' ? 'CNY' : clean(value).toUpperCase();
export function accountPayload(kind, fields, account, accounts = [], now = Date.now()) {
  if (!['create', 'update', 'calibrate'].includes(kind) || (kind !== 'create' && !account)) throw new Error('accountInvalid');
  const currency = setupCurrency(kind === 'create' ? fields.currency : account.currency);
  if (!['JPY', 'CNY', 'USD'].includes(currency)) throw new Error('accountInvalid');
  const amount = (value, options) => {
    try { return decimalAmount(value, currency, options); } catch { throw new Error('amountPrecision'); }
  };
  // A credit account takes what is owed (a positive amount) and stores it as a negative balance.
  const debt = (value, limit) => {
    let balance;
    try { balance = debtBalance(value, currency); } catch { throw new Error('debtInvalid'); }
    if (exceedsLimit(String(balance).replace('-', ''), limit)) throw new Error('debtOverLimit');
    return balance;
  };
  if (kind === 'calibrate') {
    const note = clean(fields.note);
    if (note.length > 1000) throw new Error('noteLong');
    const confirmed = account.account_type === 'credit' ? debt(fields.confirmed_balance, account.credit_limit) : amount(fields.confirmed_balance);
    return { confirmed_balance: confirmed, effective_at: new Date(now).toISOString(), note };
  }
  const name = clean(fields.name), institution = clean(fields.institution), account_type = fields.account_type;
  if (!name || name.length > 100 || institution.length > 100 || !ACCOUNT_TYPES.includes(account_type)) throw new Error('accountInvalid');
  const payload = { name, institution, account_type };
  if (account_type === 'credit') {
    payload.credit_limit = amount(fields.credit_limit, { nonnegative: true });
  } else if (kind === 'update' && account.account_type === 'credit') payload.credit_limit = null;
  if (kind === 'create') {
    if (accounts.some(a => a.name.trim() === name && clean(a.institution) === institution && a.account_type === account_type
      && setupCurrency(a.currency) === currency) && !fields.confirm_duplicate) throw new Error('duplicateAccount');
    payload.currency = currency;
    if (clean(fields.opening_balance) !== '') {
      payload.opening_balance = account_type === 'credit' ? debt(fields.opening_balance, payload.credit_limit) : amount(fields.opening_balance);
      payload.effective_at = new Date(now).toISOString();
    }
  }
  return payload;
}

// The review receipt is local only; it never changes the server's completion flag.
export function reviewFingerprint(state) {
  const byId = (a, b) => String(a.source_id ?? a.account_number).localeCompare(String(b.source_id ?? b.account_number));
  return JSON.stringify({ sources: [...(state.status?.sources || [])].sort(byId), accounts: [...state.accounts].sort(byId) });
}
export function canReview(state) {
  return ['ocr_source', 'complete'].includes(state.status?.next_step) && state.status.completed_steps?.includes('account_confirmation')
    && !state.status.active_step && state.status.status !== 'running' && state.accountsLoaded
    && !state.accountsError && !state.accountsLoading && !state.checkError && !state.checking && !state.posting && !state.uncertain
    && !state.accountPosting && !state.accountPending && !state.confirmationPending && !state.accountEditing && !state.sourceEditing
    && !state.finishing && !state.status.initialized
    && state.status.sources.every(s => s.confirmed === true && ['ready', 'skipped'].includes(s.status));
}
