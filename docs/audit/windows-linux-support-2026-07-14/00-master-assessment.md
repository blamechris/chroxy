# Master Assessment: Windows (& Linux/WSL2) Platform Support

**Target:** Get Chroxy fully running/set up on **Windows 11** with parity to the macOS Tauri tray app; verify **Linux via WSL2**.
**Panel:** 8 agents (4 core + 4 extended domain specialists)
**Aggregate rating:** **3.0 / 5** (weighted: core 1.0×, extended 0.8×)
**Date:** 2026-07-14
**Environment:** Windows 11 Pro, Node 24.18 (host) / Node 22.19 (WSL2 Ubuntu), cloudflared 2026.6.1, WebView2 present, VS2019 BuildTools present, **rustup/cargo absent**. Every agent ran commands on this machine — findings are empirical, not just code-reading.

---

## a. Auditor Panel

| Agent | Lens | Rating | Key contribution |
|---|---|:---:|---|
| **Skeptic** | Claims vs reality | 3.8 | Verified the server core actually works on this box; found the docs oversell a few headline claims (keychain, service). |
| **Builder** | Implementability / effort | 3.7 | File-by-file punch list + effort; confirmed the MSI already builds & ships; flagged the `resolve_cli_js` runtime blocker. |
| **Guardian** | Failure modes / safety | 2.5 | The `forceKill` no-op orphans the real agent on every Stop; plaintext creds; orphaned public tunnel after quit. |
| **Minimalist** | YAGNI / scope | 3.5 | Proved the minimal path (`npx chroxy start --tunnel none` + browser) works today; argues the tray is over-scoped for v1. |
| **Windows Expert** | Win32 internals | 2.5 | Reproduced the orphan bug live; verified DPAPI/`taskkill /T`/`schtasks`/`icacls` fixes all work; found a group-readable ACL leak. |
| **Tauri Expert** | Desktop packaging | 2.3 | **Authoritatively confirmed** the installed Windows MSI can't start its daemon (`resolve_cli_js` is macOS-`.app`-only). |
| **Tunneler** | CF tunnel / networking | 2.4 | Reproduced the default-`chroxy start` boot abort (40× HTTP 404); proved the naive "widen allowlist" fix is unsafe. |
| **Tester** | QA / test strategy | 3.0 | Ran the full Windows + WSL2 verification matrix; quantified the CI gap (~23% of Windows tests run on Windows). |

**The rating spread is itself a finding:** generalists rating the whole surface (3.5–3.8) saw a strong foundation; every domain specialist who went deep (2.3–2.5) hit a sharp unfinished edge. Both are true — **the base is solid; each subsystem has one serious gap.**

---

## b. Consensus Findings (high-confidence — 4+ agents agree)

### ✅ What genuinely works (verified live)
- **The Windows server daemon is a real first-class target.** `chroxy doctor` passes every check; `chroxy start --tunnel none` boots, serves `/health` 200, and spawns a live claude-tui session via conpty. **No native build toolchain is required** — node-pty ships checked-in win32-x64/win32-arm64 prebuilds. (Skeptic, Builder, Minimalist, Tester)
- **The static platform layer is excellent:** `win-spawn.js` (cmd.exe double-escaping, cross-spawn quality), `resolve-binary.js` (PATHEXT-correct), `platform.js` atomic `MoveFileExW` writes — all well-tested. (Skeptic, Guardian, Windows Expert, Tester)
- **The MSI already builds, signs (Azure Trusted Signing), and ships** via `release.yml`; tray/window/autostart plumbing is cross-platform (`tauri-plugin-autostart` = registry Run-key parity). (Builder, Tauri Expert, Skeptic)
- **WSL2/Linux is the best-supported *server* target:** systemd unit generation, verified boot + `/health` 200 inside WSL2. (Skeptic, Builder, Tester)

### ⚠️ The gaps everyone agrees on
1. **[BLOCKER] The installed Windows MSI can't start its own daemon.** `server.rs:1303-1314` `resolve_cli_js()` only knows the macOS `.app` layout; all four fallbacks fail on Windows. `auto_start_server` defaults true → guaranteed to hit. Fix is **Small** (next-to-exe branch / `resource_dir()`). *(Tauri Expert confirmed; Builder flagged; also breaks Linux AppImage/deb.)*
2. **[BLOCKER] Default `chroxy start` aborts before binding.** The pre-fork tunnel routability gate accepts only HTTP `{502,530}`, but a warming quick tunnel returns **404** → whole server exits. Reproduced 40× on this box. *(Tunneler, Minimalist.)*
3. **`forceKill` is a no-op on Windows** (`platform.js:133-139` — byte-identical branches). Combined with the `.cmd` shim wrapper, every Stop/teardown **orphans the real claude/node process** (still edits files, burns tokens). *(Guardian, Windows Expert reproduced live, Tester, Skeptic noted.)*
4. **Credentials are plaintext on Windows** — no DPAPI/Credential Manager (`keychain.js` is mac/linux-only). The "encrypted credentials at rest (OS keychain)" headline is uncaveated. DPAPI verified working on this box. *(Skeptic, Builder, Guardian, Windows Expert, Tester.)*
5. **`chroxy service install` dead-ends** — `cli/service-cmd.js:28-32` `exit(1)`s *before* the `getWindowsAlternatives()`/schtasks machinery `service.js` already contains. *(Skeptic, Builder, Windows Expert.)*
6. **The macOS Swift speech-helper (208KB Mach-O) is bundled into every Windows MSI** as dead weight (`tauri.conf.json:41`). *(Skeptic, Builder, Minimalist, Tauri Expert.)*
7. **No `bundle.windows` block** → WebView2 online-only bootstrapper, WiX perMachine/admin, no per-user NSIS option. *(Builder, Minimalist, Tauri Expert.)*
8. **Thin Windows CI:** only ~14/61 Windows unit tests run on a Windows runner; the desktop compiles only on `v*` tags (no per-PR check); zero Windows boot/tunnel/e2e. *(Skeptic, Builder, Tauri Expert, Tester.)*
9. **cloudflared install hints hardcode `brew install cloudflared`** at runtime (should be `winget install Cloudflare.cloudflared`). *(Minimalist, Tunneler.)*

---

## c. Contested Points

**1. Scope: "full macOS-tray parity" vs "minimal productive Windows setup."**
- *Minimalist:* the tray/MSI/signing/updater is over-built for v1; `npx chroxy start` + browser dashboard works today.
- *Tauri Expert / Builder:* the tray is one small fix from working and worth finishing.
- **Assessment — both are right, and they're not mutually exclusive.** There is a genuine "productive this afternoon" path (server + browser) AND the tray is unusually close (one Small fix). Recommendation sequences the cheap path first, the tray second.

**2. The tunnel fix: one-line allowlist widen vs architectural decouple.**
- *Minimalist:* "widen the 502/530 allowlist — one-line fix."
- *Tunneler (deeper evidence):* **refuted.** The 404 persisted for ~6 min *even with a healthy origin* — widening would declare a dead tunnel "routable" and hand the user a dead QR. Correct fix: **decouple boot from tunnel routability** (boot local, background-verify, advertise QR only on a connector-proven signal).
- **Assessment — Tunneler wins on evidence.** Do not add 404 to the success set.

**3. Is the shipping MSI functional?**
- *Skeptic:* "the MSI is real (v0.9.46 release)" — but did not runtime-test the installed app.
- *Tauri Expert:* the MSI **installs and opens a window**, but the daemon is **dead on arrival** (finding #1).
- **Assessment — no contradiction once separated:** it builds/ships/launches, but does not *function* on a clean box until `resolve_cli_js` is fixed. **This must be confirmed by actually installing the MSI** — the blocker is code-inferred (authoritatively, but not yet install-tested).

---

## d. Factual Corrections (to the docs / claims, found by the panel)

| Claim | Reality | Found by |
|---|---|---|
| "Encrypted credentials at rest (OS keychain)" (CLAUDE.md / README) | On Windows: **plaintext 0600 file**, no OS keychain. `docs/security/credentials-at-rest.md` is honest; the headline isn't. | Skeptic, Guardian, Windows Expert |
| README "double-click the MSI to install" (desktop) | Silently requires a **separately-installed Node 22**; not bundled, no Windows setup guide. | Skeptic, Tauri Expert |
| `platform.js` comment: profile dir grants "user-only ACLs" | **False in practice** — live check showed `<group>:(I)(RX)` (a secondary group can read secrets). | Windows Expert |
| `.gitattributes` `* text=auto eol=lf` | On-disk `.sh` files are **CRLF** (`core.autocrlf=true` masks it); breaks `./script` execution under WSL. | Tester |
| Repo version v0.10.0 (package.json) | Latest *released* MSI is **v0.9.46**; 0.10.0 hasn't shipped a desktop build. | Skeptic |

---

## e. Risk Heatmap

```
                          IMPACT
              Low          Medium          High
           +------------+------------+---------------------------+
    High   |            | brew hint  | forceKill orphans (F3)    |
           |            | (winget)   | resolve_cli_js MSI DOA(#1)|
  L        |            |            | tunnel boot-abort (#2)    |
  I        +------------+------------+---------------------------+
  K  Med   | CRLF .sh   | speech-    | plaintext creds (#4)      |
  E        | scripts    | helper in  | orphaned public tunnel    |
  L        |            | MSI        | after quit                |
  I        +------------+------------+---------------------------+
  H  Low   | version    | no bundle. | ACL group-read leak       |
  O        | mismatch   | windows    | (secrets readable)        |
  O        |            | block      |                           |
  D        +------------+------------+---------------------------+
```
Top-right cluster (High/High) = the three things that make Windows feel broken on first contact: the tray can't start its daemon, the default CLI command aborts, and Stop leaks the agent process.

---

## f. Recommended Action Plan (prioritized)

### Phase 0 — Unblock "works today" (hours, high leverage)
1. **Fix the tunnel boot-gate** (`tunnel-check.js` + `supervisor.js`): decouple server boot from quick-tunnel routability — boot local/LAN, background-verify, advertise the QR only on a connector-proven 200. **Do not** just add 404. *(Universal fix; unblocks the default `chroxy start`.)* — **M**
2. **Fix `resolve_cli_js`** (`server.rs:1303`): add a next-to-exe / `resource_dir()` branch. Then **install the MSI and runtime-test it** end-to-end. — **S + verify**
3. **Document + ship the "Windows quick start"**: `npm install` → `npx chroxy start --tunnel none --host 127.0.0.1` → browser dashboard. Works now. — **S**

### Phase 1 — Correctness & safety (the Guardian/Windows-Expert cluster)
4. **`forceKill` → `taskkill /PID <pid> /T /F`** (graceful paths `/T` without `/F`); wire into `cli-session.js`, `jsonl-subprocess-session.js`, `supervisor.js`, `user-shell-session.js`. Verified working. — **M**
5. **Windows credentials via DPAPI** (`_winGetToken/_winSetToken`, `ProtectedData.Protect('CurrentUser')`); `credential-cipher.js` stays identical; report `backend:'dpapi'`. — **M**
6. **Harden `writeFileRestricted`** (`icacls /inheritance:r /grant:r <user>:F /grant:r SYSTEM:F` + AV-lock retry). — **S**
7. **Fix orphaned cloudflared on quit** — call `kill_orphan_cloudflared` from stop/close/exit paths (or a Job Object). — **S/M**
8. **Make the embedded user-shell Windows-aware** (`defaultShell()`/PowerShell + `taskkill /T`). — **S**

### Phase 2 — First-class Windows setup UX (toward macOS parity)
9. **`chroxy service install` via `schtasks`** — replace the `exit(1)`; wire `service.js` win32 branches. — **M**
10. **Per-platform cloudflared install hints** (winget/pkg.cloudflare.com). — **S**
11. **Add `bundle.windows`** — `webviewInstallMode: embedBootstrapper`, optional NSIS per-user target; scope the Swift helper out of Windows/Linux bundles. — **M**
12. **Document Node 22 prerequisite** (or bundle a Node runtime for a true double-click). — **S/M**

### Phase 3 — Keep it working (CI + Linux/WSL2)
13. **Per-PR `windows-latest` `cargo check`** for the desktop; run the full Windows test suite (incl. `service.test.js` after guarding its 10 POSIX-only asserts) on the Windows runner. — **S/M**
14. **Windows boot/tunnel smoke** (port the ubuntu `dashboard-smoke` job) + a tag-time install-the-MSI-and-launch check. — **M**
15. **Document the WSL2 story**: run the Linux server in WSL2 with `--host 0.0.0.0` (localhost-forwarded to Windows); for phone access, **install cloudflared inside WSL2** (outbound tunnel sidesteps NAT). Add `.gitattributes`/`autocrlf` guard so `.sh` stays LF. — **S**
16. Optional: **`desktop-linux`** release job (deb/appimage) for a native Linux tray. — **M**

---

## g. Final Verdict — 3.0 / 5

**Chroxy on Windows is a strong, real foundation with two first-contact blockers and a cluster of unfinished safety/packaging edges — not a port that needs writing, but one that needs finishing.** The server daemon genuinely runs on Windows and in WSL2 (verified: doctor green, `/health` 200, conpty spawning a live Claude session, 61/71 platform unit tests passing, no build toolchain required), and the MSI already builds and ships signed. That is materially better than the usual "runs on Windows (untested)" hand-wave.

But a user's *first two* interactions both fail today: the shipped tray app can't start its bundled daemon (`resolve_cli_js` is macOS-only), and the default `chroxy start` aborts before binding (tunnel routability gate rejects the edge's warm-up 404). Both fixes are small-to-medium and were pinned to exact lines. Underneath sit the Guardian-class issues — Stop orphans the real agent process, and API keys sit in plaintext — which are pure implementation gaps (every needed Win32 primitive was verified working on this machine).

**Recommendation: proceed, in the Phase 0→3 order above.** Phase 0 (a day of work) gets a Windows user genuinely productive and makes the tray functional; Phases 1–3 close the safety and parity gap to the macOS experience. The "full macOS-tray parity" framing is achievable, but the fastest win is to ship the minimal path now and treat the tray as a fast-follow rather than a prerequisite. **The single most important next step is to fix `resolve_cli_js` and actually install-and-run the MSI** — it's the one high-impact claim in this audit that is code-confirmed but not yet runtime-verified.

---

## h. Appendix — Individual Reports

| # | Agent | Rating | File |
|---|---|:---:|---|
| 01 | Skeptic | 3.8 | [01-skeptic.md](01-skeptic.md) |
| 02 | Builder | 3.7 | [02-builder.md](02-builder.md) |
| 03 | Guardian | 2.5 | [03-guardian.md](03-guardian.md) |
| 04 | Minimalist | 3.5 | [04-minimalist.md](04-minimalist.md) |
| 05 | Windows Expert | 2.5 | [05-windows-expert.md](05-windows-expert.md) |
| 06 | Tauri Expert | 2.3 | [06-tauri-expert.md](06-tauri-expert.md) |
| 07 | Tunneler | 2.4 | [07-tunneler.md](07-tunneler.md) |
| 08 | Tester | 3.0 | [08-tester.md](08-tester.md) |

*Aggregate: (3.8+3.7+2.5+3.5)×1.0 + (2.5+2.3+2.4+3.0)×0.8 = 13.5 + 8.16 = 21.66 over weight 7.2 = **3.01 → 3.0/5**.*
