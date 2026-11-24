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
(`hash`, `keys`, `grade`, `config`, `ledger`, `checks`, `derive`, `policy`,
`investigation`, and the driver in `runtime.js`). The files of the same name under
`tests/freshness/model/` re-export them, so the model tests and the reconciler
run one implementation. Everything in those files ships, including the parts the
core does not run: `derive.js` folds the surface, owner and investigation
records, and `policy.js` holds the owner-block, surface-order and investigation
rules. The owner queue (`queue.js`) moved there too (#9284). What stays under
`tests/` and does not ship: the model's tick planner (`reconciler.js`) and the
test helpers.

| File | Role |
|---|---|
| `adapter.js` | The read-only adapter contract, and the shape check of every read |
| `state-file-adapter.js` | Adapter over the daemon's persisted session-state file |
| `file-ledger.js` | The durable file ledger and its single-writer guard |
| `investigation.js` | The bounded, read-only stale investigation |
| `queue.js` | The single-slot owner queue and owner actions (the model's, unchanged) |
| `exchange.js`, `outbox.js`, `inbox.js`, `render.js` | The queue's files: outbox, receipts, acknowledgements and the templates (below) |
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

## Transcript readers (`src/freshness-sources/`)

Live sources are kept out of `src/freshness/`: that directory's isolation test
allows no import of the daemon's transcript locator. They ship in the package
with the rest of `src`, and like the core nothing imports them yet (#9282).
Register the capabilities each exports (`CLAUDE_TRANSCRIPT_CAPS`,
`CODEX_TRANSCRIPT_CAPS`) in the reconciler's configuration under the adapter's
source name.

**Claude** (`createClaudeTranscriptAdapter({ projectsDir })`). Finds the last
status block the assistant authored in a session's JSONL transcript, and its
time, and keeps nothing else: every other line is parsed, looked at and
dropped. Prompts, tool input and output, thinking, earlier blocks, prose, titles
and working directories never leave the module, so planted content outside the
block leaves no trace in the ledger (tested with canaries in each of those
places).

- Location is the closed-conversation locator, `resolveTranscriptSource`, with
  its containment on real paths. The listing takes only regular files in real
  project directories (a link is not listed); a link swapped in afterwards is
  refused. A project directory that cannot be listed, or a `*.jsonl` name the reader would not accept, makes the whole listing unreadable (`null`) rather than shorter, so a read error is never taken for a session that is gone. `projectsDir` must be absolute. The file is opened read-only, and refused unless it is the
  object the locator resolved and a regular file. A conversation id found in
  two project directories is an `error` (`ambiguous_id`).
- Bounded: at most `maxTailBytes` (4 MiB by default) are read, from the end. A
  line the window starts inside is dropped; an unterminated last line (a write
  in flight) is ignored; a bad line before it is `error` (`corrupt`). A block
  further back than the window is not seen, so a long session whose last block
  is older than the window reads as no status; raise the limit if that
  matters. A window with no complete line is `error` (`tail_too_small`).
- Authored means a top-level assistant entry. User entries, tool results and
  subagent (`isSidechain`) entries are skipped, so a quoted block is not
  read as the session's own. The block is parsed by the daemon's
  `extractDeclaredStatus`, so a block in a code fence or a quote is not one.
  The report is timed with the entry's `timestamp` (`authored_at`) and carries
  `later_unfootered_messages` when a later assistant text message has no block.
- A changed format is `error`, never no status, never a state: an entry
  with no `type`, an assistant entry whose `message.content` is not a list of
  typed blocks, or a block whose entry has no readable `timestamp`
  (`shape_changed`, `bad_timestamp`).

The format was built and tested from synthetic fixtures only. **Before the
first run against real transcripts, make one recorded sample read** (read-only,
of a single known session) and check that the entry types, `message.content`
blocks, `timestamp` and top-level `isSidechain` flag are what the reader
expects; any mismatch reads as `error`, which is the point. Whether
subagent transcripts that sit beside a session file in the store are listed as
sessions is also to be confirmed by that read.

**Codex** (`createCodexTranscriptAdapter()`). **Not supported.** The locator
marks the Codex format unsupported and no recorded sample backs a reader, so the
adapter reads nothing and opens no file: `list()` is `null` (recorded as
`source_unreadable`) and every read is `error: unsupported`. It is never idle and
never no status. A test fails when the locator starts supporting Codex, as the
prompt to write the reader.

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
Files not named `<digits>.json` are ignored unopened, but a directory with
regular `*.json` files and none named `<digits>.json` is a changed format
(`shape_changed`), so a renamed file pattern cannot read as every session gone.
A directory that is empty, or holds only non-JSON files, is a registry with no
live sessions. The directory is only read.

`activity-meter.js` turns samples of the registry (`sampleRegistry`) into one
record per day: for each host application, the live sessions seen and the hours
it was active. A sample's busy state holds until the next sample, a span is
credited at most 30 minutes (a gap is not evidence), the last sample credits
nothing and the day is clipped to its UTC window (shifted by an offset).
Active time is wall time with at least one busy session of the application, not
a sum over sessions. A day must be a real date (1970 or later) and the offset within 14 hours of UTC, or the meter throws. The meter is separate from provider quota (#6778). Running
either against the real registry, and where samples are kept between ticks, are
for the runner (#9282).

## Relation to the daemon's stall alerts (#8709)

#8709 compares declared with observed state inside the daemon and alerts on a
stall. This reconciler grades the age of a session's last authored status from
outside it. They should share the freshness thresholds and the grading
(`grade.js`, `config.js`) rather than grow separate notification rules: the
daemon can import `gradeRead` and the thresholds from `src/freshness/`, and the
ledger's `check` records are what a per-repo pulse (#8855) can display.

## The stale investigation

Each tick, after it has read its sessions, runs the model's investigation
(`investigation.js`; the rules and classifications are in the model's README).
A trigger that holds (an old `running` line, an idle or done line while a turn is
in flight, a session dropped from the listing, two errored checks in a row, or a
recheck of a session found working or waiting) opens at most one investigation
for that session, which reads, classifies and closes in the same tick.

What it may do is what the adapter allows: the tick's listing and `read(session,
now)` on the sealed adapter, which has no send or write member, and appends to
the ledger. A re-read, its retry, the confirmation that a session is gone and a
separate activity read for a source that has one are all that same `read`; an
activity read ignores the report the read carries and keeps its native state.
Nothing is asked of a session. A tick with no exchange directory runs with a delivery function that
throws, so a planner that yielded a send would fail the tick; with one, the only
delivery is a line written to the outbox file.

Bounds, from the configuration: `investigation_budget_per_tick` cycles (first
cycles before second, oldest onset first), `recheck_budget_per_tick` rechecks
that need a read of their own (least recently investigated first; a recheck on
a source whose read carries native state costs no read and takes no budget), at
most one investigation per session per tick, at most two cycles per onset (the
second only after `inconclusive` or `running_claim_unverified`), and one
source-level investigation when every session of a source fails. Investigations
happen only inside a tick, so the cadence bounds how often.

The result is the investigation's `close` record: trigger, onset, cycle,
classification, the age it decided on and what it would surface. Each rung names
the check it read and the evidence class of that read, taken from the ledger's
own records: E2 for an authored report, E5 for a relayed one, E1 for native
state. A decision to surface is recorded and returned from the planner. When the
reconciler is given an exchange directory the owner queue consumes it (below);
without one nothing does.

A stale owner block is classified `waiting_on_owner` only while the owner item
holds a declared ask, which needs the owner queue; so with no exchange directory
a stale blocked line is `blocked_unresolved`.

## The owner queue and the exchange files (#9284)

`openReconciler({ ..., exchangeDir })` makes each tick run the model's single-slot
owner queue (`queue.js`) after the investigation: one owner item per session, a
second item about the same session merged into it, one item holding the slot,
reminders, deferrals and the acknowledgement check, exactly as the model's README
states. Without `exchangeDir` the core behaves as before and runs no queue. The
directory must be absolute and not the ledger directory. The queue is the one
place the report-age notification rule lives (#8709): the daemon's own stall
alerts should not duplicate it.

The reconciler **sends nothing and holds no secret**. Its "delivery" is one line
written to a file; "delivered" in the ledger means *written there*, and the
consumer's receipt says whether it reached anyone. Three files live in the
exchange directory:

| File | Written by | Read by |
|---|---|---|
| `outbox.jsonl` | the reconciler | any consumer, local or on another machine |
| `receipts.jsonl` | the consumer | the reconciler |
| `acks.jsonl` | the consumer, from what the operator said | the reconciler |

### Outbox, schema version 1

UTF-8, one JSON object per line, each ended by `\n`, **append-only**: the
reconciler never changes or removes a line. A consumer reads from the start or
from where it stopped, ignores a last line without its newline (a write in
flight) and any line it cannot parse, and may rotate or truncate the file between
ticks (nothing is re-rendered from the file; its tail is read only to keep a
line from being written twice after a crash, and is read again when the file's
identity changes or it shrinks). A consumer must dedupe by `rec`: a line rewritten
after a crash that came after a rotation is written again. Each write is one `write` and an
`fsync`; a crash can leave a cut-off tail, which the next write starts after
with a newline.

| Field | Meaning |
|---|---|
| `v` | `1` |
| `at` | ISO time the line was written |
| `rec` | this line's id, 32 hex. A receipt or an acknowledgement names it |
| `key` | the message the line is about, 32 hex, **stable per item episode**. Every line of one item has the same key, so a consumer edits one message in place |
| `op` | `post`: the first delivery of the key. `repost`: a further delivery of it (a reminder, a return, a show after a deferral): send it again. `updated`: its content changed: edit the message in place |
| `class` | `item`, `digest`, `echo` or `alert` |
| `status` | `open`, `closed` (an `updated` line of an item that has closed) or `info` |
| `step` | `shown`, `reminded` or `returned` for an item delivery, else `null` |
| `n` | the item's presentation number, else `null` |
| `origin` | `owner`, `attention`, `gone`, `outage` or `seed`, else `null` |
| `source` | the adapter's source name, else `null` |
| `text` | what to show, at most 2000 characters |

Nothing else is in a line: no path, no working directory, no name, no summary and
no field of the session record other than the declared status. `text` is made by
fixed templates (`render.js`), no model: each sentence is fixed, and the only
values put in one are the declared fields (state, blocked-on, decision, next
step, report time) and the session's source and id, each stripped of control
characters and cut to `exchange.text_field_max`. A text names absolute times
only, so an unchanged item renders the same text and is never "updated". A
consumer must still treat `text` as untrusted display text: a declared field is
whatever the session wrote.

What is written, and when:

- **The item currently due** (the one holding the slot) is a `post` when shown,
  and a `repost` for each reminder and for the return of an acknowledged item the
  evidence did not close (its text then starts with a fixed line).
- **A changed item**, or one that closed, is an `updated` line with the same
  `key`, once per change.
- **The digest** (`class: digest`, one fixed key): the open items, one line each,
  at most `exchange.digest_max_items`. `post` the first time, then `updated`
  when its text changes, including to "No open items."
- **An echo item** (`class: echo`) for every acknowledgement, deferral and
  refusal; **an alert item** (`class: alert`) for an acknowledgement the evidence
  contradicted.

The same item is rendered once per key across restarts: whether a message was
posted, and what its text was, are records in the ledger, and every line's `rec`
is derived from what it is made of, so a line written again after a crash is
found in the file's tail and not written twice. If a crash leaves a show's
attempt recorded without its outcome, the next tick marks it "delivery not
confirmed" and it is not made again; if the outbox cannot be written the
attempt's outcome is `failed`, and it is not made again either.

### Receipts

One JSON object per line:

```json
{"v":1,"key":"<32 hex>","rec":"<32 hex>","outcome":"delivered"}
```

`rec` is the outbox line delivered, `key` its key. `delivered` and `failed` are
known. **Any other outcome is unclear**: the attempt is recorded as "delivery not
confirmed" (the text of the outcome is never kept), the item's message says so in
place, and **the attempt is not made again**. The first receipt for a line
stands; a later one is recorded as ignored. Receipts are for item lines only:
one for an echo, alert, digest or `updated` line, or for a line the reconciler
did not write, is recorded as ignored. A message whose receipt is `failed` or
unclear is no longer the item's current message (below), so a failed or unclear
receipt on a reminder makes the earlier delivered message current again, and an
acknowledgement naming that earlier message then applies.

### Acknowledgements and deferrals

One JSON object per line:

```json
{"v":1,"key":"<32 hex>","rec":"<32 hex>","intent":"done"}
{"v":1,"key":"<32 hex>","rec":"<32 hex>","intent":"defer","until":1767571200000}
```

`intent` is `done`, `dismiss` or `defer`; `until` (epoch milliseconds) is required
for `defer` and refused on the others; `at` (a non-negative integer) is optional
and only makes two otherwise identical lines different. `rec` is the outbox line
the operator answers. This is **operator-stated evidence, not a fact**:

- It applies only to the **currently delivered message of an open item**: the
  item's latest delivered line of its current episode, without a failed or unclear
  receipt, whose `key` matches. Any other line (an unknown `rec`, a wrong `key`, a
  closed item, an earlier episode, an earlier message) is **ignored and recorded**,
  and changes nothing.
- `done` closes nothing. The item waits as acknowledged, and the **next tick's own
  evidence** closes it; if the evidence disagrees, the item is returned to the
  operator (a `repost`), an **alert** item is written and the item stays open.
- `defer` is refused, recorded and echoed when it is not in the future, is longer
  than `surface.defer_max_minutes`, is past `surface.defer_max_count` for the item's
  episode, or the item is not the one waiting for an answer. `dismiss` is refused
  for an owner block (only seed, issue, attention and gone items can be dismissed).
- Every `done`, `dismiss`, `defer` and refusal writes an **echo item**.

A line is **judged once**: the verdict (apply or refuse, and the reason) is a ledger
record under the line's hash, written before anything is done or echoed. A retry
after a crash or a failed echo carries out the recorded verdict and never judges
again with a later time, so the echo and the item cannot disagree.

Each line is acted on once ever: its disposition (`applied`, `refused`, `ignored`,
`rejected`, `receipt`) is a ledger record under the hash of the line, recorded
after the echo is written, so a tick cut short between the two finishes the line
on the next tick without applying it twice.

### Defaults (configurable; stored in the ledger's configuration record)

| Key | Default | Meaning |
|---|---|---|
| `surface.defer_max_minutes` | 1440 | the longest deferral accepted |
| `surface.defer_max_count` | 3 | deferrals one item may have in an episode |
| `exchange.max_file_bytes` | 1 MiB | an input file is read only this far |
| `exchange.max_line_bytes` | 1024 | a longer line is rejected unparsed |
| `exchange.max_new_lines_per_tick` | 200 | new lines taken from each input file per tick |
| `exchange.max_rejects_per_tick` | 20 | rejected lines recorded per input per tick |
| `exchange.text_field_max` | 240 | characters of any declared value in a text |
| `exchange.digest_max_items` | 12 | items listed in the digest |
| `exchange.max_echoes_per_item_per_tick` | 5 | lines about one item judged (and echoed) per tick; the rest wait for the next |
| `exchange.max_echoes_per_episode` | 50 | lines about one item judged in an episode; past it, one counted `input_limit` record and one echo stand for the rest, which are never judged |

A configuration stored before these keys existed gets the defaults.

### Input files are untrusted

Both input files are read with a size bound, a line bound and a per-tick count
bound, and only whole lines (ended by a newline). A line is parsed as one JSON
object with a fixed set of fields (version 1, 32-hex ids, a known intent, an
integer `until`); any other shape, extra field or wrong type is recorded as
`rejected` with a fixed reason (`not_json`, `shape`, `too_long`) and ignored, and
its content is never copied into the ledger. A malformed line cannot crash the
tick or close an item. A file that is not a regular file (a link, a directory) is
not read and the tick records `input_limit: unsafe`; a file over the size bound
is read to the bound and `input_limit: oversize` is recorded. A consumer should
rotate its files: the reconciler re-reads them from the start each tick, so a
file that only grows is read to the size bound and no further (the oversize
`input_limit` is recorded once per file, not once per tick). The open uses
`O_NOFOLLOW` and `O_NONBLOCK` where the platform has them and refuses anything
that is not a regular file after the open, so a link or FIFO swapped in after the
check is refused and never waited on.

### Not here

Delivery to any destination, and starting the exchange from the runner (a later
step). The consumer is whatever reads `outbox.jsonl` and writes the other two
files.

## Not in the core

Live sources other than the transcript readers above, and delivery of anything
(the queue and outbox are described above, #9284). The seed-handoff origin is not
derived: `seed_ref` is always null until a source that carries seed scope and
write time is added.
