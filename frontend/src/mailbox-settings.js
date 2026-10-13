// Settings → Mailboxes. A mailbox is added or reconnected in a small window that reuses setup's connection panel.
// A new mailbox is then indexed and searched for banks in the background while the workspace stays usable; when the
// banks are found the user gets a message, confirms their accounts here, and the mailbox's history is imported.
import { debtBalance, exceedsLimit } from './assets-model.js';
import { escapeHtml as e, escapeAttr as a } from './utils.js';
import { copy as setupCopy } from './initialization/copy.js';
import { mailboxMarkup, syncMailbox, mailAccount, defaultGmailMethod } from './initialization/mailbox-view.js';
import { describeSetupError } from './initialization/setup-errors.js';
import { beginGmailAuthorization } from './initialization/gmail-authorization.js';

const PROVIDERS = ['gmail', '163'];
const RUNNING = ['indexing', 'discovering', 'rules'];
const copy = {
  title: ['邮箱', 'メール', 'Mailboxes'],
  gmail: ['Gmail', 'Gmail', 'Gmail'],
  163: ['网易 163 邮箱', 'NetEase 163 メール', 'NetEase 163 Mail'],
  connected: ['已连接', '接続済み', 'Connected'],
  expired: ['连接失效', '接続が無効です', 'Connection lost'],
  absent: ['未连接', '未接続', 'Not connected'],
  adding: ['正在添加', '追加中', 'Being added'],
  add: ['添加', '追加', 'Add'],
  reconnect: ['重新连接', '再接続', 'Reconnect'],
  loading: ['正在读取邮箱状态…', 'メールの状態を取得中…', 'Loading mailboxes…'],
  dialogAdd: ['添加 {mailbox}', '{mailbox} を追加', 'Add {mailbox}'],
  dialogReconnect: ['重新连接 {mailbox}', '{mailbox} を再接続', 'Reconnect {mailbox}'],
  reconnectNote: ['请使用原来绑定的账号。重新连接只更新授权，不会重新导入数据。', '元のアカウントを使用してください。再接続は認証だけを更新し、データは取り込み直しません。',
    'Use the account it was connected with. Reconnecting only renews the authorization; nothing is imported again.'],
  addNote: ['连接后窗口会自动关闭，后台继续建立索引和识别银行（会产生模型费用），完成后会通知你。', '接続するとウィンドウは自動で閉じ、索引作成と銀行の識別をバックグラウンドで続けます（モデル料金がかかります）。完了したらお知らせします。',
    'This window closes once connected; indexing and bank detection continue in the background (model fees apply) and you are told when they finish.'],
  close: ['关闭', '閉じる', 'Close'],
  googleWaiting: ['请在 Google 页面完成授权，完成后这里会自动继续。', 'Google のページで認証を完了してください。完了すると自動で続行します。', 'Complete authorization on Google; this continues by itself.'],
  connectedAdd: ['{mailbox} 已连接，正在后台建立索引。', '{mailbox} を接続しました。バックグラウンドで索引を作成しています。', '{mailbox} is connected and being indexed in the background.'],
  connectedReconnect: ['{mailbox} 已重新连接。', '{mailbox} を再接続しました。', '{mailbox} is reconnected.'],
  jobIndexing: ['正在为 {mailbox} 建立邮件索引 {done} / {total}', '{mailbox} のメールの索引を作成中 {done} / {total}', 'Indexing {mailbox} {done} / {total}'],
  jobIndexingStart: ['正在读取 {mailbox} 的邮件…', '{mailbox} のメールを読み込み中…', 'Reading {mailbox}…'],
  jobDiscovering: ['正在识别 {mailbox} 里的银行来源 {done} / {total}', '{mailbox} の銀行の送信元を識別中 {done} / {total}', 'Finding banks in {mailbox} {done} / {total}'],
  jobDiscoveringStart: ['正在识别 {mailbox} 里的银行来源…', '{mailbox} の銀行の送信元を識別中…', 'Finding banks in {mailbox}…'],
  jobReview: ['在 {mailbox} 里发现 {count} 个新的银行来源，请确认要绑定的账户。', '{mailbox} で新しい銀行の送信元が {count} 件見つかりました。紐付ける口座を確認してください。',
    '{count} new bank sender(s) found in {mailbox}. Confirm their accounts.'],
  jobRules: ['正在为新的银行来源生成识别规则…', '新しい銀行の送信元の識別ルールを作成中…', 'Building recognition rules for the new banks…'],
  jobRulesReview: ['部分识别规则没能生成，可以重试，或重新确认银行来源。', '一部の識別ルールを作成できませんでした。再試行するか、銀行の送信元を確認し直してください。',
    'Some recognition rules could not be built. Retry, or confirm the bank sources again.'],
  jobFailed: ['{mailbox} 的索引或银行识别没有完成。', '{mailbox} の索引作成または銀行の識別が完了しませんでした。', 'Indexing {mailbox} or finding its banks did not finish.'],
  jobDone: ['{mailbox} 已就绪，正在后台导入这个邮箱的历史账单。', '{mailbox} の準備ができました。このメールの過去の明細をバックグラウンドで取り込んでいます。',
    '{mailbox} is ready; its past statements are being imported in the background.'],
  jobDoneNone: ['{mailbox} 已就绪，没有发现新的银行来源，正在后台导入历史账单。', '{mailbox} の準備ができました。新しい銀行の送信元はありません。過去の明細を取り込んでいます。',
    '{mailbox} is ready with no new bank senders; its past statements are being imported.'],
  review: ['确认银行来源', '銀行の送信元を確認', 'Confirm bank sources'],
  retry: ['重试', '再試行', 'Retry'],
  cancel: ['取消添加', '追加をキャンセル', 'Cancel adding'],
  cancelConfirm: ['确定取消添加？已建立的索引和识别结果会被丢弃。', '追加をキャンセルしますか？作成した索引と識別結果は破棄されます。', 'Cancel adding? The index and bank results built so far are discarded.'],
  dismiss: ['知道了', 'OK', 'Got it'],
  confirmTitle: ['确认 {mailbox} 的银行来源', '{mailbox} の銀行の送信元を確認', 'Confirm the banks in {mailbox}'],
  confirmLead: ['为每个银行来源选择记入的账户。确认后会生成识别规则，并开始导入这个邮箱的历史账单。', '銀行の送信元ごとに記帳する口座を選んでください。確認後、識別ルールを作成し、このメールの過去の明細を取り込みます。',
    'Choose the account each bank sender posts to. Recognition rules are then built and this mailbox’s past statements imported.'],
  sender: ['发件邮箱', '送信元', 'Sender'],
  samples: ['{count} 封样本邮件', 'サンプル {count} 件', '{count} sample mail(s)'],
  create: ['新建账户', '口座を新規作成', 'Create an account'],
  bind: ['绑定已有账户', '既存の口座に紐付け', 'Use an existing account'],
  skip: ['跳过', 'スキップ', 'Skip'],
  accountName: ['账户名称', '口座名', 'Account name'],
  openingBalance: ['当前余额（可留空，按 0 起算）', '現在の残高（空欄なら 0 から）', 'Current balance (blank starts at 0)'],
  currentDebt: ['当前欠款（正数，可留空，按 0 起算）', '現在の未払い残高（正の数、空欄なら 0）', 'Amount owed (positive; blank means 0)'],
  debtInvalid: ['欠款请填写正数金额。', '未払い残高は正の金額で入力してください。', 'Enter the amount owed as a positive number.'],
  debtOverLimit: ['欠款不能超过信用额度。', '未払い残高は利用限度額を超えられません。', 'The amount owed cannot exceed the credit limit.'],
  creditLimit: ['信用额度', '利用限度額', 'Credit limit'],
  chooseAccount: ['选择账户', '口座を選択', 'Choose an account'],
  noAccount: ['没有币种和类型相符的账户', '通貨と種類が合う口座はありません', 'No account with this currency and type'],
  bank: ['银行账户', '銀行口座', 'Bank account'],
  credit: ['信用卡', 'クレジットカード', 'Credit card'],
  submit: ['确认并继续', '確認して続行', 'Confirm and continue'],
  needLimit: ['信用卡账户需要填写信用额度。', 'クレジット口座には利用限度額が必要です。', 'A credit account needs a credit limit.'],
  needAccount: ['请为每个来源选择账户或跳过。', '送信元ごとに口座を選ぶかスキップしてください。', 'Choose an account or skip for every sender.'],
  needName: ['请填写账户名称。', '口座名を入力してください。', 'Enter an account name.'],
  failed: ['操作失败，请稍后重试。', '操作に失敗しました。しばらくしてから再試行してください。', 'The action failed. Please retry.'],
  localOnly: ['此操作仅支持在运行归流的电脑上打开的页面。', 'この操作は GUILIU を実行しているパソコン上のページでのみ利用できます。', 'This works only on the computer running GUILIU.'],
  revokedToast: ['Gmail 连接已失效，新邮件暂停读取。请到 设置 → 邮箱 重新连接。', 'Gmail の接続が無効になり、新しいメールの読み込みを停止しています。設定 → メール で再接続してください。',
    'The Gmail connection was lost and new mail is not being read. Reconnect it in Settings → Mailboxes.'],
  entryRevoked: ['Gmail 连接失效', 'Gmail の接続が無効', 'Gmail connection lost'],
};
const index = language => ({ zh: 0, ja: 1, en: 2 }[language] ?? 0);
export const mailboxText = (language, key, values = {}) =>
  Object.entries(values).reduce((text, [k, v]) => text.replaceAll('{' + k + '}', v), copy[key]?.[index(language)] ?? key);

// When Google revoked the saved Gmail authorization (the Backend reports the time), else null.
export function gmailRevokedAt(overview) {
  const gmail = overview?.mail?.accounts?.find(item => item.provider === 'gmail');
  return gmail?.selected && gmail.revoked_at ? gmail.revoked_at : null;
}

export function createMailboxSettingsState(source) {
  return { source, overview: null, loading: false, error: '', notice: '', busy: false, dialog: null, choices: {}, formError: '' };
}

function rowState(account, job, provider) {
  if (job && job.state !== 'done' && job.provider === provider) return 'adding';
  if (!account?.selected) return 'absent';
  return account.authorized ? 'connected' : 'expired';
}

function jobMarkup(ctx, overview) {
  const job = overview?.job, text = (key, values) => mailboxText(ctx.language, key, values);
  if (!job) return '';
  const mailbox = text(job.provider), progress = overview.job_progress || {};
  const button = (attr, label, primary = false) => '<button class="button' + (primary ? ' primary' : '') + '" type="button" ' + attr + '>' + e(text(label)) + '</button>';
  let line = '', bar = '', actions = '';
  if (job.state === 'indexing') {
    const indexed = progress.indexed;
    line = indexed?.total ? text('jobIndexing', { mailbox, done: indexed.vectorized, total: indexed.total }) : text('jobIndexingStart', { mailbox });
    if (indexed?.total) bar = '<progress class="update-progress" value="' + a(indexed.vectorized) + '" max="' + a(indexed.total) + '"></progress>';
    if (['failed', 'interrupted'].includes(progress.indexing_status)) {
      line = text('jobFailed', { mailbox }) + (progress.indexing_error ? ' ' + describe(ctx, progress.indexing_error) : '');
      actions = button('data-mailbox-retry', 'retry', true) + button('data-mailbox-cancel', 'cancel');
    } else if (indexed?.total && indexed.vectorized >= indexed.total) {
      // The first mails are indexed but bank discovery has not started: let the user start it.
      actions = button('data-mailbox-retry', 'retry', true) + button('data-mailbox-cancel', 'cancel');
    } else actions = button('data-mailbox-cancel', 'cancel');
  } else if (job.state === 'discovering') {
    const found = progress.discovery;
    line = found?.groups_total ? text('jobDiscovering', { mailbox, done: found.groups_checked || 0, total: found.groups_total }) : text('jobDiscoveringStart', { mailbox });
    if (found?.groups_total) bar = '<progress class="update-progress" value="' + a(found.groups_checked || 0) + '" max="' + a(found.groups_total) + '"></progress>';
    actions = button('data-mailbox-cancel', 'cancel');
  } else if (job.state === 'review') {
    line = text('jobReview', { mailbox, count: job.found || (overview.sources || []).length });
    actions = button('data-mailbox-review', 'review', true) + button('data-mailbox-cancel', 'cancel');
  } else if (job.state === 'rules') {
    line = text('jobRules');
  } else if (job.state === 'rules_review') {
    line = text('jobRulesReview') + (job.error ? ' ' + describe(ctx, job.error) : '');
    actions = button('data-mailbox-retry', 'retry', true) + button('data-mailbox-review', 'review') + button('data-mailbox-cancel', 'cancel');
  } else if (job.state === 'failed') {
    line = text('jobFailed', { mailbox }) + (job.error ? ' ' + describe(ctx, job.error) : '');
    actions = button('data-mailbox-retry', 'retry', true) + button('data-mailbox-cancel', 'cancel');
  } else if (job.state === 'done') {
    line = text(job.found === 0 ? 'jobDoneNone' : 'jobDone', { mailbox });
    actions = button('data-mailbox-dismiss', 'dismiss');
  }
  return '<div class="mailbox-job" data-mailbox-job="' + a(job.state) + '"><p class="mailbox-settings-feedback" role="status">' + e(line) + '</p>' + bar +
    (actions ? '<div class="mailbox-settings-actions">' + actions + '</div>' : '') + '</div>';
}

function describe(ctx, message) {
  return describeSetupError(key => setupCopy(ctx.language, key), message, 'gmail');
}

export function mailboxSettingsView(ctx) {
  const state = ctx.state.mailboxSettings || createMailboxSettingsState(''), overview = state.overview;
  const text = (key, values) => mailboxText(ctx.language, key, values), job = overview?.job;
  const adding = job && job.state !== 'done';
  const rows = PROVIDERS.map(provider => {
    const account = overview?.mail?.accounts?.find(item => item.provider === provider), row = rowState(account, job, provider);
    const mode = row === 'absent' ? 'add' : 'reconnect';
    const disabled = !overview || state.busy || row === 'adding' || (mode === 'add' && (adding || overview.indexing));
    const revoked = provider === 'gmail' && row === 'expired' && gmailRevokedAt(overview);
    return '<div><dt>' + e(text(provider)) + '</dt><dd><span class="mailbox-settings-status" data-state="' + row + '">' + e(text(row)) + '</span>' +
      '</dd>' +
      '<dd><button class="button' + (revoked ? ' primary' : '') + '" type="button" data-mailbox-action="' + mode + '" data-mailbox-provider="' + a(provider) + '"' +
      (disabled ? ' disabled' : '') + '>' + e(text(mode)) + '</button></dd></div>';
  }).join('');
  const feedback = state.error ? text(state.error) : state.notice || (state.loading && !overview ? text('loading') : '');
  return '<section class="settings-group mailbox-settings" data-mailbox-settings aria-labelledby="settings-mailboxes">' +
    '<header><h2 id="settings-mailboxes">' + e(text('title')) + '</h2></header>' +
    '<div aria-busy="' + Boolean(state.loading || state.busy) + '"><dl class="mailbox-settings-summary">' + rows + '</dl>' +
    jobMarkup(ctx, overview) +
    '<p class="mailbox-settings-feedback" role="' + (state.error ? 'alert' : 'status') + '" aria-live="polite">' + e(feedback) + '</p>' +
    '</div></section>';
}

function connectDialogMarkup(ctx, state) {
  const { provider, mode } = state.dialog, text = (key, values) => mailboxText(ctx.language, key, values);
  const t = key => setupCopy(ctx.language, key), mailbox = text(provider);
  return '<header class="mailbox-dialog-header"><h2>' + e(text(mode === 'add' ? 'dialogAdd' : 'dialogReconnect', { mailbox })) + '</h2>' +
    '<button class="text-button" type="button" data-mailbox-close>' + e(text('close')) + '</button></header>' +
    '<p class="mailbox-settings-note">' + e(text(mode === 'add' ? 'addNote' : 'reconnectNote')) + '</p>' +
    '<form class="mailbox-dialog-form" data-mailbox-connect-form autocomplete="off">' + mailboxMarkup(t, state.overview, provider, state.gmailMethod) + '</form>' +
    '<div data-mailbox-oauth></div><p class="mailbox-settings-feedback" data-mailbox-dialog-feedback role="alert"></p>';
}

function confirmDialogMarkup(ctx, state) {
  const text = (key, values) => mailboxText(ctx.language, key, values), overview = state.overview;
  const mailbox = text(overview?.job?.provider || 'gmail'), accounts = overview?.accounts || [];
  const cards = (overview?.sources || []).map(source => {
    const choice = state.choices[source.source_id] || {}, id = a(source.source_id);
    const type = source.account_type === 'credit' ? 'credit' : 'bank';
    const matching = accounts.filter(acc => acc.currency === source.currency && acc.account_type === type);
    const radio = (value, label, disabled = false) => '<label class="mailbox-choice"><input type="radio" name="action-' + id + '" value="' + value + '" data-mailbox-choice="' + id + '"' +
      (choice.action === value ? ' checked' : '') + (disabled ? ' disabled' : '') + '> ' + e(text(label)) + '</label>';
    return '<fieldset class="mailbox-source" data-mailbox-source="' + id + '"><legend><strong>' + e(source.bank_name) + '</strong> · ' + e(text(type)) + ' · ' + e(source.currency || '') + '</legend>' +
      '<p class="mailbox-settings-note">' + e(text('sender')) + '：' + e(source.mailaddress || '') + ' · ' + e(text('samples', { count: (source.sample_ids || []).length })) + '</p>' +
      '<div class="mailbox-choices">' + radio('create', 'create') + radio('bind', 'bind', !matching.length) + radio('skip', 'skip') + '</div>' +
      (choice.action === 'create' ? '<div class="mailbox-source-fields"><label>' + e(text('accountName')) + '<input name="name-' + id + '" value="' + a(choice.name ?? '') + '" maxlength="100" data-mailbox-field="name" data-mailbox-for="' + id + '"></label>' +
        '<label>' + e(text(type === 'credit' ? 'currentDebt' : 'openingBalance')) + '<input name="balance-' + id + '" value="' + a(choice.opening_balance ?? '') + '" inputmode="decimal" data-mailbox-field="opening_balance" data-mailbox-for="' + id + '"></label>' +
        (type === 'credit' ? '<label>' + e(text('creditLimit')) + '<input name="limit-' + id + '" value="' + a(choice.credit_limit ?? '') + '" inputmode="decimal" data-mailbox-field="credit_limit" data-mailbox-for="' + id + '"></label>' : '') + '</div>' : '') +
      (choice.action === 'bind' ? '<div class="mailbox-source-fields"><label>' + e(text('chooseAccount')) + '<select data-mailbox-field="account_number" data-mailbox-for="' + id + '">' +
        (matching.length ? matching.map(acc => '<option value="' + a(acc.account_number) + '"' + (String(choice.account_number) === String(acc.account_number) ? ' selected' : '') + '>' +
          e(acc.name + (acc.institution ? ' · ' + acc.institution : '')) + '</option>').join('') : '<option value="">' + e(text('noAccount')) + '</option>') + '</select></label></div>' : '') +
      '</fieldset>';
  }).join('');
  return '<header class="mailbox-dialog-header"><h2>' + e(text('confirmTitle', { mailbox })) + '</h2>' +
    '<button class="text-button" type="button" data-mailbox-close>' + e(text('close')) + '</button></header>' +
    '<p class="mailbox-settings-note">' + e(text('confirmLead')) + '</p>' + cards +
    '<p class="mailbox-settings-feedback" role="alert">' + e(state.formError ? text(state.formError) : '') + '</p>' +
    '<div class="mailbox-settings-actions"><button class="button primary" type="button" data-mailbox-submit' + (state.busy ? ' disabled' : '') + '>' + e(text('submit')) + '</button></div>';
}

const versions = new WeakMap();
function patchMailboxSettings(root, ctx) {
  const host = root?.querySelector('[data-mailbox-settings]');
  if (!host) return false;
  const html = mailboxSettingsView(ctx);
  if (versions.get(host) === html) return true;
  const doc = host.ownerDocument, active = doc.activeElement;
  const focus = active && host.contains(active) ? [...active.attributes].map(item => item.name).find(name => name.startsWith('data-mailbox-')) : '';
  const provider = active?.dataset?.mailboxProvider;
  const template = doc.createElement('template'); template.innerHTML = html;
  host.replaceChildren(...template.content.firstElementChild.childNodes);
  if (focus) host.querySelector('[' + focus + ']' + (provider ? '[data-mailbox-provider="' + provider + '"]' : '') + ':not(:disabled)')?.focus({ preventScroll: true });
  versions.set(host, html);
  return true;
}

function defaultChoices(overview) {
  const choices = {};
  for (const source of overview?.sources || []) {
    const type = source.account_type === 'credit' ? 'credit' : 'bank';
    const suggested = (overview.accounts || []).find(acc => acc.account_number === source.suggested_account_number && acc.currency === source.currency && acc.account_type === type);
    choices[source.source_id] = suggested ? { action: 'bind', account_number: suggested.account_number }
      : { action: 'create', name: source.account_draft?.name || source.bank_name || '', opening_balance: '', credit_limit: '' };
  }
  return choices;
}

export function createMailboxSettingsController({ state, api, source, context, root = () => document, onJobStarted = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 3000, beginAuthorization = beginGmailAuthorization, confirmAction = message => window.confirm(message) }) {
  const scopes = new Map(), mounted = new WeakSet();
  let epoch = 0, entered = false, timer = null, dialog = null, popup = null;

  function activate() {
    const key = source();
    if (state.mailboxSettings?.source !== key) {
      epoch += 1; entered = false;
      if (!scopes.has(key)) scopes.set(key, createMailboxSettingsState(key));
      state.mailboxSettings = scopes.get(key);
    }
    return state.mailboxSettings;
  }
  const text = (key, values) => mailboxText(context().language, key, values);
  function patch() { if (state.route !== 'settings') return false; activate(); return patchMailboxSettings(root(), context()); }
  function failure(error) {
    if (error?.status === 403) return 'localOnly';
    return error?.message ? describe(context(), error.message) : text('failed');
  }
  function schedule() {
    clearTimer(timer); timer = null;
    const current = activate(), job = current.overview?.job;
    const waitingGoogle = current.dialog?.kind === 'connect' && current.dialog.waiting;
    if (state.route === 'settings' && (RUNNING.includes(job?.state) || waitingGoogle)) timer = setTimer(() => { timer = null; void load(); }, pollMs);
  }
  async function load() {
    const current = activate(), version = epoch;
    current.loading = true; patch();
    try {
      const payload = await api.getSetupMailboxes(current.source);
      if (version !== epoch) return;
      current.overview = payload?.result || null; current.error = '';
      state.gmailRevoked = gmailRevokedAt(current.overview); patchMailboxAlert(root(), context());
      // Google authorization finishes in another tab; the window closes once the mailbox shows as connected.
      const pending = current.dialog?.kind === 'connect' && current.dialog.waiting ? current.dialog : null;
      if (pending) {
        const account = mailAccount(current.overview, pending.provider);
        // Adding shows the new job; renewing Google consent shows a newer token.
        const renewed = pending.mode === 'reconnect' && Number(current.overview.gmail_token_updated || 0) > Number(pending.tokenAt || 0);
        if (account?.selected && account.authorized && (pending.mode === 'add' ? Boolean(current.overview.job) : renewed)) finishConnect(current, pending);
      }
      if (current.dialog?.kind === 'confirm') renderDialog();
    } catch (error) {
      if (version === epoch) current.error = error?.status === 403 ? 'localOnly' : 'failed';
    } finally {
      if (version === epoch) { current.loading = false; patch(); schedule(); }
    }
  }
  function finishConnect(current, pending) {
    current.notice = text(pending.mode === 'add' ? 'connectedAdd' : 'connectedReconnect', { mailbox: text(pending.provider) });
    if (pending.mode === 'add') onJobStarted();
    closeDialog();
  }

  // The window reuses setup's connection panel, so its styles load with Settings, never with the workspace.
  function setupStyles() {
    if (document.querySelector('link[data-setup-styles]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('./initialization/initialization.css', import.meta.url).href; link.dataset.setupStyles = '';
    document.head.append(link);
  }
  // The dialog lives outside the settings markup, so re-rendering the page never closes it.
  function ensureDialog() {
    setupStyles();
    if (dialog?.isConnected) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'mailbox-dialog';
    dialog.addEventListener('close', () => { const current = activate(); current.dialog = null; popup?.cancel(); popup = null; patch(); });
    dialog.addEventListener('click', onDialogClick);
    dialog.addEventListener('submit', onConnectSubmit);
    dialog.addEventListener('input', onDialogInput);
    dialog.addEventListener('change', onDialogInput);
    document.body.append(dialog);
    return dialog;
  }
  function closeDialog() { if (dialog?.open) dialog.close(); else { const current = activate(); current.dialog = null; } }
  function renderDialog() {
    const current = activate();
    if (!current.dialog || !dialog) return;
    if (current.dialog.kind === 'connect') {
      if (!dialog.querySelector('[data-mailbox-connect-form]')) dialog.innerHTML = connectDialogMarkup(context(), current);
      const t = key => setupCopy(context().language, key);
      syncMailbox(dialog, t, { status: current.overview, panel: current.dialog.provider, connecting: current.busy ? current.dialog.provider : '',
        blocked: current.busy || current.dialog.waiting, gmailMethod: current.gmailMethod });
      for (const tab of dialog.querySelectorAll('.setup-lead, .setup-mailbox-tabs, [data-mail-note]')) tab.hidden = true;
      dialog.querySelector('[data-mailbox-oauth]').innerHTML = current.dialog.waiting ? '<p class="mailbox-settings-note">' + e(text('googleWaiting')) + '</p>' : '';
      dialog.querySelector('[data-mailbox-dialog-feedback]').textContent = current.formError || '';
    } else {
      const scroll = dialog.scrollTop;
      dialog.innerHTML = confirmDialogMarkup(context(), current);
      dialog.scrollTop = scroll;
    }
  }
  function openConnect(provider, mode) {
    const current = activate();
    current.dialog = { kind: 'connect', provider, mode }; current.formError = ''; current.notice = '';
    current.gmailMethod = defaultGmailMethod(current.overview);
    ensureDialog().innerHTML = '';
    renderDialog();
    dialog.showModal();
    dialog.querySelector('input:not([type="hidden"]):not(:disabled)')?.focus();
  }
  function openConfirm() {
    const current = activate();
    current.dialog = { kind: 'confirm' }; current.formError = '';
    current.choices = { ...defaultChoices(current.overview), ...Object.fromEntries(Object.entries(current.choices).filter(([id]) => (current.overview?.sources || []).some(s => s.source_id === id))) };
    ensureDialog().innerHTML = '';
    renderDialog();
    dialog.showModal();
  }
  function onDialogClick(event) {
    const current = activate(), button = event.target.closest('button');
    if (event.target === dialog) { closeDialog(); return; }
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-mailbox-close')) closeDialog();
    else if (button.dataset.gmailMethod) { current.gmailMethod = button.dataset.gmailMethod; renderDialog(); }
    else if (button.hasAttribute('data-mailbox-submit')) void submitConfirm();
  }
  function onDialogInput(event) {
    const current = activate(), target = event.target;
    if (current.dialog?.kind === 'connect') { renderDialog(); return; }
    if (target.dataset.mailboxChoice) {
      const id = target.dataset.mailboxChoice, sourceRow = (current.overview?.sources || []).find(s => s.source_id === id);
      const type = sourceRow?.account_type === 'credit' ? 'credit' : 'bank';
      const first = (current.overview?.accounts || []).find(acc => acc.currency === sourceRow?.currency && acc.account_type === type);
      current.choices[id] = target.value === 'create' ? { action: 'create', name: sourceRow?.account_draft?.name || sourceRow?.bank_name || '', opening_balance: '', credit_limit: '' }
        : target.value === 'bind' ? { action: 'bind', account_number: first?.account_number } : { action: 'skip' };
      renderDialog();
    } else if (target.dataset.mailboxField) {
      const choice = current.choices[target.dataset.mailboxFor] ||= {};
      choice[target.dataset.mailboxField] = target.value;
    }
  }
  async function onConnectSubmit(event) {
    const current = activate(), version = epoch;
    if (!current.dialog || current.dialog.kind !== 'connect') return;
    event.preventDefault();
    const submitter = event.submitter, form = event.target, { provider, mode } = current.dialog;
    if (!submitter?.dataset.mailConnect || current.busy) return;
    const fields = Object.fromEntries(new FormData(form));
    const method = provider === 'gmail' ? submitter.dataset.mailMethod || 'oauth' : '';
    const data = { providers: [provider], connect_provider: provider };
    if (provider === 'gmail') data.gmail_method = method;
    if (provider === '163' || method === 'imap') {
      data.email = String(fields[provider === '163' ? 'netease_email' : 'gmail_email'] || '').trim();
      const code = String(fields[provider === '163' ? 'netease_code' : 'gmail_app_password'] || '');
      if (code) data.authorization_code = code;
    }
    // Reserve the Google tab during the click so a popup blocker allows it.
    popup = provider === 'gmail' && method === 'oauth' ? beginAuthorization({ message: setupCopy(context().language, 'gmailOpening') }) : null;
    current.busy = true; current.formError = ''; renderDialog();
    for (const input of form.querySelectorAll('input[type="password"]')) input.value = '';
    try {
      const payload = await api.connectSetupMailbox(data, current.source);
      if (version !== epoch) return;
      const result = payload?.result || {};
      current.overview = { ...current.overview, ...result };
      if (result.authorization_url) {
        current.dialog = { ...current.dialog, waiting: true, tokenAt: current.overview?.gmail_token_updated || 0 };
        if (!popup?.navigate(result.authorization_url)) window.open(result.authorization_url, '_blank', 'noopener');
        popup = null;
        schedule();
      } else {
        popup?.cancel(); popup = null;
        finishConnect(current, { provider, mode });
      }
    } catch (error) {
      popup?.cancel(); popup = null;
      if (version === epoch) current.formError = failure(error);
    } finally {
      if (version === epoch) { current.busy = false; renderDialog(); patch(); schedule(); }
    }
  }
  async function submitConfirm() {
    const current = activate(), version = epoch, confirmations = [];
    for (const sourceRow of current.overview?.sources || []) {
      const choice = current.choices[sourceRow.source_id] || {}, type = sourceRow.account_type === 'credit' ? 'credit' : 'bank';
      if (choice.action === 'skip') confirmations.push({ source_id: sourceRow.source_id, action: 'skip' });
      else if (choice.action === 'bind' && choice.account_number) confirmations.push({ source_id: sourceRow.source_id, action: 'bind', account_number: Number(choice.account_number) });
      else if (choice.action === 'create') {
        const name = String(choice.name || '').trim(), balance = String(choice.opening_balance || '').trim(), limit = String(choice.credit_limit || '').trim();
        if (!name) { current.formError = 'needName'; renderDialog(); return; }
        if (type === 'credit' && !limit) { current.formError = 'needLimit'; renderDialog(); return; }
        // A credit account takes what is owed and stores it as a negative balance.
        let opening = balance;
        if (balance && type === 'credit') {
          try { opening = debtBalance(balance, sourceRow.currency); } catch { current.formError = 'debtInvalid'; renderDialog(); return; }
          if (exceedsLimit(opening.replace('-', ''), limit)) { current.formError = 'debtOverLimit'; renderDialog(); return; }
        }
        confirmations.push({ source_id: sourceRow.source_id, action: 'bind', account: { name, account_type: type, institution: sourceRow.bank_name || '',
          currency: sourceRow.currency, ...(opening ? { opening_balance: opening } : {}), ...(type === 'credit' ? { credit_limit: limit } : {}) } });
      } else { current.formError = 'needAccount'; renderDialog(); return; }
    }
    current.busy = true; current.formError = ''; renderDialog();
    try {
      const payload = await api.confirmSetupMailbox(confirmations, current.source);
      if (version !== epoch) return;
      current.overview = payload?.result || current.overview;
      current.busy = false;
      closeDialog();
    } catch (error) {
      if (version === epoch) { current.busy = false; current.formError = ''; renderDialog(); dialog.querySelector('[role="alert"]').textContent = failure(error); }
    } finally {
      if (version === epoch) { patch(); schedule(); }
    }
  }
  async function act(call, confirmMessage) {
    const current = activate(), version = epoch;
    if (current.busy || (confirmMessage && !confirmAction(confirmMessage))) return;
    current.busy = true; current.error = ''; current.notice = ''; patch();
    try {
      const payload = await call(current.source);
      if (version === epoch) current.overview = payload?.result || current.overview;
    } catch (error) {
      if (version === epoch) current.notice = failure(error);
    } finally {
      if (version === epoch) { current.busy = false; patch(); schedule(); }
    }
  }
  function leave() {
    epoch += 1; entered = false; clearTimer(timer); timer = null;
    const current = state.mailboxSettings;
    if (current) { current.loading = false; current.busy = false; }
    closeDialog();
  }
  function mount() {
    if (state.route !== 'settings') { leave(); return; }
    activate();
    const host = root()?.querySelector('[data-mailbox-settings]');
    if (!host) return;
    setupStyles();
    if (!mounted.has(host)) {
      mounted.add(host);
      host.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.dataset.mailboxAction) openConnect(button.dataset.mailboxProvider, button.dataset.mailboxAction);
        else if (button.hasAttribute('data-mailbox-review')) openConfirm();
        else if (button.hasAttribute('data-mailbox-retry')) void act(api.retrySetupMailbox.bind(api));
        else if (button.hasAttribute('data-mailbox-cancel')) void act(api.cancelSetupMailbox.bind(api), text('cancelConfirm'));
        else if (button.hasAttribute('data-mailbox-dismiss')) void act(api.dismissSetupMailbox.bind(api));
      });
    }
    patch();
    if (!entered) { entered = true; void load(); }
  }
  activate();
  return { activate, mount, patch, leave, load };
}

// The sidebar entry while Google has revoked the Gmail authorization; one click opens Settings → Mailboxes.
export function mailboxAlertView(ctx) {
  if (!ctx.state.gmailRevoked) return '';
  const label = mailboxText(ctx.language, 'entryRevoked'), title = mailboxText(ctx.language, 'revokedToast');
  const mark = '<span class="sidebar-update-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 4.25v4.5M8 11.5v.25"/></svg></span>';
  return '<button class="sidebar-update sidebar-alert" type="button" data-mailbox-alert title="' + a(title) + '" aria-label="' + a(title) + '">' +
    mark + '<span class="sidebar-update-label">' + e(label) + '</span></button>';
}

const alertVersions = new WeakMap();
export function patchMailboxAlert(root, ctx) {
  const host = root?.querySelector('[data-mailbox-alert-host]');
  if (!host) return;
  const html = mailboxAlertView(ctx);
  if (alertVersions.get(host) === html) return;
  host.innerHTML = html;
  alertVersions.set(host, html);
}

// Outside Settings: when Google revokes the Gmail authorization (changing the Google password does this), say so once
// per revocation and keep the sidebar entry until Gmail is reconnected.
export function watchGmailAuthorization({ state, api, notify, context, root = () => document, intervalMs = 300000,
  setTimer = setTimeout, clearTimer = clearTimeout, openSettings = () => { location.hash = '#settings'; }, onChange = () => {} }) {
  let timer = null, told = null, watching = false;
  const mounted = new WeakSet();
  async function check() {
    clearTimer(timer); timer = null;
    try {
      const overview = (await api.getSetupMailboxes())?.result;
      if (overview) {
        const revoked = gmailRevokedAt(overview), changed = revoked !== (state.gmailRevoked ?? null);
        state.gmailRevoked = revoked;
        if (revoked && told !== revoked) { told = revoked; notify(mailboxText(context().language, 'revokedToast'), 'error'); }
        patchMailboxAlert(root(), context());
        if (changed) onChange(revoked);
      }
    } catch { /* Not reachable from this page, or the Backend is restarting: look again later. */ }
    if (watching) timer = setTimer(check, intervalMs);
  }
  function mount() {
    const page = root();
    if (!page || mounted.has(page)) return;
    mounted.add(page);
    page.addEventListener('click', event => {
      if (!event.target.closest?.('[data-mailbox-alert]')) return;
      openSettings();
      setTimer(() => root()?.querySelector('[data-mailbox-settings]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
    });
  }
  return { watch() { mount(); if (watching) return; watching = true; void check(); }, check,
    stop() { watching = false; clearTimer(timer); timer = null; } };
}

// Outside Settings too: while a mailbox is being added, check now and then and say when it needs the user.
// The first look (opening the app) reminds about a job waiting for the user; later looks report each change.
const WAITING = { review: 'jobReview', rules_review: 'jobRulesReview', failed: 'jobFailed' };
export function watchMailboxJob({ api, notify, language, intervalMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout, start = true }) {
  let last, timer = null, round = 0;
  const tick = async () => {
    clearTimer(timer); timer = null;
    const mine = ++round;
    let overview;
    try { overview = (await api.getSetupMailboxes())?.result; } catch { /* Try again later. */ }
    if (mine !== round) return;   // A newer look (a job just started) carries on.
    if (!overview) { if (last && RUNNING.includes(last)) timer = setTimer(tick, intervalMs); return; }
    const job = overview.job || null, lang = language(), mailbox = job ? mailboxText(lang, job.provider) : '';
    // Indexing that failed keeps its state; Settings shows it as a failure with a retry.
    const phase = job?.state === 'indexing' && ['failed', 'interrupted'].includes(overview.job_progress?.indexing_status) ? 'failed' : job?.state || null;
    const key = phase === 'done' ? (job.found === 0 ? 'jobDoneNone' : 'jobDone') : WAITING[phase];
    if (key && phase !== last && (last !== undefined || phase !== 'done')) notify(mailboxText(lang, key, { mailbox, count: job.found || 0 }));
    last = phase;
    if (RUNNING.includes(phase)) timer = setTimer(tick, intervalMs);
    else if (phase && phase !== 'done') timer = setTimer(tick, intervalMs * 4);
  };
  if (start) void tick();
  return { check: () => tick() };
}
