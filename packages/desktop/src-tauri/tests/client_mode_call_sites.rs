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
    assert!(body.contains("window::emit_server_ready_for_attempt(&app, port, generation)"), "the watcher's handoff must prove again through emit_server_ready_for_attempt");
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
    for header in ["fn handle_start_checked_with(", "fn handle_restart(", "fn connect_to_daemon_now("] {
        let body = body_of(&lib, header);
        assert!(body.contains("window::begin_attempt();"), "{} must clear the waiting flag", header);
    }
    for header in ["fn handle_start_checked_with(", "fn handle_restart(", "fn await_installed_service("] {
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
    let start = body_of(&lib, "fn handle_start_checked_with(");
    assert!(
        start.contains("|port| adopt_external_daemon_for_attempt(&app, port, generation),"),
        "a user Start must adopt through its own attempt's generation"
    );
    assert!(
        start.contains("await_installed_service(&app, \"Cannot Start Server\", Some(generation),"),
        "the Start's service wait must carry its generation"
    );
    assert!(
        body_of(&lib, "fn handle_restart(").contains("await_installed_service(&app, \"Cannot Restart Server\", Some(generation),"),
        "the Restart's service wait must carry its generation"
    );
    let wait = body_of(&lib, "fn await_installed_service(");
    assert!(
        wait.contains("Some(generation) => adopt_external_daemon_for_attempt(app, port, generation),"),
        "a service wait with a generation must adopt through it"
    );
    // A Start connects to a running daemon only while the window is on the app's own page.
    assert!(
        start.contains("let adopt_allowed = adopt_allowed && main_window_on_app_page(&app);"),
        "a Start from a dashboard must not re-navigate it"
    );
    assert!(start.find("let adopt_allowed = adopt_allowed &&").unwrap() < start.find("run_exclusive(").unwrap());
    // Both Start and Restart show a busy rejection on the loading page, from one message.
    for header in ["fn handle_start_checked_with(", "fn handle_restart("] {
        let body = body_of(&lib, header);
        assert!(
            body.contains("notify_operation_in_progress(&app); show_on_bundled_page(&app, BUSY_MESSAGE); }"),
            "{} must show a busy rejection on the loading page",
            header
        );
    }
    assert!(body_of(&lib, "fn notify_operation_in_progress(").contains("BUSY_MESSAGE"), "one message text");
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

#[test]
fn the_commands_that_can_start_a_handoff_check_the_caller_first() {
    let lib = read("src/lib.rs");
    let connect = body_of(&lib, "async fn connect_to_daemon(");
    assert!(
        connect.contains("if !caller_may_hand_off(&page) { return false; }"),
        "connect_to_daemon must return at once for a caller that may not hand off"
    );
    let check = connect.find("caller_may_hand_off(").expect("connect_to_daemon must check the caller");
    let run = connect.find("connect_to_daemon_now(").expect("connect_to_daemon runs the connect");
    assert!(check < run, "the caller check must come before the connect");
    let start = body_of(&lib, "fn start_server(");
    assert!(start.contains("let adopt_allowed = caller_may_hand_off(&webview_page(&webview));"), "start_server must check the caller");
    assert!(
        start.contains("handle_start_checked_with(&app, adopt_allowed)"),
        "start_server must pass the computed value, not a constant"
    );
    // The menus always may.
    assert!(body_of(&lib, "fn handle_start_checked(").contains("handle_start_checked_with(app, true)"));
}

#[test]
fn connect_to_daemon_hands_off_only_through_emit_server_ready() {
    let lib = read("src/lib.rs");
    let body = body_of(&lib, "fn connect_to_daemon_now(");
    assert!(body.contains("let generation = window::begin_attempt();"), "the connect must take its generation from begin_attempt");
    assert!(
        body.contains("window::emit_server_ready_for_attempt(app, p, generation)") && !body.contains("window::emit_server_ready("),
        "the connect must hand off through emit_server_ready_for_attempt with that generation"
    );
    assert!(!body.contains("dashboard_url") && !body.contains("token"), "the connect must not handle a token or URL itself");
}

#[test]
fn the_waiting_flag_is_set_by_the_error_and_stopped_pages_and_cleared_by_a_handoff() {
    let window = read("src/window.rs");
    for header in ["pub fn emit_server_error(", "pub fn emit_server_stopped("] {
        let body = body_of(&window, header);
        assert!(body.contains("set_awaiting();"), "{} must mark the page as waiting", header);
    }
    let announce = body_of(&window, "fn announce(");
    assert!(announce.contains("clear_awaiting();"), "AppSink::announce must clear the waiting flag");
    assert!(!announce.contains("begin_attempt("), "a handoff must not start a new generation (it would invalidate itself)");
    // The check, the clear and the generation bump are one critical section.
    let claim = body_of(&window, "pub fn claim_awaiting(");
    assert_eq!(claim.matches("attempts()").count(), 1, "claim_awaiting must take the lock once");
    assert!(claim.contains("state.awaiting = false; state.generation += 1;"), "the clear and the bump are together");
}

#[test]
fn the_watcher_claims_the_waiting_page_before_it_hands_off() {
    let lib = read("src/lib.rs");
    let body = body_of(&lib, "fn spawn_port_watcher(");
    assert!(
        body.contains("match window::claim_awaiting() {")
            && body.contains("None => true,")
            && body.contains("Some(generation) => window::emit_server_ready_for_attempt(&app, port, generation),"),
        "the watcher must claim the page, treat a lost claim as no refusal, and hand off only for the claimed generation"
    );
    let claim = body.find("window::claim_awaiting()").unwrap();
    let none = body.find("None => true,").unwrap();
    let emit = body.find("emit_server_ready_for_attempt(").unwrap();
    assert!(claim < none && none < emit, "claim, then the lost-claim arm, then the guarded handoff");
    assert!(!body.contains("window::emit_server_ready(&app"), "the watcher must not hand off unguarded");
}

#[test]
fn a_handoff_for_an_attempt_drops_every_effect_once_a_newer_attempt_began() {
    let window = read("src/window.rs");
    let body = body_of(&window, "pub fn emit_server_ready_for_attempt(");
    assert!(
        body.contains("is_current: move || attempt_generation() == generation,"),
        "the guard must compare the attempt's generation with the newest"
    );
    // One guarded sink serves the announce, the delayed navigation and the refusal.
    assert!(body.contains("handoff::Current {"), "every effect goes through the guarded sink");
    assert!(body.contains("handoff::begin(&prove_for_handoff, &sink, port)"), "the announce uses the guarded sink");
    assert!(body.contains("handoff::finish(&prove_for_handoff, &sink, port)"), "the delayed navigation uses the guarded sink");
    assert!(!body.contains("AppSink(app.clone())") || body.matches("AppSink(app.clone())").count() == 1, "no second, unguarded sink");
}

#[test]
fn a_new_attempt_begins_inside_the_gate_after_the_busy_callback() {
    let lib = read("src/lib.rs");
    for header in ["fn handle_start_checked_with(", "fn handle_restart("] {
        let body = body_of(&lib, header);
        let gate = body.find("run_exclusive(").expect("the gate");
        let busy = body.find("show_on_bundled_page(&app, BUSY_MESSAGE)").expect("the busy callback");
        let begin = body.find("let generation = window::begin_attempt();").expect("the attempt begins");
        assert!(gate < busy && busy < begin, "{}: begin_attempt must sit inside the gate's closure, after its busy callback", header);
    }
}

#[test]
fn connect_to_daemon_leaves_the_tray_alone_while_the_apps_own_server_is_active() {
    let lib = read("src/lib.rs");
    let body = body_of(&lib, "fn connect_to_daemon_now(");
    assert!(body.contains("let own = app_server_active(app);"), "the connect must ask whether the app's own server is active");
    assert_eq!(body.matches("if !own { update_port_state(app, held); }").count(), 2, "the Chroxy and Foreign arms must not touch the tray for the app's own server");
    assert!(body.contains("The server on port {} is still starting."), "the Free arm names the starting server");
    assert!(body.contains("show_on_bundled_page(app, &msg);"), "the Free arm shows its reason on the loading page");
}
