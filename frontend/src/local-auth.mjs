import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, fsyncSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const roles = ['owner', 'backend', 'agent', 'control'];
const random = () => randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
const DAY = 24 * 60 * 60 * 1000;
// A browser stays paired while it is used at least monthly, and re-pairs through the launcher after half a year.
export const SESSION_IDLE_MS = 30 * DAY;
export const SESSION_MAX_MS = 180 * DAY;
const SESSION_TOUCH_MS = 60 * 60 * 1000;
const SESSION_LIMIT = 32;

export function localOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      || u.username || u.password || u.hash) throw new Error('Only local HTTP services are allowed');
  return u.origin;
}

export function credentialFile(root, env = process.env) {
  if (env.GUILIU_AUTH_FILE) return resolve(env.GUILIU_AUTH_FILE);
  const parent = resolve(root, '..');
  const backend = env.ABK_BACKEND_ROOT || resolve(parent, existsSync(resolve(parent, 'backend')) ? 'backend' : 'autobookkeeping');
  const settingsFile = env.ABK_SETTINGS_FILE || resolve(backend, 'config/settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8').replace(/^﻿/, '')) : {};
  const data = env.ABK_SERVER_DATA_DIR || settings.storage?.server_data_dir || 'GUILIU server data';
  return resolve(backend, data, 'security/service-credentials.json');
}

async function credentials(path) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fd !== undefined) {
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, tokens: Object.fromEntries(roles.map(r => [r, random()])) }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  for (let i = 0; i < 20; i++) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value.version !== 1 || Object.keys(value.tokens).sort().join() !== [...roles].sort().join()
          || roles.some(r => !/^[a-f0-9]{64}$/.test(value.tokens[r]))
          || new Set(Object.values(value.tokens)).size !== roles.length) throw new Error('Invalid credentials');
      return value.tokens;
    } catch {
      if (i === 19) throw new Error('Authentication configuration invalid; refusing to start');
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

// Browser sessions survive frontend restarts. Only SHA-256 digests of the cookie values are stored.
function sessionStore(path, now) {
  const sessions = new Map();
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    for (const item of saved.version === 1 && Array.isArray(saved.sessions) ? saved.sessions : []) {
      if (/^[a-f0-9]{64}$/.test(item?.hash) && Number.isFinite(item.created) && Number.isFinite(item.seen))
        sessions.set(item.hash, { created: item.created, seen: item.seen });
    }
  } catch { /* Missing or unreadable: browsers pair again through the launcher. */ }
  const live = (session, time) => session && time - session.seen < SESSION_IDLE_MS && time - session.created < SESSION_MAX_MS;
  function persist() {
    const time = now();
    for (const [hash, session] of sessions) if (!live(session, time)) sessions.delete(hash);
    const temporary = path + '.' + process.pid + '.tmp';
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, sessions: [...sessions].map(([hash, s]) => ({ hash, ...s })) }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch { /* Sessions remain valid in memory until this frontend stops. */ }
  }
  return {
    create() {
      const id = random(), time = now();
      sessions.set(digest(id), { created: time, seen: time });
      while (sessions.size > SESSION_LIMIT) {
        const [oldest] = [...sessions].sort((a, b) => a[1].seen - b[1].seen)[0];
        sessions.delete(oldest);
      }
      persist();
      return id;
    },
    // Returns null for unknown or expired sessions, otherwise whether the cookie should be renewed.
    check(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
      const hash = digest(id), session = sessions.get(hash), time = now();
      if (!live(session, time)) {
        if (session) { sessions.delete(hash); persist(); }
        return null;
      }
      if (time - session.seen < SESSION_TOUCH_MS) return { renewed: false };
      session.seen = time;
      persist();
      return { renewed: true };
    },
    remove(id) { if (typeof id === 'string' && sessions.delete(digest(id))) persist(); },
  };
}

const pageStyle = `:root{color-scheme:dark;--bg:#0b0c0e;--panel:#111317;--ink:#f1f0ec;--muted:#9a9da5;--line:#2a2d33;--strong:#3a3e46;--accent:#9ba6ff;--danger:#d26873}
:root[data-theme=light]{color-scheme:light;--bg:#f8f9fb;--panel:#fff;--ink:#17191d;--muted:#5d626b;--line:#dfe2e7;--strong:#c5c9d0;--accent:#3e4bb8;--danger:#b23a48}
*{box-sizing:border-box;letter-spacing:0}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:15px/1.7 Inter,"Segoe UI","Noto Sans SC","Noto Sans JP",system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:14vh 24px 48px}.mark{margin:0 0 28px;color:var(--muted);font-size:13px}
h1{margin:0 0 12px;font:500 30px/1.25 Georgia,"Noto Serif SC","Noto Serif JP",serif}p{margin:0 0 16px;color:var(--muted)}
.status{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink)}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}.alert{color:var(--danger)}a{color:inherit}
details{margin-top:28px;padding-top:16px;border-top:1px solid var(--line)}summary{cursor:pointer;color:var(--muted)}label{display:block;margin:16px 0 8px}
input,button{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--strong);border-radius:6px;background:var(--panel);color:var(--ink)}
button{margin-top:12px;cursor:pointer;background:var(--ink);color:var(--bg);border-color:var(--ink)}button.secondary{background:transparent;color:var(--ink);border-color:var(--strong)}
:focus-visible{outline:none;box-shadow:0 0 0 2px var(--accent)}[hidden]{display:none!important}`;

// Language and theme follow the app's saved preferences, read before first paint.
const pagePreferences = `const saved = (() => { try { return JSON.parse(localStorage.getItem('abk-editorial-settings') || 'null') || {}; } catch { return {}; } })();
  const browser = (navigator.language || '').toLowerCase();
  const language = ['zh', 'ja', 'en'].includes(saved.language) ? saved.language
    : browser.startsWith('ja') ? 'ja' : browser.startsWith('zh') ? 'zh' : 'en';
  try { document.documentElement.dataset.theme = JSON.parse(localStorage.getItem('abk-editorial-theme')) === 'light' ? 'light' : 'dark'; } catch {}
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
  const localize = text => {
    document.title = text.docTitle;
    for (const node of document.querySelectorAll('[data-t]')) node.textContent = text[node.dataset.t];
  };`;

const loginCopy = {
  zh: { docTitle: '归流 · 重新连接', mark: '归流', title: '重新连接归流', lead: '再次运行启动器即可自动连接；服务已在运行时不会重复启动。检测到连接后，此页面会自动继续。',
    waiting: '正在等待启动器…', expired: '自动连接链接已过期，请再次运行启动器。', manual: '无法使用启动器？改用一次性配对码',
    codeLabel: '配对码', submit: '验证并进入', codeHint: '配对码在前端服务的终端或日志中，以“GUILIU pairing code”开头，30 分钟内单次有效。',
    newCode: '生成新配对码', newCodeDone: '新配对码已输出到前端终端或日志。', newCodeWait: '刚刚已生成，请稍后再试。',
    failed: '配对码无效、已使用或已过期。', locked: '尝试次数过多，请一分钟后再试。' },
  ja: { docTitle: '归流 · 再接続', mark: '归流', title: '归流に再接続', lead: 'ランチャーをもう一度実行すると自動で接続します。サービスが起動済みの場合は再起動しません。接続を検出するとこのページは自動で続行します。',
    waiting: 'ランチャーを待っています…', expired: '自動接続リンクの有効期限が切れました。ランチャーをもう一度実行してください。', manual: 'ランチャーを使えない場合はワンタイムコードで接続',
    codeLabel: 'ペアリングコード', submit: '確認して開く', codeHint: 'コードはフロントエンドのターミナルまたはログに「GUILIU pairing code」として表示されます。30 分以内に 1 回だけ使えます。',
    newCode: '新しいコードを発行', newCodeDone: '新しいコードをフロントエンドのターミナルまたはログに出力しました。', newCodeWait: '発行したばかりです。しばらくしてから再試行してください。',
    failed: 'コードが無効、使用済み、または期限切れです。', locked: '試行回数が多すぎます。1 分後に再試行してください。' },
  en: { docTitle: 'AutoBookkeeping · Reconnect', mark: 'AutoBookkeeping', title: 'Reconnect', lead: 'Run the launcher again to connect automatically. Services that are already running are not restarted. This page continues on its own once connected.',
    waiting: 'Waiting for the launcher…', expired: 'The automatic sign-in link expired. Run the launcher again.', manual: 'Can’t use the launcher? Use a one-time pairing code',
    codeLabel: 'Pairing code', submit: 'Verify and open', codeHint: 'The code appears in the frontend terminal or log as “GUILIU pairing code”. It works once within 30 minutes.',
    newCode: 'Issue a new code', newCodeDone: 'A new code was written to the frontend terminal or log.', newCodeWait: 'A code was just issued. Try again shortly.',
    failed: 'The code is invalid, used or expired.', locked: 'Too many attempts. Try again in one minute.' },
};

const pageCsp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const zh = loginCopy.zh;
const loginHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${zh.docTitle}</title><style>${pageStyle}</style><script src="/auth/login.js"></script></head>
<body><main><p class="mark" data-t="mark">${zh.mark}</p><h1 data-t="title">${zh.title}</h1><p data-t="lead">${zh.lead}</p>
<p class="alert" data-notice hidden></p><p class="status" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span data-t="waiting">${zh.waiting}</span></p>
<details data-manual><summary data-t="manual">${zh.manual}</summary>
<form method="post" action="/auth/pair"><label for="code" data-t="codeLabel">${zh.codeLabel}</label><input id="code" name="code" required autocomplete="off" spellcheck="false" maxlength="64"><button data-t="submit">${zh.submit}</button></form>
<p data-t="codeHint">${zh.codeHint}</p><button type="button" class="secondary" data-new-code data-t="newCode">${zh.newCode}</button><p data-new-code-status role="status" hidden></p>
</details></main></body></html>`;

const loginScript = `(() => {
  const copy = ${JSON.stringify(loginCopy)};
  ${pagePreferences}
  const text = copy[language];
  const target = location.pathname.startsWith('/auth/') ? '/' : null;
  async function connected() {
    try { return (await fetch('/auth/session', { cache: 'no-store', credentials: 'same-origin' })).ok; } catch { return false; }
  }
  async function poll() {
    if (await connected()) { if (target) location.replace(target); else location.reload(); return; }
    setTimeout(poll, 2000);
  }
  document.addEventListener('DOMContentLoaded', () => {
    localize(text);
    const reason = new URLSearchParams(location.search).get('reason');
    if (target && location.search) history.replaceState(null, '', location.pathname);
    const notice = document.querySelector('[data-notice]');
    if (reason && text[reason]) {
      notice.textContent = text[reason]; notice.hidden = false;
      if (reason !== 'expired') document.querySelector('[data-manual]').open = true;
    }
    const status = document.querySelector('[data-new-code-status]');
    document.querySelector('[data-new-code]').addEventListener('click', async () => {
      let ok = false;
      try { ok = (await fetch('/auth/pairing-code', { method: 'POST', credentials: 'same-origin' })).ok; } catch {}
      status.textContent = ok ? text.newCodeDone : text.newCodeWait; status.hidden = false;
    });
    poll();
  });
})();`;

const launchHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${zh.docTitle}</title><style>${pageStyle}</style><script src="/auth/launch.js"></script></head>
<body><main><p class="mark" data-t="mark">${zh.mark}</p><p class="status" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span data-t="connecting">正在连接…</span></p></main></body></html>`;

const launchCopy = Object.fromEntries(Object.entries(loginCopy).map(([key, text]) =>
  [key, { docTitle: text.docTitle, mark: text.mark, connecting: { zh: '正在连接…', ja: '接続しています…', en: 'Connecting…' }[key] }]));

const launchScript = `(() => {
  // Read and remove the one-time ticket before anything else can observe the address.
  const ticket = location.hash.slice(1);
  history.replaceState(null, '', '/auth/launch');
  const copy = ${JSON.stringify(launchCopy)};
  ${pagePreferences}
  document.addEventListener('DOMContentLoaded', () => localize(copy[language]));
  (async () => {
    try {
      if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error();
      const response = await fetch('/auth/pair', { method: 'POST', credentials: 'same-origin',
        body: new URLSearchParams({ ticket }) });
      if (!response.ok || !(await response.json()).success) throw new Error();
      location.replace('/');
    } catch {
      // A reloaded or reused launch tab may already be paired.
      const paired = await fetch('/auth/session', { cache: 'no-store', credentials: 'same-origin' }).then(r => r.ok, () => false);
      location.replace(paired ? '/' : '/auth/login?reason=expired');
    }
  })();
})();`;

const bounceHtml = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>…</title></head><body><a href="/">→</a></body></html>`;

const clientCopy = {
  zh: { title: '连接已断开', body: '再次运行启动器即可自动恢复；页面上未保存的内容会保留，进行中的请求会在连接后继续。', manual: '手动配对' },
  ja: { title: '接続が切れました', body: 'ランチャーをもう一度実行すると自動で再開します。未保存の入力は保持され、処理中のリクエストは接続後に続行します。', manual: '手動でペアリング' },
  en: { title: 'Connection lost', body: 'Run the launcher again to resume. Unsaved input stays on this page and pending requests continue once connected.', manual: 'Pair manually' },
};

export function authClientScript({ pollMs = 2000 } = {}) {
  return `(() => {
  const nativeFetch = window.fetch.bind(window);
  const copy = ${JSON.stringify(clientCopy)};
  const isRequest = value => typeof Request === 'function' && value instanceof Request;
  let current = null, waiting = null, banner = null;

  const language = () => {
    const value = String(document.documentElement.lang || '').toLowerCase();
    return value.startsWith('ja') ? 'ja' : value.startsWith('en') ? 'en' : 'zh';
  };
  function showBanner() {
    if (banner?.isConnected || !document.body) return;
    const text = copy[language()];
    banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.dataset.guiliuReconnect = '';
    banner.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;width:max-content;max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:14px 18px;border:1px solid var(--line-strong,#3a3e46);border-radius:8px;background:var(--surface-2,#171a1f);color:var(--ink,#f1f0ec);box-shadow:var(--shadow,0 14px 40px rgba(0,0,0,.24));font:13px/1.6 var(--font-ui,system-ui,sans-serif)';
    const title = document.createElement('strong');
    title.style.display = 'block';
    title.textContent = text.title;
    const body = document.createElement('span');
    body.textContent = text.body + ' ';
    const link = document.createElement('a');
    link.href = '/auth/login';
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.color = 'inherit';
    link.textContent = text.manual;
    banner.append(title, body, link);
    document.body.append(banner);
  }
  async function readSession() {
    const response = await nativeFetch('/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (response.ok) return response.json();
    if (response.headers.get('X-Guiliu-Auth') === 'required') return null;
    throw new Error('Session check failed (' + response.status + ')');
  }
  // One shared wait: every request that met an expired session resumes after the launcher pairs this browser again.
  function waitForSession() {
    waiting ||= (async () => {
      for (;;) {
        showBanner();
        try {
          const value = await readSession();
          if (value?.authenticated) { current = Promise.resolve(value); return value; }
        } catch { /* The frontend may be restarting. */ }
        await new Promise(resolve => setTimeout(resolve, ${Number(pollMs)}));
      }
    })().finally(() => { waiting = null; banner?.remove(); banner = null; });
    return waiting;
  }
  function session(refresh = false) {
    if (refresh || !current) {
      const pending = readSession().then(value => value?.authenticated ? value : waitForSession());
      current = pending;
      pending.catch(() => { if (current === pending) current = null; });
    }
    return current;
  }
  function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  // Streams and consumed Request bodies cannot be sent twice; callers see the original response instead.
  function replayable(input, init) {
    if (isRequest(input)) return input.body === null && init.body == null;
    const body = init.body;
    return body == null || typeof body === 'string' || body instanceof URLSearchParams
      || (typeof FormData === 'function' && body instanceof FormData) || (typeof Blob === 'function' && body instanceof Blob)
      || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  }

  window.guiliuAuth = Object.freeze({ session: () => session() });
  window.fetch = async (input, init = {}) => {
    const url = new URL(isRequest(input) ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return nativeFetch(input, init);
    const method = String(init.method || (isRequest(input) ? input.method : 'GET')).toUpperCase();
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method) && url.pathname !== '/auth/pair';
    const signal = init.signal || (isRequest(input) ? input.signal : undefined);
    const send = async () => {
      if (!unsafe) return nativeFetch(input, init);
      const headers = new Headers(init.headers || (isRequest(input) ? input.headers : undefined));
      headers.set('X-Guiliu-CSRF', (await abortable(session(), signal)).csrf);
      return nativeFetch(input, { ...init, headers, credentials: 'same-origin' });
    };
    const response = await send();
    if (url.pathname.startsWith('/auth/')) return response;
    const reason = response.headers.get('X-Guiliu-Auth');
    if (reason === 'csrf') {
      const refreshed = session(true);
      if (!replayable(input, init)) return response;
      await abortable(refreshed, signal);
      return send();
    }
    if (reason === 'required') {
      const resumed = waitForSession();
      if (!replayable(input, init)) return response;
      await abortable(resumed, signal);
      return send();
    }
    return response;
  };
})();`;
}

export async function createLocalAuth({ root, host, port, backend, agent, env = process.env, now = Date.now, log = console.log }) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Local mode requires HOST=127.0.0.1 or ::1');
  const destinations = [backend, agent].map(value => {
    const u = new URL(value);
    if (!['', '/'].includes(u.pathname) || u.search) throw new Error('Service base must not contain a path or query');
    return localOrigin(value);
  });
  const credentialPath = credentialFile(root, env);
  const keys = await credentials(credentialPath);
  const sessions = sessionStore(join(dirname(credentialPath), 'browser-sessions-' + port + '.json'), now);
  let pairingCode = randomBytes(16).toString('hex');
  let pairExpires = now() + 30 * 60 * 1000, codeIssued = 0;
  const cookieName = 'guiliu_session_' + port;
  const cookie = id => cookieName + '=' + id + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_IDLE_MS / 1000;
  const csrfFor = id => createHmac('sha256', keys.owner).update('guiliu-csrf\0' + id).digest('hex');
  const clientScript = authClientScript();
  const launchTickets = new Map();
  let failedAttempts = 0, blockedUntil = 0;
  const announce = () => log('GUILIU pairing code (one use, 30 minutes): ' + pairingCode);

  function send(res, code, value, type = 'application/json', extra = {}) {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin', ...extra });
    res.end(type === 'application/json' ? JSON.stringify(value) : value);
  }
  const page = (res, html, extra = {}) => send(res, 200, html, 'text/html', { 'Content-Security-Policy': pageCsp, ...extra });

  async function handle(req, res) {
    let url, expected;
    try {
      expected = localOrigin('http://' + req.headers.host);
      if (Number(new URL(expected).port || 80) !== port || !loopback(req.socket.remoteAddress)) throw new Error();
      url = new URL(req.url, expected);
      if (url.origin !== expected || !req.url.startsWith('/') || req.url.startsWith('//')) throw new Error();
    } catch { send(res, 403, { error: 'Untrusted local host' }); return true; }
    const site = req.headers['sec-fetch-site'];
    if (req.headers.origin && req.headers.origin !== expected) { send(res, 403, { error: 'Cross-origin access denied' }); return true; }
    if (site && !['same-origin', 'none'].includes(site)) {
      // A link from another site cannot carry the SameSite cookie; restart that navigation from this origin.
      if (req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document') {
        page(res, bounceHtml); return true;
      }
      send(res, 403, { error: 'Cross-origin access denied' }); return true;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') return false;
    if (url.pathname === '/auth/launch-ticket' && req.method === 'POST') {
      // Only the local launcher with the installation's owner credential may mint tickets.
      if (req.headers.origin || site || !equal(req.headers.authorization, 'Bearer ' + keys.owner)) {
        send(res, 403, { error: 'Local launcher credentials required' }); return true;
      }
      for (const [ticket, expires] of launchTickets) if (expires <= now()) launchTickets.delete(ticket);
      if (launchTickets.size >= 8) launchTickets.delete(launchTickets.keys().next().value);
      const ticket = random();
      launchTickets.set(ticket, now() + 120000);
      send(res, 200, { ticket, expires_in: 120 }); return true;
    }
    if (req.method === 'GET' && ['/auth/launch.js', '/auth/login.js', '/auth/client.js'].includes(url.pathname)) {
      send(res, 200, { '/auth/launch.js': launchScript, '/auth/login.js': loginScript, '/auth/client.js': clientScript }[url.pathname], 'text/javascript');
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/auth/launch') { page(res, launchHtml, { 'Referrer-Policy': 'no-referrer' }); return true; }
    if (url.pathname === '/auth/pairing-code' && req.method === 'POST') {
      // Prints a fresh manual code to the frontend's own terminal or log; nothing secret is returned.
      if (req.headers.origin !== expected) { send(res, 403, { error: 'Same-origin request required' }); return true; }
      if (now() - codeIssued < 15000) { send(res, 429, { error: 'Try again shortly' }, undefined, { 'Retry-After': '15' }); return true; }
      codeIssued = now();
      pairingCode = randomBytes(16).toString('hex');
      pairExpires = now() + 30 * 60 * 1000;
      announce();
      send(res, 200, { success: true }); return true;
    }
    if (url.pathname === '/auth/pair' && req.method === 'POST') {
      if (req.headers.origin !== expected) { send(res, 403, { error: 'Same-origin form required' }); return true; }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) { send(res, 413, { error: 'Request too large' }); return true; }
      }
      const form = new URLSearchParams(body);
      const code = form.get('code')?.trim();
      const ticket = form.get('ticket');
      const retry = reason => ticket !== null
        ? send(res, reason === 'locked' ? 429 : 401, { success: false, error: reason })
        : send(res, 303, '', 'text/plain', { Location: '/auth/login?reason=' + reason });
      if (now() < blockedUntil) { retry('locked'); return true; }
      const valid = ticket !== null ? (launchTickets.get(ticket) || 0) > now()
        : pairingCode && now() <= pairExpires && equal(code, pairingCode);
      if (!valid) {
        if (++failedAttempts >= 5) { blockedUntil = now() + 60000; failedAttempts = 0; }
        retry('failed'); return true;
      }
      if (ticket !== null) launchTickets.delete(ticket);
      else pairingCode = null;
      const id = sessions.create();
      if (ticket !== null) send(res, 200, { success: true }, undefined, { 'Set-Cookie': cookie(id) });
      else send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': cookie(id) });
      return true;
    }
    const id = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const active = sessions.check(id);
    if (!active) {
      const clear = id ? { 'Set-Cookie': cookieName + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' } : {};
      if (req.method === 'GET' && (req.headers.accept?.includes('text/html') || url.pathname === '/auth/login'))
        page(res, loginHtml, { 'X-Guiliu-Auth': 'required', ...clear });
      else send(res, 401, { success: false, error: 'Authentication required', result: null }, undefined, { 'X-Guiliu-Auth': 'required', ...clear });
      return true;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && (req.headers.origin !== expected || !equal(req.headers['x-guiliu-csrf'], csrfFor(id)))) {
      send(res, 403, { error: 'CSRF validation failed' }, undefined, { 'X-Guiliu-Auth': 'csrf' }); return true;
    }
    if (active.renewed) res.setHeader('Set-Cookie', cookie(id));
    if (url.pathname === '/auth/session' && req.method === 'GET') {
      send(res, 200, { authenticated: true, csrf: csrfFor(id), services: { backend: destinations[0], agent: destinations[1] } }); return true;
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      sessions.remove(id);
      send(res, 200, { success: true }, undefined, { 'Set-Cookie': cookieName + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' }); return true;
    }
    if (url.pathname === '/auth/login' && req.method === 'GET') {
      send(res, 303, '', 'text/plain', { Location: '/' }); return true;
    }
    if (req.method === 'OPTIONS') { send(res, 204, '', 'text/plain'); return true; }
    return false;
  }

  function proxyHeaders(req, base, target) {
    const configured = localOrigin(base);
    if (!destinations.includes(configured) || target.origin !== configured) throw new Error('Unconfigured proxy destination');
    // Browser-side address settings are informational: traffic always goes to the deployment's configured services.
    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) {
      if (['host', 'cookie', 'authorization', 'origin', 'referer', 'forwarded', 'x-target-base', 'x-guiliu-csrf',
        'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
        'trailer', 'te'].includes(key) || key.startsWith('x-forwarded-') || key.startsWith('sec-fetch-')) delete headers[key];
    }
    headers.authorization = 'Bearer ' + keys.owner;
    return headers;
  }
  return { handle, proxyHeaders, announce };
}
