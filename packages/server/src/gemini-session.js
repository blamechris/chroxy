import { JsonlSubprocessSession } from './jsonl-subprocess-session.js'
import { homedir } from 'os'
import { join } from 'path'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'

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
        envVars: ['GEMINI_API_KEY'],
        hint: 'set GEMINI_API_KEY',
        optional: false,
      },
    }
  }

  constructor({ cwd, model, permissionMode, skillsDir } = {}) {
    super({ cwd, model: model || DEFAULT_MODEL, permissionMode, skillsDir })
  }

  setModel(model) {
    return super.setModel(model)
  }

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
        this.emit('result', {
          cost: null,
          duration: null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          },
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
        this.emit('result', {
          cost: null,
          duration: null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          },
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
