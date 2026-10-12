export function receiptEmail(value) {
  const email = String(value ?? '').trim();
  const parts = email.split('@');
  if (email.length > 254 || parts.length !== 2 || parts[0].length > 64
    || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0])
    || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')
    || parts[1].split('.').length < 2
    || !parts[1].split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new Error('receiptEmailInvalid');
  }
  return `${parts[0]}@${parts[1].toLowerCase()}`;
}

export function accountSourceEmails(account, sources = [], email = '') {
  const linked = sources.filter(source => source.status !== 'skipped' && source.account_number != null
    && String(source.account_number) === String(account.account_number));
  const addresses = new Map();
  for (const source of linked) {
    const value = String(source.mailaddress ?? '').trim();
    if (value) addresses.set(value.toLowerCase(), value);
  }
  if (linked.length || ['bank', 'credit'].includes(account.account_type)) {
    return { kind: 'bank', emails: [...addresses.values()] };
  }
  return { kind: 'receipt', emails: email ? [email] : [] };
}

export function configuredReceiptEmail(status) {
  if (status?.ocr_source?.configured !== true) return '';
  try { return receiptEmail(status.ocr_source.email); } catch { return ''; }
}
