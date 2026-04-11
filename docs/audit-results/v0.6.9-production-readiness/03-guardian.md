# Guardian's Audit: Chroxy v0.6.9 Production Readiness

**Agent**: Guardian — paranoid SRE who designs for 3am pages
**Overall Rating**: 3.2 / 5
**Date**: 2026-04-11

---

## Executive summary

Chroxy is a remote root shell over a public internet tunnel. The token gives
an attacker everything on the developer's laptop: browser cookies, SSH keys,
`.env` files, source code, and the ability to `git push --force` to every
repo the developer can write to. That threat model justifies paranoia the
codebase does not yet consistently meet.

The good news: most of the headline surfaces (WebSocket auth, constant-time
token compare, encrypted envelope replay protection, key-exchange-after-auth,
realpath on final-component writes, CF-Connecting-IP spoofing defences) are
present and largely correct. Recent security commits mostly do what they
claim. The crypto layer is sound. Keychain storage on the app side is sound.

The bad news: I found one **high-impact workspace-escape on the write path**
via parent-directory symlinks that defeats the recent 04a2fbbb1 TOCTOU fix,
at least one silent auth-bypass gap (notification action buttons approve
tool use with no biometric gate), missing session-binding checks on the
HTTP `/permission-response` path, an unbounded rate-limiter memory footprint,
and no graceful tunnel-kill timeout so `supervisor.shutdown()` can hang
forever. Recovery/observability is weaker than I'd ship to real users.

It is close. It is not there.

---

## Section ratings

| Surface | Rating | Comment |
| --- | --- | --- |
| Auth (WS upgrade, bearer, hook secret, pairing) | 4 / 5 | Well-layered, constant-time compare, per-session hook secrets. Main gap: notification action buttons don't re-auth. |
| Crypto / replay protection (XSalsa20-Poly1305 + strict nonce) | 4 / 5 | Per-connection key derivation is correct. Strict nonce equality is correct. One gap: `deriveConnectionKey` is raw `SHA-512(key\|\|salt)` instead of HKDF — no domain separation byte, but doesn't leak key material in practice. |
| Session binding / multi-tenant isolation | 3 / 5 | `boundSessionId` enforced on session-scoped handlers and `resolveSession`, but NOT on permission response (WS) and NOT on HTTP `/permission-response`. |
| Filesystem safety (read/write/diff) | 2 / 5 | `O_NOFOLLOW` + realpath on the final component is correct, but parent symlinks are not checked — new-file writes escape the workspace. |
| Tunnel + network attack surface | 3 / 5 | `CF-Connecting-IP` trust is scoped to loopback peers — good. But no SIGKILL fallback on `cloudflared` kill, and `supervisor.shutdown()` blocks on `await tunnel.stop()` indefinitely. |
| Token lifecycle (keychain, rotation, QR, pair) | 4 / 5 | Pairing is single-use, rotation grace period works, keychain on app. Missing: operator-facing "invalidate everyone" command, and FIFO token eviction can kick out a legit user if 100 other pairings happen. |
| Credential exposure in logs | 3 / 5 | `sanitizeConfig` masks `apiToken`/`pushToken`. `redactSensitive` regex catches `token:` / `Bearer` patterns. Gaps: bare high-entropy tokens printed without a key name are not redacted (e.g. if a 3rd-party lib dumps a header object). |
| Recovery / observability | 2 / 5 | Health check reports `restarting`, but there is no systemd/launchd wrapper, no way to tell the user "your phone is stale because the pairing ID rotated", and almost nothing to help a panicked user invalidate a leaked token. |

---

## Top 5 most dangerous findings

### 1. Parent-directory symlink escape on `write_file`  (Likelihood: medium, Impact: HIGH)

**Location**: `packages/server/src/ws-file-ops/reader.js:275–371` and
`packages/server/src/ws-file-ops/common.js:33–47`

**The attack.** A bound client with a valid token sends
`write_file { path: "subdir/evil.sh", content: "#!/bin/sh ..." }` where
`subdir` is already a symlink inside the project cwd pointing at (say)
`/Users/victim`. The server does:

1. `absInCwd = resolve(cwdReal, "subdir/evil.sh")` → stays lexically inside `cwdReal`, passes the `startsWith(cwdReal + '/')` check.
2. `realpath(absInCwd)` throws `ENOENT` (evil.sh doesn't exist yet) so `fileExists = false` and `resolvedTarget = absInCwd` — the unresolved lexical path (`common.js:38–44` falls back to `absPath` on ENOENT).
3. `validatePathWithinCwd(absInCwd, sessionCwd)` returns `{valid: true}` because the lexical prefix check matches.
4. `mkdir(resolve(absPath, '..'), { recursive: true })` is a no-op (parent already exists).
5. `open(absPath, O_CREAT|O_EXCL|O_NOFOLLOW, 0o666)` — critically, **`O_NOFOLLOW` only rejects a symlink at the final path component**. Parent directories are followed normally. The kernel resolves `/cwd/subdir` → `/Users/victim`, creates `evil.sh` under the victim's homedir, and returns success.

**Result**: arbitrary file creation (not overwrite) anywhere a pre-existing
symlink allows. The attacker can drop `.bashrc`, `.ssh/authorized_keys`,
launch-agent plists, `.zprofile`, crontab files — anything the daemon user
can reach through an existing symlink under the workspace root. The default
worktree root (`~/.chroxy/worktrees/<id>`) contains `.git` which is itself
a symlink file on some platforms, but more realistically users frequently
have `node_modules/.bin` symlinks, `.venv/bin`, `dist/` symlinks to builds,
etc. Even one such symlink is enough.

Existing regression test (`packages/server/tests/write-file.test.js:100`)
catches only a symlink at the FINAL component. There is no test with a
parent-level symlink and a non-existent target file.

**Bypass of a recent "fix"**: commit 04a2fbbb1 "apply realpath() TOCTOU fix
to file write path" only protects the existing-file case. The new-file
branch in `reader.js:286–297` is explicit: it falls back to `absInCwd`
(the lexical path) when `realpath()` throws ENOENT and then validates that.
The realpath of any parent-symlink resolution is never consulted.

**Fix**: realpath the parent directory before opening. Something like:

```js
const parent = dirname(absInCwd)
const parentReal = await realpath(parent)               // throws if parent doesn't exist
const { valid } = await validatePathWithinCwd(parentReal, sessionCwd)
if (!valid) return denied()
absPath = join(parentReal, basename(absInCwd))           // bind the final name to the realpath'd parent
// then open with O_NOFOLLOW|O_CREAT|O_EXCL
```

Alternatively, create the file under `O_NOFOLLOW|O_CREAT|O_EXCL` using
`openat` relative to a directory FD opened with `O_DIRECTORY|O_NOFOLLOW`
chain all the way down — but Node doesn't expose `openat` directly, so the
realpath-the-parent approach is the pragmatic fix.

**Recovery**: none — once the file is written, attribution is impossible.
The server logs `absPath` in `write_file_result` but not "writer client ID".

---

### 2. Notification Approve/Deny bypasses all app-side gates  (Likelihood: medium, Impact: HIGH)

**Location**: `packages/app/src/notifications.ts:195–234`, server side
`packages/server/src/handlers/settings-handlers.js:84–133` and
`packages/server/src/ws-permissions.js:178–250`.

**The concern.** A permission prompt lands as an iOS/Android notification
with "Approve" and "Deny" action buttons. Tapping Approve on the lock-screen
immediately sends `permission_response { requestId, decision: 'allow' }`
via either the open WS socket or HTTP `POST /permission-response`. There is
no biometric prompt, no re-auth, no visual confirmation of which tool is
being authorised, and no session binding check on the server side.

Attack scenarios:

- Phone briefly unattended (coffee shop, desk, partner) — any notification
  action button is accessible on modern Android and iOS without unlocking
  depending on device settings. One tap = "yes, run `rm -rf ~`".
- An attacker who has the token and can keep the victim's phone off the
  network can trigger a Claude tool call on behalf of the victim, then wait
  for the victim to see the notification and tap Approve without reading it
  carefully.
- Approve action buttons from **any** pending notification approve **any**
  live permission request — the requestId is in the notification payload,
  not checked against the currently-active session.

Combined with finding #3 (missing server-side session binding check on
`permission_response`) this means: a bound client can approve requests
for sessions it is not bound to, as long as it knows the requestId.
A bound-client-on-the-same-device scenario (e.g. user paired two devices
to the same account) becomes exploitable if one device is compromised.

**Fix (layered)**:
- **App**: gate the Approve action behind `useBiometricLock` when biometric is
  enabled; at minimum require the user to tap an explicit confirm after the
  OS action button.
- **Server**: in both `settings-handlers.handlePermissionResponse` and
  `ws-permissions.handlePermissionResponseHttp`, enforce
  `client.boundSessionId === originSessionId` before resolving.

---

### 3. Missing session-binding check on permission response  (Likelihood: low, Impact: HIGH)

**Location**: `packages/server/src/handlers/settings-handlers.js:84–133`
(WS path) and `packages/server/src/ws-permissions.js:178–250` (HTTP path).

Neither path enforces that the responding client's `boundSessionId` matches
the `originSessionId` of the permission request. The WS path at line 88:

```js
const originSessionId = ctx.permissionSessionMap.get(requestId) || client.activeSessionId
// ... no boundSessionId check here ...
entry.session.respondToPermission(requestId, decision)
```

Compare with `handler-utils.resolveSession` (line 215–227) which DOES
enforce `boundSessionId`. The permission path was missed in the 616aeaf62
/ 2c0ac7d2d session-binding fixes.

Realistic impact today is limited because `permission_request` is
broadcast via `broadcastToSession` (session-scoped), so a cross-bound
client never learns the requestId. Exploitation requires the attacker to
already have the requestId — either by being on the same session, or by
an information leak elsewhere. But this is defense in depth that was
deliberately added everywhere else and missed here. One stray `broadcast()`
call that bypasses the session filter (or a future change that adds one)
re-opens the hole.

Likelihood scored **low** only because I couldn't find a live leak path.
Impact is **high** because the approved tool is "allow Bash to do anything"
on a session the responder should not be able to speak for.

**Fix**: add `enforceBoundSession(client, originSessionId)` at the top of
both handlers, mirroring the pattern in `conversation-handlers.js:125`.

---

### 4. Rate limiter is unbounded — memory exhaustion by a random scanner  (Likelihood: high, Impact: medium)

**Location**: `packages/server/src/rate-limiter.js:80,88–110`.

`_clients` is a `Map<string, number[]>`, keyed by "client IP or CF-Connecting-IP".
Entries are created on demand in `check()` at line 93–95. There is **no
eviction, no TTL sweep, and no cap**. Pruning only happens for keys that
get re-checked — a key that is touched once and never again stays in the
map forever.

The public tunnel URL is, by definition, unauthenticated-until-auth. An
attacker who bombards it with random connections from a botnet leaks one
entry per unique IP into `_clients` before the auth_fail closes the
connection. `getClientIp` prefers `CF-Connecting-IP`, and Cloudflare
forwards those for the whole public internet, so there are ~4B possible
keys. A modest 10k-host scan balloons the map by ~10k entries plus the
per-bucket timestamp arrays.

Separately, `authFailures` IS capped (`MAX_AUTH_FAILURE_ENTRIES = 10_000`
with FIFO evict) — the rate-limiter cap was not added in the same
shape. Plus the pre-auth-connection gate (`maxPendingConnections=20`,
`ws-server.js:717`) limits concurrent but not total unique-IP churn.

**Fix**: add a TTL sweep or a size cap with eviction, matching the
existing `MAX_AUTH_FAILURE_ENTRIES` approach.

---

### 5. Supervisor `shutdown()` can hang forever on tunnel stop  (Likelihood: medium, Impact: medium)

**Location**: `packages/server/src/supervisor.js:591–615` and
`packages/server/src/tunnel/base.js:81–89`.

`tunnel.stop()` calls `proc.kill()` which defaults to SIGTERM. There is
no force-kill timer. On a non-responsive `cloudflared` (or a misbehaving
plugin), `proc.kill()` returns immediately but `process` stays alive and
`close` never fires. The supervisor's shutdown path at line 607
`await this._tunnel.stop()` does NOT currently await a process-exit
event (the adapter resolves synchronously after calling `kill()`), so
the main shutdown path does complete — BUT cloudflared is now a zombie
child. A subsequent chroxy start then hits EADDRINUSE on port 8765 and
the standby server's retry logic kicks in (`MAX_STANDBY_EADDRINUSE_RETRIES = 20`
= 10 seconds of unavailability), all because the previous tunnel never
actually died.

Compounding: `child_process.spawn` on Node does NOT send SIGTERM to
grandchildren when you kill the parent. If `cloudflared` forks its own
helpers (it does, for each region), those helpers stay. No use of
`process.kill(-pid, ...)` to reach the process group.

**Fix**: `tunnel.stop()` should `proc.kill('SIGTERM')`, wait 3s for
`close`, then `proc.kill('SIGKILL')` and wait another 2s. Consider
`detached: true` + `process.kill(-proc.pid, ...)` for group kill on
POSIX, with a corresponding signal handler for the child to propagate
SIGTERM to its own children on Windows.

---

## Recovery playbooks

### "Server died mid-query, supervisor won't restart it"

First, check `~/.chroxy/logs/chroxy.log` for `Max restarts (N) exceeded`.
If present, the supervisor has given up after 10 consecutive failures
within the backoff ladder. Run `cat ~/.chroxy/known-good-ref` — if a
deploy is in-flight and 3 crashes happened within 60s, the supervisor
may have auto-rolled back to the last known-good git ref and left your
working tree on a detached HEAD; run `git reflog` to recover.
Kill any orphaned `cloudflared` processes (`pgrep cloudflared | xargs kill -9`)
to avoid EADDRINUSE on restart. Delete `~/.chroxy/supervisor.pid` if
stale. Then `npx chroxy start --verbose` and watch the logs — the first
failure reason is the root cause; "child crashed in <5s" means the child
itself is broken, not the supervisor. As a last resort, `--no-supervisor`
to bypass the watchdog and see the raw stacktrace.

### "Phone stuck in reconnecting forever, server looks fine"

Most common cause: the Cloudflare tunnel URL rotated (Quick Tunnel) and
the phone is still hitting the old URL. Run `cat ~/.chroxy/connection.json`
on the server host — the `wsUrl` field is the current URL. On the phone,
either rescan the QR code from the desktop dashboard `/qr` endpoint, or
check the server logs for `Cloudflare tunnel established: HTTP=...` after
a `tunnel_recovered` line. If that matches, the server also writes a fresh
QR to stdout. Second most common: the phone's app cached a pairing-issued
session token that the server lost on restart (session tokens are
in-memory, not persisted) — force-disconnect in the app and rescan.
Third: Cloudflare is rate-limiting Quick Tunnel IPs — switch to Named
Tunnel (`--tunnel named`). The app retries 6 times with 1/2/3/5/8s
backoff before giving up, so 19 seconds of "reconnecting" is normal.
Longer than 30s means you need manual intervention.

### "I think someone has my token — how do I invalidate?"

**Today there is no fast path.** The session tokens issued via pairing
live in memory only and can be invalidated by restarting the daemon
(`npx chroxy stop && npx chroxy start`). The primary API token however
is persisted — either in the keychain (macOS) or in `~/.chroxy/config.json`
with 0o600 permissions. Rotate it by running `npx chroxy init --force`
which generates a new token and overwrites the stored one; restart the
server so the new token takes effect; then re-pair every legitimate
client. If the attacker was already connected, the server's token
rotation broadcast will disconnect them on the next cycle, **BUT** the
rotation grace period (5 min default) means the old token keeps working
for 5 more minutes after rotation — there is no "revoke immediately"
switch. File issue: the recovery story for leaked primary tokens needs
a hard kill button that accepts the brief operational pain of invalidating
all grace-period tokens at once.

### "The tunnel URL rotated and the QR on my desktop is wrong"

The desktop dashboard fetches `/qr` from the server process, which always
returns the **current** URL via the `PairingManager.currentPairingUrl`
getter (see `http-routes.js:171–177`). Refresh the dashboard (Cmd-R) or
the tray menu "Show QR" entry. If still wrong, the cached
`~/.chroxy/connection.json` is stale — delete it, then restart the
supervisor. Note that Quick Tunnel URLs ARE supposed to rotate; if you
need stability for field use, switch to Named Tunnel
(`chroxy tunnel setup`) which gives you a CNAME-mapped stable hostname
that never changes.

### "I see a file I didn't write in my project — when was it written and by whom?"

**Today this is essentially unanswerable.** Chroxy's write path logs
the resolved `absPath` in `write_file_result` but does NOT log the
client ID or device info for write events. The permission audit log
(`permission-audit.js`) only records tool-permission decisions, not the
writes themselves. If `writeFile` went through the `Write` tool, the
permission log will record that a `Write` tool was approved and by
which client; correlate by timestamp. If it went through the raw
`write_file` WebSocket message (dashboard or app file editor), there
is no audit trail beyond the general `chroxy.log` which only records
that a `write_file` handler ran. Real recovery story: `git log --all --follow <path>`
if the file is under git; otherwise `mdfind -onlyin ~ kMDItemFSCreationDate`
on macOS. **Issue**: the write path should emit a structured audit log
entry (clientId, deviceInfo, path, timestamp) so this scenario has an
answer.

---

## Verification of the 11 recent security fixes

| # | Commit | Present in code? | Has test? | Bypassable? |
| --- | --- | --- | --- | --- |
| 1 | `1fa8eda5e` nonce reuse on reconnect | **Yes** — `deriveConnectionKey` at `crypto.ts:187–210` | **Yes** — `crypto.test.ts` nonce-isolation tests | No bypass found. Minor: uses raw SHA-512 instead of HKDF — no domain separation byte. Not exploitable without a preimage collision. |
| 2 | `600612649` wire per-connection key into key_exchange | **Yes** — `ws-auth.js:255–257` derives sub-key when salt present | **Yes** — `packages/server/tests/ws-server-encryption.test.js` | **Backward compat hole**: if the client omits `salt`, it silently falls back to the raw DH shared key (line 257), which re-introduces the nonce-reuse-on-reconnect risk for old clients. No version check rejects old clients. |
| 3 | `88f54dc39` rate limiter uses CF-Connecting-IP | **Yes** — `rate-limiter.js:55–62` restricts trust to loopback peers | **Yes** — `rate-limiter.test.js` | No bypass for the stated fix. Separate issue: unbounded map (finding #4). |
| 4 | `72856431a` git file op paths validated against workspace root | **Yes** — `common.js:62–87` `validateGitPath` | **Yes** — `ws-file-ops-git-paths.test.js` | Cache key normalisation is correct. No bypass found. |
| 5 | `dcb8f3cdf` TOCTOU in file reader | **Yes** — `reader.js:68–172` — realpath then O_NOFOLLOW | **Yes** — tested | No bypass for the reader. (Writer has a different gap — see finding #1.) |
| 6 | `803d6c881` shell injection in permission hook | **Yes** — `hooks/permission-hook.sh` passes stdin, sanitises `$PORT` and `$PERM_MODE`, does not use positional args | **Yes** — `permission-hook-approve.test.js` (per 531157db6) | No bypass. Script is clean. |
| 7 | `616aeaf62` session binding in destroy/rename/list/resolveSession | **Yes** — `session-handlers.js:14,31,52,122,171,205`; `handler-utils.js:215–227` | **Yes** — tests under `handler-utils.test.js` | **Gap**: `handlePermissionResponse` in `settings-handlers.js:84–133` was not updated in this commit and still lacks the check. See finding #3. |
| 8 | `2c0ac7d2d` boundSessionId across session-scoped handlers | **Yes** — applied across `conversation-handlers.js:40,125`, `feature-handlers.js:34,93`, `input-handlers.js:121` | **Yes** — integration tests | Same gap as #7 — permission response is not a "session-scoped handler" in the list and was missed. |
| 9 | `04a2fbbb1` realpath TOCTOU fix on file write path | **Yes** — `reader.js:286–298` applies realpath when file exists | **Yes** — write-file tests | **Bypassable via parent symlink for new-file creation** — see finding #1. This fix is incomplete. |
| 10 | `38a4b7586` mask apiToken before config logging | **Yes** — `config.js:67–73` `sanitizeConfig`, `SENSITIVE_KEYS = ['apiToken','pushToken']` | **Yes** — `sanitizeConfig.test.js` | Regex-based redaction in `logger.js:30–35` catches `Bearer ...`, `token: ...`. Gap: a raw high-entropy token logged without a key name (e.g. a 3rd-party lib printing a plain Authorization-less header map value) is not caught. Low risk. |
| 11 | `f945b9cb5` validate session token binding on reconnect | **Yes** — `ws-auth.js:94–99` attaches `boundSessionId` from `pairingManager.getSessionIdForToken()` | **Yes** | No bypass for the stated fix. But the enforcement at resolve-time is weakened by finding #3. |

**Summary**: 9 of 11 fixes are correct. One (#2) has a silent backward-compat
fallback that re-opens the vulnerability for old clients. One (#9) is
incomplete — the write path still escapes via parent symlinks. Neither
the key-derivation fallback nor the parent-symlink path has a regression
test.

---

## Overall verdict

**Rating: 3.2 / 5**

Close, not yet. The crypto is sound. The auth surface is well-layered.
Session binding is 90% complete. The team clearly cares about these
classes of bug — 11 security commits in one release cycle is the right
tempo.

But three things hold it back from a public trust-with-my-home-folder
recommendation:

1. **Finding #1 is a concrete workspace escape with arbitrary new-file
   creation.** Any exploitation requires an existing directory symlink
   under the workspace, which is common in real dev setups (node_modules
   .bin, .venv, dist/). A malicious session (or a prompt-injected
   session) plus a found symlink is enough to drop `~/.bashrc` or a
   launchd plist. Must fix before public release.

2. **Finding #2 is a design-level gate missing in the permission UX.**
   Notification approve without biometric re-auth is a conscious
   usability choice, but for a tool that grants arbitrary shell, it
   should require a second factor at least for `Bash` / `Task` /
   `Execute` tool classes. The server has the `NEVER_AUTO_ALLOW` set
   already; use it to gate the HTTP permission response path too.

3. **Observability on the write path.** If I find a file I didn't write,
   I have no way to tell who wrote it. For a tool with this threat model,
   that is the difference between "oh, a bug" and "I'm calling my
   insurance company." Structured audit entries on every write, with
   clientId and deviceInfo, are cheap and non-negotiable.

Everything else — the rate-limiter memory, the tunnel kill timeout,
the key-derivation backward-compat fallback, the session-binding gap
on permission response — those are 1-day fixes that should land before
merging any more features.

**Personal use test**: Would I run this on my own laptop with a public
QR code in a coffee shop? Today: no. With findings #1, #2, #3 fixed
and a structured write audit log: yes, with caveats about the token
revocation story.

**Public trust test**: Would I recommend a stranger on the internet
install this and trust it with their Claude agent? Today: no — but I
would recommend it within ~4 weeks of focused work on these items.
