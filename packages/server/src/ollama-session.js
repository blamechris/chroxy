/**
 * Ollama provider — local models through Ollama's Anthropic-compatible
 * Messages API (Ollama v0.14.0+, default `http://localhost:11434`; the
 * Anthropic SDK appends `/v1/messages` itself). Reuses ClaudeByokSession's
 * entire agent loop (streaming, tools, permissions, MCP, history, cost)
 * by swapping the four seams (`_defaultModel`, `_resolveCredentials`,
 * `_buildClient`, `_getPricing`) plus the static-side metadata — the
 * same subclass-not-fork rationale as deepseek-session.js.
 *
 * What makes this provider different from the other BYOK subclasses:
 *   - No credentials. Ollama requires an api key field on the wire but
 *     ignores it; `_resolveCredentials` returns the documented dummy.
 *     `preflight.credentials.envVars` is empty so the preflight runner
 *     skips the credential gate entirely (utils/preflight.js:130).
 *   - No model allow-list. Models are whatever the user has `ollama pull`ed
 *     locally — a static list would reject valid local models, so
 *     `getAllowedModels()` returns null (session-manager treats a
 *     non-array as "no restriction"). `getFallbackModels()` seeds the
 *     dashboard picker with Ollama's recommended coder models; dynamic
 *     discovery via GET /api/tags is a tracked follow-up.
 *   - Zero pricing. Local inference is free; `_getPricing` returns a
 *     zero-rate entry (not null) so byok-session's "no pricing entry"
 *     warn never fires and result.cost is an honest 0.
 *
 * Base URL resolution (first match wins):
 *   1. CHROXY_OLLAMA_BASE_URL — full URL, chroxy-specific override
 *   2. OLLAMA_HOST — Ollama's own convention; may be `host:port` without
 *      a scheme, normalized to http:// here
 *   3. http://localhost:11434 — Ollama's default bind
 *
 * Reachability is NOT probed at preflight (the daemon may start before
 * Ollama does); a dead endpoint surfaces at session start through
 * byok-session's existing client-error path with the base URL in the
 * message.
 */

import Anthropic from '@anthropic-ai/sdk'
import { ClaudeByokSession } from './byok-session.js'

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

// Ollama's documented "required but ignored" placeholder key. The
// Anthropic SDK refuses an empty apiKey, so something must be sent.
const OLLAMA_DUMMY_API_KEY = 'ollama'

// Seed list for the dashboard model picker — Ollama's recommended coding
// models as of v0.14 (ollama.com/blog/claude). Deliberately short: the
// real catalogue is whatever the user pulled, and getAllowedModels()
// returns null so any local model id is accepted as-is. `contextWindow`
// is null because the effective window is decided by the local model
// file + num_ctx, not the provider — the wire schema tolerates null
// (protocol server.ts: contextWindow is optional/unknown) and the
// dashboard simply omits the chip.
const OLLAMA_FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'qwen3-coder', label: 'Qwen3 Coder', fullId: 'qwen3-coder', contextWindow: null }),
  Object.freeze({ id: 'glm-4.7', label: 'GLM 4.7', fullId: 'glm-4.7', contextWindow: null }),
  Object.freeze({ id: 'minimax-m2.1', label: 'MiniMax M2.1', fullId: 'minimax-m2.1', contextWindow: null }),
])

// Local inference: every rate is zero. A real (frozen) entry rather than
// null so byok-session's once-per-model "no pricing entry" warn (which
// tells operators to update CLAUDE_PRICING_USD_PER_MTOK) never fires for
// a provider where missing pricing is not a bug.
const OLLAMA_ZERO_PRICING = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Resolve the Ollama endpoint. Exported for tests and for the auth
 * panel's detail string — keep resolution in exactly one place.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveOllamaBaseUrl(env = process.env) {
  // Trimmed-non-empty is the single "is set" predicate — resolveAuth
  // derives its override-var label from the same helper so the detail
  // string and the actual routing can never disagree. An exported-but-
  // empty (or whitespace) var counts as unset. Deliberately NO URL
  // validation here: silently redirecting a typo'd override to localhost
  // would mask the misconfig — a malformed value flows through and fails
  // loudly in the SDK's request path, and resolveAuth's `detail` shows
  // the exact string in the dashboard.
  const explicit = ollamaEnvOverride(env)
  if (explicit === 'CHROXY_OLLAMA_BASE_URL') return env.CHROXY_OLLAMA_BASE_URL.trim()
  if (explicit === 'OLLAMA_HOST') {
    const host = env.OLLAMA_HOST.trim()
    // OLLAMA_HOST accepts bare `host`, `host:port`, or a full URL.
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`
  }
  return DEFAULT_OLLAMA_BASE_URL
}

/**
 * Which env var (if any) is overriding the endpoint. Shared by
 * resolveOllamaBaseUrl (routing) and resolveAuth (labelling) so the two
 * can't drift.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {'CHROXY_OLLAMA_BASE_URL'|'OLLAMA_HOST'|null}
 */
function ollamaEnvOverride(env) {
  if (typeof env.CHROXY_OLLAMA_BASE_URL === 'string' && env.CHROXY_OLLAMA_BASE_URL.trim().length > 0) {
    return 'CHROXY_OLLAMA_BASE_URL'
  }
  if (typeof env.OLLAMA_HOST === 'string' && env.OLLAMA_HOST.trim().length > 0) {
    return 'OLLAMA_HOST'
  }
  return null
}

export class OllamaSession extends ClaudeByokSession {
  static get displayLabel() {
    return 'Ollama (local)'
  }

  static get dataDir() {
    // No `~/.claude` dependency — pure HTTP to the local Ollama daemon.
    // getProviderDataDirs() skips providers that return null (#2965).
    return null
  }

  static get preflight() {
    return {
      label: 'Ollama',
      credentials: {
        // Empty envVars → the preflight credential gate is skipped
        // (utils/preflight.js requires envVars.length > 0 to check).
        // No binary check either: Ollama is a daemon we talk HTTP to,
        // not a CLI we spawn.
        envVars: [],
        hint: 'run a local Ollama (v0.14.0+) — `ollama serve`, then `ollama pull qwen3-coder`',
        optional: true,
      },
    }
  }

  /**
   * Runtime auth state for the dashboard (#4769). There is no credential:
   * always ready, with the resolved endpoint in `detail` so SettingsPanel
   * shows where requests will go (and which env var redirected them).
   *
   * @param {NodeJS.ProcessEnv} env
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string}}
   */
  static resolveAuth(env) {
    const baseURL = resolveOllamaBaseUrl(env)
    // Same predicate as resolveOllamaBaseUrl (via the shared helper) — a
    // truthy-but-whitespace var must not be labelled as the active
    // override while routing ignores it.
    const overrideVar = ollamaEnvOverride(env)
    return {
      ready: true,
      source: 'env',
      envVar: overrideVar,
      envVars: ['CHROXY_OLLAMA_BASE_URL', 'OLLAMA_HOST'],
      hint: '',
      detail: `Local Ollama at ${baseURL} (no API key — local inference)`,
    }
  }

  static getFallbackModels() {
    return OLLAMA_FALLBACK_MODELS
  }

  static getAllowedModels() {
    // null = no restriction. Valid models are whatever `ollama list`
    // shows on this machine; the daemon can't know that statically, and
    // rejecting unlisted ids would block every locally-pulled model.
    // An unknown model surfaces as Ollama's own 404 at first message.
    return null
  }

  static getModelMetadata(modelId) {
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    const hit = OLLAMA_FALLBACK_MODELS.find((m) => m.id === modelId || m.fullId === modelId)
    if (!hit) return null
    return { id: hit.id, label: hit.label, fullId: hit.fullId, contextWindow: hit.contextWindow }
  }

  constructor(opts = {}) {
    // Force the registry name so the provider id on this session is
    // always 'ollama' — independent of whatever the embedder passed.
    super({ ...opts, provider: 'ollama' })
  }

  // --- Seam overrides (see byok-session.js for the contract) ---

  get _defaultModel() {
    return 'qwen3-coder'
  }

  _resolveCredentials() {
    // Required-but-ignored placeholder (docs.ollama.com/api/anthropic-compatibility).
    return { key: OLLAMA_DUMMY_API_KEY, source: 'env' }
  }

  _buildClient(apiKey) {
    return new Anthropic({
      apiKey,
      baseURL: resolveOllamaBaseUrl(),
    })
  }

  _getPricing() {
    return OLLAMA_ZERO_PRICING
  }
}
