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
   `=== true` gates already read false). **Stamp ordering:** `ws-auth.js` currently sets
   `client.isPrimaryToken = !isPairingCredential`, which is **true** for a non-pairing
   credential, so the principal branch sets `isPrimaryToken=false`, `principal` and the
   sentinel **before any `await` or registration**; test: a client observed mid-auth is never
   `isPrimaryToken === true`. `isBoundClient` gains the clause
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
3. **Inbound choke points — both sites, one selector.** Bound clients are refused at
   **two** places: `ws-server.js` before schema validation, and again in
   `handleSessionMessage` (`ws-message-handlers.js`, which calls `refuseBoundMessage` as
   the dispatch gate). Both sites call one shared selector, **`dispatchPolicyFor(client)`**
   (S2): a principal gets **`refusePrincipalMessage`** (the principal allowlist),
   a bound client gets `refuseBoundMessage`, **instead of**, never in addition to. The bound
   allowlist is never consulted for a principal and the bound policy is **not loosened**.
   Order: dispatch allowlist → `principalMaySee` → handler. Tests span the whole dispatch:
   a spy shows **zero `refuseBoundMessage` calls** for a principal at either site; a
   bound-allowed, principal-denied type (`terminal_input`) is refused `scope_denied`; and
   **end-to-end positive controls** show a principal read (`principal_sessions_snapshot`)
   and a principal create each reach their handlers (a selector that is wired at only one
   site fails one of them). Mutation: revert one site to `refuseBoundMessage`.
4. **Outbound choke points — principal branch first.** `ws-server.js` `_send` drops a
   bound client's frame tagged with another session and then applies `frameForBoundClient`
   (`outgoing-policy.js`, deny-by-default on type); `ws-broadcaster.js` repeats the
   other-session drop at three `isBoundToOtherSession` sites (the delivery point in
   `_sendOneWithBackpressure` and the two session-broadcast paths). With a sentinel
   binding, **those drops would discard every principal frame**, so in `_send` **and** in
   all three broadcaster sites the **principal branch runs before** the bound-other-session
   drop. A principal gets **`frameForPrincipal`**: a principal **outgoing allowlist**, deny
   by default, whose scope check is "is this frame's session in the grant"; a frame with no
   `sessionId` is delivered only if its type is on the allowlist. S2 adds an **outgoing
   roster guard** in both directions (model: `tests/outgoing-policy.test.js`). Test: a
   `principal_event` for a granted `sessionId` is delivered and one for a non-granted
   session is not, at every site; mutation: move the principal branch below the drop.
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
`principal_admin_lease_resume`, `principal_admin_session_off`,
`principal_admin_session_clear_draft` (§6.4) and `principal_admin_session_legacy_override`
(§6.4). This list is the roster S2's guard reads for the management surface. Each gates on
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
(background-agent frames, `packages/protocol/src/schemas/server/stream.ts`, and
`BOUND_OUTGOING_ALLOWED`). Proposed `PRINCIPAL_ALLOWED_MESSAGE_TYPES`:

| Tier | Existing types reused | New types proposed |
|---|---|---|
| all | `auth`, `key_exchange`, `ping` (transport; asserted as the separate exempt set, §4.2) | `principal_subscribe`, `principal_unsubscribe`, `principal_events_read`, `principal_pending_permissions`, `principal_sessions_snapshot` |
| steer | `input` (lease required; fenced and queued, §6) | `principal_lease_renew`, `principal_lease_release` |
| drive | `interrupt` (§4.1.3, §7.4), `create_session` (§4.1.2), `destroy_session` (**sessions it created only**) | — |
| answer | `permission_response` (**`deny` only**, field-limited, §9) | — |

Server frames, all new and all prefixed: `principal_subscribed`, `principal_event`,
`principal_events_page`, `principal_live_fence`, `principal_gap` (S3: a gap, or the end of a
subscription), `principal_interrupt_ack`. On `principal_event` and `principal_live_fence` the
journal position is **`journalSeq`**, not `seq`: the transport stamps its own per-connection
`seq` on every frame (`ws-client-sender.js`) and would overwrite a field of that name. S2's guard
asserts **no new name collides with an existing client or server schema type**.

History and roster reads go through the `principal_*` types, whose payloads are
daemon-normalized and bounded, never through `request_full_history`, `list_sessions` or
terminal types that expose raw output.

#### 4.1.1 Wire envelopes — one closed field set per operation

Every principal operation has **exactly** the fields below; **any field outside the set is
refused `scope_denied`** (including `.passthrough()` extras), at dispatch and at the handler.
`leaseId` and `gen` are the lease the mutation is made under (§5.2).

| Operation | Allowed fields |
|---|---|
| `input` | `type, sessionId, clientMessageId, data, leaseId, gen` |
| `interrupt` | `type, sessionId, requestId, leaseId, gen` |
| `permission_response` | `type, sessionId, requestId, decision: 'deny', leaseId, gen` |
| `destroy_session` (own sessions only) | `type, sessionId, requestId, leaseId, gen` |
| `principal_lease_renew` / `principal_lease_release` | `type, sessionId, leaseId, gen` |
| `create_session` | `type, requestId, cwd, name?, provider?, model?, permissionMode?, worktree?` |

`create_session` is **exempt from a session lease** (no session exists yet). It is
authorized by a live credential, the grant's constraints, the kill switch and a
**per-principal create rate limit**; its reply **issues the creator's drive lease**
(`leaseId`, `gen`). Read operations (§7) carry `requestId` and the fields §7 names; they
need no lease. §5.2 and §9 reference this table. Test per row: each extra field is refused
and a positive control with exactly the allowed fields reaches the handler.

#### 4.1.2 Create is a closed allowlist with a v1 ceiling (S12)

The create envelope above is the allowlist. The real fields it excludes include `sandbox`
(a passthrough `SandboxSchema` that can set `autoAllowBashIfSandboxed`, allowed commands
and paths), `codexSandbox` (including `danger-full-access`), `connectionId`,
`environmentId`, `isolation`, `agentCommId` and `skipPermissions`. User-shell is gated
today by `provider === USER_SHELL_PROVIDER` plus strict primary (`handleCreateSession`);
principal create refuses provider `user-shell` explicitly (there is no `userShell` field).

The daemon writes **explicit** values — `skipPermissions: false`, an explicit
`permissionMode` in {`approve`, `plan`}, no sandbox override, the provider's default
connection, `isolation` ∈ {`none`, `worktree`} — and, **immediately before creation**,
validates the *fully resolved* plan: provider, model, mode, isolation, `realpath` of `cwd`
under a granted root, the effective sandbox **and the effective rule set**. It refuses
when:

- the effective **daemon sandbox** carries any auto-allow (`autoAllowBashIfSandboxed`,
  allowed commands);
- the effective **Codex sandbox** is `danger-full-access`, whether from the daemon default
  or from `CHROXY_CODEX_SANDBOX` (`resolveCodexSandbox`, `codex-session.js`);
- a daemon default (`_defaultSkipPermissions`, `_defaultPermissionMode` in
  `session-manager.js`) would make the configuration more permissive than the grant.

**Standing allow rules are not inherited.** Chroxy permission rules, persisted
`allowAlways` project rules and provider-level project-settings allows do **not** carry
into a principal-created session unless the grant opts in (`chroxy agent grant
--inherit-rules`). If the daemon cannot disable or detect provider-level allows for a
provider, **principal create on that provider is refused**. `worktree: true` is allowed
only under a granted root. The session records `createdBy: principalId` (§5.4). Test: one
case per refused condition (sandbox auto-allow, `danger-full-access` via env and via
default, widening default, inherited rule of each kind, undetectable provider) plus a
positive-control create.

#### 4.1.3 Destroy and interrupt

`destroy_session` is refused for every session whose `createdBy` is not this principal —
an owner-granted drive lease on a person's session **never** lets a principal close it.
Test: a drive-leased human-started session refuses destroy; mutation: drop the
`createdBy` check; positive control: an own session is destroyed.

**Interrupt is a PTY write on claude-tui**: `interrupt()` (`claude-tui-session.js`) writes
Ctrl-C (`\x03`) to the PTY, so it can land in a person's half-typed line, and each
provider's interrupt path also clears the session's own queue through
`clearOutgoingQueue` (`base-session.js`; called by the codex app-server and ACP sessions
among others). A principal interrupt therefore:

- is fenced by the **human predicates** of §6.4 (`ptyDirty`, dirty composer, human activity
  within 60 s) and refused with `fenced_pty_dirty` / `fenced_human_active` **as refusals
  here**, and with `human_queue_nonempty` while the session's human queue holds prompts;
- **never calls `clearOutgoingQueue`** — implemented per provider, not in the base class.
  Test: the human queue is intact after a refused interrupt; mutation: call the clear;
- while a permission or question is pending, **requires answer scope** (the interrupt
  denies that prompt) and is audited `denied_by_interrupt`;
- records `origin.kind = 'agent'` in the journal and audit; the human
  `recordUserInterrupt` attribution (`session-manager.js`) is not used.

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

Column (a) is the dispatch allowlist (the type is absent). Column (b) is a **handler-level
predicate** that refuses a principal **on its own**. Because a principal runs
`refusePrincipalMessage` and not `refuseBoundMessage` (§3.1), the bound allow/deny lists
are **not** a second layer and are not counted as one. Column (b) names the actual predicate,
and where none exists says **"S2 adds a handler refusal"** and S2 owns it. **The table is a
machine-read constant in code (S2, `PRINCIPAL_NEVER_CAPABILITIES`) and the guard reads that
constant, not this prose.**

| Never | (a) dispatch | (b) handler predicate that refuses a principal |
|---|---|---|
| Auto / more-permissive mode, `acceptEdits`, `skipPermissions` | `set_permission_mode` absent; create envelope (§4.1.1) | `handleSetPermissionMode` session resolution (S2 confirms it refuses the sentinel binding); the unattended mode needs `allowAutoPermissionMode` (`settings-handlers.js`); `skipPermissions:false` unchanged |
| Permission rules, `allowAlways` | `set_permission_rules` absent; `allow*` refused (§9) | `handleSetPermissionRules` refuses `isBoundClient(client)` (and gains the principal clause) |
| `revoke_token` | absent | `handleRevokeToken` refuses `client.isPrimaryToken !== true` |
| Pairing (`pair_approve`, `pair_deny`), QR, `/connect` | absent | `rejectIfBound` (`handlers/pairing-handlers.js`, truthy `boundSessionId`) — refuses a principal **only through the sentinel**; the pairing HTTP routes refuse principals (§4.5) |
| Identity rotation | no WS type (CLI only) | CLI needs local primary authority |
| MCP config | `add_mcp_server` / `remove_mcp_server` absent | `rejectMcpConfigWriteUnlessPrimary` |
| Skill trust | `skill_trust_accept` / `skill_trust_grant` absent | `rejectSkillTrustIfBound` (`handlers/skills-handlers.js`, truthy `boundSessionId`) — sentinel-dependent |
| File and git writes | `write_file`, `append_memory`, `git_stage`, `git_unstage`, `git_commit`, `git_create_pr` absent | `rejectMutationIfBound` on all six (`handlers/file-handlers.js`, truthy `boundSessionId`) — sentinel-dependent; `write_file` also hits the config-dir refusal in `ws-file-ops` |
| Environments | `create_environment` / `destroy_environment` absent | `handleCreateEnvironment` refuses `isPrimaryToken !== true`; `handleDestroyEnvironment` refuses `isBoundClient` |
| Config / settings | host-wide `set_*`, `notification_prefs_set`, `session_preset_set` absent | `handleSessionPresetSet` opens with `rejectIfNotHost` (`handlers/repo-handlers.js`, truthy `boundSessionId`) — sentinel-dependent; **S2 adds a handler refusal** to `handleNotificationPrefsSet`, which has **no** client-authority check today |
| User-shell, `terminal_input`, shell `terminal_subscribe` | absent | `handleTerminalInput` returns silently when `isUserShellSession(entry) && client.isPrimaryToken !== true`, a check **conditional on a user-shell session**; for any other session `terminal_input` is bound-allowed and session-local, so **S2 adds an unconditional principal refusal** in `handleTerminalInput`. `handleCreateSession` `PRIMARY_TOKEN_REQUIRED` covers shell creation. A principal reaches a claude-tui PTY only through the `sendMessage()` of §6 |
| Dev-preview publication | `open_dev_preview` absent | requires an authenticated primary-token WS client ([`bearer-token-authority.md` §3](bearer-token-authority.md)); **S2 confirms the handler predicate** |
| Archive purge / policy | `delete_archived_session`, `set_session_archive_policy` absent | both handlers refuse `isBoundClient(client)` |
| Daemon update / restart | `daemon_update_action` absent | `handleDaemonUpdateAction` first-statement `isPrimaryToken === true && !boundSessionId` |
| Scheduled tasks | `scheduled_task_action`, `set_scheduler_enabled` absent | `rejectSchedulerWriteUnlessPrimary` |
| Orchestration start | `orchestration_run_start` absent | `guardAction({ requirePrimary: true })` |
| Checkpoint file restore | `restore_checkpoint` absent | `handleRestoreCheckpoint` refuses `isBoundClient(client)` |
| `set_model` (v1) | absent | session-local resolution; **S2 confirms it refuses the sentinel**; a model-switch delta is required to add it |

`isBoundClient` gains the `client.principal != null` clause (§3.1), so every row whose
predicate is `isBoundClient` refuses a principal without being edited.

**Proving "two independent refusals".** For each row the test (1) calls the **real handler
directly** with a principal-stamped client and the dispatch allowlist bypassed, and expects
a refusal; (2) with the allowlist active, expects `scope_denied`. The mutation proof
**deletes the column-(b) predicate** and expects red, so the dispatch list alone is shown
not to carry the row. A row marked "S2 adds a handler refusal" is **red until S2 adds it**.
**Sentinel-dependent rows** (gates that test a truthy `boundSessionId`, not
`isBoundClient`, so the §3.1 `isBoundClient` clause does not reach them) refuse a principal
only because the sentinel is non-empty. S2 either adds an explicit `client.principal` clause
to each or keeps the dependency with a mutation test that **removes the sentinel** and
watches every such row go red.
A row whose column (b) later changes is a review trigger for this document.

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
- Every principal mutation carries `leaseId` and `gen` as listed in the §4.1.1 table
  (create is exempt and receives its lease in the reply). Any mismatch at the effect point →
  `lease_stale`. `gen` increments on every grant, renew-after-lapse, suspend and revoke,
  so a send queued before a pre-emption cannot land after it. The `gen` high-water mark is
  **persisted synchronously** (§5.4) and owned by S8.
- Re-validation is done by `withPrincipalEffect` (§3.0), after every `await`.
- **Lifetime (D9):** default **2 h**, renewed by `principal_lease_renew` heartbeat (each
  renew extends to *now + 2 h*, bounded by the credential's `expiresAt`). A lapsed lease →
  `lease_required`. **Leases do not survive a daemon restart.**

### 5.3 Human pre-emption and "agents off" (D4)

- **Human activity suspends a drive lease.** Accepted human `input` **or data-bearing human
  `terminal_input`** (the §6.4 classification: terminal reply sequences such as
  cursor-position reports, device-attribute replies and focus in/out are **not** human
  activity) on the session sets the drive lease `suspended`, bumps `gen` and
  drops the principal's queued entries (audited); principal mutations then answer
  `lease_suspended` until the owner resumes it (`principal_admin_lease_resume`) or it
  expires. A principal cannot resume its own lease. A **steer lease coexists** with human
  use but its deliveries are fenced (§6.4).
- **Owner-opt-in `autoResumeAfterIdleMinutes`** (per lease, default off, e.g. 5): after that
  long with no human input or terminal activity, a suspended drive lease resumes, `gen`
  bumps, and the resume is audited.
- **If persisting a suspension fails** on the human-input path, **human input still
  proceeds**: the lease is suspended in memory and the write is retried. Residual: if the
  daemon then crashes before either the retry or the debounced history write (≤ 2 s)
  lands, §5.4's human-origin check cannot see that input and the creator's lease can be
  restored. Accepted for v1 and listed in §13; the owner sees the restored lease in the
  roster and can suspend it again.
- **Per-session "agents off"** (`principal_admin_session_off`): refuses every principal
  request on that session with `agents_off`, revokes its leases and drops its queue
  (audited). Only primary authority may clear it.

### 5.4 Durable owner state, suppression and `createdBy` (E1)

Owner actions must survive a crash, so **"agents off", lease suspension, lease revocation
and the `gen` high-water mark are written with the one durable-write standard used
throughout this document — write, fsync the file, rename, fsync the directory, as
`_flushPersistConfirmedDurable` does (`session-manager.js`) — to the principal store, never
through the debounced session-state write, before the action is acknowledged.** §6.6
and §10.2 use the same standard; S1 provides one helper for all three. Precedence, highest first: **kill > agents-off > lease revocation or
suspension > `createdBy` restoration.**

`createdBy: principalId` is written at create and persisted with session state (S8 owns
the persistence, S12 consumes it). After a restart the creator, if its credential is valid
and in scope, is re-granted a **drive lease** (new `leaseId`, `gen` continuing from the
persisted high-water mark) **only if no suppression record exists for that
(session, principal) and the session's persisted history holds no human-origin entry since
creation**; `createdBy` alone never restores suppressed authority. A session
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
composer or primary role, and never clear it (§4.1.3).

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
chip; an entry with no `origin` is a legacy human entry. Test (S7): a principal input is
persisted and replayed with `origin.kind === 'agent'` and its label, and renders an agent
chip in the dashboard and app; a human input never carries `kind: 'agent'`. Mutation: drop
`origin` from the persisted entry; positive control: a human entry renders as human.

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
10. **Admission fence → deliver or enqueue.** If the admission fence below is clear and the agent queue is
    empty, deliver through the provider write boundary (§6.9); otherwise enqueue (§6.5).
    The ack is `accepted` (`dispatch_started`), or `queued` carrying the fence cause as
    `reason` (`fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`,
    `fenced_busy`), or `rejected` `agent_queue_full`.
11. **Audit outcome**, then the ack. A later drain writes its own outcome line.

Sanitize runs before dedup so a rejected body is never memoized as success; dedup runs
before the attempt line so a replayed duplicate produces neither a second effect nor a
second attempt record. Test: assert this order with a recording harness, for each gate
failing in turn (mutation: swap two gates).

**The delivery fence has two parts.** It applies to **every** principal delivery at both
tiers.

**Admission** (evaluated before dispatch, and by the drain). All of:

- No #8281 handoff blockers: `turn_active` (`_isBusy`, **not** `isRunning`, so background
  shells never block), `queued_prompts` — **including a dequeued human prompt that has not
  started yet (the dequeue-in-flight flag)** — `pending_permission`, `pending_question`,
  `evaluator_pending`. Where #8281 has not landed, S9 implements the same predicates and the
  guard test names each. A pending permission or question fences **every** tier: input
  landing in an approval picker is an approval by side effect (discord §4.1).
- Session not paused by budget or quota.
- **No human PTY draft (claude-tui):** the daemon-owned per-session **`ptyDirty`** flag is
  clear (below).
- **Composer state:** no dirty human composer, per the capability rule below.
- **No human input or data-bearing human `terminal_input` in the last N = 60 s**
  (`fenced_human_active`; reply sequences do not count). Test: an attached terminal view
  that only auto-replies neither fences nor suspends a lease.

**Continuation** (re-checked during the write, §6.9): credential, kill switch, "agents
off", lease and `gen`, **new** human activity since admission, and **no new prompt**. Continuation carries an owned
**`deliveryId`** and **tolerates that delivery's own `_isBusy` / `_activeTurn`**: claude-tui
sets `_isBusy` before writing, so a continuation check that applied the admission
predicates would abort every delivery. Test against the **real provider lifecycle** (fixture
claude-tui and fixture SDK): a clean delivery completes; mutation: apply the admission
`turn_active` predicate during continuation and watch every delivery abort.

**`ptyDirty` (D2, R5).** `handleTerminalInput` calls `writeTerminalInput` directly and
bypasses `handleInput`, so no input-path signal sees PTY typing; hence this flag.

- Set only by **data-bearing** human keystrokes or paste. Terminal **reply sequences**
  (cursor-position reports, device-attribute replies, focus in/out) and pure navigation
  keys do **not** set it. Test: auto-replies alone never set it.
- **Cleared only by a verified composer reset**: a turn start caused by that human input,
  or a provider-adapter **prompt detector** reporting an empty composer line. **Enter/CR is
  not proof**: in multi-line composition a bare CR is a newline, not a submit
  (`_writePtyTextThrottled`, `claude-tui/pty-driver.js`). Ctrl-C / Ctrl-U / Esc are
  *candidates* that still need the detector's confirmation. **No empty-composer detector
  exists in claude-tui today** (the nearest signal is the PTY-quiet "composer ready" wait,
  which says nothing about the line's content); S9 must add one, and until it does a
  `ptyDirty` flag clears **only at a turn start caused by that human input** — it fails
  closed.
- It **survives the last client disconnecting and has no time expiry**.
- **Backstop, no auto-clear:** the roster reports `blockedOn: human_draft` with the remedy
  ("clear the draft or run clear_draft"), and the owner may clear it explicitly with the
  strict-primary `principal_admin_session_clear_draft`. **Usability cost, stated plainly:**
  until S9's detector lands, ordinary owner actions that start no turn — a slash command,
  Esc or Ctrl-U after typing — leave the flag set, so delivery into that claude-tui session
  waits for the owner's explicit clear. That is the fail-closed choice, and S9's detector
  is what removes it.
- Data-bearing human `terminal_input` counts as human activity for drive-lease
  pre-emption (§5.3) and for the 60 s window; reply sequences do not.

**Composer capability (R7).** Clients negotiate **`composer_state_v1`** at auth and send a
throttled `composer_state {sessionId, dirty}`. A capable client must **affirmatively**
report clean; a dirty composer stays dirty for a **5 min grace** after its client
disconnects. While a **legacy** (non-capable) client is attached as primary the fence
**holds with no time lapse**; the roster shows `blockedOn: legacy_client`, and the owner
may set a per-session strict-primary override (`principal_admin_session_legacy_override`).
Test: unsent typing in a legacy client past
10 minutes still fences.

Fence predicates are **per provider**: `ptyDirty` applies to claude-tui; SDK, CLI and Codex
sessions have no shared PTY composer, so only the remaining predicates apply. A session
with **no human client attached** has its *client-reported* predicates clear by
construction, **but only if `ptyDirty` is clear and no disconnected client's composer is
still inside its 5 min dirty grace**.

### 6.5 Agent delivery lock and queue (D6, D4)

One **per-session agent delivery lock and one drain**, shared by **all principals and the
Discord return path** (reusing its queue component, D2, with a distinct audit component).
Entries are tagged by source (`principalId` or `discord`) and drained **FIFO across
sources**; a steer holder and a drive holder of different principals can never write
concurrently because the lock serializes them.

The queue is **separate from `_outgoingQueue`**, in-memory, **cap 3 per source** plus a
**per-session ceiling of 6**, **reject-new** (`agent_queue_full`), **TTL 15 min**, so one
principal cannot starve Discord or another principal. The cap and TTL are chosen for
**bounded staleness and bounded owner lockout**, not for any external token lifetime.

- **The human queue drains first.** The agent drain runs only from the post-turn drain,
  **after** the human queue is empty and no dequeue is in flight.
- An entry that **expires** emits an audit line and a `principal_event` of kind
  `input_expired`, visible to the principal. A missing `turn_ended` is bounded by the TTL.
- **Dropped** — one audit line each, dedup record updated (§6.6) — on session end, daemon
  restart, **lease expiry, lease stale or suspension**, lease release, revocation, kill and
  "agents off". Kill, revoke and "agents off" drop **principal-tagged entries only**; Discord
  entries are governed by the Discord path's own controls (its kill switch,
  [`discord-return-path.md` §9.2](discord-return-path.md)).
- **Re-enqueue is allowed only** for a `zero_effect` outcome with a fence cause
  (`fenced_*`, `fenced_busy`): TTL preserved, full gate recheck, audited as a retry. Every
  other outcome drops; `uncertain` is never retried (§6.9).
- The queue is non-durable: losing a parked message on restart is acceptable, executing a
  stale one is not.

### 6.6 Durable dedup (E3, R10)

Existing input dedup (`reserveInputRequest`; 10 min TTL, 60 min tombstone, cap 4096 per
session, `INPUT_DEDUP_*` in `input-handlers.js`) is **process-local** — the ack carries
`dedupScope: 'process'` (`ServerInputAckSchema`,
`packages/protocol/src/schemas/server/session.ts`). Principals get a durable ledger keyed
**`(principalId, sessionId, clientMessageId)`** (S10; the ack reports `dedupScope:
'durable'`), in its **own 0600 store, written before the effect with the §5.4 durable-write
standard** (file and directory fsync) — not
through the debounced session-state write (which can trail by up to 2 s). An unwritable
ledger means **no effect**.

States and boot recovery:

| State | Set when | After a restart |
|---|---|---|
| `reserved` | before the audit attempt | `uncertain` (never dispatched) |
| `rejected:audit` | `auditOrRefuse` failed | terminal |
| `committed(queued)` | entry enqueued | `dropped:restart` (the queue is not durable) |
| `dispatching` | persisted **before draining** | `uncertain` |
| `committed(<terminal>)` | a delivery or drop outcome | terminal |

- **Retention is bound to the credential**: a record lives until its principal's
  `expiresAt` (≤ 7 d), so no id can be re-executed within a credential's lifetime.
- Records are **compact hashes**; the cap is **100 000 per principal**. At the cap new input
  is refused `dedup_capacity`; nothing is evicted; the roster surfaces "nearing cap".
- Replayed acks carry `replayed: true`.

Tests: a kill between the ledger write and the effect; a duplicate of a queued-then-dropped
entry; one restart per row of the table. Mutation: evict at the cap instead of refusing.
**Never auto-retry a principal mutation after an `uncertain` result** — in the daemon, in
agent-control and in supervisor guidance.

### 6.7 Ack reasons, by channel

Consistent lower-snake case; the channel is part of the contract.

| Channel | Reasons |
|---|---|
| Input ack, refusals | `scope_denied`, `lease_required`, `lease_stale`, `lease_suspended`, `agents_off`, `agent_queue_full`, `dedup_capacity`, `payload_mismatch`, `invalid_input` |
| Input ack, `queued` reasons (not refusals) | `fenced_pending_permission`, `fenced_human_active`, `fenced_pty_dirty`, `fenced_busy` |
| Admin reply (`principal_admin_lease_grant`) | `lease_held` (names the holder label only) |
| Interrupt ack | `scope_denied`, `lease_*`, `agents_off`, `fenced_pty_dirty` and `fenced_human_active` **as refusals**, `human_queue_nonempty` (§4.1.3) |
| Journal / audit outcome | `input_expired`, `denied_by_interrupt`, `dropped:<reason>` |

All are in addition to the existing input ack reasons. To an **unauthenticated or
non-granted** caller they collapse to the connection-level refusal; specific reasons go only
to an authenticated principal about its own request. Test: such a caller cannot distinguish
any two reasons.

### 6.8 The evaluator and the canonical payload

Principal input **bypasses the prompt evaluator in v1**: no rewrite, no clarify. Today
`handleInput` can assign `textToSend = result.rewritten` after framing; for a principal no
evaluator outcome changes the text, and none adopts primary.

**Canonical payload (R15).** The delivered text is further normalized by the provider
adapter — claude-tui's `_writePtyTextThrottled` normalizes `\r\n` to `\n`, strips embedded
paste markers and **removes trailing newlines** on its multi-line (bracketed-paste) path
before writing. The daemon therefore
defines the **canonical model-visible payload as the text after all normalization**
(framing, sanitize, and the adapter's own transforms): the **audit hash and the delivery
record bind to those exact bytes**, and an adapter must preserve the canonical payload
rather than transform it silently (a transform is applied *before* hashing, via a shared
function). Test with a **trailing-newline positive control**: a body ending in LF hashes
and delivers identically, and a mutation that hashes the pre-normalization text goes red.

### 6.9 The provider write boundary and PTY arbitration (D5, R5)

Principal input never goes through `_outgoingQueue` or any provider startup/draining queue
(the SDK queues while `_drainingTurn` is set). A provider admission option (proposed
`principalAdmission: true`) sends it straight to the agent delivery lock. The provider
returns one explicit outcome: **`zero_effect`** (refused before any byte or effect),
**`dispatched`**, or **`uncertain`** (a partial write, or a failure after writing).

The **continuation** checks of §6.4 run **before the first byte and, for claude-tui, before
each throttled chunk and before the final submit**; `ptyDirty` is **re-read at the final
pre-submit check**. If readiness cannot be established the send fails closed with
`zero_effect`; the TUI's "writing anyway" path is not taken for principals.

**Arbitration.** Human `terminal_input` participates in the agent delivery lock: while an
agent PTY write is in progress, **human bytes are held**, the agent writer **stops, clears
its partial line and confirms the clear**, and only then are the held human bytes forwarded.
**No human keystroke is dropped**; the interrupted delivery reports `uncertain`.
Confirming the clear needs the same empty-composer detector §6.4 requires of S9, so
**claude-tui principal delivery is gated on that detector**: until it lands, S9 refuses
principal input to claude-tui sessions with `zero_effect` (`fenced_pty_dirty`) rather than
ship an arbitration step it cannot confirm. Once it lands, held human bytes wait at most a
bounded timeout (S9 sets it, ≤ 2 s); on timeout they are forwarded and the delivery
reports `uncertain`. A kill, revoke or "agents off" during an in-flight drain
aborts at the next boundary check, audited. Tests: a human keystroke at each chunk boundary
loses nothing and is forwarded after the confirmed clear; a fault injected at each boundary
check; mutation: forward human bytes before the clear is confirmed; positive control: an
uninterrupted write dispatches.

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
  `restart_loss`, `unknown_cursor`. (S3: a subscription the daemon ends carries the extra
  reasons `held_overflow`, `backpressure`, `scope` and `removed` on `principal_gap { ended: true }`.)
- **Persistence (S3): a 0600 sidecar, not the session state file** —
  `<config dir>/principal-journal/<hash>.meta.json` (id, reservation, clean flag; written
  synchronously with the strict durable write) and `<hash>.events.json` (the window,
  debounced). One JSON state file rewritten wholesale by many writers, parsed by the restore
  path and written by a lenient writer is the wrong place for up to 2000 x 4 KiB per session and
  for a reservation that must be confirmed durable. The journal records only while the
  principal store holds an entry, so a daemon with no principals writes none (§13).
- **Seq survives a crash by a *confirmed* reservation (E4, R14).** The journal reuses the
  seq **reservation** idea of `session-message-history.js` (`_nextSeq` / `_seqReserved`,
  `SEQ_RESERVATION_STEP`, #8259) but **not its failure handling**: `_nextSeq` advances
  `_seqReserved` *before* persistence and only logs a failure of its reservation handler,
  and the manager's callback ignores the result of `_flushPersistOrWarn`
  (`session-manager.js`). The journal therefore requires a **confirmed durable**
  reservation — the `_flushPersistConfirmedDurable` standard (file **and** directory fsync) —
  **before it issues any seq beyond it**. If the confirmation fails the journal **emits no
  event under that `journalId`** (the next successful start mints a new one) and an older
  cursor reports `restart_loss`. Within one `journalId` seq stays monotonic across a crash
  and a crash costs only a gap flag for the unpersisted tail, never a reused seq. Tests use
  an **independent oracle sequence** (not the journal's counters), an **unclean-restart**
  case, and a **persistence failure then crash** case; the mutation issues seqs past an
  unconfirmed reservation.

### 7.2 Subscribe, replay, live fence

1. `principal_subscribe { requestId, sessionIds, cursors? }` → `principal_subscribed
   { requestId, sessions: [{ sessionId, journalId, headSeq, gap? }] }`.
2. Replay `principal_event` frames (`replay: true`) from the cursor to `headSeq`.
3. `principal_live_fence { requestId, sessionId, seq }` — everything after is live.
4. Live `principal_event` frames. Live events during replay are **held and released in
   `seq` order** after the fence. (Delivery, S3: a dedicated per-subscription direct send
   through `frameForPrincipal`, not the broadcast path; `PRINCIPAL_BROADCAST_ALLOWED` stays
   empty and a principal stays off the ClientManager session index.)

The held-live buffer is **capped (500 events or 1 MiB)**. On overflow the daemon reports a
gap and **ends the subscription**; the client re-subscribes. Eviction between `headSeq`
and the fence reports a gap. `principal_events_read { requestId, sessionId, cursor, limit
}` is a paged pull (`principal_events_page`), **limit ≤ 200**. Both are limited to granted
sessions; a non-granted id is refused `scope_denied`, indistinguishable from a nonexistent
one, and a **multi-id `principal_subscribe` is all-or-nothing**: if any id is not granted the
whole request is refused `scope_denied` and nothing is subscribed.

### 7.3 Pending permissions, roster, turn outcome

- `principal_pending_permissions` returns a snapshot from the **canonical state of both
  permission pipelines** ([`permission-floor.md` §3](permission-floor.md#3-both-pipelines-one-implementation)),
  per request: the `floored` verdict, **`explicitConsent` and `nonDelegable`** (so a
  future daemon-side answer policy has its inputs; #7860, S4). The tool **`input` is omitted
  for floored requests**; otherwise a **bounded, redacted summary** is given (reusing the
  existing sanitised permission description), never the raw input.
  **(S4, #9119)** Request `principal_pending_permissions { requestId, sessionIds? }`, reply
  `principal_pending_permissions_result { requestId, generatedAt, permissions[], truncated }`
  (observe tier, a direct reply through `frameForPrincipal`; `PRINCIPAL_BROADCAST_ALLOWED` stays
  empty). Each request carries `requestId`, `sessionId`, `tool`, `floored`, `explicitConsent`,
  `nonDelegable`, `origin` (`in_process` | `hook`), `createdAt` and `expiresAt` (epoch ms: the
  request's own deadline, `null` when the daemon cannot say) and, only when `floored === false`,
  the existing description clipped to 200 characters after redaction. Never the input, and
  `frameForPrincipal` rebuilds every request from a field whitelist as a second line. Source:
  `principal-pending-permissions.js` reads the in-process PermissionManager (the session's
  `_pendingPermissions` and `_lastPermissionData`, and a BYOK session's subagents through
  `_subagentPermissionRouting`) and the hook-routed store (the server's `pendingPermissions`,
  owner from `permissionSessionMap`; a prompt with no owner is listed to nobody). Missing
  metadata fails closed (floored, consent-gated, not delegable, no description). A request at or
  past its own deadline is excluded even when its timer has not fired. With `sessionIds`, every
  id must pass `principalMaySee(..., 'observe')` or the whole request is refused `scope_denied`,
  like a nonexistent session; without it, the reply covers the granted sessions. At most 100
  requests, oldest first, `truncated` when more were pending. It grants **no decision
  authority**: nothing in it can answer, extend or reroute a request. A pending
  `AskUserQuestion` is not a permission request and is not listed.
- `principal_sessions_snapshot`: granted sessions with observed and declared status
  (#9026), handoff blockers, lease-holder **label**, model requested/observed (S5).
- `turn_started { turnId, causedBy, origin }` and `turn_ended { turnId, outcome }` journal
  events give execution and outcome their own signals (S14).

### 7.4 Interrupt

`interrupt` gains a required `requestId` for principals; the daemon answers
`principal_interrupt_ack { requestId, status: 'sent' | 'not_running' | 'rejected', reason? }`
(no `interrupt_ack` exists in the protocol today; `reason` is one of §6.7's interrupt codes). The ack is **admission only** and is
**not replayable** after a restart; whether the turn ended is `turn_ended` in the journal.

## 8. Redaction — what can and cannot be guaranteed (G1)

Never in the journal, snapshots, acks or audit: raw PTY and the full text of a rejected
body. Principal tokens are never in **daemon-originated** fields (the daemon never logs
them and holds only hashes); session text that happens to echo a token is caught only by
the existing redaction patterns. Beyond that, be
honest about what redaction can promise:

- **Provenance-based suppression:** the result of a tool call whose permission request was
  **floored** is replaced in the journal by a placeholder.
- **Raw tool inputs are not journaled in v1 (S3 review), on ANY event.** Tool events are built
  from an explicit field allowlist (`tool_start`: tool, call id, message id; `tool_result`: call id,
  redacted result, truncated flag) and an `input` field is stripped from every other type.
  `tool_start` keeps the tool name
  and call id; `tool_input_delta` is never journaled; a `permission_request` keeps the tool,
  its `floored` verdict and, only when `floored === false`, the existing bounded, sanitised
  description (a floored request carries none). Observe tier therefore sees which tools ran,
  not their inputs. The verdicts are kept per session, outside the journal generation, and
  fail closed with a LATCH: a result is let through only when its call is known to have started
  and not to be floored. A result for a call never seen start (it began before journaling or
  crossed a restart), one already retired (a duplicate) and every result while latched are
  withheld. The latch is set when the tracker drops information (no room for a verdict or an open
  call, a pending verdict forgotten) and is cleared ONLY at the turn end (`result` or
  `agent_idle`), which also retires everything the tracker holds, so emptiness never clears it.
- **A truncated stream is not journaled.** If the accumulator had to cut an assistant stream
  (65536 characters), the event carries a placeholder, `truncated: true` and the length, never a
  prefix: no fixed margin can contain a credential such as a JWT that straddles the cut.
- **Redaction runs before any lossy cut.** A frame is redacted whole (on a copy) before
  normalization clips its strings, and an accumulated stream is redacted whole, then cut with
  its unsafe tail dropped, so a credential straddling a cut leaves no prefix.
- **Pattern redaction** covers known value shapes only. It cannot catch arbitrary secret
  content, and derived assistant text may repeat floored content.
- Therefore **observe access is read access to session output**, and is granted
  accordingly (§13). The journal is new data at rest with the sensitivity of session
  history.

## 9. Permission Answers

- **Deny only in v1 (D6).** A principal `permission_response` carries **only** the §4.1.1 fields
  (`type`, `sessionId`, `requestId`, `decision: 'deny'`, `leaseId`, `gen`), for a pending request on a session it
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
- **`resolvedBy` on `permission_resolved` (S4, #9119).** `resolvedBy { kind: 'user' | 'agent' |
  'rule' | 'timeout' | 'auto_mode' | 'abort' | 'cleared', label? }` — a class plus the operator
  label for agents, never a token, a raw client id or a device name. Additive and optional on
  the wire. Every announcement sets it (`tests/permission-resolved-by-roster.test.js` enumerates
  the sites from the syntax tree and fails on one without it) and the event normalizer rebuilds
  the wire value through `normalizeResolvedBy`, so a producer cannot put another field on it.
  Mapping: an answer is `user` (a client's answer on either pipeline, including the HTTP
  fallback); a timer is `timeout`; an aborted turn, a user Stop and a cancelled consent request
  are `abort` (`reason` still says `stopped` or `aborted`); a mode switch that resolves or
  denies a pending prompt is `auto_mode`; a drain at message completion or teardown, and a
  question a newer one replaced, are `cleared`. **Reserved, produced by nothing yet:** `agent`
  (principals cannot answer before S15) and `rule` (a rule decides before a prompt exists and
  emits no `permission_resolved`, #6842). A hook-routed prompt that times out or whose hook goes
  away emits no `permission_resolved` at all today, so it has no `resolvedBy`. A principal does
  not receive `permission_resolved` directly (it is in `PRINCIPAL_OUTGOING_DENIED`); it reads it
  through the S3 journal, whose event data carries `resolvedBy` unchanged.
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
- **Revoke and kill share one order: memory first, then durability, then the ack.** Flip in
  memory first (fail closed: new frames refused `agents_off`, principal auth refused) →
  **persist** with the durable standard of `_flushPersistConfirmedDurable`
  (`session-manager.js`): write, fsync the file, rename, **fsync the directory** → **ack**.
  Then close connections 4401 → **drain every principal-tagged queue, one `dropped:killed`
  audit line per entry** → release leases.
- **If persistence fails**, memory **stays disabled**, principal auth stays refused, and the
  ack says **"not durable"**. **Residual:** a restart before a successful persist can revive
  the principals, so the owner should revoke or rotate again once the store is writable.
- **Boot reads the flag fail-closed.** An **absent** flag means never killed; an
  **unreadable or corrupt** flag means **disabled**. The move-aside of the principal store is
  a checked fallback, not an assumed one.
- Re-enable is an explicit operator action (`principal_admin_enable`), never automatic.
- Deleting a principal's token file revokes nothing (the daemon stores only a hash), so
  **revoke or disable is the lever**; deleting the principal store invalidates every
  principal.

Tests: fault-inject every transition including a failed directory fsync; a real restart
after a kill and after a revoke; an unreadable flag at boot. Mutation: acknowledge before
the fsync; positive control: a healthy kill persists.

## 11. Blast-Radius Ledger

| Leaked | Attacker gains | Still cannot |
|---|---|---|
| **Primary token** (reference) | Everything the owner can do through Chroxy ([`bearer-token-authority.md` §1](bearer-token-authority.md#1-trust-model-in-one-sentence)): all sessions, input, modes, config, shells | — |
| Principal token, **observe** | Read journal, roster, pending permissions for granted sessions (session output; §8, §13) | Send anything, hold a lease, reach HTTP |
| Principal token, **steer** | Observe + labelled, fenced, queued input into a leased session; cap 3 queued | Approve, interrupt, create, change any mode or config |
| Principal token, **drive** | Input and interrupt on leased/own sessions; create within cwd/provider/model bounds in `approve`/`plan` mode with explicit values, no sandbox override, and a **resolved plan validated no more permissive than the grant** (§4.1.2) — i.e. an agent that can run *prompted* work the owner (or an automated rule) must still approve per tool | Raise a mode to auto/acceptEdits, set `skipPermissions`, override a sandbox, approve a prompt, rules, shells, close a session it did not create |
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
| S2 dispatch + roster guards | `dispatchPolicyFor` (both inbound sites), `refusePrincipalMessage`, `frameForPrincipal` (before the bound drops), `principalMaySee`, never-table constant, **the missing handler refusals** of §4.3 | §3.1 items 3–5, §4.1, §4.2, §4.3, §4.4 |
| S3 journal, subscribe, read | events; **confirmed durable seq reservation** | §7.1, §7.2, §8 |
| S4 pending snapshot, `resolvedBy` | permission visibility | §7.3, §9 |
| S5 roster, blockers, declared status | observe snapshot | §7.3 |
| S6 agent-control `--principal` read-only, `chroxy_wait_events` | MCP adapter, read side | §2 doctor warning, §4.1 |
| S7 input `origin`, chips | provenance | §6.2 |
| S8 leases, `createdBy` persistence, owner grant, "agents off" | lease model; gen high-water mark; **auto-resume; the human-history check** | §5 whole, `lease_held` |
| S9 fence, `composer_state_v1`, `ptyDirty` classification and prompt detector, PTY arbitration, queue, sanitizer agent profile and `[agent:` sigil | steer/drive delivery | §6.4, §6.5, §6.8, §6.9 |
| S10 durable dedup | idempotency; the state table | §6.6 |
| S11 audit writer, revoke/kill order, directory fsync | the brakes | §10.1 (`auditOrRefuse`), §10.2 |
| S12 constrained create, create ceiling, rule non-inheritance | drive create | §4.1.1, §4.1.2, §5.4 |
| S13 drive interrupt, pre-emption | drive | §4.1.3, §5.3 |
| S14 `principal_interrupt_ack`, `turn_*` | outcomes | §7.3, §7.4 |
| S15 answer policy, `decisionMatched`, delivery audit | deny-only answers | §9 |
| S16 agent-control off the primary token | migration | §2; one release of a legacy flag |
| S17 Agents tab, doctor row, `principal_admin_session_clear_draft` | operator surface | §2, §6.4, §10.2, §3 store recovery |
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
- **A suspension lost to a crash.** If the suspension write fails and the daemon crashes
  within the history debounce, `createdBy` can restore a lease the owner's input should
  have suspended (§5.3). Visible in the roster; the owner suspends it again.
- **claude-tui delivery waits for S9's composer detector.** Until it lands, principal input
  to claude-tui sessions is refused, and a `ptyDirty` flag needs the owner's explicit clear
  (§6.4, §6.9). SDK, CLI and Codex sessions are unaffected.
- **Owner lockout bounded by pre-emption, TTL and kill.** A principal can hold a lease and
  fill the cap-3 queue; the owner can always type (human wins), revoke or kill, and
  leases and queue entries expire (2 h, 15 min).
- **A principal granted late sees the journal from the grant on.** The journal records only
  while the principal store has an entry (data-at-rest minimisation, S3), so history from before
  the first grant does not exist. Its cursors and gaps are otherwise unchanged.
- **Observe does not show tool inputs (S3).** A supervisor sees tool names, ids, verdicts and
  (unfloored) descriptions, not the inputs; it reads results and assistant text.
- **Journal lifetime and incarnations (S3).** A journal is deleted with its session on any removal
  (`session_removed`: user destroy, idle timeout, provider exhaustion, a kept failed restore) and
  kept across a daemon shutdown. Recording is gated on the session being CURRENTLY HELD by the
  SessionManager (no tombstone set), and every create or restore of an id (`session_created`) is a
  new incarnation that starts a fresh journal with a new `journalId`; a late frame for a session
  that is not live is dropped. A sidecar whose meta contradicts its events mints a new `journalId`.
- **A subscription never ends silently (S3).** A new `journalId` (recovery after a failed
  reservation, a reset) ends every subscription of the old one with `principal_gap { reason:
  restart_loss, ended: true }`. A grant that no longer covers the session ends it with reason
  `scope`, a removed session with `removed`. These two end notices are the only gap frames
  delivered for a session the principal can no longer see (they name only the id it subscribed to).
- **Debounced flush is synchronous (S3).** The events file is rewritten whole, durably, on the main
  thread at most every 5 s per dirty session (up to 2000 x 4 KiB, 8 MB worst case, typically a few
  hundred KB). Accepted for v1; an async or incremental writer is a follow-up.
- **Floored-result suppression can over-suppress.** One pipeline names the tool call on its
  `permission_request` (`toolUseId`), the other does not; without it the request is matched to
  the open or next call of the same tool, so a second call of that tool can be withheld too.
  It never under-suppresses (§8).
- **New data at rest.** The journal persists up to 2000 normalized events per session, the
  principal store holds label/scope/suppression metadata and the dedup ledger holds ids.
  All are 0600 under the config dir and carry the session history's sensitivity; the
  audit holds hashes only.
- **Revoke or kill before a durable persist (§10.2)** can be undone by a restart; the ack
  says so.
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
