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
import { performance } from 'node:perf_hooks'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { synthesizeModelUsage } from './usage-normalize.js'
import { PermissionManager, wirePermissionManager } from './permission-manager.js'
import { createLogger } from './logger.js'
import { isOperatorTimeoutInRange } from './duration.js'
import {
  ALLOWED_MODEL_IDS,
  getModelPricing,
  computePromptCostUsd,
} from './models.js'
import { CLAUDE_FALLBACK_MODELS, claudeModelMetadata } from './claude-model-catalog.js'
import { resolveAnthropicApiKey, maskApiKey } from './byok-credentials.js'
import { BILLING_CLASSES } from './billing-class.js'
import { translateSdkEvent } from './byok-event-translator.js'
import { BUILTIN_TOOLS, TASK_PERMISSION_MODE_LIST, TASK_PERMISSION_MODE_RANK } from './byok-tools.js'
import { executeBuiltinTool } from './byok-tool-executor.js'
import { loadClaudeMcpConfig, toMcpServerMetadata } from './byok-mcp-config.js'
import { MCPFleet, MCP_TOOL_PREFIX, parseMcpToolName } from './byok-mcp-fleet.js'
import { getSubagentProfile, SUBAGENT_PROFILE_NAMES } from './byok-subagent-profiles.js'

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

// #6845: display cap for the server-controlled MCP-prompt expansion surfaced
// in the transcript (the honesty marker). The FULL resolved text still goes to
// the model as the user turn — only the copy shown in the transcript is capped
// so a huge `prompts/get` response can't flood the chat. event-normalizer.js
// re-bounds at the wire boundary and store-core re-bounds again (defense in
// depth), mirroring the #6768 compact_boundary bounding chain.
const MCP_PROMPT_EXPANSION_DISPLAY_CAP = 4000

// Bound an MCP-prompt expansion to the display cap, appending a truncation
// marker when it overflows. Returns the (possibly truncated) text plus a
// `truncated` flag so the renderer can badge it.
function boundMcpPromptExpansionText(text, cap = MCP_PROMPT_EXPANSION_DISPLAY_CAP) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (s.length <= cap) return { text: s, truncated: false }
  return { text: `${s.slice(0, cap)}\n…(truncated)`, truncated: true }
}

export class ClaudeByokSession extends BaseSession {
  // #5858: Claude-family flag — single source of truth for isClaudeProvider().
  // DockerByokSession (docker-byok) extends this and correctly inherits it.
  // NOTE: non-Claude providers that ALSO extend this for the agent loop
  // (DeepSeekSession, OllamaSession, AnthropicCompatibleSession) MUST override
  // `static claudeFamily = false` — their model ids validate strictly.
  static claudeFamily = true

  static get displayLabel() {
    return 'Claude (API key — BYOK)'
  }

  /**
   * #6769: build the end-of-turn context-window OCCUPANCY snapshot from the
   * FINAL agent-loop round's individual usage.
   *
   * That round's `input_tokens + cache_read_input_tokens +
   * cache_creation_input_tokens` is exactly the prompt the API was last sent
   * — i.e. the conversation's current size — so it is a true occupancy
   * snapshot. The summed `turnUsage` billing aggregate is NOT (it re-counts
   * the history once per round; a 5-round turn over-reads ≈5× — the #6816
   * review finding). Output tokens are deliberately excluded (the coordinator
   * contract pins the snapshot to the prompt side; the next turn's snapshot
   * absorbs the reply), as is subagent usage (a child Task runs in its own
   * separate window).
   *
   * Returns null when the turn produced no usable round usage (error before
   * the first finalMessage(), or an endpoint that reports no usage — e.g. an
   * anthropic-compatible server that omits the field). The result then emits
   * WITHOUT `contextOccupancy` and clients keep their previous snapshot / dash.
   *
   * Static + pure so tests can pin the arithmetic without a live session;
   * subclasses that reuse the agent loop (docker-byok, deepseek, ollama,
   * anthropic-compatible) inherit it — wherever their endpoint reports real
   * per-round usage, the snapshot is equally honest.
   *
   * @param {object|null} roundUsage — the final round's `final.usage`
   * @returns {{totalTokens: number, source: 'final-round-prompt'}|null}
   */
  static _buildFinalRoundOccupancy(roundUsage) {
    if (!roundUsage || typeof roundUsage !== 'object') return null
    const totalTokens =
      (Number(roundUsage.input_tokens) || 0) +
      (Number(roundUsage.cache_read_input_tokens) || 0) +
      (Number(roundUsage.cache_creation_input_tokens) || 0)
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null
    return { totalTokens, source: 'final-round-prompt' }
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
      // #6888: BYOK shares SdkSession's PermissionManager/respondToPermission
      // path — see the matching comment in sdk-session.js's capabilities. A
      // deny reason genuinely reaches the agent as the tool's denial message.
      denyReason: true,
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
    //
    // #4049: agent_spawned / agent_completed are part of the built-in
    // transient set in session-manager.js (so they already flow without
    // being listed), but pin them here so the capability matrix /
    // dashboard introspection reflect that this provider emits them
    // when the Task tool dispatches a subagent.
    //
    // #5016: `agent_event` carries the child Task subagent's intermediate
    // wire events (tool_start / tool_input_delta / tool_result /
    // stream_delta) tagged with the parent `toolUseId` so the dashboard
    // can render the child's progress as nested sub-bubbles under the
    // parent's Task tool_call. The child's `result` is intentionally NOT
    // forwarded — usage/cost folds into the parent's per-turn
    // accumulator and the final summary text becomes the parent's
    // Task tool_result content; replaying it as a nested event would
    // double-render the same content.
    return ['tool_start', 'tool_result', 'tool_input_delta', 'agent_spawned', 'agent_completed', 'agent_event']
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

  /**
   * Resolve runtime auth state for the dashboard (#4769).
   *
   * BYOK checks ANTHROPIC_API_KEY env AND the ~/.chroxy/credentials.json
   * file (mode 0600 enforced by the resolver). Both paths surface as
   * source: 'env' because the dashboard's SettingsPanel tone legend only
   * knows about 'oauth'|'env'|'missing'|'none' (SettingsPanel.tsx:316-320);
   * the `detail` string disambiguates which path supplied the key.
   *
   * @param {NodeJS.ProcessEnv} env
   * @param {{ cachedResolveCredentialFile: Function }} helpers
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth(env, helpers) {
    const credSpec = this.preflight.credentials
    const envVars = credSpec.envVars
    const hint = credSpec.hint || `set ${envVars.join(' or ')}`
    const resolved = helpers.cachedResolveCredentialFile(
      'byok',
      env.ANTHROPIC_API_KEY,
      resolveAnthropicApiKey,
    )
    if (resolved.key) {
      return {
        ready: true,
        source: 'env',
        envVar: resolved.source === 'env' ? 'ANTHROPIC_API_KEY' : null,
        envVars,
        hint: '',
        detail: `Anthropic API (${resolved.source === 'env' ? 'ANTHROPIC_API_KEY set' : '~/.chroxy/credentials.json'} — per-token billing)`,
        // BYOK is always your own key, per-token — api-key in both eras
        // (#5629 leaves this UNCHANGED).
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint,
      detail: `Anthropic API (${resolved.reason})`,
      billingClass: BILLING_CLASSES.API_KEY,
    }
  }

  static getFallbackModels() {
    return CLAUDE_FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  /**
   * Model registry hook. BYOK accepts any Anthropic model id the API
   * accepts; reuse claude-* metadata since the ids are the same shape.
   * Delegates to the shared claudeModelMetadata() helper (#6201 OCP).
   */
  static getModelMetadata(modelId) {
    return claudeModelMetadata(modelId)
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.cwd]            Working directory for tool execution.
   * @param {string} [opts.model]          Anthropic model id; falls back to `claude-opus-4-8`.
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
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-byok' }))
    // Anthropic SDK client; lazily instantiated in start() so unit tests
    // can stub it via this._client = ... before start().
    this._client = null
    // In-memory conversation history. Each entry is a Claude API message
    // ({ role: 'user'|'assistant', content: <string|array> }). The SDK
    // accepts either shape for user/assistant turns.
    this._history = []
    // AbortController for the active stream so interrupt() can cancel.
    this._abortController = null

    // PermissionManager + event re-emission via the shared wiring (P2-9) so the
    // dashboard / mobile permission UI and the audit log work uniformly across
    // providers. ByokSession passes no pause/resume hooks (no result-timeout).
    // #6794 — pass cwd so the protected-path floor can resolve relative tool
    // targets (.git/.claude/.env…) against this session's working directory.
    // #6771 — pass the durable rule store (persistent per-project allow-always).
    this._permissions = new PermissionManager({ log, cwd: this.cwd, ruleStore: this._permissionRuleStore })
    wirePermissionManager(this, this._permissions)

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

    // #6756: per-stream index → thinking messageId, mirroring the toolUseId map
    // above. The translated `thinking_delta` events carry only the block index;
    // this maps each thinking block's index to the distinct thinking id we open
    // on its first delta so subsequent deltas + the content_block_stop route
    // correctly. Cleared alongside `_streamingIndexToToolUseId`.
    this._streamingIndexToThinkingId = new Map()

    // #6391 (chat-redesign footer-stat): thinking messageId → performance.now()
    // when the reasoning block opened, so its content_block_stop can stamp the
    // elapsed `thinkingDurationMs` on the thinking stream_end. Cleared alongside
    // `_streamingIndexToThinkingId`. #6943: monotonic clock (perf_hooks), not
    // Date.now() — wall-clock jumps (NTP step, manual change, DST) would
    // otherwise clamp a backward jump to 0 or inflate a forward jump.
    this._thinkingStartMs = new Map()

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

    // #4049: active subagent sessions spawned by the Task tool, keyed by
    // toolUseId. interrupt() iterates this map to cascade the abort
    // signal to every child; destroy() does the same to tear down each
    // child's resources (PermissionManager, listeners, MCP fleet) so a
    // long-running parent with many delegated tasks doesn't leak state.
    // Each subagent is itself a full ClaudeByokSession and owns its own
    // _subagentSessions map — nested Task → Task is naturally supported.
    this._subagentSessions = new Map()

    // #5056: routing table for subagent permission responses. When a Task
    // subagent fires a permission_request (e.g. an MCP tool under approve
    // mode), the pending entry lives in the CHILD's PermissionManager —
    // not the parent's. The dashboard, however, only knows the parent
    // session id (ws-permissions resolves against the parent), so a tap
    // Approve/Deny lands on `parent.respondToPermission(requestId, ...)`.
    // This map records `childRequestId -> childSession` while the prompt
    // is outstanding so the parent can forward the response to the child
    // whose PermissionManager actually holds it. Entries are added when
    // the child's permission_request is relayed upward and removed on
    // permission_resolved (or when the child is torn down), so a stale
    // requestId can never resolve past its lifetime.
    this._subagentPermissionRouting = new Map()

    // #4049: per-turn accumulators for subagent (Task tool) usage + cost.
    // Folded into the parent's result.usage / result.cost just before
    // the result event fires so cost attribution stays on the user-
    // facing session (acceptance criteria: "child tokens attributed to
    // the parent session"). Reset in _finishTurn() on every exit path
    // — success, error, abort — so a stale parent's totals can never
    // leak into a future turn.
    this._subagentUsageThisTurn = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    this._subagentCostThisTurn = 0

    // #5018: per-session built-in tool allowlist. Set by _executeTaskTool
    // ONLY on child sessions spawned with a `subagent_type` profile that
    // carries a restricted `toolSet`. When null (the default / unrestricted
    // case), `_buildTools()` short-circuits the filter so non-subagent
    // sessions and general-purpose subagents pay no observable cost.
    this._allowedBuiltinToolNames = null

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
    // #6824: per-session set of parked (disabled) MCP server names. Seeded from
    // the persisted `disabledMcpServers` opt (session-manager forwards the
    // restored set), filtered to names actually present in this session's
    // config so a stale entry can't wedge. Threaded into the MCPFleet at
    // start() (parked servers get no client) and round-tripped back to session
    // state via `getDisabledMcpServers()`. Byok-local opt — read straight off
    // `opts`, not a BaseSession key.
    const configuredMcpNames = new Set(mcpConfig.servers.map((s) => s.name))
    this._disabledMcpServers = new Set(
      (Array.isArray(opts.disabledMcpServers) ? opts.disabledMcpServers : [])
        .filter((name) => typeof name === 'string' && configuredMcpNames.has(name)),
    )
    // #4077: MCPFleet is lazy — created in start() only if servers exist.
    // Held here so destroy() can tear down even if start() never ran.
    this._mcpFleet = null
    // #5019: when a Task subagent borrows the parent's MCP fleet (the
    // default behaviour for nested tool use — avoids per-spawn MCP
    // child-process startup cost), it points _mcpFleet at the parent's
    // already-running fleet and flips this flag to false. destroy() then
    // skips fleet.destroy() so the parent's MCP children aren't killed
    // when the subagent finishes. The parent always owns its own fleet.
    this._ownsMcpFleet = true
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
    return 'claude-opus-4-8'
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
        // Use the subclass's preflight label (or provider id) so the
        // toast / error feed names the right provider. Pre-#4656 this
        // was hardcoded "BYOK" — DeepSeek would inherit the misleading
        // "BYOK credentials not found" string. Keep "BYOK" as the last
        // resort in case a subclass declares neither preflight nor
        // provider.
        const label = this.constructor.preflight?.label || this._provider || 'BYOK'
        this.emit('error', { message: `${label} credentials not found — ${resolved.reason}` })
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
      // #6824: seed the fleet with the persisted parked set so a respawn skips
      // starting servers the operator disabled before the restart.
      fleetOpts.disabledServers = [...this._disabledMcpServers]
      this._mcpFleet = new MCPFleet(this._mcpServerConfigs, fleetOpts)
      await this._mcpFleet.start()
    }

    this._processReady = true
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })
    // #6824: BYOK is the authoritative MCP lane — publish the live server list
    // (with per-server enabled/canToggle) so the dashboard/mobile MCP views can
    // render the enable/disable toggle. sdk/cli parse their list off the live
    // stream; the BYOK fleet is in-daemon, so we emit it here after start().
    this._emitMcpServers()
  }

  /**
   * #6824: build the `mcp_servers` broadcast payload — one entry per configured
   * server with `{ name, status, enabled, canToggle: true }`. When the fleet
   * exists (the normal post-start case) its `getServerStatuses()` is
   * authoritative (live states + parked servers). Before start() / when the
   * fleet never spun up, fall back to the static config list so the payload is
   * still coherent (parked → 'disabled', otherwise 'configured').
   */
  _buildMcpServersPayload() {
    if (this._mcpFleet) return this._mcpFleet.getServerStatuses()
    return this._mcpServerConfigs.map((cfg) => {
      const disabled = this._disabledMcpServers.has(cfg.name)
      return {
        name: cfg.name,
        status: disabled ? 'disabled' : 'configured',
        enabled: !disabled,
        canToggle: true,
      }
    })
  }

  /**
   * #6824: emit the current MCP server list to all subscribers. Best-effort —
   * a throwing listener must not escape the ready / toggle paths this is called
   * from (mirrors claude-tui-session `_emitConfiguredMcpServers`). No servers
   * configured → nothing to publish.
   */
  _emitMcpServers() {
    if (this._mcpServerConfigs.length === 0) return
    try {
      this.emit('mcp_servers', { servers: this._buildMcpServersPayload() })
    } catch (err) {
      log.warn(`BYOK MCP: mcp_servers emit failed: ${err?.message || err}`)
    }
  }

  /**
   * #6824: enable or disable a single configured MCP server for this session.
   * Delegates the park/unpark to the fleet (destroy-and-forget vs
   * rebuild-through-trust-gate), updates the persisted parked set, and
   * re-emits `mcp_servers` so every connected client converges. Returns
   * `{ found, changed, status }` — `found: false` when `name` is not a
   * configured server so the WS handler can surface a clean error.
   */
  async setMcpServerEnabled(name, enabled) {
    if (typeof name !== 'string' || !this._mcpServerConfigs.some((c) => c.name === name)) {
      return { found: false, changed: false, status: null }
    }
    let result
    if (this._mcpFleet) {
      result = await this._mcpFleet.setEnabled(name, enabled)
      // Sync the persisted set from the fleet's AUTHORITATIVE one rather than
      // applying the requested state — the fleet's in-flight churn latch can
      // legitimately ignore this toggle (changed:false while another park/
      // unpark for the same server is awaiting), and blindly recording the
      // request here would diverge what respawn honours from what actually ran.
      this._disabledMcpServers = new Set(this._mcpFleet.disabledServers)
    } else {
      // Fleet not yet started (no servers spawned): just record intent so
      // start() honours it. Treat as changed only if the set actually moves.
      const was = this._disabledMcpServers.has(name)
      result = { found: true, changed: was === enabled, status: enabled ? 'configured' : 'disabled' }
      if (enabled) this._disabledMcpServers.delete(name)
      else this._disabledMcpServers.add(name)
    }
    if (result.changed) this._emitMcpServers()
    return result
  }

  /**
   * #6822: submit a pasted OAuth authorization code for a remote MCP server that
   * reported `oauth-required`. Delegates redemption + authenticated reconnect to
   * the fleet, then re-emits `mcp_servers` so every client converges on the new
   * status. Returns `{ found, ok?, status?, error? }`; `found: false` when the
   * server isn't configured (or the fleet never started), so the WS handler can
   * surface a clean error. The code + tokens never touch a log or the wire.
   */
  async submitMcpAuthCode(name, code) {
    if (typeof name !== 'string' || !this._mcpServerConfigs.some((c) => c.name === name)) {
      return { found: false }
    }
    if (!this._mcpFleet) {
      return { found: false }
    }
    const result = await this._mcpFleet.submitAuthCode(name, code)
    if (result?.ok) this._emitMcpServers()
    return result
  }

  /**
   * #6824: the parked (disabled) server names, sorted, for persistence into
   * session-state.json. Session-manager reads this in `_serializeSessionEntry`
   * and forwards it back as `disabledMcpServers` on restore.
   */
  getDisabledMcpServers() {
    return [...this._disabledMcpServers].sort()
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

    // Claim busy up front so the async MCP-prompt resolution below can't race a
    // second concurrent send (isRunning stays true across the await window).
    this._isBusy = true

    // #6823: MCP prompt-as-slash-command interception. A leading
    // `/mcp__<server>__<prompt>` that matches a connected MCP server's prompt
    // is expanded via `prompts/get` and the returned messages become the user
    // turn. On a resolution failure (bad args, dead server) we release busy and
    // surface an error WITHOUT starting a turn. Plain text and non-MCP slash
    // commands (`/clear`, etc.) pass through untouched.
    let promptText = typeof prompt === 'string' ? prompt : String(prompt ?? '')
    const mcpPromptMatch = this._matchMcpPromptCommand(promptText)
    if (mcpPromptMatch) {
      try {
        promptText = await this._resolveMcpPromptToText(mcpPromptMatch)
      } catch (err) {
        this._isBusy = false
        this.emit('error', {
          message: `MCP prompt /${mcpPromptMatch.prefixedName} failed: ${err?.message || String(err)}`,
        })
        return
      }
      // #6845: honesty. The raw `/mcp__server__prompt` the user typed is NOT
      // what the model receives — the SERVER-CONTROLLED expansion above is,
      // injected as the user turn. Surface it in the transcript as a labeled
      // system marker so the user can audit the actual injected content (a
      // trusted-but-verbose, or later-compromised, MCP server could inject
      // surprising text). Emitted before stream_start so it renders between the
      // user's raw command echo and the assistant response. Never lets a marker
      // failure break the turn — the message send is what matters.
      this._emitMcpPromptExpansionMarker(mcpPromptMatch, promptText)
    }

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
    // rebuilt systemPrompt instead. #6823: `promptText` is the MCP-prompt-
    // expanded text when the input was a `/mcp__server__prompt` command, else
    // the raw prompt.
    let userText = promptText
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
    // #5630: computePromptCostUsd now returns `null` (not 0) when pricing is
    // unknown. Adding `null` to turnCost would make it NaN, so we guard every
    // add and track whether ANY round produced a known cost. If no round did
    // (pricing unknown for the model all turn), we emit `cost: null` so the
    // dashboard shows "n/a" rather than a misleading $0.00 — distinct from a
    // genuine zero-cost turn.
    let turnCostKnown = false
    // #6769: the FINAL round's individual usage — a true prompt-size SNAPSHOT
    // (that round's input + cache_read + cache_creation is exactly the
    // conversation as last sent to the API), unlike the summed `turnUsage`
    // above which re-counts the history once per round and must never feed
    // the context meter. Updated after every finalMessage() so whatever round
    // ends the turn (normal break, abort break, summary round) leaves its
    // snapshot here.
    let lastRoundUsage = null
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
            case 'thinking_delta': {
              // #6756 — extended-thinking (reasoning) delta. The translator
              // already recognises `thinking_delta` (byok-event-translator.js);
              // previously it hit `default: break` and was dropped. Route it to
              // a distinct thinking id (opened lazily on the block's first
              // delta) so it streams into a `type: 'thinking'` bubble.
              const idx = typeof t.index === 'number' ? t.index : 0
              let thinkingId = this._streamingIndexToThinkingId.get(idx)
              if (!thinkingId) {
                thinkingId = `${messageId}-thinking-${idx}`
                this._streamingIndexToThinkingId.set(idx, thinkingId)
                // #6391 footer-stat: mark the block's start for the
                // content_block_stop elapsed-time computation. #6943:
                // performance.now() (monotonic), not Date.now().
                this._thinkingStartMs.set(thinkingId, performance.now())
                this.emit('stream_start', { messageId: thinkingId, thinking: true })
              }
              this.emit('stream_delta', { messageId: thinkingId, delta: t.text, thinking: true })
              break
            }
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
              // just means we never tracked this block (text) and the
              // lookup is a no-op.
              if (typeof t.index === 'number') {
                this._streamingIndexToToolUseId.delete(t.index)
                // #6756 — close the thinking stream for this block so the
                // client finalises its "Thinking… → Thought" label.
                const thinkingId = this._streamingIndexToThinkingId.get(t.index)
                if (thinkingId) {
                  this._streamingIndexToThinkingId.delete(t.index)
                  // #6391 footer-stat: elapsed monotonic time from the block's
                  // open to now → the client's `thought for Xs` footer. Omit
                  // when the start wasn't tracked so we never send a bogus 0.
                  // No token count: Anthropic's usage folds thinking tokens
                  // into output_tokens with no per-block breakdown (see
                  // follow-up). #6943: startMs is a performance.now() sample
                  // (monotonic, immune to wall-clock jumps), so elapsed can
                  // never legitimately be negative — Math.max(0, …) is a
                  // defensive floor only, not a correctness requirement.
                  const startMs = this._thinkingStartMs.get(thinkingId)
                  this._thinkingStartMs.delete(thinkingId)
                  const streamEndMsg = { messageId: thinkingId, thinking: true }
                  if (typeof startMs === 'number') {
                    streamEndMsg.thinkingDurationMs = Math.max(0, Math.round(performance.now() - startMs))
                  }
                  this.emit('stream_end', streamEndMsg)
                }
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
        this._streamingIndexToThinkingId.clear()
        this._thinkingStartMs.clear()
        lastStopReason = final.stop_reason
        const roundUsage = final.usage || {}
        // #6769: keep the raw per-round usage — the LAST one standing at emit
        // time is the turn's occupancy snapshot.
        lastRoundUsage = roundUsage
        turnUsage.input_tokens += Number(roundUsage.input_tokens) || 0
        turnUsage.output_tokens += Number(roundUsage.output_tokens) || 0
        turnUsage.cache_read_input_tokens += Number(roundUsage.cache_read_input_tokens) || 0
        turnUsage.cache_creation_input_tokens += Number(roundUsage.cache_creation_input_tokens) || 0
        // #5630: skip a null (unknown) cost so turnCost never becomes NaN;
        // a non-null value marks the turn cost as known.
        {
          const c = computePromptCostUsd(roundUsage, pricing)
          if (c !== null) { turnCost += c; turnCostKnown = true }
        }

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
          // #6769: the summary round is the turn's final API round — its
          // individual usage supersedes the previous round's snapshot.
          lastRoundUsage = sUsage
          turnUsage.input_tokens += Number(sUsage.input_tokens) || 0
          turnUsage.output_tokens += Number(sUsage.output_tokens) || 0
          turnUsage.cache_read_input_tokens += Number(sUsage.cache_read_input_tokens) || 0
          turnUsage.cache_creation_input_tokens += Number(sUsage.cache_creation_input_tokens) || 0
          // #5630: skip a null (unknown) cost — see the round-usage add above.
          {
            const c = computePromptCostUsd(sUsage, pricing)
            if (c !== null) { turnCost += c; turnCostKnown = true }
          }
          this._history.push({ role: 'assistant', content: summaryFinal.content })
          break
        }
      }

      // #4049: fold any subagent (Task tool) usage + cost into the
      // user-facing turn totals. Cost accounting must attribute the
      // child's API spend to the parent session so the user sees a
      // single number for "what did this turn cost?" rather than
      // having delegated work disappear from accounting.
      turnUsage.input_tokens += this._subagentUsageThisTurn.input_tokens
      turnUsage.output_tokens += this._subagentUsageThisTurn.output_tokens
      turnUsage.cache_read_input_tokens += this._subagentUsageThisTurn.cache_read_input_tokens
      turnUsage.cache_creation_input_tokens += this._subagentUsageThisTurn.cache_creation_input_tokens
      // Subagent cost is a finite accumulator (child `result.cost` coerced via
      // `Number(...) || 0`); any positive contribution means the turn cost is
      // at least partially known (#5630).
      turnCost += this._subagentCostThisTurn
      if (this._subagentCostThisTurn > 0) turnCostKnown = true

      // #6769: occupancy snapshot from the FINAL round's individual usage.
      // input + cache_read + cache_creation of that one API call = the
      // conversation as last sent (the true prompt size). Deliberately NOT
      // the summed turnUsage (over-reads ≈N× on an N-round turn) and
      // deliberately excludes subagent usage (a child Task runs in its own
      // window). Omitted when the turn produced no round usage — clients
      // keep their previous snapshot.
      const finalRoundOccupancy = ClaudeByokSession._buildFinalRoundOccupancy(lastRoundUsage)

      this.emit('stream_end', { messageId })
      this.emit('result', {
        sessionId: null,
        messageId,
        stopReason: lastStopReason,
        duration: Date.now() - turnStartedAt,
        usage: turnUsage,
        ...(finalRoundOccupancy ? { contextOccupancy: finalRoundOccupancy } : {}),
        // #5630: emit null when no round produced a known cost so the UI
        // shows "n/a" instead of a misleading $0.00.
        cost: turnCostKnown ? turnCost : null,
        // #6692: single-model split. Task-subagent usage is folded into
        // turnUsage under the parent's model, which is CORRECT today because
        // children hard-inherit the parent model (see _executeTaskTool). If a
        // per-profile model override ever lands (#5018's deferred AC), that
        // change must split this map by actual child model (#5020).
        modelUsage: synthesizeModelUsage(
          this.model || this._defaultModel,
          turnUsage,
          turnCostKnown ? turnCost : null,
        ),
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
      // #5020: fold any subagent (Task tool) usage + cost into the
      // partial turn totals BEFORE the error fires so the user sees
      // what the failed turn cost. Without this fold the child's
      // tokens are silently dropped at _finishTurn reset even though
      // the user is still billed for them. Mirrors the success-path
      // fold above; the partial totals reflect every completed parent
      // round + every completed child API call before the failure.
      turnUsage.input_tokens += this._subagentUsageThisTurn.input_tokens
      turnUsage.output_tokens += this._subagentUsageThisTurn.output_tokens
      turnUsage.cache_read_input_tokens += this._subagentUsageThisTurn.cache_read_input_tokens
      turnUsage.cache_creation_input_tokens += this._subagentUsageThisTurn.cache_creation_input_tokens
      turnCost += this._subagentCostThisTurn
      if (this._subagentCostThisTurn > 0) turnCostKnown = true
      this.emit('stream_end', { messageId })
      this._emitTurnError(messageId, err, 'STREAM_ERROR', {
        usage: turnUsage,
        // #5630: null when no priced round committed before the error so the
        // partial-cost line shows "n/a" rather than $0.00.
        cost: turnCostKnown ? turnCost : null,
        // #6692: partial-spend turns get the same single-model split as the
        // success path so per-model accounting survives errored turns.
        modelUsage: synthesizeModelUsage(
          this.model || this._defaultModel,
          turnUsage,
          turnCostKnown ? turnCost : null,
        ),
      })
    } finally {
      // #4080: per-turn isolation guarantee. The per-round clear after
      // finalMessage() above runs on the success path; an iteration or
      // finalMessage() throw skips it and would leak stale
      // index→toolUseId entries into the next turn (mis-tagging the
      // next stream's tool_input_delta events). Clearing here drains
      // them on every exit path — success, error, abort, hard timeout.
      // Safe to call when already empty.
      this._streamingIndexToToolUseId.clear()
      this._streamingIndexToThinkingId.clear()
      this._thinkingStartMs.clear()
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

    // Execute locally. Three dispatch paths:
    //   1. Task (#4049) — recursive subagent. Spawns a fresh
    //      ClaudeByokSession with isolated history but shared client +
    //      cwd + permission mode, emits agent_spawned / agent_completed
    //      events, and folds the child's cost/usage back into the
    //      parent's turn totals.
    //   2. MCP tools (mcp__<server>__<tool>) — route through the fleet
    //      to the right child process via stdio JSON-RPC.
    //   3. Built-in tools (Read/Write/Bash/etc) — route through
    //      `_dispatchBuiltinTool` which by default runs in-process.
    //      Subclasses (e.g. DockerByokSession, #4053) override
    //      `_dispatchBuiltinTool` to redirect execution into an isolated
    //      environment without touching this loop.
    const effectiveInput = resolvedDecision.updatedInput || input
    let dispatchResult
    if (toolName === 'Task') {
      dispatchResult = await this._executeTaskTool({
        toolUseId,
        input: effectiveInput,
        messageId,
        signal,
      })
    } else if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      dispatchResult = await this._dispatchMcpTool(toolName, effectiveInput)
    } else {
      dispatchResult = await this._dispatchBuiltinTool({
        toolName,
        input: effectiveInput,
        signal,
      })
    }
    const { content, isError } = dispatchResult

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
   * #4049: dispatch the Task tool by spawning a child ClaudeByokSession.
   *
   * Design (v1 minimum protocol surface):
   *   - Child inherits the parent's cwd, model, permission mode, and
   *     Anthropic SDK client — same API key authenticates both, no
   *     second resolveCredentials() pass.
   *   - Child gets a FRESH _history (the subagent doesn't see the
   *     parent's conversation — that's the point of delegating to a
   *     focused scope). The prompt arrives as its first user message.
   *   - Child's intermediate tool calls are silent on the wire — the
   *     parent only sees `agent_spawned` (when the child starts) and
   *     `agent_completed` (when it returns). Surfacing per-child tool
   *     streams as sub-bubbles is a deliberate v2 follow-up (the issue
   *     calls it out as "optional"). Keeping v1 silent matches how
   *     sdk-session.js surfaces Task today.
   *   - Cost + usage from the child fold into _subagentUsageThisTurn /
   *     _subagentCostThisTurn, which sendMessage() adds to the user-
   *     facing result.cost before emitting (acceptance criteria:
   *     "child tokens attributed to the parent session").
   *   - Cancellation cascade: the parent's AbortSignal triggers
   *     child.interrupt() via the interrupt() override that iterates
   *     _subagentSessions. A signal that aborts mid-flight also fires
   *     the local onAbort listener so the cascade happens even on a
   *     micro-race between the abort and the child's sendMessage.
   *
   * Per-launch permission-mode override (#5017):
   *   The model may pass an optional `permission_mode` field on the Task
   *   input. When set, it overrides the inherited mode for this one
   *   launch — but only if it is at-most-as-permissive as the parent
   *   (plan < approve < acceptEdits < auto). Requesting a stricter mode
   *   is allowed; requesting a more permissive mode is rejected with
   *   an is_error tool_result.
   *
   * Deferred (per scope note):
   *   - Sub-bubble UI / mid-flight tool surfacing for the child
   *   - subagent_type profile registry — the field is accepted in the
   *     schema for forward-compat but the runner ignores it in v1
   *
   * @returns {Promise<{content: string, isError: boolean}>}
   */
  async _executeTaskTool({ toolUseId, input, messageId, signal }) {
    void messageId
    const description = typeof input?.description === 'string'
      ? input.description.slice(0, 200)
      : 'Background task'
    const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
    if (!prompt) {
      return {
        content: 'Task tool requires a non-empty `prompt` field describing the work for the subagent.',
        isError: true,
      }
    }
    // #5017: per-launch permission_mode override. When omitted, the child
    // inherits the parent's mode (existing v1 behaviour). When set, the
    // value must be a known mode AND at-most-as-permissive as the parent
    // (plan < approve < acceptEdits < auto) — a subagent must not be able
    // to escalate beyond the policy the user picked for the parent.
    let childPermissionMode = this.permissionMode
    if (input?.permission_mode !== undefined) {
      const requested = input.permission_mode
      if (typeof requested !== 'string' || !TASK_PERMISSION_MODE_LIST.includes(requested)) {
        return {
          content: `Task tool: invalid \`permission_mode\` "${requested}". Allowed values: ${TASK_PERMISSION_MODE_LIST.join(', ')}.`,
          isError: true,
        }
      }
      const parentRank = TASK_PERMISSION_MODE_RANK[this.permissionMode]
      const requestedRank = TASK_PERMISSION_MODE_RANK[requested]
      // parentRank can be undefined if the parent's mode is somehow
      // off-list (shouldn't happen — base-session validates — but defend
      // anyway). Treat that as "no override allowed".
      if (parentRank === undefined || requestedRank > parentRank) {
        return {
          content: `Task tool: \`permission_mode\` "${requested}" is more permissive than the parent's mode "${this.permissionMode}". Subagents must be at-most-as-permissive as the parent.`,
          isError: true,
        }
      }
      childPermissionMode = requested
    }
    // #5019: validate inherit_mcp type BEFORE the agent_spawned emit /
    // _activeAgents.set so a non-boolean value (string "true", number 1,
    // null — anything `typeof !== 'boolean'`) returns an is_error result
    // without leaving a phantom entry in _activeAgents or emitting an
    // unbalanced agent_spawned. The dashboard's active-agents badge would
    // otherwise show a spawn that never clears. Mirrors the placement of
    // the permission_mode validation above. The model gets a crisp signal
    // naming the offending field rather than us silently coercing to one
    // of the two paths.
    let inheritMcp = true
    if (input?.inherit_mcp !== undefined) {
      if (typeof input.inherit_mcp !== 'boolean') {
        return {
          content: `Task tool: invalid \`inherit_mcp\` value (got ${typeof input.inherit_mcp}). Must be a boolean.`,
          isError: true,
        }
      }
      inheritMcp = input.inherit_mcp
    }
    // #5018: subagent_type profile lookup. When the model passes a
    // `subagent_type`, look it up in the registry and apply the profile
    // (systemPrompt + toolSet) to the child before its first sendMessage.
    // Unknown values fall back to v1 behaviour (no profile applied) and
    // emit a warn log per the issue's acceptance criteria — keeps the
    // delegation forward-compatible with a future model that requests a
    // profile id this server doesn't yet know about, rather than failing
    // the entire tool call. When omitted, no profile is applied and the
    // v1 default behaviour stands.
    let subagentProfile = null
    if (input?.subagent_type !== undefined) {
      subagentProfile = getSubagentProfile(input.subagent_type)
      if (!subagentProfile) {
        const got = typeof input.subagent_type === 'string'
          ? `"${input.subagent_type}"`
          : String(input.subagent_type)
        log.warn(
          `Task tool: unknown subagent_type ${got}; falling back to v1 default (no profile applied). `
          + `Available profiles: ${SUBAGENT_PROFILE_NAMES.join(', ')}.`,
        )
      }
    }
    if (signal?.aborted) {
      return { content: 'Interrupted by user before subagent spawned', isError: true }
    }
    // Emit agent_spawned BEFORE creating the child so the dashboard's
    // active-agents badge updates immediately. Same shape as
    // sdk-session.js's emit on _handleToolUseBlock (`toolUseId`,
    // `description`, `startedAt`). The toolUseId matches the parent
    // turn's tool_use block id so the dashboard correlates the spawn
    // with the open tool_call bubble.
    const startedAt = Date.now()
    const agentInfo = { toolUseId, description, startedAt }
    this._activeAgents.set(toolUseId, agentInfo)
    this.emit('agent_spawned', agentInfo)

    // Build a child session. Reuse this session's already-resolved
    // client so the API key resolution + Anthropic constructor only
    // ran once. mcpConfigPath: null skips MCP-config DISCOVERY in the
    // child — the child does not parse a second copy of ~/.claude.json
    // and does not spawn its own fleet. Whether the child gets MCP tools
    // is controlled by the fleet-sharing block below (#5019), not by
    // the constructor.
    //
    // #5019: by default the child borrows the parent's already-running
    // MCP fleet — this gives nested Task subagents access to the same
    // mcp__<server>__<tool> set the parent sees, at zero extra spawn
    // cost (the parent's MCP children are reused). The child does NOT
    // own the fleet, so destroy() won't kill the parent's MCP children
    // when the subagent finishes. Per-call permission gating still
    // runs through the child's own PermissionManager — only the fleet
    // (process pool + tool catalogue) is shared.
    //
    // The model can opt out per-launch by passing `inherit_mcp: false`
    // on the Task input — useful when the subagent's prompt should be
    // strictly scoped to built-in tools or when an MCP server is known
    // to be misbehaving and the user wants to isolate it from the
    // delegated work. `inherit_mcp` defaults to true when omitted.
    //
    // #5015 review: wrap construction + init in try/catch. If the
    // ClaudeByokSession ctor or any of the field assignments throws
    // (unlikely today but a future refactor could add an init step
    // that does), the parent has already emitted agent_spawned and
    // populated _activeAgents — we MUST balance that with a matching
    // agent_completed + _activeAgents delete + matching error tool_result
    // so the dashboard badge clears and we don't leak the entry.
    let child
    try {
      const ClaudeByokSessionCtor = this.constructor
      child = new ClaudeByokSessionCtor({
        cwd: this.cwd,
        model: this.model || this._defaultModel,
        mcpConfigPath: null,
      })
      // Skip start()'s credential resolution — share the parent's client
      // so the child uses the same API key path. Also avoids a duplicate
      // credentials.json read which could rate-limit on disk for parallel
      // fan-outs.
      child._client = this._client
      child._apiKeySource = this._apiKeySource
      child._processReady = true
      // #5019: share the parent's MCP fleet (default) unless the model
      // explicitly opted out via `inherit_mcp: false`. Borrowed fleets
      // MUST set _ownsMcpFleet = false so the child's destroy() doesn't
      // tear down the parent's MCP children.
      if (inheritMcp && this._mcpFleet) {
        child._mcpFleet = this._mcpFleet
        child._ownsMcpFleet = false
      }
      // Inherit permission mode so the subagent runs under the same
      // gating policy as the parent — a user who set `auto` doesn't
      // want the child to start prompting again, and a user in
      // `approve` mode expects to gate the child's tools too. When the
      // model passes a `permission_mode` override on the Task input
      // (#5017), we use that instead — already validated above to be
      // at-most-as-permissive as the parent. Direct assignment (vs
      // setPermissionMode) is safe here: the child is fresh, not busy,
      // and has no pending permissions to flush.
      child.permissionMode = childPermissionMode
      // #5018: apply the subagent profile (validated above). Route the
      // systemPrompt through setSessionPreamble so the profile follows
      // the same trim + SESSION_PREAMBLE_MAX_LENGTH cap as user-authored
      // preambles — keeps the system-prompt size bounded and predictable
      // even if a future profile prompt grows. The profile's systemPrompt
      // rides in the same slot _buildSystemPrompt() reads, so the existing
      // skills/chroxy-hint ordering still composes. When the toolSet is
      // restricted to a name list, install the filter on the child so its
      // `_buildTools()` only emits the allowed built-ins; `toolSet: 'all'`
      // leaves the filter unset so the child sees the full BUILTIN_TOOLS
      // array.
      if (subagentProfile) {
        child.setSessionPreamble(subagentProfile.systemPrompt)
        if (subagentProfile.toolSet !== 'all') {
          child._allowedBuiltinToolNames = new Set(subagentProfile.toolSet)
        }
      }
      this._subagentSessions.set(toolUseId, child)
    } catch (ctorErr) {
      // Balance the agent_spawned emit + _activeAgents.set above so the
      // dashboard badge clears and the entry doesn't leak forever.
      this._finalizeAgentByToolUseId(toolUseId)
      log.warn(`subagent construction failed: ${ctorErr?.message || ctorErr}`)
      return {
        content: `Subagent construction failed: ${ctorErr?.message || ctorErr}`,
        isError: true,
      }
    }

    // Collect the child's stream_delta text into a buffer that becomes
    // the tool_result content. usage / cost are taken from the child's
    // single `result` event (the agent loop's per-round usage already
    // folds into the child's own result.usage).
    const textChunks = []
    let childCost = 0
    const childUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    let childError = null
    let resolveDone
    const done = new Promise((r) => { resolveDone = r })

    child.on('stream_delta', (e) => {
      if (typeof e?.delta === 'string') textChunks.push(e.delta)
      // #5016: forward the child's stream_delta to the parent so the
      // dashboard can render its assistant text as a nested sub-bubble.
      this._emitAgentEvent(toolUseId, 'stream_delta', e)
    })
    child.on('result', (e) => {
      const u = e?.usage || {}
      childUsage.input_tokens = Number(u.input_tokens) || 0
      childUsage.output_tokens = Number(u.output_tokens) || 0
      childUsage.cache_read_input_tokens = Number(u.cache_read_input_tokens) || 0
      childUsage.cache_creation_input_tokens = Number(u.cache_creation_input_tokens) || 0
      childCost = Number(e?.cost) || 0
      resolveDone()
    })
    child.on('error', (e) => {
      // First error wins — capture the message but DON'T resolve yet,
      // wait for the eventual stream_end so usage still folds in.
      if (!childError) childError = e?.message || 'subagent failed'
    })
    child.on('stream_end', () => {
      // Belt-and-braces: if `result` never fires (provider error,
      // abort, or stream-init throw), stream_end still resolves the
      // promise so this method doesn't hang the parent's tool loop.
      resolveDone()
    })
    // #5016: forward the child's per-tool wire events to the parent as
    // `agent_event` carrying the parent toolUseId so the dashboard
    // groups them under the Task tool_call bubble. Cost / usage are
    // intentionally NOT replayed here (they fold once via the parent's
    // own per-turn accumulators above — no double-counting).
    child.on('tool_start', (e) => {
      this._emitAgentEvent(toolUseId, 'tool_start', e)
    })
    child.on('tool_input_delta', (e) => {
      this._emitAgentEvent(toolUseId, 'tool_input_delta', e)
    })
    child.on('tool_result', (e) => {
      this._emitAgentEvent(toolUseId, 'tool_result', e)
    })
    // #5056: relay the child's permission_request up to the parent's
    // wire path so the dashboard can render the nested prompt and the
    // user can approve/deny it. Without this, an MCP tool the subagent
    // fires under `approve` mode surfaces a permission_request that
    // nothing forwards — the dashboard never shows it and the request
    // silently times out → denied.
    //
    // The pending entry lives in the CHILD's PermissionManager, so we
    // record `requestId -> child` in the parent's routing table. When
    // the user responds, ws-permissions calls the PARENT's
    // respondToPermission (the only session id it knows); the parent
    // consults this table and forwards to the child that actually holds
    // the pending entry. See respondToPermission below.
    //
    // Authority note (bearer-token-authority.md): this relay does NOT
    // widen the trust boundary. The response still flows through the
    // existing ws-permissions gate on the PARENT session id (primary or
    // pairing-bound-to-parent token required). The routing table only
    // redirects an already-authorized decision to the correct in-process
    // PermissionManager — it grants no new authority and is unreachable
    // by the child or the model (in-process Map, no wire surface).
    child.on('permission_request', (e) => {
      if (e && e.requestId) {
        this._subagentPermissionRouting.set(e.requestId, child)
      }
      this._emitAgentEvent(toolUseId, 'permission_request', e)
    })
    child.on('permission_resolved', (e) => {
      if (e && e.requestId) {
        this._subagentPermissionRouting.delete(e.requestId)
      }
      this._emitAgentEvent(toolUseId, 'permission_resolved', e)
    })
    // #5016: when the child itself dispatches a Task (grand-child),
    // its own `agent_event` fires on the child. Forward those too,
    // re-tagged with THIS parent's toolUseId so the dashboard groups
    // all descendants under the outermost Task bubble. The original
    // (grand-child) `parentToolUseId` is preserved on the payload's
    // `parentToolUseId` for downstream renderers that may want to
    // distinguish depth — we merge it INTO the forwarded payload so
    // consumers can read `payload.parentToolUseId` to recover the
    // immediate-parent (grand-child Task) id. Without this merge the
    // grand-child's id is lost on the way up; the comment claimed
    // preservation but the original implementation dropped it.
    // A non-string `e?.type` would re-emit as `'agent_event'` which
    // the consumer reducer doesn't recognise — skip those so noise
    // doesn't reach the wire.
    child.on('agent_event', (e) => {
      if (typeof e?.type !== 'string') return
      const basePayload = (e?.payload && typeof e.payload === 'object' && !Array.isArray(e.payload))
        ? e.payload
        : {}
      const mergedPayload = e?.parentToolUseId
        ? { ...basePayload, parentToolUseId: e.parentToolUseId }
        : basePayload
      // #5056: a grand-child permission_request reaches us as an
      // `agent_event` re-emitted by the child. Route the response one
      // hop down — to the IMMEDIATE child — which already holds the
      // grand-child mapping in its own routing table and forwards the
      // decision the rest of the way. This keeps the chain recursive:
      // each level only needs to know its direct child.
      if (e.type === 'permission_request' && basePayload.requestId) {
        this._subagentPermissionRouting.set(basePayload.requestId, child)
      } else if (e.type === 'permission_resolved' && basePayload.requestId) {
        this._subagentPermissionRouting.delete(basePayload.requestId)
      }
      this._emitAgentEvent(toolUseId, e.type, mergedPayload)
    })

    // Register a cascade hook on the parent's signal — interrupt()
    // already iterates _subagentSessions, but this listener also
    // catches the micro-race when the signal aborts between the
    // top-of-function check and child.sendMessage's first await.
    const onAbort = () => { try { child.interrupt() } catch { /* noop */ } }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    // #5015 review: second abort check immediately before sendMessage.
    // Closes the micro-race where the signal aborts AFTER the top-of-
    // function `signal?.aborted` check but BEFORE the child flips
    // _isBusy=true. In that window, the `onAbort` listener fires
    // child.interrupt() which no-ops (`if (!this._isBusy) return`) —
    // sendMessage would then proceed and burn tokens after Stop.
    // Short-circuit with an interrupted result so cancellation is
    // honored even when the abort lands during this narrow gap.
    if (signal?.aborted) {
      if (signal) signal.removeEventListener?.('abort', onAbort)
      this._subagentSessions.delete(toolUseId)
      this._purgeSubagentPermissionRouting(child)
      try { await child.destroy() } catch (err) {
        log.warn(`subagent destroy on pre-send abort failed: ${err?.message || err}`)
      }
      this._finalizeAgentByToolUseId(toolUseId)
      return { content: 'Interrupted by user before subagent started', isError: true }
    }
    try {
      await child.sendMessage(prompt)
      await done
    } finally {
      if (signal) signal.removeEventListener?.('abort', onAbort)
      // Drop the child from _subagentSessions before destroy() so a
      // racing interrupt() during teardown doesn't try to abort an
      // already-half-destroyed child.
      this._subagentSessions.delete(toolUseId)
      // #5056: drop any still-outstanding permission routing entries for
      // this child so a late dashboard response can't dereference a
      // destroyed child (the child's own teardown rejects its pending
      // permissions; this just clears the parent's pointer).
      this._purgeSubagentPermissionRouting(child)
      try { await child.destroy() } catch (err) {
        log.warn(`subagent destroy on Task completion failed: ${err?.message || err}`)
      }
      this._finalizeAgentByToolUseId(toolUseId)
    }

    // Fold child usage + cost into the parent's per-turn accumulators
    // so the user-facing result.cost includes every API call this
    // turn caused (acceptance criteria #4049).
    this._subagentUsageThisTurn.input_tokens += childUsage.input_tokens
    this._subagentUsageThisTurn.output_tokens += childUsage.output_tokens
    this._subagentUsageThisTurn.cache_read_input_tokens += childUsage.cache_read_input_tokens
    this._subagentUsageThisTurn.cache_creation_input_tokens += childUsage.cache_creation_input_tokens
    this._subagentCostThisTurn += childCost

    if (childError) {
      // Surface the child's error as the tool_result content so the
      // parent model can see what went wrong and decide whether to
      // retry / re-prompt / abandon.
      return { content: `Subagent failed: ${childError}`, isError: true }
    }
    const summary = textChunks.join('').trim()
    if (!summary) {
      return {
        content: 'Subagent finished without producing any output text.',
        isError: true,
      }
    }
    return { content: summary, isError: false }
  }

  /**
   * #5016: re-emit a Task subagent's intermediate wire event under the
   * parent's `agent_event` channel so the dashboard can render nested
   * sub-bubbles inside the parent's Task tool_call.
   *
   * `parentToolUseId` is the toolUseId of the parent's Task tool_use
   * block (the same id used for `agent_spawned` / `agent_completed`) —
   * the consumer keys the nested sub-bubble container off this id.
   *
   * `type` is the child's original event name (`tool_start`,
   * `tool_input_delta`, `tool_result`, `stream_delta`). The dashboard
   * switches on this to render the child's wire event in the same
   * shape it would for a top-level event.
   *
   * `payload` is the original child event payload, passed through
   * verbatim. Renderers MUST treat fields as best-effort (some payloads
   * carry messageId / toolUseId, others carry delta text only).
   *
   * Nested-Task support: when a Task subagent itself dispatches a Task,
   * the grand-child's events arrive as `agent_event` on the child
   * (because each session's `_emitAgentEvent` re-emits to itself), and
   * we surface them on the parent under the parent's toolUseId. This
   * means the dashboard sees a flat stream tagged with the IMMEDIATE
   * parent's id — nested-nested rendering is intentionally not in v2.
   *
   * @param {string} parentToolUseId
   * @param {string} type
   * @param {object} payload
   */
  _emitAgentEvent(parentToolUseId, type, payload) {
    this.emit('agent_event', {
      parentToolUseId,
      type,
      payload: payload ?? {},
    })
  }

  /**
   * #5056: remove every permission-routing entry that points at the given
   * child session. Called when a Task subagent is torn down so a late
   * dashboard response can never dereference a destroyed child. Cheap
   * (the map is empty in the common case where no permission was pending).
   *
   * @param {object} child  The subagent session being torn down
   */
  _purgeSubagentPermissionRouting(child) {
    for (const [requestId, routed] of this._subagentPermissionRouting) {
      if (routed === child) this._subagentPermissionRouting.delete(requestId)
    }
  }

  /**
   * Dispatch one built-in tool (Read/Write/Edit/Bash/Glob/Grep/WebFetch/
   * TodoWrite) to the local executor. Returns `{ content, isError }` —
   * the shape `_executeToolBlock` threads into the next round's
   * tool_result content block.
   *
   * Subclass seam (#4053): `DockerByokSession` overrides this to
   * redirect tool execution into an isolated Docker container while the
   * outer agent loop — model streaming, permission gating, MCP dispatch,
   * cost accounting — stays unchanged. The base implementation runs the
   * tool in-process on the host, which is what the host-side
   * `claude-byok` provider has always done.
   *
   * @param {object} args
   * @param {string} args.toolName  Tool name from the model's tool_use block
   * @param {object} args.input     Already-parsed JSON input from the model
   * @param {AbortSignal} [args.signal]  Per-turn abort signal
   */
  async _dispatchBuiltinTool({ toolName, input, signal }) {
    return executeBuiltinTool({
      toolName,
      input,
      cwd: this.cwd,
      cwdRealCache: this._cwdRealCache,
      cwdCacheTtl: CWD_CACHE_TTL_MS,
      signal,
      todoStore: this._todos,
    })
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

  // -------------------------------------------------------------------------
  // #6823: MCP prompts (as slash commands) + resources (in the @-picker).
  // -------------------------------------------------------------------------

  /**
   * Slash-command entries for every connected MCP server's prompts, namespaced
   * `mcp__<server>__<prompt>`. Merged into the session's slash-command surface
   * by the `list_slash_commands` handler + the connect-time auth_bootstrap
   * burst, so they render in SlashCommandPicker beside built-ins and markdown
   * skills. `source: 'mcp'` lets the picker badge/group them.
   */
  getMcpPromptCommands() {
    if (!this._mcpFleet) return []
    return this._mcpFleet.prompts.map((p) => ({
      name: p.name,
      description: typeof p.description === 'string' ? p.description : '',
      source: 'mcp',
    }))
  }

  /**
   * Read-only listing of every connected MCP server's resources for the
   * dashboard `@`-mention picker. Each entry carries the owning `server` so a
   * later read (`readMcpResource`) can route back by (server, uri).
   */
  getMcpResources() {
    if (!this._mcpFleet) return []
    return this._mcpFleet.resources
      .map((r) => ({
        uri: typeof r.uri === 'string' ? r.uri : '',
        name: typeof r.name === 'string' && r.name ? r.name : (typeof r.uri === 'string' ? r.uri : ''),
        description: typeof r.description === 'string' ? r.description : undefined,
        mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
        server: r._mcpServer,
      }))
      .filter((r) => r.uri)
  }

  /**
   * Read one MCP resource's contents (`resources/read`) routed by (server, uri).
   * Passthrough to the fleet; throws when no fleet exists or the read fails.
   */
  async readMcpResource(serverName, uri) {
    if (!this._mcpFleet) throw new Error('No MCP servers configured for this session')
    return this._mcpFleet.readResource(serverName, uri, this._mcpToolCallTimeoutMs ?? undefined)
  }

  /**
   * Parse a user input as an MCP prompt slash command. Returns a match
   * descriptor when the input is a leading `/mcp__<server>__<prompt>` that a
   * connected server actually advertises, else null (so plain text and non-MCP
   * slash commands like `/clear` pass through unchanged).
   */
  _matchMcpPromptCommand(text) {
    if (!this._mcpFleet || typeof text !== 'string') return null
    if (!text.startsWith('/')) return null
    const body = text.slice(1)
    const wsIdx = body.search(/\s/)
    const name = wsIdx === -1 ? body : body.slice(0, wsIdx)
    const rest = wsIdx === -1 ? '' : body.slice(wsIdx + 1).trim()
    // Must parse as an mcp__server__name AND match a live prompt — otherwise a
    // stray `/mcp__whatever` typed by the user stays literal input.
    if (!parseMcpToolName(name)) return null
    const promptDef = this._mcpFleet.prompts.find((p) => p.name === name)
    if (!promptDef) return null
    return { prefixedName: name, rest, promptDef }
  }

  /**
   * Resolve an MCP prompt command to the text injected as the user turn. Calls
   * `prompts/get` (with best-effort argument mapping) and flattens the returned
   * messages into text. No-argument prompts are first-class; when the prompt
   * declares arguments and the user supplied trailing text, that raw text maps
   * to the FIRST declared argument (a documented single-arg convenience — see
   * PR #6823). Throws (surfaced to the user) when the server errors or the
   * prompt yields no injectable text.
   */
  async _resolveMcpPromptToText(match) {
    const declared = Array.isArray(match.promptDef?.arguments) ? match.promptDef.arguments : []
    let args
    // #6844 review: require a NON-EMPTY declared argument name — a server
    // advertising `arguments: [{ name: '' }]` (or whitespace) must not produce
    // a bogus `{ "": text }` argument map; treat it as no declared args and
    // call prompts/get without arguments.
    const firstArgName = typeof declared[0]?.name === 'string' && declared[0].name.trim()
      ? declared[0].name
      : null
    if (firstArgName && match.rest) {
      args = { [firstArgName]: match.rest }
    }
    const result = await this._mcpFleet.getPrompt(
      match.prefixedName,
      args,
      this._mcpToolCallTimeoutMs ?? undefined,
    )
    const text = this._extractPromptMessagesText(result)
    if (!text) throw new Error('prompt returned no injectable text content')
    return text
  }

  /**
   * #6845: emit the honesty marker for an expanded MCP prompt. The expansion is
   * SERVER-CONTROLLED (authored by the MCP server, not typed by the user) and
   * lands in the user role, so the marker is explicitly provenance-labeled and
   * carries the (bounded) injected text for audit. Structured on a `system`
   * message with `subtype: 'mcp_prompt_expansion'` + a `mcpPromptExpansion`
   * field — the same optional-field-on-an-existing-marker path #6768's
   * compact_boundary uses, so no new wire type is introduced. `content` carries
   * the same labeled+bounded text so generic renderers (mobile system bubble,
   * the System tab) stay honest even without the dedicated marker component.
   * A marker failure is logged and swallowed: surfacing the expansion must
   * never break delivery of the actual user turn.
   */
  _emitMcpPromptExpansionMarker(match, expandedText) {
    try {
      const parsed = parseMcpToolName(match?.prefixedName) || {}
      const server = typeof parsed.serverName === 'string' ? parsed.serverName : ''
      const prompt = typeof parsed.toolName === 'string' ? parsed.toolName : ''
      const { text, truncated } = boundMcpPromptExpansionText(expandedText)
      const label = `Expanded /${match?.prefixedName ?? ''} (server-controlled MCP prompt)`
      this.emit('message', {
        type: 'system',
        subtype: 'mcp_prompt_expansion',
        content: `${label} →\n${text}`,
        mcpPromptExpansion: { server, prompt, text, truncated },
        timestamp: Date.now(),
      })
    } catch (err) {
      log.warn(`failed to emit MCP prompt expansion marker: ${err?.message || String(err)}`)
    }
  }

  /**
   * Flatten an MCP `prompts/get` result's `messages[]` into a single string.
   * Handles the spec's `content` shapes: a bare string, a single
   * `{ type:'text', text }` object, or an array of content blocks. Non-text
   * blocks (image/resource) are skipped — chroxy injects prompts as a text
   * user turn.
   */
  _extractPromptMessagesText(result) {
    const messages = Array.isArray(result?.messages) ? result.messages : []
    const parts = []
    for (const m of messages) {
      const c = m?.content
      if (typeof c === 'string') { parts.push(c); continue }
      if (Array.isArray(c)) {
        for (const block of c) if (typeof block?.text === 'string') parts.push(block.text)
        continue
      }
      if (c && typeof c === 'object' && typeof c.text === 'string') parts.push(c.text)
    }
    return parts.join('\n\n').trim()
  }

  /**
   * In-process permission response — called by ws-permissions.js when the
   * user taps Approve/Deny on the phone or dashboard. Forwards to
   * PermissionManager which resolves the pending Promise in
   * handlePermission() above.
   */
  respondToPermission(requestId, decision, editedInput, reason) {
    // #5056: if this requestId belongs to a Task subagent (its pending
    // entry lives in the CHILD's PermissionManager, not ours), forward
    // the decision to that child. ws-permissions only ever calls the
    // PARENT (the session id it knows), so this redirect is what lets a
    // dashboard Approve/Deny reach a nested MCP permission prompt. The
    // child's own respondToPermission recurses if the prompt actually
    // belongs to a grand-child. Authority is unchanged: the caller was
    // already authorized against the parent session by ws-permissions.
    const child = this._subagentPermissionRouting.get(requestId)
    if (child) {
      // Drop the routing entry first so a duplicate/late response can't
      // re-resolve a stale id. The child also emits permission_resolved
      // which our relay listener uses to clear the same entry — deleting
      // here too is idempotent and closes the lifetime tightly.
      this._subagentPermissionRouting.delete(requestId)
      // #6543: forward the operator's per-hunk editedInput to the child too.
      // #6773: the deny `reason` forwards to the child as well.
      return child.respondToPermission(requestId, decision, editedInput, reason)
    }
    return this._permissions.respondToPermission(requestId, decision, editedInput, reason)
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

  /** Current session-scoped permission rules (#3072 parity with SdkSession). */
  getPermissionRules() {
    if (typeof this._permissions.getRules === 'function') {
      return this._permissions.getRules()
    }
    return []
  }

  /**
   * #6771 — durable (project-scoped) permission rules applied to this session.
   */
  getPersistentPermissionRules() {
    if (typeof this._permissions.getPersistentRules === 'function') {
      return this._permissions.getPersistentRules()
    }
    return []
  }

  /**
   * #6771 — re-seed this session's in-memory durable rule set (no persist).
   */
  setPersistentPermissionRules(rules) {
    if (typeof this._permissions.setPersistentRules === 'function') {
      this._permissions.setPersistentRules(rules)
    }
  }

  _emitTurnError(messageId, err, fallbackCode, partials) {
    // #4057: SDK v0.81+ throws `APIUserAbortError` (not the generic
    // `AbortError`) when an in-flight messages.stream sees its signal
    // aborted. Primary check is `instanceof` — the SDK class itself
    // never sets `.name`, so a name-string check would fail
    // (instance.name === 'Error', verified at runtime). Keep the
    // legacy `name === 'AbortError'` fallback for raw fetch aborts
    // (the SDK's own internal abort helper uses this convention). The
    // signal.aborted fallback catches paths where the SDK swallowed
    // the original error and re-threw something we don't recognise.
    //
    // #5020: `partials` carries the parent's completed-round usage +
    // cost (already folded with any subagent Task tool spend). Surface
    // it on every error path — ABORT and STREAM_ERROR alike — so the
    // user can see what the failed turn cost. The error envelope schema
    // is `.passthrough()` (ServerErrorEnvelopeSchema, protocol/server.ts)
    // so additional fields propagate without a wire-side schema change.
    // Optional / undefined-safe: pre-#5020 call sites pass nothing and
    // the fields are simply absent on the event payload.
    const aborted =
      err instanceof APIUserAbortError ||
      err?.name === 'AbortError' ||
      this._abortController?.signal?.aborted
    if (aborted) {
      this.emit('error', {
        messageId,
        message: 'Interrupted by user',
        code: 'ABORT',
        ...(partials ? { usage: partials.usage, cost: partials.cost, modelUsage: partials.modelUsage ?? null } : {}),
      })
      return
    }
    const code = err?.status ? `HTTP_${err.status}` : (err?.code || fallbackCode)
    const message = err?.message || String(err)
    this.emit('error', {
      messageId,
      message,
      code,
      ...(partials ? { usage: partials.usage, cost: partials.cost, modelUsage: partials.modelUsage ?? null } : {}),
    })
  }

  _finishTurn() {
    this._isBusy = false
    this._currentMessageId = null
    this._abortController = null
    // #4049: reset the subagent accumulators so the next turn starts
    // clean — even on error / abort paths where the result event never
    // fired and the fold-in step above was skipped.
    this._subagentUsageThisTurn = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    this._subagentCostThisTurn = 0
  }

  interrupt() {
    if (!this._isBusy) return
    if (this._abortController) {
      this._abortController.abort()
    }
    // #4049: cascade the interrupt to any active subagent sessions.
    // Each child has its own AbortController — interrupt() short-
    // circuits its in-flight stream so it returns promptly, which lets
    // _executeTaskTool's awaited promise resolve and the parent's
    // outer agent loop can finish the user-facing result event.
    for (const child of this._subagentSessions.values()) {
      try { child.interrupt() } catch (err) {
        log.warn(`subagent interrupt failed: ${err?.message || err}`)
      }
    }
  }

  /**
   * #5274 (Control Room Phase 2a parity): cancel a single in-flight subagent
   * node by its `activityId` (the Task `toolUseId`). Mirrors
   * `SdkSession.cancelActivity` and returns the same structured-result
   * vocabulary, but the *mechanism* differs: SdkSession maps the node to the
   * SDK's `query.stopTask(task_id)`, whereas ClaudeByokSession owns each
   * subagent as a child session in `_subagentSessions` — so cancel aborts the
   * child's in-flight stream (via its `interrupt()` → `AbortController`) and
   * finalizes the parent's agent node.
   *
   * @param {string} activityId
   * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>}
   */
  async cancelActivity(activityId) {
    if (typeof activityId !== 'string' || !activityId) return { ok: false, reason: 'invalid-id' }
    const entry = this._activity.getEntry(activityId)
    if (!entry) return { ok: false, reason: 'not-found' }
    if (entry.kind !== 'agent') {
      // Shells and tool calls have no per-node cancel surface (same as
      // SdkSession) — distinguish the shell case so the UI can point at
      // "Interrupt turn" instead of implying a transient error.
      return { ok: false, reason: entry.kind === 'shell' ? 'shell-not-cancellable' : 'not-cancellable' }
    }
    const child = this._subagentSessions.get(activityId)
    if (!child) {
      // The agent node is in the registry but we hold no live child handle —
      // the subagent already returned and was cleaned up; nothing to abort.
      return { ok: false, reason: 'not-found' }
    }
    log.info(`Cancelling byok subagent ${activityId}`)
    // Best-effort: the child's interrupt() aborts its in-flight stream, but
    // early-returns if the child isn't busy yet (the narrow window between
    // _subagentSessions.set and the child's sendMessage flipping _isBusy). In
    // that window the cancel can't pre-empt the not-yet-started turn — we still
    // optimistically finalize the node, matching the SDK path's best-effort
    // stopTask contract.
    try {
      child.interrupt()
    } catch (err) {
      log.warn(`subagent cancel failed for ${activityId}: ${err?.message || err}`)
      return { ok: false, reason: 'stop-failed', error: err?.message || String(err) }
    }
    // Optimistic finalize — idempotent with the natural agent_completed that
    // fires when the child's aborted stream unwinds.
    this._finalizeAgentByToolUseId(activityId)
    return { ok: true }
  }

  /**
   * #5274: drop a subagent's `_activeAgents` entry and emit `agent_completed`
   * so its activity node terminates promptly on cancel. Idempotent (guards on
   * `_activeAgents.has`) so the optimistic cancel-finalize and the natural
   * completion don't double-emit. Mirrors SdkSession's helper of the same name
   * (minus the task-id map, which byok doesn't have).
   *
   * @param {string} toolUseId
   */
  _finalizeAgentByToolUseId(toolUseId) {
    if (typeof toolUseId !== 'string' || !toolUseId) return
    if (!this._activeAgents.has(toolUseId)) return
    this._activeAgents.delete(toolUseId)
    this.emit('agent_completed', { toolUseId })
  }

  // #5374: no setModel override needed — BaseSession.setModel updates the
  // field and the next sendMessage uses it. No restart: the SDK is a stateless
  // HTTP client; each turn opens a fresh stream.

  _onPermissionModeChanged(mode) {
    // #3729 / #4462: flipping to auto/bypass mid-turn must drain any
    // open permission prompts so the user isn't left staring at modals
    // after declaring "approve everything". Mirrors sdk-session.js's
    // behaviour.
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
  //
  // #5018: when this session is a subagent that was spawned with a
  // restricted profile, `_allowedBuiltinToolNames` is a Set of the
  // allowed built-in tool names. Filter BUILTIN_TOOLS down to just
  // those — MCP tools pass through unchanged in v1 (gating MCP per
  // profile is a follow-up; the immediate value of a restricted
  // profile like code-reviewer is preventing accidental Write/Edit/Bash,
  // and MCP tools are off by default in subagents anyway). Unrestricted
  // (or non-subagent) sessions skip the filter entirely so this stays
  // a zero-cost path for the common case.
  _buildTools() {
    const builtins = this._allowedBuiltinToolNames
      ? BUILTIN_TOOLS.filter((t) => this._allowedBuiltinToolNames.has(t.name))
      : BUILTIN_TOOLS
    if (!this._mcpFleet) return builtins
    const mcp = this._mcpFleet.anthropicTools
    return mcp.length === 0 ? builtins : [...builtins, ...mcp]
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
    this._streamingIndexToThinkingId.clear()
    this._thinkingStartMs.clear()
    this._pendingPermissionToolUseIds.clear()
    // #5056: drop any outstanding subagent permission-routing pointers so
    // the destroyed parent doesn't retain references to its children.
    this._subagentPermissionRouting.clear()
    // #4049: tear down any active subagent sessions. interrupt() (run
    // at the top of destroy()) already cascaded the abort signal; this
    // step also drops each child's PermissionManager, MCP fleet, and
    // EventEmitter listeners so a long-running parent that fanned-out
    // a series of Task subagents doesn't leak per-child resources.
    if (this._subagentSessions.size > 0) {
      const children = [...this._subagentSessions.values()]
      this._subagentSessions.clear()
      for (const child of children) {
        try { await child.destroy() } catch (err) {
          log.warn(`subagent destroy failed: ${err?.message || err}`)
        }
      }
    }
    this._client = null
    // #4077: tear down MCP children with SIGTERM → SIGKILL grace.
    // Awaits up to FLEET_KILL_GRACE_MS (2s) + 500ms safety margin so a
    // hung child cannot stall destroy() indefinitely.
    //
    // #5019: only the owning session tears the fleet down. A Task subagent
    // that borrowed the parent's fleet (_ownsMcpFleet === false) just
    // drops its reference — destroying the parent's MCP children mid-flight
    // would kill MCP tool access for the parent and any sibling subagents.
    if (this._mcpFleet) {
      const fleet = this._mcpFleet
      const owns = this._ownsMcpFleet
      this._mcpFleet = null
      if (owns) {
        try { await fleet.destroy() } catch (err) {
          log.warn(`MCP fleet teardown failed: ${err?.message || err}`)
        }
      }
    }
    this.removeAllListeners()
  }
}
