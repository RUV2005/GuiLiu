// Run before styles load so a saved light theme never flashes the dark canvas.
(() => {
  let theme = 'dark';
  try {
    if (JSON.parse(localStorage.getItem('abk-editorial-theme')) === 'light') theme = 'light';
  } catch { /* Storage may be unavailable; keep the original theme. */ }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f8f9fb' : '#0b0c0e');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelectorAll('[data-theme-icon]').forEach(link => {
    const href = link.getAttribute('data-' + theme + '-href');
    if (href && link.getAttribute('href') !== href) link.setAttribute('href', href);
  });
})();
