import { IMPORT_EDIT_FIELDS, IMPORT_FACETS, IMPORT_SHOWN_STEP, editableImport, canEditImportRow, selectImportRow,
  presetTemplate, parseImportPreset, defaultImportFilter, filteredRows, importableRow, selectedRows } from './import-model.js';
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
      const focusAttribute = ['data-import-field','data-import-form','data-import-query','data-import-date','data-import-preset-text'].find(attr=>active?.hasAttribute(attr));
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
    // A chip keeps or drops one value of a facet; for payment methods and file types "all" is the starting point.
    if (target.dataset.importChip) {
      const facet = target.dataset.importChip, value = target.dataset.value, f = s.importFilter;
      if (!f[facet]) f[facet] = new Set(s.rows.map(IMPORT_FACETS[facet]));
      f[facet].has(value) ? f[facet].delete(value) : f[facet].add(value);
      if (['payments', 'types'].includes(facet) && f[facet].size === new Set(s.rows.map(IMPORT_FACETS[facet])).size) f[facet] = null;
      s.shown = IMPORT_SHOWN_STEP; s.notice = ''; paint(); return;
    }
    if (target.dataset.importChipAll) { s.importFilter[target.dataset.importChipAll] = null; s.shown = IMPORT_SHOWN_STEP; paint(); return; }
    if (action === 'reset-filters') { s.importFilter = defaultImportFilter(); s.shown = IMPORT_SHOWN_STEP; paint(); return; }
    if (action === 'show-more') { s.shown += IMPORT_SHOWN_STEP; paint(); return; }
    // The ticked rows the filters show are imported as they are; nothing else is asked.
    if (action === 'import-selected') return void (async () => {
      const rows = selectedRows(s);
      if (!rows.length || s.busy || s.editor) return;
      s.choices.clear();
      for (const row of rows) selectImportRow(s, row, 'import');
      if (await service.commit()) { s.notice = 'importedRows'; s.noticeVars = { count: rows.length }; s.unchecked.clear(); }
      paint();
    })();
    if (action === 'switch-account') return void service.switchAccount(target.dataset.account);
    if (action === 'choose') return doc.querySelector('[data-import-file]').click();
    if (action === 'upload') return void service.upload();
    if (action === 'setup') return void service.setup(true);
    if (action === 'refresh') return void service.poll(true);
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
    if (action === 'retry-commit') return void service.commit(true);
  });
  doc.addEventListener('input',event=>{
    const target = event.target;
    if (!target.closest?.('[data-import-page]')) return;
    const s = current();
    if (target.hasAttribute('data-import-field') && s.editor) s.editor.draft[target.dataset.importField] = target.value;
    if (target.hasAttribute('data-import-form') && target.type !== 'checkbox') s.form[target.dataset.importForm] = target.value;
    if (target.hasAttribute('data-import-query')) { s.importFilter.query = target.value; s.shown = IMPORT_SHOWN_STEP; paint(); }
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
    if (target.hasAttribute('data-import-date')) { s.importFilter[target.dataset.importDate] = target.value; s.shown = IMPORT_SHOWN_STEP; paint(); return; }
    // The header box ticks or unticks every importable row the filters show.
    if (target.hasAttribute('data-import-select-all')) {
      for (const row of filteredRows(s)) if (importableRow(s, row)) target.checked ? s.unchecked.delete(row.row_id) : s.unchecked.add(row.row_id);
      paint(); return;
    }
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
    // Rows are ticked by default; an untick keeps that one row out of the import.
    if (target.hasAttribute('data-import-select')) {
      const id = target.dataset.importSelect;
      target.checked ? s.unchecked.delete(id) : s.unchecked.add(id);
      paint(); return;
    }
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
