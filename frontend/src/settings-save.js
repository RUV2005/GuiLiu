import { runtimeDirty } from './runtime-settings-model.js';
import { escapeHtml } from './utils.js';
import { t } from './i18n.js';

export function createSettingsSaveController({ state, runtimeSettings, saveCurrency, saveLanguage, persist, changed = () => {} }) {
  const notice = (key, tone = 'error', detail = '') => {
    state.settingsSaveNotice = { key, tone, detail };
    changed();
  };
  async function save(next) {
    if (state.settingsSaving) return false;
    const current = state.settings, runtime = runtimeSettings.activate();
    if (runtime.loading || runtime.saving) { notice('settingsSaveBusy'); return false; }
    const backendChanged = next.backendPath !== current.backendPath;
    const dirty = runtimeDirty(runtime);
    // Runtime drafts belong to the backend that supplied them, never the new address.
    if (backendChanged && (dirty || next.contextCurrency !== current.contextCurrency)) {
      notice('settingsSaveBackendConflict'); return false;
    }
    state.settingsSaving = true;
    state.settingsSaveNotice = null;
    changed();
    let stage = 'runtime';
    try {
      if (dirty && !await runtimeSettings.save()) {
        notice('settingsSaveRuntimeFailed');
        return false;
      }
      if (saveLanguage) await saveLanguage(next.language, next.backendPath);
      stage = 'currency';
      if (next.contextCurrency !== current.contextCurrency) {
        await saveCurrency(next.contextCurrency, next.backendPath);
      }
      stage = 'browser';
      const settings = { ...state.settings, ...next };
      if (!persist(settings)) { notice('settingsSaveLocalFailed'); return false; }
      state.settings = settings;
      notice(backendChanged ? 'settingsSaveConnectionChanged' : !runtime.document ? 'settingsSaveBrowserOnly'
        : dirty ? 'settingsSaveRestart' : 'settingsSaveComplete', backendChanged || !runtime.document ? 'warning' : 'success');
      return true;
    } catch (error) {
      notice(stage === 'currency' ? 'settingsSaveCurrencyFailed' : stage === 'runtime'
        ? 'settingsSaveRuntimeFailed' : 'settingsSaveLocalFailed', 'error', String(error.message || '').slice(0, 1500));
      return false;
    } finally {
      state.settingsSaving = false;
      changed();
    }
  }
  function clearNotice() {
    if (!state.settingsSaving && state.settingsSaveNotice) { state.settingsSaveNotice = null; changed(); }
  }
  return { save, clearNotice };
}

export function settingsSaveView(ctx) {
  const { settingsSaving, settingsSaveNotice: result } = ctx.state;
  const message = result ? t(ctx.language, result.key) + (result.detail ? ' ' + result.detail : '') : '';
  return '<footer class="settings-save" data-settings-save-footer><p class="settings-draft-status" data-settings-dirty role="status" aria-live="polite">' +
    escapeHtml(t(ctx.language, ctx.state.runtimeSettings && runtimeDirty(ctx.state.runtimeSettings) ? 'settingsPending' : 'settingsClean')) + '</p><p class="settings-save-feedback' +
    (result?.tone === 'error' ? ' is-error' : '') + '" role="status" aria-live="polite"' + (message ? '' : ' hidden') + '>' +
    escapeHtml(message) + '</p><button class="button" type="button" data-settings-discard disabled>' + escapeHtml(t(ctx.language, 'discardChanges')) +
    '</button><button class="button primary" type="submit" data-settings-save' + (settingsSaving ? ' disabled' : '') + '>' +
    escapeHtml(t(ctx.language, settingsSaving ? 'saving' : 'saveSettings')) + '</button></footer>';
}

const lockedControls = new WeakMap();
const savedFields = ['backendPath', 'agentPath', 'autoSyncMs', 'contextCurrency', 'developerMode'];
export function settingsFormDirty(form, state) {
  return Boolean(state.runtimeSettings && runtimeDirty(state.runtimeSettings)) || savedFields.some(name => {
    const control = form.querySelector('[name="' + name + '"]');
    if (!control) return false;
    return name === 'developerMode' ? control.checked !== Boolean(state.settings[name])
      : String(control.value).trim() !== String(state.settings[name] ?? '').trim();
  });
}

export function patchSettingsSave(root, ctx) {
  const form = root?.querySelector('[data-settings-form]');
  if (!form) return;
  const dirty = settingsFormDirty(form, ctx.state);
  const draftStatus = form.querySelector('[data-settings-dirty]');
  if (draftStatus) {
    draftStatus.textContent = t(ctx.language, dirty ? 'settingsPending' : 'settingsClean');
    draftStatus.dataset.dirty = String(dirty);
  }
  form.setAttribute('aria-busy', String(Boolean(ctx.state.settingsSaving)));
  for (const control of form.querySelectorAll('input, select, button, textarea')) {
    if (ctx.state.settingsSaving) {
      if (!lockedControls.has(control)) lockedControls.set(control, control.disabled);
      control.disabled = true;
    } else if (lockedControls.has(control)) {
      control.disabled = lockedControls.get(control);
      lockedControls.delete(control);
    }
  }
  // Discard is only offered while something is unsaved (and never during a save).
  const discard = form.querySelector('[data-settings-discard]');
  if (discard) discard.disabled = !dirty || Boolean(ctx.state.settingsSaving);
  const button = form.querySelector('[data-settings-save]');
  if (button) {
    button.disabled = Boolean(ctx.state.settingsSaving);
    button.textContent = t(ctx.language, ctx.state.settingsSaving ? 'saving' : 'saveSettings');
  }
  const feedback = form.querySelector('.settings-save-feedback'), result = ctx.state.settingsSaveNotice;
  if (feedback) {
    feedback.hidden = !result;
    feedback.classList.toggle('is-error', result?.tone === 'error');
    feedback.textContent = result ? t(ctx.language, result.key) + (result.detail ? ' ' + result.detail : '') : '';
  }
}
