export const DEFAULT_SETTINGS = {
  backendPath: "/backend",
  agentPath: "/agent",
  language: "zh",
  developerMode: false,
  financialColorsReversed: false,
  agentOpen: true,
  agentWidth: 370,
  agentWorkspaceSplit: 62,
  sidebarCollapsed: false,
  autoSyncMs: 8000,
  contextRange: "month",
  contextAccount: "all",
  contextCurrency: "JPY",
};

export const PRIMARY_CURRENCIES = ['JPY', 'RMB'];

export function normalizePrimaryCurrency(value) {
  const code = String(value ?? '').trim().toUpperCase();
  const currency = code === 'CNY' ? 'RMB' : code;
  return PRIMARY_CURRENCIES.includes(currency) ? currency : DEFAULT_SETTINGS.contextCurrency;
}

export const STORAGE = {
  theme: "abk-editorial-theme",
  settings: "abk-editorial-settings",
  legacySettings: "abk-settings",
  chat: "abk-chat-history",
  chatBackup: "abk-chat-history-backup",
  visuals: "abk-agent-visual-panels",
  recurring: "abk-recurring-rules", // Legacy data is retained but no longer executed by this frontend.
  goals: "abk-editorial-goals",
  activity: "abk-editorial-activity",
  reviewDismissed: "abk-editorial-review-dismissed",
  categoryIcons: "abk-editorial-category-icons",
  categoryIconScope: "abk-editorial-category-icon-scope",
  exchangeRates: "abk-exchange-rates",
  editHistory: "abk-editorial-edit-history",
};

// Yen per unit, used until a live quote arrives (then marked as a reference rate).
export const DEFAULT_RATES = {
  JPY: 1,
  RMB: 23.49,
  CNY: 23.49,
  USD: 150,
  updatedAt: "",
  source: "fallback",
};


export const ROUTE_ALIASES = {
  dashboard: "overview",
  deals: "transactions",
  recurring: "overview",
  automation: "overview",
  ai: "agent",
};

export const ROUTES = [
  "overview",
  "assets",
  "transactions",
  "import",
  "review",
  "agent-tasks",
  "goals",
  "insights",
  "agent",
  "settings",
  "dev-prompts",
  "dev-system",
];
