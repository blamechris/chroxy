//! Pins the client-mode fixes (#9077, #9078) that live in Tauri glue a unit test
//! cannot run: which port the IPC commands use, and what the port watcher calls.
//!
//! Lo-fi source scraping in the style of `start_origin_call_sites.rs`. Every
//! assertion collapses to a boolean first: a failing `assert!(x.contains(..))` on a
//! multi-KB source slice would otherwise carry the whole slice as its error.

use std::fs;
use std::path::PathBuf;

fn read(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The body of the function whose header starts with `header` (e.g. `"async fn open_settings("`):
/// to the first `}` in column 0. Panics if it is gone, so a rename cannot turn a pin into a no-op.
fn body_of(src: &str, header: &str) -> String {
    let start = src.find(header).unwrap_or_else(|| panic!("{} not found", header));
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or_else(|| panic!("{} has no closing brace", header));
    squash(&rest[..end])
}

#[test]
fn the_ipc_commands_ask_the_app_port_resolver_not_the_server_manager() {
    // #9077: `ServerManager::port()` is 0 until the app starts its own server, which
    // client mode never does, so a command that reads it challenges port 0.
    let lib = read("src/lib.rs");
    for header in ["async fn get_server_info(", "async fn open_settings(", "fn connect_to_daemon_now("] {
        let body = body_of(&lib, header);
        assert!(body.contains("app_port("), "{} must resolve the port through app_port", header);
        assert!(!body.contains(".port()"), "{} must not read ServerManager::port()", header);
    }
    // The token check in get_server_info is given that same port.
    let info = body_of(&lib, "async fn get_server_info(");
    assert!(info.contains("let port = app_port(&app);"), "get_server_info must bind the resolved port");
    assert!(info.contains("server_info_token( &page, port,"), "the token check must use the resolved port");
    // The resolver is the pure one, fed the configured port.
    let helper = body_of(&lib, "fn app_port(");
    assert!(
        helper.contains("tray_state::app_daemon_port(active, own_port, config::load_port)"),
        "app_port must resolve through app_daemon_port with the configured port"
    );
}

#[test]
fn the_port_watcher_runs_each_iteration_through_the_testable_seam() {
    // #9078: the handoff to a daemon that comes up late is `watch_step`'s, driven by
    // closures in the tray_state tests. A watcher that probed and observed on its own
    // would leave that test green and the window stuck.
    let lib = read("src/lib.rs");
    let body = body_of(&lib, "fn spawn_port_watcher(");
    assert!(body.contains("tray_state::watch_step("), "the watcher must call watch_step");
    assert!(body.contains("|port| window::emit_server_ready(&app, port),"), "the watcher's handoff must prove again through emit_server_ready");
    assert!(body.contains("|observed| observe_port_folded(&app, observed),"), "the decision must see the FOLDED tray state");
    assert!(
        body.contains("awaiting: window::awaiting_daemon(),") && body.contains("on_app_page: main_window_on_app_page(&app),"),
        "the window view must come from the real window"
    );
}

#[test]
fn a_refused_settings_handoff_never_reports_port_zero() {
    let window = read("src/window.rs");
    let body = body_of(&window, "fn refuse_handoff(");
    assert!(body.contains("if port != 0 {"), "refuse_handoff must skip the tray observation for port 0");
    let at_guard = body.find("if port != 0 {").unwrap();
    let at_observe = body.find("crate::observe_port(").expect("the refusal still reports an observation");
    assert!(at_guard < at_observe, "the port-0 guard must precede the observation");
}

#[test]
fn every_user_attempt_clears_the_waiting_flag_and_every_refusal_reaches_the_page() {
    let lib = read("src/lib.rs");
    for header in ["fn handle_start_checked(", "fn handle_restart(", "fn connect_to_daemon_now("] {
        let body = body_of(&lib, header);
        assert!(body.contains("window::begin_attempt();"), "{} must clear the waiting flag", header);
    }
    for header in ["fn handle_start_checked(", "fn handle_restart(", "fn await_installed_service("] {
        let body = body_of(&lib, header);
        assert!(body.contains("show_on_bundled_page("), "{} must show a refusal on the loading page", header);
    }
    // A refusal is shown only on the bundled page, never sent to a dashboard.
    let helper = body_of(&lib, "fn show_on_bundled_page(");
    assert!(
        helper.contains("if main_window_on_app_page(app) { window::emit_server_error(app, msg); }"),
        "show_on_bundled_page must be gated on the bundled page"
    );
    // A user Start adopts through the one adopt path.
    let start = body_of(&lib, "fn handle_start_checked(");
    assert!(start.contains("|port| adopt_external_daemon(&app, port),"), "a user Start must adopt a running daemon");
}

#[test]
fn connect_to_daemon_is_declared_everywhere_and_the_page_calls_it() {
    assert!(read("build.rs").contains("\"connect_to_daemon\""), "connect_to_daemon must be a declared command");
    assert!(read("capabilities/default.json").contains("allow-connect-to-daemon"), "connect_to_daemon must be permitted");
    let js = read("../dist/loading.js");
    assert!(js.contains("invoke('connect_to_daemon')"), "the Connect button must call connect_to_daemon");
    assert!(js.contains("'connect-btn'"), "the Connect button must exist");
    assert!(!js.contains("?token=") && !js.contains("dashboard?"), "the loading page must not build a dashboard URL");
}
