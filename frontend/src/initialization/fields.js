import { escapeHtml } from '../utils.js';
export const e = value => escapeHtml(String(value ?? ''));
export const button = (label, action, className = '') => `<button type="button" class="setup-button ${className}" data-setup-action="${action}">${e(label)}</button>`;
export const field = (label, name, value = '', attributes = '') => `<label class="setup-field"><span>${e(label)}</span><input name="${e(name)}" value="${e(value)}" ${attributes}></label>`;
export const select = (label, name, options) => `<label class="setup-field"><span>${e(label)}</span><select name="${e(name)}">${options}</select></label>`;
export const option = (value, title, selected) => `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(title)}</option>`;
