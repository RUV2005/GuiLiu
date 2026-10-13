import { e, field, select, option } from './fields.js';
import { setupCurrency } from './accounts.js';
import { stepPayload } from './model.js';
import { describeSetupError } from './setup-errors.js';
import { balanceInput, syncBalanceInput } from './account-table.js';

export function candidateDraft(source) {
  const draft = source.account_draft || {};
  return { selected: source.confirmed === true && source.status !== 'skipped',
    action: source.account_number != null || source.suggested_account_number != null ? 'existing' : 'new',
    account_number: String(source.account_number ?? source.suggested_account_number ?? ''),
    name: draft.name ?? '', institution: draft.institution ?? '', account_type: draft.account_type ?? '',
    // A saved credit draft keeps the debt as a negative balance; the form shows what is owed.
    currency: setupCurrency(draft.currency), opening_balance: draft.account_type === 'credit' && String(draft.opening_balance ?? '').startsWith('-') ? String(draft.opening_balance).slice(1) : draft.opening_balance ?? '',
    credit_limit: draft.credit_limit ?? '', account_ref: source.account_ref ?? '', confirm_duplicate: false };
}

export function candidateRowMarkup(source, saved, accounts, t) {
  const d = saved || candidateDraft(source);
  const eligible = accounts.filter(a => ['bank', 'credit'].includes(a.account_type));
  const options = source.confirmed && source.account_number != null ? ['existing'] : ['new', 'existing'];
  const input = (key, attrs = '') => field(t(key), key, d[key], attrs);
  const newCell = (body, key) => `<td><div data-candidate-new>${body}</div><span data-candidate-existing data-account-value="${key}"></span></td>`;
  const errors = source.status === 'skipped' ? [] : Array.isArray(source.rule_errors) ? source.rule_errors : source.rule_errors ? [source.rule_errors] : [];
  return `<tbody data-review-source="${e(source.source_id)}">
    <tr><td class="setup-selection-cell"><input type="checkbox" name="selected" aria-label="${e(t('selectSource') + ' ' + (source.bank_name || source.mailaddress))}" ${d.selected ? 'checked' : ''}></td>
      <th scope="row"><span class="setup-candidate-bank">${e(source.bank_name || source.source_id)}</span><span class="setup-candidate-email">${e(source.mailaddress)}</span><input type="hidden" name="institution" value="${e(d.institution)}"></th>
      <td>${select(t('accountAction'), 'action', options.map(a => option(a, t(a), a === d.action)).join(''))}</td>
      <td><div data-candidate-new>${input('name', 'maxlength="100"')}</div>
        <div data-candidate-existing>${select(t('selectAccount'), 'account_number', option('', t('selectAccount'), !d.account_number)
          + eligible.map(a => option(a.account_number, `${a.name} · ${setupCurrency(a.currency)}`, String(a.account_number) === String(d.account_number))).join(''))}</div></td>
      ${newCell(select(t('account_type'), 'account_type', option('', t('notFilled'), !d.account_type) + ['bank', 'credit'].map(type => option(type, t(type), type === d.account_type)).join('')), 'account_type')}
      ${newCell(select(t('currency'), 'currency', option('', t('notFilled'), !d.currency) + ['JPY', 'CNY'].map(c => option(c, c, c === d.currency)).join('')), 'currency')}
      ${newCell(balanceInput(d.opening_balance, d.account_type === 'credit', t), 'balance')}
      ${newCell(`<div data-candidate-credit>${input('credit_limit', 'inputmode="decimal"')}</div>`, 'credit_limit')}
      <td><div data-candidate-ref>${input('account_ref', 'maxlength="80"')}</div></td>
      <td class="setup-candidate-status"><span>${e(t(source.status || 'pending'))}</span>
        <div class="setup-rule-error" data-candidate-error hidden></div>
        ${errors.length ? `<details><summary>${e(t('showReason'))}</summary><ul class="setup-rule-error">${errors.map(reason => `<li>${e(describeSetupError(t, typeof reason === 'string' ? reason : reason.reason || JSON.stringify(reason), 'account_confirmation'))}</li>`).join('')}</ul></details>` : ''}
        ${source.review_reason && source.status !== 'skipped' ? `<details><summary>${e(t('showReason'))}</summary><div>${e(describeSetupError(t, source.review_reason, 'account_confirmation'))}</div></details>` : ''}
        <label class="setup-check" data-candidate-duplicate ${saved?.error === 'duplicateAccount' || d.confirm_duplicate ? '' : 'hidden'}><input type="checkbox" name="confirm_duplicate" ${d.confirm_duplicate ? 'checked' : ''}>${e(t('separateAccount'))}</label></td>
      <td class="setup-account-row-actions"><button type="button" class="setup-button" data-review-action="save-source" data-id="${e(source.source_id)}">${e(t('saveSource'))}</button>
        <button type="button" class="setup-button" data-review-action="discard-source" data-id="${e(source.source_id)}">${e(t('cancel'))}</button></td></tr></tbody>`;
}

export function candidateTableMarkup(sources, drafts, accounts, t) {
  const headers = ['bankAndEmail', 'accountAction', 'name', 'account_type', 'currency', 'opening_balance', 'credit_limit', 'accountReference', 'sourceState', 'actions'];
  return `<div class="setup-account-table-scroll" role="region" aria-label="${e(t('bankSources'))}" tabindex="0"><table class="setup-account-table setup-candidate-table"><thead><tr>
    <th scope="col" class="setup-selection-cell"><input type="checkbox" data-select-sources aria-label="${e(t('selectAllSources'))}"></th>${headers.map(h => `<th scope="col">${e(t(h))}</th>`).join('')}</tr></thead>
    ${sources.length ? sources.map(s => candidateRowMarkup(s, drafts[s.source_id], accounts, t)).join('') : `<tbody><tr><td colspan="11">${e(t('emptyBankTitle'))}</td></tr></tbody>`}</table></div>`;
}

export function selectedSourcePayload(sources, drafts, accounts, now = Date.now()) {
  if (!sources.length) return { skip_bank_sources: true };
  const confirmations = [], knownAccounts = [...accounts];
  for (const source of sources) {
    const fields = drafts[source.source_id] || candidateDraft(source);
    if (fields.selected !== true) { confirmations.push({ source_id: source.source_id, action: 'skip' }); continue; }
    try {
      const data = stepPayload('account_confirmation', { sources: { [source.source_id]: fields } }, [source], knownAccounts, now);
      const choice = data.confirmations?.[0];
      if (!choice) throw new Error('accountRequired');
      confirmations.push(choice);
      // Catch duplicate new-account drafts within the same batch before making any request.
      if (choice.account) knownAccounts.push(choice.account);
    } catch (error) { error.sourceId = source.source_id; throw error; }
  }
  return { confirmations };
}

export function readCandidateFields(row) {
  return Object.fromEntries([...row.querySelectorAll('input[name], select[name]')].map(input =>
    [input.name, input.type === 'checkbox' ? input.checked : input.value]));
}

export function syncCandidateControls(row, locked) {
  const action = row.querySelector('[name="action"]').value;
  const credit = row.querySelector('[name="account_type"]').value === 'credit';
  for (const [selector, visible] of [['[data-candidate-new]', action === 'new'], ['[data-candidate-existing]', action === 'existing'],
    ['[data-candidate-ref]', ['new', 'existing'].includes(action)], ['[data-candidate-credit]', action === 'new' && credit]]) {
    for (const group of row.querySelectorAll(selector)) group.hidden = !visible;
  }
  syncBalanceInput(row.querySelector('[data-balance-input]'), credit);
  const selected = row.querySelector('[name="selected"]').checked;
  for (const input of row.querySelectorAll('input, select')) input.disabled = locked || Boolean(input.closest('[hidden]')) || (input.name !== 'selected' && !selected);
}
