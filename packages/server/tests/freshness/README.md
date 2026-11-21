# Session freshness model

An executable model of how a supervisor could keep an honest picture of
worker sessions from their status lines: how old each session's latest report
is, when an old "running" line is worth investigating, and how to bring one
item at a time to the owner's attention without repeating itself.

It exists to be tested, not to run. It lives under `tests/` so that it does
not ship in the published package.

**What it is.** Pure functions over an in-memory, append-only ledger. Time is
always an argument; there is no clock, no timer, no I/O, no randomness, no
dependency beyond `node:crypto`. All state is derived from the ledger records
alone.

**What it is not.** It reads no real source, parses no footer, holds no lease,
compacts nothing and is wired to nothing in the server. Every "read" is data
a test supplies, and every "send" is an effect description handed back to the
caller.

## Layout

| Path | Contents |
|---|---|
| `model/grade.js` | Freshness grading from report age |
| `model/hash.js`, `model/keys.js` | Canonical hashing; the key of every record kind |
| `model/ledger.js` | Append-only ledger with idempotent append |
| `model/derive.js` | The fold from records to derived state |
| `model/checks.js` | One read turned into report, activity and check records |
| `model/investigation.js` | The stale-investigation scheduler |
| `model/queue.js` | The single-slot owner queue and owner actions |
| `model/reconciler.js` | The tick, configuration records and the driver |
| `model/policy.js` | Every rule, in one injectable object (`DEFAULT_POLICY`) |
| `model/config.js` | Starting values and source capabilities |
| `helpers/world.js` | A simulated set of sources and sessions (ground truth) |
| `helpers/invariants.js` | The invariant monitor |
| `helpers/sequence.js` | The generated-sequence runner |
| `helpers/variants.js` | Mutants and literal-reading variants of rules |

## The rules the model encodes

### Reports, checks and freshness

- A **report** is the latest status line a session authored, timed by the
  host's record of when it was written. A **check** is one read of it by the
  reconciler, timed by the reconciler. A check never moves a report's time.
- Freshness is graded from `check time − report time` against per-state
  thresholds: `fresh` if the age is at most `fresh_max`, `stale` if it is above
  `stale_after`, `aging` in between (exactly `stale_after` is `aging`).
- A line with no status is `unknown`; a failed read is `error` with a code; a
  read the reconciler may not make is `blocked` with a reason. None of these is
  ever shown as another value.
- A declaration written by someone other than the session (an API or hook
  write) is recorded but never graded by age: it is `unknown` with the reason
  `relayed_declaration`.
- A report stamped later than the check by more than the skew limit, or a
  source clock off by more than the limit, makes the read `error: clock_skew`.
  A line whose time cannot be trusted writes no report record.
- On a source that stamps a declaration only when it changes, an identical
  repeat is not a new report, and that source's decisions are carried forward
  (`possibly_inherited`).

### Keys and the ledger (the key table)

Every record's `id` is its idempotency key, `H(...)` = sha256 over a
canonical encoding. Appending a record whose key exists with the same
payload is ignored; with a different payload it appends one
`idempotency_conflict` record and has no other effect.

| Record | Key |
|---|---|
| report | H(session, report time, fields hash) |
| tick | H(tick id, phase); tick id = H(ledger, source, slot start) |
| check by a tick | H(tick id, session) |
| check inside an investigation | H(investigation id, read number) |
| activity seen at a read | H(check id, basis, ref) |
| activity event | H(session, 'event', host event id), else H(session, basis, time) |
| investigation | H(investigation id, phase); id = H(session, report, trigger, onset, cycle), or per tick for a recheck |
| surface | H(item, episode, step, ordinal, phase) |
| owner_ack | H(item, episode, message id, phase) |
| config | H(previous config record, config hash) |
| system | H(event, ids) |

The surface ordinal by step: 0 for `queued`, `resolved` and `withdrawn`; the
presentation number for `shown`, `expired` and `preempted`; the presentation
number and content reference for `exhausted`; k (1 or 2) for `reminded`; 1
for `returned`; the message id for `deferred`; the changing report or prompt
id for `updated`.

A send is an **attempt** record, then the send, then an **outcome** record. An
attempt uses up its step whether or not the send is confirmed; an attempt with
no outcome is recorded `delivery_unknown` and never re-sent. A step re-run
after a crash reuses any read already recorded.

### Items and the single slot

Each item has one origin, which fixes its identity, the reference that opens
an episode and the only evidence that closes it:

| Origin | Opens on | Closed by |
|---|---|---|
| Declared block | an authored report that is an owner block | a newer authored report that is not one |
| Pending prompt | a prompt pending at a live read | an owner answer to the latest prompt; withdrawn as lapsed when nothing is pending and the session authored a newer report |
| Attention | an investigation that surfaces | a newer authored report; withdrawn if dismissed or superseded |
| Gone | an investigation that confirms the session left | the session listed again |
| Source outage | a source-level investigation | a successful check of the source |
| Seed handoff | a report that names a seed to paste | a different session in the seed's scope whose first report is later than the seed |

A report is an owner block if it is blocked or stalled and names the owner,
or states a decision, or is blocked or stalled and carries a decision that may
be inherited. A line naming a seed raises only the seed item.

An **episode** is one stretch of an item being open. A new episode opens only
when none is open and its opening reference was never used before.

Four counters are stored on every surface record: `presentation`,
`shows_counted`, `reminders_used`, `returns_used`. The transition table:

| State | Event | Step | Sends | Next |
|---|---|---|---|---|
| none | its origin raises it | queued | no | queued |
| queued | reaches the slot with a counted show left, or after the owner's deferral | shown | yes | active |
| queued | reaches the slot with no counted show left | exhausted | no | exhausted |
| active | reminder k (1 or 2) is due | reminded | yes | active |
| active | the time limit passed since the latest show | expired | no | queued, back of its class |
| active | an item whose deadline passes first should go ahead | preempted | no | queued, front of its class |
| active | the owner defers it | deferred | no | queued again at that time, uncounted |
| active | the owner says "done" | owner_ack | no | acknowledged |
| acknowledged | next tick, closing evidence | resolved | no | closed |
| acknowledged | next tick, none, no return used | returned | yes | active |
| acknowledged | next tick, none, return used | exhausted | no | exhausted |
| any open | closing evidence | resolved | no | closed |
| any open | dismissal, lapse or superseded | withdrawn | no | closed |
| any open | content changes | updated | no | same; from exhausted, queued if a counted show is left |

One item holds the slot at a time. Order: owner blocks with a deadline
(earliest first), other owner blocks (prompts first), outages, attention
items, seeds.

### Investigation

Five level triggers, evaluated at each tick check: `stale_report` (an old
`running`, `unknown`, `blocked` or `stalled` line, or a relayed declaration
older than the running threshold), `native_disagreement` (`idle` or `done`
while the host shows a turn in flight), `dropped_from_list`,
`repeated_error` (two errored checks in a row; one source-level investigation
when every session of a source fails) and `recheck`.

An **onset** is the check at which a trigger began to hold. Each onset gets at
most two cycles: the second only after `inconclusive` or
`running_claim_unverified`. A recheck follows `working_unreported`,
`waiting_on_background`, or a prompt-based `waiting_on_owner`; it never
counts against the cycles, and a recheck that finds nothing starts a new
onset. At most one investigation per session per tick. The cycle budget per
tick covers first cycles before second, oldest onset first; a recheck that
needs its own read draws on a separate budget.

Classifications and their effect: `working_unreported` and
`waiting_on_background` are rechecked (the second is surfaced once the report
is older than its limit); `waiting_on_owner` is carried by the owner's own
item; `blocked_unresolved` is surfaced after the first cycle; `inconclusive`
and `running_claim_unverified` are surfaced after the second; `gone` and
`source_unreachable` raise their own items; `finished_unreported` and
`no_longer_observed` raise nothing.

## Running

From `packages/server`:

```bash
node --import ./tests/_setup.mjs --test 'tests/freshness/*.test.js'
FRESHNESS_SOAK=1 node --import ./tests/_setup.mjs --test tests/freshness/generated.test.js
```

The default run uses fixed seeds and takes a few seconds. The soak runs
4,600 longer sequences and takes a few minutes.

## Reading a failure

A generated-sequence failure names the seed, the invariant id in brackets,
the shortest failing prefix found by truncating the sequence, and that
prefix's events, one per line. `runSequence(seed, { steps })` in
`helpers/sequence.js` replays it exactly; the returned `harness` holds the
ledger and the simulated world for inspection.

## Invariants

| Id | Holds |
|---|---|
| I1a | Counted shows never exceed the limit in force when each is made |
| I1b | At most two reminders per episode |
| I1c | At most one return per episode |
| I1d | Shows never exceed counted shows plus the owner's deferrals |
| I2 | At most one item active |
| I2b | An acknowledged item is moved on at the next tick of its source |
| I2c | The first show after a preemption is not the preempted item |
| I3a | The model never produces an `idempotency_conflict` |
| I3b | No attempt is ever sent twice, crashes included |
| I4a | Every open item closes when its origin's evidence is supplied |
| I4b | Every resolution and withdrawal is backed by its evidence |
| I4c | The model's open items equal the monitor's own account of the ledger |
| I5 | Never two open episodes of one item; never an episode on a used reference |
| I6 | An exhausted item sends nothing unless its content changed while a counted show remained |
| I7a | At most two cycles per onset, onsets derived by the monitor itself |
| I7b | At most one investigation per session per tick |
| I7c | Both budgets respected |
| I7d | Rechecks never take a cycle that a stale session needs |
| I7e | A held trigger gets its first cycle within a bound |
| I7f | A stale, unexplained report is surfaced within a bound |
| I7g | No session is rechecked as working while nothing is there |
| I7h | Every investigation that opens closes in the same tick |
| I8 | Freshness never improves for one report under one configuration |
| I8b | Graded freshness equals the monitor's own computation |
| I9 | A stale owner block is not surfaced a second time as an attention item |
| I10 | A pending prompt or an authored owner block always has an open item |

`mutations.test.js` proves each one can fail: it swaps one rule in the policy
object (or, for checks no rule reaches, injects a test-only fault) and asserts
that the named invariant goes red.

## DESIGN-GAP choices

The model was built from a set of rules that, in the places below, were
silent or contradicted each other. Each place is marked `DESIGN-GAP` in the
code with the smallest choice that let the model run. Choices marked (W) have
a test that shows the literal reading failing an invariant.

**grade.js.** A report later than the check but inside the skew limit has an
age of zero. The rule "freshness only gets worse" does not hold across the
skew limit: `error` later becomes `fresh`.

**keys.js.** The read number for the separate activity read. Event keys
include the session: a host that numbers events per session would otherwise
give two sessions the same key.

**checks.js.** A read's activity records are written before its check, which
is the read's commit point, so a crash cannot leave a partial observation.
Added fields the ledger alone needs: `listed`, `native_available`,
`source_now`, `remote_without_clock` on checks; the owner name and the seed
reference on reports; a prompt's raise time and deadline on activity.

**derive.js.** Where the relayed-declaration duration starts (the first check
of the current run); investigation re-reads do not count toward
`repeated_error`.

**reconciler.js.** Configuration records store the full values.

**investigation.js.** The source-level investigation uses the cycle budget.
An attention item raised by a recheck opens on the onset of the cycle that
led to it, so a dismissal holds. The investigation's undefined `remainder`
field is replaced by the decision it led to.

**queue.js.** The prompt origin is evaluated only at reads that carried
native state. A seed is unclosable by evidence when its naming session's
source gives no working directory; "done" then withdraws it. "Next tick" for
verification is the item's own source's next tick. Owner actions on an item
that is not active do nothing. The deferral time is stored on the record.

**policy.js.**
- An acknowledged item keeps the slot until it is verified. (W)
- Content changes are judged by fingerprint, not by any new report. (W)
- Content only moves forward in time, so `updated` keys never repeat. (W)
- The `exhausted` ordinal includes the content reference, so lowering the show
  limit mid-episode cannot repeat it.
- A recorded read is reused after a crash, never remade; only a record of the
  expected kind counts, so a key collision is recorded, not hidden. (W)
- A prompt answered between two ticks still resolves its item. (W)
- A prompt-based `waiting_on_owner` is rechecked. (W)
- A stale owner block is `waiting_on_owner`, not a second item. (W)
- Preemption: only for a showable challenger with an earlier deadline;
  deadline order wins inside the deadline class; and a preempted item waits
  behind its preemptor while that is still queued, even if the preemptor's
  deadline has passed meanwhile (a crash between the preemption and the
  show). (W)
- Reminders: at most one per tick, lowest due first; timing counts from the
  latest show or return; "next reminder" after both are used is the expiry.
- Trigger priority when several hold; "disagree" means `idle` or `done`
  with a turn in flight; a new report starts a new onset; overlapping
  classification rows are taken in a fixed order; absence of native evidence
  on a source without it counts as nothing shown.
- `finished_unreported` is never surfaced, because the model links no work;
  I7f exempts exactly those sessions.

**Open, not fixed.** An attention item is identified by session and report,
so one raised because a session's own reads keep failing and one raised
because its report went stale share one identity; the first absorbs the
second, and when the report is an owner block the read-failure item sits
beside the owner-block item.
