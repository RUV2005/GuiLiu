import { ApiClient } from '../api.js';
import { DEFAULT_SETTINGS, STORAGE } from '../config.js';
import { escapeHtml, normalizeServiceBase } from '../utils.js';
import { createInitializationApi } from './api.js';
import { createInitializationController } from './controller.js';
import { mountInitializationView } from './view.js';
import { copy } from './copy.js';
import { workspaceLocation } from './startup.js';

const root = document.querySelector('#app');
function settings() {
  const read = key => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
  return { ...DEFAULT_SETTINGS, ...read(STORAGE.legacySettings), ...read(STORAGE.settings) };
}
function savePreference(patch) {
  try { localStorage.setItem(STORAGE.settings, JSON.stringify({ ...settings(), ...patch })); } catch { /* Settings remain usable for this visit. */ }
}
let controller, view, finished = false, preferences = settings();
function mount() {
  controller?.dispose(); view?.dispose();
  view = null;
  root.innerHTML = '<div class="boot-screen"><div class="boot-mark"><img src="/assets/app-icon.svg?v=f9-s4-1" width="48" height="48" alt="" data-brand-theme="dark"><img src="/assets/app-icon-light.svg?v=f9-s4-1" width="48" height="48" alt="" data-brand-theme="light"></div><p>' + escapeHtml(copy(preferences.language, 'checking')) + '</p></div>';
  const queryKey = 'abk-initialization-query:' + preferences.backendPath;
  let query = '';
  try { query = sessionStorage.getItem(queryKey) || ''; } catch { /* Optional, non-secret retry hint. */ }
  controller = createInitializationController({
    api: createInitializationApi(new ApiClient(() => preferences)),
    visible: () => !document.hidden,
    onChange: state => {
      if (!view && (state.status?.initialized === false || state.checkError)) showWizard();
      view?.sync(state);
    },
    onComplete: () => {
      finished = true;
      view?.dispose(); controller.dispose();
      document.removeEventListener('visibilitychange', visible);
      try { sessionStorage.removeItem(queryKey); } catch { /* No completion flag is stored locally. */ }
      location.replace(workspaceLocation(location.hash));
    },
  });
  function showWizard() {
    view = mountInitializationView({ root, controller, language: preferences.language, backendPath: preferences.backendPath,
    local: ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname), query,
    onQuery: value => { try { sessionStorage.setItem(queryKey, value); } catch { /* Never store credentials here. */ } },
    onLanguage: language => { preferences.language = language; savePreference({ language }); },
    onBackend: value => {
      preferences.backendPath = normalizeServiceBase(value, DEFAULT_SETTINGS.backendPath);
      savePreference({ backendPath: preferences.backendPath });
      mount();
    },
    });
  }
  void controller.start();
}
function visible() { if (!document.hidden) void controller.refresh(); }
document.addEventListener('visibilitychange', visible);
window.addEventListener('pagehide', () => { controller?.dispose(); view?.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted && !finished) mount(); });
mount();
