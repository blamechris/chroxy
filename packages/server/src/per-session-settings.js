/**
 * Per-session settings registry (#4664).
 *
 * Collapses the boilerplate around the per-session toggle pattern that
 * promptEvaluator (#3185), chroxyContextHint (#3805), and sessionPreamble
 * (#4660) each hand-wrote across SessionManager (createSession forwarding +
 * serializeState + restoreState) and settings-handlers.js (WS handler +
 * broadcast + immediate persist).
 *
 * Three iterations in, the next addition (snippet library, sticky visible
 * prefix in the issue body) would be the 4th time someone hand-writes the
 * same 5 sites and risks dropping the jsonl-subprocess middle layer (see
 * memory `[[feedback_jsonl_subprocess_middle_layer]]`).
 *
 * Scope of this module:
 *
 *   - `definePerSessionSetting()` — declarative shape per knob.
 *   - `PER_SESSION_SETTINGS` — registry of the three existing knobs.
 *   - `forwardPerSessionSettingsToProviderOpts()` — used by
 *     SessionManager.createSession to feed providerOpts.
 *   - `serializePerSessionSettings()` / `restorePerSessionSettings()` —
 *     used by SessionManager.serializeState / restoreState so adding a
 *     new knob takes ONE registry entry instead of a 3-site edit.
 *   - `buildPerSessionSettingHandler()` — generates the WS handler
 *     function for a setting (replaces the three near-identical 50-LOC
 *     handlers in settings-handlers.js).
 *
 * Out of scope (intentionally — keeps the refactor narrow):
 *
 *   - BaseSession field declarations + `_coerceXxxOpt()` validators +
 *     `setX()` setters: each knob still hand-writes these on BaseSession
 *     so the existing tests + `_buildSystemPrompt()` ordering stay
 *     byte-identical. The registry references the setter by NAME so the
 *     handler factory calls `session[setterName](value)` — see
 *     `buildPerSessionSettingHandler`.
 *   - Provider middle layers (cli-session, sdk-session, claude-tui-session,
 *     codex-session, gemini-session, jsonl-subprocess-session) still
 *     destructure each opt and forward to `super({...})`. The list of opt
 *     keys per provider is small and stable; the issue note about
 *     "...opts everywhere" matches the byok/deepseek pattern but
 *     reworking every provider's signature is a bigger refactor than the
 *     issue warrants. Adding `[id]` to that list per provider is a
 *     mechanical lift if/when a new knob lands.
 *   - Dashboard side: still requires the Zustand action +
 *     `message-handler.ts` entry + `store/types.ts` field. The capability
 *     gate / per-knob UI shape (text area vs checkbox) means a single
 *     dashboard helper would over-fit; the README in #4664 calls this
 *     out as "document the checklist" instead of "abstract."
 */

import { createLogger } from './logger.js'
import { resolveSessionOrError, requireSessionMethod, sendSessionError } from './handler-utils.js'

const log = createLogger('per-session-settings')

const REQUIRED_DEFINITION_KEYS = [
  'id',
  'defaultValue',
  'coerce',
  'acceptFromWire',
  'acceptFromConstructor',
  'requestType',
  'broadcastType',
  'setterName',
  'handlerInvalidValueMessage',
  'handlerUnsupportedMessage',
]

/**
 * Define a per-session setting. Returns a frozen object that the helpers
 * below iterate.
 *
 * @param {object} opts
 * @param {string} opts.id — field name on the session AND key on the
 *   serialized state file. Must match the BaseSession field declaration
 *   (e.g. `'promptEvaluator'`).
 * @param {boolean|string} opts.defaultValue — value when the field is
 *   unset on a session (used by serializePerSessionSettings's read-back
 *   guard so a custom provider that skips BaseSession's initialiser still
 *   round-trips a valid wire shape).
 * @param {(v: any) => any} opts.coerce — applied to the session field
 *   when serialising. For booleans: `(v) => !!v`. For strings: a coerce
 *   that returns `''` for non-string values.
 * @param {(v: any) => boolean} opts.acceptFromWire — predicate gating
 *   forwarding into `providerOpts` in `createSession`. Reject is silent —
 *   BaseSession's constructor coerce will apply its own default. Mirrors
 *   the existing `typeof x === 'boolean'` / `typeof x === 'string'`
 *   guards at the createSession call site.
 * @param {(v: any) => boolean} opts.acceptFromConstructor — predicate
 *   gating restoration from the state file. Same shape as
 *   `acceptFromWire` but kept separate so a future setting could relax
 *   either side independently (e.g. accept wider shapes during
 *   restore for forward-compat).
 * @param {string} opts.requestType — wire message `type` field (e.g.
 *   `'set_prompt_evaluator'`).
 * @param {string} opts.broadcastType — wire broadcast `type` field (e.g.
 *   `'prompt_evaluator_changed'`).
 * @param {string} opts.setterName — method name to call on the session
 *   when applying the update. The setter MUST return `true` when state
 *   changed, `false` for redundant / rejected updates. This is the
 *   existing BaseSession setter contract — handlers branch on it to
 *   decide whether to broadcast.
 * @param {string} opts.handlerInvalidValueMessage — user-facing error
 *   for malformed payloads.
 * @param {string} opts.handlerUnsupportedMessage — user-facing error
 *   when the session lacks the setter (defensive — every shipping
 *   provider extends BaseSession, so this only fires for custom
 *   providers).
 * @returns {Readonly<object>}
 */
export function definePerSessionSetting(opts) {
  for (const k of REQUIRED_DEFINITION_KEYS) {
    // `defaultValue: false` is legal — the check is "key present" not "truthy".
    if (!(k in opts)) {
      throw new Error(`definePerSessionSetting: missing required field '${k}'`)
    }
  }
  return Object.freeze({
    id: opts.id,
    defaultValue: opts.defaultValue,
    coerce: opts.coerce,
    acceptFromWire: opts.acceptFromWire,
    acceptFromConstructor: opts.acceptFromConstructor,
    requestType: opts.requestType,
    broadcastType: opts.broadcastType,
    setterName: opts.setterName,
    handlerInvalidValueMessage: opts.handlerInvalidValueMessage,
    handlerUnsupportedMessage: opts.handlerUnsupportedMessage,
  })
}

// --- Concrete settings -------------------------------------------------------

/**
 * `promptEvaluator` (#3185): boolean toggle for the auto-evaluator chain.
 * Default `false` so the manual `evaluate_draft` flow (PR #3089) is the
 * only behaviour until the operator opts in.
 */
const promptEvaluatorDef = definePerSessionSetting({
  id: 'promptEvaluator',
  defaultValue: false,
  coerce: (v) => !!v,
  acceptFromWire: (v) => typeof v === 'boolean',
  acceptFromConstructor: (v) => typeof v === 'boolean',
  requestType: 'set_prompt_evaluator',
  broadcastType: 'prompt_evaluator_changed',
  setterName: 'setPromptEvaluator',
  handlerInvalidValueMessage: 'set_prompt_evaluator requires a boolean `value`',
  handlerUnsupportedMessage: 'This provider does not support promptEvaluator toggling',
})

/**
 * `chroxyContextHint` (#3805): boolean toggle for the canned Chroxy
 * context paragraph prepended to the system prompt so the model can
 * adjust output for mobile clients. Default `false` — existing users
 * see no observable change.
 */
const chroxyContextHintDef = definePerSessionSetting({
  id: 'chroxyContextHint',
  defaultValue: false,
  coerce: (v) => !!v,
  acceptFromWire: (v) => typeof v === 'boolean',
  acceptFromConstructor: (v) => typeof v === 'boolean',
  requestType: 'set_chroxy_context_hint',
  broadcastType: 'chroxy_context_hint_changed',
  setterName: 'setChroxyContextHint',
  handlerInvalidValueMessage: 'set_chroxy_context_hint requires a boolean `value`',
  handlerUnsupportedMessage: 'This provider does not support chroxyContextHint toggling',
})

/**
 * `sessionPreamble` (#4660): user-authored free text prepended to the
 * system prompt every turn. Empty string is the OFF default — non-string
 * inputs coerce to '' so a hand-edited state file with a number / object
 * round-trips safely.
 */
const sessionPreambleDef = definePerSessionSetting({
  id: 'sessionPreamble',
  defaultValue: '',
  // The actual trim + length cap lives in BaseSession's
  // `_coerceSessionPreambleOpt` so the wire-level cap stays the single
  // source of truth. The coerce here is only used by
  // serializePerSessionSettings — at that point the field has already
  // been through BaseSession's coerce, so we only defend against the
  // custom-provider case (no field initialiser).
  coerce: (v) => (typeof v === 'string' ? v : ''),
  acceptFromWire: (v) => typeof v === 'string',
  acceptFromConstructor: (v) => typeof v === 'string',
  requestType: 'set_session_preamble',
  broadcastType: 'session_preamble_changed',
  setterName: 'setSessionPreamble',
  handlerInvalidValueMessage: 'set_session_preamble requires a string `value`',
  handlerUnsupportedMessage: 'This provider does not support sessionPreamble',
})

/**
 * Registry of every per-session setting. Order is the order in which
 * fields appear on the wire payload (alphabetical here so a future
 * `git diff` is predictable). New knobs MUST be added in alphabetical
 * order so review diffs stay tight.
 */
export const PER_SESSION_SETTINGS = Object.freeze([
  chroxyContextHintDef,
  promptEvaluatorDef,
  sessionPreambleDef,
])

// --- SessionManager helpers --------------------------------------------------

/**
 * Forward each registered setting from `source` (a destructured opts
 * object — typically `createSession` arguments) into `providerOpts` when
 * the setting's `acceptFromWire` predicate accepts. Mirrors the per-knob
 * `if (typeof x === 'boolean') providerOpts.x = x` shape at the
 * createSession call site.
 *
 * Mutates `providerOpts` and returns it for chaining.
 *
 * @param {object} providerOpts — target object passed to the provider constructor
 * @param {object} source — object containing per-session-setting values keyed by id
 * @returns {object} the same `providerOpts`
 */
export function forwardPerSessionSettingsToProviderOpts(providerOpts, source) {
  for (const def of PER_SESSION_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(source, def.id)) continue
    const value = source[def.id]
    if (def.acceptFromWire(value)) {
      providerOpts[def.id] = value
    }
    // Reject is silent — BaseSession's coerce applies the default. This
    // matches the existing per-knob behaviour exactly: passing
    // `{ chroxyContextHint: 'not-bool' }` to createSession drops the key,
    // and BaseSession initialises the field to `false`.
  }
  return providerOpts
}

/**
 * Build the serialized per-session-settings dict for `serializeState`.
 * Each value falls back to the setting's `defaultValue` when the session
 * field is `undefined` (custom provider that skipped BaseSession's field
 * initialiser, or a hand-edited state file), then runs through `coerce`
 * to guarantee a wire-shape match (`boolean` for toggles, `string` for
 * preamble). This mirrors the defensive guards the pre-refactor per-knob
 * sites used (`!!entry.session.chroxyContextHint`,
 * `typeof entry.session.sessionPreamble === 'string' ? ... : ''`) while
 * giving `defaultValue` a single observable purpose (Copilot review on
 * PR #4751).
 *
 * @param {object} session — a session instance (BaseSession subclass)
 * @returns {Record<string, any>} — dict ready to spread into the state-file entry
 */
export function serializePerSessionSettings(session) {
  const out = {}
  for (const def of PER_SESSION_SETTINGS) {
    const raw = session[def.id]
    const seed = raw === undefined ? def.defaultValue : raw
    out[def.id] = def.coerce(seed)
  }
  return out
}

/**
 * Build the createSession-arguments dict for `restoreState`. Each value
 * is either forwarded as-is when `acceptFromConstructor` accepts, or
 * `undefined` (so `forwardPerSessionSettingsToProviderOpts` skips it and
 * BaseSession's constructor coerce applies the default).
 *
 * `undefined` (not `null`) is deliberate — `null` would survive the
 * acceptFromConstructor predicate's `typeof` check on some shapes and
 * land in providerOpts as a real value; `undefined` is the universal
 * "key absent" signal that mirrors the pre-refactor per-knob code.
 *
 * @param {object} saved — entry from `state.sessions[i]` in the state file
 * @returns {Record<string, any|undefined>}
 */
export function restorePerSessionSettings(saved) {
  const out = {}
  for (const def of PER_SESSION_SETTINGS) {
    const value = saved?.[def.id]
    if (def.acceptFromConstructor(value)) {
      // sessionPreamble special case: empty string is the OFF default —
      // forward it so a session that the user explicitly cleared
      // round-trips as cleared rather than as the BaseSession default
      // (which happens to be the same value, but the explicit-forward is
      // clearer and matches the pre-refactor behaviour). For string
      // settings with a non-empty default this also matters.
      out[def.id] = value
    } else {
      out[def.id] = undefined
    }
  }
  return out
}

// --- WS handler factory ------------------------------------------------------

/**
 * Build the WS handler function for a per-session setting. Replaces the
 * three near-identical 50-line handlers in settings-handlers.js with one
 * factory call per knob.
 *
 * The handler:
 *   1. Validates the inbound payload with `def.acceptFromWire`.
 *   2. Resolves the bound session (via the standard handler-utils path).
 *   3. Calls `session[def.setterName](value)`.
 *   4. On a real change (setter returns true): broadcasts
 *      `{ type: def.broadcastType, sessionId, value }` to all session
 *      clients AND triggers an immediate `serializeState()` flush.
 *
 * Persistence is an immediate flush rather than the debounced
 * `schedulePersist` so a crash within the debounce window doesn't
 * silently lose the change — matches the existing per-knob behaviour.
 *
 * @param {object} settingDef — definition from definePerSessionSetting
 * @returns {(ws: any, client: any, msg: any, ctx: any) => void}
 */
export function buildPerSessionSettingHandler(settingDef) {
  return function perSessionSettingHandler(ws, client, msg, ctx) {
    if (!settingDef.acceptFromWire(msg?.value)) {
      sendSessionError(ws, ctx, settingDef.handlerInvalidValueMessage)
      return
    }

    const sessionId = msg?.sessionId || client?.activeSessionId
    // Use the same resolveSessionOrError path every other settings handler
    // uses — it enforces session-token binding for bound clients and falls
    // back to `client.activeSessionId` otherwise. Calling
    // `ctx.sessionManager.getSession(sessionId)` directly here would
    // bypass that gate.
    const entry = resolveSessionOrError(ws, ctx, msg, client)
    if (!entry) return

    // Defensive — every shipping provider extends BaseSession which adds
    // the setter. A custom provider that bypasses BaseSession would land
    // here; refuse rather than silently dropping the update.
    if (!requireSessionMethod(ws, ctx, entry, settingDef.setterName, settingDef.handlerUnsupportedMessage)) {
      return
    }
    const setter = entry.session[settingDef.setterName]

    const changed = setter.call(entry.session, msg.value)
    if (!changed) {
      // Setter no-op (redundant set, type-rejected at setter, or a
      // string that trims to the same stored value). No broadcast, no
      // persist — the dashboard already shows the current value.
      return
    }

    // Surface the STORED value (BaseSession coerces trim + cap), not the
    // raw payload, so subscribed clients see a stable shape.
    const storedValue = entry.session[settingDef.id]
    ctx.broadcastToSession(sessionId, {
      type: settingDef.broadcastType,
      sessionId,
      value: storedValue,
    })

    try {
      ctx.sessionManager?.serializeState?.()
    } catch (err) {
      log.warn(`Failed to persist ${settingDef.id} for ${sessionId}: ${err?.message || err}`)
    }
  }
}

