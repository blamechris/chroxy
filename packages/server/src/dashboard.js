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
  <script>
    window.__CHROXY_CONFIG__ = {
      port: ${port},
      token: ${apiToken ? JSON.stringify(apiToken).replace(/</g, '\\u003c') : '""'},
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
    body {
      background: #0f0f1a;
      color: #e0e0e0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      height: 100vh;
      overflow: hidden;
    }
    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      max-width: 960px;
      margin: 0 auto;
    }

    /* Header */
    #header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: #151528;
      border-bottom: 1px solid #252540;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo {
      font-size: 18px;
      font-weight: 700;
      color: #4a9eff;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-dot.connected { background: #22c55e; }
    .status-dot.disconnected { background: #ef4444; }
    .status-dot.connecting { background: #eab308; }
    .header-right {
      display: flex;
      gap: 8px;
    }
    .header-right select {
      background: #1a1a2e;
      color: #e0e0e0;
      border: 1px solid #333355;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 13px;
      cursor: pointer;
    }
    .header-btn {
      background: #1a1a2e;
      color: #e0e0e0;
      border: 1px solid #333355;
      border-radius: 6px;
      padding: 4px 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.2s, background 0.2s;
    }
    .header-btn:hover {
      border-color: #4a9eff;
      background: #222244;
    }

    /* Session bar */
    #session-bar {
      display: flex;
      align-items: center;
      padding: 6px 16px;
      background: #12121f;
      border-bottom: 1px solid #252540;
      gap: 6px;
      flex-shrink: 0;
      overflow-x: auto;
    }
    #session-tabs {
      display: flex;
      gap: 4px;
      flex: 1;
      overflow-x: auto;
    }
    .session-tab {
      padding: 4px 12px;
      border-radius: 6px;
      background: #1a1a2e;
      color: #999;
      font-size: 13px;
      cursor: pointer;
      border: 1px solid transparent;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
    }
    .session-tab:hover { background: #222244; color: #ccc; }
    .session-tab.active {
      background: #2a2a4e;
      color: #e0e0e0;
      border-color: #4a9eff;
    }
    #new-session-btn {
      background: #1a1a2e;
      color: #4a9eff;
      border: 1px solid #333355;
      border-radius: 6px;
      width: 28px;
      height: 28px;
      font-size: 16px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #new-session-btn:hover { background: #222244; }

    /* Reconnect banner */
    #reconnect-banner {
      background: #3b2010;
      color: #f59e0b;
      text-align: center;
      padding: 8px;
      font-size: 13px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    #reconnect-retry-btn {
      background: #f59e0b;
      color: #1a1a2e;
      border: none;
      border-radius: 4px;
      padding: 3px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    #reconnect-retry-btn:hover { opacity: 0.85; }
    .hidden { display: none !important; }

    /* Chat messages */
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .msg.assistant {
      background: #1a1a2e;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .msg.user {
      background: #2a2a4e;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
      color: #d0d8ff;
    }
    .msg.system {
      background: transparent;
      align-self: center;
      color: #666;
      font-size: 12px;
      font-style: italic;
    }
    .msg.error {
      background: #2e1a1a;
      color: #f87171;
      align-self: center;
      font-size: 13px;
    }

    /* Tool use */
    .tool-bubble {
      background: #161625;
      border: 1px solid #252540;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      color: #888;
      align-self: flex-start;
      max-width: 85%;
      cursor: pointer;
    }
    .tool-bubble .tool-name {
      color: #4a9eff;
      font-weight: 600;
    }
    .tool-bubble .tool-result {
      display: none;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid #252540;
      white-space: pre-wrap;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 11px;
      max-height: 200px;
      overflow-y: auto;
      color: #aaa;
    }
    .tool-bubble.expanded .tool-result { display: block; }

    /* Permission prompt */
    .permission-prompt {
      background: #1e1a30;
      border: 1px solid #4a3a7a;
      border-radius: 10px;
      padding: 12px 14px;
      align-self: flex-start;
      max-width: 85%;
    }
    .permission-prompt .perm-desc {
      font-size: 13px;
      color: #c0b8e0;
      margin-bottom: 8px;
    }
    .permission-prompt .perm-tool {
      font-weight: 600;
      color: #a78bfa;
    }
    .permission-prompt .perm-buttons {
      display: flex;
      gap: 8px;
    }
    .permission-prompt button {
      padding: 5px 16px;
      border-radius: 6px;
      border: none;
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
    }
    .permission-prompt .btn-allow {
      background: #22c55e;
      color: #fff;
    }
    .permission-prompt .btn-allow:hover { background: #16a34a; }
    .permission-prompt .btn-deny {
      background: #ef4444;
      color: #fff;
    }
    .permission-prompt .btn-deny:hover { background: #dc2626; }
    .permission-prompt.answered {
      opacity: 0.5;
    }
    .permission-prompt.answered .perm-buttons { display: none; }
    .permission-prompt.answered .perm-answer {
      display: block;
      font-size: 12px;
      color: #888;
      margin-top: 6px;
    }

    /* Question prompt */
    .question-prompt {
      background: #1a2530;
      border: 1px solid #2a5a7a;
      border-radius: 10px;
      padding: 12px 14px;
      align-self: flex-start;
      max-width: 85%;
    }
    .question-prompt .q-text {
      font-size: 13px;
      color: #a0d0e0;
      margin-bottom: 8px;
    }
    .question-prompt .q-input-row {
      display: flex;
      gap: 6px;
    }
    .question-prompt input {
      flex: 1;
      background: #12121f;
      color: #e0e0e0;
      border: 1px solid #333355;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 13px;
    }
    .question-prompt button {
      padding: 5px 12px;
      border-radius: 6px;
      border: none;
      background: #4a9eff;
      color: #fff;
      font-size: 13px;
      cursor: pointer;
    }
    .question-prompt.answered { opacity: 0.5; }
    .question-prompt.answered .q-input-row { display: none; }

    /* Thinking indicator */
    .thinking-dots {
      display: flex;
      gap: 4px;
      padding: 12px 14px;
      align-self: flex-start;
    }
    .thinking-dots span {
      width: 8px;
      height: 8px;
      background: #4a9eff;
      border-radius: 50%;
      animation: pulse 1.4s infinite ease-in-out;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }

    /* Status bar */
    #status-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 6px 16px;
      background: #12121f;
      border-top: 1px solid #252540;
      font-size: 12px;
      color: #666;
      flex-shrink: 0;
    }

    /* Input bar */
    #input-bar {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 12px 16px;
      background: #151528;
      border-top: 1px solid #252540;
      flex-shrink: 0;
    }
    #message-input {
      flex: 1;
      background: #1a1a2e;
      color: #e0e0e0;
      border: 1px solid #333355;
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 14px;
      font-family: inherit;
      resize: none;
      max-height: 150px;
      line-height: 1.4;
    }
    #message-input:focus {
      outline: none;
      border-color: #4a9eff;
    }
    #message-input::placeholder { color: #555; }
    #send-btn, #interrupt-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    #send-btn {
      background: #4a9eff;
      color: #fff;
    }
    #send-btn:hover { background: #3a8eef; }
    #send-btn:disabled {
      background: #333355;
      color: #666;
      cursor: not-allowed;
    }
    #interrupt-btn {
      background: #ef4444;
      color: #fff;
    }
    #interrupt-btn:hover { background: #dc2626; }
    #interrupt-btn:disabled {
      background: #333355;
      color: #666;
      cursor: not-allowed;
    }

    /* Markdown rendering */
    .msg pre {
      background: #12121f;
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      margin: 6px 0;
      font-size: 13px;
    }
    .msg pre code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      color: #c8d0e0;
      background: none;
      padding: 0;
    }
    .msg code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      background: #12121f;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      color: #c8d0e0;
    }
    .msg strong { color: #f0f0f0; }
    .msg em { color: #b0b8d0; }
    .msg h1, .msg h2, .msg h3 {
      margin: 8px 0 4px;
      color: #f0f0f0;
    }
    .msg h1 { font-size: 1.3em; }
    .msg h2 { font-size: 1.15em; }
    .msg h3 { font-size: 1.05em; }
    .msg a {
      color: #4a9eff;
      text-decoration: none;
    }
    .msg a:hover { text-decoration: underline; }
    .msg ul, .msg ol {
      margin: 4px 0;
      padding-left: 20px;
    }
    .msg li { margin: 2px 0; }
    .msg blockquote {
      border-left: 3px solid #4a9eff;
      padding-left: 10px;
      margin: 6px 0;
      color: #999;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #333355; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #444466; }

    /* Plan mode banner */
    #plan-mode-banner {
      background: #2a1a40;
      color: #a78bfa;
      text-align: center;
      padding: 8px;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 1px solid #4a3a7a;
      flex-shrink: 0;
    }

    /* Plan approval card */
    #plan-approval-card {
      background: #1e1a30;
      border: 1px solid #4a3a7a;
      border-radius: 10px;
      padding: 14px;
      margin: 8px 16px;
      flex-shrink: 0;
    }
    #plan-content {
      font-size: 13px;
      color: #c0b8e0;
      margin-bottom: 10px;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.5;
    }
    .plan-buttons {
      display: flex;
      gap: 8px;
    }
    .btn-plan-approve {
      padding: 6px 18px;
      border-radius: 6px;
      border: none;
      background: #22c55e;
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-plan-approve:hover { background: #16a34a; }
    .btn-plan-feedback {
      padding: 6px 18px;
      border-radius: 6px;
      border: none;
      background: #4a9eff;
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-plan-feedback:hover { background: #3a8eef; }

    /* Agent badge */
    .agent-badge {
      background: #2a1a40;
      color: #a78bfa;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    /* Session tab with close button */
    .session-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      position: relative;
    }
    .session-tab .tab-name {
      pointer-events: none;
    }
    .session-tab .tab-close {
      display: none;
      background: none;
      border: none;
      color: #666;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
      border-radius: 3px;
    }
    .session-tab .tab-close:hover {
      color: #f87171;
      background: rgba(248, 113, 113, 0.15);
    }
    .session-tab:hover .tab-close.visible { display: inline-block; }
    .session-tab .tab-rename-input {
      background: #12121f;
      color: #e0e0e0;
      border: 1px solid #4a9eff;
      border-radius: 4px;
      padding: 1px 4px;
      font-size: 13px;
      width: 100px;
      outline: none;
    }
    .tab-busy-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 1.5s infinite;
      flex-shrink: 0;
    }
    .tab-cwd {
      color: #666;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 60px;
    }
    .tab-model {
      color: #888;
      font-size: 9px;
      background: #1a1a2e;
      border-radius: 3px;
      padding: 1px 4px;
      flex-shrink: 0;
    }

    /* Permission countdown */
    .perm-countdown {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }
    .perm-countdown.urgent { color: #ff4a4a; font-weight: bold; }
    .perm-countdown.expired { color: #666; font-style: italic; }

    /* Create session modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-content {
      background: #1a1a2e;
      border: 1px solid #333355;
      border-radius: 12px;
      padding: 24px;
      min-width: 340px;
      max-width: 420px;
    }
    .modal-title {
      color: #e0e0e0;
      font-size: 16px;
      margin-bottom: 16px;
    }
    .modal-content input {
      width: 100%;
      background: #12121f;
      color: #e0e0e0;
      border: 1px solid #333355;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 14px;
      margin-bottom: 10px;
    }
    .modal-content input:focus {
      outline: none;
      border-color: #4a9eff;
    }
    .modal-content input::placeholder { color: #555; }
    .modal-buttons {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 6px;
    }
    .btn-modal-cancel {
      padding: 6px 16px;
      border-radius: 6px;
      border: 1px solid #333355;
      background: transparent;
      color: #999;
      font-size: 13px;
      cursor: pointer;
    }
    .btn-modal-cancel:hover { background: #222244; color: #ccc; }
    .btn-modal-create {
      padding: 6px 16px;
      border-radius: 6px;
      border: none;
      background: #4a9eff;
      color: #fff;
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
    }
    .btn-modal-create:hover { background: #3a8eef; }

    /* History modal */
    .history-group { margin-bottom: 16px; }
    .history-group-name {
      font-size: 11px;
      font-weight: 600;
      color: #4a9eff;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 0 0 6px;
      border-bottom: 1px solid #252540;
      margin-bottom: 6px;
    }
    .history-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .history-item:hover { background: #252540; }
    .history-item-body { flex: 1; min-width: 0; }
    .history-item-preview {
      font-size: 13px;
      color: #ccc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-item-meta {
      font-size: 11px;
      color: #666;
      margin-top: 2px;
    }
    .history-item-resume {
      padding: 4px 12px;
      border-radius: 4px;
      border: 1px solid #333355;
      background: transparent;
      color: #4a9eff;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .history-item-resume:hover { background: #1a1a2e; border-color: #4a9eff; }
    .history-empty {
      color: #555;
      font-size: 13px;
      text-align: center;
      padding: 32px 0;
    }
    .history-loading {
      color: #888;
      font-size: 13px;
      text-align: center;
      padding: 32px 0;
    }

    /* Toast notifications */
    #toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 2000;
      max-width: 380px;
    }
    .toast {
      background: #dc2626;
      color: #fff;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      display: flex;
      align-items: flex-start;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      animation: toastIn 0.2s ease-out;
    }
    .toast .toast-msg { flex: 1; }
    .toast .toast-close {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
      padding: 0;
      flex-shrink: 0;
    }
    .toast .toast-close:hover { color: #fff; }
    @keyframes toastIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Busy indicator */
    .busy-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4a9eff;
      animation: busyPulse 1s infinite ease-in-out;
      flex-shrink: 0;
    }
    @keyframes busyPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }

    /* Question prompt with option buttons */
    .question-prompt .q-options {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .question-prompt .q-option-btn {
      padding: 5px 12px;
      border-radius: 6px;
      border: 1px solid #2a5a7a;
      background: #12121f;
      color: #a0d0e0;
      font-size: 13px;
      cursor: pointer;
    }
    .question-prompt .q-option-btn:hover {
      background: #1a2530;
      border-color: #4a9eff;
    }
    .question-prompt.answered .q-options { display: none; }
    .question-prompt .q-answer-text {
      display: none;
      font-size: 12px;
      color: #888;
      margin-top: 6px;
    }
    .question-prompt.answered .q-answer-text { display: block; }

    /* View switcher */
    #view-switcher {
      display: flex;
      padding: 0 16px;
      background: #12121f;
      border-bottom: 1px solid #252540;
      flex-shrink: 0;
      gap: 0;
    }
    .view-tab {
      padding: 6px 16px;
      font-size: 13px;
      color: #888;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .view-tab:hover { color: #ccc; }
    .view-tab.active {
      color: #4a9eff;
      border-bottom-color: #4a9eff;
    }

    /* Terminal container */
    #terminal-container {
      flex: 1;
      background: #0f0f1a;
      position: relative;
      overflow: hidden;
    }
    #terminal-container .xterm {
      height: 100%;
    }
    .terminal-notice {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: #666;
      font-size: 14px;
    }
    .terminal-notice .notice-title {
      font-size: 16px;
      color: #888;
      margin-bottom: 8px;
      font-weight: 600;
    }

    /* Responsive: mobile browsers */
    @media (max-width: 600px) {
      #header { padding: 8px 12px; }
      .logo { font-size: 16px; }
      .header-right select { font-size: 12px; padding: 3px 6px; }
      .header-btn { padding: 3px 5px; }
      #session-bar { padding: 4px 10px; }
      #chat-messages { padding: 10px; gap: 8px; }
      .msg, .tool-bubble, .permission-prompt, .question-prompt { max-width: 92%; font-size: 13px; }
      #input-bar { padding: 8px 10px; gap: 6px; }
      #message-input { padding: 8px 10px; font-size: 13px; }
      #send-btn, #interrupt-btn { padding: 8px 12px; font-size: 13px; }
      #status-bar { gap: 8px; padding: 4px 10px; font-size: 11px; }
      .modal-content { min-width: 0; max-width: 90vw; margin: 0 16px; padding: 16px; }
      #toast-container { right: 10px; left: 10px; max-width: none; }
      #plan-approval-card { margin: 6px 10px; }
    }
  `
}

function getDashboardJs() {
  return `
(function() {
  "use strict";

  // ---- Config ----
  var config = window.__CHROXY_CONFIG__;
  var port = config.port;
  var token = config.token;

  // ---- State ----
  var ws = null;
  var connected = false;
  var isReplay = false;
  var sessions = [];
  var activeSessionId = null;
  var activeModel = null;
  var availableModels = [];
  var permissionMode = "approve";
  var isBusy = false;
  var streamingMsgId = null;
  var claudeReady = false;
  var userScrolledUp = false;
  var reconnectTimer = null;
  var RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];
  var MAX_RETRIES = 8;
  var reconnectAttempt = 0;
  var statusCost = 0;
  var statusContext = "";
  var statusModel = "";
  var backgroundAgents = new Map();
  var inPlanMode = false;
  var modalOpen = false;
  var hadInitialConnect = false;

  // ---- localStorage persistence ----
  var STORAGE_PREFIX = "chroxy_";
  var MAX_STORED_MESSAGES = 100;
  var MAX_ENTRY_SIZE = 50000;
  var persistTimer = null;
  var messageLog = [];
  var restoredFromCache = false;
  var activeCountdowns = [];

  // ---- Terminal state ----
  var currentView = "chat";
  var term = null;
  var fitAddon = null;
  var terminalBuffer = "";
  var TERMINAL_BUFFER_MAX = 102400;
  var serverMode = null;
  var CLIENT_PROTOCOL_VERSION = 1;
  var serverProtocolVersion = null;

  // ---- DOM refs ----
  var messagesEl = document.getElementById("chat-messages");
  var inputEl = document.getElementById("message-input");
  var sendBtn = document.getElementById("send-btn");
  var interruptBtn = document.getElementById("interrupt-btn");
  var statusDot = document.getElementById("connection-status");
  var reconnectBanner = document.getElementById("reconnect-banner");
  var reconnectText = document.getElementById("reconnect-text");
  var reconnectRetryBtn = document.getElementById("reconnect-retry-btn");
  var modelSelect = document.getElementById("model-select");
  var permissionSelect = document.getElementById("permission-select");
  var sessionTabs = document.getElementById("session-tabs");
  var newSessionBtn = document.getElementById("new-session-btn");
  var statusModelEl = document.getElementById("status-model");
  var statusCostEl = document.getElementById("status-cost");
  var statusContextEl = document.getElementById("status-context");
  var statusAgentsEl = document.getElementById("status-agents");
  var statusBusyEl = document.getElementById("status-busy");
  var planModeBanner = document.getElementById("plan-mode-banner");
  var planApprovalCard = document.getElementById("plan-approval-card");
  var planContentEl = document.getElementById("plan-content");
  var planApproveBtn = document.getElementById("plan-approve-btn");
  var planFeedbackBtn = document.getElementById("plan-feedback-btn");
  var createSessionModal = document.getElementById("create-session-modal");
  var modalSessionName = document.getElementById("modal-session-name");
  var modalSessionCwd = document.getElementById("modal-session-cwd");
  var modalCreateBtn = document.getElementById("modal-create-btn");
  var modalCancelBtn = document.getElementById("modal-cancel-btn");
  var qrBtn = document.getElementById("qr-btn");
  var qrModal = document.getElementById("qr-modal");
  var qrModalContainer = document.getElementById("qr-modal-container");
  var qrModalHint = document.getElementById("qr-modal-hint");
  var qrModalClose = document.getElementById("qr-modal-close");
  var historyBtn = document.getElementById("history-btn");
  var historyModal = document.getElementById("history-modal");
  var historyList = document.getElementById("history-list");
  var historyModalClose = document.getElementById("history-modal-close");
  var toastContainer = document.getElementById("toast-container");
  var viewSwitcher = document.getElementById("view-switcher");
  var terminalContainer = document.getElementById("terminal-container");

  // ---- Syntax highlighting ----
  var SYNTAX_COLORS = {
    keyword: "#c4a5ff", string: "#4eca6a", comment: "#7a7a7a",
    number: "#ff9a52", "function": "#4a9eff", operator: "#e0e0e0",
    punctuation: "#888888", type: "#4a9eff", property: "#4eca6a",
    plain: "#a0d0ff", diff_add: "#4eca6a", diff_remove: "#ff5b5b"
  };

  function stickyRe(pattern) {
    var flags = pattern.flags.indexOf("y") >= 0 ? pattern.flags : pattern.flags + "y";
    return new RegExp(pattern.source, flags);
  }

  var LANG_JS = [
    { p: stickyRe(/\\/\\/[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'\\\`])(?:(?!\\1|\\\\).|\\\\.)*.?\\1/), t: "string" },
    { p: stickyRe(/\\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:true|false|null|undefined|NaN|Infinity)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|RegExp|Set|String|Symbol|WeakMap|WeakSet|console|window|document|global|globalThis|process)\\b/), t: "type" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\\b/), t: "number" },
    { p: stickyRe(/\\b0[oO][0-7][0-7_]*\\b/), t: "number" },
    { p: stickyRe(/\\b0[bB][01][01_]*\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_$][\\w$]*(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/=>|[+\\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.]/), t: "punctuation" }
  ];
  var LANG_TS = [
    { p: stickyRe(/\\/\\/[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'\\\`])(?:(?!\\1|\\\\).|\\\\.)*.?\\1/), t: "string" },
    { p: stickyRe(/\\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|never|new|of|override|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:true|false|null|undefined|NaN|Infinity)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:any|bigint|boolean|number|object|string|symbol|unknown|void|never)\\b/), t: "type" },
    { p: stickyRe(/\\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|RegExp|Set|String|Symbol|WeakMap|WeakSet|console)\\b/), t: "type" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\\b/), t: "number" },
    { p: stickyRe(/\\b0[oO][0-7][0-7_]*\\b/), t: "number" },
    { p: stickyRe(/\\b0[bB][01][01_]*\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_$][\\w$]*(?=\\s*[<(])/), t: "function" },
    { p: stickyRe(/=>|[+\\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.]/), t: "punctuation" }
  ];
  var LANG_PY = [
    { p: stickyRe(/#[^\\n]*/), t: "comment" },
    { p: stickyRe(/"""[\\s\\S]*?"""/), t: "string" },
    { p: stickyRe(/'''[\\s\\S]*?'''/), t: "string" },
    { p: stickyRe(/[fFrRbBuU]?(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:True|False|None)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:int|float|str|bool|list|dict|tuple|set|frozenset|bytes|bytearray|type|object|range|complex|memoryview|Exception|TypeError|ValueError|KeyError|IndexError|AttributeError|RuntimeError|StopIteration)\\b/), t: "type" },
    { p: stickyRe(/\\b(?:print|len|range|enumerate|zip|map|filter|sorted|reversed|isinstance|issubclass|hasattr|getattr|setattr|super|property|staticmethod|classmethod|open|input)\\b(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\\b/), t: "number" },
    { p: stickyRe(/\\b0[oO][0-7][0-7_]*\\b/), t: "number" },
    { p: stickyRe(/\\b0[bB][01][01_]*\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\\w*(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/[-+*/%=!<>&|^~@:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.]/), t: "punctuation" }
  ];
  var LANG_BASH = [
    { p: stickyRe(/#[^\\n]*/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/\\$\\{[^}]*\\}/), t: "string" },
    { p: stickyRe(/\\$[a-zA-Z_]\\w*/), t: "string" },
    { p: stickyRe(/\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|alias|unalias|declare|typeset|readonly|shift|break|continue|exit|eval|exec|trap|set|unset)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:echo|printf|cd|ls|cat|grep|sed|awk|find|xargs|sort|uniq|wc|head|tail|cut|tr|tee|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|chgrp|touch|test|read|write|kill|ps|bg|fg|jobs|wait|nohup|true|false)\\b/), t: "function" },
    { p: stickyRe(/\\b\\d+\\b/), t: "number" },
    { p: stickyRe(/[|&;><!=]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\]]/), t: "punctuation" }
  ];
  var LANG_JSON = [
    { p: stickyRe(/"(?:[^"\\\\]|\\\\.)*"\\s*(?=:)/), t: "property" },
    { p: stickyRe(/"(?:[^"\\\\]|\\\\.)*"/), t: "string" },
    { p: stickyRe(/\\b(?:true|false|null)\\b/), t: "keyword" },
    { p: stickyRe(/-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b/), t: "number" },
    { p: stickyRe(/:/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\],]/), t: "punctuation" }
  ];
  var LANG_DIFF = [
    { p: stickyRe(/^\\+\\+\\+[^\\n]*/m), t: "keyword" },
    { p: stickyRe(/^---[^\\n]*/m), t: "keyword" },
    { p: stickyRe(/^@@[^\\n]*@@[^\\n]*/m), t: "keyword" },
    { p: stickyRe(/^\\+[^\\n]*/m), t: "diff_add" },
    { p: stickyRe(/^-[^\\n]*/m), t: "diff_remove" }
  ];
  var LANG_HTML = [
    { p: stickyRe(/<!--[\\s\\S]*?-->/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/<\\/?[a-zA-Z][\\w-]*/), t: "keyword" },
    { p: stickyRe(/\\/?>/), t: "keyword" },
    { p: stickyRe(/[a-zA-Z][\\w-]*(?=\\s*=)/), t: "property" },
    { p: stickyRe(/[=]/), t: "operator" }
  ];
  var LANG_CSS = [
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/@[a-zA-Z][\\w-]*/), t: "keyword" },
    { p: stickyRe(/\\b(?:important|inherit|initial|unset|revert)\\b/), t: "keyword" },
    { p: stickyRe(/#[0-9a-fA-F]{3,8}\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|deg|rad|s|ms|Hz|kHz|fr)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z][\\w-]*(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/[a-zA-Z-]+(?=\\s*:)/), t: "property" },
    { p: stickyRe(/[.#][a-zA-Z][\\w-]*/), t: "type" },
    { p: stickyRe(/[:;{}(),>+~*=]/), t: "punctuation" }
  ];
  var LANG_YAML = [
    { p: stickyRe(/#[^\\n]*/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/[a-zA-Z_][\\w.-]*(?=\\s*:)/), t: "property" },
    { p: stickyRe(/\\b(?:true|false|null|yes|no|on|off)\\b/i), t: "keyword" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[:\\-|>]/), t: "operator" }
  ];
  var LANG_GO = [
    { p: stickyRe(/\\/\\/[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'\\\`])(?:(?!\\1|\\\\).|\\\\.)*.?\\1/), t: "string" },
    { p: stickyRe(/\\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:true|false|nil|iota)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\\b/), t: "type" },
    { p: stickyRe(/\\b(?:append|cap|close|copy|delete|len|make|new|panic|print|println|recover)\\b(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\\w*(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/:=|[+\\-*/%=!<>&|^~]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.]/), t: "punctuation" }
  ];
  var LANG_RUST = [
    { p: stickyRe(/\\/\\/[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/\\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while|yield)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:true|false)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Cell|RefCell|HashMap|HashSet|BTreeMap|BTreeSet)\\b/), t: "type" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\\w*(?=\\s*[!(<])/), t: "function" },
    { p: stickyRe(/=>|->|[+\\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.#]/), t: "punctuation" }
  ];
  var LANG_JAVA = [
    { p: stickyRe(/\\/\\/[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/\\b(?:abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:true|false|null)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:boolean|byte|char|double|float|int|long|short|var|String|Integer|Long|Double|Float|Boolean|Character|Object|Class|System|List|Map|Set|ArrayList|HashMap|HashSet|Optional|Stream)\\b/), t: "type" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F_]*[lL]?\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d[\\d_]*)?[lLfFdD]?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\\w*(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/[+\\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.@]/), t: "punctuation" }
  ];
  var LANG_RUBY = [
    { p: stickyRe(/#[^\\n]*/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/\\bdefined\\?/), t: "keyword" },
    { p: stickyRe(/\\b(?:alias|and|begin|break|case|class|def|do|else|elsif|end|ensure|for|if|in|module|next|nil|not|or|redo|require|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:true|false|nil)\\b/), t: "keyword" },
    { p: stickyRe(/:[a-zA-Z_]\\w*/), t: "string" },
    { p: stickyRe(/\\b\\d[\\d_]*(?:\\.[\\d_]*)?\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\\w*(?=\\s*[({])/), t: "function" },
    { p: stickyRe(/[+\\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.@]/), t: "punctuation" }
  ];
  var LANG_C = [
    { p: stickyRe(/\\/\\/[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\\1|\\\\).|\\\\.)*\\1/), t: "string" },
    { p: stickyRe(/#\\s*(?:include|define|ifdef|ifndef|endif|if|else|elif|undef|pragma|error|warning)[^\\n]*/), t: "keyword" },
    { p: stickyRe(/\\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Bool|_Complex|_Imaginary)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:NULL|true|false)\\b/), t: "keyword" },
    { p: stickyRe(/\\b(?:size_t|ptrdiff_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|FILE|bool)\\b/), t: "type" },
    { p: stickyRe(/\\b0[xX][0-9a-fA-F][0-9a-fA-F]*[uUlL]*\\b/), t: "number" },
    { p: stickyRe(/\\b\\d[\\d]*(?:\\.[\\d]*)?(?:[eE][+-]?\\d+)?[uUlLfF]*\\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\\w*(?=\\s*\\()/), t: "function" },
    { p: stickyRe(/->|[+\\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\\[\\];,.]/), t: "punctuation" }
  ];
  var LANG_SQL = [
    { p: stickyRe(/--[^\\n]*/), t: "comment" },
    { p: stickyRe(/\\/\\*[\\s\\S]*?\\*\\//), t: "comment" },
    { p: stickyRe(/'(?:[^'\\\\]|\\\\.)*'/), t: "string" },
    { p: stickyRe(/\\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DATABASE|SCHEMA|JOIN|INNER|LEFT|RIGHT|OUTER|CROSS|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|CONSTRAINT|BEGIN|COMMIT|ROLLBACK|TRANSACTION|WITH|RETURNING|ASC|DESC)\\b/i), t: "keyword" },
    { p: stickyRe(/\\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|CHAR|VARCHAR|TEXT|BLOB|BOOLEAN|BOOL|DATE|TIME|TIMESTAMP|DATETIME|SERIAL|UUID|JSON|JSONB|ARRAY|BYTEA)\\b/i), t: "type" },
    { p: stickyRe(/\\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRIM|UPPER|LOWER|LENGTH|SUBSTR|SUBSTRING|REPLACE|CONCAT|NOW|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|OVER|PARTITION)\\b(?=\\s*\\()/i), t: "function" },
    { p: stickyRe(/\\b\\d+(?:\\.\\d+)?\\b/), t: "number" },
    { p: stickyRe(/[=<>!]+|[+\\-*/%]/), t: "operator" },
    { p: stickyRe(/[();,.]/), t: "punctuation" }
  ];

  var SYNTAX_LANGS = {
    javascript: LANG_JS, typescript: LANG_TS, jsx: LANG_JS, tsx: LANG_TS,
    python: LANG_PY, bash: LANG_BASH, json: LANG_JSON, diff: LANG_DIFF,
    html: LANG_HTML, xml: LANG_HTML, css: LANG_CSS, yaml: LANG_YAML,
    go: LANG_GO, rust: LANG_RUST, java: LANG_JAVA, ruby: LANG_RUBY,
    c: LANG_C, cpp: LANG_C, sql: LANG_SQL
  };
  var SYNTAX_ALIASES = {
    js: "javascript", ts: "typescript", py: "python", sh: "bash",
    shell: "bash", zsh: "bash", yml: "yaml", htm: "html", rb: "ruby",
    rs: "rust", "c++": "cpp", h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp",
    patch: "diff", mysql: "sql", postgresql: "sql", postgres: "sql",
    sqlite: "sql", kt: "java", kotlin: "java", scala: "java",
    cs: "java", csharp: "java", swift: "c", jsonc: "json", json5: "json",
    toml: "yaml"
  };

  function getSyntaxRules(lang) {
    if (!lang) return null;
    var key = lang.toLowerCase();
    return SYNTAX_LANGS[key] || SYNTAX_LANGS[SYNTAX_ALIASES[key] || ""] || null;
  }

  var MAX_HIGHLIGHT_LENGTH = 5000;

  function tokenize(code, lang) {
    if (!lang || code.length > MAX_HIGHLIGHT_LENGTH) return [{ text: code, type: "plain" }];
    var rules = getSyntaxRules(lang);
    if (!rules) return [{ text: code, type: "plain" }];
    var tokens = [];
    var pos = 0;
    var plainStart = 0;
    while (pos < code.length) {
      var matched = false;
      for (var ri = 0; ri < rules.length; ri++) {
        rules[ri].p.lastIndex = pos;
        var m = rules[ri].p.exec(code);
        if (m) {
          if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), "plain");
          pushToken(tokens, m[0], rules[ri].t);
          pos += m[0].length;
          plainStart = pos;
          matched = true;
          break;
        }
      }
      if (!matched) pos++;
    }
    if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), "plain");
    return tokens;
  }

  function pushToken(tokens, text, type) {
    var last = tokens.length > 0 ? tokens[tokens.length - 1] : null;
    if (last && last.type === type) { last.text += text; }
    else { tokens.push({ text: text, type: type }); }
  }

  function highlightCode(code, lang) {
    var tokens = tokenize(code, lang);
    var out = "";
    for (var i = 0; i < tokens.length; i++) {
      var color = SYNTAX_COLORS[tokens[i].type] || SYNTAX_COLORS.plain;
      out += '<span style="color:' + color + '">' + escapeHtml(tokens[i].text) + '</span>';
    }
    return out;
  }

  // ---- Markdown renderer ----
  function renderMarkdown(text) {
    if (!text) return "";

    // Extract fenced code blocks BEFORE HTML-escaping (so highlighter gets raw code)
    var codeBlocks = [];
    var raw = text.replace(/\\\`\\\`\\\`(\\w*)?\\n([\\s\\S]*?)\\\`\\\`\\\`/g, function(m, lang, code) {
      var placeholder = "\\x00CB" + codeBlocks.length + "\\x00";
      var cls = lang ? ' class="language-' + lang + '"' : "";
      var highlighted = lang ? highlightCode(code, lang) : escapeHtml(code);
      codeBlocks.push('<pre><code' + cls + '>' + highlighted + '</code></pre>');
      return placeholder;
    });

    // Extract inline code before escaping
    raw = raw.replace(/\\\`([^\\\`\\n]+)\\\`/g, function(m, code) {
      var placeholder = "\\x00CB" + codeBlocks.length + "\\x00";
      codeBlocks.push("<code>" + escapeHtml(code) + "</code>");
      return placeholder;
    });

    // Now HTML-escape the remaining text
    var html = raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold and italic
    html = html.replace(/\\\*\\\*(.+?)\\\*\\\*/g, "<strong>$1</strong>");
    html = html.replace(/\\\*(.+?)\\\*/g, "<em>$1</em>");

    // Links — sanitize URL scheme to block javascript:/data:/vbscript:
    html = html.replace(/\\\[([^\\\]]+)\\\]\\\(([^)]+)\\\)/g, function(m, text, url) {
      if (/^\\s*(javascript|data|vbscript)\\s*:/i.test(url)) {
        return text;
      }
      var safeUrl = url.replace(/"/g, "&quot;");
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener">' + text + '</a>';
    });

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\\/li>\\n?)+/g, function(m) {
      return "<ul>" + m + "</ul>";
    });

    // Ordered lists — wrap in <ol>
    html = html.replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs (double newlines)
    html = html.replace(/\\n\\n/g, "</p><p>");
    // Single newlines to <br>
    html = html.replace(/\\n/g, "<br>");

    // Restore code blocks from placeholders
    for (var i = 0; i < codeBlocks.length; i++) {
      html = html.replace("\\x00CB" + i + "\\x00", codeBlocks[i]);
    }

    return html;
  }

  // ---- Auto-scroll logic ----
  messagesEl.addEventListener("scroll", function() {
    var threshold = 60;
    var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    userScrolledUp = !atBottom;
  });

  function scrollToBottom() {
    if (!userScrolledUp) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ---- Persistence functions ----
  function saveMessages() {
    if (!activeSessionId) return;
    try {
      var toStore = messageLog.slice(-MAX_STORED_MESSAGES).map(function(entry) {
        var e = Object.assign({}, entry);
        if (e.content && e.content.length > MAX_ENTRY_SIZE) {
          e.content = e.content.slice(0, MAX_ENTRY_SIZE) + "\\n[truncated]";
        }
        if (e.result && e.result.length > MAX_ENTRY_SIZE) {
          e.result = e.result.slice(0, MAX_ENTRY_SIZE) + "\\n[truncated]";
        }
        return e;
      });
      localStorage.setItem(STORAGE_PREFIX + "messages_" + activeSessionId, JSON.stringify(toStore));
      localStorage.setItem(STORAGE_PREFIX + "active_session", activeSessionId);
    } catch (e) {
      console.warn("[dashboard] Failed to save messages:", e);
    }
  }

  function debouncedSave() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(saveMessages, 500);
  }

  function loadMessages(sessionId) {
    try {
      var data = localStorage.getItem(STORAGE_PREFIX + "messages_" + sessionId);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function restoreMessages(sessionId) {
    if (!sessionId) return;
    if (messageLog.length > 0) return; // already have messages
    var stored = loadMessages(sessionId);
    if (stored.length === 0) return;
    restoredFromCache = true;
    messageLog = stored;
    stored.forEach(function(entry) {
      if (entry.type === "tool") {
        var bubble = addToolBubble(entry.tool || "tool", entry.toolUseId || "", entry.input || null, true);
        if (entry.result && bubble) {
          var resultDiv = bubble.querySelector(".tool-result");
          if (resultDiv) resultDiv.textContent = entry.result;
        }
      } else if (entry.type === "permission") {
        addPermissionPrompt(entry.requestId || "", entry.tool || "Unknown", entry.description || "", null, true);
      } else {
        addMessage(entry.msgType || "system", entry.content || "", { skipLog: true });
      }
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function logMessage(entry) {
    messageLog.push(entry);
    debouncedSave();
  }

  // ---- Terminal functions ----
  function initTerminal() {
    if (term) return;
    if (typeof Terminal === "undefined") {
      terminalContainer.innerHTML = '<div class="terminal-notice"><div class="notice-title">Terminal Unavailable</div><div>xterm.js could not be loaded</div></div>';
      return;
    }
    term = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      scrollback: 5000,
      fontSize: 14,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#0f0f1a",
        foreground: "#f8f8f2",
        cursor: "#f8f8f0",
        black: "#000000",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#bfbfbf",
        brightBlack: "#4d4d4d",
        brightRed: "#ff6e67",
        brightGreen: "#5af78e",
        brightYellow: "#f4f99d",
        brightBlue: "#caa9fa",
        brightMagenta: "#ff92d0",
        brightCyan: "#9aedfe",
        brightWhite: "#e6e6e6"
      }
    });
    if (typeof FitAddon !== "undefined") {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    term.open(terminalContainer);
    if (fitAddon) {
      try { fitAddon.fit(); } catch(e) {}
    }
    // Resize on container resize
    var resizeTimer = null;
    var ro = new ResizeObserver(function() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function() {
        if (fitAddon && currentView === "terminal") {
          try { fitAddon.fit(); } catch(e) {}
        }
      }, 250);
    });
    ro.observe(terminalContainer);
  }

  function switchView(view) {
    if (view === currentView) return;
    currentView = view;
    // Update tab active states and ARIA
    viewSwitcher.querySelectorAll(".view-tab").forEach(function(tab) {
      var isActive = tab.getAttribute("data-view") === view;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    if (view === "chat") {
      messagesEl.classList.remove("hidden");
      terminalContainer.classList.add("hidden");
      scrollToBottom();
    } else {
      messagesEl.classList.add("hidden");
      terminalContainer.classList.remove("hidden");
      if (serverMode === "cli") {
        if (!terminalContainer.querySelector(".terminal-notice")) {
          terminalContainer.innerHTML = '<div class="terminal-notice"><div class="notice-title">Terminal Not Available</div><div>Terminal view is not available for this session.</div></div>';
        }
      } else {
        initTerminal();
        if (term && terminalBuffer) {
          term.reset();
          term.write(terminalBuffer);
        }
        if (fitAddon) {
          try { fitAddon.fit(); } catch(e) {}
        }
      }
    }
    // Tell server which view we want
    send({ type: "mode", mode: view === "terminal" ? "terminal" : "chat" });
  }

  // View switcher click handler
  viewSwitcher.addEventListener("click", function(e) {
    var tab = e.target.closest(".view-tab");
    if (!tab) return;
    switchView(tab.getAttribute("data-view"));
  });

  // ---- Textarea auto-resize ----
  inputEl.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 150) + "px";
  });

  // ---- Message rendering ----
  function addMessage(type, content, opts) {
    opts = opts || {};
    var div = document.createElement("div");

    if (type === "assistant" || type === "response") {
      div.className = "msg assistant";
      div.innerHTML = renderMarkdown(content);
    } else if (type === "user" || type === "user_input") {
      div.className = "msg user";
      div.textContent = content;
    } else if (type === "system") {
      div.className = "msg system";
      div.textContent = content;
    } else if (type === "error") {
      div.className = "msg error";
      div.textContent = content;
    }

    if (opts.id) div.setAttribute("data-msg-id", sanitizeId(opts.id));
    messagesEl.appendChild(div);
    scrollToBottom();
    if (!opts.skipLog) {
      logMessage({ msgType: type, content: content, timestamp: Date.now() });
    }
    return div;
  }

  function addToolBubble(tool, toolUseId, input, skipLog) {
    var div = document.createElement("div");
    div.className = "tool-bubble";
    div.setAttribute("data-tool-id", sanitizeId(toolUseId || ""));
    var inputSummary = "";
    if (input) {
      if (typeof input === "object") {
        // Show the most useful field
        inputSummary = input.command || input.file_path || input.path || input.description || "";
        if (typeof inputSummary !== "string") inputSummary = JSON.stringify(inputSummary).slice(0, 100);
      } else {
        inputSummary = String(input).slice(0, 100);
      }
    }
    div.innerHTML = '<span class="tool-name">' + escapeHtml(tool) + '</span>' +
      (inputSummary ? ' <span style="color:#666">' + escapeHtml(inputSummary) + '</span>' : "") +
      '<div class="tool-result"></div>';
    div.addEventListener("click", function() {
      div.classList.toggle("expanded");
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    if (!skipLog) {
      logMessage({ type: "tool", tool: tool, toolUseId: toolUseId, input: inputSummary, timestamp: Date.now() });
    }
    return div;
  }

  function addPermissionPrompt(requestId, tool, description, remainingMs, skipLog) {
    var div = document.createElement("div");
    div.className = "permission-prompt";
    div.setAttribute("data-request-id", sanitizeId(requestId));
    div.innerHTML =
      '<div class="perm-desc"><span class="perm-tool">' + escapeHtml(tool) + '</span>: ' +
      escapeHtml(description || "Permission requested") + '</div>' +
      '<div class="perm-countdown"></div>' +
      '<div class="perm-buttons">' +
      '<button class="btn-allow" data-decision="allow">Allow</button>' +
      '<button class="btn-deny" data-decision="deny">Deny</button>' +
      '</div>' +
      '<div class="perm-answer" style="display:none"></div>';

    // Countdown timer — handle expired, active, and missing states
    var countdownEl = div.querySelector(".perm-countdown");
    var countdownInterval = null;
    if (typeof remainingMs === "number") {
      if (remainingMs > 0 && !skipLog) {
        var expiresAt = Date.now() + remainingMs;
        function updateCountdown() {
          var remaining = Math.max(0, expiresAt - Date.now());
          if (remaining <= 0) {
            clearInterval(countdownInterval);
            activeCountdowns = activeCountdowns.filter(function(id) { return id !== countdownInterval; });
            countdownEl.textContent = "Timed out";
            countdownEl.classList.add("expired");
            return;
          }
          var mins = Math.floor(remaining / 60000);
          var secs = Math.floor((remaining % 60000) / 1000);
          countdownEl.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
          if (remaining <= 30000) {
            countdownEl.classList.add("urgent");
          }
        }
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
        activeCountdowns.push(countdownInterval);
      } else {
        // Zero or negative remaining — immediately expired
        countdownEl.textContent = "Timed out";
        countdownEl.classList.add("expired");
      }
    } else {
      // No remainingMs (older servers or restored prompts) — hide countdown
      countdownEl.style.display = "none";
    }

    div.querySelectorAll("button").forEach(function(btn) {
      btn.addEventListener("click", function() {
        if (countdownInterval) {
          clearInterval(countdownInterval);
          activeCountdowns = activeCountdowns.filter(function(id) { return id !== countdownInterval; });
        }
        var decision = btn.getAttribute("data-decision");
        sendPermissionResponse(requestId, decision);
        div.classList.add("answered");
        div.querySelector(".perm-answer").textContent = decision === "allow" ? "Allowed" : "Denied";
        div.querySelector(".perm-answer").style.display = "block";
        countdownEl.style.display = "none";
      });
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    if (!skipLog) {
      logMessage({ type: "permission", requestId: requestId, tool: tool, description: description, timestamp: Date.now() });
    }
    return div;
  }

  function addQuestionPrompt(question, toolUseId, options) {
    var div = document.createElement("div");
    div.className = "question-prompt";
    div.setAttribute("data-tool-use-id", sanitizeId(toolUseId || ""));

    var html = '<div class="q-text">' + escapeHtml(question) + '</div>';

    // If options are provided, show them as buttons
    if (Array.isArray(options) && options.length > 0) {
      html += '<div class="q-options">';
      options.forEach(function(opt) {
        html += '<button class="q-option-btn">' + escapeHtml(opt) + '</button>';
      });
      html += '</div>';
    }

    // Always show text input as fallback
    html += '<div class="q-input-row">' +
      '<input type="text" placeholder="Type your answer...">' +
      '<button>Reply</button>' +
      '</div>' +
      '<div class="q-answer-text"></div>';

    div.innerHTML = html;

    // Option button handlers
    div.querySelectorAll(".q-option-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        if (div.classList.contains("answered")) return;
        var answer = btn.textContent;
        sendQuestionResponse(answer, toolUseId);
        div.querySelector(".q-answer-text").textContent = "Answered: " + answer;
        div.classList.add("answered");
      });
    });

    // Text input handler
    var qInput = div.querySelector("input");
    var qBtn = div.querySelector(".q-input-row button");
    function submitAnswer() {
      if (div.classList.contains("answered")) return;
      var answer = qInput.value.trim();
      if (!answer) return;
      sendQuestionResponse(answer, toolUseId);
      div.querySelector(".q-answer-text").textContent = "Answered: " + answer;
      div.classList.add("answered");
    }
    qBtn.addEventListener("click", submitAnswer);
    qInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") submitAnswer();
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function showThinking() {
    removeThinking();
    var div = document.createElement("div");
    div.className = "thinking-dots";
    div.id = "thinking-indicator";
    div.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function removeThinking() {
    var el = document.getElementById("thinking-indicator");
    if (el) el.remove();
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function sanitizeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  // ---- Session tabs ----
  function renderSessions() {
    sessionTabs.innerHTML = "";
    var showClose = sessions.length > 1;
    sessions.forEach(function(s) {
      var tab = document.createElement("div");
      tab.className = "session-tab" + (s.sessionId === activeSessionId ? " active" : "");

      // Busy indicator dot
      if (s.isBusy) {
        var dot = document.createElement("span");
        dot.className = "tab-busy-dot";
        tab.appendChild(dot);
      }

      var nameSpan = document.createElement("span");
      nameSpan.className = "tab-name";
      nameSpan.textContent = s.name || "Default";
      tab.appendChild(nameSpan);

      // Abbreviated cwd
      if (s.cwd) {
        var cwdSpan = document.createElement("span");
        cwdSpan.className = "tab-cwd";
        var parts = s.cwd.split(/[\\/]/);
        cwdSpan.textContent = parts[parts.length - 1] || s.cwd;
        cwdSpan.title = s.cwd;
        tab.appendChild(cwdSpan);
      }

      // Model badge (short name)
      if (s.model) {
        var modelBadge = document.createElement("span");
        modelBadge.className = "tab-model";
        var short = s.model.replace(/^claude-/, "").replace(/-\\d.*$/, "");
        modelBadge.textContent = short;
        tab.appendChild(modelBadge);
      }

      // Close button (hidden when only 1 session)
      var closeBtn = document.createElement("button");
      closeBtn.className = "tab-close" + (showClose ? " visible" : "");
      closeBtn.innerHTML = "&times;";
      closeBtn.title = "Destroy session";
      closeBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        if (window.confirm("Destroy session '" + (s.name || "Default") + "'?")) {
          send({ type: "destroy_session", sessionId: s.sessionId });
        }
      });
      tab.appendChild(closeBtn);

      // Click to switch session
      tab.addEventListener("click", function() {
        if (s.sessionId !== activeSessionId) {
          send({ type: "switch_session", sessionId: s.sessionId });
        }
      });

      // Double-click to rename session (inline editing)
      tab.addEventListener("dblclick", function(e) {
        e.preventDefault();
        e.stopPropagation();
        startInlineRename(tab, s);
      });

      sessionTabs.appendChild(tab);
    });
  }

  function startInlineRename(tab, session) {
    var nameSpan = tab.querySelector(".tab-name");
    if (!nameSpan) return;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.value = session.name || "Default";
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      var newName = input.value.trim();
      if (newName && newName !== (session.name || "Default")) {
        send({ type: "rename_session", sessionId: session.sessionId, name: newName });
      }
      // Re-render regardless to restore normal tab look
      renderSessions();
    }
    function cancel() {
      renderSessions();
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); input.removeEventListener("blur", commit); cancel(); }
    });
  }

  // ---- Create session modal ----
  function openCreateSessionModal() {
    modalSessionName.value = "";
    modalSessionCwd.value = "";
    createSessionModal.classList.remove("hidden");
    modalOpen = true;
    modalSessionName.focus();
  }

  function closeCreateSessionModal() {
    createSessionModal.classList.add("hidden");
    modalOpen = false;
  }

  function submitCreateSession() {
    var name = modalSessionName.value.trim();
    var cwd = modalSessionCwd.value.trim();
    if (!name) { modalSessionName.focus(); return; }
    var msg = { type: "create_session", name: name };
    if (cwd) msg.cwd = cwd;
    send(msg);
    closeCreateSessionModal();
  }

  newSessionBtn.addEventListener("click", function() {
    openCreateSessionModal();
  });

  modalCreateBtn.addEventListener("click", submitCreateSession);
  modalCancelBtn.addEventListener("click", closeCreateSessionModal);

  // Close modal on backdrop click
  createSessionModal.addEventListener("click", function(e) {
    if (e.target === createSessionModal) closeCreateSessionModal();
  });

  // Modal keyboard: Enter to submit, Escape to close
  createSessionModal.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); submitCreateSession(); }
    if (e.key === "Escape") { e.preventDefault(); closeCreateSessionModal(); }
  });

  // ---- QR pairing modal ----
  function openQrModal() {
    qrModalContainer.innerHTML = '<span style="color:#555;font-size:13px;">Loading...</span>';
    qrModalHint.textContent = 'Scan with Chroxy app to connect';
    qrModal.classList.remove("hidden");
    modalOpen = true;

    fetch('/qr', { headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
      .then(function(r) {
        if (!r.ok) throw new Error(r.status);
        var ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('image/svg+xml')) throw new Error('unexpected_content_type');
        return r.text();
      })
      .then(function(svg) {
        qrModalContainer.innerHTML = svg;
        // Scale SVG to fill container
        var svgEl = qrModalContainer.querySelector('svg');
        if (svgEl) {
          svgEl.setAttribute('width', '180');
          svgEl.setAttribute('height', '180');
        }
      })
      .catch(function() {
        qrModalContainer.innerHTML = '<span style="color:#f87171;font-size:13px;">QR unavailable</span>';
        qrModalHint.textContent = 'Connection info not available. Is a tunnel configured?';
      });
  }

  function closeQrModal() {
    qrModal.classList.add("hidden");
    modalOpen = false;
  }

  qrBtn.addEventListener("click", openQrModal);
  qrModalClose.addEventListener("click", closeQrModal);
  qrModal.addEventListener("click", function(e) {
    if (e.target === qrModal) closeQrModal();
  });
  qrModal.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { e.preventDefault(); closeQrModal(); }
  });

  // ---- History modal ----
  function relativeTime(isoStr) {
    var ms = Date.now() - new Date(isoStr).getTime();
    var s = Math.floor(ms / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d === 1) return "yesterday";
    if (d < 30) return d + "d ago";
    return new Date(isoStr).toLocaleDateString();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + "KB";
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  }

  function openHistoryModal() {
    historyList.innerHTML = '<div class="history-loading">Scanning conversations...</div>';
    historyModal.classList.remove("hidden");
    modalOpen = true;
    send({ type: "list_conversations" });
  }

  function closeHistoryModal() {
    historyModal.classList.add("hidden");
    modalOpen = false;
  }

  function renderConversations(conversations) {
    if (!conversations || conversations.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No conversation history found</div>';
      return;
    }
    // Group by projectName
    var groups = {};
    var groupOrder = [];
    conversations.forEach(function(c) {
      var key = c.projectName || "Unknown";
      if (!groups[key]) {
        groups[key] = [];
        groupOrder.push(key);
      }
      groups[key].push(c);
    });

    var html = "";
    groupOrder.forEach(function(name) {
      html += '<div class="history-group">';
      html += '<div class="history-group-name">' + escapeHtml(name) + '</div>';
      groups[name].forEach(function(c) {
        var preview = c.preview ? escapeHtml(c.preview.slice(0, 80)) : '<em style="color:#555">No preview</em>';
        var time = relativeTime(c.modifiedAt);
        var size = formatSize(c.sizeBytes);
        html += '<div class="history-item" data-conv-id="' + escapeHtml(c.conversationId) + '" data-cwd="' + escapeHtml(c.cwd || "") + '">';
        html += '<div class="history-item-body">';
        html += '<div class="history-item-preview">' + preview + '</div>';
        html += '<div class="history-item-meta">' + time + ' &middot; ' + size + '</div>';
        html += '</div>';
        html += '<button class="history-item-resume">Resume</button>';
        html += '</div>';
      });
      html += '</div>';
    });
    historyList.innerHTML = html;

    // Attach click handlers
    historyList.querySelectorAll(".history-item-resume").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var item = btn.closest(".history-item");
        var convId = item.getAttribute("data-conv-id");
        var cwd = item.getAttribute("data-cwd");
        send({ type: "resume_conversation", conversationId: convId, cwd: cwd || undefined });
        closeHistoryModal();
      });
    });
  }

  historyBtn.addEventListener("click", openHistoryModal);
  historyModalClose.addEventListener("click", closeHistoryModal);
  historyModal.addEventListener("click", function(e) {
    if (e.target === historyModal) closeHistoryModal();
  });
  historyModal.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { e.preventDefault(); closeHistoryModal(); }
  });

  // ---- Model + permission selects ----
  modelSelect.addEventListener("change", function() {
    if (modelSelect.value) {
      send({ type: "set_model", model: modelSelect.value });
    }
  });

  permissionSelect.addEventListener("change", function() {
    send({ type: "set_permission_mode", mode: permissionSelect.value });
  });

  function updateModelSelect() {
    var previousValue = modelSelect.value;
    modelSelect.innerHTML = "";
    // Keep placeholder when no models available yet
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Model";
    modelSelect.appendChild(placeholder);
    if (!availableModels || availableModels.length === 0) return;
    availableModels.forEach(function(m) {
      var opt = document.createElement("option");
      opt.value = m.id || m.fullId || m;
      opt.textContent = m.label || m.id || m;
      modelSelect.appendChild(opt);
    });
    if (activeModel) {
      // Try to select by matching label or id (skip placeholder at 0)
      for (var i = 1; i < modelSelect.options.length; i++) {
        var optLabel = modelSelect.options[i].textContent.toLowerCase();
        var optVal = modelSelect.options[i].value.toLowerCase();
        if (optLabel === activeModel.toLowerCase() || optVal === activeModel.toLowerCase()) {
          modelSelect.selectedIndex = i;
          return;
        }
      }
    }
    // Fall back to previous selection if possible
    if (previousValue) {
      for (var j = 1; j < modelSelect.options.length; j++) {
        if (modelSelect.options[j].value === previousValue) {
          modelSelect.selectedIndex = j;
          return;
        }
      }
    }
  }

  // ---- Status bar ----
  function updateStatusBar() {
    statusModelEl.textContent = statusModel || activeModel || "";
    statusCostEl.textContent = statusCost ? "$" + statusCost.toFixed(4) : "";
    statusContextEl.textContent = statusContext || "";
  }

  function updateAgentBadge() {
    var count = backgroundAgents.size;
    if (count > 0) {
      statusAgentsEl.textContent = count + (count === 1 ? " agent" : " agents");
      statusAgentsEl.classList.remove("hidden");
    } else {
      statusAgentsEl.classList.add("hidden");
    }
  }

  function updateBusyIndicator() {
    if (isBusy) {
      statusBusyEl.classList.remove("hidden");
    } else {
      statusBusyEl.classList.add("hidden");
    }
  }

  // ---- Toast notifications ----
  function showToast(message) {
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "alert");
    toast.innerHTML =
      '<span class="toast-msg">' + escapeHtml(message) + '</span>' +
      '<button class="toast-close" aria-label="Close notification">&times;</button>';
    toast.querySelector(".toast-close").addEventListener("click", function() {
      toast.remove();
    });
    while (toastContainer.children.length >= 5) { toastContainer.removeChild(toastContainer.firstChild); }
    toastContainer.appendChild(toast);
    // Auto-dismiss after 5 seconds
    setTimeout(function() {
      if (toast.parentNode) toast.remove();
    }, 5000);
  }

  // ---- Connection status ----
  function setConnectionState(state) {
    statusDot.className = "status-dot " + state;
    connected = state === "connected";
    if (state === "connected") {
      hadInitialConnect = true;
      reconnectAttempt = 0;
      reconnectBanner.classList.add("hidden");
    }
    updateButtons();
  }

  function updateButtons() {
    sendBtn.disabled = !connected || !claudeReady;
    interruptBtn.disabled = !connected || !isBusy;
  }

  // ---- WebSocket connection ----
  function connect() {
    if (ws) {
      try { ws.close(); } catch(e) {}
    }
    setConnectionState("connecting");

    var url = "ws://localhost:" + port;
    ws = new WebSocket(url);

    ws.onopen = function() {
      // Send auth
      send({
        type: "auth",
        token: token,
        deviceInfo: {
          deviceName: "Web Dashboard",
          deviceType: "desktop",
          platform: "web"
        }
      });
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch(e) {
        console.error("[dashboard] Failed to parse message:", e);
      }
    };

    ws.onclose = function() {
      setConnectionState("disconnected");
      connected = false;
      claudeReady = false;
      isBusy = false;
      updateBusyIndicator();
      updateButtons();
      // Auto-reconnect with escalating backoff
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (hadInitialConnect) {
        reconnectRetryBtn.classList.add("hidden");
        if (reconnectAttempt < MAX_RETRIES) {
          var delay = RETRY_DELAYS[Math.min(reconnectAttempt, RETRY_DELAYS.length - 1)];
          reconnectText.textContent = "Disconnected. Reconnecting in " + Math.round(delay / 1000) + "s (" + (reconnectAttempt + 1) + "/" + MAX_RETRIES + ")...";
          reconnectBanner.classList.remove("hidden");
          reconnectTimer = setTimeout(function() {
            reconnectAttempt++;
            connect();
          }, delay);
        } else {
          reconnectText.textContent = "Connection lost.";
          reconnectRetryBtn.classList.remove("hidden");
          reconnectBanner.classList.remove("hidden");
        }
      } else {
        // Initial connection attempt — retry quickly
        reconnectTimer = setTimeout(function() {
          connect();
        }, 1000);
      }
    };

    ws.onerror = function(err) {
      console.error("[dashboard] WebSocket error:", err);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function sendInput(text) {
    if (!text || !text.trim()) return;
    if (!connected || !claudeReady) return;
    send({ type: "input", data: text.trim() });
    addMessage("user", text.trim(), { skipLog: false });
    inputEl.value = "";
    inputEl.style.height = "auto";
    isBusy = true;
    updateButtons();
  }

  function sendInterrupt() {
    send({ type: "interrupt" });
  }

  function sendPermissionResponse(requestId, decision) {
    send({ type: "permission_response", requestId: requestId, decision: decision });
  }

  function sendQuestionResponse(answer, toolUseId) {
    var msg = { type: "user_question_response", answer: answer };
    if (toolUseId) msg.toolUseId = toolUseId;
    send(msg);
  }

  // ---- Message handler ----
  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "auth_ok":
        setConnectionState("connected");
        if (msg.serverMode) {
          serverMode = msg.serverMode;
        }
        if (typeof msg.protocolVersion === "number") {
          serverProtocolVersion = msg.protocolVersion;
        }
        break;

      case "server_mode":
        serverMode = msg.mode || null;
        break;

      case "raw":
        if (msg.data) {
          terminalBuffer += msg.data;
          if (terminalBuffer.length > TERMINAL_BUFFER_MAX) {
            terminalBuffer = terminalBuffer.slice(-TERMINAL_BUFFER_MAX);
          }
          if (term && currentView === "terminal") {
            term.write(msg.data);
          }
        }
        break;

      case "status":
        if (msg.connected) {
          setConnectionState("connected");
        }
        break;

      case "session_list":
        if (Array.isArray(msg.sessions)) {
          sessions = msg.sessions;
          // Validate restored activeSessionId still exists on the server
          if (activeSessionId && !sessions.some(function(s) { return s && s.sessionId === activeSessionId; })) {
            activeSessionId = sessions.length > 0 ? sessions[0].sessionId : null;
            messagesEl.innerHTML = "";
            messageLog = [];
            restoredFromCache = false;
            if (activeSessionId) restoreMessages(activeSessionId);
          }
          renderSessions();
        }
        break;

      case "session_switched":
        // Save messages for old session before switching
        saveMessages();
        // Clear active countdown intervals before wiping DOM
        activeCountdowns.forEach(function(id) { clearInterval(id); });
        activeCountdowns = [];
        activeSessionId = msg.sessionId;
        messagesEl.innerHTML = "";
        messageLog = [];
        restoredFromCache = false;
        restoreMessages(activeSessionId);
        // Clear terminal buffer for new session
        terminalBuffer = "";
        if (term) {
          try { term.clear(); } catch(e) {}
        }
        renderSessions();
        break;

      case "session_destroyed":
        // Clean up persisted messages for destroyed session
        if (msg.sessionId) {
          localStorage.removeItem(STORAGE_PREFIX + "messages_" + msg.sessionId);
        }
        break;

      case "conversations_list":
        renderConversations(msg.conversations);
        break;

      case "claude_ready":
        claudeReady = true;
        isBusy = false;
        removeThinking();
        updateBusyIndicator();
        updateButtons();
        break;

      case "history_replay_start":
        isReplay = true;
        userScrolledUp = true; // Don't auto-scroll during replay
        break;

      case "history_replay_end":
        isReplay = false;
        userScrolledUp = false;
        // Scroll to bottom after replay
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;

      case "message": {
        var messageType = msg.messageType || "response";
        if (messageType === "response" || messageType === "assistant") {
          addMessage("assistant", msg.content || "");
        } else if (messageType === "user_input") {
          addMessage("user", msg.content || "");
        } else if (messageType === "tool_use") {
          addToolBubble(msg.tool || "tool", msg.toolUseId || "", msg.toolInput || null);
        } else {
          addMessage("system", msg.content || "");
        }
        break;
      }

      case "stream_start": {
        streamingMsgId = msg.messageId;
        var streamDiv = document.createElement("div");
        streamDiv.className = "msg assistant";
        streamDiv.setAttribute("data-msg-id", sanitizeId(streamingMsgId));
        streamDiv.innerHTML = "";
        messagesEl.appendChild(streamDiv);
        removeThinking();
        isBusy = true;
        updateBusyIndicator();
        updateButtons();
        scrollToBottom();
        break;
      }

      case "stream_delta": {
        if (!msg.delta) break;
        var target = null;
        if (msg.messageId) {
          target = messagesEl.querySelector('[data-msg-id="' + sanitizeId(msg.messageId) + '"]');
        }
        if (!target && streamingMsgId) {
          target = messagesEl.querySelector('[data-msg-id="' + sanitizeId(streamingMsgId) + '"]');
        }
        if (target) {
          // Accumulate raw text, then re-render markdown
          var raw = target.getAttribute("data-raw") || "";
          raw += msg.delta;
          target.setAttribute("data-raw", raw);
          target.innerHTML = renderMarkdown(raw);
        }
        scrollToBottom();
        break;
      }

      case "stream_end": {
        // Log the completed streamed message
        if (streamingMsgId) {
          var streamEl = messagesEl.querySelector('[data-msg-id="' + sanitizeId(streamingMsgId) + '"]');
          if (streamEl) {
            var rawText = streamEl.getAttribute("data-raw") || streamEl.textContent || "";
            logMessage({ msgType: "assistant", content: rawText, timestamp: Date.now() });
          }
        }
        streamingMsgId = null;
        break;
      }

      case "tool_start":
        addToolBubble(msg.tool || "tool", msg.toolUseId || msg.messageId || "", msg.input || null);
        break;

      case "tool_result": {
        var toolId = msg.toolUseId || "";
        var toolEl = messagesEl.querySelector('[data-tool-id="' + sanitizeId(toolId) + '"]');
        if (toolEl) {
          var resultDiv = toolEl.querySelector(".tool-result");
          if (resultDiv) {
            resultDiv.textContent = msg.result || "";
            if (msg.truncated) {
              resultDiv.textContent += "\\n[truncated]";
            }
          }
        }
        // Update messageLog entry with result
        for (var ri = messageLog.length - 1; ri >= 0; ri--) {
          if (messageLog[ri].type === "tool" && messageLog[ri].toolUseId === toolId) {
            messageLog[ri].result = msg.result || "";
            debouncedSave();
            break;
          }
        }
        break;
      }

      case "permission_request":
        addPermissionPrompt(msg.requestId, msg.tool || "Unknown", msg.description || "", msg.remainingMs);
        // Desktop notification when tab not focused
        if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
          var permNote = new Notification("Chroxy: Permission Required", {
            body: (msg.tool || "Tool") + ": " + (msg.description || "").slice(0, 100),
            tag: "chroxy-permission-" + msg.requestId,
            requireInteraction: true
          });
          permNote.onclick = function() { window.focus(); };
        }
        break;

      case "user_question": {
        if (Array.isArray(msg.questions) && msg.questions.length > 0) {
          var q = msg.questions[0];
          var questionOptions = Array.isArray(q.options) ? q.options : null;
          addQuestionPrompt(q.question || "Question from Claude", msg.toolUseId || "", questionOptions);
          // Desktop notification when tab not focused
          if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
            var qNote = new Notification("Chroxy: Question from Claude", {
              body: (q.question || "").slice(0, 100),
              tag: "chroxy-question-" + (msg.toolUseId || Date.now()),
              requireInteraction: true
            });
            qNote.onclick = function() { window.focus(); };
          }
        }
        break;
      }

      case "model_changed":
        activeModel = msg.model || null;
        statusModel = activeModel || "";
        updateModelSelect();
        updateStatusBar();
        break;

      case "available_models":
        if (Array.isArray(msg.models)) {
          availableModels = msg.models;
          updateModelSelect();
        }
        break;

      case "permission_mode_changed":
        permissionMode = msg.mode || "approve";
        permissionSelect.value = permissionMode;
        break;

      case "confirm_permission_mode": {
        var targetMode = msg.mode || "approve";
        var warning = msg.message || "Enable " + targetMode + " mode? Tools may run without approval.";
        if (window.confirm(warning)) {
          send({ type: "set_permission_mode", mode: targetMode, confirmed: true });
        } else {
          permissionSelect.value = permissionMode;
        }
        break;
      }

      case "available_permission_modes":
        if (Array.isArray(msg.modes) && msg.modes.length > 0) {
          var previousValue = permissionSelect.value;
          permissionSelect.innerHTML = "";
          msg.modes.forEach(function(m) {
            var opt = document.createElement("option");
            opt.value = m.id || m;
            opt.textContent = m.label || m.id || m;
            permissionSelect.appendChild(opt);
          });
          permissionSelect.value = previousValue;
          if (!permissionSelect.value) permissionSelect.value = permissionMode;
        }
        break;

      case "agent_busy":
        isBusy = true;
        showThinking();
        updateBusyIndicator();
        updateButtons();
        break;

      case "agent_idle":
        isBusy = false;
        removeThinking();
        updateBusyIndicator();
        updateButtons();
        // Notify if window not focused
        if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
          var idleNote = new Notification("Chroxy: Claude is waiting", {
            body: "Claude is waiting for input.",
            tag: "chroxy-idle"
          });
          idleNote.onclick = function() { window.focus(); };
        }
        break;

      case "error":
      case "server_error":
        addMessage("error", msg.message || msg.details || "Unknown error");
        showToast(msg.message || msg.details || "Unknown error");
        break;

      case "session_error":
        addMessage("error", msg.message || "Session error");
        showToast(msg.message || "Session error");
        break;

      case "server_shutdown":
        reconnectText.textContent = msg.reason === "restart"
          ? "Server restarting..."
          : "Server shutting down...";
        reconnectBanner.classList.remove("hidden");
        // Reset backoff for server-initiated restarts
        if (msg.reason === "restart") reconnectAttempt = 0;
        break;

      case "token_rotated":
        if (msg.newToken) {
          token = msg.newToken;
          // Update URL bar so bookmarking works with new token
          var newUrl = new URL(window.location);
          newUrl.searchParams.set("token", token);
          window.history.replaceState(null, "", newUrl.toString());
        }
        break;

      case "plan_started":
        inPlanMode = true;
        planModeBanner.classList.remove("hidden");
        planApprovalCard.classList.add("hidden");
        break;

      case "plan_ready":
        inPlanMode = false;
        planModeBanner.classList.add("hidden");
        planApprovalCard.classList.remove("hidden");
        if (msg.plan) {
          planContentEl.innerHTML = renderMarkdown(msg.plan);
        }
        break;

      case "agent_spawned":
        if (msg.agentId) {
          backgroundAgents.set(msg.agentId, { task: msg.task || "", startedAt: Date.now() });
          updateAgentBadge();
        }
        break;

      case "agent_completed":
        if (msg.agentId) {
          backgroundAgents.delete(msg.agentId);
          updateAgentBadge();
        }
        break;

      default:
        if (serverProtocolVersion && serverProtocolVersion > CLIENT_PROTOCOL_VERSION) {
          console.warn("[ws] Unknown message type \"" + msg.type + "\" (server protocol v" + serverProtocolVersion + ", client v" + CLIENT_PROTOCOL_VERSION + ")");
        }
        break;
    }
  }

  // ---- Input handling ----
  sendBtn.addEventListener("click", function() {
    sendInput(inputEl.value);
  });

  interruptBtn.addEventListener("click", function() {
    sendInterrupt();
  });

  reconnectRetryBtn.addEventListener("click", function() {
    reconnectAttempt = 0;
    reconnectRetryBtn.classList.add("hidden");
    reconnectText.textContent = "Reconnecting...";
    connect();
  });

  inputEl.addEventListener("keydown", function(e) {
    // Ctrl+Enter or Cmd+Enter to send
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendInput(inputEl.value);
    }
  });

  document.addEventListener("keydown", function(e) {
    // Escape: close modal first, skip if renaming, otherwise interrupt
    if (e.key === "Escape") {
      if (modalOpen) {
        e.preventDefault();
        closeCreateSessionModal();
        return;
      }
      if (document.activeElement && document.activeElement.classList.contains("tab-rename-input")) {
        return;
      }
      e.preventDefault();
      sendInterrupt();
      return;
    }

    // Skip shortcuts when typing in inputs (except Escape handled above)
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Ctrl/Cmd+N: open new session modal
    if (e.key === "n" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openCreateSessionModal();
      return;
    }

    // Ctrl+backtick: toggle chat/terminal view
    if (e.key === "\\\`" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      switchView(currentView === "chat" ? "terminal" : "chat");
      return;
    }

    // Ctrl/Cmd+1-9: switch to session by index
    if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      var idx = parseInt(e.key, 10) - 1;
      if (idx < sessions.length) {
        send({ type: "switch_session", sessionId: sessions[idx].sessionId });
      }
      return;
    }
  });

  // ---- Plan approval handlers ----
  planApproveBtn.addEventListener("click", function() {
    sendInput("Looks good, proceed.");
    planApprovalCard.classList.add("hidden");
  });

  planFeedbackBtn.addEventListener("click", function() {
    planApprovalCard.classList.add("hidden");
    inputEl.value = "Feedback on plan: ";
    inputEl.focus();
  });

  // ---- Init ----
  updateButtons();
  updateBusyIndicator();

  // Defer notification permission request until first user interaction
  if ("Notification" in window && Notification.permission === "default") {
    var requestNotifOnce = function() {
      document.removeEventListener("click", requestNotifOnce);
      document.removeEventListener("keydown", requestNotifOnce);
      Notification.requestPermission().catch(function() {});
    };
    document.addEventListener("click", requestNotifOnce);
    document.addEventListener("keydown", requestNotifOnce);
  }

  // Flush pending saves before page unload
  window.addEventListener("beforeunload", saveMessages);

  // Restore last active session ID and messages
  var savedSessionId = localStorage.getItem(STORAGE_PREFIX + "active_session");
  if (savedSessionId) {
    activeSessionId = savedSessionId;
    restoreMessages(activeSessionId);
  }

  connect();
})();
`
}
