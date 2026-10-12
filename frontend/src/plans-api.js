export function createPlansApi(api) {
  const path = id => '/' + encodeURIComponent(id);
  const query = args => { const text = new URLSearchParams(Object.entries(args || {}).filter(([, value]) => value !== '' && value != null)).toString(); return text ? '?' + text : ''; };
  function requestAt(url, options = {}) {
    const { signal, timeout = 20000, ...rest } = options, deadline = AbortSignal.timeout(timeout);
    return api.request(url, { cache: 'no-store', ...rest, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }
  const request = (suffix = '', options) => requestAt(api.agentBase() + '/plans' + suffix, options);
  const write = (suffix, method, body, key, options = {}) => request(suffix, { ...options, method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    list: (args, options) => request(query(args), options), accounts: options => request('/accounts', options), get: (id, options) => request(path(id), options),
    prepare: (body, options) => write('/prepare', 'POST', body, null, { timeout: 180000, ...options }),
    create: (body, key, options) => write('', 'POST', body, key, options),
    update: (id, body, key, options) => write(path(id), 'PATCH', body, key, options),
    remove: (id, version, key, options) => write(path(id) + query({ expected_version: version }), 'DELETE', undefined, key, options),
    setAccounts: (id, body, key, options) => write(path(id) + '/accounts', 'PUT', body, key, options),
    addEntry: (id, body, key, options) => write(path(id) + '/entries', 'POST', body, key, options),
    createIncome: (body, key) => api.createIncome(body, key),
    removeEntry: (id, entry, version, key, options) => write(path(id) + '/entries/' + encodeURIComponent(entry) + query({ expected_version: version }), 'DELETE', undefined, key, options),
    entries: (id, args, options) => request(path(id) + '/entries' + query(args), options),
    progress: (id, args, options) => request(path(id) + '/progress' + query(args), options),
  };
}
