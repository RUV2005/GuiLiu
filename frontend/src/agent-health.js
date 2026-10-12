export function createAgentHealthMonitor({ api, state, onChange = () => {}, now = Date.now, interval = 30000 }) {
  let current;
  let checkedAt = -Infinity;
  let checkedAddress;

  function check({ force = false } = {}) {
    const address = api.settings().agentPath;
    if (current?.address === address) return current.promise;
    if (!force && address === checkedAddress && now() - checkedAt < interval) return Promise.resolve(state.status.agent === 'ok');
    const job = { address };
    current = job;
    if (state.status.agent !== 'ok') state.status.agent = 'checking';
    state.agentHealthError = '';
    onChange();
    job.promise = (async () => {
      let online = false, error = '';
      try { online = await api.checkAgent(); }
      catch (reason) { error = reason?.message || String(reason); }
      // Ignore replies from an address that was replaced while the request was running.
      if (current === job && api.settings().agentPath === address) {
        state.status.agent = online ? 'ok' : 'fail';
        state.agentHealthError = error;
        checkedAt = now(); checkedAddress = address;
        onChange();
      }
      if (current === job) current = null;
      return online;
    })();
    return job.promise;
  }
  return { check };
}
