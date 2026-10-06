# Daemon auto-deploy (idle-only)

`scripts/deploy-daemon.mjs` keeps a long-running Chroxy daemon on the latest `main` without ever restarting it while there is work to lose. It is for the setup where one machine runs the daemon from a dedicated checkout under launchd (`KeepAlive=true`, `node packages/server/src/cli.js start --no-supervisor`) and you want that daemon to follow `main` on its own (#8324).

This guide is documentation only. The repository does not install the launchd agent for you; you opt in by creating the plist below.

## What it does, and does not do

Every run (the agent below runs it every ten minutes):

1. Takes `<configDir>/deploy.lock` so two runs never overlap. A lock whose pid is dead is stale and is reclaimed.
2. Requires the daemon checkout to be a **clean** git tree on the followed branch. A dirty tree or the wrong branch is refused (exit 1) and logged; nothing is touched.
3. `git fetch`es the remote. If `HEAD` already equals the remote branch it prints one console line, writes nothing to `deploy.log`, and exits 0. If `HEAD` is not an ancestor of the remote branch (diverged, or ahead) it refuses: this is fast-forward only. If the remote branch is a commit that already **rolled back** on this machine it is skipped (see "A target that already failed is not retried").
4. Asks the running daemon whether it is idle (below). Busy, unreachable, a daemon that predates the route, or an unreadable answer all mean **do not deploy**; the run exits 0 and logs why, once per target commit rather than once per tick.
5. `git merge --ff-only`, then `npm ci --no-audit --no-fund` **only if** a `package-lock.json` (root or `packages/*`) changed in the range, then `npm run build -w @chroxy/dashboard`.
6. If the install or build fails: `git reset --hard` back to the previous commit, redo `npm ci` if the lockfile had changed, rebuild, log `rolled-back (build failed: ...)`, exit 1. The running daemon was never signalled.
7. Asks again whether the daemon is idle, because the build takes time. If it is busy (or cannot be confirmed idle) now, it **rolls back**: `git reset --hard` to the previous commit, `npm ci` again if the lockfile had changed, rebuild, log `deferred after build: busy (...)` (once per target) and exit 0. Nothing is left built-but-unrestarted: a turn that started during the build would otherwise run for hours under a daemon whose dashboard (served from disk) and source files no longer match it. The next tick tries again from scratch.
8. Restarts with `launchctl kill SIGTERM gui/<uid>/<label>` (a graceful SIGTERM, never SIGKILL). launchd relaunches the daemon.
9. Waits (default 90 s) until `connection.json` names a **different pid** than the one it signalled **and** the local `/health` answers 200, so an old process that has not exited yet cannot pass for the new one. Unless the tunnel is `none`/absent or `--no-tunnel-check` is set, it then requires the tunnel URL's `/health` to answer 200, retrying through the HTTP 530 a Cloudflare tunnel returns for several seconds after a restart.
10. **Settles.** A build that answers `/health` and then crashes seconds later is not a deploy. After health passes it waits `--settle <s>` (default 15) and re-confirms that `connection.json` still names the same new pid, that pid is alive, and local `/health` still answers 200. Failing that counts as a health failure.
11. If health (or the settle check) fails: `git reset --hard` to the previous commit, rebuild, signal again, wait again. It logs `rolled-back (health failed: ...)` and exits 1, or `ROLLBACK-FAILED` loudly if the daemon still is not healthy.
12. On success it appends `<utc iso> <old12>..<new12> ok` to `<configDir>/logs/deploy.log` and writes `<configDir>/last-deploy.json` (`{ from, to, at, result, subject }`).

It does **not** run the test suite (CI already did, on the commit that merged), does not touch the supervisor or `chroxy deploy` (those drive a supervisor over SIGUSR2 and do not apply to a `--no-supervisor` daemon), and does not install or remove the launchd agent.

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
- no hook-routed permission request is parked on the daemon.

The answer lists every session's state and a `reasons` array (for example `session "main" busy: turn`). If the daemon cannot compute the answer it answers `idle: false`. The route is loopback-only and primary-token-only; see [bearer-token-authority.md](../security/bearer-token-authority.md). The script reads the port from `connection.json` when `httpUrl` carries one, and otherwise uses 8765. Pass `--port` if your daemon listens elsewhere and is reached through a tunnel.

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
| `rolled-back (health failed: ...)` | The new daemon did not come back healthy, or did not stay healthy through the settle window; the old build was restored and the daemon restarted onto it. |
| `ROLLBACK-FAILED ...` | The rollback itself failed. Go and look at launchd and the checkout. |
| `refused: ...` | Dirty tree, wrong branch, or not a fast-forward. Fix the checkout; the script will not. |

`~/.chroxy/last-deploy.json` holds the most recent result, `~/.chroxy/deploy-state.json` holds the log dedupe key and any `failedTarget`, and the launchd stdout/stderr logs above hold the one-line-per-tick console output.

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
