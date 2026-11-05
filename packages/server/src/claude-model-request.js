// Claude model REQUEST enforcement (#7855).
//
// A requested model that the static roster does not list used to be turned into
// `null` ("use the provider default") with only a log line, so a session asked
// for `claude-sonnet-5` could start on whatever the account default was. This
// module is the single place that decides what a requested Claude model id is:
//
//   - roster       the id is in the provider's current allowlist
//   - native       not in the roster, but a well-formed id the claude CLI can
//                  resolve itself: it is forwarded VERBATIM as `--model <id>`
//                  (per-spawn argv only; claude's own global default is never
//                  written), and the running model is confirmed afterwards from
//                  the native journal, never assumed
//   - invalid      cannot be a Claude model id at all: rejected, never defaulted
//
// It also owns the requested-vs-observed comparison. A requested value is a
// configuration, not evidence of what is running.

import { resolvePricingKey, CLAUDE_CLI_MODEL_ALIASES } from './claude-model-catalog.js'

/** Error code carried by the non-fatal mismatch notice a session emits. */
export const MODEL_MISMATCH_CODE = 'MODEL_MISMATCH'

// Short aliases the claude CLI resolves itself: one set, owned by the catalog.
const NATIVE_ALIASES = CLAUDE_CLI_MODEL_ALIASES
const ONE_M = '[1m]'
const MAX_MODEL_ID_LENGTH = 100
// `claude-` + family/version/date segments. Starts with a letter or digit so the
// value can never begin with `-` (argv option injection) and has no whitespace,
// quotes or path separators.
const NATIVE_FULL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]*$/

function stripOneM(id) {
  return id.endsWith(ONE_M) ? id.slice(0, -ONE_M.length) : id
}

/**
 * Classify a requested Claude model id.
 * @param {unknown} model
 * @param {string[]|null} rosterModels the provider's current allowlist
 * @returns {{ kind: 'roster'|'native'|'invalid', model: string|null }}
 */
export function classifyClaudeModelRequest(model, rosterModels) {
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_ID_LENGTH) {
    return { kind: 'invalid', model: null }
  }
  if (Array.isArray(rosterModels) && rosterModels.includes(model)) {
    return { kind: 'roster', model }
  }
  const base = stripOneM(model)
  if (NATIVE_ALIASES.has(base) || NATIVE_FULL_ID_RE.test(base)) {
    return { kind: 'native', model }
  }
  return { kind: 'invalid', model: null }
}

/**
 * Does an OBSERVED running model satisfy a REQUESTED one? Tolerates the CLI's
 * own normalisation: the `[1m]` suffix, a trailing date pin, and a short alias
 * resolving to a full id of that family.
 * @param {string} requested
 * @param {string} observed
 * @returns {boolean}
 */
export function claudeModelMatchesRequest(requested, observed) {
  if (typeof requested !== 'string' || typeof observed !== 'string') return false
  const want = stripOneM(requested)
  const got = stripOneM(observed)
  if (want === got) return true
  if (NATIVE_ALIASES.has(want)) {
    // `default`/`best` mean "whatever the account resolves": nothing to compare.
    if (want === 'default' || want === 'best') return true
    if (want === 'opusplan') return /^claude-(opus|sonnet)-/.test(got)
    return got.startsWith(`claude-${want}-`)
  }
  // A roster short id (`sonnet-5-5`) names its catalog full id (`claude-sonnet-5-5`);
  // compare against that, not a hand-prefixed guess.
  const full = want.startsWith('claude-') ? want : resolvePricingKey(want)
  if (!full) return false
  const fullBase = stripOneM(full)
  if (fullBase === got) return true
  // `claude-sonnet-5` vs `claude-sonnet-5-20261001`: only a pure date pin counts.
  return got.startsWith(`${fullBase}-`) && /^\d{8,}$/.test(got.slice(fullBase.length + 1))
}

/**
 * Build the separated requested/observed evidence record.
 * @param {{ requested: string|null, observed: string|null, observedAt: number|null, now?: number }} p
 */
export function buildModelEvidence({ requested, observed, observedAt, now = Date.now() }) {
  const req = typeof requested === 'string' && requested ? requested : null
  const obs = typeof observed === 'string' && observed ? observed : null
  let status = 'unobserved'
  if (obs) status = req === null ? 'observed' : (claudeModelMatchesRequest(req, obs) ? 'match' : 'mismatch')
  return {
    requested: req,
    requestedSource: req ? 'create_request' : null,
    observed: obs,
    observedSource: obs ? 'native_journal' : null,
    observedAgeMs: obs && typeof observedAt === 'number' ? Math.max(0, now - observedAt) : null,
    status,
  }
}
