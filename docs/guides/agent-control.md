# agent-control — external agent harness over chroxy's own protocol

## What this is

`agent-control` is a thin [MCP](https://modelcontextprotocol.io) adapter that lets an
**external agent harness** — Codex, Claude, Gemini, or anything else that speaks MCP —
drive an **ordinary chroxy session** as a set of tools. It is not a new control plane: it
reuses the daemon's existing authenticated WebSocket protocol (auth, E2E encryption,
session lifecycle, the `input_ack` admission contract) end to end. The implementation is
`packages/server/src/agent-control/{client.js,events.js,mcp-server.js}`, run via
`chroxy agent-control --stdio` (`packages/server/src/cli/agent-control-cmd.js`).

**This running Codex/Claude session cannot hot-load this MCP server into itself.** It must
be added to the **MCP host's own configuration** — the CLI or app that spawned *you* — and
started by that host as a subprocess talking stdio. See "Host configuration" below.

## Relationship to existing epics

This is a bounded foundation, not a replacement for any of the following — each owns a
different problem this adapter deliberately does not solve:

- **#7823 (durable task/handoff identity)** — out of scope here. Precisely what does and
  doesn't survive: a **transport reconnect within the same running MCP-server process**
  (the WS connection drops and `ClientManager` reconnects) carries recorded **model
  expectations** forward — a session `chroxy_create_session` created earlier is still
  gated on the model it was created with. It does **not** carry the **event history**
  forward: every reconnect mints a fresh cursor epoch (see `events.js`), so a cursor from
  before the reconnect reports `gap: true, gapReason: 'connection_reset'` rather than
  silently resuming. Model expectations also survive a **daemon restart** if the same MCP
  process reconnects; restarting the **MCP-server process** discards the map. This adapter
  has no durable notion of "this session belongs to this task". Durable task/handoff
  identity across process restarts is #7823's job.
- **#7437 (universal mailbox)** — a different surface entirely (notification/wakeup
  delivery into an idle session via the ingest secret). `agent-control` does not touch it
  and does not replace it.
- **epic #6691 (in-daemon orchestration)** — `agent-control` is an **external** client
  process, not an orchestration engine living inside the daemon. It has no scheduler and no
  task database, and does not spawn or supervise other sessions on the daemon's behalf. It
  CAN list/create/drive multiple ordinary sessions concurrently on one daemon connection —
  correlated calls (`chroxy_send_input`, `chroxy_get_events`, `chroxy_respond_permission`)
  for different sessions may be in flight at the same time. Only the three uncorrelated
  operations (`list_sessions`/`create_session`/`subscribe_sessions` — the protocol carries
  no `requestId` for them) are serialized on the wire per connection; that is an
  implementation detail of this one connection, not a "one session at a time" limit on what
  the adapter can drive.

## The seven tools

| Tool | Mutates? | What it does |
|---|---|---|
| `chroxy_daemon_info` | no | Safe daemon metadata (server/protocol version, encryption mode, a bounded capabilities map). Never the raw `auth_ok` frame or `connection.json`. |
| `chroxy_list_sessions` | no | Lists ordinary sessions, each annotated with `modelStatus: { requested, observed, unknown, mismatch }`. |
| `chroxy_create_session` | **yes** | Creates a session. Refuses `provider: 'user-shell'` and any `skipPermissions` option; always sends `skipPermissions: false` explicitly regardless of the daemon's own default. |
| `chroxy_send_input` | **yes** | Sends text input, returns the daemon's correlated `input_ack` verbatim. *Session-owned* (see below): a session this process did not create is refused with `reason: 'not_owned'`, before any network I/O. Gated on a fresh model-status check when the session has a recorded model expectation (see "Model truth" below). |
| `chroxy_get_events` | no | Bounded, cursor-based read of a session's retained, normalized event log. Observing is unrestricted — any session this connection can subscribe to, not only ones this process created. |
| `chroxy_interrupt_session` | **yes** | Best-effort interrupt (the protocol has no correlated ack for this). *Session-owned*: same `not_owned` refusal as `chroxy_send_input`. |
| `chroxy_respond_permission` | **yes** | Answers an *observed, session-owned* pending permission request with `allow`/`deny` — never `allowAlways`. "Session-owned" means **created by `chroxy_create_session` in this same MCP-server process**; a prompt in any other session (one a human is driving, say) is refused with `reason: 'not_owned'` and left for its owner. `allow` is additionally refused for a floor-forced request, a never-delegable tool (`mcp_spawn`/`request_permissions`), or a command-style tool without `--allow-command-approvals` — see "Answering permissions is a human-level decision" below. |

**Session-owned, uniformly.** `chroxy_send_input`, `chroxy_interrupt_session`, and
`chroxy_respond_permission` all gate on the SAME ownership set (`_ownedSessions` in
`client.js`, via one shared `_ownershipRejection` check) — only a session this MCP-server
process created with `chroxy_create_session` may be mutated. `chroxy_create_session` itself
is exempt (it is the ownership *source*, not a session-targeting mutation), and
`chroxy_get_events`/`chroxy_list_sessions`/`chroxy_daemon_info` are exempt because observing
is never restricted — a planner may always see any session it can subscribe to; it may only
*change* one it created.

Under `--read-only`, the four mutation tools (`chroxy_create_session`, `chroxy_send_input`,
`chroxy_interrupt_session`, `chroxy_respond_permission`) are both **absent from the tool
list** and **hard-refused if called directly** — the gate is enforced at dispatch time, not
merely by omission from `tools/list`.

## Security model

Full detail lives in [`docs/security/bearer-token-authority.md`](../security/bearer-token-authority.md)
and [`docs/security/encryption-threat-model.md`](../security/encryption-threat-model.md) — this
adapter does not introduce a new token class or widen what a token is allowed to do; the
daemon's existing authority checks are the actual floor. Specific to `agent-control`:

- The bearer token is held **in memory only** for the life of the process — never in argv,
  never logged, and redacted (exact match, plus the shared value-shape patterns) out of
  every tool result, error, and log line before it leaves the process.
- **Local is the default and the safe path**: it reads the daemon's `connection.json` for
  its `port` field and always dials `127.0.0.1` — **never** the public tunnel URL, even
  though `connection.json` may also contain one.
- A **remote** endpoint is never inferred. It requires an explicit `--url ws://` or
  `wss://` plus `CHROXY_AGENT_CONTROL_TOKEN` in the environment.
- E2E encryption is negotiated exactly as any other chroxy client (eager or discrete key
  exchange, per the daemon's `auth_ok`). Optional daemon-identity pinning via
  `--pin-identity <base64 key>` (or `CHROXY_AGENT_CONTROL_PIN`) refuses a handshake that
  lacks a valid signature over the offered exchange key, or that unexpectedly downgrades to
  no encryption — mirroring the daemon's own anti-downgrade behavior.
- **A pin does not protect the token.** The bearer token travels in the very first `auth`
  frame, before any key exchange and therefore before the pin can be checked (see
  "Auth Token Transmitted Before Encryption" in the
  [threat model](../security/encryption-threat-model.md)). A pin makes an impersonating
  endpoint's handshake fail and the session is refused — but by then the impersonator has
  the token. Only TLS keeps the token off the wire: use `wss://` for any non-loopback
  `--url`. Over `ws://` to another host, anyone on the path can read the token.
- **Pinning the local daemon needs `encryptLocalhost`.** A genuine loopback connection gets
  the daemon's localhost plaintext bypass (same threat-model doc), so `auth_ok` offers no
  encryption and a pinned client refuses with `IDENTITY_PIN_REQUIRES_ENCRYPTION`. That is
  the pin failing closed, not a bug; set `encryptLocalhost: true` on the daemon to pin locally.
- **The local path uses the primary token.** `connection.json` (written `0600`) carries the
  daemon's primary API token, and this adapter authenticates with it — full host authority
  per [`bearer-token-authority.md`](../security/bearer-token-authority.md). It does not widen
  who can obtain that token (any process running as your user can already read the file),
  but every MCP host you register it with is handed that authority.
- **Frames that did not come from the authenticated daemon are discarded.** When the daemon
  requires encryption, a plaintext application frame received during the handshake (before
  `auth_ok`, or in the discrete key-exchange window) is dropped rather than recorded as an
  observed permission or event — an on-path injector cannot plant a prompt for the planner
  to answer. After the handshake, a plaintext frame closes the connection
  (`ENCRYPTION_DOWNGRADE`).

### Answering permissions is a human-level decision

`chroxy_respond_permission` lets the planner stand where a person would stand. Two limits
apply, and both are now enforced:

- **Ownership (enforced).** Only sessions this MCP-server process created can be answered;
  see the tool table. The set is in memory, so after the MCP-server process restarts its
  earlier sessions become `not_owned` — their prompts time out and the daemon auto-denies,
  which fails closed.
- **The protected-path floor (enforced, #7968).** The
  [permission floor](../security/permission-floor.md) forces a *prompt* — never a deny — for
  secret reads (`.env`, key material) and for writes into config directories such as
  `.git/` and `.claude/`, so that a person decides. A daemon that implements #7968 marks
  every `permission_request` broadcast with `floored: true|false`. `chroxy_respond_permission`
  reads that flag off exactly the request it observed (never re-derived — a second
  implementation of the floor is exactly what `permission-floor.md` says not to build) and
  refuses `allow` unless it is the **explicit** `false`:
  - `floored: true` → `allow` refused with `reason: 'floored'`; `deny` still goes through.
  - `floored` **absent** (a daemon that predates #7968) → `allow` refused with
    `reason: 'floor_unknown'`, fail-closed — this adapter cannot tell a floored prompt from
    an ordinary one without the flag, so it refuses rather than guess. `deny` still goes
    through.
  - `floored: false` → an ordinary prompt; `allow` proceeds normally.

  Practically: until the daemon you're pointed at actually sends `floored`, every `allow`
  through `chroxy_respond_permission` is refused — only `deny` and observation work. Once a
  daemon that implements #7968 is running, `allow` works again for ordinary (non-floored)
  prompts, and a floored prompt is left for a person exactly as the floor intends.

- **Never-delegable tools (enforced, #7973).** Two tools are refused `allow` **unconditionally
  — whatever `floored` says** — because they are high-authority independent of any path field:
  - `mcp_spawn`: an `allow` PERSISTS a permanent "trust this binary" MCP-server grant to disk
    (#4462). The daemon's own bypass-mode sweep (`autoAllowPending()` in
    `permission-manager.js`) already refuses to fold this into an auto-allow; agent-control
    mirrors that intent for its own one-shot `allow` path.
  - `request_permissions` (codex's sandbox-scope escalation prompt).
  These are the exact `NOT_DELEGABLE_TOOLS` set exported from `permission-manager.js` and
  imported (never copied) by `agent-control/client.js` — `allow` refuses with
  `reason: 'not_delegable'`; `deny` still goes through.
- **Command-tool approvals (deny-only by default, opt-in, #7973).** `Bash` (Claude SDK / BYOK)
  and codex's `shell` carry an arbitrary, caller-supplied command string. The protected-path
  floor inspects PATH-carrying input fields only — it cannot see into a command string, so
  `floored: false` on a `Bash` prompt means "no path field looked protected," not "this
  command is safe" (`cat .env` is an ordinary, unfloored Bash call). `allow` for one of these
  is refused with `reason: 'command_approval_disabled'` unless this MCP server was started
  with `--allow-command-approvals` — and even then, the floored and ownership gates above
  still apply on top; the flag only ever narrows further, it never overrides either of them.
  A clear warning is logged to stderr at startup whenever the flag is enabled. This is off by
  default: only enable it for a planner you trust with shell-level authority over the daemon.

## Running it

```bash
chroxy agent-control --stdio                        # local daemon, read-write
chroxy agent-control --stdio --read-only            # local daemon, mutation tools absent
chroxy agent-control --stdio --allow-command-approvals   # let the planner approve Bash/shell too (logs a startup warning)
chroxy agent-control --stdio --url wss://your-tunnel-host --pin-identity <base64-key>
```

There is **no `--token` flag** — argv is visible to every other process on the machine via
`ps`. A remote connection's token comes **only** from `CHROXY_AGENT_CONTROL_TOKEN` in the
environment; the local (default) case needs no token anywhere in argv or config, since it
reads `connection.json` itself.

**Not yet on npm.** `chroxy agent-control` has not shipped in a published `chroxy` release
yet (this is the PR introducing it) — the published `chroxy@0.11` package does not have this
subcommand. Every example below therefore invokes the CLI entry point directly with Node 22
(`node /absolute/path/to/chroxy/packages/server/src/cli.js agent-control --stdio`) instead
of `npx chroxy agent-control --stdio`. **The `npx chroxy agent-control --stdio` form works
once this ships in a published release** — swap it back in at that point; until then,
`src/cli.js` is the entry point every host config below must point at.

## Host configuration examples (token-free, local case)

> Claude Code and Gemini CLI syntax below has been independently verified against each
> host's official docs. The Codex example is verified against the installed `codex` CLI on
> this machine (`/opt/homebrew/bin/codex`) — its exact flags may still drift across Codex
> CLI versions, so confirm against `codex mcp add --help` if it's been a while.

### Claude Code CLI

Per the [MCP docs](https://code.claude.com/docs/en/mcp), a stdio server is added with `--`
before the command:

```bash
claude mcp add chroxy-agent-control -- node /absolute/path/to/chroxy/packages/server/src/cli.js agent-control --stdio
```

Read-only:

```bash
claude mcp add chroxy-agent-control -- node /absolute/path/to/chroxy/packages/server/src/cli.js agent-control --stdio --read-only
```

### Codex CLI

```bash
codex mcp add chroxy-agent-control -- node /absolute/path/to/chroxy/packages/server/src/cli.js agent-control --stdio
```

Read-only:

```bash
codex mcp add chroxy-agent-control -- node /absolute/path/to/chroxy/packages/server/src/cli.js agent-control --stdio --read-only
```

### Gemini CLI

Per the [MCP server docs](https://geminicli.com/docs/tools/mcp-server), add an entry to the
`mcpServers` object in your Gemini CLI settings:

```json
{
  "mcpServers": {
    "chroxy-agent-control": {
      "command": "node",
      "args": ["/absolute/path/to/chroxy/packages/server/src/cli.js", "agent-control", "--stdio"],
      "trust": false
    }
  }
}
```

Gemini CLI defaults new MCP servers to `trust: false`, meaning the CLI prompts for approval
before the first call to each tool. Leave it `false` until you've reviewed what the
mutation tools do; only set `trust: true` deliberately once you understand the implications
of letting Gemini answer permission prompts and send input unattended.

### Remote / tunnel example (token via environment, never in argv or committed config)

None of these examples put a literal token value in a command, in argv, or in a config file
on disk. A shell prefix like `FOO=bar claude mcp add ...` is a **one-shot** environment
variable for that single invocation only — it does **not** get saved into the host's stored
MCP config, so it is not a way to persist `CHROXY_AGENT_CONTROL_TOKEN` for a server the host
spawns later. Two approaches that actually persist it:

1. **Claude Code — `.mcp.json` environment-variable interpolation.** Per the
   [MCP docs](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json),
   `.mcp.json`'s `env` block supports `${VAR}` interpolation, resolved from the environment
   the Claude Code process itself is running in — so the JSON file on disk never holds the
   literal token, only a reference to it:

   ```json
   {
     "mcpServers": {
       "chroxy-agent-control": {
         "command": "node",
         "args": ["/absolute/path/to/chroxy/packages/server/src/cli.js", "agent-control", "--stdio", "--url", "wss://your-tunnel-host"],
         "env": { "CHROXY_AGENT_CONTROL_TOKEN": "${CHROXY_AGENT_CONTROL_TOKEN}" }
       }
     }
   }
   ```

   For this to resolve, `CHROXY_AGENT_CONTROL_TOKEN` must already be set in Claude Code's
   OWN environment (your shell profile, a secrets manager injecting it before Claude Code
   starts, a launchd/systemd unit, …) — the interpolation only substitutes a variable that's
   already there, it does not itself fetch or store a secret.

2. **The host process itself already has the token in its environment**, and the MCP server
   simply inherits it as a normal child process would (no special config syntax needed) —
   this is how Codex CLI picks it up, and is equally valid for Claude Code/Gemini if you'd
   rather not rely on `.mcp.json` interpolation:

   ```bash
   # Start the host with CHROXY_AGENT_CONTROL_TOKEN supplied by your secrets manager.
   codex mcp add chroxy-agent-control -- node /absolute/path/to/chroxy/packages/server/src/cli.js agent-control --stdio --url wss://your-tunnel-host
   ```

For Gemini CLI, use the same environment inheritance approach and keep the token out of
the settings file:

```json
{
  "mcpServers": {
    "chroxy-agent-control": {
      "command": "node",
      "args": ["/absolute/path/to/chroxy/packages/server/src/cli.js", "agent-control", "--stdio", "--url", "wss://your-tunnel-host"],
      "trust": false
    }
  }
}
```

## Model truth

`chroxy_create_session`'s result and every `chroxy_list_sessions` row carry `modelStatus: {
requested, observed, unknown, mismatch }`. `observed` is read straight from the daemon
(`null` → `unknown: true`, never guessed or assumed to equal what was requested).
`chroxy_send_input` re-checks this **fresh** (not from a cache) for any session with a
recorded expectation and **refuses to send** when the status is `mismatch` or `unknown`,
returning `status: 'blocked'` instead — pass `acknowledgeModelMismatch: true` to send
anyway once a human/planner has consciously decided the mismatch is acceptable. This exists
because a daemon can silently fall back to a different model than requested (observed in
production: an explicit `claude-sonnet-5` create request booting Opus instead, with
`session_list` reporting `model: null`) — this adapter's whole point is to make that
observable and blocking by default, not to guess.

See [Running a backlog through agent-control](agent-control-backlog.md) for the dispatch
contract, proposed first-wave issues, and the durable coordination follow-ups.

## Known limitations

- **No `chroxy_get_history` tool.** `request_full_history` has no `requestId` correlation
  on the wire, so a caller-initiated full-history pull cannot be safely distinguished from
  the daemon's own connect-time replay burst without a protocol change. Evaluated and
  skipped for this foundation; `chroxy_get_events` with no `cursor` returns everything
  currently retained, which covers most practical needs.
- **`chroxy_respond_permission` can report `status: 'uncertain'` even on a successful
  send**, for legacy (non-SDK) daemon permission-resolution code paths that don't
  unconditionally broadcast a `permission_resolved` confirmation back to the resolving
  client. This is a real protocol gap this adapter is honest about, not a client bug —
  never retry automatically on `uncertain`.
- **One daemon per MCP-server process.** There is no multi-daemon fan-out; running against
  several daemons means running several `chroxy agent-control --stdio` processes.
- **Local-only by default**, by design (see Security model above).
- **In-memory state only.** Event log, model expectations, session ownership, and
  observed-permission tracking all live in the MCP-server process's memory and are lost if
  it restarts.

## Follow-ups worth filing

- A durable, `requestId`-correlated `request_full_history` (or an equivalent) would unblock
  a real `chroxy_get_history` tool — likely worth scoping against #7823 rather than as a
  standalone change, since both want a stable notion of "this planner's view of a session"
  across reconnects.
- The legacy permission-resolution broadcast gap (unconditional `permission_resolved` even
  on the non-SDK path) would remove the most common source of `uncertain` results from
  `chroxy_respond_permission`.
- **Finding (#7973), daemon-side, tracked separately as #7975:** `autoAllowPending()` in
  `permission-manager.js` does not consult `NOT_DELEGABLE_TOOLS` (or `NEVER_AUTO_ALLOW`) for
  `request_permissions` — a pending `request_permissions` prompt carries neither
  `protectedTarget` nor the `mcpTrust` flag `mcp_spawn` prompts carry, so it falls through
  `autoAllowPending`'s default branch and IS folded into a bypass-mode sweep if a session
  switches to auto/bypass mode mid-turn. This is a real gap in the daemon's own bypass-mode
  handling, independent of agent-control; this PR does not change daemon behavior, only shares
  the exclusion set agent-control now enforces on its own path.
