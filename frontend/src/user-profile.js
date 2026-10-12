import { escapeHtml as e, escapeAttr as a, currencyName } from './utils.js';
import { t } from './i18n.js';
import { normalizePrimaryCurrency } from './config.js';
import { beginGmailAuthorization } from './initialization/gmail-authorization.js';
import { safeAuthorizationUrl } from './initialization/model.js';

const copy = {
  title: ['Google 账户', 'Google アカウント', 'Google account'],
  authorize: ['同步 Google 资料', 'Google のプロフィールを同期', 'Sync Google profile'],
  note: ['授权后保存名字、头像和 Google ID。请使用已绑定的邮箱，不会重新导入账单。', '認証後に名前・写真・Google ID を保存します。接続済みのメールを使用してください。明細の再取込は行いません。', 'Authorize to save your name, photo and Google ID. Use your linked email; transactions will not be imported again.'],
  waiting: ['请在 Google 页面完成授权。', 'Google のページで認証を完了してください。', 'Complete authorization on Google.'],
  failed: ['无法读取或同步 Google 资料，请重试。', 'プロフィールを取得できません。再試行してください。', 'Could not load or sync your Google profile. Please retry.'],
  expired: ['授权等待已结束，请重新同步。', '認証の待機を終了しました。もう一度同期してください。', 'Authorization wait ended. Please sync again.'],
  saved: ['Google 资料已更新。', 'プロフィールを更新しました。', 'Google profile updated.'],
  missing: ['尚未同步 Google 资料', 'プロフィールは未同期です', 'Google profile not synced'],
  unbound: ['请先在初始化中连接 Gmail。', '初期設定で Gmail に接続してください。', 'Connect Gmail during setup first.'],
  open: ['打开 Google 授权页面', 'Google の認証ページを開く', 'Open Google authorization'],
  noOauth: ['Gmail 目前用应用专用密码连接。同步名字和头像需要 Google 授权，而后端还没有配置 Google 授权应用；不影响读取邮件。', 'Gmail はアプリ パスワードで接続しています。名前と写真の同期には Google 認証が必要ですが、Backend に Google 認証アプリが設定されていません。メールの読み取りには影響しません。', 'Gmail is connected with an app password. Syncing your name and photo needs Google sign-in, which the Backend has not been set up for. Reading mail is unaffected.'],
};
const text = (ctx, key) => copy[key][ctx.language === 'ja' ? 1 : ctx.language === 'en' ? 2 : 0];

export function safeProfilePicture(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['googleusercontent.com', 'ggpht.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : '';
  } catch { return ''; }
}

export function sidebarProfileContent(ctx, fallback = t(ctx.language, 'currencyBasis', {
  spend: 'JPY', asset: currencyName(normalizePrimaryCurrency(ctx.state.settings?.contextCurrency)),
})) {
  const profile = ctx.state.userProfile;
  // Gmail on an app password and 163 carry no Google name or photo; the connected address names the account.
  const name = profile?.name || profile?.email || profile?.mailbox_email || 'Personal';
  const id = profile?.id ? 'ID: ' + profile.id : fallback;
  const picture = safeProfilePicture(profile?.picture);
  return '<span class="profile-avatar"><span aria-hidden="true">' + e([...name][0] || 'P') + '</span>' +
    (picture ? '<img data-profile-image src="' + a(picture) + '" alt="" width="30" height="30" referrerpolicy="no-referrer" />' : '') +
    '</span><span><strong title="' + a(name) + '">' + e(name) + '</strong><small title="' + a(id) + '">' + e(id) + '</small></span>';
}

export function userProfileSettings(ctx) {
  const profile = ctx.state.userProfile, ui = ctx.state.userProfileUi || {};
  const url = safeAuthorizationUrl(ui.url);
  return '<section class="settings-group" data-user-profile-settings aria-labelledby="settings-google-profile">' +
    '<header><h2 id="settings-google-profile">' + e(text(ctx, 'title')) + '</h2></header>' +
    '<p class="runtime-note">' + e(profile?.email || text(ctx, 'unbound')) + '</p>' +
    '<p class="runtime-note">' + e(profile?.id ? (profile.name || '') + ' · ID: ' + profile.id : text(ctx, 'missing')) + '</p>' +
    // Without an OAuth app (Gmail on an app password) the profile cannot be synced; say so instead of failing later.
    '<p class="runtime-note">' + e(text(ctx, profile?.oauth_available === false ? 'noOauth' : 'note')) + '</p>' +
    '<button class="button" type="button" data-profile-authorize' + (ui.busy || ui.waiting || !profile?.email || profile?.oauth_available === false ? ' disabled' : '') + '>' +
    e(text(ctx, 'authorize')) + '</button><p class="runtime-note" role="status" aria-live="polite">' +
    e(ui.message ? text(ctx, ui.message) : '') + '</p>' +
    (url ? '<a href="' + a(url) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' + e(text(ctx, 'open')) + '</a>' : '') + '</section>';
}

export function createUserProfileController({ state, api, context, root = document,
  beginAuthorization = beginGmailAuthorization, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let source = '', generation = 0, loading = null, timer, popup, expires = 0, beforeUpdate;
  const versions = new WeakMap();
  state.userProfileUi = {};
  function activate() {
    const next = api.settings().backendPath;
    if (source === next) return;
    source = next; generation += 1; loading = null; expires = 0;
    clearTimer(timer); popup?.cancel(); popup = null;
    state.userProfile = null; state.userProfileUi = {};
  }
  function patch() {
    for (const [selector, markup] of [
      ['[data-user-profile]', sidebarProfileContent(context())],
      ['[data-user-profile-settings]', userProfileSettings(context())],
    ]) {
      const node = root.querySelector(selector);
      if (!node || versions.get(node) === markup) continue;
      if (selector === '[data-user-profile]') {
        node.innerHTML = markup;
      } else {
        const focused = node.contains(node.ownerDocument.activeElement);
        const template = node.ownerDocument.createElement('template'); template.innerHTML = markup;
        node.replaceChildren(...template.content.firstElementChild.childNodes);
        if (focused) node.querySelector('[data-profile-authorize]')?.focus({ preventScroll: true });
      }
      versions.set(node, markup);
    }
  }
  function schedule() {
    clearTimer(timer);
    if (!state.userProfileUi.waiting) return;
    if (now() >= expires) {
      state.userProfileUi = { message: 'expired' }; patch(); return;
    }
    timer = setTimer(() => void refresh(), Math.min(2500, expires - now()));
  }
  async function refresh() {
    activate();
    if (loading) return loading;
    const version = generation;
    const task = (async () => {
      try {
        const response = await api.getUserProfile();
        if (version !== generation || api.settings().backendPath !== source) return false;
        if (typeof response?.result?.authorized !== 'boolean') throw new Error('Invalid profile');
        state.userProfile = response.result;
        if (state.userProfileUi.waiting && response.result.id && response.result.updated_at !== beforeUpdate) {
          state.userProfileUi = { message: 'saved' }; expires = 0;
        } else if (!state.userProfileUi.waiting) state.userProfileUi.message = '';
        patch(); return true;
      } catch {
        if (version === generation) { state.userProfileUi.message = 'failed'; patch(); }
        return false;
      } finally {
        if (version === generation) { loading = null; schedule(); }
      }
    })();
    loading = task;
    return task;
  }
  async function authorize() {
    activate();
    if (state.userProfileUi.busy || state.userProfileUi.waiting || !state.userProfile?.email || state.userProfile.oauth_available === false) return false;
    const version = generation;
    popup = beginAuthorization({ message: text(context(), 'waiting') });
    state.userProfileUi = { busy: true }; patch();
    beforeUpdate = state.userProfile.updated_at;
    try {
      const response = await api.authorizeUserProfile();
      if (version !== generation || api.settings().backendPath !== source) return false;
      const url = safeAuthorizationUrl(response?.result?.authorization_url);
      if (!url) throw new Error('Invalid authorization URL');
      expires = now() + Math.min(600, Number(response.result.expires_in) || 600) * 1000;
      state.userProfileUi = { waiting: true, message: 'waiting', url };
      popup.navigate(url); patch(); schedule(); return true;
    } catch {
      if (version === generation) { state.userProfileUi = { message: 'failed' }; patch(); }
      return false;
    } finally { popup?.cancel(); popup = null; }
  }
  root.addEventListener('click', event => {
    if (event.target.closest('[data-profile-authorize]:not(:disabled)')) { event.preventDefault(); void authorize(); }
  });
  root.addEventListener('error', event => {
    if (event.target.matches?.('[data-profile-image]')) event.target.remove();
  }, true);
  function mount() { activate(); patch(); }
  function stop() { generation += 1; loading = null; clearTimer(timer); popup?.cancel(); popup = null; }
  return { refresh, authorize, activate, mount, stop };
}
