# Windows Expert's Audit: Windows/Linux Platform Support
**Agent**: Windows Expert — deep Win32 specialist (process model, DPAPI, service control, ACLs)
**Overall Rating**: 2.5 / 5
**Date**: 2026-07-14

I ran the code on this Windows 11 box, reproduced the orphan bug, verified the proposed fixes, and confirmed every recommended Win32 primitive (DPAPI, `cmdkey`, `schtasks`, `taskkill /T`) is present and working. Findings below are grounded in `file:line` plus command output.

## 1. Dimension ratings (1–5)

| Dimension | Rating | One-line justification |
|---|---|---|
| (a) Process / tree-kill correctness | **2.0** | `forceKill` is a literal no-op branch; empirically confirmed it orphans the real claude/node grandchild under the cmd.exe shim. |
| (b) Credentials / DPAPI | **1.5** | Zero DPAPI/CredMan. Secrets sit in plaintext `credentials.json`; the "0600 file" is a near-no-op on NTFS. |
| (c) Service management | **2.0** | `service install` hard-`exit(1)`s before the existing `getWindowsAlternatives()` can render; no `schtasks` integration. |
| (d) File ACLs & paths | **2.5** | Atomic write path is correct and Windows-aware, but no ACL hardening (a secondary group can read secrets — confirmed), no long-path handling, no AV-retry on `service.json`. |
| (e) Binary / shell resolution | **3.0** | `resolve-binary.js` PATHEXT logic is genuinely correct and well-tested; but the embedded user-shell is POSIX-only and broken on Windows. |

## 2. Top 5 findings

### Finding 1 — CONFIRMED: `forceKill` is a no-op branch; orphans the real process tree
`platform.js:133-139` is byte-identical in both arms (`child.kill('SIGKILL')`). Node's `.kill()` on Windows → `TerminateProcess(handle)` on the **top process only**. Combined with `win-spawn.js:prepareSpawn` wrapping every `.cmd` shim in `cmd.exe /d /s /c` (used by `cli-session.js:521` for claude **and** `jsonl-subprocess-session.js:302` for codex/gemini/deepseek/ollama), killing the child kills only the cmd.exe wrapper.

**Reproduced live:**
```
cmd.exe pid = 46472 ; grandchild pid = 14732
--- child.kill("SIGKILL") on cmd.exe (what forceKill does) ---
cmd.exe alive after kill? false ; grandchild 14732 alive? true
RESULT: orphaned grandchild = true
```
Affected teardown paths: `cli-session.js:1467/1799`, `jsonl-subprocess-session.js:163/178`, `supervisor.js:894`.

**Win32 fix (verified reaps tree):** `execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])`. Graceful kills should become `taskkill /PID <pid> /T` (no `/F`) with `/F` escalation on the grace timer. Robust alternative: Win32 **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (needs a native addon; `taskkill /T` is the pragmatic no-native-deps fix).

### Finding 2 — CONFIRMED: credentials are plaintext on Windows; no DPAPI anywhere
`keychain.js:1-11` documents "Windows/fallback: returns null"; every helper implements only `_mac*`/`_linux*` (lines 100, 176-181, 221, 265, 287). `credential-cipher.js:19-26` falls back to **plaintext** `credentials.json`. `chroxy doctor`: `[ OK ] Credential storage  file fallback — no OS keychain on this platform`. Grep `dpapi|CryptProtectData|cmdkey|ConvertFrom-SecureString` → **zero hits**.

**Win32 fix — DPAPI fits the master-key model.** `credential-cipher.js` already does envelope encryption with a 32-byte data key; it just needs a keychain-equivalent place to store it. **Verified DPAPI works on this box:** `DPAPI roundtrip OK ; cipher bytes: 246`. Implement `_winGetToken`/`_winSetToken` storing a DPAPI-protected key (`[Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')`) in `%LOCALAPPDATA%\Chroxy\cred-key.dpapi`. The cipher stays identical; only the key vault changes. Update `keychainHealth()` to report `backend: 'dpapi'`.

### Finding 3 — CONFIRMED: `service install` dead-ends before the Windows machinery runs
`cli/service-cmd.js:28-32` hard-exits on Windows, pre-empting the *working* path in `service.js` (`getServicePaths('win32')` line 58-63; `installService` win32 branch line 468-475; `getWindowsAlternatives()` line 173-191 already returns the correct `schtasks` command).

**Win32 fix (schtasks.exe confirmed present):**
- install: `schtasks /Create /TN "Chroxy" /TR "\"<node>\" \"<chroxyBin>\" start" /SC ONLOGON /RL HIGHEST /IT /F`
- start: `schtasks /Run /TN "Chroxy"` ; stop: `schtasks /End /TN "Chroxy"`
- status: `schtasks /Query /TN "Chroxy" /FO LIST /V` ; uninstall: `schtasks /Delete /TN "Chroxy" /F`
Slot into the existing `win32` branches. `getServiceStatus` can keep the `process.kill(pid,0)` liveness probe (works on Windows). Do **not** bake secrets into `/TR`. Note ONLOGON vs `/SC ONSTART /RU SYSTEM` trade-off (user-scope DPAPI won't reach machine-account secrets).

### Finding 4 — CONFIRMED: `writeFileRestricted` sets no ACL; a secondary group can read secrets
`platform.js:113-118` — on Windows writes with no mode, relying on NTFS inheritance. **Live check of the actual files:**
```
C:\Users\<user>\.chroxy\config.json
   <HOST>\<group>:(I)(RX)   ← a secondary local GROUP can READ
   ...all ACEs (I) = inherited; no explicit owner-only ACE
```
Same inherited ACL on `server-identity.json`, `ingest-secret`, `session-state.json`, and would be on `credentials.json`. macOS `0600` excludes group/other entirely — concrete parity gap + actual secret-exposure path. Also omits the AV-lock retry `_rotateToBak` has; `saveServiceState` (`service.js:421`) has no caller-level retry.

**Win32 fix:** after rename, `icacls <file> /inheritance:r /grant:r "%USERNAME%":F /grant:r SYSTEM:F` (true 0600 equivalent; `SetNamedSecurityInfo` with `PROTECTED_DACL_SECURITY_INFORMATION` is the API form). Add one-shot EPERM/EACCES/EBUSY/EEXIST retry to `renameSync`.

### Finding 5 — MY FINDING: the embedded user-shell terminal is POSIX-only, broken on Windows
`user-shell-session.js:40-47` `resolveShell()` checks `$SHELL` then `/bin/zsh|bash|sh` → returns `/bin/sh` on Windows → node-pty spawn fails. Irony: `platform.js:10-13` already has a correct `defaultShell()` returning `COMSPEC || 'cmd.exe'` — unused here. So the embedded user-shell (epic #5982) never launches on Windows. Destroy path also skips tree-kill (`user-shell-session.js:384` guards `process.kill(-pid)` behind `!== 'win32'`).

**Win32 fix:** route through `defaultShell()` with PowerShell preference; use `taskkill /PID <pty.pid> /T /F` for destroy.

**What's right:** `resolve-binary.js` `pickWindowsExecutable` (35-45) filters to PATHEXT, ranks `.exe`>`.com`>`.cmd`>`.bat`, rejects the extensionless npm wrapper. `win-spawn.js` cmd.exe double-escaping is textbook cross-spawn quality. `writeFileRestricted`'s atomic temp+rename is correctly Windows-aware. The problem is the process-lifecycle and secret-storage layers around them.

## 3. Concrete recommendations (ordered)
1. **Fix `forceKill` first (highest blast radius).** `taskkill /PID <pid> /T /F` in the `isWindows` branch; graceful paths `taskkill /T` (no `/F`). Verified working. Follow-up: Job Object.
2. **Add a DPAPI master-key vault.** `_winGetToken`/`_winSetToken` via `ProtectedData.Protect/Unprotect('CurrentUser')`. `credential-cipher.js` stays identical. Report `backend: 'dpapi'`.
3. **Replace `service-cmd.js:28-32` exit(1) with real `schtasks` support** wired into `service.js` win32 branches.
4. **Harden ACLs in `writeFileRestricted`** — `icacls /inheritance:r /grant:r <user>:F /grant:r SYSTEM:F` + AV-lock retry.
5. **Make the user-shell Windows-aware** — `defaultShell()`/COMSPEC/PowerShell + `taskkill /T /F` destroy. Consider `%LOCALAPPDATA%`/`%APPDATA%` for secret files.
6. **Long paths:** `\\?\` prefixing or `LongPathsEnabled` preflight for deep worktree/container paths.

## 4. Overall rating + verdict — 2.5 / 5
Chroxy's Windows story is a tale of two layers. The **static** platform primitives are excellent and clearly written by someone who understands Win32. But the **dynamic and security** layers are where macOS parity collapses: `forceKill` is a copy-paste no-op that I proved orphans the real claude/codex process on every Stop; credentials sit in plaintext because DPAPI was never wired despite the cipher being ready for it; `service install` hard-fails past its own working `schtasks` guidance; secret files inherit a group-readable ACL I found leaking to `<group>`; and the embedded shell can't even launch. Every required primitive (`taskkill /T`, DPAPI, `schtasks`, `icacls`, `COMSPEC`) is present and I verified each works — but until Findings 1–2 land, running Chroxy on Windows leaks processes and stores your API keys in the clear.
