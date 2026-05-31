/**
 * BYOK (Bring Your Own Key) provider — talks to Anthropic's API directly
 * using @anthropic-ai/sdk and a user-supplied API key. No `claude` binary,
 * no Agent SDK wrapper, no OAuth. chroxy IS the agent.
 *
 * Motivation + scope: docs/decisions/2026-05-byok-provider-scope.md
 * Audit:              docs/audit-results/clarp-proxy-provider-viability/
 *
 * PR 2 (this file) adds tool execution: when the model emits a tool_use
 * block, chroxy gates it through PermissionManager, dispatches to a local
 * executor (byok-tool-executor.js), feeds the tool_result back, and loops
 * until the model stops calling tools. Built-in tools: Read, Write, Edit,
 * Bash, Glob, Grep (see byok-tools.js). MCP / Task / WebFetch are deferred
 * to follow-ups #4048-#4051.
 */

import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk'
import { join } from 'path'
import { homedir } from 'os'
import { BaseSession } from './base-session.js'
import { PermissionManager } from './permission-manager.js'
import { createLogger } from './logger.js'
import { isOperatorTimeoutInRange } from './duration.js'
import {
  FALLBACK_MODELS,
  ALLOWED_MODEL_IDS,
  claudeDeriveId,
  resolveClaudeContextWindow,
  getModelPricing,
  computePromptCostUsd,
} from './models.js'
import { resolveAnthropicApiKey, maskApiKey } from './byok-credentials.js'
import { translateSdkEvent } from './byok-event-translator.js'
import { BUILTIN_TOOLS } from './byok-tools.js'
import { executeBuiltinTool } from './byok-tool-executor.js'
import { loadClaudeMcpConfig, toMcpServerMetadata } from './byok-mcp-config.js'
import { MCPFleet, MCP_TOOL_PREFIX } from './byok-mcp-fleet.js'

const log = createLogger('byok-session')

// Default per-turn token cap. Mirrors what the spike used; the SDK accepts
// up to 200k for Opus 4.7. 64k is generous for typical chroxy turns and
// the model stops at end_turn long before this in practice.
const DEFAULT_MAX_TOKENS = 64000

// Hard cap on history length to prevent unbounded growth. Each entry is
// a Claude API message ({ role, content }). At 50 turns we're well within
// any model's context window before the SDK does its own pruning.
const MAX_HISTORY_TURNS = 50

// Safety cap on tool-use rounds within a single user turn. The model can
// legitimately need 5-10 tool calls for a complex task; 25 is a generous
// ceiling that still catches infinite loops if the model misbehaves.
// Hitting the cap surfaces a clear error to the model rather than running
// up an unbounded API bill.
const MAX_TOOL_ROUNDS = 25

// TTL for the per-session realpath cache used by validatePathWithinCwd
// in the tool executor. The cwd shouldn't change mid-session, but caching
// for 30s strikes a balance between safety (re-stat to catch a swap) and
// performance (don't re-realpath the same cwd on every file op).
const CWD_CACHE_TTL_MS = 30_000

export class ClaudeByokSession extends BaseSession {
  static get displayLabel() {
    return 'Claude (API key — BYOK)'
  }

  static get dataDir() {
    // BYOK does NOT depend on ~/.claude — no claude binary, no OAuth.
    // Returning null tells getProviderDataDirs() to skip this provider
    // when collecting workspace data dirs (#2965). Setting to home would
    // pull every user dotfile into conversation-scanner's scope.
    return null
  }

  static get capabilities() {
    return {
      // PR 2: tool execution enabled with permission gating via
      // PermissionManager (same machinery as claude-sdk).
      permissions: true,
      inProcessPermissions: true,
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: false,
      // Still no cross-restart resume. _history is in-memory; #4047
      // tracks a follow-up to persist + resume.
      resume: false,
      terminal: false,
      // Thinking config supported by the SDK but not wired through the
      // chroxy UI yet — leave off until the toggle lands.
      thinkingLevel: false,
      streaming: true,
      // We rebuild the system prompt on every turn from
      // _buildSystemPrompt(), so an activate/deactivate of a skill
      // takes effect on the next user message. Same property as the
      // SDK provider.
      skillToggle: true,
    }
  }

  static get customEvents() {
    // tool_start / tool_result / tool_input_delta are surfaced per turn
    // for the dashboard's tool-call bubble UI. permission_request /
    // user_question / permission_resolved are re-emitted from
    // PermissionManager and already known to the SessionManager
    // forwarding pipeline, but list them here so the capability matrix
    // reflects reality. tool_input_delta (#4080) MUST be in this list —
    // session-manager.js:_wireSessionEvents reads `customEvents` to
    // build the TRANSIENT_EVENTS set it bridges to `session_event`
    // listeners; without it the emit fires on the local EventEmitter
    // and never reaches ws-forwarding.
    return ['tool_start', 'tool_result', 'tool_input_delta']
  }

  /**
   * Preflight check for `chroxy doctor`. Unlike claude-cli/claude-sdk,
   * BYOK has NO binary dependency — pure HTTPS to api.anthropic.com.
   * Required credential is the API key.
   */
  static get preflight() {
    return {
      label: 'Claude (BYOK)',
      credentials: {
        envVars: ['ANTHROPIC_API_KEY'],
        hint: `set ANTHROPIC_API_KEY or save it in ${join(homedir(), '.chroxy', 'credentials.json')} (mode 0600)`,
        optional: false,
      },
    }
  }

  static getFallbackModels() {
    return FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  /**
   * Model registry hook. BYOK accepts any Anthropic model id the API
   * accepts; reuse claude-* metadata since the ids are the same shape.
   */
  static getModelMetadata(modelId) {
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    const fullId = modelId
    const id = claudeDeriveId(fullId)
    return {
      id,
      label: id,
      fullId,
      contextWindow: resolveClaudeContextWindow(fullId),
      description: '',
    }
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.cwd]            Working directory for tool execution.
   * @param {string} [opts.model]          Anthropic model id; falls back to `claude-opus-4-7`.
   * @param {string} [opts.mcpConfigPath]  Path to a Claude-style MCP config (default: `~/.claude.json` or `$CHROXY_CLAUDE_CONFIG`).
   *   Canonical name (#4449). Only the `mcpServers` block is read — the rest of the
   *   file is ignored. A previous `opts.claudeConfigPath` alias was removed because
   *   it was unused at every call site and added no semantics over `mcpConfigPath`:
   *   only the MCP portion of the file is consumed by this session, so a single
   *   "where does the MCP config live" knob is sufficient. Wider Claude-config
   *   overrides (system prompt, settings) can be added as distinct named opts when
   *   any of them are actually used.
   * @param {number} [opts.mcpToolCallTimeoutMs]  Per-tools/call timeout; null/undefined = MCPClient default (30s).
   */
  constructor(opts = {}) {
    super({ ...opts, provider: opts.provider || 'claude-byok' })
    // Anthropic SDK client; lazily instantiated in start() so unit tests
    // can stub it via this._client = ... before start().
    this._client = null
    // In-memory conversation history. Each entry is a Claude API message
    // ({ role: 'user'|'assistant', content: <string|array> }). The SDK
    // accepts either shape for user/assistant turns.
    this._history = []
    // AbortController for the active stream so interrupt() can cancel.
    this._abortController = null

    // PermissionManager + event re-emission. Same wiring as
    // sdk-session.js:254-275 so the dashboard / mobile permission UI
    // and the audit log work uniformly across providers.
    this._permissions = new PermissionManager({ log })
    this._permissions.on('permission_request', (data) => this.emit('permission_request', data))
    this._permissions.on('user_question', (data) => this.emit('user_question', data))
    this._permissions.on('permission_resolved', (data) => {
      if (data && (data.requestId || data.toolUseId)) {
        this.emit('permission_resolved', data)
      }
    })
    // Backward-compatible accessors used by ws-permissions.js + settings-handlers.js.
    this._pendingPermissions = this._permissions._pendingPermissions
    this._lastPermissionData = this._permissions._lastPermissionData

    // Realpath cache used by the tool executor's path-safety check. One
    // cache per session — fresh sessions don't reuse a stale cwd.
    this._cwdRealCache = new Map()

    // #4051: Per-session TodoWrite list. Keyed by todo id; the executor
    // merges partial updates into this map so the model can update one
    // item without re-listing the rest. Explicitly cleared in destroy()
    // (#4137) so the Map doesn't survive if anything outside the session
    // holds a closure capturing it.
    this._todos = new Map()

    // #4085: Per-session set of model ids we've already logged a
    // "no pricing entry" warn for. Without this, a tool-heavy 50-turn
    // session on an unknown model logs 50 identical warns — noise that
    // drowns out signal. The set lives until destroy() (the session
    // goes away). setModel() does NOT clear entries: a user switching
    // unknown → known just stops adding; switching unknown → different-
    // unknown adds a new entry (one warn for the new one). The
    // semantically-correct invariant is "one warn per (session, model)
    // pair" — not "one warn per current model."
    this._pricingWarnedModels = new Set()

    // #4080: Per-stream index→toolUseId map. Populated on
    // `content_block_start` with `block.type === 'tool_use'` (where the
    // SDK emits both the block index and the tool_use id) and queried on
    // `tool_input_delta`, which only carries the index. Entry is deleted
    // on `content_block_stop` so the map stays small even on multi-tool
    // turns. The full map is cleared after the for-await loop in case
    // the stream terminated without emitting a final stop for every
    // block — kept inside the session (not the translator) per #4059's
    // boundary call: the translator stays pure, stateful tracking lives
    // here.
    this._streamingIndexToToolUseId = new Map()

    // #4080: toolUseIds whose permission_request is currently pending.
    // Populated when this session re-emits permission_request (line
    // ~165), drained on permission_resolved (line ~167). Consulted on
    // tool_input_delta — if the same toolUseId already has a pending
    // permission prompt, suppress the delta so the dashboard tool-call
    // bubble doesn't flicker between "running…" and a partial-input
    // preview while the user is deciding. (In the current single-round
    // BYOK flow this is defensive: permission requests fire AFTER the
    // stream ends, so a delta cannot race with a pending permission for
    // the SAME toolUseId within one round. The check exists so a future
    // mid-stream permission gate — or a permission carried across
    // rounds for the same toolUseId — can't accidentally flicker the
    // UI.) The PermissionManager keys its pending map by requestId, not
    // toolUseId, so we maintain a separate Set on the session.
    this._pendingPermissionToolUseIds = new Set()

    // #4076: MCP config discovery. Parses ~/.claude.json (or an
    // override) for the `mcpServers` block. Parse-only at this stage —
    // no child spawn, no tool wiring — those land in #4077/#4078/#4079.
    // Malformed configs log a single warn per server and produce an
    // empty list, so a corrupt user config can't take down session start.
    //
    // #4449: `mcpConfigPath` is the only supported override. The
    // earlier `opts.claudeConfigPath` alias was redundant — this
    // session only reads the `mcpServers` block, so a separate
    // "whole Claude config" knob added no behavior over
    // `mcpConfigPath` and had no callers. See constructor JSDoc.
    const mcpConfig = loadClaudeMcpConfig(opts.mcpConfigPath)
    for (const warning of mcpConfig.warnings) {
      log.warn(`BYOK MCP config: ${warning}`)
    }
    this._mcpServerConfigs = mcpConfig.servers
    this.mcpServers = Object.freeze(mcpConfig.servers.map(toMcpServerMetadata))
    // #4077: MCPFleet is lazy — created in start() only if servers exist.
    // Held here so destroy() can tear down even if start() never ran.
    this._mcpFleet = null
    // #4482: per-call MCP tools/call timeout (ms). null = use byok-mcp-client's
    // DEFAULT_TOOL_CALL_TIMEOUT_MS (30s) via the destructured default in
    // MCPFleet.callTool. Forwarded from session-manager via providerOpts →
    // opts.mcpToolCallTimeoutMs. Same defensive guard as resultTimeoutMs:
    // non-finite / non-positive (NaN, Infinity, 0, -1, strings) falls back
    // to null because setTimeout coerces those to 0 ms and every MCP tool
    // would look broken.
    // #4517: ceiling check via `isOperatorTimeoutInRange` (same as the three
    // sibling timeouts in #4509) — defends per-session BYOK assignment
    // against an over-24h value that would survive session-manager (e.g.
    // an embedder constructing ClaudeByokSession directly with a typoed opt).
    this._mcpToolCallTimeoutMs =
      isOperatorTimeoutInRange(opts.mcpToolCallTimeoutMs, { name: 'mcpToolCallTimeoutMs', log })
        ? opts.mcpToolCallTimeoutMs
        : null
    // #4456: wall-clock cap on fleet.start(). null = use the fleet's
    // DEFAULT_FLEET_START_CAP_MS (1500ms). Same defensive guard pattern
    // as _mcpToolCallTimeoutMs.
    this._mcpStartCapMs =
      Number.isFinite(opts.mcpStartCapMs) && opts.mcpStartCapMs > 0
        ? opts.mcpStartCapMs
        : null
  }

  // Subclass seams (#4656 — DeepSeek). Overriding these four lets a
  // sibling provider (DeepSeek's Anthropic-compatible endpoint, any
  // other future Anthropic-compatible service) reuse this entire agent
  // loop by swapping credentials, base URL, default model, and pricing
  // table — no fork, no re-implementation of the streaming + tool +
  // permission + MCP machinery.
  get _defaultModel() {
    return 'claude-opus-4-7'
  }

  _resolveCredentials() {
    return resolveAnthropicApiKey()
  }

  _buildClient(apiKey) {
    return new Anthropic({ apiKey })
  }

  _getPricing(model) {
    return getModelPricing(model)
  }

  async start() {
    if (this._client === null) {
      // Spike (BYOK direct) confirmed the SDK's standard constructor
      // works fine; baseURL defaults to api.anthropic.com.
      const resolved = this._resolveCredentials()
      if (!resolved.key) {
        this.emit('error', { message: `BYOK credentials not found — ${resolved.reason}` })
        return
      }
      this._apiKeySource = resolved.source
      // Mask in logs — full key never appears on disk. logger.js redactor
      // catches Bearer / sk-ant patterns as a defense in depth. The
      // `this._provider` label keeps the line accurate when a subclass
      // (#4656 — DeepSeek) reuses this start() through the four seams.
      log.info(`${this._provider || 'BYOK'} session ready — key source=${this._apiKeySource} key=${maskApiKey(resolved.key)} model=${this.model || 'default'}`)
      this._client = this._buildClient(resolved.key)
    }

    // #4077: spawn MCP children lazily on first start(). Errors during
    // handshake are non-fatal — the dead client just contributes zero
    // tools, identical to a server missing from config. We deliberately
    // wait for fleet.start() so this.mcpServers + tools list are stable
    // by the time we emit 'ready'.
    if (this._mcpServerConfigs.length > 0 && this._mcpFleet === null) {
      // #4457: pass the session's PermissionManager so the fleet can
      // emit a trust prompt for new (name, command, args[0]) tuples.
      // Tuples already trusted in ~/.chroxy/mcp-trust.json spawn directly
      // with no prompt; denied tuples set state=DEAD without spawning.
      // #4456: forward startCapMs override so operators can tune the
      // session-start wall-clock cap. Passing undefined lets the fleet's
      // constructor default (DEFAULT_FLEET_START_CAP_MS) win — exactly
      // what we want when no override is in play.
      const fleetOpts = { log, permissionManager: this._permissions }
      if (this._mcpStartCapMs !== null) fleetOpts.startCapMs = this._mcpStartCapMs
      this._mcpFleet = new MCPFleet(this._mcpServerConfigs, fleetOpts)
      await this._mcpFleet.start()
    }

    this._processReady = true
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })
  }

  async sendMessage(prompt, attachments, _options = {}) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }
    if (this._destroying || !this._processReady || !this._client) {
      this.emit('error', { message: 'Session not ready' })
      return
    }

    this._isBusy = true
    this._messageCounter += 1
    const messageId = `${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId
    this._abortController = new AbortController()
    const turnStartedAt = Date.now()

    // Attachments — PR 2 still keeps these as a warn until Read can
    // pick up materialised files. Tracked separately; not blocking.
    if (Array.isArray(attachments) && attachments.length > 0) {
      this.emit('error', {
        messageId,
        message: `BYOK provider does not yet materialise attachments (${attachments.length} dropped). Track follow-up: file-via-Read tool flow.`,
      })
    }

    // Build the user message. On the very first turn, prepend any skills
    // text from BaseSession._buildPrependPrompt(). Subsequent turns are
    // plain prompt text — skills that targeted `system` ride on the
    // rebuilt systemPrompt instead.
    let userText = typeof prompt === 'string' ? prompt : String(prompt ?? '')
    if (this._history.length === 0) {
      const prepend = typeof this._buildPrependPrompt === 'function'
        ? this._buildPrependPrompt()
        : ''
      if (prepend) {
        userText = `${prepend}\n\n---\n\n${userText}`
      }
    }
    this._history.push({ role: 'user', content: userText })

    // Trim history if it grew past the cap. We drop from the head but
    // keep pairs intact (user + assistant) so the wire never sees a
    // half-turn opening.
    while (this._history.length > MAX_HISTORY_TURNS * 2) {
      this._history.splice(0, 2)
    }

    const systemPrompt = typeof this._buildSystemPrompt === 'function'
      ? this._buildSystemPrompt()
      : ''

    this.emit('stream_start', { messageId })

    // Agent loop. Each iteration:
    //   1. Stream the next assistant turn (text + possibly tool_use blocks)
    //   2. If the turn ended with stop_reason !== 'tool_use', break.
    //   3. Otherwise, execute each tool_use block locally (with permission
    //      gating) and push a user message of tool_result blocks.
    //   4. Loop back to (1).
    // Bounded by MAX_TOOL_ROUNDS to catch infinite-loop misbehavior.

    // Accumulate usage + cost across every agent-loop round so the result
    // event reflects the WHOLE turn, not just the last round. Each round is
    // a separate billable API request; without accumulation a 5-round
    // tool-use turn reports only 1/5th of the actual cost (#4056).
    const turnUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    let turnCost = 0
    const pricingModel = this.model || this._defaultModel
    const pricing = this._getPricing(pricingModel)
    if (!pricing && !this._pricingWarnedModels.has(pricingModel)) {
      // #4085: warn at most once per (session, model) — not once per turn.
      this._pricingWarnedModels.add(pricingModel)
      log.warn(`no pricing entry for model=${pricingModel}; result.cost will be 0 — update CLAUDE_PRICING_USD_PER_MTOK in models.js`)
    }
    let lastStopReason = null
    // Snapshot the pre-turn history length so any stream-init failure (at
    // any round) can rollback the entire turn atomically. We derive it
    // from the current length minus the user message we just pushed at
    // L251 — clamped to 0 so this stays defensive if the trim above ever
    // collapses history harder than expected. Pre-#4109 the rollback only
    // ran at round 0, leaving a trailing tool_result `user` turn after a
    // round-1+ failure — the next sendMessage would then push another
    // `user` turn back-to-back, soft-breaking the alternation invariant
    // the API may tighten on in future.
    const historyLengthBeforeSend = Math.max(0, this._history.length - 1)

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let stream
        try {
          stream = this._client.messages.stream(
            {
              model: this.model || this._defaultModel,
              max_tokens: DEFAULT_MAX_TOKENS,
              ...(systemPrompt ? { system: systemPrompt } : {}),
              // #4078: merge BUILTIN_TOOLS with live MCP tools at turn time.
              // fleet.anthropicTools filters DEAD servers, so a crashed-then-
              // restart-exhausted MCP server cleanly disappears from the next
              // turn without anything to invalidate.
              tools: this._buildTools(),
              messages: this._history,
            },
            { signal: this._abortController.signal },
          )
        } catch (err) {
          // Stream init threw synchronously. Rollback the ENTIRE turn —
          // the user prompt + every assistant/tool_result pair appended
          // by completed rounds. Truncating to the pre-send length is
          // simpler and stronger than the previous round-0-only pop:
          // the next sendMessage starts from a known-clean state with no
          // possibility of back-to-back user turns (#4109).
          if (this._history.length > historyLengthBeforeSend) {
            this._history.length = historyLengthBeforeSend
          }
          throw err
        }

        for await (const event of stream) {
          const t = translateSdkEvent(event)
          if (!t) continue
          switch (t.kind) {
            case 'stream_delta':
              this.emit('stream_delta', { messageId, delta: t.text })
              break
            case 'tool_start': {
              // Surface the tool_use opening to the dashboard so it can
              // render a tool-call bubble. Matches sdk-session.js /
              // cli-session.js shape — event-normalizer reads `tool`
              // and `input` (ServerToolStartSchema requires `tool` as a
              // non-null string). Pre-#4240 this emitted `toolName`,
              // which the normalizer silently dropped, so the dashboard
              // saw `tool: undefined` and rendered a generic bubble.
              // `input` is null here because the model streams the
              // tool's JSON input via subsequent input_json_delta
              // events; tool_input_delta carries the partials.
              //
              // #4262: Use the tool's content_block.id as the tool_start
              // messageId so each tool in a multi-tool turn has a distinct
              // id. Sharing the turn-level messageId across tools collides
              // with itself (store-core/handlers/handleToolStart uses
              // messageId as ChatMessage.id, so later tools overwrite
              // earlier ones in replay-dedupe) AND with the post-tool
              // stream_start id (#stream_id_collision class). Mirrors
              // sdk-session.js:635-641 / cli-session.js:708-714.
              // #4364: Mirror sdk-session.js:635-641 — reuse the
              // derived toolId for both fields so the wire schema
              // (`ServerToolStartSchema.toolUseId: z.string()`) holds
              // even on the defensive fallback path. Pre-#4364 this
              // emitted `toolUseId: undefined` when content_block.id
              // was absent; no observable runtime impact today (no
              // broadcast-side validator) but the schema is the
              // contract.
              const toolId = t.toolUseId || `${messageId}-tool`
              this.emit('tool_start', {
                messageId: toolId,
                toolUseId: toolId,
                tool: t.toolName,
                input: null,
              })
              // #4080: track index→toolUseId so the upcoming
              // tool_input_delta events (which only carry the index)
              // can be re-tagged with the toolUseId before re-emit.
              if (typeof t.index === 'number' && t.toolUseId) {
                this._streamingIndexToToolUseId.set(t.index, t.toolUseId)
              }
              break
            }
            case 'tool_input_delta': {
              // #4080: stream the partial JSON to the dashboard so the
              // tool-call bubble can live-preview the model's evolving
              // input (especially valuable for Bash, where users can
              // early-abort once they see a destructive `command`
              // forming). The translator only carries the block index;
              // resolve to toolUseId via the per-stream map we populated
              // on tool_start.
              const toolUseId = typeof t.index === 'number'
                ? this._streamingIndexToToolUseId.get(t.index)
                : undefined
              if (!toolUseId) {
                // Delta for a content block that wasn't a tool_use
                // (text deltas already went through stream_delta) or
                // for an index we never saw a start for (SDK reorder /
                // malformed event). Drop quietly — the accepted shape
                // for partial input is "may not arrive."
                break
              }
              if (this._pendingPermissionToolUseIds.has(toolUseId)) {
                // A permission prompt is pending for this exact
                // toolUseId — suppress the delta so the bubble doesn't
                // flicker between "running…" and partial-input while
                // the user is mid-decision. See constructor comment.
                break
              }
              this.emit('tool_input_delta', {
                messageId,
                toolUseId,
                partialJson: t.partial,
              })
              break
            }
            case 'content_block_stop':
              // #4080: free the per-index slot as soon as the block
              // finishes so a long turn's map doesn't grow unbounded.
              // Safe to delete even if index isn't in the map — that
              // just means we never tracked this block (text /
              // thinking) and the lookup is a no-op.
              if (typeof t.index === 'number') {
                this._streamingIndexToToolUseId.delete(t.index)
              }
              break
            case 'message_delta':
              if (t.stopReason) lastStopReason = t.stopReason
              // Don't accumulate from message_delta — it carries the
              // round's running totals that culminate in final.usage. We
              // accumulate exactly once per round below, after
              // finalMessage() resolves.
              break
            case 'unknown':
              log.warn(`unknown SDK event type=${t.sdkType} forwarded as no-op`)
              break
            default:
              break
          }
        }

        const final = await stream.finalMessage()
        // #4080: defensive cleanup. content_block_stop should have
        // drained every entry above, but if the stream ended on an
        // error path or the SDK ever skips the stop event for a
        // block, the map would leak across rounds and a later
        // tool_input_delta for index N could pick up a STALE
        // toolUseId from the previous round. Clear here so each round
        // starts with an empty per-stream map.
        this._streamingIndexToToolUseId.clear()
        lastStopReason = final.stop_reason
        const roundUsage = final.usage || {}
        turnUsage.input_tokens += Number(roundUsage.input_tokens) || 0
        turnUsage.output_tokens += Number(roundUsage.output_tokens) || 0
        turnUsage.cache_read_input_tokens += Number(roundUsage.cache_read_input_tokens) || 0
        turnUsage.cache_creation_input_tokens += Number(roundUsage.cache_creation_input_tokens) || 0
        turnCost += computePromptCostUsd(roundUsage, pricing)

        // Append the assistant turn — full content array preserves
        // tool_use blocks for the next round of conversation.
        this._history.push({ role: 'assistant', content: final.content })

        if (lastStopReason !== 'tool_use') {
          // Done — model wants no more tools. Break out and emit result.
          break
        }

        // Execute each tool_use block. Build a tool_result content array
        // to send back as the user message.
        //
        // #4061 history invariant: the Anthropic API rejects (400) any
        // assistant turn that contains tool_use blocks unless the
        // immediately-following user message has a tool_result for EVERY
        // tool_use id. If the user aborts mid-loop, we have to synthesize
        // tool_result blocks for the unexecuted remainder so the next
        // sendMessage doesn't 400 on a mismatched history.
        //
        // #4062: when the model emits multiple tool_use blocks in one
        // turn (parallel tool calls — common for 3 unrelated Reads), we
        // execute them concurrently to save wall-clock latency. Two
        // distinct phases:
        //
        //   1. PERMISSION GATE — strictly sequential. The user can't
        //      answer N prompts simultaneously on the phone, and the
        //      dashboard's permission_request handler assumes one prompt
        //      at a time. Auto-allow / session-rule decisions resolve
        //      synchronously, so this phase is effectively free when no
        //      real prompt fires.
        //
        //   2. EXECUTION — fanned out via Promise.all on every approved
        //      block. Denied blocks short-circuit to a synthetic
        //      tool_result. Order is preserved by index so the API sees
        //      tool_results in the same order as the tool_uses.
        //
        // Abort handling: if the signal trips DURING the gate phase, we
        // stop gating and the unscheduled remainder gets a synthetic
        // 'Interrupted' tool_result (same #4061 invariant). If it trips
        // mid-execution, the shared AbortSignal propagates to
        // executeBuiltinTool and any in-flight tool aborts cleanly.
        const toolBlocks = (final.content || []).filter((b) => b?.type === 'tool_use')
        const toolResults = await this._processToolBlocks({ toolBlocks, messageId })
        if (toolResults.length === 0) {
          // stop_reason was tool_use but no tool_use blocks — defensive
          // bailout to avoid an empty user message that the SDK rejects.
          log.warn(`stop_reason=tool_use but no tool_use blocks in final.content; ending turn`)
          break
        }
        this._history.push({ role: 'user', content: toolResults })

        if (this._abortController?.signal?.aborted) break

        if (round === MAX_TOOL_ROUNDS - 1) {
          // #4063: instead of bailing silently, run ONE more text-only
          // stream so the model can summarise what it accomplished and the
          // user sees a closing message instead of an apparent hang. To
          // preserve the strict user/assistant alternation invariant
          // (#4109/#4118), we EMBED the summary instruction as an extra
          // content block on the existing tool_result user turn rather
          // than pushing a second user turn back-to-back.
          log.warn(`hit MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} cap; running summary round`)

          // Emit a non-fatal error so the dashboard can render a warning
          // banner. The session stays alive — the user can keep talking;
          // it's not a STREAM_ERROR / ABORT.
          this.emit('error', {
            messageId,
            code: 'MAX_TOOL_ROUNDS_REACHED',
            message: `Tool round cap reached (${MAX_TOOL_ROUNDS}). Asked the model to summarise what it accomplished so far.`,
            fatal: false,
          })

          // Append the instruction as a text block on the last user turn
          // (the one we just pushed at line ~432 with tool_results).
          const summaryInstruction = {
            type: 'text',
            text: `Tool budget exhausted (${MAX_TOOL_ROUNDS} rounds). Please summarise what you accomplished so far. Do not call any more tools.`,
          }
          const lastTurn = this._history[this._history.length - 1]
          if (lastTurn?.role === 'user' && Array.isArray(lastTurn.content)) {
            lastTurn.content.push(summaryInstruction)
          } else {
            // Defensive fallback — should never hit given the immediately-
            // prior push at line ~432, but if invariants change later
            // we'd rather log and bail than corrupt history.
            log.warn(`MAX_TOOL_ROUNDS cap-hit: last turn is not a user tool_result turn; skipping summary`)
            break
          }

          let summaryStream
          try {
            summaryStream = this._client.messages.stream(
              {
                model: this.model || this._defaultModel,
                max_tokens: DEFAULT_MAX_TOKENS,
                ...(systemPrompt ? { system: systemPrompt } : {}),
                // No tools — force a text-only summary. Even if the model
                // tried to tool_use, the API would reject (no tools to
                // dispatch to). Cleaner to just omit.
                messages: this._history,
              },
              { signal: this._abortController.signal },
            )
          } catch (err) {
            // Stream-init threw synchronously. Pop the instruction we
            // just appended so the user turn returns to pure tool_results
            // — invariant preserved.
            const popped = lastTurn.content.pop()
            if (popped !== summaryInstruction) {
              log.warn(`MAX_TOOL_ROUNDS rollback: popped content block was not the summary instruction`)
            }
            log.warn(`MAX_TOOL_ROUNDS summary stream-init failed: ${err?.message}`)
            break
          }

          // Async failures inside the for-await or finalMessage() rethrow
          // and propagate to the outer catch, which truncates _history to
          // historyLengthBeforeSend — rolling back the entire turn
          // (consistent with #4109/#4118). The user has already seen
          // emitted tool_result events; only the history-persisted state
          // resets.
          for await (const event of summaryStream) {
            const t = translateSdkEvent(event)
            if (!t) continue
            switch (t.kind) {
              case 'stream_delta':
                this.emit('stream_delta', { messageId, delta: t.text })
                break
              case 'message_delta':
                if (t.stopReason) lastStopReason = t.stopReason
                break
              default:
                break
            }
          }

          const summaryFinal = await summaryStream.finalMessage()
          lastStopReason = summaryFinal.stop_reason
          const sUsage = summaryFinal.usage || {}
          turnUsage.input_tokens += Number(sUsage.input_tokens) || 0
          turnUsage.output_tokens += Number(sUsage.output_tokens) || 0
          turnUsage.cache_read_input_tokens += Number(sUsage.cache_read_input_tokens) || 0
          turnUsage.cache_creation_input_tokens += Number(sUsage.cache_creation_input_tokens) || 0
          turnCost += computePromptCostUsd(sUsage, pricing)
          this._history.push({ role: 'assistant', content: summaryFinal.content })
          break
        }
      }

      this.emit('stream_end', { messageId })
      this.emit('result', {
        sessionId: null,
        messageId,
        stopReason: lastStopReason,
        duration: Date.now() - turnStartedAt,
        usage: turnUsage,
        cost: turnCost,
      })
    } catch (err) {
      // #4118: extend the synchronous stream-init rollback (#4109) to
      // ANY error that bubbles to the outer catch at round 1+ — the
      // for-await loop rejecting mid-iteration, finalMessage() rejecting,
      // a tool-execution promise rejecting after at least one round has
      // committed assistant + user tool_result to _history. Without this,
      // history ends on a `user` tool_result turn and the next
      // sendMessage pushes a plain-text `user` turn back-to-back —
      // soft-breaking the alternation invariant the API may tighten on.
      //
      // The synthetic-tool_result completion path (#4061, when the user
      // aborts mid-tool-loop) intentionally COMMITS the user turn so
      // the next turn doesn't 400. That path emits a 'result' event
      // before reaching this catch and never throws, so it's not
      // affected here. We only catch real errors.
      //
      // Truncating to historyLengthBeforeSend is idempotent: if the
      // inner stream-init catch already truncated (round-0 path), the
      // length is already at or below the snapshot and this is a no-op.
      if (this._history.length > historyLengthBeforeSend) {
        this._history.length = historyLengthBeforeSend
      }
      this.emit('stream_end', { messageId })
      this._emitTurnError(messageId, err, 'STREAM_ERROR')
    } finally {
      // #4080: per-turn isolation guarantee. The per-round clear after
      // finalMessage() above runs on the success path; an iteration or
      // finalMessage() throw skips it and would leak stale
      // index→toolUseId entries into the next turn (mis-tagging the
      // next stream's tool_input_delta events). Clearing here drains
      // them on every exit path — success, error, abort, hard timeout.
      // Safe to call when already empty.
      this._streamingIndexToToolUseId.clear()
      this._finishTurn()
    }
  }

  /**
   * Orchestrate one round's tool_use blocks (#4062).
   *
   * Phase 1: Gate ALL blocks sequentially in source order so the
   *   permission prompts surface one-at-a-time (UX guarantee — the user
   *   can only answer one prompt at a time on the phone).
   * Phase 2: Execute approved blocks in parallel via Promise.all to
   *   collapse wall-clock latency on multi-Read turns.
   *
   * Preserves the #4061 history invariant: returns a tool_result content
   * block for EVERY tool_use, in the same order. Aborts during gating
   * synthesise 'Interrupted' tool_results for the unscheduled remainder.
   */
  async _processToolBlocks({ toolBlocks, messageId }) {
    const signal = this._abortController?.signal
    // Pre-allocate result slots so we can write by index from parallel
    // executions while preserving model-emit order in the final array.
    const toolResults = new Array(toolBlocks.length)
    const gateDecisions = new Array(toolBlocks.length)
    let firstUngatedIndex = toolBlocks.length

    // Synthetic-fill helper (#4108, #4247). Used both for the mid-gate
    // remainder (blocks that never entered the gate) AND the
    // inter-phase race (every block was gated, but the signal tripped
    // before phase 2 schedules — without this guard, write-side tools
    // that ignore the signal would execute AFTER the user pressed Stop).
    const fillInterrupted = (startIndex) => {
      const interrupted = 'Interrupted by user before execution'
      for (let j = startIndex; j < toolBlocks.length; j++) {
        // Skip slots that already carry a real result (defensive — the
        // inter-phase guard fires when startIndex === 0, but only the
        // blocks that *would* have executed in phase 2 need filling).
        if (toolResults[j]) continue
        const remaining = toolBlocks[j]
        this.emit('tool_result', {
          messageId,
          toolUseId: remaining.id,
          result: interrupted,
          isError: true,
        })
        toolResults[j] = {
          type: 'tool_result',
          tool_use_id: remaining.id,
          content: interrupted,
          is_error: true,
        }
      }
    }

    // PHASE 1 — sequential permission gating.
    for (let i = 0; i < toolBlocks.length; i++) {
      if (signal?.aborted) {
        firstUngatedIndex = i
        break
      }
      gateDecisions[i] = await this._gateToolBlock({
        block: toolBlocks[i],
        messageId,
      })
    }

    // Mid-gate abort: fill synthetic 'Interrupted' tool_results for the
    // unscheduled remainder (#4108). The early-aborted blocks never
    // emitted a tool_start (we didn't even get to the executor), but
    // the SDK already emitted tool_start when streaming the assistant
    // turn — so the bubble would hang in 'running…' without a closing
    // tool_result event.
    if (firstUngatedIndex < toolBlocks.length) {
      fillInterrupted(firstUngatedIndex)
    }

    // Inter-phase race guard (#4247): if the signal tripped while the
    // last gate was awaiting — or any time after phase 1's loop check
    // and before phase 2 schedules — short-circuit the remainder into
    // synthetic-fills rather than launching write-side tools (Read,
    // Write, Edit, TodoWrite) that don't honour the signal and would
    // run to completion AFTER the user pressed Stop. Pre-fix, the
    // sequential-loop's bottom-of-iteration check caught this; the
    // parallel refactor (#4062) opened a window between phase 1 and
    // phase 2 where the abort could go unobserved.
    //
    // Only applies when phase 1 completed fully (every block was
    // successfully gated). The mid-gate path above already handled
    // the partial-gate case and must keep block N's execution — its
    // gate ran BEFORE the abort tripped, so the user's permission
    // answer would be wasted if we re-synthesized it here.
    if (signal?.aborted && firstUngatedIndex === toolBlocks.length) {
      fillInterrupted(0)
      firstUngatedIndex = 0
    }

    // PHASE 2 — parallel execution of every successfully-gated block.
    // Promise.all preserves array order, but we write by index to
    // double-guard against any future reordering refactor.
    const executions = []
    for (let i = 0; i < firstUngatedIndex; i++) {
      const block = toolBlocks[i]
      const decision = gateDecisions[i]
      executions.push(
        this._executeToolBlock({ block, messageId, decision }).then(
          (result) => { toolResults[i] = result },
        ),
      )
    }
    await Promise.all(executions)

    return toolResults
  }

  /**
   * Resolve the permission decision for a single tool_use block. Split
   * out from _executeToolBlock so the orchestrator can serialize gating
   * across all blocks in a turn before fanning out execution (#4062).
   *
   * Returns the PermissionManager decision shape directly, or a synthetic
   * deny-shaped object if the gate itself rejected (timeout/abort). The
   * caller distinguishes by checking `decision.behavior !== 'allow'`.
   */
  async _gateToolBlock({ block, messageId }) {
    // messageId is currently unused here, but kept in the signature so
    // future telemetry (e.g. emitting a permission_pending event tied to
    // the round) can hook in without changing every call site.
    void messageId
    const toolUseId = block.id
    const toolName = block.name
    const input = block.input || {}
    const signal = this._abortController?.signal
    // #4080: track that this toolUseId has a pending permission prompt
    // so any tool_input_delta for the SAME toolUseId (e.g. a future
    // mid-stream gate, or a re-streamed input in a later round) is
    // suppressed until the prompt resolves. PermissionManager keys
    // its own pending map by requestId, not toolUseId, so the
    // tracking has to live here. Wrap the whole permission gate so
    // both the allow-and-deny paths drain.
    this._pendingPermissionToolUseIds.add(toolUseId)
    try {
      return await this._permissions.handlePermission(
        toolName,
        input,
        signal,
        this.permissionMode,
      )
    } catch (err) {
      // permission_request was rejected (timeout, abort, etc.). Surface
      // as a deny so the executor short-circuits to a tool_result.
      return {
        behavior: 'deny',
        message: `Permission gate error: ${err?.message || String(err)}`,
      }
    } finally {
      this._pendingPermissionToolUseIds.delete(toolUseId)
    }
  }

  /**
   * Run one tool_use block: permission gate, dispatch to executor, emit
   * tool_result events, return the {type:'tool_result', ...} content
   * block to append to the next user message.
   *
   * #4062: When called from the orchestrator, a pre-resolved `decision`
   * is supplied so we skip the gate (it already ran sequentially in
   * _processToolBlocks). When called directly (legacy callers and tests
   * that stub the seam) the gate runs inline — preserves backwards
   * compatibility with the original single-phase contract.
   */
  async _executeToolBlock({ block, messageId, decision }) {
    const toolUseId = block.id
    const toolName = block.name
    const input = block.input || {}
    const signal = this._abortController?.signal

    // Permission gate. PermissionManager handles all four modes
    // (approve / auto / acceptEdits / plan) and session rules. The
    // _pendingPermissionToolUseIds tracking (#4080) lives inside
    // _gateToolBlock so it covers both the orchestrator (#4062) path
    // and the legacy inline-gate path used by direct callers/tests.
    let resolvedDecision = decision
    if (!resolvedDecision) {
      resolvedDecision = await this._gateToolBlock({ block, messageId })
    }

    if (resolvedDecision.behavior !== 'allow') {
      const msg = resolvedDecision.message || 'Permission denied by user.'
      this.emit('tool_result', {
        messageId,
        toolUseId,
        result: msg,
        isError: true,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: msg,
        is_error: true,
      }
    }

    // Execute locally. MCP tools (mcp__<server>__<tool>) route through
    // the fleet to the right child process via stdio JSON-RPC; everything
    // else runs in-process (Read/Write/Bash/etc).
    const effectiveInput = resolvedDecision.updatedInput || input
    const { content, isError } = toolName.startsWith(MCP_TOOL_PREFIX)
      ? await this._dispatchMcpTool(toolName, effectiveInput)
      : await executeBuiltinTool({
          toolName,
          input: effectiveInput,
          cwd: this.cwd,
          cwdRealCache: this._cwdRealCache,
          cwdCacheTtl: CWD_CACHE_TTL_MS,
          signal,
          todoStore: this._todos,
        })

    this.emit('tool_result', {
      messageId,
      toolUseId,
      result: content,
      isError,
    })

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      is_error: isError,
    }
  }

  /**
   * Dispatch one MCP tool_use to the fleet. Flattens `{ content: [...],
   * isError }` from the MCP server into the `{ content: string, isError }`
   * shape `_executeToolBlock` returns. Concatenates any text blocks; for
   * non-text blocks (image, resource) we stringify the block so the model
   * sees the shape and can decide what to do — chroxy itself doesn't
   * interpret them.
   *
   * Errors (server unknown, server dead, RPC error, timeout, child crash
   * mid-call) become is_error:true tool_results — same shape as
   * executeBuiltinTool's catch-all. The session keeps running.
   */
  async _dispatchMcpTool(toolName, input) {
    try {
      // #4482: pass undefined when the operator didn't set a timeout so
      // MCPFleet.callTool's destructured default (DEFAULT_TOOL_CALL_TIMEOUT_MS)
      // fires — duplicating the constant here would silently desync if
      // MCPClient ever retunes its 30s default.
      const result = await this._mcpFleet.callTool(toolName, input, this._mcpToolCallTimeoutMs ?? undefined)
      const blocks = Array.isArray(result?.content) ? result.content : []
      const text = blocks
        .map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b)))
        .join('\n')
      return { content: text, isError: result?.isError === true }
    } catch (err) {
      return { content: `MCP ${toolName} failed: ${err?.message || String(err)}`, isError: true }
    }
  }

  /**
   * In-process permission response — called by ws-permissions.js when the
   * user taps Approve/Deny on the phone or dashboard. Forwards to
   * PermissionManager which resolves the pending Promise in
   * handlePermission() above.
   */
  respondToPermission(requestId, decision) {
    return this._permissions.respondToPermission(requestId, decision)
  }

  /**
   * Response to an AskUserQuestion tool. Same forwarding pattern.
   */
  respondToQuestion(text, answersMap) {
    this._permissions.respondToQuestion(text, answersMap)
  }

  /**
   * Session-scoped permission rules (the dashboard's "Allow for Session"
   * affordance, #3072). Optional method — providers.js's capability check
   * uses presence to advertise sessionRules: true.
   */
  setPermissionRules(rules) {
    if (typeof this._permissions.setRules === 'function') {
      this._permissions.setRules(rules)
    }
  }

  _emitTurnError(messageId, err, fallbackCode) {
    // #4057: SDK v0.81+ throws `APIUserAbortError` (not the generic
    // `AbortError`) when an in-flight messages.stream sees its signal
    // aborted. Primary check is `instanceof` — the SDK class itself
    // never sets `.name`, so a name-string check would fail
    // (instance.name === 'Error', verified at runtime). Keep the
    // legacy `name === 'AbortError'` fallback for raw fetch aborts
    // (the SDK's own internal abort helper uses this convention). The
    // signal.aborted fallback catches paths where the SDK swallowed
    // the original error and re-threw something we don't recognise.
    const aborted =
      err instanceof APIUserAbortError ||
      err?.name === 'AbortError' ||
      this._abortController?.signal?.aborted
    if (aborted) {
      this.emit('error', {
        messageId,
        message: 'Interrupted by user',
        code: 'ABORT',
      })
      return
    }
    const code = err?.status ? `HTTP_${err.status}` : (err?.code || fallbackCode)
    const message = err?.message || String(err)
    this.emit('error', { messageId, message, code })
  }

  _finishTurn() {
    this._isBusy = false
    this._currentMessageId = null
    this._abortController = null
  }

  interrupt() {
    if (!this._isBusy) return
    if (this._abortController) {
      this._abortController.abort()
    }
  }

  setModel(model) {
    super.setModel(model)
    // Next sendMessage will use the new model. No restart needed — the
    // SDK is just a stateless HTTP client; each turn opens a fresh stream.
  }

  setPermissionMode(mode) {
    if (!super.setPermissionMode(mode)) return
    // #3729 / #4462: flipping to auto/bypass mid-turn must drain any
    // open permission prompts so the user isn't left staring at modals
    // after declaring "approve everything". Mirrors sdk-session.js's
    // setPermissionMode behaviour.
    //
    // MCP trust prompts are exempt — autoAllowPending denies them so
    // the bypass doesn't silently persist a binary to the trust store
    // (a panic-button shouldn't grant forever-trust). See
    // permission-manager.js:autoAllowPending and the byok-mcp-trust
    // recordTrust path.
    if (mode === 'auto') {
      this._permissions.autoAllowPending()
    }
  }

  // #4078: assemble the per-turn tools array. BUILTIN_TOOLS first
  // (Read/Write/Edit/Bash/Glob/Grep) then any live MCP tools surfaced by
  // the fleet, namespaced as mcp__<server>__<tool>. Re-evaluated every
  // turn rather than cached because the cost is trivial and the fleet's
  // READY-state filter is the source of truth for which servers are
  // contributing right now.
  _buildTools() {
    if (!this._mcpFleet) return BUILTIN_TOOLS
    const mcp = this._mcpFleet.anthropicTools
    return mcp.length === 0 ? BUILTIN_TOOLS : [...BUILTIN_TOOLS, ...mcp]
  }

  async destroy() {
    if (this._destroying) return
    this._destroying = true
    this.interrupt()
    // Mirror sdk-session.js:1272-1300 teardown: PermissionManager owns
    // its own destroy (which calls clearAll() and any internal timer
    // cleanup), and removeAllListeners drops every EventEmitter
    // subscription we registered on this session. Without these the
    // process leaks listeners + timers per session destroyed.
    try {
      this._permissions?.destroy()
    } catch (err) {
      log.warn(`PermissionManager teardown failed: ${err.message}`)
    }
    this._history = []
    this._todos.clear()
    // #4153: consistency with the existing _history/_todos teardown so
    // every in-memory collection on this session is reset at destroy.
    // Neither is a leak risk (both are bounded + small) — but if anything
    // outside the session retains a reference (debugger, future export
    // feature, tests that capture the instance) these collections would
    // otherwise outlive the session.
    this._cwdRealCache.clear()
    this._pricingWarnedModels.clear()
    // #4080: same-rationale teardown — both maps are bounded by the
    // active stream / outstanding permission count, but any external
    // reference (test capture, future export) would keep them alive.
    this._streamingIndexToToolUseId.clear()
    this._pendingPermissionToolUseIds.clear()
    this._client = null
    // #4077: tear down MCP children with SIGTERM → SIGKILL grace.
    // Awaits up to FLEET_KILL_GRACE_MS (2s) + 500ms safety margin so a
    // hung child cannot stall destroy() indefinitely.
    if (this._mcpFleet) {
      const fleet = this._mcpFleet
      this._mcpFleet = null
      try { await fleet.destroy() } catch (err) {
        log.warn(`MCP fleet teardown failed: ${err?.message || err}`)
      }
    }
    this.removeAllListeners()
  }
}
