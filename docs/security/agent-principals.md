# Agent Principals — Threat Model and Authority Design

External supervisor agents need to watch Chroxy sessions and steer them without typing
into a session UI. Today the only route is `chroxy agent-control --stdio` (#7854), which
authenticates with the **primary token**. Epic #9112 adds an **agent principal**: a
scoped, revocable, labelled credential that runs on the **same WebSocket router and
handlers** as the dashboard — no new control plane, no REST or eval bridge. This document
is the design gate (#9113), like [`discord-return-path.md`](discord-return-path.md)
(#7166), #8246 (agent-driven browser and device surfaces) and #8307 (agent-run terminal
commands). It pins the trust boundary, the credential class, the authority tiers, the
lease, input and event contracts, and the audit and kill contracts **before any code**, so
the children S1–S18 of #9112 implement one contract instead of negotiating it in review.

**Status: designed, not yet implemented.** Nothing here exists in code. Where this
document says a mechanism exists on main it names the symbol; everything else is
*proposed* and is implemented by the child named in §12.

Companion documents: [`bearer-token-authority.md`](bearer-token-authority.md) (the token
classes this sits beside; §2 and §9 gain a note and a checklist item with this change),
[`permission-floor.md`](permission-floor.md) (why approvals stay human),
[`discord-return-path.md`](discord-return-path.md) (the queue, fence, sanitizer and audit
design reused here — by reference, §5), [`../guides/agent-control.md`](../guides/agent-control.md)
(the MCP adapter that becomes the first principal client), and
[`../guides/declared-session-status.md`](../guides/declared-session-status.md).

## 1. Trust Model in One Sentence

> An agent principal may **observe** the sessions its grant names, and — only while it
> holds a daemon-issued lease the owner granted — may send one labelled, sanitized text
> message into a session (steer), or drive input, interrupt and create-and-close its own
> sessions inside granted bounds (drive), or **deny** a pending permission (answer). It
> may never approve a host action, widen any permission mode, or touch credentials,
> configuration, files, shells or the daemon. The ceiling is enforced by the daemon's
> router and handlers, not by the agent-control client or the agent.

The controlling asymmetry is the one from the Discord return path: **steering is advice
to an agent; an approval is authorization of a host action.** A principal carries the
first and, in v1, only the *refusing* half of the second (§9). The delivery fence (§6.4)
is what stops advice from turning into authorization by side effect (an interjection
landing in an approval picker).

Second asymmetry: **a human always wins.** Human input suspends a drive lease, a
steer is fenced on human activity, and no principal action ever takes the primary role,
the composer or the human's queue (§5.5).

## 2. Trust Boundaries and Honest Limits

```
[supervisor agent process] ──(principal token, loopback only, v1)──▶ [chroxy daemon]
        │  reads/writes: its own token file (0600)                        │
        └─ same OS user as the daemon ─────────────────────────────────── ┘
```

| Zone | Trust | Holds |
|---|---|---|
| Supervisor agent (model + host process) | **Untrusted for content, semi-trusted for identity.** Anything it sends is attacker-influenceable text (prompt injection reaches it from web pages, repo files, other sessions). Its identity is the label and principal id of the grant. | one principal token |
| Daemon host | Trusted — the owner's own machine ([`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries)). | everything |
| Sessions it observes | Their output is untrusted data to the supervisor, exactly as it is to any reader. | — |

**Honest limit, stated plainly.** Any process running as the same OS user can read the
daemon's connection file (`connection.json`) and the primary token, and can dial the
daemon directly. A principal therefore is **attribution + guardrail + revocation for a
cooperative agent. It is not a sandbox against a hostile local process.** Containment
needs an agent host that **cannot read the config directory** (a separate OS user, a
container or sandbox without that mount). Until the agent-control MCP default moves off
the primary token (S16), `chroxy doctor` gains a row (S17) that **warns when agent-control
is configured with the primary token** and when the principal token file is readable by
a different user than intended. The warning exists because the guardrails below buy
nothing for an agent that holds the primary token: the primary token is full host
authority ([`bearer-token-authority.md` §1](bearer-token-authority.md#1-trust-model-in-one-sentence)).

Today's agent-control gates are **client-side**. `_ownershipRejection`, the
`NOT_DELEGABLE_TOOLS` / `FLOOR_ALLOWLISTED_TOOLS` / `COMMAND_TOOLS` checks and the
`floored === false` requirement (`packages/server/src/agent-control/client.js`, with the
tool sets exported from `packages/server/src/permission-manager.js`) run inside the MCP
process; a raw WebSocket client holding the primary token bypasses all four. Ownership is
an in-memory `_ownedSessions` set, filled only from that process's own `create_session`
reply, so it cannot name a session a person started and does not survive a restart. The
principal design **moves the gates into the daemon** (§3.3, §9) and **replaces
process-local ownership with durable leases** (§5).

**Loopback-only acceptance in v1 (D8).** A principal token is accepted only on a
connection that passes `isLoopbackPeer(req)` (`packages/server/src/connection-locality.js`).
A bare socket-address check is **not enough**: the Cloudflare tunnel connects to the
daemon from 127.0.0.1, so tunnel traffic looks loopback by address.
`isLoopbackPeer` additionally rejects any request carrying a proxy-family header and
parses the address strictly, which is the property this rule needs — and its own
doc-comment states its limit: a proxy that strips every hint header, or a local process
forwarding for a remote party, passes it. So it is defence in depth; **the token remains
the authority**, and a remote supervisor is out of scope for v1 (it needs its own
delta: TLS, host binding, IP policy). The check runs at the WS upgrade and again at
`auth`; a principal token presented from any other peer is refused with the same
opaque failure as an invalid token.

## 3. The Credential Class (D1)

[`bearer-token-authority.md` §2](bearer-token-authority.md#2-the-four-token-classes)
lists four classes, and notes a fifth (discord-return) designed but not built. The agent
principal is a **separate** class — not the primary token, not a pairing token (a
pairing token binds one *device* to one session; a principal is an *agent*, with its own
tiers, leases, label and kill switch). Rows land in §2 and §7 of that document when S1
implements the class.

| | agent principal token |
|---|---|
| Issued by | `chroxy agent grant --label <label> --scope observe\|steer\|drive\|answer --session <id> \| --cwd <root> [--provider ..] [--model ..] [--ttl <dur>]`, run under **local primary authority** (the CLI uses the local primary token; no daemon running → refuses) |
| Token | `randomBytes(32).toString('base64url')`, shown **once**, written to a 0600 file under the config dir's `agents/` subdirectory (atomic write, `CHROXY_CONFIG_DIR` honored). Never printed to argv, env or logs |
| Daemon stores | **Only** a SHA-256 hash of the token plus `principalId`, `label`, scopes, constraints (session ids / cwd roots / providers / models), `createdAt`, `expiresAt`, `revokedAt`, in a 0600 store read through `readTrustedSecretFile` (`packages/server/src/trusted-file-read.js`: `O_NOFOLLOW` open, `fstat` on the same fd, mode and owner check). A store that is not 0600, not owned by the daemon's uid or is a symlink is **refused, not trusted** — every principal is then invalid (fail closed) |
| Label | Operator-authored at grant time; charset `^[a-z0-9_-]{1,32}$`, unique among live grants, validated at load (mirrors discord §5.3: the label is later interpolated into model-visible text, so its charset is enforced even though the operator wrote it). **Never taken from the wire** |
| TTL | Default **24 h**, maximum **7 d** (D9); a grant request above 7 d is refused, not clamped. Expiry is absolute (not sliding) |
| Scope | Per §4. Fail-safe: an unknown or malformed scope string grants nothing |
| Used on | WS `auth` message only, from a loopback peer (§2). **Refused on every HTTP route in v1** — `_validateBearerAuth`/`_validatePrimaryBearerAuth` never accept this class, and an opt-in (`allowScoped`) route that does not name principals still refuses it |

Discipline (each line is a review checklist item for S1):

- **Constant-time validation** (`safeTokenCompare`, `packages/server/src/token-compare.js`)
  of the presented token's hash against stored hashes, evaluated for every candidate so
  timing does not reveal which principal matched; the token is never logged;
  `maskToken` on any diagnostic surface.
- **No fallback in either direction.** The principal class is accepted at WS `auth`
  only; no primary-token, pairing, hook or ingest path accepts it, and it never
  satisfies `isPrimaryToken` (§3.1).
- **Auth failure** shares the existing exponential-backoff rate limit in `ws-auth.js`;
  every failure answers identically (no distinction between unknown, expired, revoked and
  wrong-peer tokens).
- **Revocation** (`chroxy agent revoke <label|principalId>`, dashboard button): sets
  `revokedAt`, persists it **before** acknowledging, closes every connection of that
  principal with `credential_invalidated` and close code **4401**
  (`WS_CLOSE_CREDENTIAL_INVALID` in `packages/server/src/ws-server.js`), drops its
  interject-queue entries (audited, §10) and releases its leases (§5). **Every frame
  re-checks the credential** — the per-frame `bearerStillValid` pattern from #9028
  (`packages/server/src/bearer-recheck.js`) — so a revoked or expired principal is cut off
  within one frame, and a re-check runs again **after every `await`** in a principal
  handler (a revoke landing mid-handler must not let the handler's effect through).
- The principal store survives daemon restarts; tokens do not rotate silently. Renewal is
  a new `grant` (the old token stays valid until its own expiry or a revoke).

### 3.1 A principal must never read as host authority

The existing gates branch on `client.boundSessionId`, `client.isPrimaryToken` and
`isBoundClient(client)` (`packages/server/src/environments/authority.js`:
`boundSessionId != null` is the **only** unbound case, and a nullish client is bound).
A new class that left those stamps at their "unscoped" values would read as a host
client everywhere that checks them. So, as contract:

1. A principal connection is stamped **`client.principal = { principalId, label, tier,
   scope, constraints }`** at auth and **`client.isPrimaryToken = false`** (strict
   `=== true` gates already read false), and **`client.boundSessionId`** is set to a
   non-null **sentinel** that matches no session id (the existing fail-safe rule: "an
   empty or non-string binding is scoped too and matches no session").
2. The shared authority helper treats **`client.principal != null` as scoped** —
   `isBoundClient` gains the clause `|| client.principal != null` (fail-safe, same shape
   as the `== null` rule). So every existing consumer of the helper — broadcaster
   delivery (`isBoundToOtherSession`), subscription index, `canSeePeer`, web-task
   visibility — treats a principal as non-host without being edited.
3. **Per-session access goes through ONE helper**, proposed `principalMaySee(client,
   sessionId, need)`, that checks the grant's session/cwd constraint, the tier and, for
   mutations, the lease (§5). No principal-aware handler does its own check; a handler
   that branches on `boundSessionId` alone is not enough for a principal because the
   sentinel matches nothing — it **fails closed**, which is the intent.
4. **Consequence for allowed types.** Bound-policy handlers that "resolve the bound
   session" (`input`, `interrupt`, `permission_response`, `destroy_session`, …) refuse the
   sentinel for every session. That is the fail-safe default for the never rows (§4.3), and
   it means each allowed principal type needs an explicit principal-aware resolve step:
   S2 routes them through `principalMaySee` *before* the bound-session resolve, so a
   handler that is not wired to the helper refuses a principal rather than treating it as
   host.
5. A roster guard (§4.2) proves the dispatch allowlist covers every message type; the
   helper change above is the second, independent layer, so a handler added later and
   missing from the allowlist reasoning is still refused by the bound/non-primary gate.
6. **A principal receives no ordinary session broadcasts.** The sentinel binding matches
   no session, so the broadcaster's bound-client filter delivers it nothing session-
   scoped, and frames with no session id already go to unbound clients only. Its read path
   is the `agent_*` family (§7) plus direct replies to its own requests (acks, snapshots).
   That is deliberate: what a principal sees is daemon-normalized and bounded, never the
   raw replay a dashboard gets.

**Management surface.** `chroxy agent …` (CLI) and the dashboard's Agents tab (S17) drive
grants, revocation, leases, "agents off" and the kill switch through new
**strict-primary, loopback-only** WS message types (proposed: `agent_principal_grant`,
`agent_principal_list`, `agent_principal_revoke`, `agent_principals_disable`,
`agent_principals_enable`, `agent_lease_grant`, `agent_lease_revoke`,
`agent_session_agents_off`). Each gates on `client.isPrimaryToken === true &&
!client.boundSessionId && !client.principal` as its first statement, sits in
`BOUND_DENIED_MESSAGE_TYPES` **and** `PRINCIPAL_DENIED_MESSAGE_TYPES`, and writes the
store from the daemon process only — the CLI never edits the store file itself, so the
daemon and CLI cannot race on it.

## 4. Authority Tiers and Dispatch

| Tier | Grants | Lease | Constraint |
|---|---|---|---|
| **observe** | Roster of granted sessions with observed + declared status, handoff blockers (#8281), lease-holder label, model requested/observed; normalized event journal subscribe/read; pending-permission snapshot | none | granted sessions only |
| **steer** | observe + **one fenced interjection** delivered at a turn boundary | `steer` | one holder per session |
| **drive** | steer + `interrupt` on a leased session, create sessions within granted cwd roots / providers / models, and close **only sessions it created** | `drive` | `permissionMode` only `approve` or `plan` at create; never `acceptEdits`/`auto`; never `skipPermissions`; never user-shell |
| **answer** | drive + **deny** pending permission requests | `drive` + answer scope | **deny only in v1** (§9) |
| **never** | see §4.3 | — | — |

A grant carries exactly one tier; higher tiers include everything below them.

**Input is the same contract at steer and drive.** Every principal `input` goes through
the same gates, the same delivery fence and the same agent queue (§6.4, §6.5), so it lands
only at a turn boundary with no prompt pending and no human composing. The tiers differ in
what else they may do (interrupt, create, close own sessions, deny) and in how human input
affects the lease (§5.3), not in how input is delivered. v1 principal input is **text
only**: `attachments` and `context` items are refused `scope_denied`.

### 4.1 Deny-by-default dispatch

A principal connection may send **only** allowlisted message types, checked **in the WS
router before any handler, schema validation, session lookup or payload logging**, by one
function modelled on `refuseBoundMessage` (`packages/server/src/bound-client-policy.js`,
`BOUND_ALLOWED_MESSAGE_TYPES` / `BOUND_DENIED_MESSAGE_TYPES`). Anything not listed — a
malformed type, a type registered later and never classified, anything sent while the
daemon drains — is refused `scope_denied` before the handler runs. The refusal echoes
`requestType`/`requestId` only when they are short strings (the bound-policy rule) and
carries no detail about *why* beyond the code.

Proposed v1 allowlist (`PRINCIPAL_ALLOWED_MESSAGE_TYPES`, the reason beside each entry):

| Tier | Existing types reused | New types proposed |
|---|---|---|
| all | `auth`, `key_exchange`, `ping` (transport and keepalive only) | `agent_subscribe`, `agent_unsubscribe`, `agent_events_read`, `agent_pending_permissions`, `agent_sessions_snapshot` |
| steer | `input` (lease required; fenced and queued, §6) | `lease_renew`, `lease_release` |
| drive | `interrupt` (gains `requestId`, §7.4), `create_session` (constrained, below), `destroy_session` (**sessions it created only**) | — |
| answer | `permission_response` (**`deny` only**, §9) | — |

`lease_renew` / `lease_release` apply to steer and drive. Existing types that are not
session-local reads of the granted session are **not** reused as-is: history and roster
reads go through the new `agent_*` types, whose payloads are daemon-normalized and
bounded, rather than through `request_full_history`, `list_sessions` or terminal types
that expose raw output.

**Create is constrained daemon-side** (S12): `cwd` must resolve (`realpath`) under a
granted root; `provider` and `model` must be in the grant; `permissionMode` ∈ {`approve`,
`plan`}; `skipPermissions` absent or `false`; `userShell` and `environment` fields
refused; `worktree: true` is allowed only under a granted root; the created session
records `createdBy: principalId` (durable, §5.4). `destroy_session` is refused for every
session whose `createdBy` is not this principal — an owner-granted drive lease on a
session a person started **never** lets a principal close it. `interrupt` needs a drive
lease, and is refused `fenced_human_active` while the session's own (human) queue holds
prompts, because `interrupt` clears that queue (`clearOutgoingQueue`, `base-session.js`)
and a principal must never discard a person's queued work.

### 4.2 Roster guard (S2)

A test enumerates **every registered client message type** (the protocol's
client-message schema registry and the live handler map) and requires each to be
classified in `PRINCIPAL_ALLOWED_MESSAGE_TYPES` **or** `PRINCIPAL_DENIED_MESSAGE_TYPES`,
**checked in both directions**, as `tests/bound-client-policy.test.js` does for bound
clients:

- a registered type in neither list → red (a new message type with no classification
  fails CI);
- a listed name that is not a real type → red (a stale entry);
- a type in both → red;
- every allowed entry has a non-empty written reason, and every allowed type is either
  session-local by construction or calls `principalMaySee`.

This is the false-safety class "a roster checked in one direction only"
([`../false-safety-guards.md`](../false-safety-guards.md)). The S2 PR must include a
mutation proof: delete one denied entry and one allowed entry, confirm red, legibly and
quickly. The guard must parse source with the repo's parser, not a hand tokenizer.

### 4.3 Never — each capability mapped to two independent refusals

No capability depends on one handler remembering to check. Column (a) is the new
dispatch allowlist (the type is simply absent). Column (b) is the **existing** gate that
would already refuse a bound or non-primary client, and therefore refuses a principal
through §3.1:

| Never | (a) dispatch | (b) existing gate that also refuses it |
|---|---|---|
| Auto / more-permissive mode changes, `acceptEdits`, `skipPermissions` | `set_permission_mode` absent; create constrained (§4.1) | `set_permission_mode` is a bound-guarded type that resolves the bound session, which the §3.1 sentinel never matches; the unattended mode additionally needs `allowAutoPermissionMode`; `skipPermissions:false` unchanged |
| Permission rules, `allowAlways` | `set_permission_rules` absent; `allow*` refused (§9) | `set_permission_rules` is in `BOUND_DENIED_MESSAGE_TYPES`; `permission_response` is bound-guarded and downgrades a standing allow |
| Credentials, `revoke_token`, pairing (`pair_approve`, `pair_deny`), QR and `/connect` | absent | all three are in `BOUND_DENIED_MESSAGE_TYPES`; `revoke_token` is also strict `isPrimaryToken` (`handleRevokeToken`); pairing HTTP routes refuse principals (§3) |
| Identity rotation | no WS type exists (CLI only) | CLI needs local primary authority |
| MCP config | `add_mcp_server` / `remove_mcp_server` absent | both in the bound denied list; `rejectMcpConfigWriteUnlessPrimary` |
| Skill trust | `skill_trust_accept` / `skill_trust_grant` absent | both in the bound denied list |
| File and git writes | `write_file`, `append_memory`, `git_stage`, `git_unstage`, `git_commit`, `git_create_pr` absent | all in the bound denied list; `write_file` also hits the config-dir refusal in `ws-file-ops` |
| Environments | `create_environment` / `destroy_environment` absent | bound denied list |
| Config / settings | host-wide `set_*`, `notification_prefs_set`, `session_preset_set` absent | bound denied list |
| User-shell, `terminal_input`, shell `terminal_subscribe` | absent | `terminal_input` is bound-allowed but session-local (sentinel refuses); the user-shell gates are strict `isPrimaryToken` (`handleTerminalInput`, `handleCreateSession` `PRIMARY_TOKEN_REQUIRED`). A principal reaches a claude-tui PTY only through the daemon-composed `sendMessage()` of §6 |
| Dev-preview publication | `open_dev_preview` absent | bound denied list; requires an authenticated primary-token WS client |
| Archive purge / policy | `delete_archived_session`, `set_session_archive_policy` absent | bound denied list |
| Daemon update / restart | `daemon_update_action` absent | bound denied list; `isPrimaryToken === true && !boundSessionId` first-statement gate |
| Scheduled tasks | `scheduled_task_action`, `set_scheduler_enabled` absent | bound denied list; `rejectSchedulerWriteUnlessPrimary` |
| Orchestration start | `orchestration_run_start` absent | bound denied list; `guardAction({ requirePrimary: true })` |
| Checkpoint file restore | `restore_checkpoint` absent | bound denied list |
| `set_model` (v1) | absent | bound-allowed but session-local (sentinel refuses); a model-switch delta is required to add it |

S2's guard additionally asserts that every row above that names a bound-denied type is
present in `PRINCIPAL_DENIED_MESSAGE_TYPES`. A row whose column (b) later changes is a
review trigger for this document.

## 5. Leases

A lease is the daemon's record that **this principal may mutate this session now**.
Process-local ownership (`_ownedSessions`) is replaced by it.

```
Lease { leaseId, sessionId, principalId, tier: 'steer'|'drive', gen, grantedBy, expiresAt }
```

### 5.1 Granting (D3)

- **Sessions a person started: the owner grants the lease.** Via the dashboard or
  `chroxy agent lease grant <label> <session> --tier steer|drive` (primary authority
  required). **An agent-initiated lease request is out of v1** — no `lease_request`
  message type exists, so a prompt-injected supervisor cannot talk itself into authority
  it was not given.
- **Sessions the principal created** (via `create_session` under drive scope) carry
  `createdBy: principalId`, persisted with session state, and re-grant the principal its
  **drive lease** on its own sessions after a restart (§5.4).
- A grant never exceeds the credential's tier: a `steer` principal cannot be handed a
  drive lease.

### 5.2 Holder rules and fencing

- **One holder per tier per session.** A second grant for a held tier is refused
  `LEASE_HELD`; the reply names the **holder's label only** — never `principalId`,
  token or lease generation.
- Every principal mutation carries `leaseId` and `gen`. The daemon compares both against
  the current lease at the effect point; any mismatch → `lease_stale`. `gen`
  increments on every grant, renew-after-lapse, suspend and revoke, so a send queued
  before a pre-emption cannot land after it.
- **Re-check after every `await`** in the handler (lease, credential, kill switch, "agents
  off") — the same discipline as the #9028 credential re-check. The TOCTOU between the
  fence read and the PTY/SDK write is bounded, not eliminated; see §13.
- **Lifetime (D9):** default **2 h**, renewed by `lease_renew` heartbeat (each renew
  extends to *now + 2 h*, bounded by the credential's own expiry). A lapsed lease → `lease_required`.
  **Leases do not survive a daemon restart.**

### 5.3 Human pre-emption and "agents off" (D4)

- **Human input suspends a drive lease.** Accepted human `input` on the session sets the
  drive lease `suspended`, bumps `gen` and drops the principal's queued entries (audited);
  principal mutations then answer `lease_suspended` until the owner resumes the lease
  (dashboard or CLI) or it expires. A principal cannot resume its own lease. A **steer
  lease coexists** with human use but its deliveries are fenced on human activity (§6.4).
- **Per-session "agents off" flag** (dashboard, `chroxy agent session-off <id>`):
  refuses every principal request on that session with `agents_off`, revokes its leases
  and drops its queue (audited). Persists with session state; only primary authority
  may clear it.

### 5.4 Durable `createdBy`

`createdBy: principalId` is written at create and persisted with session state. After a
daemon restart the creator, if its credential is still valid and in scope, is re-granted
the **drive lease** on that session (new `leaseId`, `gen` continuing from the persisted
high-water mark so pre-restart sends cannot match). A session whose creator principal
was revoked or expired has **no** automatic lease; it behaves as a human-started session.
Sessions a person started never gain `createdBy`.

### 5.5 Primary-client interplay

`ws-client-manager.js` `claimPrimary` is sticky and explicit, and accepted human input
force-adopts primary; `input_conflict` fires only while `session.isRunning` and another
client is primary. **A principal never claims or force-adopts primary**, its input does
not take the explicit-claim path, and `input_conflict` for a principal send is never
resolved by taking the role: a principal send that meets a busy session or an active
human is **queued in the agent queue** (§6.5), never admitted through the primary path.
Agents never write to the human's queue (`_outgoingQueue`, cap `OUTGOING_QUEUE_MAX` = 10
in `base-session.js`), composer or primary role, and never clear it (§4.1, `interrupt`).

## 6. Input Contract

Principals reuse the **`input` handler** (`handleInput` in
`packages/server/src/handlers/input-handlers.js`) with extra gates; there is no second
send path.

### 6.1 Required fields

`clientMessageId` is **required** for a principal and the daemon's ack is **mandatory**
(the principal handshake implies `input_context_v1`; a principal that omits
`clientMessageId` is refused `invalid_input` with an ack). Admission, execution and
outcome stay three distinct signals (#8698): the ack reports admission, the journal's
`turn_started`/`turn_ended` report execution (§7.3).

### 6.2 Provenance

The history entry (`session-message-history.js`, `recordUserInput`) currently stores
`{type, content, timestamp, messageId?, source?}` with no actor beyond `source:
'daemon'`. **Proposed (S7):** an `origin` field, persisted on the entry **and** on the
live `user_input` broadcast:

- agent: `origin: { kind: 'agent', principalId, label }`
- human: `origin: { kind: 'user', clientId, device }` (the live broadcast already carries
  an ephemeral clientId, excluded from the sender; history stores the device label only).

Dashboards and the app render an origin chip; an entry with no `origin` is a legacy human
entry.

### 6.3 Model-visible framing (D5)

The daemon composes the delivered text as `[agent:<label>] <sanitized text>` and **owns
framing and submission end-to-end**. The label comes only from the operator-authored
grant (§3). The model-visible prefix is the in-band half of provenance; the
`origin` field is the out-of-band half. **A labelled interjection carries no approval
authority**: it is advice, and nothing in the daemon treats a message with an `[agent:`
prefix as consent for anything.

### 6.4 Gate order (authoritative)

For a principal `input`, in this order; each gate fails closed and answers an ack with the
stated reason:

1. **Dispatch allowlist** (§4.1) — `scope_denied`, before any handler or logging.
2. **Credential valid** (hash match, not expired, not revoked, loopback peer) — close
   4401.
3. **Kill switch** (§10) — `agents_off` when the principal or label is disabled.
4. **Scope** — session within grant constraints and tier ≥ steer (`scope_denied`).
5. **Lease + gen** — `lease_required` (none/lapsed), `lease_stale` (gen/leaseId mismatch),
   `lease_suspended`.
6. **Per-session "agents off"** — `agents_off`.
7. **Sanitize** — the discord §5.1 step 3 rules, **reused by reference** (one shared
   module, D2), with an **agent profile**: strip Unicode `Cc` **except LF and TAB**
   (supervisor briefs are multi-line; the session's own `sendMessage()` already submits
   multi-line text safely, as it does for dashboard input), plus `Cf` and U+2028/U+2029;
   CR is stripped; reject-never-repair; combining-mark run ≤ 8; non-empty after strip.
   Bounds: **steer ≤ 2000 code points / 8192 UTF-8 bytes; drive ≤ 64 KiB UTF-8.** The
   reserved-sigil list adds **`[agent:`** (case-insensitive, anywhere in the body)
   alongside `[discord:` and `<system-`, so a body can never forge a second speaker; the
   list stays one code constant.
8. **Durable dedup** (§6.6) — a known `(principalId, sessionId, clientMessageId)` with the
   same payload hash → replay the memoized ack verbatim (`duplicate`), no effect; a
   different hash → `rejected` `payload_mismatch`. Dedup runs **before** the fence and the
   enqueue, so a retry of a message that is already queued can never queue it twice.
9. **Audit attempt** (§10) — fail-closed: an unwritten line means **no effect**.
10. **Fence → deliver or enqueue.** If the delivery fence (below) is clear and the agent
    queue is empty, deliver through the session's `sendMessage()` path, never a bulk PTY
    write (discord §5.1 step 4); otherwise enqueue (§6.5). The ack is `accepted` /
    `dispatch_started`, or `queued` / `queued` carrying the fence cause as `reason`
    (`fenced_pending_permission`, `fenced_human_active`, `fenced_busy`), or `rejected`
    `agent_queue_full`.
11. **Audit outcome**, then the ack. A later drain writes its own outcome line.

Sanitize runs before dedup so a rejected body is never memoized as success; dedup runs
before the attempt line so a replayed duplicate produces neither a second effect nor a
second attempt record.

**The delivery fence** applies to **every** principal delivery, at both tiers, and is
re-evaluated by the drain (all required):

- No #8281 handoff blockers on the session: `turn_active`, `queued_prompts`,
  `pending_permission`, `pending_question`, `evaluator_pending` (the proposed accessor's
  codes; where #8281 has not landed, S9 implements the same predicates locally and the
  guard test names each). A pending permission or question fences **every** tier: input
  that lands while an approval picker is showing is an approval by side effect (discord
  §4.1), and principals may not approve.
- Session not paused by budget or quota.
- **No dirty human composer:** clients send a new throttled `composer_state {sessionId,
  dirty}` (S9). **A client that never sends it counts as "human active" while it is the
  session's primary** — absence of a signal never reads as "clear".
- **No human input in the last N = 60 s** (`fenced_human_active`).

On a session with no human client attached (typically one the principal created), the
human-activity predicates are clear by construction, so the fence reduces to "turn
boundary, nothing pending".

### 6.5 Interject queue

A **per-session queue separate from `_outgoingQueue`**, used by both tiers (reuses the
Discord interject queue component, D2, with a distinct instance and audit component name;
entries are FIFO and drained one per turn boundary): in-memory,
**cap 3, reject-new** (`agent_queue_full`), **TTL 15 min**. A drain that loses a race
(`sendMessage()` returns `{ ok: false }`) **re-enqueues with TTL preserved**, audited as
a retry. Entries are dropped — one audit line each — on session end, daemon restart,
kill, revocation, "agents off" and lease release/suspension. Drain trigger is turn-finish
plus a fence re-check. The queue is non-durable by design: losing a parked interjection
on restart is acceptable, executing a stale one is not.

### 6.6 Durable dedup

Existing input dedup (`reserveInputRequest`, 10 min TTL, 60 min tombstone, cap 4096 per
session) is **process-local** — the ack carries `dedupScope: 'process'`
(`ServerInputAckSchema`, `packages/protocol/src/schemas/server/session.ts`). Principals
get a durable ledger keyed **`(principalId, sessionId, clientMessageId)`**, retained
**24 h**, a payload-hash mismatch rejected as in the existing path; the ack reports
`dedupScope: 'durable'` (S10). The reservation is written to its **own 0600 store,
synchronously, before the effect** — not through the debounced session-state write, which
can trail by up to 2 s and would let a crash forget a message that was already delivered.
An unwritable ledger means **no effect** (the same fail-closed rule as the audit
attempt). **Never auto-retry a
principal mutation after an `uncertain` result** — in the daemon, in agent-control and in
any supervisor guidance; the existing agent-control rule stands.

### 6.7 Ack reasons (new)

Rejections: `scope_denied`, `lease_required`, `lease_stale`, `lease_suspended`,
`agent_queue_full`, `agents_off`. Reasons on a `queued` ack (not refusals):
`fenced_pending_permission`, `fenced_human_active`, `fenced_busy`. All are in addition to
the existing input ack reasons. To a **non-granted or unauthenticated**
caller these collapse to the connection-level refusal; the specific reasons are returned
only to an authenticated principal about its own request.

## 7. Events

Today `agent-control/events.js` is a **client-side** normalized ring with
`${instanceId}:${epoch}:${seq}` cursors and gap reasons, lost on MCP restart (#7859).
Live broadcast frames carry no per-session sequence; `request_full_history` has no
`requestId`; `interrupt` has no ack. This section moves the ring into the daemon.

### 7.1 Journal (S3)

- **Daemon-side, per session, normalized** like `events.js` — the same event vocabulary,
  never raw PTY bytes. **Thinking is excluded by default.**
- **Bounded:** 2000 events per session (D7), per-event byte cap (4 KiB serialized;
  oversize is truncated with a `truncated: true` flag, not dropped), values redacted with
  the existing redactor before storage. Persisted with session state; an eviction advances
  the window start and is reported as a gap.
- **Cursor** `{ sessionId, journalId, seq }`. `journalId` changes when history is lost or
  rebuilt, so a stale cursor is detected rather than silently misaligned. Gap reasons:
  `evicted`, `journal_reset`, `restart_loss`, `unknown_cursor`.
- **Restart rule.** Session state is persisted on a debounce, so after a crash the stored
  tail can be short of the last `seq` a client saw; resuming the counter from it would
  **reuse sequence numbers for different events**. So `journalId` survives only a **clean
  shutdown** (final flush plus a clean-shutdown marker). Every other start mints a new
  `journalId`, and any older cursor reports `restart_loss` — never a silently realigned
  `seq`.

### 7.2 Subscribe, replay, live fence

1. `agent_subscribe { requestId, sessionIds, cursors? }` → `agent_subscribed
   { requestId, sessions: [{ sessionId, journalId, headSeq, gap? }] }`.
2. Replay frames (`agent_event` with `replay: true`) from the cursor to `headSeq`.
3. `agent_live_fence { requestId, sessionId, seq }` — everything after this is live.
4. Live `agent_event` frames. Live events arriving **during replay are held and
   released in `seq` order** after the fence, so a consumer never sees live before
   replay or out of order.

`agent_events_read { requestId, sessionId, cursor, limit }` is a paged pull, **limit ≤
200** per page, same cursor and gap semantics. Subscribe and read are limited to granted
sessions (§3.1 helper); a non-granted id is refused `scope_denied` indistinguishably from
a nonexistent one.

### 7.3 Pending permissions, roster, turn outcome

- `agent_pending_permissions { requestId, sessionIds? }` returns a snapshot from the
  **canonical state of both permission pipelines** (in-process and hook-routed,
  [`permission-floor.md` §3](permission-floor.md#3-both-pipelines-one-implementation)),
  with the `floored` verdict per request, so recovery after a reconnect does not guess
  (#7860, S4).
- `agent_sessions_snapshot` returns granted sessions with observed and declared status
  (#9026), handoff blockers, lease-holder **label**, model requested/observed (S5).
- `turn_started { turnId, causedBy, origin }` and `turn_ended { turnId, outcome }` journal
  events give execution and outcome their own signals (S14). `causedBy` references the
  admitting `clientMessageId`; `origin` is as in §6.2.

### 7.4 Interrupt

`interrupt` gains a `requestId`; the daemon answers `interrupt_ack { requestId,
status: 'sent' | 'not_running' | 'rejected' }`. The ack is **admission**; whether the turn
actually ended is `turn_ended` in the journal.

## 8. Redaction and what the journal never holds

Never in the journal, snapshots, acks or audit: tokens of any class, raw PTY, the
contents of floored reads (`permission-floor.md` §1), the full text of a rejected body,
another principal's label-to-id mapping. Journal contents are session output and are
therefore **new data at rest** with the sensitivity of the session history (§13).

## 9. Permission Answers

- **Deny only in v1 (D6).** A principal with answer scope may send `permission_response`
  with `decision: 'deny'` for a pending request on a session it holds a drive lease on. `allow`, `allowAlways`
  and any rule-creating response are refused `scope_denied` at dispatch **and** at the
  handler.
- **The bar for ever allowing `allow`:** the four agent-control gates are enforced
  **daemon-side** (ownership/lease, `NOT_DELEGABLE_TOOLS`, `FLOOR_ALLOWLISTED_TOOLS` /
  `COMMAND_TOOLS` flag, `floored === false`), with an absent flag refused (the
  fail-closed `floor_unknown` rule), **and** a HIGH-reviewed delta of this document
  naming the change. Neither the label nor an `[agent:` message ever substitutes.
- **`resolvedBy` on `permission_resolved` (S4).** The event today carries `requestId`,
  `decision`, `reason`, `scope` and no resolver. Proposed: `resolvedBy { kind: 'user' |
  'agent' | 'rule' | 'timeout' | 'auto_mode' | 'abort' | 'cleared', label? }` — a class
  plus the **operator-authored label** for agents, never a token or a raw client id.
- **The responder** learns whether its decision won via `decisionMatched` (#8927), so a
  deny that lost to a human allow is not reported as resolved.
- **Delivery audit (#7352, S15):** the permission audit records that a prompt reached,
  or failed to reach, at least one client. `PermissionAuditLog` is an in-memory ring of
  500 entries, so the durable record of every principal permission action is the `[AUDIT]`
  line (§10), not the ring.

## 10. Audit and Kill Switch

### 10.1 Audit — always-on, fail-closed

Emitted through the level-independent `logger.audit()` path (`[AUDIT]` lines in the
daemon audit log, with the retention floor the log-rotation policy already gives
`[AUDIT]`-tagged lines), component `agent-audit`. Like discord §9.1: a **pre-effect
attempt line** before every principal effect (enqueue, send, interrupt, create, destroy,
permission answer, lease change) — **if it cannot be written, there is no effect** — and
an **outcome line per transition** (`delivered | queued | expired | dropped:<reason> |
rejected:<reason> | killed`). `logger.audit()` is currently fire-and-forget; S11 adds a
writer that **reports success**, shared with #7169's, and principal access requires
file-backed logging (checked at `grant` and at boot).

Fields: `ts`, `principalId`, `label`, `action`, `sessionId`, `requestId` /
`clientMessageId`, `leaseId`/`gen`, `result`, `reason`, and for input **`sha256` of the
sanitized text plus its length — never the content** (D7; deliberately unlike discord
§9.1, which logs a prefix: agent text is high-volume and the transcript is the content
record). A rejected body logs the failing rule and the hash of the raw body only.
Repeated identical rejections within a minute collapse into one counter line, so a
hostile principal cannot spend disk through the always-on trail.

### 10.2 Kill switch

- `chroxy agent disable --all | --label <label>`, a dashboard button, and a
  strict-primary route. **Inbound only:** it never touches outbound notification sinks.
- **Immediate and persistent across restart** (the persisted flag is read before the
  principal store is trusted at boot). Order, modelled on discord §9.2: flip in memory
  (new frames refused `agents_off`) → close connections 4401 → **drain every queue,
  one `dropped:killed` audit line per entry** → release leases → persist. If the persist
  fails, the daemon also moves the principal store aside so every principal is invalid
  after restart.
- Re-enable is an explicit operator action (`chroxy agent enable`), never automatic.
- Manual fallback: deleting a principal's token file revokes nothing (the daemon stores
  only a hash), so **revoke or disable is the lever**; deleting the principal store
  invalidates every principal.

## 11. Blast-Radius Ledger

| Leaked | Attacker gains | Still cannot |
|---|---|---|
| **Primary token** (reference) | Everything the owner can do through Chroxy ([`bearer-token-authority.md` §1](bearer-token-authority.md#1-trust-model-in-one-sentence)): all sessions, input, modes, config, shells | — |
| Principal token, **observe** | Read journal, roster, pending permissions for granted sessions (session output; new data at rest) | Send anything, hold a lease, reach HTTP |
| Principal token, **steer** | Observe + one fenced, labelled interjection per fence window into a leased session; cap 3 queued | Approve, drive, interrupt, create, change any mode or config |
| Principal token, **drive** | Input and interrupt on leased/own sessions; create within cwd/provider/model bounds in `approve`/`plan` mode — i.e. an agent that can run *prompted* work the owner (or an automated rule) must still approve per tool | Raise a mode to auto/acceptEdits, skipPermissions, approve a prompt, rules, shells, files outside the session's own tools |
| Principal token, **answer** | Drive + **deny** pending prompts (denial-of-service on a session's progress) | `allow` anything |
| Any principal token from a **non-loopback** peer | Nothing (refused) | — |
| Any principal token with the **primary token also leaked** | N/A — the primary token already subsumes it | — |
| Daemon host | Everything (A4 in the Discord doc applies unchanged) | — |

A leaked principal token is **bounded by tier, lease, TTL (≤ 7 d), loopback and the kill
switch**; a leaked primary token is bounded by none of them. Because a same-user process
can already read the primary token (§2), the real security value of a principal is
**revocability, attribution and blast-radius for an agent that was handed less**, not
resistance to a local attacker.

## 12. What Each Child of #9112 Implements From This Document

| Child | Owns | Contract lines it is reviewed against |
|---|---|---|
| S1 principal store + `agent grant\|list\|revoke` | the credential | §3 table and discipline list, §3.1 stamps, 4401 + per-frame/post-await re-check, hash-only 0600 store via `readTrustedSecretFile`, HTTP refusal, loopback (§2) |
| S2 dispatch allowlist + roster guard | the router gate | §4.1, §4.2, §4.3 (both columns), mutation proof |
| S3 journal + subscribe/read | events | §7.1, §7.2, retention and cap, redaction (§8) |
| S4 pending snapshot + `resolvedBy` | permission visibility | §7.3, §9 |
| S5 roster + blockers + declared status | observe snapshot | §7.3, §4 observe row |
| S6 agent-control `--principal` read-only, `chroxy_wait_events` | the MCP adapter, read side | §2 (doctor warning), §4.1 observe types, bounded wait |
| S7 input `origin` + chips | provenance | §6.2 |
| S8 leases, `createdBy`, owner grant, "agents off" | lease model | §5 whole, `LEASE_HELD`, gen tokens |
| S9 fence, `composer_state`, interject queue | steer delivery | §6.4 fence, §6.5 queue, §6.4 gate order |
| S10 durable dedup | idempotency | §6.6, `dedupScope: 'durable'` |
| S11 audit + kill | the brakes | §10.1, §10.2, success-reporting audit writer |
| S12 constrained create | drive create | §4.1 create constraints, §5.4 |
| S13 drive interrupt + pre-emption | drive | §4.1 (`interrupt`, own-session `destroy_session`), §5.3, §6.4, §6.5 |
| S14 `interrupt_ack`, `turn_*` | outcomes | §7.3, §7.4 |
| S15 answer policy, `decisionMatched`, delivery audit | deny-only answers | §9 |
| S16 agent-control off the primary token | migration | §2 honest limit; one release of a legacy flag |
| S17 Control Room Agents tab + doctor row | operator surface | §2, §10.2 |
| S18 owner-path smoke | acceptance | §1 asymmetries exercised on an isolated daemon with a fixture planner |

**Ordering constraint.** S11's success-reporting audit writer is a precondition inside
S8, S9, S12–S15 effects (§10.1); land it first or in the same PR. S2 precedes any child
that adds a principal message type.

## 13. Residual Risks (accepted for v1)

- **Prompt-injection relay through a supervisor.** A supervisor that reads session
  output can be steered by text inside it and then steer another session. The `[agent:`
  label makes origin visible and keeps the daemon from treating it as authority, but an
  agent *may* act on advice; that is the feature. Mitigation is **who holds a lease**
  and the deny-only ceiling, not what steers may say. Treat `[agent:…]`-labelled input
  as untrusted relative to the operator at the keyboard.
- **Same-user containment (§2).** No sandbox against a hostile local process.
- **Owner lockout bounded by pre-emption, TTL and kill.** A principal can hold the steer
  or drive lease and fill the cap-3 queue; the owner can always type (human wins), revoke
  or kill, and leases and queues expire (2 h, 15 min).
- **New data at rest.** The journal persists up to 2000 normalized events per session
  alongside session state, and the principal store holds label/scope metadata. Both are
  0600 under the config dir and carry the session history's sensitivity; the audit
  holds hashes only.
- **TOCTOU between fence and send.** The fence is evaluated, then `sendMessage` runs; a
  human can start typing in between. Mitigations: re-check after every `await`, the
  human-wins pre-emption, and the lost-race re-enqueue. A residual window of one tick
  remains and is accepted because a steer is advice and cannot approve anything (§1).
- **`uncertain` outcomes.** A mutation whose confirmation did not arrive is never retried
  automatically, so a message can be lost; the supervisor's cursor and the journal let it
  decide.
- **Availability.** Disabling principals (kill or "agents off") is by design immediate;
  the dashboard and app are unaffected.

This document must not change any existing invariant: the permission floor, the
never-delegable set, `skipPermissions:false`, the auto-mode gates and every bound-client
and strict-primary refusal apply to principals exactly as to any non-primary client. A PR
that widens principal authority — including enabling `allow` (§9) or an agent-initiated
lease request (§5.1) — is reviewed at HIGH tier against this document and left for the
owner to merge.
