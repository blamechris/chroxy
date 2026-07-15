# Builder's Audit: Windows/Linux Platform Support
**Agent**: Builder — pragmatic full-stack dev, revises effort estimates and lists file-by-file changes
**Overall Rating**: 3.7 / 5
**Date**: 2026-07-14

The surprise going in: this is *not* a greenfield port. There is a large body of real, CI-tested Windows code, a shipping Windows MSI, and a Windows-aware server that runs cleanly on this box out of the box. The remaining work is a short list of concrete gaps, one of which is a probable runtime blocker.

## Baseline established on this machine
| Tool | State |
|---|---|
| Node | v24.18.0 (CLAUDE.md wants 22; doctor WARNs but runs) |
| npm | 11.18.0 |
| cloudflared | `C:\Program Files (x86)\cloudflared\cloudflared.exe`, v2026.6.1 — detected by doctor |
| WebView2 runtime | **installed** (pv 150.0.4078.65) |
| MSVC Build Tools | **VS 2019 BuildTools present** (`link.exe` just not on the bare-shell PATH) |
| rustc / cargo / rustup | **absent** — the one real local-build blocker |
| cargo-tauri | absent |
| Git Bash | present (git 2.45.1) — `beforeBuildCommand` needs it |
| WSL2 | Ubuntu + docker-desktop, both v2 (stopped) |

Live smoke tests: `node src/cli.js --help` → clean; `node src/cli.js doctor` → **all checks pass**. node-pty loaded without a rebuild. Verified in CI: `Chroxy_0.9.46_x64_en-US.msi` is a **shipped release asset**.

## 1. Dimension ratings

| Dimension | Rating | One-line justification |
|---|---|---|
| **(a) Server daemon on Windows** | **4.0** | CLI + doctor run great; `platform.js`, `win-spawn.js`, `resolve-binary.js`, `server.rs` are genuinely Windows-aware and CI-tested. Gaps: no native service, no Credential Manager. |
| **(b) Tunnel / cloudflared** | **4.5** | Installed & detected; quick tunnel is cross-platform; orphan-cloudflared cleanup uses `wmic`→PowerShell→`taskkill`. Near-complete. |
| **(c) Tauri desktop build + install** | **3.0** | MSI builds & ships in CI, Authenticode signing wired. But **no `bundle.windows` block** and a **probable runtime blocker** locating the bundled server. |
| **(d) Setup / first-run** | **3.5** | `setup.rs`/`node.rs` handle Windows; doctor is excellent; WebView2 present. Held back by admin-elevation MSI + online-only WebView2 + the cli.js-discovery bug. |
| **(e) Linux / WSL2** | **4.0** | Server runs natively on Linux (systemd fully supported), Docker image is Linux, WSL Control Room (`wsl.js`) works. Gap: no Linux desktop tray build. |

## 2. File-by-file punch list

### (c) Tauri desktop — highest priority
- **`packages/desktop/src-tauri/src/server.rs:1303-1314` — `resolve_cli_js()` bundled-server discovery is macOS-only. [M, ~3-4h] — LIKELY BLOCKER.** Strategy 1 hardcodes the `.app` layout: `exe.parent().parent().join("Resources/server/src/cli.js")`. On a Windows MSI install that resolves to `C:\Program Files\Resources\server\src\cli.js` — wrong. Tauri v2 places `bundle.resources` next to the exe, so the real path is `<exe_dir>\server\src\cli.js`. **Net effect: the installed Windows tray app probably cannot start its own daemon.** *Should be verified by actually installing the MSI.*
- **`tauri.conf.json:33-49` — no `bundle.windows` block. [M, ~2-3h].** Add `webviewInstallMode` (default `downloadBootstrapper` requires internet; use `embedBootstrapper`/`offlineInstaller`), consider an `nsis` target (per-user, non-elevated) alongside the default `wix` MSI (`perMachine`/admin).
- **`tauri.conf.json:41` — macOS speech-helper (208KB Mach-O) bundled into the Windows MSI. [S, ~1h].**

### (a) Server daemon
- **`service.js:173-191, 468-475, 616-622, 706-711` — no native Windows service. [M ~4-6h for schtasks; L ~1-2d for NSSM/`sc.exe`].** `installService`/`startService`/`stopService` return `getWindowsAlternatives()` text instead of acting. **Note:** the desktop tray already gets login-launch parity via `tauri-plugin-autostart`, so this only matters for the headless `chroxy service` CLI path.
- **`keychain.js` — no Windows Credential Manager backend. [M, ~4-6h].** Add `_winGetToken/_winSetToken/_winDeleteToken` via DPAPI or Credential Manager.
- Already solid (no action): `platform.js`, `utils/win-spawn.js`, `utils/resolve-binary.js`, `server.rs` Windows process mgmt.

### (d) Setup / first-run
- `node.rs:29-58` — good, no change (covers `%ProgramFiles%\nodejs`, nvm-windows, `where`).
- `setup.rs` — platform-neutral, no change.

### (e) Linux / WSL2
- **`release.yml:133-404` — no `desktop-linux` job. [M, ~3-4h].** Adding an ubuntu `cargo tauri build --bundles deb,appimage` job would give Linux users a native tray.
- `control-room/wsl.js` — already works; no change.

### CI hardening
- **`.github/workflows/ci.yml:748-784` — `desktop-tests` runs `cargo test` on the self-hosted macOS runner only.** [S, ~2h] Add a `windows-latest` `cargo check --target x86_64-pc-windows-msvc` to per-PR CI.

## 3. Build/toolchain requirements for a Windows installer

**Proven working in CI** (`release.yml` `desktop-windows`, windows-latest): Rust stable `x86_64-pc-windows-msvc` → cargo-binstall tauri-cli → `cargo tauri build --bundles msi` → optional Azure Trusted Signing.

**To build locally on THIS box, install:**
1. **rustup + `stable-x86_64-pc-windows-msvc`** — the only hard blocker (absent now).
2. **cargo-tauri** (`cargo install tauri-cli --version "^2"`).
3. Already present: MSVC linker (VS 2019 BuildTools), WebView2 runtime, Node, Git Bash (required — `beforeBuildCommand` is `bash scripts/before-build.sh`).
4. Signing optional; unsigned MSI still builds (SmartScreen warning only).

## 4. Dependency-ordered action sequence

**Phase 1 — Make the shipping MSI actually work:**
1. Fix `resolve_cli_js` Windows strategy (`server.rs:1303`) — [M].
2. **Install the MSI and runtime-test it** — the single most important missing verification.
3. Drop the macOS speech-helper from the Windows bundle — [S].

**Phase 2 — First-run & install-experience parity:**
4. Add `bundle.windows` (WebView2 install mode + optional NSIS/per-user) — [M].
5. Add per-PR `windows-latest` `cargo check` — [S].
6. Windows Credential Manager keychain backend — [M].

**Phase 3 — Full feature/service parity:**
7. Native Windows service via `schtasks` in `service.js` — [M]; NSSM/`sc.exe` — [L].
8. Linux `desktop-linux` release job — [M].
9. Windows voice-to-text or explicitly ship as macOS-only — [L].

## 5. Top 5 findings + verdict

1. **The Windows tray probably can't find its own bundled server** (`server.rs:1303-1314`). Highest-priority, small fix, needs a real install-test to confirm.
2. **The Windows MSI already builds, signs, and ships** (`release.yml`; `Chroxy_0.9.46_x64_en-US.msi`). The build toolchain question is largely *solved*.
3. **The server/CLI cross-platform layer is genuinely strong and CI-tested** — `chroxy doctor` passes every check here.
4. **`tauri.conf.json` has no `bundle.windows` block** — WebView2 online-bootstrap-only, admin-elevated perMachine MSI, plus a 208KB macOS binary as dead weight.
5. **Two advertised features silently degrade on Windows**: OS-keychain credential encryption and native service management. Login-autostart is *not* a gap — `tauri-plugin-autostart` (`lib.rs:872`) gives registry-Run-key parity.

**Verdict:** Windows support is far more mature than the "no `bundle.windows` block" framing suggests — a signed MSI ships and the Node daemon runs cleanly today. The gap between "builds an installer" and "installer produces a working app" hinges almost entirely on one macOS-only path in `resolve_cli_js`; fix that and runtime-test the MSI, and Windows jumps to ~4.3/5. Rating the current state 3.7 — held down by the untested runtime path and missing installer polish, buoyed by an unusually solid cross-platform foundation.
