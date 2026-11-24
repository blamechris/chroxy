# Session freshness runner (read-only)

A command that runs **one tick** of the session freshness reconciler over three
live sources and exits. A timer starts it; nothing in this repository installs
or starts a timer. The reconciler, its adapters and the ledger are described in
[`freshness-reconciler.md`](freshness-reconciler.md).

Read-only mode is the only mode. It reads the sources, writes the ledger and
delivers nothing: the runner imports no network, child-process or credential
module, the reconciler has no send method, and the only directory it writes is
the ledger's.

| Source | What it reads | Default location |
|---|---|---|
| `chroxy-state-file` | declared status of each session in the daemon's state file | `<config dir>/session-state.json` (`CHROXY_CONFIG_DIR`, else `~/.chroxy`) |
| `claude-session-registry` | which Claude Code sessions are live and busy (activity only) | `<claude config dir>/sessions` (`CLAUDE_CONFIG_DIR`, else `~/.claude`) |
| `claude-transcript` | the last status block each Claude transcript's assistant authored | `<claude config dir>/projects` |

The defaults are resolved the way the daemon resolves them. Every path can be
overridden; use the overrides to point a run at copies.

## The command

```text
freshness tick --ledger-dir <dir> [--state-file <file>] [--registry-dir <dir>] [--projects-dir <dir>]
               [--cadence-minutes <n>] [--lease-minutes <n>] [--ledger-id <id>] [--mode read-only] [--allow-dev-checkout]
freshness stamp --commit <40-hex sha> [--package-dir <dir>] [--force]
```

Run it from a pinned install, directly, without starting the daemon:

```bash
node "$PIN/node_modules/@chroxy/server/src/freshness-runner/cli.js" tick --ledger-dir "$LEDGER"
```

or through the CLI of that install, `chroxy freshness tick --ledger-dir "$LEDGER"`.
It prints one JSON line (the build, the slot and, per source, the tick id and a
count of sessions by freshness; no session text).

| Exit | Meaning |
|---|---|
| 0 | every source ticked |
| 1 | a source's tick failed; the others ran (see `failed` in the output) |
| 2 | refused: bad arguments (including a missing `--ledger-dir`, also through `chroxy freshness`), a build that is not a stamped pinned install, a ledger inside the daemon's state directory or inside a source directory or Claude's config dir (real paths are compared, so a symlink does not get around it), a lease that does not exceed the cadence, a ledger that is corrupt or was fenced |
| 3 | the ledger is held by another reconciler; no source was ticked |

- **`--ledger-dir` has no default.** It must sit outside the daemon's state
  directory (`CHROXY_CONFIG_DIR`, `~/.chroxy` by default), the state file's
  directory, the registry and projects directories and Claude's config dir; the
  core refuses it otherwise, comparing real paths. A path such as
  `~/.local/state/chroxy-freshness/ledger` works.
- **The cadence** (`--cadence-minutes`, default 30) is how often a tick is due.
  A tick is due once per slot of that length, and the slot is the wall-clock
  interval the run falls in. Set the timer's period to **half the cadence** (15
  minutes for 30): a timer whose period equals the cadence drifts, fires twice
  in one slot and then skips the next, which records a missed slot. With the
  half period each slot is ticked once and the second firing finds the tick
  closed and does nothing (`skipped: closed`). A timer that fires less often
  than the cadence records the slots it missed.
- **The lease** (`--lease-minutes`) defaults to twice the cadence, at least 15
  minutes, and must exceed the cadence. The runner is one-shot: it holds the
  ledger's writer lock only while a tick runs, so a second run that overlaps the
  first is refused with exit 3 rather than interleaved.

## What a tick record carries

Every `tick` record (open and close, one pair per source) has a `build` object:

| Field | Value | Read from |
|---|---|---|
| `commit` | the 40-character commit of the build that ran | `build-info.json` in the installed package, written by `freshness stamp` |
| `daemon_version` | the installed daemon package's version | the installed package's `package.json`, read at run time |
| `state_schema_version` | the state file's `version`, or `null` when it cannot be read | the state file |
| `install` | `pinned` or `checkout` | where the package is installed |

The state file's own shape check is the state-file adapter's: a file that fails
it reads as `error` (`shape_changed`), never as an idle session.

## A pinned install

A pinned install is a copy of the daemon package under a `node_modules`
directory, stamped with the commit it was built from. Switching branches in a
development checkout does not change it, because nothing in it points at the
checkout. The runner refuses to run from anywhere else (a path without a
real path ending in `node_modules/@chroxy/server` with no `.git` entry at or
above it, which includes an npm workspace link into a checkout) unless
`--allow-dev-checkout` is given, and refuses an install that has not been
stamped. Keep the pin directory out of any git working tree. `stamp` refuses to
replace a different existing stamp unless `--force`.

Build it from a commit, not from a working tree:

```bash
CHECKOUT=~/src/chroxy                                  # any clone; it is only read
COMMIT=$(git -C "$CHECKOUT" rev-parse --verify "origin/main^{commit}")   # a full 40-character id
PIN=~/.local/share/chroxy-freshness/$COMMIT            # one directory per build
BUILD=$(mktemp -d)

# 1. Pack the three workspace packages at that commit.
git -C "$CHECKOUT" worktree add --detach "$BUILD/src" "$COMMIT"
(cd "$BUILD/src" && npm ci --ignore-scripts && npm run build -w @chroxy/protocol \
  && npm pack -w @chroxy/protocol -w @chroxy/store-core -w @chroxy/server --pack-destination "$BUILD")

# 2. Install the tarballs into the pin directory (not a workspace, not the checkout).
mkdir -p "$PIN" && (cd "$PIN" && npm init -y >/dev/null && npm install --ignore-scripts "$BUILD"/chroxy-*.tgz)

# 3. Stamp the installed copy with the commit.
node "$PIN/node_modules/@chroxy/server/src/freshness-runner/cli.js" stamp --commit "$COMMIT" \
  --package-dir "$PIN/node_modules/@chroxy/server"

git -C "$CHECKOUT" worktree remove --force "$BUILD/src"; rm -rf "$BUILD"
```

`--ignore-scripts` skips the native build of `node-pty`, which the runner does
not use. The three tarballs are installed together so the protocol the runner
loads is the one at the same commit, not whatever is published.

To move to another build, make a new pin directory the same way and change the
timer's path; the old directory stays, so going back is a path change. The
ledger is shared across builds, and each record names the build that wrote it.
Reinstalling over a pin directory removes the stamp: stamp again. A second run
in the same slot by a different build, or after the state file's schema version
changed, writes a different tick record under the same key, which the ledger
records as an `idempotency_conflict` rather than a duplicate.

## Timer definitions

These are examples. Nothing here is installed by the code; copy, adjust the
paths and the node binary, and load them yourself. Both fire at half the cadence, so each slot is ticked once.

### macOS: launchd

Save as `~/Library/LaunchAgents/local.chroxy.freshness-tick.plist`, then
`launchctl bootstrap gui/$(id -u) <that file>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.chroxy.freshness-tick</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>/Users/example/.local/share/chroxy-freshness/COMMIT/node_modules/@chroxy/server/src/freshness-runner/cli.js</string>
    <string>tick</string>
    <string>--ledger-dir</string>
    <string>/Users/example/.local/state/chroxy-freshness/ledger</string>
    <string>--cadence-minutes</string>
    <string>30</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>/Users/example/.local/state/chroxy-freshness/tick.err</string>
</dict>
</plist>
```

### Linux: systemd (user units)

`~/.config/systemd/user/chroxy-freshness-tick.service`:

```ini
[Unit]
Description=Chroxy session freshness tick (read-only)

[Service]
Type=oneshot
ExecStart=/usr/bin/node %h/.local/share/chroxy-freshness/COMMIT/node_modules/@chroxy/server/src/freshness-runner/cli.js tick --ledger-dir %h/.local/state/chroxy-freshness/ledger --cadence-minutes 30
```

`~/.config/systemd/user/chroxy-freshness-tick.timer`:

```ini
[Unit]
Description=Run the Chroxy session freshness tick every 15 minutes (half the 30-minute cadence)

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now chroxy-freshness-tick.timer`.
Replace `COMMIT` with the full commit id of the pin directory, and use a Node 22
binary.

## Running without the shadow period

Delivery mode does not exist here, so a run delivers nothing whatever it reads.
The multi-day shadow run that issue #9282 listed as its fourth acceptance
criterion was waived by the project owner: the runner goes straight to use, and
a mismatch between the ledger and what the Chroxy app or dashboard shows is
recorded as a comment on the issue when it is found. A transcript read has one
more first-run step, described in `freshness-reconciler.md`: one recorded sample
read of a known session before relying on that source.
