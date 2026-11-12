// Apply the persisted theme before first paint to avoid a flash.
(function () {
  try {
    var stored = localStorage.getItem('vaultphotos.theme');
    var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  } catch (_) {
    /* storage may be unavailable in private mode */
  }
})();
