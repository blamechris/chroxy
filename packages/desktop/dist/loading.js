(function() {
  var loading = document.getElementById('loading');
  var status = document.getElementById('status');
  var spinner = document.getElementById('spinner');
  var wizard = document.getElementById('wizard');

  var invoke = (window.__TAURI__ && window.__TAURI__.core)
    ? window.__TAURI__.core.invoke
    : null;

  // -- Splash failure surfacing (issue #5492) --
  // The splash used to spin on "Starting server..." forever when the spawned
  // server child died before health succeeded (e.g. EADDRINUSE because
  // another chroxy owns the port). Two safety nets:
  //   1. `server_error` (now also emitted on child exit, Rust side) switches
  //      to an error state with the buffered server log and a Retry button.
  //   2. A 30s splash-side timeout: if neither ready nor error has fired,
  //      reframe as "still starting" and show the log view — without
  //      touching the (still alive) child.
  var STARTUP_TIMEOUT_MS = 30000;
  var LOG_REFRESH_MS = 5000;
  var startupTimer = null;
  var logRefreshTimer = null;

  function stopLogRefresh() {
    if (logRefreshTimer) { clearInterval(logRefreshTimer); logRefreshTimer = null; }
  }

  function clearStartupTimers() {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    stopLogRefresh();
  }

  function armStartupTimeout() {
    clearStartupTimers();
    startupTimer = setTimeout(function() {
      startupTimer = null;
      // The child is still alive as far as we know — don't kill anything,
      // just stop spinning silently: reframe the text and show the buffered
      // server log so the user can see what's slow. Keep refreshing it.
      status.textContent = 'Still starting... (taking longer than usual)';
      status.className = 'status';
      renderStartupLogs(true);
      logRefreshTimer = setInterval(renderStartupLogs, LOG_REFRESH_MS);
    }, STARTUP_TIMEOUT_MS);
  }

  function removeStartupLogs() {
    var panel = document.getElementById('startup-logs');
    if (panel) panel.parentNode.removeChild(panel);
  }

  function hideRetryButton() {
    var btn = document.getElementById('retry-btn');
    if (btn) btn.parentNode.removeChild(btn);
  }

  function showRetryButton() {
    if (!invoke || document.getElementById('retry-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'retry-btn';
    btn.textContent = 'Retry';
    btn.className = 'btn btn-primary';
    btn.style.cssText = 'margin-top:1rem;';
    btn.addEventListener('click', function() {
      hideRetryButton();
      removeStartupLogs();
      spinner.style.display = '';
      status.textContent = 'Starting server...';
      status.className = 'status';
      armStartupTimeout();
      invoke('start_server');
    });
    // Directly under the status line, above any logs panel.
    status.parentNode.insertBefore(btn, status.nextSibling);
  }

  // -- Event listeners for loading view --
  function listenForEvents() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;

    window.__TAURI__.event.listen('server_ready', function(event) {
      clearStartupTimers();
      hideRetryButton();
      removeStartupLogs();
      status.textContent = 'Connected!';
      status.className = 'status';
      window.location.href = event.payload.url;
    });

    window.__TAURI__.event.listen('server_error', function(event) {
      clearStartupTimers();
      spinner.style.display = 'none';
      status.textContent = event.payload.message || 'Server error';
      status.className = 'status error';
      showRetryButton();
      renderStartupLogs(true);
    });

    window.__TAURI__.event.listen('server_restarting', function(event) {
      var p = event.payload;
      hideRetryButton();
      status.textContent = 'Restarting... (attempt ' + p.attempt + '/' + p.max_attempts + ')';
      status.className = 'status';
      spinner.style.display = '';
      armStartupTimeout();
    });

    window.__TAURI__.event.listen('server_stopped', function() {
      clearStartupTimers();
      spinner.style.display = 'none';
      status.textContent = 'Server stopped';
      status.className = 'status';
    });
  }

  listenForEvents();

  // -- Check if first run --
  if (!invoke) return;

  // -- Startup log inspection (issue #2835 sub-fix C) --
  // When a startup error fires, fetch the last ~30 server log lines and
  // render them in a collapsible details panel with a copy button so the
  // user (or a bug reporter) can see WHY the server failed to start.
  //
  // On repeated `server_error` events (issue #2848), we refresh the panel
  // rather than no-op: the buffer usually grew between fires (new health-
  // poll attempts, more stderr, updated timestamps), and the user needs
  // to see the latest picture. We preserve the `open` state of the
  // <details> element across refreshes so the user's interaction isn't
  // clobbered when they've already expanded the panel.
  //
  // `forceOpen` (#5492): error and still-starting states pass true so the
  // log lines are visible immediately instead of collapsed behind the
  // summary; periodic refreshes omit it and inherit the user's state.
  function renderStartupLogs(forceOpen) {
    if (!invoke) return;
    invoke('get_startup_logs', { limit: 30 }).then(function(lines) {
      if (!lines || lines.length === 0) return;

      var container = document.getElementById('loading');
      if (!container) return;

      // If a panel was rendered by a previous `server_error`, remember
      // whether the user had expanded it, then drop the stale DOM node
      // before rebuilding. This re-triggers the animation and shows a
      // refreshed line count / log snapshot.
      var prev = document.getElementById('startup-logs');
      var wasOpen = false;
      if (prev) {
        wasOpen = prev.hasAttribute('open');
        prev.parentNode.removeChild(prev);
      }

      var details = document.createElement('details');
      details.id = 'startup-logs';
      details.style.cssText = 'margin-top:1.25rem;text-align:left;font-size:0.75rem;';
      if (wasOpen || forceOpen === true) details.setAttribute('open', '');

      var summary = document.createElement('summary');
      summary.textContent = 'Show server logs (' + lines.length + ' lines)';
      summary.style.cssText = 'cursor:pointer;color:#888;user-select:none;margin-bottom:0.5rem;';
      details.appendChild(summary);

      var pre = document.createElement('pre');
      pre.style.cssText = 'background:#1a1a2e;border-radius:8px;padding:0.75rem;color:#c0c0c0;overflow:auto;max-height:220px;white-space:pre-wrap;word-break:break-word;font-family:SF Mono,Monaco,monospace;font-size:0.7rem;line-height:1.35;';
      pre.textContent = lines.join('\n');
      details.appendChild(pre);

      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy logs';
      copyBtn.className = 'btn btn-secondary';
      copyBtn.style.cssText = 'margin-top:0.5rem;padding:0.35rem 0.75rem;font-size:0.75rem;';
      copyBtn.addEventListener('click', function() {
        var text = lines.join('\n');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function() {
            copyBtn.textContent = 'Copied!';
            setTimeout(function() { copyBtn.textContent = 'Copy logs'; }, 2000);
          }).catch(function() {
            copyBtn.textContent = 'Copy failed';
          });
        }
      });
      details.appendChild(copyBtn);

      container.appendChild(details);
    }).catch(function() {
      // Command unavailable — silently skip.
    });
  }

  invoke('get_setup_state').then(function(state) {
    if (state.isFirstRun) {
      loading.style.display = 'none';
      wizard.classList.add('active');
      runDependencyCheck();
    } else {
      // Not first run: a start is normally in flight when this page shows.
      // Arm the splash timeout so we never spin silently forever (#5492) —
      // server_ready / server_error / server_stopped all cancel it.
      armStartupTimeout();
    }
  });

  // -- Wizard state --
  var tunnelMode = 'quick';
  var dots = [document.getElementById('dot-1'), document.getElementById('dot-2'), document.getElementById('dot-3')];

  function showStep(n) {
    for (var i = 1; i <= 3; i++) {
      var el = document.getElementById('step-' + i);
      el.style.display = i === n ? '' : 'none';
      dots[i-1].className = 'step-dot' + (i < n ? ' done' : (i === n ? ' active' : ''));
    }
  }

  // -- Step 1: Dependency check --
  function runDependencyCheck() {
    var list = document.getElementById('dep-list');
    list.innerHTML = '<li class="dep-item"><div class="dep-icon">...</div><div class="dep-info"><div class="dep-name">Checking dependencies...</div></div></li>';

    invoke('check_dependencies').then(function(deps) {
      list.innerHTML = '';

      // Node 22
      var nodeItem = document.createElement('li');
      nodeItem.className = 'dep-item';
      nodeItem.innerHTML = '<div class="dep-icon">' + (deps.node22.found ? checkIcon() : crossIcon()) + '</div>'
        + '<div class="dep-info"><div class="dep-name">Node.js 22</div>'
        + '<div class="dep-detail">' + (deps.node22.found
            ? (deps.node22.version || '') + ' at ' + (deps.node22.path || '')
            : 'Not found. Install: brew install node@22') + '</div></div>';
      list.appendChild(nodeItem);

      // cloudflared
      var cfItem = document.createElement('li');
      cfItem.className = 'dep-item';
      cfItem.innerHTML = '<div class="dep-icon">' + (deps.cloudflared.found ? checkIcon() : warnIcon()) + '</div>'
        + '<div class="dep-info"><div class="dep-name">cloudflared</div>'
        + '<div class="dep-detail">' + (deps.cloudflared.found
            ? 'Found on PATH'
            : 'Not found. Install: brew install cloudflared') + '</div>'
        + '<div class="dep-optional">Optional — required for remote access</div></div>';
      list.appendChild(cfItem);

      // Claude CLI
      var clItem = document.createElement('li');
      clItem.className = 'dep-item';
      clItem.innerHTML = '<div class="dep-icon">' + (deps.claude.found ? checkIcon() : crossIcon()) + '</div>'
        + '<div class="dep-info"><div class="dep-name">Claude CLI</div>'
        + '<div class="dep-detail">' + (deps.claude.found
            ? (deps.claude.version || 'Found on PATH')
            : 'Not found. Install from claude.ai') + '</div></div>';
      list.appendChild(clItem);

      // Enable Next if Node is found (minimum requirement)
      var btn = document.getElementById('btn-step1-next');
      btn.disabled = !deps.node22.found;

      // Auto-select local-only if cloudflared missing
      if (!deps.cloudflared.found) {
        tunnelMode = 'none';
        selectTunnel('none');
      }
    });
  }

  function checkIcon() { return '<span style="color:#34d399">&#10003;</span>'; }
  function crossIcon() { return '<span style="color:#f87171">&#10007;</span>'; }
  function warnIcon() { return '<span style="color:#fbbf24">!</span>'; }

  // -- Step 2: Configuration --
  function selectTunnel(value) {
    tunnelMode = value;
    var options = document.querySelectorAll('#tunnel-group .radio-option');
    for (var i = 0; i < options.length; i++) {
      options[i].className = 'radio-option' + (options[i].getAttribute('data-value') === value ? ' selected' : '');
    }
  }

  var tunnelOptions = document.querySelectorAll('#tunnel-group .radio-option');
  for (var i = 0; i < tunnelOptions.length; i++) {
    tunnelOptions[i].addEventListener('click', function() {
      selectTunnel(this.getAttribute('data-value'));
    });
  }

  // -- Step 3: Ready --
  function loadToken() {
    invoke('get_server_info').then(function(info) {
      document.getElementById('token-display').textContent = info.token || '(none)';
    });
  }

  // -- Navigation --
  document.getElementById('btn-step1-next').addEventListener('click', function() { showStep(2); });
  document.getElementById('btn-step2-back').addEventListener('click', function() { showStep(1); });
  document.getElementById('btn-step2-next').addEventListener('click', function() {
    loadToken();
    showStep(3);
  });
  document.getElementById('btn-step3-back').addEventListener('click', function() { showStep(2); });

  document.getElementById('btn-step3-start').addEventListener('click', function() {
    var port = parseInt(document.getElementById('cfg-port').value, 10) || 8765;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Starting...';

    invoke('save_setup_config', { port: port, tunnelMode: tunnelMode }).then(function() {
      // Switch to loading view
      wizard.classList.remove('active');
      loading.style.display = '';
      spinner.style.display = '';
      status.textContent = 'Starting server...';
      status.className = 'status';

      armStartupTimeout();
      invoke('start_server');
    });
  });
})();
