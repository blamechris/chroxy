//! Tray-menu state for an externally managed daemon (#8267).
//!
//! The tray used to know only the state of the server *this app* spawned, so with
//! a launchd (or `chroxy start`) daemon on the configured port and Auto-start
//! Server off it behaved as though nothing were running: Start Server enabled
//! against an occupied port (and `ServerManager::start` SIGTERMs whatever node
//! process holds that port), Open Dashboard / Console / Show QR Code greyed out.
//!
//! Everything decision-shaped lives here as pure functions so it is unit-testable
//! without a Tauri runtime and stays platform-neutral (the `#[cfg(target_os)]`
//! blocks in `lib.rs` are not type-checked on other targets). `lib.rs` owns the
//! I/O: the periodic probe thread and applying a [`TrayPlan`] to the real menu
//! items.

use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// What the app-managed server is doing, as far as the menu is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuState {
    Running,
    Stopped,
    Restarting,
}

/// What is listening on the configured port, when the app's own server is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortState {
    /// Nothing is listening.
    Free,
    /// A chroxy daemon answered `/health` as chroxy: an externally managed daemon.
    Chroxy(u16),
    /// Something holds the port but did not answer as chroxy.
    Foreign(u16),
}

impl PortState {
    /// True when the port is taken by anything at all.
    pub fn is_occupied(&self) -> bool {
        !matches!(self, PortState::Free)
    }

    /// True only for a verified chroxy daemon.
    pub fn is_external_chroxy(&self) -> bool {
        matches!(self, PortState::Chroxy(_))
    }
}

/// Fingerprint check for a 200 `/health` body.
///
/// We navigate WITH the access token (#6015, #6123 review), so a 200 from an
/// unrelated local service squatting on the port must not read as a daemon.
/// chroxy's health JSON is `{"status":"ok","mode":...,"version":...}`; require
/// `status:"ok"` and a string `version`.
pub fn is_chroxy_health(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .map(|v| {
            v.get("status").and_then(|s| s.as_str()) == Some("ok")
                && v.get("version").and_then(|x| x.as_str()).is_some()
        })
        .unwrap_or(false)
}

/// What a single `/health` request observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthOutcome {
    /// HTTP 200 with this body.
    Ok(String),
    /// Some other HTTP status (a service answered, but not as a healthy chroxy).
    BadStatus(u16),
    /// No HTTP response. `tcp_open` says whether a plain TCP connect succeeded,
    /// which separates "nothing listening" from "listening but not speaking HTTP".
    NoHttp { tcp_open: bool },
}

/// Classify one probe. An occupied port that does not answer as chroxy is
/// `Foreign`, never `Chroxy`.
pub fn classify_probe(port: u16, outcome: &HealthOutcome) -> PortState {
    match outcome {
        HealthOutcome::Ok(body) if is_chroxy_health(body) => PortState::Chroxy(port),
        HealthOutcome::Ok(_) | HealthOutcome::BadStatus(_) => PortState::Foreign(port),
        HealthOutcome::NoHttp { tcp_open: true } => PortState::Foreign(port),
        HealthOutcome::NoHttp { tcp_open: false } => PortState::Free,
    }
}

/// Fold a new observation into the tracked state.
///
/// A verified daemon that stops answering once (a busy event loop missing the
/// probe timeout) must not flip the tray to "Start Server enabled", so leaving
/// `Chroxy` needs two consecutive observations. Every other transition is
/// immediate. Returns `(next_state, pending_downgrade)`; thread the second
/// value back in on the next call.
pub fn next_external(
    current: PortState,
    observed: PortState,
    pending_downgrade: bool,
) -> (PortState, bool) {
    if observed == current {
        return (current, false);
    }
    if current.is_external_chroxy() && !pending_downgrade {
        return (current, true);
    }
    (observed, false)
}

/// What the tray should show: labels and enablement for each item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayPlan {
    pub status_label: String,
    pub start_label: String,
    pub stop_label: String,
    pub restart_label: String,
    pub start: bool,
    pub stop: bool,
    pub restart: bool,
    pub dashboard: bool,
    pub console: bool,
    pub show_qr: bool,
}

const START: &str = "Start Server";
const STOP: &str = "Stop Server";
const RESTART: &str = "Restart Server";

/// `(app-managed server state, what holds the port) -> menu plan`.
///
/// While the app's own server is Running or Restarting it owns the port, so the
/// probe result is irrelevant. Only a stopped app-managed server defers to it.
pub fn tray_plan(state: MenuState, port: PortState) -> TrayPlan {
    let plan = |status: &str, start: bool, stop: bool, restart: bool, open: bool| TrayPlan {
        status_label: status.to_string(),
        start_label: START.to_string(),
        stop_label: STOP.to_string(),
        restart_label: RESTART.to_string(),
        start,
        stop,
        restart,
        dashboard: open,
        console: open,
        show_qr: open,
    };
    match (state, port) {
        (MenuState::Running, _) => plan("Server running", false, true, true, true),
        (MenuState::Restarting, _) => plan("Server restarting…", false, false, false, false),
        (MenuState::Stopped, PortState::Free) => plan("Server stopped", true, false, false, false),
        (MenuState::Stopped, PortState::Chroxy(p)) => TrayPlan {
            status_label: format!("Connected to external daemon (port {})", p),
            start_label: format!("Start Server (port {} in use)", p),
            // The app does not own this process: do not offer to kill it.
            stop_label: format!("{} (managed externally)", STOP),
            restart_label: format!("{} (managed externally)", RESTART),
            ..plan("", false, false, false, true)
        },
        (MenuState::Stopped, PortState::Foreign(p)) => TrayPlan {
            status_label: format!("Port {} is in use by another program", p),
            start_label: format!("Start Server (port {} in use)", p),
            ..plan("", false, false, false, false)
        },
    }
}

/// The port of a verified chroxy daemon the app did not start, if the menu is in
/// that state. Only meaningful while the app-managed server is stopped.
pub fn external_port(menu: MenuState, port: PortState) -> Option<u16> {
    match (menu, port) {
        (MenuState::Stopped, PortState::Chroxy(p)) => Some(p),
        _ => None,
    }
}

/// The user-initiated actions that would spawn a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserAction {
    Start,
    Restart,
}

/// What a user-initiated Start/Restart should do about a held port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserStartDecision {
    Proceed,
    /// Do nothing; tell the user what holds the port.
    Refuse(PortState),
}

/// While the app's own server is active the port is its own (a Restart of it is
/// legitimate); otherwise anything holding the port is somebody else's and the
/// action is refused.
pub fn user_start_decision(app_server_active: bool, held: PortState) -> UserStartDecision {
    if !app_server_active && held.is_occupied() {
        UserStartDecision::Refuse(held)
    } else {
        UserStartDecision::Proceed
    }
}

/// User-facing explanation of a refusal.
pub fn refusal_message(action: UserAction, held: PortState) -> String {
    match (action, held) {
        (UserAction::Start, PortState::Chroxy(p)) => format!(
            "A chroxy daemon already serves port {}. Use Open Dashboard to connect to it.",
            p
        ),
        (UserAction::Restart, PortState::Chroxy(p)) => format!(
            "The daemon on port {} was not started by this app, so it cannot be restarted. Manage it with its service manager.",
            p
        ),
        (_, PortState::Foreign(p)) => format!(
            "Port {} is in use by another program. Free it, or change the port in config.json.",
            p
        ),
        (_, PortState::Free) => "The port is free.".to_string(),
    }
}

/// Orchestrates a user-initiated Start/Restart: probe live (only when the app's
/// own server is idle), refuse if the port is held, else proceed. The effects are
/// closures so the sequencing is testable: a refusal must never reach `proceed`.
pub fn run_guarded_user_start(
    action: UserAction,
    app_server_active: bool,
    probe: impl FnOnce() -> PortState,
    on_refuse: impl FnOnce(PortState, String),
    proceed: impl FnOnce(),
) {
    let held = if app_server_active { PortState::Free } else { probe() };
    match user_start_decision(app_server_active, held) {
        UserStartDecision::Refuse(h) => on_refuse(h, refusal_message(action, h)),
        UserStartDecision::Proceed => proceed(),
    }
}

/// Stop acts on the server this app spawned. Against an external daemon it must
/// do nothing, not even tell a connected window that the server stopped.
pub fn run_guarded_stop(
    menu: MenuState,
    port: PortState,
    on_refuse: impl FnOnce(String),
    proceed: impl FnOnce(),
) {
    match external_port(menu, port) {
        Some(p) => on_refuse(format!(
            "The daemon on port {} was not started by this app, so it cannot be stopped. Manage it with its service manager.",
            p
        )),
        None => proceed(),
    }
}

/// Probe `/health` on loopback once and classify what holds `port`.
pub fn probe_port(port: u16, timeout: Duration) -> PortState {
    let url = format!("http://127.0.0.1:{}/health", port);
    let outcome = match ureq::get(&url).timeout(timeout).call() {
        Ok(resp) if resp.status() == 200 => {
            // Bounded read: the port may belong to something that streams forever.
            let mut body = String::new();
            let _ = resp.into_reader().take(64 * 1024).read_to_string(&mut body);
            HealthOutcome::Ok(body)
        }
        Ok(resp) => HealthOutcome::BadStatus(resp.status()),
        Err(ureq::Error::Status(code, _)) => HealthOutcome::BadStatus(code),
        Err(ureq::Error::Transport(_)) => HealthOutcome::NoHttp {
            tcp_open: tcp_connects(port, timeout),
        },
    };
    classify_probe(port, &outcome)
}

/// True if something accepts a TCP connection on loopback `port`.
pub fn port_accepts_connections(port: u16) -> bool {
    tcp_connects(port, Duration::from_millis(300))
}

fn tcp_connects(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    const GOOD: &str = r#"{"status":"ok","mode":"cli","version":"0.11.4"}"#;

    // --- tray_plan ---------------------------------------------------------

    #[test]
    fn external_daemon_disables_start_and_enables_open_items() {
        let p = tray_plan(MenuState::Stopped, PortState::Chroxy(8765));
        assert!(!p.start, "Start must be disabled while a daemon owns the port");
        assert!(p.dashboard && p.console && p.show_qr);
        assert!(!p.stop && !p.restart, "the app must not offer to kill a process it does not own");
        assert_eq!(p.status_label, "Connected to external daemon (port 8765)");
        assert_eq!(p.start_label, "Start Server (port 8765 in use)");
        assert_eq!(p.stop_label, "Stop Server (managed externally)");
        assert_eq!(p.restart_label, "Restart Server (managed externally)");
    }

    #[test]
    fn no_daemon_keeps_todays_stopped_menu() {
        let p = tray_plan(MenuState::Stopped, PortState::Free);
        assert!(p.start);
        assert!(!p.stop && !p.restart && !p.dashboard && !p.console && !p.show_qr);
        assert_eq!(p.start_label, "Start Server");
        assert_eq!(p.stop_label, "Stop Server");
    }

    #[test]
    fn app_managed_server_keeps_todays_running_menu() {
        // Even if a probe somehow reports the port as external, our own running
        // server owns it: the menu must not change.
        for port in [PortState::Free, PortState::Chroxy(8765), PortState::Foreign(8765)] {
            let p = tray_plan(MenuState::Running, port);
            assert!(!p.start && p.stop && p.restart);
            assert!(p.dashboard && p.console && p.show_qr);
            assert_eq!(p.start_label, "Start Server");
            assert_eq!(p.stop_label, "Stop Server");
        }
    }

    #[test]
    fn restarting_disables_everything_regardless_of_probe() {
        for port in [PortState::Free, PortState::Chroxy(8765), PortState::Foreign(8765)] {
            let p = tray_plan(MenuState::Restarting, port);
            assert!(!p.start && !p.stop && !p.restart);
            assert!(!p.dashboard && !p.console && !p.show_qr);
        }
    }

    #[test]
    fn foreign_port_holder_disables_start_with_hint_and_is_not_connected() {
        let p = tray_plan(MenuState::Stopped, PortState::Foreign(8765));
        assert!(!p.start);
        assert_eq!(p.start_label, "Start Server (port 8765 in use)");
        assert!(!p.dashboard && !p.console && !p.show_qr, "must not read as connected");
        assert!(!p.status_label.contains("Connected"));
        assert!(p.status_label.contains("8765"));
    }

    // --- classify_probe ----------------------------------------------------

    #[test]
    fn chroxy_health_body_reads_as_external_daemon() {
        assert_eq!(
            classify_probe(9000, &HealthOutcome::Ok(GOOD.to_string())),
            PortState::Chroxy(9000)
        );
    }

    #[test]
    fn non_chroxy_answers_are_foreign_never_chroxy() {
        for outcome in [
            HealthOutcome::Ok("OK".to_string()),
            HealthOutcome::Ok(r#"{"status":"ok"}"#.to_string()),
            HealthOutcome::Ok(String::new()),
            HealthOutcome::BadStatus(404),
            HealthOutcome::BadStatus(503),
            HealthOutcome::NoHttp { tcp_open: true },
        ] {
            assert_eq!(classify_probe(9000, &outcome), PortState::Foreign(9000), "{:?}", outcome);
        }
    }

    #[test]
    fn closed_port_is_free() {
        assert_eq!(
            classify_probe(9000, &HealthOutcome::NoHttp { tcp_open: false }),
            PortState::Free
        );
    }

    // --- next_external (debounce) -----------------------------------------

    #[test]
    fn daemon_disappearing_needs_two_consecutive_observations() {
        let d = PortState::Chroxy(8765);
        let (s, pending) = next_external(d, PortState::Free, false);
        assert_eq!((s, pending), (d, true), "one miss must not flip the tray");
        let (s, pending) = next_external(s, PortState::Free, pending);
        assert_eq!((s, pending), (PortState::Free, false));
    }

    #[test]
    fn a_recovered_probe_clears_the_pending_downgrade() {
        let d = PortState::Chroxy(8765);
        let (s, pending) = next_external(d, PortState::Free, false);
        let (s, pending) = next_external(s, d, pending);
        assert_eq!((s, pending), (d, false));
        // ...so the next miss is again only the first.
        assert_eq!(next_external(s, PortState::Free, pending), (d, true));
    }

    #[test]
    fn daemon_appearing_is_immediate() {
        assert_eq!(
            next_external(PortState::Free, PortState::Chroxy(8765), false),
            (PortState::Chroxy(8765), false)
        );
        assert_eq!(
            next_external(PortState::Foreign(8765), PortState::Chroxy(8765), false),
            (PortState::Chroxy(8765), false)
        );
    }

    // --- guards for user-initiated actions (#8267 review S1, X1) -----------

    #[test]
    fn is_occupied_is_true_for_anything_but_free() {
        assert!(!PortState::Free.is_occupied());
        assert!(PortState::Chroxy(1).is_occupied());
        assert!(PortState::Foreign(1).is_occupied());
        assert!(PortState::Chroxy(1).is_external_chroxy());
        assert!(!PortState::Foreign(1).is_external_chroxy());
        assert!(!PortState::Free.is_external_chroxy());
    }

    #[test]
    fn user_start_is_refused_for_every_held_port_when_the_app_is_idle() {
        for held in [PortState::Chroxy(8765), PortState::Foreign(8765)] {
            assert_eq!(user_start_decision(false, held), UserStartDecision::Refuse(held));
        }
        assert_eq!(user_start_decision(false, PortState::Free), UserStartDecision::Proceed);
    }

    #[test]
    fn user_restart_of_the_apps_own_running_server_proceeds() {
        for held in [PortState::Free, PortState::Chroxy(8765), PortState::Foreign(8765)] {
            assert_eq!(user_start_decision(true, held), UserStartDecision::Proceed);
        }
    }

    #[test]
    fn guarded_start_never_proceeds_on_a_held_port() {
        for action in [UserAction::Start, UserAction::Restart] {
            for held in [PortState::Chroxy(8765), PortState::Foreign(8765)] {
                let (mut proceeded, mut refused) = (false, None);
                run_guarded_user_start(action, false, || held, |h, m| refused = Some((h, m)), || proceeded = true);
                assert!(!proceeded, "{:?} on {:?} must not reach the start path", action, held);
                let (h, msg) = refused.expect("must refuse");
                assert_eq!(h, held);
                assert!(msg.contains("8765"));
            }
        }
    }

    #[test]
    fn guarded_start_proceeds_on_a_free_port_and_does_not_probe_an_active_server() {
        let (mut proceeded, mut refused) = (false, false);
        run_guarded_user_start(UserAction::Start, false, || PortState::Free, |_, _| refused = true, || proceeded = true);
        assert!(proceeded && !refused);

        // The app's own server is active: its own port must not be probed (it
        // would read as an external daemon) and the action proceeds.
        let (mut probed, mut proceeded) = (false, false);
        run_guarded_user_start(
            UserAction::Restart,
            true,
            || {
                probed = true;
                PortState::Chroxy(8765)
            },
            |_, _| panic!("must not refuse"),
            || proceeded = true,
        );
        assert!(proceeded && !probed);
    }

    #[test]
    fn guarded_stop_refuses_only_for_an_external_daemon() {
        let (mut proceeded, mut msg) = (false, None);
        run_guarded_stop(MenuState::Stopped, PortState::Chroxy(8765), |m| msg = Some(m), || proceeded = true);
        assert!(!proceeded);
        assert!(msg.unwrap().contains("8765"));

        for (menu, port) in [
            (MenuState::Stopped, PortState::Free),
            (MenuState::Stopped, PortState::Foreign(8765)),
            (MenuState::Running, PortState::Chroxy(8765)),
            (MenuState::Restarting, PortState::Chroxy(8765)),
        ] {
            let mut proceeded = false;
            run_guarded_stop(menu, port, |_| panic!("must not refuse {:?}/{:?}", menu, port), || proceeded = true);
            assert!(proceeded);
        }
    }

    #[test]
    fn external_port_needs_a_stopped_menu_and_a_verified_daemon() {
        assert_eq!(external_port(MenuState::Stopped, PortState::Chroxy(9)), Some(9));
        assert_eq!(external_port(MenuState::Running, PortState::Chroxy(9)), None);
        assert_eq!(external_port(MenuState::Stopped, PortState::Foreign(9)), None);
        assert_eq!(external_port(MenuState::Stopped, PortState::Free), None);
    }

    #[test]
    fn refusal_messages_name_the_port_and_the_way_out() {
        assert!(refusal_message(UserAction::Start, PortState::Chroxy(7)).contains("Open Dashboard"));
        assert!(refusal_message(UserAction::Restart, PortState::Chroxy(7)).contains("service manager"));
        assert!(refusal_message(UserAction::Start, PortState::Foreign(7)).contains("another program"));
    }

    // --- probe_port against real sockets -----------------------------------

    /// Serve `reply` (a full HTTP response) to every connection until dropped.
    fn serve(reply: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(reply.as_bytes());
            }
        });
        port
    }

    fn http_200(body: &str) -> &'static str {
        Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .into_boxed_str(),
        )
    }

    const T: Duration = Duration::from_millis(400);

    #[test]
    fn probe_recognises_a_chroxy_daemon() {
        let port = serve(http_200(GOOD));
        assert_eq!(probe_port(port, T), PortState::Chroxy(port));
    }

    #[test]
    fn probe_treats_a_200_that_is_not_chroxy_as_foreign() {
        let port = serve(http_200("hello"));
        assert_eq!(probe_port(port, T), PortState::Foreign(port));
    }

    #[test]
    fn probe_treats_a_404_as_foreign() {
        let port = serve("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(probe_port(port, T), PortState::Foreign(port));
    }

    #[test]
    fn probe_treats_a_listener_that_never_answers_as_foreign() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept into the backlog and say nothing: HTTP times out, TCP connects.
        assert_eq!(probe_port(port, T), PortState::Foreign(port));
        drop(listener);
    }

    #[test]
    fn probe_reports_a_closed_port_as_free() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert_eq!(probe_port(port, T), PortState::Free);
    }
}
