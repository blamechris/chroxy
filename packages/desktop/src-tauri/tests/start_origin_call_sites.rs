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

/// The top-level, whitespace-squashed arguments of the call that `src` starts at.
fn call_args(src: &str) -> Vec<String> {
    let call = balanced_call(src);
    let open = call.find('(').expect("a call");
    let inner = &call[open + 1..call.len() - 1];
    let (mut depth, mut cur, mut out) = (0i32, String::new(), Vec::new());
    for c in inner.chars() {
        match c {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            ',' if depth == 0 => {
                out.push(squash(&cur));
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        out.push(squash(&cur));
    }
    out
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
    // The launch-time auto-start has two spellings: inline, and on its own thread
    // when a chroxy service is installed, where the start may wait for the service
    // (#8890). Anything else is a new call site that has to be looked at.
    assert!(
        origins.iter().any(|a| a == "handle_start(&app_handle, StartOrigin::Launch)"),
        "the launch-time auto-start with a service installed must start as Launch"
    );
    assert!(origins.len() == 4, "an unexpected handle_start call site appeared: {:?}", origins);
    // Two User spellings: the guarded start, and the fallback of the service wait
    // (the service turned out to be gone, so the user's Start proceeds).
    assert!(
        origins.iter().filter(|a| a.contains("StartOrigin::User")).count() == 2,
        "exactly two handle_start calls may start as User: {:?}",
        origins
    );
}

#[test]
fn the_launch_time_auto_start_is_a_launch_start() {
    let lib = squash(&read("src/lib.rs"));
    let arm = &lib[lib.find("StartupAction::StartOwn => {").expect("the StartOwn arm")..];
    let arm = &arm[..arm.find("StartupAction::AdoptExternal").expect("the arm after StartOwn")];
    assert!(
        arm.contains("handle_start(app.handle(), StartOrigin::Launch)")
            && arm.contains("handle_start(&app_handle, StartOrigin::Launch)"),
        "auto-start on launch must start as Launch, on either spelling"
    );
    assert!(!arm.contains("StartOrigin::User"), "auto-start on launch must never start as User");
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
    // `probe_port` (and `probe_port_with_token` under it) is the one place a holder
    // becomes an adoptable daemon: it sends a fresh challenge and checks the proof.
    // A route with its own `/health` request would adopt without that check.
    let lib = read("src/lib.rs");
    // `probe_external_health` delegates to `poll_for_daemon`, which owns the probe.
    let delegate = fn_body(&lib, "probe_external_health");
    assert!(delegate.contains("poll_for_daemon("), "the client-mode adopt must go through the shared poll");
    assert!(!delegate.contains("ureq"), "the client-mode adopt must not make its own request");
    let client_mode = fn_body(&lib, "poll_for_daemon");
    assert!(client_mode.contains("tray_state::probe_port("), "the client-mode adopt must challenge the daemon");
    assert!(!client_mode.contains("ureq"), "the client-mode adopt must not make its own request");

    let server = squash(&read("src/server.rs"));
    assert!(
        server.contains("fn probe(&self, port: u16) -> PortState { tray_state::probe_port("),
        "the automatic start must probe the holder with probe_port"
    );
    assert!(
        server.contains("self.start_health_poll_with( Arc::new(|port| tray_state::probe_port(port, Duration::from_secs(2))),"),
        "the spawned server's readiness must challenge the responder with probe_port"
    );
    assert!(
        server.contains("Arc::new(tray_state::chroxy_service_installed), );"),
        "the monitor must be given the real service detector, not a constant"
    );

    let tray = squash(&read("src/tray_state.rs"));
    assert!(
        tray.contains("pub fn probe_port(port: u16, timeout: Duration) -> PortState { probe_effective(port, timeout, &REAL_TOKEN_SOURCES, probe_port_outcome).0 }")
            && tray.contains("match probe_effective(port, timeout, &REAL_TOKEN_SOURCES, probe_port_outcome) {"),
        "probe_port and prove_daemon must both challenge through the real token sources"
    );
    assert!(
        tray.contains("let (state, proof_failed) = probe(port, timeout, first.as_deref());") && tray.contains("if proof_failed {"),
        "the fresh token is read only after a chroxy-shaped body's proof failed"
    );
    assert!(
        tray.contains("(Some(t), Some(n)) => health_proof::body_proves_daemon(body, t, port, n)"),
        "a chroxy-shaped body must be accepted only on a verified proof"
    );
}

#[test]
fn the_readiness_poll_never_treats_a_bare_200_as_running() {
    let server = read("src/server.rs");
    let start = pos(&server, "fn start_health_poll_with(");
    let end = start + server[start..].find("fn resolve_cli_js").expect("end of the poll");
    let poll = squash(&server[start..end]);
    assert!(!poll.contains("ureq::get"), "the readiness poll must not make its own request");
    assert!(!poll.contains("resp.status() == 200"), "a bare 200 must not set Running");
    // Every `Running` assignment in the poll sits in a `PortState::Chroxy` arm.
    let assignments = poll.matches("*s = ServerStatus::Running").count();
    let proven_arms = poll.matches("PortState::Chroxy(_) => {").count();
    assert!(assignments >= 1 && assignments == proven_arms, "each Running assignment must follow a proven probe");
    assert!(poll.contains("let observed = probe(port);") && poll.contains("match probe(port) {"), "both loops must probe");
}

#[test]
fn the_window_hands_over_only_through_the_handoff_steps() {
    let window = squash(&read("src/window.rs"));
    // The ready handoff is exactly `begin`, a pause, then `finish`, each with the prover.
    let start = pos(&window, "pub fn try_server_ready(");
    let body = &window[start..pos(&window, "pub fn emit_server_ready(")];
    let begin = pos(body, "handoff::begin(&prove_for_handoff, &sink, port)");
    let spawn = pos(body, "std::thread::spawn(");
    let finish = pos(body, "handoff::finish(&prove_for_handoff, &sink, port)");
    assert!(begin < spawn && spawn < finish, "begin, then the delayed finish");
    assert!(body.contains("return false;"), "a refused begin must not report success");
    // Settings go the same way.
    assert!(
        window.contains("handoff::open_settings(&prove_for_handoff, &AppSink(app.clone()), port)"),
        "settings must open through handoff::open_settings"
    );
    // The prover is the daemon challenge, nothing cached.
    let prover = &window[pos(&window, "fn prove_for_handoff(")..pos(&window, "fn refuse_handoff(")];
    assert!(prover.contains("crate::tray_state::prove_daemon(port, HANDOFF_TIMEOUT)"), "the prover must challenge the daemon");
    // Only the sink emits the token-bearing event and navigates: nowhere else in the module.
    let outside_sink = window.replace(&window[pos(&window, "impl handoff::Sink for AppSink {")..pos(&window, "pub fn try_server_ready(")], "");
    assert!(!outside_sink.contains("\"server_ready\""), "server_ready is emitted only by the sink");
    assert!(!outside_sink.contains("window.location.href"), "navigation happens only in the sink");
    assert!(!window.contains("inject_settings_button_handler"), "no page-side navigation with a credential");
    // A refusal goes through the tray's two-observation rule, not straight to Foreign.
    let refuse = &window[pos(&window, "fn refuse_handoff(")..pos(&window, "pub fn show_handoff_refusal(")];
    assert!(refuse.contains("crate::observe_port(app, crate::tray_state::PortState::Foreign(port))"), "refusal must report an observation");
    assert!(!refuse.contains("update_port_state"), "one refusal must not flip the tray");
}

#[test]
fn the_connect_request_is_preceded_by_a_challenge() {
    let qr = squash(&read("src/qrcode.rs"));
    let start = pos(&qr, "fn fetch_with(");
    let body = &qr[start..pos(&qr, "/// What a refused handoff reports")];
    assert!(pos(body, "prove(port)") < pos(body, "request_connection_info("), "challenge before the request");
    assert!(body.contains("request_connection_info(port, &token)"), "the request carries the token that proved");
    let public = &qr[pos(&qr, "pub fn fetch_daemon_connection_info(")..start];
    assert!(public.contains("crate::tray_state::prove_daemon(p, "), "the public fetch challenges the daemon");
    // The only caller of the request is the verifying fetch: the definition and
    // that one call are the only two mentions outside the tests.
    let code = &qr[..pos(&qr, "#[cfg(test)]")];
    assert_eq!(
        code.matches("request_connection_info(").count(),
        2,
        "request_connection_info must be reached only through fetch_with"
    );
}

#[test]
fn every_dashboard_qr_and_ipc_handoff_goes_through_the_verifying_functions() {
    let lib = read("src/lib.rs");
    // Open Dashboard hands over through emit_server_ready, which challenges.
    let dash = fn_body(&lib, "handle_dashboard");
    assert!(dash.contains("window::emit_server_ready("), "Open Dashboard must navigate through emit_server_ready");
    assert!(!dash.contains("dashboard_url(") && !dash.contains("api_token") && !dash.contains("load_config"), "Open Dashboard must not handle a token itself");
    // The QR path asks through the verifying request, or proves first.
    let qr = fn_body(&lib, "qr_for_reachable_daemon");
    assert!(qr.contains("qrcode::connection_info_for( external, port,"), "Show QR must go through connection_info_for");
    assert!(qr.contains("&qrcode::get_external_connection_info,"), "an external daemon is asked through the verifying request");
    assert!(!qr.contains("fetch_daemon_connection_info") && !qr.contains("ureq"), "no direct /connect request");
    assert!(
        qr.contains("tray_state::prove_daemon(p, std::time::Duration::from_secs(2))")
            && qr.contains("&|p| observe_port(app, PortState::Foreign(p))"),
        "the own server is challenged and a refused QR reports an observation"
    );
    // Adoption hands over through show_adopted_daemon -> emit_server_ready.
    let adopt = fn_body(&lib, "show_adopted_daemon");
    assert!(adopt.contains("window::emit_server_ready(app, port)"), "adoption must navigate through emit_server_ready");
    // The spawned server's readiness hands over through the same path, with retries.
    let monitor = fn_body(&lib, "monitor_startup");
    assert!(monitor.contains("handoff::with_retries( HANDOFF_ATTEMPTS, || window::try_server_ready(app, p),"), "readiness must hand over through try_server_ready, retried");
    assert!(monitor.contains("window::show_handoff_refusal(app, p);\n                return true;") || monitor.contains("window::show_handoff_refusal(app, p); return true;"),
        "a refused readiness handoff must keep the server under crash supervision");
    assert!(!monitor.contains("return window::emit_server_ready"), "one refusal must not end supervision");
    // Token-returning IPC proves first (or is an app page).
    let ipc = squash(&lib);
    assert!(
        ipc.contains("let token = server_info_token( &page, port, &|p| tray_state::prove_daemon(p, std::time::Duration::from_secs(2)),"),
        "get_server_info must challenge the daemon for a page it did not serve"
    );
    assert!(
        ipc.contains(".map(|u| caller_page(&u)) .unwrap_or(CallerPage::Remote { host: None, port: None });"),
        "get_server_info must classify the page by its URL, treating an unreadable one as remote"
    );
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
    let shown = pos(&adopt, "if show_adopted_daemon(app, port) {");
    assert!(pos(&adopt, "update_port_state(app, PortState::Chroxy(port))") > shown, "the tray claims the daemon only after the handoff");
    assert!(pos(&adopt, "send_notification(") > shown, "the user is told only after the handoff");
    // Client-mode adoption.
    let squashed = squash(&lib);
    assert!(
        squashed.contains("if probe_external_health(port) { show_adopted_daemon(&app_handle, port); }"),
        "client-mode adoption must challenge the daemon, then hand over through show_adopted_daemon"
    );
}

#[test]
fn the_settings_button_opens_settings_through_the_command_not_a_url() {
    let js = read("../dist/loading.js");
    assert!(js.contains("invoke('open_settings')"), "the settings button must call open_settings");
    assert!(!js.contains("?token=") && !js.contains("dashboard?"), "the loading page must not build a dashboard URL");
    let build = read("build.rs");
    assert!(build.contains("\"open_settings\""), "open_settings must be a declared command");
    assert!(read("capabilities/default.json").contains("allow-open-settings"), "open_settings must be permitted");
}

#[test]
fn the_two_token_reads_use_their_own_age_limits() {
    let config = squash(&read("src/config.rs"));
    assert!(config.contains("pub fn proof_token() -> Option<String> { read_token(TokenRead::Cached) }"));
    assert!(
        config.contains("pub fn fresh_token() -> Option<String> { read_token(TokenRead::Fresh) }"),
        "the retry's token read must bypass the long cache"
    );
}

#[test]
fn every_path_that_could_spawn_knows_whether_a_service_is_installed() {
    // #8890: the service flag reaches the decision on every route that can spawn.
    // A caller of the flag-less spelling would spawn into the service's restart gap.
    let lib = read("src/lib.rs");
    for name in ["handle_start_checked", "handle_restart"] {
        let body = fn_body(&lib, name);
        assert!(
            body.contains("run_guarded_user_start_with_service(") && body.contains("chroxy_service_installed()"),
            "{} must pass whether a service is installed",
            name
        );
        assert!(!body.contains("run_guarded_user_start("), "{} must not use the service-blind spelling", name);
        assert!(body.contains("await_installed_service("), "{} must wait for the service, not proceed", name);
    }
    let server = squash(&read("src/server.rs"));
    assert!(
        server.contains("tray_state::launch_start_decision_with_service(held,")
            && !server.contains("tray_state::launch_start_decision(held"),
        "the automatic start (launch and crash restart) must use the service-aware decision"
    );
    assert!(
        server.contains("LaunchDecision::AwaitService => {"),
        "the automatic start must handle AwaitService, not spawn"
    );
}

#[test]
fn the_service_wait_runs_before_any_lock_and_never_under_one() {
    // #8890: the ~30 s wait for an installed service must run with the
    // ServerManager mutex FREE (tray handlers lock it on the main thread).
    let lib = read("src/lib.rs");
    let body = fn_body(&lib, "handle_start");

    // Launch-time start: the wait precedes the first lock in the function.
    let wait = body.find("wait_for_service(").expect("the launch-time start must wait for a service");
    let first_lock = body.find("lock_or_recover(").expect("handle_start locks the manager");
    assert!(wait < first_lock, "the launch-time wait must come before any lock_or_recover");

    // Crash auto-restart: the brief release lock comes first (before the backoff),
    // and from the backoff sleep to the wait no lock is held; all before the
    // restart that takes the lock.
    let sleep = body.find("std::thread::sleep(backoff)").expect("backoff sleep");
    let crash_wait = body[sleep..]
        .find("wait_for_service(service)")
        .map(|i| i + sleep)
        .expect("the crash restart must wait for a service");
    assert!(!body[sleep..crash_wait].contains("lock_or_recover("), "no lock may be taken between the backoff and the crash-restart wait");
    let restart = body.find("mgr.try_auto_restart(").expect("the crash restart");
    assert!(crash_wait < restart, "the crash-restart wait must precede try_auto_restart");

    // The wait is one implementation, shared with the user path.
    assert!(fn_body(&lib, "await_installed_service").contains("wait_for_service(tray_state::chroxy_service_detection())"));
    assert!(fn_body(&lib, "wait_for_service").contains("poll_for_daemon_within("));
    let within = fn_body(&lib, "poll_for_daemon_within");
    assert!(within.contains("poll_until_chroxy_within(") && within.contains("tray_state::probe_port(port, timeout)"), "the deadline poll must challenge through probe_port with the capped timeout");
}

#[test]
fn the_under_lock_backstop_probes_once_and_cannot_sleep() {
    let server = read("src/server.rs");
    let slice = |start: &str, end: &str| {
        let from = server.find(start).unwrap_or_else(|| panic!("{} not found", start));
        let rest = &server[from..];
        squash(&rest[..rest.find(end).unwrap_or_else(|| panic!("no end after {}", start))])
    };
    let prep = slice("fn prepare_port_with(", "\n}\n");
    assert!(prep.contains("probe_service_daemon("), "the backstop must use the single-probe method");
    assert!(!prep.contains("await_service") && !prep.contains("sleep") && !prep.contains("poll_until_chroxy"), "the backstop must not wait");
    let real = slice("    fn probe_service_daemon(&self, port: u16) -> PortState {\n        tray_state", "\n    }\n");
    assert!(real.contains("tray_state::probe_port("), "the real probe challenges through probe_port");
    assert!(!real.contains("sleep") && !real.contains("poll_until_chroxy") && !real.contains("SERVICE_WAIT"), "the real probe must not wait");
}

const DETECTOR: &str = "tray_state::chroxy_service_installed()";
const DETECTION: &str = "tray_state::chroxy_service_detection()";

#[test]
fn the_detector_itself_is_what_reaches_every_decision() {
    // Spelling is not enough: `{ let _ = chroxy_service_installed(); false }` names
    // the detector and still passes a constant. The argument must BE the call.
    let lib = read("src/lib.rs");
    for name in ["handle_start_checked", "handle_restart"] {
        let body = lib[lib.find(&format!("\nfn {}(", name)).expect("fn")..].to_string();
        let at = body.find("run_guarded_user_start_with_service(").expect("the guarded start");
        let args = call_args(&body[at..]);
        assert_eq!(args.get(2).map(String::as_str), Some(DETECTOR), "{}: the service argument must be the detector's result: {:?}", name, args);
    }
    // Every wait for a service is given the detection itself, or the binding that
    // is exactly the detection.
    let mut checked = 0;
    for (i, _) in lib.match_indices("wait_for_service(") {
        if lib[..i].ends_with("fn ") {
            continue;
        }
        let args = call_args(&lib[i..]);
        let ok = args.len() == 1 && (args[0] == DETECTION || args[0] == "service");
        assert!(ok, "wait_for_service must be given the detection: {:?}", args);
        checked += 1;
    }
    assert!(checked >= 4, "expected the launch, crash, restart and user paths, saw {}", checked);
    let binding = format!("let service = {};", DETECTION);
    assert!(lib.matches(&binding).count() >= 2, "`service` may only be a binding of the detection (crash loop and restart)");
    assert_eq!(
        lib.matches("let service =").count(),
        lib.matches(&binding).count(),
        "another `let service =` binding is not the detection"
    );

    // The restart branch is driven by the pure plan, over the detection binding.
    let restart = fn_body(&lib, "restart_own_server");
    let at = restart.find("restart_plan(").expect("the restart plan");
    assert!(restart[..at].contains(&binding), "the plan must be computed from the detection binding");
    assert_eq!(call_args(&restart[at..]), vec!["&service".to_string()], "the plan must be given the detection binding");
    assert!(
        restart.contains("if tray_state::restart_plan(&service) == tray_state::RestartPlan::HandOffToService {"),
        "the restart plan must drive the branch (not a constant or a bare condition)"
    );
    assert!(restart.find("restart_plan(").unwrap() < restart.find("mgr.restart(StartOrigin::User)").unwrap());
    assert!(restart.contains("stop_for_service_handoff()"));
}

#[test]
fn the_crash_restart_retires_the_old_monitor_when_the_crash_is_accepted() {
    // Before the backoff, not after it: the monitor must not be left able to act
    // on the port for the whole delay.
    let lib = read("src/lib.rs");
    let body = fn_body(&lib, "handle_start");
    let arm = body.find("let service = tray_state::chroxy_service_detection();").expect("the crash arm reads the detection");
    let release = body[arm..].find("mgr.release_for_service()").map(|i| i + arm).expect("release at acceptance");
    let sleep = body.find("std::thread::sleep(backoff)").unwrap();
    let wait = body[arm..].find("wait_for_service(service)").map(|i| i + arm).unwrap();
    assert!(arm < release && release < sleep && sleep < wait, "release must come before the backoff, and the backoff before the wait");
    assert!(body[arm..release].contains("service.blocks_spawn()"), "the release is conditional on the detection");
}

#[test]
fn the_start_reads_tunnel_and_host_leniently_and_before_settling_the_port() {
    // #8890: an unrelated bad field must not hide tunnel/host, and an unreadable
    // config.json refuses the start before anything is adopted, reaped or spawned.
    let server = squash(&read("src/server.rs"));
    let start = server.find("fn start_server_process(").expect("start_server_process");
    let body = &server[start..];
    let read_at = body.find("self.apply_launch_overrides(config::load_launch_overrides())?;").expect("the lenient read must refuse on Err");
    let settle_at = body.find("self.settle_port(").expect("settle_port");
    assert!(read_at < settle_at, "the config read must come before the port is settled");
    let lib = read("src/lib.rs");
    assert!(fn_body(&lib, "handle_start").contains("cloudflared_missing_notice("), "the cloudflared notice must say who chose the tunnel");
}
