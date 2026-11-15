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
*proposed* and is implemented by the child named in §12. Every guard this document asks
for must be proven to fail ([`../false-safety-guards.md`](../false-safety-guards.md)); §4.4
states the common test rules.

Companion documents: [`bearer-token-authority.md`](bearer-token-authority.md) (the token
classes this sits beside), [`permission-floor.md`](permission-floor.md) (why approvals stay
human), [`discord-return-path.md`](discord-return-path.md) (the queue, fence, sanitizer and
audit design reused here — by reference), [`../guides/agent-control.md`](../guides/agent-control.md)
(the MCP adapter that becomes the first principal client), and
[`../guides/declared-session-status.md`](../guides/declared-session-status.md).

## 1. Trust Model in One Sentence

> An agent principal may **observe** the sessions its grant names, and — only while it
> holds a daemon-issued lease the owner granted — may send labelled, sanitized text into a
> session through a fenced queue (steer or drive), or, at drive tier, interrupt it and
> create and close its own sessions inside granted bounds, or **deny** a pending
> permission (answer). It may never approve a host action, widen any permission mode, or
> touch credentials, configuration, files, shells or the daemon. The ceiling is enforced
> by the daemon's router and handlers, not by the agent-control client or the agent.

The controlling asymmetry is the one from the Discord return path: **steering is advice
to an agent; an approval is authorization of a host action.** A principal carries the
first and, in v1, only the *refusing* half of the second (§9). The delivery fence (§6.4)
is what stops advice from turning into authorization by side effect (an interjection
landing in an approval picker).

Second asymmetry: **a human always wins.** Human input or terminal typing suspends a
drive lease and fences a steer; no principal action ever takes the primary role, the
composer or the human's queue (§5.5).

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
is configured with the primary token** and when the principal token file is readable by a
different user than intended: the guardrails below buy nothing for an agent that holds
the primary token ([`bearer-token-authority.md` §1](bearer-token-authority.md#1-trust-model-in-one-sentence)).

Today's agent-control gates are **client-side**. `_ownershipRejection`, the
`NOT_DELEGABLE_TOOLS` / `FLOOR_ALLOWLISTED_TOOLS` / `COMMAND_TOOLS` checks and the
`floored === false` requirement (`packages/server/src/agent-control/client.js`, with the
tool sets exported from `packages/server/src/permission-manager.js`) run inside the MCP
process; a raw WebSocket client holding the primary token bypasses all four. Ownership is
an in-memory `_ownedSessions` set, filled only from that process's own `create_session`
reply, so it cannot name a session a person started and does not survive a restart. The
principal design **moves the gates into the daemon** (§3.1, §9) and **replaces
process-local ownership with durable leases** (§5).

**Loopback-only acceptance in v1 (D8).** A principal token is accepted only on a
connection that passes `isLoopbackPeer(req)` (`packages/server/src/connection-locality.js`).
A bare socket-address check is **not enough**: the Cloudflare tunnel connects to the
daemon from 127.0.0.1, so tunnel traffic looks loopback by address. `isLoopbackPeer`
additionally rejects any request carrying a proxy-family header and parses the address
strictly; its own doc-comment states its limit (a proxy that strips every hint header, or
a local process forwarding for a remote party, passes it). So it is defence in depth;
**the token remains the authority**, and a remote supervisor is out of scope for v1 (it
needs its own delta: TLS, host binding, IP policy). **`isLoopbackPeer` has no WebSocket
caller today** (its only callers are in `http-routes.js`); S1 adds one at the upgrade and
**retains the upgrade `req` on the client record** so the check re-runs at `auth`. A
principal token presented from any other peer is refused with the same opaque failure as
an invalid token. Test: a fixture upgrade with a proxy-family header and a loopback
socket address is refused (mutation: drop the header test; positive control: a plain
loopback upgrade authenticates).

## 3. The Credential Class (D1)

[`bearer-token-authority.md` §2](bearer-token-authority.md#2-the-four-token-classes)
lists four classes and notes a fifth (discord-return) and this sixth as designed. The
agent principal is a **separate** class — not the primary token, not a pairing token (a
pairing token binds one *device* to one session; a principal is an *agent*, with its own
tiers, leases, label and kill switch). Table rows land in §2 and §7 of that document when
S1 implements the class.

| | agent principal token |
|---|---|
| Issued by | `chroxy agent grant --label <label> --scope observe\|steer\|drive\|answer --session <id> \| --cwd <root> [--provider ..] [--model ..] [--ttl <dur>]`, run under **local primary authority** through the management surface below. Until S11 lands, `grant` refuses with "agent principals not yet enabled" (§12) |
| Token | `randomBytes(32).toString('base64url')`, shown **once**, written to a 0600 file under the config dir's `agents/` subdirectory (atomic write, `CHROXY_CONFIG_DIR` honored). Never printed to argv, env or logs |
| Daemon stores | **Only** a SHA-256 hash of the token plus `principalId`, `label`, scopes, constraints (session ids / cwd roots / providers / models), `createdAt`, `expiresAt`, `revokedAt`, in a 0600 store read through `readTrustedSecretFile` (`packages/server/src/trusted-file-read.js`: `O_NOFOLLOW` open, `fstat` on the same fd, mode and owner check). A store that is not exactly 0600, not owned by the daemon's uid or a symlink is **refused, not trusted** — every principal is then invalid (fail closed), and `chroxy doctor` names the recovery: re-mode the file to 0600 under the daemon's uid |
| Label | Operator-authored at grant time; charset `^[a-z0-9_-]{1,32}$`, unique among live grants, validated at load (mirrors discord §5.3: the label is later interpolated into model-visible text). **Never taken from the wire** |
| TTL | Default **24 h**, maximum **7 d** (D9); a request above 7 d is refused, not clamped. Expiry is absolute |
| Scope | Per §4. Fail-safe: an unknown or malformed scope string grants nothing |
| Used on | WS `auth` message only, from a loopback peer (§2). **Refused on every HTTP route in v1**: `_validateBearerAuth` already refuses a session-scoped token unless the route opts in with `{ allowScoped: true }`, and no opt-in route may name principals (§4.5 roster) |

Discipline (each line is a review checklist item for S1):

- **Constant-time validation** (`safeTokenCompare`, `packages/server/src/token-compare.js`)
  of the presented token's hash against every stored hash, so timing does not reveal
  which principal matched; the token is never logged; `maskToken` on diagnostics.
- **No fallback in either direction.** Accepted at WS `auth` only; no primary, pairing,
  hook or ingest path accepts it, and it never satisfies `isPrimaryToken`.
- **Auth failure** shares the exponential-backoff rate limit in `ws-auth.js`; every
  failure answers identically (unknown, expired, revoked and wrong-peer are
  indistinguishable).
- **Revocation** (`principal_admin_revoke`, CLI, dashboard): sets `revokedAt`, persists it
  **before** acknowledging, closes every connection of that principal with
  `credential_invalidated` and close code **4401**, drops its queue entries (audited,
  §10) and releases its leases.
- Renewal is a new `grant` (the old token stays valid until its own expiry or a revoke).

### 3.0 Where the credential is re-checked (WebSocket)

`bearer-recheck.js` (`captureBearer` / `bearerStillValid`) is the **HTTP** post-body
re-check, not a per-frame one; do not cite it for WebSocket. The WebSocket analogues, all
in `packages/server/src/ws-server.js`, are:

- `_isConnectionAuthorized(client)` — for code that resumes after an `await`;
- `_mayDeliverTo(client, message)` — the outbound delivery gate;
- `_endCredentialConnection(ws, client, reason)` — the only path that ends a connection
  with close code 4401 (`WS_CLOSE_CREDENTIAL_INVALID`), after sending
  `credential_invalidated`.

All three are keyed on `client.pairingCredential`. **S1 adds the principal wiring** to
each (credential live, not expired, not revoked, not killed, loopback origin retained).
Three requirements follow, each with a test:

1. **Every inbound frame** is re-checked before dispatch; **every outbound delivery and
   flush** is re-checked in `_mayDeliverTo` (a passive subscriber that never sends a
   frame must still be cut off). Test: revoke, expire and kill each cut a connection that
   sends nothing, including one with replay buffered across the event.
2. **A per-connection expiry timer** closes the connection with 4401 at `expiresAt` and
   cleans its subscriptions and buffers. Test: advance a fake clock past `expiresAt` with
   no inbound frames.
3. **One wrapper, `withPrincipalEffect(client, check, fn)` (proposed, S1)**, runs `fn`
   only after re-validating credential, kill switch, "agents off", lease and `gen` *at the
   commit point* (after the last `await`). Every principal mutation handler runs inside
   it. Test, parametrised over the allowed mutation roster: inject a revoke, a kill and a
   lease bump at each `await` and assert zero effect. Mutation: remove the wrapper from
   one handler, confirm red. Positive control: the same handler with nothing injected
   takes effect.

### 3.1 A principal must never read as host authority

`isBoundClient(client)` (`packages/server/src/environments/authority.js`) is
`!client || client.boundSessionId != null`: the **only** unbound case is
`boundSessionId == null`. `isBoundToOtherSession(client, sessionId)` is its own predicate
and does **not** call `isBoundClient`. In the broadcaster
(`ws-broadcaster.js` `_sendOneWithBackpressure`) a frame **without a string `sessionId`
passes** to every client. A class that left the stamps at their unscoped values would
read as host everywhere. So, as contract:

1. **Stamps.** A principal connection is stamped `client.principal = { principalId,
   label, tier, scope, constraints }` and `client.isPrimaryToken = false` (strict
   `=== true` gates already read false). `isBoundClient` gains the clause
   `|| client.principal != null` (S1 owns it; fail-safe, same shape as the `== null`
   rule).
2. **Sentinel, as defence in depth.** `client.boundSessionId` is set to a **fixed,
   non-empty, opaque sentinel** that no creatable session id can equal (S1 asserts this by
   test), so every existing host gate that branches on the binding still refuses a
   principal. The sentinel is **never serialized**: `sendBoundRefusal` /
   `buildSessionTokenMismatchPayload` (`bound-client-policy.js`, `handler-utils.js`),
   `auth_ok`, and the bootstrap in `ws-history.js` omit or replace it for principals. A
   principal's `auth_ok` carries no session list beyond its grant and no replay. Test:
   scan every frame a principal receives across the §4.4 fixture for the sentinel string.
3. **Inbound choke point.** `ws-server.js` calls `refuseBoundMessage(ws, client, msg, …)`
   before schema validation for every `isBoundClient` client. For a principal the
   contract is: run **`refusePrincipalMessage`** (the principal dispatch allowlist,
   S2) **instead of** `refuseBoundMessage` at that point. The bound allowlist is **never
   consulted** for principals and the bound policy is **not loosened**. Order: dispatch
   allowlist → `principalMaySee` → handler. Test: a principal sending a type that is
   bound-allowed but principal-denied (e.g. `terminal_input`) is refused `scope_denied`,
   and a spy shows `refuseBoundMessage` was not called.
4. **Outbound choke point.** `ws-server.js` `_send` drops a bound client's frame tagged
   with another session and then applies `frameForBoundClient`
   (`outgoing-policy.js`), which is deny-by-default on type. For a principal `_send`
   applies a separate **`frameForPrincipal`**: a principal **outgoing allowlist**, deny by
   default, whose scope check is "is this frame's session in the grant" — the sentinel
   match is not used for delivery. A frame with no `sessionId` is delivered only if its
   type is on the principal allowlist. S2 adds an **outgoing roster guard** in both
   directions, modelled on `tests/outgoing-policy.test.js`.
5. **One access helper.** Per-session access goes through **`principalMaySee(client,
   sessionId, need)`** (S2): grant session/cwd constraint, tier and, for mutations,
   lease. No principal-aware handler does its own check.
6. **Per-handler carve-outs are acceptance items**, each with a mutation proof (§4.4):
   - `handleCreateSession` (`handlers/session-handlers.js`) refuses any truthy
     `client.boundSessionId` up front, so create needs an explicit `client.principal`
     branch placed before it (S12).
   - `destroy_session`, `permission_response` (`ws-permissions.js` passes the
     connection's binding to the permission resolver), `input` and `interrupt` each need
     an explicit principal branch that resolves the target through `principalMaySee` and
     can never fall into the host path (S2, S8, S13, S15).
   - Principal `input` and `interrupt` carry an **explicit `sessionId` with no fallback to
     `activeSessionId`**; a missing id is `invalid_input`.
   - Principal create **does not call `setActiveSession` or `subscribeClient`** on the
     principal and does not move any human client's focus. Human clients are told of the
     new session through the normal roster, flagged `origin: agent`.
7. **A principal receives no ordinary session broadcasts.** Its read path is the
   `principal_*` family (§7) plus direct replies to its own requests. What a principal
   sees is daemon-normalized and bounded, never the raw replay a dashboard gets.

**Management surface.** `chroxy agent …` (CLI) and the dashboard's Agents tab (S17) drive
grants, revocation, leases, "agents off" and the kill switch through new
**strict-primary, loopback-only** WS types: `principal_admin_grant`,
`principal_admin_list`, `principal_admin_revoke`, `principal_admin_disable`,
`principal_admin_enable`, `principal_admin_lease_grant`, `principal_admin_lease_revoke`,
`principal_admin_lease_resume`, `principal_admin_session_off`. Each gates on
`client.isPrimaryToken === true && !client.boundSessionId && !client.principal` as its
**first statement**, sits in `BOUND_DENIED_MESSAGE_TYPES` **and**
`PRINCIPAL_DENIED_MESSAGE_TYPES`, and writes the store from the daemon process only — the
CLI never edits the store file, so daemon and CLI cannot race.

## 4. Authority Tiers and Dispatch

| Tier | Grants | Lease | Constraint |
|---|---|---|---|
| **observe** | Roster of granted sessions with observed + declared status, handoff blockers (#8281), lease-holder label, model requested/observed; normalized event journal subscribe/read; pending-permission snapshot | none | granted sessions only |
| **steer** | observe + fenced, queued input | `steer` | one holder per session |
| **drive** | steer + `interrupt` on a leased session, create sessions within granted cwd roots / providers / models, close **only sessions it created** | `drive` | `permissionMode` only `approve` or `plan` at create; never `acceptEdits`/`auto`; never `skipPermissions`; never user-shell |
| **answer** | drive + **deny** pending permission requests | `drive` + answer scope | **deny only in v1** (§9) |
| **never** | see §4.3 | — | — |

A grant carries exactly one tier; higher tiers include everything below them.

**Input is the same contract at steer and drive.** Every principal `input` goes through
the same gates, fence and agent queue (§6.4, §6.5), so it lands only at a turn boundary
with no prompt pending and no human composing. The tiers differ in what else they may do
and in how human input affects the lease (§5.3). v1 principal input is **text only**:
`attachments` and `context` items are refused `scope_denied`.

### 4.1 Deny-by-default dispatch and the v1 allowlist

A principal connection may send **only** allowlisted message types, checked **before any
handler, schema validation, session lookup or payload logging**, by `refusePrincipalMessage`
(§3.1 item 3), modelled on `refuseBoundMessage` (`bound-client-policy.js`). Anything not
listed — a malformed type, a type registered later and never classified, anything sent
while the daemon drains — is refused `scope_denied`. The refusal echoes
`requestType`/`requestId` only when they are short strings and carries no detail beyond
the code.

All **new** types carry a **`principal_` prefix**, because `agent_event` already exists
(background-agent frames, `packages/protocol/src/schemas/server/activity.ts`, and
`BOUND_OUTGOING_ALLOWED`). Proposed `PRINCIPAL_ALLOWED_MESSAGE_TYPES`:

| Tier | Existing types reused | New types proposed |
|---|---|---|
| all | `auth`, `key_exchange`, `ping` (transport; asserted as the separate exempt set, §4.2) | `principal_subscribe`, `principal_unsubscribe`, `principal_events_read`, `principal_pending_permissions`, `principal_sessions_snapshot` |
| steer | `input` (lease required; fenced and queued, §6) | `principal_lease_renew`, `principal_lease_release` |
| drive | `interrupt` (requestId required, §7.4), `create_session` (closed allowlist, §4.1.1), `destroy_session` (**sessions it created only**) | — |
| answer | `permission_response` (**`deny` only**, field-limited, §9) | — |

Server frames, all new and all prefixed: `principal_subscribed`, `principal_event`,
`principal_events_page`, `principal_live_fence`, `principal_interrupt_ack`. S2's guard
asserts **no new name collides with an existing client or server schema type**.

History and roster reads go through the `principal_*` types, whose payloads are
daemon-normalized and bounded, never through `request_full_history`, `list_sessions` or
terminal types that expose raw output.

#### 4.1.1 Create is a closed allowlist (S12)

Principal `create_session` accepts **only** `name`, `cwd`, `provider`, `model`,
`permissionMode`, `worktree` and `requestId`. **Any other key is refused `scope_denied`**,
including `.passthrough()` extras and the real fields `sandbox` (a passthrough
`SandboxSchema` that can set `autoAllowBashIfSandboxed`, allowed commands and paths),
`codexSandbox` (including `danger-full-access`), `connectionId`, `environmentId`,
`isolation`, `agentCommId` and `skipPermissions`. User-shell is gated today by
`provider === USER_SHELL_PROVIDER` plus strict primary (`handleCreateSession`); principal
create refuses provider `user-shell` explicitly (there is no `userShell` field).

The daemon writes **explicit** values — `skipPermissions: false`, an explicit
`permissionMode` in {`approve`, `plan`}, no sandbox override, the provider's default
connection — and, **immediately before creation**, validates the *fully resolved* plan:
provider, model, mode, isolation, `realpath` of `cwd` under a granted root, and the
effective sandbox. It **refuses** when a daemon default (`_defaultSkipPermissions`,
`_defaultPermissionMode` in `session-manager.js`, a config sandbox) would make the
effective configuration more permissive than the grant allows. `worktree: true` is allowed
only under a granted root. The created session records `createdBy: principalId` (§5.4).
Test: one case per refused key and per default that would widen, plus a positive-control
create that succeeds.

#### 4.1.2 Destroy and interrupt

`destroy_session` is refused for every session whose `createdBy` is not this principal —
an owner-granted drive lease on a person's session **never** lets a principal close it.
`interrupt` needs a drive lease, requires an explicit `sessionId` and `requestId`, and is
refused `fenced_human_active` while the session's own (human) queue holds prompts: each
provider's interrupt path clears that queue through `clearOutgoingQueue`
(defined in `base-session.js`; called from the codex app-server and ACP sessions among
others), so the refusal must be implemented **per provider**, not in the base class. A
principal interrupt records `origin.kind = 'agent'` in the journal and audit; the human
`recordUserInterrupt` attribution (`session-manager.js`) is **not** used. Interrupting
while a permission or question is pending denies that prompt; this is permitted, because
it is a deny.

### 4.2 Roster guard (S2)

The guard enumerates the **union** of the protocol client-schema registry and
`registeredMessageTypes` (`ws-message-handlers.js`, i.e. `handlerRegistry.keys()`). A type
present in one but not the other is red. `auth`, `key_exchange` and `ping` are handled in
`ws-auth.js` / `ws-server.js` outside the registry; they form a **separately asserted
transport exempt set** (asserted equal to that literal list), not a hole in the roster.
Each type must be in `PRINCIPAL_ALLOWED_MESSAGE_TYPES` or `PRINCIPAL_DENIED_MESSAGE_TYPES`,
**checked in both directions**, as `tests/bound-client-policy.test.js` does:

- a registered type in neither list → red; a listed name that is not a real type → red; a
  type in both → red;
- every allowed entry has a non-empty written reason;
- **behavioural check:** for each allowed type, a principal with **no grant** for the
  target session is refused at the handler (not merely by the dispatch list);
- the roster is asserted **non-empty** and the case count is asserted greater than 0 (the
  zero-case class, `../false-safety-guards.md`).

Mutations: delete one denied entry and one allowed entry; remove the `principalMaySee`
call from one allowed handler. Each must go red, legibly and quickly. The guard parses
source with the repo's parser, not a hand tokenizer.

### 4.3 Never — each capability mapped to two independent refusals

No capability depends on one handler remembering to check. Column (a) is the dispatch
allowlist (the type is absent). Column (b) is the **existing** gate that already refuses a
bound or non-primary client and therefore refuses a principal through §3.1. **The table is
a machine-read constant in code (S2, `PRINCIPAL_NEVER_CAPABILITIES`) and the guard reads
that constant, not this prose.**

| Never | (a) dispatch | (b) existing gate that also refuses it |
|---|---|---|
| Auto / more-permissive mode, `acceptEdits`, `skipPermissions` | `set_permission_mode` absent; create is a closed allowlist (§4.1.1) | `set_permission_mode` is bound-guarded and resolves the bound session (the sentinel matches none); the unattended mode needs `allowAutoPermissionMode`; `skipPermissions:false` unchanged |
| Permission rules, `allowAlways` | `set_permission_rules` absent; `allow*` refused (§9) | `set_permission_rules` in `BOUND_DENIED_MESSAGE_TYPES`; `permission_response` is bound-guarded and downgrades a standing allow |
| Credentials, `revoke_token`, pairing (`pair_approve`, `pair_deny`), QR and `/connect` | absent | the WS types are in `BOUND_DENIED_MESSAGE_TYPES`; `revoke_token` is also strict `isPrimaryToken`; pairing HTTP routes refuse principals (§4.5) |
| Identity rotation | no WS type exists (CLI only) | CLI needs local primary authority |
| MCP config | `add_mcp_server` / `remove_mcp_server` absent | bound denied list; `rejectMcpConfigWriteUnlessPrimary` |
| Skill trust | `skill_trust_accept` / `skill_trust_grant` absent | bound denied list |
| File and git writes | `write_file`, `append_memory`, `git_stage`, `git_unstage`, `git_commit`, `git_create_pr` absent | bound denied list; `write_file` also hits the config-dir refusal in `ws-file-ops` |
| Environments | `create_environment` / `destroy_environment` absent | bound denied list |
| Config / settings | host-wide `set_*`, `notification_prefs_set`, `session_preset_set` absent | bound denied list |
| User-shell, `terminal_input`, shell `terminal_subscribe` | absent | `terminal_input` is bound-allowed but session-local (the sentinel refuses); the user-shell gates are strict `isPrimaryToken` (`handleTerminalInput`, `handleCreateSession` `PRIMARY_TOKEN_REQUIRED`). A principal reaches a claude-tui PTY only through the daemon-composed `sendMessage()` of §6 |
| Dev-preview publication | `open_dev_preview` absent | bound denied list; needs an authenticated primary-token WS client |
| Archive purge / policy | `delete_archived_session`, `set_session_archive_policy` absent | bound denied list |
| Daemon update / restart | `daemon_update_action` absent | bound denied list; `isPrimaryToken === true && !boundSessionId` first-statement gate |
| Scheduled tasks | `scheduled_task_action`, `set_scheduler_enabled` absent | bound denied list; `rejectSchedulerWriteUnlessPrimary` |
| Orchestration start | `orchestration_run_start` absent | bound denied list; `guardAction({ requirePrimary: true })` |
| Checkpoint file restore | `restore_checkpoint` absent | bound denied list |
| `set_model` (v1) | absent | bound-allowed but session-local (the sentinel refuses); a model-switch delta is required to add it |

**Proving "two independent refusals".** For each row the test (1) calls the **real
handler directly** with a principal-stamped client and the dispatch allowlist bypassed,
and expects a refusal; (2) with the allowlist active, expects `scope_denied`. The
mutation proof **deletes the column-(b) gate** and expects red, so the dispatch list alone
is shown not to be carrying the row. A row whose column (b) later changes is a review
trigger for this document.

### 4.4 Common test rules (apply to every guard in this document)

Each contract line below has an **observable**, a **test**, a **mutation** and a
**positive control**; where a section omits one it inherits these:

- **Positive control per tier:** an allowed type succeeds with grant, lease and scope
  present, so a deny-everything check cannot pass its negative tests for the wrong reason
  (#7273).
- Every guard asserts its case count is **> 0** and every roster is **non-empty**.
- Expectations come from an **independent oracle**, not the subject's own counters
  (#7424); mutations are restored with `cp`, never `git checkout --`.
- A test that the dispatch refusal happens **before payload logging** attaches a log
  listener and asserts it never sees the payload (S2).
- A guard against a hang fails fast: assertions on large text use boolean `assert.ok`.

### 4.5 HTTP route roster (S1)

Every HTTP route that accepts a bearer is **enumerated** in a roster, and a principal
token is refused on each. The roster is checked in both directions: a route that accepts
bearer auth but is missing from the roster is red; a route that is listed but absent is
red; and a route that begins accepting principals is red (no route in v1 opts in).
Mutation: add `principal` acceptance to one route; positive control: the same route
accepts the primary token.

## 5. Leases

A lease is the daemon's record that **this principal may mutate this session now**.
Process-local ownership (`_ownedSessions`) is replaced by it.

```
Lease { leaseId, sessionId, principalId, tier: 'steer'|'drive', gen, grantedBy, expiresAt }
```

### 5.1 Granting (D3)

- **Sessions a person started: the owner grants the lease**, through
  `principal_admin_lease_grant` (dashboard or `chroxy agent lease grant <label> <session>
  --tier steer|drive`, primary authority required). **An agent-initiated lease request is
  out of v1** — no such message type exists, so a prompt-injected supervisor cannot talk
  itself into authority it was not given.
- **Sessions the principal created** carry `createdBy: principalId`, persisted with
  session state, and regain a **drive lease** after a restart only under §5.4.
- A grant never exceeds the credential's tier.

### 5.2 Holder rules and fencing

- **One holder per tier per session.** A second grant for a held tier is refused
  `lease_held`; the reply names the **holder's label only** — never `principalId`, token
  or generation.
- Every principal mutation carries `leaseId` and `gen`. Any mismatch at the effect point →
  `lease_stale`. `gen` increments on every grant, renew-after-lapse, suspend and revoke,
  so a send queued before a pre-emption cannot land after it. The `gen` high-water mark is
  **persisted synchronously** (§5.4) and owned by S8.
- Re-validation is done by `withPrincipalEffect` (§3.0), after every `await`.
- **Lifetime (D9):** default **2 h**, renewed by `principal_lease_renew` heartbeat (each
  renew extends to *now + 2 h*, bounded by the credential's `expiresAt`). A lapsed lease →
  `lease_required`. **Leases do not survive a daemon restart.**

### 5.3 Human pre-emption and "agents off" (D4)

- **Human activity suspends a drive lease.** Accepted human `input` **or human
  `terminal_input`** on the session sets the drive lease `suspended`, bumps `gen` and
  drops the principal's queued entries (audited); principal mutations then answer
  `lease_suspended` until the owner resumes it (`principal_admin_lease_resume`) or it
  expires. A principal cannot resume its own lease. A **steer lease coexists** with human
  use but its deliveries are fenced (§6.4).
- **Per-session "agents off"** (`principal_admin_session_off`): refuses every principal
  request on that session with `agents_off`, revokes its leases and drops its queue
  (audited). Only primary authority may clear it.

### 5.4 Durable owner state, suppression and `createdBy` (E1)

Owner actions must survive a crash, so **"agents off", lease suspension, lease revocation
and the `gen` high-water mark are written synchronously (write, fsync, rename) to the
principal store — never through the debounced session-state write — before the action is
acknowledged.** Precedence, highest first: **kill > agents-off > lease revocation or
suspension > `createdBy` restoration.**

`createdBy: principalId` is written at create and persisted with session state (S8 owns
the persistence, S12 consumes it). After a restart the creator, if its credential is valid
and in scope, is re-granted a **drive lease** (new `leaseId`, `gen` continuing from the
persisted high-water mark) **only if no suppression record exists for that
(session, principal)**; `createdBy` alone never restores suppressed authority. A session
whose creator was revoked or expired behaves as a human-started session. Sessions a
person started never gain `createdBy`. Test: a restart after each owner action
(agents-off, suspend, revoke) leaves the principal without a lease; mutation: ignore the
suppression record; positive control: a restart with no suppression restores the lease.

### 5.5 Primary-client interplay

`claimPrimary` (`ws-client-manager.js`) is sticky and explicit, and accepted human input
force-adopts primary; `input_conflict` fires only while `session.isRunning` and another
client is primary. **A principal never claims or force-adopts primary**, its input does
not take the explicit-claim path, and no evaluator outcome adopts primary for it (§6.8).
A principal send that meets a busy session or an active human is **queued in the agent
queue** (§6.5), never admitted through the primary path. Agents never write to the
human's queue (`_outgoingQueue`, cap `OUTGOING_QUEUE_MAX` = 10 in `base-session.js`),
composer or primary role, and never clear it (§4.1.2).

## 6. Input Contract

Principals reuse the **`input` handler** (`handleInput` in
`packages/server/src/handlers/input-handlers.js`) with extra gates; there is no second
send path.

### 6.1 Required fields

`clientMessageId` and an explicit `sessionId` are **required**, and the daemon's ack is
**mandatory** (the principal handshake implies `input_context_v1`); a principal that omits
either is refused `invalid_input` with an ack. Admission, execution and outcome stay three
signals (#8698): the ack reports admission; the journal's `turn_started` / `turn_ended`
report execution (§7.3).

### 6.2 Provenance

The history entry (`recordUserInput`, `session-message-history.js`) stores `{type,
content, timestamp, messageId?, source?}` with no actor beyond `source: 'daemon'`.
**Proposed (S7):** an `origin` field, persisted on the entry **and** on the live
`user_input` broadcast: agent `origin: { kind: 'agent', principalId, label }`; human
`origin: { kind: 'user', clientId, device }`. Dashboards and the app render an origin
chip; an entry with no `origin` is a legacy human entry.

### 6.3 Model-visible framing (D5)

The daemon composes the delivered text as `[agent:<label>] <sanitized text>` and **owns
framing and submission end-to-end**. The label comes only from the operator-authored
grant. **A labelled message carries no approval authority**: nothing in the daemon treats
an `[agent:` prefix as consent for anything.

### 6.4 Gate order (authoritative)

For a principal `input`, in this order; each gate fails closed with an ack carrying the
stated reason (§6.7):

1. **Dispatch allowlist** (§4.1) — `scope_denied`, before any handler or logging.
2. **Credential valid** (hash, not expired, not revoked, loopback origin retained) — close 4401.
3. **Kill switch** (§10) — `agents_off`.
4. **Scope** — session within grant constraints and tier ≥ steer (`scope_denied`).
5. **Lease + gen** — `lease_required`, `lease_stale`, `lease_suspended`.
6. **Per-session "agents off"** — `agents_off`.
7. **Sanitize** — discord §5.1 step 3, **reused by reference** (one shared module, D2;
   S9 owns the agent profile and the `[agent:` sigil), with an **agent profile**: strip
   Unicode `Cc` **except LF and TAB** (supervisor briefs are multi-line; `sendMessage()`
   already submits multi-line text safely), plus `Cf` and U+2028/U+2029; CR is stripped;
   reject-never-repair; combining-mark run ≤ 8; non-empty after strip. Bounds: **steer ≤
   2000 code points / 8192 UTF-8 bytes; drive ≤ 64 KiB UTF-8.** The reserved-sigil list
   adds **`[agent:`** (case-insensitive, anywhere in the body) alongside `[discord:` and
   `<system-`, one code constant.
8. **Durable dedup** (§6.6) — a known `(principalId, sessionId, clientMessageId)` with the
   same payload hash replays the memoized ack (`replayed: true`), no effect; a different
   hash → `payload_mismatch`. Dedup runs **before** the fence and enqueue, so a retry of a
   queued message can never queue it twice.
9. **Audit attempt** (§10) via `auditOrRefuse()` — an unwritten line means **no effect**.
10. **Fence → deliver or enqueue.** If the fence below is clear and the agent queue is
    empty, deliver through the provider write boundary (§6.9); otherwise enqueue (§6.5).
    The ack is `accepted` (`dispatch_started`), or `queued` carrying the fence cause as
    `reason` (`fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`,
    `fenced_busy`), or `rejected` `agent_queue_full`.
11. **Audit outcome**, then the ack. A later drain writes its own outcome line.

Sanitize runs before dedup so a rejected body is never memoized as success; dedup runs
before the attempt line so a replayed duplicate produces neither a second effect nor a
second attempt record. Test: assert this order with a recording harness, for each gate
failing in turn (mutation: swap two gates).

**The delivery fence** applies to **every** principal delivery at both tiers, and is
re-evaluated by the drain. All of:

- No #8281 handoff blockers: `turn_active` (`_isBusy`, **not** `isRunning`, so background
  shells never block), `queued_prompts` — **including a dequeued human prompt that has not
  started yet (the dequeue-in-flight flag)** — `pending_permission`, `pending_question`,
  `evaluator_pending`. Where #8281 has not landed, S9 implements the same predicates and
  the guard test names each. A pending permission or question fences **every** tier: input
  landing in an approval picker is an approval by side effect (discord §4.1).
- Session not paused by budget or quota.
- **No human PTY activity (claude-tui):** a daemon-owned per-session **`ptyDirty`** flag
  is set by any human `terminal_input` write (`handleTerminalInput` calls
  `writeTerminalInput` directly and bypasses `handleInput`, so no input-path signal sees
  it) and cleared **only** at an observed submit (Enter) or turn start. It **survives
  client disconnect and has no time expiry**. While set → `fenced_pty_dirty`.
- **No dirty human composer:** clients send a throttled `composer_state {sessionId,
  dirty}` (S9). A dirty composer stays dirty for a **5 min grace** after its client
  disconnects. **A primary client that never sent the signal counts as "human active"
  for at most 10 min since its last human activity** (input, terminal input, claim);
  after that the fence needs only `ptyDirty` clear and no recent human write, so a stale
  primary cannot starve delivery.
- **No human input or human `terminal_input` in the last N = 60 s** (`fenced_human_active`).

Fence predicates are **per provider**: `ptyDirty` applies to claude-tui; SDK, CLI and
Codex sessions have no shared PTY composer, so only the remaining predicates apply. On a
session with no human client attached (typically one the principal created) the human
predicates are clear by construction.

### 6.5 Agent delivery lock and queue (D6, D4)

One **per-session agent delivery lock and one drain**, shared by **all principals and the
Discord return path** (reusing its queue component, D2, with a distinct audit component).
Entries are tagged by source (`principalId` or `discord`) and drained **FIFO across
sources**; a revoke drops only that principal's entries; a steer holder and a drive holder
of different principals can never write concurrently because the lock serializes them.

The queue is **separate from `_outgoingQueue`**, in-memory, **cap 3, reject-new**
(`agent_queue_full`), **TTL 15 min**. The cap and TTL are chosen for **bounded staleness
and bounded owner lockout**, not for any external token lifetime.

- **The human queue drains first.** The agent drain runs only from the post-turn drain,
  **after** the human queue is empty and no dequeue is in flight.
- An entry that **expires** emits an audit line and a `principal_event` of kind
  `input_expired`, visible to the principal. A missing `turn_ended` is bounded by the TTL.
- Entries are dropped — one audit line each, and the dedup record updated to its terminal
  outcome (§6.6) — on session end, daemon restart, kill, revocation, "agents off" and lease
  release/suspension.
- **Only `zero_effect` transient refusals re-enqueue** (TTL preserved, after a full gate
  recheck, audited as a retry); `uncertain` is never retried (§6.9).
- The queue is non-durable: losing a parked message on restart is acceptable, executing a
  stale one is not.

### 6.6 Durable dedup (E3)

Existing input dedup (`reserveInputRequest`; 10 min TTL, 60 min tombstone, cap 4096 per
session, `INPUT_DEDUP_*` in `input-handlers.js`) is **process-local** — the ack carries
`dedupScope: 'process'` (`ServerInputAckSchema`,
`packages/protocol/src/schemas/server/session.ts`). Principals get a durable ledger keyed
**`(principalId, sessionId, clientMessageId)`** (S10; the ack reports `dedupScope:
'durable'`), in its **own 0600 store, written synchronously before the effect** — not
through the debounced session-state write (which can trail by up to 2 s). An unwritable
ledger means **no effect**.

- Each record moves **`reserved` → `committed(<terminal or queued outcome>)`**; a later
  queue drop **updates** the record to its terminal outcome.
- A `reserved` record found after restart replays as `uncertain` and is **never
  dispatched**.
- **Retention is bound to the credential**: a record lives until its principal's
  `expiresAt` (≤ 7 d), so no id can be re-executed within a credential's lifetime.
- At a **per-principal cap (10 000)** new input is refused `dedup_capacity`; nothing is
  evicted.
- Replayed acks carry `replayed: true`.

Tests: a kill between the ledger write and the effect; a duplicate of a queued-then-dropped
entry; restart with a `reserved` record. Mutation: evict at the cap instead of refusing.
**Never auto-retry a principal mutation after an `uncertain` result** — in the daemon, in
agent-control and in supervisor guidance.

### 6.7 Ack reasons

Consistent lower-snake case. Refusals: `scope_denied`, `lease_required`, `lease_stale`,
`lease_suspended`, `lease_held`, `agents_off`, `agent_queue_full`, `dedup_capacity`,
`payload_mismatch`, `invalid_input`. Reasons on a `queued` ack (not refusals):
`fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`, `fenced_busy`.
Outcome (journal and audit, not an ack): `input_expired`. All are in addition to the
existing input ack reasons. To an **unauthenticated or non-granted** caller they collapse
to the connection-level refusal; specific reasons go only to an authenticated principal
about its own request. Test: such a caller cannot distinguish any two reasons.

### 6.8 The evaluator (D1)

Principal input **bypasses the prompt evaluator in v1**: no rewrite, no clarify. Today
`handleInput` can assign `textToSend = result.rewritten` after framing; for a principal
the delivered text is exactly the sanitized, framed text, the **audit hash and delivery
record bind to those exact bytes**, and no evaluator outcome adopts primary.

### 6.9 The provider write boundary (D5)

Principal input never goes through `_outgoingQueue` or any provider startup/draining
queue (the SDK queues while `_drainingTurn` is set). A provider admission option
(proposed `principalAdmission: true`) sends it straight to the agent delivery lock. The
provider returns one explicit outcome: **`zero_effect`** (refused before any byte or
effect), **`dispatched`**, or **`uncertain`** (a partial write, or a failure after
writing).

Credential, kill switch, "agents off", lease, `gen` and the fence are **re-validated at the
write boundary**: before the first byte and, for claude-tui, **before each throttled chunk
and before the final submit**. If readiness cannot be established the send fails closed
with `zero_effect`; the TUI's "writing anyway" path is not taken for principals. If human
`input` or `terminal_input` arrives during an agent PTY write, the agent write **aborts
before submit**, clears its own partial line with the provider's line-clear sequence, and
reports `uncertain`: the human wins. A kill, revoke or "agents off" during an in-flight
drain aborts at the next boundary check, audited. Tests: a fault injected at each boundary
check; mutation: skip the pre-submit re-check; positive control: an uninterrupted write
dispatches.

## 7. Events

Today `agent-control/events.js` is a **client-side** normalized ring with
`${instanceId}:${epoch}:${seq}` cursors and gap reasons, lost on MCP restart (#7859). Live
broadcast frames carry no per-session sequence; `request_full_history` has no
`requestId`; `interrupt` has no ack. This section moves the ring into the daemon.

### 7.1 Journal (S3)

- **Daemon-side, per session, normalized** like `events.js` — never raw PTY bytes;
  **thinking excluded by default**.
- **Bounded:** 2000 events per session (D7), per-event cap 4 KiB serialized (oversize is
  truncated with `truncated: true`), persisted with session state. An eviction advances
  the window start and is reported as a gap.
- **Cursor** `{ sessionId, journalId, seq }`. Gap reasons: `evicted`, `journal_reset`,
  `restart_loss`, `unknown_cursor`.
- **Seq survives a crash by reservation (E4).** The journal reuses the seq **reservation**
  pattern of `session-message-history.js` (`_nextSeq` / `_seqReserved`, `SEQ_RESERVATION_STEP`,
  #8259): no seq above the persisted reservation is ever issued, so within one `journalId`
  seq stays monotonic across a crash and a crash costs only a gap flag for the unpersisted
  tail, never a reused seq. A start that cannot prove the reservation mints a new
  `journalId`, and an older cursor reports `restart_loss`. Tests use an **independent
  oracle sequence** (not the journal's counters) and include an **unclean-restart** case;
  the mutation reuses the old `journalId`/seq after a crash.

### 7.2 Subscribe, replay, live fence

1. `principal_subscribe { requestId, sessionIds, cursors? }` → `principal_subscribed
   { requestId, sessions: [{ sessionId, journalId, headSeq, gap? }] }`.
2. Replay `principal_event` frames (`replay: true`) from the cursor to `headSeq`.
3. `principal_live_fence { requestId, sessionId, seq }` — everything after is live.
4. Live `principal_event` frames. Live events during replay are **held and released in
   `seq` order** after the fence.

The held-live buffer is **capped (500 events or 1 MiB)**. On overflow the daemon reports a
gap and **ends the subscription**; the client re-subscribes. Eviction between `headSeq`
and the fence reports a gap. `principal_events_read { requestId, sessionId, cursor, limit
}` is a paged pull (`principal_events_page`), **limit ≤ 200**. Both are limited to granted
sessions; a non-granted id is refused `scope_denied`, indistinguishable from a nonexistent
one.

### 7.3 Pending permissions, roster, turn outcome

- `principal_pending_permissions` returns a snapshot from the **canonical state of both
  permission pipelines** ([`permission-floor.md` §3](permission-floor.md#3-both-pipelines-one-implementation)),
  per request: the `floored` verdict, **`explicitConsent` and `nonDelegable`** (so a
  future daemon-side answer policy has its inputs; #7860, S4).
- `principal_sessions_snapshot`: granted sessions with observed and declared status
  (#9026), handoff blockers, lease-holder **label**, model requested/observed (S5).
- `turn_started { turnId, causedBy, origin }` and `turn_ended { turnId, outcome }` journal
  events give execution and outcome their own signals (S14).

### 7.4 Interrupt

`interrupt` gains a required `requestId` for principals; the daemon answers
`principal_interrupt_ack { requestId, status: 'sent' | 'not_running' | 'rejected' }`
(no `interrupt_ack` exists in the protocol today). The ack is **admission only** and is
**not replayable** after a restart; whether the turn ended is `turn_ended` in the journal.

## 8. Redaction — what can and cannot be guaranteed (G1)

Never in the journal, snapshots, acks or audit: principal tokens (the daemon never logs
them and holds only hashes), raw PTY, the full text of a rejected body. Beyond that, be
honest about what redaction can promise:

- **Provenance-based suppression:** the result of a tool call whose permission request was
  **floored** is replaced in the journal by a placeholder.
- **Pattern redaction** covers known value shapes only. It cannot catch arbitrary secret
  content, and derived assistant text may repeat floored content.
- Therefore **observe access is read access to session output**, and is granted
  accordingly (§13). The journal is new data at rest with the sensitivity of session
  history.

## 9. Permission Answers

- **Deny only in v1 (D6).** A principal `permission_response` may carry **only** `type`,
  `sessionId`, `requestId` and `decision: 'deny'`, for a pending request on a session it
  holds a drive lease on. `reason`, `editedInput`, `scope`, `allowAlways` and any other
  field are refused `scope_denied`, at dispatch **and** at the handler. The model-facing
  denial text is a **fixed daemon-authored string** naming the label (for example "Denied
  by supervisor agent <label>."): today a client `reason` reaches the model through
  `buildDenyMessage` (`permission-manager.js`), an unfenced, unframed channel.
- **The bar for ever allowing `allow`:** every gate the client enforces today, daemon-side
  and fail-closed on missing metadata — ownership/lease, `NOT_DELEGABLE_TOOLS`,
  `FLOOR_ALLOWLISTED_TOOLS` / the `COMMAND_TOOLS` flag, `floored === false`, **and
  `explicitConsent === false` and `nonDelegable === false`**
  (`agent-control/client.js` `respondPermission`) — **and** a HIGH-reviewed delta of this
  document. Neither the label nor an `[agent:` message ever substitutes.
- **`resolvedBy` on `permission_resolved` (S4, proposed).** The event carries `requestId`,
  `decision`, `reason`, `scope` and no resolver. Proposed: `resolvedBy { kind: 'user' |
  'agent' | 'rule' | 'timeout' | 'auto_mode' | 'abort' | 'cleared', label? }` — a class
  plus the operator label for agents, never a token or a raw client id.
- **`decisionMatched` (proposed, S15; #8927)** is **not on main**: it would tell a
  responder whether its decision won over a competing one.
- **Delivery audit (#7352, S15):** records whether a prompt reached at least one client.
  `PermissionAuditLog` is an in-memory 500-entry ring, so the durable record of every
  principal permission action is the `[AUDIT]` line (§10).

## 10. Audit and Kill Switch

### 10.1 Audit — always-on, fail-closed (F1)

Emitted through the level-independent `logger.audit()` path (`[AUDIT]` lines with the
retention floor log rotation gives them), component `agent-audit`. `logger.audit()` today
**swallows write errors** (it catches the `appendFileSync` failure and only sets a flag),
so it cannot fail closed. **S11 adds a success-reporting write, `auditOrRefuse()`**, used
for **every principal attempt line**, shared with #7169's. Contract: a **pre-effect
attempt line** before every principal effect (enqueue, send, interrupt, create, destroy,
permission answer, lease change) — if it cannot be written there is **no effect** and an
error ack — and an **outcome line per transition** (`delivered | queued | expired |
dropped:<reason> | rejected:<reason> | killed`). Principal access requires file-backed
logging (checked at `grant` and at boot).

Required test: inject an `appendFileSync` failure (ENOSPC, EBADF) at **every effect kind**
and assert no effect plus an error ack, and assert the attempt line exists **before** the
effect. Mutation: make the writer report success unconditionally. Positive control: with
logging healthy the effect occurs.

Fields: `ts`, `principalId`, `label`, `action`, `sessionId`, `requestId` /
`clientMessageId`, `leaseId`/`gen`, `result`, `reason`, and for input **`sha256` of the
delivered (sanitized, framed) text plus its length — never the content** (D7; deliberately
unlike discord §9.1, which logs a prefix: agent text is high-volume and the transcript is
the content record). A rejected body logs the failing rule and the hash of the raw body.
Repeated identical rejections within a minute collapse into one counter line.

### 10.2 Kill switch (E6)

- `chroxy agent disable --all | --label <label>` (`principal_admin_disable`), a dashboard
  button. **Inbound only:** outbound notification sinks are untouched.
- **A durable barrier first.** The disabled flag is **written, fsynced and renamed
  *before* the kill is acknowledged**; cleanup happens after. Order: persist barrier →
  flip in memory (new frames refused `agents_off`) → close connections 4401 → **drain every
  queue, one `dropped:killed` audit line per entry** → release leases.
- **Boot reads the flag fail-closed.** An **absent** flag means never killed; an
  **unreadable or corrupt** flag means **disabled**.
- If the barrier cannot be written, principals stay disabled **in memory**, principal auth
  is refused, and the acknowledgement says the persist failed; the move-aside of the
  principal store is a checked fallback, not an assumed one.
- Re-enable is an explicit operator action (`principal_admin_enable`), never automatic.
- Deleting a principal's token file revokes nothing (the daemon stores only a hash), so
  **revoke or disable is the lever**; deleting the principal store invalidates every
  principal.

Tests: fault-inject every transition; a real restart after a kill; an unreadable flag at
boot. Mutation: acknowledge before the fsync; positive control: a healthy kill persists.

## 11. Blast-Radius Ledger

| Leaked | Attacker gains | Still cannot |
|---|---|---|
| **Primary token** (reference) | Everything the owner can do through Chroxy ([`bearer-token-authority.md` §1](bearer-token-authority.md#1-trust-model-in-one-sentence)): all sessions, input, modes, config, shells | — |
| Principal token, **observe** | Read journal, roster, pending permissions for granted sessions (session output; §8, §13) | Send anything, hold a lease, reach HTTP |
| Principal token, **steer** | Observe + labelled, fenced, queued input into a leased session; cap 3 queued | Approve, interrupt, create, change any mode or config |
| Principal token, **drive** | Input and interrupt on leased/own sessions; create within cwd/provider/model bounds in `approve`/`plan` mode with explicit values, no sandbox override, and a **resolved plan validated no more permissive than the grant** (§4.1.1) — i.e. an agent that can run *prompted* work the owner (or an automated rule) must still approve per tool | Raise a mode to auto/acceptEdits, set `skipPermissions`, override a sandbox, approve a prompt, rules, shells, close a session it did not create |
| Principal token, **answer** | Drive + **deny** pending prompts (denial of progress) | `allow` anything; supply denial text |
| Any principal token from a **non-loopback** peer | Nothing (refused) | — |
| Daemon host | Everything (A4 of the Discord doc applies unchanged) | — |

A leaked principal token is **bounded by tier, lease, TTL (≤ 7 d), loopback and the kill
switch**; a leaked primary token is bounded by none of them. Because a same-user process
can already read the primary token (§2), the value of a principal is **revocability,
attribution and blast radius for an agent that was handed less**, not resistance to a
local attacker.

## 12. What Each Child of #9112 Implements From This Document

| Child | Owns | Contract lines it is reviewed against |
|---|---|---|
| S1 principal store, `grant\|list\|revoke`, stamps | the credential; `isBoundClient` clause; retained upgrade `req`; WS re-check wiring | §2 loopback, §3 table and discipline, §3.0 (`_isConnectionAuthorized`, `_mayDeliverTo`, `_endCredentialConnection`, expiry timer, `withPrincipalEffect`), §3.1 stamps and sentinel, §4.5 HTTP roster |
| S2 dispatch + roster guards | `refusePrincipalMessage`, `frameForPrincipal`, `principalMaySee`, never-table constant | §3.1 items 3–5, §4.1, §4.2, §4.3, §4.4 |
| S3 journal, subscribe, read | events | §7.1, §7.2, §8 |
| S4 pending snapshot, `resolvedBy` | permission visibility | §7.3, §9 |
| S5 roster, blockers, declared status | observe snapshot | §7.3 |
| S6 agent-control `--principal` read-only, `chroxy_wait_events` | MCP adapter, read side | §2 doctor warning, §4.1 |
| S7 input `origin`, chips | provenance | §6.2 |
| S8 leases, `createdBy` persistence, owner grant, "agents off" | lease model; gen high-water mark | §5 whole, `lease_held` |
| S9 fence, `composer_state`, `ptyDirty`, queue, sanitizer agent profile and `[agent:` sigil | steer/drive delivery | §6.4, §6.5, §6.8, §6.9 |
| S10 durable dedup | idempotency | §6.6 |
| S11 audit writer + kill | the brakes | §10.1 (`auditOrRefuse`), §10.2 |
| S12 constrained create | drive create | §4.1.1, §5.4 |
| S13 drive interrupt, pre-emption | drive | §4.1.2, §5.3 |
| S14 `principal_interrupt_ack`, `turn_*` | outcomes | §7.3, §7.4 |
| S15 answer policy, `decisionMatched`, delivery audit | deny-only answers | §9 |
| S16 agent-control off the primary token | migration | §2; one release of a legacy flag |
| S17 Agents tab, doctor row | operator surface | §2, §10.2, §3 store recovery |
| S18 owner-path smoke | acceptance | §1 asymmetries on an isolated daemon with a fixture planner |

**Landing order (H1).** **S2** lands before any child that adds a principal message type.
**S11** (audit writer and kill) lands **before the first mintable token**: until then
`chroxy agent grant` refuses with "agent principals not yet enabled". **S10** lands before
S9. S8 owns `createdBy` persistence and the gen high-water mark; S12 consumes them.

## 13. Residual Risks (accepted for v1)

- **Prompt-injection relay through a supervisor.** A supervisor that reads session output
  can be steered by text inside it and then steer another session. The `[agent:` label
  keeps the daemon from treating it as authority, but an agent *may* act on advice; that
  is the feature. Mitigation is **who holds a lease** and the deny-only ceiling. Treat
  `[agent:…]` input as untrusted relative to the operator at the keyboard.
- **Observe is read access to session output.** Redaction is provenance suppression plus
  pattern matching (§8) and cannot catch arbitrary secrets or derived assistant text.
  Grant observe as you would grant read access to the transcript.
- **Same-user containment (§2).** No sandbox against a hostile local process.
- **Owner lockout bounded by pre-emption, TTL and kill.** A principal can hold a lease and
  fill the cap-3 queue; the owner can always type (human wins), revoke or kill, and
  leases and queue entries expire (2 h, 15 min).
- **New data at rest.** The journal persists up to 2000 normalized events per session, the
  principal store holds label/scope/suppression metadata and the dedup ledger holds ids.
  All are 0600 under the config dir and carry the session history's sensitivity; the
  audit holds hashes only.
- **One synchronous write between the last boundary check and the submit byte.** The
  provider write boundary (§6.9) re-validates before every chunk and before submit and
  aborts on human input; the residue is one synchronous write between the final check and
  the submit byte. Accepted because the message is advice and cannot approve anything (§1).
- **`uncertain` outcomes.** A mutation whose confirmation did not arrive is never retried
  automatically, so a message can be lost; the cursor and journal let the supervisor
  decide.
- **Availability.** Disabling principals (kill or "agents off") is immediate by design;
  the dashboard and app are unaffected.

This document must not change any existing invariant: the permission floor, the
never-delegable set, `skipPermissions:false`, the auto-mode gates and every bound-client
and strict-primary refusal apply to principals exactly as to any non-primary client. A PR
that widens principal authority — including enabling `allow` (§9) or an agent-initiated
lease request (§5.1) — is reviewed at HIGH tier against this document and left for the
owner to merge.
