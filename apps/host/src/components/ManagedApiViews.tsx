import { useEffect, useRef, useState } from 'react';
import markup from '../../../../serve/web/index.html?raw';
import tokens from '../../../../serve/web/tokens.css?raw';
import components from '../../../../serve/web/components.css?raw';
import styles from '../../../../serve/web/app.css?raw';
import keys from '../../../../serve/web/keys.js?raw';
import usage from '../../../../serve/web/usage.js?raw';
import { LOCAL_SERVICE } from '../lib/client';
import latin from '../../../../serve/web/fonts/outfit-latin-wght.woff2?url';
import latinExt from '../../../../serve/web/fonts/outfit-latin-ext-wght.woff2?url';

const frameTokens = tokens
  .replace('../fonts/outfit-latin-wght.woff2', new URL(latin, import.meta.url).href)
  .replace('../fonts/outfit-latin-ext-wght.woff2', new URL(latinExt, import.meta.url).href);

export function ManagedApiViews({ endpoint, target, title }: { endpoint: string; target: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [documentSource] = useState(() => {
    // Share the existing forms, charts and CSV export. The frame scopes their styles and document IDs.
    const source = document.createElement('template');
    source.innerHTML = markup;
    const panel = (name: string) => source.content.getElementById(name)!.outerHTML;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${frameTokens}\n${components}\n${styles}</style></head>
      <body data-admin-slot="${LOCAL_SERVICE ? 'strata.keys.admin' : `strata.upstream.admin.${target}`}">
        <header class="st-header"><nav class="st-tabs" role="tablist" aria-label="API 管理">
          <button id="tab-btn-keys" class="st-tab" role="tab" aria-controls="view-keys">API Key 管理</button>
          <button id="tab-btn-usage" class="st-tab" role="tab" aria-controls="view-usage">用量</button>
        </nav></header>
        <main>${panel('view-keys')}${panel('view-usage')}</main>${panel('usage-tooltip')}
        <script>
          const health = {service: "strata", key_management: true};
          const esc = value => String(value).replace(/[&<>"']/g, char => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
          })[char]);
          const request = window.fetch.bind(window);
          const fetch = (path, options) => request(${JSON.stringify(endpoint).replaceAll('<', '\\u003c')} + '/' + path, options);
          let tab = 'keys';
          for (const name of ['keys', 'usage']) {
            document.getElementById('tab-btn-' + name).onclick = () => {
              tab = name;
              for (const item of ['keys', 'usage']) {
                document.getElementById('tab-btn-' + item).setAttribute('aria-selected', String(item === tab));
                document.getElementById('view-' + item).hidden = item !== tab;
              }
              document.dispatchEvent(new Event('strata-' + name + '-view'));
            };
          }
          document.getElementById('tab-btn-keys').click();
        </script><script>${keys}</script><script>${usage}</script>
      </body></html>`;
  });
  const applyTheme = () => {
    const root = frame.current?.contentDocument?.documentElement;
    if (root) root.dataset.theme = document.documentElement.dataset.theme;
  };
  useEffect(() => {
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return <iframe ref={frame} title={title} srcDoc={documentSource} onLoad={applyTheme}
    style={{ display: 'block', border: 0, width: '100%', height: '100%' }}/>;
}
