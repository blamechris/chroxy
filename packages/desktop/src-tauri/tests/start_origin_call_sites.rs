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

#[test]
fn every_adopt_route_classifies_the_holder_through_probe_port() {
    // `probe_port` is the one place a holder becomes an adoptable daemon: it checks
    // that every listener runs as the current user. A route with its own `/health`
    // request would adopt without that check.
    let lib = read("src/lib.rs");
    let client_mode = fn_body(&lib, "probe_external_health");
    assert!(client_mode.contains("tray_state::probe_port("), "the client-mode adopt must use probe_port");
    assert!(!client_mode.contains("ureq"), "the client-mode adopt must not make its own request");

    let server = squash(&read("src/server.rs"));
    assert!(
        server.contains("fn probe(&self, port: u16) -> PortState { tray_state::probe_port("),
        "the automatic start must probe the holder with probe_port"
    );

    let tray = squash(&read("src/tray_state.rs"));
    assert!(
        tray.contains("probe_port_with_owner(port, timeout, crate::owned_server::holders_run_as_current_user)"),
        "probe_port must check the real owner"
    );
}
