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
refusal and invariant there applies to every message here. Every guard must be proven to
fail ([`../false-safety-guards.md`](../false-safety-guards.md)); agent-principals §4.4 states
the common test rules, and each guard below names its test, mutation and positive control.

Companion documents: [`agent-principals.md`](agent-principals.md) (the credential, tiers,
leases, input contract, journal, audit and kill switch this builds on),
[`bearer-token-authority.md`](bearer-token-authority.md) (the token classes, §6.7 below),
[`permission-floor.md`](permission-floor.md) (why approvals stay human),
[`discord-return-path.md`](discord-return-path.md) (the one-way channel posture), and
[`../guides/declared-session-status.md`](../guides/declared-session-status.md) (the declared
channel this design refuses to read for decisions).

Related issues: #7823 owns the task record (task id, attempts, handoff envelope) and
depends on #7821, #7822 (correlated, duplicate-safe delivery), #6743 and #7827; #6691 owns
orchestration; #7437 owns mailbox delivery; #9112 is the agent-principal epic. This
document does not close any of them.

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
   fenced exactly as agent-principals §6.3 and §6.4 frame principal input. Neither the
   text, the acknowledgment nor any event authorizes a host action.
2. **Uncertainty is never resolved by retrying.** A delivery that may have landed is
   counted as landed for capacity and as unknown for everything else. Only the operator
   leaves that state (§6.8). No timeout anywhere in this design starts a second worker.
3. **A human always wins** (agent-principals §1, §5.3). A dispatch never pre-empts human
   input, never takes the primary role and never writes to the human's queue.

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
| Coordinator agent | **Untrusted for content, semi-trusted for identity**, as agent-principals §2. Its identity is the principal grant and the coordinator-of-record designation, never its label in text. | one principal token |
| Worker session | **Untrusted for content.** Its output, declarations and anything it sends are data. Its identity is assigned by the daemon (the session the daemon spawned), never asserted by the caller. | its own per-session secret (§6.7) |
| Reviewer | A separate identity from the worker and the coordinator. A review record is evidence, never authority. | its own credential |
| Notification channel | **Untrusted, outbound only.** Receives a hint; nothing it returns or carries is a command. | nothing of chroxy's beyond the hint |
| GitHub | A data source read with the read time recorded. Issue state and labels are trusted only as of that read; titles, bodies and comments are untrusted text. | — |
| Daemon host | Trusted ([`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries)). | everything |

**The same-user limit applies unchanged** (agent-principals §2): a process running as the
daemon's OS user can read the primary token and dial the daemon. Dispatch adds
attribution, guardrails and a durable record for a cooperative but fallible agent; it is
**not a sandbox** against a hostile local process. The worker's own credential has the same
limit inside the worker: the per-session secret is in the worker's process environment, so
anything that runs in that process tree can present it (§6.7).

**Untrusted content.** Issue text, pull request comments, worker output, review text and
anything arriving on a notification channel are data. None of it becomes wake text, an
instruction to the daemon, an eligibility verdict or an authority.

**Channels are one-way.** A notification channel can wake a coordinator; it cannot command
the daemon. Commands arrive only over the authenticated principal connection (§7).

**No message broker; no write-back.** The ledger is a local durable journal. GitHub is
**read-only** to the dispatcher: no comment, label, assignment or status is written back.
Principals stay refused on every HTTP route (agent-principals §4.5); there is no REST plane.

## 3. Identity: the Work Key

Every command, reservation, delivery, ACK, deadline, event and audit record carries the
same four-part **work key**:

| Part | Meaning | Changes when |
|---|---|---|
| `repo` + `issue` | The GitHub issue, with its repository (`owner/name`, GitHub's own charset, ≤ 100 characters; issue a positive integer) | Never |
| `task` (`t<n>`) | One deliverable cut from the issue; most issues have one | The issue is decomposed |
| `attempt` (`a<n>`) | One authorized try at the task, with its own caps and budget. **Monotonic** per task and never reused, across restarts | A previous attempt is closed and a new one is authorized |
| `successor` (`s<n>`) | Which session in the attempt's lineage holds it; **0 first** | A session is replaced (context limit, provider change, handoff) |

Written form: `owner/repo#123/t1/a1/s0`.

- **One open attempt per task**, enforced inside the reservation step (§6.2).
- **A successor is registered, never inferred.** A replacement session becomes `s+1` only
  through an explicit **handoff record** that names its predecessor (the handoff envelope
  of #7823 is the record's content). Silence, a session ending or a timeout registers
  nothing. Commands, deliveries and ACKs addressed to an older successor are refused
  `stale_successor`.
- **Consumed limits ride the attempt**, not the session: caps and budgets carry across
  successors and restarts.
- A session name or a label never establishes identity; the daemon's session id and the
  ledger's work key do.
- **A human-started session is observed, never adopted.** A coordinator reaches one only
  under an owner-granted lease (agent-principals §5.1, D3), and only for as long as that
  lease is live.

This design adds no second task store: the work key is the dispatch-side identity of the
#7823 record, and dispatch records reference it.

Tests. (a) **Every record carries the full key**: the test enumerates the ledger's record
kinds from an independently written list, checked in both directions against the
reducer's kinds, and asserts each fixture record has all four parts; mutation: drop
`successor` from the delivery record; positive control: a complete record passes.
(b) **Stale successor**: an ACK and a cancel naming `s0` after `s1` is registered are refused
`stale_successor`; mutation: compare `attempt` only; positive control: the same messages at
`s1` succeed. (c) **Attempt monotonicity** across an unclean restart, against an independent
oracle sequence; mutation: derive the next attempt from the in-memory count.

## 4. Roles and What Each May Do

| Action | Operator | Coordinator of record | Other principal | Worker (own attempt) | Reviewer | Notification channel |
|---|---|---|---|---|---|---|
| Read work view, dispatch events, audit in scope | yes | yes | observe grant only | no | own task only | no |
| Dispatch, cancel, request a reconcile | yes | yes | no (`not_coordinator_of_record`) | no | no | no |
| Register a successor session | yes | no in v1 (§15) | no | no | no | no |
| Supersede (new attempt for the same task) | yes | **no** until completion fencing (`owner_decision_required`) | no | no | no | no |
| Resolve an uncertain delivery (adopt, resend, cancel, supersede) | yes | **no** | no | no | no | no |
| ACK a delivery | no | no | no | **yes**, own session, current successor | no | no |
| Declare progress or completion | no | no | no | yes, recorded as declared | no | no |
| Attach a review record | no | no | no | no | yes (never the attempt's session) | no |
| Request an owner decision | yes | yes | yes | yes | yes | no |
| Answer an owner decision | yes, directly | no | no | no | no | no |
| Deny a pending permission | yes | answer scope only (agent-principals §9) | answer scope only | no | no | no |
| Allow a pending permission; change permission mode or rules | yes | **never** | never | never | never | never |
| Mint, extend or revoke credentials; grant leases; set the coordinator of record | yes | **never** | never | never | never | never |
| Raise a cap or a deadline | yes | **never** | never | never | never | never |
| Merge, deploy, restart the daemon | outside this API | **never** | never | never | never | never |
| Send a hint to a coordinator | — | — | — | — | — | outbound only |

**Coordinator of record.** One per repository, named by the operator through a
strict-primary, loopback-only management type (proposed `principal_admin_coordinator_set`,
listed in `BOUND_DENIED_MESSAGE_TYPES` and `PRINCIPAL_DENIED_MESSAGE_TYPES` and gated as
agent-principals §3 requires), persisted with the agent-principals §5.4 durable-write
standard and stamped on every command record. **Never taken from the wire.** Coordinators
are interchangeable because the designation moves, not because two act at once: a swap
is a recorded handover, and the incoming coordinator starts from the work view and its
event cursor, not from the outgoing one's memory. Revoking the principal (or the kill
switch) ends the designation's effect immediately; the record stays for audit.

**An owner decision** answered by the operator is made directly in Chroxy, by a client
holding primary authority. A coordinator may only *request* one; a decision quoted or
relayed by a coordinator satisfies no owner-reserved gate. A default never authorizes a
reserved action.

Tests. The matrix is a **machine-read constant** (proposed `DISPATCH_ROLE_MATRIX`), and the
guard reads the constant, not this prose, in the manner of `PRINCIPAL_NEVER_CAPABILITIES`
(`principal-policy.js`). For every **never** cell: (1) the real handler, called directly
with a principal-stamped client and the dispatch allowlist bypassed, refuses; (2) with the
allowlist active, the type is refused `scope_denied`. Mutation: delete the handler predicate
of one cell and watch that row go red. Positive control: the coordinator of record's
dispatch reaches the commit step. A second principal with the same tier and lease is
refused `not_coordinator_of_record`; mutation: check tier only.

## 5. Source-Owned State

### 5.1 Principle

A state value is a **claim with an owner**. Only the component that can observe a fact may
assert it. Every value is carried as `{ value, basis, source, asOf }`, where **basis** is
one of `observed` (the asserting component saw it), `reconciled` (§5.3), `declared` (the
worker said so) or none, shown as `unknown`. A reader that cannot refresh a value shows
`unknown` with its age; it never shows the last value as current. Three things stay apart:
what the **dispatcher did** (its own ledger records), what the daemon **observed** in the
session, and what the worker **declared**.

### 5.2 Observed state of an attempt

| State | Asserted by | Evidence required | Not sufficient |
|---|---|---|---|
| `working` | Session runtime | An active turn (`turn_active` in `getHandoffBlockers`, `session-manager.js`) plus a journal event after the delivery's acceptance, inside the freshness window | The busy flag alone; a declared `running` |
| `waiting` | Session runtime | Idle, empty pending-permission and question snapshots; sub-reason `awaiting_input`, `queued` | Silence; an open client |
| `blocked` | Daemon or ledger | A code it can itself see: `quota`, `budget_pause`, `capacity`, `hold`, `owner_decision:<id>`, `agents_off`, `gate_failed` | A worker saying it is blocked (declared, shown beside) |
| `permission_requested` | Permission pipelines, through the canonical snapshot (`principal-pending-permissions.js`) | Request id, tool, policy verdicts, the request's own `expiresAt` | A banner; a notification |
| `permission_timed_out` | Permission pipelines | §5.4 row "timed out" | `permission_expired`; a deny with no reason |
| `permission_denied` | Permission pipelines | §5.4 rows "answered" and "stopped" with decision deny | A deny with no reason (`ended: reason unknown`) |
| `permission_abandoned` | Session runtime | §5.4 row "turn ended", confirmed by a later snapshot that no longer lists the request | The frame alone |
| `completed` | Daemon turn outcome plus a worker declaration naming the deliverable | Turn outcome `completed` (S14's proposed `turn_ended`) and a deliverable reference | A finished turn alone; "ready for input" |
| `unknown` | Whoever reads | A journal gap reason, a restart since the last observation, a roster row `unavailable`, freshness expired | Never rendered as idle or as working |

`completed` is **not** validated completion: validation is separate evidence (§12.4) with
its own owners, the reviewer and CI.

### 5.3 Reconciliation is a basis, not a guess

When a value is `unknown`, or two sources disagree, the daemon runs a deterministic
**reconciliation**: it reads the session roster (`collectSessionsSnapshot`,
`principal-sessions-snapshot.js`), the session journal from the last trusted cursor
(`PrincipalJournal`, `principal-journal.js`) and the pending-permission snapshot, then writes
a **reconciliation record** naming the result, each source with its time, and what is
still unknown. The value then shows basis `reconciled` until a direct observation replaces
it; if the sources cannot settle it, it stays `unknown` with `reconcile_inconclusive`.
**Reconciliation reads; it never sends, retries, releases or resolves.** Test: a reconcile
over every fixture state performs zero writes outside its own record (spy on the delivery
and capacity paths); mutation: release a reservation on `reconcile_inconclusive`.

### 5.4 Permission endings are three different things

Read in source; they differ in frame, in pipeline and in **ordering against the pending
state**, so they are never collapsed:

| Ending | Frame and site | Ordering | A reader may conclude |
|---|---|---|---|
| Answered (allow or deny), in-process | `permission_resolved` with `reason: 'user'` and `resolvedBy`, from `PermissionManager.respondToPermission` (`permission-manager.js`) | The pending entry is deleted **before** the frame is emitted | A snapshot read after the frame no longer lists the request |
| Answered, hook-routed | `permission_resolved` built by `buildLegacyResolvedBroadcast` (`permission-resolver.js`): `decision` and `resolvedBy: 'user'`, **no `reason`** | The resolver's `resolveLegacyPermission` removes the entry synchronously, then the caller broadcasts | As above; the missing `reason` is recorded as missing |
| Timed out, in-process | `permission_resolved`, `decision: 'deny'`, `reason: 'timeout'`, from the permission timer (`permission-manager.js`) | Entry deleted, then emitted | `permission_timed_out` |
| Timed out, hook-routed | **No `permission_resolved`.** The daemon's timer (`ws-permissions.js`) answers the hook `{ decision: 'deny', reason: 'timeout' }` and records the history outcome `expired` | — | Nothing from frames: the ending reads `ended: reason unknown` until a slice adds an observable timeout signal (§12.4) |
| Stopped or aborted, in-process | `permission_resolved`, `reason: 'stopped'` or `'aborted'`, `resolvedBy: 'abort'` (the abort listener in `permission-manager.js`) | Entry deleted, then emitted | `stopped`: `permission_denied`; `aborted`: `permission_abandoned` |
| Turn or session ended under the prompt | `permission_expired` per request id, from `BaseSession._expirePendingPermissions` (`base-session.js`) and `SdkSession._handleHardTimeout` (`sdk-session.js`) | Emitted **before** the bookkeeping is cleared (`_pendingPermissionIds.clear()`; `_clearMessageState`) | A snapshot read at that instant may still list it; confirm with a second read before recording `permission_abandoned` |
| A reply to a client that tried to answer | `permission_expired`, sent **only** to that client, "expired or was already handled" (`handlers/settings-handlers.js`; also the reply for `not_found` and for a request the client cannot see) | Not a state change | **Nothing** about the request |

Rules:

- **Never infer one ending from another's frame.** A timeout is not `permission_expired`;
  `permission_expired` is not a timeout; a reply to an answerer is not an ending.
- **A resolution with no `reason` stays "reason unknown"**, never a user deny.
- **The history record cannot classify.** `permissionOutcomeForEvent`
  (`session-manager.js`) maps every `permission_expired` and every resolution with reason
  `timeout`, `aborted` or `cleared` to `permission_outcome: expired`; only the live frames
  distinguish them.
- **No text.** Nothing here is read from a banner, a status line or an assistant message.

Test: a fixture per row asserts the recorded ending and its basis, including a snapshot
read at the instant of a `permission_expired` that still lists the request (recorded only
after the confirming read) and an answerer reply that changes nothing. Mutation: map
`permission_expired` to `permission_timed_out`; treat a reasonless resolution as a deny.
Positive control: an in-process timeout records `permission_timed_out`.

### 5.5 Declared status is a projection

Declared status, including the Status/Next footer parsed into `declaredStatus` with source
`marker` ([declared session status](../guides/declared-session-status.md)), is shown in a
column **labelled declared**, with its source and age. **No dispatch decision reads it**:
not admission, capacity, release, completion, eligibility or the next task. A disagreement
between declared and observed is an event (`state_disagreement`), because the disagreement
is the finding. A worker's `decision` text stays a declaration; only a structured owner
decision request (§7) creates a ledger record. Test: two fixtures differing only in
declared status produce byte-identical ledger state and admission verdicts; mutation: let
the release path read `declaredStatus`; positive control: the declared column renders the
declaration with its source.

## 6. The Dispatch Ledger

### 6.1 Storage

One **append-only journal** under the config dir (0600, owned by the daemon's uid, read
through `readTrustedSecretFile` like the principal store), with a deterministic reducer
deriving every view, the pattern of `RunLedger` (`orchestration/run-ledger.js`) and
`PrincipalJournal`. Each append is **confirmed durable** before anything acts on it, to the
agent-principals §5.4 standard (file fsync, and directory fsync where a file is created or
renamed; `writeDurableFile` in `durable-write.js` is the verdict-returning helper for whole-file
writes). The ledger stores **work keys, ids, hashes, lengths and references**, never prompt
text, issue text or tool inputs. A ledger that is unreadable, corrupt, the wrong mode or
owner, or a symlink, **disables dispatch** (every command refused `ledger_unavailable`) and
`chroxy doctor` names the recovery. Test: each bad-store case at boot refuses dispatch;
mutation: fall back to an empty ledger; positive control: a healthy store admits.

### 6.2 The reservation is one transaction (authoritative gate order)

For `principal_task_dispatch`, in this order; each gate fails closed with the reason shown:

1. **Dispatch allowlist** (`refusePrincipalMessage`, `principal-policy.js`) — `scope_denied`,
   before any handler, schema validation or payload logging.
2. **Closed envelope** (§7.1) — any extra field `scope_denied`.
3. **Credential valid** — close 4401 (agent-principals §3.0).
4. **Kill switch and ledger health** — `agents_off`; `ledger_unavailable`.
5. **Tier ≥ drive and repository in the grant** — `scope_denied`.
6. **Coordinator of record** — `not_coordinator_of_record`.
7. **Field validation** (charsets, bounds, deadline ranges) — `invalid_input`.
8. **Idempotency** (§6.4) — a known `(principalId, commandId)` with the same payload hash
   returns the stored result with `replayed: true` and no effect; a different hash is
   `payload_mismatch`.
9. **Generation and view** — `stale_generation` (§10); `stale_view` when
   `expectedViewVersion` is not current.
10. **Eligibility** — `backlog_stale` when the issue read is older than the staleness limit;
    `issue_not_eligible`; `issue_held`.
11. **Attempt** — `attempt_open`; `attempt_uncertain`.
12. **Target** — `principalMaySee(client, sessionId, 'drive')` with a live lease
    (`scope_denied`, `lease_required`, `lease_stale`, `lease_suspended`); per-session
    "agents off" (`agents_off`); a supported provider (`target_unsupported`, §6.7); empty
    handoff blockers (`target_blocked:<code>`, from `getHandoffBlockers`); no human activity
    by the agent-principals §6.4 admission predicates (`target_human_active`).
13. **Capacity** (§6.3) — `capacity_unavailable`.
14. **Commit.** Inside `withPrincipalEffect` (`principal-effect.js`), whose `check` and `fn`
    run in one synchronous step: credential, kill switch, "agents off", lease and `gen` are
    re-validated, gates 8, 9, 11 and 13 are re-evaluated against the in-memory reducer, and
    **one durable append** writes the `dispatch_reserved` record. That record **is** the
    reservation, the capacity holds, the outbox entry in `pending`, the deadlines, the
    payload hash, the nonce hash and the **audit attempt line**, all under one work key and
    `bootGen`, so they cannot disagree. **No `await` between the verdict and the write.** If
    the append is not confirmed durable there is **no effect**: memory is not advanced,
    nothing is delivered, and the reply is `ledger_unavailable`.
15. **Reply** `principal_command_result { status: 'accepted', workKey, reservationId,
    deliveryId, ledgerSeq, bootGen }`, then delivery begins (§6.5).

Validation runs before idempotency so a malformed body is never memoized; idempotency runs
before every precondition so a replay of an accepted command is answered from the record
instead of meeting its own open attempt.

Tests. (a) A recording harness asserts this order, failing each gate in turn; mutation: swap
gates 8 and 11 (a replay then reports `attempt_open`). (b) Inject a revoke, a kill and a lease
bump at every `await` before step 14 and assert zero effect (agent-principals §3.0 item 3);
mutation: perform the append outside `withPrincipalEffect`. (c) Fault-inject the append (throw,
and an unconfirmed fsync) and assert no reservation, no delivery and `ledger_unavailable`;
mutation: reply before the fsync verdict. Positive control for all three: a clean dispatch
writes exactly one `dispatch_reserved` record and replies `accepted`.

### 6.3 Capacity

Capacity pools are named, read from configuration (never assumed), and counted **inside the
commit step**: `session` (the session cap), `heavy` (a configured slot count), `reviewer`,
and a per-provider `quota` gate that is open or `blocked`. A reservation holds its slots
until the attempt closes or a **recorded transition** releases them. Time never releases a
slot silently: a capacity ceiling is a deadline (§9) that emits an event and asks the
holder to release. Test: N + 1 concurrent dispatches against a pool of N admit exactly N
(counted by an independent oracle); mutation: count before the commit step; positive
control: a released slot admits the next dispatch.

### 6.4 Idempotency

- The key is **`(principalId, commandId)`**; `commandId` is client-generated
  (`^[A-Za-z0-9_-]{8,64}$`). The payload hash is SHA-256 over the canonical serialization of
  the closed field set without `commandId`.
- The result of every command that reached gate 9 (accepted, or refused at gates 9 to 13) is
  stored in the ledger and **returned verbatim** for a repeat, with `replayed: true`. A
  different payload under the same key is `payload_mismatch` (the agent-principals §6.7
  reason, reused).
- A record lives **as long as the task plus a tombstone** (§15), never a 10-minute or
  process-local window (contrast `reserveInputRequest`, `INPUT_DEDUP_*` in
  `handlers/input-handlers.js`), and never shorter than the credential's maximum lifetime.
- At a per-principal cap new commands are refused `dispatch_capacity`; nothing is evicted.
- **Conformance requirement on coordinators:** persist the `commandId` before sending it, so a
  coordinator's own restart repeats the same id.

Test: a duplicate yields one reservation and a replay; a daemon restart between the two
still replays; a changed payload is `payload_mismatch`. Mutation: keep the record in memory
only. Positive control: a new `commandId` for a new task is admitted.

### 6.5 Delivery to the worker

Delivery reuses the agent-principals input contract and adds **no second send path**: the
daemon-built text (§7.3) is framed and attributed (§6.2, §6.3 there), fenced by the
admission and continuation predicates (§6.4 there), serialized by the per-session agent
delivery lock and queue with source tag `dispatch` (§6.5 there), and written through the
provider write boundary (§6.9 there). The ledger's outbox entry records what happened:

| Delivery state | Written when | After a daemon restart |
|---|---|---|
| `pending` | With the reservation, and while the fence holds the entry queued | Stays `pending`: known unsent; it may be sent once its lease is restored (agent-principals §5.4) and every delivery gate passes again |
| `sending` | **Persisted before the provider is called**, with a delivery attempt id | Becomes **`uncertain`** |
| `delivered` | An **acceptance signal belonging to that turn** (below) | Stays `delivered` |
| `rejected` | A `zero_effect` outcome that is not a fence cause, or the agent queue's TTL expiring (`delivery_expired`) | Terminal; the reservation is released by a recorded transition |
| `uncertain` | A provider `uncertain` outcome, a lost transport, or a restart during `sending` | Stays `uncertain` (§6.8) |

**The acceptance signal.** On the provider turn-input seam (`capabilities.daemonTurnInput ===
true`, `session-wake.js`), it is the provider's admission report `{ status: 'accepted',
delivery: 'dispatch_started' }` for this delivery's `clientMessageId` (the `deliveryId`); a
`queued` admission is **not** delivery. On claude-tui, a PTY write that returns true is a
write, not an acceptance (`wakeSession` reports it `injected`); a claude-tui delivery needs a
turn start caused by it (S14's proposed `turn_started { causedBy }`) and, before that, the
composer detector that agent-principals §6.9 gates principal input on. Test: a fixture
provider that admits, queues then admits, rejects and fails mid-write maps to `delivered`,
`pending` then `delivered`, `rejected` and `uncertain`; mutation: mark `delivered` on
`queued`, and persist `sending` after the write; positive control: an uninterrupted
admission is `delivered`.

### 6.6 The two-part acknowledgment and the observed start

- **Part 1, daemon-observed.** The provider accepted the turn that carried this
  `deliveryId` (§6.5). No model cooperation is involved.
- **Part 2, worker-returned.** The worker returns the delivery's **nonce** (128 random bits,
  generated at reservation, carried in the wake text, stored in the ledger only as a hash)
  through the session-bound route of §6.7. The daemon checks, in one synchronous step: the
  credential resolves to exactly one session; that session is the delivery's target at the
  **current successor**; the delivery is `sending` or `delivered`; the attempt is open and
  not superseded; the nonce hash matches (constant-time). It then writes the part durably.
  The nonce binds the ACK to the delivery and the credential binds it to the session; the
  nonce is not a secret and confers nothing on its own.
- A **verified durable ACK** is both parts on disk under the same work key and `bootGen`.
  Either part alone is recorded and shown as what it is, never as the pair.
- **Work start is a third fact**: the first tool event (`tool_start` in the session journal)
  in the target session after part 1, in the turn that delivery caused. It is observed by the
  daemon, **never declared**. The reducer counts starts per task; a second start is an
  incident event, never a success.
- **Overdue clocks emit events and a reconcile, nothing else**: `ack_overdue` at `ackBy`,
  `start_overdue` at `firstActivityBy`.

Test: part 2 before part 1 is recorded as part 2 only; part 1 without part 2 is never shown
as verified; a declared "started" with no tool event records no start. Mutation: accept a
declared start, or record part 2 without the successor check. Positive control: both parts
and one tool event yield a verified ACK and a start count of 1.

### 6.7 The worker acknowledgment credential (decision for the gate)

**The declared-status channel cannot carry part 2.** Its `hook` source
(`POST /api/events`, `event-ingest.js`) lets the caller **name** the session in the envelope;
its `api` source (`POST /api/sessions/:id/status`, `http-routes.js`) binds a session only for
a pairing token bound to that session; and its schema (`DeclaredStatusInputSchema`,
`packages/protocol/src/schemas/declared-status.ts`) is `.strict()` with no field for a delivery
id or a nonce. Part 2 therefore needs **its own small message**, authenticated by a credential
class already bound to exactly one session, so that the daemon, not the caller, decides which
session is speaking. The classes of
[`bearer-token-authority.md` §2](bearer-token-authority.md#2-the-four-token-classes):

| Class | Bound to one session? | What else it can do | Verdict |
|---|---|---|---|
| Primary token | no | everything | refuse |
| Pairing-bound session token | yes (`generateBoundPairing`, `pairing.js`) | input, permission answers and declared-status writes **for that session** | refuse: a worker holding it could answer its own permission prompts |
| **Per-session hook secret** | **yes**: minted per session by `CliSession` (`cli-session.js`) and `ClaudeTuiSession` (`claude-tui-session.js`, when a port is configured), in memory only, never persisted, never accepted on the WebSocket; `_findSessionByHookSecret` (`ws-server.js`) resolves the owner session from the secret | today only `POST /permission` and `POST /permission-floor`, which create a prompt for that session or read | **recommend** |
| Daemon-level ingest secret | no: daemon-wide; the caller names the session | notifications, declared status, mailbox wakeups | refuse |
| Agent principal | no; a worker is not a principal | its tier | refuse |
| Discord-return secret | not built; channel-scoped | — | refuse |

**Recommendation:** the per-session hook secret, extended by **one** hook route (proposed
`POST /task-ack`, body exactly `{ deliveryId, nonce }`, at most 512 bytes). Requirements, each a
review item: the session is resolved from the secret with a constant-time comparison and a
**non-null session id**, and the route has **no fallback** to any other class (the
`_validateHookAuth` fallback to the primary token when no hook secret is registered does not
apply to it); principals, primary, pairing and ingest credentials are refused; the reply is
`{ ok: true }` or one uniform refusal, while the audit records the specific reason; per-session
rate limit; the route joins the HTTP roster of agent-principals §4.5.

**What it must not be able to do:** answer, create or extend any permission request; send
input; interrupt; read any session data, roster, journal or ledger; write declared status;
acknowledge a delivery for another session or an older successor; register a successor; change
any ledger state other than recording part 2.

**Honest limits.** The secret is in the worker's process environment (the `cli-session.js`
comment says so), so anything running in that process tree can present it: part 2 proves the
nonce was returned from **inside that session's process tree**, which is evidence of receipt,
not of intent and not authority. Providers that mint no hook secret (claude-sdk, Codex, ACP)
cannot produce part 2; claude-tui cannot yet produce part 1 (§6.5). The v1 target set this
implies is §15 decision 2. Adding the route widens the hook-secret class by one endpoint, so
it lands with a §2/§5 delta of `bearer-token-authority.md` at HIGH review.

Test: an ACK presented with each refused class, with another session's secret, with an older
successor's secret and with a wrong nonce is refused and audited; mutation: take the session
from the body, or drop the nonce check; positive control: the target session's secret with the
right nonce records part 2.

### 6.8 Uncertainty and no blind redispatch

`uncertain` means the delivery may have been accepted. Reconciliation (§5.3) may record that
the session journal shows the input admitted under this `deliveryId` (the delivery becomes
`delivered`, basis `reconciled`), that a continuous journal shows no admission
(`no_admission_observed`, still `uncertain`), or that a gap covers the window (still
`uncertain`). **Nothing resends automatically**, in the daemon, in a client or in coordinator
guidance. While an attempt is open or uncertain, a new dispatch for the task is refused
(`attempt_open`, `attempt_uncertain`). Leaving `uncertain` takes an **operator** decision
(proposed strict-primary `principal_admin_task_resolve { adopt | resend | cancel | supersede }`);
`resend` reuses the same target and the same `deliveryId`. A superseded attempt is **fenced**:
a late ACK, start or completion from it is refused and raised as an event, so an old worker
cannot overwrite its successor. **Supersede** stays operator-only until completion fencing
exists; a coordinator's request is `owner_decision_required`. Test: restart during `sending`,
then every reconcile outcome, leaves start count ≤ 1 and no second delivery; mutation: resend
on `no_admission_observed`; positive control: an operator `resend` delivers once.

## 7. Message Types and Refusal Reasons

All names are proposals for the gate. New types carry the `principal_` prefix and enter
`PRINCIPAL_ALLOWED_MESSAGE_TYPES` (`principal-policy.js`) only together with their handlers;
the roster guard of agent-principals §4.2 checks them in both directions, and every new frame
enters the principal outgoing allowlist (`PRINCIPAL_BROADCAST_ALLOWED` stays empty).

### 7.1 Coordinator messages (closed field sets)

| Type | Tier | Fields |
|---|---|---|
| `principal_task_dispatch` | drive | `type, commandId, expectedViewVersion, bootGen, repo, issue, task, sessionId, scopeRef, deadlines { ackBy, firstActivityBy, dueBy? }, capacity[], leaseId, gen` |
| `principal_task_cancel` | drive | `type, commandId, workKey, leaseId, gen` |
| `principal_task_reconcile` | observe | `type, requestId, workKey` (rate-limited; read-only) |
| `principal_work_view` | observe | `type, requestId, repo, sinceVersion?` |
| `principal_dispatch_subscribe` / `principal_dispatch_events_read` | observe | the cursor fields of agent-principals §7.2 |
| `principal_event_ack` | observe | `type, commandId, journalId, throughSeq` |
| `principal_audit_read` | observe | `type, requestId, workKey, afterSeq?, limit` (≤ 200) |
| `principal_decision_request` | observe | `type, commandId, workKey, scopeRef, recommendation, default, expiresAt` (codes and references only) |

**No free-text field exists on any dispatch command.** `scopeRef` is a reference
(`^[a-z0-9._/-]{1,64}$`), not prose. A cancel interrupts through the drive interrupt of
agent-principals §4.1.3 and is confirmed only by an observed turn end; a cancel of a
`pending` delivery removes it with zero effect; a cancel of an `uncertain` attempt is
`attempt_uncertain`.

Server frames: `principal_command_result`, `principal_work_view_result` (or `not_modified`),
`principal_dispatch_event`, `principal_dispatch_events_page`, `principal_dispatch_live_fence`,
`principal_dispatch_gap`, `principal_audit_page`. Operator management types, strict-primary
and loopback-only as agent-principals §3 requires: `principal_admin_coordinator_set`,
`principal_admin_task_resolve`, `principal_admin_task_supersede`,
`principal_admin_successor_register`, `principal_admin_decision_answer`.

### 7.2 Refusal reasons, by channel

| Channel | Reasons |
|---|---|
| Command result, refusals | `scope_denied`, `not_coordinator_of_record`, `agents_off`, `lease_required`, `lease_stale`, `lease_suspended`, `invalid_input`, `payload_mismatch`, `dispatch_capacity`, `stale_generation`, `stale_view`, `stale_successor`, `backlog_stale`, `issue_not_eligible`, `issue_held`, `attempt_open`, `attempt_uncertain`, `target_unsupported`, `target_blocked:<code>`, `target_human_active`, `capacity_unavailable`, `owner_decision_required`, `audit_unavailable`, `ledger_unavailable` |
| Command result, statuses | `accepted`; any stored result repeated carries `replayed: true` |
| Worker ACK route | one uniform refusal on the wire; the audit records `nonce_mismatch`, `wrong_session`, `stale_successor`, `delivery_not_open`, `attempt_superseded` |
| Delivery and event outcomes | `delivered`, `rejected:<reason>`, `delivery_expired`, `uncertain`, `ack_overdue`, `start_overdue`, `hint_exhausted` |

As in agent-principals §6.7, a non-granted target is `scope_denied`, indistinguishable from a
nonexistent one, and specific reasons go only to an authenticated principal about its own
request. Test: a non-granted caller cannot distinguish any two reasons; mutation: answer
`target_blocked` for a non-granted session; positive control: the coordinator of record sees
`target_blocked:turn_active` for its own leased session.

### 7.3 The wake text is built by the daemon

The model-visible text is **composed by the daemon from ledger fields it validated**: the work
key, the issue reference, the `scopeRef` and the nonce, framed `[agent:<label>]` with the
coordinator's operator-authored label (agent-principals §6.3), sanitized by the agent profile
(§6.4 step 7 there) and bounded by `MAX_WAKE_TEXT_CHARS` (500, `session-wake.js`). **Nothing
from the wire becomes wake text, and issue titles, bodies and comments never do**: the worker
reads the issue itself, as untrusted data. Test: every command field fuzzed with control
characters, reserved sigils and over-length values is `invalid_input`, and the delivered text
equals a template rendered by an independent oracle; mutation: add a pass-through `note`
field; positive control: a clean dispatch renders the expected line.

## 8. Events, Hints and the Event Acknowledgment

- **Durable first.** Every dispatch event is appended to a dispatch event journal with the
  cursor and gap semantics of agent-principals §7.1 and §7.2 (`journalId`, `seq`, `evicted`,
  `journal_reset`, `restart_loss`, `unknown_cursor`), before any hint is sent.
- **Reasons are evaluated deterministically by the daemon**; no model decides whether
  something happened: `work_started`, `ack_overdue`, `start_overdue`, `permission_requested`,
  `permission_timed_out`, `permission_denied`, `permission_abandoned`, `deadline_approaching`,
  `attempt_completed`, `dispatch_uncertain`, `state_unknown`, `state_disagreement`,
  `reconciled`, `decision_answered`, `capacity_freed`, `command_denied`.
- **A hint carries nothing**: an event id, a reason code and an opaque reference. No title,
  content, command or secret. At most one hint per coordinator per minute; several events
  share one. An unacknowledged event is re-hinted on a short bounded schedule (§15), then
  marked `hint_exhausted` and shown to the operator; the event stays readable.
- **The only delivery proof** is the coordinator's authenticated `principal_event_ack`,
  recorded durably before the reply. A channel's own acceptance proves only that the channel
  accepted; channel receipts are not relied on. An ACK past the journal head, or for another
  principal's journal, is refused.
- **Channels are one-way.** Nothing arriving on a notification channel is a command; a reply,
  reaction or forwarded hint on a channel has no effect on the daemon. With no open attempt
  nothing polls; otherwise a coordinator reads `principal_work_view` with `sinceVersion`
  (answered `not_modified` when current) or follows its subscription.

Tests: an event is on disk before its hint (fault-inject the append: no hint); a replayed hint
has no second effect; a forged hint on the channel causes no command; an adapter restart
mid-stream reports a gap. Mutation: send the hint before the append; treat channel acceptance
as the ACK. Positive control: one event, one hint, one durable `principal_event_ack`.

## 9. Deadlines

**One durable timer mechanism.** A deadline is a ledger record `{ deadlineId, kind, workKey,
expiresAt, leads[] }`; one daemon timer sleeps until the earliest pending lead. Nothing polls
and no model runs.

| Deadline | Expiry from | Before expiry | At expiry |
|---|---|---|---|
| Permission decision window | The request's own `expiresAt` in the pending snapshot (hook-routed: `HOOK_PERMISSION_DECISION_WINDOW_MS`, `permission-deadlines.js`) | One reminder at a lead (§15) | The ending is recorded per §5.4; nothing is requested again or extended |
| `ackBy`, `firstActivityBy` | The dispatch | none | `ack_overdue`, `start_overdue`, then a reconcile |
| Capacity ceiling | The reservation | One reminder | `ceiling_reached`; the holder is asked to release; no forced release |
| Lease and credential expiry | The grant | One reminder | The grant's own behaviour (agent-principals §5.2, §3) |
| Task `dueBy` | The dispatch | One reminder | `due_missed` |

- **At most once.** A pre-expiry event is keyed `(deadlineId, lead)` and recorded before it is
  emitted, so a restart or a replay cannot send it twice.
- **Missed while down is reported.** A lead that passed while the daemon was down emits
  `deadline_missed_while_down` at boot; it never pretends the reminder went out.
- **No extension by any agent.** Only the operator changes a cap or a deadline. Extending a
  permission window would be a permission change and is out of this design entirely.
- **A timeout never makes anything eligible** (§12.4).

Tests: a restart across a lead emits `deadline_missed_while_down` once; a replayed lead emits
nothing; a coordinator message attempting to change `ackBy` on an open attempt is refused
`scope_denied`. Mutation: key reminders by time only; emit before recording. Positive control:
a lead reached while up emits exactly one event.

## 10. Restart and the Generation Fence

- **Boot generation.** At start the daemon increments `bootGen` and persists it with the
  durable standard **before** admitting any command; if that write is not confirmed, dispatch
  stays disabled for the boot. `bootGen` is stamped on reservations, deliveries, ACK parts and
  command results. A result from an older generation is valid history; a command naming an
  older generation as current is refused `stale_generation`.
- **Boot sequence, before the first admission:** every `sending` delivery becomes
  `uncertain`; every attempt's observed state becomes `unknown`; deadlines are swept (§9); a
  reconciliation sweep runs (§5.3). Leases do not survive a restart (agent-principals §5.2), so
  a `pending` delivery waits until its lease is restored under §5.4 there.
- **Restart blocker.** An open reservation that has not reached work start, and any `sending`
  delivery, adds a reason to `computeDaemonIdleState` (`daemon-idle-state.js`), so the idle
  auto-deploy (#8324) does not restart the daemon under it. Fail safe: an unreadable ledger
  reads as not idle.

Tests: a real restart after each delivery state matches the §6.5 table; an unconfirmed
`bootGen` write refuses every dispatch; the idle probe reports the blocker with one open
reservation and drops it at work start. Mutation: admit before the sweep; omit the blocker.
Positive control: a ledger with no open reservation leaves the idle state unchanged.

## 11. Audit

This extends agent-principals §10.1 and uses **one writer**: the S11 audit writer
(`auditOrRefuse`, proposed there) extended with a confirmed-durable append that the ledger
uses, so the ledger record **is** the audit attempt line (§15 decision 6). The rule:

- **Every command and every denial** leaves a record. The attempt record precedes every effect;
  if it cannot be written there is **no effect** and the reply is `audit_unavailable` or
  `ledger_unavailable`. An outcome record follows every transition.
- Denials record the type name, principal, label and reason, **never the refused payload**;
  identical denials within a minute collapse into one counter record.
- **Content is never logged**: wake text and every body are recorded as SHA-256 and length
  only, the agent-principals §10.1 posture.

Record kinds: `command` (each attempt and outcome), `denial` (coalesced), `delivery` (each
outbox transition), `ack` (each worker ACK part and each coordinator event ACK),
`observation` (each change of observed state, with its evidence reference),
`reconciliation` (sources read, result, remainder), `decision` (request, answer, expiry,
consumption), `deadline` (set, lead emitted, expiry, miss) and `system` (boot, generation,
kill switch, store health).

Envelope fields: `v`, `seq`, `ts`, `bootGen`, `kind`, `phase`, `actor { class, id, label }`
(`class` is `operator`, `principal`, `worker`, `reviewer` or `system`), `action`,
`commandId`, the work key, `result`, `reason`, references (reservation, delivery, session,
journal cursor), `content { sha256, len }` and `prev`, the hash of the previous record. The
`prev` chain lets an honest reader detect gaps and edits; within the same-user limit (§2) it
is **not** a defence and is not claimed as one. `principal_audit_read` returns records for tasks in the caller's
grant and its own commands and denials only.

Test: inject an append failure (ENOSPC, EBADF, unconfirmed fsync) before **every** effect kind
(reserve, deliver, ACK part, event ACK, cancel, decision) and assert no effect and the attempt
record before the effect; assert a payload marker never appears in any record. Mutation: make
the writer report success unconditionally; log a body prefix. Positive control: with a healthy
writer each effect occurs with its records.

## 12. Acceptance Split

Two tracks that never borrow each other's evidence. A fixture pass is never cited as proof of a
real provider or channel, and a live wake is never cited as proof of dispatch.

### 12.1 Fixture first slice

A throwaway daemon with its own config dir, a test-inserted principal (no minting) and a
fixture provider: **the ledger, the reservation transaction with one capacity pool, durable
idempotency for one command, loopback delivery, the two-part ACK and one observed start.**
Out of scope: completion and completion fencing, successors beyond `s0`, supersede, the
coordinator event outbox and every external channel, deadlines other than `ackBy` and
`firstActivityBy`, GitHub reads (the issue is a fixture row), operator UI, anything on a
daily daemon. Cases, each with its mutation: happy path; duplicate command; same id with a
different payload; second dispatch for the task; pool full; durable write failing at
reservation (no effect, no delivery); restart after `pending`; restart during `sending`
(`uncertain`, start count 0 or 1, never 2); wrong nonce and another session's secret; no ACK
by `ackBy`; a journal gap across the window; a stale view. **Proves** the ledger logic.
**Does not prove** anything about a real provider, session or channel.

### 12.2 Live wake acceptance

A real daemon, a real coordinator and a real channel, under its own authorization; no session
is sent anything. Hops, one correlation id throughout: a daemon-originated event exists; it
is durable before any send; the channel accepted the hint; the coordinator woke because of
it; the coordinator read the event over its authenticated connection and the daemon recorded
its **durable `principal_event_ack`**. Controls, each run: channel disabled (no wake; the event
stays readable); a hint replayed (no second effect); a hint forged on the channel (no command,
no effect); an adapter restart mid-stream (a gap, reconciled, not silently resumed). **Proves**
that a wake arrived and was acknowledged. **Makes nothing eligible and starts nothing.**

### 12.3 Live dispatch acceptance

A separate run with separate authorization, which requires §12.1 and §12.2 to have passed on
their own and the agent-principals leases, delivery fence and durable dedup to have landed.
Hops: one dispatch `accepted`; reservation and delivery `delivered`; a verified durable ACK
(both parts); work start with **start count 1**. Controls: the same command twice (one
reservation, a replay, start count 1); a restart between `sending` and the ACK (`uncertain`,
nothing resent, start count ≤ 1); a wrong nonce and an ACK from another session (refused,
audited); a dispatch against an open attempt (`attempt_open`, audited). **Proves** one
delivered, acknowledged, started task. **Neither acceptance proves** completion, quality,
behaviour while the host sleeps, or latency beyond the trials run.

### 12.4 Slices and what each is reviewed against

| Slice | Owns | Reviewed against |
|---|---|---|
| D1 ledger, reducer, work key, generation | storage and identity | §3, §6.1, §10 |
| D2 reservation, capacity, idempotency | the commit step | §6.2 to §6.4 |
| D3 delivery outbox through the input contract | delivery states | §6.5, §6.8, §7.3 |
| D4 worker ACK route and observed start | the two-part ACK | §6.6, §6.7 and the `bearer-token-authority.md` delta |
| D5 source-owned state, permission endings, reconciliation | observation | §5 |
| D6 event journal, hints, event ACK | events | §8 |
| D7 deadline timer | deadlines | §9 |
| D8 completion fencing and successor eligibility | completion | §6.8 and the rule below |

A **successor task** (the next task that depends on this one) becomes eligible only on
**independently proven completion**: a review record by someone other than the worker, bound
to the exact head, required checks green on that head, and the stated end condition verified.
The worker's own declaration is not enough. **A timeout or a wake never makes anything
eligible.** D8 also adds an observable timeout signal for hook-routed prompts (§5.4) or leaves
that ending `reason unknown`. Landing order: S11 (audit writer and kill switch) before any
slice that writes; D1 before every other slice; D4 before the live dispatch acceptance.

## 13. What This Document Does Not Authorize

- No implementation beyond the slices of §12.4, each under its own review; nothing here mints a
  principal or enables `grant`.
- **No change to any agent-principals invariant**: deny-only answers, no agent-initiated lease
  request, the never table, the permission floor, the never-delegable set,
  `skipPermissions: false`, the auto-mode gates, and every bound-client and strict-primary
  refusal apply to every dispatch message exactly as to any principal message.
- No permission allow, mode or rule change, credential action, lease grant, merge, deploy or
  daemon restart by any coordinator, through this API or any other.
- No write-back to GitHub, no webhook intake enabled, no message broker, no REST plane for
  principals.
- Untouched: mailbox delivery (#7437) and `session-wake.js`'s gates (dispatch does not use the
  PTY wake route); `POST /api/events` and the declared-status routes; orchestration (#6691).
- A PR that widens dispatch authority (a coordinator supersede, an automatic resend, a
  coordinator-registered successor, a new token reaching the ACK route) is reviewed at HIGH
  tier against this document and left for the owner to merge.

## 14. Residual Risks

- **Prompt-injection relay.** A coordinator that reads issues and session output can be steered
  by text inside them; mitigation is who is coordinator of record, the drive lease, the closed
  envelope and the daemon-built wake text. A dispatch can still point a worker at the wrong
  issue within the grant.
- **Same-user containment** (§2). No sandbox against a hostile local process; a worker's tools
  can present its per-session secret (§6.7), so part 2 is evidence of receipt only.
- **Operator attention for uncertainty.** Every `uncertain` delivery needs an operator decision;
  a restart during `sending` therefore costs owner time. Accepted: an automatic resend can start
  a second worker.
- **Hook-routed timeouts are unclassified** until a slice adds a signal (§5.4); they read
  `reason unknown`.
- **Provider coverage.** Until session-bound credentials exist for more providers, dispatch
  serves fewer providers than principal input does (§15 decision 2).
- **Eligibility is as fresh as the last read.** An issue closed after the read and before
  delivery is dispatched once; the staleness limit bounds the window.
- **New data at rest.** The ledger and event journal hold work keys, ids, hashes and
  references, 0600 under the config dir; issue and prompt content stay out.
- **Lost hints.** A coordinator whose channel fails sees the event only on its next read;
  `hint_exhausted` tells the operator.

## 15. Decisions Needed at the Gate

| # | Decision | Recommendation | Default until decided |
|---|---|---|---|
| 1 | Credential for the worker ACK (§6.7) | Per-session hook secret plus one route, `POST /task-ack` | No part 2; the live dispatch acceptance cannot pass |
| 2 | v1 target providers | Those with both an acceptance signal and a hook secret: claude-cli (`CliSession`) today; others `target_unsupported` | Same as the recommendation |
| 3 | Tier required to dispatch | drive, with a live lease on the target | drive |
| 4 | Who registers a successor session | Operator only in v1 | Operator only |
| 5 | Where the eligibility read runs and with what credential | Daemon-side, read-only, under the operator's existing local configuration; the fixture slice uses a fixture row | No live dispatch |
| 6 | One audit writer | S11's writer gains the confirmed-durable append the ledger uses | No slice that writes merges with two writers |
| 7 | Idempotency tombstone after a task closes | 7 days | 7 days |
| 8 | Re-hint schedule and reminder leads | 3 hints over 15 minutes; permission reminder 120 s before expiry | As recommended |
| 9 | Hint channel for the live wake acceptance | An operator-configured outbound sink or a local bridge | None; the live wake acceptance waits |
