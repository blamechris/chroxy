# Guardian's Audit: Windows/Linux Platform Support
**Agent**: Guardian — paranoid SRE, finds race conditions and orphaned-process nightmares
**Overall Rating**: 2.5 / 5
**Date**: 2026-07-14

The code is honest and unusually well-commented about its cross-platform seams — but honesty about a gap is not the same as closing it. On the default Windows install path (npm-global `claude.cmd`, no keychain), two of my five dimensions are effectively broken: the daemon **orphans the real agent process on every session teardown and every Stop**, and it stores its highest-value secrets in **plaintext**. The Tauri tray has genuinely good orphan-cloudflared cleanup, which pulls the overall score up from "broken."

## 1. Dimension ratings

| Dimension | Rating | One-line verdict |
|---|---|---|
| (a) Process/child cleanup on Windows | **1.5 / 5** | `forceKill` kills only the direct PID; the `cmd.exe` wrapper guarantees the real claude/node is orphaned. No `taskkill /T`, no job objects in the Node server. |
| (b) Command-injection / spawn safety | **4.0 / 5** | `prepareSpawn` uses the battle-tested cross-spawn escaper with adversarial round-trip tests; no `shell:true`+interpolation anywhere; `execFile` with arg arrays throughout. |
| (c) Paths & file-write integrity | **3.0 / 5** | Atomic temp+rename is correct and documented, but no Windows ACL hardening, no AV-lock retry on the cred store, no long-path handling. |
| (d) Credentials at rest | **2.0 / 5** | Windows = plaintext. No DPAPI, no Credential Manager. A documented, deliberate gap — but a hard parity break vs. macOS/Linux keychain encryption. |
| (e) WSL2 boundary safety | **4.0 / 5** | `execFile` (no shell), correct UTF-16LE decode, degradation-first, handler validates distro against a live survey. |

## 2. Top 5 findings

### Finding 1 — Windows session teardown *and the Stop button* orphan the real agent process (CRITICAL)
**Files:** `utils/win-spawn.js:85-98`, `platform.js:133-139`, `cli-session.js:521-527`, `:1723`, `:1467`
A standard npm-global Claude Code install on Windows ships `claude.cmd` with **no** `claude.exe`, so `pickWindowsExecutable` (`resolve-binary.js:35-45`) selects the `.cmd` shim. `prepareSpawn` then rewrites the spawn to run **`cmd.exe /d /s /c "…"`** — so `this._child.pid` is the `cmd.exe` wrapper, and the actual `claude`→`node` process is a *grandchild*.

Every teardown path targets the wrapper, not the tree:
- Interrupt / Stop: `this._child.kill('SIGINT')` (`cli-session.js:1723`). On Windows Node cannot signal another process; this becomes `TerminateProcess(cmd.exe)`. **The wrapper dies; claude/node keeps running its turn** — still calling the API and editing files while the UI reports "stopped."
- Destroy / respawn: `forceKill(oldChild)` (`:1467`, `:1799`) → `TerminateProcess(cmd.exe)` → same orphan.

**Failure scenario:** User hits Stop mid-turn. The wrapper is killed; the orphaned `node` continues writing files and consuming tokens. Over a session, orphaned `node.exe` processes accumulate with no owner and no UI to kill them.

### Finding 2 — `forceKill` has an identical, no-op Windows branch — no process-tree kill (HIGH)
**File:** `platform.js:133-139`
```js
export function forceKill(child) {
  if (isWindows) { child.kill('SIGKILL') } else { child.kill('SIGKILL') }
}
```
Byte-for-byte identical branches — Windows tree-kill was scaffolded and never implemented. `child.kill()` on Windows only `TerminateProcess`es the direct PID. Any session that spawns grandchildren (MCP servers, `bash-exec.js` subprocesses, node-pty/conhost user shells) leaks them. **Fix:** `taskkill /PID <pid> /T /F` (whole tree) or a Job Object with `KILL_ON_JOB_CLOSE`.

### Finding 3 — Credentials stored in plaintext on Windows; no DPAPI / Credential Manager (HIGH)
**Files:** `keychain.js:211-222`, `credential-cipher.js:66-88`, `docs/security/credentials-at-rest.md:58-62`. A repo-wide grep for `dpapi|CryptProtectData|cmdkey|ConvertFrom-SecureString|Credential Manager` returns **zero** hits. On Windows there is no keychain, so the 32-byte data key can't be stored, so `credentials.json` — holding **BYOK provider API keys and the Claude Code OAuth token** — stays cleartext. Windows *has* the right primitive: **DPAPI `CryptProtectData`** ties a blob to the user's login without a stored key.
**Failure scenario:** A backed-up / OneDrive-roamed / stolen-disk Windows profile exposes every provider API key in plaintext.

### Finding 4 — `writeFileRestricted` sets no ACLs on Windows; "0600" is POSIX-only (MEDIUM)
**File:** `platform.js:113-114` — on Windows writes with no mode/ACL, relying entirely on `%USERPROFILE%` ACL inheritance. If `credentials.json` is ever created in or moved to a directory with looser inheritance, other principals can read it. Separately, the documented AV-held-handle retry that `_rotateToBak` has is *deliberately omitted* here (platform.js:70-82) — a transient Defender lock on the rename throws straight to the caller.

### Finding 5 — Orphaned `cloudflared` keeps the PUBLIC tunnel live after quit/crash (MEDIUM-HIGH)
**Files:** `desktop/src-tauri/src/server.rs:1069-1073` (`child.kill()` = `TerminateProcess`), `supervisor.js:900` (comment "reaped on full exit" — a **false POSIX assumption** on Windows), `tunnel/cloudflare.js:229-233`. On Windows, `TerminateProcess` gives the node server **no cleanup window**, so `tunnel.stop()` never runs and `cloudflared` is orphaned. The Tauri app only cleans it up on the **next** start (`server.rs:659-684`).
**Failure scenario:** User quits the tray app. `cloudflared` survives and the `*.trycloudflare.com` URL stays publicly reachable — fingerprintable via `/health`, open to pairing attempts — with **no local UI to see or stop it**, indefinitely.

## 3. Concrete hardening recommendations
1. **Kill the tree, not the PID.** `taskkill /PID <pid> /T /F`, or a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Closes Findings 1, 2, half of 5.
2. **Make Stop actually stop on Windows.** Spawn sessions with `CREATE_NEW_PROCESS_GROUP` + `CTRL_BREAK` via `GenerateConsoleCtrlEvent`, or route interrupt through provider stdin, or at minimum `taskkill /T` the wrapper's tree.
3. **Job-object the Tauri-spawned server** (kill-on-close) + send a real shutdown IPC before `TerminateProcess`.
4. **Implement Windows credentials-at-rest via DPAPI** (`CryptProtectData`, user scope) or Credential Manager (`CredWrite`/`CredRead`).
5. **Harden `writeFileRestricted`** with an explicit owner-only ACL (`icacls`) + the one-shot AV-lock retry.
6. **Long paths:** add `\\?\` prefixing or a `LongPathsEnabled` preflight for deep worktree/container paths (>260).
7. **WSL defense-in-depth:** have `runWslAction` (`control-room/wsl.js:168`) re-validate `distro` against a fresh survey and reject names starting with `-`.

## 4. Overall verdict — 2.5 / 5
Chroxy on Windows is a house with excellent locks on some doors and no walls on others. The spawn-escaping, the WSL2 boundary, the atomic file writes, and the Tauri-side orphan-cloudflared cleanup are all genuinely careful, well-tested work. But the two things a paranoid SRE cares about most at 3am — *does killing the parent kill the children, and are my secrets safe on disk* — both fail on the **default** Windows install. The fixes are well-understood Win32 primitives (Job Objects, `taskkill /T`, DPAPI, `icacls`) — the gap is implementation, not design knowledge. Until Findings 1–3 are closed, I would not call Windows at parity with the macOS tray, and I would warn any Windows user that "Stop" is advisory and their API keys are on disk in the clear.
