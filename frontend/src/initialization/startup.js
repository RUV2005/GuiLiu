export function setupLocation(hash = '') {
  return '/initialization.html' + (typeof hash === 'string' && hash.startsWith('#') ? hash : '');
}

export function workspaceLocation(hash = '') {
  return '/' + (typeof hash === 'string' && hash.startsWith('#') ? hash : '#overview');
}

// Read-only, one decision per page load. Never infer completion from existing data.
export function createStartupCheck({ api, onChecking = () => {}, onReady, onRequired, onError }) {
  const abort = new AbortController();
  let disposed = false, settled = false, pending = null;
  return {
    run() {
      if (pending || disposed || settled) return pending || Promise.resolve();
      pending = Promise.resolve().then(async () => {
        if (disposed) return;
        onChecking();
        try {
          const status = await api.status(abort.signal);
          if (disposed) return;
          if (typeof status?.initialized !== 'boolean') throw new Error('invalidStatus');
          settled = true;
          await (status.initialized ? onReady() : onRequired());
        } catch (error) {
          if (!disposed) onError(error);
        }
      }).finally(() => { pending = null; });
      return pending;
    },
    dispose() { disposed = true; abort.abort(); },
  };
}
