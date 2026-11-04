// #8609 — what the backend refused to serve to a given codex client.
//
// An older codex client's `model/list` echoes the shared ~/.codex/models_cache.json
// (written by the newest client on the machine), so it lists — and may mark
// default — models it cannot use. The only reliable signal is the backend's
// rejection on the first turn. This module recognises that rejection and keeps a
// daemon-lifetime, bounded record per launched client (`<binaryPath>@<version>`)
// so the next session on the same client does not walk into the same refusal.

import { PROVIDER_MODEL_ID_MAX_LENGTH, PROVIDER_REJECTED_MODELS_MAX } from '@chroxy/protocol'

export const MODEL_UNSUPPORTED_CODE = 'model_unsupported'

const MAX_CLIENTS = 32
// Shared with the provider_runtime_info schema so the two bounds cannot drift.
const MAX_MODELS_PER_CLIENT = PROVIDER_REJECTED_MODELS_MAX
const MAX_MODEL_ID = PROVIDER_MODEL_ID_MAX_LENGTH
// path (bounded by PROVIDER_BINARY_PATH_MAX_LENGTH upstream) + version + route
const MAX_CLIENT_KEY = 1400

// "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
const QUOTED_RE = /['"‘’`]([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})['"‘’`]\s+model\s+is\s+not\s+supported/i
const BARE_RE = /\bmodel\s+is\s+not\s+supported\b/i

function textOf(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) || '' } catch { return '' }
}

/**
 * @returns {{model: string|null}|null} null when this is not a model rejection;
 *   `model` is the quoted id, or null when the text names none. Only a QUOTED id
 *   is evidence about a specific model; callers must not blame a client for an
 *   unquoted match.
 */
export function detectModelRejection(err, raw) {
  const haystack = `${typeof err?.message === 'string' ? err.message : ''}\n${textOf(raw)}`
  const quoted = QUOTED_RE.exec(haystack)
  if (quoted) return { model: quoted[1].slice(0, MAX_MODEL_ID) }
  if (BARE_RE.test(haystack)) return { model: null }
  return null
}

/** @type {Map<string, {rejected: Set<string>, defaultRejected: string|null}>} */
const ledger = new Map()

export function codexClientKey(binaryPath, version, route) {
  return `${binaryPath || 'codex'}@${version || 'unknown'}#${route || 'unknown'}`
}

export function recordModelRejection(clientKey, model, { wasDefault = false } = {}) {
  if (typeof clientKey !== 'string' || !clientKey || clientKey.length > MAX_CLIENT_KEY) return
  if (typeof model !== 'string' || !model || model.length > MAX_MODEL_ID) return
  let entry = ledger.get(clientKey)
  if (entry) ledger.delete(clientKey) // re-insert below: Map order = recency
  else entry = { rejected: new Set(), defaultRejected: null }
  if (!entry.rejected.has(model) && entry.rejected.size >= MAX_MODELS_PER_CLIENT) {
    entry.rejected.delete(entry.rejected.values().next().value)
  }
  entry.rejected.add(model)
  if (wasDefault) entry.defaultRejected = model
  ledger.set(clientKey, entry)
  while (ledger.size > MAX_CLIENTS) ledger.delete(ledger.keys().next().value)
}

export function rejectedModelsFor(clientKey) {
  return new Set(ledger.get(clientKey)?.rejected || [])
}

/** The model that was this client's DEFAULT when the backend rejected it, or null. */
export function rejectedDefaultFor(clientKey) {
  return ledger.get(clientKey)?.defaultRejected || null
}

/** First roster id that is not excluded or previously rejected for this client; null if none. */
export function suggestFallbackModel(roster, clientKey, exclude = []) {
  const rejected = rejectedModelsFor(clientKey)
  for (const id of Array.isArray(roster) ? roster : []) {
    if (typeof id === 'string' && id && !rejected.has(id) && !exclude.includes(id)) return id
  }
  return null
}

export function _resetModelRejectionsForTests() {
  ledger.clear()
}
