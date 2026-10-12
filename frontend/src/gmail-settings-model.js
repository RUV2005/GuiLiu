import { safeAuthorizationUrl } from './initialization/model.js';

// No settings-specific Gmail protocol is published yet. This is not an HTTP adapter.
export const unavailableGmailAdapter = Object.freeze({ supported: false });
export const GMAIL_CONNECTION_STATES = ['valid', 'reauth_required', 'unverified'];
export const GMAIL_OPERATION_STATES = ['pending', 'succeeded', 'denied', 'cancelled', 'expired', 'failed'];

export function createGmailSettingsState(source, supported = false) {
  return { source, supported, email: '', connection: 'unverified', unreachable: false,
    busy: false, attempted: false, phase: 'idle', notice: '', error: '', operation: null, attemptId: '', expectedEmail: '', popupBlocked: false };
}

// These are private frontend adapter values, not an invented backend response schema.
export function readGmailConnection(value) {
  if (!value || !GMAIL_CONNECTION_STATES.includes(value.state)) throw new Error('invalidResponse');
  if (value.email != null && typeof value.email !== 'string') throw new Error('invalidResponse');
  const email = value.email == null ? '' : value.email.trim();
  if (email.length > 254 || email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || value.state === 'valid' && !email) throw new Error('invalidResponse');
  return { email, state: value.state };
}

export function readGmailOperation(value) {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256 ||
    !GMAIL_OPERATION_STATES.includes(value.state)) throw new Error('invalidResponse');
  const url = value.url == null ? '' : safeAuthorizationUrl(value.url);
  if (value.url && !url) throw new Error('unsafeUrl');
  const expiresAt = Number(value.expiresAt);
  if (value.state === 'pending' && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new Error('invalidResponse');
  return { id: value.id, state: value.state, url, expiresAt,
    connection: value.connection ? readGmailConnection(value.connection) : null };
}

export function gmailFailure(error) {
  if ([404, 405, 501].includes(error?.status)) return 'unsupported';
  if (['invalidResponse', 'unsafeUrl', 'accountMismatch', 'operationMismatch'].includes(error?.message)) return error.message;
  return error?.name === 'TimeoutError' ? 'requestTimeout' : 'requestFailed';
}
