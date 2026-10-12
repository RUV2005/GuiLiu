import { accountPayload } from './accounts.js';
import { receiptEmail, configuredReceiptEmail } from './receipt-sender.js';

export const STEPS = ['api_keys', 'gmail', 'vector_db', 'bank_rules', 'account_confirmation', 'ocr_source', 'complete'];
export const UI_STEPS = [...STEPS];
export function statusSnapshot(value) {
  if (!value || typeof value.initialized !== 'boolean') throw new Error('invalidStatus');
  if (value.initialized) return value;
  if (!STEPS.includes(value.next_step) || !Array.isArray(value.completed_steps)) throw new Error('invalidStatus');
  return { ...value, sources: Array.isArray(value.sources) ? value.sources : [], progress: value.progress || {} };
}
export function busyStatus(status) { return Boolean(status?.active_step) || status?.status === 'running'; }
export function completed(status, step) { return Boolean(status?.completed_steps?.includes(step)); }
export function canVisit(status, step) {
  return STEPS.includes(step) && (step === status?.next_step || step === status?.active_step || completed(status, step));
}
export function canSubmit(status, step) {
  return status && !status.initialized && !busyStatus(status) && (step === status.next_step
    || (['api_keys', 'gmail', 'ocr_source'].includes(step) && completed(status, step)))
    && (step !== 'complete' || (status.ready_to_complete === true && completed(status, 'ocr_source') && Boolean(configuredReceiptEmail(status))));
}
export function stepProgress(status) {
  const p = status?.progress || {};
  const vector = status?.active_step ? status.active_step === 'vector_db' : ('vectorized' in p && !('groups_checked' in p));
  const total = Number(vector ? p.total : p.groups_total), done = Number(vector ? p.vectorized : p.groups_checked);
  if (!Number.isFinite(total) || !Number.isFinite(done) || total < 0 || done < 0) return null;
  return { total, done, percent: total ? Math.min(100, done / total * 100) : 0 };
}
export function safeAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
export function safeError(error, secrets = []) {
  let message = String(error?.message || error || '').slice(0, 3000);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[redacted]');
  return message.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
}
// Which model keys the Backend reports as saved (GET /initialization → agent.credentials).
export const savedKeys = status => ({ dashscope: Boolean(status?.agent?.credentials?.DASHSCOPE_API_KEY),
  openai: Boolean(status?.agent?.credentials?.OPENAI_API_KEY) });
// The Backend names mailbox read failures only by exception type; point at the likely cause for the current step.
export const setupErrorKey = (message, step) => /^MailAccessError: /.test(message) ? (step === 'gmail' ? 'neteaseConnectFailed' : 'mailReadFailed') : message;
// One filter is sent to every connected mailbox. 163 search (mail_access.NetEaseMail._ids) understands only these
// operators, plain keywords and in:inbox, so reject Gmail-only syntax before the import starts instead of mid-run.
const NETEASE_QUERY_KEYS = new Set(['from', 'to', 'subject', 'text', 'after', 'before']);
function queryTokens(query) {
  const tokens = []; let token = '', quote = '', open = false;
  for (const char of query) {
    if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; open = true; }
    else if (/\s/.test(char)) { if (token || open) tokens.push(token); token = ''; open = false; }
    else token += char;
  }
  if (quote) return null;
  if (token || open) tokens.push(token);
  return tokens;
}
export function mailQueryError(query, providers = ['gmail']) {
  if (!providers?.includes('163')) return '';
  const tokens = queryTokens(query);
  if (!tokens) return 'query163Unsupported';
  for (const token of tokens) {
    if (!token) return 'query163Unsupported';
    if (token.toLowerCase() === 'in:inbox') continue;
    if (/^[-({]/.test(token) || token === 'OR' || token === 'AND') return 'query163Unsupported';
    const colon = token.indexOf(':');
    if (colon < 0) continue;
    const key = token.slice(0, colon).toLowerCase(), value = token.slice(colon + 1);
    if (!NETEASE_QUERY_KEYS.has(key) || !value) return 'query163Unsupported';
    if ((key === 'after' || key === 'before') && !/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(value)) return 'queryDateInvalid';
  }
  return '';
}
const clean = value => String(value ?? '').trim();
// Mail date range of the vector step, in months back from today; 0 is all mail and the default (last) stop.
export const MAIL_RANGES = [3, 6, 12, 24, 36, 0];
export const ALL_MAIL_RANGE = MAIL_RANGES.length - 1;
export function rangeStart(index, now = new Date()) {
  const months = MAIL_RANGES[index] ?? 0;
  if (!months) return null;
  const year = now.getFullYear(), month = now.getMonth() - months;
  return new Date(year, month, Math.min(now.getDate(), new Date(year, month + 1, 0).getDate()));
}
const two = n => String(n).padStart(2, '0');
export function rangeQuery(index, now = new Date()) {
  const start = rangeStart(index, now);
  return start ? `after:${start.getFullYear()}/${two(start.getMonth() + 1)}/${two(start.getDate())}` : '';
}
// What a saved filter means, for the locked view: all mail, mail from a date on, or a custom search.
export function describeQuery(query) {
  const text = clean(query);
  const match = /^after:(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text);
  return !text ? { kind: 'all' } : match ? { kind: 'after', date: new Date(+match[1], match[2] - 1, +match[3]) } : { kind: 'custom', query: text };
}
export function stepPayload(step, fields, sources = [], accounts = [], now = Date.now()) {
  if (step === 'api_keys') {
    // A blank key is tested from what the Backend already saved; both blank re-tests the saved pair.
    const saved = fields.saved_keys || {};
    const dashscope_api_key = clean(fields.dashscope_api_key), openai_api_key = clean(fields.openai_api_key);
    if ((!dashscope_api_key && !saved.dashscope) || (!openai_api_key && !saved.openai)) throw new Error('keysRequired');
    return { ...(dashscope_api_key ? { dashscope_api_key } : {}), ...(openai_api_key ? { openai_api_key } : {}) };
  }
  if (step === 'gmail') {
    if (fields.connect_provider) {
      const connect_provider = fields.connect_provider;
      if (!['gmail', '163'].includes(connect_provider)) throw new Error('mailSelectionRequired');
      const providers = ['gmail', '163'].filter(p => p === connect_provider || fields.connected_providers?.includes(p));
      if (connect_provider === 'gmail' && fields.gmail_method !== 'imap') return { providers, connect_provider };
      if (connect_provider === 'gmail') {
        // Gmail over IMAP: the account and its app password; Google shows the password in groups of four.
        const email = clean(fields.gmail_email).toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('gmailEmailInvalid');
        const authorization_code = clean(fields.gmail_app_password).replace(/\s+/g, '');
        if (authorization_code && !/^[A-Za-z]{16}$/.test(authorization_code)) throw new Error('gmailAppPasswordInvalid');
        return { providers, connect_provider, gmail_method: 'imap', email, ...(authorization_code ? { authorization_code } : {}) };
      }
      const email = clean(fields.netease_email).toLowerCase();
      if (!/^[a-z0-9_.-]+@163\.com$/.test(email)) throw new Error('neteaseEmailInvalid');
      const authorization_code = clean(fields.netease_code);
      return { providers, connect_provider, email, ...(authorization_code ? { authorization_code } : {}) };
    }
    if (!Object.hasOwn(fields, 'mail_mode')) return {};
    const mode = fields.mail_mode;
    if (!['gmail', '163', 'both'].includes(mode)) throw new Error('mailSelectionRequired');
    const providers = mode === 'both' ? ['gmail', '163'] : [mode];
    if (!providers.includes('163')) return { providers };
    const email = clean(fields.netease_email).toLowerCase();
    if (!/^[a-z0-9_.-]+@163\.com$/.test(email)) throw new Error('neteaseEmailInvalid');
    const authorization_code = clean(fields.netease_code);
    return { providers, email, ...(authorization_code ? { authorization_code } : {}) };
  }
  if (step === 'ocr_source') return { email: receiptEmail(fields.email) };
  if (step === 'vector_db') {
    // A started import keeps its first filter; otherwise a custom search takes the place of the date range.
    const query = typeof fields.locked_query === 'string' ? fields.locked_query
      : clean(fields.query) || rangeQuery(Number(fields.mail_range ?? ALL_MAIL_RANGE), new Date(now));
    if (query.length > 2000) throw new Error('queryLong');
    const invalid = mailQueryError(query, fields.mail_providers);
    if (invalid) throw new Error(invalid);
    return { query };
  }
  if (step === 'complete') return {};
  if (step === 'bank_rules') return {};
  if (step !== 'account_confirmation') throw new Error('invalidStatus');
  if (!sources.length) {
    if (fields.skip_bank_sources !== true) throw new Error('emptySkipRequired');
    return { skip_bank_sources: true };
  }
  if (fields.skip_bank_sources) throw new Error('emptySkipInvalid');
  const confirmations = [];
  for (const source of sources) {
    const f = fields.sources?.[source.source_id];
    if (!f || !f.action || f.action === 'later') continue;
    if (f.action === 'skip') { confirmations.push({ source_id: source.source_id, action: 'skip' }); continue; }
    const choice = { source_id: source.source_id, action: 'bind' };
    if (Object.hasOwn(f, 'account_ref')) choice.account_ref = clean(f.account_ref);
    if (choice.account_ref?.length > 80) throw new Error('referenceLong');
    if (f.action === 'existing') {
      const number = Number(f.account_number), account = accounts.find(a => Number(a.account_number) === number);
      if (!Number.isSafeInteger(number) || number <= 0 || !account || !['bank', 'credit'].includes(account.account_type)) throw new Error('accountRequired');
      choice.account_number = number;
    } else if (f.action === 'new') {
      if ((source.confirmed && source.account_number != null) || !['bank', 'credit'].includes(f.account_type)) throw new Error('accountInvalid');
      choice.account = accountPayload('create', f, null, accounts, now);
    } else throw new Error('accountInvalid');
    confirmations.push(choice);
  }
  return confirmations.length ? { confirmations } : {};
}
