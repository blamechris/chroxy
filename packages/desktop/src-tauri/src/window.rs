use crate::handoff;
use tauri::{AppHandle, Emitter, Manager};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const MAIN_LABEL: &str = "main";

/// The bundled loading page is showing an error or stopped state, so nothing is
/// in flight and the port watcher may point the window at a daemon that comes up
/// (#9078). Set by [`emit_server_error`] / [`emit_server_stopped`]; cleared when a
/// handoff begins ([`AppSink::announce`], through [`clear_awaiting`]) and by every
/// new attempt ([`begin_attempt`]), so an in-progress start, service wait or
/// connect is never raced.
static AWAITING_DAEMON: AtomicBool = AtomicBool::new(false);

/// True while the bundled page shows an error or stopped state (see [`AWAITING_DAEMON`]).
pub fn awaiting_daemon() -> bool {
    AWAITING_DAEMON.load(Ordering::SeqCst)
}

/// Counts every attempt to point the window at a daemon (user and watcher): the
/// newest one wins, and a handoff whose generation is no longer this value drops
/// its effects (see [`emit_server_ready_for_attempt`]).
static ATTEMPT: AtomicU64 = AtomicU64::new(0);

/// Counts user attempts only, so the watcher can tell that one began (and
/// possibly failed) between two of its samples.
static USER_ATTEMPTS: AtomicU64 = AtomicU64::new(0);

/// The current attempt generation.
pub fn attempt_generation() -> u64 {
    ATTEMPT.load(Ordering::SeqCst)
}

/// How many user attempts have begun.
pub fn user_attempts() -> u64 {
    USER_ATTEMPTS.load(Ordering::SeqCst)
}

/// Take the waiting state, once: `Some(generation)` for the one caller that finds
/// the page still waiting, `None` if an attempt began (or another caller took it)
/// since. The claim is itself an attempt (it supersedes older ones) but not a user
/// attempt. The port watcher claims before it hands off, so it never races an
/// attempt.
pub fn claim_awaiting() -> Option<u64> {
    AWAITING_DAEMON
        .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1)
}

/// A new user attempt (Start, Restart, Connect) is beginning: the page is no
/// longer waiting, whatever it showed before, and any older handoff is stale.
/// Returns the new generation.
pub fn begin_attempt() -> u64 {
    AWAITING_DAEMON.store(false, Ordering::SeqCst);
    USER_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1
}

/// A handoff has begun: the page is no longer waiting. Unlike [`begin_attempt`]
/// this does not start a new generation, so a handoff never invalidates itself.
pub fn clear_awaiting() {
    AWAITING_DAEMON.store(false, Ordering::SeqCst);
}

/// Percent-encode a string for safe use in URL query values.
/// Encodes everything except unreserved characters (RFC 3986: A-Z a-z 0-9 - _ . ~).
fn url_encode(s: &str) -> String {
    let mut encoded = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Build the dashboard URL for the given port and optional token.
pub fn dashboard_url(port: u16, token: Option<&str>) -> String {
    match token {
        Some(t) => format!("http://127.0.0.1:{}/dashboard?token={}", port, url_encode(t)),
        None => format!("http://127.0.0.1:{}/dashboard", port),
    }
}

// -- Tauri event payloads --

#[derive(Clone, Serialize)]
pub struct ServerReadyPayload {
    pub port: u16,
    pub token: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
pub struct ServerErrorPayload {
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct ServerRestartingPayload {
    pub attempt: u32,
    pub max_attempts: u32,
    pub backoff_secs: u64,
}

// -- Event emission (replaces eval-based injection) --

/// How long one handoff challenge may take.
const HANDOFF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The token that makes the daemon on `port` prove itself now (see
/// [`crate::tray_state::prove_daemon`]); this is the prover every handoff asks.
fn prove_for_handoff(port: u16) -> Option<String> {
    crate::tray_state::prove_daemon(port, HANDOFF_TIMEOUT)
}

/// Show that the daemon on `port` could not be verified. The tray's port state
/// takes the observation through its two-observation rule, so one missed
/// challenge does not by itself flip a daemon the tray was showing.
fn refuse_handoff(app: &AppHandle, port: u16) {
    // Port 0 is "unset", never a port something holds: reporting it would turn a
    // tray that correctly shows a daemon into Foreign(0) (#9077).
    if port != 0 {
        crate::observe_port(app, crate::tray_state::PortState::Foreign(port));
    }
    emit_server_error(
        app,
        &format!(
            "The server on port {} could not be verified as the Chroxy daemon for this app (no matching access token, or no valid proof), so the dashboard was not opened.",
            port
        ),
    );
}

/// Show that the daemon on `port` could not be verified (see [`refuse_handoff`]).
pub fn show_handoff_refusal(app: &AppHandle, port: u16) {
    refuse_handoff(app, port);
}

/// The real [`handoff::Sink`]: the `server_ready` event, the loading page and the
/// main window.
struct AppSink(AppHandle);

impl handoff::Sink for AppSink {
    fn announce(&self, port: u16, token: &str, url: &str) {
        // A handoff has begun: the page is no longer waiting for a daemon (#9078).
        clear_awaiting();
        let payload = ServerReadyPayload {
            port,
            token: token.to_string(),
            url: url.to_string(),
        };
        let _ = self.0.emit("server_ready", payload);
        show_window(&self.0);

        // Update loading page status to "Connected!"
        if let Some(window) = self.0.get_webview_window(MAIN_LABEL) {
            let _ = window.eval(
                "try { \
                    var s = document.getElementById('status'); \
                    if (s) { s.textContent = 'Connected!'; s.className = 'status'; } \
                    var sp = document.getElementById('spinner'); \
                    if (sp) sp.style.display = 'none'; \
                } catch(e) {}"
            );
        }
    }

    fn navigate(&self, url: &str) {
        if let Some(window) = self.0.get_webview_window(MAIN_LABEL) {
            // Use eval to navigate — window.navigate() from tauri:// to http://
            // may be blocked by same-origin policy in the embedded webview.
            let escaped = url.replace('\\', "\\\\").replace('\'', "\\'");
            let _ = window.eval(&format!("window.location.href = '{}'", escaped));
        }
    }

    fn refuse(&self, port: u16) {
        refuse_handoff(&self.0, port);
    }
}

/// Hand the dashboard to the daemon on `port`, silently refusing: returns `false`
/// when it does not prove itself, without showing anything.
///
/// The access token goes only to a daemon that has just answered a fresh health
/// challenge ([`handoff::begin`], before the `server_ready` event whose payload
/// carries the token and URL) and again after the pause, immediately before the
/// navigation ([`handoff::finish`]). Blocking (up to two network round trips):
/// call it off the main thread.
pub fn try_server_ready(app: &AppHandle, port: u16) -> bool {
    let sink = AppSink(app.clone());
    if !handoff::begin(&prove_for_handoff, &sink, port) {
        return false;
    }
    // Navigate to dashboard after a brief pause so user sees "Connected!"
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        handoff::finish(&prove_for_handoff, &sink, port);
    });
    true
}

/// [`try_server_ready`], showing the refusal when the daemon does not prove itself.
/// Tauri v2's CSP nonce blocks both inline and external scripts in the embedded
/// frontend, so status updates go in via eval() (which is nonce-aware) and the
/// navigation happens from Rust.
pub fn emit_server_ready(app: &AppHandle, port: u16) -> bool {
    let ok = try_server_ready(app, port);
    if !ok {
        refuse_handoff(app, port);
    }
    ok
}

/// [`emit_server_ready`] for the attempt `generation` (from [`begin_attempt`] or
/// [`claim_awaiting`]): every effect, including the delayed navigation and the
/// refusal, happens only while that attempt is still the newest. A superseded
/// attempt asks for its proofs, does nothing else and returns `true` (it is not a
/// refusal). Blocking: call it off the main thread.
pub fn emit_server_ready_for_attempt(app: &AppHandle, port: u16, generation: u64) -> bool {
    let sink = handoff::Current {
        inner: AppSink(app.clone()),
        is_current: move || attempt_generation() == generation,
    };
    if !handoff::begin(&prove_for_handoff, &sink, port) {
        if (sink.is_current)() {
            handoff::Sink::refuse(&sink, port);
            return false;
        }
        return true;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        handoff::finish(&prove_for_handoff, &sink, port);
    });
    true
}

/// Open the dashboard's settings panel on the daemon at `port`, after it proves
/// itself; otherwise show the refusal.
pub fn open_settings(app: &AppHandle, port: u16) -> bool {
    handoff::open_settings(&prove_for_handoff, &AppSink(app.clone()), port)
}

/// Emit `server_stopped` event and update loading page if visible.
pub fn emit_server_stopped(app: &AppHandle) {
    AWAITING_DAEMON.store(true, Ordering::SeqCst);
    let _ = app.emit("server_stopped", ());
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(
            "try { \
                var s = document.getElementById('status'); \
                if (s) { s.textContent = 'Server stopped'; s.className = 'status'; } \
                var sp = document.getElementById('spinner'); \
                if (sp) sp.style.display = 'none'; \
            } catch(e) {}"
        );
    }
    show_window(app);
}

/// Emit `server_error` event and update loading page if visible.
pub fn emit_server_error(app: &AppHandle, message: &str) {
    AWAITING_DAEMON.store(true, Ordering::SeqCst);
    let payload = ServerErrorPayload {
        message: message.to_string(),
    };
    let _ = app.emit("server_error", payload);
    let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(&format!(
            "try {{ \
                var s = document.getElementById('status'); \
                if (s) {{ s.textContent = '{}'; s.className = 'status error'; }} \
                var sp = document.getElementById('spinner'); \
                if (sp) sp.style.display = 'none'; \
            }} catch(e) {{}}",
            escaped
        ));
    }
    show_window(app);
}

/// Emit `server_restarting` event with restart progress.
pub fn emit_server_restarting(app: &AppHandle, attempt: u32, max_attempts: u32, backoff_secs: u64) {
    let payload = ServerRestartingPayload {
        attempt,
        max_attempts,
        backoff_secs,
    };
    let _ = app.emit("server_restarting", payload);
    show_window(app);
}

/// Emit `navigate_console` event.
/// Dashboard listens and switches to console viewMode.
pub fn emit_navigate_console(app: &AppHandle) {
    let _ = app.emit("navigate_console", ());
    show_window(app);
}

// -- Window management (no eval) --

/// Percent-encode HTML for use in a data URI.
/// Encodes characters that are not safe in URIs (spaces, angle brackets, etc.).
pub fn percent_encode_html(html: &str) -> String {
    let mut encoded = String::with_capacity(html.len() * 2);
    for byte in html.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')'
            | b';' | b':' | b'@' | b',' | b'/'
            | b'=' | b'&' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Show, un-minimize, and focus the main window. Un-minimizing first means a
/// "summon" (tray item or global hotkey) reliably brings the window forward even
/// when it was minimized to the Dock — `show()` + `set_focus()` alone leave a
/// minimized window minimized (#5281 ②). Mirrors the single-instance focus path.
pub fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_leaves_unreserved_chars() {
        assert_eq!(url_encode("hello"), "hello");
        assert_eq!(url_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn url_encode_encodes_special_chars() {
        assert_eq!(url_encode("a b"), "a%20b");
        assert_eq!(url_encode("a+b"), "a%2Bb");
        assert_eq!(url_encode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn dashboard_url_without_token() {
        let url = dashboard_url(8765, None);
        assert_eq!(url, "http://127.0.0.1:8765/dashboard");
    }

    #[test]
    fn dashboard_url_with_token() {
        let url = dashboard_url(8765, Some("abc-123"));
        assert_eq!(url, "http://127.0.0.1:8765/dashboard?token=abc-123");
    }

    #[test]
    fn dashboard_url_encodes_token_special_chars() {
        let url = dashboard_url(9000, Some("key with spaces&more"));
        assert!(url.contains("key%20with%20spaces%26more"));
    }

    #[test]
    fn server_ready_payload_serializes() {
        let payload = ServerReadyPayload {
            port: 8765,
            token: "abc".to_string(),
            url: "http://127.0.0.1:8765/dashboard?token=abc".to_string(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["port"], 8765);
        assert_eq!(json["token"], "abc");
        assert!(json["url"].as_str().unwrap().contains("/dashboard"));
    }

    #[test]
    fn server_error_payload_serializes() {
        let payload = ServerErrorPayload {
            message: "something went wrong".to_string(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["message"], "something went wrong");
    }

    #[test]
    fn server_restarting_payload_serializes() {
        let payload = ServerRestartingPayload {
            attempt: 2,
            max_attempts: 3,
            backoff_secs: 6,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["attempt"], 2);
        assert_eq!(json["max_attempts"], 3);
        assert_eq!(json["backoff_secs"], 6);
    }

    #[test]
    fn percent_encode_html_preserves_safe_chars() {
        assert_eq!(percent_encode_html("hello"), "hello");
        assert_eq!(percent_encode_html("/path=val&k=v"), "/path=val&k=v");
        assert_eq!(percent_encode_html("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn percent_encode_html_encodes_angle_brackets_and_spaces() {
        let encoded = percent_encode_html("<div>hello world</div>");
        assert!(encoded.contains("%3C"));  // <
        assert!(encoded.contains("%3E"));  // >
        assert!(encoded.contains("%20"));  // space
        assert!(!encoded.contains('<'));
        assert!(!encoded.contains('>'));
    }

    #[test]
    fn percent_encode_html_encodes_hash_and_question_mark() {
        // # and ? are URI-reserved and must be encoded in data URI bodies
        let encoded = percent_encode_html("color: #ff0000; url?token=abc");
        assert!(encoded.contains("%23"), "# must be percent-encoded");
        assert!(encoded.contains("%3F"), "? must be percent-encoded");
        assert!(!encoded.contains('#'), "literal # must not appear");
        assert!(!encoded.contains('?'), "literal ? must not appear");
    }

    #[test]
    fn percent_encode_html_encodes_brackets() {
        let encoded = percent_encode_html("arr[0]");
        assert!(encoded.contains("%5B"), "[ must be percent-encoded");
        assert!(encoded.contains("%5D"), "] must be percent-encoded");
    }

    #[test]
    fn attempt_generations_order_handoffs_and_a_handoff_does_not_supersede_itself() {
        // No other test touches these statics; the counters only grow, so compare deltas.
        AWAITING_DAEMON.store(true, Ordering::SeqCst);
        let users = user_attempts();
        let claimed = claim_awaiting().expect("the page was waiting");
        assert_eq!(attempt_generation(), claimed);
        assert_eq!(user_attempts(), users, "a watcher claim is not a user attempt");
        assert_eq!(claim_awaiting(), None, "a second claim finds nothing waiting");

        clear_awaiting();
        assert_eq!(attempt_generation(), claimed, "a handoff beginning does not supersede itself");

        let newer = begin_attempt();
        assert!(newer > claimed && attempt_generation() == newer, "a user attempt supersedes the claim");
        assert_eq!(user_attempts(), users + 1);
        assert!(!awaiting_daemon());
    }
}
