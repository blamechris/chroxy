// App Settings (#9079): the app's own settings on the bundled page, usable with
// no daemon running. Each control applies as soon as it changes, through a native
// command, and shows its own error inline. The same settings are edited from the
// tray and the dashboard, so the view re-reads them when it opens, when the
// window regains focus and on `app_settings_changed`.
(function() {
  var invoke = (window.__TAURI__ && window.__TAURI__.core)
    ? window.__TAURI__.core.invoke
    : null;

  var view = document.getElementById('app-settings');
  var gear = document.getElementById('settings-btn');
  if (!view) return;

  var loading = document.getElementById('loading');
  var wizard = document.getElementById('wizard');

  function $(id) { return document.getElementById(id); }
  var els = {
    autoStart: $('as-auto-start'),
    login: $('as-login'),
    port: $('as-port'),
    lan: $('as-lan'),
    tunnelHint: $('as-tunnel-hint'),
    dashboard: $('as-dashboard'),
    dashboardNote: $('as-dashboard-note')
  };
  var radios = view.querySelectorAll('input[name="as-tunnel"]');

  var isOpen = false;
  // What the page showed before the view opened, restored on close.
  var restore = null;
  var refreshSeq = 0;
  var state = null;       // the last snapshot from the app
  var lastPort = null;    // the port as last stored

  function setError(id, message) {
    var el = $(id);
    if (el) el.textContent = message || '';
  }

  function errorText(err) {
    return String(err && err.message ? err.message : (err || 'Something went wrong'));
  }

  // -- Open / close --

  function open(section) {
    if (!invoke) return;
    if (!isOpen) {
      restore = {
        loading: loading ? loading.style.display : '',
        wizard: wizard ? wizard.classList.contains('active') : false
      };
      if (loading) loading.style.display = 'none';
      if (wizard) wizard.classList.remove('active');
      view.classList.add('active');
      document.body.classList.add('settings-open');
      isOpen = true;
    }
    refresh().then(function() {
      if (section === 'tunnel') focusTunnel();
    });
    if (section === 'tunnel') focusTunnel();
  }

  function focusTunnel() {
    var section = $('as-tunnel-section');
    if (section && section.scrollIntoView) section.scrollIntoView({ block: 'nearest' });
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { radios[i].focus(); return; }
    }
    if (radios.length) radios[0].focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    view.classList.remove('active');
    document.body.classList.remove('settings-open');
    if (restore) {
      if (loading) loading.style.display = restore.loading;
      if (wizard && restore.wizard) wizard.classList.add('active');
    }
    restore = null;
  }

  // -- Reading state --

  function refresh() {
    if (!invoke || !isOpen) return Promise.resolve();
    var seq = ++refreshSeq;
    return invoke('get_app_settings').then(function(snapshot) {
      if (seq !== refreshSeq || !isOpen) return;
      state = snapshot;
      setError('as-error', '');
      render(snapshot);
    }).catch(function(err) {
      if (seq !== refreshSeq) return;
      setError('as-error', 'Could not read the settings: ' + errorText(err));
    });
  }

  function render(s) {
    els.autoStart.checked = !!s.autoStartServer;
    els.login.checked = !!s.startAtLogin;
    els.lan.checked = !!s.exposeOnLan;
    lastPort = s.port;
    // Do not overwrite a port the user is typing.
    if (document.activeElement !== els.port) els.port.value = String(s.port);
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = radios[i].value === s.tunnelMode;
    }
    els.tunnelHint.textContent = s.cloudflaredFound
      ? 'Takes effect the next time the server starts.'
      : 'cloudflared was not found: Quick and Named need it. Takes effect the next time the server starts.';
    els.dashboard.disabled = !s.daemonAvailable;
    els.dashboardNote.textContent = s.daemonAvailable
      ? ''
      : 'Dashboard settings need a running server. Start the server or connect to a running one.';
  }

  // -- Writing settings --

  // Run `cmd` for a control; on failure put the control back and say why.
  function apply(cmd, args, errorId, revert) {
    setError(errorId, '');
    return invoke(cmd, args).then(function() {
      setError(errorId, '');
    }).catch(function(err) {
      setError(errorId, errorText(err));
      if (revert) revert();
      refresh();
    });
  }

  els.autoStart.addEventListener('change', function() {
    var box = els.autoStart;
    apply('set_auto_start_server', { enabled: box.checked }, 'as-auto-start-error', function() { box.checked = !box.checked; });
  });

  els.login.addEventListener('change', function() {
    var box = els.login;
    apply('set_start_at_login', { enabled: box.checked }, 'as-login-error', function() { box.checked = !box.checked; });
  });

  els.lan.addEventListener('change', function() {
    var box = els.lan;
    apply('set_expose_on_lan', { expose: box.checked }, 'as-lan-error', function() { box.checked = !box.checked; });
  });

  for (var r = 0; r < radios.length; r++) {
    radios[r].addEventListener('change', function() {
      var mode = this.value;
      var previous = state ? state.tunnelMode : null;
      apply('set_tunnel_mode', { mode: mode }, 'as-tunnel-error', function() {
        for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === previous;
      });
    });
  }

  // Port: 1024-65535, applied on change or Enter.
  function commitPort() {
    var raw = els.port.value.trim();
    var n = Number(raw);
    if (raw === '' || !isFinite(n) || Math.floor(n) !== n || n < 1024 || n > 65535) {
      setError('as-port-error', 'Enter a port between 1024 and 65535.');
      return;
    }
    if (n === lastPort) { setError('as-port-error', ''); return; }
    apply('set_app_port', { port: n }, 'as-port-error', function() {
      els.port.value = String(lastPort);
    }).then(function() {
      if (!$('as-port-error').textContent) lastPort = n;
    });
  }
  els.port.addEventListener('change', commitPort);
  els.port.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitPort(); }
  });

  // -- Actions --

  $('as-close').addEventListener('click', close);

  // Start and Connect report on the loading page's status line, so close first.
  $('as-start').addEventListener('click', function() {
    close();
    if (window.chroxyLoading) window.chroxyLoading.startServer();
  });
  $('as-connect').addEventListener('click', function() {
    close();
    if (window.chroxyLoading) window.chroxyLoading.connect();
  });

  els.dashboard.addEventListener('click', function() {
    setError('as-dashboard-error', '');
    invoke('open_settings').then(function(opened) {
      if (opened === false) {
        // The refusal reason is also on the page's status line.
        var st = document.getElementById('status');
        var why = st && st.className.indexOf('error') !== -1 ? ' ' + st.textContent : '';
        setError('as-dashboard-error', 'Could not open the dashboard settings.' + why);
        refresh();
      }
    }).catch(function(err) {
      setError('as-dashboard-error', errorText(err));
    });
  });

  // -- Entry points --

  if (gear && invoke) {
    gear.addEventListener('click', function() { open(); });
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOpen) close();
  });

  window.addEventListener('focus', function() { refresh(); });

  // The menu bar's Preferences..., Tunnel > Settings... and Connect to Server...
  // reach this page as `app_page_action` events for the main webview only.
  if (window.__TAURI__ && window.__TAURI__.event) {
    var target = { target: 'main' };
    window.__TAURI__.event.listen('app_settings_changed', function() { refresh(); }, target);
    window.__TAURI__.event.listen('app_page_action', function(event) {
      var p = event.payload || {};
      if (p.action === 'open-settings') {
        open(p.section || undefined);
      } else if (p.action === 'connect') {
        close();
        if (window.chroxyLoading) {
          window.chroxyLoading.showLoadingView();
          window.chroxyLoading.connect();
        }
      }
    }, target);
  }

  window.chroxyAppSettings = { open: open, close: close, refresh: refresh };
})();
