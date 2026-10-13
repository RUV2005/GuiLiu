const copy = {
  zh: {
    title: '运行配置', 
    
    
    models: '任务模型', loop: '自动记账',
    nullable: '留空表示自动（null）',
    
    reload: '重新读取', discard: '放弃修改', save: '保存运行配置', loading: '正在读取配置…', saving: '正在保存…',
    saved: '已保存。重启相关服务后生效，当前进程尚未应用这次修改。', dirty: '有未保存的修改',
    confirmDiscard: '放弃尚未保存的运行配置修改，并重新读取服务器配置？',
    notLoaded: '尚未读取运行配置。', loadFailed: '配置读取失败，未清空已有内容。',
    saveFailed: '保存未确认，修改内容已保留。可重新读取核对保存值，或手动重试。',
    unavailable: '运行配置存储不可用。', missing: '当前 Backend 未提供运行配置接口，请确认服务已更新并重启。',
    busy: '配置正在被其他进程写入，请稍后重试。', invalid: '后端拒绝了配置，请检查字段与预算。',
    invalidResponse: '接口返回了无法识别的配置，未覆盖当前内容。',
    required: '不能为空。', invalidModel: '请选择支持的模型。', invalidBoolean: '请选择开启或关闭。',
    positiveInteger: '请输入大于 0 的整数。', nonnegativeInteger: '请输入 0 或正整数。',
    positiveNumber: '请输入大于或等于 1 的秒数。', outputContext: '输出预算必须小于对应模型及配置的上下文上限。',
    validation: '请检查标记的字段。', unchanged: '没有需要保存的修改。',
  },
  ja: {
    title: '実行設定', 
    
    
    models: 'タスクのモデル', loop: '自動記帳',
    nullable: '空欄で自動（null）',
    
    reload: '再読み込み', discard: '変更を破棄', save: '実行設定を保存', loading: '設定を読み込み中…', saving: '保存中…',
    saved: '保存しました。関連サービスの再起動後に適用されます。実行中のプロセスにはまだ適用されていません。', dirty: '未保存の変更があります',
    confirmDiscard: '未保存の実行設定を破棄し、サーバーから再読み込みしますか？',
    notLoaded: '実行設定がまだ読み込まれていません。', loadFailed: '設定の読み込みに失敗しました。既存の内容は保持しています。',
    saveFailed: '保存を確認できませんでした。入力は保持しています。再読み込みで保存値を確認するか、手動で再試行してください。',
    unavailable: '実行設定のストレージを利用できません。', missing: 'Backend に実行設定 API がありません。更新と再起動を確認してください。',
    busy: '別のプロセスが設定を書き込み中です。後ほど再試行してください。', invalid: '設定が拒否されました。項目と予算を確認してください。',
    invalidResponse: '設定の応答形式を認識できません。現在の内容は変更していません。',
    required: '入力が必要です。', invalidModel: '対応モデルを選択してください。', invalidBoolean: '有効または無効を選択してください。',
    positiveInteger: '正の整数を入力してください。', nonnegativeInteger: '0 または正の整数を入力してください。',
    positiveNumber: '1 以上の秒数を入力してください。', outputContext: '出力予算は対応するモデル・設定のコンテキスト上限未満にしてください。',
    validation: '表示された項目を確認してください。', unchanged: '保存する変更はありません。',
  },
  en: {
    title: 'Runtime settings', 
    
    
    models: 'Task models', loop: 'Automatic bookkeeping',
    nullable: 'Leave empty for automatic (null)',
    
    reload: 'Reload', discard: 'Discard changes', save: 'Save runtime settings', loading: 'Loading settings…', saving: 'Saving…',
    saved: 'Saved. Restart the relevant services to apply. Running processes have not applied this change.', dirty: 'Unsaved changes',
    confirmDiscard: 'Discard unsaved runtime changes and reload the saved server configuration?',
    notLoaded: 'Runtime settings have not loaded yet.', loadFailed: 'Could not load settings. Existing content was kept.',
    saveFailed: 'Saving was not confirmed. Your edits were kept. Reload to check saved values, or retry manually.',
    unavailable: 'Runtime settings storage is unavailable.', missing: 'This Backend does not provide the runtime settings API. Check its update and restart status.',
    busy: 'Another process is writing settings. Please retry shortly.', invalid: 'The backend rejected the settings. Check the fields and budgets.',
    invalidResponse: 'The settings response was invalid. Existing content was kept.',
    required: 'Required.', invalidModel: 'Choose a supported model.', invalidBoolean: 'Choose enabled or disabled.',
    positiveInteger: 'Enter a positive integer.', nonnegativeInteger: 'Enter 0 or a positive integer.',
    positiveNumber: 'Enter at least 1 second.', outputContext: 'Output must be smaller than the corresponding model and configured context limit.',
    validation: 'Check the highlighted fields.', unchanged: 'No changes to save.',
  },
};
export const runtimeText = (language, key) => (copy[language] || copy.en)[key] || key;
