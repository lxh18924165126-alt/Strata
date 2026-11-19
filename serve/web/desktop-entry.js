(() => {
  const { pageOrigin, desktopHost } = document.currentScript.dataset;
  const legacyScripts = document.getElementById('legacy-web-scripts');

  function startLegacy() {
    for (const original of legacyScripts.content.querySelectorAll('script')) {
      const script = document.createElement('script');
      script.async = false;
      script.src = original.src;
      document.body.append(script);
    }
    legacyScripts.remove();
  }

  const localhostOrigin = pageOrigin?.replace('://127.0.0.1:', '://localhost:');
  if (!desktopHost || (location.origin !== pageOrigin && location.origin !== localhostOrigin)) {
    startLegacy();
    return;
  }

  const signal = AbortSignal.timeout(2500);
  Promise.all([
    fetch(desktopHost, { signal }),
    fetch(`${desktopHost}/api/bridge`, { signal }),
    fetch(`${desktopHost}/icons/sprite.svg`, { signal }),
  ])
    .then(async ([page, bridge, icons]) => {
      if (!page.ok || !bridge.ok || !icons.ok || typeof (await bridge.json()).enabled !== 'boolean') {
        throw new Error('Desktop bridge is unavailable');
      }
      const shell = new DOMParser().parseFromString(await page.text(), 'text/html');
      const root = shell.getElementById('root');
      const entry = shell.querySelector('script[type="module"][src]');
      const sprite = new DOMParser().parseFromString(await icons.text(), 'image/svg+xml').documentElement;
      if (!root || !entry || sprite.localName !== 'svg') throw new Error('Desktop UI is unavailable');

      for (const link of shell.querySelectorAll('link[href]')) {
        link.href = new URL(link.getAttribute('href'), desktopHost).href;
      }
      const script = document.createElement('script');
      script.type = 'module';
      script.src = new URL(entry.getAttribute('src'), desktopHost).href;
      sprite.id = 'strata-desktop-sprite';
      globalThis.__STRATA_HOST__ = desktopHost;
      document.head.replaceChildren(...[...shell.head.children].filter(node => node.tagName !== 'SCRIPT'));
      // SVG use references must stay in the same origin as the page.
      document.body.replaceChildren(sprite, root, script);
    })
    .catch(startLegacy);
})();
