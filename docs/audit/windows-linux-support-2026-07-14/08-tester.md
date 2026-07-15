# Tester's Audit: Windows/Linux Platform Support
**Agent**: Tester — QA/test-strategy specialist
**Overall Rating**: 3.0 / 5
**Date**: 2026-07-14

## 1. WSL2 / Linux verification results (everything below was actually run)

**Environment:** WSL2 Ubuntu (`Linux 6.6.87.2-microsoft-standard-WSL2`), Node **v22.19.0** (nvm login shell). No `cloudflared` inside the distro. Windows host: Node v24.18.0, cloudflared 2026.6.1.

| # | Command (in WSL, repo via `/mnt/c/...`) | Result |
|---|---|---|
| 1 | `node src/cli.js doctor` | **Ran.** Node OK v22.19.0; `cloudflared` **FAIL** (absent in WSL); Config WARN; Credential WARN (secret-service unavailable → file fallback); **claude-tui driving claude 2.0.22** (older than Windows' 2.1.195); Port 8765 free. |
| 2 | `node -e "require('node-pty')"` | **FAILED:** `Cannot find module './prebuilds/linux-x64//pty.node'`. The `/mnt/c` node_modules was `npm install`-ed on **Windows** — no linux prebuild, no compiled `build/Release`. |
| 3 | `node src/cli.js start --tunnel none --host 127.0.0.1 --skip-checks` | **HTTP/WS server BOOTED** in WSL: `Server listening on 127.0.0.1:8766`, `/health` → **HTTP 200**. The auto-created claude-tui session then **failed gracefully** (node-pty unavailable). **Key insight: the HTTP/WS core does not need node-pty at boot; only PTY-backed sessions do.** |

**Localhost-forwarding (tested from Windows against the running WSL server):**

| WSL bind | From Windows `localhost:8766` | From Windows WSL-VM-IP `172.19.80.139:8766` |
|---|---|---|
| `--host 127.0.0.1` | **HTTP 000** (unreachable) | n/a |
| `--host 0.0.0.0` | **HTTP 200** | **HTTP 200** |

WSL2 localhostForwarding forwards Windows→WSL **only for `0.0.0.0`-bound** servers. To reach a WSL-hosted chroxy from Windows you must use `--host 0.0.0.0` (chroxy's default) — `127.0.0.1` silently isolates it.

**Native-Windows parity check (ran):** `start --tunnel none --host 127.0.0.1 --skip-checks --no-auth` → `/health` **HTTP 200**; node-pty **conpty loaded** and spawned the claude TUI. Windows server boot works end-to-end.

**Line-ending / exec-bit hazards:**
- `.gitattributes` declares `* text=auto eol=lf`, **but** `core.autocrlf=true` and on-disk `.sh` files have **CRLF** (`before-build.sh` shebang ends `bash\r\n`). `git status` clean (autocrlf masks it). A CRLF script run **directly** in WSL → `/usr/bin/env: 'bash\r': No such file or directory`; run as **`bash script.sh`** → works. So `bash foo.sh` (how CI/Tauri call them) tolerates CRLF; `./foo.sh` breaks.
- Exec-bit is a non-issue from `/mnt/c` (DrvFs mounts `-rwxrwxrwx`).
- **Feasibility verdict for `/mnt/c`:** doctor + HTTP/WS boot + pure-JS paths run fine. A **native Linux `npm install` is required** for node-pty (PTY sessions). A native clone is preferable.

## 2. Windows test coverage assessment

**Ran on native Windows (Node v24.18.0):**

| Suite | Result |
|---|---|
| `platform.test.js` | **9/9 pass** |
| `platform-windows.test.js` | **5/5 pass** |
| `win-spawn.test.js` | **8/8 pass** |
| `windows-cmd-routing.test.js` | **6/6 pass** |
| `resolve-binary.test.js` | **14/14 pass** |
| `control-room-wsl.test.js` | **17/17 pass** |
| `service.test.js` | **82 pass / 10 FAIL** |

The 10 `service.test.js` failures are **test-portability defects, not product bugs** (POSIX path separators asserted on Windows `path.join`; `resolveNode22Path` asserts Node-22 on a Node-24 box). None are guarded for `win32`.

**What CI actually covers on Windows:**
- `server-tests-windows` (`windows-latest`, ci.yml:186-260) runs **only** `platform.test.js` + `platform-windows.test.js` (**14 tests**), gated to PRs touching `platform*`.
- The other five Windows-relevant suites run **only on self-hosted ARM64 Linux**, where their `isWindows` branches are **skipped**.
- `desktop-windows` MSI/Tauri build (release.yml:279-404) runs **only on `v*` tags** — no per-PR Windows desktop compile check. Rust `cargo test` runs **only on self-hosted macOS**.
- `dashboard-smoke` (Playwright) runs **only on ubuntu**. **Zero** Windows server-boot / tunnel / e2e coverage in CI.

**Quantified gap:** ~61 Windows-behavior unit tests exist; CI runs **14 (~23%)** on a Windows runner. **0** desktop Rust tests and **0** Windows server-boot/tunnel/e2e tests run on Windows in CI.

## 3. Highest-risk untested Windows paths + the test that should exist

| Risk | Evidence | Test that should exist |
|---|---|---|
| **`forceKill` no tree-kill** | `platform.js:133-139` identical no-op branch | Spawn child→grandchild, `forceKill(child)`, assert grandchild gone (needs `taskkill /T /F` first). |
| **`.cmd`-shim Stop/interrupt orphaning** | `win-spawn.js` routes via `cmd.exe /d /s /c` | Launch a `.cmd` shim with a long-lived grandchild; interrupt; assert whole tree dies. |
| **No Windows credential keychain** | `keychain.js:163,180` → file fallback | Windows Credential Manager/DPAPI backend + retrievable-and-not-world-readable test. |
| **`service.test.js` 10 failures + no Windows service test** | POSIX-only asserts | Guard launchd/systemd tests behind `plat`; add file to Windows CI job. |
| **Installed-MSI runtime path** | MSI built only at release, never installed in CI | Nightly/tag job: install MSI on `windows-latest`, launch tray, assert dashboard served. |
| **Tunnel routability on Windows** | cloudflared present but untested | Windows smoke: `--tunnel quick`, curl the resulting URL. |
| **Windows server boot** | verified manually, no CI | Port the ubuntu `dashboard-smoke` job to a gated `windows-latest` run. |

## 4. Manual verification matrix

| Dimension | Command | Expected | Status (this audit) |
|---|---|---|---|
| Doctor | `node packages/server/src/cli.js doctor` | All checks pass (Node WARN on 24) | **PASS (ran)** |
| Server start + health | `start --tunnel none --host 127.0.0.1 --skip-checks --no-auth` + `curl /health` | `HTTP 200` | **PASS (ran)** |
| Session spawn (conpty) | boot log | `spawn claude TUI`, conpty loads | **PASS (ran)** |
| Session interrupt / tree-kill | start a turn, stop, check orphans | no orphaned descendants | **NOT PASS (code review)** — `forceKill` no-op → orphans |
| Credential store | doctor cred line | ideally OS-keychain | **DEGRADED (ran)** — file fallback |
| Windows unit suites | 6 platform/win files via `node --test` | all pass | **PARTIAL (ran)** — 61 pass; `service.test.js` 10 fail (portability) |
| Tunnel (quick) | `start --tunnel quick` | prints URL; `/health` reachable | **NOT RUN** (avoided public tunnel) |
| Service / autostart | `service install` | configured or clear guidance | **NOT RUN** — win32 branch minimal |
| Desktop MSI install + run | build/install/launch | tray runs, wraps dashboard | **NOT RUN** — only built at release |
| WSL2 host → Windows client | WSL `start --host 0.0.0.0`; Windows `curl localhost/health` | HTTP 200 | **PASS (ran)** — 200 for `0.0.0.0`; **000 for `127.0.0.1`** |

## 5. Dimension ratings (1–5)

| Dimension | Rating | Basis |
|---|---|---|
| (a) Linux/WSL2 runnability | **4 / 5** | Core boots on Node 22, `/health` OK, PTY works once natively installed. Friction: `/mnt/c` needs native `npm install`, cloudflared absent, `127.0.0.1`-bind not forwarded. |
| (b) Windows unit-test coverage | **3 / 5** | Good breadth (61 tests) mostly passing, but `service.test.js` 10 unguarded failures + top runtime risk (`forceKill`) untested. |
| (c) Windows CI coverage | **2 / 5** | Only 14/61 tests on a Windows runner; no per-PR desktop build; no Windows boot/tunnel/e2e. |
| (d) Testability of desktop app | **2 / 5** | Rust tests macOS-only; MSI built only at release; installed-MSI runtime never tested. |
| (e) Confidence parity is real | **3 / 5** | Windows server core empirically works, but thin CI leaves parity partly unverified. |

## 6. Top 5 findings
1. **`forceKill` dead Windows branch** — highest-severity untested Windows path; no test exists.
2. **CI Windows coverage ~23%** of existing Windows tests; desktop MSI compiled only at release.
3. **node-pty not portable Windows-tree→WSL** — HTTP/WS core still boots, but PTY sessions fail; WSL needs a native Linux `npm install`.
4. **No Windows encrypted credential store** — 0600 file fallback, no DPAPI.
5. **`.sh` scripts carry CRLF despite `eol=lf`** (`core.autocrlf=true`); `service.test.js` has 10 unguarded POSIX-only failures.

**Verdict:** Windows is a genuinely working first-class *server* target — I booted the daemon on native Windows and in WSL2, got `/health` 200 on both, saw conpty spawn a real claude TUI, and 61 of 71 Windows-relevant unit tests pass. But "parity" is only partly *proven*: CI exercises a fraction of the Windows tests, never compiles the desktop per-PR, and never runs a Windows boot/tunnel/e2e or installed-MSI check. Two concrete correctness gaps sit underneath — `forceKill`'s no-op branch and the absent Windows credential keychain — both exactly what the current CI matrix would never catch. Net: the platform *works*, but the *evidence that it keeps working* is where the investment is missing.
