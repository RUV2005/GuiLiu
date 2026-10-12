import { createRuntimeState, readRuntimeDocument, RUNTIME_FIELDS, runtimeDirty, runtimeDraft, runtimePatch } from './runtime-settings-model.js';
import { runtimeText } from './runtime-settings-copy.js';
import { patchRuntimeSettings } from './runtime-settings-view.js';

export function createRuntimeSettingsController({ state, api, source, context, root = () => document,
  confirm = message => globalThis.confirm(message) }) {
  const scopes = new Map(), mounted = new WeakSet();
  let host;
  function activate() {
    const key = source();
    if (!scopes.has(key)) scopes.set(key, createRuntimeState(key));
    state.runtimeSettings = scopes.get(key);
    return state.runtimeSettings;
  }
  function patch() {
    if (state.route !== 'settings') return false;
    activate();
    return patchRuntimeSettings(root(), context());
  }
  function update(current) { if (current === state.runtimeSettings && current.source === source()) patch(); }
  function failure(error, write = false) {
    const key = error.message === 'invalidResponse' ? 'invalidResponse' : ({ 404: 'missing', 409: 'busy', 422: 'invalid', 503: 'unavailable' })[error.status]
      || (write ? 'saveFailed' : 'loadFailed');
    return { key, detail: key === 'invalidResponse' ? '' : String(error.message || '').slice(0, 1500) };
  }
  async function load({ discard = false } = {}) {
    const current = activate();
    if (state.settingsSaving || current.loading || current.saving || runtimeDirty(current) && !discard) return false;
    if (discard && current.document) current.draft = runtimeDraft(current.document.settings);
    current.loading = true; current.attempted = true; current.error = null; current.fieldErrors = {}; current.notice = ''; update(current);
    const before = { ...current.draft };
    try {
      const doc = readRuntimeDocument(await api.getRuntimeSettings(current.source));
      const next = runtimeDraft(doc.settings);
      // A slow read must not erase typing that began after the request started.
      for (const field of RUNTIME_FIELDS) if (current.draft[field.path] !== before[field.path]) next[field.path] = current.draft[field.path];
      current.document = doc; current.draft = next;
      return true;
    } catch (error) { current.error = failure(error); return false; }
    finally { current.loading = false; update(current); }
  }
  function edit(path, value) {
    const current = activate();
    if (state.settingsSaving || !current.document || current.saving || !RUNTIME_FIELDS.some(field => field.path === path)) return;
    current.draft[path] = value; current.fieldErrors = {}; current.error = null; current.notice = ''; update(current);
  }
  async function save() {
    const current = activate();
    if (!current.document || current.saving || current.loading) return false;
    const { patch: body, errors } = runtimePatch(current);
    current.fieldErrors = errors; current.notice = ''; current.error = null;
    if (Object.keys(errors).length) { current.error = { key: 'validation' }; update(current); return false; }
    if (!Object.keys(body).length) { current.draft = runtimeDraft(current.document.settings); current.notice = 'unchanged'; update(current); return true; }
    current.saving = true; update(current);
    try {
      const doc = readRuntimeDocument(await api.patchRuntimeSettings(body, current.source));
      current.document = doc; current.draft = runtimeDraft(doc.settings); current.notice = 'saved';
      return true;
    } catch (error) { current.error = failure(error, true); return false; }
    finally { current.saving = false; update(current); }
  }
  function discard() {
    const current = activate();
    if (state.settingsSaving || !current.document || current.loading || current.saving) return;
    current.draft = runtimeDraft(current.document.settings); current.error = null; current.fieldErrors = {}; current.notice = ''; update(current);
  }
  function mount() {
    if (state.route !== 'settings') { host = null; return; }
    const current = activate(), next = root().querySelector('[data-runtime-settings]');
    const entered = next !== host; host = next;
    if (!host) return;
    if (!mounted.has(host)) {
      mounted.add(host);
      const input = event => {
        const target = event.target;
        if (target.matches('[data-runtime-field]')) edit(target.dataset.runtimeField, target.type === 'checkbox' ? target.checked : target.value);
      };
      host.addEventListener('input', input); host.addEventListener('change', input);
      host.addEventListener('click', event => {
        if (event.target.closest('[data-runtime-discard]')) discard();
        if (event.target.closest('[data-runtime-reload]')) {
          if (!runtimeDirty(state.runtimeSettings) || confirm(runtimeText(state.settings.language, 'confirmDiscard'))) void load({ discard: true });
        }
      });
    }
    patch();
    if ((entered || !current.attempted) && !runtimeDirty(current) && !current.saving) void load();
  }
  activate();
  return { activate, load, save, edit, discard, mount, patch };
}
