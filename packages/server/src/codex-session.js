import { JsonlSubprocessSession } from './jsonl-subprocess-session.js'
import { homedir } from 'os'
import { join } from 'path'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'

/**
 * Manages a Codex CLI session using `codex exec --json`.
 *
 * Implements the same EventEmitter interface as SdkSession/CliSession so
 * SessionManager and WsServer work identically regardless of provider.
 *
 * Codex CLI outputs JSONL events via --json flag:
 *   thread.started  { thread_id }
 *   turn.started    {}
 *   item.completed  { item: { id, type, text, ... } }
 *   turn.completed  { usage: { input_tokens, output_tokens, cached_input_tokens } }
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

/**
 * No default model is hard-coded here.
 *
 * Previously this module shipped `DEFAULT_MODEL = 'gpt-5.4'`, which pinned
 * the server to a specific Codex release and caused `codex exec -c model=...`
 * to fail whenever that version wasn't available on the host. Instead we now
 * pass `null` through to `BaseSession` when no model is supplied, and
 * `buildCodexArgs()` below omits the `-c model=...` override so Codex CLI
 * falls back to whatever default is configured in `~/.codex/config.toml`.
 */
const DEFAULT_MODEL = null

// Resolve the codex binary once at module load. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's
// install dir — fall through to known locations so `spawn()` succeeds.
// Covers curl|sh installers (~/.local/bin) and `npm install -g` without
// sudo (~/.npm-global/bin).
const BINARY_CANDIDATES = [
  join(homedir(), '.local/bin/codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/usr/bin/codex',
  join(homedir(), '.npm-global/bin/codex'),
]

const CODEX = resolveBinary('codex', BINARY_CANDIDATES)

/**
 * Build the argv passed to `codex exec`. Exported for unit testing.
 *
 * @param {string} text   User prompt
 * @param {string|null} model  Optional model ID. If falsy, no `-c model=` flag
 *                              is appended — Codex CLI uses its own default.
 * @returns {string[]}
 */
export function buildCodexArgs(text, model) {
  const args = ['exec', text, '--json']
  if (model) {
    args.push('-c', `model="${model}"`)
  }
  return args
}

// Per-provider model metadata — #2956.
// Source of truth for `set_model` validation, fallback model list, and
// per-model context window/label surfaced in the dashboard dropdown. Keep
// this list small and explicit until Codex CLI grows a native
// `supportedModels()` equivalent.
//
// Context-window values come from the OpenAI model docs; `contextWindow` is
// used both in the token-usage HUD and as the Codex-side override for the
// generic 200k default shipped by `models.js`.
const CODEX_MODEL_METADATA = Object.freeze({
  'gpt-5-codex': { label: 'GPT-5 Codex', contextWindow: 272_000 },
  'gpt-5':       { label: 'GPT-5',        contextWindow: 272_000 },
  'gpt-4.1':     { label: 'GPT-4.1',      contextWindow: 1_000_000 },
  'gpt-4o':      { label: 'GPT-4o',       contextWindow: 128_000 },
  'o1':          { label: 'o1',           contextWindow: 200_000 },
  'o3':          { label: 'o3',           contextWindow: 200_000 },
})

const CODEX_ALLOWED_MODELS = Object.freeze(Object.keys(CODEX_MODEL_METADATA))

const CODEX_FALLBACK_MODELS = Object.freeze(CODEX_ALLOWED_MODELS.map(id => {
  const meta = CODEX_MODEL_METADATA[id]
  return Object.freeze({
    id,
    label: meta.label,
    fullId: id,
    contextWindow: meta.contextWindow,
  })
}))

export class CodexSession extends JsonlSubprocessSession {
  // ------------------------------------------------------------------
  // Static provider identity — required by JsonlSubprocessSession
  // ------------------------------------------------------------------

  static get binaryCandidates() {
    return BINARY_CANDIDATES
  }

  static get resolvedBinary() {
    return CODEX
  }

  static get apiKeyEnv() {
    return 'OPENAI_API_KEY'
  }

  static get providerName() {
    return 'codex'
  }

  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'OpenAI Codex'
  }

  /**
   * Root data directory for this provider (#2965).
   * Consumers (conversation-scanner, ws-file-ops) use this to locate
   * provider-specific subdirs (projects/, agents/, commands/) without
   * hardcoding the path.
   */
  static get dataDir() {
    return join(homedir(), '.codex')
  }

  static get messageIdPrefix() {
    return 'codex'
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
    return CODEX_ALLOWED_MODELS
  }

  /**
   * Minimal model list shown in the dashboard when the SDK has not pushed
   * a dynamic update for this provider. Mirrors the shape returned by
   * `createModelsRegistry().getModels()` so it can be dropped straight
   * into the per-provider registry (#2956).
   *
   * @returns {ReadonlyArray<{id:string,label:string,fullId:string,contextWindow:number}>}
   */
  static getFallbackModels() {
    return CODEX_FALLBACK_MODELS
  }

  /**
   * Lookup metadata for a known Codex model. Returns null for unknown
   * ids so the registry can fall through to its generic heuristic
   * (useful when Codex adds a new model before the server is updated).
   *
   * @param {string} modelId
   * @returns {{id:string,label:string,fullId:string,contextWindow:number,description?:string}|null}
   */
  static getModelMetadata(modelId) {
    const meta = CODEX_MODEL_METADATA[modelId]
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
      label: 'Codex',
      binary: {
        name: 'codex',
        args: ['--version'],
        candidates: BINARY_CANDIDATES,
        installHint: 'install Codex CLI',
      },
      credentials: {
        envVars: ['OPENAI_API_KEY'],
        hint: 'set OPENAI_API_KEY',
        optional: false,
      },
    }
  }

  constructor({ cwd, model, permissionMode, skillsDir } = {}) {
    // `model` may be null/undefined — BaseSession coerces to null and
    // _buildArgs() omits the `-c model=...` flag so Codex CLI defers
    // to its own default from ~/.codex/config.toml.
    super({ cwd, model: model || DEFAULT_MODEL, permissionMode, skillsDir })
  }

  // ------------------------------------------------------------------
  // JsonlSubprocessSession overrides
  // ------------------------------------------------------------------

  _buildArgs(text) {
    return buildCodexArgs(text, this.model)
  }

  _buildChildEnv() {
    return buildSpawnEnv('codex')
  }

  /**
   * Only buffer stderr lines that look like actual errors/warnings —
   * Codex can be noisy with diagnostic output.
   */
  _shouldSkipStderr(msg) {
    return !(
      msg.includes('ERROR') ||
      msg.includes('WARN') ||
      msg.includes('error') ||
      msg.includes('not set')
    )
  }

  _processJsonlLine(event, ctx) {
    if (!event.type) return

    switch (event.type) {
      case 'item.completed': {
        const item = event.item
        if (!item) break

        if (item.type === 'agent_message' && item.text) {
          if (!ctx.didStreamStart) {
            this.emit('stream_start', { messageId: ctx.messageId })
            ctx.didStreamStart = true
          }
          this.emit('stream_delta', { messageId: ctx.messageId, delta: item.text })
        } else if (item.type === 'tool_call') {
          const toolMessageId = `codex-tool-${++this._messageCounter}`
          this.emit('tool_start', {
            messageId: toolMessageId,
            toolUseId: item.id || toolMessageId,
            tool: item.name || 'unknown',
            input: item.arguments || item.input || {},
          })
        } else if (item.type === 'tool_output') {
          this.emit('tool_result', {
            toolUseId: item.call_id || item.id || `codex-tool-${this._messageCounter}`,
            result: item.output || item.text || '',
          })
        }
        break
      }

      case 'turn.completed': {
        ctx.didEmitResult = true
        // End stream before result (standard provider contract)
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
        break
    }
  }
}
