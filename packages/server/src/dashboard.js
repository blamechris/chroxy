/**
 * Generate the web dashboard HTML with embedded configuration.
 * Assets (CSS, JS, xterm) are served as separate static files via ws-server.
 *
 * @param {number} port - WsServer port
 * @param {string|null} apiToken - API token (embedded for WS auth)
 * @param {boolean} noEncrypt - Whether E2E encryption is disabled
 * @param {string} [nonce] - Optional CSP nonce to apply to inline style and script tags
 * @returns {string} Complete HTML document
 */
export function getDashboardHtml(port, apiToken, noEncrypt, nonce) {
  const n = nonce ? ` nonce="${nonce}"` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chroxy Dashboard</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
  <link rel="stylesheet" href="/assets/xterm/xterm.css">
</head>
<body>
  <div id="app">
    <header id="header">
      <div class="header-left">
        <span class="logo">Chroxy</span>
        <span id="connection-status" class="status-dot disconnected"></span>
      </div>
      <div class="header-right">
        <select id="model-select" title="Model">
          <option value="">Model</option>
        </select>
        <select id="permission-select" title="Permission mode">
          <option value="approve">Approve</option>
          <option value="acceptEdits">Accept Edits</option>
          <option value="auto">Auto</option>
          <option value="plan">Plan</option>
        </select>
        <button id="history-btn" class="header-btn" title="Conversation history">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button id="qr-btn" class="header-btn" title="Pair phone via QR">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="4" height="4"/><line x1="22" y1="14" x2="22" y2="18"/><line x1="18" y1="22" x2="22" y2="22"/></svg>
        </button>
      </div>
    </header>

    <div id="session-bar">
      <div id="session-tabs"></div>
      <button id="new-session-btn" title="New session (Ctrl+N)">+</button>
    </div>

    <div id="view-switcher" role="tablist">
      <button class="view-tab active" data-view="chat" role="tab" aria-selected="true" aria-controls="chat-messages" id="tab-chat">Chat</button>
      <button class="view-tab" data-view="terminal" role="tab" aria-selected="false" aria-controls="terminal-container" id="tab-terminal">Terminal</button>
    </div>

    <div id="reconnect-banner" class="hidden">
      <span id="reconnect-text">Disconnected. Reconnecting...</span>
      <button id="reconnect-retry-btn" class="hidden">Retry</button>
      <div id="reauth-container" class="hidden">
        <input id="reauth-input" type="password" placeholder="Paste new API token" aria-label="New API token" autocomplete="off">
        <button id="reauth-submit-btn">Connect</button>
      </div>
    </div>

    <!-- Create session modal -->
    <div id="create-session-modal" class="modal-overlay hidden">
      <div class="modal-content">
        <h3 class="modal-title">New Session</h3>
        <input type="text" id="modal-session-name" placeholder="Session name" autocomplete="off">
        <input type="text" id="modal-session-cwd" placeholder="Working directory (optional)" autocomplete="off">
        <div class="modal-buttons">
          <button id="modal-cancel-btn" class="btn-modal-cancel">Cancel</button>
          <button id="modal-create-btn" class="btn-modal-create">Create</button>
        </div>
      </div>
    </div>

    <!-- QR pairing modal -->
    <div id="qr-modal" class="modal-overlay hidden">
      <div class="modal-content" style="text-align:center;">
        <h3 class="modal-title">Pair Phone</h3>
        <div id="qr-modal-container" style="width:200px;height:200px;margin:0 auto 12px;background:#12121f;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;"></div>
        <p id="qr-modal-hint" style="color:#888;font-size:13px;margin-bottom:16px;">Scan with Chroxy app to connect</p>
        <button id="qr-modal-close" class="btn-modal-cancel">Close</button>
      </div>
    </div>

    <!-- History modal -->
    <div id="history-modal" class="modal-overlay hidden">
      <div class="modal-content" style="max-width:520px;max-height:70vh;display:flex;flex-direction:column;">
        <h3 class="modal-title">Conversation History</h3>
        <div id="history-list" style="overflow-y:auto;flex:1;"></div>
        <div style="margin-top:12px;text-align:right;">
          <button id="history-modal-close" class="btn-modal-cancel">Close</button>
        </div>
      </div>
    </div>

    <!-- Toast container -->
    <div id="toast-container" role="status" aria-live="polite" aria-atomic="true"></div>

    <div id="plan-mode-banner" class="hidden">
      Plan Mode
    </div>

    <div id="plan-approval-card" class="hidden">
      <div id="plan-content"></div>
      <div class="plan-buttons">
        <button id="plan-approve-btn" class="btn-plan-approve">Approve</button>
        <button id="plan-feedback-btn" class="btn-plan-feedback">Give Feedback</button>
      </div>
    </div>

    <div id="chat-messages" role="tabpanel" aria-labelledby="tab-chat"></div>
    <div id="terminal-container" class="hidden" role="tabpanel" aria-labelledby="tab-terminal"></div>

    <div id="status-bar">
      <span id="status-busy" class="busy-indicator hidden"></span>
      <span id="status-model"></span>
      <span id="status-cost"></span>
      <span id="status-context"></span>
      <span id="status-agents" class="agent-badge hidden"></span>
    </div>

    <div id="input-bar">
      <textarea id="message-input" placeholder="Send a message..." rows="1"></textarea>
      <button id="send-btn" title="Send (Ctrl+Enter)">Send</button>
      <button id="interrupt-btn" title="Interrupt (Escape)">Stop</button>
    </div>
  </div>
  <script src="/assets/xterm/xterm.js"></script>
  <script src="/assets/xterm/addon-fit.js"></script>
  <script${n}>
    window.__CHROXY_CONFIG__ = {
      port: ${port},
      token: ${apiToken ? JSON.stringify(apiToken).replace(/</g, '\\u003c') : '""'},
      noEncrypt: ${!!noEncrypt},
    };
  </script>
  <script src="/assets/dashboard-app.js"></script>
</body>
</html>`
}

// CSS is now served as a static file from src/dashboard/dashboard.css

