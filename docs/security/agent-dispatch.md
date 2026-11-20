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
`7442b39ff`; everything else is *proposed*. Where it depends on a mechanism that
[`agent-principals.md`](agent-principals.md) itself marks proposed (`auditOrRefuse`, leases,
the delivery fence, `turn_started`), it depends on that child landing and adds nothing to it.
This document **extends agent-principals by reference and never loosens it**: every gate,
refusal and invariant there applies to every message here; the few places it proposes an
amendment to P say so. Every guard must be proven to fail
([`../false-safety-guards.md`](../false-safety-guards.md)); agent-principals §4.4 states the
common test rules, and each guard below names its test, mutation and positive control.

Conventions: "P §n" is a section of [`agent-principals.md`](agent-principals.md); S-numbers
are the children of #9112 listed in P §12; D-numbers (D1 to D8) are this document's slices
(§12.4). "Owner" and "operator" denote the same person, as in agent-principals. Companions:
P, [`bearer-token-authority.md`](bearer-token-authority.md),
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
2. **Only the operator can decide that a delivery did not land, or send it again.**
   Evidence may move an uncertain delivery toward "delivered" (§6.8); nothing moves it the
   other way. A delivery the daemon *knows* was never sent is dropped (§6.5), which is not a
   redispatch. No timeout anywhere in this design starts a second worker.
3. **A human always wins** (P §1, §5.3). A dispatch never pre-empts human input, never
   takes the primary role and never writes to the human's queue.

## 2. Trust Boundaries and Honest Limits

```
[operator] ──primary, loopback──▶ [daemon] ◀──principal token, loopback── [coordinator]
                                   │   ▲  └──read-only──▶ [GitHub]              ▲
              wake text (input     │   │ ACK part 2 (per-session secret)        │ hint only:
              contract, §6.5)      ▼   │                                        │ id, code, ref
                               [worker session]                  [notification channel]
```

| Zone | Trust | Holds |
|---|---|---|
| Coordinator agent | **Untrusted for content, semi-trusted for identity**, as P §2. Its identity is the principal grant and the coordinator-of-record record, never its label in text. | one principal token |
| Worker session | **Untrusted for content.** Its output, declarations and anything it sends are data. Its identity is assigned by the daemon (the session the daemon spawned), never asserted by the caller. | its own per-session secret (§6.7) |
| Reviewer | A separate identity from the worker and the coordinator. A review record is evidence, never authority. | no channel in v1 |
| Notification channel | **Untrusted, outbound only** (§8). | nothing of chroxy's beyond the hint |
| GitHub | A data source read with the read time recorded. Issue state and labels are trusted only as of that read; titles, bodies and comments are untrusted text. | — |
| Daemon host | Trusted ([`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries)). | everything |

**The same-user limit applies unchanged** (P §2). Dispatch adds attribution, guardrails and
a durable record for a cooperative but fallible agent; it is **not a sandbox** against a
hostile local process, and inside the worker anything in its process tree can present the
worker's per-session secret (§6.7).

**Untrusted content.** Issue text, pull request comments, worker output, review text and
anything arriving on a notification channel are data, never wake text, an instruction, an
eligibility verdict or an authority. **No broker, no write-back:** the ledger is a local
durable journal, GitHub is **read-only** to the dispatcher, and principals stay refused on
every HTTP route (P §4.5).

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
the key; one delivery's tries at the provider are **sends** (§6.5).

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

Tests. (a) **Every record carries the full key**: the test enumerates the ledger's record
kinds from an independently written list, checked in both directions against the
reducer's kinds, and asserts each fixture record has all four parts; mutation: drop
`successor` from the delivery record; positive control: a complete record passes.
(b) **Stale successor**: a cancel and an ACK naming `s0` after `s1` is registered are refused;
mutation: compare `attempt` only; positive control: the same messages at `s1` succeed.
(c) **Attempt monotonicity** across an unclean restart, against an independent oracle
sequence; mutation: derive the next attempt from the in-memory count.

## 4. Roles and What Each May Do

| Action | Operator | Coordinator of record | Other principal | Worker (own attempt) | Reviewer | Notification channel |
|---|---|---|---|---|---|---|
| Read work view, dispatch events, audit in scope | yes | yes | observe grant, sessions it may see | no | no channel in v1 | no |
| Dispatch | no channel in v1 | yes | no (`not_coordinator_of_record`) | no | no | no |
| Cancel; request a reconcile pass | passes run on the daemon's timer | yes | no | no | no | no |
| Request an owner decision | — | yes | no | no channel in v1 | no channel in v1 | no |
| Register a successor session | yes | no in v1 (§15 decision 4) | no | no | no | no |
| Resolve an attempt (adopt, resend, close, supersede, operator cancel) | yes (§6.8) | **no** | no | no | no | no |
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

Tests. A fixture per row asserts the recorded ending, including a snapshot read at the
instant of a `permission_expired` that still lists the request and an answerer reply that
changes nothing; a `permission_expired` then `cleared` pair records one ending; a question
ending records nothing. Mutation: map `permission_expired` to `permission_timed_out`; treat
a resolution with neither `reason` nor `resolvedBy` as a deny; record the second frame as a
second ending. Positive control: an in-process timeout records `permission_timed_out`, and a
hook-routed deny records `permission_denied`. **Roster:** a syntax-tree test enumerates every
`permission_resolved` and `permission_expired` emit and send site, question sites included
and classified explicitly, modelled on `tests/permission-resolved-by-roster.test.js` (P §9),
and fails on a site absent from the classification constant this table mirrors; mutation:
add an unclassified emit site.

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
after their tombstone (§15 decision 13), snapshot plus journal, as `RunLedger` does.

**Every ledger transition is a synchronous check-and-append** against the reducer's current
state, exactly like the commit step of §6.2: the precondition is evaluated and the record
appended in one synchronous step, so no other transition interleaves; a precondition that no
longer holds refuses the transition instead of writing it.

**A failed append latches dispatch off.** An append that throws or is not confirmed durable
refuses every later command `ledger_unavailable`, and every new `sending` transition, until
the next boot re-reads the ledger; nothing is retried in-process. Where a written but
unconfirmed record may exist, the guarantee is **no delivery**, not "no record": the boot
sweep settles it (§10). **At boot:** a torn **final** record (an incomplete line) is copied to
a side file, the journal is **durably truncated** to the last good record, and only then is a
`system` record appended, so no later boot sees a bad record mid-file; dispatch proceeds. An
unreadable or invalid record **before** the final one, an unknown record version `v`, an
unknown record kind, a wrong mode or owner, or a symlink **disables dispatch**, and
`chroxy doctor` names the recovery.

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
5. **Scope** — tier ≥ drive **and** `principalMaySee(client, sessionId, 'drive')` called for
   grant and tier only, without the lease option — `scope_denied`.
6. **Lease and `gen`** — `lease_required`, `lease_stale`, `lease_suspended`.
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
    `pending`, the deadlines and the semantic hash, under one work key and `bootGen`, so they
    cannot disagree. The append and its fsync are **synchronous calls** inside the step, as
    `writeDurableFile` (`durable-write.js`) is synchronous, so no other command interleaves.
    An implementation that appends with asynchronous I/O must instead serialize every commit
    through one writer and count **in-flight** reservations in the idempotency, attempt and
    capacity gates. If the append is not confirmed durable there is **no delivery** (memory
    is not advanced), the reply is `ledger_unavailable`, an outcome line records the failure,
    and §6.1's latch is set.
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
`ledger_unavailable`; mutation: reply before the fsync verdict. (d) **Synchronous path:** a
spy on the append injects, inside it, a second command for the same task and one for a full
pool; neither is admitted until the first commit returns; mutation: an asynchronous append
without the serializer. An asynchronous implementation must also pass both cases against a
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
- `principal_task_cancel`, `principal_task_reconcile` and `principal_decision_request` follow
  the same `(principalId, commandId)` rule, each hashing its own semantic fields.
- A record lives **as long as the task plus a tombstone** of at least the credential's
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
`entry.session.sendMessage(text, attachments, { clientMessageId, onInputAdmission, … })` in
that handler, and the CI-completion wake through the same provider call from
`wakeViaTurnInput` (`session-wake.js`). That call and its admission report are the
**turn-input seam**. **A dispatch delivery** goes through the principal input path S9 adds
behind `handleInput`: framing (P §6.2, §6.3), the fence (P §6.4), the agent delivery lock and
queue (P §6.5) and the provider write boundary (P §6.9), ending in that same `sendMessage`
call with the send's `sendId` as `clientMessageId`. It adds **no second send path** and never
calls `wakeSession` or `wakeViaTurnInput`, so session-wake.js's gates (idle only, the PTY
route, `sanitizeWakeText`) do not apply; only `MAX_WAKE_TEXT_CHARS` is reused (§7.3).

Queue entries are tagged with the coordinator's **`principalId`**, so kill, revoke and
"agents off" drains reach them, plus a **`via: 'dispatch'`** marker, a **proposed extension of
P §6.5 owned by S9**. The agent queue stays non-durable; for a dispatch delivery **the ledger
is authoritative**.

| Delivery state | Written when | After a daemon restart |
|---|---|---|
| `pending` | With the reservation, and while the fence holds the queued entry (`fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`, `fenced_busy`) | `dropped:restart` |
| `sending` | **Persisted before the provider is called**, with a `sendId` and the nonce hash (§6.6) | `uncertain` |
| `delivered` | An **acceptance signal belonging to that turn** (below), §6.8's safe reconciliation, or an operator `adopt` (basis `operator`) | `delivered` |
| `rejected:not_dispatched` | A provider `zero_effect` outcome that is not a fence cause | terminal |
| `dropped:<reason>` | **Only from `pending`**, on any P §6.5 drop cause: `session_end`, `restart`, `lease_expired`, `lease_stale`, `lease_suspended`, `lease_released`, `revoked`, `killed`, `agents_off` (per-session or global), the queue TTL (`expired`), a cancel (`cancelled`), or a coordinator swap (`coordinator_changed`) | terminal |
| `uncertain` | A provider `uncertain` outcome, a lost transport, a restart during `sending`, or a drop cause that arrives during `sending` | `uncertain` (§6.8) |

**Drop versus send is serialized.** The `pending` → `sending` transition and every drop are
taken under the **per-session agent delivery lock** and each is a synchronous check-and-append
(§6.1), so exactly one of them wins. In the same synchronous step that appends `sending`,
immediately before the provider call, credential, kill switch, "agents off", lease and `gen`
are re-validated against the values **current at send time**, never the command's stored
`leaseId`/`gen`. A drop cause that arrives once the delivery is `sending` yields `uncertain`,
never `dropped`; one that arrives at `delivered` changes no delivery state. A kill, revoke or
"agents off" drain removes the queue entry even if its ledger append fails (the latch is then
set); the ledger catches up at the boot sweep, where a `pending` record becomes
`dropped:restart`. Nothing reaches the provider before `sending` is persisted, so an S10
durable-dedup record (P §6.6) for a dispatch send found in `reserved` or `committed(queued)`
at boot is reclassified `dropped:restart`, not `uncertain`.

A **dropped** or **rejected** delivery is therefore **known unsent**: one audit record, the
attempt closes `dropped` (`cancelled` when the cause is a cancel), and its reservation and
capacity are released by that recorded transition, with a `delivery_dropped` event. A later
dispatch is a new command and a new attempt; that is not a blind redispatch.

**The acceptance signal** is the provider's `onInputAdmission` report `{ status: 'accepted',
delivery: 'dispatch_started' }` for the send's `clientMessageId`, on a provider that declares
the seam (`capabilities.daemonTurnInput === true`, read by `supportsDaemonTurnInput` in
`session-wake.js`); a `queued` admission is **not** delivery. On claude-tui, a PTY write that
returns true is a write, not an acceptance; a claude-tui delivery needs a turn start caused
by it (S14's proposed `turn_started { causedBy }`) and the composer detector that P §6.9 gates
principal input on.

Tests. Each drop cause at `pending` yields `dropped:<reason>`, one audit record, a released
reservation and **zero sends**. **Race:** a cancel, a lease loss and a revoke injected at the
`sending` append each yield either (`dropped`, zero sends) or (`sending` then `uncertain`),
never (`dropped` and sent). A fixture provider that admits, queues then admits, rejects and
fails mid-write maps to `delivered`, `pending` then `delivered`, `rejected:not_dispatched` and
`uncertain`. Mutation: allow a drop from `sending`; keep `pending` across a kill; mark
`delivered` on `queued`; persist `sending` after the provider call; send under the stored
`gen`. Positive control: an undisturbed delivery sends once and is `delivered`.

### 6.6 The two-part acknowledgment and the observed start

- **Part 1, daemon-observed**: the provider accepted the turn that carried this send (§6.5).
- **Part 2, worker-returned.** A **nonce** (128 random bits) is generated when a **send** is
  created; its `sending` record carries the `sendId` and the nonce **hash**, and the plaintext
  exists only in memory while the wake text is built. An operator `resend` (§6.8) creates a
  **new** `sendId` (a new `clientMessageId`, so it does not collide with P §6.6 dedup) and a
  new nonce. The worker returns the nonce through the route of §6.7. In one synchronous step
  the daemon checks that the credential resolves to exactly one session, the delivery's
  target (`wrong_session`), at the **current successor** (`ack_stale_successor`); the delivery
  is `sending`, `delivered` or `uncertain` (`delivery_not_open`); the attempt is open
  (`attempt_closed`); and the nonce matches (constant-time) the hash of one of that
  delivery's sends (`nonce_mismatch`). It records part 2 durably with the send it matched;
  against `uncertain`, part 2 is evidence and reconciles toward `delivered` (§6.8). The nonce
  binds the ACK to the send, the credential binds it to the session; the nonce is not a
  secret and confers nothing alone.
- A **verified durable ACK** is both parts on disk under the same work key and `sendId`. Each
  part records its own `bootGen`. Either part alone is shown as what it is.
- **Work start** is a third fact: the first tool event (`tool_start` in the session journal)
  in the target session after part 1, **in the turn that send caused**. It is observed,
  **never declared**. Attribution needs S14's `turn_started { causedBy }`; until then a tool
  event after part 1 is recorded as an **unattributed start** (`start_unattributed`) and
  cannot satisfy the live dispatch acceptance (the fixture provider supplies causation).
- **Starts are counted per attempt and delivery**, summed over all sends of the delivery. The
  acceptance quantity is "observed starts attributable to the delivery": **0, 1, more than 1,
  or unknown**; a journal gap yields `unknown`, never 0. Counting **detects** a second start
  (`second_start`); the reservation and uncertainty rules are what **prevent** one.
- **Overdue clocks emit events and a reconcile, nothing else**: `ack_overdue` at `ackBy`,
  `start_overdue` at `firstActivityBy`. These two clocks belong to the delivery slice (D3).

Test: part 2 before part 1 is recorded as part 2 only; part 2 against an `uncertain` delivery
moves it to `delivered`; part 2 matching the first of two sends records that send; a declared
"started" with no tool event records no start; a gap reads `unknown`; starts across two sends
are summed. Mutation: accept a declared start; drop the successor check; count a gap as 0;
count per send only. Positive control: both parts and one attributed tool event yield a
verified ACK and a count of 1.

### 6.7 The worker acknowledgment credential (§15 decision 1)

**The declared-status channel cannot carry part 2.** Its `hook` source (`POST /api/events`,
`event-ingest.js`) lets the caller **name** the session; its `api` source
(`POST /api/sessions/:id/status`, `http-routes.js`) accepts a primary token for **any** session
named in the path and a pairing token only for its bound session; and its schema
(`DeclaredStatusInputSchema`, `packages/protocol/src/schemas/declared-status.ts`) is
`.strict()` with no field for a delivery id or a nonce. Part 2 needs **its own small message**,
authenticated by a class already bound to exactly one session, so the daemon, not the caller,
decides which session is speaking. The classes of
[`bearer-token-authority.md` §2](bearer-token-authority.md#2-the-four-token-classes):

| Class | Bound to one session? | What else it can do | Verdict |
|---|---|---|---|
| Primary token | no | everything | refuse |
| Pairing-bound session token | yes (`generateBoundPairing`, `pairing.js`) | input, permission answers and declared-status writes **for that session** | refuse: a worker holding it could answer its own permission prompts |
| **Per-session hook secret** | **yes**: minted per session by `CliSession` (`cli-session.js`) and `ClaudeTuiSession` (`claude-tui-session.js`), in memory only, never persisted, not accepted for WebSocket auth; **exported to the child only when a port is configured** (and, for claude-tui, permissions are enabled); `_findSessionByHookSecret` (`ws-server.js`) resolves the owner session from the secret | today only `POST /permission` and `POST /permission-floor`, which create a prompt for that session or read | **recommend** |
| Daemon-level ingest secret | no: daemon-wide; the caller names the session | notifications, declared status, mailbox wakeups | refuse |
| Agent principal | no; a worker is not a principal | its tier | refuse |
| Discord-return secret | not built; channel-scoped | — | refuse |

**Recommendation:** the per-session hook secret, extended by **one** hook route
(`POST /task-ack`, proposed; §15 decision 1), body exactly `{ deliveryId, nonce }`, ≤ 512
bytes. Requirements: **loopback only** (`isLoopbackPeer`, `connection-locality.js`, before the
token check, per bearer-token-authority §9 step 3); the session resolved by constant-time
comparison to a **non-null session id**, with **no fallback** to any other class (the
`_validateHookAuth` primary-token fallback does not apply); every other class refused; a
per-session rate limit (§15 decision 13); the route on the P §4.5 HTTP roster. The reply is
`{ ok: true }` or **one uniform refusal**, a deliberate departure from bearer-token-authority
§9 step 2: the caller's tools are untrusted, and a specific reason would make the route an
oracle for other sessions' deliveries; the audit records the specific reason.

**What it must not be able to do:** answer, create or extend any permission request; send
input; interrupt; read any session data, roster, journal or ledger; write declared status;
acknowledge for another session or an older successor; register a successor; change any
ledger state other than recording part 2. **The bearer-token-authority delta it needs**
(with D4, at HIGH): the §1 trust sentence, §5, the §7 lifecycle table, the §9 step 1 class
list, and an entry in `tests/http-routes-scoped-token.test.js`. It would be the **first
hook-secret route that writes durable state**, so §5's reasoning that this class causes
nothing beyond a prompt or a read (the "strictly less" argument made for
`POST /permission-floor`) must be re-argued there, not assumed.

**Honest limits.** The secret is in the worker's process environment (the `cli-session.js`
comment beside it says so), so anything in that process tree can present it: part 2 proves
the nonce came from **inside that session's process tree**, evidence of receipt, not of
intent or authority. Providers that mint no hook secret (claude-sdk, Codex, ACP) cannot
produce part 2 and claude-tui cannot yet produce part 1 (§6.5); hence §15 decision 2.

Test: an ACK presented with each refused class, from a non-loopback peer, with another
session's secret, with an older successor's secret and with a wrong nonce is refused
uniformly and audited with the specific reason; mutation: take the session from the body, or
drop the nonce check; positive control: the target session's secret with the right nonce
records part 2.

### 6.8 Uncertainty, attempt close and no blind redispatch

`uncertain` means the delivery may have been accepted. Reconciliation may move it to
`delivered` **only in the safe direction**: when the session journal positively shows the
input admitted under one of the delivery's `sendId`s (`admission_observed`), or when a valid
part 2 arrives. It **never** concludes "not sent", resends or releases; a continuous journal
with no admission leaves it `uncertain`, as does a gap. While an attempt is open or uncertain
a new dispatch for the task is refused (`attempt_open`, `attempt_uncertain`). A target session
that disappears makes the attempt `unknown`, emits `session_gone`, and waits for `close`.

**Operator verbs** (`principal_admin_task_resolve`). Before acting on an `uncertain` delivery
the operator is **shown the reconcile evidence**.

| Verb | Valid from | Effect |
|---|---|---|
| `adopt` | `uncertain` only | The operator asserts the delivery landed: `delivered`, basis `operator` |
| `resend` | `uncertain` only | A new send (§6.6) to the same target; its `sending` append re-checks in the same synchronous step that the delivery is **still** `uncertain`, else refused `delivery_not_uncertain` |
| `cancel` | any open attempt | As a coordinator cancel (below), including the interrupt rule |
| `close` | any state | The attempt closes `closed`; reservation and capacity released |
| `supersede` | any open or uncertain attempt | Closes it `superseded` and fences it; it does **not** dispatch: a later dispatch command creates the next attempt |

**Attempt-close transitions that exist before the completion slice:** `dropped` (§6.5),
`cancelled`, `closed` and `superseded`. Each releases the reservation by its recorded
transition; nothing else does, and every open attempt is on the operator's attention list
(§8), so no reservation is held without an operator-visible state. A superseded or closed
attempt is **fenced**: a late ACK, start or report from it is refused and raised as
`late_report_refused`, so an old worker cannot overwrite the attempt that replaced it.
**Supersede is operator-only** until completion fencing exists; no coordinator message asks.

**Cancel** (`principal_task_cancel`) runs gates 1 to 10 of §6.2, then checks the work key's
successor (`stale_successor`) and, before any interrupt, the P §4.1.1 interrupt envelope rules
and the P §4.1.3 fences (`fenced_pty_dirty`, `fenced_human_active`, `human_queue_nonempty`, and
answer scope while a prompt is pending). Its command result embeds the P §7.4 interrupt-ack
fields (`status`, `reason?`).

| Delivery state | Cancel outcome |
|---|---|
| `pending` | `dropped:cancelled`; the attempt closes `cancelled` |
| `sending` | `cancel_requested` is recorded; when the delivery settles at `delivered`, the `delivered` rule applies after gates 3 to 7 and the P §4.1.3 fences are re-run at apply time (a refusal records `cancel_not_applicable`); at `uncertain` (including by restart), a `cancel_not_applied` record and event, nothing interrupted |
| `delivered` | Interrupt **only** if the session's current turn was caused by this delivery (S14); otherwise `cancel_not_applicable`, so a human's turn is never interrupted by a dispatch cancel |
| `uncertain` | Refused `attempt_uncertain` |
| `rejected`, `dropped`, or a closed attempt | `cancel_not_applicable` |

Tests: a restart during `sending`, then every reconcile outcome, leaves at most one attributed
start and no second delivery; a `resend` raced with a part 2 arrival is refused
`delivery_not_uncertain`; a cancel while a human's turn runs interrupts nothing; a cancel
requested during `sending` that settles `uncertain` interrupts nothing; a vanished session
waits for `close`. Mutation: resend on a continuous empty journal; resend without the
still-`uncertain` re-check; interrupt any running turn on cancel. Positive control: an
operator `resend` delivers once.

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
| `principal_admin_task_resolve` | operator | `type, requestId, workKey, action` | direct reply |
| `principal_admin_successor_register` | operator | `type, requestId, workKey, sessionId, handoffRef` | direct reply |
| `principal_admin_decision_answer` | operator | `type, requestId, decisionId, answer` | direct reply |
| `POST /task-ack` (proposed; §15 decision 1) | worker, per-session hook secret | `deliveryId, nonce` | `{ ok: true }` or the uniform refusal |

Every coordinator command is rate-limited (§15 decision 13). **No free-text field exists on
any coordinator command.** `scopeRef` and the decision `*Ref` fields are references
(`^[a-z0-9._/-]{1,64}$`), not prose. The journal position on the wire is `journalSeq` (P §4.1),
never `seq`, which the transport stamps on every frame.

### 7.2 Reasons and event codes

Every code used in this document appears in this table, and a code reused across channels
keeps one meaning.

| Channel | Codes |
|---|---|
| Command refusals | `scope_denied`, `agents_off`, `lease_required`, `lease_stale`, `lease_suspended`, `not_coordinator_of_record`, `invalid_input`, `payload_mismatch`, `dispatch_capacity`, `rate_limited`, `stale_generation`, `stale_view`, `stale_successor`, `backlog_stale`, `issue_not_eligible`, `issue_held`, `attempt_open`, `attempt_uncertain`, `attempt_cap_reached`, `target_unsupported`, `target_blocked:<code>`, `target_human_active`, `target_repo_mismatch`, `capacity_unavailable`, `audit_unavailable`, `ledger_unavailable`, `delivery_not_uncertain`, `cursor_unavailable` |
| P §6.7 codes reused (fences and queue) | `fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`, `fenced_busy`, `human_queue_nonempty`, `agent_queue_full` |
| Command result | `accepted` (a repeat carries `replayed: true` and the current state); cancel outcomes `cancel_requested`, `cancel_not_applicable`, `cancel_not_applied` |
| Worker ACK route (audit only; one uniform refusal on the wire) | `nonce_mismatch`, `wrong_session`, `ack_stale_successor`, `delivery_not_open`, `attempt_closed` |
| Delivery states | `pending`, `sending`, `delivered`, `rejected:not_dispatched`, `dropped:<reason>` (`session_end`, `restart`, `lease_expired`, `lease_stale`, `lease_suspended`, `lease_released`, `revoked`, `killed`, `agents_off`, `expired`, `cancelled`, `coordinator_changed`), `uncertain` |
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
key, the issue reference, the `scopeRef` and the nonce, framed `[agent:<label>]` with the
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
  unclosed attempts, `session_gone`, a latched ledger) is derived from **ledger state alone**,
  never from hints or acknowledgments.
- **The event ACK is the one observe-tier write**, and a **proposed amendment** to P §4 and
  P §11's definition of observe (§15 decision 14). `principal_event_ack` advances only the
  caller's **own** acknowledgment cursor on its **own** event stream. The cursor is **not a
  ledger record**: it is persisted durably in its own per-principal cursor record before the
  reply; a failed cursor write returns `cursor_unavailable` and does **not** set the ledger
  latch; over the limit is `rate_limited`. It changes no task, delivery or attempt state, and
  an ACK past the head or for another principal's stream is refused. It proves the principal
  **asserted** receipt, nothing about reading.
- **Channels are one-way.** Nothing arriving on a notification channel is a command; a reply,
  reaction or forwarded hint has no effect on the daemon. With no open attempt nothing polls;
  otherwise a coordinator reads `principal_work_view` with `sinceVersion` or follows its
  subscription.

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
  record each, attempt closed, reservation released); every S10 dedup record of a dispatch
  send in `reserved` or `committed(queued)` is reclassified `dropped:restart` (§6.5); every
  `sending` delivery becomes `uncertain`; every attempt's observed state becomes `unknown`;
  deadlines are swept (§9); a reconciliation pass runs (§5.3).
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
`commandId`, the work key, `result`, `reason`, references (reservation, `sendId`, session,
journal cursor), `content { sha256, len }` and `prev`, the hash of the previous record. The
`prev` chain lets an honest reader detect gaps and edits; within the same-user limit (§2) it
is **not** a defence. `principal_audit_read` returns records for tasks on sessions the caller
may observe and its own commands and denials only.

Test: inject a failure of the pre-effect write and, separately, of the ledger append (ENOSPC,
EBADF, unconfirmed fsync) before **every** effect kind (reserve, send, ACK part, cancel,
decision) and assert no effect for the first and no delivery plus an outcome line for the
second; assert the pre-effect record precedes the effect and exists once per effect; assert
a payload marker never appears in any record. Mutation: make the writer report success
unconditionally; append the ledger record before the pre-effect line; write a second
pre-effect record for a send; log a body prefix. Positive control: with a healthy writer each
effect occurs with its records.

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
path; duplicate; same id, different semantic payload; second dispatch for the task; pool
full; append failing (no delivery, latched); torn tail across two boots; each drop cause; the
drop-versus-send race; restart with `pending` and during `sending` (attributed starts 0 or 1,
never 2); wrong nonce; another session's secret; no ACK by `ackBy`; a gap (`unknown`); a
stale view. **Proves** the ledger logic, nothing about a real provider, session or channel.

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
dispatch against an open attempt; an operator `resend` of an `uncertain` delivery whose
original landed (evidence shown first; the second start detected as `second_start`).
**Proves** one delivered, acknowledged, started task. **Neither acceptance proves**
completion, quality, behaviour while the host sleeps, or latency.

### 12.4 Landing order and dependent tasks

Proposed: S11 (the audit writer and kill switch) and S2 (dispatch roster) before any slice;
D1 (ledger, reducer, work key, generation, the P §3 roster amendment) before every other
D-slice; D2 (reservation, capacity, idempotency) and D3 (delivery and its `ackBy` and
`firstActivityBy` clocks, through S8 leases, S9 fence, queue and `via` marker, S10 dedup)
next; D4 (worker ACK route, with its bearer-token-authority delta) and D5 (source-owned
state, permission endings, reconciliation, on S3 to S5) before the live dispatch acceptance;
D6 (events) before the live wake acceptance; D7 (the general deadline timer); D8
(completion, fencing, attributed starts on S14, the hook-routed timeout signal) last.

A **dependent task** (the next task that depends on this one) becomes eligible only on
**independently proven completion**: a review record by someone other than the worker, bound
to the exact head, required checks green on that head, and the stated end condition verified.
The worker's declaration is not enough. **A timeout or a wake never makes anything eligible.**

## 13. What This Document Does Not Authorize

- No implementation beyond the slices of §12.4, each under its own review; nothing here mints a
  principal or enables `grant`.
- **No change to any P invariant** (deny-only answers, no agent-initiated lease request, the
  never table, the permission floor, `skipPermissions: false`, the auto-mode gates, every
  bound-client and strict-primary refusal). Proposed amendments to P: the `via: 'dispatch'`
  marker (§6.5), the admin roster (§7), the event-ACK own-cursor exception (§8).
- **Policy stays with its owners.** Eligibility, scheduling and capacity **policy** remain owned
  by #7823 and #6691; this document specifies only the admission checks a dispatch must pass,
  and its timers apply only to a dispatched attempt.
- No GitHub write-back, webhook intake, broker, REST plane or new P §3 grant dimension.
  Untouched: mailbox delivery (#7437); `session-wake.js` and its gates (a dispatch delivery
  goes through the principal input path and the provider's `sendMessage` seam, never through
  `wakeSession` or `wakeViaTurnInput`, §6.5); `POST /api/events` and the declared-status
  routes.
- A PR that widens dispatch authority (a coordinator supersede, an automatic resend, a
  coordinator-registered successor, a new class reaching the ACK route) is reviewed at HIGH
  tier against this document and left for the owner to merge.

## 14. Residual Risks

- **Prompt-injection relay.** A coordinator that reads issues and session output can be steered
  by them; the record, the lease, the closed envelope and the daemon-built text bound it, but a
  dispatch can still point a worker at the wrong issue within its repository.
- **Operator resend can double-start** if the original landed unobserved; the evidence is shown
  first and a second start is detected, not prevented (§6.8).
- **Completed attempts hold capacity** until the operator closes them, before D8 (§5.2).
- Pointers: same-user containment (§2); part 2 is evidence of receipt only (§6.7); unattributed
  starts before S14 (§6.6); the event ACK is an assertion (§8); every `uncertain` delivery
  costs operator attention (§6.8); hook-routed timeouts read `reason_unknown` (§5.4); provider
  coverage (§15 decision 2); eligibility is as fresh as the last read (§15 decision 11).
- **New data at rest**: work keys, ids, hashes and references, 0600 under the config dir.

## 15. Decisions Needed at the Gate

| # | Decision | Recommendation | Default until decided |
|---|---|---|---|
| 1 | Credential for the worker ACK (§6.7) | Per-session hook secret plus `POST /task-ack` | No part 2; the live dispatch acceptance cannot pass |
| 2 | v1 target providers | Those with both an acceptance signal and a hook secret: claude-cli (`CliSession`) today; others `target_unsupported` | As recommended |
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
| 13 | Limits (excess refused `rate_limited` unless stated) | Dispatch: 6 per principal per minute. Cancel: 6 per principal per minute. Reconcile: 1 per attempt per minute. Decision requests: 1 per minute, 20 open per principal. Event ACK: 1 cursor write per principal per second. Worker ACK route: 10 per session per minute. Attempts per task: 3 (`attempt_cap_reached`; only the operator raises it). Idempotency records: 10 000 per principal (`dispatch_capacity`). `ackBy` ≤ 10 minutes, `firstActivityBy` ≤ 30 minutes. Retention: closed tasks compacted to a snapshot after the 7-day tombstone, `RunLedger`-style | As recommended |
| 14 | Event-ACK tier | Accept the own-cursor observe exception (§8) as an amendment to P §4 and §11 | Require drive tier for `principal_event_ack` |
