(function() {
  var loading = document.getElementById('loading');
  var status = document.getElementById('status');
  var spinner = document.getElementById('spinner');
  var wizard = document.getElementById('wizard');

  // -- Event listeners for loading view --
  function listenForEvents() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;

    window.__TAURI__.event.listen('server_ready', function(event) {
      status.textContent = 'Connected!';
      status.className = 'status';
      window.location.href = event.payload.url;
    });

    window.__TAURI__.event.listen('server_error', function(event) {
      spinner.style.display = 'none';
      status.textContent = event.payload.message || 'Server error';
      status.className = 'status error';
    });

    window.__TAURI__.event.listen('server_restarting', function(event) {
      var p = event.payload;
      status.textContent = 'Restarting... (attempt ' + p.attempt + '/' + p.max_attempts + ')';
      status.className = 'status';
      spinner.style.display = '';
    });

    window.__TAURI__.event.listen('server_stopped', function() {
      spinner.style.display = 'none';
      status.textContent = 'Server stopped';
      status.className = 'status';
    });
  }

  listenForEvents();

  // -- Check if first run --
  if (!window.__TAURI__ || !window.__TAURI__.core) return;
  var invoke = window.__TAURI__.core.invoke;

  invoke('get_setup_state').then(function(state) {
    if (state.isFirstRun) {
      loading.style.display = 'none';
      wizard.classList.add('active');
      runDependencyCheck();
    }
    // If not first run and server is already running, the event listeners handle navigation
  });

  // -- Wizard state --
  var tunnelMode = 'quick';
  var depResults = null;
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
      depResults = deps;
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

      invoke('start_server');
    });
  });
})();
