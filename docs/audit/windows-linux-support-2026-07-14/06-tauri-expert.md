# Tauri Expert's Audit: Windows/Linux Platform Support
**Agent**: Tauri Expert — Tauri v2 / desktop packaging specialist (WiX/NSIS, WebView2, tray, updater, signing)
**Overall Rating**: 2.3 / 5
**Date**: 2026-07-14

## 1. VERDICT on the `resolve_cli_js` runtime blocker — **REAL (confirmed, not a false alarm, not mitigated)**

The installed Windows MSI **launches** (window + tray render — WebView2 is present) but its **embedded Node daemon never starts on a clean Windows box.** The tray's one job is broken.

### The exact code path
`packages/desktop/src-tauri/src/server.rs:1303-1371`, `resolve_cli_js()` tries four strategies. On a clean Windows MSI install, **all four fail**:
- **Strategy 1 (server.rs:1307-1314)** — macOS `.app` layout *only*: `exe.parent().parent().join("Resources/server/src/cli.js")`. macOS `.../Contents/MacOS/chroxy-desktop` → `Contents/Resources/server/src/cli.js` ✅. Windows `C:\Program Files\Chroxy\Chroxy.exe` → `C:\Program Files\Resources\server\src\cli.js` ❌ (doesn't exist).
- **Strategy 2 (1321-1334)** — walks up for `packages/server/src/cli.js`. No monorepo on an end-user machine. ❌
- **Strategy 3 (1337-1349)** — `CHROXY_SERVER_PATH` env. **Never set by the app** (grepped the whole crate — only *read* here). ❌
- **Strategy 4 (1356-1365)** — `where chroxy`. Nothing unless the user separately `npm i -g chroxy`. (Latent secondary bug: even if it hit, it returns the `chroxy` **shim** path and hands it back as if it were `cli.js`.) ❌

Result: `resolve_cli_js()` → `Err` → `start_server_process` (server.rs:932) → `handle_start` Err arm (lib.rs:2052-2057) → `emit_server_error`.

### Evidence the bundle staging is Windows-correct (so this is purely a lookup bug)
- `tauri.conf.json:39-42` maps `"server-bundle": "server"`. Tauri v2 `resource_dir()` on **Windows = the directory that contains the main executable**; macOS = `${exe_dir}/../Resources`. So the server is staged at `<install>\server\src\cli.js` — exactly where Strategy 1 does **not** look.
- `bundle-server.sh:104-108` prunes node-pty win32 prebuilds **macOS-host-only**; `build.rs:265-343` prunes/signs node-pty **macOS-only**. So the Windows MSI *does* ship the correct `win32-x64` `pty.node` — the daemon would run fine *if cli.js were found*.

### Trigger is guaranteed
`DesktopSettings::auto_start_server` **defaults to `true`** (settings.rs:9-10, 51). Second launch → `startup_action(true, true)` = `StartOwn` (lib.rs:1830) → the failing `resolve_cli_js`. First-run wizard "Start" hits the identical failure. No path around it.

**Fix (S):** insert a next-to-exe branch (covers Windows *and* Linux AppImage/deb, equally broken today):
```rust
if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
        let bundled = dir.join("server/src/cli.js");
        if bundled.exists() { return Ok(bundled); }
    }
}
```
Cleaner: thread the `AppHandle` and call `app.path().resource_dir()`.

## 2. Dimension ratings (1–5)

| Dimension | Rating | Basis |
|---|---|---|
| **(a) MSI builds & ships** | **4.5** | `release.yml:279-404` builds `--bundles msi`, uploads `.msi`/`.msi.zip`/`.sig`/`latest.json`. A signed 0.9.46 MSI shipped. Ding: no NSIS, compiles only on `v*` tags. |
| **(b) Installed app actually runs** | **1.5** | Window + tray open, but embedded daemon dead (§1). Compounded: **Node 22 is an unbundled external prerequisite** (`node.rs:30-58` only discovers it) with no Windows install guide. |
| **(c) Bundle config correctness** | **2.0** | **No `bundle.windows` block** (tauri.conf.json:33-49). No `webviewInstallMode` → default `downloadBootstrapper` (online-only). Default WiX = perMachine/admin; no NSIS per-user. Dead weight: `swift/speech-helper` in `resources` unconditionally (line 41). |
| **(d) Tray/window/autostart parity** | **3.5** | Tray menu **fully cross-platform** (lib.rs:1536-1675). `tauri-plugin-autostart` (registry Run key), single-instance, window-state, updater — all platform-neutral. macOS-only extras with no Windows equivalent (by design): menu-bar (lib.rs:1042-1330), voice/speech, dock badge (`update_tray_badge` no-ops on Windows, lib.rs:374-379). |
| **(e) Updater + signing** | **3.5** | Windows updater path **real**: `.msi.zip`+`.sig`+`latest.json`; `merge-updater-feeds.mjs` merges darwin+windows. Azure Trusted Signing for the standalone `.msi` (release.yml:376-395); graceful skip → unsigned (SmartScreen). **Gap (docs/release-signing.md:112-117):** the update `.msi.zip` payload is **not** Authenticode-signed. |

## 3. Parity punch list

| # | Change | Location | Effort |
|---|---|---|---|
| 1 | **[BLOCKER]** Next-to-exe cli.js resolution (Win + Linux); ideally `resource_dir()` | server.rs:1303-1314 | **S** |
| 2 | `bundle.windows.webviewInstallMode` (`embedBootstrapper`/`offlineInstaller`) | tauri.conf.json:33-49 | S |
| 3 | Add **NSIS** target (per-user); `--bundles msi,nsis` | tauri.conf.json + release.yml:348 | M |
| 4 | Scope `swift/speech-helper` out of Windows/Linux bundles | tauri.conf.json:41 | S–M |
| 5 | Fix/remove Strategy 4 Windows `where chroxy` shim handling | server.rs:1351-1365 | S |
| 6 | macOS-centric `"brew install cloudflared"` strings on Windows | lib.rs:292, 1912 | S |
| 7 | Per-PR Windows compile check (currently only `v*` tags) | ci.yml (new job) | M |
| 8 | Document + handle external **Node 22** requirement on Windows | docs/ + first-run UX | M |
| 9 | Authenticode-sign the updater `.msi.zip` | release.yml / tauri.conf.json | M–L |
| 10 | `update_tray_badge` taskbar overlay-icon parity | lib.rs:374-379 | M |

## 4. Top 5 findings
1. **`resolve_cli_js` is macOS-`.app`-only → the installed Windows tray cannot start its own daemon.** Makes the shipped MSI non-functional for its core purpose. (BLOCKER; fix is S.)
2. **No `bundle.windows` block whatsoever** → WebView2 online-only, WiX perMachine/admin, no per-user NSIS.
3. **macOS `speech-helper` Mach-O bundled unconditionally into the MSI** — dead weight + wrong-platform.
4. **Node 22 is an undocumented external prerequisite on Windows** — not bundled, no Windows setup guide.
5. **Updater `.msi.zip` isn't Authenticode-signed** + the **Windows desktop build compiles only on `v*` tags** — so exactly this class of macOS-only-path regression rots undetected between releases.

## Overall rating + verdict — 2.3 / 5
The Windows tray is **one small bug away from launching and a handful of packaging changes away from real parity.** The scaffolding is genuinely good: signed MSI builds and ships, tray/window/autostart/updater plumbing is cross-platform, process-management code is carefully Windows-aware, and the server bundle is staged *correctly* for Windows. But the app is gated behind a **single macOS-only path assumption in `resolve_cli_js` that makes the installed daemon dead on arrival** — the highest-leverage, lowest-effort fix in the whole audit. Fix finding #1 + a CI compile check and the rating jumps to the high-3s immediately; address `bundle.windows`/NSIS/WebView2 and it reaches genuine macOS parity.
