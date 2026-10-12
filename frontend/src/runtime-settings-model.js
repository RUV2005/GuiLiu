const field = (path, type, labels, options = {}) => ({ path, type, labels, ...options });
export const RUNTIME_MODELS = ['qwen3.8-flash', 'qwen3.8-max', 'qwen-max'];
export const RUNTIME_FIELDS = [
  field('models.chat', 'model', ['对话', 'チャット', 'Chat']),
  field('models.mail_classification', 'model', ['邮件分类', 'メール分類', 'Mail classification']),
  field('models.dealing_classification', 'model', ['账单分类', '取引分類', 'Transaction classification']),
  field('models.ocr_intent', 'model', ['OCR 意图判断', 'OCR 意図判定', 'OCR intent']),
  field('models.ocr', 'text', ['图片 OCR', '画像 OCR', 'Image OCR']),
  field('models.adr', 'model', ['ADR', 'ADR', 'ADR']),
  field('agent.max_context_tokens', 'integer', ['上下文预算', 'コンテキスト予算', 'Context budget'], { nullable: true }),
  field('agent.max_output_tokens', 'integer', ['通用输出预算', '共通出力予算', 'Default output budget']),
  field('agent.chat_output_tokens', 'integer', ['对话输出预算', 'チャット出力予算', 'Chat output budget'], { nullable: true }),
  field('agent.max_react_steps', 'integer', ['通用 ReAct 步数', '共通 ReAct ステップ数', 'Default ReAct steps']),
  field('agent.scheduled_context_tokens', 'integer', ['定时任务上下文预算', '定期タスクのコンテキスト予算', 'Scheduled context budget']),
  field('agent.scheduled_output_tokens', 'integer', ['定时任务输出预算', '定期タスクの出力予算', 'Scheduled output budget']),
  field('agent.scheduled_react_steps', 'integer', ['定时任务 ReAct 步数', '定期タスクの ReAct ステップ数', 'Scheduled ReAct steps']),
  field('loop.enabled', 'boolean', ['邮件自动同步', 'メールの自動同期', 'Automatic mail sync']),
  field('loop.interval_seconds', 'number', ['循环间隔（秒）', 'ループ間隔（秒）', 'Loop interval (seconds)']),
  field('loop.ocr_mail_query', 'text', ['OCR 邮件查询条件', 'OCR メール検索条件', 'OCR mail query'], { allowEmpty: true }),
  field('loop.vector_mail_query', 'text', ['向量邮件查询条件', 'ベクトルメール検索条件', 'Vector mail query']),
  field('loop.vector_mail_max_results', 'integer', ['每轮向量邮件数量', 'ループごとのベクトルメール件数', 'Vector mails per loop'], { min: 0 }),
  field('loop.adr_ocr_limit', 'integer', ['每轮 ADR / OCR 数量', 'ループごとの ADR / OCR 件数', 'ADR / OCR items per loop'], { min: 0 }),
  field('adr.enabled', 'boolean', ['定时匹配', '定期照合', 'Scheduled matching']),
  field('adr.interval_seconds', 'number', ['匹配间隔（秒）', '照合間隔（秒）', 'Matching interval (seconds)']),
  field('adr.new_mail_enabled', 'boolean', ['新邮件触发 ADR', '新着メールで ADR を起動', 'Run ADR on new mail']),
  field('adr.output_tokens', 'integer', ['ADR 输出预算', 'ADR 出力予算', 'ADR output budget']),
  field('adr.max_react_steps', 'integer', ['ADR ReAct 步数', 'ADR ReAct ステップ数', 'ADR ReAct steps']),
  field('automation.enabled', 'boolean', ['自动任务调度', '自動タスクのスケジューラー', 'Automation scheduler']),
];
export const runtimeValue = (settings, path) => path.split('.').reduce((value, key) => value?.[key], settings);
export const runtimeLabel = (field, language) => field.labels[{ zh: 0, ja: 1, en: 2 }[language] ?? 2];
export const runtimeDraft = settings => Object.fromEntries(RUNTIME_FIELDS.map(field => {
  const value = runtimeValue(settings, field.path);
  return [field.path, field.type === 'boolean' ? value : value == null ? '' : String(value)];
}));
export const createRuntimeState = source => ({ source, document: null, draft: {}, loading: false, saving: false,
  error: null, fieldErrors: {}, notice: '', attempted: false });
export function runtimeDirty(state) {
  if (!state.document) return false;
  const original = runtimeDraft(state.document.settings);
  return RUNTIME_FIELDS.some(field => state.draft[field.path] !== original[field.path]);
}

export function readRuntimeDocument(response) {
  const doc = response?.result;
  if (response?.success !== true || !doc || doc.apply_mode !== 'restart_required' || doc.settings?.schema_version !== 1
    || !Array.isArray(doc.restart_services) || doc.restart_services.some(name => typeof name !== 'string')
    || !doc.backend_environment_overrides || typeof doc.backend_environment_overrides !== 'object'
    || Array.isArray(doc.backend_environment_overrides)
    || Object.values(doc.backend_environment_overrides).some(path => typeof path !== 'string')) throw new Error('invalidResponse');
  for (const path of ['services.backend_url', 'services.agent_url', 'storage.backend_db']) {
    if (typeof runtimeValue(doc.settings, path) !== 'string') throw new Error('invalidResponse');
  }
  for (const field of RUNTIME_FIELDS) {
    const value = runtimeValue(doc.settings, field.path);
    const valid = field.nullable && value === null || (field.type === 'boolean' ? typeof value === 'boolean'
      : ['model', 'text'].includes(field.type) ? typeof value === 'string' && (field.allowEmpty || value.trim().length > 0)
        : typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? 1)
          && (field.type !== 'integer' || Number.isSafeInteger(value)));
    if (!valid) throw new Error('invalidResponse');
  }
  return structuredClone(doc);
}

export function runtimePatch(state) {
  const errors = {}, patch = {}, values = {};
  if (!state.document) return { patch, errors: { form: 'notLoaded' } };
  for (const field of RUNTIME_FIELDS) {
    const raw = state.draft[field.path];
    let value = raw;
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') errors[field.path] = 'invalidBoolean';
    } else if (['model', 'text'].includes(field.type)) {
      if (typeof raw !== 'string' || !field.allowEmpty && !raw.trim()) errors[field.path] = 'required';
      // Preserve unchanged query whitespace rather than submitting unrelated edits.
      value = raw === runtimeValue(state.document.settings, field.path) ? raw : String(raw ?? '').trim();
      if (field.type === 'model' && !RUNTIME_MODELS.includes(value)) errors[field.path] = 'invalidModel';
    } else {
      const text = String(raw ?? '').trim();
      value = text === '' && field.nullable ? null : Number(text);
      if (value !== null && (!text || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) || !Number.isFinite(value)
        || value < (field.min ?? 1) || value > Number.MAX_SAFE_INTEGER || field.type === 'integer' && !Number.isSafeInteger(value))) {
        errors[field.path] = field.min === 0 ? 'nonnegativeInteger' : field.type === 'number' ? 'positiveNumber' : 'positiveInteger';
      }
    }
    values[field.path] = value;
    if (value !== runtimeValue(state.document.settings, field.path)) {
      const [group, key] = field.path.split('.');
      (patch[group] ||= {})[key] = value;
    }
  }
  if (!Object.keys(errors).length) {
    const context = values['agent.max_context_tokens'];
    const caps = RUNTIME_FIELDS.filter(field => field.type === 'model').map(field =>
      Math.min(context ?? Infinity, values[field.path] === 'qwen-max' ? 32768 : 1000000));
    if (values['agent.max_output_tokens'] >= Math.min(...caps)) errors['agent.max_output_tokens'] = 'outputContext';
    const chatContext = Math.min(context ?? Infinity, values['models.chat'] === 'qwen-max' ? 32768 : 1000000);
    if (values['agent.chat_output_tokens'] !== null && values['agent.chat_output_tokens'] >= chatContext) errors['agent.chat_output_tokens'] = 'outputContext';
    if (values['agent.scheduled_output_tokens'] >= values['agent.scheduled_context_tokens']) errors['agent.scheduled_output_tokens'] = 'outputContext';
  }
  return { patch, errors };
}
