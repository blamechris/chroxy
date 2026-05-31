/**
 * DeepSeek provider (#4656) — talks to DeepSeek's Anthropic-compatible
 * endpoint at `https://api.deepseek.com/anthropic` using the existing
 * `@anthropic-ai/sdk` client. Reuses ClaudeByokSession's entire agent
 * loop (streaming, tools, permissions, MCP, history, cost) by swapping
 * the four seams (`_defaultModel`, `_resolveCredentials`, `_buildClient`,
 * `_getPricing`) plus the static-side metadata.
 *
 * Why subclass instead of fork: every fix that lands in byok-session
 * (history rollback semantics, parallel-tool execution, MAX_TOOL_ROUNDS
 * summary, `tool_input_delta` flicker suppression, MCP fleet teardown)
 * is correctness work that DeepSeek users want too. A fork would have
 * to be hand-merged on every byok change; subclassing keeps the
 * tracking automatic.
 *
 * Onboarding: the user gets a key at platform.deepseek.com, exports
 * `DEEPSEEK_API_KEY` OR drops `{"deepseekApiKey":"sk-..."}` into
 * `~/.chroxy/credentials.json` (chmod 600), then picks the "deepseek"
 * provider in the dashboard / mobile app. See the issue tracker for the
 * full onboarding doc.
 */

import Anthropic from '@anthropic-ai/sdk'
import { ClaudeByokSession } from './byok-session.js'
import { resolveDeepSeekApiKey } from './deepseek-credentials.js'
import { getDeepSeekPricing } from './models.js'

// Override point for self-hosted or pinned-version endpoints. Defaults
// to DeepSeek's Anthropic-compatible endpoint, which they explicitly
// publish so Claude Code clients can point at it without translation.
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'

// DeepSeek's published context window for both `deepseek-chat` (V3) and
// `deepseek-reasoner` (R1). If they ever ship a larger-context variant,
// extend the metadata map below and the chip will surface automatically.
const DEEPSEEK_CONTEXT_WINDOW = 128_000

// Static model registry. `id` matches `fullId` because DeepSeek doesn't
// use a `claude-` style prefix — the registry's deriveId hook for
// non-Claude providers defaults to identity, so this stays consistent
// with what providers.js installs.
const DEEPSEEK_MODELS = Object.freeze([
  Object.freeze({
    id: 'deepseek-chat',
    label: 'DeepSeek V3 (Chat)',
    fullId: 'deepseek-chat',
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  }),
  Object.freeze({
    id: 'deepseek-reasoner',
    label: 'DeepSeek R1 (Reasoner)',
    fullId: 'deepseek-reasoner',
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  }),
])

const DEEPSEEK_MODEL_IDS = Object.freeze(DEEPSEEK_MODELS.map((m) => m.id))

export class DeepSeekSession extends ClaudeByokSession {
  static get displayLabel() {
    return 'DeepSeek (API key)'
  }

  static get dataDir() {
    // No `~/.claude` dependency — pure HTTPS to api.deepseek.com.
    // getProviderDataDirs() skips providers that return null (#2965).
    return null
  }

  static get preflight() {
    return {
      label: 'DeepSeek',
      credentials: {
        envVars: ['DEEPSEEK_API_KEY'],
        hint: 'set DEEPSEEK_API_KEY or save it as "deepseekApiKey" in ~/.chroxy/credentials.json (mode 0600)',
        optional: false,
      },
    }
  }

  static getFallbackModels() {
    return DEEPSEEK_MODELS
  }

  static getAllowedModels() {
    return [...DEEPSEEK_MODEL_IDS]
  }

  static getModelMetadata(modelId) {
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    const hit = DEEPSEEK_MODELS.find((m) => m.id === modelId || m.fullId === modelId)
    if (!hit) return null
    return { id: hit.id, label: hit.label, fullId: hit.fullId, contextWindow: hit.contextWindow }
  }

  constructor(opts = {}) {
    // Force the registry name so the provider id on this session is
    // always 'deepseek' — independent of whatever the embedder passed.
    super({ ...opts, provider: 'deepseek' })
  }

  // --- Seam overrides (see byok-session.js for the contract) ---

  get _defaultModel() {
    return 'deepseek-chat'
  }

  _resolveCredentials() {
    return resolveDeepSeekApiKey()
  }

  _buildClient(apiKey) {
    return new Anthropic({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
    })
  }

  _getPricing(model) {
    return getDeepSeekPricing(model)
  }
}
