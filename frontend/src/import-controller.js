import { IMPORT_EDIT_FIELDS, editableImport, canEditImportRow, canImportRow, rowDone, selectImportRow,
  visibleImportRows, buildImportChoices, presetTemplate, parseImportPreset } from './import-model.js';
import { importParts, importText } from './import-view.js';
import { createImportService } from './import-service.js';

export function createImportController({ state, api, source, afterCommit, openIncome, context, document: doc = document }) {
  const cache = new WeakMap();
  let tableStamp = '', lastEditor = null, painting = false;
  const current = () => state.importData;
  const tx = key => importText(context(),key);
  const service = createImportService({ api, state, source, afterCommit, changed: paint });
  function paint() {
    const page = doc.querySelector('[data-import-page]');
    if (!page || state.route !== 'import' || painting) return;
    painting = true;
    try {
      const s = current(), active = doc.activeElement;
      const focusAttribute = ['data-import-field','data-import-form','data-import-query','data-import-preset-text'].find(attr=>active?.hasAttribute(attr));
      const focusKey = focusAttribute ? '[' + focusAttribute + '="' + CSS.escape(active.getAttribute(focusAttribute)) + '"]' : null;
      const selection = active?.selectionStart != null ? [active.selectionStart,active.selectionEnd] : null;
      const scroll = page.querySelector('.import-table-scroll'), position = scroll ? [scroll.scrollTop,scroll.scrollLeft] : null;
      const presetScroll = page.querySelector('[data-import-preset-text]')?.scrollTop;
      const stamp = JSON.stringify([context().language,s.busy,s.pendingCommit?.key,s.rowsRevision,s.rowsLoading,s.editor?.error,s.editor?.conflict,s.expanded.size]);
      for (const [key,html] of Object.entries(importParts(context()))) {
        const node = page.querySelector('[data-import-part="' + key + '"]');
        if (!node) continue;
        // Keep the actual input nodes while a user types, including during status polling.
        if (key === 'table' && s.editor && lastEditor === s.editor && stamp === tableStamp && node.querySelector('[data-import-field]')) continue;
        if (cache.get(node) !== html) { node.innerHTML = html; cache.set(node,html); }
      }
      lastEditor = s.editor; tableStamp = stamp;
      const restored = page.querySelector('.import-table-scroll');
      if (position && restored) { restored.scrollTop = position[0]; restored.scrollLeft = position[1]; }
      const preset = page.querySelector('[data-import-preset-text]');
      if (preset && presetScroll != null) preset.scrollTop = presetScroll;
      if (focusKey && !page.contains(active)) {
        const target = page.querySelector(focusKey); target?.focus({preventScroll:true});
        if (selection && target?.setSelectionRange) { try { target.setSelectionRange(...selection); } catch {} }
      }
    } finally { painting = false; }
  }
  function error(message) { current().error = message; paint(); }
  function beginEdit(id,field) {
    const s = current(), row = s.rowCache.get(id);
    if (!IMPORT_EDIT_FIELDS.includes(field) || !row || !editableImport(s.job) || !canEditImportRow(row) || s.busy || s.pendingCommit || s.rowsLoading) return;
    if (s.editor && s.editor.id !== id) { error('finishEditing'); return; }
    s.confirming = false;
    if (!s.editor) s.editor = { id, draft:Object.fromEntries(IMPORT_EDIT_FIELDS.map(key=>[key,String(row.normalized[key] ?? '')])),error:'',latest:row.normalized };
    paint();
    const input = doc.querySelector('[data-import-field="' + field + '"]');
    input?.focus({preventScroll:true}); input?.select();
  }
  function acceptFiles(files) {
    const s = current();
    if (files.length !== 1) return error('singleFile');
    if (s.editor) return error('finishEditing');
    if (s.busy || s.pendingCommit) return;
    if (s.job && !window.confirm(tx('confirmReplace'))) return;
    service.newFile(files[0]);
  }
  function download(preset) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(preset,null,2)],{type:'application/json;charset=utf-8'}));
    const link = doc.createElement('a'); link.href = url; link.download = preset.preset_id + '.json'; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  doc.addEventListener('click',async event=>{
    const target = event.target.closest?.('[data-import-page] button');
    if (!target || target.disabled) return;
    const s = current(), action = target.dataset.importAction;
    if (target.dataset.importIncome) {
      const row = s.rowCache.get(target.dataset.importIncome);
      if (row?.income_id != null) {
        target.disabled = true;
        try { await openIncome(row.income_id, row.normalized); }
        catch (e) { error(e.message); }
        finally { target.disabled = false; }
      }
      return;
    }
    if (target.dataset.importCell) return beginEdit(target.dataset.importId,target.dataset.importCell);
    if (target.dataset.importDetails) {
      const id = target.dataset.importDetails;
      s.expanded.has(id) ? s.expanded.delete(id) : s.expanded.add(id); paint(); return;
    }
    if (target.dataset.importGroup) {
      s.filter = 'group:' + target.dataset.importGroup; s.rows = []; s.query = ''; s.payment = null; s.confirming = false; paint();
      return void service.loadRows();
    }
    if (action === 'select-all-ready') return void service.selectGroup('ready');
    if (action === 'import-all') return void (async () => {
      if (!await service.selectGroup('ready')) return;
      try { buildImportChoices(s); s.confirming = true; s.error = ''; } catch (e) { s.error = e.message; }
      paint();
    })();
    if (action === 'switch-account') return void service.switchAccount(target.dataset.account);
    if (action === 'choose') return doc.querySelector('[data-import-file]').click();
    if (action === 'upload') return void service.upload();
    if (action === 'setup') return void service.setup(true);
    if (action === 'refresh') return void service.poll(true);
    if (action === 'more') return void service.loadRows(true);
    if (action === 'save-row') return void service.saveEditor();
    if (action === 'cancel-edit') { s.editor = null; s.error = ''; paint(); return; }
    if (action === 'presets') {
      s.presetOpen = !s.presetOpen;
      if (!s.presetText) s.presetText = JSON.stringify(presetTemplate(),null,2);
      paint(); return;
    }
    if (action === 'load-json') return doc.querySelector('[data-import-json-file]').click();
    if (action === 'download') {
      try { download(parseImportPreset(s.presetText)); } catch (e) { error(e.message); } return;
    }
    if (action === 'save-preset' || action === 'map') return void service.savePreset(action === 'map');
    if (action === 'clear-selection') { s.choices.clear(); s.confirming = false; paint(); return; }
    if (action === 'select-new' || action === 'skip-visible') {
      for (const row of visibleImportRows(s)) {
        if (rowDone(row)) continue;
        if (action === 'skip-visible') selectImportRow(s,row,'skip');
        else if (canImportRow(row,s.distinct.has(row.row_id),s.externalIncome.has(row.row_id))) selectImportRow(s,row,'import');
      }
      paint(); return;
    }
    if (action === 'confirm') {
      try { buildImportChoices(s); s.confirming = true; s.error = ''; } catch (e) { s.error = e.message; }
      paint(); return;
    }
    if (action === 'back-review') { s.confirming = false; paint(); return; }
    if (action === 'commit' && s.confirming) return void service.commit();
    if (action === 'retry-commit') return void service.commit(true);
  });
  doc.addEventListener('input',event=>{
    const target = event.target;
    if (!target.closest?.('[data-import-page]')) return;
    const s = current();
    if (target.hasAttribute('data-import-field') && s.editor) s.editor.draft[target.dataset.importField] = target.value;
    if (target.hasAttribute('data-import-form') && target.type !== 'checkbox') s.form[target.dataset.importForm] = target.value;
    if (target.hasAttribute('data-import-query')) { s.query = target.value; paint(); }
    if (target.hasAttribute('data-import-preset-text')) { s.presetText = target.value; s.presetDirty = true; }
  });
  doc.addEventListener('change',async event=>{
    const target = event.target;
    if (!target.closest?.('[data-import-page]')) return;
    const s = current();
    if (target.hasAttribute('data-import-file')) { acceptFiles([...target.files]); target.value = ''; return; }
    if (target.hasAttribute('data-import-json-file')) {
      const file = target.files[0]; target.value = '';
      try {
        if (!file) return;
        if (file.size > 131072) throw new Error('presetTooLarge');
        const text = await file.text(); parseImportPreset(text);
        if (s !== current()) return;
        s.presetText = text; s.presetDirty = true; paint();
      } catch(e) { error(e.message); }
      return;
    }
    if (target.hasAttribute('data-import-form')) {
      const field = target.dataset.importForm;
      s.form[field] = target.type === 'checkbox' ? target.checked : target.value;
      if (field === 'preset_id') await service.selectPreset(target.value);
      paint(); return;
    }
    if (target.hasAttribute('data-import-preset-load')) { s.presetDirty = false; await service.selectPreset(target.value); return; }
    if (target.hasAttribute('data-import-save-preset')) { s.savePreset = target.checked; return; }
    if (target.hasAttribute('data-import-select-all')) {
      if (target.checked) await service.selectGroup('ready');
      else { s.choices.clear(); s.confirming = false; }
      paint(); return;
    }
    if (target.hasAttribute('data-import-payment')) { s.payment = target.value === '*' ? null : target.value; s.rows = []; s.query = ''; s.choices.clear(); s.confirming = false; await service.loadRows(); return; }
    if (target.hasAttribute('data-import-filter')) { s.filter = target.value; s.rows = []; s.query = ''; s.confirming = false; await service.loadRows(); return; }
    if (target.hasAttribute('data-import-distinct')) {
      const id = target.dataset.importDistinct;
      if (target.checked) s.distinct.add(id);
      else { s.distinct.delete(id); if (s.choices.get(id)?.action === 'import') s.choices.delete(id); }
      s.confirming = false; paint(); return;
    }
    if (target.hasAttribute('data-import-external-income')) {
      const id = target.dataset.importExternalIncome;
      if (target.checked) s.externalIncome.add(id);
      else { s.externalIncome.delete(id); if (s.choices.get(id)?.action === 'import') s.choices.delete(id); }
      s.confirming = false; paint(); return;
    }
    if (target.hasAttribute('data-import-select')) {
      const row = s.rowCache.get(target.dataset.importSelect);
      // A tick means "import this row"; rows left unticked are simply not imported.
      selectImportRow(s,row,target.checked && canImportRow(row,s.distinct.has(row.row_id),s.externalIncome.has(row.row_id)) ? 'import' : '');
      paint(); return;
    }
    if (target.hasAttribute('data-import-decision')) { selectImportRow(s,s.rowCache.get(target.dataset.importDecision),target.value); paint(); }
  });
  doc.addEventListener('keydown',event=>{
    if (!event.target.matches?.('[data-import-field]') || event.isComposing) return;
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault(); doc.querySelector('[data-import-action="' + (event.key === 'Enter' ? 'save-row' : 'cancel-edit') + '"]')?.click();
    }
  });
  doc.addEventListener('dragover',event=>{
    if (state.route !== 'import' || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); const zone = event.target.closest?.('[data-import-drop]');
    event.dataTransfer.dropEffect = zone ? 'copy' : 'none'; zone?.classList.add('is-dragging');
  });
  doc.addEventListener('dragleave',event=>{
    const zone = event.target.closest?.('[data-import-drop]');
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
  });
  doc.addEventListener('drop',event=>{
    if (state.route !== 'import') return;
    event.preventDefault(); doc.querySelector('[data-import-drop]')?.classList.remove('is-dragging');
    if (event.target.closest?.('[data-import-drop]')) acceptFiles([...event.dataTransfer.files]);
  });
  doc.addEventListener('visibilitychange',()=>service.syncActive());
  // Repaints must not fold "Advanced" back up while the user works in it.
  doc.addEventListener('toggle',event=>{ if (event.target.matches?.('[data-import-advanced]')) current().advancedOpen = event.target.open; },true);
  return {
    patch:()=>{ service.syncActive(); return state.route === 'import' && Boolean(doc.querySelector('[data-import-page]')); },
    mount:()=>{ service.syncActive(); paint(); },
    relocalize:paint,
  };
}
