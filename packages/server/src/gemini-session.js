import { JsonlSubprocessSession } from './jsonl-subprocess-session.js'
import { buildBaseSessionOpts } from './base-session.js'
import { synthesizeModelUsage } from './usage-normalize.js'
import { homedir } from 'os'
import { join } from 'path'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { hasGeminiOAuthCreds } from './auth-probes.js'
import {
  CONTEXT_WINDOW_HEADROOM,
  getRatchetCap,
  maybeRatchetContextWindow,
} from './utils/context-window-learn.js'
import { BILLING_CLASSES } from './billing-class.js'

/**
 * Manages a Gemini CLI session using `gemini -p --output-format stream-json`.
 *
 * Implements the same EventEmitter interface as SdkSession/CliSession so
 * SessionManager and WsServer work identically regardless of provider.
 *
 * Gemini CLI supports `--output-format stream-json` which outputs NDJSON events.
 * The exact event format depends on the Gemini CLI version; this provider
 * maps the most common patterns to the standard Chroxy event stream.
 *
 * Events emitted (standard provider contract):
 *   ready        { model }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   tool_start   { messageId, toolUseId, tool, input }
 *   tool_result  { toolUseId, result }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 */

const DEFAULT_MODEL = 'gemini-2.5-pro'

// Resolve the gemini binary once at module load. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's
// install dir — fall through to known locations so `spawn()` succeeds.
// Covers curl|sh installers (~/.local/bin) and `npm install -g` without
// sudo (~/.npm-global/bin).
const BINARY_CANDIDATES = [
  join(homedir(), '.local/bin/gemini'),
  '/opt/homebrew/bin/gemini',
  '/usr/local/bin/gemini',
  '/usr/bin/gemini',
  join(homedir(), '.npm-global/bin/gemini'),
]

const GEMINI = resolveBinary('gemini', BINARY_CANDIDATES)

// Per-provider model metadata — #2956.
// Context windows come from the Gemini model docs. Kept explicit here so the
// per-provider registry (models.js#getRegistryForProvider) can surface
// accurate values in the dashboard without the generic 200k heuristic that
// ships with the Claude default registry.
const GEMINI_MODEL_METADATA = Object.freeze({
  'gemini-2.5-pro':   { label: 'Gemini 2.5 Pro',   contextWindow: 2_000_000 },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', contextWindow: 1_000_000 },
  'gemini-2.0-pro':   { label: 'Gemini 2.0 Pro',   contextWindow: 2_000_000 },
  'gemini-2.0-flash': { label: 'Gemini 2.0 Flash', contextWindow: 1_000_000 },
  'gemini-1.5-pro':   { label: 'Gemini 1.5 Pro',   contextWindow: 2_000_000 },
  'gemini-1.5-flash': { label: 'Gemini 1.5 Flash', contextWindow: 1_000_000 },
})

const GEMINI_ALLOWED_MODELS = Object.freeze(Object.keys(GEMINI_MODEL_METADATA))

const GEMINI_FALLBACK_MODELS = Object.freeze(GEMINI_ALLOWED_MODELS.map(id => {
  const meta = GEMINI_MODEL_METADATA[id]
  return Object.freeze({
    id,
    label: meta.label,
    fullId: id,
    contextWindow: meta.contextWindow,
  })
}))

/**
 * Headroom multiplier for the learn-loop (#4414). Re-exported from the
 * shared `CONTEXT_WINDOW_HEADROOM` constant in `utils/context-window-learn.js`
 * so Gemini and Codex stay aligned on the same value.
 */
export const GEMINI_CONTEXT_WINDOW_HEADROOM = CONTEXT_WINDOW_HEADROOM

/**
 * Sanity cap on the learn-loop ratchet target for the Gemini provider
 * (#4414). A single `result` event with a corrupt or malicious
 * `input_tokens` value (overflow, JSONL parse glitch, future Gemini CLI
 * bug) must not be able to balloon the registered window to an absurd
 * number. 4,000,000 tokens is double today's largest published Gemini
 * window (2M for gemini-2.5-pro / gemini-2.0-pro / gemini-1.5-pro) —
 * leaves room for the next-gen bump without needing another source change.
 *
 * Sourced from the per-provider cap table in `utils/context-window-learn.js`
 * — bump it there if a legit future Gemini model exceeds 4M.
 */
export const GEMINI_CONTEXT_WINDOW_RATCHET_CAP = getRatchetCap('gemini')

/**
 * #4414 learn-loop helper. Thin Gemini-specific wrapper around the shared
 * `maybeRatchetContextWindow` so unit tests can drive the helper directly
 * without going through the JSONL readline pipeline.
 *
 * @param {import('events').EventEmitter} session  The GeminiSession instance
 * @param {string} modelId  Short id or fullId of the active Gemini model
 * @param {number} inputTokens  `usage.input_tokens` from the `result` event
 * @returns {boolean}  true when the registry was updated, false when no-op
 */
export function _maybeRatchetContextWindow(session, modelId, inputTokens) {
  return maybeRatchetContextWindow('gemini', modelId, inputTokens, session.emit.bind(session))
}

export class GeminiSession extends JsonlSubprocessSession {
  // ------------------------------------------------------------------
  // Static provider identity — required by JsonlSubprocessSession
  // ------------------------------------------------------------------

  static get binaryCandidates() {
    return BINARY_CANDIDATES
  }

  static get resolvedBinary() {
    return GEMINI
  }

  static get apiKeyEnv() {
    return 'GEMINI_API_KEY'
  }

  /**
   * #6563 — Gemini authenticates via GEMINI_API_KEY / GOOGLE_API_KEY OR OAuth
   * tokens cached under ~/.gemini by `gemini login`. Reuse the SAME probe
   * resolveAuth() and the preflight use so all three layers (display, runtime,
   * preflight) agree that a `gemini login`-only user is authenticated — start()
   * must not throw for them just because the env key is unset.
   */
  static hasAlternativeCredentials() {
    return hasGeminiOAuthCreds()
  }

  static get providerName() {
    return 'gemini'
  }

  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'Google Gemini'
  }

  /**
   * Root data directory for this provider (#2965).
   * Consumers (conversation-scanner, ws-file-ops) use this to locate
   * provider-specific subdirs (projects/, agents/, commands/) without
   * hardcoding the path.
   */
  static get dataDir() {
    return join(homedir(), '.gemini')
  }

  static get messageIdPrefix() {
    return 'gemini'
  }

  static get capabilities() {
    return {
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
      thinkingLevel: false,
      // #3932: declared explicitly so the capability matrix matches across
      // providers — claude-tui is the only one that sets this to false.
      streaming: true,
    }
  }

  /**
   * Model IDs this provider accepts in `set_model`. Returns a plain array so
   * the settings handler can surface it to the client on rejection.
   * @returns {string[]}
   */
  static getAllowedModels() {
    return GEMINI_ALLOWED_MODELS
  }

  /**
   * Minimal model list shown in the dashboard when the SDK has not pushed
   * a dynamic update for this provider. Same shape as the Claude registry
   * so `getRegistryForProvider('gemini')` can serve it directly (#2956).
   *
   * @returns {ReadonlyArray<{id:string,label:string,fullId:string,contextWindow:number}>}
   */
  static getFallbackModels() {
    return GEMINI_FALLBACK_MODELS
  }

  /**
   * Lookup metadata for a known Gemini model. Returns null for unknown
   * ids so the registry can fall back to a generic heuristic.
   *
   * @param {string} modelId
   * @returns {{id:string,label:string,fullId:string,contextWindow:number,description?:string}|null}
   */
  static getModelMetadata(modelId) {
    const meta = GEMINI_MODEL_METADATA[modelId]
    if (!meta) return null
    return {
      id: modelId,
      label: meta.label,
      fullId: modelId,
      contextWindow: meta.contextWindow,
      description: meta.description || '',
    }
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   */
  static get preflight() {
    return {
      label: 'Gemini',
      binary: {
        name: 'gemini',
        args: ['--version'],
        candidates: BINARY_CANDIDATES,
        installHint: 'install Gemini CLI (see https://github.com/google-gemini/generative-ai-cli)',
      },
      credentials: {
        // GOOGLE_API_KEY is also accepted by the Gemini CLI subprocess (see
        // utils/spawn-env.js gemini allowlist). Keep both here so the
        // preflight + #3404 audit auth surface match what the spawn allows.
        envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        hint: 'set GEMINI_API_KEY or GOOGLE_API_KEY',
        // #6563: the env var is OPTIONAL when OAuth creds exist (`gemini login`),
        // so `chroxy doctor` downgrades the missing env var from fail→warn instead
        // of a hard credentials failure — doctor can't read the OAuth token, but it
        // must not report a false failure when resolveAuth() is ready on OAuth. Same
        // probe as resolveAuth() + hasAlternativeCredentials() → one definition of
        // "has a usable credential".
        optional: hasGeminiOAuthCreds(),
      },
    }
  }

  /**
   * Resolve runtime auth state for the dashboard (#4769).
   *
   * Gemini accepts GEMINI_API_KEY / GOOGLE_API_KEY env vars OR the OAuth
   * state cached under `~/.gemini/` by `gemini login` (#4301). Filename
   * varies between CLI versions — oauth_creds.json or google_accounts.json
   * — the probe accepts either.
   *
   * @param {NodeJS.ProcessEnv} env
   * @param {{ hasGeminiOAuthCreds: () => boolean }} helpers
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string}}
   */
  static resolveAuth(env, helpers) {
    const credSpec = this.preflight.credentials
    const envVars = credSpec.envVars
    const hint = credSpec.hint || `set ${envVars.join(' or ')}`

    const matched = envVars.find(v => env[v])
    if (matched) {
      return {
        ready: true,
        source: 'env',
        envVar: matched,
        envVars,
        hint: '',
        detail: `Google API (${matched} set)`,
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }
    if (helpers.hasGeminiOAuthCreds()) {
      return {
        ready: true,
        source: 'oauth',
        envVar: null,
        envVars,
        hint,
        detail: 'Google API (OAuth from `gemini login`)',
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }
    const resolvedHint = hint
      ? `${hint} or run \`gemini login\``
      : 'run `gemini login` or set GEMINI_API_KEY'
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint: resolvedHint,
      detail: envVars.length ? `Not configured — ${resolvedHint}` : 'Not configured',
      // Non-Claude provider — always per-token api-key billing, era-independent.
      billingClass: BILLING_CLASSES.API_KEY,
    }
  }

  constructor(opts = {}) {
    // #5367: forward every BaseSession opt via the canonical picker (which
    // preserves the #3899 hardTimeoutMs / #4790 streamStallTimeoutMs plumbing
    // that used to be hand-maintained here). Overrides: provider default,
    // `model || DEFAULT_MODEL`, and `resumeSessionId` — the last is a
    // JsonlSubprocessSession-local opt (not a BaseSession key) so it must ride
    // through the overrides bag to reach the middle layer.
    super(buildBaseSessionOpts(opts, {
      provider: opts.provider || 'gemini',
      model: opts.model || DEFAULT_MODEL,
      resumeSessionId: opts.resumeSessionId,
    }))
  }

  // #5374: removed the no-op `setModel` override — it only forwarded to
  // BaseSession.setModel, which now owns the guard + the (default no-op)
  // _onModelChanged hook.

  // ------------------------------------------------------------------
  // JsonlSubprocessSession overrides
  // ------------------------------------------------------------------

  _buildArgs(text) {
    const args = ['-p', text, '--output-format', 'stream-json', '-y']
    if (this.model) {
      args.push('-m', this.model)
    }
    return args
  }

  _buildChildEnv() {
    return buildSpawnEnv('gemini')
  }

  /** Drop node DeprecationWarning noise from gemini stderr. */
  _shouldSkipStderr(msg) {
    return msg.includes('DeprecationWarning')
  }

  /**
   * Map a Gemini JSONL event to the standard Chroxy event stream.
   * Called once per JSONL line by the base class sendMessage() runtime.
   *
   * Handles the full event dispatch including assistant text streaming.
   *
   * @param {Object} event - Parsed Gemini JSONL event
   * @param {Object} ctx   - Shared per-sendMessage mutable context
   */
  _processJsonlLine(event, ctx) {
    if (!event || !event.type) return

    switch (event.type) {
      case 'assistant': {
        if (!event.content || !Array.isArray(event.content)) break
        for (const block of event.content) {
          if (block.type === 'text') {
            if (!ctx.didStreamStart) {
              this.emit('stream_start', { messageId: ctx.messageId })
              ctx.didStreamStart = true
            }
            this.emit('stream_delta', { messageId: ctx.messageId, delta: block.text || '' })
          } else if (block.type === 'tool_use') {
            const toolMessageId = `gemini-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId: toolMessageId,
              toolUseId: block.id || toolMessageId,
              tool: block.name || 'unknown',
              input: block.input || {},
            })
          }
        }
        break
      }

      case 'tool_result': {
        const toolUseId = event.tool_use_id || event.id || `gemini-tool-${this._messageCounter}`
        this.emit('tool_result', {
          toolUseId,
          result: event.content || event.output || '',
        })
        break
      }

      case 'result': {
        ctx.didEmitResult = true
        // Close any open stream before emitting result (provider contract)
        if (ctx.didStreamStart) {
          this.emit('stream_end', { messageId: ctx.messageId })
          ctx.didStreamStart = false
        }
        const usage = event.usage || {}
        const inputTokens = usage.input_tokens || 0
        const outputTokens = usage.output_tokens || 0
        // #4414 learn-loop: same drift pattern as Codex (#3857) — the static
        // window in GEMINI_MODEL_METADATA will go stale as Google bumps the
        // window for gemini-2.5-pro / future variants. When the observed
        // `input_tokens` exceeds the registered window, ratchet the registry
        // upward so the meter reflects reality, and emit `models_updated` so
        // connected dashboards refresh.
        //
        // Only ratchets *up* — a single small turn must never shrink the
        // registered window.
        if (this.model && inputTokens > 0) {
          _maybeRatchetContextWindow(this, this.model, inputTokens)
        }
        this.emit('result', {
          cost: null,
          duration: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
          // #6692: single-model split (gemini reports no cache/cost fields)
          modelUsage: synthesizeModelUsage(this.model, {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          }),
          sessionId: null,
        })
        break
      }

      default:
        // Unknown event — ignore
        break
    }
  }

  /**
   * Map a Gemini event to the standard Chroxy event stream.
   *
   * Kept for backward compatibility with tests and any callers that invoke
   * this method directly. Handles only non-text events (tool_use, tool_result,
   * result); assistant text blocks are handled via _processJsonlLine/sendMessage.
   *
   * @param {Object} event - Parsed Gemini JSONL event
   */
  _processGeminiEvent(event) {
    if (!event || !event.type) return

    switch (event.type) {
      case 'assistant': {
        // Text blocks are handled via _processJsonlLine in sendMessage context.
        // Only process tool_use blocks here.
        if (!event.content || !Array.isArray(event.content)) break
        for (const block of event.content) {
          if (block.type === 'tool_use') {
            const toolMessageId = `gemini-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId: toolMessageId,
              toolUseId: block.id || toolMessageId,
              tool: block.name || 'unknown',
              input: block.input || {},
            })
          }
        }
        break
      }

      case 'tool_result': {
        const toolUseId = event.tool_use_id || event.id || `gemini-tool-${this._messageCounter}`
        this.emit('tool_result', {
          toolUseId,
          result: event.content || event.output || '',
        })
        break
      }

      case 'result': {
        const usage = event.usage || {}
        // NOTE: the context-window learn-loop (`maybeRatchetContextWindow`)
        // is deliberately NOT wired in here. Production routes end-of-turn
        // events through `_processJsonlLine`, which owns the ratchet call.
        // This legacy path exists only for tests / direct callers and is
        // intentionally minimal — duplicating the ratchet would risk
        // double-emitting `models_updated` if both paths ever fire on the
        // same event.
        this.emit('result', {
          cost: null,
          duration: null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          },
          // #6692: keep the legacy/test path shape-identical to production
          modelUsage: synthesizeModelUsage(this.model, {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          }),
          sessionId: null,
        })
        break
      }

      default:
        // Unknown event — ignore
        break
    }
  }
}
