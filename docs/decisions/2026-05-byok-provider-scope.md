# BYOK Provider PR Scope

**Date**: 2026-05-21
**Companion to**: `2026-05-claude-tui-proxy-spike.md` (the Phase 1 + 2 spike that motivated this)
**Provider name**: `claude-byok` ✓ confirmed
**Epic tracker**: #4047
**Status**: scope locked, deferred issues filed (#4048-#4054), implementation pending

## Decisions (locked)

1. **Name**: `claude-byok`
2. **PR split**: Three PRs (prep refactor → core → tools). `/full-review` on each before merge.
3. **Skills system**: included in v1 (the core PR — PR #2).
4. **`claude-sdk` lifetime**: keep. Still useful for users who want to spend Anthropic free API credits via the Agent SDK wrapper after June 15.

## Why a new provider (vs extending `claude-sdk`)

`claude-sdk` today reads `ANTHROPIC_API_KEY` from env (`sdk-session.js:168`), so users *can* technically run it BYOK already. But:

1. **It uses `@anthropic-ai/claude-agent-sdk`** — a higher-level wrapper Anthropic owns the agent loop inside. After June 15 the Agent SDK *also* moves to the new metered credit pool when used via OAuth. Continuing to depend on it couples chroxy's roadmap to Anthropic's higher-level packaging decisions.
2. **It requires the `claude` binary installed** (`sdk-session.js:159-165` preflight — `binary.name='claude'`, `installHint='install Claude Code CLI'`). The Agent SDK spawns the binary under the hood. That binary requirement is a real friction for CI / headless deploys / slim containers.
3. **It hides the agent loop.** Tool definitions come from a preset (`tools: { type: 'preset', preset: 'claude_code' }` at `sdk-session.js:478`); chroxy can't easily change tool behavior or extend the toolset.

The new provider uses **`@anthropic-ai/sdk`** (the regular lower-level client — what the BYOK spike used). chroxy IS the agent: manages history, drives the tool loop, gates permissions, talks directly to `api.anthropic.com`. Stable, sanctioned, no binary required, full control.

## What it replaces / how it fits

| Provider | Spawns `claude`? | Auth | Billing | Status after this PR |
|---|---|---|---|---|
| `claude-cli` | Yes (`claude -p`) | OAuth | Subscription → **metered June 15** | Keep (subscription path for users with claude installed) |
| `claude-sdk` | Yes (via Agent SDK) | OAuth or API key | Subscription / per-token → **Agent SDK metered June 15** | Keep (parity option for users wanting Anthropic's wrapper) |
| `claude-tui` | Yes (interactive PTY) | OAuth | Subscription (interactive — **stays unmetered**) | Keep (conservative subscription path) |
| **`claude-byok` (new)** | **No** | **API key only** | **Per-token API (sanctioned)** | Add |

The new provider doesn't *replace* anything; it **adds the path that has no June 15 exposure and no claude-binary dependency**. Users on subscription stay on `claude-tui`. Users moving to metered billing anyway get a cleaner path than `claude-sdk` + binary install.

## Architecture

```
ClaudeByokSession (extends BaseSession)
 ├─ start()
 │   ├─ validate API key present
 │   └─ emit('ready', { sessionId, model, tools: <known list> })
 │
 ├─ sendMessage(prompt, attachments)
 │   ├─ append { role:'user', content:[...] } to _history
 │   └─ runAgentLoop()
 │       loop:
 │         ├─ client.messages.stream({ model, messages, tools, system })
 │         ├─ for await (event of stream):
 │         │    translate(event) → emit chroxy stream_start/stream_delta/tool_start
 │         ├─ if response.stop_reason === 'tool_use':
 │         │    for each tool_use block:
 │         │      ├─ this._permissions.handlePermission(toolName, input, signal, mode)
 │         │      ├─ if denied: build tool_result with is_error
 │         │      └─ if allowed: byokToolExecutor.run(toolName, input, cwd)
 │         │    append assistant + tool_result message to _history
 │         │    continue loop (model may chain tools)
 │         └─ else: emit('result', { stopReason, usage })
 │
 ├─ respondToPermission(/* from /permission long-poll */) — delegates to PermissionManager
 ├─ respondToQuestion(/* clarification question if model emits one */) — delegates to PermissionManager
 ├─ interrupt() — AbortController.abort() on the active stream
 ├─ setModel(), setPermissionMode() — base + re-resolve next turn
 └─ destroy() — abort + clear _history
```

The agent loop is the only meaningful new code. Streaming translation is mechanical (8 SDK event types → 5 chroxy event types). Permission gating is `permission-manager.js` exactly as `sdk-session.js` uses it.

## File-by-file change list

### New files (in `packages/server/`)

| File | LOC est | Purpose |
|---|---|---|
| `src/byok-session.js` | ~300 | `ClaudeByokSession` class — extends `BaseSession`, owns the agent loop |
| `src/byok-tools.js` | ~250 | Tool definitions (Read, Write, Edit, Bash, Glob, Grep, etc.) — `tools: [...]` array for SDK calls, JSON schemas |
| `src/byok-tool-executor.js` | ~250 | `executeTool(name, input, cwd, signal) → { result, isError }`. Local executors for each built-in tool; reuses existing `executeBash`, file ops, etc. where chroxy already has them |
| `src/byok-event-translator.js` | ~150 | Maps `@anthropic-ai/sdk` stream events → chroxy `stream_*` / `tool_*` / `result` events. Standalone module so it's unit-testable against fixture streams |
| `tests/byok-session.test.js` | ~500 | Session lifecycle, mocked SDK stream, message history, history-on-resume, abort behavior |
| `tests/byok-tool-executor.test.js` | ~300 | Each built-in tool — happy path, error path, permission-denied path, cancellation |
| `tests/byok-event-translator.test.js` | ~200 | Fixture stream → expected chroxy events |
| `tests/fixtures/anthropic-sse-*.txt` | — | Recorded SDK event streams from a real API call. ~3 fixtures (text-only turn, tool-use turn, multi-tool-chain turn) |

### Modified files

| File | Change |
|---|---|
| `packages/server/src/providers.js` | Register `'claude-byok': ClaudeByokSession`. Add to `getProviderAuthInfo` branching — required API key (not optional like `claude-sdk`). Add billing-detail string. |
| `packages/server/src/models.js` | `claudeByokDeriveId` or share `claudeDeriveId` — the model IDs are the same Anthropic IDs the SDK accepts (`claude-opus-4-7`, `claude-sonnet-4-6`, etc.). |
| `packages/store-core/src/provider-labels.ts` | Add `'claude-byok'` to `KNOWN_PROVIDERS` with label `Claude (API)`, tooltip `Direct Anthropic API — billed per token via ANTHROPIC_API_KEY. No claude binary required.`, type `'sdk'`. |
| `packages/dashboard/src/components/CreateSessionModal.tsx:70-78` | Add `'claude-byok': 'Uses Anthropic API credits (no claude binary required)'` to `PROVIDER_BILLING`. Add `<option>` to the provider dropdown. |
| `packages/server/tests/providers.test.js` | New entries in capability matrix + label/billing assertions. |
| `packages/server/tests/provider-data-dirs.test.js` | Decision: BYOK has no `dataDir` (no `~/.claude` dependency). Test asserts `getProviderDataDirs()` excludes BYOK. |
| `packages/server/package.json` | Confirm `@anthropic-ai/sdk` is a direct dependency (currently transitive — was via the agent SDK). Pin a version. |

### Deferred to follow-up PRs (issues filed)

| Item | Issue | Reason for deferring |
|---|---|---|
| MCP server support | #4048 | Sizable own-PR work — full subprocess lifecycle + JSON-RPC + tool namespace plumbing |
| `Task` (subagent) tool | #4049 | Recursive `ClaudeByokSession` + child-progress UI — its own design surface |
| `WebFetch` tool | #4050 | Day-2 — readability/sanitization complexity is its own thing |
| `TodoWrite` tool | #4051 | Day-2 — small but separate |
| Dashboard settings UI for API key paste | #4052 | UX PR; day-1 reads `ANTHROPIC_API_KEY` env var or `~/.chroxy/credentials.json` (mode 0600) |
| `docker-byok` container provider | #4053 | Additive; defer until BYOK demand warrants |
| Session-cumulative cost/usage display | #4054 | Strongly recommended for same release as v1; without it BYOK is a footgun for users new to API billing |

**Note on skills**: per user decision, skills are now in **v1** (the core PR, not deferred). `BaseSession._buildCombinedSkillsPrefix` integration ships in PR #2.

**Prompt caching**: implement basic always-cache-system in v1. Advanced multi-turn cache strategies stay informal until we see cost data from real usage.

## Capability matrix entry

```js
static get capabilities() {
  return {
    permissions: true,
    inProcessPermissions: true,  // chroxy is the agent, gates locally
    modelSwitch: true,           // re-resolved next turn
    permissionModeSwitch: true,  // re-resolved next turn
    planMode: false,             // no special plan mode in raw SDK
    resume: true,                // _history fully owned by chroxy
    terminal: false,
    thinkingLevel: true,         // SDK supports extended thinking config
    streaming: true,             // native SDK iterator
    skillToggle: true,           // we rebuild system prompt each turn
  }
}
```

## Settings / UX

### API key sourcing (day-1)

In priority order:
1. `process.env.ANTHROPIC_API_KEY`
2. `~/.chroxy/credentials.json` → `{ "anthropicApiKey": "sk-ant-..." }` (mode 0600 enforced on read)
3. Refuse session start with a clear error: "Set ANTHROPIC_API_KEY or save it in ~/.chroxy/credentials.json (mode 0600)"

Stored never in chroxy's main config (which is shared/committable). Never logged. Logger redaction filter on `sk-ant-` (mirrors what the audit recommended for the proxy provider).

### Model selection

The `CreateSessionModal` already has a model dropdown driven by `models.js` per-provider registry. BYOK reuses the same set as `claude-sdk` since the API accepts the same model IDs:

- `claude-opus-4-7` (default)
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`
- (whatever's in `FALLBACK_MODELS` from `models.js`)

No new UX work; the dropdown infrastructure already exists.

### Permission mode

Same `approve` / `auto` / `acceptEdits` / `plan` modes. Same dashboard dropdown. The permission-manager intercept point is `runAgentLoop`'s pre-tool-execution gate. No protocol change.

### Billing visibility

`CreateSessionModal` already surfaces `auth.detail` per provider (the "billing identity" string). BYOK's detail comes from `getProviderAuthInfo` and reads:

- Ready: `"Anthropic API (ANTHROPIC_API_KEY set — per-token billing)"`
- Not ready: `"ANTHROPIC_API_KEY not set — paste a key from console.anthropic.com or set the env var"`

## Tool execution — the meat

The tools chroxy needs to implement locally (matching Claude Code's standard set):

| Tool | Implementation | Existing chroxy helper? |
|---|---|---|
| `Read` | `fs.readFile` with line-range support | Some pieces in `ws-file-ops.js` — extract |
| `Write` | `fs.writeFile` (truncate semantics) | Same |
| `Edit` | string-replace with uniqueness check (matches Claude Code's Edit semantics) | None — implement |
| `Bash` | spawn shell, capture stdout/stderr/exit, timeout | `permission-manager.js` already handles the gate; raw exec needs a small helper. Probably ~50 LOC of shell-exec wrapping. |
| `Glob` | `fast-glob` or builtin | None — implement |
| `Grep` | `ripgrep` if installed, fallback to JS | Implement |
| `WebFetch` | `fetch` + DOMPurify + readability extract | Day-2 — non-essential for v1 |
| `TodoWrite` | in-memory list per session | Day-2 |
| `Task` (subagent) | nested SDK call | **Out of scope for v1** — big enough for its own PR |

Day-1 ships Read/Write/Edit/Bash/Glob/Grep — that's the 80%. WebFetch / TodoWrite / Task land as follow-ups.

Tool definitions live in `byok-tools.js` as a `BUILTIN_TOOLS` array — each entry is a `{ name, description, input_schema }` object the SDK accepts. The executor in `byok-tool-executor.js` switches on `name` and dispatches.

## Streaming event translation

```js
function translate(event) {
  switch (event.type) {
    case 'message_start':
      return { kind: 'stream_start', model: event.message.model, messageId: event.message.id }
    case 'content_block_start':
      if (event.content_block?.type === 'tool_use') {
        return { kind: 'tool_start', toolUseId: event.content_block.id, toolName: event.content_block.name }
      }
      return null
    case 'content_block_delta':
      if (event.delta?.type === 'text_delta') {
        return { kind: 'stream_delta', text: event.delta.text }
      }
      if (event.delta?.type === 'input_json_delta') {
        return { kind: 'tool_input_delta', partial: event.delta.partial_json }
      }
      if (event.delta?.type === 'thinking_delta') {
        return { kind: 'thinking_delta', text: event.delta.thinking }
      }
      return null
    case 'content_block_stop':
      return { kind: 'content_block_stop', index: event.index }
    case 'message_delta':
      return { kind: 'message_delta', stopReason: event.delta?.stop_reason, usage: event.usage }
    case 'message_stop':
      return { kind: 'result' }
    default:
      return null
  }
}
```

Verified against the spike: the SDK iterator emits these event types cleanly. Pure-function translation; tested against recorded fixtures.

## Effort estimate

Per the BYOK spike that worked end-to-end in ~150 LOC for a basic stream-and-respond loop (no tools, no history, no permissions):

| Slice | LOC | Days |
|---|---|---|
| `byok-session.js` core (start, history, stream loop, abort, destroy) | 300 | 1.0 |
| `byok-event-translator.js` (translate + tests against fixtures) | 350 | 0.5 |
| `byok-tool-executor.js` (6 built-in tools) | 550 | 1.5 |
| `byok-tools.js` (definitions matching Claude Code shapes) | 250 | 0.5 |
| Tests (3 files, with fixtures) | 1000 | 1.0 |
| Provider registration + capability matrix + provider-labels | 100 | 0.25 |
| Permission integration (reuses `permission-manager.js` — wiring only) | 100 | 0.25 |
| Settings detection + credentials.json fallback + redaction | 150 | 0.5 |
| **Total** | **2800 LOC** | **5.5 days** |

Compare to the subscription `claude-tui-proxy` (Builder 6-9 days, Skeptic 2-4 weeks): the BYOK provider is **smaller in code and smaller in time** because the SDK does the hard parts (TLS, gzip, SSE parsing, retry semantics, auth refresh, rate-limit headers, content_block_delta state machine).

## PR breakdown (chosen: three PRs)

Each gets `/full-review` before merge.

### PR 1 — Prep refactor (≈1-1.5 days)
- Extract reusable helpers from existing providers into `packages/server/src/built-in-tools/` (or similar):
  - `bash-exec.js` — shell-exec wrapper currently inline in `sdk-session.js` / `cli-session.js`
  - `file-ops.js` — Read/Write/Edit primitives currently scattered between providers and `ws-file-ops.js`
  - `permission-gate.js` — thin facade over `permission-manager.js` for consistent gating API
- **No behavior change.** Both providers (and incoming `claude-byok`) consume the shared helpers.
- Tests: existing test suite passes unchanged; new unit tests for the extracted helpers cover what was previously in-situ.
- Mergeable alone. Reduces PR 3's diff by ~30%.

### PR 2 — BYOK core, including skills system (≈2 days)
- `byok-session.js` — extends `BaseSession`; agent loop calling `client.messages.stream(...)`.
- `byok-event-translator.js` — SDK iterator → chroxy events.
- `byok-tools.js` — only the *system prompt + skills* portion. No execution-capable tools yet (those land in PR 3).
- Skills integration: hook into `BaseSession._buildCombinedSkillsPrefix` (or extract to a free function in PR 1 if it gets in the way).
- Provider registration (`providers.js`), labels (`store-core/provider-labels.ts`), dashboard option (`CreateSessionModal.tsx`).
- Credentials sourcing: env var first, then `~/.chroxy/credentials.json` (mode 0600 enforced).
- Logger redaction filter for `sk-ant-` / `Bearer\s+\S+`. Asserted by test.
- Tests: session lifecycle, mocked SDK stream against recorded fixtures, abort, history-on-resume.
- **Alpha-mergeable**: sessions can chat but can't execute tools. Behind a `experimental: true` flag in the capability matrix so the dashboard can label appropriately.

### PR 3 — BYOK tools (≈2 days)
- `byok-tool-executor.js` — dispatcher mapping tool name → executor; integrates with PR 1's shared helpers.
- `byok-tools.js` (extended) — `BUILTIN_TOOLS` array: Read, Write, Edit, Bash, Glob, Grep with JSON schemas matching Claude Code's published shapes.
- Permission-manager wiring: each tool fires `_permissions.handlePermission(...)` before executing.
- Tests: per-tool executor tests, multi-tool-chain integration test, permission-denied test, cancellation test.
- Removes the `experimental` flag; BYOK is feature-complete (modulo deferred follow-ups in #4048-#4054).

## Acceptance criteria

- [ ] `claude-byok` provider registered, validates per `providers.js` REQUIRED_METHODS + IN_PROCESS_PERMISSION_METHODS.
- [ ] `chroxy doctor` reports BYOK ready when `ANTHROPIC_API_KEY` is set; reports actionable error otherwise.
- [ ] Dashboard CreateSessionModal lists `Claude (API)` with billing tooltip.
- [ ] A fresh BYOK session can: ask a question → receive a streaming response with live `stream_delta` events arriving from ~1.5s.
- [ ] A fresh BYOK session can: ask a code question that triggers tool use (`Read this file and tell me what it does`) → permission prompt fires on the phone → tool executes after approve → response streams back.
- [ ] Multi-tool chains work (model calls Tool A, then Tool B based on A's result, etc.) — verified by a test with a fixture stream.
- [ ] Interrupt (Stop button) cleanly aborts the SDK stream + clears `_isBusy`.
- [ ] No `Authorization:` / `sk-ant-` token ever appears in any log line. Asserted by a test.
- [ ] `~/.chroxy/credentials.json` is read only with mode 0600; warns and refuses otherwise.
- [ ] Capability matrix snapshot in tests updated.
- [ ] CHANGELOG entry.

## Risks worth naming

- **`@anthropic-ai/sdk` version pinning** — Anthropic may bump SDK majors and break the iterator interface. Pin to a tested version, write the translator defensively (`default: null` for unknown event types).
- **Tool semantic drift** — Claude Code's `Read` / `Write` / `Edit` semantics may evolve over time. Our re-implementations need fixture tests that lock the behavior; surprise drift means user-visible inconsistency between providers. Mitigate by mirroring the published Claude Code tool schemas verbatim.
- **Cost surprise** — users new to API billing may rack up costs unexpectedly. Recommend dashboard surfaces session-cumulative usage estimate (from the per-turn `usage` block the SDK already provides). Stretch goal for this PR; necessary for the next release.
- **Edge case: subagent / Task tool** — out of scope for v1 but flag it loudly. Some Claude Code prompts rely on the subagent tool. Without it, BYOK is feature-incomplete vs `claude-tui` / `claude-sdk` for complex workflows. Need clear "limitations" copy in the UI.

## Decisions (resolved)

1. ✓ Name: `claude-byok`
2. ✓ Three PRs, `/full-review` on each
3. ✓ Skills system in v1 (PR 2)
4. ✓ Keep `claude-sdk` — still useful for users spending Anthropic free API credits via the Agent SDK wrapper after June 15
