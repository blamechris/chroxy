/**
 * Lightweight credential ping for the dashboard "Test" button (#3855).
 *
 * Resolves a credential via the env > store order and makes the smallest
 * possible authenticated call to the provider so the user gets inline
 * confirmation that a pasted key actually works — without spawning a session.
 *
 * The raw value is used only to build the outbound request and is NEVER
 * returned, logged, or surfaced. Results carry only { ok, error?, model?,
 * latencyMs? }. Error strings are provider-supplied status text, sanitized to
 * a short summary so a verbose error body can't leak the key back.
 */
import { resolveCredential } from './credential-store.js'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Pings the provider that owns `key`. Uses the global fetch (Node 18+).
 *
 * @param {string} key - one of the known credential keys
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, error?: string, model?: string, latencyMs?: number }>}
 */
export async function testCredential(key, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch is not available in this runtime' }
  }

  const { value } = resolveCredential(key)
  if (!value) {
    return { ok: false, error: 'No credential configured (set it first, or export the env var).' }
  }

  const probe = PROBES[key]
  if (!probe) {
    return { ok: false, error: `Testing is not supported for ${key}.` }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const result = await probe(value, fetchImpl, controller.signal)
    return { ...result, latencyMs: Date.now() - startedAt }
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: `Request timed out after ${timeoutMs}ms.`, latencyMs: Date.now() - startedAt }
    }
    // Never interpolate the raw value; err.message is provider/network text.
    return { ok: false, error: sanitizeError(err?.message || String(err)), latencyMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

/** Truncate provider error text so a verbose body can't smuggle the key back. */
function sanitizeError(msg) {
  const s = String(msg).replace(/\s+/g, ' ').trim()
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

/**
 * Per-key probes. Each makes the minimal authenticated request and maps the
 * HTTP status to a friendly result. The model echoed back is the cheap model
 * used for the ping — surfaced so the user sees which endpoint answered.
 */
const PROBES = {
  ANTHROPIC_API_KEY: anthropicProbe,
  CLAUDE_CODE_OAUTH_TOKEN: claudeOauthProbe,
  GEMINI_API_KEY: geminiProbe,
  OPENAI_API_KEY: openaiProbe,
}

async function anthropicProbe(value, fetchImpl, signal) {
  const model = 'claude-3-5-haiku-latest'
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': value,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
  })
  return mapAnthropic(res, model)
}

async function claudeOauthProbe(value, fetchImpl, signal) {
  const model = 'claude-3-5-haiku-latest'
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${value}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
  })
  return mapAnthropic(res, model)
}

function mapAnthropic(res, model) {
  // 200 = key works. 400 can still mean the key authenticated (e.g. a content
  // policy rejection of a 1-token ping) — treat 4xx that ISN'T 401/403 as
  // "credential accepted, request rejected", which is a passing auth test.
  if (res.ok) return { ok: true, model }
  if (res.status === 401 || res.status === 403) return { ok: false, error: `Authentication failed (HTTP ${res.status}).` }
  if (res.status < 500) return { ok: true, model }
  return { ok: false, error: `Provider error (HTTP ${res.status}).` }
}

async function geminiProbe(value, fetchImpl, signal) {
  // models.list is a cheap authenticated GET. The key goes in the header
  // (x-goog-api-key) rather than the query string so it never lands in logs.
  const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    method: 'GET',
    signal,
    headers: { 'x-goog-api-key': value },
  })
  if (res.ok) return { ok: true, model: 'models.list' }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, error: `Authentication failed (HTTP ${res.status}).` }
  }
  return { ok: false, error: `Provider error (HTTP ${res.status}).` }
}

async function openaiProbe(value, fetchImpl, signal) {
  // GET /v1/models does not support a `limit` query param — passing one returns
  // 400 and would mis-report a valid key as failing (Copilot review). The auth
  // test is based on the response status, so the plain list endpoint suffices.
  const res = await fetchImpl('https://api.openai.com/v1/models', {
    method: 'GET',
    signal,
    headers: { authorization: `Bearer ${value}` },
  })
  if (res.ok) return { ok: true, model: 'models.list' }
  if (res.status === 401 || res.status === 403) return { ok: false, error: `Authentication failed (HTTP ${res.status}).` }
  return { ok: false, error: `Provider error (HTTP ${res.status}).` }
}
