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
  source clock off by more than the limit, makes the read `error: clock_skew`;
  exactly the limit is not skew. A line whose time cannot be trusted writes no report record.
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
| check inside an investigation | H(investigation id, read number): 1 the re-read, 2 its retry, 3 the gone confirmation, 4 a separate activity read |
| activity seen at a read | H(check id, basis, ref) |
| activity event | H(session, 'event', host event id), else H(session, basis, time) |
| investigation | H(investigation id, phase); id = H(session, report, trigger, onset, cycle), or per tick for a recheck |
| surface | H(item, episode, step, ordinal, phase) |
| owner_ack | H(item, episode, message id, phase) |
| config | H(previous config record, config hash) |
| system | H(event, ids) |

The surface ordinal by step: 0 for `queued`, `resolved` and `withdrawn`; the
presentation number for `shown`, `expired` and `preempted`; the presentation
number and content reference for `exhausted`, followed by the latest
carried-condition change once the item has carried one; k (1 or 2) for
`reminded`; 1 for `returned`; the message id for `deferred`; for `updated`,
the changing report or prompt id, or for a carried-condition change
H('carried', change, attention item, opening reference).

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
| Attention | an investigation that surfaces | a newer authored report; withdrawn if dismissed, superseded or merged |
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
| any open | dismissal, lapse, superseded or merged | withdrawn | no | closed |
| any open | content changes (a new report or prompt, or a carried condition added or dropped) | updated | no | same; from exhausted, queued if a counted show is left |

Edges at exact equality: a reminder or the time limit is due at the very
moment its interval has passed since the latest show or return. A deadline
equal to the present has passed, so it does not preempt; a challenger
preempts only with a deadline strictly before the active item's next reminder
and strictly before the active item's own deadline, and an active item whose
deadline equals the present has none left. A report with the same time as the
opening report is not newer, and a session whose first report is at exactly
the seed's `written_at` is not later than the seed. An open-turn event exactly
`activity_window_minutes` old is still inside the window.

One item holds the slot at a time. Order: owner blocks with a deadline
(earliest first), other owner blocks (prompts first), outages, attention
items, seeds.

### One session, one item

An **owner-block item** is a declared block or a pending prompt. When a
session already has an open owner-block item, a second item of a different
kind about that session is merged into the open item and is not shown
separately. For attention items that works as follows.

- **Merged, not raised.** An investigation that surfaces a session with an
  open owner-block item raises no attention item. Its **condition** is
  recorded on the owner-block item by an `updated` step, and the item's
  content lists every condition it carries: the attention item it would have
  been (session and report), the reference that would have opened it, the
  trigger, and the time the condition began (the check at its onset). It is
  merged only where the attention item would have been raised: that item is
  not open, the opening reference was never used or carried before, and its
  closing evidence has not arrived. With both owner-block items open, the
  declared block takes it.
- **The `updated` row, nothing more.** The step sends nothing by itself.
  From `exhausted` it queues the item again only if a counted show is left,
  and every show after that uses one, so a condition that comes and goes
  cannot add a show beyond the limit.
- **Dropped when it ends.** A carried condition ends on the attention item's
  own closing evidence: a newer authored report than its report, or the
  session confirmed gone (superseded). Another `updated` step then drops it
  from the content, so the item names only what still holds. This is checked
  at every tick of the session's source and just before the owner-block item
  closes.
- **Handed on when the item closes.** If the owner-block item closes while a
  condition still holds, the same tick merges the condition into the
  session's other open owner-block item, or else raises its own attention
  item, opened by the reference that would have opened it, exactly as for a
  session with no open item.
- **The reverse order.** An attention item already open when its session
  gets an owner-block item is withdrawn, reason `merged`, after its condition
  is carried on the owner-block item. If that condition is later handed back,
  the attention item opens a new episode under a reference derived from its
  used one and the owner-block episode that carried it.

The rule covers attention items. A `gone` item, a source outage item, a seed
item, or a pending prompt beside a declared block can still be open for the
same session as an owner-block item.

### Evidence classes

Each report and activity record names the class of its evidence: **E1**
native-observed (busy state, prompts and events the host itself records,
timed by the host); **E2** authored and host-timed (a status line the
session wrote, timed by the host's record); **E5** relayed (written by
someone other than the session, such as an API or hook write). E2 is the
only class graded by age; E5 decides no state.

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

An investigation runs **rungs**, recorded by name in its close record:
`re_read` (the same adapter read once more, and one retry if it failed),
`confirm_gone` (a read confirming a dropped session is really gone),
`activity_read` (native activity: from the tick's own read where the source
carries it, else a separate read) and `classify`. A recheck runs only
`activity_read` and `classify`.

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
4,000 sequences of the default length and 600 of 600 steps, and takes a few
minutes.

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
| I7i | An investigation is opened only for a trigger the monitor also sees holding |
| I8 | Freshness never improves for one report under one configuration |
| I8b | Graded freshness equals the monitor's own computation |
| I9 | A session with an open owner-block item never also has an open attention item, whatever its trigger |
| I10 | By the end of each tick, the latest prompt pending at a live read has an open prompt item, and an authored owner-block report has an open owner-block item, unless that item already used the same opening reference |
| I11 | A surfaced condition is never lost: until its attention item's closing evidence (or a dismissal), its session has that attention item open or an open owner-block item whose content names it; and no owner-block item names a condition that has ended |

**Limits of the monitor.** It uses the model's own `isOwnerBlock` (for
declared resolutions in I4b, and in I10) and the model-computed
`block_fingerprint` (I6), so a defect in the default owner-block rule or in
the fingerprint is invisible to those checks. For the source-level outage
investigation, I7a uses the model's onset. I11 starts a condition at an
investigation's decision to surface, as the investigation's close record
states it; whether that decision comes in time is I7f's to check against the
world. Everything else I11 uses (which items are open, what each owner-block
item's content names, the closing evidence) is the monitor's own account.

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

**queue.js.** An item that expires with no counted show left goes to the
back of its class like any other, and is exhausted only when it next reaches
the slot, not at the time limit itself. The prompt origin is evaluated only
at reads that carried native state. A seed is unclosable by evidence when its naming session's
source gives no working directory; "done" then withdraws it. "Next tick" for
verification is the item's own source's next tick. Owner actions on an item
that is not active do nothing. The deferral time is stored on the record.
A carried condition whose closing evidence arrives while its owner-block
item is open is dropped from the content by another `updated` step, not
kept. An attention item withdrawn as merged has used its opening reference,
so when its condition is handed back it opens under a reference derived from
that one and the carrying owner-block episode. A handover belongs to the
tick that closed the owner-block item, and a crash re-runs it there. A
condition's trigger, for one surfaced by a recheck, is the trigger of the
cycle that led to the recheck. A reference that was carried and then
dropped is spent: it is neither merged nor raised again. Added fields: the
carried-condition change (`carry`) and the list carried (`carried`) on
`updated`, the condition (`condition`) and the handover (`handover_of`) on an
attention item's `queued`.

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
- A stale owner block is `waiting_on_owner`, so its own item does not carry
  a stale condition about the wait it already shows.
- Both owner-block items open: a condition is merged into the declared
  block. The reverse order (an attention item already open when its session
  gets an owner-block item) is merged too. (W)
- The `exhausted` ordinal also names the latest carried-condition change, so
  an item exhausted, queued again by a carried condition and exhausted at the
  same presentation never repeats its key.
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
