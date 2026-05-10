use tauri_build::{AppManifest, Attributes};

// Custom Tauri commands invoked from the dashboard webview. tauri-build
// autogenerates `allow-<command>` / `deny-<command>` permissions for each
// entry; capabilities/default.json grants the allow-* set so the dashboard
// (loaded from http://127.0.0.1:<server-port>) can call them.
//
// Adding a new #[tauri::command] requires an entry here AND the matching
// allow-* permission in capabilities/default.json. Tauri 2.11+ rejects any
// custom command with no resolved ACL when the request comes from a remote
// origin (issue #3741).
const APP_COMMANDS: &[&str] = &[
    "get_server_info",
    "get_server_logs",
    "get_startup_logs",
    "start_server",
    "stop_server",
    "restart_server",
    "get_qr_code_svg",
    "pick_directory",
    "check_dependencies",
    "get_setup_state",
    "save_setup_config",
    "get_tunnel_mode",
    "set_tunnel_mode",
    "get_allow_auto_permission_mode",
    "set_allow_auto_permission_mode",
    "voice_available",
    "start_voice_input",
    "stop_voice_input",
    "tile_window",
];

fn main() {
    // Compile the Swift speech helper for macOS
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let swift_src = format!("{}/swift/speech-helper.swift", manifest_dir);
        let swift_out = format!("{}/swift/speech-helper", manifest_dir);

        if std::path::Path::new(&swift_src).exists() {
            let status = std::process::Command::new("swiftc")
                .args(["-O", &swift_src, "-o", &swift_out, "-framework", "Speech", "-framework", "AVFoundation"])
                .status()
                .expect("Failed to compile speech-helper.swift — is Xcode CLI tools installed?");

            if !status.success() {
                panic!("swiftc failed to compile speech-helper.swift");
            }

            println!("cargo:rerun-if-changed={}", swift_src);
        }
    }

    let attrs = Attributes::new().app_manifest(AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attrs).expect("tauri_build::try_build failed");
}
