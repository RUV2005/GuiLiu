import { e } from './fields.js';
import { canSubmit, busyStatus, stepPayload } from './model.js';
import { configuredReceiptEmail } from './receipt-sender.js';
import { canReview } from './accounts.js';
import { accountTableEditor, accountTableMarkup, accountSourceMarkup, setupAmount } from './account-table.js';
import { localizeView } from '../language-view.js';
import { candidateTableMarkup, readCandidateFields, syncCandidateControls, selectedSourcePayload } from './candidate-table.js';
import { syncBalanceInput } from './account-table.js';
import { describeSetupError } from './setup-errors.js';

const action = (label, type, id = '', disabled = false) => `<button type="button" class="setup-button" data-review-action="${type}" data-id="${e(id)}" ${disabled ? 'disabled' : ''}>${e(label)}</button>`;
export function mountBankReview({ root, controller, t, language = () => 'zh', local, draft }) {
  draft.sources ||= {};
  if (!controller.state.accountEditing && !controller.state.accountPending) draft.editor = null;
  let sourceSignature = '', accountSignature = '', tableEditorSignature = '';
  let renderedAccounts = [];
  const find = id => controller.state.accounts.find(a => String(a.account_number) === String(id));
  const label = (key, tag = 'span', attributes = '') => `<${tag} data-setup-copy="${key}" ${attributes}>${e(t(key))}</${tag}>`;
  root.innerHTML = `<div class="setup-review-grid">
    <section class="setup-review-region" aria-labelledby="setup-sources-title"><header class="setup-region-header">${label('scanResults', 'h2', 'id="setup-sources-title"')}</header>
      <div class="setup-rule-summary" data-rule-summary role="status" hidden></div><div data-review-sources></div>
      <div class="setup-inline-actions">${action(t('saveSelection'), 'save-selected')}${action(t('retryConfirmation'), 'retry-confirmation')}</div></section>
    <section class="setup-review-region" aria-labelledby="setup-accounts-title"><header class="setup-region-header">${label('savedAccounts', 'h2', 'id="setup-accounts-title"')}${action(t('addAccount'), 'create')}</header>
      <div data-review-account-feedback role="status"></div><div data-review-accounts></div></section></div>
    <footer class="setup-review-confirm"><div class="setup-inline-actions">${action(t('reviewContinue'), 'confirm')}${action(t('retry'), 'refresh')}</div></footer>`;
  function relocalize() {
    for (const node of root.querySelectorAll('[data-setup-copy]')) node.textContent = t(node.dataset.setupCopy);
    for (const [type, key] of Object.entries({ create: 'addAccount', confirm: 'reviewContinue', refresh: 'retry', 'retry-confirmation': 'retryConfirmation' })) {
      for (const node of root.querySelectorAll(`[data-review-action="${type}"]`)) node.textContent = t(key);
    }
    const candidateTemplate = root.ownerDocument.createElement('template');
    candidateTemplate.innerHTML = candidateTableMarkup(controller.state.status.sources, draft.sources, controller.state.accounts, t);
    localizeView(root.querySelector('.setup-candidate-table thead'), candidateTemplate.content.querySelector('thead'));
    for (const node of root.querySelectorAll('[data-review-source]')) {
      const translated = [...candidateTemplate.content.querySelectorAll('[data-review-source]')].find(row => row.dataset.reviewSource === node.dataset.reviewSource);
      localizeView(node, translated);
    }
    const empty = root.querySelector('.setup-candidate-table tbody:not([data-review-source]) td');
    if (empty) empty.textContent = t('emptyBankTitle');
    const table = root.querySelector('[data-review-table-form]');
    if (table) {
      const template = root.ownerDocument.createElement('template');
      template.innerHTML = accountTableMarkup(renderedAccounts, draft.editor, t, language(), controller.state.status.sources, configuredReceiptEmail(controller.state.status));
      table.querySelector('[role="region"]').setAttribute('aria-label', t('accountsTitle'));
      localizeView(table.querySelector('thead'), template.content.querySelector('thead'));
      const rows = [...template.content.querySelectorAll('tbody tr')];
      // Each row is a translation root, including the active editor, whose controls stay mounted.
      [...table.querySelectorAll('tbody tr')].forEach((row, i) => localizeView(row, rows[i]));
    } else {
      const note = root.querySelector('[data-review-accounts] p');
      if (note) note.textContent = t(controller.state.accountsLoaded ? 'noAccounts' : 'loadingAccounts');
    }
  }
  // Failed rule generation is easy to miss in a wide table, so list each source and its reason above it.
  function ruleSummaryMarkup(sources) {
    const failing = sources.filter(source => source.status === 'rules_review');
    if (!failing.length) return '';
    const items = failing.map(source => {
      const errors = Array.isArray(source.rule_errors) ? source.rule_errors : source.rule_errors ? [source.rule_errors] : [];
      const reasons = [...new Set(errors.map(row => describeSetupError(t, typeof row === 'string' ? row : row.reason || '', 'account_confirmation')))];
      const reason = reasons[0] || describeSetupError(t, source.review_reason || '', 'account_confirmation');
      return `<li><strong>${e(source.bank_name || source.mailaddress)}</strong><span>${e(reason)}${reasons.length > 1 ? e(` (+${reasons.length - 1})`) : ''}</span></li>`;
    }).join('');
    return `<p class="setup-rule-summary-title">${e(t('ruleSummaryTitle').replace('{count}', failing.length))}</p><ul>${items}</ul>
      <p class="setup-note">${e(t('ruleSummaryHint'))}</p><div class="setup-inline-actions">${action(t('retryRules'), 'retry-rules')}${action(t('skipFailing'), 'skip-failing')}</div>`;
  }
  function sync(state) {
    if (state.confirmationResult && draft.confirmationVersion !== state.confirmationResult.version) {
      draft.confirmationVersion = state.confirmationResult.version;
      for (const id of state.confirmationResult.sourceIds) delete draft.sources[id];
      sourceSignature = '';
      controller.editingSources(Object.keys(draft.sources).length > 0);
    }
    const writing = !local || state.posting || state.accountPosting || state.finishing || busyStatus(state.status) || Boolean(state.ocrPending);
    const blocked = writing || state.checking;
    const signature = JSON.stringify([state.status.sources, state.accounts]);
    if (!sourceSignature || (sourceSignature !== signature && !state.sourceEditing && !state.confirmationPending)) {
      root.querySelector('[data-review-sources]').innerHTML = candidateTableMarkup(state.status.sources, draft.sources, state.accounts, t);
      sourceSignature = signature;
    }
    const accounts = JSON.stringify([state.accounts, state.accountsLoaded]);
    const inline = draft.editor;
    const tableKey = inline ? `${draft.editor.kind}:${draft.editor.id}` : '';
    const tableChanged = tableEditorSignature !== tableKey;
    // Keep the active row DOM intact during polling so typing and focus are preserved.
    if (tableChanged || (!inline && accountSignature !== accounts)) {
      renderedAccounts = state.accounts;
      root.querySelector('[data-review-accounts]').innerHTML = accountTableMarkup(renderedAccounts, draft.editor, t, language(), state.status.sources, configuredReceiptEmail(state.status));
      accountSignature = accounts;
      tableEditorSignature = tableKey;
    }
    // Refresh derived sender cells without disturbing the active row's inputs.
    for (const cell of root.querySelectorAll('[data-account-source]')) {
      const account = find(cell.dataset.accountSource);
      if (!account) continue;
      const markup = accountSourceMarkup(account, state.status.sources, configuredReceiptEmail(state.status), t);
      if (cell.innerHTML !== markup) cell.innerHTML = markup;
    }
    const editable = canSubmit(state.status, 'account_confirmation');
    const summary = root.querySelector('[data-rule-summary]'), summaryMarkup = busyStatus(state.status) ? '' : ruleSummaryMarkup(state.status.sources);
    if (summary.innerHTML !== summaryMarkup) summary.innerHTML = summaryMarkup;
    summary.hidden = !summaryMarkup;
    for (const row of root.querySelectorAll('[data-review-source]')) {
      const rowDraft = draft.sources[row.dataset.reviewSource];
      const error = row.querySelector('[data-candidate-error]');
      error.textContent = t(rowDraft?.error || ''); error.hidden = !rowDraft?.error;
      row.querySelector('[data-candidate-duplicate]').hidden = rowDraft?.error !== 'duplicateAccount' && !rowDraft?.confirm_duplicate;
      syncCandidateControls(row, writing || !editable || Boolean(state.accountPending) || Boolean(state.confirmationPending) || state.accountEditing || state.uncertain);
      const account = find(row.querySelector('[name="account_number"]').value);
      for (const cell of row.querySelectorAll('[data-account-value]')) {
        const key = cell.dataset.accountValue, value = account?.[key];
        cell.textContent = key === 'account_type' ? t(value || 'notFilled') : key === 'currency' ? value || '—'
          : setupAmount(value, language(), t('balanceUnknown'));
      }
    }
    const selected = [...root.querySelectorAll('[data-review-source] [name="selected"]')];
    const count = selected.filter(input => input.checked).length;
    const selectAll = root.querySelector('[data-select-sources]');
    selectAll.checked = selected.length > 0 && count === selected.length;
    selectAll.indeterminate = count > 0 && count < selected.length;
    selectAll.disabled = !selected.length || writing || !editable || Boolean(state.accountPending) || Boolean(state.confirmationPending) || state.accountEditing || state.uncertain;
    const save = root.querySelector('[data-review-action="save-selected"]');
    save.textContent = count ? t('saveSelectedCount').replace('{selected}', count).replace('{skipped}', selected.length - count) : t('skipAllSources');
    save.hidden = !editable && !busyStatus(state.status);
    const edit = draft.editor && root.querySelector('[data-review-table-form]');
    if (edit) {
      for (const field of edit.querySelectorAll('input, select, fieldset')) field.disabled = writing || Boolean(state.accountPending);
      edit.querySelector('button[type="submit"]').disabled = blocked || Boolean(state.checkError);
      edit.querySelector('button[type="submit"]').textContent = t(state.accountPending ? 'retryAccountWrite' : inline ? 'saveShort' : 'saveAccount');
      const credit = edit.querySelector('[data-review-credit]');
      if (credit) { credit.hidden = edit.elements.account_type.value !== 'credit'; credit.querySelector('input').disabled ||= credit.hidden; }
      syncBalanceInput(edit.querySelector('[data-balance-input]'), edit.elements.account_type?.value === 'credit');
      const noCredit = edit.querySelector('[data-review-no-credit]');
      if (noCredit) noCredit.hidden = !credit.hidden;
      const dup = edit.querySelector('[data-review-duplicate]');
      if (dup) dup.hidden = state.accountError !== 'duplicateAccount' && !draft.editor.fields.confirm_duplicate;
    }
    if (tableChanged && inline) edit?.querySelector(`[name="${draft.editor.focus || 'name'}"]`)?.focus({ preventScroll: true });
    const feedback = root.querySelector('[data-review-account-feedback]');
    feedback.textContent = t(state.accountError || ''); feedback.hidden = !state.accountError;
    feedback.className = state.accountError ? 'setup-feedback' : '';
    for (const b of root.querySelectorAll('[data-review-action]')) {
      const type = b.dataset.reviewAction;
      b.disabled = blocked || Boolean(state.accountPending) || (Boolean(state.confirmationPending) && !['retry-confirmation', 'refresh'].includes(type)) || (state.accountEditing && type !== 'cancel-account');
      if (['create', 'update', 'calibrate'].includes(type)) b.disabled ||= state.sourceEditing || !state.accountsLoaded || Boolean(state.accountsError) || Boolean(state.checkError);
      if (['save-selected', 'save-source', 'skip-failing'].includes(type)) b.disabled ||= !editable || state.uncertain || !state.accountsLoaded || Boolean(state.accountsError) || Boolean(state.checkError);
      if (type === 'save-source') b.disabled ||= !b.closest('[data-review-source]').querySelector('[name="selected"]').checked;
      if (type === 'discard-source') b.disabled ||= !editable;
      if (type === 'retry-rules') b.disabled ||= !editable || state.uncertain || Boolean(state.checkError) || Boolean(state.confirmationPending);
      if (type === 'retry-confirmation') { b.hidden = !state.confirmationPending; b.disabled ||= !editable || state.uncertain || Boolean(state.checkError); }
      if (type === 'confirm') { b.hidden = !canReview(state); b.disabled ||= !canReview(state); }
    }
  }
  function onInput(event) {
    if (event.target.matches('[data-select-sources]')) {
      for (const row of root.querySelectorAll('[data-review-source]')) {
        row.querySelector('[name="selected"]').checked = event.target.checked;
        draft.sources[row.dataset.reviewSource] = readCandidateFields(row);
      }
      controller.editingSources(true); return;
    }
    const row = event.target.closest('[data-review-source]');
    if (row) {
      draft.sources[row.dataset.reviewSource] = readCandidateFields(row);
      controller.editingSources(true); sync(controller.state); return;
    }
    const form = event.target.closest('form');
    if (!form) { sync(controller.state); return; }
    const values = Object.fromEntries(new FormData(form));
    if (form.matches('[data-review-account-form]') && draft.editor) {
      draft.editor.fields = { ...draft.editor.fields, ...values };
      if (form.elements.confirm_duplicate) draft.editor.fields.confirm_duplicate = form.elements.confirm_duplicate.checked;
    }
    sync(controller.state);
  }
  function closeEditor() {
    const previous = draft.editor;
    draft.editor = null;
    sync(controller.state);
    const target = previous?.kind === 'create' ? root.querySelector('[data-review-action="create"]')
      : [...root.querySelectorAll('.setup-cell-button')].find(b => b.dataset.id === previous?.id && b.dataset.field === previous?.focus);
    target?.focus({ preventScroll: true });
  }
  async function onSubmit(event) {
    const form = event.target;
    if (!form.matches('[data-review-account-form]')) return;
    event.preventDefault(); event.stopPropagation();
    if (!local || !draft.editor) return;
    const { kind, id } = draft.editor;
    if (await controller.saveAccount(kind, id, Object.fromEntries(new FormData(form)))) closeEditor();
  }
  async function saveSource(id) {
    const row = [...root.querySelectorAll('[data-review-source]')].find(node => node.dataset.reviewSource === id);
    if (!local || !row || !row.querySelector('[name="selected"]').checked) return;
    try {
      const data = stepPayload('account_confirmation', { sources: { [id]: readCandidateFields(row) } }, controller.state.status.sources, controller.state.accounts);
      if (!data.confirmations?.length) return;
      if (await controller.submit('account_confirmation', data)) {
        delete draft.sources[id]; sourceSignature = '';
        controller.editingSources(Object.keys(draft.sources).length > 0); sync(controller.state);
      }
    } catch (error) { draft.sources[id] = { ...readCandidateFields(row), error: error.message }; controller.error(error.message); }
  }
  async function saveSelected() {
    if (!local) return;
    const rows = Object.fromEntries([...root.querySelectorAll('[data-review-source]')].map(row => [row.dataset.reviewSource, readCandidateFields(row)]));
    try { await controller.submit('account_confirmation', selectedSourcePayload(controller.state.status.sources, rows, controller.state.accounts)); }
    catch (error) {
      if (error.sourceId) draft.sources[error.sourceId] = { ...rows[error.sourceId], error: error.message };
      controller.error(error.message);
    }
  }
  // Leave the sources whose rules failed out (their mail is not booked automatically) and keep every other choice.
  async function skipFailing() {
    if (!local) return;
    const failing = new Set(controller.state.status.sources.filter(source => source.status === 'rules_review').map(source => source.source_id));
    const rows = Object.fromEntries([...root.querySelectorAll('[data-review-source]')].map(row => {
      const fields = readCandidateFields(row);
      return [row.dataset.reviewSource, failing.has(row.dataset.reviewSource) ? { ...fields, selected: false } : fields];
    }));
    try { await controller.submit('account_confirmation', selectedSourcePayload(controller.state.status.sources, rows, controller.state.accounts)); }
    catch (error) {
      if (error.sourceId) draft.sources[error.sourceId] = { ...rows[error.sourceId], error: error.message };
      controller.error(error.message);
    }
  }
  function onClick(event) {
    const b = event.target.closest('[data-review-action]');
    if (!b || b.disabled) return;
    const type = b.dataset.reviewAction, id = b.dataset.id;
    if (['create', 'update', 'calibrate'].includes(type)) {
      if (!controller.editingAccount(true)) return;
      const a = find(id);
      draft.editor = type !== 'create' ? accountTableEditor(a, type, b.dataset.field) : { kind: type, id, focus: 'name', fields: { name: '', institution: '', account_type: 'bank', currency: 'JPY', credit_limit: '', opening_balance: '' } };
    }
    if (type === 'cancel-account' && controller.editingAccount(false)) closeEditor();
    if (type === 'discard-source') { delete draft.sources[id]; sourceSignature = ''; controller.editingSources(Object.keys(draft.sources).length > 0); }
    if (type === 'save-source') void saveSource(id);
    if (type === 'save-selected') void saveSelected();
    if (type === 'skip-failing') void skipFailing();
    if (type === 'retry-confirmation') void (async () => {
      const pending = controller.state.confirmationPending;
      if (!pending) return;
      if (await controller.submit('account_confirmation', pending)) {
        for (const choice of pending.confirmations || []) delete draft.sources[choice.source_id];
        sourceSignature = ''; controller.editingSources(Object.keys(draft.sources).length > 0);
      }
    })();
    // An empty confirmation regenerates rules only; accounts and choices already saved stay as they are.
    if (type === 'retry-rules') void controller.submit('account_confirmation', {});
    if (type === 'refresh') { void controller.refresh(); void controller.accounts(); }
    if (type === 'confirm') controller.confirmReview({ checked: true });
    sync(controller.state);
  }
  function onKeydown(event) {
    const row = event.target.closest('[data-review-source]');
    if (row) {
      if (event.key === 'Enter' && event.target.matches('input:not([type="checkbox"])')) {
        event.preventDefault();
        const button = row.querySelector('[data-review-action="save-source"]');
        if (!event.isComposing && !button.disabled) void saveSource(row.dataset.reviewSource);
      }
      return;
    }
    if (!event.target.closest('[data-review-account-form]') || !draft.editor) return;
    if (event.isComposing) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Escape' && controller.editingAccount(false)) {
      event.preventDefault(); closeEditor();
    }
  }
  root.addEventListener('input', onInput); root.addEventListener('change', onInput);
  root.addEventListener('submit', onSubmit); root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  return { sync, relocalize, dispose() {
    root.removeEventListener('input', onInput); root.removeEventListener('change', onInput);
    root.removeEventListener('submit', onSubmit); root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeydown);
  } };
}
