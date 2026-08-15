# Discord Return Path — Threat Model and Authority Design

The Discord status sink (#5413, verified e2e 2026-08-14) is one-way: daemon → Discord.
Epic #7165 adds the return path: a command issued in Discord is routed to the owning
session as an async interjection. This document is the design gate (#7166) — it pins the
trust boundaries, the token class, the command authority ceiling, and the audit/kill
contracts **before any code**, so the sub-issues (#7167 gateway, #7168 daemon API +
mailbox, #7169 audit/kill-switch, #7170 v1.1) implement one contract instead of
negotiating it in review.

Companion documents: [`bearer-token-authority.md`](bearer-token-authority.md) (the token
classes this extends), [`permission-floor.md`](permission-floor.md) (why approvals stay
off this channel), [`encryption-threat-model.md`](encryption-threat-model.md) §2 (the
daemon-host trust baseline).

## 1. Trust Model in One Sentence

> A Discord interaction from an allowlisted user ID may enqueue one provenance-labeled,
> sanitized text interjection into one named session, or read a bounded status summary —
> and nothing else. Every other capability class (permission approvals, session
> lifecycle, mode/model changes, config, credentials, shell) is out of this channel's
> authority regardless of who asks, and the ceiling is enforced by the daemon, not by
> the bot.

The controlling asymmetry: an **interjection is advice to an agent**; an **approval is
authorization of a host action**. This channel carries the first and never the second
(§4).

## 2. Trust Boundaries

```
[guild members]──(Discord account auth)──▶[Discord infra]
                                              │  bot-token-authenticated
                                              │  OUTBOUND gateway WebSocket
                                              ▼
                                        [gateway bot process]
                                              │  discord-return command secret
                                              │  (loopback, or tailnet TLS)
                                              ▼
                                        [chroxy daemon — hub Mac]
```

| Zone | Trust | Holds |
|---|---|---|
| Guild members / channel content | **Untrusted.** A Discord channel, thread, message, or embed is never an authority — only the authenticated interaction user ID is examined, and only against the allowlist. | nothing |
| Discord infra | Trusted for transport and for **authenticating which user ID invoked an interaction** (assumption A1). Not trusted with any chroxy credential, and not trusted for content: everything in the payload except the user ID is treated as attacker-influenceable text. | nothing of chroxy's |
| Gateway bot process/host | **Semi-trusted.** Holds exactly two secrets: the Discord bot token and the discord-return command secret. Its compromise is a *designed* blast radius (§7) — never host authority. | bot token, command secret |
| Daemon host (hub Mac) | Trusted — the operator's own machine, per [`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries). | everything |

**Assumption ledger** (what breaks if each fails):

- **A1 — Discord authenticates interaction user IDs honestly.** If broken (Discord infra
  compromise/insider), an attacker can act as the allowlisted owner. Blast radius equals
  owner-account compromise: interject + status, nothing more (§7). This is precisely why
  the authority ceiling matters more than authn hardening on this channel — we cannot
  harden Discord's authn, so we bound what it is worth.
- **A2 — the bot↔Discord link is TLS to genuine Discord endpoints.** discord.js pins the
  official gateway/REST hosts; a MITM without a Discord-valid cert gets nothing.
- **A3 — the bot↔daemon path is loopback or tailnet.** The daemon binds `127.0.0.1` and
  is fronted only by `tailscale serve` (#7160, #7171). A command-secret holder with no
  tailnet position has **no network path** — the secret alone is not enough (§7).
- **A4 — the daemon host is not compromised.** If it is, every guarantee in every chroxy
  document is void; this feature adds nothing to that scenario.

### 2.1 Connection model — pinned: outbound gateway, no public ingress

Discord offers two ways to receive interactions: a **gateway WebSocket** the bot dials
*out* to Discord, and an **HTTPS interactions endpoint** Discord dials *in* to a public
URL (Ed25519-signed requests). The daemon went tailnet-only on 2026-08-14 — the LAN bind
closed (#7160) and the public quick tunnel retired (#7171). An interactions endpoint
would re-open exactly that public ingress.

**v1 uses the gateway WebSocket, full stop.** The bot makes only outbound connections;
no new listening surface exists anywhere. Revisiting the endpoint model requires its own
threat-model delta (signature verification, timestamp/replay window, public-surface rate
limiting, ingress hosting) *and* a reason the tailnet-only posture no longer holds. The
Ed25519 signature machinery is an artifact of that model, not of this one — with the
gateway connection, interaction authenticity rides on the bot-token-authenticated TLS
session (A2), and there are no signature headers to verify.

### 2.2 Where the bot runs — and where it must not

v1 recommends the **hub Mac itself**: the bot talks to the daemon over loopback, both
secrets live in one keychain, and no cross-machine provisioning exists. Any tailnet node
is acceptable (the daemon is reachable only via tailnet regardless).

**Explicitly out: the CI-invoked execution model.** repo-relay today runs as a GitHub
Actions step with `DISCORD_BOT_TOKEN` in repo secrets — fine for an *outbound-only*
notifier, because that credential's blast radius is "post messages". A return-path
gateway is different twice over: it needs a **long-lived resident process** (a gateway
connection, not a per-event job), and it holds an **inbound-command credential**.
Putting the command secret in GitHub Actions secrets would widen its custody to GitHub's
infrastructure plus every write-collaborator and every workflow with secrets access. If
the "gateway home" decision (#7167) lands on repo-relay, that is a decision about
**sharing code** — the deployment is still a resident process with local custody (§8),
never a CI secret.

## 3. The Fifth Token Class — the discord-return command secret

[`bearer-token-authority.md` §2](bearer-token-authority.md#2-the-four-token-classes)
defines four token classes. The return path adds a fifth (the table row and §9 checklist
update land with #7168, when the class exists in code):

| | discord-return command secret |
|---|---|
| Issued by | `chroxy discord-return enable` — `randomBytes(32).toString('base64url')`, minted at enable time |
| Stored where | OS keychain preferred (service `chroxy-discord-return`, account `command-secret`); 0600 file fallback `~/.chroxy/discord-return-secret` (`CHROXY_CONFIG_DIR` honored). The gateway process reads the same ladder (§8) |
| Scope | Exactly two routes: `POST /api/discord/interject`, `GET /api/discord/status` |
| Used on | `Authorization: Bearer …` from the gateway process, over loopback or tailnet |

Discipline (each rule mirrors a rule the ingest secret already established in
[`bearer-token-authority.md` §6](bearer-token-authority.md#6-daemon-level-ingest-secret-post-apievents--post-apimailbox-5413),
stated here so #7168 can be reviewed against this list):

- **No fallback, in either direction.** The two routes accept this class only — never
  the primary token, a pairing token, a hook secret, or the ingest secret. No other
  endpoint accepts this class. There is no deployment where a different credential is
  the right one for the gateway, and no deployment where the gateway's credential should
  open any other door.
- **Constant-time validation** (`safeTokenCompare`), token never logged, `maskToken()`
  on any diagnostic surface.
- **Fail closed.** Missing/invalid auth → `401`, empty body. Secret file unreadable or
  keychain entry missing → every request rejected (this doubles as a manual kill, §9).
  Feature disabled or killed → `503 { "disabled": true }`.
- **Rate limits in layers:** a pre-auth per-IP ceiling at the route (the hard total),
  then per-Discord-user buckets behind auth, then the per-session queue cap (§5.1).
  Rejected calls consume budget too — a hostile caller cannot spend the daemon's disk or
  log on rejections (§9.1).

**What the class grants** — a bounded write and a bounded read:

- *Write:* enqueue one sanitized, provenance-labeled text message (§5.1) into one named
  session's mailbox. Delivery semantics are the mailbox's (queue-while-busy).
- *Read:* the closed status schema of §5.2. Nothing else — no history, no transcripts,
  no file reads, no permission responses, no session lifecycle, no settings, no
  credentials, no scheduler, no MCP, no shell.

**Why not reuse the ingest secret.** Custody and authority both differ. The ingest
secret is deliberately *broadly held* — it sits 0600 on disk for every external Claude
Code hook emitter on the box to read — and correspondingly *weak* (notifications plus a
fixed-string wakeup, no reads). The command secret is held by **exactly one process**
and grants strictly more: a real (bounded) read, and a write whose text is
attacker-influenceable rather than fixed. Merging them would hand every hook emitter
interject authority, make a leak unattributable between two very different holder
populations, and force both surfaces to share one revocation. Separate class, separate
revocation, legible audit.

**Lifecycle.** Static; no TTL. `chroxy discord-return rotate` regenerates and prints
once for re-provisioning the gateway (old value invalid immediately — the gateway is a
single operator-owned process, so there is no graceful-rotation population to migrate).
Revocation = the kill switch (§9.2), deleting the secret, or `rotate` itself.

## 4. Command Authority Tiers

| Tier | Commands | Status |
|---|---|---|
| v1 | `/interject`, `/status` | this epic |
| Explicitly out of v1 | permission approvals | §4.1 — hard bar to ever revisit (§4.2) |
| Out of this channel, period | session create/destroy · permission mode/model changes · permission rules · config/settings · credentials · anything in the strict-primary table ([`bearer-token-authority.md` §4](bearer-token-authority.md#the-ws-primary-token-gate-clientisprimarytoken-5985b): shell, MCP config, scheduler, orchestration) | not tier-gated — the token class cannot reach the endpoints, and the strict-primary capabilities additionally require a token that never exists on the bot host |

The tier ceiling is enforced **at the daemon** by the token class's endpoint scoping
(§3), not by bot-side command registration. Registering fewer slash commands is UX;
the daemon rejecting everything but interject/status is the boundary.

### 4.1 Why approvals are out

1. **Consequence class.** An approval is the last human gate before host-side tool
   execution. An interjection is input an agent may weigh, mediated by the agent and by
   the permission engine downstream; an approval **is** the mediation. Moving it to
   Discord converts a Discord-account compromise into authorized host actions.
2. **The authn doesn't carry the weight.** This channel's identity is a Discord account
   — one remote factor, outside our control, phishable at Discord's scale, with no
   binding to any chroxy-paired device. Chroxy's approval surfaces rest on the pairing
   trust model ([`bearer-token-authority.md` §4](bearer-token-authority.md#4-pairing-bound-session-tokens)):
   a QR scanned in physical proximity, a token bound to that device. The permission
   floor's whole design ([`permission-floor.md`](permission-floor.md)) is that ambiguity
   resolves to *a prompt the operator answers on a trusted surface* — terminating that
   fail-closed path in the weakest channel inverts it.
3. **Compromise asymmetry — the chain.** With v1 tiers, bot-host compromise yields
   interjections and status reads: recoverable, audited, bounded (§7). With approvals,
   the same compromise closes the loop — the attacker interjects *"run X"* **and
   approves X**. Interject-without-approve leaves the human gate standing; adding
   approvals removes it precisely when the channel is hostile.

### 4.2 The bar for ever revisiting

All of the following, together, and only then:

- **Discord carries the doorbell, never the key.** The Discord side may *surface* an
  approval request (deep link back to the dashboard/app); the approval itself completes
  on a chroxy-paired surface, or with a per-approval one-time code displayed **only** on
  a paired surface. A design where tapping a Discord button alone approves anything does
  not clear this bar at any factor count.
- **Floored prompts are never eligible.** Anything the permission floor routes to a
  prompt (protected paths, secret reads) stays on paired surfaces unconditionally.
- **Audit parity with `shell-audit`** for every approval that so much as *transits*
  Discord.
- **Its own threat-model delta**, reviewed at HIGH tier, superseding this section by
  name.

## 5. Command Surface Contract (v1)

### 5.1 `/interject <project> <text>`

The gateway forwards `{ interactionId, discordUserId, project, text }` with the command
secret. The daemon then owns every security-relevant step — **the bot's checks are UX,
the daemon's are the boundary** (a compromised bot host is assumed to skip bot-side
checks entirely):

1. **Allowlist (daemon-authoritative).** `discordUserId` is checked against the
   daemon's own `discordReturn.allowedUsers` config map (§5.3). The bot also checks, for
   a fast decline UX, but the daemon re-checks every call. v1 allowlist = the owner
   only.
2. **Targeting.** `project` resolves through the same project→active-session registry
   the outbound status embed uses. Unknown project or no active session → rejected ack.
   The project string is matched against the registry — it is never interpolated into a
   path, shell word, or pattern. Inbound envelope hygiene follows the project-derivation
   clamp (#7123).
3. **Sanitization — the PTY boundary.** This is the first attacker-influenceable byte
   stream to reach `writeTerminalInput`. Every prior injection is a **fixed** template
   (the mailbox wakeup, [`bearer-token-authority.md` §6](bearer-token-authority.md#6-daemon-level-ingest-secret-post-apievents--post-apimailbox-5413))
   precisely to avoid this analysis; interject text is user-controlled, so the contract
   is explicit:
   - Strip **all** C0 and C1 control characters — including `\n`, `\r`, `ESC`, and
     therefore every ANSI/VT escape sequence, bracketed-paste delimiter, and control
     chord. A stray `\r` submits early; an `ESC` sequence drives the TUI itself. v1
     interjections are single-line by construction.
   - Length cap **2000 characters post-strip** (Discord's own message ceiling),
     enforced by the daemon — the bot's identical cap is not trusted.
   - The daemon composes the delivered line as `[discord:<label>] <sanitized text>` and
     the **daemon appends the single trailing `\r`**. The gateway never controls
     framing.
   - `<label>` comes from the daemon's own config map (§5.3) — operator-authored,
     never from the wire. Discord usernames and display names are attacker-controlled
     strings; they appear nowhere in the delivered line. The immutable user ID is what
     the audit line records.
4. **Delivery.** Idle claude-tui session → inject now. Busy → enqueue in the session's
   mailbox, deliver on the idle transition; ack `queued (N ahead)`. Per-session queue
   cap (v1: 10); a full queue **rejects the new command with an ack** — it never
   silently displaces a queued one. v1 delivery is claude-tui-only, keeping the
   `isClaudeTui` fence (#5984); SDK-session delivery is a #7168 mechanism decision and
   inherits this contract's sanitization and framing regardless of transport.
5. **Idempotency.** Duplicate `interactionId` (Discord snowflakes are unique; gateway
   resumes can redeliver) → acked identically, not re-enqueued, within a bounded LRU
   window. Freshness: the snowflake encodes its creation time — reject interactions
   older than 5 minutes.
6. **Audit** (§9.1) on every outcome: delivered, queued, and each rejection with its
   reason.

**No bot-side store-and-forward.** If the daemon is unreachable, the bot acks "daemon
unreachable — retry" and drops the command. A retry queue on the bot host would be a
second, unaudited mailbox holding commands the daemon never vetted; the human is the
retry loop.

### 5.2 `/status`

The response is a **closed field allowlist**, per project: project name, session state
(idle / running / waiting-approval / error), elapsed time in state, interject-queue
depth. Never: history or output text, file paths, cwd, hostnames, URLs, token material
of any class.

The design test for ever adding a field: **"would we put it in the outbound status
embed?"** The embed already publishes exactly this class of information to the same
channel, so v1 status-query discloses nothing the channel doesn't already see. A field
that fails the embed test needs a wider token class and a revision of this document —
which is the signal it doesn't belong here.

### 5.3 Config (non-secret knobs)

```json
{
  "discordReturn": {
    "enabled": false,
    "allowedUsers": { "<discord-user-snowflake>": "chris" },
    "guildId": "<operator guild snowflake>"
  }
}
```

`enabled` defaults **false** — the entire return path is opt-in (§9.2). `allowedUsers`
maps immutable Discord user IDs to the operator-authored provenance labels of §5.1;
snowflakes are identifiers, not secrets, so config.json is the right home (the same
judgment as the webhook doc's color knobs — secrets go in the credential ladder, §8).
`guildId` scopes command registration (§8.1).

## 6. Spoofing and Replay Analysis

Actor by actor:

| Actor | What they can attempt | What stops it / what they get |
|---|---|---|
| Non-allowlisted guild member | Invoke the slash commands | Bot declines (UX); daemon rejects (boundary); attempt audited with their user ID; rejects are rate-limited so they can't spend disk (§9.1). Run the bot in a private, operator-owned guild so this population is near-zero (§8.1). |
| Channel content of any kind | Messages, embeds, thread replies, @-mentions crafted to look like commands | Inert. The bot has no message-content intent and reacts to nothing but registered application commands; a channel is never an authority (§2). In v1.1 reply-UX (#7170), a reply's thread may select the *target* session — it still never supplies *authority*, which remains the interaction user ID. |
| Owner's Discord account, compromised | Full v1 channel authority: interject + status | **The accepted residual risk of the feature** (§11). Bounded by the tier ceiling; mitigations: 2FA on the account (§8.1), per-user rate limit, audit trail, kill switch. |
| Discord infra (A1 broken) | Forge interactions as the owner | Same blast radius as the row above — that equality is the design working as intended (§2, A1). |
| Bot host, compromised | Everything the two resident secrets grant (§7): full channel authority toward the daemon, bot impersonation toward Discord (fake embeds — a social lever, e.g. a counterfeit "needs approval" card steering the operator to a look-alike link) | Cannot read sessions beyond §5.2, cannot approve, spawn, or reach any other endpoint. Recovery: kill switch, `rotate`, reset the bot token in the Discord developer portal. The social lever is why ack/embed content never carries URLs the operator is expected to click beyond the operator's own known dashboard address. |
| Network MITM, bot↔daemon | Capture/replay forwarded commands | No assumed position: loopback on the hub, or tailnet TLS (A3). Belt-and-braces: interactionId idempotency + the 5-minute snowflake freshness window (§5.1) make a captured request worthless shortly after issue. |
| Network MITM, bot↔Discord | Forge gateway events | TLS to pinned Discord hosts (A2). |
| Replay via gateway resume | Discord redelivers an interaction after reconnect | Idempotent by interactionId — acked, not re-enqueued (§5.1). |

**Ack-path rule:** Discord interactions demand an ack within ~3 seconds — the gateway
defers immediately and follows up with the daemon's outcome. Ack text mirrors the audit
outcome, never echoes secrets, and never invites a retry loop the daemon didn't vet
(§5.1's no-store-and-forward rule).

## 7. Blast-Radius Ledger

What each credential is worth, alone and in combination:

| Compromised | Attacker gains | Attacker still cannot |
|---|---|---|
| Command secret only | Nothing, from outside the tailnet — there is no network path to the routes (A3). From a tailnet node or the hub itself: interject + status. | Reach any other endpoint; read history; approve; spawn. |
| Bot token only | Impersonate the bot to Discord: post/edit in the channel, receive interactions addressed to it. | Reach the daemon at all — no command secret, and no path without tailnet position. |
| Both (= bot host) | The union: full v1 channel authority + bot impersonation (§6). | Anything outside the two routes. Host authority requires the primary token, which never exists on the bot host — this is the epic's core requirement, held by construction. |
| Owner's Discord account | Interject + status via the legitimate bot. | Same ceiling; §4.1's chain argument is why the ceiling excludes approvals. |
| Daemon host | Everything, feature or no feature (A4). | — |

## 8. Bot-Token Custody

Same posture as the webhook URL (`discord-credentials.js`, #5413/#5493) — the bot token
is a secret with the same shape of consequences, so it rides the same ladder:

1. `process.env.CHROXY_DISCORD_BOT_TOKEN`
2. `~/.chroxy/credentials.json` → `discordBotToken` — 0600 enforced, read via the
   cipher-aware `readStoredField` (coexists with the #5154 encrypted envelope)
3. OS keychain — service `chroxy-discord-bot`, account `bot-token`

Never in `config.json` (`validateConfig` warns, mirroring the webhook rule); never
logged (redactor gains a bot-token pattern — match Discord's `<base64 id>.<base64
ts>.<hmac>` dotted shape *anchored to token-bearing contexts* to keep false positives
off ordinary base64 — plus a `maskBotToken` helper for use sites); never echoed in acks,
embeds, or error strings. The command secret follows the same ladder under its own
service name (§3); when the gateway runs on a non-hub tailnet node, both secrets are
provisioned manually over an authenticated channel — never committed, never in CI
secrets (§2.2).

### 8.1 Discord-side minimization

- **No privileged intents.** Interactions require no message-content intent — the bot
  cannot read channel traffic even if subverted at the Discord-permission level.
- **Guild-scoped command registration** to `discordReturn.guildId` only — no global
  commands; the surface exists in one operator-owned guild.
- **Private guild.** The status channel already discloses fleet activity to its
  members; the return path adds a command surface for them to *attempt*. Both point the
  same way: the guild is the operator's own, membership ≈ the operator.
- **Minimal channel permissions** (view + send in the status channel; no manage
  permissions beyond what the outbound sink already holds).
- **2FA on the bot-owning Discord account** — operator guidance, same class as "keep
  your Apple ID secure", but §6's account-compromise row is the reason to say it.

## 9. Audit Log and Kill Switch

### 9.1 Audit — always-on, fail-closed

Component `discord-audit`, emitted via the logger's level-independent `audit()` path
(tagged `[AUDIT] [discord-audit]`), exactly like `shell-audit` (#5985/#6001): recorded
regardless of `LOG_LEVEL`, redacted, in the daemon log.

One line per inbound command attempt, carrying: timestamp, `interactionId`, Discord
user ID, command, target project/session, outcome
(`delivered | queued | rejected:<reason> | killed`), queue depth after the operation —
and for interjections, the **SHA-256 of the full sanitized text plus its first 200
characters**. Rationale for logging content at all (where shell-audit deliberately logs
no keystrokes): this text is remote-channel input whose forensic value *is* the content,
and it is already destined for a session transcript via the provenance label — the
prefix makes the audit line self-contained, the hash binds it to the full text in the
transcript. Never logged: tokens of any class, the raw pre-sanitization bytes.

**Fail-closed:** if the audit line cannot be written, the command is **rejected** (the
rejection itself attempted best-effort). This deliberately diverges from `shell-audit`,
which observes but never gates — that trail records a *local, operator-authorized*
capability, where blocking the operator on a logging failure would be the tail wagging
the dog. Here the log is the accountability for a *remote* channel: an unauditable
remote command must not execute. The cost — losing remote interject while the logger is
down — is acceptable because the dashboard and app paths are unaffected.

Retention is bounded by daemon log rotation — which is #7162, still open. Until it
lands, the audit trail's lifetime is the current log files'; #7162 should treat
`[AUDIT]`-tagged lines as the retention floor when choosing policy.

### 9.2 Kill switch — one command, inbound only

- **Master enable:** `discordReturn.enabled`, default **false**. Enabling is an
  explicit operator action (`chroxy discord-return enable`, which also mints the
  command secret, §3).
- **The kill:** `chroxy discord-return kill` — the epic's one-command requirement.
  Order of operations is the reverse of live-revoke's (#6902), because the safe
  direction is reversed: revoke must persist-then-forget so a crash cannot *resurrect*
  a token; a kill flips **in-memory first** — the running daemon rejects immediately on
  both routes (`503 { "disabled": true }`, audit outcome `killed`) — then persists
  `enabled: false`. If the persist fails, the in-memory kill holds, the command warns
  that a restart would resurrect the path, and exits nonzero.
- **What it does not touch:** the outbound webhook sink — separate credential, separate
  module, keeps posting. Deliberate: during an incident you want *more* visibility, not
  less.
- **Manual fallbacks,** in order of reach: delete the command-secret keychain
  entry/file (daemon fails closed on every request, §3); reset the bot token in the
  Discord developer portal (severs the gateway connection at Discord's side).
- **Re-enable is a fresh decision:** `chroxy discord-return enable` again — never
  automatic, never on daemon restart from a half-persisted kill.

## 10. What Each Sub-Issue Implements From This Document

| Sub-issue | Owns | The contract lines it is reviewed against |
|---|---|---|
| #7167 — gateway | The bot process | Outbound gateway WS only (§2.1); resident process, local secret custody, never CI secrets (§2.2, §8); UX-tier allowlist check (§5.1); defer-then-follow-up ack (§6); no store-and-forward (§5.1); forwards `{interactionId, discordUserId, project, text}` with a size guard, no other local transformation — sanitization is daemon-authoritative |
| #7168 — daemon API + mailbox | The boundary | The two routes + fifth token class, no-fallback both directions (§3); daemon-side allowlist (§5.1); sanitization, framing, label map, daemon-owned `\r` (§5.1); queue caps, idempotency, freshness (§5.1); `isClaudeTui` fence (§5.1); status schema + embed test (§5.2); config block (§5.3); extends `bearer-token-authority.md` §2 table + §9 checklist |
| #7169 — audit + kill | The brakes | `discord-audit` component, fields, hash+prefix rule, fail-closed gate (§9.1); kill semantics, in-memory-first ordering, persist-failure behavior (§9.2); default-off enable flow |
| #7170 — v1.1 | Reply-UX | Thread context selects target only, never authority (§6); everything else unchanged |

Cross-cutting: inbound envelopes inherit the project-derivation clamp (#7123); audit
retention depends on log rotation (#7162).

## 11. Residual Risks (accepted for v1)

- **Owner Discord-account compromise ⇒ full channel authority.** Accepted because the
  ceiling is interject + status; the §4.2 bar exists so the ceiling doesn't drift
  upward without this trade being re-examined.
- **An interjection is prompt injection into an agent, by design.** The provenance
  label makes origin visible in the transcript and to the agent, and agents'
  instruction-source rules treat remote-channel text as data rather than command — but
  an agent *may* act on it; that is the feature. The mitigation is **who** can interject
  (the allowlist), not what interjections may say. Anyone modeling agent behavior should
  treat `[discord:…]`-labeled input as untrusted relative to the operator at the
  keyboard.
- **Availability.** A Discord outage takes the return path with it; the dashboard and
  app remain the primary control surfaces. No SLA is inherited from this feature.
- **Channel disclosure is unchanged.** The status embed already publishes fleet
  activity to the guild; §5.2's embed test keeps the return path from widening that.
