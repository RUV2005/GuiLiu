import { ApiClient } from './api.js';
import { DEFAULT_SETTINGS, STORAGE } from './config.js';
import { escapeHtml } from './utils.js';
import { createInitializationApi } from './initialization/api.js';
import { copy } from './initialization/copy.js';
import { createStartupCheck, setupLocation } from './initialization/startup.js';

const root = document.querySelector('#app');
let startup, workspaceLoading = false;
function settings() {
  const read = key => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
  return { ...DEFAULT_SETTINGS, ...read(STORAGE.legacySettings), ...read(STORAGE.settings) };
}
function begin() {
  startup?.dispose();
  const preferences = settings(), t = key => copy(preferences.language, key);
  document.documentElement.lang = preferences.language === 'zh' ? 'zh-CN' : preferences.language || 'zh-CN';
  function screen(error) {
    const reason = workspaceLoading ? 'appFailed' : error?.status === 404 ? 'endpointMissing'
      : error?.status === 403 ? 'localOnly' : error?.message === 'invalidStatus' ? 'invalidStatus' : 'checkFailed';
    root.innerHTML = `<main class="boot-screen boot-check">
      <div class="boot-mark"><img src="/assets/app-icon.svg?v=f9-s4-1" width="48" height="48" alt="" data-brand-theme="dark"><img src="/assets/app-icon-light.svg?v=f9-s4-1" width="48" height="48" alt="" data-brand-theme="light"></div>
      <p role="${error ? 'alert' : 'status'}">${escapeHtml(t(error ? reason : 'checking'))}</p>
      ${error ? `<div class="button-row"><button class="button" type="button" data-startup-retry>${escapeHtml(t('retry'))}</button><a class="button ghost" href="${escapeHtml(setupLocation(location.hash))}">${escapeHtml(t('connectionSettings'))}</a></div>` : ''}
    </main>`;
    root.querySelector('[data-startup-retry]')?.addEventListener('click', () => {
      if (workspaceLoading) location.reload(); else void startup.run();
    });
  }
  startup = createStartupCheck({
    api: createInitializationApi(new ApiClient(() => preferences)),
    onChecking: () => screen(),
    onReady: async () => {
      workspaceLoading = true;
      startup.dispose();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
      try { await import('./main.js'); } catch (error) { screen(error); }
    },
    onRequired: () => location.replace(setupLocation(location.hash)),
    onError: error => screen(error),
  });
  void startup.run();
}
function leave() { startup?.dispose(); }
function restore(event) { if (event.persisted && !workspaceLoading) begin(); }
window.addEventListener('pagehide', leave);
window.addEventListener('pageshow', restore);
begin();
