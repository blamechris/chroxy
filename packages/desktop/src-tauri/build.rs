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

        // Emit cargo directives unconditionally so cargo's rerun tracking stays
        // consistent even if speech-helper.swift is temporarily absent.
        println!("cargo:rerun-if-changed={}", swift_src);
        println!("cargo:rerun-if-env-changed=APPLE_SIGNING_IDENTITY");

        // Helper: run a command, panic with captured stderr on failure.
        fn run(label: &str, cmd: &mut std::process::Command) {
            let output = cmd.output().unwrap_or_else(|e| {
                panic!("Failed to invoke {label}: {e}")
            });
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                panic!("{label} failed (exit {}):\n--- stderr ---\n{}\n--- stdout ---\n{}",
                    output.status.code().unwrap_or(-1), stderr, stdout);
            }
        }

        if std::path::Path::new(&swift_src).exists() {
            for (arch, out) in [("arm64", &swift_arm64), ("x86_64", &swift_x86_64)] {
                let target = format!("{}-apple-macos11", arch);
                run(
                    &format!("swiftc ({arch})"),
                    std::process::Command::new("swiftc").args([
                        "-O",
                        "-target", &target,
                        &swift_src,
                        "-o", out,
                        "-framework", "Speech",
                        "-framework", "AVFoundation",
                    ]),
                );
            }

            run(
                "lipo (universal speech-helper)",
                std::process::Command::new("lipo").args([
                    "-create", &swift_arm64, &swift_x86_64,
                    "-output", &swift_out,
                ]),
            );

            // Codesign the universal binary with the Developer ID cert when one
            // is configured. Skipping when adhoc ("-") keeps local dev working
            // without any Apple credentials.
            if let Ok(identity) = std::env::var("APPLE_SIGNING_IDENTITY") {
                if !identity.is_empty() && identity != "-" {
                    run(
                        "codesign (speech-helper)",
                        std::process::Command::new("codesign").args([
                            "--force",
                            "--options", "runtime",
                            "--timestamp",
                            "--sign", &identity,
                            &swift_out,
                        ]),
                    );
                    // Fail-fast verification: catches bad signatures here instead of
                    // letting them propagate to a ~15-minute Apple notarytool rejection.
                    run(
                        "codesign --verify (speech-helper)",
                        std::process::Command::new("codesign").args([
                            "--verify",
                            "--strict",
                            "--verbose=2",
                            &swift_out,
                        ]),
                    );
                }
            }
        }

        // node-pty native binaries shipped with the staged server bundle
        // (#3902 claude-tui provider). npm prebuilds ship as adhoc-signed
        // Mach-O — Apple notarytool rejects those, so we re-sign with the
        // Developer ID cert before Tauri's bundler copies the
        // server-bundle/ directory into Chroxy.app/Contents/Resources/.
        //
        // We also drop linux-* and win32-* prebuilds: the desktop bundle
        // is darwin-only, and unsigned non-darwin .node files inside the
        // bundle would also fail notarization.
        let server_bundle = format!("{}/server-bundle/node_modules/node-pty/prebuilds", manifest_dir);
        if std::path::Path::new(&server_bundle).exists() {
            // Always prune non-darwin prebuilds (independent of signing config).
            for entry in std::fs::read_dir(&server_bundle).unwrap_or_else(|e| {
                panic!("Failed to read node-pty prebuilds dir {server_bundle}: {e}")
            }) {
                let entry = entry.unwrap_or_else(|e| panic!("read_dir entry failed: {e}"));
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("darwin-") { continue }
                let _ = std::fs::remove_dir_all(entry.path());
            }

            // Sign the darwin prebuilds we kept. node-pty ships two binaries
            // per arch — pty.node (the dlopen'd native addon) and
            // spawn-helper (an executable invoked by pty.fork()). Both
            // load at runtime and both must be signed.
            //
            // chmod +x on spawn-helper here too: npm 1.1.0 strips the
            // exec bit (see scripts/fix-node-pty-helper.js). Tauri's
            // resource copy preserves modes from staging, so fixing it
            // here gets it into the final .app correctly.
            for arch in ["darwin-arm64", "darwin-x64"] {
                let arch_dir = format!("{}/{}", server_bundle, arch);
                if !std::path::Path::new(&arch_dir).exists() { continue }
                let spawn_helper = format!("{}/spawn-helper", arch_dir);
                if std::path::Path::new(&spawn_helper).exists() {
                    let _ = std::process::Command::new("chmod")
                        .args(["+x", &spawn_helper])
                        .status();
                }

                if let Ok(identity) = std::env::var("APPLE_SIGNING_IDENTITY") {
                    if !identity.is_empty() && identity != "-" {
                        for bin in ["pty.node", "spawn-helper"] {
                            let path = format!("{}/{}", arch_dir, bin);
                            if !std::path::Path::new(&path).exists() { continue }
                            run(
                                &format!("codesign (node-pty {bin} {arch})"),
                                std::process::Command::new("codesign").args([
                                    "--force",
                                    "--options", "runtime",
                                    "--timestamp",
                                    "--sign", &identity,
                                    &path,
                                ]),
                            );
                            run(
                                &format!("codesign --verify (node-pty {bin} {arch})"),
                                std::process::Command::new("codesign").args([
                                    "--verify",
                                    "--strict",
                                    "--verbose=2",
                                    &path,
                                ]),
                            );
                        }
                    }
                }
            }
        }
    }

    let attrs = Attributes::new().app_manifest(AppManifest::new().commands(APP_COMMANDS));
    tauri_build::try_build(attrs).expect("tauri_build::try_build failed");
}
