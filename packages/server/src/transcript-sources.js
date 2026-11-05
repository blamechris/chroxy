/**
 * Provider-aware transcript source resolution for the read-only closed-
 * conversation endpoint (#7828, part of #7818).
 *
 * The scanner tags every discovered conversation with the provider whose store
 * it was found in plus an opaque locator. This module is the ONE place that
 * turns (provider, locator, conversationId) into a file to read, and it never
 * guesses: an unknown provider, a provider with no adapter, a locator that does
 * not name this conversation, or a path that escapes the provider's projects
 * root is a refusal. No refusal falls back to another provider's source, and a
 * same-id file under a different provider is never consulted.
 */
import { realpathSync } from 'fs'
import { join, isAbsolute } from 'path'
import { isPathWithin } from './utils/path-containment.js'
import { resolveJsonlPath } from './jsonl-reader.js'

const UNSUPPORTED_CODEX =
  'Codex keeps its sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl in its own record format, ' +
  'which Chroxy cannot replay as a transcript yet'

/**
 * Providers whose store Chroxy can replay. Everything else known is listed with
 * the reason it cannot be; anything not listed is an unknown provider.
 */
const ADAPTERS = {
  claude: { format: 'claude-jsonl' },
  codex: { unsupported: UNSUPPORTED_CODEX },
  gemini: { unsupported: 'Gemini transcripts are not stored in a format Chroxy can replay' },
}

// `<encoded project dir>/<conversationId>.jsonl` — exactly two segments, the
// second being this conversation's own file. Anything else is not a locator the
// scanner produced.
function locatorMatches(locator, conversationId) {
  if (typeof locator !== 'string') return false
  const parts = locator.split('/')
  if (parts.length !== 2) return false
  const [dir, file] = parts
  if (!dir || dir === '.' || dir === '..' || dir.includes('\\') || dir.includes('\0')) return false
  return file === `${conversationId}.jsonl`
}

/**
 * @param {object} p
 * @param {string|null|undefined} p.provider
 * @param {string} p.conversationId
 * @param {string|null} [p.cwd] - recorded cwd; used only to place a Claude file when no locator exists (cwd-hint path)
 * @param {string|null} [p.sourceLocator]
 * @param {Array<{provider: string, projectsDir: string}>} [p.sources] - the provider-tagged roots
 * @returns {{ ok: true, provider: string, path: string } |
 *           { ok: false, code: 'unknown_provider'|'unsupported'|'invalid_source'|'source_unavailable', reason: string }}
 */
export function resolveTranscriptSource({ provider, conversationId, cwd = null, sourceLocator = null, sources = null }) {
  if (typeof provider !== 'string' || !Object.hasOwn(ADAPTERS, provider)) {
    return { ok: false, code: 'unknown_provider', reason: `Unknown transcript provider: ${typeof provider === 'string' ? provider : 'none'}` }
  }
  const adapter = ADAPTERS[provider]
  if (adapter.unsupported) {
    return { ok: false, code: 'unsupported', reason: `Transcript view is not supported for ${provider}: ${adapter.unsupported}` }
  }

  // claude-jsonl. Without a locator (the client-hint path, or a scan source
  // that predates tagging) the historical derivation applies, unchanged.
  if (sourceLocator == null) {
    if (typeof cwd !== 'string' || !cwd) {
      return { ok: false, code: 'invalid_source', reason: 'No source recorded for this conversation' }
    }
    return { ok: true, provider, path: resolveJsonlPath(cwd, conversationId) }
  }

  if (!locatorMatches(sourceLocator, conversationId)) {
    return { ok: false, code: 'invalid_source', reason: 'Transcript source does not match the conversation' }
  }
  const root = (sources || []).find((s) => s?.provider === provider)?.projectsDir
  if (typeof root !== 'string' || !isAbsolute(root)) {
    return { ok: false, code: 'source_unavailable', reason: `No ${provider} transcript store is registered` }
  }
  const candidate = join(root, sourceLocator)
  // Containment on the REAL paths, so a symlinked project dir or file cannot
  // point the read outside the provider's root (shared helper, #7287).
  try {
    const realRoot = realpathSync(root)
    const realFile = realpathSync(candidate)
    if (!isPathWithin(realFile, realRoot)) {
      return { ok: false, code: 'invalid_source', reason: 'Transcript source is outside the provider store' }
    }
    return { ok: true, provider, path: realFile }
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { ok: false, code: 'source_unavailable', reason: 'Transcript file not found' }
    }
    return { ok: false, code: 'invalid_source', reason: 'Transcript source could not be resolved' }
  }
}
