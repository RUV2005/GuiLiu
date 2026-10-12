import { escapeHtml as h, escapeAttr as a } from './utils.js';
import { accountOptions } from './assets-view.js';
import { financeAttr } from './finance-colors.js';
import { IMPORT_FIELDS, IMPORT_EDIT_FIELDS, IMPORT_STATUSES, editableImport, processingImport, rowStatus, rowDone,
  missingClassification, canImportRow, canEditImportRow, currencyLabel, importSelection, visibleImportRows, isIncomeRow, needsIncomeConfirmation } from './import-model.js';

export const importFieldKey = field => 'import' + field[0].toUpperCase() + field.slice(1);
export const importText = (ctx, key, vars) => {
  const value = ctx.t(importFieldKey(key), vars);
  return value === importFieldKey(key) ? key : value;
};
const button = (action, label, disabled = false, primary = false, describedBy = '') =>
  `<button type="button" class="button${primary ? ' primary' : ''}" data-import-action="${a(action)}"${disabled ? ' disabled' : ''}${describedBy ? ' aria-describedby="' + a(describedBy) + '"' : ''}>${h(label)}</button>`;
const opts = (values, selected) => values.map(([value, label]) =>
  `<option value="${a(value)}"${String(value) === String(selected) ? ' selected' : ''}>${h(label)}</option>`).join('');
const textValue = value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
const fieldValue = (row, field) => field === 'price' ? (isIncomeRow(row) ? '+' : '-') + String(row.normalized?.price ?? '') + ' ' + currencyLabel(row.normalized?.CurrencyTypeNumber) : row.normalized?.[field] ?? '';
const locked = s => Boolean(s.busy || s.pendingCommit || s.editor || s.rowsLoading || !editableImport(s.job) || s.rowsRevision !== s.job?.revision);
const notice = (ctx, value, error = false) => value ? `<p class="import-notice${error ? ' is-error' : ''}" role="${error ? 'alert' : 'status'}">${h(importText(ctx, value))}</p>` : '';

function setup(ctx) {
  const s = ctx.state.importData, t = key => importText(ctx, key);
  if (s.job || s.resumeId) return '';
  const disabled = Boolean(s.busy || s.setupLoading), attr = disabled ? ' disabled' : '';
  const needsAccount = Boolean(s.file && !s.form.account_number && s.setupLoaded && !s.setupError && !disabled);
  return `<div class="import-map-grid import-upload-form">
    <label>${h(t('source'))}<select data-import-form="preset_id"${attr}>${opts([['', t('auto')], ...s.presets.map(p => [p.preset_id, p.name || p.preset_id])], s.form.preset_id)}</select></label>
    <label>${h(t('account'))}<select data-import-form="account_number"${attr}>${opts([['', t('chooseAccount')]], s.form.account_number)}${accountOptions(ctx, s.form.account_number, s.accounts)}</select></label>
    <label>${h(t('timezone'))}<input data-import-form="timezone" value="${a(s.form.timezone)}"${attr}/></label>
    <label>${h(t('defaultCurrency'))}<select data-import-form="default_currency"${attr}>${opts([['CNY','CNY'],['JPY','JPY']], s.form.default_currency)}</select></label>
    <label>${h(t('sheet'))}<input data-import-form="sheet_name" value="${a(s.form.sheet_name)}"${attr}/></label>
    </div>
    <label class="import-check"><input type="checkbox" data-import-form="use_agent"${s.form.use_agent ? ' checked' : ''}${attr}/><span>${h(t('useAgent'))}</span></label>
    <p class="import-privacy">${h(t('disclosure'))}</p>
    <p class="import-privacy">${h(t('builtinCurrency'))}</p>
    ${s.setupLoading ? notice(ctx, 'loading') : ''}
    ${s.setupError ? notice(ctx, s.setupError, true) + button('setup', t('retrySetup'), disabled) : ''}
    ${s.setupLoaded && !s.accounts.length ? notice(ctx, 'noAccounts') : ''}
    <div class="import-drop ${s.file ? 'has-file' : ''}" data-import-drop>
      <div class="import-file-mark"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg></div>
      <div class="import-file-copy"><h2>${h(s.file?.name || t('drop'))}</h2><p>${h(t('formats'))}</p></div>
      ${button('choose', t(s.file ? 'replace' : 'choose'), disabled)}
    </div>
    <div class="import-upload-actions"><p class="import-privacy">${h(t('previewOnly'))}</p><div class="import-upload-submit">
      <p id="import-account-hint" class="import-upload-hint" role="status"${needsAccount ? '' : ' hidden'}>${needsAccount ? h(t('chooseAccountFirst')) : ''}</p>
      ${button('upload', t(s.busy || 'upload'), !s.file || !s.form.account_number || !s.setupLoaded || disabled, true, needsAccount ? 'import-account-hint' : '')}</div></div>`;
}
// Analysis reports merchant/product pairs classified so far; other processing states have no measurable progress.
function progressBar(ctx, job) {
  const p = job.state === 'analyzing' && job.progress?.total > 0 ? job.progress : null;
  if (!p) return '<progress aria-label="' + a(importText(ctx, job.state)) + '"></progress>';
  const label = importText(ctx, 'classifyingProgress', { done: p.done, total: p.total });
  return `<div class="import-progress"><progress value="${a(p.done)}" max="${a(p.total)}" aria-label="${a(label)}"></progress><span>${h(label)}</span></div>`;
}
function stage(ctx) {
  const s = ctx.state.importData, t = key => importText(ctx, key), job = s.job;
  if (!job) return s.resumeId ? notice(ctx, 'loading') + button('refresh', t('refresh'), Boolean(s.busy)) + button('choose', t('replace'), Boolean(s.busy || s.pendingCommit)) : '';
  return `<div class="import-job">
    <div><h2>${h(job.filename)}</h2><p>#${h(job.account_number)} · ${h(job.import_id)} · ${h(t('revision'))} ${job.revision}</p></div>
    <div class="button-row"><span class="import-job-state" role="status">${h(t(job.state))}</span>${button('refresh', t('refresh'), Boolean(s.busy))}${button('choose', t('replace'), Boolean(s.busy || s.pendingCommit || s.editor))}</div>
    ${processingImport(job.state) ? progressBar(ctx, job) : ''}
    </div>
    ${notice(ctx, job.error, true)}
    ${(job.warnings || []).map(item => notice(ctx, textValue(item))).join('')}`;
}
function mapping(ctx) {
  const s = ctx.state.importData, t = key => importText(ctx, key);
  if (!s.presetOpen && s.job?.state !== 'mapping_required') return '';
  const isMapping = s.job?.state === 'mapping_required', disabled = Boolean(s.busy || s.pendingCommit || s.editor);
  return `<section class="import-preset"><h2>${h(t(isMapping ? 'mapping' : 'presets'))}</h2>
    ${isMapping && s.job.header_samples?.length ? `<h3>${h(t('samples'))}</h3><div class="import-samples">${s.job.header_samples.map(sample =>
      `<div><span>${h(sample.sheet)} · #${h(sample.row_number)}</span><p>${(sample.cells || []).map(cell => '<code>' + h(cell) + '</code>').join(' ')}</p></div>`).join('')}</div>` : ''}
    <p class="import-privacy">${h(t('mappingHint'))}</p>
    <div class="import-preset-tools">${!isMapping ? `<select data-import-preset-load aria-label="${a(t('preset'))}"${disabled ? ' disabled' : ''}>${opts([['',t('preset')], ...s.presets.map(p=>[p.preset_id,p.name || p.preset_id])], s.form.preset_id)}</select>` : ''}
      ${button('load-json', t('loadJson'), disabled)}${button('download', t('download'), !s.presetText || Boolean(s.busy))}</div>
    <textarea data-import-preset-text aria-label="${a(t('presets'))}" spellcheck="false"${disabled ? ' disabled' : ''}>${h(s.presetText)}</textarea>
    <div class="import-map-actions">
    ${isMapping ? `<label class="import-check"><input type="checkbox" data-import-save-preset${s.savePreset ? ' checked' : ''}${disabled ? ' disabled' : ''}/>${h(t('saveForLater'))}</label>` : ''}
    ${button(isMapping ? 'map' : 'save-preset', t(s.busy === 'mapping' ? 'parsing' : isMapping ? 'applyMapping' : 'savePreset'), disabled, true)}</div></section>`;
}
function summary(ctx) {
  const s = ctx.state.importData, t = key => importText(ctx, key);
  if (!s.job) return '';
  const c = s.job.classification, sources = c && !processingImport(s.job.state) && c.memory + c.model + c.user + c.open > 0
    ? `<p class="import-classified${c.open ? ' has-open' : ''}" role="status">${h(importText(ctx, 'classifiedSummary', c))}</p>` : '';
  return `<div class="import-metrics">${[['total',s.job.total],['selected',s.choices.size],['imported',s.job.counts?.imported || 0],['skipped',s.job.counts?.skipped || 0]].map(([key,value]) =>
    `<div><span>${h(t(key))}</span><strong>${h(value)}</strong></div>`).join('')}</div>${sources}`;
}
function controls(ctx) {
  const s = ctx.state.importData, t = key => importText(ctx, key);
  if (!s.job || processingImport(s.job.state) || s.job.state === 'mapping_required') return '';
  const disabled = Boolean(s.editor || s.busy || s.pendingCommit);
  return `<div class="import-toolbar"><div class="import-tools">
    <select data-import-filter aria-label="${a(t('status'))}"${disabled ? ' disabled' : ''}>${opts([['',t('all')],['unclassified',t('unclassified') + ' (' + (s.job.classification?.open || 0) + ')'],...IMPORT_STATUSES.map(value=>[value,t(value) + ' (' + (s.job.counts?.[value] || 0) + ')'])],s.filter)}</select>
    <input type="search" data-import-query value="${a(s.query)}" placeholder="${a(t('search'))}" aria-label="${a(t('search'))}"${disabled ? ' disabled' : ''}/></div>
    <div class="button-row">${button('select-new',t('selectNew'),locked(s))}${button('skip-visible',t('skipVisible'),locked(s))}${button('clear-selection',t('clearSelection'),locked(s) || !s.choices.size)}</div></div>`;
}
function cells(ctx, row) {
  const s = ctx.state.importData, editing = s.editor?.id === row.row_id;
  return IMPORT_FIELDS.map(field => {
    const allowed = IMPORT_EDIT_FIELDS.includes(field) && canEditImportRow(row) && editableImport(s.job);
    const value = fieldValue(row, field), label = importText(ctx, field);
    let html = field === 'isotime' && value ? '<time datetime="' + a(value) + '">' + String(value).split('T').map(part=>'<span>' + h(part) + '</span>').join('') + '</time>' : h(value || '—');
    if (editing && allowed) html = `<input data-import-field="${field}" aria-label="${a(label)}" value="${a(s.editor.draft[field])}" maxlength="300"${s.busy || s.pendingCommit ? ' disabled' : ''}/>`;
    else if (allowed) html = `<button type="button" class="import-cell-trigger" data-import-cell="${field}" data-import-id="${a(row.row_id)}"${locked(s) ? ' disabled' : ''}>${h(value || '—')}</button>`;
    return `<td class="import-cell-${field}"${field === 'price' ? financeAttr((isIncomeRow(row) ? '' : '-') + row.normalized.price, 'amount') : ''}>${html}</td>`;
  }).join('');
}
function rowDetails(ctx, row) {
  const s = ctx.state.importData, t = key => importText(ctx, key), n = row.normalized || {}, id = row.row_id;
  const candidates = row.duplicate_candidates || [], showMatches = ['suspected_duplicate','duplicate'].includes(row.status) || candidates.length > 0;
  const details = s.expanded.has(id), editor = s.editor?.id === id ? s.editor : null;
  let html = '';
  if (editor?.error || editor?.conflict) html += `<tr class="import-edit-error"><td colspan="11">${notice(ctx,editor.error,true)}${editor.conflict ? '<strong>' + h(t('latest')) + '</strong><p>' + IMPORT_EDIT_FIELDS.map(field => h(t(field)) + ': ' + h(editor.latest?.[field] ?? n[field])).join(' · ') + '</p>' : ''}</td></tr>`;
  if (showMatches) html += `<tr class="import-match-row"><td></td><td colspan="10"><div class="import-candidates">
    <strong>${h(t('candidates'))}</strong>
    ${candidates.map(candidate=>`<div class="import-candidate"><span>${h(t(candidate.income_id != null ? 'incomeMatch' : candidate.DealingNumber != null ? 'ledgerMatch' : 'fileMatch'))} #${h(candidate.income_id ?? candidate.DealingNumber ?? candidate.row_id ?? '')}</span>
      <strong>${h(candidate.shop_name ?? '')}</strong><span>${h(candidate.price ?? '')} ${h(currencyLabel(candidate.CurrencyTypeNumber ?? n.CurrencyTypeNumber))}</span>
      <span>${h(candidate.time ?? '')}</span><span>${h(candidate.product_name ?? '')}</span>
      <p>${h(t('reason'))}: ${(candidate.reasons || []).map(reason=>h(t(reason))).join(' · ')}</p></div>`).join('')}
    ${row.status === 'suspected_duplicate' && !rowDone(row) ? `<label class="import-check"><input type="checkbox" data-import-distinct="${a(id)}"${s.distinct.has(id) ? ' checked' : ''}${locked(s) ? ' disabled' : ''}/>${h(t(isIncomeRow(row) ? 'distinctIncome' : 'distinct'))}</label>` : ''}
    </div></td></tr>`;
  if (needsIncomeConfirmation(row) && !rowDone(row)) html += `<tr class="import-match-row"><td></td><td colspan="10"><label class="import-check"><input type="checkbox" data-import-external-income="${a(id)}"${s.externalIncome.has(id) ? ' checked' : ''}${locked(s) ? ' disabled' : ''}/>${h(t('externalIncome'))}</label></td></tr>`;
  if (row.commit_error) html += `<tr class="import-edit-error"><td colspan="11">${h(row.commit_error)}</td></tr>`;
  if (row.DealingNumber != null || row.income_id != null || row.balance_sync != null) html += `<tr class="import-result-row"><td></td><td colspan="10">${row.income_id != null ? '<button type="button" class="text-button" data-import-income="' + a(id) + '">' + h(t('incomeMatch')) + ' #' + h(row.income_id) + '</button>' : row.DealingNumber != null ? '<button type="button" class="text-button" data-assets-deal="' + a(row.DealingNumber) + '">' + h(t('ledgerMatch')) + ' #' + h(row.DealingNumber) + '</button>' : ''} ${row.balance_sync != null ? '<span>' + h(t('balance')) + ': ' + h(t(row.balance_sync.status || 'unavailable')) + (row.balance_sync.reason ? ' · ' + h(row.balance_sync.reason) : '') + '</span>' : ''}</td></tr>`;
  if (details) html += `<tr class="import-details-row"><td></td><td colspan="10"><dl>${[
    ['account',n.AccountNumber],['payment',n.payment_method],['transactionId',n.transaction_id],['orderId',n.merchant_order_id],
    ['classificationSource',t(row.classification_source || 'unavailable')],
    ].map(([key,value])=>'<div><dt>' + h(t(key)) + '</dt><dd>' + h(value ?? '—') + '</dd></div>').join('')}</dl>
    <strong>${h(t('raw'))}</strong><pre>${h(JSON.stringify(row.raw || {}, null, 2))}</pre></td></tr>`;
  return html;
}
function table(ctx) {
  const s = ctx.state.importData, t = (key,vars) => importText(ctx,key,vars);
  if (!s.job || processingImport(s.job.state) || s.job.state === 'mapping_required') return '';
  const disabled = locked(s), rows = visibleImportRows(s);
  return `<div class="import-table-scroll" aria-busy="${s.rowsLoading}"><table class="import-table">
    <thead><tr><th aria-label="${a(t('selected'))}"></th><th>#</th>${IMPORT_FIELDS.map(field=>'<th>' + h(t(field)) + '</th>').join('')}<th>${h(t('status'))}</th><th>${h(t('actions'))}</th></tr></thead>
    <tbody>${rows.map(row=>{
      const id = row.row_id, selected = s.choices.get(id), editing = s.editor?.id === id, done = rowDone(row);
      const status = !row.commit_status && row.status === 'new' && missingClassification(row) ? 'classification_required' : rowStatus(row), canImport = canImportRow(row,s.distinct.has(id),s.externalIncome.has(id));
      return `<tr data-import-row="${a(id)}" class="${editing ? 'is-editing' : ''}">
        <td><input type="checkbox" data-import-select="${a(id)}" aria-label="${a(t('selectRow'))}"${selected ? ' checked' : ''}${disabled || done ? ' disabled' : ''}/></td>
        <td class="import-line">${h(row.row_number ?? id)}<small>${h(t(isIncomeRow(row) ? 'income' : 'expense'))}</small></td>${cells(ctx,row)}
        <td><span class="import-row-state ${['invalid','failed'].includes(status) ? 'has-error' : ['suspected_duplicate','needs_review'].includes(status) ? 'needs-review' : ''}">${h(t(status))}</span>
          ${missingClassification(row) && !done && status !== 'classification_required' ? '<p class="import-row-state needs-review">' + h(t('classification_required')) + '</p>' : ''}
          ${(row.issues || []).filter(issue=>issue!=='classification_required' && issue!=='confirm_external_income_required').map(issue=>'<p class="import-row-state">' + h(t(textValue(issue))) + '</p>').join('')}
        </td>
        <td class="import-row-actions">${editing ? button('save-row',t(s.busy === 'saving' ? 'saving' : 'save'),Boolean(s.busy || s.pendingCommit || s.rowsLoading)) + button('cancel-edit',t('cancel'),Boolean(s.busy)) : `
          ${!done ? `<select data-import-decision="${a(id)}" aria-label="${a(t('actions'))}"${disabled ? ' disabled' : ''}>
            ${opts([['',t('unselected')],...(canImport ? [['import',t('keep')]] : []),['skip',t('skip')]],selected?.action || '')}</select>` : ''}
          <button type="button" class="button" data-import-details="${a(id)}" aria-expanded="${s.expanded.has(id)}">${h(t('details'))}</button>`}
        </td></tr>${rowDetails(ctx,row)}`;
    }).join('') || '<tr><td colspan="11" class="import-no-match">' + h(t(s.rowsLoading ? 'loading' : 'empty')) + '</td></tr>'}
    </tbody></table></div>
    <div class="import-table-end"><span>${h(t('showing',{shown:s.rows.length,total:s.total}))}</span>
    ${s.nextOffset !== null ? button('more',t(s.rowsLoading ? 'loading' : 'more'),Boolean(s.rowsLoading || s.editor || s.busy || s.pendingCommit)) : ''}</div>`;
}
function footer(ctx) {
  const s = ctx.state.importData, t = (key,vars)=>importText(ctx,key,vars), selection = importSelection(s);
  if (!s.job && !s.pendingCommit) return '';
  if (s.pendingCommit) return `<div class="import-footer"><div><strong>${h(t('commitUncertain'))}</strong><p>${h(s.pendingCommit.key)}</p></div>${button('retry-commit',t(s.busy === 'committing' ? 'committing' : 'retryCommit'),Boolean(s.busy),true)}</div>`;
  if (!editableImport(s.job)) return '';
  return `<div class="import-footer"><div><strong>${h(t('selectionSummary',selection))}</strong><p>${h(t('commitHint'))}</p></div><div class="button-row">
    ${s.confirming ? button('back-review',t('cancel')) + button('commit',t('confirmCommit'),locked(s) || !selection.total,true) : button('confirm',t('reviewSelection'),locked(s) || !selection.total,true)}</div></div>`;
}
export function importParts(ctx) {
  const s = ctx.state.importData;
  return {
    heading: `<header class="page-header"><div class="page-heading"><h1>${h(importText(ctx,'page'))}</h1></div><div class="page-actions">${button('presets',importText(ctx,'presets'),Boolean(s.busy || s.pendingCommit || s.editor))}</div></header>`,
    setup: setup(ctx), stage: stage(ctx), alerts: notice(ctx,s.error,true) + notice(ctx,s.pollingError,true) + notice(ctx,s.notice) + (s.conflict ? notice(ctx,'conflict') : ''),
    mapping: mapping(ctx), summary: summary(ctx), controls: controls(ctx), table: table(ctx), footer: footer(ctx),
  };
}
export function importView(ctx) {
  return `<section class="page import-page" data-import-page>
    <input type="file" data-import-file accept=".csv,.xlsx" hidden/>
    <input type="file" data-import-json-file accept=".json,application/json" hidden/>
    ${Object.entries(importParts(ctx)).map(([key,html])=>`<div data-import-part="${key}">${html}</div>`).join('')}
    </section>`;
}
