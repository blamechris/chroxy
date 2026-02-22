/**
 * Generate the web dashboard HTML with embedded configuration.
 * Self-contained — no external dependencies.
 *
 * @param {number} port - WsServer port
 * @param {string|null} apiToken - API token (embedded for WS auth)
 * @param {boolean} noEncrypt - Whether E2E encryption is disabled
 * @returns {string} Complete HTML document
 */
export function getDashboardHtml(port, apiToken, noEncrypt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chroxy Dashboard</title>
  <style>${getDashboardCss()}</style>
</head>
<body>
  <div id="app">
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#ccc;font-family:system-ui">
      <p>Chroxy Dashboard — frontend coming soon</p>
    </div>
  </div>
  <script>
    window.__CHROXY_CONFIG__ = {
      port: ${port},
      token: ${apiToken ? JSON.stringify(apiToken) : 'null'},
      noEncrypt: ${!!noEncrypt},
    };
  </script>
  <script>${getDashboardJs()}</script>
</body>
</html>`
}

function getDashboardCss() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f0f1a; color: #fff; font-family: system-ui, -apple-system, sans-serif; }
  `
}

function getDashboardJs() {
  return ''  // Filled in #731
}
