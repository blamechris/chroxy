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
    "discover_lan_servers",
    "get_qr_code_svg",
    "pick_directory",
    "check_dependencies",
    "get_setup_state",
    "save_setup_config",
    "get_tunnel_mode",
    "set_tunnel_mode",
    "get_expose_on_lan",
    "set_expose_on_lan",
    "get_summon_hotkey",
    "set_summon_hotkey",
    "get_allow_auto_permission_mode",
    "set_allow_auto_permission_mode",
    "update_tray_badge",
    "private_no_it_all_status",
    "launch_private_no_it_all",
    "voice_available",
    "start_voice_input",
    "stop_voice_input",
    "reset_speech_permissions",
    "tile_window",
    "read_clipboard_image",
    "reveal_in_finder",
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
        // APPLE_KEYCHAIN_PATH is passed to `codesign --keychain` below; toggling
        // it between cargo invocations must invalidate the speech-helper cache
        // marker so the binary is re-signed against the new keychain (#4252).
        println!("cargo:rerun-if-env-changed=APPLE_KEYCHAIN_PATH");

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
            // Cache key for skipping redundant compile+lipo+sign on the second
            // cargo invocation of a universal-apple-darwin build (#3833). Tauri
            // runs `cargo build` once per arch (arm64 then x86_64); each
            // invocation re-runs this build.rs and used to redo the full
            // ~10s swiftc+lipo+codesign cycle even though the output is
            // identical.
            //
            // Inputs that must invalidate the cache:
            //   - swift source mtime (also tracked by rerun-if-changed above,
            //     but cargo's tracker is per-target_dir; the universal build
            //     uses two target dirs so we re-check explicitly here)
            //   - APPLE_SIGNING_IDENTITY (signature changes when identity does)
            //   - APPLE_KEYCHAIN_PATH (#4252: passed to codesign --keychain;
            //     swapping the keychain must re-sign the binary against the
            //     new identity-resolution scope)
            //   - swiftc toolchain version (#3950: Xcode/Swift updates produce
            //     binaries with different runtime requirements; without this,
            //     a stale cache would silently ship a binary compiled against
            //     the prior toolchain). Captured via `swiftc --version` so any
            //     change (Swift release, Xcode build id) invalidates the cache.
            //   - The output binary itself must still exist + be non-empty
            //
            // Cache file lives next to swift_out in the source tree so both
            // cargo invocations (which have different OUT_DIR) see the same
            // file. To force a rebuild manually: `rm packages/desktop/src-tauri/swift/speech-helper.cache`
            // — combined with the `rerun-if-changed` directive on the cache
            // file below, this is enough to make cargo re-run this build
            // script even when nothing else has changed.
            // The `v<N>` prefix is bumped whenever this key's schema changes so
            // existing on-disk caches auto-invalidate on rollout.
            let swift_cache = format!("{}.cache", swift_out);
            // Track the cache marker so `rm <swift_cache>` reliably forces a
            // rebuild: without this, cargo only re-runs the build script when
            // a tracked input changes (currently `swift_src`,
            // `APPLE_SIGNING_IDENTITY`, and `APPLE_KEYCHAIN_PATH`), so
            // deleting the cache marker alone would be silently ignored on
            // the next `cargo build`.
            println!("cargo:rerun-if-changed={}", swift_cache);
            let identity_for_cache = std::env::var("APPLE_SIGNING_IDENTITY").unwrap_or_default();
            // Include the (possibly empty) keychain path in the cache key so a
            // swap of APPLE_KEYCHAIN_PATH between two cargo invocations forces
            // a re-sign even on a warm cache (#4252). On CI this is moot
            // (fresh runner), but it matters for local experiments with
            // alternate keychains.
            let keychain_for_cache = std::env::var("APPLE_KEYCHAIN_PATH").unwrap_or_default();
            let src_mtime_secs = std::fs::metadata(&swift_src)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            // #4953: the helper-entitlements plist participates in the sign
            // step now, so its mtime must invalidate the cache — otherwise
            // edits to the plist (e.g. adding new entitlements) silently
            // ship under the old signature on a warm cache.
            let helper_ent_path = format!("{}/entitlements-helper.plist", manifest_dir);
            println!("cargo:rerun-if-changed={}", helper_ent_path);
            let helper_ent_mtime = std::fs::metadata(&helper_ent_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            // `swiftc --version` writes the full toolchain banner (Swift release
            // + Xcode build id on Apple toolchains) to stdout. If swiftc is
            // missing or the call fails, fall back to "unknown" so we still
            // produce a deterministic cache key — the compile step below will
            // then fail loudly with the real error.
            let swiftc_version = std::process::Command::new("swiftc")
                .arg("--version")
                .output()
                .ok()
                .and_then(|o| if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                })
                .unwrap_or_else(|| "unknown".to_string());
            // BUMP THE v<N> PREFIX whenever the key schema (fields/format) changes
            // — otherwise warm on-disk caches with the old schema match the new
            // key by coincidence and ship a stale binary. Add a field → bump.
            // Reorder fields → bump. Change the separator → bump.
            let cache_key = format!(
                "v4\nsrc_mtime={}\nidentity={}\nkeychain={}\nswiftc={}\nhelper_ent_mtime={}\n",
                src_mtime_secs, identity_for_cache, keychain_for_cache, swiftc_version,
                helper_ent_mtime,
            );

            let cached = std::path::Path::new(&swift_out).exists()
                && std::fs::metadata(&swift_out).map(|m| m.len() > 0).unwrap_or(false)
                && std::fs::read_to_string(&swift_cache).map(|s| s == cache_key).unwrap_or(false);

            if cached {
                println!("cargo:warning=speech-helper: cache hit, skipping swiftc+lipo+codesign (cache key matches {swift_cache})");
            } else {
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
                        // Optional explicit keychain (#3832). When set, scopes
                        // codesign's identity lookup to that keychain — avoids
                        // ambiguity in CI if login.keychain remains on the
                        // search path alongside the temp signing keychain.
                        let keychain = std::env::var("APPLE_KEYCHAIN_PATH").ok();
                        // Helper-scoped entitlements (#4953). TCC binds
                        // microphone access per-binary, so the parent app's
                        // com.apple.security.device.audio-input does NOT
                        // propagate to this subprocess — the helper needs its
                        // own audio-input entitlement embedded at sign time.
                        // Without --entitlements, the helper signs with empty
                        // entitlements and AVAudioEngine init is denied
                        // silently. #4801 / #4812 only patched the parent.
                        let helper_entitlements = format!(
                            "{}/entitlements-helper.plist", manifest_dir,
                        );
                        let mut args: Vec<&str> = vec![
                            "--force",
                            "--options", "runtime",
                            "--timestamp",
                            "--entitlements", &helper_entitlements,
                            "--sign", &identity,
                        ];
                        if let Some(ref kc) = keychain {
                            if !kc.is_empty() {
                                args.extend_from_slice(&["--keychain", kc]);
                            }
                        }
                        args.push(&swift_out);
                        run(
                            "codesign (speech-helper)",
                            std::process::Command::new("codesign").args(&args),
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

                // Write the cache marker last, so a failed compile/sign leaves
                // the cache invalid and forces a rebuild on the next pass.
                if let Err(e) = std::fs::write(&swift_cache, &cache_key) {
                    println!("cargo:warning=speech-helper: failed to write cache marker {swift_cache}: {e}");
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
                        // Optional explicit keychain (#3832). See speech-helper
                        // block above for rationale.
                        let keychain = std::env::var("APPLE_KEYCHAIN_PATH").ok();
                        for bin in ["pty.node", "spawn-helper"] {
                            let path = format!("{}/{}", arch_dir, bin);
                            if !std::path::Path::new(&path).exists() { continue }
                            let mut args: Vec<&str> = vec![
                                "--force",
                                "--options", "runtime",
                                "--timestamp",
                                "--sign", &identity,
                            ];
                            if let Some(ref kc) = keychain {
                                if !kc.is_empty() {
                                    args.extend_from_slice(&["--keychain", kc]);
                                }
                            }
                            args.push(&path);
                            run(
                                &format!("codesign (node-pty {bin} {arch})"),
                                std::process::Command::new("codesign").args(&args),
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
