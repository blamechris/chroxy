/**
 * Config-driven OpenAI-compatible provider endpoints (#5420).
 *
 * The sibling of anthropic-compatible-session.js (#5419): anything that speaks
 * the OpenAI Chat Completions API — OpenAI itself, OpenRouter, LM Studio, vLLM,
 * llama.cpp server, Together, Groq, DeepInfra, any custom proxy — can be
 * declared in config.json under `providers.openaiCompatible` and registered as
 * a first-class provider at startup, without writing a per-service session class.
 *
 * The Anthropic↔OpenAI translation core (request shape + streaming-chunk fold
 * into Anthropic SDK events + final Message) ships in anthropic-openai-translate.js
 * (#6127); the network glue that exposes it as an `@anthropic-ai/sdk`-shaped
 * client lives in anthropic-openai-shim.js. This module reuses the entire
 * config-driven Anthropic-compatible factory (credential resolution, model
 * allowlists / discovery, pricing, preflight, resolveAuth) and swaps exactly one
 * seam: `_buildClient` returns the OpenAI shim client instead of a raw Anthropic
 * client. Subclass, not fork — every byok-session fix and every
 * anthropic-compatible improvement flows to every configured OpenAI endpoint.
 *
 * Entry shape is identical to `providers.anthropicCompatible`
 * (id/label/baseUrl/defaultModel/models?/apiKeyEnv?/credentialsKey?/pricing?/
 * contextWindow?/modelDiscovery?), validated by the same validator in
 * anthropic-compatible-config.js. The ONLY difference is the wire dialect of
 * `baseUrl`: it must point at an OpenAI chat-completions endpoint (the shim
 * appends `/chat/completions`) rather than an Anthropic `/v1/messages` one.
 *
 * Credentials never touch config.json: `apiKeyEnv` names an env var,
 * `credentialsKey` names a field in ~/.chroxy/credentials.json (mode 0600).
 * Env wins over file. Keys are never logged.
 */

import { createAnthropicCompatibleSessionClass } from './anthropic-compatible-session.js'
import { validateOpenAiCompatibleProviders } from './anthropic-compatible-config.js'
import { createAnthropicShimClient } from './anthropic-openai-shim.js'
import { registerProvider, getRegisteredProviderNames } from './providers.js'
import { createLogger } from './logger.js'

const log = createLogger('openai-compatible')

/**
 * Create a ClaudeByokSession subclass for one validated OpenAI-compatible config
 * entry. Delegates the whole four-seam machinery to
 * `createAnthropicCompatibleSessionClass` and overrides only `_buildClient` so
 * the session talks chat-completions (via the shim) instead of Anthropic
 * `/v1/messages`.
 *
 * The entry should be the NORMALIZED shape produced by
 * `validateOpenAiCompatibleProviders`; the underlying Anthropic-compatible
 * factory still applies the same defaults defensively so tests and embedders can
 * pass a minimal raw entry.
 *
 * @param {object} rawEntry - Normalized config entry
 * @returns {typeof import('./byok-session.js').ClaudeByokSession} Provider session class
 */
export function createOpenAiCompatibleSessionClass(rawEntry) {
  // Reuse the Anthropic-compatible factory wholesale: it validates id/baseUrl/
  // defaultModel, freezes the entry, and wires every seam except the client.
  const AnthropicCompatibleSession = createAnthropicCompatibleSessionClass(rawEntry)
  // The frozen, normalized entry the base factory built — single source of the
  // baseUrl the shim needs.
  const entry = AnthropicCompatibleSession.compatEntry

  class OpenAiCompatibleSession extends AnthropicCompatibleSession {
    /**
     * The ONE swapped seam: build an OpenAI-shim client (chat-completions under
     * an Anthropic-SDK-shaped surface) instead of a raw Anthropic client.
     * Everything else — credential resolution, history rollback, parallel
     * tools, MAX_TOOL_ROUNDS, pricing, model discovery — is inherited unchanged.
     */
    _buildClient(apiKey) {
      return createAnthropicShimClient({ baseURL: entry.baseUrl, apiKey })
    }
  }

  return OpenAiCompatibleSession
}

/**
 * Register every valid `providers.openaiCompatible` entry from the merged config
 * as a first-class provider (#5420). Called once at server startup
 * (server-cli.js) right after `registerAnthropicCompatibleProviders`, before the
 * default-provider resolution so `--provider <id>` can select an OpenAI endpoint.
 *
 * Invalid entries are logged and skipped; valid siblings still register.
 * Collisions are checked against the static RESERVED_PROVIDER_IDS and the LIVE
 * registry at call time (which already includes any anthropicCompatible ids
 * registered moments earlier).
 *
 * @param {object | null | undefined} config - Merged server config
 * @returns {string[]} The provider ids that were registered
 */
export function registerOpenAiCompatibleProviders(config) {
  const block = config?.providers
  // Legacy form: `providers` as an array of provider-id strings — nothing here.
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return []
  if (!Object.prototype.hasOwnProperty.call(block, 'openaiCompatible')) return []

  const { entries, warnings } = validateOpenAiCompatibleProviders(block.openaiCompatible, {
    reservedIds: getRegisteredProviderNames(),
  })
  for (const warning of warnings) {
    log.warn(warning)
  }

  const registered = []
  for (const entry of entries) {
    registerProvider(entry.id, createOpenAiCompatibleSessionClass(entry))
    registered.push(entry.id)
    log.info(
      `OpenAI-compatible provider registered: ${entry.id} → ${entry.baseUrl} (default model: ${entry.defaultModel}, models: ${entry.models ? entry.models.join(', ') : 'unrestricted'}, key: ${entry.apiKeyEnv || entry.credentialsKey || 'none'})`,
    )
  }
  return registered
}
