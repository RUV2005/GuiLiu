import { e, option } from './fields.js';
import { ACCOUNT_TYPES } from '../assets-model.js';
import { setupCurrency } from './accounts.js';
import { localeFor } from '../i18n.js';
import { accountSourceEmails } from './receipt-sender.js';

export function setupAmount(value, language, unknown) {
  if (!['string', 'number'].includes(typeof value) || !/^-?\d+(\.\d+)?$/.test(String(value))) return unknown;
  const decimals = Math.min(20, String(value).split('.')[1]?.length || 0);
  return new Intl.NumberFormat(localeFor(language), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

export function accountTableEditor(account, kind, focus) {
  return { kind, id: String(account.account_number), focus, fields: {
    name: account.name || '', institution: account.institution || '', account_type: account.account_type,
    credit_limit: account.credit_limit ?? '',
    // A credit account is reconciled by what is owed, not by its (negative) balance.
    confirmed_balance: account.account_type === 'credit' ? account.outstanding_balance ?? '' : account.balance ?? '',
    note: '',
  } };
}

export function accountSourceMarkup(account, sources, receiptEmail, t) {
  const source = accountSourceEmails(account, sources, receiptEmail);
  return source.emails.length ? source.emails.map(email => `<span>${e(email)}</span>`).join('')
    : `<span class="setup-source-unset">${e(t(source.kind === 'bank' ? 'bankSenderPending' : 'receiptSenderPending'))}</span>`;
}

// New accounts: a credit account asks for what is owed; the label follows the chosen type.
export function balanceInput(value, credit, t) {
  return `<input name="opening_balance" value="${e(value)}" inputmode="decimal" aria-label="${e(t(credit ? 'currentDebt' : 'initialBalance'))}" placeholder="${e(t(credit ? 'debtPlaceholder' : 'balancePlaceholder'))}"`
    + ` data-balance-input data-label-credit="${e(t('currentDebt'))}" data-label-other="${e(t('initialBalance'))}" data-hint-credit="${e(t('debtPlaceholder'))}" data-hint-other="${e(t('balancePlaceholder'))}">`;
}
export function syncBalanceInput(input, credit) {
  if (!input?.dataset?.labelCredit) return;
  input.setAttribute('aria-label', credit ? input.dataset.labelCredit : input.dataset.labelOther);
  input.placeholder = credit ? input.dataset.hintCredit : input.dataset.hintOther;
}

export function accountTableMarkup(accounts, editor, t, language = 'zh', sources = [], receiptEmail = '') {
  const inline = editor && editor.kind !== 'create' ? editor : null;
  const amount = value => setupAmount(value, language, t('balanceUnknown'));
  const input = (key, label, value, attrs = '') => `<input name="${key}" aria-label="${e(t(label))}" value="${e(value)}" ${attrs}>`;
  const cellButton = (a, kind, key, label, value) => `<button type="button" class="setup-cell-button" data-review-action="${kind}" data-id="${e(a.account_number)}" data-field="${key}" aria-label="${e(t('editCell') + ' ' + a.name + ' · ' + t(label))}">${e(value === '' || value == null ? t('notFilled') : value)}</button>`;
  const blank = '<span class="setup-cell-blank">—</span>';
  const rows = accounts.map(a => {
    const active = inline && String(a.account_number) === inline.id;
    const details = active && inline.kind === 'update', balance = active && inline.kind === 'calibrate';
    const f = active ? inline.fields : {};
    const credit = (details ? f.account_type : a.account_type) === 'credit';
    return `<tr data-account-row="${e(a.account_number)}" ${active ? 'class="is-editing"' : ''}>
      <th scope="row">${details ? input('name', 'name', f.name, 'maxlength="100" required') : cellButton(a, 'update', 'name', 'name', a.name)}</th>
      <td>${details ? `<select name="account_type" aria-label="${e(t('account_type'))}">${ACCOUNT_TYPES.map(type => option(type, t(type), type === f.account_type)).join('')}</select>` : cellButton(a, 'update', 'account_type', 'account_type', t(a.account_type))}</td>
      <td>${details ? input('institution', 'institutionLabel', f.institution, 'maxlength="100"') : cellButton(a, 'update', 'institution', 'institutionLabel', a.institution || (a.account_type === 'cash' ? '—' : ''))}</td>
      <td class="setup-account-currency">${e(setupCurrency(a.currency))}</td>
      <td class="setup-account-amount">${balance ? input('confirmed_balance', a.account_type === 'credit' ? 'currentDebt' : 'confirmedBalance', f.confirmed_balance, `inputmode="decimal" required placeholder="${e(t(a.account_type === 'credit' ? 'debtPlaceholder' : 'balancePlaceholder'))}"`)
        : a.account_type === 'credit' ? cellButton(a, 'calibrate', 'confirmed_balance', 'currentDebt', t('debtShort') + ' ' + amount(a.outstanding_balance)) : cellButton(a, 'calibrate', 'confirmed_balance', 'accountBalance', amount(a.balance))}</td>
      <td class="setup-account-amount">${details ? `<span data-review-credit ${credit ? '' : 'hidden'}>${input('credit_limit', 'credit_limit', f.credit_limit, 'inputmode="decimal"')}</span><span data-review-no-credit ${credit ? 'hidden' : ''}>${blank}</span>` : credit ? cellButton(a, 'update', 'credit_limit', 'credit_limit', amount(a.credit_limit)) : blank}</td>
      <td class="setup-account-source" data-account-source="${e(a.account_number)}">${accountSourceMarkup(a, sources, receiptEmail, t)}</td>
      <td class="setup-account-row-actions">${active ? `<button type="submit" class="setup-button primary">${e(t('saveShort'))}</button><button type="button" class="setup-button" data-review-action="cancel-account">${e(t('cancel'))}</button>` : ''}</td>
    </tr>${balance ? `<tr class="setup-account-row-note"><td colspan="8"><label class="setup-table-note"><span>${e(t('note'))}</span>${input('note', 'note', f.note, 'maxlength="1000"')}</label></td></tr>` : ''}`;
  }).join('');
  const creating = editor?.kind === 'create', f = creating ? editor.fields : {};
  const createRow = !creating ? '' : `<tr class="is-editing" data-account-create>
    <th scope="row">${input('name', 'name', f.name, 'maxlength="100" required')}</th>
    <td><select name="account_type" aria-label="${e(t('account_type'))}">${ACCOUNT_TYPES.map(type => option(type, t(type), type === f.account_type)).join('')}</select></td>
    <td>${input('institution', 'institutionLabel', f.institution, 'maxlength="100"')}</td>
    <td><select name="currency" aria-label="${e(t('currency'))}">${['JPY', 'CNY', 'USD'].map(c => option(c, c, c === f.currency)).join('')}</select></td>
    <td>${balanceInput(f.opening_balance, f.account_type === 'credit', t)}</td>
    <td><span data-review-credit ${f.account_type === 'credit' ? '' : 'hidden'}>${input('credit_limit', 'credit_limit', f.credit_limit, 'inputmode="decimal"')}</span><span data-review-no-credit ${f.account_type === 'credit' ? 'hidden' : ''}>${blank}</span></td>
    <td>${blank}</td><td class="setup-account-row-actions"><button type="submit" class="setup-button primary">${e(t('saveShort'))}</button><button type="button" class="setup-button" data-review-action="cancel-account">${e(t('cancel'))}</button></td>
    </tr><tr data-review-duplicate hidden><td colspan="8"><label class="setup-check"><input type="checkbox" name="confirm_duplicate" ${f.confirm_duplicate ? 'checked' : ''}>${e(t('separateAccount'))}</label></td></tr>`;
  return `<form data-review-account-form data-review-table-form class="setup-account-table-form"><div class="setup-account-table-scroll" role="region" aria-label="${e(t('accountsTitle'))}" tabindex="0">
    <table class="setup-account-table"><colgroup>${['name', 'type', 'institution', 'currency', 'amount', 'credit', 'source', 'actions'].map(name => `<col class="setup-account-col-${name}">`).join('')}</colgroup><thead><tr>${['name', 'account_type', 'institution', 'currency', 'balanceOrDebt', 'credit_limit', 'sourceEmail', 'actions'].map(key => `<th scope="col">${e(t(key))}</th>`).join('')}</tr></thead><tbody>${rows}${createRow}${!rows && !creating ? `<tr><td colspan="8">${e(t('noSavedAccounts'))}</td></tr>` : ''}</tbody></table>
    </div></form>`;
}
