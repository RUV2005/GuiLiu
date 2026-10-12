// Mailbox step: two provider tabs (Gmail, NetEase 163) with small marks, and one panel per provider that holds
// everything that provider needs. Colour lives inside the marks only; buttons and text stay neutral. Gmail connects
// with an app password over IMAP or with Google OAuth (when the Backend has an OAuth app). A submitter carries
// data-mail-connect (and data-mail-method for Gmail); credentials come from the gmail_* or netease_* fields.
import { e, field } from './fields.js';

export const MAIL_PROVIDERS = ['gmail', '163'];
const NETEASE_HELP = 'https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b';

// A plain envelope for Gmail (Google's brand rules keep its logo out of third-party apps; the tab names it in text),
// and the 163 name on red.
const MARKS = {
  gmail: `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38" rx="9" fill="#fff" stroke="#dadce0"/>
    <rect x="9.5" y="12.5" width="21" height="15" rx="2" fill="none" stroke="#5f6368" stroke-width="2"/>
    <path d="M10.5 14l9.5 7.2 9.5-7.2" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  163: `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38" rx="9" fill="#d7302a"/>
    <text x="20" y="25.2" text-anchor="middle" fill="#fff" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" letter-spacing="-.3">163</text></svg>`,
};

export const mailAccount = (status, provider) => status?.mail?.accounts?.find(account => account.provider === provider);
export function mailReady(status, provider) {
  const selected = status?.mail?.providers || ['gmail'];
  if (!selected.includes(provider)) return false;
  return provider === 'gmail' ? Boolean(mailAccount(status, 'gmail')?.authorized ?? status?.gmail?.authorized) : Boolean(mailAccount(status, '163')?.authorized);
}
export const mailAddress = (status, provider) => provider === 'gmail' ? status?.gmail_email || status?.gmail?.email || mailAccount(status, 'gmail')?.email || ''
  : mailAccount(status, '163')?.email || '';
// Connected mailboxes by display name, never the internal provider ids.
export function mailboxNames(t, status) {
  const ready = MAIL_PROVIDERS.filter(provider => mailReady(status, provider));
  return ready.length === 2 ? t('mailBoth') : ready.map(provider => provider === 'gmail' ? 'Gmail' : '163').join('');
}
// Open the panel the user most likely needs: the one that is connected when only 163 is, Gmail otherwise.
export const defaultMailPanel = status => mailReady(status, '163') && !mailReady(status, 'gmail') ? '163' : 'gmail';
// Gmail connects with an app password over IMAP, or with Google OAuth when the Backend has an OAuth app.
// Backends that predate IMAP do not report gmail_oauth_available and offer OAuth only.
export function gmailMethods(status) {
  const mail = status?.mail || {};
  if (!Object.hasOwn(mail, 'gmail_oauth_available')) return ['oauth'];
  return mail.gmail_oauth_available ? ['imap', 'oauth'] : ['imap'];
}
export function defaultGmailMethod(status) {
  const methods = gmailMethods(status), connected = mailAccount(status, 'gmail');
  if (connected?.authorized && methods.includes(connected.method)) return connected.method;
  return methods.includes('oauth') ? 'oauth' : 'imap';
}
const GMAIL_2SV = 'https://myaccount.google.com/signinoptions/two-step-verification';
const GMAIL_APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';

export function mailboxMarkup(t, status, panel, gmailMethod = defaultGmailMethod(status)) {
  const tab = (provider, name, method) => `<button type="button" role="tab" class="setup-mailbox-tab" id="setup-mail-tab-${provider}" data-mail-tab="${provider}"
      aria-controls="setup-mail-panel-${provider}" aria-selected="${panel === provider}" tabindex="${panel === provider ? 0 : -1}">
      <span class="setup-mailbox-mark">${MARKS[provider]}</span>
      <span class="setup-mailbox-text"><strong>${e(name)}</strong><small>${e(t(method))}</small></span>
      <span class="setup-mailbox-state" data-mail-status="${provider}" data-connected="false">${e(t('mailboxPending'))}</span></button>`;
  const step = (title, detail) => `<li><strong>${e(t(title))}</strong>${e(t(detail))}</li>`;
  const methods = gmailMethods(status);
  const gmailLabel = methods.length > 1 ? 'mailGoogleMethod' : methods[0] === 'imap' ? 'mailGoogleImapMethod' : 'mailGoogleOauthMethod';
  return `<p class="setup-lead">${e(t('mailAccess'))}</p>
    <div class="setup-mailbox-tabs" role="tablist" aria-label="${e(t('mailProvider'))}">
      ${tab('gmail', 'Gmail', gmailLabel)}${tab('163', t('mailNeteaseName'), 'mailNeteaseMethod')}</div>
    <section class="setup-mailbox-panel" id="setup-mail-panel-gmail" role="tabpanel" aria-labelledby="setup-mail-tab-gmail" data-mail-panel="gmail">
      <h2>${e(t('gmailConfirm'))}</h2>
      <div class="setup-mailbox-methods" role="radiogroup" aria-label="${e(t('gmailMethodLabel'))}" data-gmail-methods>
        ${['imap', 'oauth'].map(method => `<button type="button" role="radio" class="setup-mailbox-method" data-gmail-method="${method}" aria-checked="${gmailMethod === method}">
          <strong>${e(t(method === 'imap' ? 'gmailMethodImap' : 'gmailMethodOauth'))}</strong><small>${e(t(method === 'imap' ? 'gmailMethodImapHint' : 'gmailMethodOauthHint'))}</small></button>`).join('')}</div>
      <div data-gmail-method-panel="oauth">
        <ul class="setup-mailbox-points"><li>${e(t('gmailPointAuthorize'))}</li><li>${e(t('gmailPointRead'))}</li><li>${e(t('gmailPointProfile'))}</li></ul>
        <div class="setup-mailbox-actions"><button class="setup-button primary" type="submit" formnovalidate data-mail-connect="gmail" data-mail-method="oauth">${e(t('gmailAuthorize'))}</button></div>
        <div data-setup-oauth></div>
      </div>
      <div class="setup-mailbox-163" data-gmail-method-panel="imap" data-mail-gmail-imap>
        <div class="setup-mailbox-steps"><h3>${e(t('gmailImapStepsTitle'))}</h3>
          <ol>${step('gmailImapStepVerify', 'gmailImapGuideVerify')}${step('gmailImapStepCreate', 'gmailImapGuideCreate')}${step('gmailImapStepCopy', 'gmailImapGuideCopy')}</ol>
          <p class="setup-mailbox-links"><a href="${GMAIL_2SV}" target="_blank" rel="noopener noreferrer">${e(t('gmailImapOpenVerify'))} <span aria-hidden="true">↗</span></a>
            <a href="${GMAIL_APP_PASSWORDS}" target="_blank" rel="noopener noreferrer">${e(t('gmailImapOpenPasswords'))} <span aria-hidden="true">↗</span></a></p></div>
        <div class="setup-mailbox-form">
          <div class="setup-mailbox-fields">
            ${field(t('gmailEmail'), 'gmail_email', mailAddress(status, 'gmail'), 'type="email" maxlength="254" autocomplete="email" spellcheck="false" placeholder="name@gmail.com"')}
            ${field(t('gmailAppPassword'), 'gmail_app_password', '', 'type="password" maxlength="64" autocomplete="off" spellcheck="false" placeholder="xxxx xxxx xxxx xxxx" aria-describedby="setup-gmail-password-note"')}</div>
          <p class="setup-note" id="setup-gmail-password-note">${e(t('gmailImapNote'))}</p>
          <p class="setup-note" data-gmail-code-saved hidden>${e(t('gmailImapSaved'))}</p>
          <p class="setup-note">${e(t('gmailImapScope'))}</p>
          <div class="setup-mailbox-actions"><button class="setup-button primary" type="submit" data-mail-connect="gmail" data-mail-method="imap">${e(t('gmailImapConnect'))}</button></div>
        </div>
      </div>
      <p class="setup-mailbox-account" data-mail-account="gmail" hidden></p>
    </section>
    <section class="setup-mailbox-panel" id="setup-mail-panel-163" role="tabpanel" aria-labelledby="setup-mail-tab-163" data-mail-panel="163" data-mail-163>
      <h2>${e(t('neteasePanelTitle'))}</h2>
      <div class="setup-mailbox-163">
        <div class="setup-mailbox-steps"><h3>${e(t('neteaseStepsTitle'))}</h3>
          <ol>${step('neteaseStepLogin', 'neteaseGuideLogin')}${step('neteaseStepEnable', 'neteaseGuideEnable')}${step('neteaseStepAllMail', 'neteaseGuideAllMail')}${step('neteaseStepGenerate', 'neteaseGuideGenerate')}</ol>
          <p class="setup-mailbox-links"><a href="https://mail.163.com/" target="_blank" rel="noopener noreferrer">${e(t('neteaseOpenWebmail'))} <span aria-hidden="true">↗</span></a>
            <a href="${NETEASE_HELP}" target="_blank" rel="noopener noreferrer">${e(t('neteaseOfficialHelp'))} <span aria-hidden="true">↗</span></a></p></div>
        <div class="setup-mailbox-form">
          <div class="setup-mailbox-fields">
            ${field(t('neteaseEmail'), 'netease_email', mailAddress(status, '163'), 'type="email" maxlength="254" autocomplete="email" spellcheck="false" placeholder="name@163.com"')}
            ${field(t('neteaseCode'), 'netease_code', '', 'type="password" maxlength="256" autocomplete="off" spellcheck="false" aria-describedby="setup-163-credential-note"')}</div>
          <p class="setup-note" id="setup-163-credential-note">${e(t('neteaseCredentialNote'))}</p>
          <p class="setup-note" data-mail-code-saved hidden>${e(t('neteaseCodeSaved'))}</p>
          <p class="setup-note">${e(t('mailScope'))}</p>
          <p class="setup-mailbox-account" data-mail-account="163" hidden></p>
          <div class="setup-mail-warning" data-mail-recent role="status" hidden><strong>${e(t('neteaseRecentTitle'))}</strong><p data-mail-recent-body></p></div>
          <div class="setup-mailbox-actions"><button class="setup-button primary" type="submit" data-mail-connect="163">${e(t('neteaseConfirm'))}</button></div>
        </div>
      </div>
    </section>
    <p class="setup-mail-select-note" data-mail-note></p>`;
}

// Reflect the current status: which panel shows, each tab's state, button wording and which 163 inputs are required.
export function syncMailbox(root, t, { status, panel, connecting, blocked, gmailMethod = defaultGmailMethod(status) }) {
  const neteasePanel = root.querySelector('[data-mail-163]');
  if (!neteasePanel) return;
  for (const provider of MAIL_PROVIDERS) {
    const ready = mailReady(status, provider), busy = connecting === provider, open = panel === provider;
    const tab = root.querySelector(`[data-mail-tab="${provider}"]`);
    tab.setAttribute('aria-selected', String(open)); tab.tabIndex = open ? 0 : -1;
    root.querySelector(`[data-mail-panel="${provider}"]`).hidden = !open;
    const state = root.querySelector(`[data-mail-status="${provider}"]`);
    state.dataset.connected = String(ready); state.dataset.connecting = String(busy);
    state.textContent = t(busy ? 'mailboxConnecting' : ready ? 'mailboxConnected' : 'mailboxPending');
    const account = root.querySelector(`[data-mail-account="${provider}"]`), address = mailAddress(status, provider);
    account.hidden = !ready; account.textContent = ready ? t('mailboxConnectedAs').replace('{email}', address || (provider === 'gmail' ? 'Gmail' : '163')) : '';
    // Gmail has one connect button per method; "reconnect" wording applies to the method in use.
    const method = mailAccount(status, provider)?.method || 'oauth';
    for (const connect of root.querySelectorAll(`[data-mail-connect="${provider}"]`)) {
      const own = provider === '163' || connect.dataset.mailMethod === method, done = ready && own;
      connect.disabled = blocked;
      connect.classList.toggle('primary', !done);
      connect.textContent = t(busy ? 'mailboxConnecting' : provider === '163' ? (done ? 'neteaseReconfirm' : 'neteaseConfirm')
        : connect.dataset.mailMethod === 'imap' ? (done ? 'gmailImapReconfirm' : 'gmailImapConnect') : (done ? 'gmailReconnect' : 'gmailAuthorize'));
    }
  }
  const methods = gmailMethods(status);
  root.querySelector('[data-gmail-methods]').hidden = methods.length < 2;
  for (const button of root.querySelectorAll('[data-gmail-method]')) {
    button.hidden = !methods.includes(button.dataset.gmailMethod);
    button.setAttribute('aria-checked', String(button.dataset.gmailMethod === gmailMethod));
    button.tabIndex = button.dataset.gmailMethod === gmailMethod ? 0 : -1;
    button.disabled = blocked;
  }
  for (const section of root.querySelectorAll('[data-gmail-method-panel]')) section.hidden = section.dataset.gmailMethodPanel !== gmailMethod;
  const imapOpen = panel === 'gmail' && gmailMethod === 'imap', gmail = mailAccount(status, 'gmail');
  for (const input of root.querySelectorAll('[data-mail-gmail-imap] input')) input.disabled = !imapOpen;
  const gmailEmail = root.querySelector('[name="gmail_email"]');
  gmailEmail.required = imapOpen;
  const reuseGmail = gmail?.method === 'imap' && Boolean(gmail.authorized) && gmailEmail.value.trim().toLowerCase() === (gmail.email || '');
  root.querySelector('[name="gmail_app_password"]').required = imapOpen && !reuseGmail;
  root.querySelector('[data-gmail-code-saved]').hidden = !reuseGmail;
  // Hidden inputs must not block the other provider's submission.
  const open = panel === '163', account = mailAccount(status, '163');
  for (const input of neteasePanel.querySelectorAll('input')) input.disabled = !open;
  const email = root.querySelector('[name="netease_email"]');
  email.required = open;
  const reuse = Boolean(account?.authorized) && email.value.trim().toLowerCase() === (account?.email || '');
  root.querySelector('[name="netease_code"]').required = open && !reuse;
  root.querySelector('[data-mail-code-saved]').hidden = !reuse;
  // Measured at verification: webmail still limits clients to the last 30 days until 收取全部邮件 is chosen.
  const limited = mailReady(status, '163') && Boolean(account?.recent_only), warning = root.querySelector('[data-mail-recent]');
  warning.hidden = !limited;
  warning.querySelector('[data-mail-recent-body]').textContent = limited ? t('neteaseRecentBody').replace('{date}', account.oldest_mail || '') : '';
  const anyReady = MAIL_PROVIDERS.some(provider => mailReady(status, provider));
  root.querySelector('[data-mail-note]').textContent = t(anyReady ? 'mailSelectNoteReady' : 'mailSelectNote');
}
