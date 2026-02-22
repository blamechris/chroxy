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
          <option value="plan">Plan</option>
          <option value="auto">Auto</option>
        </select>
      </div>
    </header>

    <div id="session-bar">
      <div id="session-tabs"></div>
      <button id="new-session-btn" title="New session">+</button>
    </div>

    <div id="reconnect-banner" class="hidden">
      Disconnected. Reconnecting...
    </div>

    <div id="chat-messages"></div>

    <div id="status-bar">
      <span id="status-model"></span>
      <span id="status-cost"></span>
      <span id="status-context"></span>
    </div>

    <div id="input-bar">
      <textarea id="message-input" placeholder="Send a message..." rows="1"></textarea>
      <button id="send-btn" title="Send (Ctrl+Enter)">Send</button>
      <button id="interrupt-btn" title="Interrupt (Escape)">Stop</button>
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
    }
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
  var statusCost = 0;
  var statusContext = "";
  var statusModel = "";

  // ---- DOM refs ----
  var messagesEl = document.getElementById("chat-messages");
  var inputEl = document.getElementById("message-input");
  var sendBtn = document.getElementById("send-btn");
  var interruptBtn = document.getElementById("interrupt-btn");
  var statusDot = document.getElementById("connection-status");
  var reconnectBanner = document.getElementById("reconnect-banner");
  var modelSelect = document.getElementById("model-select");
  var permissionSelect = document.getElementById("permission-select");
  var sessionTabs = document.getElementById("session-tabs");
  var newSessionBtn = document.getElementById("new-session-btn");
  var statusModelEl = document.getElementById("status-model");
  var statusCostEl = document.getElementById("status-cost");
  var statusContextEl = document.getElementById("status-context");

  // ---- Markdown renderer ----
  function renderMarkdown(text) {
    if (!text) return "";
    // Escape HTML first
    var html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Fenced code blocks
    html = html.replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, function(m, lang, code) {
      var cls = lang ? ' class="language-' + lang + '"' : "";
      return '<pre><code' + cls + '>' + code + '</code></pre>';
    });

    // Inline code (avoid matching inside pre blocks)
    html = html.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold and italic
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
    html = html.replace(/\\*(.+?)\\*/g, "<em>$1</em>");

    // Links
    html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\\/li>\\n?)+/g, function(m) {
      return "<ul>" + m + "</ul>";
    });

    // Ordered lists
    html = html.replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs (double newlines)
    html = html.replace(/\\n\\n/g, "</p><p>");
    // Single newlines to <br> (except inside pre)
    html = html.replace(/\\n/g, "<br>");

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

    if (opts.id) div.setAttribute("data-msg-id", opts.id);
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addToolBubble(tool, toolUseId, input) {
    var div = document.createElement("div");
    div.className = "tool-bubble";
    div.setAttribute("data-tool-id", toolUseId || "");
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
    return div;
  }

  function addPermissionPrompt(requestId, tool, description) {
    var div = document.createElement("div");
    div.className = "permission-prompt";
    div.setAttribute("data-request-id", requestId);
    div.innerHTML =
      '<div class="perm-desc"><span class="perm-tool">' + escapeHtml(tool) + '</span>: ' +
      escapeHtml(description || "Permission requested") + '</div>' +
      '<div class="perm-buttons">' +
      '<button class="btn-allow" data-decision="allow">Allow</button>' +
      '<button class="btn-deny" data-decision="deny">Deny</button>' +
      '</div>' +
      '<div class="perm-answer" style="display:none"></div>';
    div.querySelectorAll("button").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var decision = btn.getAttribute("data-decision");
        sendPermissionResponse(requestId, decision);
        div.classList.add("answered");
        div.querySelector(".perm-answer").textContent = decision === "allow" ? "Allowed" : "Denied";
        div.querySelector(".perm-answer").style.display = "block";
      });
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addQuestionPrompt(question, toolUseId) {
    var div = document.createElement("div");
    div.className = "question-prompt";
    div.setAttribute("data-tool-use-id", toolUseId || "");
    div.innerHTML =
      '<div class="q-text">' + escapeHtml(question) + '</div>' +
      '<div class="q-input-row">' +
      '<input type="text" placeholder="Type your answer...">' +
      '<button>Reply</button>' +
      '</div>';
    var qInput = div.querySelector("input");
    var qBtn = div.querySelector("button");
    function submitAnswer() {
      var answer = qInput.value.trim();
      if (!answer) return;
      sendQuestionResponse(answer, toolUseId);
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

  // ---- Session tabs ----
  function renderSessions() {
    sessionTabs.innerHTML = "";
    sessions.forEach(function(s) {
      var tab = document.createElement("div");
      tab.className = "session-tab" + (s.sessionId === activeSessionId ? " active" : "");
      tab.textContent = s.name || "Default";
      tab.addEventListener("click", function() {
        if (s.sessionId !== activeSessionId) {
          send({ type: "switch_session", sessionId: s.sessionId });
        }
      });
      sessionTabs.appendChild(tab);
    });
  }

  newSessionBtn.addEventListener("click", function() {
    var name = prompt("Session name:");
    if (name && name.trim()) {
      send({ type: "create_session", name: name.trim() });
    }
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
    var val = modelSelect.value;
    modelSelect.innerHTML = "";
    availableModels.forEach(function(m) {
      var opt = document.createElement("option");
      opt.value = m.id || m.fullId || m;
      opt.textContent = m.label || m.id || m;
      modelSelect.appendChild(opt);
    });
    if (activeModel) {
      // Try to select by matching label or id
      for (var i = 0; i < modelSelect.options.length; i++) {
        var optLabel = modelSelect.options[i].textContent.toLowerCase();
        var optVal = modelSelect.options[i].value.toLowerCase();
        if (optLabel === activeModel.toLowerCase() || optVal === activeModel.toLowerCase()) {
          modelSelect.selectedIndex = i;
          break;
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

  // ---- Connection status ----
  function setConnectionState(state) {
    statusDot.className = "status-dot " + state;
    connected = state === "connected";
    if (state === "connected") {
      reconnectBanner.classList.add("hidden");
    } else if (state === "disconnected" || state === "connecting") {
      if (!reconnectBanner.classList.contains("hidden") || state === "disconnected") {
        // Show banner only after initial connect
      }
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
      updateButtons();
      // Show reconnect banner if we were previously connected
      reconnectBanner.classList.remove("hidden");
      // Auto-reconnect
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function() {
        connect();
      }, 2000);
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
    send({ type: "input", data: text.trim() });
    addMessage("user", text.trim());
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
          // Could display mode indicator
        }
        break;

      case "server_mode":
        // Display info
        break;

      case "status":
        if (msg.connected) {
          setConnectionState("connected");
        }
        break;

      case "session_list":
        if (Array.isArray(msg.sessions)) {
          sessions = msg.sessions;
          renderSessions();
        }
        break;

      case "session_switched":
        activeSessionId = msg.sessionId;
        messagesEl.innerHTML = "";
        renderSessions();
        break;

      case "claude_ready":
        claudeReady = true;
        isBusy = false;
        removeThinking();
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
        streamDiv.setAttribute("data-msg-id", streamingMsgId);
        streamDiv.innerHTML = "";
        messagesEl.appendChild(streamDiv);
        removeThinking();
        isBusy = true;
        updateButtons();
        scrollToBottom();
        break;
      }

      case "stream_delta": {
        if (!msg.delta) break;
        var target = null;
        if (msg.messageId) {
          target = messagesEl.querySelector('[data-msg-id="' + msg.messageId + '"]');
        }
        if (!target && streamingMsgId) {
          target = messagesEl.querySelector('[data-msg-id="' + streamingMsgId + '"]');
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

      case "stream_end":
        streamingMsgId = null;
        break;

      case "tool_start":
        addToolBubble(msg.tool || "tool", msg.toolUseId || msg.messageId || "", msg.input || null);
        break;

      case "tool_result": {
        var toolId = msg.toolUseId || "";
        var toolEl = messagesEl.querySelector('[data-tool-id="' + toolId + '"]');
        if (toolEl) {
          var resultDiv = toolEl.querySelector(".tool-result");
          if (resultDiv) {
            resultDiv.textContent = msg.result || "";
            if (msg.truncated) {
              resultDiv.textContent += "\\n[truncated]";
            }
          }
        }
        break;
      }

      case "permission_request":
        addPermissionPrompt(msg.requestId, msg.tool || "Unknown", msg.description || "");
        break;

      case "user_question": {
        if (Array.isArray(msg.questions) && msg.questions.length > 0) {
          var q = msg.questions[0];
          addQuestionPrompt(q.question || "Question from Claude", msg.toolUseId || "");
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

      case "available_permission_modes":
        // Could update permission select options dynamically
        break;

      case "status_update":
        if (msg.cost !== undefined) statusCost = msg.cost;
        if (msg.model) statusModel = msg.model;
        if (msg.contextPercent !== undefined) {
          statusContext = msg.contextPercent + "% context";
        }
        updateStatusBar();
        break;

      case "agent_busy":
        isBusy = true;
        showThinking();
        updateButtons();
        break;

      case "agent_idle":
        isBusy = false;
        removeThinking();
        updateButtons();
        break;

      case "error":
      case "server_error":
        addMessage("error", msg.message || msg.details || "Unknown error");
        break;

      case "session_error":
        addMessage("error", msg.message || "Session error");
        break;

      default:
        // Ignore unhandled message types
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

  inputEl.addEventListener("keydown", function(e) {
    // Ctrl+Enter or Cmd+Enter to send
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendInput(inputEl.value);
    }
  });

  document.addEventListener("keydown", function(e) {
    // Escape to interrupt
    if (e.key === "Escape") {
      sendInterrupt();
    }
  });

  // ---- Init ----
  updateButtons();
  connect();
})();
`
}
