// All setup writes go through the Backend, not directly to the Agent.
export function createInitializationApi(client) {
  const request = async (path, options = {}) => {
    const { signal, ...rest } = options;
    const response = await client.request(client.backendBase() + path, {
      ...rest, cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
    });
    return response?.result;
  };
  return {
    status: signal => request('/initialization', { signal }),
    models: async signal => {
      const result = await request('/settings/runtime', { signal });
      if (!result?.settings?.models || typeof result.settings.models.chat !== 'string') throw new Error('Invalid model settings');
      return result.settings.models;
    },
    submit: (step, data, signal) => request('/initialization/step', {
      signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step, data }),
    }),
    accounts: async signal => {
      const result = await request('/DB/accounts', { signal });
      if (!Array.isArray(result?.items)) throw new Error('Invalid accounts response');
      return result.items;
    },
    saveAccount: async (kind, id, payload, key) => {
      const response = kind === 'create' ? await client.createAccount(payload, key)
        : kind === 'update' ? await client.updateAccount(id, payload, key)
          : await client.calibrateAccount(id, payload, key);
      const account = kind === 'calibrate' ? response?.result?.account : response?.result;
      if (!account?.account_number) throw new Error('invalidAccountResponse');
      return account;
    },
  };
}
