# Daemon auto-deploy (idle-only)

`scripts/deploy-daemon.mjs` keeps a long-running Chroxy daemon on the latest `main` without ever restarting it while there is work to lose. It is for the setup where one machine runs the daemon from a dedicated checkout under launchd (`KeepAlive=true`, `node packages/server/src/cli.js start --no-supervisor`) and you want that daemon to follow `main` on its own (#8324).

This guide is documentation only. The repository does not install the launchd agent for you; you opt in by creating the plist below.

## What it does, and does not do

The script does not keep a journal of what it did. Every tick it compares what **is** with what **should be** and does whatever closes the gap, so an interrupted run needs no recovery code: the next tick sees the gap and closes it.

Desired state: **the daemon runs `desired`, the checkout `HEAD` is `desired`, and the dashboard build is from `desired`.**

- *What the daemon runs* is read from the daemon itself: `GET /api/daemon/idle` returns the `commit` the process started from. It is never inferred from a pid or from a record of what the script did.
- *What the build is from* is `<configDir>/deploy-build.json` (`{ sha, lockHash }`, the "build stamp"). It is written only after a successful build and deleted, before anything else happens, whenever the tree or build is about to change. `lockHash` is the sha256 of every `package-lock.json` in the working tree (root and `packages/*`, sorted by path). `npm ci` runs only when the stamp is missing or its `lockHash` differs from the tree's.
- *`desired`* is, in order: the **owed rollback** if there is one (`rollbackTo` in `deploy-state.json`); otherwise the tip of the remote branch, except a tip that already failed (`failedTarget`), which is skipped (the daemon's own commit is `desired`) until `main` moves or you pass `--retry`.

### Each tick

1. **Lock.** The script takes a kernel-held TCP port, `127.0.0.1:<--lock-port>` (default 47651), for the whole run. The kernel gives it to exactly one process and takes it back when that process exits, so there is nothing to go stale and no reclaim protocol. If the port is taken the run prints `another deploy is running (or port N is in use)`, exits 0 with outcome `locked`, and touches no state, stamp or log. Leftover `deploy.lock`, `deploy.lock.reclaim` and `deploy-pending-restart.json` files from earlier designs are deleted. `deploy-state.json` is read and written only while the lock is held.
2. **Checkout.** It must be a clean git tree on the followed branch (otherwise `refused`, exit 1, nothing touched). `git fetch` then runs with `GIT_TERMINAL_PROMPT=0`, so an unattended fetch fails instead of waiting for a credential.
3. **Probe.** It asks the daemon (below) whether it is idle and which commit it runs, and classifies the answer as one of four kinds: **idle**, **busy**, **down** (nothing is listening: no `connection.json`, a dead pid in it, or a refused/reset loopback connection) or **unknown** (something may be listening but cannot answer: a 404 from a daemon that predates the route, any other non-200, a timeout, an unreadable body). A daemon that is reachable but reports **no commit** cannot be certified either. Every one of those but idle defers (exit 0, logged once per target) and touches nothing. `--force` is how you bootstrap past this (see below).
4. **Nothing to do.** If the daemon runs `desired`, `HEAD` is `desired` and the stamp is `desired`, the run prints one console line, writes nothing to `deploy.log`, forgets the last logged condition (so a later repeat of an earlier failure is news again), and exits 0.
5. **Busy gate, before any mutation.** If the daemon is busy and there is work to do, the run defers (exit 0) and touches nothing: not the tree, not the build, not the daemon. This applies to forward deploys, repairs and owed rollbacks alike, and **`unknown` is treated exactly like busy**: a daemon whose probe times out or answers 500 may well be mid-turn. The one exception is an owed rollback against a daemon that is **down**, meaning nothing is listening: there is nothing to lose, so it proceeds. (A hung daemon, whose pid is alive but whose probe times out, therefore never gets a rollback restart by itself; restart it by hand or use `--force`.) The other exception is an owed rollback against a daemon that answers 404 or reports no commit: it cannot be certified, so the tree is restored, `rollbackTo` is **cleared** (which is what stops it looping), nothing is signalled, and the log line says to restart the daemon by hand or run once with `--force`.
6. **Repair.** If the daemon already runs `desired` but `HEAD` or the stamp differ, the tree is converged to `desired` with no restart (`repaired checkout to <sha> (no restart needed)`). This is also how a build that was interrupted, or a rollback whose tree step failed, is finished.
7. **Converge the tree** (one shared procedure for forward deploys and rollbacks): delete the stamp (mandatory); move `HEAD` to `desired` with `merge --ff-only` when `desired` descends from `HEAD`, or `reset --hard` when it is an ancestor; refuse otherwise. A forward deploy never resets away local commits, so a checkout that is ahead or diverged is refused. Then `npm ci` if the lock hashes differ, build the dashboard, write the stamp.
   - **Forward build failure:** the target becomes the `failedTarget` (mandatory write), then the tree is converged back to what the daemon runs, with no restart (exit 1, `rolled-back (build failed: ...)`). If that fails too, `rollbackTo` is set so the next tick keeps trying.
8. **Busy re-check.** The build took time, so the daemon is **always** probed again. If it is now busy or unknown (or, for a forward deploy, down), a forward deploy converges the tree back to what the daemon runs and defers (`deferred after build: ...`, exit 0, not a failed target). A rollback defers and stays owed. Only a rollback that finds the daemon still **down** goes ahead without an idle verdict: a daemon that was down at the start of the tick may have been relaunched by launchd, and be busy, by the time the build finishes.
9. **Restart.** For a forward deploy, `rollbackTo = <what the daemon runs now>` is written (mandatory) **before** the signal, so an interruption anywhere after it leaves a rollback owed rather than a false "up to date". Then `launchctl kill SIGTERM gui/<uid>/<label>` (a graceful SIGTERM, never SIGKILL).
10. **Verify** (one shared verifier for forward deploys, rollbacks and owed rollbacks):
    - the restart counts only when a probe reports `commit === desired` **and** local `/health` answers 200 **and** the pid differs from the pid that was signalled (when it was known); this is polled for `--health-timeout` seconds;
    - then it waits `--settle` seconds (default 15) and re-confirms the same pid, the same commit, a live process and health;
    - then the tunnel check, retrying through the HTTP 530 a Cloudflare tunnel returns for several seconds after a restart (skipped when the tunnel is `none`/absent or with `--no-tunnel-check`);
    - then local health, pid and commit are confirmed **again**, because a daemon can die during a long tunnel wait.
    - A **tunnel-only** failure, with local health still confirmed, is **not** rolled back: the new daemon is serving locally and may already hold new work, and a rollback would not fix a tunnel. The outcome is `deployed-tunnel-unverified`, exit 1, a loud `DEPLOYED-TUNNEL-UNVERIFIED` line, the same `result` in `last-deploy.json`; `rollbackTo` is cleared and the target is **not** a `failedTarget`.
    - **Success** clears `rollbackTo` (mandatory), writes `last-deploy.json` (atomic) and one `deploy.log` line.
11. **Any local failure** (wrong commit, wrong pid, unhealthy, died while settling or during the tunnel wait): the target becomes the `failedTarget` and the rollback runs in the same run through the same code. If the daemon is busy or unknown, the script waits for idle for up to `--health-timeout` seconds, logging that it waited. **If it is still not idle it stops, leaving the rollback owed**, and touches neither the tree nor the daemon: the next idle tick finishes it. Otherwise it converges the tree to `rollbackTo`, restarts, and verifies the same way with `desired = rollbackTo`. Success clears `rollbackTo`; failure keeps it.

A rollback restores the **checkout and the dashboard build**. It cannot undo anything the new daemon wrote to `~/.chroxy` while it ran.

### Interruption needs no recovery code

Kill the script at any point and the next tick converges:

| Interrupted | What the next tick sees | What it does |
|---|---|---|
| during the tree change or the build | stamp missing | rebuilds (`npm ci` too: no stamp means no trusted install), then carries on with the deploy |
| before the SIGTERM | `rollbackTo` set, daemon still runs the old commit | repairs the checkout back to the old commit (no restart); the target is retried on a later tick |
| after the SIGTERM | `rollbackTo` set, daemon runs the new commit (or is still restarting) | rolls back (the interruption is not a verdict on the target, so it is not a `failedTarget`), then deploys the target again on the next tick. **That costs two extra restarts even when the new build was fine** (the rollback, then the redeploy). This is deliberate: an unverified state is never trusted. Remembering a `pendingTarget` so the second restart can be skipped is a follow-up. |
| during a rollback | `rollbackTo` still set | finishes it |

A restart is never certified by "the old commit answered" or "a pid changed": only the daemon reporting `desired` counts.

### Safety-critical writes are mandatory

`deploy-state.json` holds only `{ failedTarget, failedOutcome, rollbackTo, lastKey }`. Writes are temp file plus rename. Writes of `failedTarget`, `rollbackTo` and the build stamp are **mandatory**: if one fails (a full disk, say), the run aborts before its next change, with exit 1 and a loud `ABORTED: ...` console line (outcome `state-write-failed`). Deleting the stamp is mandatory the same way. A state file that cannot be **read** (as opposed to absent) aborts the run too, because `rollbackTo` might be in it, and so does one that parses but whose `rollbackTo` or `failedTarget` is not a commit: an owed rollback must never silently become "up to date". Both are left on disk for the operator to fix or delete. A state file that is corrupt is moved aside to `deploy-state.json.corrupt-<ts>`, logged, and treated as empty. Only the log dedupe key (`lastKey`) is best effort.

### A target that already failed is not retried

When a target rolls back (a failed build, a failed restart, or a local verify failure), its SHA is recorded as `failedTarget` / `failedOutcome`. While `origin/main` is still that commit, later ticks log (once) `skipped: <sha12> already rolled back (<outcome>); waiting for a newer main or --retry` and exit 0 without building anything, so a bad `main` is not rebuilt every ten minutes and the daemon is not restarted twice per retry. A newer `origin/main` clears the record, even when that run only defers. `--retry` tries the recorded target once and clears the record if it succeeds. `--force` skips the idle checks only; it does **not** imply `--retry`.

A busy daemon is not a failure: `deferred` outcomes are never recorded as a failed target, so they are retried next tick. A verify failure can be caused by something unrelated to the code (the daemon was hit by something else); the target is then skipped until `main` moves or you run `--retry`.

Things to know:

- **The deploy is not zero-impact on disk, even though the daemon is idle.** For the length of the build, the dashboard `dist` that the running daemon serves is replaced (the build empties it first, so a request during the build can find it missing or half-written), and when a lockfile changed `npm ci` replaces `node_modules` under the running process, where a lazy import can see the new tree. **If a forward `npm ci` fails, `node_modules` stays replaced under the running daemon until the tree is converged back**, which the same run attempts immediately and the next tick retries if it fails. The idle check is what makes the window acceptable; it does not make it zero, and it can be longer than one build when the daemon turns busy during it.

## The idle definition

The script asks the daemon itself, over loopback HTTP, with the primary token from `connection.json`:

```
GET http://127.0.0.1:<port>/api/daemon/idle     Authorization: Bearer <apiToken>
```

The daemon is idle only when **all** of these hold:

- no session is busy: no turn is running, and no tracked background shell is holding a session busy (`isBusy` covers both);
- no session has a permission request waiting on a human;
- no session has an `AskUserQuestion` waiting on a human;
- no hook-routed permission request is parked on the daemon;
- nothing in the session's `getRestartBlockers()`: work `isBusy` does not report. The base list is background agents that outlived their turn and input accepted into the outgoing queue but not yet dispatched. The Claude CLI session adds messages acknowledged as `queued` while the CLI warms up or respawns. The Claude TUI session adds recent terminal activity, because a turn typed straight into the terminal never sets `isBusy`: any PTY output in the last 30 s (on the same monotonic clock the #6601 readiness signal uses) **or** any `writeTerminalInput` in the last 10 minutes (`terminal input in the last 10m`). The other providers (SDK, Codex, BYOK, Gemini, ACP, claude-channel) queue only in the shared outgoing queue, so they need no override.

The answer also carries `commit` (the 40-hex commit the daemon process started from, resolved once at startup from its own checkout, or `null` when it cannot say), `pid`, `version` and `startedAt`. The answer lists every session's state and a `reasons` array (for example `session "main" busy: turn`). If the daemon cannot compute any part of the answer, including a missing or throwing `getRestartBlockers()` or one that returns something other than an array of reasons, it answers `idle: false`. The route is loopback-only and primary-token-only; see [bearer-token-authority.md](../security/bearer-token-authority.md). The loopback gate parses the peer address strictly (127.0.0.0/8, `::1`, IPv4-mapped 127.x) and rejects any request carrying a `cf-*`, `cdn-loop`, `forwarded`, `x-forwarded-*` or `x-real-ip` header, because Cloudflare can strip the visitor-IP headers; it is defence in depth, and the primary token is the authority. The script reads the port from `connection.json` when `httpUrl` carries one, and otherwise uses 8765. Pass `--port` if your daemon listens elsewhere and is reached through a tunnel.

### Known residuals

- **The probe is a snapshot, not a lock.** There is a sub-second window between the final idle check and the SIGTERM in which newly submitted work can be cut off. A daemon-side maintenance lease, which would make the daemon refuse new work once the deploy has decided to restart, is tracked in #8332.
- **A terminal-typed turn can still read as idle.** The TUI blocker keys off PTY output (30 s) and terminal input (10 min). A turn typed into the terminal that produces no PTY output for 30 s **and** whose last keystroke is more than 10 minutes old reads as idle. The TUI animates a spinner while a turn runs and an idle TUI is silent (measured), so this needs a turn that is genuinely silent for that long.
- **The locality gate does not prove direct local origin.** See [bearer-token-authority.md](../security/bearer-token-authority.md): the primary token is the authority.
- **A bootstrap rollback cannot be certified.** If you bootstrap with `--force` onto a daemon that does not report its commit and the deploy has to roll back, the old daemon still cannot report a commit, so the rollback restart cannot be verified. The tree is restored and the owed rollback is cleared on the next tick with a log line saying the restart could not be certified.

## Running it by hand

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/deploy-daemon.mjs --dry-run
```

`--dry-run` fetches and then prints what the daemon runs, the checkout `HEAD` and build stamp, the remote tip, any owed rollback and failed target, the `desired` commit, the idle verdict, the commits that would deploy (with subjects), and the steps it would take. It takes no lock and writes nothing: no state, stamp, `last-deploy.json` or `deploy.log` line, and no merge, install, build or restart.

Options: `--checkout <path>` (default `~/Projects/chroxy-daemon`), `--config-dir <path>` (default `$CHROXY_CONFIG_DIR` or `~/.chroxy`), `--label <launchd label>` (default `com.chroxy.server`), `--branch main`, `--remote origin`, `--port <n>` (**required** when the daemon is tunnelled on a non-default port: `connection.json` then carries only the tunnel URL, so the local port cannot be read from it), `--lock-port <n>` (default 47651), `--health-timeout <s>` (default 90), `--settle <s>` (default 15; seconds to wait after the daemon reports the new commit before re-confirming the same pid, commit and health), `--npm <path>`, `--dry-run`, `--force` (skip the idle checks and the need for the daemon to report its commit; everything else still happens), `--retry` (try a target that already rolled back), `--no-tunnel-check`.

### First time: bootstrap with `--force`

The running daemon predates `GET /api/daemon/idle` (it answers 404), or predates its `commit` field, so the script (correctly) cannot certify it and refuses to deploy. The first deploy that brings them in has to be done by you, once, at a moment when you know nothing is running:

```bash
node scripts/deploy-daemon.mjs --force
```

(or update the checkout and restart by hand). From then on the daemon reports its commit and the unattended agent works. `--force` skips the idle gate, so check first that no session is mid-turn. The restarted daemon is still verified by the commit it reports.

## The launchd agent

Save as `~/Library/LaunchAgents/com.chroxy.deploy.plist`. Use the absolute path to Node 22 and to the script **in the daemon checkout** (the script then updates itself along with the code; a running node process has already loaded it, so a mid-run fast-forward cannot corrupt it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chroxy.deploy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>/Users/YOU/Projects/chroxy-daemon/scripts/deploy-daemon.mjs</string>
    <string>--checkout</string>
    <string>/Users/YOU/Projects/chroxy-daemon</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/Users/YOU/.chroxy/logs/deploy-agent.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/.chroxy/logs/deploy-agent.err.log</string>
</dict>
</plist>
```

`~/.chroxy/logs/` must exist before the agent first runs (`mkdir -p ~/.chroxy/logs`). The agent has no `KeepAlive`: launchd runs the script every 600 seconds and the script exits.

Install and remove:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.chroxy.deploy.plist
launchctl bootout   gui/$UID ~/Library/LaunchAgents/com.chroxy.deploy.plist
```

Run one tick on demand: `launchctl kickstart gui/$UID/com.chroxy.deploy`.

## Reading the log

`~/.chroxy/logs/deploy.log`, one line per event:

| Line (prefix `<old12>..<new12>` where a range applies) | Meaning |
|---|---|
| `ok` | Deployed and verified: the daemon reports the new commit, from a new pid, healthy, settled, tunnel reachable. |
| `ok (tunnel not checked: <reason>)` | The same, but the tunnel was not looked at: `--no-tunnel-check`, no `connection.json`, no `tunnelMode`, tunnel mode `none`, or a local URL. A rollback line says `(tunnel not checked: <reason>)` the same way. |
| `still deferred since <iso>: <reasons>` | A busy or unknown deferral that has lasted more than 24 hours; it logs once per 24 hours, so a leaked background agent or an always-open shell PTY that starves deploys is visible. A tick that does not defer ends the streak. |
| `DEPLOYED-TUNNEL-UNVERIFIED: ...` | Healthy and settled locally but the tunnel never answered 200. Not rolled back; check the tunnel. Exit 1. |
| `deferred: busy (...)` / `deferred (rollback to <sha12> is owed): busy (...)` / `... : cannot confirm idle (...)` | Something was running; nothing was touched. Retried next tick. Logged once per target. |
| `deferred: cannot confirm idle (...)` | Daemon unreachable, route missing, or an unreadable answer. Nothing was touched. |
| `deferred: the daemon does not report the commit it runs ...` | An older daemon without the `commit` field; bootstrap once with `--force`. |
| `deferred after build: busy (...)` / `deferred after build: cannot confirm idle (...)` | The daemon turned busy during the build; the tree was converged back to what it runs. Retried next tick. |
| `rollback restart deferred: ...; ... the rollback stays owed` | An owed rollback's tree is built but the daemon turned busy before its restart; the restart waits for idle. |
| `skipped: <sha12> already rolled back (<outcome>); waiting for a newer main or --retry` | This target failed before; nothing runs until `main` moves or you pass `--retry`. |
| `repaired checkout to <sha12> (no restart needed)` | The daemon already ran the right commit; only the checkout or build was behind. |
| `repair failed: ...` | The same, but converging the tree failed. Retried next tick. |
| `owed rollback to <sha12> is already satisfied` | A rollback was owed but the daemon, checkout and build already match. |
| `restored the checkout to <sha12>; the daemon has no /api/daemon/idle route (or reports no commit), so a restart could not be certified and was NOT attempted ...` | An owed rollback to a daemon that cannot report a commit: the tree was restored and the owed rollback cleared. Restart the daemon by hand or run once with `--force`. See "A bootstrap rollback cannot be certified". |
| `rolled-back (build failed: ...)` | The install or build of the target failed (the reason is the first few lines that look like an error, not the stack frames after them); the tree is back on the running commit and the daemon was never touched. |
| `rolled-back (restart failed: ...)` | `launchctl kill` failed; nothing was signalled; the tree was put back. |
| `health failed: ... Rolling back to <sha12>.` | The restarted daemon was not verified (wrong commit, pid, unhealthy, or died while settling or during the tunnel wait). The rollback follows. |
| `rollback waited <n>s for the daemon to go idle` | The rollback held its SIGTERM for a busy daemon. |
| `ROLLBACK-OWED to <sha12>: the daemon is still not idle after <n>s ...` | The rollback could not run because the daemon never went idle (busy, or unknown: a timeout or a 500); nothing was touched; the next idle tick completes it. Exit 1. |
| `rolled-back to <sha12>` / `rollback completed to <sha12>` | A rollback was verified (right after a failed deploy / on a later tick). |
| `ROLLBACK-FAILED (...)` | A rollback step failed (tree, build or verify). The rollback stays owed and the next tick retries. Go and look at launchd and the checkout. |
| `ROLLBACK-FAILED after a failed build ...` / `... after the daemon turned ...` | The same, while restoring the tree after a failed build or a busy re-check. |
| `refused: ...` | Not a git checkout, dirty tree, wrong branch, unresolvable refs, or the target is not a fast-forward (diverged or ahead). Fix the checkout; the script will not. |
| `fetch failed: ...` | `git fetch` failed (offline, auth). Retried next tick. |
| `deploy-state.json unreadable; keeping a copy at <path>` | A corrupt state file was moved aside and treated as empty. |
| `failed: ...` | An unexpected error. |

Console only (no `deploy.log` line): `up to date at <sha12>`, `another deploy is running (or port N is in use); skipping this run`, `ABORTED: ...` (a mandatory write or an unreadable state file stopped the run), and every `[dry-run]` line.

`~/.chroxy/last-deploy.json` holds the most recent verified result, `~/.chroxy/deploy-state.json` holds `failedTarget`, `rollbackTo` and the log dedupe key, `~/.chroxy/deploy-build.json` is the build stamp, and the launchd stdout/stderr logs above hold the one-line-per-tick console output.

## Rolling back by hand

```bash
cd ~/Projects/chroxy-daemon
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.chroxy.deploy.plist   # stop the agent first
cat ~/.chroxy/last-deploy.json            # "from" is the commit to return to
rm -f ~/.chroxy/deploy-build.json         # the stamp must not certify a build you are about to replace
git reset --hard <from>
npm ci --no-audit --no-fund               # only if package-lock.json differs between the two commits
npm run build -w @chroxy/dashboard
launchctl kill SIGTERM gui/$UID/com.chroxy.server
```

Resetting by hand leaves the checkout behind `origin/main`, so a running agent would deploy `main` again on its next tick; that is why it is stopped first. When you start it again, a tick that finds the daemon on the right commit but no stamp simply rebuilds (`repaired checkout ...`). If `deploy-state.json` carries a `rollbackTo` or `failedTarget` you no longer want, delete the file.
