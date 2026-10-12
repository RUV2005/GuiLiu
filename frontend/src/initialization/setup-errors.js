// Backend and Agent errors arrive as English sentences or as "Agent <route> HTTP <status>; <code>; retry this step".
// Known ones become the user's language plus what to do next; anything else is shown as sent.
import { setupErrorKey } from './model.js';

export const SERVICE_CODES = ['invalid_key', 'quota', 'rate_limited', 'model_unavailable', 'permission_denied', 'timeout',
  'network', 'service_error', 'bad_request', 'not_configured', 'invalid_format', 'unknown'];
const STAGES = { '/agent/initialization/discover': 'errStageDiscover', '/agent/bank-regex/generate': 'errStageRegex',
  '/vectorDB/adr-memory/batch': 'errStageIndex' };
const MODEL_OUTPUT = { invalid_model_json: 'errModelOutput', invalid_model_schema: 'errModelOutput', invalid_model_evidence: 'errModelEvidence',
  invalid_bank_regex: 'errModelRegex', context_budget_exceeded: 'errContextBudget' };

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const statusNote = status => status ? ` (HTTP ${status})` : '';
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
// CJK sentences join without a space; English ones need one.
const wide = code => (code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef);
const joined = text => text + (wide(text.charCodeAt(text.length - 1)) ? '' : ' ');
export const joinSentences = (first, second) => second ? joined(first) + second : first;

// What went wrong with one model service, e.g. from the setup API check or a model call during a later step.
export function serviceProblem(t, service, code, { model = '', status = '' } = {}) {
  return capital(fill(t('apiErr_' + (SERVICE_CODES.includes(code) ? code : 'unknown')), {
    service: t(service === 'embedding' ? 'embeddingShort' : 'llmShort'), model: model ? ` ${model}` : '', status: statusNote(status) }));
}

function gmailProblem(t, status, reasons) {
  if (status === 401 || /invalid_grant|authError/i.test(reasons)) return t('errGmailAuth');
  if (status === 429 || /rateLimit|quota/i.test(reasons)) return t('errGmailRate');
  if (status === 403) return fill(t('errGmailDenied'), { reason: reasons || 'forbidden' });
  return fill(t('errGmailUnavailable'), { status: statusNote(status) });
}

export function describeSetupError(t, message, step) {
  if (typeof message !== 'string') return JSON.stringify(message);
  let match = message.match(/^Agent (\/\S+) HTTP (\d+); ([a-z_]+); retry this step$/);
  if (match) {
    const [, route, status, code] = match;
    const service = code.startsWith('model_') ? code.slice(6) : '';
    const reason = SERVICE_CODES.includes(service)
      ? serviceProblem(t, route === '/vectorDB/adr-memory/batch' ? 'embedding' : 'llm', service, { status })
      : fill(t(MODEL_OUTPUT[code] || 'errAgentRequest'), { status: statusNote(status) });
    return fill(t('errWithStage'), { stage: t(STAGES[route] || 'errStageAgent'), reason });
  }
  if ((match = message.match(/^Embedding failed for some messages(?: \(([a-z_]+)\))?; retry vector_db$/)))
    return fill(t('errEmbeddingFailed'), { reason: match[1] ? joined(serviceProblem(t, 'embedding', match[1])) : '' });
  if ((match = message.match(/^Gmail HTTP (\d+); reason=([^;]*)/))) return gmailProblem(t, Number(match[1]), match[2]);
  if ((match = message.match(/^Rule needs review: ([\s\S]+)$/))) return fill(t('errRuleNeedsReview'), { reason: match[1] });
  if ((match = message.match(/^Bank regex regression failed: (.+)$/))) return fill(t('errRegexRegression'), { issues: match[1] });
  if ((match = message.match(/^Submit step: ([a-z_]+)$/))) return fill(t('errStepOrder'), { step: t(match[1]) });
  if ((match = message.match(/^(\w+): initialization step failed; retry this step$/)) && match[1] !== 'MailAccessError')
    return fill(t('errStepCrashed'), { type: match[1] });
  if ((match = message.match(/^(\w+): initialization operation failed$/)) && match[1] !== 'MailAccessError')
    return fill(t('errOperationFailed'), { type: match[1] });
  return t(setupErrorKey(message, step));
}
