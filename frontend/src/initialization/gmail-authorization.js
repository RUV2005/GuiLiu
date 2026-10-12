import { safeAuthorizationUrl } from './model.js';

// Reserve the tab during the click, before awaiting the authorization API.
export function beginGmailAuthorization({ openWindow = () => window.open('about:blank', '_blank'), message = '' } = {}) {
  let popup = null;
  function cancel() {
    try { popup?.close(); } catch { /* A blocked or closed tab needs no cleanup. */ }
    popup = null;
  }
  try {
    popup = openWindow();
    if (popup) {
      popup.opener = null;
      popup.document.title = message;
      popup.document.body.textContent = message;
    }
  } catch { cancel(); }
  return {
    navigate(value) {
      const url = safeAuthorizationUrl(value);
      if (!url || !popup || popup.closed) { cancel(); return false; }
      try {
        popup.location.replace(url);
        popup = null;
        return true;
      } catch { cancel(); return false; }
    },
    cancel,
  };
}
