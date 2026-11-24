# Session freshness reconciler (core)

A reconciler that grades the age of each session's declared status. It reads
sources through read-only adapters, grades every report by its age, and writes
what it saw to a file ledger. This page covers the core: the adapter contract,
the file ledger and the first adapter. The rules it implements are the
executable model in `packages/server/tests/freshness/` (its README is the
specification and defines the vocabulary: report, check, key table, ledger).

## Where it lives and whether it ships

The code is in `packages/server/src/freshness/`. `src` is in the published
package's `files`, so **it ships**. Nothing in the daemon imports it yet and
nothing starts it: it is a library until a runner is added (#9282).

The model's pure rule modules moved there from `tests/freshness/model/`
(`hash`, `keys`, `grade`, `config`, `ledger`, `checks`, `derive`, `policy`, and
the driver in `runtime.js`). The files of the same name under
`tests/freshness/model/` re-export them, so the model tests and the reconciler
run one implementation. Everything in those files ships, including the parts the
core does not run: `derive.js` folds the surface, owner and investigation
records, and `policy.js` holds the owner-block, surface-order and investigation
rules. What stays under `tests/` and does not ship: the investigation scheduler
(`investigation.js`), the owner queue (`queue.js`), the model's tick planner
(`reconciler.js`) and the test helpers.

| File | Role |
|---|---|
| `adapter.js` | The read-only adapter contract, and the shape check of every read |
| `state-file-adapter.js` | Adapter over the daemon's persisted session-state file |
| `file-ledger.js` | The durable file ledger and its single-writer guard |
| `core.js` | `openReconciler`, `planCoreTick`, `coreConfig` |
| `index.js` | The public surface |

## The adapter contract

An adapter is a plain object with a `source` name and two methods, `list()` and
`read(session, now)`. There is no send method, and none can be added:
`sealAdapter` refuses an adapter with any other member (it does not trim it),
and the reconciler works only with the frozen `{ source, list, read }` view.

A read carries the source, the report's own time (`last_report_at`) and its
`state`. The reconciler stamps `checked_at` and computes `freshness`, so an
adapter cannot grade its own report. A read that is not well formed, or an
adapter that throws, is an `error` read with a fixed code (`adapter_shape`,
`adapter_fault`); a listing that cannot be read is recorded as a
`source_unreadable` system record. Nothing a failing adapter says reaches the
ledger.

The reconciler opens no credential store, holds no secret and makes no network
call. Its only I/O is the ledger directory and what an adapter reads. Tests
assert this on the source (imports and names), on a full run with every network,
process and file entry point trapped, and on the configuration.

## The file ledger

`ledger.jsonl` in a directory the caller names, outside the daemon's own state
directory (`keepOutOf` refuses the daemon's). One record per line in the model's
envelope: the record's `id` is its idempotency key, an identical repeat is
ignored, a different payload under the same key appends one
`idempotency_conflict`, and each record carries the hash of the one before.
Every append is written with one write and synced before it returns. The key
index is rebuilt from the file on open, so keys stay durable across restarts.

On open, a last line without a newline is a write a crash cut off and is dropped.
A bad line, a gap in the sequence, a broken hash chain or a different ledger id
refuses the open (`LedgerCorruptError`); nothing is repaired.

### Single writer: refuse, and fence the stale

A second reconciler on the same ledger is **refused**: `ledger.lock` is created
exclusively, and a process that finds a live holder throws `LedgerHeldError`
before it reads or writes anything.

A **stale** holder is **fenced**. On this host a holder is stale only when its
pid is gone: a live pid is never taken over, however old its lock. On another
host, where the pid cannot be checked, a holder is stale when its lock has not
been touched for the lease. The lease must exceed the tick cadence;
`openReconciler` rejects a shorter one and defaults to twice the longest cadence
(at least 15 minutes). A takeover bumps the lock's epoch and writes one
`writer_takeover` record. Before every append the writer re-checks that the lock
still names it and that the file is the size it left it at; a holder that was
paused past the lease and taken over gets `LedgerFencedError` and writes
nothing. The lock's time only moves forward. Closing a fenced handle does not
release the new holder's lock.

The checks and the write are separate steps. A successor that takes over and
writes inside the microseconds between a stale holder's size check and its write
can leave a duplicate sequence number. The next open then refuses the ledger
with `LedgerCorruptError` instead of repairing it: the damage is detected, not
silent, and needs an operator. Pid reuse can make a dead same-host holder look
live until that pid exits.

## The state-file adapter

Reads the daemon's `session-state.json` and takes, for each session, its `id`
and its `declaredStatus`, and from that `state`, `next`, `blockedOn`,
`decision`, `updatedAt` and `source`. Names, working directories, history and the
`summary` text are never read into a value, so planted content outside the status
fields leaves no trace in the ledger. It never writes the file.

Every read is shape-checked: the file must be an object with `version: 1` and a
`sessions` array of objects with unique string ids; each `declaredStatus` must
satisfy the daemon's own strict `DeclaredStatusSchema`; an entry with no
`declaredStatus` must still carry the keys the daemon always writes
(`sdkSessionId`, `conversationId`) and no declaration-shaped object under another
key, so a renamed field is an error. A declaration dropped from an otherwise
intact entry cannot be told from a session that never declared, and reads as no
status. A changed shape is
`error` (`shape_changed`, `parse_failed`, `source_missing`), never `idle`, never
no status. The daemon stamps `updatedAt` when a declaration changes, so reports
are timed `changed_at` and a decision is recorded `possibly_inherited`.

The four-slot status block is parsed by the daemon's own `extractDeclaredStatus`
(`declared-status.js`); `reportFromText` maps its result to a report for sources
that hold message text.

## The session-registry adapter and the activity meter

`session-registry-adapter.js` reads the Claude Code command-line tool's local
registry of live sessions: a directory with one `<pid>.json` file per live
process (`~/.claude/sessions/` by default; the caller passes the directory, the
adapter never derives it). It is activity evidence only. It never returns a
report, so a session it reads is graded `unknown` (no status line) and can never
be `fresh`. What it returns is native activity: whether a turn is in flight and
a `registry_busy` or `registry_idle` event timed at the row's `statusUpdatedAt`,
with the host application (from `entrypoint`) in the event's `ref`. The session
is listed with its project (the last segment of `cwd`) as its scope.

The registry is not a documented interface. Only `sessionId`, `cwd`, `status`
(`busy` or `idle`), `statusUpdatedAt` (epoch milliseconds) and `entrypoint` are
read, and each must have the expected type. The title (`name`) and every other
field are never read into a value, so planted content there leaves no trace in
the ledger; an `entrypoint` that is not a short lowercase token is recorded as
`other`. A row that fails the check, an unparseable or oversized row, a
duplicate `sessionId`, a row file that is not a regular file or a registry
directory that is missing makes the whole registry `error` for that tick
(`shape_changed`, `parse_failed`, `too_large`, `source_missing`), never `idle`.
A row dated more than five minutes ahead of the check is `error: clock_skew`.
Files not named `<digits>.json` are ignored unopened. An empty directory is a
registry with no live sessions. The directory is only read.

`activity-meter.js` turns samples of the registry (`sampleRegistry`) into one
record per day: for each host application, the live sessions seen and the hours
it was active. A sample's busy state holds until the next sample, a span is
credited at most 30 minutes (a gap is not evidence), the last sample credits
nothing and the day is clipped to its UTC window (shifted by an offset).
Active time is wall time with at least one busy session of the application, not
a sum over sessions. The meter is separate from provider quota (#6778). Running
either against the real registry, and where samples are kept between ticks, are
for the runner (#9282).

## Relation to the daemon's stall alerts (#8709)

#8709 compares declared with observed state inside the daemon and alerts on a
stall. This reconciler grades the age of a session's last authored status from
outside it. They should share the freshness thresholds and the grading
(`grade.js`, `config.js`) rather than grow separate notification rules: the
daemon can import `gradeRead` and the thresholds from `src/freshness/`, and the
ledger's `check` records are what a per-repo pulse (#8855) can display.

## Not in the core

Live sources, delivery of anything, the stale investigation (#9280) and the
queue and outbox (#9284). The seed-handoff origin is not derived: `seed_ref` is
always null until a source that carries seed scope and write time is added.
