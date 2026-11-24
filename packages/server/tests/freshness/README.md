# Session freshness model

An executable model of how a supervisor could keep an honest picture of
worker sessions from their status lines: how old each session's latest report
is, when an old "running" line is worth investigating, and how to bring one
item at a time to the owner's attention without repeating itself.

It exists to be tested. What ships is exactly the eight modules moved to
`src/freshness/` (hashing, keys, grading, configuration, the ledger, one read
turned into records, the derived state and the policy) and the driver
(`runtime.js`); the files of the same name under `model/` re-export them, so the
model tests and the reconciler core run one implementation. That includes all of
`derive.js` and `policy.js`, which also carry the owner-block, surface and
investigation rules and the fold of their records. The reconciler core does not
run those rules; they ship as data and functions only. What stays under `tests/`
and does not ship: the stale-investigation scheduler (`investigation.js`), the
owner queue (`queue.js`), the model's tick planner and owner actions
(`reconciler.js`), and the helpers. See `docs/guides/freshness-reconciler.md`.

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
| `model/{hash,keys,grade,config,ledger,checks,derive,policy}.js` | Re-exports of `src/freshness/` (the shared implementation) |
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
  exactly the limit is not skew. Its outcome is `error` whatever the read
  found, a status line or none, so it counts toward `repeated_error` and a
  source-level outage like any errored check; it writes no report record and
  no native state is taken from it. A line whose time cannot be trusted
  writes no report record.
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
| investigation | H(investigation id, phase); id = H(session, report, trigger, onset, cycle), or per tick for a recheck; H(that id, 'after_abandoned') once for each earlier investigation of that id closed as abandoned |
| surface | H(item, episode, step, ordinal, phase) |
| owner_ack | H(item, episode, message id, phase) |
| config | H(previous config record, config hash) |
| system | H(event, ids) |

The surface ordinal by step: 0 for `queued`, `resolved` and `withdrawn`; the
presentation number for `shown`, `expired` and `preempted`; the presentation
number and content reference for `exhausted`, followed by the latest
carried-condition change once the item has carried one; k (1 or 2) for
`reminded`; 1 for `returned`; the message id for `deferred`; for `updated`,
H('ask', change, kind, the ask's opening reference, and for new content the
changing report or prompt id) for a change to an owner item's asks, or
H('carried', change, attention item, opening reference) for a carried
condition. An ask's opening reference is its report or prompt id, except for
a prompt ask added again for the prompt an earlier prompt ask opened on,
which opens on H('prompt_again', prompt id, the opening reference of the
prompt ask that last ended, its ending evidence) (see "Items and the single
slot").

A send is an **attempt** record, then the send, then an **outcome** record. An
attempt uses up its step whether or not the send is confirmed; an attempt with
no outcome is recorded `delivery_unknown` and never re-sent. A step re-run
after a crash reuses any read already recorded. The verification of an
acknowledgment (`owner_ack`, phase `verify`) is written once, by whichever
step comes first, and is never rewritten with another result.

### Items and the single slot

Each item has one origin, which fixes its identity, the reference that opens
an episode and the only evidence that closes it:

| Origin | Opens on | Closed by |
|---|---|---|
| Owner item | its first ask (below) | its last ask's own evidence |
| Attention | an investigation that surfaces | a newer authored report; withdrawn if dismissed, superseded or merged |
| Gone | an investigation that confirms the session left | the session listed again |
| Source outage | a source-level investigation | a successful check of the source |
| Seed handoff | a report that names a seed to paste | a different session in the seed's scope whose first report is later than the seed |

A session has one **owner item**, whose content lists each **ask** that is
live:

| Ask | Arrives on | Ends on |
|---|---|---|
| Declared block | an authored report that is an owner block | a newer authored report that is not one |
| Pending prompt | a prompt pending at a live read | an owner answer to its latest prompt; lapsed when nothing is pending and the session authored a newer report |

A report is an owner block if it is blocked or stalled and names the owner,
or states a decision, or is blocked or stalled and carries a decision that may
be inherited. A line naming a seed raises only the seed item.

An **episode** is one stretch of an item being open. A new episode opens only
when none is open and its opening reference was never used before. On an
owner item every reference an ask stood on is used: its opening reference,
whether it opened the episode or joined it, and, for a declared block, every
authored owner-block report of its session that it covered while it was live,
whatever its fingerprint (a reworded line, the same block with another next
step, an identical line re-authored). No ask is added, opening an episode or
joining one, on a used reference, so a session rewound to a line a declared
ask already covered never brings that ask back.

The two kinds differ on purpose. For a prompt ask only its opening reference
is used, not the prompts its content moved through. Whenever a read that
carried native state shows a prompt pending and the owner item has no live
prompt ask, a prompt ask is added for the latest pending prompt, opening a
new episode if the item is closed or joining it if a declared ask kept it
open. A prompt the ended ask's content moved away from is added on its own
id. The prompt the ended ask opened on is a used reference, yet it too can
still be pending, unanswered, when the ask ends (its content moved to a newer
prompt and that one was answered); it is added under a reference derived from
the prompt and from the prompt ask that last ended:
H('prompt_again', prompt, that ask's opening reference, its ending evidence).
That reference is new (each ask ends once) and the same on a replay, and a
second such addition (the prompt still pending after a third prompt was
raised and answered) gets another. A prompt ask is added only for a prompt
pending at a live read and only while no prompt ask of the item is live, and
the added ask stays until an owner answer ends it, so a prompt is added again
at most once per ending of a prompt ask, never tick after tick. Here keeping
every pending prompt in front of the owner comes before never asking twice.
Declared asks have no such rule: a declared ask never comes back on a line it
covered.

Five counters are stored on every surface record: `presentation`,
`shows_counted`, `reminders_used`, `returns_used`, and `round_shows` (the
shows prompt rounds earned after an owner item's limit was used). The transition table:

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
| any open | content changes (a new report or prompt within a live ask, or a carried condition added or dropped) | updated | no | same; from exhausted, queued if a counted show is left |
| owner, open | an ask joins | updated | no | see "The owner item"; a counted show, a round's show, or none is owed |
| owner, active or acknowledged | an ask joined with a counted show left | shown | yes | active |
| owner, open | a prompt round joined with no counted show left, the slot held by it or free | shown, once | yes | unchanged |
| owner, open | an ask ends while another is live | updated | no | same |
| owner, open | its last ask ends | resolved, or withdrawn for a lapse | no | closed |

A crash after the verification is written and before its step leaves the
item acknowledged. If the next tick runs in a later slot, the recorded
verification stands and is not written again, and the item follows the
evidence that tick finds: closing evidence resolves it by the "any open,
closing evidence" row; none completes the failed-verification step
(`returned` or `exhausted`), sent at most once as any send. Until then it
holds the slot as acknowledged. A recorded verification is the answer the
first tick found and is not rewritten; a later tick may find the other
answer. So in one case the ledger holds a "verified" record followed by a
return: the tick that found closing evidence wrote "verified" and was killed
before `resolved`, the session then authored a new owner block, and the next
tick, finding no closing evidence, returned the item "not yet confirmed",
as it would have with no crash had the block cleared and come back between
two ticks. The alternative not chosen is to resolve the item from the
recorded verification and let the new block open a new episode.

Edges at exact equality: a reminder or the time limit is due at the very
moment its interval has passed since the latest show or return. A deadline
equal to the present has passed, so it does not preempt; a challenger
preempts only with a deadline strictly before the active item's next reminder
and strictly before the active item's own deadline, and an active item whose
deadline equals the present has none left. A report with the same time as the
opening report is not newer, and a session whose first report is at exactly
the seed's `written_at` is not later than the seed. An open-turn event exactly
`activity_window_minutes` old is still inside the window.

One item holds the slot at a time. Order: owner items with a deadline
(earliest first), other owner items (those with a live prompt ask first),
outages, attention items, seeds.

### The owner item

A declared block that names the owner and a pending prompt on one session
are one item, not two: a session has at most one open owner item, and its
content lists each ask that is live, the declared block, the pending prompt,
or both.

- **Asks come and go on their own evidence.** Each ask ends by its own
  rule: the declared block by a newer authored report that is not an owner
  block, the prompt by an owner answer (to its latest prompt, or to any
  later one when nothing is pending) or by lapsing. An ask that ends while
  another is still live is removed from the content by an `updated` step
  and sends nothing. When the last ask ends the item closes with that ask's
  step: `resolved` for a declared block or an answered prompt, `withdrawn`
  (reason `lapsed`) for a lapsed prompt. A newer prompt replacing the latest
  prompt within a live prompt ask is new content, not a new ask: the
  existing in-place `updated`, which sends nothing. Prompt asks are read only
  at reads that carry native state, so a source without it never has one.
- **A new ask is a reason to show the item again.** An ask of the other kind
  joining an open item (a prompt joining a declared block, a declared block
  joining a prompt, or a prompt arriving again while the declared block keeps
  the item open) is owed a show. While the item has a counted show left it
  is a counted one from the item's own limit. Once they are used, a prompt
  joining (a prompt round) is still owed one round's show, and a declared
  block joining is owed none. What that means depends on the item's state:

  | State when the ask joins | With a counted show left | None left: a prompt round | None left: a declared block |
  |---|---|---|---|
  | active (holding the slot) | shown again at once | shown once, at once; still holding the slot | content only |
  | acknowledged, awaiting its verification tick | shown again at once; the acknowledgment applied to the earlier content and is not verified | shown once, at once; still acknowledged, verified at its tick as usual | content only; verified at the tick as usual |
  | queued behind another item, preempted, or back from expiry | keeps its place; its next show is counted | shown once when the slot is free, in its own place; then exhausted at the slot | content only |
  | deferred by the owner | queued again: the deferral was about the earlier content | shown once when the slot is free; the deferral stands | content only; the deferral stands |
  | exhausted | queued again | shown once when the slot is free; stays exhausted and listed | content only; stays exhausted and listed |

  A new-ask counted show is an ordinary counted `shown`: reminders and the
  time limit count from it, and the reminders already used stay used. A
  round's show is described next. A new ask gains no right to preempt; only
  the deadline rule below can move it ahead.
- **The more urgent class.** The item sorts by its live asks: in the
  deadline class if an ask has a deadline (only a prompt ask has one), by
  the earliest deadline; otherwise among owner items, with a live prompt ask
  first and then by its earliest ask. Preemption follows the existing rule:
  a queued owner item preempts only with a deadline earlier than the active
  item's, and only if it can be shown.
- **One send history per episode.** However its asks come and go, an
  episode gets at most the show limit in counted shows, plus one show for
  each prompt round that joined after the limit was used (below), two
  reminders and one return; owner deferrals keep their meaning (an
  uncounted show when the deferral ends).
- **Each prompt round after the limit earns one show.** Once the item has
  used its counted shows, a prompt round, that is a prompt ask joining the
  item (the first prompt on an item a declared block opened, or a prompt
  pending after the earlier prompt ask ended, including the prompt that
  ask opened on), is shown once anyway. A newer
  prompt replacing the latest within a live prompt ask is no new round. The
  show restores nothing: it is kept in its own counter (`round_shows`), not
  in `shows_counted`, so every rule that reads the limit is unchanged; it
  moves neither the reminder nor the time-limit clock, so no reminder,
  return or expiry follows from it that the item would not have had (a
  reminder still unused falls due when it would have anyway); and it takes
  no slot, so an item that held the slot keeps holding it and any other
  keeps its state (the table above, third column). It is made only by the
  item holding the slot or while the slot is free: a round owed to an item
  that does not hold it waits, however many ticks, while another item holds
  the slot, and is shown at the first tick that finds the slot free. Rounds
  owed to items that are not queued are shown before the queue is ordered
  for the slot, so they never stand in the way of the queue's own order. If
  the round's prompt ask ends first (answered or lapsed), the owed show is
  dropped: the round it was for is over. An ordinary show made meanwhile
  (the owner's deferral coming due; a queued item with a counted show again
  after the limit was raised) serves the round too. The round gains no right
  to preempt: an item with no counted show left preempts nothing.
- **Prompts, not declared blocks.** A declared ask joining an item whose
  counted shows are used only changes the content, as before. A prompt is a
  question the session cannot go on without and the owner must answer each
  one; a declared block that comes back is the same wait the owner has
  already been shown.
- **What that gives over many rounds.** A session that raises and resolves
  prompts all day while blocked on the owner is shown once per round. At the
  starting values, a block authored once and five prompts each raised and
  answered over the next two and a half hours give the shows 1 to 6 (the
  block, the first two prompts on the counted shows, the last three as
  rounds) and reminder 1, 60 minutes after the last counted show, in the
  same tick as the fourth prompt's show.

### Attention beside the owner item

When a session already has an open owner item, an attention item about that
session is merged into it and is not shown separately.

- **Merged, not raised.** An investigation that surfaces a session with an
  open owner item raises no attention item. Its **condition** is recorded on
  the owner item by an `updated` step, and the item's content lists every
  condition it carries: the attention item it would have been (session and
  report), the reference that would have opened it, the trigger, and the time
  the condition began (the check at its onset). It is merged only where the
  attention item would have been raised: that item is not open, the opening
  reference was never used or carried before, and its closing evidence has
  not arrived.
- **The `updated` row, nothing more.** The step sends nothing by itself.
  From `exhausted` it queues the item again only if a counted show is left,
  and every show after that uses one, so a condition that comes and goes
  cannot add a show beyond the limit.
- **Dropped when it ends.** A carried condition ends on the attention item's
  own closing evidence: a newer authored report than its report, or the
  session confirmed gone (superseded). Another `updated` step then drops it
  from the content, so the item names only what still holds. This is checked
  at every tick of the session's source and just before the owner item
  closes. Asks ending do not end a condition: a condition carried while both
  asks are live outlives the prompt ask, and the declared block's own ending
  (a newer authored report) ends a condition about an earlier report too.
- **Handed back when the item closes.** If the owner item closes while a
  condition still holds, the same tick raises the condition's own attention
  item, opened by the reference that would have opened it, exactly as for a
  session with no open item. (If an ask opened the item's next episode in the
  same tick, the condition is carried on into it instead.)
- **One send history per condition.** A condition keeps the reference that
  first opened it (its root) through every merge and handover. When it is
  handed back to its attention item, the new episode starts with the
  counters its previous episode ended with: the presentation number,
  counted shows, reminders and returns. However many owner-item cycles it
  outlives, one condition gets at most the show limit in counted shows, two
  reminders and one return; once its shows are used, a handover leaves it
  exhausted and listed, not shown. A condition first raised by a handover
  (merged before it was ever shown) starts from zero.
- **The reverse order.** An attention item already open when its session
  gets an owner item is withdrawn, reason `merged`, after its condition is
  carried on the owner item. If that condition is later handed back, the
  attention item opens a new episode under a reference derived from its used
  one and the owner episode that carried it.

The rule covers attention items. A `gone` item, a source outage item or a
seed item can still be open for the same session as its owner item.

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
`activity_read` (native activity: where the source's read carries it, from
the latest successful read of the cycle, the re-read or, if the re-read
failed, its retry, and from the tick's own read only when neither
succeeded; else a separate read) and `classify`. A recheck runs only
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

The default run uses fixed seeds and takes a few seconds. A crashed tick is
replayed in its own slot, or, for some crashes (chosen from a separate
random stream, so a seed's events are unchanged up to its first such
restart), the process comes back only after the slot has passed and the
source's next tick, in a later slot, runs instead; until it has, only the
checks that hold mid-tick are made, and a run that ends with such a source
waiting ticks it once more and then makes every check. So a breach of the
checks made only at a complete step (I2, I4c, I7h, I9, I11) that appears and
heals entirely inside such a waiting window is not seen. The soak runs
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
| I1a | Counted shows never exceed the limit in force when each is made; beyond it, an owner item is shown only once for each prompt round that joined after the limit was used, as the monitor counts the rounds itself |
| I1b | At most two reminders per episode |
| I1c | At most one return per episode |
| I1d | Shows never exceed counted shows plus the owner's deferrals plus the rounds' shows; and the counters every record stores (presentation, counted shows, round shows, reminders, returns) equal the values on the episode's opening record plus the monitor's own counts since; a wrong value on the opening record itself is not seen here |
| I2 | At most one item active; the item holding the slot in the model is the one the ledger account says holds it (a round's show takes no slot); and a round's show is made only by the item holding the slot or while it is free |
| I2b | An acknowledged item is moved on at the next tick of its source |
| I2c | The first show after a preemption is not the preempted item |
| I3a | The model never produces an `idempotency_conflict` |
| I3b | No attempt is ever sent twice, crashes included |
| I4a | Every open item closes when its origin's evidence is supplied |
| I4b | Every resolution and withdrawal is backed by its evidence |
| I4c | The model's open items equal the monitor's own account of the ledger |
| I5 | Never two open episodes of one item; never an episode opened, or an ask added, on a used reference, including any owner-block report a declared ask covered, as the monitor itself follows it; and a prompt ask added for a prompt an earlier ask of the item opened on is added only while that prompt is pending at the session's latest live read, and at most once after each ending of a prompt ask of the item, with no prompt ask added in between |
| I6 | An exhausted item sends nothing unless its content changed while a counted show remained, or a prompt round is owed its show |
| I7a | At most two cycles per onset, onsets derived by the monitor itself; an investigation closed as abandoned is no cycle, and each per-session cycle opens under the number the monitor's own count of its onset's cycles gives |
| I7b | At most one investigation per session per tick |
| I7c | Both budgets respected |
| I7d | Rechecks never take a cycle that a stale session needs |
| I7e | A held trigger gets its first cycle within a bound |
| I7f | A stale, unexplained report is surfaced within a bound |
| I7g | No session is rechecked as working while nothing is there |
| I7h | Every investigation that opens closes in the same tick, or, when that tick was killed and never replayed, is closed as abandoned by a later tick of its source, deciding nothing; an investigation is closed as abandoned only then |
| I7i | An investigation is opened only for a trigger the monitor also sees holding |
| I8 | Freshness never improves for one report under one configuration |
| I8b | Graded freshness equals the monitor's own computation, a source clock off by more than the limit giving `error` on any read the adapter answered (a read with no status line included); and a read so graded has outcome `error`, no report and no native state |
| I9 | A session never has two open owner items, and never an open attention item beside its open owner item, whatever its trigger |
| I10 | By the end of each tick every live ask, as the monitor sees it, is an ask on the session's open owner item: the latest prompt pending at a live read always, whatever ask stood on it before; an authored owner-block report unless a declared ask that stood on that line already ended; an owner item closes only with its last ask, carries no declared ask that a newer report ended, and lists the asks its own changes add up to |
| I11 | A surfaced condition is never lost: until its attention item's closing evidence (or a dismissal), its session has that attention item open or an open owner item whose content names it; no owner item names a condition that has ended; and the list each carried-condition record states equals the changes so far |
| I12 | One condition, across every attention episode it opens, gets at most the show limit in counted shows, two reminders and one return |
| I13 | An ask joining an open owner item with a counted show left is shown by the end of that tick (at once if the item held the slot, else queued behind the item that holds it); with none left, a prompt round is owed one show until it is made, its prompt ask ends, or an ordinary show serves it, and at every tick's end an item still owed one is waiting behind another item that holds the slot; a declared ask is shown nothing and leaves an exhausted item exhausted |

**Limits of the monitor.** It uses the model's own `isOwnerBlock` (for
declared asks in I4b and I10) and the model-computed
`block_fingerprint` (I6), so a defect in the default owner-block rule or in
the fingerprint is invisible to those checks. For the source-level outage
investigation, I7a uses the model's onset. I11 starts a condition at an
investigation's decision to surface, as the investigation's close record
states it; whether that decision comes in time is I7f's to check against the
world. Everything else I11 and I12 use (which items are open, what each
owner item carries, the closing evidence, the sends) is the monitor's
own account: it folds each carried-condition change itself and checks the
list the record states against that fold. One link is not: the monitor ties a
handed-back episode to the condition's earlier episodes through the record's
own `handover_of` (and a carry's `from`). A model that both gave a handed-back
episode fresh counters and left that link out would not be caught by I12.
Which asks are live is the monitor's own account, from the reports, prompts
and answers it reads; the moment an ask joins, which I13 then checks, is the
model's own join record, and I10 is what makes sure a live ask is never left
off the item instead. Which shows are a prompt round's is the monitor's own
count: a round is a prompt ask joining while its own count of counted shows
is at the limit, and a show made while it owes such a round its show is the
round's; it never takes the model's `round_shows` or `round` marks as input,
though I1d compares the stored `round_shows` with its own count. It does
take each owner deferral's time from the model's own `deferred` record
(`until`), because no other record carries the time the owner asked for. A
model that acted on another time than it recorded would go unseen while no
round is owed (the monitor does not time ordinary deferral shows); with a
round owed, the two accounts would disagree on whether a show was the
round's, which shows as I1d (the stored round count) on that record, or as
I2 (the slot holder) at the end of the step.

An investigation's `abandoned` close is the model's own label: the monitor
checks that the tick that opened it never closed, that a later tick of the
same source closed it and that it surfaced nothing, and then counts it as no
cycle; it does not check that the model closes every such investigation at
the first chance, only that none is left open at the end of a step that
leaves no crashed tick waiting for its source's next tick.

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

**investigation.js.** A tick killed by a crash is replayed only in its own
slot. When the process comes back after the slot has passed, the source's
next tick closes each investigation the crashed tick left open as
`abandoned` (no rungs, no decision, no cycle), and the next investigation
of that onset and cycle takes a derived id, so no open record repeats a key;
the signals of the investigations the crashed tick did close are applied by
that next tick, unless the item's closing evidence has arrived since, until
a later tick of the source closes. The source-level investigation uses the cycle budget.
An attention item raised by a recheck opens on the onset of the cycle that
led to it, so a dismissal holds. The investigation's undefined `remainder`
field is replaced by the decision it led to.

**queue.js.** An item that expires with no counted show left goes to the
back of its class like any other, and is exhausted only when it next reaches
the slot, not at the time limit itself. Prompt asks are evaluated only at
reads that carried native state. The owner item: what a new ask does in
each state of the item (the table above); an ask ending while another is
live does not queue an exhausted item again (there is less for the owner to
do, not more); in one tick, asks that end are taken before asks that arrive,
so an item whose last ask ends closes and a new ask opens a new episode;
every owner record carries the live asks (`asks`), its ask change (`ask`),
the ask that closed it (`closing_ask`), and on a join whether a show is owed
at once (`show_now`), as counted (`counted_next`), or to a prompt round
(`round_owed`); a round's show is marked `round`. A seed is unclosable by evidence when its naming session's
source gives no working directory; "done" then withdraws it. "Next tick" for
verification is the item's own source's next tick. A verification is written
once and looked up before it is written, so a crash between it and its step,
followed by a tick in a later slot that finds the other answer, does not
rewrite it; that tick follows the evidence it finds (resolved, or the
failed-verification step) without a second verification record. Owner actions on an item
that is not active do nothing. The deferral time is stored on the record.
A carried condition whose closing evidence arrives while its owner item is
open is dropped from the content by another `updated` step, not kept. An
attention item withdrawn as merged has used its opening reference, so when
its condition is handed back it opens under a reference derived from that
one and the carrying owner episode. A handover belongs to the tick that
closed the owner item, and a crash re-runs it there. A
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
  a stale condition about the wait it already shows; but only while the
  owner item carries a live declared ask. A session rewound to an
  owner-block line whose ask already ended has no ask carrying it, so it is
  classified, and rechecked, as any other stale line.
- A declared block and a pending prompt are one owner item. (W)
- A prompt round's show after the limit is kept in its own counter,
  `round_shows`, so no rule that reads `shows_counted` changes; it takes no
  slot and moves no clock; in each state of the item it is made as the
  table under "The owner item" says; rounds owed to items that are not
  queued are shown before the queue is ordered, so they cannot hide a
  still-queued preemptor from the preemptor-first rule; and a show owed to a
  round is dropped when the round's prompt ask ends before it is made. (W)
- An ask is added to an owner item, opening its episode or joining it, only
  on a reference no earlier ask of that item stood on in any episode: its
  opening reference and, for a declared block, every authored owner-block
  report it covered while live, whatever the fingerprint. The covered
  reports are derived in the fold from the tick checks already in the
  ledger, so no record is written for them. A prompt the content moved away
  from stays free, because it may still be pending when the ask ends.
- The prompt an ended prompt ask opened on, still pending, is added again
  under a reference derived from it and from the prompt ask that last ended
  (its opening reference and ending evidence), so it is never left without
  an item, no key repeats, and it is added again at most once per ending of
  a prompt ask.
- A two-ask item's natural order is the earliest of its live asks.
- The reverse order (an attention item already open when its session gets
  an owner item) is merged too. (W)
- A condition's counters continue across the attention episodes it opens.
  Reminders and the time limit still count from the episode's own latest
  show or return: the previous show came before the merge and is no anchor
  for a show not yet made. An owner deferral pending when a condition is
  merged does not survive the merge. (W)
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
