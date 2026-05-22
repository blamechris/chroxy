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

import Anthropic from '@anthropic-ai/sdk'
import { join } from 'path'
import { homedir } from 'os'
import { BaseSession } from './base-session.js'
import { PermissionManager } from './permission-manager.js'
import { createLogger } from './logger.js'
import {
  FALLBACK_MODELS,
  ALLOWED_MODEL_IDS,
  claudeDeriveId,
  resolveClaudeContextWindow,
} from './models.js'
import { resolveAnthropicApiKey, maskApiKey } from './byok-credentials.js'
import { translateSdkEvent } from './byok-event-translator.js'
import { BUILTIN_TOOLS } from './byok-tools.js'
import { executeBuiltinTool } from './byok-tool-executor.js'

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
    // tool_start / tool_result are surfaced per turn for the dashboard's
    // tool-call bubble UI. permission_request / user_question /
    // permission_resolved are re-emitted from PermissionManager and
    // already known to the SessionManager forwarding pipeline, but list
    // them here so the capability matrix reflects reality.
    return ['tool_start', 'tool_result']
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
  }

  async start() {
    if (this._client === null) {
      // Spike (BYOK direct) confirmed the SDK's standard constructor
      // works fine; baseURL defaults to api.anthropic.com.
      const resolved = resolveAnthropicApiKey()
      if (!resolved.key) {
        this.emit('error', { message: `BYOK credentials not found — ${resolved.reason}` })
        return
      }
      this._apiKeySource = resolved.source
      // Mask in logs — full key never appears on disk. logger.js redactor
      // catches Bearer / sk-ant patterns as a defense in depth.
      log.info(`BYOK session ready — key source=${this._apiKeySource} key=${maskApiKey(resolved.key)} model=${this.model || 'default'}`)
      this._client = new Anthropic({ apiKey: resolved.key })
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
    let lastUsage = null
    let lastStopReason = null
    let rolledBack = false

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let stream
        try {
          stream = this._client.messages.stream(
            {
              model: this.model || 'claude-opus-4-7',
              max_tokens: DEFAULT_MAX_TOKENS,
              ...(systemPrompt ? { system: systemPrompt } : {}),
              tools: BUILTIN_TOOLS,
              messages: this._history,
            },
            { signal: this._abortController.signal },
          )
        } catch (err) {
          // Stream init threw synchronously. On the FIRST round only,
          // roll back the user message we pushed above so the next turn
          // doesn't double-send and the alternation invariant holds.
          // After the first round, _history contains assistant + user
          // tool_result pairs we should NOT discard.
          if (round === 0 && !rolledBack) {
            if (this._history.length > 0 && this._history[this._history.length - 1].role === 'user') {
              this._history.pop()
              rolledBack = true
            }
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
            case 'tool_start':
              // Surface the tool_use opening to the dashboard so it can
              // render a tool-call bubble. Matches sdk-session.js custom
              // event names.
              this.emit('tool_start', {
                messageId,
                toolUseId: t.toolUseId,
                toolName: t.toolName,
              })
              break
            case 'tool_input_delta':
              // Streaming JSON for the tool input. We don't currently
              // forward partial tool input to the UI (the final block
              // arrives in finalMessage), but logging helps debug
              // multi-tool turns.
              break
            case 'message_delta':
              if (t.stopReason) lastStopReason = t.stopReason
              if (t.usage) lastUsage = t.usage
              break
            case 'unknown':
              log.warn(`unknown SDK event type=${t.sdkType} forwarded as no-op`)
              break
            default:
              break
          }
        }

        const final = await stream.finalMessage()
        lastStopReason = final.stop_reason
        lastUsage = final.usage

        // Append the assistant turn — full content array preserves
        // tool_use blocks for the next round of conversation.
        this._history.push({ role: 'assistant', content: final.content })

        if (lastStopReason !== 'tool_use') {
          // Done — model wants no more tools. Break out and emit result.
          break
        }

        // Execute each tool_use block. Build a tool_result content array
        // to send back as the user message.
        const toolBlocks = (final.content || []).filter((b) => b?.type === 'tool_use')
        const toolResults = []
        for (const block of toolBlocks) {
          const result = await this._executeToolBlock({ block, messageId })
          toolResults.push(result)
          if (this._abortController?.signal?.aborted) {
            // User pressed Stop mid-tool-loop. Treat the rest as denied.
            break
          }
        }
        if (toolResults.length === 0) {
          // stop_reason was tool_use but no tool_use blocks — defensive
          // bailout to avoid an empty user message that the SDK rejects.
          log.warn(`stop_reason=tool_use but no tool_use blocks in final.content; ending turn`)
          break
        }
        this._history.push({ role: 'user', content: toolResults })

        if (this._abortController?.signal?.aborted) break

        if (round === MAX_TOOL_ROUNDS - 1) {
          // Hit the safety cap. Push one more assistant note + bail.
          log.warn(`hit MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} cap; stopping agent loop`)
          break
        }
      }

      this.emit('stream_end', { messageId })
      this.emit('result', {
        sessionId: null,
        messageId,
        stopReason: lastStopReason,
        duration: Date.now() - turnStartedAt,
        usage: lastUsage,
      })
    } catch (err) {
      this.emit('stream_end', { messageId })
      this._emitTurnError(messageId, err, 'STREAM_ERROR')
    } finally {
      this._finishTurn()
    }
  }

  /**
   * Run one tool_use block: permission gate, dispatch to executor, emit
   * tool_result events, return the {type:'tool_result', ...} content
   * block to append to the next user message.
   */
  async _executeToolBlock({ block, messageId }) {
    const toolUseId = block.id
    const toolName = block.name
    const input = block.input || {}
    const signal = this._abortController?.signal

    // Permission gate. PermissionManager handles all four modes
    // (approve / auto / acceptEdits / plan) and session rules.
    let decision
    try {
      decision = await this._permissions.handlePermission(
        toolName,
        input,
        signal,
        this.permissionMode,
      )
    } catch (err) {
      // permission_request was rejected (timeout, abort, etc.)
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Permission gate error: ${err?.message || String(err)}`,
        is_error: true,
      }
    }

    if (decision.behavior !== 'allow') {
      const msg = decision.message || 'Permission denied by user.'
      this.emit('tool_result', {
        messageId,
        toolUseId,
        toolName,
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

    // Execute locally.
    const effectiveInput = decision.updatedInput || input
    const { content, isError } = await executeBuiltinTool({
      toolName,
      input: effectiveInput,
      cwd: this.cwd,
      cwdRealCache: this._cwdRealCache,
      cwdCacheTtl: CWD_CACHE_TTL_MS,
      signal,
    })

    this.emit('tool_result', {
      messageId,
      toolUseId,
      toolName,
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
    const aborted = err?.name === 'AbortError' || this._abortController?.signal?.aborted
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
    // PR 1 has no permission gating, so this is purely persisted state
    // for PR 2 to consume.
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
    this._client = null
    this.removeAllListeners()
  }
}
