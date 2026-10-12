const mobile = globalThis.matchMedia?.('(max-width: 720px)');
let opened = false, previousFocus;

export function syncSidebar() {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  const drawer = Boolean(mobile?.matches && opened);
  const sidebar = shell.querySelector('.sidebar');
  shell.classList.toggle('mobile-sidebar-open', drawer);
  sidebar.inert = Boolean(mobile?.matches && !drawer);
  document.querySelectorAll('[data-toggle-sidebar]').forEach((button) => {
    button.setAttribute('aria-expanded', String(mobile?.matches ? drawer : !shell.classList.contains('sidebar-collapsed')));
  });
  const backdrop = shell.querySelector('[data-sidebar-backdrop]');
  backdrop?.setAttribute('aria-hidden', String(!drawer));
  if (backdrop) backdrop.inert = !drawer;
  document.dispatchEvent(new Event('abk-sidebar-change'));
}

export function toggleSidebar(desktopToggle) {
  if (mobile?.matches) {
    opened = !opened;
    if (opened) previousFocus = document.activeElement;
  } else desktopToggle();
  syncSidebar();
  if (mobile?.matches && opened) document.querySelector('.sidebar [data-route].is-active, .sidebar a')?.focus({ preventScroll: true });
}

export function closeMobileSidebar() {
  if (!opened) return;
  opened = false; syncSidebar();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}

globalThis.document?.addEventListener('click', (event) => {
  if (event.target.closest?.('[data-sidebar-backdrop]')) closeMobileSidebar();
});
globalThis.document?.addEventListener('keydown', (event) => {
  if (!opened || !mobile?.matches) return;
  if (event.key === 'Escape') { event.preventDefault(); closeMobileSidebar(); }
  if (event.key !== 'Tab') return;
  const nodes = [...document.querySelectorAll('.sidebar a, .sidebar button')].filter((node) => node.getClientRects().length);
  const first = nodes[0], last = nodes.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
mobile?.addEventListener('change', () => { opened = false; syncSidebar(); });
