# Skeptic's Audit: Windows/Linux Platform Support
**Agent**: Skeptic — cynical systems engineer, cross-references every claim against code
**Overall Rating**: 3.8 / 5
**Date**: 2026-07-14

I came in expecting "cross-platform" theater. I mostly found the opposite: the Windows server code is real, tested on a real `windows-latest` CI runner, and I verified it runs on this box — `chroxy doctor` passes, the CLI works, and the Windows platform tests are 14/14 green. The MSI genuinely ships (it's attached to the v0.9.46 GitHub Release). The gaps are in the *edges* — service install, credential security, and the desktop app's macOS-only baggage — not the core.

## 1. Dimension ratings

### (a) Server daemon on Windows — 4.5 / 5
First-class, not a bolt-on. `platform.js` does atomic `MoveFileExW` writes with a documented NTFS-ACL rationale; `utils/win-spawn.js:36-98` implements the battle-tested cross-spawn cmd.exe double-escaping for `.cmd`/`.bat` shims (real problem: Node 24's CVE-2024-27980 fix + DEP0190 arg-mangling); `utils/resolve-binary.js:35-91` correctly uses `where`+`PATHEXT` and rejects the non-runnable extensionless npm wrapper. **Verified live**: `node src/cli.js doctor` → "All checks passed" (cloudflared 2026.6.1 detected, port 8765 free, claude 2.1.195 drivable); platform tests pass on this actual Windows 11 host. Only nit: `platform.js:133-139` `forceKill` has two identical branches — cosmetic "Windows-aware" veneer.

### (b) Tunnel / cloudflared on Windows — 4.5 / 5
`cloudflared.exe` is found on PATH and detected by doctor. `desktop/src-tauri/src/server.rs` has genuinely thorough Windows orphan-cleanup: netstat+taskkill for port holders, `wmic` process enumeration **with a PowerShell `Get-CimInstance` fallback for Windows 11 22H2+** where wmic was removed (server.rs:734-849). README winget instructions are correct. This is more careful than most projects bother with.

### (c) Tauri desktop app on Windows — 3 / 5
The MSI is real (v0.9.46 release), the Rust is Windows-aware (node/server/discovery), and `release.yml:279-404` is a legitimate `windows-latest` MSI job with Azure Trusted Signing wired up. But: voice-to-text is macOS-only, a **dead 208KB macOS Mach-O gets bundled into every Windows MSI** (finding 3), Node isn't bundled (finding 4), and the Windows desktop build never runs on PRs (finding 5). "Works, with gaps."

### (d) Setup / install / first-run — 3 / 5
Server first-run is smooth (real "Running on Windows" README section, working winget commands, doctor). The drop-offs: `chroxy service install` dead-ends (finding 1), the tray app silently needs Node (finding 4), and the credential-at-rest story is weaker and uncaveated (finding 2).

### (e) Linux / WSL2 — 4.5 / 5
Linux is first-class: `service.js:129-166` generates a proper systemd user unit, and CI runs the **full** server suite on a self-hosted Linux ARM64 runner. **WSL2 verified live**: `wsl -d Ubuntu` boots, Node v22.19.0 present via nvm (meets the requirement). Bonus: `control-room/wsl.js` surveys/starts/terminates WSL distros with correct UTF-16LE decoding of `wsl.exe` output. Only friction: cloudflared isn't in the WSL distro by default (user installs it, or uses `--tunnel none`).

## 2. Top 5 findings (claim vs reality)

**1. `chroxy service install` hard-blocks on Windows and throws away the alternatives the library built.**
`service.js:173-191` defines `getWindowsAlternatives()` (Task Scheduler / NSSM / PM2 with copy-paste commands), and `service.js:468-475` has an `installService` win32 branch returning `{ installed:false, message, alternatives }`. **None of it is reachable.** `cli/service-cmd.js:28-32` short-circuits *before* that with a bare `console.error('Error: Service install is not supported on Windows.')` + `process.exit(1)`. So the polished Windows-alternatives machinery is dead code on the CLI path; the user gets a bare error, not the guidance. README.md:338-341 documents the alternatives, but the tool itself contradicts the library layer.

**2. "Encrypted credentials at rest (OS keychain)" is false on Windows — it's a 0600 plaintext file.**
CLAUDE.md and README.md:69 list "encrypted credentials at rest" as an unconditional feature. `keychain.js:11` imports only `isMac, isLinux` — there is **no Windows Credential Manager / DPAPI backend**. On Windows, `keychain.js:163/180` returns `backend: 'file'`, "no OS keychain on this platform — using the 0600 file/env fallback" (I saw this exact line in live `doctor` output). And `platform.js:39-46` documents that 0600 mode bits are "mostly a no-op" on Windows — protection is *only* NTFS ACL inheritance. The detailed `docs/security/credentials-at-rest.md:56-60` is honest ("Windows → 0600 plaintext + one-time warning"), but the headline feature claims never caveat it.

**3. Every Windows MSI bundles a useless committed macOS Swift binary; voice-to-text doesn't exist on Windows.**
`tauri.conf.json:39-42` bundles `"swift/speech-helper": "speech-helper"` as a resource on **all** platforms. `swift/speech-helper` is a **committed 208KB macOS universal Mach-O** (`git ls-files` confirms it's tracked; `file` reports x86_64+arm64 Mach-O). `build.rs:55` compiles/signs it only under `#[cfg(target_os = "macos")]`. Net effect: the Windows MSI ships a dead macOS executable, and README.md:72's "voice-to-text (macOS SFSpeechRecognizer)" desktop feature is simply absent on Windows.

**4. The "double-click MSI" tray app silently requires a separately-installed Node 22 — undocumented in the desktop section.**
`node.rs:30-58` resolves Node from `%ProgramFiles%/nodejs`, nvm-windows, or `where node`; the bundle (`bundle-server.sh`) stages server JS + node_modules but **no Node runtime**. So the tray app spawns the user's system Node. README.md:343-345 ("Download the latest MSI … double-click to install") never states Node 22 is a prerequisite for the desktop app.

**5. The Windows desktop build has zero PR-time CI, and the MSI is unsigned by default.**
The only Windows CI job (`ci.yml:186-260`, `server-tests-windows`) runs just **two** platform test files. The Windows Tauri MSI build (`release.yml:279`) fires **only on `v*` tags** — a PR that breaks the Windows desktop build isn't caught until release. Additionally, `release.yml:350-374` ships the MSI **unsigned** unless six Azure Trusted Signing secrets are set, so downloaders hit the SmartScreen wall. (Aside: repo is at v0.10.0 in package.json:3 / tauri.conf.json:3, but the latest release is v0.9.46 — 0.10.0 hasn't shipped an MSI yet.)

## 3. Recommendations (ordered)

1. **Fix the `service install` dead-end (finding 1).** Replace the `process.exit(1)` in `service-cmd.js:28-32` with a call to `installService()` and print the `alternatives` array service.js already returns. Optionally implement real `schtasks`-based install.
2. **Stop misrepresenting credential security on Windows (finding 2).** Either add a Windows Credential Manager / DPAPI backend to `keychain.js`, or qualify the CLAUDE.md/README headline feature to "OS keychain on macOS/Linux; 0600 file on Windows."
3. **Exclude the Swift helper from non-macOS bundles (finding 3).** Move `swift/speech-helper` into a macOS-only resource overlay so the Windows/Linux bundle doesn't ship a dead Mach-O.
4. **Document the desktop Node prerequisite (finding 4)** in README's "Desktop tray app" Windows section, or bundle a Node runtime into the MSI.
5. **Add a PR-gated Windows desktop build (finding 5)** — at minimum `cargo build --target x86_64-pc-windows-msvc` on `windows-latest` for desktop-touching PRs.

## 4. Verdict

**Windows parity is close, not misrepresented — but "parity" is overstated by a few uncaveated headline claims.** The server daemon, tunnel handling, and Linux/WSL2 stories are the real deal: I ran them here and they work, the CI has an actual Windows runner, and the MSI genuinely ships. Where it falls short of true macOS parity is exactly where you'd predict: no native service installer (and the CLI rudely hides the workarounds it already coded), no Windows keychain so credentials land in a near-unprotected file, a desktop app that carries dead macOS voice-input code and a hidden Node dependency, and Windows desktop builds that only get exercised at release time. None of these are fundamental — they're finishing work. Call it 3.8/5.
