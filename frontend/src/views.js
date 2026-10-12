import { t as translate } from "./i18n.js";
import { importView } from './import-view.js';
import { financeAttr } from './finance-colors.js';
import { agentText, agentQuestions } from './agent-copy.js';
import { historyToolbar, historyControls } from './agent-history-view.js';
import { scrollDockMarkup } from './scroll-dock.js';
import { themeSwitch } from './theme.js';
import { runtimeDirty } from './runtime-settings-model.js';
import { agentInformationView, taskCreateButton } from './agent-information-view.js';
import { plansView } from './plans-view.js';
import { overviewChartView, overviewHeatmapView, overviewCategoryDriversView } from './overview-chart.js';
import { overviewAssetsView } from './overview-assets.js';
import { runtimeSettingsView } from './runtime-settings-view.js';
import { gmailSettingsView } from './gmail-settings-view.js';
import { sidebarProfileContent, userProfileSettings } from './user-profile.js';
import { fullMailImportView } from './full-mail-import-view.js';
import { shutdownSettingsView } from './system-shutdown.js';
import { settingsSaveView } from './settings-save.js';
import { reportScopeView, reportAccountLabel, comparisonLabels } from './report-scope.js';
import { runtimeText } from './runtime-settings-copy.js';
import { PRIMARY_CURRENCIES, normalizePrimaryCurrency } from './config.js';
import { assetsView, assetModalContent } from './assets-view.js';
import { INITIAL_TRANSACTION_ROWS, ESTIMATED_TRANSACTION_HEIGHT, transactionAdrState, todayTransactionDeals } from './ledger-model.js';
import { transactionCategoryIcon, categoryIconPickerMarkup } from './category-icons.js';
import { transactionAmountAttrs } from './transaction-amount.js';
import {
  amountToJpy,
  currencyName,
  dateInputValue,
  datetimeInputValue,
  dealHasAdr,
  escapeAttr,
  escapeHtml,
  formatAmount,
  formatDate,
  formatDateTime,
  formatDealAmount,
  formatJpy,
  formatPercent,
  formatSignedJpy,
  formatTime,
  simpleRichText,
  toDate,
} from "./utils.js";
import {
  comparisonTable,
  deltaBars,
  donutChart,
  horizontalBars,
  lineChart,
  progressChart,
  renderAgentPanelVisual,
} from "./charts.js";

function text(ctx, key, variables) {
  return ctx.t ? ctx.t(key, variables) : translate(ctx.language, key, variables);
}

function icon(name) {
  const paths = {
    overview: '<path d="M4 5h16M4 12h10M4 19h16"></path><circle cx="18" cy="12" r="2"></circle>',
    assets: '<path d="M3 8h18v12H3zM3 8l3-4h12l3 4M16 12h5v4h-5z"></path>',
    transactions: '<path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h8M8 16h5"></path>',
    import: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"></path>',
    review: '<path d="M12.5 4.6A5.5 5.5 0 0 0 6 10v3c0 1.6-.6 3.1-1.8 4.5h14.6C17.6 16.1 17 14.6 17 13v-1"></path><path d="M9 20a2.5 2.5 0 0 0 5 0"></path><path d="M18 2.5c.4 2.4 1.6 3.6 4 4-2.4.4-3.6 1.6-4 4-.4-2.4-1.6-3.6-4-4 2.4-.4 3.6-1.6 4-4Z"></path>',
    goals: '<circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="4"></circle><path d="M12 2v20M2 12h20"></path>',
    insights: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"></path>',
    agent: '<path d="M5 5h14v11H9l-4 4z"></path><path d="M9 9h6M9 12h4"></path>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"></path>',
    prompts: '<path d="M7 3h10v18H7z"></path><path d="M10 7h4M10 11h4M10 15h3"></path>',
    system: '<ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"></path>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4 4"></path>',
    calendar: '<rect x="4" y="5" width="16" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6"></path>',
    globe: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path>',
    refresh: '<path d="M20 6v5h-5"></path><path d="M4 18v-5h5"></path><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"></path>',
    panel: '<path d="M4 4h16v16H4zM15 4v16"></path>',
    expand: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    arrow: '<path d="m9 18 6-6-6-6"></path>',
    back: '<path d="M20 12H4m6-6-6 6 6 6"></path>',
    chevron: '<path d="m6 9 6 6 6-6"></path>',
    close: '<path d="m6 6 12 12M18 6 6 18"></path>',
    filter: '<path d="M4 7h16M4 17h16"></path><circle cx="9" cy="7" r="2"></circle><circle cx="15" cy="17" r="2"></circle>',
    reset: '<path d="M4 5v5h5"></path><path d="M4.5 10a8 8 0 1 1 1 8"></path>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7M14 10v7"></path>',
    retrieve: '<path d="M13 3H5v18h14v-7M8 7h3M8 11h3M8 16h5"></path><circle cx="17" cy="7" r="3"></circle><path d="m19 9 3 3"></path>',
    sort: '<path d="M8 4v16m-3-3 3 3 3-3M16 20V4m-3 3 3-3 3 3"></path>',
    ascending: '<path d="M12 20V4m-5 5 5-5 5 5"></path>',
    descending: '<path d="M12 4v16m-5-5 5 5 5-5"></path>',
    more: '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
  };
  return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.more) + "</svg>";
}

function navLink(ctx, route, key, badge) {
  const active = ctx.state.route === route;
  const badgeHtml = badge ? '<span class="nav-badge">' + escapeHtml(badge) + "</span>" : "";
  return (
    '<a class="nav-link ' + (active ? "is-active" : "") + '" href="#' + route + '" data-route="' + route + '">' +
    icon(route === "dev-prompts" ? "prompts" : route === "dev-system" ? "system" : route) +
    '<span class="nav-label">' + escapeHtml(text(ctx, key)) + "</span>" + badgeHtml + "</a>"
  );
}

function option(value, label, current) {
  return '<option value="' + escapeAttr(value) + '"' + (String(value) === String(current) ? " selected" : "") + ">" +
    escapeHtml(label) + "</option>";
}

function statusDot(status, agent = false) {
  return '<i class="status-dot is-' + escapeAttr(status || "idle") + '"' + (agent ? ' data-agent-health role="img" aria-label="Agent"' : '') + '></i>';
}

function dockFields(ctx) {
  const state = ctx.state;
  return (
    '<div class="global-search-wrap">' + icon("search") +
      '<input type="search" value="' + escapeAttr(state.globalSearch || "") + '" placeholder="' +
      escapeAttr(text(ctx, "searchAnything")) + '" aria-label="' + escapeAttr(text(ctx, "search")) + '" data-global-search autocomplete="off" />' +
      (state.globalSearch ? searchResults(ctx) : "") + "</div>"
  );
}

export function appShell(ctx) {
  const state = ctx.state;
  const syncing = Boolean(state.syncing || state.refreshing);
  const refreshLabel = text(ctx, syncing ? 'syncing' : 'refreshSync');
  // Spending statistics are always JPY; assets follow the primary currency. Show both so the two bases are never confused.
  const assetCurrency = currencyName(normalizePrimaryCurrency(state.settings.contextCurrency));
  const bodyClass = [
    "app-shell",
    state.settings.sidebarCollapsed ? "sidebar-collapsed" : "",
    state.settings.agentOpen && state.route !== "agent" ? "agent-open" : "",
    state.route === "agent" ? "agent-workspace-open" : "",
  ].filter(Boolean).join(" ");

  return (
    '<div class="' + bodyClass + '" style="--agent-width:' + Number(state.settings.agentWidth || 370) + 'px">' +
    '<button class="icon-button mobile-sidebar-toggle" type="button" data-toggle-sidebar aria-controls="primary-sidebar" aria-expanded="false" aria-label="' + escapeAttr(text(ctx, 'primaryNavigation')) + '">' + icon('panel') + '</button>' +
    '<button class="sidebar-backdrop" type="button" data-sidebar-backdrop aria-label="' + escapeAttr(text(ctx, 'close')) + '" tabindex="-1" aria-hidden="true" inert></button>' +
    '<aside class="sidebar" id="primary-sidebar">' +
      '<div class="brand-row"><a class="brand" href="#overview" aria-label="' + escapeAttr(text(ctx, 'appName')) +
      '"><span class="brand-mark" aria-hidden="true"><img src="/assets/app-icon.svg?v=f9-s4-1" width="36" height="36" alt="" data-brand-theme="dark" /><img src="/assets/app-icon-light.svg?v=f9-s4-1" width="36" height="36" alt="" data-brand-theme="light" /></span><span class="brand-copy"><strong>' +
      escapeHtml(text(ctx, "appName")) +
      '</strong></span></a><button class="icon-button sidebar-toggle" type="button" data-toggle-sidebar aria-expanded="' + String(!state.settings.sidebarCollapsed) + '" aria-label="Toggle navigation">' +
      icon("panel") + "</button></div>" +
      '<nav class="nav-block" aria-label="' + escapeAttr(text(ctx, "primaryNavigation")) + '">' +
      navLink(ctx, "overview", "overview") +
      navLink(ctx, "assets", "assets") +
      navLink(ctx, "transactions", "transactions") +
      navLink(ctx, "import", "importPage") +
      "</nav>" +
      (state.settings.developerMode
        ? '<nav class="nav-block developer-nav"><p class="nav-heading">' + escapeHtml(text(ctx, "developerTools")) + "</p>" +
          navLink(ctx, "dev-prompts", "promptManagement") +
          navLink(ctx, "dev-system", "systemManagement") + "</nav>"
        : "") +
      '<div class="sidebar-footer">' +
      '<button class="profile-block" type="button" data-user-profile data-route-button="settings">' +
      sidebarProfileContent(ctx, text(ctx, 'currencyBasis', { spend: 'JPY', asset: assetCurrency })) + '</button>' +
      '<div class="sidebar-actions">' +
      '<button class="icon-button sidebar-utility sidebar-refresh" type="button" data-refresh data-sidebar-refresh aria-busy="' + String(syncing) + '" title="' +
      escapeAttr(refreshLabel) + '" aria-label="' + escapeAttr(refreshLabel) + '"' + (syncing ? ' disabled' : '') + '>' +
      icon('refresh') + '</button>' +
      '<a class="icon-button sidebar-utility sidebar-settings' + (state.route === 'settings' ? ' is-active' : '') +
      '" href="#settings" data-route="settings" title="' + escapeAttr(text(ctx, 'settings')) + '" aria-label="' +
      escapeAttr(text(ctx, 'settings')) + '"' + (state.route === 'settings' ? ' aria-current="page"' : '') + '>' + icon('settings') +
      '</a></div></div>' +
    "</aside>" +
    '<main class="main-workspace" id="main-view">' + routeView(ctx) + "</main>" +
    (state.route !== "agent"
      ? '<div class="agent-resizer" data-agent-resizer></div><aside class="agent-panel" id="agent-panel">' + agentPanel(ctx) + "</aside>"
      : "") +
    scrollDockMarkup(ctx, icon, dockFields(ctx)) +
    '<div class="toast-region" aria-live="polite">' + toastMarkup(ctx) + "</div>" +
    '<div id="modal-root">' + modalMarkup(ctx) + "</div>" +
    "</div>"
  );
}

function searchResults(ctx) {
  const query = String(ctx.state.globalSearch || "").trim().toLowerCase();
  if (!query) return "";
  const routeMatches = [
    ["overview", "overview"],
    ["assets", "assets"],
    ["transactions", "transactions"],
    ["import", "importPage"],
    ["review", "review"],
    ['agent-tasks', 'automatedTasks'],
    ["goals", "goals"],
    ["insights", "insights"],
    ["agent", "agent"],
  ]
    .filter(([, key]) => text(ctx, key).toLowerCase().includes(query))
    .slice(0, 3);
  const dealMatches = ctx.state.deals
    .filter((deal) => {
      return String(deal.DealingNumber).includes(query) || String(deal.ShopName || "").toLowerCase().includes(query);
    })
    .slice(0, 5);
  if (!routeMatches.length && !dealMatches.length) return "";
  return (
    '<div class="search-popover">' +
    routeMatches.map(([route, key]) =>
      '<button type="button" data-search-route="' + route + '">' + icon(route) + "<span>" + escapeHtml(text(ctx, key)) + "</span></button>",
    ).join("") +
    dealMatches.map((deal) =>
      '<button type="button" data-search-deal="' + escapeAttr(deal.DealingNumber) + '">' +
      icon("transactions") + "<span><strong>" + escapeHtml(deal.ShopName || "—") + "</strong><small>#" +
      escapeHtml(deal.DealingNumber) + " · " + escapeHtml(formatDealAmount(deal.price, deal.CurrencyTypeNumber, ctx.language, ctx.state.rates)) +
      "</small></span></button>",
    ).join("") +
    "</div>"
  );
}

export function toastMarkup(ctx) {
  if (!ctx.state.toast) return "";
  return '<div class="toast is-' + escapeAttr(ctx.state.toast.type || "info") + '">' + escapeHtml(ctx.state.toast.message) + "</div>";
}

function pageHeader(ctx, kickerKey, titleKey, brief, actions) {
  return (
    '<header class="page-header"><div class="page-heading">' +
    '<h1>' + escapeHtml(text(ctx, titleKey)) + "</h1>" +
    (brief ? '<p class="page-brief">' + escapeHtml(brief) + "</p>" : "") +
    "</div>" +
    (actions ? '<div class="page-actions">' + actions + "</div>" : "") +
    "</header>"
  );
}

export function routeView(ctx) {
  const routes = {
    overview: overviewView,
    assets: (ctx) => assetsView(ctx, { pageHeader, icon }),
    transactions: transactionsView,
    import: importView,
    review: reviewView,
    'agent-tasks': (ctx) => '<section class="page agent-tasks-page">' + pageHeader(ctx, '', 'automatedTasks', '', taskCreateButton(ctx)) + agentInformationView(ctx) + '</section>',
    goals: goalsView,
    insights: insightsView,
    agent: agentWorkspaceView,
    settings: settingsView,
    "dev-prompts": promptView,
    "dev-system": systemView,
  };
  return (routes[ctx.state.route] || overviewView)(ctx);
}

function overviewView(ctx) {
  const summary = ctx.summary;
  if (!ctx.state.deals.length && ctx.state.status.backend !== "ok") {
    return (
      '<section class="page overview-page">' +
      pageHeader(ctx, "overviewKicker", "overviewNoDataTitle", text(ctx, "overviewNoDataBody"), "") +
      serviceEmptyState(ctx) + overviewAssetsView(ctx) + "</section>"
    );
  }
  const metrics = [
    [text(ctx, "periodSpending"), formatJpy(summary.currentTotal, ctx.language), summary.deltaPercentText,
      financeAttr(summary.previousTotal > 0 ? summary.delta : null, 'expense-change')],
    [text(ctx, "dailyAverage"), formatJpy(summary.dailyAverage, ctx.language)],
    [text(ctx, "todaySpending"), formatJpy(summary.todayTotal, ctx.language)],
    [text(ctx, "engelCoefficient"), summary.engelCoefficient == null ? "—" : formatPercent(summary.engelCoefficient, ctx.language)],
  ];
  const mainChart = overviewChartView(ctx);
  return (
    '<section class="page overview-page">' +
    pageHeader(ctx, "overviewKicker", summary.titleKey, summary.brief, "") +
    reportScopeView(ctx) + '<div class="overview-grid">' +
      '<section class="metric-strip overview-summary-card" aria-label="' + escapeAttr(text(ctx, "currentState")) + '">' +
      metrics.map((metric) =>
        '<div class="metric-block"><span>' + escapeHtml(metric[0]) + '</span><div class="metric-value"><strong>' + escapeHtml(metric[1]) +
        '</strong>' + (metric[2] ? '<small class="metric-change" title="' + escapeAttr(comparisonLabels(ctx).previous + ': ' + metric[2]) + '" aria-label="' + escapeAttr(comparisonLabels(ctx).previous + ': ' + metric[2]) + '"' +
          (metric[3] || '') + '>' + escapeHtml(metric[2]) + '</small>' : '') + '</div></div>',
      ).join("") + "</section>" +
      '<div class="overview-trends-stack">' + overviewAssetsView(ctx) +
      '<section class="editorial-section change-section"><header class="section-header"><div><h2>' + escapeHtml(summary.chartTitle) +
      '</h2></div><button class="text-button" type="button" data-route-button="insights">' +
      escapeHtml(text(ctx, "viewAll")) + icon("arrow") + "</button></header>" + mainChart + "</section></div>" +
      '<div class="overview-analysis-stack">' +
      overviewHeatmapView(ctx) + overviewCategoryDriversView(ctx) + '</div>' +
      todayTransactionsBlock(ctx) +
    "</div></section>"
  );
}

function serviceEmptyState(ctx) {
  return (
    '<div class="service-empty"><div class="service-empty-copy"><h2>' +
    escapeHtml(text(ctx, "backendAddress")) + '</h2><p>' + escapeHtml(ctx.state.lastError || text(ctx, "offline")) +
    '</p><div class="button-row"><button class="button primary" type="button" data-route-button="settings">' +
    escapeHtml(text(ctx, "settings")) + '</button><button class="button" type="button" data-refresh>' +
    escapeHtml(text(ctx, "refresh")) + "</button></div></div>" +
    '<img src="/assets/finance-source.jpg" alt="" /></div>'
  );
}

export function todayTransactionsBlock(ctx, now = new Date()) {
  const rows = todayTransactionDeals(ctx.state.deals, ctx.state.settings.contextAccount, now);
  const preview = { ...ctx, state: { ...ctx.state, adrByDeal: ctx.state.adrByDeal || {}, adrLoading: ctx.state.adrLoading || {} } };
  return (
    '<section class="editorial-section today-transactions-block" data-today-transactions="' + dateInputValue(now) +
    '"><header class="section-header compact"><div><h2>' + escapeHtml(text(ctx, "todayTransactions")) +
    '</h2></div><button class="text-button" type="button" data-route-button="transactions">' +
    escapeHtml(text(ctx, "viewAll")) + icon("arrow") + "</button></header>" +
    '<div class="ledger-meta"><span>' + escapeHtml(text(ctx, 'transactionsEnd', { count: rows.length })) + '</span></div>' +
    '<div class="table-scroll today-transactions-scroll"><table class="ledger-table today-transactions-table" aria-label="' +
    escapeAttr(text(ctx, 'todayTransactions')) + '"><thead><tr><th class="check-cell" aria-hidden="true"></th>' +
    ['merchant', 'amount', 'date', 'category', 'actions'].map(key => '<th scope="col">' + escapeHtml(text(ctx, key)) + '</th>').join('') +
    '</tr></thead><tbody>' + (rows.length ? rows.map(deal => transactionRows(preview, deal, { readOnly: true })).join('') :
      '<tr><td colspan="5"><div class="table-empty">' + escapeHtml(text(ctx, 'noTodayTransactions')) + '</div></td></tr>') +
    '</tbody></table></div></section>'
  );
}

export function refreshOverviewTransactions(ctx, root, now = new Date()) {
  const section = root?.querySelector('[data-today-transactions]');
  if (!section || section.dataset.todayTransactions === dateInputValue(now)) return false;
  section.outerHTML = todayTransactionsBlock(ctx, now);
  return true;
}

function transactionsView(ctx) {
  const filters = ctx.state.transactionFilters;
  const correction = ctx.state.correctionMode;
  const correctionSwitch =
    '<label class="mode-switch" title="' + escapeAttr(text(ctx, "correctionHint")) + '">' +
    '<input type="checkbox" data-correction-mode aria-label="' + escapeAttr(text(ctx, "correctionMode")) + '"' +
    (correction ? " checked" : "") + " />" +
    '<span class="switch-track" aria-hidden="true"><i></i></span><span class="mode-caption">' +
    escapeHtml(text(ctx, "correctionMode")) + "</span></label>";
  const actions =
    '<button class="button primary" type="button" data-open-modal="transaction">' + icon("plus") +
    escapeHtml(text(ctx, "addTransaction")) + "</button>";

  return (
    '<section class="page transactions-page">' +
    pageHeader(
      ctx,
      "transactionsKicker",
      "transactionsTitle",
      text(ctx, "transactionsBrief", {
        count: ctx.filteredDeals.length,
        amount: formatJpy(ctx.filteredTotal, ctx.language),
      }),
      actions,
    ) +
    '<section class="ledger-toolbar"><div class="ledger-search">' + icon("search") +
    '<input type="search" data-filter="shop" value="' + escapeAttr(filters.shop) + '" placeholder="' +
    escapeAttr(text(ctx, "merchant")) + '" /></div>' +
    '<button class="button filter-toggle" type="button" data-toggle-filters aria-controls="transaction-filters" aria-expanded="' +
    String(ctx.state.filtersOpen) + '">' + icon("filter") + escapeHtml(text(ctx, "filters")) +
    '<span class="filter-count">' + escapeHtml(ctx.activeFilterCount) + "</span>" + icon("chevron") + "</button>" +
    correctionSwitch +
    '<div data-ledger-selection>' + transactionSelection(ctx) + '</div>' +
    "</section>" +
    '<div data-ledger-filters>' + (ctx.state.filtersOpen ? transactionFilters(ctx) : '') + '</div>' +
    '<section class="ledger-section"><div class="ledger-meta"><span>' +
    escapeHtml(ctx.filteredDeals.length + " / " + ctx.state.deals.length) + "</span><strong>" +
    escapeHtml(formatJpy(ctx.filteredTotal, ctx.language)) + "</strong></div>" +
    transactionTable(ctx) + '<div class="ledger-end" data-ledger-end>' +
    (ctx.filteredDeals.length ? escapeHtml(text(ctx, 'transactionsEnd', { count: ctx.filteredDeals.length })) : '') + '</div></section>' +
    '<section class="editorial-section transaction-structure"><header class="section-header compact"><div><h2>' +
    escapeHtml(text(ctx, "categoryDrivers")) + "</h2></div></header>" +
    '<div data-ledger-structure>' + transactionStructure(ctx) + '</div>' +
    "</section></section>"
  );
}

export function transactionStructure(ctx) {
  return horizontalBars(ctx.filteredCategories.slice(0, 8), { language: ctx.language, motionKey: 'transaction-categories' });
}

export function transactionSelection(ctx) {
  return ctx.state.selectedDeals.size ? '<div class="bulk-actions"><span>' +
    escapeHtml(text(ctx, 'selected', { count: ctx.state.selectedDeals.size })) +
    '</span><button class="button ghost danger-quiet" type="button" data-delete-selected-deals' +
    (ctx.state.dealDrafts?.size ? ' disabled' : '') + '>' + icon('trash') + escapeHtml(text(ctx, 'deleteSelected')) + '</button></div>' : '';
}

function categoryFilter(ctx, field, list) {
  const label = text(ctx, field);
  return '<label><span>' + escapeHtml(label) + '</span><span class="category-filter-control">' +
    '<input type="search" data-category-list="' + list + '" data-filter="' + field + '" value="' +
    escapeAttr(ctx.state.transactionFilters[field]) + '" role="combobox" aria-autocomplete="list" aria-haspopup="listbox"' +
    ' aria-expanded="false" aria-label="' + escapeAttr(label) + '" data-empty-label="' + escapeAttr(text(ctx, 'noRows')) +
    '" autocomplete="off" spellcheck="false" />' + icon('chevron') + '</span></label>';
}

export function transactionFilters(ctx) {
  const filters = ctx.state.transactionFilters;
  const mainOptions = ctx.categoryOptions.map((item) => '<option value="' + escapeAttr(item) + '"></option>').join("");
  const subOptions = ctx.subcategoryOptions.map((item) => '<option value="' + escapeAttr(item) + '"></option>').join("");
  return (
    '<section class="filter-panel" id="transaction-filters" aria-label="' + escapeAttr(text(ctx, "filters")) + '">' +
    '<div class="filter-panel-header"><label class="filter-id"><span>' + escapeHtml(text(ctx, "id")) +
    '</span><input type="search" data-filter="id" value="' + escapeAttr(filters.id) + '" placeholder="#22437" /></label>' +
    '<button class="button ghost" type="button" data-clear-filters>' + icon("reset") +
    escapeHtml(text(ctx, "clearFilters")) + '</button></div>' +
    '<div class="filter-groups"><fieldset class="filter-group"><legend>' + escapeHtml(text(ctx, "category")) +
    '</legend><div class="filter-pair">' +
    categoryFilter(ctx, 'mainCategory', 'main-category-options') +
    categoryFilter(ctx, 'subCategory', 'sub-category-options') +
    '</div></fieldset><fieldset class="filter-group"><legend>' + escapeHtml(text(ctx, "date")) +
    '</legend><div class="filter-pair">' +
    '<label><span>' + escapeHtml(text(ctx, "startDate")) + '</span><input type="date" data-filter="startDate" value="' +
    escapeAttr(filters.startDate) + '" /></label>' +
    '<label><span>' + escapeHtml(text(ctx, "endDate")) + '</span><input type="date" data-filter="endDate" value="' +
    escapeAttr(filters.endDate) + '" /></label>' +
    '</div></fieldset></div>' +
    '<datalist id="main-category-options">' + mainOptions + '</datalist><datalist id="sub-category-options">' +
    subOptions + "</datalist></section>"
  );
}

export function transactionEditActions(ctx, id, saving) {
  return '<div class="inline-edit-actions" data-deal-edit-actions><button class="button compact" type="button" data-save-deal-draft="' +
    escapeAttr(id) + '" aria-busy="' + String(saving) + '"' + (saving ? ' disabled' : '') + '>' +
    escapeHtml(text(ctx, saving ? 'saving' : 'save')) + '</button><button class="button compact ghost icon-only" type="button" data-cancel-deal-draft="' +
    escapeAttr(id) + '" aria-label="' + escapeAttr(text(ctx, 'cancel') + ' #' + id) + '" title="' +
    escapeAttr(text(ctx, 'cancel')) + '"' + (saving ? ' disabled' : '') + '>' + icon('close') + '</button></div>';
}

function transactionTable(ctx) {
  const rows = ctx.filteredDeals.length
    ? ctx.filteredDeals.slice(0, INITIAL_TRANSACTION_ROWS).map((deal) => transactionRows(ctx, deal)).join("")
    : transactionEmptyRow(ctx);
  const remainingHeight = Math.max(0, ctx.filteredDeals.length - INITIAL_TRANSACTION_ROWS) * ESTIMATED_TRANSACTION_HEIGHT;
  return (
    '<div class="table-scroll" tabindex="0" role="region" aria-label="' + escapeAttr(text(ctx, 'transactionsTitle')) + '"><table class="ledger-table"><thead><tr>' +
    '<th class="check-cell"><input type="checkbox" data-select-all-deals aria-label="' + escapeAttr(text(ctx, "selectAllMatches")) + '" title="' + escapeAttr(text(ctx, "selectAllMatches")) + '" /></th>' +
    '<th>' + escapeHtml(text(ctx, "merchant")) + "</th>" +
    '<th aria-sort="' + (ctx.state.transactionSort.field === "amount" ? (ctx.state.transactionSort.direction === "asc" ? "ascending" : "descending") : "none") +
    '"><button class="sort-button" type="button" data-sort-deals="amount">' + escapeHtml(text(ctx, "amount")) +
    sortIndicator(ctx, "amount") + "</button></th>" +
    '<th aria-sort="' + (ctx.state.transactionSort.field === "time" ? (ctx.state.transactionSort.direction === "asc" ? "ascending" : "descending") : "none") +
    '"><button class="sort-button" type="button" data-sort-deals="time">' + escapeHtml(text(ctx, "date")) +
    sortIndicator(ctx, "time") + "</button></th>" +
    '<th>' + escapeHtml(text(ctx, "category")) + "</th>" +
    '<th>' + escapeHtml(text(ctx, "actions")) + "</th></tr></thead><tbody data-ledger-body>" +
    '<tr class="ledger-spacer" data-ledger-spacer="top" aria-hidden="true" hidden><td colspan="6"></td></tr>' + rows +
    '<tr class="ledger-spacer" data-ledger-spacer="bottom" aria-hidden="true"' + (remainingHeight ? '' : ' hidden') + '><td colspan="6" style="height:' + remainingHeight + 'px"></td></tr>' +
    "</tbody></table></div>"
  );
}

export function sortIndicator(ctx, field) {
  const active = ctx.state.transactionSort.field === field;
  return '<span class="sort-indicator' + (active ? " is-active" : "") + '" aria-hidden="true">' +
    icon(active ? (ctx.state.transactionSort.direction === "asc" ? "ascending" : "descending") : "sort") + "</span>";
}

export function transactionEmptyRow(ctx) {
  return '<tr data-empty-deals><td colspan="6"><div class="table-empty">' + escapeHtml(text(ctx, 'noTransactions')) + '</div></td></tr>';
}

export function transactionRows(ctx, deal, { readOnly = false } = {}) {
  const id = String(deal.DealingNumber);
  const selected = !readOnly && ctx.state.selectedDeals.has(id);
  const adr = transactionAdrView(ctx, deal);
  const categories = [deal.MainCategory, deal.SubCategory].filter((value) => String(value || "").trim());
  const fieldAction = field => readOnly ? ' data-open-deal="' + escapeAttr(id) + '"' :
    ' data-edit-deal="' + escapeAttr(id) + '" data-field="' + field + '"';
  const main =
    '<tr class="ledger-row' + (adr.expandable ? ' has-adr' : '') + '" data-deal-row="' + escapeAttr(id) +
    '"' + (adr.expandable ? ' aria-expanded="' + String(adr.expanded) + '"' : '') + '>' +
    '<td class="check-cell">' + (readOnly ? '' : '<input type="checkbox" data-select-deal="' + escapeAttr(id) + '"' + (selected ? " checked" : "") + ' />') + '</td>' +
    '<td class="merchant-cell"><div class="merchant-content"><span class="adr-disclosure">' + adr.disclosure +
    '</span>' + transactionCategoryIcon(deal, ctx.state.categoryIcons, ctx.language) + '<button type="button" class="editable-value merchant-value"' +
    fieldAction('ShopName') + '>' + escapeHtml(deal.ShopName || "—") + "</button></div></td>" +
    '<td class="amount-cell"><button type="button" class="editable-value numeric"' +
    fieldAction('price') + financeAttr(deal.price, 'amount') + transactionAmountAttrs(ctx, deal.price, deal.CurrencyTypeNumber) + '>' +
    escapeHtml(formatAmount(deal.price, deal.CurrencyTypeNumber, ctx.language)) +
    "</button></td>" +
    '<td class="date-cell"><button type="button" class="editable-value numeric"' +
    fieldAction('ISOtime') + '>' + escapeHtml(formatDateTime(deal.ISOtime, ctx.language)) + "</button></td>" +
    '<td class="category-cell"><div class="category-pair">' +
    (categories.length
      ? categories.map((category, index) =>
        '<button type="button" class="category-tag"' + fieldAction(index === 0 ? 'MainCategory' : 'SubCategory') + '>' + escapeHtml(category) + "</button>",
      ).join("")
      : '<button type="button" class="category-tag is-missing"' +
        fieldAction('MainCategory') + '>' + escapeHtml(text(ctx, "missingClassification")) + "</button>") +
    "</div></td>" +
    '<td class="action-cell"><div class="row-actions"><button class="button compact ghost icon-only" type="button" data-open-deal="' +
    escapeAttr(id) + '" aria-label="' + escapeAttr(text(ctx, "transactionDetail") + " · " + (deal.ShopName || "—")) +
    '" title="' + escapeAttr(text(ctx, "transactionDetail")) + '">' + icon("transactions") +
    '</button>' + (readOnly ? '' : '<button class="button compact ghost icon-only danger-quiet" type="button" data-delete-deal="' + escapeAttr(id) +
    '" aria-label="' + escapeAttr(text(ctx, "delete") + " #" + id) + '" title="' + escapeAttr(text(ctx, "delete")) + '">' +
    icon("trash") + '</button>') + '</div></td></tr>';

  return main + adr.details;
}

export function transactionAdrView(ctx, deal) {
  const id = String(deal.DealingNumber);
  const { rows, loading, expandable, expanded } = transactionAdrState(ctx.state, deal);
  const source = rows.length ? "ADR " + rows.length : dealHasAdr(deal) ? "ADR" : "AUTO";
  if (!expandable) return { expandable, expanded, source, disclosure: "", details: "" };

  const detailIds = expanded ? Array.from({ length: Math.max(rows.length, 1) }, (_, index) => "adr-detail-" + encodeURIComponent(id) + "-" + index) : [];
  const label = text(ctx, expanded ? "collapseDetails" : "expandDetails") + " #" + id;
  const disclosure = '<button class="button compact ghost icon-only adr-toggle" type="button" data-toggle-adr="' +
    escapeAttr(id) + '" aria-expanded="' + String(expanded) + '"' + (expanded ? ' aria-controls="' + escapeAttr(detailIds.join(' ')) + '"' : '') +
    ' aria-label="' + escapeAttr(label) + '" title="' + escapeAttr(label) + '">' + icon("chevron") + "</button>";
  if (!expanded) return { expandable, expanded, source, disclosure, details: '' };
  const detailStart = (index, last) => '<tr class="adr-detail-row' + (last ? ' is-last' : '') + '" id="' +
    escapeAttr(detailIds[index]) + '" data-adr-row-for="' + escapeAttr(id) + '"' + (expanded ? '' : ' hidden') + '>';
  const details = rows.length ? rows.map((row, index) => {
    const product = row.ProductName || row.ShopName || "—";
    const quantity = row.Quantity ?? row.quantity;
    return detailStart(index, index === rows.length - 1) +
      '<td class="adr-gutter"></td><td class="adr-product-cell"><span class="adr-product">' +
      escapeHtml(product) + '</span></td><td class="adr-amount-cell"><strong class="adr-amount"' + financeAttr(row.price, 'amount') +
      transactionAmountAttrs(ctx, row.price, row.CurrencyTypeNumber ?? deal.CurrencyTypeNumber) + '>' +
      escapeHtml(formatAmount(row.price, row.CurrencyTypeNumber ?? deal.CurrencyTypeNumber, ctx.language)) +
      '</strong></td><td class="adr-quantity-cell">' +
      (quantity !== null && quantity !== undefined && quantity !== ''
        ? '<span class="adr-quantity"><span>' + escapeHtml(text(ctx, "quantity")) + '</span><strong>' + escapeHtml(quantity) + '</strong></span>'
        : '') + '</td><td class="category-cell"><div class="category-pair">' +
      [row.MainCategory, row.SubCategory].filter(Boolean).map((category) =>
        '<span class="category-tag">' + escapeHtml(category) + '</span>',
      ).join('') + '</div></td><td></td></tr>';
  }).join('') : detailStart(0, true) + '<td class="adr-gutter"></td><td colspan="5" class="adr-product-cell">' +
    '<span class="adr-empty" role="status">' + escapeHtml(loading ? text(ctx, "loading") : ctx.state.adrSyncError || text(ctx, "noAdrDetails")) + '</span></td></tr>';
  return { expandable, expanded, source, disclosure, details };
}

function reviewView(ctx) {
  return '<section class="page review-page">' + pageHeader(ctx, '', 'reviewTitle', '', '') +
    agentInformationView(ctx) + '</section>';
}

function goalsView(ctx) {
  return plansView(ctx, { pageHeader });
}

function goalListItem(ctx, goal, selected) {
  const ratio = Math.min(1, Number(goal.currentAmount || 0) / Math.max(Number(goal.targetAmount || 1), 1));
  return (
    '<button class="goal-list-item ' + (selected?.id === goal.id ? "is-active" : "") + '" type="button" data-select-goal="' +
    escapeAttr(goal.id) + '"><span class="goal-list-top"><strong>' + escapeHtml(goal.name) +
    "</strong><small>" + escapeHtml(formatPercent(ratio * 100, ctx.language, 0)) + "</small></span>" +
    '<span class="mini-progress" data-page-chart="goal-list-' + escapeAttr(goal.id) + '" data-page-chart-type="progress" data-page-chart-version="' + ratio + '"><i class="finance-fill"' + financeAttr(goal.currentAmount) + ' style="width:' + (ratio * 100).toFixed(2) + '%"></i></span><span class="goal-list-meta">' +
    escapeHtml(formatJpy(goal.currentAmount, ctx.language)) + " / " + escapeHtml(formatJpy(goal.targetAmount, ctx.language)) +
    "</span></button>"
  );
}

function goalDetail(ctx, goal) {
  if (!goal) return "";
  const current = Number(goal.currentAmount || 0);
  const target = Number(goal.targetAmount || 0);
  const contribution = Number(ctx.state.scenarioContribution || goal.monthlyContribution || 0);
  const remaining = Math.max(0, target - current);
  const months = contribution > 0 ? Math.ceil(remaining / contribution) : null;
  const ratio = target > 0 ? Math.min(1, current / target) : 0;
  return (
    '<div class="goal-detail-head"><div><p class="section-label">' +
    escapeHtml(goal.primary ? text(ctx, "primaryGoal") : text(ctx, "goalProgress")) + '</p><h2>' +
    escapeHtml(goal.name) + '</h2><p>' + escapeHtml(formatDate(goal.deadline, ctx.language)) +
    '</p></div><div class="goal-detail-actions"><button class="button" type="button" data-edit-goal="' +
    escapeAttr(goal.id) + '">' + escapeHtml(text(ctx, "edit")) + '</button><button class="button danger-quiet" type="button" data-delete-goal="' +
    escapeAttr(goal.id) + '">' + escapeHtml(text(ctx, "delete")) + "</button></div></div>" +
    '<div class="goal-number"><strong>' + escapeHtml(formatPercent(ratio * 100, ctx.language, 0)) +
    '</strong><span><span' + financeAttr(current) + '>' + escapeHtml(formatJpy(current, ctx.language)) + "</span> / " + escapeHtml(formatJpy(target, ctx.language)) + "</span></div>" +
    progressChart(current, target, { language: ctx.language, plannedRatio: ctx.goalPlannedRatio, motionKey: 'goal-detail-' + goal.id }) +
    '<dl class="goal-facts"><div><dt>' + escapeHtml(text(ctx, "monthlyContribution")) + "</dt><dd>" +
    escapeHtml(formatJpy(goal.monthlyContribution || 0, ctx.language)) + "</dd></div><div><dt>" +
    escapeHtml(text(ctx, "projectedDate")) + "</dt><dd>" +
    escapeHtml(months === 0 ? text(ctx, "goalReached") : months ? text(ctx, "projectedIn", { months }) : "—") +
    "</dd></div></dl>" +
    '<section class="scenario-section"><p class="section-label">' + escapeHtml(text(ctx, "scenario")) +
    '</p><label><span>' + escapeHtml(text(ctx, "scenarioContribution")) + '</span><input type="range" min="0" max="' +
    escapeAttr(Math.max(100000, Number(goal.monthlyContribution || 0) * 3)) + '" step="1000" value="' +
    escapeAttr(contribution) + '" data-goal-scenario /><strong data-goal-scenario-value>' +
    escapeHtml(formatJpy(contribution, ctx.language)) + "</strong></label></section>" +
    (!goal.primary
      ? '<button class="text-button" type="button" data-primary-goal="' + escapeAttr(goal.id) + '">' +
        escapeHtml(text(ctx, "makePrimary")) + icon("arrow") + "</button>"
      : "")
  );
}

function insightsView(ctx) {
  const summary = ctx.summary;
  const labels = comparisonLabels(ctx);
  const topDriver = ctx.categoryComparison[0];
  const brief = !(summary.previousTotal > 0) ? text(ctx, 'noComparison') : summary.delta > 500
    ? text(ctx, "insightsBriefUp", { delta: formatJpy(Math.abs(summary.delta), ctx.language), driver: topDriver?.label || "—" })
    : summary.delta < -500
      ? text(ctx, "insightsBriefDown", { delta: formatJpy(Math.abs(summary.delta), ctx.language), driver: topDriver?.label || "—" })
      : text(ctx, "insightsBriefFlat");
  const mainChart = overviewChartView(ctx);
  return (
    '<section class="page insights-page">' +
    pageHeader(ctx, "insightsKicker", "insightsTitle", brief, "") +
    reportScopeView(ctx) + '<div class="insight-summary"><div><span>' + escapeHtml(labels.current) + '</span><strong>' +
    escapeHtml(formatJpy(summary.currentTotal, ctx.language)) + '</strong></div><div><span>' +
    escapeHtml(labels.previous) + '</span><strong>' + escapeHtml(summary.previousCount ? formatJpy(summary.previousTotal, ctx.language) : '—') +
    '</strong></div><div><span>' + escapeHtml(text(ctx, "difference")) + '</span><strong' +
    financeAttr(summary.previousCount ? summary.delta : null, 'expense-change') + '>' + escapeHtml(summary.previousCount ? formatSignedJpy(summary.delta, ctx.language) : '—') +
    "</strong></div></div>" +
    '<section class="editorial-section insight-main"><header class="section-header"><div><p class="section-label">' +
    escapeHtml(text(ctx, "trendExplorer")) + '</p><h2>' + escapeHtml(summary.chartTitle) + "</h2></div></header>" + mainChart + "</section>" +
    '<div class="insight-grid"><section class="editorial-section"><header class="section-header compact"><div><p class="section-label">01</p><h2>' +
    escapeHtml(text(ctx, "categoryDrivers")) + "</h2></div></header>" +
    deltaBars(ctx.categoryComparison, { language: ctx.language, limit: 8, meaning: 'expense-change', motionKey: 'insights-categories' }) + "</section>" +
    '<section class="editorial-section"><header class="section-header compact"><div><p class="section-label">02</p><h2>' +
    escapeHtml(text(ctx, "merchantDrivers")) + "</h2></div></header>" +
    horizontalBars(ctx.merchantTotals.slice(0, 8), { language: ctx.language, motionKey: 'insights-merchants' }) + "</section></div>" +
    '<section class="editorial-section monthly-history"><header class="section-header compact"><div><h2>' +
    escapeHtml(text(ctx, "monthlyHistory")) + '</h2></div><div class="monthly-average-value"><span>' +
    escapeHtml(text(ctx, "monthlyAverage")) + '</span><strong>' +
    escapeHtml(formatJpy(ctx.monthlyAverage, ctx.language)) + '</strong></div></header><p class="report-scope">' +
    escapeHtml(text(ctx, 'allTime') + ' · ' + reportAccountLabel(ctx) + ' · ' + text(ctx, 'spendingCurrency')) + '</p><div class="monthly-history-scroll">' +
    horizontalBars(ctx.monthlyTotals, { language: ctx.language, limit: 60, motionKey: 'insights-months' }) + "</div></section>" +
    '<section class="editorial-section evidence-section"><details><summary>' + escapeHtml(text(ctx, "evidence")) +
    icon("chevron") + '</summary><dl><div><dt>' + escapeHtml(text(ctx, "evidenceRange")) + "</dt><dd>" +
    escapeHtml(ctx.summary.rangeLabel) + '</dd></div><div><dt>' + escapeHtml(text(ctx, "evidenceCurrency")) +
    "</dt><dd>JPY</dd></div><div><dt>" + escapeHtml(text(ctx, "evidenceSource")) +
    "</dt><dd>DealingData API</dd></div></dl></details></section>" +
    '<section class="editorial-section top-transactions"><header class="section-header compact"><div><h2>' +
    escapeHtml(text(ctx, "topTransactions")) + "</h2></div></header>" +
    ctx.currentDeals.slice().sort((a, b) =>
      amountToJpy(b.price, b.CurrencyTypeNumber, ctx.state.rates) - amountToJpy(a.price, a.CurrencyTypeNumber, ctx.state.rates),
    ).slice(0, 6).map((deal) =>
      '<button class="evidence-row" type="button" data-open-deal="' + escapeAttr(deal.DealingNumber) + '"><span>#' +
      escapeHtml(deal.DealingNumber) + '</span><strong>' + escapeHtml(deal.ShopName || "—") + '</strong><small>' +
      escapeHtml([deal.MainCategory, deal.SubCategory].filter(Boolean).join(" / ")) + '</small><b>' +
      escapeHtml(formatDealAmount(deal.price, deal.CurrencyTypeNumber, ctx.language, ctx.state.rates)) +
      "</b></button>",
    ).join("") + "</section></section>"
  );
}

function agentWorkspaceView(ctx) {
  return (
    '<section class="page agent-workspace-page">' +
    '<div class="agent-workspace-grid" style="--workspace-split:' + Number(ctx.state.settings.agentWorkspaceSplit || 62) + '%"><section class="agent-evidence-column" aria-label="' + escapeAttr(agentText(ctx.language, 'canvas')) + '">' +
    '<header class="agent-canvas-heading"><h1>' + escapeHtml(agentText(ctx.language, 'canvas')) + '</h1><div class="agent-canvas-actions"><button class="icon-button" type="button" data-agent-back title="' + escapeAttr(agentText(ctx.language, 'back')) + '" aria-label="' + escapeAttr(agentText(ctx.language, 'back')) + '">' + icon('back') + '</button></div></header>' +
    '<div data-agent-canvas></div></section><div class="agent-workspace-resizer" data-agent-workspace-resizer role="separator" aria-orientation="vertical" tabindex="0" aria-label="' + escapeAttr(agentText(ctx.language, 'canvas')) + '"></div>' +
    '<section class="agent-chat-column"><div class="agent-conversation-tools">' + contextStrip(ctx) + historyToolbar() + '</div><div class="agent-report-stream">' + agentMessages(ctx, true) +
    '</div>' + agentComposer(ctx, true) + '</section></div></section>'
  );
}

export function agentPanel(ctx) {
  return (
    '<div class="agent-panel-head"><div><h2>' + statusDot(ctx.state.status?.agent, true) + escapeHtml(agentText(ctx.language, 'panelTitle')) +
    '</h2></div><div class="agent-panel-actions"><button class="icon-button" type="button" data-dock-pin-agent title="' + escapeAttr(agentText(ctx.language, 'sidePanel')) + '" aria-label="' +
    escapeAttr(agentText(ctx.language, 'sidePanel')) + '">' + icon('panel') + '</button><button class="icon-button" type="button" data-open-agent-workspace title="' + escapeAttr(agentText(ctx.language, 'expand')) + '" aria-label="' +
    escapeAttr(agentText(ctx.language, 'expand')) + '">' + icon('expand') + '</button><button class="icon-button" type="button" data-toggle-agent aria-label="' +
    escapeAttr(text(ctx, "closeAgent")) + '">' + icon("close") + "</button></div></div>" +
    '<div class="agent-conversation-tools">' + contextStrip(ctx) + historyToolbar() + '</div>' +
    '<div class="agent-panel-scroll">' + agentMessages(ctx, false) + '</div>' +
    agentComposer(ctx, false)
  );
}

function contextStrip(ctx) {
  if (ctx.state.route === 'assets') return '';
  const selected = ctx.state.selectedContextDeal
    ? '<span>#' + escapeHtml(ctx.state.selectedContextDeal.DealingNumber) + " " +
      escapeHtml(ctx.state.selectedContextDeal.ShopName || "") +
      '<button type="button" data-clear-agent-deal>×</button></span>'
    : "";
  return selected ? '<div class="agent-context-strip">' + selected + '</div>' : '';
}

function agentMessages(ctx, workspace) {
  return historyControls() + '<div class="agent-messages ' + (workspace ? 'is-workspace' : '') + '" data-agent-messages></div>' +
    '<p class="agent-loading" data-agent-loading role="status" aria-live="polite" hidden><span class="agent-status-text" data-agent-status-text></span></p><p class="agent-message-error" data-agent-notice role="status" hidden></p>';
}

function agentComposer(ctx, workspace) {
  return (
    '<div class="agent-input-area"><button class="agent-jump-latest" type="button" data-agent-latest hidden title="' + escapeAttr(agentText(ctx.language, 'latest')) + '" aria-label="' + escapeAttr(agentText(ctx.language, 'latest')) + '">' + icon('descending') + '</button>' +
    '<div class="agent-suggestions-slot"><div class="agent-suggestions">' + agentQuestions(ctx.language).map((question, index) => '<button type="button" data-agent-question="' + index + '" title="' + escapeAttr(question) + '"' + (ctx.state.agentLoading ? ' disabled' : '') + '>' + icon(['transactions', 'insights', 'goals'][index]) + '<span>' + escapeHtml(question) + '</span></button>').join('') + '</div></div>' +
    '<form class="agent-composer ' + (workspace ? "is-workspace" : "") + '" data-agent-form>' +
    '<div class="agent-input-field"><textarea rows="1" name="message" data-agent-input placeholder="' + escapeAttr(text(ctx, "agentPlaceholder")) +
    '" aria-label="' + escapeAttr(text(ctx, 'agentPlaceholder')) + '" maxlength="20000">' + escapeHtml(ctx.state.agentDraft || '') + '</textarea><span class="agent-input-hint" aria-hidden="true"><i></i>' + escapeHtml(text(ctx, 'agentPlaceholder')) + '</span></div>' +
    '<button class="send-button" type="submit" aria-label="' + escapeAttr(text(ctx, "send")) + '"' +
    (ctx.state.agentLoading ? " disabled" : "") + '>' + icon('ascending') + '</button></form></div>'
  );
}

function settingsView(ctx) {
  const { contextAccount, contextRange } = ctx.state.settings;
  const accounts = [...new Set(['all', ...(ctx.accounts || []).map(String), contextAccount].filter(Boolean))];
  const addresses = ctx.state.serviceAddresses;
  return (
    '<section class="page settings-page">' +
    pageHeader(ctx, "settingsKicker", "settings", '', "") + userProfileSettings(ctx) +
    '<form class="settings-form" data-settings-form novalidate><section class="settings-group" aria-labelledby="settings-appearance"><header><h2 id="settings-appearance">' +
    escapeHtml(text(ctx, "settingsAppearance")) + '</h2><span class="settings-behavior">' + escapeHtml(text(ctx, 'settingsImmediate')) + '</span></header>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, "language")) + '</span><select name="language" data-settings-language>' +
    option("zh", "中文", ctx.state.settings.language) + option("ja", "日本語", ctx.state.settings.language) +
    option("en", "English", ctx.state.settings.language) + "</select></label>" +
    themeSwitch(ctx.language, ctx.state.theme) +
    '<div class="financial-color-setting"><label class="setting-switch"><span><strong>' +
    escapeHtml(text(ctx, 'financialColors')) + '</strong><small id="financial-colors-hint">' +
    escapeHtml(text(ctx, 'financialColorsHint')) + '</small></span><input type="checkbox" name="financialColorsReversed" data-finance-colors aria-describedby="financial-colors-hint"' +
    (ctx.state.settings.financialColorsReversed === true ? ' checked' : '') + ' /><i class="switch-track" aria-hidden="true"><b></b></i></label>' +
    '<div class="financial-color-preview"><span data-finance-tone="positive"><i aria-hidden="true"></i>' +
    escapeHtml(text(ctx, 'financialSurplus')) + '</span><span data-finance-tone="negative"><i aria-hidden="true"></i>' +
    escapeHtml(text(ctx, 'financialDeficit')) + '</span></div></div>' +
    '</section><section class="settings-group" aria-labelledby="settings-scope"><header><h2 id="settings-scope">' + escapeHtml(text(ctx, 'dataScope')) + '</h2></header>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, 'primaryCurrency')) + '<small class="settings-behavior">' + escapeHtml(text(ctx, 'settingsOnSave')) + '</small></span><select name="contextCurrency" aria-describedby="primary-currency-hint">' +
    PRIMARY_CURRENCIES.map((currency) => option(currency, text(ctx, 'primaryCurrency' + currency), normalizePrimaryCurrency(ctx.state.settings.contextCurrency))).join('') +
    '</select><small class="primary-currency-hint" id="primary-currency-hint">' + escapeHtml(text(ctx, 'primaryCurrencyHint')) + '</small></label>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, 'scopeRange')) + '<small class="settings-behavior">' + escapeHtml(text(ctx, 'settingsImmediate')) + '</small></span><select name="contextRange" data-context-range>' +
    option('today', text(ctx, 'today'), contextRange) + option('month', text(ctx, 'thisMonth'), contextRange) +
    option('7d', text(ctx, 'last7Days'), contextRange) + option('30d', text(ctx, 'last30Days'), contextRange) +
    option('all', text(ctx, 'allTime'), contextRange) + '</select></label>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, 'scopeAccount')) + '<small class="settings-behavior">' + escapeHtml(text(ctx, 'settingsImmediate')) + '</small></span><select name="contextAccount" data-context-account>' +
    accounts.map((account) => option(account, reportAccountLabel(ctx, account), contextAccount)).join('') +
    '</select></label></section>' +
    // Technical settings stay in the form (so saving and dirty checks still see them) but start collapsed.
    '<details class="settings-fold" data-settings-fold' + (ctx.state.settingsFold === true || (ctx.state.runtimeSettings && runtimeDirty(ctx.state.runtimeSettings)) ? ' open' : '') +
    '><summary><span><strong class="settings-fold-title">' + escapeHtml(text(ctx, 'settingsTechnical')) + '</strong><small>' +
    escapeHtml(text(ctx, 'settingsTechnicalHint')) + '</small></span></summary><div class="settings-fold-body">' +
    '<section class="settings-group" aria-labelledby="settings-connections"><header><h2 id="settings-connections">' +
    escapeHtml(text(ctx, 'settingsConnections')) + '</h2><span class="settings-behavior">' + escapeHtml(text(ctx, 'settingsOnSave')) + '</span></header><p class="runtime-note">' +
    escapeHtml(runtimeText(ctx.language, addresses ? 'launcherHint' : 'localHint')) + '</p>' +
    // Behind the paired local proxy the launcher fixes the services, so the addresses are shown, not edited.
    (addresses ? '<dl class="service-addresses">' + [['backend', 'backendAddress'], ['agent', 'agentAddress']].map(([key, label]) =>
      '<div><dt>' + escapeHtml(text(ctx, label)) + '</dt><dd data-service-address="' + key + '">' + escapeHtml(addresses[key] || '…') + '</dd></div>').join('') + '</dl>'
    : '<label class="field"><span>' + escapeHtml(text(ctx, "backendAddress")) + '</span><input name="backendPath" value="' +
    escapeAttr(ctx.state.settings.backendPath) + '" placeholder="http://127.0.0.1:8001" /></label>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, "agentAddress")) + '</span><input name="agentPath" value="' +
    escapeAttr(ctx.state.settings.agentPath) + '" placeholder="http://127.0.0.1:8000" /></label>') +
    '<label class="field"><span>' + escapeHtml(text(ctx, "syncInterval")) + '</span><select name="autoSyncMs">' +
    option("5000", "5 s", ctx.state.settings.autoSyncMs) + option("8000", "8 s", ctx.state.settings.autoSyncMs) +
    option("15000", "15 s", ctx.state.settings.autoSyncMs) + option("30000", "30 s", ctx.state.settings.autoSyncMs) +
    '</select></label><div class="settings-connection-check"><div class="connection-results"><span>' +
    statusDot(ctx.state.status.backend) + escapeHtml(text(ctx, "backend")) + '</span><span>' +
    statusDot(ctx.state.status.agent, true) + 'Agent</span></div><button class="button" type="button" data-test-services>' +
    escapeHtml(text(ctx, "testConnection")) + '</button></div></section>' + gmailSettingsView(ctx) + fullMailImportView(ctx) + runtimeSettingsView(ctx) +
    '<section class="settings-group" aria-labelledby="settings-advanced"><header><h2 id="settings-advanced">' +
    escapeHtml(text(ctx, 'settingsAdvanced')) + '</h2><span class="settings-behavior">' + escapeHtml(text(ctx, 'settingsOnSave')) + '</span></header><label class="setting-switch"><span><strong>' +
    escapeHtml(text(ctx, "developerMode")) + '</strong><small>' + escapeHtml(text(ctx, "developerModeHint")) +
    '</small></span><input type="checkbox" name="developerMode"' + (ctx.state.settings.developerMode ? " checked" : "") +
    ' /><i class="switch-track" aria-hidden="true"><b></b></i></label></section></div></details>' + settingsSaveView(ctx) + '</form>' + shutdownSettingsView(ctx) + '</section>'
  );
}

function promptView(ctx) {
  const detail = ctx.state.promptDetail;
  return (
    '<section class="page prompt-page">' +
    pageHeader(ctx, "promptKicker", "promptTitle", text(ctx, "promptBrief"), "") +
    '<div class="prompt-layout"><aside class="prompt-list-panel"><header><h2>' +
    escapeHtml(text(ctx, "promptList")) + '</h2><button class="icon-button" type="button" data-refresh-prompts>' +
    icon("refresh") + "</button></header><div class=\"prompt-list\">" +
    (ctx.state.promptList?.length
      ? ctx.state.promptList.map((prompt) =>
        '<button class="' + (ctx.state.promptSelectedName === prompt.name ? "is-active" : "") +
        '" type="button" data-select-prompt="' + escapeAttr(prompt.name) + '"><strong>' +
        escapeHtml(prompt.name) + '</strong><span>' + escapeHtml(prompt.description || "") + "</span></button>",
      ).join("")
      : '<p class="empty-copy">' + escapeHtml(ctx.state.promptLoading ? text(ctx, "loading") : text(ctx, "noRows")) + "</p>") +
    "</div></aside><section class=\"prompt-editor-panel\">" +
    (detail ? promptEditor(ctx, detail) : '<div class="empty-report"><p>' + escapeHtml(text(ctx, "selectPrompt")) + "</p></div>") +
    "</section></div></section>"
  );
}

function promptEditor(ctx, detail) {
  return (
    '<form data-prompt-form><header class="prompt-editor-head"><div><h2>' +
    escapeHtml(detail.name) + '</h2></div><button class="button primary" type="submit">' +
    escapeHtml(text(ctx, "save")) + "</button></header>" +
    '<div class="prompt-fields"><label class="field"><span>' + escapeHtml(text(ctx, "description")) +
    '</span><input name="description" value="' + escapeAttr(detail.description || "") + '" /></label>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, "model")) + '</span><input name="model" value="' +
    escapeAttr(detail.model || "") + '" /></label>' +
    '<label class="field full"><span>' + escapeHtml(text(ctx, "inputVariables")) + '</span><textarea name="input_variables" rows="4">' +
    escapeHtml((detail.input_variables || []).join("\n")) + "</textarea></label>" +
    '<label class="field full prompt-body-field"><span>' + escapeHtml(text(ctx, "promptBody")) +
    '</span><textarea name="prompt" rows="22">' + escapeHtml(detail.prompt || "") + "</textarea></label></div>" +
    '<section class="readonly-grid"><p class="section-label">' + escapeHtml(text(ctx, "readonlyFields")) +
    "</p>" + readonlyItem(ctx, "fileName", detail.file_name) + readonlyItem(ctx, "promptType", detail.prompt_type) +
    readonlyItem(ctx, "sourceFile", detail.source_file) + readonlyItem(ctx, "sourceSymbol", detail.source_symbol) +
    "</section></form>"
  );
}

function readonlyItem(ctx, key, value) {
  return '<div><span>' + escapeHtml(text(ctx, key)) + '</span><code>' + escapeHtml(value || "—") + "</code></div>";
}

function systemView(ctx) {
  const shopActive = ctx.state.systemTab === "shop";
  return (
    '<section class="page system-page">' +
    pageHeader(ctx, "systemKicker", "systemTitle", text(ctx, "systemBrief"), "") +
    '<div class="segmented-control"><button type="button" class="' + (shopActive ? "is-active" : "") +
    '" data-system-tab="shop">' + escapeHtml(text(ctx, "shopNameTable")) + '</button><button type="button" class="' +
    (!shopActive ? "is-active" : "") + '" data-system-tab="unknown">' + escapeHtml(text(ctx, "unknownShopTable")) +
    "</button></div>" +
    '<section class="system-table-section">' + (shopActive ? shopSystemTable(ctx) : unknownSystemTable(ctx)) + "</section></section>"
  );
}

function systemSearch(ctx, fields) {
  return (
    '<form class="system-search" data-system-search>' +
    fields.map((field) =>
      '<label><span>' + escapeHtml(text(ctx, field.key)) + '</span><input name="' + escapeAttr(field.name) +
      '" value="' + escapeAttr(field.value || "") + '" /></label>',
    ).join("") +
    '<button class="button primary" type="submit">' + escapeHtml(text(ctx, "search")) +
    '</button><button class="button" type="button" data-reset-system-search>' + escapeHtml(text(ctx, "reset")) +
    "</button></form>"
  );
}

function shopSystemTable(ctx) {
  const rows = ctx.filteredShopRows;
  return (
    systemSearch(ctx, [
      { key: "key", name: "key", value: ctx.state.systemSearch.shop.key },
      { key: "merchant", name: "ShopName", value: ctx.state.systemSearch.shop.ShopName },
      { key: "mainCategory", name: "MainCategory", value: ctx.state.systemSearch.shop.MainCategory },
      { key: "subCategory", name: "SubCategory", value: ctx.state.systemSearch.shop.SubCategory },
    ]) +
    systemBulkBar(ctx, "shop") +
    '<div class="table-scroll"><table class="compact-table system-table"><thead><tr><th><input type="checkbox" data-system-select-all="shop" /></th><th>' +
    escapeHtml(text(ctx, "key")) + "</th><th>" + escapeHtml(text(ctx, "merchant")) + "</th><th>" +
    escapeHtml(text(ctx, "mainCategory")) + "</th><th>" + escapeHtml(text(ctx, "subCategory")) +
    "</th><th>" + escapeHtml(text(ctx, "actions")) + "</th></tr></thead><tbody>" +
    (rows.length ? rows.map((row) => {
      const key = String(row.key || "");
      const selected = ctx.state.systemSelected.shop.has(key);
      return (
        '<tr><td><input type="checkbox" data-system-select="shop" value="' + escapeAttr(key) + '"' +
        (selected ? " checked" : "") + " /></td>" +
        systemEditableCell("shop", key, "key", row.key) +
        systemEditableCell("shop", key, "ShopName", row.ShopName) +
        systemEditableCell("shop", key, "MainCategory", row.MainCategory) +
        systemEditableCell("shop", key, "SubCategory", row.SubCategory) +
        '<td><button class="button compact danger-quiet" type="button" data-delete-system="shop" data-key="' +
        escapeAttr(key) + '">' + escapeHtml(text(ctx, "delete")) + "</button></td></tr>"
      );
    }).join("") : '<tr><td colspan="6">' + escapeHtml(text(ctx, "noRows")) + "</td></tr>") +
    "</tbody></table></div>"
  );
}

function unknownSystemTable(ctx) {
  const rows = ctx.filteredUnknownRows;
  return (
    systemSearch(ctx, [{ key: "merchant", name: "TitleValue", value: ctx.state.systemSearch.unknown.TitleValue }]) +
    systemBulkBar(ctx, "unknown") +
    '<div class="table-scroll"><table class="compact-table system-table"><thead><tr><th><input type="checkbox" data-system-select-all="unknown" /></th><th>' +
    escapeHtml(text(ctx, "unknownShopTable")) + "</th><th>" + escapeHtml(text(ctx, "actions")) +
    "</th></tr></thead><tbody>" +
    (rows.length ? rows.map((row) => {
      const value = String(row.TitleValue || row.title_value || row);
      const selected = ctx.state.systemSelected.unknown.has(value);
      return (
        '<tr><td><input type="checkbox" data-system-select="unknown" value="' + escapeAttr(value) + '"' +
        (selected ? " checked" : "") + " /></td>" +
        systemEditableCell("unknown", value, "TitleValue", value) +
        '<td><button class="button compact danger-quiet" type="button" data-delete-system="unknown" data-key="' +
        escapeAttr(value) + '">' + escapeHtml(text(ctx, "delete")) + "</button></td></tr>"
      );
    }).join("") : '<tr><td colspan="3">' + escapeHtml(text(ctx, "noRows")) + "</td></tr>") +
    "</tbody></table></div>"
  );
}

function systemEditableCell(table, key, field, value) {
  return '<td><button class="editable-value" type="button" data-edit-system="' + escapeAttr(table) +
    '" data-key="' + escapeAttr(key) + '" data-field="' + escapeAttr(field) + '">' +
    escapeHtml(value || "—") + "</button></td>";
}

function systemBulkBar(ctx, table) {
  const count = ctx.state.systemSelected[table].size;
  if (!count) return "";
  return '<div class="system-bulk-bar"><span>' + escapeHtml(text(ctx, "selected", { count })) +
    '</span><button class="button danger" type="button" data-delete-system-selected="' + escapeAttr(table) + '">' +
    escapeHtml(text(ctx, "deleteSelected")) + "</button></div>";
}

export function modalMarkup(ctx) {
  const modal = ctx.state.modal;
  if (!modal) return "";
  let content = "";
  if (modal.type === "transaction") content = transactionModal(ctx, modal.data);
  else if (modal.type === "deal-detail") content = dealDetailModal(ctx, modal.data);
  else if (modal.type === "goal") content = goalModal(ctx, modal.data);
  else if (modal.type === "merchant-map") content = merchantMapModal(ctx, modal.data);
  else if (modal.type === 'category-icon') content = categoryIconPickerMarkup(modal.data, ctx.state.categoryIcons, ctx.language, ctx.state.categoryIconScope === 'category', modal.iconDraft);
  else if (modal.type.startsWith('asset-')) content = assetModalContent(ctx, { modalHeader });
  const assetModal = modal.type.startsWith('asset-');
  const categoryModal = modal.type === 'category-icon';
  return '<div class="modal-backdrop' + (categoryModal ? ' category-icon-backdrop' : '') + '" data-close-modal><section class="modal-sheet' + (assetModal ? ' asset-preview-modal' : categoryModal ? ' category-icon-modal' : '') +
    '" role="dialog" aria-modal="true"' + (assetModal ? ' aria-label="' + escapeAttr(text(ctx, 'assets')) + '"' : categoryModal ? ' aria-labelledby="category-icon-title"' : '') + ' data-modal-sheet>' +
    '<button class="icon-button modal-close" type="button" data-close-modal aria-label="' + escapeAttr(text(ctx, 'close')) + '">' + icon("close") + "</button>" +
    content + "</section></div>";
}

function modalHeader(ctx, kicker, title, body) {
  return '<header class="modal-header"><p class="section-label">' + escapeHtml(kicker) + '</p><h2>' +
    escapeHtml(title) + '</h2>' + (body ? '<p>' + escapeHtml(body) + "</p>" : "") + "</header>";
}

function transactionModal(ctx, data = {}) {
  data = data ?? {};
  const editing = data.DealingNumber !== undefined && data.DealingNumber !== null && data.DealingNumber !== "";
  const categories = ctx.categoryOptions.map((item) => '<option value="' + escapeAttr(item) + '"></option>').join("");
  const subs = ctx.subcategoryOptions.map((item) => '<option value="' + escapeAttr(item) + '"></option>').join("");
  return (
    modalHeader(ctx, "TRANSACTION", editing ? text(ctx, "edit") : text(ctx, "addTransaction"), "") +
    '<form class="modal-form" data-create-transaction' + (editing ? ' data-edit-id="' + escapeAttr(data.DealingNumber) + '"' : "") + '><label class="field"><span>' +
    escapeHtml(text(ctx, "merchant")) + '</span><input name="shop_name" value="' + escapeAttr(data.ShopName || "") +
    '" required autofocus /></label><label class="field"><span>' + escapeHtml(text(ctx, "amount")) +
    '</span><input type="number" step="0.01" name="price" value="' + escapeAttr(data.price || "") +
    '" required /></label><label class="field"><span>Currency</span><select name="CurrencyTypeNumber">' +
    option("101", "JPY", data.CurrencyTypeNumber || 101) + option("100", "CNY", data.CurrencyTypeNumber || 101) +
    '</select></label><label class="field"><span>' + escapeHtml(text(ctx, "date")) +
    '</span><input type="datetime-local" name="isotime" value="' +
    escapeAttr(datetimeInputValue(data.ISOtime || new Date())) + '" required /></label><label class="field"><span>' +
    escapeHtml(text(ctx, "mainCategory")) + '</span><input list="modal-main-categories" name="main_category" value="' +
    escapeAttr(data.MainCategory || "") + '" /></label><label class="field"><span>' +
    escapeHtml(text(ctx, "subCategory")) + '</span><input list="modal-sub-categories" name="sub_category" value="' +
    escapeAttr(data.SubCategory || "") + '" /></label><label class="field"><span>' +
    escapeHtml(text(ctx, "account")) + '</span><input name="AccountNumber" list="transaction-account-options" value="' +
    escapeAttr(data.AccountNumber || (ctx.state.settings.contextAccount === "all" ? "" : ctx.state.settings.contextAccount)) +
    '" /></label><datalist id="transaction-account-options">' + ctx.state.assets.accounts.map((account) => '<option value="' + account.account_number + '">' + escapeHtml(account.name + ' · ' + account.currency) + '</option>').join('') +
    '</datalist><label class="field"><span>' + escapeHtml(text(ctx, 'assetSettled')) + '</span><input name="settled_amount" inputmode="decimal" /><small>' +
    escapeHtml(text(ctx, 'assetSettlementHint')) + '</small></label><datalist id="modal-main-categories">' + categories +
    '</datalist><datalist id="modal-sub-categories">' + subs +
    '</datalist><footer><button class="button" type="button" data-close-modal>' + escapeHtml(text(ctx, "cancel")) +
    '</button><button class="button primary" type="submit">' + escapeHtml(text(ctx, editing ? "save" : "create")) +
    "</button></footer></form>"
  );
}

function dealDetailModal(ctx, deal) {
  if (!deal) return "";
  const history = ctx.state.editHistory[String(deal.DealingNumber)] || [];
  const adrRows = ctx.state.adrByDeal[String(deal.DealingNumber)] || [];
  return (
    modalHeader(ctx, "TRANSACTION / #" + deal.DealingNumber, deal.ShopName || "—", "") +
    '<div class="detail-sections"><section><p class="section-label">' + escapeHtml(text(ctx, "normalizedData")) +
    '</p><dl class="detail-grid">' + detailItem(ctx, "date", formatDateTime(deal.ISOtime, ctx.language)) +
    '<div><dt>' + escapeHtml(text(ctx, 'amount')) + '</dt><dd><span' + transactionAmountAttrs(ctx, deal.price, deal.CurrencyTypeNumber) + '>' +
    escapeHtml(formatAmount(deal.price, deal.CurrencyTypeNumber, ctx.language)) + '</span></dd></div>' +
    detailItem(ctx, "account", "#" + deal.AccountNumber) + detailItem(ctx, "id", "#" + deal.DealingNumber) +
    "</dl></section><section><p class=\"section-label\">" + escapeHtml(text(ctx, "classification")) +
    '</p><div class="category-pair">' + [deal.MainCategory, deal.SubCategory, deal.DetailCategory].filter(Boolean).map((item) =>
      '<span class="category-tag">' + escapeHtml(item) + "</span>",
    ).join("") + "</div></section>" +
    (adrRows.length ? '<section><p class="section-label">ADR</p><div class="detail-adr-list">' +
      adrRows.map((row) => '<div><strong>' + escapeHtml(row.ProductName || row.ShopName || "—") +
        '</strong><span' + transactionAmountAttrs(ctx, row.price, row.CurrencyTypeNumber ?? deal.CurrencyTypeNumber) + '>' +
        escapeHtml(formatAmount(row.price, row.CurrencyTypeNumber ?? deal.CurrencyTypeNumber, ctx.language)) +
        "</span></div>").join("") + "</div></section>" : "") +
    '<section><p class="section-label">' + escapeHtml(text(ctx, "changeHistory")) + "</p>" +
    (history.length ? '<div class="history-list">' + history.map((item) =>
      '<div><time>' + escapeHtml(formatDateTime(item.timestamp, ctx.language)) + '</time><p>' +
      escapeHtml(item.field + ": " + item.before + " → " + item.after) + "</p></div>",
    ).join("") + "</div>" : '<p class="empty-copy">' + escapeHtml(text(ctx, "noHistory")) + "</p>") +
    "</section></div><footer class=\"modal-footer\"><button class=\"button\" type=\"button\" data-edit-modal-deal=\"" +
    escapeAttr(deal.DealingNumber) + '">' + escapeHtml(text(ctx, "edit")) + "</button></footer>"
  );
}

function detailItem(ctx, key, value) {
  return '<div><dt>' + escapeHtml(text(ctx, key)) + '</dt><dd>' + escapeHtml(value) + "</dd></div>";
}

function goalModal(ctx, goal = {}) {
  goal = goal ?? {};
  return (
    modalHeader(ctx, "GOAL", goal.id ? text(ctx, "edit") : text(ctx, "newGoal"), "") +
    '<form class="modal-form" data-goal-form><input type="hidden" name="id" value="' + escapeAttr(goal.id || "") +
    '" /><label class="field full"><span>' + escapeHtml(text(ctx, "goalName")) +
    '</span><input name="name" value="' + escapeAttr(goal.name || "") + '" required autofocus /></label>' +
    '<label class="field"><span>' + escapeHtml(text(ctx, "targetAmount")) +
    '</span><input type="number" step="1" name="targetAmount" value="' + escapeAttr(goal.targetAmount || "") +
    '" required /></label><label class="field"><span>' + escapeHtml(text(ctx, "currentAmount")) +
    '</span><input type="number" step="1" name="currentAmount" value="' + escapeAttr(goal.currentAmount || 0) +
    '" /></label><label class="field"><span>' + escapeHtml(text(ctx, "monthlyContribution")) +
    '</span><input type="number" step="1" name="monthlyContribution" value="' +
    escapeAttr(goal.monthlyContribution || "") + '" /></label><label class="field"><span>' +
    escapeHtml(text(ctx, "deadline")) + '</span><input type="date" name="deadline" value="' +
    escapeAttr(dateInputValue(goal.deadline || new Date(new Date().setFullYear(new Date().getFullYear() + 1)))) +
    '" /></label><label class="setting-switch full"><span><strong>' + escapeHtml(text(ctx, "primaryGoal")) +
    '</strong></span><input type="checkbox" name="primary"' + (goal.primary ? " checked" : "") +
    ' /><i class="switch-track"><b></b></i></label><footer><button class="button" type="button" data-close-modal>' +
    escapeHtml(text(ctx, "cancel")) + '</button><button class="button primary" type="submit">' +
    escapeHtml(text(ctx, "save")) + "</button></footer></form>"
  );
}

function merchantMapModal(ctx, title) {
  return (
    modalHeader(ctx, "REVIEW", text(ctx, "mapMerchant"), title) +
    '<form class="modal-form" data-merchant-map-form><input type="hidden" name="unknown" value="' +
    escapeAttr(title) + '" /><label class="field"><span>' + escapeHtml(text(ctx, "key")) +
    '</span><input name="key" value="' + escapeAttr(title) + '" required /></label><label class="field"><span>' +
    escapeHtml(text(ctx, "merchant")) + '</span><input name="ShopName" value="' + escapeAttr(title) +
    '" required /></label><label class="field"><span>' + escapeHtml(text(ctx, "mainCategory")) +
    '</span><input name="MainCategory" required /></label><label class="field"><span>' +
    escapeHtml(text(ctx, "subCategory")) + '</span><input name="SubCategory" required /></label><footer>' +
    '<button class="button" type="button" data-close-modal>' + escapeHtml(text(ctx, "cancel")) +
    '</button><button class="button primary" type="submit">' + escapeHtml(text(ctx, "save")) +
    "</button></footer></form>"
  );
}
