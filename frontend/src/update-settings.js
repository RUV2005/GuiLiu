// Settings → Version and updates, and the sidebar's update entry. The Backend reads the signed latest.json of the newest
// GitHub release; the panel shows the result, and both the panel and the entry download and verify an update on request
// and wait while launch.py switches to it. Data is backed up before the switch and the previous version returns if the
// new one does not start. One controller drives both, so an update keeps reporting on every page.
import { escapeHtml as e, escapeAttr as a } from './utils.js';

const copy = {
  title: ['版本与更新', 'バージョンと更新', 'Version and updates'],
  current: ['当前版本', '現在のバージョン', 'Current version'],
  latest: ['最新版本', '最新バージョン', 'Latest version'],
  check: ['检查更新', '更新を確認', 'Check for updates'],
  checking: ['正在检查更新…', '更新を確認中…', 'Checking for updates…'],
  upToDate: ['已是最新版本。', '最新バージョンです。', 'You are on the latest version.'],
  available: ['发现新版本 {version}', '新しいバージョン {version} があります', 'Version {version} is available'],
  details: ['更新说明', '更新内容', 'Release notes'],
  size: ['约 {size} MB', '約 {size} MB', 'About {size} MB'],
  update: ['下载并更新', 'ダウンロードして更新', 'Download and update'],
  confirm: ['将下载约 {size} MB 的更新包并校验签名，随后自动重启归流，大约需要半分钟。更新前会自动备份数据；如果新版本启动失败，会自动回到当前版本。更新期间页面会暂时无法使用。',
    '約 {size} MB の更新パッケージをダウンロードして署名を確認し、GUILIU を自動で再起動します（約 30 秒）。更新前にデータを自動でバックアップし、新しいバージョンが起動しない場合は現在のバージョンに戻ります。更新中はページを利用できません。',
    'This downloads about {size} MB, checks its signature and restarts GUILIU, which takes about half a minute. Your data is backed up first, and if the new version does not start, the current one comes back. The page is unavailable meanwhile.'],
  confirmButton: ['确认更新', '更新する', 'Update now'],
  back: ['返回', '戻る', 'Back'],
  downloading: ['正在下载更新 {done} / {total} MB', '更新をダウンロード中 {done} / {total} MB', 'Downloading the update {done} / {total} MB'],
  verifying: ['正在校验更新包…', '更新パッケージを確認中…', 'Verifying the update…'],
  restarting: ['正在重启归流并切换到新版本，完成后页面会自动刷新…', 'GUILIU を再起動して新しいバージョンに切り替えています。完了するとページが自動で更新されます…',
    'Restarting GUILIU on the new version; the page reloads when it is back…'],
  slow: ['重启比预期慢。请稍后手动刷新页面；如果打不开，请重新运行 start_windows.cmd。', '再起動に時間がかかっています。しばらくしてからページを更新してください。開かない場合は start_windows.cmd を実行し直してください。',
    'The restart is taking longer than expected. Reload the page in a moment; if it does not open, run start_windows.cmd again.'],
  pending: ['更新 {version} 已下载并校验，重启后生效。', '更新 {version} はダウンロード済みです。再起動すると反映されます。', 'Update {version} is downloaded and verified; it applies on restart.'],
  restartNow: ['立即重启', '今すぐ再起動', 'Restart now'],
  fullPackage: ['新版本 {version} 的运行环境有变化，需要下载完整安装包。下载后解压到新文件夹，再把旧文件夹里的 .runtime 复制过去即可保留数据。',
    'バージョン {version} は実行環境が変わるため、完全なパッケージが必要です。新しいフォルダーに展開し、古いフォルダーの .runtime をコピーするとデータを引き継げます。',
    'Version {version} changes the runtime, so it needs the full package. Extract it to a new folder and copy .runtime from the old folder to keep your data.'],
  openRelease: ['打开下载页面', 'ダウンロードページを開く', 'Open the download page'],
  rolledBack: ['上次更新到 {version} 时新版本没能启动，已自动回到当前版本，数据已恢复到更新前。', '前回の {version} への更新では新しいバージョンが起動しなかったため、現在のバージョンに戻し、データを更新前の状態に戻しました。',
    'The last update to {version} did not start, so GUILIU returned to this version and restored your data.'],
  unsupported: ['从源码运行时不支持在线更新，请用 Git 拉取新版本。', 'ソースから実行している場合はオンライン更新できません。Git で更新してください。',
    'Updates are not available when running from source; pull the new version with Git.'],
  // The latest release carries no signed update information, so nothing newer can be installed from here yet.
  missing: ['暂时没有可在线安装的新版本。', 'オンラインでインストールできる新しいバージョンはまだありません。', 'No newer version can be installed online yet.'],
  network: ['无法连接到更新服务器，请检查网络后重试。', '更新サーバーに接続できません。ネットワークを確認して再試行してください。', 'Could not reach the update server. Check your network and retry.'],
  signature: ['更新信息的签名校验失败，已拒绝这个更新。', '更新情報の署名を確認できなかったため、この更新を拒否しました。', 'The update information failed its signature check and was refused.'],
  invalid: ['更新信息格式不正确，已忽略。', '更新情報の形式が正しくないため無視しました。', 'The update information is malformed and was ignored.'],
  invalid_package: ['下载的更新包校验失败，没有安装。可以稍后重试。', 'ダウンロードした更新パッケージの確認に失敗したため、インストールしていません。後で再試行できます。',
    'The downloaded update failed verification and was not installed. You can retry later.'],
  unsafe_package: ['更新包内容不安全，已拒绝。', '更新パッケージの内容が安全ではないため拒否しました。', 'The update package is unsafe and was refused.'],
  busy: ['已经在更新中。', 'すでに更新中です。', 'An update is already in progress.'],
  stale: ['更新信息已变化，请重新检查。', '更新情報が変わりました。もう一度確認してください。', 'The update information changed; check again.'],
  failed: ['更新失败，请稍后重试。', '更新に失敗しました。後で再試行してください。', 'The update failed. Please retry later.'],
  checkedAt: ['上次检查：{time}', '前回の確認：{time}', 'Last checked: {time}'],
  // The sidebar entry above the profile block.
  entryAvailable: ['新版本更新', '新バージョンに更新', 'Update available'],
  entryTitle: ['新版本 {version} 已发布。点一下自动更新：下载约 {size} MB，备份数据后重启归流，大约半分钟。',
    '新しいバージョン {version} が公開されました。クリックすると自動で更新します：約 {size} MB をダウンロードし、データをバックアップしてから GUILIU を再起動します（約 30 秒）。',
    'Version {version} is out. Click to update: it downloads about {size} MB, backs up your data and restarts GUILIU, which takes about half a minute.'],
  entryFullTitle: ['新版本 {version} 的运行环境有变化，需要下载完整安装包。点一下查看说明。', 'バージョン {version} は完全なパッケージが必要です。クリックすると手順を表示します。',
    'Version {version} needs the full package. Click for the steps.'],
  entryDownloading: ['正在下载 {percent}%', 'ダウンロード中 {percent}%', 'Downloading {percent}%'],
  entryVerifying: ['正在校验…', '確認中…', 'Verifying…'],
  entryRestarting: ['正在重启…', '再起動中…', 'Restarting…'],
  entrySlow: ['重启较慢，请稍后刷新', '再起動に時間がかかっています', 'Restart is slow; reload soon'],
  entryRestart: ['重启完成更新', '再起動して更新', 'Restart to update'],
  entryRetry: ['更新没成功，点一下重试', '更新に失敗しました。クリックで再試行', 'Update failed; click to retry'],
};
export const updateText = (language, key) => copy[key]?.[{ zh: 0, ja: 1, en: 2 }[language] ?? 0] ?? copy.failed[{ zh: 0, ja: 1, en: 2 }[language] ?? 0];
const fill = (text, values) => Object.entries(values).reduce((value, [key, item]) => value.replaceAll('{' + key + '}', item), text);
const megabytes = bytes => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);

export function createUpdateState(source) {
  return { source, status: null, loading: false, error: '', confirming: false, busy: false, restarting: false, slow: false };
}

export function updateSettingsView(ctx) {
  const state = ctx.state.updateSettings || createUpdateState(''), text = key => updateText(ctx.language, key);
  const s = state.status, task = s?.task || {}, version = s?.latest || '';
  const line = (label, value) => '<div><dt>' + e(label) + '</dt><dd>' + e(value) + '</dd></div>';
  let body = '';
  if (s && !s.supported) body = '<p class="mailbox-settings-note">' + e(text('unsupported')) + '</p>';
  else if (s) {
    const working = ['downloading', 'verifying', 'restarting'].includes(task.state) || state.restarting;
    if (s.failed?.version) body += '<p class="mailbox-settings-feedback" role="status">' + e(fill(text('rolledBack'), { version: s.failed.version })) + '</p>';
    if (state.restarting || task.state === 'restarting') {
      body += '<p class="mailbox-settings-feedback" role="status">' + e(text(state.slow ? 'slow' : 'restarting')) + '</p>';
    } else if (task.state === 'downloading') {
      body += '<p class="mailbox-settings-feedback" role="status">' + e(fill(text('downloading'), { done: megabytes(task.received), total: megabytes(task.size) })) + '</p>' +
        '<progress class="update-progress" value="' + a(task.received || 0) + '" max="' + a(task.size || 1) + '"></progress>';
    } else if (task.state === 'verifying') {
      body += '<p class="mailbox-settings-feedback" role="status">' + e(text('verifying')) + '</p>';
    } else if (s.pending) {
      body += '<p class="mailbox-settings-feedback" role="status">' + e(fill(text('pending'), { version: s.pending })) + '</p>' +
        '<div class="mailbox-settings-actions"><button class="button primary" type="button" data-update-restart' + (state.busy ? ' disabled' : '') + '>' + e(text('restartNow')) + '</button></div>';
    } else if (s.available && s.compatible === false) {
      body += '<p class="mailbox-settings-feedback" role="status">' + e(fill(text('fullPackage'), { version })) + '</p>' +
        (safeLink(s.release_url) ? '<p><a href="' + a(safeLink(s.release_url)) + '" target="_blank" rel="noopener noreferrer">' + e(text('openRelease')) + '</a></p>' : '');
    } else if (s.available) {
      body += '<p class="mailbox-settings-feedback" role="status"><strong>' + e(fill(text('available'), { version })) + '</strong> · ' + e(fill(text('size'), { size: megabytes(s.size) })) + '</p>' +
        (s.notes ? '<details class="update-notes"><summary>' + e(text('details')) + '</summary><p>' + e(s.notes) + '</p></details>' : '') +
        (state.confirming ? '<div class="mail-full-confirm" data-update-confirming><p>' + e(fill(text('confirm'), { size: megabytes(s.size) })) + '</p><div class="mailbox-settings-actions">' +
          '<button class="button primary" type="button" data-update-confirm' + (state.busy ? ' disabled' : '') + '>' + e(text('confirmButton')) + '</button>' +
          '<button class="button" type="button" data-update-back' + (state.busy ? ' disabled' : '') + '>' + e(text('back')) + '</button></div></div>'
          : '<div class="mailbox-settings-actions"><button class="button primary" type="button" data-update-start>' + e(text('update')) + '</button></div>');
    } else if (!s.error || s.error === 'missing') {
      body += '<p class="mailbox-settings-feedback" role="status">' + e(text(s.error ? 'missing' : 'upToDate')) + '</p>';
    }
    const problem = state.error || (task.state === 'failed' ? task.error : '') || (s.error === 'missing' ? '' : s.error);
    if (problem) body += '<p class="mailbox-settings-feedback" role="alert">' + e(text(problem)) + '</p>';
    if (!working) body += '<div class="mailbox-settings-actions"><button class="button" type="button" data-update-check' + (state.loading || state.busy ? ' disabled' : '') + '>' +
      e(text(state.loading ? 'checking' : 'check')) + '</button></div>';
    if (s.checked_at && !working) body += '<p class="mailbox-settings-note">' + e(fill(text('checkedAt'), { time: new Date(s.checked_at * 1000).toLocaleString(ctx.language === 'zh' ? 'zh-CN' : ctx.language) })) + '</p>';
  } else body = '<p class="mailbox-settings-feedback" role="status">' + e(text(state.error || 'checking')) + '</p>';
  return '<section class="settings-group update-settings" data-update-settings aria-labelledby="settings-updates">' +
    '<header><h2 id="settings-updates">' + e(text('title')) + '</h2></header>' +
    '<dl class="mailbox-settings-summary update-summary">' + line(text('current'), s?.current || '—') +
    (s?.supported && s.latest ? line(text('latest'), s.latest) : '') + '</dl>' +
    '<div aria-busy="' + Boolean(state.loading || state.busy) + '">' + body + '</div></section>';
}

// The sidebar entry: nothing until a newer version can be installed, then one click updates and it reports progress.
export function updateEntryView(ctx) {
  const state = ctx.state.updateSettings, s = state?.status;
  if (!s?.supported) return '';
  const task = s.task || {}, text = key => updateText(ctx.language, key);
  let label, title = '', busy = true;
  if (state.restarting || task.state === 'restarting') { label = text(state.slow ? 'entrySlow' : 'entryRestarting'); title = text(state.slow ? 'slow' : 'restarting'); }
  else if (task.state === 'downloading') label = fill(text('entryDownloading'), { percent: Math.min(100, Math.floor(100 * (Number(task.received) || 0) / (Number(task.size) || 1))) });
  else if (task.state === 'verifying') label = text('entryVerifying');
  else {
    busy = false;
    if (s.pending) { label = text('entryRestart'); title = fill(text('pending'), { version: s.pending }); }
    else if (!s.available) return '';
    else if (state.error || task.state === 'failed') { label = text('entryRetry'); title = text(state.error || task.error || 'failed'); }
    else { label = text('entryAvailable'); title = fill(text(s.compatible === false ? 'entryFullTitle' : 'entryTitle'), { version: s.latest, size: megabytes(s.size) }); }
  }
  const mark = '<span class="sidebar-update-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 11.5V4.5M4.75 7.5 8 4.25l3.25 3.25"/></svg></span>';
  return '<button class="sidebar-update' + (busy ? ' is-busy' : '') + '" type="button" data-update-entry title="' + a(title || label) + '" aria-label="' + a(label) + '"' +
    (busy || state.busy ? ' disabled' : '') + '>' + mark + '<span class="sidebar-update-label">' + e(label) + '</span></button>';
}

function patchUpdateEntry(root, ctx) {
  const host = root?.querySelector('[data-update-entry-host]');
  if (!host) return;
  const html = updateEntryView(ctx);
  if (versions.get(host) === html) return;
  const focused = host.contains(host.ownerDocument.activeElement);
  host.innerHTML = html;
  if (focused) host.querySelector('[data-update-entry]:not(:disabled)')?.focus({ preventScroll: true });
  versions.set(host, html);
}

function safeLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : ''; } catch { return ''; }
}

const versions = new WeakMap();
function patchUpdateSettings(root, ctx) {
  const host = root?.querySelector('[data-update-settings]');
  if (!host) return false;
  const html = updateSettingsView(ctx);
  if (versions.get(host) === html) return true;
  const doc = host.ownerDocument, active = doc.activeElement;
  const focus = active && host.contains(active) ? ['data-update-check', 'data-update-start', 'data-update-confirm', 'data-update-back', 'data-update-restart'].find(n => active.hasAttribute(n)) : '';
  const open = host.querySelector('details')?.open;
  const template = doc.createElement('template'); template.innerHTML = html;
  host.replaceChildren(...template.content.firstElementChild.childNodes);
  if (open && host.querySelector('details')) host.querySelector('details').open = true;
  if (focus) host.querySelector('[' + focus + ']:not(:disabled)')?.focus({ preventScroll: true });
  versions.set(host, html);
  return true;
}

export function createUpdateController({ state, api, source, context, root = () => document, reload = () => location.reload(),
  openSettings = () => { location.hash = '#settings'; }, setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 2000,
  restartLimitMs = 180000, checkMs = 3600000 }) {
  const scopes = new Map(), mounted = new WeakSet();
  let epoch = 0, entered = false, timer = null, watching = false;

  function activate() {
    const key = source();
    if (state.updateSettings?.source !== key) {
      epoch += 1; entered = false;
      if (!scopes.has(key)) scopes.set(key, createUpdateState(key));
      state.updateSettings = scopes.get(key);
    }
    return state.updateSettings;
  }
  function patch() {
    activate();
    const ctx = context();
    patchUpdateEntry(root(), ctx);
    return state.route === 'settings' ? patchUpdateSettings(root(), ctx) : false;
  }
  function schedule(callback, delay = pollMs) { clearTimer(timer); timer = setTimer(() => { timer = null; void callback(); }, delay); }
  async function load(refresh = false) {
    const current = activate(), version = epoch;
    current.loading = true; current.error = ''; patch();
    try {
      const payload = await api.getUpdateStatus(refresh, current.source);
      if (version !== epoch) return;
      current.status = payload?.result || null;
      // Keep reporting a download or verification until it ends.
      if (['downloading', 'verifying'].includes(current.status?.task?.state)) schedule(() => load(false));
      if (current.status?.task?.state === 'restarting') waitForRestart(current, current.status.current);
    } catch (error) {
      if (version === epoch) current.error = error?.payload?.error || 'network';
    } finally {
      if (version === epoch) {
        current.loading = false; patch();
        // Between updates, look again every checkMs (the Backend asks GitHub at most hourly).
        if (watching && !timer && !current.restarting) schedule(() => load(false), checkMs);
      }
    }
  }
  function waitForRestart(current, from) {
    if (current.restarting) return;
    current.restarting = true; current.slow = false; patch();
    const started = Date.now();
    const poll = async () => {
      try {
        const payload = await api.getUpdateStatus(false, current.source);
        const now = payload?.result?.current;
        if (now && now !== from) { reload(); return; }
        // Still the old version: a rollback also lands here once the old version is back.
        if (now && payload.result.failed?.version && Date.now() - started > 5000) { reload(); return; }
      } catch { /* The services are restarting. */ }
      if (Date.now() - started > restartLimitMs && !current.slow) { current.slow = true; patch(); }
      schedule(poll, pollMs);
    };
    schedule(poll, pollMs * 2);
  }
  async function start() {
    const current = activate(), version = epoch;
    if (!current.status?.latest || current.busy) return;
    current.busy = true; current.error = ''; patch();
    try {
      const payload = await api.startUpdate(current.status.latest, current.source);
      if (version !== epoch) return;
      current.status = payload?.result || current.status;
      current.confirming = false;
      schedule(() => load(false));
    } catch (error) {
      if (version === epoch) current.error = error?.payload?.error || 'failed';
    } finally {
      if (version === epoch) { current.busy = false; patch(); }
    }
  }
  async function restart() {
    const current = activate(), version = epoch, from = current.status?.current;
    current.busy = true; patch();
    try {
      await api.restartForUpdate(current.source);
      if (version === epoch) waitForRestart(current, from);
    } catch (error) {
      if (version === epoch) current.error = error?.payload?.error || 'failed';
    } finally {
      if (version === epoch) { current.busy = false; patch(); }
    }
  }
  // The sidebar entry: a pending update restarts, a full-package release opens Settings, anything else starts at once.
  function act() {
    const current = activate(), s = current.status;
    if (!s?.supported || current.busy || current.loading) return;
    if (s.pending) void restart();
    else if (s.available && s.compatible === false) openSettings();
    else if (current.error === 'stale') void load(true);
    else if (s.available) void start();
  }
  // Leaving Settings only forgets the visit; an update in progress keeps reporting in the sidebar.
  function leave() { entered = false; const current = state.updateSettings; if (current) current.confirming = false; }
  function stop() { epoch += 1; entered = false; watching = false; clearTimer(timer); timer = null; const current = state.updateSettings; if (current) { current.loading = current.busy = false; } }
  // Called once the workspace is ready: check now, then every checkMs while the page is open.
  function watch() { if (watching) return; watching = true; if (!timer) void load(false); }
  function mount() {
    activate();
    const page = root();
    if (page && !mounted.has(page)) {
      mounted.add(page);
      page.addEventListener('click', event => {
        const button = event.target.closest?.('[data-update-entry]');
        if (button && !button.disabled) act();
      });
    }
    patch();
    if (state.route !== 'settings') return;
    const host = page?.querySelector('[data-update-settings]');
    if (!host) return;
    if (!mounted.has(host)) {
      mounted.add(host);
      host.addEventListener('click', event => {
        const button = event.target.closest('button'), current = activate();
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-update-check')) void load(true);
        else if (button.hasAttribute('data-update-start')) { current.confirming = true; patch(); host.querySelector('[data-update-confirm]')?.focus({ preventScroll: true }); }
        else if (button.hasAttribute('data-update-back')) { current.confirming = false; patch(); }
        else if (button.hasAttribute('data-update-confirm')) void start();
        else if (button.hasAttribute('data-update-restart')) void restart();
      });
    }
    patch();
    if (!entered) { entered = true; void load(false); }
  }
  activate();
  return { activate, mount, patch, leave, stop, watch, load, act };
}
