import { escapeAttr, escapeHtml } from './utils.js';
import { RUNTIME_FIELDS, RUNTIME_MODELS, runtimeLabel, runtimeDirty } from './runtime-settings-model.js';
import { runtimeText } from './runtime-settings-copy.js';
import { localizeMarkup } from './language-view.js';
import { patchSettingsSave } from './settings-save.js';
import { t } from './i18n.js';

function inputView(field, state, language) {
  const text = key => runtimeText(language, key), id = 'runtime-' + field.path.replaceAll('.', '-');
  const value = state.draft[field.path], error = state.fieldErrors[field.path];
  const attrs = ' data-runtime-field="' + field.path + '" name="runtime.' + field.path + '" id="' + id +
    '" aria-describedby="' + id + '-error" aria-invalid="' + Boolean(error) + '"';
  const label = escapeHtml(runtimeLabel(field, language));
  const feedback = '<small class="runtime-field-error" id="' + id + '-error" data-runtime-error="' + field.path + '"' +
    (error ? '' : ' hidden') + '>' + escapeHtml(error ? text(error) : '') + '</small>';
  if (field.type === 'boolean') return '<div><label class="setting-switch"><span><strong>' + label +
    '</strong></span><input type="checkbox"' + attrs + (value ? ' checked' : '') +
    ' /><i class="switch-track" aria-hidden="true"><b></b></i></label>' + feedback + '</div>';
  let control;
  if (field.type === 'model' || field.choices) {
    const models = [...new Set([...RUNTIME_MODELS, value].filter(Boolean))];
    control = '<select' + attrs + '>' + models.map(model => '<option value="' + escapeAttr(model) + '"' +
      (model === value ? ' selected' : '') + '>' + escapeHtml(model) + '</option>').join('') + '</select>';
  } else {
    const numeric = ['integer', 'number'].includes(field.type);
    control = '<input type="' + (numeric ? 'number' : 'text') + '"' + attrs + ' value="' + escapeAttr(value ?? '') + '"' +
      (numeric ? ' min="' + (field.min ?? 1) + '" step="' + (field.type === 'integer' ? '1' : 'any') + '"' : '') +
      (field.nullable ? ' placeholder="' + escapeAttr(text('nullable')) + '"' : ' required') + ' />';
  }
  return '<label class="field" for="' + id + '"><span>' + label + '</span>' + control + feedback + '</label>';
}

export function runtimeSettingsView(ctx) {
  const state = ctx.state.runtimeSettings, text = key => runtimeText(ctx.language, key);
  if (!state) return '<section class="runtime-settings" data-runtime-settings></section>';
  const doc = state.document;
  const error = state.error ? text(state.error.key) + (state.error.detail ? ' ' + state.error.detail : '') : '';
  const status = state.saving ? text('saving') : state.loading ? text('loading') : state.notice ? text(state.notice)
    : runtimeDirty(state) ? text('dirty') : '';
  const groups = ['models', 'loop'];
  return '<section class="runtime-settings" data-runtime-settings data-runtime-source="' + escapeAttr(state.source) + '"' +
    ' data-runtime-loaded="' + Boolean(doc) + '"><header class="runtime-heading"><h2>' + escapeHtml(text('title')) +
    '</h2><span class="settings-behavior">' + escapeHtml(t(ctx.language, 'settingsAfterRestart')) + '</span></header>' +
    '<p class="runtime-status" role="status" aria-live="' + (doc ? 'off' : 'polite') + '">' + escapeHtml(status) + '</p>' +
    '<p class="runtime-error" role="alert"' + (error ? '' : ' hidden') + '>' + escapeHtml(error) + '</p>' +
    (doc ? '<div data-runtime-controls><fieldset class="runtime-fields">' + groups.map(group =>
      '<details class="runtime-group"' + (group === 'models' ? ' open' : '') + '><summary>' + escapeHtml(text(group)) + '</summary>' +
      '<div class="runtime-grid">' + RUNTIME_FIELDS.filter(field => field.path.startsWith(group + '.') &&
        !['models.adr', 'models.legacy_adr', 'loop.adr_ocr_limit'].includes(field.path))
        .map(field => inputView(field, state, ctx.language)).join('') + '</div></details>').join('') + '</fieldset></div>' : '') +
    // Saving and discarding live in the page's one save bar. Reload only appears when loading failed, so the
    // section can be read again.
    '<footer class="runtime-actions">' + (doc ? '<div class="runtime-feedback" role="status" aria-live="polite"><p>' + escapeHtml(status) +
      '</p><p class="runtime-error" data-runtime-save-error' + (error ? '' : ' hidden') + '>' + escapeHtml(error) + '</p></div>' :
      '<button type="button" class="button" data-runtime-reload>' + escapeHtml(text('reload')) + '</button>') + '</footer></section>';
}

export function patchRuntimeSettings(root, ctx) {
  const host = root?.querySelector('[data-runtime-settings]'), state = ctx.state.runtimeSettings;
  if (!host || !state) return false;
  const markup = runtimeSettingsView(ctx);
  if (host.dataset.runtimeSource !== state.source || host.dataset.runtimeLoaded !== String(Boolean(state.document))) {
    const template = host.ownerDocument.createElement('template'); template.innerHTML = markup;
    const next = template.content.firstElementChild;
    host.replaceChildren(...next.childNodes);
    host.dataset.runtimeSource = state.source; host.dataset.runtimeLoaded = String(Boolean(state.document));
  } else localizeMarkup(host, markup);
  host.querySelectorAll('.runtime-error').forEach(node => { node.hidden = !state.error; });
  host.querySelectorAll('[data-runtime-error]').forEach(node => { node.hidden = !state.fieldErrors[node.dataset.runtimeError]; });
  host.querySelectorAll('[data-runtime-field]').forEach(node => {
    const value = state.draft[node.dataset.runtimeField];
    if (node.type === 'checkbox') node.checked = value === true;
    else if (node.value !== String(value ?? '')) node.value = String(value ?? '');
    node.setAttribute('aria-invalid', String(Boolean(state.fieldErrors[node.dataset.runtimeField])));
  });
  const fieldset = host.querySelector('.runtime-fields');
  const saving = state.saving || ctx.state.settingsSaving;
  if (fieldset) fieldset.disabled = Boolean(saving);
  const reload = host.querySelector('[data-runtime-reload]');
  if (reload) reload.disabled = Boolean(state.loading || saving);
  host.setAttribute('aria-busy', String(state.loading || state.saving));
  patchSettingsSave(root, ctx);
  return true;
}
