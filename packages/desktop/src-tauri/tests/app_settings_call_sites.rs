//! Pins the App Settings wiring (#9079) that lives in Tauri glue and bundled-page
//! scripts a unit test cannot run: which commands refuse a non-app caller, which
//! setters share one write path, and what the bundled page loads and offers.
//!
//! Lo-fi source scraping in the style of `client_mode_call_sites.rs`; every
//! assertion collapses to a boolean first.

use std::fs;
use std::path::PathBuf;

fn read(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The body of the function whose header starts with `header`, to the first `}` in
/// column 0. Panics if it is gone, so a rename cannot turn a pin into a no-op.
fn body_of(src: &str, header: &str) -> String {
    let start = src.find(header).unwrap_or_else(|| panic!("{} not found", header));
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or_else(|| panic!("{} has no closing brace", header));
    squash(&rest[..end])
}

#[test]
fn every_app_settings_command_refuses_a_caller_that_is_not_the_apps_page() {
    let lib = read("src/lib.rs");
    for header in [
        "async fn get_app_settings(",
        "fn set_auto_start_server(",
        "fn set_start_at_login(",
        "fn set_app_port(",
    ] {
        let body = body_of(&lib, header);
        let check = body.find("require_app_page(&webview)?;");
        assert!(check.is_some(), "{} must check the caller", header);
        let act = body
            .find("apply_")
            .or_else(|| body.find("app_settings_snapshot("))
            .unwrap_or_else(|| panic!("{} must act", header));
        assert!(check.unwrap() < act, "{}: the caller check must come before the action", header);
    }
    let gate = body_of(&lib, "fn require_app_page(");
    assert!(
        gate.contains("app_settings::require_app_page(&webview_page(webview))"),
        "the wrapper must hand the webview's own URL to the pure gate"
    );
}

#[test]
fn the_tray_and_app_settings_share_one_write_path() {
    let lib = read("src/lib.rs");
    assert!(body_of(&lib, "fn handle_toggle_auto_start(").contains("apply_auto_start_server(app,"));
    assert!(body_of(&lib, "fn handle_toggle_login(").contains("apply_start_at_login(app,"));
    assert!(body_of(&lib, "fn set_auto_start_server(").contains("apply_auto_start_server(&app, enabled)"));
    assert!(body_of(&lib, "fn set_start_at_login(").contains("apply_start_at_login(&app, enabled)"));
    // One port writer, shared by the wizard and App Settings.
    assert!(body_of(&lib, "fn apply_app_port(").contains("app_settings::set_port_at("));
    assert!(body_of(&lib, "fn save_setup_config(").contains("app_settings::set_port_at("));
    assert!(!body_of(&lib, "fn save_setup_config(").contains("std::fs::write"), "no second, unrestricted config.json write");
    // Every change a user can make elsewhere reaches an open settings view.
    for header in [
        "fn apply_auto_start_server(",
        "fn apply_start_at_login(",
        "fn apply_app_port(",
        "fn set_tunnel_mode(",
        "fn set_expose_on_lan(",
        "fn handle_set_tunnel_mode(",
    ] {
        assert!(body_of(&lib, header).contains("emit_app_settings_changed("), "{} must announce the change", header);
    }
    // To the main webview only.
    assert!(body_of(&lib, "fn emit_app_settings_changed(").contains("emit_to(window::MAIN_LABEL"));
}

#[test]
fn the_dashboard_menu_items_follow_the_main_windows_page() {
    let lib = read("src/lib.rs");
    assert!(
        squash(&lib).contains(".on_page_load(|webview, payload| { if app_settings::page_load_syncs_menu( webview.label(),"),
        "the page-load hook must act for the main window only"
    );
    assert!(squash(&lib).contains("app_settings::dashboard_items_enabled(payload.url())"));
    // Built disabled: the window starts on the bundled page.
    let squashed = squash(&lib);
    for id in ["app_menu:new-session", "app_menu:disconnect", "app_menu:view-toggle-sidebar", "app_menu:view-toggle-plan-mode", "app_menu:view-show-qr", "app_menu:view-reload"] {
        let at = squashed.find(&format!("with_id( \"{}\"", id)).or_else(|| squashed.find(&format!("with_id(\"{}\"", id))).unwrap_or_else(|| panic!("{} not built", id));
        let build = squashed[at..].find(".build(app)?").unwrap();
        assert!(squashed[at..at + build].contains(".enabled(false)"), "{} must be built disabled", id);
    }
    // The menu routes through the pure router before the default dashboard emit.
    let route = lib.find("app_settings::route_app_menu(action, main_window_on_app_page(app))").expect("routed");
    let default = lib.find("let event_name = format!(\"menu://{}\", action);").expect("default emit");
    assert!(route < default, "the page route must come before the dashboard emit");
}

#[test]
fn the_new_commands_are_not_reachable_without_the_three_lists() {
    // The drift test keeps the three lists equal; this pins that the new names are in them.
    let build = read("build.rs");
    let caps = read("capabilities/default.json");
    for (cmd, perm) in [
        ("get_app_settings", "allow-get-app-settings"),
        ("set_auto_start_server", "allow-set-auto-start-server"),
        ("set_start_at_login", "allow-set-start-at-login"),
        ("set_app_port", "allow-set-app-port"),
    ] {
        assert!(build.contains(&format!("\"{}\"", cmd)), "{} missing from APP_COMMANDS", cmd);
        assert!(caps.contains(&format!("\"{}\"", perm)), "{} missing from capabilities", perm);
    }
}

#[test]
fn the_bundled_page_offers_the_server_actions_and_app_settings() {
    let html = read("../dist/index.html");
    let loading_at = html.find("<script src=\"loading.js\">").expect("loading.js is loaded");
    let settings_at = html.find("<script src=\"app-settings.js\">").expect("app-settings.js is loaded");
    assert!(loading_at < settings_at, "app-settings.js uses what loading.js exposes, so it loads after it");
    assert!(!html.contains("<script>"), "the CSP allows no inline script");

    let loading = read("../dist/loading.js");
    assert!(!loading.contains("open_settings"), "the gear no longer calls open_settings directly");
    assert!(loading.contains("btn.textContent = 'Start Server'"), "the error state offers Start Server");
    assert!(loading.contains("'settings-link-btn'"), "the error state offers Settings...");
    assert!(loading.contains("invoke('start_server')"), "Start Server is the start_server action");
    // The stopped state gets the same way forward.
    let stopped = loading.find("listen('server_stopped'").expect("server_stopped handler");
    let tail = &loading[stopped..];
    let end = tail.find("});").unwrap();
    assert!(tail[..end].contains("showActionButtons();"), "server_stopped must show Start Server / Connect / Settings...");

    let js = read("../dist/app-settings.js");
    for cmd in ["get_app_settings", "set_auto_start_server", "set_start_at_login", "set_app_port", "set_tunnel_mode", "set_expose_on_lan", "open_settings"] {
        assert!(js.contains(&format!("'{}'", cmd)), "App Settings must call {}", cmd);
    }
    // Events emitted to the main webview are heard only by a listener that names it.
    // Both listeners go through the one helper that names it; no bare listen call.
    assert!(js.contains("{ target: 'main' }"));
    assert!(js.contains("listenMain('app_settings_changed'") && js.contains("listenMain('app_page_action'"));
    assert_eq!(js.matches("event.listen(").count(), 1, "only listenMain may call event.listen");
    let helper = js.find("function listenMain(").expect("listenMain");
    let call = js.find("event.listen(").unwrap();
    assert!(call > helper && js[helper..call].len() < 400, "the one listen call lives in listenMain");
    // The first-run branch defers to an open settings view.
    let loading = read("../dist/loading.js");
    assert!(loading.contains("chroxyAppSettings.deferWizard()"), "first run must not activate the wizard beside an open view");
}

#[test]
fn the_dashboard_menu_handles_are_the_six_items_each_once() {
    let lib = read("src/lib.rs");
    let at = lib.find("dashboard_items: vec![").expect("the handle list");
    let rest = &lib[at..];
    let list = &rest[..rest.find("],").unwrap()];
    let mut ids: Vec<&str> = Vec::new();
    let mut r = list;
    while let Some(i) = r.find("(\"") {
        let after = &r[i + 2..];
        let end = after.find('"').unwrap();
        ids.push(&after[..end]);
        r = &after[end..];
    }
    assert!(
        chroxy_desktop::app_settings::dashboard_handles_match(&ids),
        "the enable set must be exactly the dashboard-only items, each once: {:?}",
        ids
    );
}
