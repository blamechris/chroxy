//! Pins which `StartOrigin` each start call site passes (#8393).
//!
//! `StartOrigin` is a required argument of `ServerManager::start`, `restart` and
//! `try_auto_restart`, so a call site that forgets it does not compile. What the
//! compiler cannot check is that a site passes the RIGHT one:
//!
//! - every path a user can click (tray, app menu Shell submenu, the loading page
//!   and the dashboard through the `start_server` / `restart_server` commands)
//!   must start as `User`, which never stops a port holder;
//! - the launch-time auto-start and the crash auto-restart are the only `Launch`
//!   starts, and `Launch` itself stops nothing it cannot prove it started (#8388).
//!
//! The sites live in Tauri glue that a unit test cannot run, so this scrapes the
//! source, deliberately lo-fi in the style of `command_drift.rs`. Every assertion
//! collapses to a boolean before it is made: a failing `assert!(x.contains(..))`
//! on a multi-KB source slice would otherwise carry the whole slice as its error.

use std::fs;
use std::path::PathBuf;

fn read(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

/// Collapse all whitespace runs so formatting changes do not move a match.
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The body of the top-level `fn <name>(`: from its header to the first `}` in
/// column 0. Panics if the function is gone, so a rename cannot silently turn a
/// pin into a no-op.
fn fn_body(src: &str, name: &str) -> String {
    let header = format!("\nfn {}(", name);
    let start = src
        .find(&header)
        .unwrap_or_else(|| panic!("top-level fn {} not found in lib.rs", name));
    let rest = &src[start + 1..];
    let end = rest.find("\n}\n").unwrap_or_else(|| panic!("fn {} has no closing brace", name));
    squash(&rest[..end])
}

/// `src` starts at a call's name; returns it through its matching `)`.
fn balanced_call(src: &str) -> String {
    let mut depth = 0usize;
    for (i, c) in src.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return src[..=i].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unclosed call");
}

#[test]
fn every_user_entry_point_starts_as_user() {
    let lib = read("src/lib.rs");

    let checked = fn_body(&lib, "handle_start_checked");
    assert!(checked.contains("handle_start(&app, StartOrigin::User)"), "handle_start_checked must start as User");
    assert!(!checked.contains("StartOrigin::Launch"), "handle_start_checked must never start as Launch");

    let restart = fn_body(&lib, "restart_own_server");
    assert!(restart.contains("mgr.restart(StartOrigin::User)"), "restart_own_server must restart as User");
    assert!(!restart.contains("StartOrigin::Launch"), "restart_own_server must never restart as Launch");
}

#[test]
fn every_clickable_surface_goes_through_the_user_start_and_restart() {
    let lib = squash(&read("src/lib.rs"));
    for (what, needle) in [
        ("start_server command (loading page, dashboard)", "fn start_server(app: tauri::AppHandle) { handle_start_checked(&app); }"),
        ("restart_server command (loading page, dashboard)", "fn restart_server(app: tauri::AppHandle) { handle_restart(&app); }"),
        ("tray Start", "\"start\" => handle_start_checked(app),"),
        ("tray Restart", "\"restart\" => handle_restart(app),"),
        ("Shell menu Start", "\"shell-start\" => { handle_start_checked(app); return; }"),
        ("Shell menu Restart", "\"shell-restart\" => { handle_restart(app); return; }"),
    ] {
        assert!(lib.contains(needle), "{} must call the user-origin handler", what);
    }
}

#[test]
fn every_handle_start_call_names_its_origin_and_only_launch_and_the_user_path_exist() {
    let lib = read("src/lib.rs");
    let mut origins = Vec::new();
    for (i, _) in lib.match_indices("handle_start(") {
        if lib[..i].ends_with("fn ") {
            continue;
        }
        origins.push(squash(&balanced_call(&lib[i..])));
    }
    let named: Vec<&String> = origins.iter().filter(|a| a.contains("StartOrigin::")).collect();
    assert!(named.len() == origins.len(), "a handle_start call does not name its origin: {:?}", origins);
    assert!(
        origins.iter().any(|a| a == "handle_start(app.handle(), StartOrigin::Launch)"),
        "the launch-time auto-start must start as Launch"
    );
    assert!(
        origins.iter().any(|a| a == "handle_start(&app, StartOrigin::User)"),
        "the guarded user start must start as User"
    );
    assert!(origins.len() == 2, "an unexpected handle_start call site appeared: {:?}", origins);
}

#[test]
fn the_launch_time_auto_start_is_a_launch_start() {
    let lib = squash(&read("src/lib.rs"));
    assert!(
        lib.contains("StartupAction::StartOwn => handle_start(app.handle(), StartOrigin::Launch),"),
        "auto-start on launch must start as Launch"
    );
}

#[test]
fn the_crash_auto_restart_passes_launch_explicitly() {
    let lib = read("src/lib.rs");
    let body = fn_body(&lib, "handle_start");
    assert!(
        body.contains("mgr.try_auto_restart(StartOrigin::Launch)"),
        "the crash auto-restart must pass Launch at the call site, not inherit an origin"
    );
    assert!(!body.contains("StartOrigin::User"), "the supervisor loop must never restart as User");
}

#[test]
fn the_origin_is_not_remembered_on_the_manager() {
    let server = read("src/server.rs");
    assert!(!server.contains("fn set_origin"), "a setter would bring the sticky origin back");
    let decl = server.find("pub struct ServerManager {").expect("ServerManager");
    let body = &server[decl..decl + server[decl..].find("\n}\n").unwrap()];
    assert!(!body.contains("origin:"), "ServerManager must not carry an origin field");

    let lib = read("src/lib.rs");
    assert!(!lib.contains("set_origin"), "lib.rs must not set a remembered origin");
}

#[test]
fn user_start_and_restart_and_the_crash_restart_share_one_gate() {
    let lib = read("src/lib.rs");
    for name in ["handle_start_checked", "handle_restart"] {
        let body = fn_body(&lib, name);
        assert!(
            body.contains("run_exclusive( &START_RESTART_GATE,"),
            "{} must run under START_RESTART_GATE so a second Start/Restart cannot kill the first's child",
            name
        );
    }
    let supervisor = fn_body(&lib, "handle_start");
    assert!(
        supervisor.contains("START_RESTART_GATE.try_acquire()"),
        "the crash auto-restart must take the same gate"
    );
}

#[test]
fn the_check_updates_item_is_never_set_with_the_menu_items_lock_held() {
    let lib = read("src/lib.rs");
    let setter = fn_body(&lib, "set_check_updates_enabled");
    assert!(setter.contains("pick_then_act("), "set_check_updates_enabled must release the lock before the setter");
    assert!(!setter.contains("lock_or_recover"), "set_check_updates_enabled must not hold the lock itself");

    let check = fn_body(&lib, "handle_check_updates");
    assert!(
        check.contains("set_check_updates_enabled(&self.1, true)") && check.contains("set_check_updates_enabled(app, false)"),
        "both the disable and the ResetGuard re-enable go through the lock-releasing setter"
    );
    assert!(!check.contains("check_updates.set_enabled"), "a direct setter call in handle_check_updates could run under the lock");
}

/// Position of the first `needle` in `hay`, panicking if it is absent so a rename
/// cannot turn an ordering pin into a no-op.
fn pos(hay: &str, needle: &str) -> usize {
    hay.find(needle).unwrap_or_else(|| panic!("`{}` not found", needle))
}

#[test]
fn every_adopt_route_classifies_the_holder_through_a_challenge() {
    // `probe_port_with_token` is the one place a holder becomes an adoptable
    // daemon: it sends a fresh challenge and checks the proof. A route with its own
    // `/health` request would adopt without that check.
    let lib = read("src/lib.rs");
    let client_mode = fn_body(&lib, "probe_external_health");
    assert!(client_mode.contains("tray_state::probe_port_with_token("), "the client-mode adopt must challenge the daemon");
    assert!(!client_mode.contains("ureq"), "the client-mode adopt must not make its own request");

    let server = squash(&read("src/server.rs"));
    assert!(
        server.contains("fn probe(&self, port: u16) -> PortState { tray_state::probe_port("),
        "the automatic start must probe the holder with probe_port"
    );
    assert!(
        server.contains("tray_state::probe_port_with_token(port, Duration::from_secs(2), token.as_deref())"),
        "the spawned server's readiness must challenge the responder"
    );

    let tray = squash(&read("src/tray_state.rs"));
    assert!(
        tray.contains("pub fn probe_port(port: u16, timeout: Duration) -> PortState { probe_port_with_token(port, timeout, crate::config::proof_token().as_deref()) }"),
        "probe_port must challenge with the configured token"
    );
    assert!(
        tray.contains("(Some(t), Some(n)) => health_proof::body_proves_daemon(body, t, port, n)"),
        "a chroxy-shaped body must be accepted only on a verified proof"
    );
}

#[test]
fn the_readiness_poll_never_treats_a_bare_200_as_running() {
    let server = read("src/server.rs");
    let start = pos(&server, "fn start_health_poll(");
    let end = start + server[start..].find("fn resolve_cli_js").expect("end of the poll");
    let poll = squash(&server[start..end]);
    assert!(!poll.contains("ureq::get"), "the readiness poll must not make its own request");
    assert!(!poll.contains("resp.status() == 200"), "a bare 200 must not set Running");
    // Every `Running` assignment in the poll sits in a `PortState::Chroxy` arm.
    let assignments = poll.matches("*s = ServerStatus::Running").count();
    let proven_arms = poll.matches("PortState::Chroxy(_) => {").count();
    assert!(assignments >= 1 && assignments == proven_arms, "each Running assignment must follow a proven probe");
}

#[test]
fn the_dashboard_navigation_is_preceded_by_a_fresh_challenge_on_both_paths() {
    let window = squash(&read("src/window.rs"));
    let start = pos(&window, "pub fn emit_server_ready(");
    let body = &window[start..pos(&window, "/// Emit `server_stopped`")];
    let first = pos(body, "daemon_proves_itself(");
    let event = pos(body, "app.emit(\"server_ready\"");
    assert!(first < event, "the server_ready event (token and URL) must follow a challenge");
    let second = first + 1 + body[first + 1..].find("daemon_proves_itself(").expect("a second challenge in the delayed task");
    let navigate = pos(body, "window.location.href");
    assert!(event < second && second < navigate, "the delayed navigation must be preceded by its own challenge");
    assert!(body.contains("return false;"), "a refused handoff must not report success");
    // A refusal drops the cached claim that the port holds a chroxy daemon.
    let refuse = &window[pos(&window, "fn refuse_handoff(")..start];
    assert!(
        refuse.contains("update_port_state(app, crate::tray_state::PortState::Foreign(port))"),
        "a refused handoff must update the tray state to foreign"
    );
}

#[test]
fn the_connect_request_is_preceded_by_a_challenge() {
    let qr = squash(&read("src/qrcode.rs"));
    let start = pos(&qr, "pub fn fetch_daemon_connection_info(");
    let body = &qr[start..pos(&qr, "fn request_connection_info(")];
    assert!(body.contains("daemon_proves_itself(port, Some(token)"), "fetch must challenge with the token it would send");
    assert!(pos(body, "daemon_proves_itself(") < pos(body, "request_connection_info("), "challenge before the request");
    // The only caller of the request is the verifying fetch: the definition and
    // that one call are the only two mentions outside the tests.
    let code = &qr[..pos(&qr, "#[cfg(test)]")];
    assert_eq!(
        code.matches("request_connection_info(").count(),
        2,
        "request_connection_info must be reached only through fetch_daemon_connection_info"
    );
}

#[test]
fn every_dashboard_and_qr_handoff_goes_through_the_verifying_functions() {
    let lib = read("src/lib.rs");
    // Open Dashboard hands over through emit_server_ready, which challenges.
    let dash = fn_body(&lib, "handle_dashboard");
    assert!(dash.contains("window::emit_server_ready("), "Open Dashboard must navigate through emit_server_ready");
    assert!(!dash.contains("dashboard_url("), "Open Dashboard must not build its own URL");
    // The external Show QR path asks through the verifying fetch.
    let qr = fn_body(&lib, "qr_for_reachable_daemon");
    assert!(qr.contains("qrcode::get_external_connection_info("), "Show QR must use the verifying request");
    assert!(!qr.contains("fetch_daemon_connection_info") && !qr.contains("ureq"), "no direct /connect request");
    assert!(
        qr.contains("if e == qrcode::DAEMON_NOT_PROVEN { ") && qr.contains("update_port_state(app, PortState::Foreign(port));"),
        "a refused QR request must update the tray state to foreign"
    );
    // Client-mode and launch adoption hand over through show_adopted_daemon.
    let adopt = fn_body(&lib, "show_adopted_daemon");
    assert!(adopt.contains("window::emit_server_ready("), "adoption must navigate through emit_server_ready");
    // The spawned server's readiness hands over through emit_server_ready too.
    let monitor = fn_body(&lib, "monitor_startup");
    assert!(monitor.contains("return window::emit_server_ready("), "readiness must report the handoff's result");
    // No other module builds a token-bearing dashboard URL for navigation.
    for file in ["src/lib.rs", "src/server.rs", "src/qrcode.rs", "src/tray_state.rs"] {
        let src = read(file);
        let code = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(!code.contains("dashboard_url("), "{} must not build a dashboard URL", file);
    }
}

#[test]
fn adoption_shows_the_daemon_only_after_the_handoff_succeeds() {
    let lib = read("src/lib.rs");
    // Launch / crash-restart adoption.
    let adopt = fn_body(&lib, "adopt_external_daemon");
    let shown = pos(&adopt, "if show_adopted_daemon(app, port, token.as_deref()) {");
    assert!(pos(&adopt, "update_port_state(app, PortState::Chroxy(port))") > shown, "the tray claims the daemon only after the handoff");
    assert!(pos(&adopt, "send_notification(") > shown, "the user is told only after the handoff");
    // Client-mode adoption.
    let squashed = squash(&lib);
    assert!(
        squashed.contains("} else if probe_external_health(port, token.as_deref()) { show_adopted_daemon(&app_handle, port, token.as_deref());"),
        "client-mode adoption must challenge the daemon, then hand over through show_adopted_daemon"
    );
}
