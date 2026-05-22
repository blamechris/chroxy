/**
 * BYOK (Bring Your Own Key) provider — talks to Anthropic's API directly
 * using @anthropic-ai/sdk and a user-supplied API key. No `claude` binary,
 * no Agent SDK wrapper, no OAuth. chroxy IS the agent.
 *
 * Motivation + scope: docs/decisions/2026-05-byok-provider-scope.md
 * Audit:              docs/audit-results/clarp-proxy-provider-viability/
 *
 * PR 1 (this file) ships chat-only: the session can stream a response but
 * cannot execute tools. PR 2 adds tools + permission-gated execution.
 *
 * Capability flags reflect that contract — `permissions: false`,
 * `inProcessPermissions: false` for now. They flip in PR 2 alongside the
 * `respondToPermission` / `respondToQuestion` methods.
 */

import Anthropic from '@anthropic-ai/sdk'
import { join } from 'path'
import { homedir } from 'os'
import { BaseSession } from './base-session.js'
import { createLogger } from './logger.js'
import {
  FALLBACK_MODELS,
  ALLOWED_MODEL_IDS,
  claudeDeriveId,
  resolveClaudeContextWindow,
} from './models.js'
import { resolveAnthropicApiKey, maskApiKey } from './byok-credentials.js'
import { translateSdkEvent } from './byok-event-translator.js'

const log = createLogger('byok-session')

// Default per-turn token cap. Mirrors what the spike used; the SDK accepts
// up to 200k for Opus 4.7. 64k is generous for typical chroxy turns and
// the model stops at end_turn long before this in practice.
const DEFAULT_MAX_TOKENS = 64000

// Hard cap on history length to prevent unbounded growth. Each entry is
// a Claude API message ({ role, content }). At 50 turns we're well within
// any model's context window before the SDK does its own pruning.
const MAX_HISTORY_TURNS = 50

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
      // PR 1: chat only, no tool dispatch yet. permissions flip true
      // in PR 2 alongside respondToPermission/respondToQuestion.
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      // permissionModeSwitch is true so the dropdown lets the user pre-
      // set the mode they want when tools arrive in PR 2. The mode is
      // stored on the BaseSession; setPermissionMode validates the value.
      permissionModeSwitch: true,
      planMode: false,
      // PR 1 doesn't persist history across restarts (no resumable id
      // beyond in-memory _history). Flip to true once we wire a session
      // file or DB write.
      resume: false,
      terminal: false,
      // Anthropic SDK supports extended thinking via thinking config
      // block; left off for PR 1 — wire in PR 2 alongside tools.
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
    return []
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

    // PR 1: attachments are not yet materialised (no Read tool to read them
    // back). Surface a clear error rather than silently dropping content.
    // PR 2 will route attachments through file-ops + the tool layer.
    if (Array.isArray(attachments) && attachments.length > 0) {
      this.emit('error', {
        messageId,
        message: `BYOK provider does not yet support attachments (${attachments.length} dropped). Coming in PR 2.`,
      })
      // Continue with the text-only prompt rather than aborting the turn —
      // matches the pattern in claude-tui-session.js attachments fallback.
    }

    // Build the user message. On the very first turn, prepend any skills
    // text from BaseSession._buildPrependPrompt() so a skill that asked
    // for `injection: prepend` lands in the first user turn. Subsequent
    // turns are plain prompt text — skills that targeted `system` ride
    // on the rebuilt systemPrompt instead.
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

    let stream
    try {
      stream = this._client.messages.stream(
        {
          model: this.model || 'claude-opus-4-7',
          max_tokens: DEFAULT_MAX_TOKENS,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: this._history,
          // PR 1: no tools — chat only. Tools land in PR 2.
        },
        { signal: this._abortController.signal },
      )
    } catch (err) {
      // Stream init threw synchronously (rare — usually validation errors
      // from the SDK). Roll back the user message we just pushed onto
      // _history so the next turn doesn't double-send it and so the
      // user/assistant alternation invariant the SDK requires holds.
      if (this._history.length > 0 && this._history[this._history.length - 1].role === 'user') {
        this._history.pop()
      }
      this._emitTurnError(messageId, err, 'STREAM_INIT')
      this._finishTurn()
      return
    }

    this.emit('stream_start', { messageId })

    let lastUsage = null
    let lastStopReason = null

    try {
      for await (const event of stream) {
        const t = translateSdkEvent(event)
        if (!t) continue
        switch (t.kind) {
          case 'stream_start':
            // SDK's message_start. We already emitted our own
            // stream_start above so the dashboard could spin up the
            // bubble before the model started talking; if the model
            // returns a different one (typical), emit a model_info
            // here would be useful, but for PR 1 the initial event is
            // enough. Skip.
            break
          case 'stream_delta':
            // Canonical chroxy payload shape: { messageId, delta }. The
            // dashboard + mobile consumers both read `msg.delta`; emitting
            // `text` here renders empty bubbles (matches sdk-session.js
            // shape and the ws-server.js protocol comment).
            this.emit('stream_delta', { messageId, delta: t.text })
            break
          case 'thinking_delta':
            // PR 1: forward as a regular delta. PR 2 will route via a
            // dedicated thinking surface when thinkingLevel capability
            // is enabled.
            break
          case 'tool_start':
          case 'tool_input_delta':
            // PR 1 doesn't pass tools to the SDK, so the model can't
            // emit tool_use blocks. If it ever does (e.g. a model
            // ignored the empty tool list and fabricated one), log
            // and ignore — don't crash the turn.
            log.warn(`PR1: unexpected tool event ignored: ${t.kind}`)
            break
          case 'message_delta':
            if (t.stopReason) lastStopReason = t.stopReason
            if (t.usage) lastUsage = t.usage
            break
          case 'content_block_stop':
          case 'result':
            // result fires below from finalMessage(); the SDK's own
            // message_stop is informational.
            break
          case 'unknown':
            log.warn(`PR1: unknown SDK event type=${t.sdkType} forwarded as no-op`)
            break
        }
      }

      const final = await stream.finalMessage()
      lastStopReason = lastStopReason || final.stop_reason
      lastUsage = lastUsage || final.usage

      // Append the assistant turn to history so the next sendMessage
      // sees the full conversation. Store final.content (the structured
      // array of blocks) so any future tool_use blocks survive a resume.
      this._history.push({ role: 'assistant', content: final.content })

      // stream_end MUST fire before result — dashboard's message-handler
      // flushes the debounced delta buffer + clears streamingMessageId on
      // stream_end. Without it the spinner hangs and trailing deltas may
      // not flush. Mirrors sdk-session.js:696.
      this.emit('stream_end', { messageId })
      this.emit('result', {
        sessionId: null,  // BYOK has no upstream session id (SDK is stateless)
        messageId,
        stopReason: lastStopReason,
        duration: Date.now() - turnStartedAt,
        usage: lastUsage,
        // cost intentionally omitted — until #4054 wires a per-model rate
        // table, session-manager.js gates cost tracking on
        // `typeof data.cost === 'number'` so undefined is the right
        // signal for "cost tracking deferred."
      })
    } catch (err) {
      // Always emit stream_end on the error path too so the dashboard
      // doesn't strand the spinner. Errors fire AFTER stream_end so
      // consumers can finalize the bubble before showing the error.
      this.emit('stream_end', { messageId })
      this._emitTurnError(messageId, err, 'STREAM_ERROR')
    } finally {
      this._finishTurn()
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
    this._history = []
    this._client = null
  }
}
