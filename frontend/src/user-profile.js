import { escapeHtml as e, escapeAttr as a } from './utils.js';

const copy = {
  title: ['个人资料', 'プロフィール', 'Profile'],
  avatar: ['头像', 'アイコン', 'Avatar'],
  choose: ['更换头像', 'アイコンを変更', 'Change avatar'],
  remove: ['移除', '削除', 'Remove'],
  id: ['ID', 'ID', 'ID'],
  idPlaceholder: ['AI 会用它称呼你', 'AI がこの名前で呼びかけます', 'The AI calls you by this'],
  save: ['保存', '保存', 'Save'],
  saving: ['正在保存…', '保存中…', 'Saving…'],
  saved: ['已保存', '保存しました', 'Saved'],
  failed: ['保存失败，请重试。', '保存できませんでした。もう一度お試しください。', 'Could not save. Please retry.'],
  badImage: ['无法读取这张图片，请换一张 PNG、JPEG、WebP 或 GIF 图片。', 'この画像は読み込めません。PNG・JPEG・WebP・GIF の画像を選んでください。',
    'This picture cannot be read. Choose a PNG, JPEG, WebP or GIF image.'],
  tooLong: ['ID 最多 32 个字。', 'ID は 32 文字までです。', 'An ID has at most 32 characters.'],
};
const text = (language, key) => copy[key][language === 'ja' ? 1 : language === 'en' ? 2 : 0];
export const ID_MAX = 32;
const AVATAR = /^data:image\/(?:webp|png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/;

export function safeProfilePicture(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['googleusercontent.com', 'ggpht.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : '';
  } catch { return ''; }
}
// The avatar the user set (the Backend re-encodes it); nothing but an inline image is ever shown.
export const safeAvatar = value => typeof value === 'string' && value.length <= 2_000_000 && AVATAR.test(value) ? value : '';
// What GUILIU calls the user: the ID they set, else the Google name or the connected address.
export const profileName = profile => profile?.display_name || profile?.name || profile?.email || profile?.mailbox_email || '';
export const profilePicture = profile => safeAvatar(profile?.avatar) || safeProfilePicture(profile?.picture);

export function avatarMarkup(profile, size, fallback = 'P') {
  const name = profileName(profile), picture = profilePicture(profile);
  return '<span aria-hidden="true">' + e([...(name || fallback)][0] || fallback) + '</span>' +
    (picture ? '<img data-profile-image src="' + a(picture) + '" alt="" width="' + size + '" height="' + size + '" referrerpolicy="no-referrer" />' : '');
}

export function sidebarProfileContent(ctx) {
  const profile = ctx.state.userProfile, name = profileName(profile) || 'Personal';
  return '<span class="profile-avatar">' + avatarMarkup(profile, 30) + '</span><span><strong title="' + a(name) + '">' + e(name) + '</strong></span>';
}

// Settings → Profile: the avatar and the ID, each saved on its own (not by "Save settings").
export function userProfileSettings(ctx) {
  const profile = ctx.state.userProfile, ui = ctx.state.userProfileUi || {}, say = key => text(ctx.language, key);
  const busy = Boolean(ui.busy), hasAvatar = Boolean(safeAvatar(profile?.avatar));
  return '<section class="settings-group profile-settings" data-user-profile-settings aria-labelledby="settings-profile">' +
    '<header><h2 id="settings-profile">' + e(say('title')) + '</h2></header>' +
    '<div class="profile-settings-row"><span class="profile-settings-label">' + e(say('avatar')) + '</span><div class="profile-settings-avatar">' +
    '<span class="profile-avatar profile-avatar-large" data-profile-avatar-preview>' + avatarMarkup(profile, 56) + '</span>' +
    '<button class="button" type="button" data-profile-avatar-choose' + (busy || !profile ? ' disabled' : '') + '>' + e(say('choose')) + '</button>' +
    '<button class="button" type="button" data-profile-avatar-remove' + (busy || !hasAvatar ? ' disabled' : '') + '>' + e(say('remove')) + '</button>' +
    '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-profile-avatar-file hidden /></div></div>' +
    '<div class="profile-settings-row"><label class="profile-settings-label" for="profile-id">' + e(say('id')) + '</label><div class="profile-settings-name">' +
    '<input id="profile-id" data-profile-name maxlength="' + ID_MAX + '" autocomplete="off" spellcheck="false" value="' + a(profile?.display_name || '') +
    '" placeholder="' + a(say('idPlaceholder')) + '"' + (busy || !profile ? ' disabled' : '') + ' />' +
    '<button class="button" type="button" data-profile-name-save disabled>' + e(say('save')) + '</button></div></div>' +
    '<p class="profile-settings-feedback' + (ui.error ? ' is-error' : '') + '" role="status" aria-live="polite">' + e(ui.message ? say(ui.message) : '') + '</p></section>';
}

// A square, small picture to upload; the Backend re-encodes it again.
export async function squareAvatar(file, side = 256) {
  const bitmap = await createImageBitmap(file);
  const crop = Math.min(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: side, height: side });
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side);
  bitmap.close?.();
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

export function createUserProfileController({ state, api, context, root = document, onChange = () => {}, prepareAvatar = squareAvatar }) {
  let source = '', generation = 0, loading = null;
  const versions = new WeakMap();
  state.userProfileUi = {};
  function activate() {
    const next = api.settings().backendPath;
    if (source === next) return;
    source = next; generation += 1; loading = null;
    state.userProfile = null; state.userProfileUi = {};
  }
  function patch() {
    const node = root.querySelector('[data-user-profile]'), markup = sidebarProfileContent(context());
    if (node && versions.get(node) !== markup) { node.innerHTML = markup; versions.set(node, markup); }
    const card = root.querySelector('[data-user-profile-settings]');
    if (!card) return;
    // Rebuild the card but keep an ID being typed (and its focus) as it is.
    const input = card.querySelector('[data-profile-name]'), typing = input && (input === card.ownerDocument.activeElement || input.dataset.edited === 'true');
    const draft = input?.value, html = userProfileSettings(context());
    if (versions.get(card) === html) return;
    const template = card.ownerDocument.createElement('template'); template.innerHTML = html;
    card.replaceChildren(...template.content.firstElementChild.childNodes);
    versions.set(card, html);
    const fresh = card.querySelector('[data-profile-name]');
    if (typing && fresh) { fresh.value = draft; fresh.dataset.edited = 'true'; if (input === card.ownerDocument.activeElement) fresh.focus({ preventScroll: true }); }
    syncNameButton(card);
  }
  function syncNameButton(card) {
    const input = card.querySelector('[data-profile-name]'), button = card.querySelector('[data-profile-name-save]');
    if (!input || !button) return;
    button.disabled = Boolean(state.userProfileUi.busy) || input.value.trim() === (state.userProfile?.display_name || '');
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
        const before = [state.userProfile?.display_name, state.userProfile?.avatar].join('\0');
        state.userProfile = response.result;
        patch();
        if ([response.result.display_name, response.result.avatar].join('\0') !== before) onChange();
        return true;
      } catch {
        return false;
      } finally {
        if (version === generation) loading = null;
      }
    })();
    loading = task;
    return task;
  }
  async function save(change) {
    activate();
    if (state.userProfileUi.busy) return false;
    const version = generation;
    state.userProfileUi = { busy: true, message: 'saving' }; patch();
    try {
      const response = await api.updateUserProfile(change);
      if (version !== generation) return false;
      if (typeof response?.result?.authorized !== 'boolean') throw new Error('Invalid profile');
      state.userProfile = response.result;
      state.userProfileUi = { message: 'saved' };
      const input = root.querySelector('[data-profile-name]');
      if (input && 'display_name' in change) delete input.dataset.edited;
      patch(); onChange();
      return true;
    } catch (error) {
      if (version === generation) { state.userProfileUi = { message: 'failed', error: true }; patch(); }
      return false;
    }
  }
  function saveName() {
    const input = root.querySelector('[data-profile-name]'), value = input?.value.trim() ?? '';
    if ([...value].length > ID_MAX) { state.userProfileUi = { message: 'tooLong', error: true }; patch(); return Promise.resolve(false); }
    return save({ display_name: value || null });
  }
  async function chooseAvatar(file) {
    if (!file) return false;
    let avatar;
    try { avatar = await prepareAvatar(file); } catch { state.userProfileUi = { message: 'badImage', error: true }; patch(); return false; }
    return save({ avatar });
  }
  root.addEventListener('click', event => {
    const target = event.target.closest?.('button');
    if (!target || target.disabled || !target.closest('[data-user-profile-settings]')) return;
    if (target.hasAttribute('data-profile-avatar-choose')) root.querySelector('[data-profile-avatar-file]')?.click();
    else if (target.hasAttribute('data-profile-avatar-remove')) void save({ avatar: null });
    else if (target.hasAttribute('data-profile-name-save')) void saveName();
  });
  root.addEventListener('change', event => {
    if (!event.target.matches?.('[data-profile-avatar-file]')) return;
    const file = event.target.files?.[0];
    event.target.value = '';
    void chooseAvatar(file);
  });
  root.addEventListener('input', event => {
    if (!event.target.matches?.('[data-profile-name]')) return;
    event.target.dataset.edited = 'true';
    syncNameButton(event.target.closest('[data-user-profile-settings]'));
  });
  // Enter saves the ID instead of submitting the whole settings form.
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.target.matches?.('[data-profile-name]')) return;
    event.preventDefault();
    if (!root.querySelector('[data-profile-name-save]')?.disabled) void saveName();
  });
  root.addEventListener('error', event => {
    if (event.target.matches?.('[data-profile-image]')) event.target.remove();
  }, true);
  function mount() { activate(); patch(); }
  function stop() { generation += 1; loading = null; }
  return { refresh, activate, mount, stop, save, saveName, chooseAvatar };
}
