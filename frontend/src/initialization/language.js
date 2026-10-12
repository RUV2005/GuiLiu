import { localizeView, captureLanguagePosition } from '../language-view.js';

// Translate labels in place; controls, open disclosures and preview tools belong to the live view.
export function translateSetupRegion(current, translated) {
  for (const selector of ['[data-setup-oauth]']) {
    const live = current.querySelector(selector), next = translated.querySelector(selector);
    if (live && next) next.replaceChildren(...[...live.childNodes].map(node => node.cloneNode(true)));
  }
  localizeView(current, translated);
}

export function captureSetupPosition(root, win = globalThis.window) {
  const restore = captureLanguagePosition(root, win);
  const workspace = root.querySelector('.setup-workspace');
  const top = workspace.getBoundingClientRect().top;
  const anchor = [...workspace.querySelectorAll('h1, h2, p, label, tr')].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.height && rect.bottom > top && rect.top < top + workspace.clientHeight;
  });
  const anchorTop = anchor?.getBoundingClientRect().top;
  return () => {
    restore();
    if (anchor?.isConnected && win.getComputedStyle(workspace).overflowY !== 'visible') {
      workspace.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
  };
}
