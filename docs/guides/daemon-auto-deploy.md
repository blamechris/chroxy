# Daemon auto-deploy (idle-only)

`scripts/deploy-daemon.mjs` keeps a long-running Chroxy daemon on the latest `main` without ever restarting it while there is work to lose. It is for the setup where one machine runs the daemon from a dedicated checkout under launchd (`KeepAlive=true`, `node packages/server/src/cli.js start --no-supervisor`) and you want that daemon to follow `main` on its own (#8324).

This guide is documentation only. The repository does not install the launchd agent for you; you opt in by creating the plist below.

## What it does, and does not do

Every run (the agent below runs it every ten minutes):

1. Takes `<configDir>/deploy.lock` so two runs never overlap. A lock whose pid is dead is stale and is reclaimed, but only through a second lock, `deploy.lock.reclaim` (created exclusively; itself stale after 60 s). The reclaimer re-reads the main lock's holder after taking the reclaim lock and unlinks only if that holder is still dead, so a slow reclaimer can never delete a live lock another run just took. `deploy-state.json` is read and written only while holding the lock, and `deploy-state.json` and `last-deploy.json` are written atomically (temp file plus rename). A run that loses the lock prints one console line and touches no state. A corrupt `deploy-state.json` is moved aside to `deploy-state.json.corrupt-<ts>`, logged, and treated as empty.
2. Requires the daemon checkout to be a **clean** git tree on the followed branch. A dirty tree or the wrong branch is refused (exit 1) and logged; nothing is touched.
3. `git fetch`es the remote. If `HEAD` already equals the remote branch it prints one console line, writes nothing to `deploy.log`, and exits 0. If `HEAD` is not an ancestor of the remote branch (diverged, or ahead) it refuses: this is fast-forward only. If the remote branch is a commit that already **rolled back** on this machine it is skipped (see "A target that already failed is not retried").
4. Asks the running daemon whether it is idle (below). Busy, unreachable, a daemon that predates the route, or an unreadable answer all mean **do not deploy**; the run exits 0 and logs why, once per target commit rather than once per tick.
5. Records `inProgress: { from, to, phase: 'building' }` in `deploy-state.json`, then `git merge --ff-only`, then `npm ci --no-audit --no-fund` **only if** a `package-lock.json` (root or `packages/*`) changed in the range, then `npm run build -w @chroxy/dashboard`.
6. If the install or build fails: `git reset --hard` back to the previous commit, redo `npm ci` if the lockfile had changed, rebuild, log `rolled-back (build failed: ...)`, exit 1. The running daemon was never signalled.
7. Asks again whether the daemon is idle, because the build takes time. If it is busy (or cannot be confirmed idle) now, it **rolls back**: `git reset --hard` to the previous commit, `npm ci` again if the lockfile had changed, rebuild, log `deferred after build: busy (...)` (once per target) and exit 0. Nothing is left built-but-unrestarted: a turn that started during the build would otherwise run for hours under a daemon whose dashboard (served from disk) and source files no longer match it. The next tick tries again from scratch.
8. Sets the phase to `restarting` (with the pid it is about to signal) and restarts with `launchctl kill SIGTERM gui/<uid>/<label>` (a graceful SIGTERM, never SIGKILL). launchd relaunches the daemon.
9. Waits (default 90 s) until `connection.json` names a **different pid** than the one it signalled **and** the local `/health` answers 200, so an old process that has not exited yet cannot pass for the new one. 
10. **Settles.** A build that answers `/health` and then crashes seconds later is not a deploy. After health passes it waits `--settle <s>` (default 15) and re-confirms that `connection.json` still names the same new pid, that pid is alive, and local `/health` still answers 200. Failing that counts as a health failure.
11. **Tunnel, last.** Unless the tunnel is `none`/absent or `--no-tunnel-check` is set, it then requires the tunnel URL's `/health` to answer 200, retrying through the HTTP 530 a Cloudflare tunnel returns for several seconds after a restart. This comes after the settle verdict on purpose. A **tunnel-only** failure (local health fine, settle passed, the tunnel never answered) is **not rolled back**: the new daemon is serving locally and may already hold new work, and a rollback would not fix a tunnel. The outcome is `deployed-tunnel-unverified`, exit 1, a loud `DEPLOYED-TUNNEL-UNVERIFIED` line in `deploy.log`, the same `result` in `last-deploy.json`, and the target is **not** recorded as failed.
12. If local health or the settle check fails: `git reset --hard` to the previous commit, rebuild, signal again, wait again. Before that second SIGTERM, if the daemon still answers `/api/daemon/idle` and is busy, the script polls for idle for up to `--health-timeout` and logs that it waited; it then restarts regardless, because the running code is known-bad. It logs `rolled-back (health failed: ...)` and exits 1, or `ROLLBACK-FAILED` loudly if the daemon still is not healthy.
13. On success it appends `<utc iso> <old12>..<new12> ok` to `<configDir>/logs/deploy.log` and writes `<configDir>/last-deploy.json` (`{ from, to, at, result, subject }`).

It does **not** run the test suite (CI already did, on the commit that merged), does not touch the supervisor or `chroxy deploy` (those drive a supervisor over SIGUSR2 and do not apply to a `--no-supervisor` daemon), and does not install or remove the launchd agent.

### An interrupted deploy is recovered

The record in step 5 is cleared on every terminal outcome. If the process is killed (or the machine loses power) between the merge and the end, the record survives and the next run, under the lock and **before** the "already up to date" shortcut, recovers it. Without this, `HEAD` already equals `origin/main` after the merge and the interruption would read as "up to date" for ever.

- Phase `building`: logs `recovering interrupted deploy`, resets to `from`, rebuilds (with `npm ci` if the lockfile differs), clears the record, and then continues the normal flow in the same run, so the target is retried. It is not recorded as a failed target.
- Phase `restarting`: the SIGTERM may or may not have been sent. If `connection.json` still names the pid the script was aiming at, the daemon never restarted, so this is handled like `building`. Otherwise it verifies the running daemon (local `/health` plus the settle check, with no new-pid requirement): healthy means it records `ok` and carries on; unhealthy takes the ordinary health-failed rollback path.
- If recovery itself fails the record is kept and the next tick tries again.

### A target that already failed is not retried

When a target commit rolls back (a failed build, a failed restart, a failed health or settle check, or a failed rollback), its SHA is recorded in `<configDir>/deploy-state.json` as `failedTarget` / `failedOutcome`. While `origin/main` is still that commit, later ticks do nothing but log (once) `skipped: <sha12> already rolled back (<outcome>); waiting for a newer main or --retry` and exit 0. Without this a bad `main` would be rebuilt every ten minutes forever, and every health-failure retry would restart the daemon twice. A newer `origin/main` clears the record. `--retry` tries the recorded target once and clears the record if it succeeds. `--force` skips the idle checks only; it does **not** imply `--retry`. `--dry-run` says when a real run would skip.

Note that a health rollback can be caused by something unrelated to the code, such as a Cloudflare tunnel outage. The target is then skipped until `main` moves or you run `--retry`. A busy daemon is not a failure: `deferred` and `deferred after build` outcomes are never recorded, so they are retried next tick.

Things to know:

- **The deploy is not zero-impact on disk, even though the daemon is idle.** For the length of the build, the dashboard `dist` that the running daemon serves is replaced (the build empties it first, so a request during the build can find it missing or half-written), and when a lockfile changed `npm ci` replaces `node_modules` under the running process, where a lazy import can see the new tree. The idle check is what makes that window acceptable; it does not make it zero. If the daemon turns busy during the build, the script restores the old tree and rebuilds it (step 7) rather than leave the new one in place, so the window can be longer than one build.
- A rollback restores the **checkout and the dashboard build**. It cannot undo anything the new daemon wrote to `~/.chroxy` while it ran.

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
- nothing in the session's `getRestartBlockers()`: work `isBusy` does not report. The base list is background agents that outlived their turn and input accepted into the outgoing queue but not yet dispatched. The Claude CLI session adds messages acknowledged as `queued` while the CLI warms up or respawns. The Claude TUI session adds recent terminal output (any PTY output in the last 30 s, on the same monotonic clock the #6601 readiness signal uses), because a turn typed straight into the terminal never sets `isBusy`. The other providers (SDK, Codex, BYOK, Gemini, ACP, claude-channel) queue only in the shared outgoing queue, so they need no override.

The answer lists every session's state and a `reasons` array (for example `session "main" busy: turn`). If the daemon cannot compute any part of the answer, including a missing or throwing `getRestartBlockers()` or one that returns something other than an array of reasons, it answers `idle: false`. The route is loopback-only and primary-token-only; see [bearer-token-authority.md](../security/bearer-token-authority.md). The loopback gate parses the peer address strictly (127.0.0.0/8, `::1`, IPv4-mapped 127.x) and rejects any request carrying a `cf-*`, `cdn-loop`, `forwarded`, `x-forwarded-*` or `x-real-ip` header, because Cloudflare can strip the visitor-IP headers; it is defence in depth, and the primary token is the authority. The script reads the port from `connection.json` when `httpUrl` carries one, and otherwise uses 8765. Pass `--port` if your daemon listens elsewhere and is reached through a tunnel.

### Known residual

There is a sub-second window between the final idle check and the SIGTERM in which newly submitted work can be cut off. The probe is a snapshot, not a lock. A daemon-side maintenance lease, which would make the daemon refuse new work once the deploy has decided to restart, is tracked as a follow-up (issue to be filed).

## Running it by hand

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/deploy-daemon.mjs --dry-run
```

`--dry-run` fetches and then prints the commits that would deploy (with subjects), whether `package-lock.json` changed, the idle verdict and its reasons, and the exact commands. It performs no merge, install, build, restart, lock or log write.

Options: `--checkout <path>` (default `~/Projects/chroxy-daemon`), `--config-dir <path>` (default `$CHROXY_CONFIG_DIR` or `~/.chroxy`), `--label <launchd label>` (default `com.chroxy.server`), `--branch main`, `--remote origin`, `--port <n>`, `--health-timeout <s>` (default 90), `--settle <s>` (default 15; seconds to wait after health passes before re-confirming the same pid), `--npm <path>`, `--dry-run`, `--force` (skip both idle checks; everything else still happens), `--retry` (try a target that already rolled back), `--no-tunnel-check`.

### First time: bootstrap with `--force`

The running daemon predates `GET /api/daemon/idle`, so it answers 404 and the script (correctly) refuses to deploy. The first deploy that brings the route in has to be done by you, once, at a moment when you know nothing is running:

```bash
node scripts/deploy-daemon.mjs --force
```

(or update the checkout and restart by hand). From then on the daemon has the route and the unattended agent works. `--force` skips the idle gate, so check first that no session is mid-turn.

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

| Line | Meaning |
|---|---|
| `<old12>..<new12> ok` | Deployed and healthy. |
| `deferred: busy (...)` | Something was running; retried next tick. Logged once per target. |
| `deferred: cannot confirm idle (...)` | Daemon unreachable, route missing, or an unreadable answer. Nothing was deployed. |
| `deferred after build: busy (...)` | The daemon turned busy during the build. The old commit was restored and rebuilt; retried next tick. Logged once per target. |
| `skipped: <sha12> already rolled back (...)` | This target failed before; nothing runs until `main` moves or you pass `--retry`. Logged once per target. |
| `rolled-back (build failed: ...)` | The install or build failed; the checkout is back on the old commit and the daemon was never touched. |
| `DEPLOYED-TUNNEL-UNVERIFIED ...` | The new daemon is healthy and settled locally but the tunnel never answered 200. Not rolled back; check the tunnel. |
| `recovering interrupted deploy ...` / `recovered interrupted deploy ...` | A previous run was killed mid-deploy; this run reset to the previous commit and retried, or verified the daemon. |
| `rollback restart waited ...` / `rollback restart: daemon still busy ...` | A health rollback held its SIGTERM for a busy daemon (up to `--health-timeout`), then restarted anyway. |
| `rolled-back (health failed: ...)` | The new daemon did not come back healthy, or did not stay healthy through the settle window; the old build was restored and the daemon restarted onto it. |
| `ROLLBACK-FAILED ...` | The rollback itself failed. Go and look at launchd and the checkout. |
| `refused: ...` | Dirty tree, wrong branch, or not a fast-forward. Fix the checkout; the script will not. |

`~/.chroxy/last-deploy.json` holds the most recent result, `~/.chroxy/deploy-state.json` holds the log dedupe key, any `failedTarget` and any `inProgress` record, and the launchd stdout/stderr logs above hold the one-line-per-tick console output.

## Rolling back by hand

```bash
cd ~/Projects/chroxy-daemon
cat ~/.chroxy/last-deploy.json            # "from" is the commit to return to
git reset --hard <from>
npm ci --no-audit --no-fund               # only if package-lock.json differs between the two commits
npm run build -w @chroxy/dashboard
launchctl kill SIGTERM gui/$UID/com.chroxy.server
```

Resetting by hand leaves the checkout behind `origin/main`, so the agent will deploy `main` again on its next tick. To stop that, unload the agent first (`launchctl bootout ...` above) and bring it back when you are ready.
