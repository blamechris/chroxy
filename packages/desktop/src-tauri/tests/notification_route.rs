//! Pins that every notification the app raises goes through one function (#7367).
//!
//! On macOS the notification centre has a single delegate. The plugin installs its
//! own on every send, so if any call site delivered a card through
//! `tauri-plugin-notification` directly, the click handler of a turn-complete card
//! sent earlier would be orphaned and clicking it would do nothing. The only
//! permitted plugin call is the fallback inside `show_via_plugin`, reached from
//! `deliver_notification`.
//!
//! The call sites are Tauri glue a unit test cannot run, so this scrapes the
//! source in the style of `command_drift.rs`; every assertion collapses to a
//! boolean first so a failure never carries the whole file as its message.

use std::fs;
use std::path::PathBuf;

fn lib_rs() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn fn_body(src: &str, name: &str) -> String {
    let header = format!("\nfn {}(", name);
    let start = src.find(&header).unwrap_or_else(|| panic!("fn {} not found in lib.rs", name));
    let rest = &src[start + 1..];
    let end = rest.find("\n}\n").unwrap_or_else(|| panic!("fn {} has no closing brace", name));
    rest[..end].to_string()
}

#[test]
fn only_show_via_plugin_touches_the_notification_plugin() {
    let src = lib_rs();
    let uses = src.matches(".notification()").count();
    let ok = uses == 1 && fn_body(&src, "show_via_plugin").contains(".notification()");
    assert!(
        ok,
        "expected exactly one `.notification()` call, inside show_via_plugin; found {} in lib.rs",
        uses
    );
}

#[test]
fn lifecycle_notifications_and_the_dashboard_command_share_deliver_notification() {
    let src = lib_rs();
    let lifecycle = fn_body(&src, "send_notification");
    let command = fn_body(&src, "send_session_notification");
    assert!(lifecycle.contains("deliver_notification("), "send_notification must call deliver_notification");
    assert!(command.contains("deliver_notification("), "send_session_notification must call deliver_notification");
}

#[test]
fn the_command_validates_before_delivering() {
    let src = lib_rs();
    let command = fn_body(&src, "send_session_notification");
    let validate = command.find("validate_request(");
    let deliver = command.find("deliver_notification(");
    assert!(
        matches!((validate, deliver), (Some(v), Some(d)) if v < d),
        "send_session_notification must call validate_request before deliver_notification"
    );
}

/// The dashboard half of the contract lives in another package, and a typo on
/// either side fails silently (an unknown event is never delivered; an unknown
/// command only falls back to the plugin). Pin the three names it depends on.
#[test]
fn dashboard_uses_the_same_event_command_and_payload_field() {
    let rust = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/notification_click.rs"))
        .expect("read notification_click.rs");
    let ts_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../dashboard/src/utils/native-notifications.ts");
    let ts = fs::read_to_string(&ts_path).unwrap_or_else(|e| panic!("read {}: {}", ts_path.display(), e));

    let event_in_rust = rust.contains("NOTIFICATION_CLICKED_EVENT: &str = \"notification_clicked\"");
    let event_in_ts = ts.contains("NOTIFICATION_CLICKED_EVENT = 'notification_clicked'");
    let command_in_ts = ts.contains("'send_session_notification'");
    let command_in_rust = lib_rs().contains("fn send_session_notification(");
    let field_in_rust = rust.contains("pub session_id: String");
    let field_in_ts = ts.contains("session_id?: unknown");
    assert!(event_in_rust, "Rust event name changed");
    assert!(event_in_ts, "dashboard event name differs from Rust");
    assert!(command_in_rust && command_in_ts, "command name differs between Rust and the dashboard");
    assert!(field_in_rust && field_in_ts, "click payload field differs between Rust and the dashboard");
}
