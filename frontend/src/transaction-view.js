import {
  sortIndicator, transactionAdrView, transactionEmptyRow, transactionFilters,
  transactionRows, transactionSelection, transactionStructure,
} from './views.js';
import { formatJpy } from './utils.js';
import { createTransactionScroller } from './transaction-scroller.js';
import { patchDisclosure } from './ui-motion.js';
import { transactionCategoryIconName, categoryIconStyle, categoryIconButtonLabel, categoryIconPickerState, categoryIconText,
  categoryIconTone, transactionCategoryIconTone, categoryIconLabel } from './category-icons.js';

const rowVersions = new WeakMap();
const regionVersions = new WeakMap();
let scroller;

function setHtml(node, html) {
  if (node && regionVersions.get(node) !== html) {
    node.innerHTML = html;
    regionVersions.set(node, html);
  }
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function patchCategoryIcon(ctx, deal, row) {
  const button = row.querySelector('[data-pick-category-icon]');
  if (!button) return;
  const name = transactionCategoryIconName(deal, ctx.state.categoryIcons);
  const tone = transactionCategoryIconTone(deal, ctx.state.categoryIcons);
  if (button.dataset.categoryTone !== tone) button.dataset.categoryTone = tone;
  if (button.dataset.categoryIcon !== name) {
    button.dataset.categoryIcon = name;
    button.style.setProperty('--merchant-icon', categoryIconStyle(name));
  }
  const label = categoryIconButtonLabel(deal, ctx.language);
  if (button.getAttribute('aria-label') !== label) {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

export function patchTransactionCategoryIcons(ctx) {
  const byId = new Map(ctx.state.deals.map((deal) => [String(deal.DealingNumber), deal]));
  for (const row of document.querySelectorAll('[data-ledger-body] [data-deal-row], [data-today-transactions] [data-deal-row]')) {
    const deal = byId.get(row.dataset.dealRow);
    if (deal) patchCategoryIcon(ctx, deal, row);
  }
}

export function patchCategoryIconPicker(root, deal, preferences, language, syncCategory, draft = null) {
  if (!root) return;
  const picker = categoryIconPickerState(deal, preferences, syncCategory, draft);
  const scope = picker.syncCategory ? 'category' : 'transaction';
  const control = root.querySelector('[data-category-icon-scope-control]');
  if (control && control.dataset.scope !== scope) control.dataset.scope = scope;
  for (const button of root.querySelectorAll('[data-category-icon-scope]')) {
    const selected = button.dataset.categoryIconScope === scope;
    button.disabled = button.dataset.categoryIconScope === 'category' && !picker.canSync;
    button.tabIndex = selected ? 0 : -1;
    if (button.getAttribute('aria-checked') !== String(selected)) button.setAttribute('aria-checked', String(selected));
  }
  setText(root.querySelector('[data-category-icon-scope-label]'), categoryIconText(language, picker.target.scope) + ': ' + picker.target.label);
  for (const button of root.querySelectorAll('[data-category-icon-value]')) {
    const value = button.dataset.categoryIconValue;
    const selected = value ? picker.custom && value === picker.preferred : !picker.custom;
    if (button.getAttribute('aria-pressed') !== String(selected)) button.setAttribute('aria-pressed', String(selected));
    const glyph = button.querySelector('.category-option-glyph');
    if (glyph) {
      const tone = picker.tone || categoryIconTone(value || transactionCategoryIconName(deal));
      if (glyph.dataset.categoryTone !== tone) glyph.dataset.categoryTone = tone;
    }
  }
  for (const button of root.querySelectorAll('[data-category-icon-color]')) {
    const selected = button.dataset.categoryIconColor === (picker.tone || '');
    if (button.getAttribute('aria-pressed') !== String(selected)) button.setAttribute('aria-pressed', String(selected));
  }
  const preview = root.querySelector('[data-category-icon-preview]');
  if (preview) {
    const tone = picker.tone || categoryIconTone(picker.name);
    if (preview.dataset.categoryTone !== tone) preview.dataset.categoryTone = tone;
    if (preview.dataset.categoryIcon !== picker.name) {
      preview.dataset.categoryIcon = picker.name;
      preview.style.setProperty('--merchant-icon', categoryIconStyle(picker.name));
    }
  }
  setText(root.querySelector('[data-category-icon-preview-label]'), categoryIconLabel(picker.name, language));
}

function rememberRow(ctx, deal, row) {
  rowVersions.set(row, { deal, language: ctx.language, rates: ctx.state.rates,
    primaryCurrency: ctx.state.settings?.contextCurrency,
    adr: ctx.state.adrByDeal[String(deal.DealingNumber)], adrError: ctx.state.adrSyncError });
}

export function primeTransactionView(ctx, restoreEditors) {
  scroller?.destroy();
  scroller = null;
  if (ctx.state.route !== 'transactions') return;
  const body = document.querySelector('[data-ledger-body]');
  if (!body) return;
  const byId = new Map(ctx.filteredDeals.map((deal) => [String(deal.DealingNumber), deal]));
  for (const row of body.querySelectorAll('[data-deal-row]')) {
    const deal = byId.get(row.dataset.dealRow);
    if (deal) rememberRow(ctx, deal, row);
  }
  scroller = createTransactionScroller(body, ctx, (context, window) => patchRows(context, body, window), restoreEditors);
  patchSelection(ctx, document.querySelector('.transactions-page'));
}

function detailNodes(row) {
  const result = [];
  let next = row.nextElementSibling;
  while (next?.dataset.adrRowFor === row.dataset.dealRow) {
    result.push(next);
    next = next.nextElementSibling;
  }
  return result;
}

function afterRow(row) {
  return (detailNodes(row).at(-1) || row).nextElementSibling;
}

export function patchAdrRow(ctx, deal, row) {
  if (!row) return;
  const adr = transactionAdrView(ctx, deal);
  const slot = row.querySelector('.adr-disclosure');
  const focused = slot.contains(document.activeElement);
  slot.innerHTML = adr.disclosure;
  row.classList.toggle('has-adr', adr.expandable);
  if (adr.expandable) row.setAttribute('aria-expanded', String(adr.expanded));
  else row.removeAttribute('aria-expanded');
  for (const detail of detailNodes(row)) detail.remove();
  if (adr.details) row.insertAdjacentHTML('afterend', adr.details);
  if (focused) slot.querySelector('button')?.focus({ preventScroll: true });
  rememberRow(ctx, deal, row);
  scroller?.schedule();
}

function patchRows(ctx, body, window) {
  const visible = window.rows;
  let mounted = false;
  const topSpacer = body.querySelector('[data-ledger-spacer="top"]');
  const bottomSpacer = body.querySelector('[data-ledger-spacer="bottom"]');
  for (const [spacer, height] of [[topSpacer, window.top], [bottomSpacer, window.bottom]]) {
    spacer.hidden = height < 1;
    const value = height + 'px';
    if (spacer.firstElementChild.style.height !== value) spacer.firstElementChild.style.height = value;
  }
  const ids = new Set(visible.map((deal) => String(deal.DealingNumber)));
  const existing = new Map([...body.querySelectorAll('[data-deal-row]')].map((row) => [row.dataset.dealRow, row]));
  for (const [id, row] of existing) {
    if (ids.has(id)) continue;
    for (const child of detailNodes(row)) child.remove();
    row.remove();
    existing.delete(id);
  }
  if (!visible.length) {
    if (!body.querySelector('[data-empty-deals]')) bottomSpacer.insertAdjacentHTML('beforebegin', transactionEmptyRow(ctx));
    return false;
  }
  body.querySelector('[data-empty-deals]')?.remove();
  let anchor = topSpacer.nextElementSibling;
  for (const deal of visible) {
    const id = String(deal.DealingNumber);
    let row = existing.get(id);
    const version = row && rowVersions.get(row);
    const replace = !row || (!ctx.state.dealDrafts.has(id) &&
      (version?.deal !== deal || version?.language !== ctx.language || version?.rates !== ctx.state.rates ||
        version?.primaryCurrency !== ctx.state.settings?.contextCurrency));
    if (replace) {
      const nextAnchor = row === anchor ? afterRow(row) : anchor;
      if (row) {
        for (const child of detailNodes(row)) child.remove();
        row.remove();
        anchor = nextAnchor?.isConnected ? nextAnchor : bottomSpacer;
      }
      const template = document.createElement('template');
      template.innerHTML = transactionRows(ctx, deal);
      row = template.content.firstElementChild;
      body.insertBefore(template.content, anchor);
      rememberRow(ctx, deal, row);
      mounted = true;
    } else if (version?.adr !== ctx.state.adrByDeal[id] || version?.adrError !== ctx.state.adrSyncError) {
      patchAdrRow(ctx, deal, row);
    }
    // Keep unchanged nodes in place, including any focused draft inputs.
    if (row !== anchor && !replace) {
      const children = detailNodes(row);
      body.insertBefore(row, anchor);
      for (const child of children) body.insertBefore(child, anchor);
    }
    row.querySelector('[data-select-deal]').checked = ctx.state.selectedDeals.has(id);
    patchCategoryIcon(ctx, deal, row);
    anchor = afterRow(row);
  }
  return mounted;
}

function patchSelection(ctx, page) {
  const selectAll = page?.querySelector('[data-select-all-deals]');
  if (!selectAll) return;
  const selected = ctx.filteredDeals.reduce((count, deal) => count + Number(ctx.state.selectedDeals.has(String(deal.DealingNumber))), 0);
  selectAll.checked = selected > 0 && selected === ctx.filteredDeals.length;
  selectAll.indeterminate = selected > 0 && selected < ctx.filteredDeals.length;
}

export function patchTransactionView(ctx) {
  const page = document.querySelector('.transactions-page');
  const body = page?.querySelector('[data-ledger-body]');
  if (ctx.state.route !== 'transactions' || !body) return false;
  setText(page.querySelector('.page-brief'), ctx.t('transactionsBrief', { count: ctx.filteredDeals.length, amount: formatJpy(ctx.filteredTotal, ctx.language) }));
  setText(page.querySelector('.ledger-meta > span'), ctx.filteredDeals.length + ' / ' + ctx.state.deals.length);
  setText(page.querySelector('.ledger-meta > strong'), formatJpy(ctx.filteredTotal, ctx.language));
  setHtml(page.querySelector('[data-ledger-selection]'), transactionSelection(ctx));
  const filterSlot = page.querySelector('[data-ledger-filters]');
  patchDisclosure(filterSlot, ctx.state.filtersOpen, () => transactionFilters(ctx));
  for (const input of page.querySelectorAll('[data-filter]')) {
    const value = ctx.state.transactionFilters[input.dataset.filter];
    if (input !== document.activeElement && input.value !== value) input.value = value;
  }
  for (const [id, values] of [['main-category-options', ctx.categoryOptions], ['sub-category-options', ctx.subcategoryOptions]]) {
    const list = filterSlot.querySelector('#' + id);
    if (!list || regionVersions.get(list) === values) continue;
    list.replaceChildren(...values.map((value) => new Option(value, value)));
    regionVersions.set(list, values);
  }
  const toggle = page.querySelector('[data-toggle-filters]');
  toggle.setAttribute('aria-expanded', String(ctx.state.filtersOpen));
  setText(toggle.querySelector('.filter-count'), ctx.activeFilterCount);
  for (const button of page.querySelectorAll('[data-sort-deals]')) {
    const field = button.dataset.sortDeals;
    const active = ctx.state.transactionSort.field === field;
    const sort = active ? (ctx.state.transactionSort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
    if (button.parentElement.getAttribute('aria-sort') !== sort) {
      button.parentElement.setAttribute('aria-sort', sort);
      button.querySelector('.sort-indicator').outerHTML = sortIndicator(ctx, field);
    }
  }
  scroller?.update(ctx);
  setText(body.querySelector('[data-empty-deals] .table-empty'), ctx.t('noTransactions'));
  patchSelection(ctx, page);
  setText(page.querySelector('[data-ledger-end]'), ctx.filteredDeals.length ? ctx.t('transactionsEnd', { count: ctx.filteredDeals.length }) : '');
  const structure = page.querySelector('[data-ledger-structure]');
  const version = regionVersions.get(structure);
  if (version?.data !== ctx.filteredCategories || version?.language !== ctx.language) {
    structure.innerHTML = transactionStructure(ctx);
    regionVersions.set(structure, { data: ctx.filteredCategories, language: ctx.language });
  }
  return true;
}
