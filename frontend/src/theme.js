import { STORAGE } from './config.js';
import { escapeAttr, escapeHtml } from './utils.js';

const copy = {
  zh: { appearance: '外观模式', light: '日间模式', dark: '夜间模式', lightAction: '切换到日间模式', darkAction: '切换到夜间模式', },
  ja: { appearance: '表示モード', light: 'ライトモード', dark: 'ダークモード', lightAction: 'ライトモードに切り替え', darkAction: 'ダークモードに切り替え', },
  en: { appearance: 'Appearance', light: 'Light mode', dark: 'Dark mode', lightAction: 'Switch to light mode', darkAction: 'Switch to dark mode', },
};

export const normalizeTheme = value => value === 'light' ? 'light' : 'dark';
export const nextTheme = value => normalizeTheme(value) === 'dark' ? 'light' : 'dark';
export function readTheme(storage) {
  try { return normalizeTheme(JSON.parse((storage || globalThis.localStorage).getItem(STORAGE.theme))); }
  catch { return 'dark'; }
}
export function themeLabels(language, theme) {
  const labels = copy[language] || copy.en, next = nextTheme(theme);
  return { label: labels[next], action: labels[next + 'Action'] };
}
export function themeSelect(language, theme) {
  const labels = copy[language] || copy.en;
  return '<label class="field"><span>' + escapeHtml(labels.appearance) + '</span><select name="theme" data-theme-select>' +
    ['light', 'dark'].map(value => '<option value="' + value + '"' + (normalizeTheme(theme) === value ? ' selected' : '') + '>' + escapeHtml(labels[value]) + '</option>').join('') +
    '</select></label>';
}
// Two states with one fixed label: an on/off switch reads faster than a dropdown (on = dark).
export function themeSwitch(language, theme) {
  const labels = copy[language] || copy.en;
  return '<label class="setting-switch"><span><strong>' + escapeHtml(labels.dark) + '</strong></span><input type="checkbox" name="theme" value="dark" data-theme-select' + (normalizeTheme(theme) === 'dark' ? ' checked' : '') +
    ' /><i class="switch-track" aria-hidden="true"><b></b></i></label>';
}
export function themeButton(language, theme, placement = 'label') {
  const { label, action } = themeLabels(language, theme);
  const classes = placement === 'dock' ? 'scroll-dock-button' : placement === 'icon' ? 'icon-button' : 'nav-link';
  const trigger = placement === 'dock' ? 'data-dock-action="theme" data-toggle-theme' : 'data-toggle-theme';
  return '<button class="' + classes + ' theme-toggle" type="button" ' + trigger + ' title="' + escapeAttr(action) + '" aria-label="' + escapeAttr(action) + '">' +
    '<span class="theme-icon" aria-hidden="true"><svg class="icon theme-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"></path></svg>' +
    '<svg class="icon theme-moon" viewBox="0 0 24 24"><path d="M20.5 13.2A8.6 8.6 0 0 1 10.8 3.5a8.7 8.7 0 1 0 9.7 9.7Z"></path></svg></span>' +
    (placement === 'label' ? '<span class="nav-label" data-theme-label>' + escapeHtml(label) + '</span>' : '') + '</button>';
}
export function applyTheme(value, language = 'zh', doc = globalThis.document) {
  const theme = normalizeTheme(value);
  if (!doc) return theme;
  doc.documentElement.dataset.theme = theme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f8f9fb' : '#0b0c0e');
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  doc.querySelectorAll('[data-theme-icon]').forEach(link => {
    const href = link.getAttribute('data-' + theme + '-href');
    if (href && link.getAttribute('href') !== href) link.setAttribute('href', href);
  });
  const { label, action } = themeLabels(language, theme);
  doc.querySelectorAll('[data-toggle-theme], [data-dock-action="theme"]').forEach(button => {
    button.title = action;
    button.setAttribute('aria-label', action);
    const text = button.querySelector('[data-theme-label]');
    if (text && text.textContent !== label) text.textContent = label;
  });
  doc.querySelectorAll('[data-theme-select]').forEach(control => {
    if (control.type === 'checkbox') control.checked = theme === 'dark';
    else if (control.value !== theme) control.value = theme;
  });
  return theme;
}
