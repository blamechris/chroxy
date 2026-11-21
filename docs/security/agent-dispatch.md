# Agent Dispatch — Threat Model and Authority Design

A coordinator agent that runs a backlog needs to put one task in front of one worker
session and then know, without reading prose, whether the task landed and whether work
began. Today it can only type into a session and infer the rest from status text.
**Dispatch** is the daemon-side contract for that step: an agent principal asks the daemon
to deliver one task to one worker session; the daemon reserves it in a **durable record**,
builds and delivers the wake text itself, and records an **acknowledgment** and an
**observed start** as facts with an owner. It runs on the agent-principal class and the
same WebSocket router; there is no new control plane. This document is the design gate
for the dispatch part of the durable task record of #7823, like
[`agent-principals.md`](agent-principals.md) (#9113) and
[`discord-return-path.md`](discord-return-path.md) (#7166): it pins the trust boundary, the
identity, the roles, the ledger and the audit **before any code**, so the slices of §12
implement one contract instead of negotiating it in review.

**Status: designed, not yet implemented.** No dispatch mechanism exists in code. Where this
document says a mechanism exists on main it names the symbol and file, read at commit
`7442b39ff`; everything else is *proposed*. The amended acknowledgment-channel text (in §6.6
and §6.7, and the entries that cite them) was read at `2373ec835` and rests on the spike
described in §6.7; everything else remains as read at `7442b39ff`. Where it depends on a
mechanism that [`agent-principals.md`](agent-principals.md) itself marks proposed
(`auditOrRefuse`, leases, the delivery fence, `turn_started`), it depends on that child
landing and adds nothing to it.
This document **extends agent-principals by reference and never loosens it**: every gate,
refusal and invariant there applies to every message here; the few places it proposes an
amendment to P say so. Every guard must be proven to fail
([`../false-safety-guards.md`](../false-safety-guards.md)); agent-principals §4.4 states the
common test rules, and each guard below names its test, mutation and positive control.

Conventions: "P §n" is a section of [`agent-principals.md`](agent-principals.md); S-numbers
are the children of #9112 listed in P §12; D-numbers (D1 to D8; D4 has parts D4a and D4b)
are this document's slices (§12.4). "Owner" and "operator" denote the same person, as in
agent-principals. Companions: P, [`bearer-token-authority.md`](bearer-token-authority.md),
[`permission-floor.md`](permission-floor.md), [`discord-return-path.md`](discord-return-path.md)
and [`../guides/declared-session-status.md`](../guides/declared-session-status.md).

Related issues: #7823 owns the task record (task id, attempts, handoff envelope); it builds
on #7821 (explicit agent connection mapping) and #7822 (typed context with correlated,
duplicate-safe delivery) and coordinates with #6743 and #7827. #6691 owns orchestration;
#7437 owns mailbox delivery. This document closes none of them.

## 1. Trust Model in One Sentence

> A coordinator agent that the operator has named **coordinator of record** for a
> repository may ask the daemon to put one task in front of one worker session it already
> holds a drive lease on; the daemon admits the request only in **one synchronous, durably
> recorded step**, builds the wake text itself, delivers it through the agent-principal
> input contract, and records acceptance, a session-bound acknowledgment and a work start
> as **observed facts**. No coordinator may approve a host action, widen a permission,
> extend a deadline, start a second worker on a timeout, or resolve an uncertain dispatch
> by belief. The ceiling is enforced by the daemon, not by the coordinator or its client.

Three asymmetries control the design:

1. **A dispatch is advice plus a record.** The wake text is advice to a worker, framed and
   fenced exactly as P §6.3 and §6.4 frame principal input. Neither the text, the
   acknowledgment nor any event authorizes a host action.
2. **One delivery, one send; only the operator gives up on an uncertain one.** Evidence may
   move an uncertain delivery toward "delivered" (§6.8); only the operator may close or
   supersede it, accepting that the old send may still have started a worker. A delivery the
   daemon *knows* was never sent is dropped (§6.5). No timeout ever starts a second worker.
3. **A human always wins** (P §1, §5.3). A dispatch never pre-empts human input, never
   takes the primary role and never writes to the human's queue.

## 2. Trust Boundaries and Honest Limits

```
[operator] ──primary, loopback──▶ [daemon] ◀──principal token, loopback── [coordinator]
                                   │   ▲  └──read-only──▶ [GitHub]              ▲
              wake text (input     │   │ ACK part 2 (own channel, §6.7)         │ hint only:
              contract, §6.5)      ▼   │                                        │ id, code, ref
                               [worker session]                  [notification channel]
```

| Zone | Trust | Holds |
|---|---|---|
| Coordinator agent | **Untrusted for content, semi-trusted for identity**, as P §2. Its identity is the principal grant and the coordinator-of-record record, never its label in text. | one principal token |
| Worker session | **Untrusted for content.** Its output, declarations and anything it sends are data. Its identity is assigned by the daemon (the session the daemon spawned), never asserted by the caller. | on claude-sdk, nothing: its acknowledgment tool is bound to it by the daemon (§6.7); on the deferred hook-secret route, its own per-session secret |
| Reviewer | A separate identity from the worker and the coordinator. A review record is evidence, never authority. | no channel in v1 |
| Notification channel | **Untrusted, outbound only** (§8). | nothing of chroxy's beyond the hint |
| GitHub | A data source read with the read time recorded. Issue state and labels are trusted only as of that read; titles, bodies and comments are untrusted text. | — |
| Daemon host | Trusted ([`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries)). | everything |

**The same-user limit applies unchanged** (P §2). Dispatch adds attribution, guardrails and
a durable record for a cooperative but fallible agent; it is **not a sandbox** against a
hostile local process. On claude-sdk anything that can steer the session's agent loop can
make its acknowledgment call; on the deferred hook-secret route anything in the worker's
process tree can present the worker's per-session secret (§6.7).

**Untrusted content.** Issue text, comments, worker output, review text and channel input
are data, never wake text, an instruction, a verdict or an authority. **No broker, no
write-back:** GitHub is **read-only** to the dispatcher; principals stay off HTTP (P §4.5).

## 3. Identity: the Work Key

Every command, reservation, delivery, ACK, deadline, event and audit record carries the
same four-part **work key**:

| Part | Meaning | Changes when |
|---|---|---|
| `repo` + `issue` | The GitHub issue, with its repository (`owner/name`, GitHub's own charset, ≤ 100 characters; issue a positive integer) | Never |
| `task` (`t<n>`) | One deliverable cut from the issue; most issues have one | The issue is decomposed |
| `attempt` (`a<n>`) | One authorized try at the task, with its own caps and budget. **Monotonic** per task and never reused, across restarts | A previous attempt is closed and a new one is authorized |
| `successor` (`s<n>`) | Which session in the attempt's lineage holds it; **0 first** | A session is replaced (context limit, provider change, handoff) |

Written form: `owner/repo#123/t1/a1/s0`. In this document "attempt" means only this part of
the key; an attempt has one delivery, and a delivery has exactly **one send** (§6.5).

- **One open attempt per task**, enforced inside the reservation step (§6.2), and at most
  the configured number of attempts per task (`attempt_cap_reached`, §15 decision 13).
- **A successor is registered, never inferred.** A replacement session becomes `s+1` only
  through an explicit **handoff record** that names its predecessor (the handoff envelope
  of #7823 is the record's content), written by the operator in v1 (§15 decision 4).
  Silence, a session ending or a timeout registers nothing. Commands addressed to an older
  successor are refused `stale_successor`; ACKs, `ack_stale_successor` (§6.7).
- **Consumed limits ride the attempt**, not the session. A session name or a label never
  establishes identity; the daemon's session id and the work key do.
- **A human-started session is observed, never adopted.** A coordinator reaches one only
  under an owner-granted lease (P §5.1, its decision D3), and only while that lease is live.
  After a restart such a session needs a fresh owner grant; P §5.4 restores a lease only for
  a principal-created session.

This design adds no second task store: the work key is the dispatch-side identity of the
#7823 record, and dispatch records reference it.

Tests. (a) Every fixture record of every kind (an independent list, checked both ways
against the reducer) has all four parts; mutation: drop `successor` from the delivery record.
(b) A cancel and an ACK naming `s0` after `s1` is registered are refused; mutation: compare
`attempt` only; positive control: both succeed at `s1`. (c) Attempts stay monotonic across an
unclean restart and a compaction, against an independent oracle; mutation: derive the next
attempt from the in-memory count.

## 4. Roles and What Each May Do

| Action | Operator | Coordinator of record | Other principal | Worker (own attempt) | Reviewer | Notification channel |
|---|---|---|---|---|---|---|
| Read work view, dispatch events, audit in scope | yes | yes | observe grant, sessions it may see | no | no channel in v1 | no |
| Dispatch | no channel in v1 | yes | no (`not_coordinator_of_record`) | no | no | no |
| Cancel; request a reconcile pass | cancel via `principal_admin_task_resolve`; passes run on the daemon's timer | yes | no | no | no | no |
| Request an owner decision | — | yes | no | no channel in v1 | no channel in v1 | no |
| Register a successor session | yes | no in v1 (§15 decision 4) | no | no | no | no |
| Resolve an attempt (adopt, mark uncertain, close, supersede, operator cancel) | yes (§6.8) | **no** | no | no | no | no |
| ACK a delivery | no | no | no | **yes**, own session, current successor | no | no |
| Declare progress (existing declared status) | no | no | no | yes, recorded as declared | no | no |
| Declare a deliverable; attach a review record | no | no | no | no channel in v1 | no channel in v1 | no |
| Answer an owner decision | yes, directly | no | no | no | no | no |
| Deny a pending permission | yes | answer scope only (P §9) | answer scope only | no | no | no |
| Allow a pending permission; change permission mode or rules | yes | **never** | never | never | never | never |
| Mint, extend or revoke credentials; grant leases; set the coordinator of record; raise a cap or a deadline | yes | **never** | never | never | never | never |
| Merge, deploy, restart the daemon | outside this API | **never** | never | never | never | never |
| Send a hint to a coordinator | — | — | — | — | — | outbound only |

**Coordinator of record.** One per repository, named by the operator through the
strict-primary, loopback-only `principal_admin_coordinator_set` (§7.1), which refuses a
principal below drive tier; held in the principal store (`principal-store.js`: 0600, written
only by the daemon) under the P §5.4 durable-write standard; stamped on every command record;
**never taken from the wire**. A missing or unreadable record reads as **none** (fail closed).
A swap is a recorded handover: the incoming coordinator starts from the work view and its
event cursor, and the outgoing one's `pending` deliveries are dropped
(`dropped:coordinator_changed`, §6.5). Revoking the principal or the kill switch ends the
record's effect at once; the record stays for audit. **An owner decision** is answered
directly in Chroxy with primary authority; one relayed by a coordinator satisfies no
owner-reserved gate, and a default never authorizes a reserved action.

Tests. The matrix is a **machine-read constant** (proposed `DISPATCH_ROLE_MATRIX`) that the
guard reads, in the manner of `PRINCIPAL_NEVER_CAPABILITIES` (`principal-policy.js`). Cells
marked "no channel in v1" are **excluded explicitly** in the constant, and the guard asserts a
real handler exists for every cell it tests. For every **never** cell: (1) the real handler,
called with a principal-stamped client and the allowlist bypassed, refuses; (2) with the
allowlist active, the type is refused `scope_denied`. Mutation: delete one cell's handler
predicate; check tier only for coordinator of record. Positive control: the coordinator of
record's dispatch reaches the commit step, and a second principal with the same tier and
lease is refused `not_coordinator_of_record`.

## 5. Source-Owned State

### 5.1 Principle

A state value is a **claim with an owner**. Only the component that can observe a fact may
assert it. Every value is carried as `{ value, basis, source, asOf }`, where **basis** is
one of `observed` (the asserting component saw it), `reconciled` (§5.3), `declared` (the
worker said so), `operator` (an operator assertion, §6.8) or none, shown as `unknown`. A
value older than the **freshness window** (§15 decision 12) is shown as `unknown` with its
age, never as current. Three things stay apart: what the **dispatcher did** (its ledger
records), what the daemon **observed** in the session, and what the worker **declared**.

### 5.2 Observed state of an attempt

| State | Asserted by | Evidence required | Not sufficient |
|---|---|---|---|
| `working` | Session runtime | An active turn (`turn_active` from `BaseSession.getHandoffBlockers`, `base-session.js`, aggregated by `SessionManager.getHandoffBlockers`) plus a journal event after the delivery's acceptance, inside the freshness window | The busy flag alone; a declared `running` |
| `waiting` | Session runtime | Idle, empty pending-permission and question snapshots; detail `awaiting_input` or `queued` | Silence; an open client |
| `blocked` | Daemon or ledger | A code it can itself see: `quota`, `budget_pause`, `hold`, `owner_decision:<id>`, `gate_failed` | A worker saying it is blocked (declared, shown beside) |
| `permission_requested` | Permission pipelines, through the canonical snapshot (`principal-pending-permissions.js`) | Request id, tool, policy verdicts, the request's own `expiresAt` | A banner; a notification |
| `permission_timed_out` | Permission pipelines | §5.4 | `permission_expired`; a resolution with neither `reason` nor `resolvedBy` |
| `permission_denied` | Permission pipelines | §5.4 | A deny with neither `reason` nor `resolvedBy` (`reason_unknown`) |
| `permission_abandoned` | Session runtime or pipeline | §5.4, confirmed by a later snapshot that no longer lists the request | A frame alone |
| `completed` | The daemon's turn outcome **alone** (S14's proposed `turn_ended`) | Turn outcome `completed` | A finished stream; "ready for input" |
| `unknown` | Whoever reads | A P §7.1 gap reason, a restart since the last observation, a roster row `unavailable`, the target session gone (`session_gone`), freshness expired | Never rendered as idle or as working |

A worker's deliverable claim is shown as **declared**. Neither it nor observed `completed` is
**validated completion**; that is separate evidence (§12.4), and the deliverable channel
belongs to the completion slice (D8). An attempt whose turn has ended **keeps its
reservation until it is closed** (§6.8); the `attempt_completed` event says so, and the
attempt stays on the operator's attention list (§8) until it is.

### 5.3 Reconciliation is a basis, not a guess

When a value is `unknown`, or two sources disagree, the daemon runs a deterministic
**reconciliation**: it reads the session roster (`collectSessionsSnapshot`,
`principal-sessions-snapshot.js`), the session journal from the last trusted cursor and the
pending-permission snapshot, then writes a **reconciliation record** naming the result, each
source with its time, and what is still unknown. The value then shows basis `reconciled`
until a direct observation replaces it; if the sources cannot settle it, it stays `unknown`
with `reconcile_inconclusive`. The daemon runs passes at boot and on its own timer while an
attempt is open; a coordinator of record's `principal_task_reconcile` only **asks** for a
pass. **Reconciliation reads; it never sends, retries, releases or resolves**, and its only
permitted transition is the safe one of §6.8. Test: a reconcile over every fixture state
performs zero writes outside its own record and that one transition (spy on the delivery and
capacity paths); mutation: release a reservation on `reconcile_inconclusive`.

### 5.4 Permission endings are different things

Read in source; they differ in frame, pipeline and **ordering against the pending state**,
so they are never collapsed:

| Ending | Frame and site | Ordering | Recorded as |
|---|---|---|---|
| Answered (allow or deny), in-process | `permission_resolved`, `reason: 'user'`, `resolvedBy`, from `PermissionManager.respondToPermission` (`permission-manager.js`) | Entry deleted **before** the frame | deny: `permission_denied`; allow: ends `permission_requested` |
| Answered, hook-routed | `permission_resolved` from `buildLegacyResolvedBroadcast` (`permission-resolver.js`): `decision`, `resolvedBy: 'user'`, **no `reason`** | The resolver's legacy path removes the entry synchronously, then the caller broadcasts | `resolvedBy: 'user'` is the evidence of a user decision: deny is `permission_denied`, allow ends the request; the absent `reason` is recorded as absent |
| Timed out, in-process | `permission_resolved`, `decision: 'deny'`, `reason: 'timeout'`, from the permission timer (`permission-manager.js`) | Entry deleted, then emitted | `permission_timed_out` |
| Timed out, hook-routed | **No `permission_resolved`.** The daemon's timer (`ws-permissions.js`) answers the hook `{ decision: 'deny', reason: 'timeout' }` and records the history outcome `expired` | — | `reason_unknown` until D8 adds an observable signal |
| Stopped or aborted, in-process | `permission_resolved`, `reason: 'stopped'` or `'aborted'`, `resolvedBy: 'abort'` (abort listener, `permission-manager.js`) | Entry deleted, then emitted | `stopped`: `permission_denied`; `aborted`: `permission_abandoned` |
| Drained at turn end or teardown, in-process | `permission_resolved`, `decision: 'deny'`, `reason: 'stopped'` on a user Stop, else `'cleared'`, from `PermissionManager.clearAll` | The maps are cleared **first**, then one frame per id | `stopped`: `permission_denied`; `cleared`: `permission_abandoned`, raw reason kept |
| Turn or session ended under the prompt | `permission_expired` per id, from `BaseSession._expirePendingPermissions` (`base-session.js`, which covers the **hook-routed** ids) and `SdkSession._handleHardTimeout` (`sdk-session.js`) | Emitted **before** the bookkeeping is cleared (`_pendingPermissionIds.clear()`; `_clearMessageState`) | `permission_abandoned` after a confirming snapshot read |
| A reply to a client that tried to answer | `permission_expired` sent **only** to that client, "expired or was already handled" (`handlers/settings-handlers.js`; also the reply for `not_found` and for a request it cannot see) | Not a state change | **Nothing** |
| A question (AskUserQuestion) ending | `permission_resolved { toolUseId, reason }` with **no `requestId`** (question timeout, abort, answer, supersede, and the `clearAll` drain, in `permission-manager.js`; the supersede frame also carries `decision: 'deny'`) | Per site | **Nothing**: not a permission ending |
| Other resolutions (mode switch, policy answer, explicit-consent `cancelled`) | `permission_resolved` with its own `reason` and `resolvedBy` | Per site | Raw reason kept: `cancelled` is `permission_abandoned`; a system deny is `permission_denied`; an allow ends the request |

Rules:

- **One ending per request id.** The first ending frame classifies it; a later frame for the
  same id is recorded as a secondary observation, never a second ending. (An in-process SDK
  request can receive `permission_expired` from the hard timeout and then a `cleared`
  resolution from `clearAll` for the same id.)
- **Never infer one ending from another's frame**, or from text; a reply to an answerer is
  not an ending, and a resolution with **neither a `reason` nor a `resolvedBy`** stays
  `reason_unknown`.
- **The history record cannot classify.** `permissionOutcomeForEvent` (`session-manager.js`)
  maps every `permission_expired` and every resolution with reason `timeout`, `aborted` or
  `cleared` to `permission_outcome: expired`, and reason `stopped` to `stopped`; only the
  live frames distinguish the endings folded into `expired`.

Tests. A fixture per row, including a snapshot read during a `permission_expired` that still
lists the request, an answerer reply (no change), an expired-then-`cleared` pair (one ending)
and a question ending (nothing). Mutation: map `permission_expired` to timed out; deny on a
resolution lacking both `reason` and `resolvedBy`; record a second ending. Positive control:
an in-process timeout and a hook-routed deny record their states. **Roster:** a syntax-tree
test, modelled on `tests/permission-resolved-by-roster.test.js` (P §9), enumerates every
`permission_resolved` and `permission_expired` site, question sites classified explicitly,
and fails on one absent from the constant this table mirrors; mutation: add one.

### 5.5 Declared status is a projection

Declared status, including the Status/Next footer parsed into `declaredStatus` with source
`marker` ([declared session status](../guides/declared-session-status.md)), is shown in a
column **labelled declared**, with its source and age. **No dispatch decision reads it**:
not admission, capacity, release, completion, eligibility or the next task. A disagreement
between declared and observed is an event (`state_disagreement`). A worker's `decision` text
stays a declaration; only a structured `principal_decision_request` creates a ledger record.
Test: two fixtures differing only in declared status produce byte-identical ledger state and
admission verdicts; mutation: let the release path read `declaredStatus`; positive control:
the declared column renders the declaration with its source.

## 6. The Dispatch Ledger

### 6.1 Storage, transitions and failed appends

One **append-only journal** under the config dir (0600, owned by the daemon's uid, read
through `readTrustedSecretFile` like the principal store), with a deterministic reducer
deriving every view, the append-plus-reducer pattern of `RunLedger`
(`orchestration/run-ledger.js`). Each append is **confirmed durable** before anything acts on
it, to the P §5.4 standard (file fsync, and directory fsync where a file is created or
renamed), the confirmed-durable discipline `PrincipalJournal` (`principal-journal.js`)
applies to its sequence reservation. The ledger stores **work keys, ids, hashes, lengths
and references**, never prompt text, issue text or tool inputs. Closed tasks are compacted
after their tombstone (§15 decision 13), snapshot plus journal, as `RunLedger` does; the
snapshot keeps each task's attempt counter, so monotonicity and the attempt cap survive.

**Every ledger transition is a synchronous check-and-append** against the reducer's current
state, exactly like the commit step of §6.2: the precondition is evaluated and the record
appended in one synchronous step, so no other transition interleaves; a precondition that no
longer holds refuses the transition instead of writing it.

**A failed append latches dispatch off.** An append that throws or is not confirmed durable
refuses every later command `ledger_unavailable`, and every new `sending` transition, until
the next boot re-reads the ledger; nothing is retried in-process. A queued `pending` entry
then has no exit until that re-read; that is safe, and the attention list shows the latch.
Where a written but unconfirmed record may exist, the guarantee is **no delivery**, not "no
record": the boot sweep settles it (§10). **At boot:** a torn **final** record (an
**incomplete line**, the only torn case) is copied to a side file, the journal is **durably
truncated** to the last good record, and only then is a `system` record appended; dispatch
proceeds. Any complete but invalid record (final or not), an unknown record version `v` or
kind, a wrong mode or owner, or a symlink **disables dispatch**, and `chroxy doctor` names
the recovery.

Tests: after an fsync failure a second command under a new `commandId` is refused and no
pending delivery is sent; a crash with a torn tail, two boots, then a dispatch is admitted
and the side file holds the torn bytes; an unknown `v` or a corrupt middle record disables
dispatch. Mutation: clear the latch on the next good write; append the `system` record before
truncating; fall back to an empty ledger. Positive control: a healthy store admits.

### 6.2 The reservation is one transaction (authoritative gate order)

For `principal_task_dispatch`, in this order; each gate fails closed with the reason shown.
Gates 1 to 7 follow P §6.4, so **no task state is revealed before session authorization**:

1. **Dispatch allowlist** (`refusePrincipalMessage`, `principal-policy.js`) — `scope_denied`,
   before any handler, schema validation or payload logging.
2. **Closed envelope** (§7.1) — any extra field `scope_denied`.
3. **Credential valid** — close 4401 (P §3.0).
4. **Kill switch and ledger health** — `agents_off`; `ledger_unavailable`.
5. **Scope and tier** — gates 5 and 6 are **one call**, `principalMaySee(client, sessionId,
   'drive', opts)` with `leaseFor` supplied (`principal-policy.js`), which checks grant, then
   tier, then the lease. Its reasons `scope` and `tier` are gate 5's `scope_denied`.
6. **Lease and `gen`** — the same call's `lease_required`, reached only after scope and tier
   pass; then the `gen` and suspension checks (`lease_stale`, `lease_suspended`).
7. **Per-session "agents off"** — `agents_off`.
8. **Coordinator of record** for the command's `repo` — `not_coordinator_of_record`.
9. **Field validation** (charsets, bounds; `ackBy` and `firstActivityBy` no longer than the
   daemon-configured maxima, §15 decision 13: a coordinator may choose a shorter deadline,
   never a longer one, which is not "changing a deadline") — `invalid_input`; rate limit —
   `rate_limited`.
10. **Idempotency** (§6.4) — a known `(principalId, commandId)` with the same semantic hash
    returns the stored accepted result with `replayed: true` and no effect; a different hash
    is `payload_mismatch`.
11. **Generation and view** — `stale_generation` (§10); `stale_view` when
    `expectedViewVersion` is not current.
12. **Eligibility** — `backlog_stale` when the issue read is older than the staleness limit
    (§15 decision 11); `issue_not_eligible`; `issue_held`.
13. **Attempt** — `attempt_open`; `attempt_uncertain`; `attempt_cap_reached`.
14. **Target fitness** — a supported provider (`target_unsupported`, §6.7); no **hard**
    handoff blockers from `getHandoffBlockers` (`background_shells` is soft, per
    `SOFT_HANDOFF_BLOCKER_CODES` in `base-session.js`) (`target_blocked:<code>`); no human
    activity by the P §6.4 admission predicates (`target_human_active`); the target
    session's repository, resolved by the daemon from the session's working directory,
    matches the work key (`target_repo_mismatch`; unresolvable reads as a mismatch). Refusing
    `target_blocked` and `target_human_active` here is **deliberately stricter than P**, whose
    input contract would queue: a dispatch starts work, so it is not admitted against a
    session that cannot take it now.
15. **Capacity** (§6.3) — `capacity_unavailable`; the agent queue has room for the
    coordinator's entry — `agent_queue_full` (the P §6.7 reason).
16. **Commit.** Inside `withPrincipalEffect` (`principal-effect.js`), whose `check` and `fn` run
    in one synchronous step: credential, kill switch, "agents off", lease and `gen` are
    re-validated; gates 8, 10, 11, 12, 13 and 15 are re-evaluated against the in-memory
    reducer; `auditOrRefuse` writes the **audit pre-effect record** (§11; failure is
    `audit_unavailable` with no ledger append); then **one durable append** writes the
    `dispatch_reserved` record: the reservation, the capacity hold, the outbox entry in
    `pending`, the deadlines and the semantic hash, under one work key and `bootGen`; the
    agent-queue entry is created in the same step, so the room checked at gate 15 cannot be
    lost. The append and its fsync are **synchronous calls** (as `writeDurableFile`,
    `durable-write.js`, is), and a command arriving while a commit is in progress is refused
    or serialized by a **commit-in-progress re-entry guard**, never evaluated against
    un-advanced state. An asynchronous implementation must instead serialize every commit
    through one writer and count **in-flight** reservations in gates 10, 13 and 15. If the
    append is not confirmed durable there is **no delivery** (memory is not advanced), the
    reply is `ledger_unavailable`, an outcome line records it, and §6.1's latch is set.
17. **Reply** `principal_command_result { status: 'accepted', workKey, reservationId,
    deliveryId, ledgerSeq, bootGen }`; then delivery begins (§6.5).

Validation runs before idempotency so a malformed body is never memoized; idempotency runs
before the task-state gates so a replay of an accepted command is answered from its record
instead of meeting its own open attempt. Because gates 5 to 7 come first, **a replay after
the lease is lost gets the lease refusal**, as in P §6.4.

Tests. (a) A recording harness fails each gate in turn; mutation: swap gates 10 and 13 (a
replay reports `attempt_open`), or move gate 12 above gate 5 (a non-granted caller learns
eligibility). (b) A revoke, kill, lease bump, coordinator change and issue hold injected at
every `await` before gate 16 cause zero effect (P §3.0 item 3); mutation: append outside
`withPrincipalEffect`, or drop gate 8 from the re-check. (c) A failed pre-effect write or
append (throw, unconfirmed fsync) yields no delivery and `audit_unavailable` or
`ledger_unavailable`; mutation: reply before the fsync verdict. (d) **Re-entry guard:** a spy
on the append injects, inside it, a second command for the same task and one for a full
pool; each is refused or serialized, never evaluated against un-advanced state; mutation:
remove the re-entry refusal. An asynchronous implementation must pass both cases against a
**slow writer**; mutation: drop in-flight counting. Positive control: a clean dispatch writes
one `dispatch_reserved` record and replies `accepted`.

### 6.3 Capacity

Pools are **named pools derived by the daemon from configuration**, never named on the wire;
v1 has one, `session`. They are counted **inside the commit step**, and a slot is held until
the attempt closes by a **recorded transition** (§6.8); time never releases one silently.
Test: §6.2 (d) against an independent oracle; mutation: count before the commit step;
positive control: a released slot admits the next dispatch.

### 6.4 Idempotency

- The key is **`(principalId, commandId)`**; `commandId` is client-generated
  (`^[A-Za-z0-9_-]{8,64}$`). The **semantic hash** is SHA-256 over the canonical serialization
  of `repo`, `issue`, `task`, `sessionId`, `scopeRef` and `deadlines` only; `commandId` and
  every fence (`bootGen`, `gen`, `leaseId`, `expectedViewVersion`) are excluded.
- **Only accepted results are memoized**, durably, in the reservation record. A replay
  returns the stored accepted result with `replayed: true` **plus the delivery's current
  state and the attempt's outcome**, so a coordinator never reads a stale "accepted" for a
  delivery that was dropped. A refused command leaves a denial audit record and **no
  idempotency record**, so the same `commandId` may be retried and is evaluated afresh. A
  different semantic hash under an accepted key is `payload_mismatch` (the P §6.7 reason).
- Cancel, reconcile and decision requests follow the same rule on their own semantic fields.
  A record lives **as long as the task plus a tombstone** of at least the credential's
  maximum lifetime (§15 decision 7), never a process-local window (contrast
  `reserveInputRequest`, `INPUT_DEDUP_*` in `handlers/input-handlers.js`).
- At a per-principal cap new commands are refused `dispatch_capacity`; nothing is evicted.
  **Coordinators must persist a `commandId` before sending it**, so their restart repeats it.

Test: a duplicate yields one reservation and a replay carrying the current delivery state; a
replay after a drop reports `dropped:<reason>`; a restart between the two still replays; a
changed semantic field is `payload_mismatch`; a changed `gen` alone replays; a command
refused `capacity_unavailable` and retried under the same id after a slot frees is accepted.
Mutation: memoize refusals; hash a fence; replay without the current state. Positive control:
a new `commandId` for a new task is admitted.

### 6.5 Delivery to the worker

**On main**, `handleInput` (`handlers/input-handlers.js`) refuses every principal at its
first statement (`refusePrincipalHandler`); host input reaches a provider through
`entry.session.sendMessage(text, attachments, { clientMessageId, … })` in that handler, with
`onInputAdmission` passed when the handler tracks admission, and the CI wake through the
same provider call from `wakeViaTurnInput` (`session-wake.js`). That call and its admission
report are the **turn-input seam**. **A dispatch delivery** goes through the principal input
path S9 adds behind `handleInput`: framing (P §6.2, §6.3), the fence (P §6.4), the agent
delivery lock and queue (P §6.5) and the provider write boundary (P §6.9), ending in that
same `sendMessage` call with the `deliveryId` as `clientMessageId` (one per delivery, never
reused). It adds **no second send path** and never calls `wakeSession` or
`wakeViaTurnInput`, so session-wake.js's gates (idle only, the PTY route,
`sanitizeWakeText`) do not apply; only `MAX_WAKE_TEXT_CHARS` is reused (§7.3).

Queue entries are tagged with the coordinator's **`principalId`**, so kill, revoke and
"agents off" drains reach them, plus a **`via: 'dispatch'`** marker, a **proposed extension of
P §6.5 owned by S9**. The agent queue stays non-durable; for a dispatch delivery **the ledger
is authoritative**.

| Delivery state | Written when | After a daemon restart |
|---|---|---|
| `pending` | With the reservation; **only before any provider call**. The fence may hold the entry in the daemon's own agent queue (`fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`, `fenced_busy`); a fence-cause `zero_effect` for an entry that never left that queue is the one case that keeps `pending` | `dropped:restart` |
| `sending` | **Persisted before the provider is called**, with the nonce hash (§6.6). Stays `sending` until acceptance, a provider `zero_effect`, `uncertain`, or the operator's `mark_uncertain` (§6.8); a provider `queued` admission keeps it `sending` | `uncertain` |
| `delivered` | An **acceptance signal belonging to that turn** (below), §6.8's safe reconciliation, or an operator `adopt` (basis `operator`) | `delivered` |
| `rejected:not_dispatched` | A provider `zero_effect` verdict for the send | terminal |
| `dropped:<reason>` | **Only from `pending`**, on any P §6.5 drop cause: `session_end`, `restart`, `lease_expired`, `lease_stale`, `lease_suspended`, `lease_released`, `revoked`, `killed`, `agents_off` (per-session or global), the queue TTL (`expired`), a cancel (`cancelled`), a coordinator swap (`coordinator_changed`), an operator `close`/`supersede` or a closed attempt at send time (`closed`), or a held issue at send time (`held`) | terminal |
| `uncertain` | A provider `uncertain` outcome, a lost transport, a restart during `sending`, a drop cause during `sending`, or `mark_uncertain` (basis `operator`) | `uncertain` (§6.8) |

**Drop versus send is serialized.** The `pending` → `sending` transition and every drop are
taken under the **per-session agent delivery lock**, each a synchronous check-and-append
(§6.1), so exactly one wins. The step that appends `sending`, immediately before the
provider call, re-validates credential, kill switch, "agents off", lease and `gen` **current
at send time** (never the command's stored values), **attempt open** and **issue not held**;
a `pending` delivery whose attempt is closed or whose issue is held is not sent and is
recorded `dropped:closed` or `dropped:held` (known unsent; `delivery_dropped`). A
drop cause during `sending` yields `uncertain` unless the provider returns a `zero_effect`
verdict for that send, which wins (`rejected:not_dispatched`); a later `zero_effect` for a
delivery already `uncertain` reconciles it to `rejected:not_dispatched` (the provider itself
says nothing happened). An event not listed for a state (a drop cause at `uncertain` or
`delivered`, a `queued` admission at `uncertain`, a `zero_effect` at `delivered`) leaves the
state unchanged and is recorded as an observation. A kill, revoke or
"agents off" drain removes the queue entry even if its append fails (latching); at boot a
`pending` record becomes `dropped:restart`.

**The ledger is the authority for a dispatch delivery's state.** The `sending` append is
written **before** the S10 durable-dedup record (P §6.6) reaches `dispatching` and before the
provider call, so the ledger never says `pending` for what S10 says was dispatching. The S10
record keeps exactly the state P §6.6 gives it (a `reserved` record still reads `uncertain`
there, which only means that `clientMessageId` is never auto-retried); the dispatch reducer
does not read S10 to decide delivery state.

A **dropped** or **rejected** delivery is **known unsent**: one audit record, the attempt
closes `dropped` (or `cancelled`, `closed`, `superseded` for those verbs), its capacity is
released by that transition, and `delivery_dropped` is emitted.

**The acceptance signal** is the provider's `onInputAdmission` report `{ status: 'accepted',
delivery: 'dispatch_started' }` for the send's `clientMessageId`, on a provider that declares
the seam (`capabilities.daemonTurnInput === true`, read by `supportsDaemonTurnInput` in
`session-wake.js`); a `queued` admission leaves the delivery `sending`. On claude-tui a PTY
write that returns true is not an acceptance; it needs a turn start caused by the send (S14's
proposed `turn_started { causedBy }`) and the composer detector P §6.9 gates input on.

Tests. Each drop cause at `pending`: `dropped:<reason>`, one audit record, capacity released,
**zero sends**. **Race:** a cancel, lease loss or revoke at the `sending` append yields
(`dropped`, zero sends) or (`sending`, then `uncertain`), never both. `close` at `pending`
with a fenced entry, then the fence clears: zero sends. A fixture provider that admits,
queues then admits, rejects, and fails mid-write maps to `delivered`, `sending` then
`delivered`, `rejected:not_dispatched`, `uncertain`. Mutation: drop from `sending`; map
`queued` to `pending`; leave a closed entry queued; persist `sending` after the call; send
under the stored `gen`. Positive control: an undisturbed delivery sends once.

### 6.6 The two-part acknowledgment and the observed start

- **Part 1, daemon-observed**: the provider accepted the turn that carried the send (§6.5).
- **Part 2, worker-returned.** A **nonce** (128 random bits) is generated when the single
  send is created; the `sending` record carries its **hash**, and the plaintext exists only in
  memory while the wake text is built. The worker returns the nonce through its
  acknowledgment channel (§6.7), which the daemon resolves to exactly one session without
  reading a session from the message. In one synchronous step the daemon checks that this
  session is the delivery's target (`wrong_session`), at the **current successor**
  (`ack_stale_successor`); the delivery is `sending`, `delivered` or `uncertain`
  (`delivery_not_open`); the attempt is open (`attempt_closed`); and the nonce matches the
  stored hash, constant-time (`nonce_mismatch`). Part 2 is recorded durably **once**; a repeat
  is acknowledged without a new record. Against `uncertain` it is evidence and reconciles
  toward `delivered` (§6.8). The nonce binds the ACK to the delivery and the channel binds it
  to the session; the nonce is not a secret and confers nothing alone.
- A **verified durable ACK** is both parts on disk under the same work key and `deliveryId`.
  Each part records its own `bootGen`. Either part alone is shown as what it is.
- **Work start** is a third, observed fact, **never declared**: the first tool event
  (`tool_start`) after part 1 **in the turn the delivery caused**, other than the
  acknowledgment tool's own call (§6.7), which is part 2 and never a start. Attribution needs
  S14's `turn_started { causedBy }`; until then it is an **unattributed start**
  (`start_unattributed`), which cannot pass the live dispatch acceptance.
- **Starts are counted per attempt and delivery.** The acceptance quantity is "observed starts
  attributable to the delivery": **0, 1, more than 1, or unknown**; a journal gap yields
  `unknown`, never 0. Counting **detects** a second start (`second_start`); the reservation
  and uncertainty rules are what **prevent** one.
- **Overdue clocks emit events and a reconcile, nothing else**: `ack_overdue` at `ackBy`,
  `start_overdue` at `firstActivityBy`. These two clocks belong to the delivery slice (D3).

Test: part 2 before part 1 is part 2 only; against `uncertain` it moves to `delivered`; a
repeat adds no record; a declared start with no tool event is no start; a gap reads
`unknown`; an acknowledgment call alone is no start. Mutation: accept a declared start; drop
the successor check; count a gap as 0; count the acknowledgment call as a start. Positive
control: both parts and one attributed tool event yield a verified ACK and a count of 1.

### 6.7 The worker acknowledgment channel (§15 decision 1)

**The declared-status channel cannot carry part 2.** Its `hook` source (`POST /api/events`,
`event-ingest.js`) lets the caller **name** the session; its `api` source
(`POST /api/sessions/:id/status`, `http-routes.js`) accepts a primary token for **any** session
named in the path and a pairing token only for its bound session; and its schema
(`DeclaredStatusInputSchema`, `packages/protocol/src/schemas/declared-status.ts`) is
`.strict()` with no field for a delivery id or a nonce. Part 2 needs **its own small message**
on a channel already bound to exactly one session, so the daemon, not the caller, decides
which session is speaking. The candidates are a daemon-defined in-process tool and the classes
of [`bearer-token-authority.md` §2](bearer-token-authority.md#2-the-four-token-classes):

| Class | Bound to one session? | What else it can do | Verdict |
|---|---|---|---|
| **Daemon-defined in-process tool** (claude-sdk) | **yes, by construction**: one tool instance per session object, the daemon session id from the manager's wiring; no credential | nothing (below) | **recommend for claude-sdk** |
| Primary token | no | everything | refuse |
| Pairing-bound session token | yes (`generateBoundPairing`, `pairing.js`) | input, permission answers and declared-status writes **for that session** | refuse: a worker holding it could answer its own permission prompts |
| **Per-session hook secret** | **yes**: minted per session by `CliSession` (`cli-session.js`) and, only when a port is configured, `ClaudeTuiSession` (`claude-tui-session.js`); in memory only, never persisted, not accepted for WebSocket auth; **exported to the child only when a port is configured** (and, for claude-tui, permissions are enabled); `_findSessionByHookSecret` (`ws-server.js`) resolves the owner session from the secret | today only `POST /permission` and `POST /permission-floor`, which create a prompt for that session or read | **retained for claude-cli, deferred** |
| Daemon-level ingest secret | no: daemon-wide; the caller names the session | notifications, declared status, mailbox wakeups | refuse |
| Agent principal | no; a worker is not a principal | its tier | refuse |
| Discord-return secret | not built; channel-scoped | — | refuse |

**On main.** claude-sdk already produces part 1: `SdkSession` (`sdk-session.js`) declares
`capabilities.daemonTurnInput: true` and reports `{ status: 'accepted', delivery:
'dispatch_started' }` through `reportInputAdmission`. `SdkSession.sendMessage` builds a fresh
options object and calls `query()` once per turn; permission enters the daemon in-process at
exactly two places, `options.canUseTool` → `_handlePermission` (every mode but auto) and
`options.hooks.PreToolUse` → `_handleAutoPreToolUse` (auto, where the SDK runs
`bypassPermissions`), both reaching `PermissionManager.handlePermission`; no `mcpServers`
option is passed. The session object does not hold the daemon's session id;
`SessionManager._wireSessionEvents(sessionId, session)` (`session-manager.js`) closes over it.
`DockerSdkSession` (`docker-sdk-session.js`) extends `SdkSession` with its own process spawn.
The Agent SDK exports `createSdkMcpServer` and `tool` (in-process tools).

**Recommendation for claude-sdk: a daemon-defined in-process acknowledgment tool.** Built per
turn inside the session: server `chroxy`, tool `task_ack`, model-visible name
`mcp__chroxy__task_ack` (names proposed); input exactly `{ deliveryId, nonce }`, strict, ≤ 512
bytes; the §6.6 checks and the §7.2 audit-only reasons. It uses **no token class**: the session
is the one whose session object owns the tool instance, and the daemon session id comes from
the manager's wiring, never from the tool input and never from the session object. It
therefore needs no `bearer-token-authority.md` delta. Requirements:

- **The handler is the only authority.** Every §6.6 check runs in the tool's handler, in one
  synchronous step. The permission entry point is **not a gate** for this tool (an
  `allowedTools` entry skips `canUseTool` entirely, spike item 5); its only job is that no
  human prompt is created for the call. That treatment is not a permission answer by any
  principal or relay, creates no pending request, and changes the treatment of no other tool.
- **No prompt, narrowly, and behind the floor.** The treatment is an ordinary short-circuit
  placed **after the floor check**, as `permission-floor.md` §2 requires of every
  short-circuit: the call reaches `PermissionManager.handlePermission` through the same two
  entry points as any tool, the floor is evaluated first, and only then is the one reserved
  name settled. The spike settled it ahead of `PermissionManager`, in the same call chain;
  D4a must not. An `allowedTools` entry is not an acceptable mechanism: it skips the entry
  point and with it the floor check. The match is **exact**, on the one reserved name, and
  applies only while the daemon's own instance is the registered server of that name. A session whose configuration (user, project or local, the
  `settingSources` `SdkSession` passes) defines a server with the reserved name **fails
  closed**: the tool is not registered, nothing is pre-settled, and the session is
  `target_unsupported` (which instance would win is unverified; hence a required test).
  `_trackPermissionDecision` bookkeeping is kept. The tool takes no path, command or content,
  so the floor has nothing to floor; it is still checked first. **Its `permission-floor.md`
  delta** (with D4a, at HIGH): a row in that document's §2 table and the in-process diagram
  of its §3. As the **first tool settled without a prompt by name**, the row must be argued
  there, not assumed, to leave §2's precedence as written.
- **Narrow registration.** The tool is registered only on turns of a session that is the target
  of an open dispatched attempt (a delivery in `sending`, `delivered` or `uncertain`); every
  other session and turn sees no new tool and no change. The daemon-built wake text names the
  tool exactly (§7.3); nothing from the wire becomes wake text.
- **Reply and rate.** A per-session rate limit (§15 decision 13). The reply to the model is
  `{ ok: true }` or **one uniform refusal**; the audit records the specific reason and, when
  the entry point saw an `agentID`, records it as audit detail only.

**Honest limits of the tool.** Part 2 is evidence that the **session's own agent loop** made
the call with the nonce, not evidence of intent. A **subagent** of the session can make it,
and v1 accepts that: the handler cannot tell. The acknowledgment **can be lost** if the turn
ends first (spike item 7); a delivery then lacks part 2, which §6.6 and §6.8 already treat
safely, never by resending. The tool is **visible** to the model and in the transcript (spike
item 8), and the model may need a lookup step first (spike item 9). Narrower than the hook
secret in one respect: no process in the worker's tree can present anything; the call can
only arrive over the SDK's own channel for that turn.

**Evidence.** Spiked 2026-11-21 on a throwaway daemon built from `2373ec835` with an unmerged
patch, Agent SDK 0.2.141, small model only; the evidence is held by the owner. (1) A tool built
per turn inside the session was called by the model, and the entry point saw the call (exact
name, input keys) **before** the handler ran: approve mode via `canUseTool`, auto via
`PreToolUse`. (2) With that one tool settled by the entry point, no `permission_request` frame
reached any client in either mode; an ordinary file write in the same approve session still
prompted. (3) The handler ran in the daemon; a listener in `_wireSessionEvents` recorded the
right daemon session id (3 of 3); two concurrent turns each got only their own call. (4) On
an entry-point deny the handler never ran. (5) A tool pre-allowed by `allowedTools` ran with
`canUseTool` never consulted (standalone SDK probe only). (6) A subagent could call it; the
`canUseTool` options carried an `agentID`, the handler's arguments nothing distinguishing.
(7) A subagent call after the turn's input stream closed at its result failed with an abort,
once; a call before the result succeeded; "after the result, input held open" is unproven.
(8) The call is an ordinary tool row (`tool_start`, `tool_result`), the server in the
`mcp_servers` frame. (9) In 10 of 11 turns the model first loaded the deferred tool through
the CLI's tool search; `tool()`'s `alwaysLoad` extra was not tried. **Not tested:** resume
across turns; a configured server of the same name; `DockerSdkSession`; interrupt or stop
mid-call; a throwing handler; the sandbox option; plan mode; other models; claude-cli,
claude-tui, Codex and ACP (no in-process seam; nothing applies).

**Retained, deferred: the per-session hook secret and `POST /task-ack`.** Not part of v1; the
mechanism for a provider with a hook secret and no in-process seam (claude-cli), with its own
slice (D4b). The per-session hook secret is extended by **one** hook route
(`POST /task-ack`, proposed; §15 decision 1), body exactly `{ deliveryId, nonce }`, ≤ 512
bytes. Requirements: **loopback only** (`isLoopbackPeer`, `connection-locality.js`, before the
token check, per bearer-token-authority §9 step 3); the session resolved by constant-time
comparison to a **non-null session id**, with **no fallback** to any other class (the
`_validateHookAuth` primary-token fallback does not apply); every other class refused; a
per-session rate limit (§15 decision 13); the route on the P §4.5 HTTP roster. The reply is
`{ ok: true }` or **one uniform refusal**, a deliberate departure from bearer-token-authority
§9 step 2: the caller's tools are untrusted, and a specific reason would make the route an
oracle for other sessions' deliveries; the audit records the specific reason. **Its
bearer-token-authority delta** (with D4b, at HIGH): §1, §5, the §7 table, the §9 step 1 list,
`tests/http-routes-scoped-token.test.js`. As the **first hook-secret route that writes durable
state**, it needs §5's "strictly less" argument (made for `POST /permission-floor`) re-argued
there, not assumed. **Its honest limit:** anything in the worker's process tree can read the
secret (the `cli-session.js` comment says so): part 2 is evidence of receipt **from inside
that tree**, not of intent.

**What neither channel may do:** answer, create or extend any permission request; send
input; interrupt; read any session data, roster, journal or ledger; write declared status;
acknowledge for another session or an older successor; register a successor; change any
ledger state other than recording part 2. Codex and ACP have neither a hook secret nor an
in-process seam, claude-tui cannot yet produce part 1 (§6.5), and the route is deferred; hence
§15 decision 2.

Test (tool, D4a): two sessions with open attempts each call their own tool with the other's
`deliveryId` and nonce: refused uniformly, audited `wrong_session` (another session's tool
instance cannot record this session's part 2, by construction); a wrong nonce, an older
successor and a closed attempt are refused, also with the entry point skipped by an
`allowedTools` entry; a session with no open attempt lists no such tool; an ordinary file
write in the same approve session still prompts; a configured server of the reserved name
leaves the session `target_unsupported` with nothing pre-settled; the floor check runs for
the acknowledgment call before it is settled. Mutation: take the session id from the tool
input; pre-settle by prefix rather than exact name; settle ahead of the floor check; register
the tool for a session with no open attempt; run a §6.6 check in the entry point instead of
the handler.
Positive control: the target session's call with the right nonce records part 2 with no
`permission_request` frame, in approve and in auto mode. Test (route, D4b): an ACK with each
refused class, from a non-loopback peer, with another session's or an older successor's
secret, or a wrong nonce is refused uniformly and audited specifically; mutation: take the
session from the body, or drop the nonce check; positive control: the target session's secret
and nonce record part 2.

### 6.8 Uncertainty, attempt close and no blind redispatch

`uncertain` means the delivery may have been accepted. Reconciliation may move it to
`delivered` **only in the safe direction**: when the session journal positively shows the
input admitted under the `deliveryId` (`admission_observed`), or when a valid part 2 or
acceptance signal arrives. It **never** concludes "not sent", sends or releases; a continuous
journal with no admission leaves it `uncertain`, as does a gap. While an attempt is open or
uncertain a new dispatch for the task is refused (`attempt_open`, `attempt_uncertain`). A
target session that disappears makes the attempt `unknown`, emits `session_gone`, and waits
for `close`.

**Operator verbs** (`principal_admin_task_resolve`), by **delivery state**. No verb releases a
reservation while a send is **known to be in flight** (`sending`). From `uncertain`, `close`
and `supersede` are the operator's evidence-based decision (the reconcile evidence is shown
first) that the task may be given up or tried again; the attempt is fenced, and the residual
risk that the old send started a worker is the operator's to accept. **There is no resend:**
to try again the operator supersedes, and a later dispatch command creates the next attempt.
**Attempt state is evaluated first:** on a closed attempt (`closed`, `superseded`,
`cancelled`, `dropped`) every verb but the task-level `raise_cap` is refused `attempt_closed`
(`cancel`: `cancel_not_applicable`) whatever the delivery state, so `adopt` never revives a
fenced attempt. `close`/`supersede` on a `delivered` attempt leaves a running worker running
(fenced) beside any new attempt; the operator should cancel first or wait for the turn end.

| Verb | `pending` | `sending` | `uncertain` | `delivered` | `rejected`, `dropped`, or attempt closed |
|---|---|---|---|---|---|
| `adopt` | `delivery_not_uncertain` | `delivery_sending` | `delivered`, basis `operator` | `delivery_not_uncertain` | `attempt_closed` |
| `mark_uncertain` | `delivery_not_sending` | `uncertain`, basis `operator`; releases and sends nothing | `delivery_not_sending` | `delivery_not_sending` | `attempt_closed` |
| `cancel` | as the coordinator cancel below | as below | `attempt_uncertain` | as below | `cancel_not_applicable` |
| `close`, `supersede` | in one synchronous step `dropped:closed`, queue entry drained, attempt `closed`/`superseded` | `delivery_sending` | attempt `closed`/`superseded`, fenced | attempt `closed`/`superseded` | `attempt_closed` |
| `raise_cap` (field `attemptCap`) | raises the task's attempt cap | same | same | same | same |

`mark_uncertain` is the operator's exit from a `sending` delivery that never settles (a
restart is the other); a later acceptance or part 2 still reconciles it to `delivered`. The
operator `cancel` skips the coordinator gates but keeps the interrupt rule. **Attempt-close
transitions** before the completion slice are `dropped` (§6.5), `cancelled`, `closed` and
`superseded`; each releases capacity **exactly once**, nothing else does, and every open
attempt is on the attention list (§8). A closed or superseded attempt is **fenced**: a late
acceptance, ACK, start or report is refused and raised as `late_report_refused`.
**Supersede is operator-only** until completion fencing exists.

**Coordinator cancel** (`principal_task_cancel`) runs gates 1 to 10 of §6.2, then checks the
work key's successor (`stale_successor`) and, before any interrupt, the P §4.1.1 interrupt
envelope rules and the P §4.1.3 fences (`fenced_pty_dirty`, `fenced_human_active`,
`human_queue_nonempty`, answer scope while a prompt is pending). Its result embeds the P §7.4
interrupt-ack fields (`status`, `reason?`).

| Delivery state | Cancel outcome |
|---|---|
| `pending` | `dropped:cancelled`; the attempt closes `cancelled` |
| `sending` | `cancel_requested` is recorded; settling at `delivered`, the `delivered` rule applies after gates 3 to 8 and the P §4.1.3 fences re-run (a refusal records `cancel_not_applicable`); settling `uncertain` (also by restart), a `cancel_not_applied` record and event, nothing interrupted |
| `delivered` | Interrupt **only** a turn caused by this delivery (S14), else `cancel_not_applicable`; a human's turn is never interrupted. The attempt **stays open** and keeps its capacity until `close` |
| `uncertain` | Refused `attempt_uncertain` |
| `rejected`, `dropped`, closed attempt | `cancel_not_applicable` |

Tests: a restart during `sending`, then any reconcile, leaves at most one attributed start;
`close` at `sending` is `delivery_sending`; `mark_uncertain` releases nothing; a second
`close` is `attempt_closed` and releases nothing; `close` from `uncertain`, then a late
acceptance and a late ACK: both refused as fenced and raised, the next attempt unchanged; a
cancel during a human's turn interrupts nothing. Mutation: send again from `uncertain`;
release at `sending`; release twice; accept a late ACK on a fenced attempt; interrupt any
turn. Positive control: `adopt` from `uncertain` records `delivered` once.

## 7. Message Types and Codes

All names are proposals. New types carry the `principal_` prefix and enter
`PRINCIPAL_ALLOWED_MESSAGE_TYPES` (`principal-policy.js`) only with their handlers; the roster
guard of P §4.2 checks them in both directions. Every reply passes `frameForPrincipal` field
whitelists, and every row it carries passes `principalMaySee(client, sessionId, 'observe')`
(`PRINCIPAL_BROADCAST_ALLOWED` stays empty). The new admin types **amend P §3's management
roster** (an amendment D1 owns): they are strict-primary and loopback-only, and sit in
`BOUND_DENIED_MESSAGE_TYPES` and `PRINCIPAL_DENIED_MESSAGE_TYPES`.

### 7.1 Message types (closed field sets)

| Type | Who, tier | Fields | Reply |
|---|---|---|---|
| `principal_task_dispatch` | coordinator of record, drive | `type, commandId, expectedViewVersion, bootGen, repo, issue, task, sessionId, scopeRef, deadlines { ackBy, firstActivityBy }, leaseId, gen` | `principal_command_result` |
| `principal_task_cancel` | coordinator of record, drive | `type, commandId, requestId, workKey, sessionId, leaseId, gen` | `principal_command_result` with the P §7.4 interrupt-ack fields |
| `principal_task_reconcile` | coordinator of record, drive | `type, commandId, workKey, sessionId, leaseId, gen` | `principal_command_result` |
| `principal_decision_request` | coordinator of record, drive | `type, commandId, workKey, sessionId, leaseId, gen, scopeRef, recommendationRef, defaultRef, expiresAt` (references only) | `principal_command_result` |
| `principal_work_view` | observe | `type, requestId, repo, sinceVersion?` | `principal_work_view_result` (`notModified: true` when current) |
| `principal_dispatch_subscribe`, `principal_dispatch_events_read` (proposed; §15 decision 10) | observe | the P §7.2 cursor fields; cursor `{ journalId, journalSeq }` | `principal_dispatch_subscribed`, `principal_dispatch_event`, `principal_dispatch_live_fence`, `principal_dispatch_gap`, `principal_dispatch_events_page` |
| `principal_event_ack` (proposed; §15 decision 14) | observe (the one exception, §8) | `type, requestId, journalId, journalSeq` | `principal_event_ack_result` |
| `principal_audit_read` | observe | `type, requestId, workKey?, afterLedgerSeq?, limit` (≤ 200) | `principal_audit_page` |
| `principal_admin_coordinator_set` | operator | `type, requestId, repo, principalId \| null` | direct reply |
| `principal_admin_task_resolve` | operator | `type, requestId, workKey, action, attemptCap?` | direct reply |
| `principal_admin_successor_register` | operator | `type, requestId, workKey, sessionId, handoffRef` | direct reply |
| `principal_admin_decision_answer` | operator | `type, requestId, decisionId, answer` | direct reply |
| `mcp__chroxy__task_ack` (proposed; §15 decision 1) | worker on claude-sdk, the session's own in-process tool (§6.7) | `deliveryId, nonce` | `{ ok: true }` or the uniform refusal |
| `POST /task-ack` (proposed, deferred; §15 decision 1) | worker, per-session hook secret | `deliveryId, nonce` | `{ ok: true }` or the uniform refusal |

Every coordinator command is rate-limited (§15 decision 13). **No free-text field exists on
any coordinator command.** `scopeRef` and the decision `*Ref` fields are references
(`^[a-z0-9._/-]{1,64}$`), not prose. The journal position on the wire is `journalSeq` (P §4.1),
never `seq`, which the transport stamps on every frame.

### 7.2 Reasons and event codes

Every code used in this document appears in this table, and a code reused across channels
keeps one meaning.

| Channel | Codes |
|---|---|
| Command refusals | `scope_denied`, `agents_off`, `lease_required`, `lease_stale`, `lease_suspended`, `not_coordinator_of_record`, `invalid_input`, `payload_mismatch`, `dispatch_capacity`, `rate_limited`, `stale_generation`, `stale_view`, `stale_successor`, `backlog_stale`, `issue_not_eligible`, `issue_held`, `attempt_open`, `attempt_uncertain`, `attempt_cap_reached`, `target_unsupported`, `target_blocked:<code>`, `target_human_active`, `target_repo_mismatch`, `capacity_unavailable`, `audit_unavailable`, `ledger_unavailable`, `delivery_not_uncertain`, `delivery_not_sending`, `delivery_sending`, `attempt_closed` (shared with the worker ACK channels), `cursor_unavailable` |
| P §6.7 codes reused (fences and queue) | `fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`, `fenced_busy`, `human_queue_nonempty`, `agent_queue_full` |
| Command result | `accepted` (a repeat carries `replayed: true` and the current state); cancel outcomes `cancel_requested`, `cancel_not_applicable`, `cancel_not_applied` |
| Worker ACK channels, tool and route (audit only; one uniform refusal on the wire) | `nonce_mismatch`, `wrong_session`, `ack_stale_successor`, `delivery_not_open`, `attempt_closed` |
| Delivery states | `pending`, `sending`, `delivered`, `rejected:not_dispatched`, `dropped:<reason>` (`session_end`, `restart`, `lease_expired`, `lease_stale`, `lease_suspended`, `lease_released`, `revoked`, `killed`, `agents_off`, `expired`, `cancelled`, `coordinator_changed`, `closed`, `held`), `uncertain` |
| Attempt close outcomes | `dropped`, `cancelled`, `closed`, `superseded` |
| Observed state detail | `awaiting_input`, `queued`, `quota`, `budget_pause`, `hold`, `owner_decision:<id>`, `gate_failed`, `reason_unknown` |
| Reconciliation results | `admission_observed`, `reconcile_inconclusive` |
| Events (§8) | `work_started`, `start_unattributed`, `second_start`, `ack_overdue`, `start_overdue`, `attempt_completed`, `permission_requested`, `permission_timed_out`, `permission_denied`, `permission_abandoned`, `deadline_approaching`, `deadline_missed_while_down`, `dispatch_uncertain`, `delivery_dropped`, `cancel_not_applied`, `session_gone`, `late_report_refused`, `state_unknown`, `state_disagreement`, `reconciled`, `decision_answered`, `command_denied`, `hint_exhausted` |

As in P §6.7, a non-granted target is `scope_denied`, indistinguishable from a nonexistent
one, and specific reasons go only to an authenticated principal about its own request. Test:
the codes are a constant, and a guard asserts every code the handlers can emit is in it and
every listed code is emitted somewhere, in both directions; a non-granted caller cannot
distinguish any two reasons. Mutation: emit an unlisted code; answer `target_blocked` for a
non-granted session. Positive control: the coordinator of record sees
`target_blocked:turn_active` for its own leased session.

### 7.3 The wake text is built by the daemon

The model-visible text is **composed by the daemon from ledger fields it validated**: the work
key, the issue reference, the `scopeRef`, the nonce and, on claude-sdk, the acknowledgment
tool's exact name (a daemon constant, §6.7), framed `[agent:<label>]` with the
coordinator's operator-authored label (P §6.3), sanitized by the agent profile (P §6.4 step 7)
and bounded by `MAX_WAKE_TEXT_CHARS` (500, `session-wake.js`). **Nothing from the wire becomes
wake text, and issue titles, bodies and comments never do**: the worker reads the issue
itself, as untrusted data. Test: every command field fuzzed with control characters, reserved
sigils and over-length values is `invalid_input`, and the delivered text equals a template
rendered by an independent oracle; mutation: add a pass-through `note` field; positive
control: a clean dispatch renders the expected line.

## 8. Events, Hints and the Event Acknowledgment

- **Durable first; the semantics of one journal protocol.** Dispatch events are records of
  kind `event` **in the dispatch ledger**, appended before any hint is sent. The stream is
  **per principal**, keyed on the work key, with cursor `{ journalId, journalSeq }` and no
  session id. It reuses the cursor and gap **semantics** of S3's journal (`evicted`,
  `journal_reset`, `restart_loss`, `unknown_cursor`) and the P §7.2 subscribe, replay,
  live-fence and paged-read **wire shapes**, not the per-session `PrincipalJournal` store.
  Whether the wire uses a stream selector on the existing types or the sibling types of §7.1
  is §15 decision 10.
- **The daemon evaluates the §7.2 event codes deterministically**, no model involved. Besides
  those named where they arise: `work_started` (an attributed start), `dispatch_uncertain`,
  `state_unknown`, `reconciled` (per record), `decision_answered`, `command_denied` (per
  denial) and the §5.2 permission states as recorded.
- **A hint carries nothing**: an event id, a reason code and an opaque reference. No title,
  content, command or secret. At most one hint per coordinator per minute; several events
  share one. An unacknowledged event is re-hinted on a bounded schedule (§15 decision 8), then
  marked `hint_exhausted`; that is the **only** signal tied to an ACK, and it is informational.
- **The operator's attention list** (uncertain deliveries, overdue clocks, completed but
  unclosed attempts, `session_gone`, a latched ledger) covers **open attempts only**, from
  **ledger state alone**, never hints or ACKs; an `uncertain` delivery under a closed attempt
  is terminal history, its attempt outcome the exit.
- **The event ACK is the one observe-tier write**, and a **proposed amendment** to P §4 and
  P §11's definition of observe (§15 decision 14). `principal_event_ack` advances only the
  caller's **own** acknowledgment cursor on its **own** event stream. The cursor is **not a
  ledger record**: it is persisted durably in the **dispatch cursor store** (one 0600 file
  under the config dir, one record per principal, P §5.4 standard) before the reply. On the
  wire, `journalId` names the ledger's event-stream incarnation and `journalSeq` is the
  event's monotonic position in that principal's stream; each event record carries both
  beside its global `ledgerSeq`, which is not exposed on the stream. A failed cursor write
  returns `cursor_unavailable` and does **not** latch the ledger; over the limit is
  `rate_limited`. It changes no task, delivery or attempt state; an ACK past the head or for
  another stream is refused. It proves only that the principal **asserted** receipt.
- **Channels are one-way**: nothing arriving on a notification channel affects the daemon.
  With no open attempt nothing polls; otherwise a coordinator reads `principal_work_view`
  with `sinceVersion` or follows its subscription.

Tests: an event is on disk before its hint (fault-inject the append: no hint); a replayed hint
has no second effect; a forged hint on the channel causes no command; an adapter restart
mid-stream reports a gap; an event ACK changes no ledger record and none of the attention
list; a failed cursor write leaves dispatch unlatched. Mutation: send the hint before the
append; let an ACK clear an attention item; latch on a cursor failure. Positive control: one
event, one hint, one durable cursor advance.

## 9. Deadlines

**One durable timer mechanism, for dispatched attempts only** (slice D7). A deadline is a
ledger record `{ deadlineId, kind, workKey, expiresAt, leads[] }`; one daemon timer sleeps
until the earliest pending lead. Nothing polls and no model runs. The `ackBy` and
`firstActivityBy` clocks are set by the delivery slice (D3) and may run on a simple timer
until D7 lands.

| Deadline | Expiry from | Before expiry | At expiry |
|---|---|---|---|
| Permission decision window | The request's own `expiresAt` in the pending snapshot (hook-routed: `HOOK_PERMISSION_DECISION_WINDOW_MS`, `permission-deadlines.js`) | One reminder (`deadline_approaching`) at a lead (§15 decision 8) | The ending is recorded per §5.4; nothing is requested again or extended |
| `ackBy`, `firstActivityBy` | The dispatch, within configured maxima | none | `ack_overdue`, `start_overdue`, then a reconcile |
| Lease and credential expiry | The grant | One reminder | The grant's own behaviour (P §5.2, §3) |

**At most once:** a lead's event is keyed `(deadlineId, lead)` and recorded before it is
emitted. **Missed while down is reported** (`deadline_missed_while_down` at boot). **No
extension by any agent:** only the operator changes a cap or a deadline, and extending a
permission window would be a permission change, out of this design. **A timeout never makes
anything eligible** (§12.4).

Tests: a restart across a lead emits `deadline_missed_while_down` once; a replayed lead emits
nothing; a coordinator message attempting to change `ackBy` on an open attempt is refused
`scope_denied`; a dispatch with `ackBy` above the configured maximum is `invalid_input`.
Mutation: key reminders by time only; emit before recording. Positive control: a lead
reached while up emits exactly one event.

## 10. Restart and the Generation Fence

- **Boot generation.** At start the daemon increments `bootGen` and persists it with the
  durable standard **before** admitting any command; if that write is not confirmed, dispatch
  stays disabled for the boot. `bootGen` is stamped on reservations, deliveries, ACK parts and
  command results. A result from an older generation is valid history; a command naming an
  older generation as current is refused `stale_generation`.
- **Boot sequence, before the first admission:** the ledger is re-read under §6.1's rules
  (a torn tail truncated first); every `pending` delivery becomes `dropped:restart` (one audit
  record each, attempt closed, reservation released); S10 records keep their P §6.6 states
  and are not read for delivery state (§6.5); every `sending` delivery becomes `uncertain`;
  observed states become `unknown`; deadlines are swept (§9); a reconciliation pass runs.
- **Restart blocker.** An open reservation that has not reached work start, and any `sending`
  delivery, adds a reason to `computeDaemonIdleState` (`daemon-idle-state.js`), so the idle
  auto-deploy (#8324) does not restart the daemon under it. Fail safe: an unreadable ledger
  reads as not idle.

Tests: a real restart after each delivery state matches the §6.5 table; an unconfirmed
`bootGen` write refuses every dispatch; the idle probe reports the blocker with one open
reservation and drops it at work start. Mutation: admit before the sweep; omit the blocker.
Positive control: a ledger with no open reservation leaves the idle state unchanged.

## 11. Audit

This extends P §10.1 with **one writer** (§15 decision 6). Inside the synchronous step of
every effect, `auditOrRefuse` (S11, proposed in P) writes the **audit pre-effect record**
(the `[AUDIT]` line) **first**; its failure is `audit_unavailable` with no ledger append. The
ledger record follows through the same writer's confirmed-durable mode; a failed append gets
an outcome line. A delivery's P §6.4 gate 9 is satisfied by the pre-effect record of its
`sending` step, so there is **exactly one pre-effect record per effect**. **Every command and
every denial** leaves a record, and an outcome record follows every transition. Denials
record the type, principal, label and reason, **never the refused payload**; identical
denials within a minute collapse into one counter record. **Content is never logged**: wake
text and bodies are recorded as SHA-256 and length only (P §10.1).

Ledger record kinds: `command` (each command and outcome), `denial` (coalesced), `delivery`
(each outbox transition), `ack` (each worker ACK part), `observation` (each change of
observed state, with its evidence), `reconciliation` (sources, result, remainder), `event`
(§8), `decision` (request, answer, expiry, consumption), `deadline` (set, lead, expiry, miss)
and `system` (boot, generation, latch, torn tail, kill switch, store health). Envelope
fields: `v`, `ledgerSeq`, `ts`, `bootGen`, `kind`, `phase`, `actor { class, id, label }`
(`class` is `operator`, `principal`, `worker`, `reviewer` or `system`), `action`,
`commandId`, the work key, `result`, `reason`, references (reservation, `deliveryId`, session,
journal cursor), `content { sha256, len }` and `prev`, the hash of the previous record. The
`prev` chain lets an honest reader detect gaps and edits; within the same-user limit (§2) it
is **not** a defence. `principal_audit_read` returns records for tasks on sessions the caller
may observe and its own commands and denials only.

Test: a failed pre-effect write, and separately a failed append (ENOSPC, EBADF, unconfirmed
fsync), before **every** effect kind (reserve, send, ACK part, cancel, decision) yields no
effect, or no delivery plus an outcome line; the pre-effect record precedes each effect, once;
no payload marker appears in any record. Mutation: an always-successful writer; the ledger
record before the pre-effect line; two pre-effect records for a send; a logged body prefix.
Positive control: a healthy writer records every effect.

## 12. Acceptance Split

Two tracks that never borrow each other's evidence. A fixture pass is never cited as proof of a
real provider or channel, and a live wake is never cited as proof of dispatch.

### 12.1 Fixture first slice

A throwaway daemon with its own config dir, a test-inserted principal (no minting) and a
fixture provider that supplies turn causation: **ledger, reservation with the `session` pool,
durable idempotency, loopback delivery with its `ackBy` and `firstActivityBy` clocks (D3),
two-part ACK, one attributed start.** Out of scope: completion, successors beyond `s0`,
supersede, events and every external channel, the general deadline timer (D7), GitHub (a
fixture row), UI, anything on a long-running daemon. Cases, each with its mutation: happy
path; duplicate; changed payload; second dispatch; pool full; append failing (latched); torn
tail across two boots; each drop cause; the drop-versus-send race; restart at `pending` and at
`sending` (attributed starts 0 or 1, never 2); wrong nonce; another session's channel; no ACK
by `ackBy`; a gap; a stale view. **Proves** the ledger logic, nothing about a real provider.

### 12.2 Live wake acceptance

A real daemon, coordinator and channel, under its own authorization; no session is sent
anything. Hops, one correlation id throughout: a daemon-originated event, durable before any
send; the channel accepted the hint; the coordinator woke because of it, read the event over
its authenticated connection, and the daemon recorded its durable event ACK (an asserted
receipt, §8). Controls: channel disabled (no wake; the event stays readable); a hint replayed
(no second effect); a hint forged on the channel (no effect); an adapter restart mid-stream
(a gap, reconciled). **Proves** a wake arrived and its receipt was asserted. **Makes nothing
eligible and starts nothing.**

### 12.3 Live dispatch acceptance

A separate, separately authorized run after §12.1 and §12.2 pass and S2, S3 to S5, S8 to S11
and S14 land. Hops: one dispatch `accepted`; delivery `delivered`; a verified durable ACK;
**observed starts attributable to the delivery = 1**. Controls: the same command twice (one
reservation, a replay, count 1); a restart between `sending` and the ACK (`uncertain`,
nothing resent, count ≤ 1); a wrong nonce and another session's ACK (refused, audited); a
dispatch against an open attempt; an operator `close` from `uncertain` followed by a late ACK
(refused as fenced, raised as an event).
**Proves** one delivered, acknowledged, started task. **Neither acceptance proves**
completion, quality, behaviour while the host sleeps, or latency.

### 12.4 Landing order and dependent tasks

Proposed: S11 (the audit writer and kill switch) and S2 (dispatch roster) before any slice;
D1 (ledger, reducer, work key, generation, the P §3 roster amendment) before every other
D-slice; D2 (reservation, capacity, idempotency) and D3 (delivery and its `ackBy` and
`firstActivityBy` clocks, through S8 leases, S9 fence, queue and `via` marker, S10 dedup)
next; D4a (the in-process acknowledgment tool for claude-sdk, with its `permission-floor.md`
delta) and D5 (source-owned state, permission endings, reconciliation, on S3 to S5) before
the live dispatch acceptance; D6 (events) before the live wake acceptance; D7 (the general
deadline timer); D8 (completion, fencing, attributed starts on S14, the hook-routed timeout
signal) last. D4b (the hook-secret route, with its bearer-token-authority delta) is deferred
until claude-cli is targeted and is not required for the live dispatch acceptance.

A **dependent task** (the next task that depends on this one) becomes eligible only on
**independently proven completion**: a review record by someone other than the worker, bound
to the exact head, required checks green on that head, and the stated end condition verified.
The worker's declaration is not enough. **A timeout or a wake never makes anything eligible.**

## 13. What This Document Does Not Authorize

- No implementation beyond the §12.4 slices, each reviewed; nothing mints a principal.
- **No change to any P invariant** (deny-only answers, no agent-initiated lease request, the
  never table, the permission floor, `skipPermissions: false`, the auto-mode gates, every
  bound-client and strict-primary refusal). Proposed amendments to P: the `via: 'dispatch'`
  marker (§6.5), the admin roster (§7), the event-ACK own-cursor exception (§8). Proposed
  amendment outside P: the `permission-floor.md` delta of §6.7 (D4a), which changes no
  floored target and keeps the floor ahead of the new short-circuit.
- **Policy stays with its owners.** Eligibility, scheduling and capacity **policy** remain owned
  by #7823 and #6691; this document specifies only the admission checks a dispatch must pass,
  and its timers apply only to a dispatched attempt.
- No GitHub write-back, webhook intake, broker, REST plane or new P §3 grant dimension.
  Untouched: mailbox delivery (#7437), `session-wake.js` and its gates (dispatch never calls
  `wakeSession` or `wakeViaTurnInput`, §6.5), `POST /api/events`, the declared-status routes.
- **A second send within one attempt** (an operator or automatic resend) is out of this
  design. It, a coordinator supersede, a coordinator-registered successor, a new class
  reaching the ACK route, any other tool settled without a prompt, and the acknowledgment
  tool gaining a field or an effect each widen authority: reviewed at HIGH tier, left for the
  owner.

## 14. Residual Risks

- **Prompt-injection relay.** A steered coordinator can still point a worker at the wrong issue
  in its repository; the record, lease, closed envelope and daemon-built text bound the rest.
- **Closing an `uncertain` attempt** may leave a worker the old send started; the operator
  accepts that on the shown evidence, and the fenced attempt's late reports are refused (§6.8).
- **Closing a `delivered` attempt** whose worker still runs leaves it running beside a new
  attempt; it is fenced, and the operator should cancel first or wait for the turn to end.
- **`rejected:not_dispatched` is known unsent** only as far as the provider's `zero_effect`
  verdict is truthful, a trusted input defined by the P §6.9 write boundary.
- **A lost or subagent acknowledgment.** On claude-sdk part 2 is lost when the turn ends
  before the call lands; the delivery then lacks part 2 (`ack_overdue`), handled by §6.6 and
  §6.8 and never by a resend. A subagent of the session can make the call, and v1 accepts it
  as the session's own (§6.7).
- Pointers: completed attempts hold capacity until closed (§5.2); same-user containment (§2);
  part 2 proves receipt only (§6.7); unattributed starts before S14 (§6.6); the event ACK is an
  assertion (§8); `uncertain` costs operator attention (§6.8); hook-routed timeouts read
  `reason_unknown` (§5.4); provider coverage and eligibility freshness (§15 decisions 2, 11).
- **New data at rest**: ids, hashes and references in the ledger and cursor store, 0600.

## 15. Decisions Needed at the Gate

| # | Decision | Recommendation | Default until decided |
|---|---|---|---|
| 1 | Channel for the worker ACK (§6.7) | claude-sdk: daemon-defined in-process tool, no credential (§6.7). Hook secret plus `POST /task-ack` retained for claude-cli, deferred | No part 2; the live dispatch acceptance cannot pass |
| 2 | v1 target providers | Those with both an acceptance signal and an acknowledgment channel: claude-sdk (`SdkSession` itself; `DockerSdkSession` and any other subclass `target_unsupported` until tested) today; claude-cli (`CliSession`) when its route slice (D4b) lands; others `target_unsupported` | As recommended |
| 3 | Tier required to dispatch | drive, with a live lease on the target | drive |
| 4 | Who registers a successor session | Operator only in v1 | Operator only |
| 5 | Where the eligibility read runs and with what credential | Daemon-side, read-only, under the operator's existing local configuration; the fixture slice uses a fixture row | No live dispatch |
| 6 | One audit writer | S11's writer writes the pre-effect line and, in its confirmed-durable mode, the ledger record | No slice that writes merges with two writers |
| 7 | Idempotency tombstone after a task closes | 7 days (the credential maximum) | 7 days |
| 8 | Re-hint schedule and reminder leads | 3 hints over 15 minutes; permission reminder 120 s before expiry | As recommended |
| 9 | Hint channel for the live wake acceptance | An operator-configured outbound sink or a local bridge | None; the live wake acceptance waits |
| 10 | Dispatch event stream wire shape | Sibling `principal_dispatch_*` types with the P §7.2 shapes, leaving the session-journal handlers unchanged | Sibling types |
| 11 | Eligibility read staleness limit | 10 minutes | 10 minutes |
| 12 | Observation freshness window | 120 seconds | 120 seconds |
| 13 | Limits (excess refused `rate_limited` unless stated) | Dispatch: 6 per principal per minute. Cancel: 6 per principal per minute. Reconcile: 1 per attempt per minute. Decision requests: 1 per minute, 20 open per principal. Event ACK: 1 cursor write per principal per second. Worker ACK: 10 per session per minute, across either channel (tool or route). Attempts per task: 3 (`attempt_cap_reached`; raised only by the operator's `raise_cap`). Idempotency records: 10 000 per principal (`dispatch_capacity`). `ackBy` ≤ 10 minutes, `firstActivityBy` ≤ 30 minutes. Retention: closed tasks compacted to a snapshot after the 7-day tombstone, `RunLedger`-style | As recommended |
| 14 | Event-ACK tier | Accept the own-cursor observe exception (§8) as an amendment to P §4 and §11 | Require drive tier for `principal_event_ack` |
