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
    "read_clipboard_image",
];

fn main() {
    // Compile the Swift speech helper for macOS as a universal (arm64 + x86_64)
    // binary so the resulting .app passes Apple notarization on universal-apple-darwin
    // Tauri builds. If APPLE_SIGNING_IDENTITY is set (and not adhoc "-"), the
    // universal binary is also codesigned with hardened runtime + secure timestamp
    // so Tauri's bundler copies a notarization-ready binary into the .app.
    //
    // Why here: Tauri's bundler does NOT recursively sign arbitrary executables
    // under Contents/Resources/, AND any pre-signing done in a previous workflow
    // step would be wiped because this build.rs unconditionally regenerates the
    // binary on every cargo invocation. Compile + lipo + sign must be one atomic
    // pass inside build.rs.
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let out_dir = std::env::var("OUT_DIR").unwrap();
        let swift_src = format!("{}/swift/speech-helper.swift", manifest_dir);
        let swift_out = format!("{}/swift/speech-helper", manifest_dir);
        let swift_arm64 = format!("{}/speech-helper-arm64", out_dir);
        let swift_x86_64 = format!("{}/speech-helper-x86_64", out_dir);

        if std::path::Path::new(&swift_src).exists() {
            for (arch, out) in [("arm64", &swift_arm64), ("x86_64", &swift_x86_64)] {
                let target = format!("{}-apple-macos11", arch);
                let status = std::process::Command::new("swiftc")
                    .args([
                        "-O",
                        "-target", &target,
                        &swift_src,
                        "-o", out,
                        "-framework", "Speech",
                        "-framework", "AVFoundation",
                    ])
                    .status()
                    .unwrap_or_else(|e| {
                        panic!("Failed to invoke swiftc for {arch} — is Xcode CLI tools installed? ({e})")
                    });
                if !status.success() {
                    panic!("swiftc failed to compile speech-helper.swift for {arch}");
                }
            }

            let status = std::process::Command::new("lipo")
                .args(["-create", &swift_arm64, &swift_x86_64, "-output", &swift_out])
                .status()
                .expect("Failed to invoke lipo");
            if !status.success() {
                panic!("lipo failed to merge speech-helper architectures");
            }

            // Codesign the universal binary with the Developer ID cert when one
            // is configured. Skipping when adhoc ("-") keeps local dev working
            // without any Apple credentials.
            if let Ok(identity) = std::env::var("APPLE_SIGNING_IDENTITY") {
                if !identity.is_empty() && identity != "-" {
                    let status = std::process::Command::new("codesign")
                        .args([
                            "--force",
                            "--options", "runtime",
                            "--timestamp",
                            "--sign", &identity,
                            &swift_out,
                        ])
                        .status()
                        .expect("Failed to invoke codesign for speech-helper");
                    if !status.success() {
                        panic!("codesign failed for speech-helper");
                    }
                }
            }

            println!("cargo:rerun-if-changed={}", swift_src);
            println!("cargo:rerun-if-env-changed=APPLE_SIGNING_IDENTITY");
        }
    }

    let attrs = Attributes::new().app_manifest(AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attrs).expect("tauri_build::try_build failed");
}
