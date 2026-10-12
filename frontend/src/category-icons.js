import { escapeAttr, escapeHtml } from './utils.js';

export const CATEGORY_ICON_OPTIONS = [
  ['utensils', '餐饮', '食事', 'Dining'], ['bike', '外卖', '出前', 'Delivery'],
  ['store', '便利店', 'コンビニ', 'Store'], ['coffee', '咖啡', 'コーヒー', 'Coffee'],
  ['cup-soda', '奶茶', 'ミルクティー', 'Milk tea'], ['glass-water', '饮料', '飲み物', 'Drinks'],
  ['carrot', '食材', '食材', 'Groceries'], ['shopping-bag', '购物', '買い物', 'Shopping'],
  ['shopping-cart', '网购', '通販', 'Online shop'], ['building-2', '商场', '百貨店', 'Mall'],
  ['shopping-basket', '杂货', '雑貨', 'Household'], ['package', '日用品', '日用品', 'Essentials'],
  ['train-front', '交通', '交通', 'Transport'], ['house', '房租', '家賃', 'Rent'],
  ['train-front-tunnel', '新干线', '新幹線', 'Bullet train'],
  ['zap', '电费', '電気', 'Electricity'], ['droplets', '水费', '水道', 'Water'], ['utilities', '水电', '水道・電気', 'Utilities'],
  ['flame', '燃气', 'ガス', 'Gas'], ['heart-pulse', '医药', '医療', 'Health'],
  ['pill', '药妆', '薬局', 'Drugstore'], ['shirt', '服装', '衣服', 'Clothing'],
  ['smartphone', '话费', '携帯料金', 'Phone bill'], ['monitor', '数码', 'デジタル', 'Devices'],
  ['gamepad-2', '游戏', 'ゲーム', 'Games'], ['globe', '网络', 'ネット', 'Internet'],
  ['joystick', '电子游戏', 'ビデオゲーム', 'Video games'], ['coins', '游戏充值', 'ゲーム課金', 'Game credit'],
  ['ticket', '会员', '会員', 'Membership'], ['volleyball', '体育用品', 'スポーツ用品', 'Sports'],
  ['dumbbell', '健身', 'ジム', 'Fitness'], ['plane', '旅行', '旅行', 'Travel'],
  ['clapperboard', '娱乐', '娯楽', 'Leisure'], ['mic', '卡拉OK', 'カラオケ', 'Karaoke'],
  ['book-open', '教育', '教育', 'Education'], ['shield-check', '保险', '保険', 'Insurance'],
  ['paw-print', '宠物', 'ペット', 'Pets'], ['gift', '礼物', 'ギフト', 'Gifts'],
  ['landmark', '投资', '投資', 'Investing'], ['banknote', '收入', '収入', 'Income'],
  ['receipt-text', '固定费用', '固定費', 'Fixed costs'],
  ['circle-help', '未分类', '未分類', 'Unclassified'],
];

// Fixed defaults for the existing main/subcategory pairs, independent of list order.
export const CATEGORY_ICON_GROUPS = [
  ['饮食费', '外卖', 'bike'], ['饮食费', '外出就餐', 'utensils'],
  ['饮食费', '食材', 'carrot'], ['饮食费', '咖啡店', 'coffee'],
  ['饮食费', '奶茶', 'cup-soda'], ['饮食费', '饮料', 'glass-water'],
  ['购物', '网购', 'shopping-cart'], ['购物', '商场购物', 'building-2'],
  ['购物', '购物', 'shopping-bag'], ['购物', '电子产品', 'monitor'],
  ['购物', '服装类', 'shirt'], ['购物', '书本', 'book-open'], ['购物', '体育用品', 'volleyball'],
  ['日用杂货', '便利店', 'store'], ['日用杂货', '药妆店', 'pill'],
  ['日用杂货', '日用品', 'package'], ['日用杂货', '日用杂货', 'shopping-basket'], ['日用杂货', '服装类', 'shirt'],
  ['交通费', '交通费', 'train-front'], ['交通费', '新干线', 'train-front-tunnel'],
  ['固定开支', '房租', 'house'], ['固定开支', '电费', 'zap'], ['固定开支', '水费', 'droplets'],
  ['固定开支', '煤气费', 'flame'], ['固定开支', '水电费', 'utilities'],
  ['固定费用', '保险', 'shield-check'], ['固定费用', '健身房', 'dumbbell'], ['固定费用', '手机话费', 'smartphone'],
  ['网络服务', '会员', 'ticket'], ['网络服务', '网络服务', 'globe'],
  ['网络服务', '电子游戏', 'joystick'], ['网络服务', '游戏消费', 'gamepad-2'], ['网络服务', '游戏氪金', 'coins'],
  ['休闲娱乐', '游戏消费', 'gamepad-2'], ['休闲娱乐', '内容消费', 'clapperboard'],
  ['休闲娱乐', '卡拉ok', 'mic'], ['休闲娱乐', '旅行', 'plane'], ['', '购物', 'shopping-bag'],
];
const groupIcons = new Map(CATEGORY_ICON_GROUPS.map(([main, sub, icon]) =>
  [categoryIconTarget({ MainCategory: main, SubCategory: sub }).key, icon]));
export const CATEGORY_ICON_COLORS = [
  ['sage', '灰绿', 'セージ', 'Sage'], ['blue', '灰蓝', 'ブルー', 'Blue'],
  ['rose', '藕粉', 'ローズ', 'Rose'], ['sky', '雾青', 'スカイ', 'Sky'],
  ['gold', '暖金', 'ゴールド', 'Gold'], ['teal', '松绿', 'ティール', 'Teal'],
  ['steel', '钢灰', 'スチール', 'Steel'], ['lilac', '灰紫', 'ライラック', 'Lilac'],
];
const colorNames = new Set(CATEGORY_ICON_COLORS.map(([name]) => name));
const defaultTones = new Map([
  ['sage', ['utensils', 'bike', 'coffee', 'cup-soda', 'glass-water', 'carrot']],
  ['blue', ['shopping-bag', 'shopping-cart', 'building-2', 'monitor', 'shirt', 'book-open', 'volleyball']],
  ['rose', ['store', 'shopping-basket', 'package', 'pill', 'heart-pulse', 'gift', 'paw-print']],
  ['sky', ['train-front', 'train-front-tunnel']], ['gold', ['house', 'zap', 'droplets', 'flame', 'utilities', 'receipt-text']],
  ['teal', ['shield-check', 'dumbbell', 'smartphone', 'banknote', 'landmark']],
  ['steel', ['globe', 'ticket', 'joystick', 'coins', 'circle-help']], ['lilac', ['gamepad-2', 'clapperboard', 'mic', 'plane']],
].flatMap(([tone, names]) => names.map((name) => [name, tone])));

export function categoryIconTone(name) {
  return defaultTones.get(name) || 'steel';
}

const iconNames = new Set(CATEGORY_ICON_OPTIONS.map(([name]) => name));
const AUTOMATIC_ICON = 'auto';
const unclassifiedIconLabels = new Set([
  '', '-', 'unknown', 'unclassified', 'uncategorized', 'uncategorised', 'null', 'none',
  '未分类', '待分类', '未知分类', '未分類', '待分類', '未知分類', '不明', '未设置', '未設定',
]);
const copy = {
  zh: { title: '选择图标', automatic: '自动匹配', scope: '变更范围', changeTransaction: '变更这一笔', changeCategory: '变更所有相同分类', category: '分类', transaction: '此笔交易', saved: '图标已更新', failed: '无法保存图标设置，请检查浏览器存储权限。' },
  ja: { title: 'アイコンを選択', automatic: '自動選択', scope: '変更範囲', changeTransaction: 'この1件を変更', changeCategory: '同じカテゴリを一括変更', category: 'カテゴリ', transaction: 'この取引', saved: 'アイコンを更新しました', failed: 'アイコン設定を保存できません。ブラウザーの保存権限を確認してください。' },
  en: { title: 'Choose an icon', automatic: 'Automatic', scope: 'Apply to', changeTransaction: 'This transaction', changeCategory: 'All in this category', category: 'Category', transaction: 'This transaction', saved: 'Icon updated', failed: 'Could not save icon preferences. Check browser storage permissions.' },
};

const colorCopy = {
  zh: { color: '颜色', defaultColor: '默认配色', apply: '应用', cancel: '取消' },
  ja: { color: 'カラー', defaultColor: '標準カラー', apply: '適用', cancel: 'キャンセル' },
  en: { color: 'Color', defaultColor: 'Default color', apply: 'Apply', cancel: 'Cancel' },
};

export function categoryIconText(language, key) {
  return (copy[language] || copy.zh)[key] ?? (colorCopy[language] || colorCopy.zh)[key];
}

function categoryLabel(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
}

export function categoryIconTarget(deal, scope = 'category') {
  const main = categoryLabel(deal?.MainCategory);
  const sub = categoryLabel(deal?.SubCategory);
  if (scope !== 'transaction' && (main || sub)) return {
    key: JSON.stringify(['category', main.toLowerCase(), sub.toLowerCase()]),
    label: [main, sub].filter(Boolean).join(' / '), scope: 'category',
  };
  const id = String(deal?.DealingNumber ?? '');
  return { key: id ? JSON.stringify(['transaction', id]) : '', label: [id ? '#' + id : '', deal?.ShopName].filter(Boolean).join(' / '), scope: 'transaction' };
}

function iconAppearance(value) {
  // Keep legacy icon-name strings readable alongside the new icon/color pairs.
  if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'icon'))) return null;
  const icon = typeof value === 'string' ? value : value.icon;
  if (!iconNames.has(icon) && icon !== AUTOMATIC_ICON) return null;
  const tone = typeof value === 'object' && Object.hasOwn(value, 'tone') && colorNames.has(value.tone) ? value.tone : null;
  return { icon, tone };
}

export function normalizeCategoryIcons(value) {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, saved] of Object.entries(value)) {
    const appearance = iconAppearance(saved);
    if (key.length > 2048 || !appearance) continue;
    try {
      const parts = JSON.parse(key);
      if (!Array.isArray(parts) || !parts.every((part) => typeof part === 'string')) continue;
      if ((parts[0] === 'category' && parts.length === 3 && (parts[1] || parts[2]) && (iconNames.has(appearance.icon) || appearance.tone)) ||
          (parts[0] === 'transaction' && parts.length === 2 && parts[1])) {
        result[key] = appearance.tone ? appearance : appearance.icon;
      }
    } catch { /* Ignore malformed saved preferences. */ }
  }
  return result;
}

export function withCategoryIconPreference(preferences, deal, name, { syncCategory = false, deals = [], tone = null } = {}) {
  const next = normalizeCategoryIcons(preferences);
  const target = categoryIconTarget(deal, syncCategory ? 'category' : 'transaction');
  const { key } = target;
  if (!key || key.length > 2048 || (name !== null && !iconNames.has(name)) || (tone !== null && !colorNames.has(tone))) return next;
  const appearance = tone ? { icon: name || AUTOMATIC_ICON, tone } : name || AUTOMATIC_ICON;
  if (target.scope === 'category') {
    // Explicit group changes also replace individual choices, including filtered-out rows.
    for (const row of [deal, ...(Array.isArray(deals) ? deals : [])]) {
      if (categoryIconTarget(row).key === key) delete next[categoryIconTarget(row, 'transaction').key];
    }
    if (name === null && tone === null) delete next[key];
    else next[key] = appearance;
  } else {
    // An explicit per-row automatic choice must not inherit a custom category icon.
    next[key] = appearance;
  }
  return next;
}

function preferredCategoryIcon(deal, preferences, syncCategory = false) {
  const category = categoryIconTarget(deal);
  const individualKey = categoryIconTarget(deal, 'transaction').key;
  const keys = syncCategory && category.scope === 'category'
    ? [category.key] : [individualKey, category.key];
  for (const key of keys) {
    const value = iconAppearance(preferences && Object.hasOwn(preferences, key) ? preferences[key] : undefined);
    if (value && (iconNames.has(value.icon) || value.tone || key === individualKey)) return value;
  }
  return undefined;
}

export function categoryIconPickerState(deal, preferences, syncCategory = false, draft = null) {
  const canSync = categoryIconTarget(deal).scope === 'category';
  const synced = canSync && Boolean(syncCategory);
  const target = categoryIconTarget(deal, synced ? 'category' : 'transaction');
  const appearance = draft ? { icon: iconNames.has(draft.icon) ? draft.icon : AUTOMATIC_ICON,
    tone: colorNames.has(draft.tone) ? draft.tone : null } : preferredCategoryIcon(deal, preferences, synced);
  const preferred = appearance?.icon;
  const custom = iconNames.has(preferred);
  const name = custom ? preferred : transactionCategoryIconName(deal);
  return { target, preferred, canSync, syncCategory: synced, custom, name, tone: appearance?.tone || null };
}

export function categoryIconDraft(deal, preferences, syncCategory = false) {
  const picker = categoryIconPickerState(deal, preferences, syncCategory);
  return { icon: picker.custom ? picker.preferred : null, tone: picker.tone };
}

export function updateCategoryIconDraft(modal, field, value) {
  if (modal?.type !== 'category-icon' || !modal.iconDraft) return false;
  if (!['icon', 'tone'].includes(field)) return false;
  if (value !== null && !(field === 'icon' ? iconNames : colorNames).has(value)) return false;
  modal.iconDraft[field] = value;
  modal.iconDraftDirty = true;
  return true;
}

export function normalizeCategoryIconScope(value) {
  return value === 'category' ? 'category' : 'transaction';
}

export function setCategoryIconPickerScope(state, scope) {
  if (state?.modal?.type !== 'category-icon' || !['transaction', 'category'].includes(scope)) return false;
  if (scope === 'category' && categoryIconTarget(state.modal.data).scope !== 'category') return false;
  // Explicit selection is idempotent; choosing a scope never saves icon preferences.
  state.categoryIconScope = scope;
  return true;
}

export function categoryIconStyle(name) {
  return "url('/assets/category-icons/" + (iconNames.has(name) ? name : 'store') + ".svg')";
}

export function categoryIconButtonLabel(deal, language) {
  return categoryIconText(language, 'title') + ': ' + categoryIconTarget(deal).label;
}

// More specific subcategories win; matching never depends on the UI language.
const rules = [
  ['cup-soda', /奶茶|ミルクティー|タピオカ|\b(?:milk tea|bubble tea|boba)\b/],
  ['glass-water', /饮料|飲料|飲み物|ドリンク|\b(?:drinks?|beverages?)\b/],
  ['shopping-cart', /网购|網購|通販|ネットショッピング|\bonline shopping\b/],
  ['building-2', /商场|商場|百貨店|ショッピングモール|\b(?:mall|department store)\b/],
  ['monitor', /电子产品|電子產品|電子機器|家電|\b(?:electronics?|devices?)\b/],
  ['volleyball', /体育用品|體育用品|スポーツ用品|\bsports (?:goods|equipment)\b/],
  ['train-front-tunnel', /新干线|新幹線|\b(?:shinkansen|bullet train|high speed rail)\b/],
  ['utilities', /水电|水電|水道・電気|\butilities\b/],
  ['pill', /药妆|藥妝|ドラッグストア|\bdrugstore\b/],
  ['package', /日用品|\bdaily essentials\b/],
  ['carrot', /食材|\b(?:grocer(?:y|ies)|ingredients?)\b/],
  ['coins', /氪金|游戏充值|遊戲儲值|ゲーム課金|\b(?:game credit|in game purchases?)\b/],
  ['joystick', /电子游戏|電子遊戲|ビデオゲーム|\bvideo games?\b/],
  ['ticket', /会员|會員|会員|\bmemberships?\b/],
  ['bike', /外卖|外賣|出前|宅配|デリバリー|テイクアウト|\b(?:delivery|take ?out|take ?away)\b/],
  ['store', /便利店|便利商店|コンビニ|\bconvenience\b/],
  ['coffee', /咖啡|奶茶|饮料|飲料|飲み物|カフェ|喫茶|ドリンク|\bcaf\u00e9(?![a-z])|\b(?:coffee|cafe|tea|drinks?|beverages?)\b/],
  ['shopping-basket', /食材|食品|超市|スーパー|\b(?:grocer(?:y|ies)|supermarket|ingredients?)\b/],
  ['heart-pulse', /药妆|藥妝|药店|药品|薬|医疗|醫療|医療|病院|診療|健康|ドラッグストア|\b(?:health|medical|pharmacy|drugstore|medicine)\b/],
  ['shirt', /服装|服裝|衣服|衣料|ファッション|\b(?:clothes|clothing|apparel|fashion)\b/],
  ['gamepad-2', /游戏|遊戲|氪金|ゲーム|\b(?:games?|gaming)\b/],
  ['mic', /卡拉|カラオケ|\bkaraoke\b/],
  ['dumbbell', /健身|体育|體育|スポーツ|ジム|フィットネス|\b(?:gym|fitness|sports?|exercise)\b/],
  ['book-open', /书本|書籍|书籍|教育|学费|學費|学費|学习|学習|読書|\b(?:books?|education|tuition|learning|courses?)\b/],
  ['shield-check', /保险|保險|保険|\binsurance\b/],
  ['house', /房租|租房|房贷|房貸|住房|家賃|住宅|\b(?:rent|housing|mortgage)\b/],
  ['zap', /电费|電費|電気|水电|水電|光熱|\b(?:electricity|electric|utilities)\b/],
  ['droplets', /水费|水費|水道|\bwater\b/],
  ['flame', /煤气|煤氣|燃气|燃氣|ガス|\bgas\b/],
  ['smartphone', /手机|手機|话费|話費|电子产品|電子產品|電子機器|携帯|スマホ|家電|デジタル|\b(?:phone|mobile|electronics?|devices?)\b/],
  ['plane', /旅行|旅游|旅遊|航空|机票|機票|ホテル|\b(?:travel|flights?|airfare|hotels?)\b/],
  ['train-front', /交通|地铁|地鐵|地下鉄|新干线|新幹線|電車|バス|タクシー|停车|駐車|\b(?:transport(?:ation)?|transit|trains?|subway|bus|taxi|parking|commute)\b/],
  ['paw-print', /宠物|寵物|ペット|\bpets?\b/],
  ['gift', /礼物|禮物|贈答|ギフト|プレゼント|\b(?:gifts?|presents?|donations?)\b/],
  ['landmark', /投资|投資|股票|基金|黄金|黃金|証券|\b(?:investments?|stocks?|funds?|gold)\b/],
  ['banknote', /收入|給与|給料|工资|工資|仕送り|\b(?:income|salary|wages?|allowance)\b/],
  ['globe', /网络|網絡|網路|ネット|通信|订阅|訂閱|会员|會員|会員|サブスク|\b(?:internet|network|online services?|subscriptions?|memberships?)\b/],
  ['utensils', /饮食|飲食|餐饮|餐飲|吃饭|吃飯|就餐|外食|食事|食費|レストラン|\b(?:food|dining|meals?|restaurants?|eating out)\b/],
  ['clapperboard', /娱乐|娛樂|娯楽|休闲|休閒|内容消费|內容消費|映画|エンタメ|レジャー|\b(?:entertainment|leisure|movies?|cinema|streaming)\b/],
  ['shopping-bag', /购物|購物|网购|網購|商场|商場|買い物|通販|百貨店|\b(?:shopping|retail|purchases?)\b/],
  ['shopping-basket', /日用|日常生活|生活用品|\b(?:daily essentials|household|essentials)\b/],
  ['receipt-text', /固定|\b(?:fixed costs?|fixed expenses?|bills?)\b/],
];

export function transactionCategoryIconName(deal = {}, preferences = {}) {
  const preferred = preferredCategoryIcon(deal, preferences)?.icon;
  if (iconNames.has(preferred)) return preferred;
  if ([deal?.MainCategory, deal?.SubCategory].every((value) => unclassifiedIconLabels.has(categoryLabel(value).toLowerCase()))) return 'circle-help';
  const exact = groupIcons.get(categoryIconTarget(deal).key);
  if (exact) return exact;
  for (const value of [deal?.SubCategory, deal?.MainCategory]) {
    if (typeof value !== 'string') continue;
    const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/[_/-]+/g, ' ');
    const match = rules.find(([, pattern]) => pattern.test(normalized));
    if (match) return match[0];
  }
  return 'store';
}

export function transactionCategoryIconTone(deal, preferences) {
  return preferredCategoryIcon(deal, preferences)?.tone || categoryIconTone(transactionCategoryIconName(deal, preferences));
}

export function categoryIconLabel(name, language) {
  return CATEGORY_ICON_OPTIONS.find(([icon]) => icon === name)?.[{ zh: 1, ja: 2, en: 3 }[language] || 1] || '';
}

export function transactionCategoryIcon(deal, preferences, language = 'zh') {
  const name = transactionCategoryIconName(deal, preferences);
  const label = escapeAttr(categoryIconButtonLabel(deal, language));
  return '<button type="button" class="merchant-category-icon" data-pick-category-icon="' +
    escapeAttr(deal?.DealingNumber ?? '') + '" data-category-icon="' + name +
    '" data-category-tone="' + transactionCategoryIconTone(deal, preferences) + '" aria-haspopup="dialog" aria-label="' + label + '" title="' + label +
    '" style="--merchant-icon: ' + escapeAttr(categoryIconStyle(name)) + '"><span aria-hidden="true"></span></button>';
}

export function categoryIconPickerMarkup(deal, preferences, language = 'zh', syncCategory = false, draft = null) {
  const { target, preferred, custom, canSync, name, tone, syncCategory: synced } = categoryIconPickerState(deal, preferences, syncCategory, draft);
  const automatic = transactionCategoryIconName(deal);
  const glyph = (name) => '<span class="category-option-glyph" data-category-tone="' + (tone || categoryIconTone(name)) +
    '" aria-hidden="true" style="--merchant-icon: ' + escapeAttr(categoryIconStyle(name)) + '"></span>';
  const labelIndex = { zh: 1, ja: 2, en: 3 }[language] || 1;
  return '<header class="category-icon-heading"><h2 id="category-icon-title">' + escapeHtml(categoryIconText(language, 'title')) +
    '</h2><p data-category-icon-scope-label>' + escapeHtml(categoryIconText(language, target.scope) + ': ' + target.label) + '</p></header>' +
    '<div class="category-icon-scope" role="radiogroup" aria-label="' + escapeAttr(categoryIconText(language, 'scope')) +
    '" data-category-icon-scope-control data-scope="' + (synced ? 'category' : 'transaction') + '">' +
    '<span class="category-icon-scope-thumb" aria-hidden="true"></span>' +
    '<button type="button" role="radio" data-category-icon-scope="transaction" aria-checked="' + !synced +
    '" tabindex="' + (synced ? -1 : 0) + '">' + escapeHtml(categoryIconText(language, 'changeTransaction')) + '</button>' +
    '<button type="button" role="radio" data-category-icon-scope="category" aria-checked="' + synced +
    '" tabindex="' + (synced ? 0 : -1) + '"' + (canSync ? '' : ' disabled') + '>' +
    escapeHtml(categoryIconText(language, 'changeCategory')) + '</button></div>' +
    '<div class="category-icon-preview"><span class="category-icon-preview-glyph" data-category-icon-preview data-category-tone="' +
    (tone || categoryIconTone(name)) + '" aria-hidden="true" style="--merchant-icon: ' + escapeAttr(categoryIconStyle(name)) +
    '"><span></span></span><span data-category-icon-preview-label>' + escapeHtml(categoryIconLabel(name, language)) + '</span></div>' +
    '<div class="category-icon-colors" role="group" aria-label="' + escapeAttr(categoryIconText(language, 'color')) + '">' +
    '<div class="category-color-heading"><span>' + escapeHtml(categoryIconText(language, 'color')) + '</span>' +
    '<button type="button" class="category-color-default" data-category-icon-color="" aria-pressed="' + !tone + '">' +
    escapeHtml(categoryIconText(language, 'defaultColor')) + '</button></div>' +
    '<div class="category-color-swatches">' + CATEGORY_ICON_COLORS.map((color) =>
      '<button type="button" class="category-color-swatch" data-category-icon-color="' + color[0] + '" data-category-tone="' + color[0] +
      '" aria-pressed="' + (tone === color[0]) + '" aria-label="' + escapeAttr(color[labelIndex]) + '" title="' +
      escapeAttr(color[labelIndex]) + '"><span aria-hidden="true"></span></button>').join('') + '</div></div>' +
    '<button type="button" class="category-icon-auto" data-category-icon-value="" aria-pressed="' + !custom + '"' +
    (!custom ? ' autofocus' : '') + '>' + glyph(automatic) + '<span>' + escapeHtml(categoryIconText(language, 'automatic')) + '</span></button>' +
    '<div class="category-icon-grid">' + CATEGORY_ICON_OPTIONS.map((option) => {
      const selected = custom && option[0] === preferred;
      return '<button type="button" class="category-icon-option" data-category-icon-value="' + option[0] +
        '" aria-pressed="' + selected + '"' + (selected ? ' autofocus' : '') + '>' + glyph(option[0]) +
        '<span class="category-option-label">' + escapeHtml(option[labelIndex]) + '</span></button>';
    }).join('') + '</div><footer class="category-icon-footer"><button type="button" class="button ghost" data-close-modal>' +
    escapeHtml(categoryIconText(language, 'cancel')) + '</button><button type="button" class="button" data-apply-category-icon>' +
    escapeHtml(categoryIconText(language, 'apply')) + '</button></footer>';
}
