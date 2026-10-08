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

/// Longest title / body / id / tag accepted from the webview. The values come
/// from the dashboard, which is trusted, but they end up in an OS surface that
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

/// A notification request, validated.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionNotification {
    pub title: String,
    pub body: Option<String>,
    /// The session a click should select. `None` for notifications that are not
    /// about one session (server lifecycle): a click still raises the window.
    pub session_id: Option<String>,
    /// Collapse key: delivering a second notification with the same tag
    /// replaces the first rather than stacking.
    pub tag: Option<String>,
}

fn field_ok(s: &str) -> bool {
    s.chars().count() <= MAX_FIELD_LEN && !s.chars().any(|c| c.is_control() && c != '\n')
}

/// Validate what the webview sent. An empty `session_id` / `tag` is treated as
/// absent (the dashboard never sends one, but "" must not become a key that every
/// card shares).
pub fn validate_request(
    title: String,
    body: Option<String>,
    session_id: Option<String>,
    tag: Option<String>,
) -> Result<SessionNotification, String> {
    if title.is_empty() {
        return Err("notification title is empty".to_string());
    }
    if title.chars().count() > MAX_FIELD_LEN || title.chars().any(|c| c.is_control()) {
        return Err("notification title is too long or has control characters".to_string());
    }
    if let Some(b) = &body {
        if b.chars().count() > MAX_FIELD_LEN {
            return Err("notification body is too long".to_string());
        }
    }
    let session_id = session_id.filter(|s| !s.is_empty());
    if let Some(s) = &session_id {
        if !field_ok(s) || s.contains('\n') {
            return Err("session id is too long or has control characters".to_string());
        }
    }
    let tag = tag.filter(|s| !s.is_empty());
    if let Some(t) = &tag {
        if !field_ok(t) || t.contains('\n') {
            return Err("notification tag is too long or has control characters".to_string());
        }
    }
    Ok(SessionNotification { title, body, session_id, tag })
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

    use super::SessionNotification;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, Once};

    /// `userInfo` key holding the session id.
    const SESSION_KEY: &str = "chroxySessionId";
    const DELEGATE_CLASS: &str = "ChroxyNotificationDelegate";

    type ClickSink = Arc<dyn Fn(Option<String>) + Send + Sync>;

    static CLICK_SINK: Mutex<Option<ClickSink>> = Mutex::new(None);
    /// The delegate instance, as a raw address (it is retained for the life of
    /// the process; `NSUserNotificationCenter` only holds it weakly).
    static DELEGATE: AtomicUsize = AtomicUsize::new(0);

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

    unsafe fn ns_string(s: &str) -> id {
        let ns: id = NSString::alloc(nil).init_str(s);
        msg_send![ns, autorelease]
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

    fn delegate_class() -> &'static Class {
        static REGISTER: Once = Once::new();
        REGISTER.call_once(|| {
            let mut decl = ClassDecl::new(DELEGATE_CLASS, class!(NSObject))
                .expect("ChroxyNotificationDelegate registered twice");
            unsafe {
                decl.add_method(
                    sel!(userNotificationCenter:didActivateNotification:),
                    did_activate as extern "C" fn(&Object, Sel, id, id),
                );
            }
            decl.register();
        });
        Class::get(DELEGATE_CLASS).expect("ChroxyNotificationDelegate not registered")
    }

    /// A fresh delegate instance (separate from the installed one) for tests.
    #[cfg(test)]
    fn new_delegate() -> id {
        unsafe { msg_send![delegate_class(), new] }
    }

    /// The main bundle identifier, or `None` for an unbundled binary.
    pub fn bundle_identifier() -> Option<String> {
        unsafe {
            let bundle: id = msg_send![class!(NSBundle), mainBundle];
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
    unsafe fn build_card(n: &SessionNotification) -> id {
        let note: id = msg_send![class!(NSUserNotification), new];
        let note: id = msg_send![note, autorelease];
        let _: () = msg_send![note, setTitle: ns_string(&n.title)];
        if let Some(body) = &n.body {
            let _: () = msg_send![note, setInformativeText: ns_string(body)];
        }
        // Without this a banner-style card is given a "Show" button whose
        // activation type differs; contents-click is the one path we handle.
        let _: () = msg_send![note, setHasActionButton: false];
        if let Some(tag) = &n.tag {
            let _: () = msg_send![note, setIdentifier: ns_string(tag)];
        }
        if let Some(session) = &n.session_id {
            let info: id = msg_send![
                class!(NSDictionary),
                dictionaryWithObject: ns_string(session)
                forKey: ns_string(SESSION_KEY)
            ];
            let _: () = msg_send![note, setUserInfo: info];
        }
        note
    }

    /// Deliver `n` through `NSUserNotificationCenter` with our delegate attached.
    ///
    /// Call on the main thread. Re-asserts the delegate every time: it is one
    /// pointer write, and it means a stray plugin delivery (the dev-build
    /// fallback) cannot leave the centre pointing at someone else's delegate.
    pub fn deliver(n: &SessionNotification) -> Result<(), String> {
        objc::rc::autoreleasepool(|| unsafe {
            let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            if center == nil {
                return Err("NSUserNotificationCenter unavailable".to_string());
            }

            let mut delegate = DELEGATE.load(Ordering::Acquire) as id;
            if delegate == nil {
                delegate = msg_send![delegate_class(), new];
                DELEGATE.store(delegate as usize, Ordering::Release);
            }
            let _: () = msg_send![center, setDelegate: delegate];

            let _: () = msg_send![center, deliverNotification: build_card(n)];
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
                tag: Some("chroxy-turn-x".to_string()),
            }
        }

        /// The card `deliver` would hand to the notification centre (there is no
        /// centre in a bare test binary, so it cannot be delivered here).
        unsafe fn card(session: Option<&str>) -> id {
            build_card(&request(session))
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
        fn card_carries_title_body_tag_and_no_action_button() {
            objc::rc::autoreleasepool(|| unsafe {
                let note = card(Some("s"));
                assert_eq!(rust_string(msg_send![note, title]).as_deref(), Some("Chroxy: api"));
                assert_eq!(rust_string(msg_send![note, informativeText]).as_deref(), Some("Finished"));
                assert_eq!(rust_string(msg_send![note, identifier]).as_deref(), Some("chroxy-turn-x"));
                let has_button: bool = msg_send![note, hasActionButton];
                assert!(!has_button);
            });
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
    fn validate_accepts_a_normal_request() {
        let n = validate_request(
            "Chroxy: api".into(),
            Some("Finished — awaiting your input.".into()),
            Some("sess-1".into()),
            Some("chroxy-turn-sess-1".into()),
        )
        .unwrap();
        assert_eq!(n.session_id.as_deref(), Some("sess-1"));
        assert_eq!(n.tag.as_deref(), Some("chroxy-turn-sess-1"));
    }

    #[test]
    fn validate_treats_empty_session_and_tag_as_absent() {
        let n = validate_request("t".into(), None, Some(String::new()), Some(String::new())).unwrap();
        assert_eq!(n.session_id, None);
        assert_eq!(n.tag, None);
    }

    #[test]
    fn validate_rejects_empty_title() {
        assert!(validate_request(String::new(), None, None, None).is_err());
    }

    #[test]
    fn validate_rejects_oversized_and_control_fields() {
        let long = "x".repeat(MAX_FIELD_LEN + 1);
        assert!(validate_request(long.clone(), None, None, None).is_err());
        assert!(validate_request("t".into(), Some(long.clone()), None, None).is_err());
        assert!(validate_request("t".into(), None, Some(long.clone()), None).is_err());
        assert!(validate_request("t".into(), None, None, Some(long)).is_err());
        assert!(validate_request("t\u{0}".into(), None, None, None).is_err());
        assert!(validate_request("t".into(), None, Some("a\nb".into()), None).is_err());
    }

    #[test]
    fn payload_serializes_with_snake_case_session_id() {
        let json = serde_json::to_string(&NotificationClickedPayload { session_id: "s".into() }).unwrap();
        assert_eq!(json, r#"{"session_id":"s"}"#);
    }
}
