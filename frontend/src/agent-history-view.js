import { escapeHtml as html, escapeAttr as attr, formatDateTime } from './utils.js';
import { sessionTitle } from './agent-history.js';
import { informationText } from './agent-information-copy.js';
export { historySendBlocked } from './agent-history.js';

const copy = {
  zh: { sessions: '会话', new: '新建会话', earlier: '加载更早记录', more: '更多会话', loading: '正在读取历史', empty: '暂无历史会话', retry: '重新加载',
    rename: '修改会话名', open: '打开会话', saveTitle: '保存名称', cancelTitle: '取消修改', titleSaving: '正在保存名称…', titleSaved: '会话名已保存',
    titleNew: '先发送一条消息，再修改会话名', titleInvalid: '请输入 1～120 个字符，不能换行。', titleMissing: '会话不存在或尚未保存，原名称未修改。',
    titleUnavailable: '历史存储暂不可用，输入已保留，请重试。', titleFailed: '未能确认保存成功，原名称和输入已保留，请重试。',
    delete: '删除会话', deleteConfirm: '删除此会话？聊天记录、上下文和图表将永久删除，无法撤销。不会影响其他会话、账单和账户。',
    deleting: '正在删除会话…', deleted: '会话已删除', deleteRetry: '重试删除', dismiss: '关闭', deleteBusy: '会话正在运行，结束后才能删除。',
    deleteFailed: '删除未成功，本地内容已保留。', deleteUncertain: '尚未确认清理完成，本地内容已保留。请重试删除，不要在此会话继续发送。',
    failedLoad: '历史加载失败，现有内容已保留。', missing: '服务器上找不到此会话，已保留本地内容。', invalid: '历史请求参数有误。', unavailable: '历史存储暂不可用。',
    canvas: '部分历史图表尚未恢复。', running: '处理中', completed: '已完成', failed: '未完成', cancelled: '已取消', limit_reached: '已达到运行限制', interrupted: '已中断' },
  ja: { sessions: '会話', new: '新しい会話', earlier: '以前の履歴を読み込む', more: 'さらに表示', loading: '履歴を読み込み中', empty: '会話はまだありません', retry: '再読み込み',
    rename: '会話名を変更', open: '会話を開く', saveTitle: '名前を保存', cancelTitle: '変更を取り消す', titleSaving: '名前を保存中…', titleSaved: '会話名を保存しました',
    titleNew: 'メッセージを送信してから名前を変更できます', titleInvalid: '改行なしで 1～120 文字を入力してください。', titleMissing: '会話が存在しないか、まだ保存されていません。元の名前は変更していません。',
    titleUnavailable: '履歴ストレージを利用できません。入力内容を保持しています。再試行してください。', titleFailed: '保存を確認できませんでした。元の名前と入力内容を保持しています。再試行してください。',
    delete: '会話を削除', deleteConfirm: 'この会話を削除しますか？履歴、コンテキスト、グラフは完全に削除され、元に戻せません。他の会話、取引、口座には影響しません。',
    deleting: '会話を削除中…', deleted: '会話を削除しました', deleteRetry: '削除を再試行', dismiss: '閉じる', deleteBusy: '実行中の会話は、処理が終わってから削除できます。',
    deleteFailed: '削除できませんでした。ローカルの内容は保持しています。', deleteUncertain: '削除の完了を確認できません。ローカルの内容は保持しています。削除を再試行し、この会話への送信は控えてください。',
    failedLoad: '履歴を取得できませんでした。表示中の内容は保持しています。', missing: 'サーバーに会話が見つかりません。ローカルの内容は保持しています。', invalid: '履歴リクエストのパラメータが不正です。', unavailable: '履歴ストレージを利用できません。',
    canvas: '一部の過去のグラフを復元できていません。', running: '処理中', completed: '完了', failed: '未完了', cancelled: 'キャンセル済み', limit_reached: '実行上限に到達', interrupted: '中断' },
  en: { sessions: 'Conversations', new: 'New conversation', earlier: 'Load earlier messages', more: 'More conversations', loading: 'Loading history', empty: 'No conversations yet', retry: 'Reload',
    rename: 'Rename conversation', open: 'Open conversation', saveTitle: 'Save name', cancelTitle: 'Cancel rename', titleSaving: 'Saving name…', titleSaved: 'Conversation name saved',
    titleNew: 'Send a message before renaming this conversation', titleInvalid: 'Enter 1–120 characters without line breaks.', titleMissing: 'Conversation not found or not saved yet. The original name was kept.',
    titleUnavailable: 'History storage is unavailable. Your input was kept. Please retry.', titleFailed: 'Save could not be confirmed. The original name and your input were kept. Please retry.',
    delete: 'Delete conversation', deleteConfirm: 'Delete this conversation? Its messages, context and charts will be permanently removed. This cannot be undone. Other conversations, transactions and accounts are not affected.',
    deleting: 'Deleting conversation…', deleted: 'Conversation deleted', deleteRetry: 'Retry deletion', dismiss: 'Dismiss', deleteBusy: 'This conversation is running. Wait until it finishes before deleting.',
    deleteFailed: 'Deletion failed. Local content was kept.', deleteUncertain: 'Cleanup has not been confirmed. Local content was kept. Retry deletion and do not send more messages in this conversation.',
    failedLoad: 'History could not be loaded. Existing content was kept.', missing: 'Conversation not found on the server. Local content was kept.', invalid: 'Invalid history request parameters.', unavailable: 'History storage is unavailable.',
    canvas: 'Some earlier charts have not been restored.', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', limit_reached: 'Run limit reached', interrupted: 'Interrupted' },
};
export const historyText = (language, key) => (copy[language] || copy.en)[key] || (key === 'waiting_reply' ? informationText(language, key) : key);
const errorText = (language, error) => historyText(language, ({ 404: 'missing', 422: 'invalid', 503: 'unavailable' })[error.status] || 'failedLoad')
  + (error.message ? ' ' + error.message : '');

export const historyToolbar = () => '<div class="agent-session-toolbar" data-agent-session-toolbar></div>';
export const historyControls = () => '<div class="agent-history-controls" data-agent-history-controls aria-live="polite"></div>';

export function patchHistoryControls(ctx, root = document) {
  const h = ctx.state.agentHistory;
  if (!h) return;
  const label = key => historyText(ctx.language, key), removal = h.removal;
  const disabled = ctx.state.agentLoading || removal?.pending || h.rename?.saving ? ' disabled' : '';
  const selected = h.sessions.find(item => item.session_id === h.sessionId);
  const title = sessionTitle(h, h.sessionId, h.isNew ? label('new') : h.session?.title || selected?.title || label('sessions'));
  const unsaved = h.isNew || !(selected || h.confirmed || h.metadata?.[h.sessionId]);
  const pencil = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/></svg>';
  const renameError = () => h.rename?.error ? label(h.rename.error) + (h.rename.detail ? ' ' + h.rename.detail : '') : '';
  const editor = place => '<div class="agent-session-editor" data-agent-session-editor="' + attr(h.rename.sessionId) + '" data-place="' + place + '">' +
    '<input data-agent-title-input aria-label="' + attr(label('rename')) + '" aria-invalid="' + Boolean(h.rename.error) + '" aria-describedby="agent-title-error-' + place + '" type="text" maxlength="240" autocomplete="off" value="' + attr(h.rename.value) + '"' + (h.rename.saving ? ' readonly' : '') + '>' +
    '<button type="button" data-agent-title-save aria-label="' + attr(label('saveTitle')) + '" title="' + attr(label('saveTitle')) + '"' + (h.rename.saving ? ' disabled' : '') + '><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>' +
    '<button type="button" data-agent-title-cancel aria-label="' + attr(label('cancelTitle')) + '" title="' + attr(label('cancelTitle')) + '"' + (h.rename.saving ? ' disabled' : '') + '><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>' +
    '<small data-agent-title-progress role="status"' + (h.rename.saving ? '' : ' hidden') + '>' + html(label('titleSaving')) + '</small><small data-agent-title-error id="agent-title-error-' + place + '" role="alert"' + (h.rename.error ? '' : ' hidden') + '>' + html(renameError()) + '</small></div>';
  const list = h.open ? '<div class="agent-session-list" role="group" aria-label="' + attr(label('sessions')) + '">' +
    (h.listError ? '<p role="status">' + html(errorText(ctx.language, h.listError)) + '</p><button type="button" data-agent-list-retry>' + html(label('retry')) + '</button>' : '') +
    h.sessions.map(item => {
      const running = item.status === 'running' || (item.session_id === h.sessionId && h.remoteRunning);
      const unavailable = disabled || running || Boolean(removal);
      const name = sessionTitle(h, item.session_id, item.title || label('new'));
      return '<div class="agent-session-row" data-current="' + (h.sessionId === item.session_id) + '"><div class="agent-session-name">' +
        (h.rename?.sessionId === item.session_id && h.rename.place === 'list' ? editor('list') : '<button type="button" data-agent-select-session="' + attr(item.session_id) + '" aria-pressed="' + (h.sessionId === item.session_id) + '" aria-label="' + attr(label('open') + ': ' + name) + '" title="' + attr(label('open')) + '"' + disabled +
        '><strong>' + html(name) + '</strong><small>' + html(formatDateTime(item.updated_at, ctx.language)) + ' · ' + html(label(item.status)) + '</small></button>') + '</div>' +
        '<button type="button" class="agent-session-rename" data-agent-rename-session="' + attr(item.session_id) + '" data-agent-rename-place="list" aria-label="' + attr(label('rename') + ': ' + name) + '" title="' + attr(label('rename')) + '"' + (h.rename?.sessionId === item.session_id || h.rename?.saving || removal?.pending || removal?.sessionId === item.session_id ? ' disabled' : '') + '>' + pencil + '</button>' +
        '<button type="button" class="agent-session-delete" data-agent-delete-session="' + attr(item.session_id) + '" aria-label="' + attr(label('delete') + ': ' + name) + '" title="' + attr(label(running ? 'deleteBusy' : 'delete')) + '"' + (unavailable ? ' disabled' : '') +
        '><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg></button></div>';
    }).join('') +
    (h.listLoading ? '<p role="status" data-agent-sessions-loading>' + html(label('loading')) + '</p>' : !h.sessions.length && !h.listError ? '<p>' + html(label('empty')) + '</p>' : '') +
    (h.offset < h.total ? '<button type="button" data-agent-sessions-more' + (h.listLoading ? ' disabled' : '') + '>' + html(label('more')) + '</button>' : '') + '</div>' : '';
  const status = removal?.error?.status;
  const feedback = removal ? '<div class="agent-session-feedback" role="status"><span>' + html(removal.title) + ' · ' + html(label(removal.pending ? 'deleting' : status === 409 ? 'deleteBusy' : [404, 422].includes(status) ? 'deleteFailed' : 'deleteUncertain')) +
    (removal.error?.message ? ' ' + html(removal.error.message) : '') + '</span>' + (!removal.pending ? '<div><button type="button" data-agent-delete-retry' + disabled + '>' + html(label('deleteRetry')) + '</button>' +
    ([404, 409, 422].includes(status) ? '<button type="button" data-agent-delete-dismiss>' + html(label('dismiss')) + '</button>' : '') + '</div>' : '') + '</div>' :
    h.deleteNotice || h.renameNotice ? '<div class="agent-session-feedback" role="status">' + html(label(h.deleteNotice ? 'deleted' : 'titleSaved')) + '</div>' : '';
  const toolbar = (h.rename?.place === 'current' ? editor('current') : '<div class="agent-session-current"><span>' + html(title) + '</span></div>' +
    '<button type="button" class="icon-button agent-session-rename" data-agent-rename-session="' + attr(h.sessionId) + '" data-agent-rename-place="current" aria-label="' + attr(label('rename') + ': ' + title) + '" title="' + attr(label(unsaved ? 'titleNew' : 'rename')) + '"' + (unsaved || h.rename?.saving || removal?.pending || removal?.sessionId === h.sessionId ? ' disabled' : '') + '>' + pencil + '</button>') +
    '<button type="button" class="icon-button" data-agent-sessions-toggle aria-expanded="' + Boolean(h.open) + '" aria-label="' + attr(label('sessions')) + '" title="' + attr(label('sessions')) + '">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' +
    '<button type="button" class="icon-button" data-agent-new-session title="' + attr(label('new')) + '" aria-label="' + attr(label('new')) + '"' + disabled +
    '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' + feedback + list;
  const controls = (h.loading || h.loadingMore || (h.listLoading && !h.hadSelection && !h.isNew) ? '<span role="status">' + html(label('loading')) + '</span>' : '') +
    (h.remoteWaiting ? '<p role="status">' + html(informationText(ctx.language, 'reply_waiting_reply')) + '</p><button class="button compact" type="button" data-agent-open-waiting="' + attr(h.sessionId) + '">' + html(informationText(ctx.language, 'replyOpenWaiting')) + '</button>' : '') +
    (h.listError && !h.hadSelection && !h.isNew ? '<p role="status">' + html(errorText(ctx.language, h.listError)) + '</p><button class="button compact" type="button" data-agent-list-retry>' + html(label('retry')) + '</button>' : '') +
    (h.error ? '<p role="status">' + html(errorText(ctx.language, h.error)) + '</p><button class="button compact" type="button" data-agent-history-retry>' + html(label('retry')) + '</button>' : '') +
    (h.canvasError ? '<p>' + html(label('canvas')) + '</p><button class="button compact" type="button" data-agent-history-retry>' + html(label('retry')) + '</button>' : '') +
    (h.hasMore && !h.error ? '<button class="button compact" type="button" data-agent-load-earlier' + (h.loading || h.loadingMore || ctx.state.agentLoading ? ' disabled' : '') + '>' + html(label('earlier')) + '</button>' : '');
  for (const [selector, markup] of [['[data-agent-session-toolbar]', toolbar], ['[data-agent-history-controls]', controls]]) {
    const node = root.querySelector(selector);
    if (!node || node.dataset.markup === markup) continue;
    const editing = node.querySelector('[data-agent-session-editor]');
    // Preserve the live input (including an IME composition) during background history updates.
    if (editing && h.rename?.sessionId === editing.dataset.agentSessionEditor && h.rename.place === editing.dataset.place) {
      if (!h.listLoading) node.querySelector('[data-agent-sessions-loading]')?.remove();
      editing.querySelector('input').setAttribute('aria-invalid', String(Boolean(h.rename.error)));
      editing.querySelector('input').readOnly = Boolean(h.rename.saving);
      editing.querySelectorAll('button').forEach(button => { button.disabled = Boolean(h.rename.saving); });
      editing.querySelector('[data-agent-title-progress]').hidden = !h.rename.saving;
      const error = editing.querySelector('[data-agent-title-error]');
      error.hidden = !h.rename.error; error.textContent = renameError();
      continue;
    }
    const focus = node.contains(node.ownerDocument.activeElement) ? node.ownerDocument.activeElement : null;
    const renameId = focus?.dataset.agentRenameSession || focus?.closest('[data-agent-session-editor]')?.dataset.agentSessionEditor;
    const renamePlace = focus?.dataset.agentRenamePlace || focus?.closest('[data-agent-session-editor]')?.dataset.place;
    const selectedId = focus?.dataset.agentSelectSession;
    const deleteId = focus?.dataset.agentDeleteSession;
    const focusSelector = ['data-agent-sessions-toggle', 'data-agent-new-session', 'data-agent-sessions-more', 'data-agent-list-retry', 'data-agent-history-retry', 'data-agent-load-earlier', 'data-agent-delete-retry', 'data-agent-delete-dismiss']
      .find(name => focus?.hasAttribute(name));
    const top = node.querySelector('.agent-session-list')?.scrollTop;
    node.innerHTML = markup; node.dataset.markup = markup;
    if (top != null && node.querySelector('.agent-session-list')) node.querySelector('.agent-session-list').scrollTop = top;
    const input = node.querySelector('[data-agent-title-input]');
    if (input) { input.focus({ preventScroll: true }); input.select(); }
    else if (renameId) [...node.querySelectorAll('[data-agent-rename-session]')].find(button => button.dataset.agentRenameSession === renameId && button.dataset.agentRenamePlace === renamePlace)?.focus({ preventScroll: true });
    else if (selectedId) ([...node.querySelectorAll('[data-agent-select-session]')].find(button => button.dataset.agentSelectSession === selectedId)
      || node.querySelector('[data-agent-sessions-toggle]'))?.focus({ preventScroll: true });
    else if (deleteId) ([...node.querySelectorAll('[data-agent-delete-session]')].find(button => button.dataset.agentDeleteSession === deleteId && !button.disabled)
      || node.querySelector('[data-agent-delete-retry], [data-agent-sessions-toggle]'))?.focus({ preventScroll: true });
    else if (focusSelector) (node.querySelector('[' + focusSelector + ']') || node.querySelector('[data-agent-sessions-toggle]'))?.focus({ preventScroll: true });
  }
}
