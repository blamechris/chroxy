//! Click-to-focus for native notifications (#7367).
//!
//! ## What the stock plugin cannot do
//!
//! `tauri-plugin-notification` 2.3.x gives the desktop no click callback at all:
//! `NotificationBuilder::show()` returns `Result<()>`, the desktop `show` hands the
//! notification to `notify-rust` and drops the handle, and the plugin's `onAction`
//! surface is built around `registerActionTypes`, an Android/iOS concept. So a
//! notification sent through it can never tell the app it was clicked.
//!
//! ## What this module does instead (macOS only)
//!
//! On macOS the plugin ends up in `NSUserNotificationCenter`; its click report
//! (`-userNotificationCenter:didActivateNotification:`) only exists on a
//! delegate, and `mac-notification-sys` makes a throwaway delegate per call that
//! blocks a thread until the user acts. Waiting on that would leak one thread
//! per ignored notification and, because each call replaces the centre's
//! delegate, route a click on an older card to the newest call. So instead this
//! module owns ONE long-lived delegate, delivers the notification itself, and
//! stamps the dashboard's session id into the notification's `userInfo`. The
//! click reads it back from the notification that was clicked, so the mapping
//! is by card, not by "whichever was sent last".
//!
//! A click raises the window ([`crate::window::show_window`]) and emits
//! [`NOTIFICATION_CLICKED_EVENT`] carrying the session id; the dashboard
//! (`utils/native-notifications.ts`) routes that to its session switch.
//!
//! ## Limits, stated plainly
//!
//! - **macOS, bundled builds only.** `NSUserNotificationCenter` needs a main
//!   bundle identifier; an unbundled `cargo run` / `tauri dev` binary has none,
//!   and there [`choose_delivery_path`] picks the plugin and nothing is clickable.
//! - **Windows and Linux are unchanged.** They keep the plugin path, so clicking
//!   a card does not select the session there. Nothing is faked: no focus
//!   heuristic is applied, because "the window gained focus after a notification"
//!   cannot tell a click from an unrelated Cmd-Tab.
//! - **`NSUserNotification` is the API the plugin already uses** (deprecated by
//!   Apple since macOS 11, still shipped). Moving to `UNUserNotificationCenter`
//!   would need the app's notification entitlement story re-verified, so this
//!   change deliberately stays on the same API rather than swap it unverified.
//! - **Every macOS notification goes through here**, lifecycle ones included,
//!   because the centre has a single delegate: if the plugin delivered a
//!   "Server restarted" card after a turn-complete card, its throwaway delegate
//!   would replace ours and the earlier card's click would be lost.

use serde::Serialize;

/// Tauri event the dashboard listens for.
pub const NOTIFICATION_CLICKED_EVENT: &str = "notification_clicked";

/// Longest title / body / session id kept from the webview. The values come from
/// the dashboard, which is trusted, but they end up in an OS surface that
/// truncates unpredictably, so bound them rather than pass a megabyte along.
pub const MAX_FIELD_LEN: usize = 1024;

/// Payload of [`NOTIFICATION_CLICKED_EVENT`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NotificationClickedPayload {
    pub session_id: String,
}

/// Which delivery route a notification takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryPath {
    /// Our own `NSUserNotificationCenter` delivery: clickable.
    Native,
    /// `tauri-plugin-notification`: fire-and-forget, no click.
    Plugin,
}

/// Pure routing decision (kept free of any platform call so it is testable on
/// every OS).
///
/// `Native` only on macOS, outside `tauri dev`, and only when the process has a
/// real main-bundle identifier. An unbundled binary has none, and calling
/// `NSUserNotificationCenter` without one is an uncaught Objective-C exception,
/// i.e. a crash, so this errs toward the plugin.
pub fn choose_delivery_path(is_macos: bool, is_dev: bool, bundle_id: Option<&str>) -> DeliveryPath {
    if is_macos && !is_dev && bundle_id.is_some_and(|b| !b.is_empty()) {
        DeliveryPath::Native
    } else {
        DeliveryPath::Plugin
    }
}

/// A notification request, sanitized.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionNotification {
    pub title: String,
    pub body: Option<String>,
    /// The session a click should select. `None` for notifications that are not
    /// about one session (server lifecycle): a click still raises the window.
    pub session_id: Option<String>,
}

/// Title shown when the webview sent nothing displayable.
pub const FALLBACK_TITLE: &str = "Chroxy";

/// Replace control characters with a space (keeping `\n` when `keep_newline`)
/// and cut to [`MAX_FIELD_LEN`] characters.
fn clean(s: &str, keep_newline: bool) -> String {
    s.chars()
        .map(|c| if c.is_control() && !(keep_newline && c == '\n') { ' ' } else { c })
        .take(MAX_FIELD_LEN)
        .collect()
}

/// Turn whatever the webview sent into something that can always be shown.
///
/// This never rejects. A rejection would send the dashboard to the plugin
/// fallback, and on macOS the plugin installs its own notification-centre
/// delegate, orphaning the click handler of every card already on screen. So an
/// over-long field is truncated, control characters become spaces, an empty
/// title becomes [`FALLBACK_TITLE`], and a session id that cannot be trusted as
/// an id (too long, or holding control characters) is dropped, since a truncated
/// id would name a different session; the card then simply has no session to
/// select and the click only raises the window.
pub fn sanitize_request(title: String, body: Option<String>, session_id: Option<String>) -> SessionNotification {
    let title = clean(&title, false).trim().to_string();
    let title = if title.is_empty() { FALLBACK_TITLE.to_string() } else { title };
    let body = body.map(|b| clean(&b, true)).filter(|b| !b.trim().is_empty());
    let session_id = session_id.filter(|s| {
        !s.is_empty() && s.chars().count() <= MAX_FIELD_LEN && !s.chars().any(|c| c.is_control())
    });
    SessionNotification { title, body, session_id }
}

// `cocoa` is deprecated in favour of objc2 and the `objc` 0.2 macros trip
// `unexpected_cfgs` under clippy; the rest of the crate has the same noise. This
// module is the one place that adds to it, so it is silenced here, and migrating
// the whole crate's AppKit use to objc2 is a separate change.
#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
pub mod macos {
    //! The `NSUserNotificationCenter` half. Uses the `objc` 0.2 + `cocoa` pair the
    //! crate already uses for the dock badge and window menu; no new dependency.
    //!
    //! Every class is looked up with `Class::get` and a missing one is an `Err`
    //! (the caller then takes the plugin fallback). The `class!` macro panics on a
    //! missing class, and this code runs inside `run_on_main_thread`, where a
    //! panic is not a recoverable error.

    use super::SessionNotification;
    use cocoa::base::{id, nil};
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};

    /// `userInfo` key holding the session id.
    const SESSION_KEY: &str = "chroxySessionId";
    const DELEGATE_CLASS: &str = "ChroxyNotificationDelegate";

    type ClickSink = Arc<dyn Fn(Option<String>) + Send + Sync>;

    static CLICK_SINK: Mutex<Option<ClickSink>> = Mutex::new(None);
    /// The delegate instance, as a raw address (it is retained for the life of
    /// the process; `NSUserNotificationCenter` only holds it weakly).
    static DELEGATE: AtomicUsize = AtomicUsize::new(0);

    fn class(name: &str) -> Result<&'static Class, String> {
        Class::get(name).ok_or_else(|| format!("Objective-C class {name} is not available"))
    }

    /// Install what a click does. Replaces any earlier sink.
    pub fn set_click_sink(sink: impl Fn(Option<String>) + Send + Sync + 'static) {
        *CLICK_SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(sink));
    }

    fn dispatch_click(session_id: Option<String>) {
        let sink = CLICK_SINK.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(sink) = sink {
            sink(session_id);
        }
    }

    /// An autoreleased `NSString`, or `nil` if the class is missing or `s` holds
    /// an interior NUL (a nil title/body is harmless to the notification centre).
    unsafe fn ns_string(s: &str) -> id {
        let (Ok(cls), Ok(c)) = (class("NSString"), CString::new(s)) else {
            return nil;
        };
        msg_send![cls, stringWithUTF8String: c.as_ptr()]
    }

    unsafe fn rust_string(ns: id) -> Option<String> {
        if ns == nil {
            return None;
        }
        let p: *const c_char = msg_send![ns, UTF8String];
        if p.is_null() {
            return None;
        }
        Some(CStr::from_ptr(p).to_string_lossy().into_owned())
    }

    /// `-userNotificationCenter:didActivateNotification:`
    ///
    /// Any activation counts as a click: the notifications are delivered without
    /// action buttons or a reply field, so contents-click is the only way to get
    /// here. The session id is read from the card that was clicked.
    extern "C" fn did_activate(_this: &Object, _sel: Sel, _center: id, notification: id) {
        let session_id = unsafe {
            if notification == nil {
                None
            } else {
                let info: id = msg_send![notification, userInfo];
                if info == nil {
                    None
                } else {
                    let value: id = msg_send![info, objectForKey: ns_string(SESSION_KEY)];
                    rust_string(value)
                }
            }
        };
        dispatch_click(session_id);
    }

    fn delegate_class() -> Result<&'static Class, String> {
        static REGISTERED: OnceLock<Result<&'static Class, String>> = OnceLock::new();
        REGISTERED
            .get_or_init(|| {
                let mut decl = ClassDecl::new(DELEGATE_CLASS, class("NSObject")?)
                    .ok_or_else(|| format!("{DELEGATE_CLASS} is already registered"))?;
                unsafe {
                    decl.add_method(
                        sel!(userNotificationCenter:didActivateNotification:),
                        did_activate as extern "C" fn(&Object, Sel, id, id),
                    );
                }
                Ok(decl.register())
            })
            .clone()
    }

    /// The one delegate instance, created on first use and kept for the life of
    /// the process. Idempotent: every call returns the same pointer.
    fn ensure_delegate() -> Result<id, String> {
        let existing = DELEGATE.load(Ordering::Acquire) as id;
        if existing != nil {
            return Ok(existing);
        }
        let created: id = unsafe { msg_send![delegate_class()?, new] };
        if created == nil {
            return Err("could not create the notification delegate".to_string());
        }
        match DELEGATE.compare_exchange(0, created as usize, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => Ok(created),
            // Lost a race; the winner's instance is the one in use.
            Err(winner) => Ok(winner as id),
        }
    }

    /// A fresh delegate instance (separate from the installed one) for tests.
    #[cfg(test)]
    fn new_delegate() -> id {
        unsafe { msg_send![delegate_class().unwrap(), new] }
    }

    /// Attach the delegate to the notification centre. Idempotent, and cheap
    /// enough to repeat on every delivery.
    ///
    /// Call it at app setup (so a click on a card left over from before a
    /// relaunch has a delegate to land on) and again before each delivery (so a
    /// stray plugin delivery cannot leave the centre pointing at the plugin's
    /// delegate). Main thread.
    pub fn install_delegate() -> Result<(), String> {
        unsafe {
            let center: id = msg_send![class("NSUserNotificationCenter")?, defaultUserNotificationCenter];
            if center == nil {
                return Err("NSUserNotificationCenter unavailable".to_string());
            }
            let _: () = msg_send![center, setDelegate: ensure_delegate()?];
        }
        Ok(())
    }

    /// The main bundle identifier, or `None` for an unbundled binary.
    pub fn bundle_identifier() -> Option<String> {
        unsafe {
            let bundle: id = msg_send![class("NSBundle").ok()?, mainBundle];
            if bundle == nil {
                return None;
            }
            let ident: id = msg_send![bundle, bundleIdentifier];
            rust_string(ident)
        }
    }

    /// Whether the native route can be used right now (see
    /// [`super::choose_delivery_path`]).
    pub fn available() -> bool {
        super::choose_delivery_path(true, tauri::is_dev(), bundle_identifier().as_deref())
            == super::DeliveryPath::Native
    }

    /// Build the `NSUserNotification` for `n` (autoreleased). Split from
    /// [`deliver`] so the test builds exactly what is delivered.
    unsafe fn build_card(n: &SessionNotification) -> Result<id, String> {
        let note: id = msg_send![class("NSUserNotification")?, new];
        if note == nil {
            return Err("could not create an NSUserNotification".to_string());
        }
        let note: id = msg_send![note, autorelease];
        let _: () = msg_send![note, setTitle: ns_string(&n.title)];
        if let Some(body) = &n.body {
            let _: () = msg_send![note, setInformativeText: ns_string(body)];
        }
        // Without this a banner-style card is given a "Show" button whose
        // activation type differs; contents-click is the one path we handle.
        let _: () = msg_send![note, setHasActionButton: false];
        // Deliberately NO `setIdentifier:`. The plugin never set one, so every
        // completion used to stack its own card. An identifier makes the centre
        // REPLACE an earlier card with the same one, and a replacement may arrive
        // without a banner, which would hide a repeat turn-complete or permission
        // notification. Keep the stacking behaviour; a tag from the webview is
        // not even accepted.
        if let Some(session) = &n.session_id {
            let info: id = msg_send![
                class("NSDictionary")?,
                dictionaryWithObject: ns_string(session)
                forKey: ns_string(SESSION_KEY)
            ];
            let _: () = msg_send![note, setUserInfo: info];
        }
        Ok(note)
    }

    /// Deliver `n` through `NSUserNotificationCenter` with our delegate attached.
    ///
    /// Call on the main thread. Any `Err` (missing class, no centre) means
    /// nothing was delivered and the caller should use the plugin.
    pub fn deliver(n: &SessionNotification) -> Result<(), String> {
        objc::rc::autoreleasepool(|| unsafe {
            install_delegate()?;
            let center: id = msg_send![class("NSUserNotificationCenter")?, defaultUserNotificationCenter];
            let _: () = msg_send![center, deliverNotification: build_card(n)?];
            Ok(())
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex as StdMutex;

        /// The sink is process-global, so the tests that set it must not overlap.
        static SERIAL: StdMutex<()> = StdMutex::new(());

        fn request(session: Option<&str>) -> SessionNotification {
            SessionNotification {
                title: "Chroxy: api".to_string(),
                body: Some("Finished".to_string()),
                session_id: session.map(str::to_string),
            }
        }

        /// The card `deliver` would hand to the notification centre (there is no
        /// centre in a bare test binary, so it cannot be delivered here).
        unsafe fn card(session: Option<&str>) -> id {
            build_card(&request(session)).unwrap()
        }

        fn click(note: id) -> Vec<Option<String>> {
            let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink_seen = seen.clone();
            set_click_sink(move |s| sink_seen.lock().unwrap().push(s));
            unsafe {
                let delegate = new_delegate();
                let _: () = msg_send![delegate, userNotificationCenter: nil didActivateNotification: note];
            }
            let out = seen.lock().unwrap().clone();
            out
        }

        #[test]
        fn click_reports_the_session_stamped_on_that_card() {
            let got = objc::rc::autoreleasepool(|| click(unsafe { card(Some("sess-42")) }));
            assert_eq!(got, vec![Some("sess-42".to_string())]);
        }

        #[test]
        fn click_on_a_card_without_a_session_still_fires_with_none() {
            // A lifecycle card ("Server ready") has no session: the click must
            // still reach the sink so the window is raised.
            let got = objc::rc::autoreleasepool(|| click(unsafe { card(None) }));
            assert_eq!(got, vec![None]);
        }

        #[test]
        fn two_cards_report_their_own_sessions() {
            // The mapping is by card, not by last-sent: clicking the older card
            // after a newer one exists must still name the older session.
            let (a, b) = objc::rc::autoreleasepool(|| {
                let first = unsafe { card(Some("older")) };
                let second = unsafe { card(Some("newer")) };
                (click(first), click(second))
            });
            assert_eq!(a, vec![Some("older".to_string())]);
            assert_eq!(b, vec![Some("newer".to_string())]);
        }

        #[test]
        fn card_carries_title_and_body_but_no_identifier_and_no_action_button() {
            objc::rc::autoreleasepool(|| unsafe {
                let note = card(Some("s"));
                assert_eq!(rust_string(msg_send![note, title]).as_deref(), Some("Chroxy: api"));
                assert_eq!(rust_string(msg_send![note, informativeText]).as_deref(), Some("Finished"));
                // No identifier: a repeat completion must stack a new card, not
                // replace the last one (a replacement can arrive without a banner).
                let ident: id = msg_send![note, identifier];
                assert_eq!(ident, nil);
                let has_button: bool = msg_send![note, hasActionButton];
                assert!(!has_button);
            });
        }

        #[test]
        fn a_missing_class_is_an_error_not_a_panic() {
            assert!(class("ChroxyNoSuchClass7367").is_err());
            assert!(class("NSUserNotification").is_ok());
        }

        #[test]
        fn the_delegate_is_created_once_however_often_it_is_asked_for() {
            let first = ensure_delegate().unwrap();
            let second = ensure_delegate().unwrap();
            assert!(first != nil);
            assert_eq!(first, second);
        }

        #[test]
        fn bundle_identifier_is_none_for_the_test_binary() {
            // `cargo test` runs an unbundled binary, which is exactly the case
            // `available()` must refuse so the app never calls the notification
            // centre without a bundle.
            assert_eq!(bundle_identifier(), None);
            assert!(!available());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_only_for_a_bundled_non_dev_macos_build() {
        assert_eq!(choose_delivery_path(true, false, Some("com.blamechris.chroxy")), DeliveryPath::Native);
    }

    #[test]
    fn dev_build_uses_the_plugin_even_with_a_bundle_id() {
        assert_eq!(choose_delivery_path(true, true, Some("com.blamechris.chroxy")), DeliveryPath::Plugin);
    }

    #[test]
    fn unbundled_macos_binary_uses_the_plugin() {
        assert_eq!(choose_delivery_path(true, false, None), DeliveryPath::Plugin);
        assert_eq!(choose_delivery_path(true, false, Some("")), DeliveryPath::Plugin);
    }

    #[test]
    fn windows_and_linux_always_use_the_plugin() {
        assert_eq!(choose_delivery_path(false, false, Some("com.blamechris.chroxy")), DeliveryPath::Plugin);
        assert_eq!(choose_delivery_path(false, false, None), DeliveryPath::Plugin);
    }

    #[test]
    fn sanitize_keeps_a_normal_request() {
        let n = sanitize_request(
            "Chroxy: api".into(),
            Some("Finished — awaiting your input.".into()),
            Some("sess-1".into()),
        );
        assert_eq!(n.title, "Chroxy: api");
        assert_eq!(n.body.as_deref(), Some("Finished — awaiting your input."));
        assert_eq!(n.session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn sanitize_never_rejects_an_empty_title() {
        assert_eq!(sanitize_request(String::new(), None, None).title, FALLBACK_TITLE);
        assert_eq!(sanitize_request("  \n\t ".into(), None, None).title, FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_truncates_instead_of_rejecting() {
        let long = "x".repeat(MAX_FIELD_LEN + 500);
        let n = sanitize_request(long.clone(), Some(long), None);
        assert_eq!(n.title.chars().count(), MAX_FIELD_LEN);
        assert_eq!(n.body.unwrap().chars().count(), MAX_FIELD_LEN);
    }

    #[test]
    fn sanitize_truncates_on_character_boundaries() {
        // Multi-byte characters must not be cut mid-sequence (a byte slice would
        // panic here).
        let n = sanitize_request("é".repeat(MAX_FIELD_LEN + 10), None, None);
        assert_eq!(n.title.chars().count(), MAX_FIELD_LEN);
    }

    #[test]
    fn sanitize_replaces_control_characters_and_keeps_body_newlines() {
        let n = sanitize_request("a\u{0}b\nc".into(), Some("l1\nl2\u{7}".into()), None);
        assert_eq!(n.title, "a b c");
        assert_eq!(n.body.as_deref(), Some("l1\nl2 "));
    }

    #[test]
    fn sanitize_drops_a_blank_body() {
        assert_eq!(sanitize_request("t".into(), Some("  ".into()), None).body, None);
    }

    #[test]
    fn sanitize_drops_an_untrustworthy_session_id_rather_than_truncating_it() {
        // A truncated id would name a different session.
        for bad in ["".to_string(), "x".repeat(MAX_FIELD_LEN + 1), "a\nb".to_string(), "a\u{0}b".to_string()] {
            assert_eq!(sanitize_request("t".into(), None, Some(bad)).session_id, None);
        }
    }

    #[test]
    fn payload_serializes_with_snake_case_session_id() {
        let json = serde_json::to_string(&NotificationClickedPayload { session_id: "s".into() }).unwrap();
        assert_eq!(json, r#"{"session_id":"s"}"#);
    }
}
