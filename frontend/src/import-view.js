import { escapeHtml as h, escapeAttr as a } from './utils.js';
import { accountOptions } from './assets-view.js';
import { financeAttr } from './finance-colors.js';
import { IMPORT_EDIT_FIELDS, IMPORT_GROUPS, editableImport, processingImport, rowDone, missingClassification, canImportRow,
  canEditImportRow, currencyLabel, importSelection, visibleImportRows, isIncomeRow, needsIncomeConfirmation, groupCounts,
  activeGroup, rowReasons, rowStatus, paymentMethods } from './import-model.js';

export const importFieldKey = field => 'import' + field[0].toUpperCase() + field.slice(1);
export const importText = (ctx, key, vars) => {
  const value = ctx.t(importFieldKey(key), vars);
  return value === importFieldKey(key) ? key : value;
};
const button = (action, label, disabled = false, primary = false, describedBy = '', extra = '') =>
  `<button type="button" class="button${primary ? ' primary' : ''}" data-import-action="${a(action)}"${disabled ? ' disabled' : ''}${describedBy ? ' aria-describedby="' + a(describedBy) + '"' : ''}${extra}>${h(label)}</button>`;
const opts = (values, selected) => values.map(([value, label]) =>
  `<option value="${a(value)}"${String(value) === String(selected) ? ' selected' : ''}>${h(label)}</option>`).join('');
const textValue = value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
const amountText = row => (isIncomeRow(row) ? '+' : '-') + String(row.normalized?.price ?? '') + ' ' + currencyLabel(row.normalized?.CurrencyTypeNumber);
const locked = s => Boolean(s.busy || s.pendingCommit || s.editor || s.rowsLoading || !editableImport(s.job) || s.rowsRevision !== s.job?.revision);
const notice = (ctx, value, error = false) => value ? `<p class="import-notice${error ? ' is-error' : ''}" role="${error ? 'alert' : 'status'}">${h(importText(ctx, value))}</p>` : '';
const reviewing = job => job && !processingImport(job.state) && job.state !== 'mapping_required';

function accountName(ctx, number) {
  const account = ctx.state.importData.accounts.find(item => String(item.account_number) === String(number));
  return account ? account.name : '#' + number;
}

// Upload: pick a file, pick the account, start. Everything else waits under "Advanced".
function setup(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars);
  if (s.job || s.resumeId) return '';
  const disabled = Boolean(s.busy || s.setupLoading), attr = disabled ? ' disabled' : '';
  const missing = !s.file ? 'needFile' : !s.form.account_number ? 'needAccount' : '';
  return `<p class="import-intro">${h(t('intro'))}</p>
    <div class="import-steps">
      <section class="import-step" aria-labelledby="import-step-file"><h2 id="import-step-file"><span aria-hidden="true">1</span>${h(t('stepFile'))}</h2>
        <div class="import-drop ${s.file ? 'has-file' : ''}" data-import-drop>
          <div class="import-file-mark"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg></div>
          <div class="import-file-copy"><h3>${h(s.file?.name || t('drop'))}</h3><p>${h(t('formats'))}</p></div>
          ${button('choose', t(s.file ? 'replace' : 'choose'), disabled, !s.file)}
        </div></section>
      <section class="import-step" aria-labelledby="import-step-account"><h2 id="import-step-account"><span aria-hidden="true">2</span>${h(t('stepAccount'))}</h2>
        <select class="import-account-select" data-import-form="account_number" aria-labelledby="import-step-account"${attr}>${opts([['', t('chooseAccount')]], s.form.account_number)}${accountOptions(ctx, s.form.account_number, s.accounts)}</select>
        <p class="import-privacy">${h(t('accountHint'))}</p>
        ${s.setupLoaded && !s.accounts.length ? notice(ctx, 'noAccounts') : ''}
      </section>
    </div>
    <div class="import-start">
      <p class="import-privacy">${h(t(s.form.use_agent ? 'agentOn' : 'agentOff'))}</p>
      <div class="import-upload-submit"><p id="import-start-hint" class="import-upload-hint" role="status"${missing ? '' : ' hidden'}>${missing ? h(t(missing)) : ''}</p>
        ${button('upload', t(s.busy || 'start'), Boolean(missing) || !s.setupLoaded || disabled, true, missing ? 'import-start-hint' : '')}</div>
    </div>
    ${s.setupLoading ? notice(ctx, 'loading') : ''}
    ${s.setupError ? notice(ctx, s.setupError, true) + button('setup', t('retrySetup'), disabled) : ''}
    <details class="import-advanced" data-import-advanced${s.advancedOpen ? ' open' : ''}><summary>${h(t('advanced'))}</summary>
      <div class="import-map-grid">
        <label>${h(t('source'))}<select data-import-form="preset_id"${attr}>${opts([['', t('auto')], ...s.presets.map(p => [p.preset_id, p.name || p.preset_id])], s.form.preset_id)}</select></label>
        <label>${h(t('timezone'))}<input data-import-form="timezone" value="${a(s.form.timezone)}"${attr}/></label>
        <label>${h(t('defaultCurrency'))}<select data-import-form="default_currency"${attr}>${opts([['CNY', 'CNY'], ['JPY', 'JPY']], s.form.default_currency)}</select></label>
        <label>${h(t('sheet'))}<input data-import-form="sheet_name" value="${a(s.form.sheet_name)}"${attr}/></label>
      </div>
      <label class="import-check"><input type="checkbox" data-import-form="use_agent"${s.form.use_agent ? ' checked' : ''}${attr}/><span>${h(t('useAgent'))}</span></label>
      <p class="import-privacy">${h(t('disclosure'))}</p>
      <p class="import-privacy">${h(t('builtinCurrency'))}</p>
      <div class="button-row">${button('presets', t(s.presetOpen ? 'hideCustomFormat' : 'customFormat'), Boolean(s.busy || s.pendingCommit || s.editor))}</div>
    </details>`;
}
// Analysis reports merchant/product pairs classified so far; other processing states have no measurable progress.
function progressBar(ctx, job) {
  const p = job.state === 'analyzing' && job.progress?.total > 0 ? job.progress : null;
  if (!p) return '<progress aria-label="' + a(importText(ctx, job.state)) + '"></progress>';
  const label = importText(ctx, 'classifyingProgress', { done: p.done, total: p.total });
  return `<div class="import-progress"><progress value="${a(p.done)}" max="${a(p.total)}" aria-label="${a(label)}"></progress><span>${h(label)}</span></div>`;
}
function stage(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars), job = s.job;
  if (!job) return s.resumeId ? notice(ctx, 'loading') + button('refresh', t('refresh'), Boolean(s.busy)) + button('choose', t('otherFile'), Boolean(s.busy || s.pendingCommit)) : '';
  const working = processingImport(job.state) || job.state === 'mapping_required';
  return `<div class="import-job">
    <div><h2>${h(job.filename)}</h2><p>${h(t('intoAccount', { account: accountName(ctx, job.account_number) }))}</p></div>
    <div class="button-row">${working ? `<span class="import-job-state" role="status">${h(t(job.state))}</span>` : ''}${s.pollingError ? button('refresh', t('refresh'), Boolean(s.busy)) : ''}${button('choose', t('otherFile'), Boolean(s.busy || s.pendingCommit || s.editor))}</div>
    ${processingImport(job.state) ? progressBar(ctx, job) : ''}
    </div>
    ${notice(ctx, job.error, true)}
    ${(job.warnings || []).map(item => notice(ctx, textValue(item))).join('')}`;
}
function mapping(ctx) {
  const s = ctx.state.importData, t = key => importText(ctx, key);
  if (!s.presetOpen && s.job?.state !== 'mapping_required') return '';
  const isMapping = s.job?.state === 'mapping_required', disabled = Boolean(s.busy || s.pendingCommit || s.editor);
  return `<section class="import-preset"><h2>${h(t(isMapping ? 'mapping' : 'customFormat'))}</h2>
    ${isMapping && s.job.header_samples?.length ? `<h3>${h(t('samples'))}</h3><div class="import-samples">${s.job.header_samples.map(sample =>
      `<div><span>${h(sample.sheet)} · #${h(sample.row_number)}</span><p>${(sample.cells || []).map(cell => '<code>' + h(cell) + '</code>').join(' ')}</p></div>`).join('')}</div>` : ''}
    <p class="import-privacy">${h(t('mappingHint'))}</p>
    <div class="import-preset-tools">${!isMapping ? `<select data-import-preset-load aria-label="${a(t('preset'))}"${disabled ? ' disabled' : ''}>${opts([['', t('preset')], ...s.presets.map(p => [p.preset_id, p.name || p.preset_id])], s.form.preset_id)}</select>` : ''}
      ${button('load-json', t('loadJson'), disabled)}${button('download', t('download'), !s.presetText || Boolean(s.busy))}</div>
    <textarea data-import-preset-text aria-label="${a(t('presets'))}" spellcheck="false"${disabled ? ' disabled' : ''}>${h(s.presetText)}</textarea>
    <div class="import-map-actions">
    ${isMapping ? `<label class="import-check"><input type="checkbox" data-import-save-preset${s.savePreset ? ' checked' : ''}${disabled ? ' disabled' : ''}/>${h(t('saveForLater'))}</label>` : ''}
    ${button(isMapping ? 'map' : 'save-preset', t(s.busy === 'mapping' ? 'parsing' : isMapping ? 'applyMapping' : 'savePreset'), disabled, true)}</div></section>`;
}
// The file in one sentence, then one card per group; a card filters the list below.
function summary(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars), job = s.job;
  if (!reviewing(job)) return '';
  const counts = groupCounts(job), group = activeGroup(s);
  const parts = IMPORT_GROUPS.filter(name => counts[name]).map(name => t('sum_' + name, { count: counts[name] }));
  const sentence = t('sumTotal', { total: job.total }) + parts.join(t('listSeparator')) + t('sumEnd');
  const nothing = !counts.ready && !counts.attention ? `<p class="import-nothing">${h(t(counts.done ? 'allHandled' : 'nothingNew'))}</p>` : '';
  const cards = IMPORT_GROUPS.filter(name => counts[name]).map(name => `<button type="button" class="import-group is-${name}${group === name ? ' is-active' : ''}" data-import-group="${name}" aria-pressed="${group === name}"${s.editor || s.busy ? ' disabled' : ''}>
    <strong>${h(counts[name])}</strong><span>${h(t('group_' + name))}</span><small>${h(t('groupHint_' + name))}</small></button>`).join('');
  const c = job.classification, classified = c && c.memory + c.model + c.user > 0
    ? `<p class="import-classified${c.open ? ' has-open' : ''}" role="status">${h(t('classifiedSummary', c))}</p>` : '';
  return `<p class="import-sentence" role="status">${h(sentence)}</p>${nothing}${accountHint(ctx)}
    <div class="import-groups" role="group" aria-label="${a(t('groupsLabel'))}">${cards}</div>${classified}`;
}
// Rows imported before into another account usually mean the wrong account was chosen for this file.
function accountHint(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars);
  const [number, count] = Object.entries(s.job.previous_accounts || {}).sort((x, y) => y[1] - x[1])[0] || [];
  if (!number) return '';
  const other = s.accounts.find(item => String(item.account_number) === String(number)), name = other ? other.name : '#' + number;
  return `<div class="import-account-hint" role="status"><p>${h(t('otherAccountHint', { count, other: name, current: accountName(ctx, s.job.account_number) }))}</p>
    ${other ? button('switch-account', t('useOtherAccount', { account: name }), Boolean(s.busy || s.pendingCommit || s.editor), true, '', ` data-account="${a(number)}"`) : ''}</div>`;
}
function controls(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars);
  if (!reviewing(s.job)) return '';
  const group = activeGroup(s), counts = groupCounts(s.job);
  if (!counts[group]) return '';
  const disabled = Boolean(s.editor || s.busy || s.pendingCommit);
  return `<div class="import-toolbar"><div><h2>${h(t('group_' + group))}</h2><p>${h(t('groupHint_' + group))}</p></div><div class="import-tools">
    ${paymentFilter(ctx, group, disabled)}
    <input type="search" data-import-query value="${a(s.query)}" placeholder="${a(t('search'))}" aria-label="${a(t('search'))}"${disabled ? ' disabled' : ''}/>
    </div></div>`;
}
// A file can mix payment methods (Huabei, a balance, a bank card); each can be looked at and imported on its own.
function paymentFilter(ctx, group, disabled) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars), methods = paymentMethods(s.job, group);
  if (methods.length < 2) return '';
  const total = methods.reduce((sum, [, count]) => sum + count, 0);
  return `<select data-import-payment aria-label="${a(t('paymentFilter'))}"${disabled ? ' disabled' : ''}>${opts([['*', t('allPayments', { count: total })],
    ...methods.map(([method, count]) => [method, (method || t('noPayment')) + ' (' + count + ')'])], s.payment === null ? '*' : s.payment)}</select>`;
}
function reasons(ctx, row) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars);
  // Only rows that wait for the user are highlighted; rows in the ledger or not bookkeeping stay quiet.
  const state = rowStatus(row), open = !rowDone(row) && ['new', 'suspected_duplicate', 'needs_review'].includes(row.status);
  const tone = ['invalid', 'failed'].includes(state) || row.commit_error ? 'has-error'
    : open && (row.status !== 'new' || missingClassification(row) || needsIncomeConfirmation(row)) ? 'needs-review' : '';
  return rowReasons(row, s.job.account_number).map(({ key, vars }) =>
    `<p class="import-row-state ${tone}">${h(t(key, ['noteOtherAccount', 'noteInOtherAccount'].includes(key) ? { account: accountName(ctx, vars.account) } : vars))}</p>`).join('');
}
function editorRow(ctx, row) {
  const s = ctx.state.importData, t = key => importText(ctx, key), editor = s.editor, off = s.busy || s.pendingCommit ? ' disabled' : '';
  const fields = IMPORT_EDIT_FIELDS.filter(field => !isIncomeRow(row) || field === 'shop_name');
  return `<tr class="import-edit-row"><td></td><td colspan="6"><div class="import-editor">
    ${fields.map(field => `<label>${h(t(field))}<input data-import-field="${field}" value="${a(editor.draft[field])}" maxlength="300"${off}/></label>`).join('')}
    <div class="button-row">${button('save-row', t(s.busy === 'saving' ? 'saving' : 'save'), Boolean(s.busy || s.pendingCommit || s.rowsLoading), true)}${button('cancel-edit', t('cancel'), Boolean(s.busy))}</div></div>
    ${notice(ctx, editor.error, true)}${editor.conflict ? '<p class="import-notice"><strong>' + h(t('latest')) + '</strong> ' + IMPORT_EDIT_FIELDS.map(field => h(t(field)) + ': ' + h(editor.latest?.[field] ?? row.normalized[field])).join(' · ') + '</p>' : ''}</td></tr>`;
}
function rowDetails(ctx, row) {
  const s = ctx.state.importData, t = key => importText(ctx, key), n = row.normalized || {}, id = row.row_id;
  const candidates = row.duplicate_candidates || [], showMatches = row.status === 'suspected_duplicate' || (s.expanded.has(id) && candidates.length > 0);
  let html = '';
  if (showMatches) html += `<tr class="import-match-row"><td></td><td colspan="6"><div class="import-candidates">
    <strong>${h(t('candidates'))}</strong>
    ${candidates.map(candidate => `<div class="import-candidate"><span>${h(t(candidate.income_id != null ? 'incomeMatch' : candidate.DealingNumber != null ? 'ledgerMatch' : 'fileMatch'))} #${h(candidate.income_id ?? candidate.DealingNumber ?? candidate.row_id ?? '')}</span>
      <strong>${h(candidate.shop_name ?? '')}</strong><span>${h(candidate.price ?? '')} ${h(currencyLabel(candidate.CurrencyTypeNumber ?? n.CurrencyTypeNumber))}</span>
      <span>${h(candidate.time ?? '')}</span>${candidate.AccountNumber != null ? '<span>' + h(t('account')) + ': ' + h(accountName(ctx, candidate.AccountNumber)) + '</span>' : ''}<span>${h(candidate.product_name ?? '')}</span>
      <p>${h(t('reason'))}: ${(candidate.reasons || []).map(reason => h(t(reason))).join(' · ')}</p></div>`).join('')}
    ${row.status === 'suspected_duplicate' && !rowDone(row) ? `<label class="import-check"><input type="checkbox" data-import-distinct="${a(id)}"${s.distinct.has(id) ? ' checked' : ''}${locked(s) ? ' disabled' : ''}/>${h(t(isIncomeRow(row) ? 'distinctIncome' : 'distinct'))}</label>` : ''}
    </div></td></tr>`;
  if (needsIncomeConfirmation(row) && !rowDone(row) && ['new', 'suspected_duplicate'].includes(row.status)) html += `<tr class="import-match-row"><td></td><td colspan="6"><label class="import-check"><input type="checkbox" data-import-external-income="${a(id)}"${s.externalIncome.has(id) ? ' checked' : ''}${locked(s) ? ' disabled' : ''}/>${h(t('externalIncome'))}</label></td></tr>`;
  if (row.commit_error) html += `<tr class="import-edit-error"><td colspan="7">${h(row.commit_error)}</td></tr>`;
  if (row.DealingNumber != null || row.income_id != null || row.balance_sync != null) html += `<tr class="import-result-row"><td></td><td colspan="6">${row.income_id != null ? '<button type="button" class="text-button" data-import-income="' + a(id) + '">' + h(t('incomeMatch')) + ' #' + h(row.income_id) + '</button>' : row.DealingNumber != null ? '<button type="button" class="text-button" data-assets-deal="' + a(row.DealingNumber) + '">' + h(t('ledgerMatch')) + ' #' + h(row.DealingNumber) + '</button>' : ''} ${row.balance_sync != null ? '<span>' + h(t('balance')) + ': ' + h(t(row.balance_sync.status || 'unavailable')) + (row.balance_sync.reason ? ' · ' + h(row.balance_sync.reason) : '') + '</span>' : ''}</td></tr>`;
  if (s.expanded.has(id)) html += `<tr class="import-details-row"><td></td><td colspan="6"><dl>${[
    ['account', accountName(ctx, n.AccountNumber)], ['payment', n.payment_method], ['transactionType', n.transaction_type], ['transactionId', n.transaction_id], ['orderId', n.merchant_order_id],
    ['detail_category', n.detail_category], ['classificationSource', t(row.classification_source || 'unavailable')], ['line', row.row_number],
    ].map(([key, value]) => '<div><dt>' + h(t(key)) + '</dt><dd>' + h(value || '—') + '</dd></div>').join('')}</dl>
    <strong>${h(t('raw'))}</strong><pre>${h(JSON.stringify(row.raw || {}, null, 2))}</pre></td></tr>`;
  return html;
}
function rowMarkup(ctx, row, disabled) {
  const s = ctx.state.importData, t = key => importText(ctx, key), id = row.row_id, n = row.normalized || {};
  const editing = s.editor?.id === id, selected = s.choices.get(id)?.action === 'import';
  const importable = canImportRow(row, s.distinct.has(id), s.externalIncome.has(id));
  const editable = canEditImportRow(row) && editableImport(s.job);
  const trigger = (field, value, missing = false) => `<button type="button" class="import-cell-trigger${missing ? ' is-missing' : ''}" data-import-cell="${field}" data-import-id="${a(id)}"${locked(s) ? ' disabled' : ''}>${h(value)}</button>`;
  const category = [n.main_category, n.sub_category].filter(Boolean).join(' · ');
  const categoryCell = isIncomeRow(row) ? h(t('income')) : editable ? trigger('main_category', category || t('pickCategory'), missingClassification(row)) : h(category || '—');
  const time = String(n.isotime || '');
  return `<tr data-import-row="${a(id)}" class="${editing ? 'is-editing' : ''}">
    <td>${importable || selected ? `<input type="checkbox" data-import-select="${a(id)}" aria-label="${a(t('selectRow'))}"${selected ? ' checked' : ''}${disabled || rowDone(row) ? ' disabled' : ''}/>` : ''}</td>
    <td class="import-cell-isotime">${time ? `<time datetime="${a(time)}"><span>${h(time.slice(0, 10))}</span><small>${h(time.slice(11, 16))}</small></time>` : '—'}</td>
    <td class="import-cell-merchant">${editable ? trigger('shop_name', n.shop_name || '—') : `<strong>${h(n.shop_name || '—')}</strong>`}<small>${h(n.product_name || '')}</small></td>
    <td class="import-cell-price"${financeAttr((isIncomeRow(row) ? '' : '-') + n.price, 'amount')}>${h(amountText(row))}</td>
    <td class="import-cell-category">${categoryCell}</td>
    <td class="import-cell-note">${reasons(ctx, row)}</td>
    <td class="import-row-actions"><button type="button" class="text-button" data-import-details="${a(id)}" aria-expanded="${s.expanded.has(id)}">${h(t(s.expanded.has(id) ? 'hideDetails' : 'details'))}</button></td>
  </tr>${editing ? editorRow(ctx, row) : ''}${rowDetails(ctx, row)}`;
}
function table(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars);
  if (!reviewing(s.job) || !groupCounts(s.job)[activeGroup(s)]) return '';
  const disabled = locked(s), rows = visibleImportRows(s);
  // The header box picks every row ready to import (all pages, within the payment filter).
  const ready = s.payment === null ? groupCounts(s.job).ready : Number(s.job.payment_methods?.ready?.[s.payment] || 0);
  const all = activeGroup(s) === 'ready' ? `<input type="checkbox" data-import-select-all aria-label="${a(t('selectAll'))}"${ready && importSelection(s).imports >= ready ? ' checked' : ''}${disabled ? ' disabled' : ''}/>` : '';
  return `<div class="import-table-scroll" aria-busy="${s.rowsLoading}"><table class="import-table">
    <thead><tr><th aria-label="${a(t('selected'))}">${all}</th><th>${h(t('isotime'))}</th><th>${h(t('merchantProduct'))}</th><th>${h(t('price'))}</th><th>${h(t('category'))}</th><th>${h(t('note'))}</th><th><span class="sr-only">${h(t('actions'))}</span></th></tr></thead>
    <tbody>${rows.map(row => rowMarkup(ctx, row, disabled)).join('') || '<tr><td colspan="7" class="import-no-match">' + h(t(s.rowsLoading ? 'loading' : 'empty')) + '</td></tr>'}
    </tbody></table></div>
    <div class="import-table-end"><span>${h(t('showing', { shown: s.rows.length, total: s.total }))}</span>
    ${s.nextOffset !== null ? button('more', t(s.rowsLoading ? 'loading' : 'more'), Boolean(s.rowsLoading || s.editor || s.busy || s.pendingCommit)) : ''}</div>`;
}
// One clear action at the bottom: import everything ready, or the rows picked by hand.
function footer(ctx) {
  const s = ctx.state.importData, t = (key, vars) => importText(ctx, key, vars), selection = importSelection(s);
  if (!s.job && !s.pendingCommit) return '';
  if (s.pendingCommit) return `<div class="import-footer"><div><strong>${h(t('commitUncertain'))}</strong><p>${h(s.pendingCommit.key)}</p></div>${button('retry-commit', t(s.busy === 'committing' ? 'committing' : 'retryCommit'), Boolean(s.busy), true)}</div>`;
  if (!editableImport(s.job)) return '';
  const counts = groupCounts(s.job), account = accountName(ctx, s.job.account_number);
  if (!counts.ready && !selection.imports) return '';
  // "Import all" follows the payment filter of the ready list.
  const payment = activeGroup(s) === 'ready' ? s.payment : null;
  const ready = payment === null ? counts.ready : Number(s.job.payment_methods?.ready?.[payment] || 0);
  const allLabel = payment === null ? t('importAll', { count: ready }) : t('importAllPayment', { count: ready, payment: payment || t('noPayment') });
  if (s.confirming) return `<div class="import-footer is-confirming"><div><strong>${h(t('confirmImport', { count: selection.imports, account }))}</strong><p>${h(t('confirmImportHint'))}</p></div><div class="button-row">
    ${button('back-review', t('cancel'), Boolean(s.busy))}${button('commit', t(s.busy === 'committing' ? 'committing' : 'confirmCommit'), locked(s) || !selection.total, true)}</div></div>`;
  return `<div class="import-footer"><div><strong>${h(selection.imports ? t('selectedCount', { count: selection.imports }) : t('readyCount', { count: ready }))}</strong><p>${h(t('footerHint'))}</p></div><div class="button-row">
    ${selection.imports ? button('confirm', t('importSelected', { count: selection.imports }), locked(s), true) : button('import-all', allLabel, locked(s) || !ready, true)}</div></div>`;
}
export function importParts(ctx) {
  const s = ctx.state.importData;
  return {
    heading: `<header class="page-header"><div class="page-heading"><h1>${h(importText(ctx, 'page'))}</h1></div></header>`,
    setup: setup(ctx), stage: stage(ctx), alerts: notice(ctx, s.error, true) + notice(ctx, s.pollingError, true) + notice(ctx, s.notice) + (s.conflict ? notice(ctx, 'conflict') : ''),
    mapping: mapping(ctx), summary: summary(ctx), controls: controls(ctx), table: table(ctx), footer: footer(ctx),
  };
}
export function importView(ctx) {
  return `<section class="page import-page" data-import-page>
    <input type="file" data-import-file accept=".csv,.xlsx" hidden/>
    <input type="file" data-import-json-file accept=".json,application/json" hidden/>
    ${Object.entries(importParts(ctx)).map(([key, html]) => `<div data-import-part="${key}">${html}</div>`).join('')}
    </section>`;
}
