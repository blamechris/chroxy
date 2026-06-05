# Spike: `claude --channels` MCP as a chroxy provider (`claude-channel`)

Status: **Spike / investigation** — findings + go/no-go recommendation. No provider is wired into the live registry by this document (that is the job of sub-issues #3952–#3956).

Tracking issue: [#3951](https://github.com/blamechris/chroxy/issues/3951). Sub-issues: #3952 (prototype), #3953 (scaffold), #3954 (bridge), #3955 (permission relay), #3956 (dashboard/docs/packaging).

Last verified against: **Claude Code CLI v2.1.163** (installed locally), Anthropic docs `code.claude.com/docs/en/channels` and `.../channels-reference` as of 2026-06-04.

---

## TL;DR — recommendation

**Conditional GO**, sequenced behind the existing `claude-tui` provider, gated as a **research preview** option that is never the default.

- `claude --channels` is **real and present** in the installed CLI (v2.1.163, well past the v2.1.80 minimum). The flag is hidden from `claude --help` but functional, and the channel protocol strings (`notifications/claude/channel`, `.../permission`, `.../permission_request`, the `experimental: { 'claude/channel': {} }` capability key, and the `<channel source="…">` envelope) are all present in the binary and documented. See [Verification](#verification) for the exact observations.
- The protocol is an **Anthropic-defined MCP contract**, which is a materially lower long-term maintenance surface than `claude-tui`'s ANSI-scrape / PTY-keystroke approach. That is the core argument for adopting it.
- The blocking caveats are all **preview-stability and ergonomics**, not feasibility:
  1. The contract is explicitly a research preview and "may change based on feedback" (Anthropic's words).
  2. Custom (non-allowlisted) channels require `--dangerously-load-development-channels` until a marketplace listing is approved. That flag carries a scary name we'd be asking chroxy users to pass.
  3. The channel surface gives us **inbound events + reply + permission relay**, but it does **not** solve model-switch or permission-mode-switch — those remain the same slash-keystroke problem `claude-tui` has. The channel is a sibling transport, not a superset.
- Therefore: build it as a **parallel provider** (matching #3951's stated scope), keep `claude-tui` shipping, and **do not** make any decision about deprecating `claude-tui` here.

Net: the spike de-risks the chain. The protocol exists, is documented, and maps cleanly onto chroxy's provider contract. Proceed with sub 1 (standalone prototype) first to prove the live round-trip before investing in bridge wiring.

---

## What `--channels` is

A *channel* is an MCP server, spawned by an **interactive** `claude` session over stdio, that **pushes events into the running session**. Unlike a normal MCP server (which Claude *pulls* from on demand), a channel *pushes*: external events arrive in Claude's context wrapped in a `<channel source="…">` tag while the session is open. Two-way channels additionally expose a `reply` tool so Claude can send a message back out, and can opt in to **relay permission prompts** to the channel.

This is Anthropic's first-party building block for "drive a Claude Code session from somewhere other than the local terminal" — the same problem chroxy solves, but expressed as a documented protocol instead of a screen-scrape. That is precisely why it's worth adopting as a transport.

### Why it matters for chroxy

The `claude-tui` provider (`packages/server/src/claude-tui-session.js`) works and bills as a subscription session, but carries known fragility:

- PTY warmup + ANSI stripping (`ANSI_STRIP` regex, hex-dump diagnostics).
- Permission relay via a sidecar `permission-hook.sh` that POSTs to the chroxy HTTP server.
- `streaming: false` — no incremental output.
- Multi-question `AskUserQuestion` forms need empirically-pinned keystroke byte sequences and watchdogs (`ASK_USER_QUESTION_WATCHDOG_MS`, `OTHER_FREEFORM_*`).
- Every Claude Code release risks breaking the visual contract.

A channel-based provider replaces the scrape with a structured, documented event stream and replaces the hook script with Anthropic's first-party permission relay. The remaining `claude-tui` pain points that channels do **not** fix (model switch, permission-mode switch) are called out below so we don't oversell it.

---

## Verification

> Honesty note for reviewers: every claim in this section was observed against the installed CLI or quoted from the public docs. Where a claim is inferred from docs but not exercised end-to-end in this environment, it is flagged **[unverified-runtime]**.

### `--channels` exists in the installed CLI — **verified**

```
$ claude --version
2.1.163 (Claude Code)

$ claude --channels --help
--channels entries must be tagged: --help
  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)
  server:<name>                — manually configured MCP server
```

The flag is **hidden** from `claude --help` (a `grep -i channel` over the full help text returns only `--remote-control`, not `--channels`), but it is parsed and functional. It demands a tagged entry of one of two forms:

- `plugin:<name>@<marketplace>` — an installed channel plugin (allowlist-enforced).
- `server:<name>` — an MCP server named in `.mcp.json` / `~/.claude.json`.

`--dangerously-load-development-channels` is also present and accepts the same tag forms.

### Protocol strings are present in the binary — **verified**

`strings` over the compiled CLI (`~/.local/share/claude/versions/2.1.163`) surfaces the protocol contract verbatim:

- Notification methods:
  - `notifications/claude/channel`
  - `notifications/claude/channel/permission`
  - `notifications/claude/channel/permission_request`
- Capability key (literal source fragment in the binary):
  - `experimental: { 'claude/channel': {} }`
  - the comment `// Required: presence of this key registers the channel notification`
- Envelope template: `Events from ${H} arrive as <channel source=\"${H}\" ...>. Anything you want the sender to see must go through the reply tool — …`
- Channel-server description: `${H} channel server — stdio MCP server implementing the channel contract.`
- Allowlist gate: `… is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`
- Dev-flag warning: `--dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.`

This matches the public reference exactly, so the documented contract and the shipped binary agree.

### End-to-end round-trip against a live `claude` session — **[unverified-runtime]**

This spike did **not** drive a full `claude --dangerously-load-development-channels server:… → notification → reply → permission verdict` loop, because that requires an authenticated interactive `claude` session (subscription/console auth) in the loop. Proving that loop is exactly the deliverable of **sub 1 (#3952)**. The protocol shape below is taken from the published reference and corroborated by the binary strings, but the live behaviour should be confirmed by the sub-1 prototype before the bridge (sub 3) is built on top of it.

---

## The protocol contract (from the reference + binary)

### Capability declaration (MCP `Server` constructor)

| Field | Type | Meaning |
| --- | --- | --- |
| `capabilities.experimental['claude/channel']` | `{}` (required) | Presence registers the channel notification listener. |
| `capabilities.experimental['claude/channel/permission']` | `{}` (optional) | Declares the channel can receive permission-relay requests (requires CLI ≥ v2.1.81). |
| `capabilities.tools` | `{}` (two-way only) | Standard MCP tools capability — needed to expose the `reply` tool. |
| `instructions` | `string` | Injected into Claude's system prompt; tells Claude the envelope shape and which tool/attribute to reply through. |

Transport is `StdioServerTransport` — `claude` spawns the channel server as a subprocess and talks stdio.

### Inbound: pushing an event into the session

```js
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'the message body',          // becomes the <channel> tag body
    meta: { chat_id: '1', severity: 'high' }, // each key → a tag attribute
  },
})
```

Arrives in Claude's context as:

```
<channel source="<server-name>" chat_id="1" severity="high">the message body</channel>
```

`meta` keys must be identifier-safe (`[A-Za-z0-9_]`); keys with hyphens are silently dropped. The `source` attribute is set automatically from the server's configured name. Notifications are fire-and-forget — `await` resolves on transport write, not on Claude processing, and dropped silently if the session didn't load the channel.

### Outbound: the `reply` tool (two-way)

Standard MCP tool, nothing channel-specific. Registered via `ListToolsRequestSchema` / `CallToolRequestSchema`:

```js
{ name: 'reply',
  inputSchema: { type: 'object',
    properties: { chat_id: { type: 'string' }, text: { type: 'string' } },
    required: ['chat_id', 'text'] } }
```

Claude calls `reply(chat_id, text)`; the handler routes `text` back out to the external surface (for chroxy: back over the IPC socket → `stream_end`/`result`).

### Permission relay

Requires `claude/channel/permission` capability and CLI ≥ v2.1.81.

Inbound request — `notifications/claude/channel/permission_request`, four string params:

| Field | Notes |
| --- | --- |
| `request_id` | Five lowercase letters from `a–z` excluding `l` (so it never reads as `1`/`I` on a phone). Claude only accepts a verdict carrying an ID it issued. |
| `tool_name` | e.g. `Bash`, `Write`, `Edit`. |
| `description` | Human-readable summary (same text the local dialog shows). |
| `input_preview` | Tool args as a JSON string, truncated to ~200 chars. |

Outbound verdict — `notifications/claude/channel/permission`, two params:

| Field | Notes |
| --- | --- |
| `request_id` | Echoes the issued ID. Verdicts with unknown IDs are dropped silently. |
| `behavior` | `'allow'` or `'deny'`. |

Relay covers tool-use approvals (Bash/Write/Edit). Project-trust and MCP-consent dialogs do **not** relay. The **local terminal dialog stays open in parallel** — whichever answer (local or relayed) arrives first wins, the other is dropped. Only declare this capability if the channel gates its sender, since anyone who can reply can approve tool use.

---

## Proposed provider design (`claude-channel`)

Mirrors #3951's architecture sketch. This is the design the sub-issues would implement; it is **not** wired up here.

```
chroxy ws clients (mobile, dashboard)
        │
        ▼
   ws-server.js ──► ClaudeChannelSession ──► spawn (node-pty) `claude --dangerously-load-development-channels server:chroxy-channel`
                          │                          │
                          │                          └─ stdio ─► chroxy-channel-server.js (MCP child)
                          │                                            │
                          └────── Unix socket ($XDG_RUNTIME_DIR or os.tmpdir()) ──────┘
                                  • sendMessage(text)        → JSON line → mcp.notification('notifications/claude/channel')
                                  • reply(chat_id, text)     ← JSON line ← reply-tool handler   → emit 'stream_end' + 'result'
                                  • permission_request       ← JSON line ← permission handler   → chroxy permission UI
                                  • permission_verdict       → JSON line → mcp.notification('notifications/claude/channel/permission')
```

Two processes:

1. **`packages/server/src/channels/chroxy-channel-server.js`** — a small stdio MCP server (Node 22, `@modelcontextprotocol/sdk`). Declares the channel + permission + tools capabilities, exposes a localhost control surface (HTTP for the sub-1 prototype, Unix socket for the real bridge in sub 3), implements `reply`, and handles `permission_request`. Modelled on the upstream `fakechat` reference but in-tree.
2. **`packages/server/src/claude-channel-session.js`** — a `BaseSession` subclass that spawns `claude` with the channel pointed at (1), bridges the IPC socket to chroxy's event/permission pipeline, and normalizes outbound events via `event-normalizer.js` so the existing chat UI renders them.

### Capability matrix (proposed, from sub 2)

| Capability | `claude-tui` (today) | `claude-channel` (proposed) | Rationale |
| --- | --- | --- | --- |
| `permissions` | `true` (hook script) | `true` (channel/permission) | First-party relay replaces the sidecar hook. |
| `inProcessPermissions` | `false` | `false` | Verdicts round-trip over IPC, not in-process. |
| `modelSwitch` | `false` | `false` | **Channel does not help** — still a TUI-keystroke problem. |
| `permissionModeSwitch` | `true` (sidecar file) | `false` (initially) | No documented channel mechanism; revisit later. |
| `planMode` | `false` | `false` | Not exposed by the channel surface. |
| `resume` | `false` | `false` | Not in the channel contract. |
| `terminal` | `false` | `false` | No PTY surface exposed to clients. |
| `thinkingLevel` | `false` | `false` | Not exposed. |
| `streaming` | `false` | `true` | Channel notifications stream as they arrive — a real win. |
| `tools` | `true` | `true` | Tool calls render in chat. |

Note the deliberately honest cells: `claude-channel` is **not** a strict superset of `claude-tui`. It wins on `streaming` and on a documented permission contract; it loses `permissionModeSwitch` (at least initially) and gains nothing on model switching.

### Auth / billing

Same path as `claude-tui`: a subscription/console-authenticated interactive `claude` session. The provider does **not** accept `ANTHROPIC_API_KEY` for the channel path — preflight should mirror `claude-tui`'s `credentials: { envVars: [], hint: 'run claude login …', optional: true }`. Channels are explicitly **not available** on Bedrock / Vertex / Foundry, and Team/Enterprise orgs must enable `channelsEnabled` in managed settings — both worth surfacing in `chroxy doctor` / the dashboard.

### Preflight additions vs `claude-tui`

- Same `binary` block (`claude --version`, same candidate paths).
- Additionally: gate on **CLI ≥ v2.1.80** (≥ v2.1.81 for permission relay). The dashboard should disable the option with an explanatory tooltip below that version (sub 5).

---

## Comparison: `claude-channel` vs `-p` (`claude-cli`) vs TUI scrape (`claude-tui`)

| Axis | `claude-cli` (`-p`) | `claude-tui` (PTY scrape) | `claude-channel` (proposed) |
| --- | --- | --- | --- |
| Transport | `claude -p` subprocess, JSON/text stdout | interactive PTY, ANSI scrape + keystroke injection | stdio MCP + IPC socket, structured notifications |
| Protocol stability | CLI flag contract (stable-ish) | **visual TUI shape** (fragile, per-release risk) | **documented MCP contract** (preview — may change, but versioned + documented) |
| Streaming | partial (per-message) | `false` | `true` (notifications stream) |
| Permission relay | hook script → chroxy HTTP | hook script → chroxy HTTP | **first-party** `claude/channel/permission` |
| Billing | depends on auth (API key billed) | subscription | subscription (same path) |
| Model switch | restart with new model | slash-keystroke (faked) | **not addressed** (same gap as TUI) |
| Permission-mode switch | restart-based | sidecar file re-read | **not addressed initially** |
| Resume | yes | no | no |
| Packaging cost | none (built into CLI) | none | `@modelcontextprotocol/sdk` dep + `--dangerously-load-development-channels` until marketplace approval |
| Maintenance surface | low | **high** (empirical keystroke pins, watchdogs) | **low-to-medium** (depends on preview churn) |

The headline: against `claude-tui` specifically, `claude-channel` trades a fragile visual contract for a documented protocol contract and adds streaming + first-party permission relay — at the cost of a new npm dependency and a preview opt-in flag. It does **not** replace `claude-cli`'s `-p` path or its resume capability.

---

## Risks & unknowns

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | **Research-preview protocol churn.** Anthropic explicitly says the flag syntax and contract may change. | High | Pin the verified CLI version in preflight; gate the dashboard option as "research preview"; keep `claude-tui` as the stable fallback. Treat each Claude Code minor bump as a smoke-test trigger for this provider. |
| R2 | **`--dangerously-load-development-channels` UX.** We'd ask users to pass a flag whose name is deliberately alarming. | Medium | Path to a marketplace-approved `chroxy-channel` plugin (sub 5) removes the flag. Until then, document clearly *why* it's needed and that it bypasses only the allowlist, not org policy. |
| R3 | **Allowlist / org policy gating.** `channelsEnabled` (Team/Enterprise) and `allowedChannelPlugins` can block the channel; Console default-allows. Bedrock/Vertex/Foundry unsupported. | Medium | Detect and surface in `chroxy doctor` + dashboard auth panel. Fail with a clear message, not a silent drop. |
| R4 | **Live round-trip not yet proven here** ([unverified-runtime]). | Medium | This is exactly sub 1 (#3952) — prove the loop with the standalone prototype before building the bridge. |
| R5 | **Model / permission-mode switch unsolved.** Channel surface doesn't expose these. | Low–Medium | Document the gap; `claude-channel` simply reports those capabilities `false`. Not a regression vs the baseline — `claude-tui` fakes them via keystrokes. |
| R6 | **`@modelcontextprotocol/sdk` is a new server dependency.** | Low | Add to `packages/server/package.json`, latest stable. Node 22 supported (no Bun required — docs confirm Node/Deno/Bun all work). |
| R7 | **Notification ordering / batching.** Channel events queue and are delivered as a group on the next turn if Claude is busy. | Low | Bridge must not assume one-notification-per-turn; normalize accordingly. Independent streams need separate sessions. |
| R8 | **Prompt-injection surface.** An ungated channel lets anyone reaching the socket inject into the session. | Medium | chroxy's bridge socket is localhost/Unix-socket only and driven solely by `ClaudeChannelSession`; do **not** expose an open HTTP endpoint in production (keep the sub-1 HTTP path behind `CHROXY_CHANNEL_HTTP=1` for debugging only). Gate permission-relay declaration on that single trusted writer. |

---

## Go / no-go recommendation

**GO — conditional, sequenced, preview-gated.**

Rationale:

1. **Feasibility is verified.** The flag, the capability key, all three notification methods, and the envelope are present in the installed CLI and match the published contract. No fabrication, no guessing on the core protocol.
2. **It directly attacks `claude-tui`'s biggest liability** — the fragile visual contract — by swapping it for a documented protocol, and adds streaming + first-party permission relay as bonuses.
3. **The risks are containable** and all of the "preview" variety (R1–R3), not architectural. They argue for *gating*, not *abandoning*.
4. **Scope is already correctly bounded** by #3951: parallel provider, never default, no `claude-tui` deprecation decision.

Conditions on the GO:

- Do **sub 1 (#3952) first** and prove the live round-trip ([unverified-runtime] → verified) before committing to the bridge (sub 3). If the live loop doesn't behave as the docs describe, re-evaluate.
- Ship the provider **disabled-by-default**, labelled "research preview", with a CLI-version gate.
- Keep `claude-tui` shipping unchanged; make **no** deprecation decision in this chain.
- Re-spike if Anthropic graduates channels out of preview (the contract may shift on the way to GA).

---

## Pointers for the implementing sub-issues

- **#3952 (prototype):** `packages/server/src/channels/chroxy-channel-server.js` + `README.md`. Add `@modelcontextprotocol/sdk` to `packages/server/package.json`. HTTP listener (default 8788, `CHROXY_CHANNEL_PORT`) for `curl` testing. Mirrors upstream `fakechat`. **Deliverable: prove the live loop**, resolving R4.
- **#3953 (scaffold):** `packages/server/src/claude-channel-session.js` extends `BaseSession`; register in `providers.js`. `start()` throws "not yet implemented"; preflight/capabilities/auth fully wired. **Per CLAUDE.md, forward every `BaseSession` opt** through `super({ … })` (the middle-layer trap — see `feedback_jsonl_subprocess_middle_layer.md`) and satisfy the `lint-session-opt-forwarding.sh` + `lint-tests-state-file-path.sh` gates.
- **#3954 (bridge):** Replace the stub `start()` with node-pty spawn + Unix-socket IPC (`CHROXY_CHANNEL_SOCKET`); keep HTTP behind `CHROXY_CHANNEL_HTTP=1`. Normalize outbound via `event-normalizer.js`.
- **#3955 (permission relay):** Wire `claude/channel/permission` through `permission-manager.js` / `ws-permissions.js`. Track outstanding `request_id`s; drop verdicts for unknown IDs (R7-adjacent). Document that permissions flow through the channel, **not** the hook script.
- **#3956 (dashboard/docs/packaging):** Provider picker entry with "research preview" badge + CLI-version gate; `CONFIG.md` / `README.md` / `reference.md` entries; `PACKAGING.md` scoping the marketplace path that removes the `--dangerously-load-development-channels` flag.

---

## References

- Claude Code: Channels — https://code.claude.com/docs/en/channels
- Claude Code: Channels reference — https://code.claude.com/docs/en/channels-reference
- Official channel plugins (Telegram/Discord/iMessage/fakechat) — https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins
- Model Context Protocol — https://modelcontextprotocol.io
- Sibling provider — `packages/server/src/claude-tui-session.js`
- Provider registry — `packages/server/src/providers.js`
- Original PTY/TUI workaround — #3902
</content>
