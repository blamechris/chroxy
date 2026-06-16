/**
 * Shared stateless message handler functions.
 *
 * Each function takes a raw WebSocket message and optional context,
 * returning a state patch or transformed data. No side effects — consumers
 * apply the patches to their own store however they see fit.
 *
 * These extract the shared logic that was duplicated between the mobile app
 * and web dashboard message handlers.
 */

import type {
  ActiveTool,
  ChatMessage,
  ConnectedClient,
  ConversationSummary,
  CumulativeUsage,
  DevPreview,
  ModelInfo,
  PendingBackgroundShell,
  SearchResult,
  TranscriptBackgroundTask,
  ServerError,
  SessionInfo,
  SessionIntervention,
  SessionRole,
  WebTask,
} from '../types'
import { MAX_SESSION_INTERVENTIONS, nextMessageId, stripAnsi } from '../utils'
import { parseUserInputMessage } from '../user-input-handler'
// #5039: ErrorPartialCost surfaced on the optional `partialCost` slot of
// `handleError`'s return shape so dashboard + app can render the
// PR #5037 partial-cost sub-line under the error toast.
import type { ErrorPartialCost } from '../cost-format'
// Established Zod-handler pattern (#3138).
import { ServerAvailableModelsEntrySchema, ServerNotificationPrefsSchema } from '@chroxy/protocol'

// Shared field parsers + session resolution live in ./_shared (audit P2-3).
import {
  parseStringField,
  parseRawStringField,
  parseEnumField,
  resolveSessionId,
} from './_shared'
import type { SessionPatch } from './_shared'
// ---------------------------------------------------------------------------
// Shared helpers (parseStringField / parseRawStringField / parseEnumField /
// resolveSessionId) and the SessionPatch type now live in ./_shared.ts
// (audit P2-3, imported above). resolveSessionId + SessionPatch are part of
// the barrel's public surface, so they are re-exported here; the three field
// parsers were always private and are intentionally not re-exported.
// ---------------------------------------------------------------------------
export { resolveSessionId }
export type { SessionPatch }

// ---------------------------------------------------------------------------
// model_changed
// ---------------------------------------------------------------------------

/** Extract the model value from a `model_changed` message. */
export function handleModelChanged(msg: Record<string, unknown>): { model: string | null } {
  return { model: parseStringField(msg, 'model') }
}

// ---------------------------------------------------------------------------
// permission_mode_changed
// ---------------------------------------------------------------------------

/** Extract the permission mode from a `permission_mode_changed` message. */
export function handlePermissionModeChanged(msg: Record<string, unknown>): { mode: string | null } {
  return { mode: parseStringField(msg, 'mode') }
}

// ---------------------------------------------------------------------------
// available_permission_modes
// ---------------------------------------------------------------------------

export interface PermissionMode {
  id: string
  label: string
  /**
   * #4019: optional human-readable explainer for the mode (e.g. "Auto-approve
   * every tool call without prompting"). The server's PERMISSION_MODES table
   * exports a description for every mode; we keep the field optional here so
   * older servers that pre-date the description plumbing still parse cleanly.
   */
  description?: string
}

/** Validate and extract permission modes from an `available_permission_modes` message. */
export function handleAvailablePermissionModes(
  msg: Record<string, unknown>,
): PermissionMode[] | null {
  if (!Array.isArray(msg.modes)) return null
  return (msg.modes as unknown[])
    .filter(
      (m): m is { id: string; label: string; description?: unknown } =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as { id: unknown }).id === 'string' &&
        typeof (m as { label: unknown }).label === 'string',
    )
    .map((m) => {
      const out: PermissionMode = { id: m.id, label: m.label }
      // #4019: pass through description when present + string-typed. Non-
      // strings (number, object, etc.) get dropped at the type boundary
      // rather than poisoning the typed shape downstream consumers see.
      if (typeof m.description === 'string') out.description = m.description
      return out
    })
}

// ---------------------------------------------------------------------------
// session_updated
// ---------------------------------------------------------------------------

/**
 * Apply a `session_updated` message to a sessions list.
 * Returns the updated list, or null if no update was needed.
 */
export function handleSessionUpdated(
  msg: Record<string, unknown>,
  sessions: SessionInfo[],
): SessionInfo[] | null {
  const updatedId = msg.sessionId as string
  const updatedName = msg.name as string
  if (!updatedId || !updatedName) return null
  return sessions.map((s) =>
    s.sessionId === updatedId ? { ...s, name: updatedName } : s,
  )
}

// ---------------------------------------------------------------------------
// confirm_permission_mode
// ---------------------------------------------------------------------------

export interface PendingPermissionConfirm {
  mode: string
  warning: string
}

/**
 * Extract the mode + warning text from a `confirm_permission_mode` message.
 *
 * Returns the pending-confirmation payload when the server included a valid
 * `mode` string, or null when the message is malformed (caller should leave
 * existing pending state alone in that case — matches both clients' prior
 * inline behavior).
 */
export function handleConfirmPermissionMode(
  msg: Record<string, unknown>,
): PendingPermissionConfirm | null {
  const mode = typeof msg.mode === 'string' ? msg.mode : null
  if (!mode) return null
  const warning = typeof msg.warning === 'string' ? msg.warning : 'Are you sure?'
  return { mode, warning }
}

// ---------------------------------------------------------------------------
// claude_ready
// ---------------------------------------------------------------------------

/**
 * State patch for `claude_ready`.
 *
 * `stoppedAt`/`stoppedCode` are reset to null here so the quiet "Session
 * stopped." status strip introduced for #4879 clears the moment the
 * server reports the child is ready again (typically because the user
 * sent another message after tapping Stop). This is purely additive for
 * sessions that were never stopped — both fields stay null end-to-end.
 */
export function handleClaudeReady(msg?: Record<string, unknown>): {
  claudeReady: true
  stoppedAt: null
  stoppedCode: null
  transcriptBackgroundTasks?: TranscriptBackgroundTask[]
  scheduledWakeup?: { at: number; reason: string } | null
} {
  const patch: ReturnType<typeof handleClaudeReady> = {
    claudeReady: true,
    stoppedAt: null,
    stoppedCode: null,
  }
  // #5431: enriched ready — `backgroundTasks` present (even as []) means the
  // server computed a fresh transcript snapshot, so it is authoritative for
  // BOTH fields: a snapshot with tasks but no wakeup means any previously
  // stored wakeup has fired/been superseded. Absent means a pre-#5431 server
  // or no transcript access — leave the stored fields untouched.
  if (Array.isArray(msg?.backgroundTasks)) {
    patch.transcriptBackgroundTasks = msg.backgroundTasks.filter(
      (t): t is TranscriptBackgroundTask =>
        !!t && typeof t === 'object' &&
        typeof (t as TranscriptBackgroundTask).toolUseId === 'string' &&
        ['bash', 'agent', 'monitor'].includes((t as TranscriptBackgroundTask).kind) &&
        typeof (t as TranscriptBackgroundTask).description === 'string' &&
        Number.isFinite((t as TranscriptBackgroundTask).startedAt),
    )
    const wakeup = msg.scheduledWakeup as { at?: unknown; reason?: unknown } | undefined
    patch.scheduledWakeup =
      wakeup && typeof wakeup.at === 'number' && typeof wakeup.reason === 'string'
        ? { at: wakeup.at, reason: wakeup.reason }
        : null
  }
  return patch
}

// ---------------------------------------------------------------------------
// agent_idle / agent_busy
// ---------------------------------------------------------------------------

/** State patch for `agent_idle`.
 *
 * Also clears `streamingMessageId` so the stop button hides if the agent
 * reaches idle without a closing `stream_end`/`result` (abnormal Agent SDK
 * shutdown). Pre-#3170 the 5s safety timer in `sendInput` recovered this
 * case; post-#3170 the timer is bypassed once `tool_start` bumps the value,
 * so `agent_idle` is the remaining recovery hook. See #3171.
 *
 * #4308 — also clears `activeTools` as a safety net: a missed `tool_result`
 * (server crash mid-turn, dropped broadcast, etc.) would otherwise leave a
 * phantom "Running X" indicator visible for the rest of the session. Idle
 * is a guaranteed turn-boundary, so it's the right place to drop any
 * still-tracked in-flight tools.
 */
export function handleAgentIdle(): {
  isIdle: true
  streamingMessageId: null
  activeTools: ActiveTool[]
} {
  return { isIdle: true, streamingMessageId: null, activeTools: [] }
}

/** State patch for `agent_busy`. */
export function handleAgentBusy(): { isIdle: false } {
  return { isIdle: false }
}

// ---------------------------------------------------------------------------
// thinking_level_changed
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'default' | 'high' | 'max'

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['default', 'high', 'max'])

/** Extract and validate the thinking level from a `thinking_level_changed` message. */
export function handleThinkingLevelChanged(msg: Record<string, unknown>): { level: ThinkingLevel } {
  const raw = parseStringField(msg, 'level') || 'default'
  const level = VALID_THINKING_LEVELS.has(raw as ThinkingLevel) ? (raw as ThinkingLevel) : 'default'
  return { level }
}

// ---------------------------------------------------------------------------
// Cost-budget handlers (budget_warning / budget_exceeded / budget_resumed /
// budget_resume_ack) live in ./budget.ts (audit P2-3 split). Re-exported here
// so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './budget'

// ---------------------------------------------------------------------------
// Plan-mode handlers (plan_started / plan_ready / inactivity_warning) live in
// ./plan.ts (audit P2-3 split). Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './plan'

// ---------------------------------------------------------------------------
// multi_question_intervention (#4653)
//
// Server fires this event when ClaudeTuiSession's PreToolUse handler sees a
// multi-question AskUserQuestion — i.e. the exact condition the permission-
// hook bash script (#4648) denies on. The dashboard renders a per-session
// counter + a first-time inline notice so the user can tell chroxy intervened
// (rather than wondering why the model is suddenly being polite).
//
// Builder shape (not a flat patch): the new array is computed from the
// existing one — dedup-by-toolUseId so a stuck model re-emitting the same
// multi-q payload doesn't inflate the counter falsely, and ring-cap at
// MAX_SESSION_INTERVENTIONS so long-running sessions don't accumulate memory.
// ---------------------------------------------------------------------------

/** Builder result for handlers whose patch depends on existing intervention state. */
export interface SessionInterventionBuilder {
  /** Session ID the patch targets (may be null if no session context). */
  sessionId: string | null
  /**
   * `true` when this intervention is the FIRST one in this session (the caller
   * uses it to gate a one-time inline notice / system ChatMessage — repeat
   * denials should just bump the counter, not re-spam the chat). Always `false`
   * when the toolUseId duplicates an existing entry (no append happens).
   */
  isFirst: boolean
  /** Apply the builder to the session's current interventions list. */
  applyTo: (current: SessionIntervention[]) => { interventions: SessionIntervention[] }
}

/**
 * Parse a `multi_question_intervention` session_event payload (wire shape
 * `{ toolUseId, questionCount, reason: 'multi_question', timestamp }` — see
 * `ClaudeTuiSession._emitToolHookEvent` in packages/server) and produce a
 * builder that appends a {@link SessionIntervention} entry to the targeted
 * session's `interventions` array.
 *
 * Returns null when the payload is malformed (missing/non-string toolUseId,
 * non-finite questionCount). Callers should leave existing state alone — the
 * counter just doesn't tick, no fallback "unknown intervention" entry is
 * inserted (those would lie about what happened).
 *
 * Dedup-by-toolUseId: the caller's `applyTo` returns the existing array
 * unchanged when an entry with the same `toolUseId` is already present (the
 * known-stuck-model re-emit pattern from #4666 / #4668). When that happens
 * `isFirst` is also false even on the very first event the session sees, so
 * the inline-notice gate stays consistent with what's actually appended.
 *
 * Ring-cap at MAX_SESSION_INTERVENTIONS: when the new array would exceed the
 * cap, the oldest entry is dropped (`.slice(-MAX)` — FIFO).
 */
export function handleMultiQuestionIntervention(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionInterventionBuilder | null {
  const toolUseIdRaw = msg.toolUseId
  if (typeof toolUseIdRaw !== 'string' || toolUseIdRaw.length === 0) return null

  const countRaw = msg.questionCount
  // `questionCount` from the server is always >= 2 (the permission-hook
  // only denies multi-question forms — single-q is the happy path). Mirror
  // the protocol Zod schema (`ServerMultiQuestionInterventionSchema`) here
  // as defence in depth: floor BEFORE the threshold check so 1.9 doesn't
  // sneak past as 1, then drop anything < 2 so a malformed payload doesn't
  // render "0 questions" or "1 question" in the counter UI (both would lie
  // about what happened — the hook only fires for >= 2).
  if (typeof countRaw !== 'number' || !Number.isFinite(countRaw)) {
    return null
  }
  const count = Math.floor(countRaw)
  if (count < 2) return null

  const tsRaw = msg.timestamp
  // Mirror the protocol schema's `timestamp >= 0` bound — epoch 0 is
  // explicitly allowed so a clock-skewed dev environment doesn't bounce
  // the event off the wire. Only fall back to Date.now() when the payload
  // is missing or non-numeric, NOT when timestamp is legitimately 0.
  const timestamp =
    typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw >= 0
      ? Math.floor(tsRaw)
      : Date.now()

  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    isFirst: false, // recomputed by applyTo based on the current list
    applyTo: (current) => {
      const dup = current.some((iv) => iv.toolUseId === toolUseIdRaw)
      if (dup) {
        // Stuck-model re-emit — return the array unchanged so the counter
        // stays accurate and React's referential-equality skips a re-render.
        return { interventions: current }
      }
      const entry: SessionIntervention = {
        kind: 'multi_question',
        toolUseId: toolUseIdRaw,
        count,
        timestamp,
      }
      const next = [...current, entry]
      // Ring-cap from the OLDEST side — newest entry always stays so the
      // user sees the most recent intervention reflected in the counter.
      const capped = next.length > MAX_SESSION_INTERVENTIONS
        ? next.slice(-MAX_SESSION_INTERVENTIONS)
        : next
      return { interventions: capped }
    },
  }
}

/**
 * #4653 helper — runs the builder against a current array and returns BOTH
 * the new array AND whether this intervention was the session's first (i.e.
 * the previous array was empty AND this call actually appended an entry).
 * Lets the call site gate a one-time inline notice without re-walking the
 * dedup state itself.
 */
export function applyInterventionBuilder(
  builder: SessionInterventionBuilder,
  current: SessionIntervention[],
): { interventions: SessionIntervention[]; isFirst: boolean } {
  const wasEmpty = current.length === 0
  const result = builder.applyTo(current)
  const actuallyAppended = result.interventions.length > current.length
  return {
    interventions: result.interventions,
    isFirst: wasEmpty && actuallyAppended,
  }
}

// ---------------------------------------------------------------------------
// dev_preview / dev_preview_stopped
//
// These handlers are stateful in a way the others aren't: the new devPreviews
// array depends on the existing array (dedup-by-port for `dev_preview`, filter
// for `dev_preview_stopped`). To keep a single sessionId resolution path
// (matching plan_started/plan_ready), the handlers return a builder shape:
// `sessionId` resolved as usual, plus an `applyTo(current)` function the call
// site invokes with the looked-up array. This avoids the double-resolution
// pattern that would otherwise be needed if `currentPreviews` were a
// pre-handler argument.
// ---------------------------------------------------------------------------

/** Builder result for handlers whose patch depends on existing state. */
export interface DevPreviewBuilder {
  /** Session ID the patch targets (may be null if no session context). */
  sessionId: string | null
  /** Apply the builder to the session's current devPreviews. */
  applyTo: (current: DevPreview[]) => { devPreviews: DevPreview[] }
}

/**
 * Resolve target session and produce a builder that appends (or replaces by
 * port) a dev-preview entry. Both clients dedupe by port: a new preview for
 * an already-tracked port replaces the existing entry, otherwise it is
 * appended after the filtered remainder.
 *
 * Behaviour-preserving: `msg.port` and `msg.url` are forwarded verbatim with
 * the same unsafe cast (`port as number, url as string`) the prior inline
 * implementations used. Tightening to runtime validation would be a behaviour
 * change and is out of scope for the #2661 mechanical migration.
 */
export function handleDevPreview(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): DevPreviewBuilder {
  const preview: DevPreview = {
    port: msg.port as number,
    url: msg.url as string,
  }
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => ({
      devPreviews: [...current.filter((p) => p.port !== preview.port), preview],
    }),
  }
}

/**
 * Resolve target session and produce a builder that removes the dev-preview
 * entry matching `msg.port`. If no entry matches the previews list is returned
 * unchanged (matches both clients' prior `filter`-based inline implementation).
 *
 * Behaviour-preserving: `msg.port` is cast verbatim (`port as number`) without
 * runtime validation, matching the prior inline behaviour.
 */
export function handleDevPreviewStopped(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): DevPreviewBuilder {
  const stoppedPort = msg.port as number
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => ({
      devPreviews: current.filter((p) => p.port !== stoppedPort),
    }),
  }
}

// ---------------------------------------------------------------------------
// auth_ok / auth_fail / key_exchange_ok / server_mode
// ---------------------------------------------------------------------------

/**
 * Server mode advertised by the WS protocol.
 *
 * Historically the server could in principle have run in a `'terminal'`
 * (PTY/tmux) mode, but the wire protocol only ever emits `'cli'` — the
 * `ServerAuthOkSchema` is a `z.literal('cli')` and the server hardcodes
 * `this.serverMode = 'cli'` (see #4810). The shared handler validates the
 * field and returns null for any non-`'cli'` value so the call site can
 * surface a hardened "unknown server" branch.
 */
export type ServerMode = 'cli'

const VALID_SERVER_MODES: readonly ServerMode[] = ['cli']

/**
 * Validated `webFeatures` map advertised by the server. Each flag is a hard
 * boolean — the parser coerces missing/malformed values to `false` so a
 * misshapen wire message can't accidentally light up a feature gate. Both
 * clients fall back to `{ available: false, remote: false, teleport: false }`
 * when the field is absent so consumer call sites get a uniform shape.
 */
export interface AuthOkWebFeatures {
  available: boolean
  remote: boolean
  teleport: boolean
}

/**
 * Typed payload extracted from an `auth_ok` message.
 *
 * Side-effects (reset replay flags, save connection, start heartbeat, kick
 * off key exchange, register push tokens, sync ConnectionLifecycleStore,
 * update lastConnectedUrl, etc.) stay at the call site — every one of those
 * is platform-specific (the mobile app has push notifications + biometric
 * setup; the dashboard owns lastConnectedUrl tracking) and out of scope for
 * the data-extraction seam.
 *
 * #4766 — fields below were previously decoded inline in both clients,
 * which let `streamStallTimeoutMs` silently drop on mobile (StreamStallChip
 * couldn't humanise the headline phrase). The parser now owns the full
 * wire-shape decode; consumers assemble their platform-specific state
 * patches around the shared payload. The connected-clients roster is
 * parsed separately in `parseConnectedClients` (sibling helper) so the
 * roster shape doesn't bloat `AuthOkPayload`.
 */
export interface AuthOkPayload {
  /** Validated server mode (`'cli'`, or null when unknown). */
  serverMode: ServerMode | null
  /** Raw `cwd` string (NOT trimmed — empty string preserved). */
  sessionCwd: string | null
  /** Raw `defaultCwd` string. */
  defaultCwd: string | null
  /** Raw `serverVersion` string. */
  serverVersion: string | null
  /** Raw `latestVersion` string. */
  latestVersion: string | null
  /** Raw `serverCommit` string. */
  serverCommit: string | null
  /** Validated integer >= 1, else null. */
  protocolVersion: number | null
  /**
   * #3760 — server-advertised inactivity timeout in ms. Validated positive
   * finite number, else null (older servers omit the field; consumers fall
   * back to their built-in reference timeout).
   */
  resultTimeoutMs: number | null
  /**
   * #4497 / #4477 — server-advertised stream-stall window in ms. 0 is the
   * protocol's explicit "disabled" sentinel and is treated as absent so the
   * chip falls back to the generic phrase. Was previously dropped on mobile
   * (#4766 latent bug — fixed by unifying the parser).
   */
  streamStallTimeoutMs: number | null
  /** Raw encryption directive from the server (`'required'` or other). */
  encryption: string | null
  /**
   * `sessionToken` issued via the pairing flow. Only the mobile app currently
   * consumes this; the dashboard ignores it. Exposed in the shared payload so
   * the wire-shape decode lives in one place.
   */
  sessionToken: string | null
  /** Self-identifying clientId issued by the server, null when missing/malformed. */
  myClientId: string | null
  /** Validated webFeatures flags with hardened defaults — never null. */
  webFeatures: AuthOkWebFeatures
  /**
   * #4560 / #3272 — server-advertised capability map. Keys are feature names,
   * values are strict booleans (`true` only when the wire value was literally
   * `true`). Empty object when the field is absent so consumers can blindly
   * spread it into state without an existence check.
   */
  serverCapabilities: Record<string, boolean>
  /**
   * #5555 (eager key exchange) — the server's ephemeral X25519 public key,
   * present only when this client sent `eagerPublicKey` + `eagerSalt` in its
   * `auth` message AND the server honoured the eager path. When non-null the
   * client derives the shared key immediately and skips the discrete
   * `key_exchange` round trip; null means fall back to the discrete handshake
   * (old server, encryption disabled, or no eager fields were sent). Same
   * validation as `handleKeyExchangeOk`'s `publicKey`.
   */
  serverPublicKey: string | null
  /**
   * #5536 (E2E key pinning) — the server's Ed25519 signature (base64) over the
   * eager `serverPublicKey`, present only on the eager path when the daemon has
   * a pinned identity. A client that pinned this daemon's identity public key
   * (at pairing time) MUST verify this signature against the pinned key before
   * keying off `serverPublicKey`; a mismatch is a refusal (MITM key swap). Null
   * when absent (unpinned daemon / discrete path) — see the connect-flow's
   * pin-or-TOFU decision. Same string validation as `serverPublicKey`.
   */
  serverKeySig: string | null
  /**
   * #5555 (auth_bootstrap) — the static permission-mode enum folded into
   * auth_ok so a new client doesn't have to wait for the discrete
   * `available_permission_modes` burst frame. Validated with the same shape
   * checks as `handleAvailablePermissionModes`. Null when the field is absent
   * (older server) — consumers then fall back to the discrete frame.
   */
  availablePermissionModes: PermissionMode[] | null
}

const DEFAULT_WEB_FEATURES: AuthOkWebFeatures = {
  available: false,
  remote: false,
  teleport: false,
}

/** Validated positive finite number, else null. Used for both timeout fields. */
function parsePositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Extract typed server-context fields from an `auth_ok` message. */
export function handleAuthOk(msg: Record<string, unknown>): AuthOkPayload {
  const protoRaw = msg.protocolVersion
  const protocolVersion =
    typeof protoRaw === 'number' &&
    Number.isFinite(protoRaw) &&
    Number.isInteger(protoRaw) &&
    protoRaw >= 1
      ? protoRaw
      : null

  // webFeatures: object → boolean-coerced subset; otherwise hardened defaults.
  const webFeaturesRaw = msg.webFeatures
  const webFeatures: AuthOkWebFeatures =
    webFeaturesRaw && typeof webFeaturesRaw === 'object' && !Array.isArray(webFeaturesRaw)
      ? {
          available: !!(webFeaturesRaw as Record<string, unknown>).available,
          remote: !!(webFeaturesRaw as Record<string, unknown>).remote,
          teleport: !!(webFeaturesRaw as Record<string, unknown>).teleport,
        }
      : { ...DEFAULT_WEB_FEATURES }

  // capabilities: object → strict-true boolean map; absent/non-object → {}.
  // Skip prototype-pollution-prone keys (`__proto__`, `constructor`,
  // `prototype`) so a malformed server payload can't mutate Object.prototype
  // even though both consumers spread the map into Zustand state (which
  // doesn't re-walk the prototype chain at runtime, but defence-in-depth is
  // cheap here). Capability gates are fail-closed elsewhere — dropping a
  // dangerous key just leaves the gate unset, which is the safe default.
  const capabilitiesRaw = msg.capabilities
  const serverCapabilities: Record<string, boolean> = {}
  if (capabilitiesRaw && typeof capabilitiesRaw === 'object' && !Array.isArray(capabilitiesRaw)) {
    for (const [k, v] of Object.entries(capabilitiesRaw)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      serverCapabilities[k] = v === true
    }
  }

  return {
    serverMode: parseEnumField(msg, 'serverMode', VALID_SERVER_MODES),
    sessionCwd: parseRawStringField(msg, 'cwd'),
    defaultCwd: parseRawStringField(msg, 'defaultCwd'),
    serverVersion: parseRawStringField(msg, 'serverVersion'),
    latestVersion: parseRawStringField(msg, 'latestVersion'),
    serverCommit: parseRawStringField(msg, 'serverCommit'),
    protocolVersion,
    resultTimeoutMs: parsePositiveFiniteNumber(msg.resultTimeoutMs),
    streamStallTimeoutMs: parsePositiveFiniteNumber(msg.streamStallTimeoutMs),
    encryption: parseRawStringField(msg, 'encryption'),
    sessionToken: parseRawStringField(msg, 'sessionToken'),
    myClientId: parseRawStringField(msg, 'clientId'),
    webFeatures,
    serverCapabilities,
    // #5555 — null for missing/empty/non-string, exactly the "fall back to
    // discrete key_exchange" signal the call sites key off. Mirrors
    // handleKeyExchangeOk's `typeof raw === 'string' && raw` validation so an
    // empty-string serverPublicKey is treated as absent, not a usable key.
    serverPublicKey:
      typeof msg.serverPublicKey === 'string' && msg.serverPublicKey ? msg.serverPublicKey : null,
    // #5536 — identity signature over the eager serverPublicKey. Null for
    // missing/empty/non-string (unpinned daemon / discrete path).
    serverKeySig:
      typeof msg.serverKeySig === 'string' && msg.serverKeySig ? msg.serverKeySig : null,
    // #5555 — reuse the discrete-frame parser on the folded field. Absent /
    // non-array → null so the consumer falls back to the discrete frame.
    availablePermissionModes: Array.isArray(msg.availablePermissionModes)
      ? handleAvailablePermissionModes({ modes: msg.availablePermissionModes })
      : null,
  }
}

/**
 * Parse the `connectedClients` array from an `auth_ok` message, marking the
 * caller's own entry via `myClientId`.
 *
 * Behaviour-preserving — matches the inline `filter().map()` block previously
 * duplicated across app and dashboard (#4766):
 *   - drops entries that aren't objects or lack a string `clientId`
 *   - narrows `deviceType` to the validated enum, falling back to `'unknown'`
 *   - falls back `deviceName` to null and `platform` to `'unknown'` for
 *     missing/non-string values
 *   - sets `isSelf: true` only when the entry's clientId matches `myClientId`
 *
 * Returns `[]` when `rawClients` isn't an array — call sites no longer need
 * the `Array.isArray` guard.
 */
export function parseConnectedClients(
  rawClients: unknown,
  myClientId: string | null,
): ConnectedClient[] {
  if (!Array.isArray(rawClients)) return []
  return rawClients
    .filter(
      (c: unknown): c is { clientId: string } =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).clientId === 'string',
    )
    .map((c) => {
      const entry = c as Record<string, unknown>
      const deviceType: ConnectedClient['deviceType'] = VALID_DEVICE_TYPES.has(
        entry.deviceType as ConnectedClient['deviceType'],
      )
        ? (entry.deviceType as ConnectedClient['deviceType'])
        : 'unknown'
      return {
        clientId: c.clientId,
        deviceName: typeof entry.deviceName === 'string' ? entry.deviceName : null,
        deviceType,
        platform: typeof entry.platform === 'string' ? entry.platform : 'unknown',
        isSelf: c.clientId === myClientId,
      }
    })
}

/**
 * Extract the failure reason from an `auth_fail` message, falling back to
 * `'Invalid token'` when missing or non-string. Matches the prior inline
 * `(msg.reason as string) || 'Invalid token'` guard.
 */
export function handleAuthFail(msg: Record<string, unknown>): { reason: string } {
  const raw = msg.reason
  const reason = typeof raw === 'string' && raw ? raw : 'Invalid token'
  return { reason }
}

/**
 * Extract the validated `publicKey` from a `key_exchange_ok` message.
 *
 * Returns null when the field is missing, empty, or non-string — matches the
 * prior inline guard `if (!msg.publicKey || typeof msg.publicKey !== 'string')`.
 *
 * The actual key-derivation side effects (deriveSharedKey, deriveConnectionKey,
 * setting `_encryptionState`, sending post-auth WS messages) stay at the call
 * site — they touch crypto state and the websocket directly.
 */
export function handleKeyExchangeOk(msg: Record<string, unknown>): { publicKey: string | null; serverKeySig: string | null } {
  const raw = msg.publicKey
  const sig = msg.serverKeySig
  return {
    publicKey: typeof raw === 'string' && raw ? raw : null,
    // #5536 — Ed25519 signature (base64) over publicKey, present when the daemon
    // has a pinned identity. Null when absent (unpinned daemon / older server).
    serverKeySig: typeof sig === 'string' && sig ? sig : null,
  }
}

/**
 * Extract and validate the mode enum from a `server_mode` message.
 *
 * Returns null for unknown modes; the call site is expected to surface an
 * "Invalid Server Mode" alert (matches dashboard's prior inline behaviour).
 * The wire protocol only emits `'cli'` (#4810) — any other value is treated
 * as null.
 */
export function handleServerMode(msg: Record<string, unknown>): { mode: ServerMode | null } {
  return { mode: parseEnumField(msg, 'mode', VALID_SERVER_MODES) }
}

// ---------------------------------------------------------------------------
// Checkpoint handlers (checkpoint_created / checkpoint_list /
// checkpoint_restored) live in ./checkpoint.ts (audit P2-3 split). Re-exported
// here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './checkpoint'

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_MESSAGE = 'An unexpected server error occurred'

/**
 * Parse an `error` message into its display fields and a system ChatMessage.
 *
 * Mirrors the inline implementations in both clients:
 * - `code` defaults to "UNKNOWN" when missing/non-string
 * - `message` is ANSI-stripped and trimmed; if the result is empty (including
 *   cases where a non-empty input becomes empty after stripping ANSI codes
 *   and whitespace), it falls back to the default error string. This matches
 *   the app's `(stripAnsi(...).trim() || ...)` pattern and is a safe widening
 *   of the dashboard's behaviour.
 * - `requestId` is exposed so callers can correlate against in-flight
 *   requests (e.g. `set_permission_mode` rejection handling on the app).
 *
 * Toast/banner placement and request-correlation logic stays at the call
 * site — this handler only normalises the payload.
 */
export function handleError(msg: Record<string, unknown>): {
  code: string
  message: string
  requestId: string | null
  /**
   * #4178: optional severity hint from the server. `false` means the
   * envelope is non-fatal — the session is alive and the dashboard
   * should render a yellow warning toast rather than the destructive
   * red toast used for STREAM_ERROR / ABORT. `true` or `undefined` are
   * both treated as fatal by consumers (so missing / typo'd values
   * surface loudly instead of silently degrading).
   */
  fatal: boolean | undefined
  /**
   * #5039: optional partial-cost snapshot from PR #5037. When the
   * error fired AFTER any parent rounds + subagent Task calls had
   * already billed, byok-session folds those totals onto the error
   * envelope (`usage` / `cost`) so the user can see what the failed
   * turn cost. Only populated when `cost` is a finite non-negative
   * number — undefined / NaN / Infinity / negative / non-number all
   * resolve to null, matching the strict-finite gate that
   * `_trackUsage` applies on the success path (#5038). Tokens default
   * to 0 when missing/non-finite so a subscription-billed provider
   * (cost present, usage absent) still surfaces a cost-only line.
   */
  partialCost: ErrorPartialCost | null
} {
  const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN'
  const rawMessage =
    typeof msg.message === 'string' ? stripAnsi(msg.message).trim() : ''
  const message = rawMessage.length > 0 ? rawMessage : DEFAULT_ERROR_MESSAGE
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  // Strict boolean check — a typo (e.g. fatal: 'false' string) must NOT
  // degrade to a warning toast. Treat anything non-boolean as undefined.
  const fatal = typeof msg.fatal === 'boolean' ? msg.fatal : undefined
  // #5039: parse optional partial usage + cost (PR #5037 wire shape).
  // `cost` is the gate — null/undefined/NaN/Infinity/non-number/negative
  // all mean "no usable partial info", matching the strict-finite check
  // on the success-path `_trackUsage` fold (#5038). Tokens are
  // best-effort: any field that isn't a finite non-negative number
  // falls to 0 so a single bogus counter can't poison the rest of the
  // display.
  const rawCost = msg.cost
  const partialCost: ErrorPartialCost | null =
    typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
      ? {
          costUsd: rawCost,
          inputTokens: pickFiniteTokenCount(msg.usage, 'input_tokens'),
          outputTokens: pickFiniteTokenCount(msg.usage, 'output_tokens'),
          cacheReadTokens: pickFiniteTokenCount(msg.usage, 'cache_read_input_tokens'),
          cacheCreationTokens: pickFiniteTokenCount(msg.usage, 'cache_creation_input_tokens'),
        }
      : null
  // `systemMessage` was dropped from the return shape (#3112) — neither
  // call site (`dashboard:store/message-handler.ts:case 'error'`,
  // `app:store/message-handler.ts:case 'error'`) consumed it.
  return {
    code,
    message,
    requestId,
    fatal,
    partialCost,
  }
}

/**
 * #5039: best-effort extract of a single token-count field from the
 * untyped server `error.usage` payload. Non-object/null usage and any
 * non-finite / negative numeric falls to 0 — see `handleError` JSDoc
 * for the contract.
 */
function pickFiniteTokenCount(rawUsage: unknown, key: string): number {
  if (rawUsage == null || typeof rawUsage !== 'object') return 0
  const v = (rawUsage as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

// ---------------------------------------------------------------------------
// session_error
// ---------------------------------------------------------------------------

/**
 * Build the default bound-token mismatch hint surfaced to users (#2904).
 * This helper provides the shared/dashboard wording used when normalising
 * `SESSION_TOKEN_MISMATCH`; other clients may intentionally present different
 * copy at the call site (the app's modal mentions "from the desktop" and is
 * built inline rather than consuming this string).
 */
function boundSessionMismatchMessage(boundSessionName: string): string {
  return `This device is paired to session "${boundSessionName}" and can only talk to that session. Disconnect and scan a fresh QR code to create new sessions.`
}

/**
 * Parse a `session_error` message.
 *
 * Two distinct shapes flow through the same WS message type:
 *
 * 1. `category === 'crash'` — the session crashed server-side. Returns a
 *    `sessionPatch` flipping the target session's health to `'crashed'`.
 *    Callers additionally push a session notification (platform-specific UX
 *    that stays at the call site).
 *
 * 2. Everything else — a user-visible error. Returns `message` (rewritten to
 *    the bound-session hint when the server signals SESSION_TOKEN_MISMATCH
 *    with a `boundSessionName`) and a system ChatMessage. Callers display the
 *    error via their preferred surface (web toast, native Alert, etc.).
 *
 * The two shapes are disjoint: when `category === 'crash'`, `message` and
 * `systemMessage` are null; otherwise `sessionPatch` is null.
 */
export function handleSessionError(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): {
  category: string | null
  code: string | null
  boundSessionName: string | null
  message: string | null
  sessionPatch: SessionPatch | null
  /**
   * #4982 — server-supplied id of the session the client addressed before
   * the server rejected it as stale (most commonly `SESSION_NOT_FOUND`
   * after `session-manager.restoreState()` regenerated all ids on a
   * daemon restart). Surfaced so the dashboard SessionNotFoundChip can
   * confirm to the operator which id was lost. Only forwarded when the
   * wire payload carries it as a non-empty string; otherwise null.
   */
  attemptedSessionId: string | null
} {
  const category = typeof msg.category === 'string' ? msg.category : null
  const code = typeof msg.code === 'string' ? msg.code : null
  const boundSessionName =
    typeof msg.boundSessionName === 'string' && msg.boundSessionName.length > 0
      ? msg.boundSessionName
      : null
  // #4982 — only forward when present + a non-empty string. Defense in
  // depth against malformed wire payloads (matches the attemptedResumeId
  // trimming/guard branch in handleMessage).
  const attemptedSessionId =
    typeof msg.attemptedSessionId === 'string' && msg.attemptedSessionId.trim().length > 0
      ? msg.attemptedSessionId.trim()
      : null

  if (category === 'crash') {
    return {
      category,
      code,
      boundSessionName,
      message: null,
      sessionPatch: {
        sessionId: resolveSessionId(msg, activeSessionId),
        patch: { health: 'crashed' },
      },
      attemptedSessionId,
    }
  }

  let message: string
  if (code === 'SESSION_TOKEN_MISMATCH' && boundSessionName) {
    message = boundSessionMismatchMessage(boundSessionName)
  } else {
    message = parseStringField(msg, 'message') ?? 'Unknown error'
  }

  // `systemMessage` was dropped from the return shape (#3112) — neither
  // call site consumed it (dashboard surfaces via `addServerError`/alert,
  // app surfaces via `Alert.alert`/native modal).
  return {
    category,
    code,
    boundSessionName,
    message,
    sessionPatch: null,
    attemptedSessionId,
  }
}

// ---------------------------------------------------------------------------
// session_stopped (#4879)
// ---------------------------------------------------------------------------

/**
 * Parse a `session_stopped` message into a `SessionPatch` that flips the
 * target session into the quiet "stopped" UX state.
 *
 * The server emits `session_stopped` when `CliSession` exits cleanly after
 * a user-initiated Stop (wire path wired in #4868 — CliSession `stopped` →
 * SessionManager → ws-forwarding → ServerSessionStoppedSchema). This is a
 * positive confirmation distinct from `session_error` (which flips
 * `health: 'crashed'` and surfaces a loud red banner): the operator
 * tapped Stop, the child process did indeed stop.
 *
 * The patch sets `stoppedAt` to `now()` so renderers can show a calm
 * informational status strip ("Session stopped." / with optional
 * "(exit N)" suffix for non-zero exits). `stoppedCode` carries the child
 * process exit code when the server reported one — null otherwise. Both
 * fields are cleared (back to null) by `handleClaudeReady`'s patch when
 * the server restarts the child after the operator's next input.
 *
 * The caller is responsible for applying the patch to its store. No
 * notification / toast side effects are baked in here; surfaces vary by
 * platform (dashboard: info toast via `addInfoNotification` per #4878;
 * mobile app: inline status strip in `SessionScreen` per #4879). The
 * `now` parameter is injected so tests can pin the timestamp without
 * touching `Date.now()`.
 */
export function handleSessionStopped(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  now: () => number = Date.now,
): SessionPatch {
  // `code` is optional on the wire (ServerSessionStoppedSchema declares it
  // as `z.number().int()`). Mirror that integer constraint here so a
  // buggy producer can't poison `stoppedCode` with a fractional value
  // (e.g. rendering "exit 1.5") or with NaN / Infinity. `Number.isInteger`
  // already excludes all three failure modes; matches the existing
  // protocol-int validation pattern used elsewhere in this file (see
  // `protoRaw` around line 798). Preserve 0 explicitly — it's the common
  // clean-SIGINT-exit case and is a meaningful signal, not a "missing"
  // value.
  const code = typeof msg.code === 'number' && Number.isInteger(msg.code) ? msg.code : null
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      stoppedAt: now(),
      stoppedCode: code,
    },
  }
}

// ---------------------------------------------------------------------------
// log_entry
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const VALID_LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])

export interface LogEntry {
  id: string
  component: string
  level: LogLevel
  message: string
  timestamp: number
  sessionId?: string
}

/**
 * Parse a `log_entry` message into a typed `LogEntry`.
 *
 * - `component` defaults to `"unknown"` when missing/non-string
 * - `level` is validated against the `LogLevel` enum, falling back to `"info"`
 * - `message` is ANSI-stripped (logs from the server can contain colour codes)
 * - `timestamp` defaults to `Date.now()` when not a number
 * - `sessionId` is omitted entirely when not a string (matches inline impl)
 *
 * Today only the dashboard consumes `log_entry`; the app does not subscribe to
 * server logs. Extracting the parser here lets the app adopt without
 * duplicating logic later.
 */
export function handleLogEntry(msg: Record<string, unknown>): {
  entry: LogEntry
} {
  const component = typeof msg.component === 'string' ? msg.component : 'unknown'
  const level: LogLevel = VALID_LOG_LEVELS.has(msg.level as LogLevel)
    ? (msg.level as LogLevel)
    : 'info'
  const message = typeof msg.message === 'string' ? stripAnsi(msg.message) : ''
  const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
  const entry: LogEntry = {
    id: nextMessageId('log'),
    component,
    level,
    message,
    timestamp,
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
  return { entry }
}

// ---------------------------------------------------------------------------
// Multi-client coordination
// ---------------------------------------------------------------------------

const VALID_DEVICE_TYPES = new Set<ConnectedClient['deviceType']>([
  'phone',
  'tablet',
  'desktop',
  'unknown',
])

/** Result of a `client_joined` handler invocation. */
export interface ClientJoinedResult {
  /** The newly-parsed client (always `isSelf: false`). */
  client: ConnectedClient
  /** Updated roster with the client upserted (existing entry by `clientId` is replaced). */
  roster: ConnectedClient[]
}

/**
 * Parse a `client_joined` message and produce an upserted roster.
 *
 * Returns null when the message is malformed (no client, missing/non-string
 * `clientId`) — caller leaves existing roster alone in that case, matching
 * both clients' prior inline `if (!msg.client || ...) break;` guard.
 *
 * The shared handler returns ONLY the universal data (parsed client + new
 * roster list). Platform-specific UX (system-message broadcast on connect,
 * per-store side stores) stays at the call site.
 */
export function handleClientJoined(
  msg: Record<string, unknown>,
  currentRoster: ConnectedClient[],
): ClientJoinedResult | null {
  const rawClient = msg.client
  if (!rawClient || typeof rawClient !== 'object') return null
  const c = rawClient as Record<string, unknown>
  if (typeof c.clientId !== 'string') return null

  const deviceType = VALID_DEVICE_TYPES.has(c.deviceType as ConnectedClient['deviceType'])
    ? (c.deviceType as ConnectedClient['deviceType'])
    : 'unknown'

  const client: ConnectedClient = {
    clientId: c.clientId,
    deviceName: typeof c.deviceName === 'string' ? c.deviceName : null,
    deviceType,
    platform: typeof c.platform === 'string' ? c.platform : 'unknown',
    isSelf: false,
  }

  const roster = [
    ...currentRoster.filter((existing) => existing.clientId !== client.clientId),
    client,
  ]
  return { client, roster }
}

/** Result of a `client_left` handler invocation. */
export interface ClientLeftResult {
  /** The clientId that left (echoed from the message for convenience). */
  clientId: string
  /** The roster entry being removed, if any (caller may want it for UX labels). */
  departingClient: ConnectedClient | undefined
  /** Roster with the entry filtered out. */
  roster: ConnectedClient[]
}

/**
 * Parse a `client_left` message and produce a filtered roster.
 *
 * Returns null when `msg.clientId` is missing or non-string — matches both
 * clients' prior `if (typeof msg.clientId !== 'string') break;` guard.
 */
export function handleClientLeft(
  msg: Record<string, unknown>,
  currentRoster: ConnectedClient[],
): ClientLeftResult | null {
  if (typeof msg.clientId !== 'string') return null
  const clientId = msg.clientId
  const departingClient = currentRoster.find((c) => c.clientId === clientId)
  const roster = currentRoster.filter((c) => c.clientId !== clientId)
  return { clientId, departingClient, roster }
}

/** Parsed payload for a `primary_changed` message. */
export interface PrimaryChanged {
  /**
   * Target session id. May be null (missing/non-string), the literal `'default'`
   * (server-wide default), or any other session id. The caller decides how to
   * route — both clients currently special-case `null`/`'default'` to apply
   * globally and any other value to apply per-session.
   */
  sessionId: string | null
  /** New primary client id, or null if missing/non-string. */
  primaryClientId: string | null
}

/**
 * Extract the routing payload for a `primary_changed` message.
 *
 * Pure data extraction — does NOT consult the active session id (the message
 * always carries the target sessionId or omits it deliberately). The caller
 * decides whether to apply the change globally or to a session.
 */
export function handlePrimaryChanged(msg: Record<string, unknown>): PrimaryChanged {
  return {
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    primaryClientId: typeof msg.clientId === 'string' ? msg.clientId : null,
  }
}

// ---------------------------------------------------------------------------
// session_role (#5589 / #5281)
// ---------------------------------------------------------------------------

export interface SessionRoleInfo {
  /**
   * Target session id. Unlike `primary_changed`, the server always sends
   * `session_role` with an explicit `sessionId` (it is broadcast per-session
   * via `_broadcastToSession`); null only on a malformed payload.
   */
  sessionId: string | null
  /**
   * The session's primary client id, or null when the session is unclaimed
   * (nobody-until-claim — e.g. after the previous primary disconnected).
   */
  primaryClientId: string | null
  /**
   * THIS client's role, derived from `primaryClientId` vs the client's own id:
   *   - `'primary'`   — this client owns the session (drives input)
   *   - `'observer'`  — another client owns it (read-only while running; can
   *                     still adopt an idle session per #5589)
   *   - `'unclaimed'` — nobody owns it yet
   */
  role: SessionRole
}

/**
 * Extract THIS client's role from a `session_role` message (#5589).
 *
 * Pure derivation: the server names the primary (`primaryClientId`, null when
 * unclaimed); the client computes its own role by comparing that to its own
 * id (`myClientId`, learned from `auth_ok`). Identical across both clients —
 * the storage of the result diverges (the app's dedicated `useMultiClientStore`
 * vs the dashboard's flat + per-session slots), so only this parse is shared,
 * mirroring `handlePrimaryChanged`.
 *
 * When `myClientId` is unknown (null — e.g. a pre-auth race) the role is
 * `'unclaimed'` if the slot is empty, else `'observer'` (we cannot be the
 * primary if we don't yet know our own id).
 */
export function handleSessionRole(
  msg: Record<string, unknown>,
  myClientId: string | null,
): SessionRoleInfo {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const primaryClientId =
    typeof msg.primaryClientId === 'string' ? msg.primaryClientId : null
  let role: SessionRole
  if (!primaryClientId) {
    role = 'unclaimed'
  } else if (myClientId && primaryClientId === myClientId) {
    role = 'primary'
  } else {
    role = 'observer'
  }
  return { sessionId, primaryClientId, role }
}

// ---------------------------------------------------------------------------
// session_list
// ---------------------------------------------------------------------------

/**
 * Validate a `session_list` message and return the parsed sessions array.
 *
 * Returns null when `msg.sessions` is missing or non-array — matches both
 * clients' prior `if (Array.isArray(msg.sessions))` guard.
 *
 * Per-element shape is NOT validated — the cast to `SessionInfo[]` matches
 * the inline behaviour in both clients prior to this migration. Tightening
 * would be a behaviour change beyond the scope of #2661.
 *
 * Heavy state-merge logic (GC of removed sessions, flat-field sync, auto-
 * subscribe, conversationId persistence) stays at the call site — those
 * concerns are platform-specific (the dashboard syncs `activeModel` against
 * `availableModels`; the app additionally auto-subscribes via WS and persists
 * the last conversationId to disk).
 */
export function handleSessionList(msg: Record<string, unknown>): SessionInfo[] | null {
  if (!Array.isArray(msg.sessions)) return null
  return msg.sessions as unknown as SessionInfo[]
}

/**
 * Default (and maximum) chunk size for `subscribe_sessions` messages
 * produced by {@link buildSessionListPatches}. Matches the protocol-level
 * `SubscribeSessionsSchema` `.max(20)` bound (client→server message — the
 * server validates incoming `subscribe_sessions` payloads against this
 * cap). Consumers may pass a SMALLER override via the optional
 * `subscribeChunkSize` parameter; {@link chunkSubscribeSessionIds} clamps
 * larger / non-integer / non-positive values to this constant so a buggy
 * caller can never produce payloads the server will reject.
 *
 * Co-located here (rather than per-consumer) so the app and dashboard
 * can't drift out of sync — see #4767 acceptance criteria.
 */
export const SESSION_LIST_SUBSCRIBE_CHUNK_SIZE = 20

/**
 * Per-session patch maps + derived bookkeeping produced by
 * {@link buildSessionListPatches}. See that function's doc-comment for the
 * full call-site recipe.
 */
export interface SessionListPatches {
  /** Parsed sessions array (same reference returned by {@link handleSessionList}). */
  sessionList: SessionInfo[]
  /**
   * Session ids present in `prevSessionStateIds` but missing from the new
   * snapshot. Consumers GC persisted state + `sessionStates[id]` for these,
   * and decide their own "active session was removed" fallback policy.
   */
  removedIds: string[]
  /**
   * Session ids in the new snapshot that are NOT in `prevSessionStateIds`.
   * Consumers seed `sessionStates[id]` for these (typically with their
   * platform-specific `createEmptySessionState()`); the dashboard's
   * `isBusy → isIdle` seed (#4639) stays at the call site because it
   * mutates the consumer's own state shape.
   */
  newSessionIds: string[]
  /**
   * `sessionId → conversationId` for every session whose snapshot has a
   * non-null `conversationId`. Consumers gate on `sessionStates[id]` and
   * call `updateSession(id, ss => ss.conversationId !== cid ? { conversationId: cid } : {})`.
   */
  conversationIdPatches: Map<string, string>
  /**
   * `sessionId → CumulativeUsage snapshot` for every session whose
   * snapshot has a non-undefined `cumulativeUsage` (#4073 / #4074).
   * Consumers gate on `sessionStates[id]` and use
   * {@link cumulativeUsageEquals} to short-circuit no-op patches.
   */
  cumulativeUsagePatches: Map<string, CumulativeUsage>
  /**
   * `sessionId → PendingBackgroundShellsBuilder` for every session in the
   * snapshot — defaults to an empty `pending` list when the snapshot omits
   * the field (#4307 wire compat). Consumers gate on `sessionStates[id]`
   * and call `builder.applyTo(current)`; the builder's reference-equality
   * short-circuit suppresses no-op re-renders.
   */
  backgroundShellBuilders: Map<string, PendingBackgroundShellsBuilder>
  /**
   * Non-active session ids chunked into `subscribe_sessions` payloads. Each
   * chunk's length <= `SESSION_LIST_SUBSCRIBE_CHUNK_SIZE` (default 20 — the
   * server schema's max ids per message). Consumers iterate and send one
   * `subscribe_sessions` message per chunk; empty array means nothing to send.
   *
   * Consumers that don't auto-subscribe (currently the dashboard) ignore this
   * field; it's surfaced here so both clients can adopt the same chunking
   * logic without re-duplicating it later (#4767).
   */
  subscribeChunks: string[][]
}

/**
 * Reference-comparison-friendly equality check for two
 * {@link CumulativeUsage} snapshots. Returns `true` when both are non-null
 * and all six tracked fields (`inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `turnsBilled`) match.
 *
 * Two nulls return `false` — there is no current snapshot to short-circuit
 * against, so the caller would apply the (also-null) candidate as a no-op
 * write anyway. The pre-existing inline checks both gated on
 * `current && ...`, so this preserves that exact behaviour.
 *
 * Centralised here so both consumers stay in sync if the
 * {@link CumulativeUsage} shape grows a new field (#4767 AC).
 */
export function cumulativeUsageEquals(
  a: CumulativeUsage | null | undefined,
  b: CumulativeUsage | null | undefined,
): boolean {
  if (!a || !b) return false
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.costUsd === b.costUsd &&
    a.turnsBilled === b.turnsBilled
  )
}

/**
 * Build the per-session patch maps + derived bookkeeping a `session_list`
 * consumer needs to apply the snapshot. Centralises the GC + new-session
 * seeding + conversationId sync + #4073/#4074 cumulativeUsage seeding +
 * #4307 pendingBackgroundShells seeding + `subscribe_sessions` chunking
 * logic that previously lived inline in both the app and dashboard
 * `case 'session_list'` branches (#4767).
 *
 * Returns `null` when {@link handleSessionList} rejects the message —
 * consumers `break` out of the case in that path, preserving prior
 * behaviour.
 *
 * Behaviour preservation contract:
 * - `removedIds` filters `prevSessionStateIds` by membership in the new id
 *   set — identical to both prior inline computations
 *   (app L1209-1211 / dashboard L2140-2142).
 * - `newSessionIds` lists ids in the new snapshot that aren't already in
 *   `prevSessionStateIds`, in snapshot order. Mirrors both prior
 *   `for (const s of sessionList) if (!newStates[s.sessionId]) ...` loops
 *   (app L1236-1241 / dashboard L2206-2213).
 * - `conversationIdPatches` includes every session with a truthy
 *   `conversationId` — the consumer's `ss.conversationId !== cid` short-
 *   circuit stays at the call site (existing `updateSession` callback).
 * - `cumulativeUsagePatches` includes every session whose snapshot has a
 *   non-undefined `cumulativeUsage` field — same gate as the prior inline
 *   `if (s.cumulativeUsage && ...)` (app L1258 / dashboard L2246). Use
 *   {@link cumulativeUsageEquals} at the call site for the six-field
 *   no-op short-circuit (centralised here per #4767 AC).
 * - `backgroundShellBuilders` always includes every session (per the
 *   #4307 wire contract: omitted = []); each builder's `applyTo` does the
 *   per-shell reference-equality short-circuit. The consumer still gates
 *   on `sessionStates[id]` to skip sessions it hasn't seeded yet, matching
 *   both prior inline `if (!get().sessionStates[s.sessionId]) continue;`
 *   guards (app L1283 / dashboard L2275).
 * - `subscribeChunks` filters out `activeSessionId` then chunks by
 *   `SESSION_LIST_SUBSCRIBE_CHUNK_SIZE`. Matches app L1308-1318. When
 *   nothing to subscribe (empty list or only active id present), the
 *   array is empty so consumers can iterate without an outer guard.
 *
 * Consumer-specific behaviour stays at the call site:
 * - The app's `loadLastConversationId()` auto-resume on empty list +
 *   reconnect (L1196-1207).
 * - The dashboard's `activeModel` lookup against `availableModels`
 *   (L2188-2197) and `isBusy → isIdle` resync (#4639, L2223-2230).
 * - Both consumers' `clearPersistedSession(prevId)` call per removed id.
 * - The app's `persistLastConversationId(activeConversationId)` after seeding.
 * - The dashboard's "active session removed → copy flat fields into the
 *   top-level patch" recovery (L2159-2180) — this touches consumer-
 *   specific top-level state slots so it stays in the consumer's `set()`.
 */
export function buildSessionListPatches(
  msg: Record<string, unknown>,
  prevSessionStateIds: readonly string[],
  activeSessionId: string | null,
  subscribeChunkSize: number = SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
): SessionListPatches | null {
  const sessionList = handleSessionList(msg)
  if (!sessionList) return null

  const newIdSet = new Set<string>()
  for (const s of sessionList) {
    if (s && typeof s.sessionId === 'string') newIdSet.add(s.sessionId)
  }

  const prevIdSet = new Set(prevSessionStateIds)

  const removedIds: string[] = []
  for (const prev of prevSessionStateIds) {
    if (!newIdSet.has(prev)) removedIds.push(prev)
  }

  const newSessionIds: string[] = []
  const conversationIdPatches = new Map<string, string>()
  const cumulativeUsagePatches = new Map<string, CumulativeUsage>()
  const backgroundShellBuilders = new Map<string, PendingBackgroundShellsBuilder>()

  for (const s of sessionList) {
    if (!s || typeof s.sessionId !== 'string') continue
    const sid = s.sessionId
    if (!prevIdSet.has(sid)) newSessionIds.push(sid)
    if (s.conversationId) conversationIdPatches.set(sid, s.conversationId)
    if (s.cumulativeUsage) cumulativeUsagePatches.set(sid, s.cumulativeUsage)
    backgroundShellBuilders.set(
      sid,
      handleBackgroundWorkChanged(
        { sessionId: sid, pending: s.pendingBackgroundShells ?? [] },
        activeSessionId,
      ),
    )
  }

  const subscribeChunks = chunkSubscribeSessionIds(sessionList, activeSessionId, subscribeChunkSize)

  return {
    sessionList,
    removedIds,
    newSessionIds,
    conversationIdPatches,
    cumulativeUsagePatches,
    backgroundShellBuilders,
    subscribeChunks,
  }
}

/**
 * Filter out `activeSessionId` from `sessionList` and chunk the remaining
 * ids into `subscribe_sessions`-bound payloads.
 *
 * Extracted from {@link buildSessionListPatches} so consumers whose active
 * session changes after the initial patch computation (e.g. the active
 * session was removed and the consumer fell back to the first surviving
 * id) can recompute the chunks against the final active id without
 * re-running the full patch builder.
 *
 * Returns `[]` when there are no non-active ids to subscribe (empty
 * sessionList, or list contains only the active session). Defensive
 * against malformed entries (missing/non-string sessionId — skipped).
 *
 * `subscribeChunkSize` is normalised to an integer in
 * `[1, SESSION_LIST_SUBSCRIBE_CHUNK_SIZE]`:
 * - Non-integers (e.g. `0.5`, `2.5`) would cause `i += chunkSize` to walk
 *   off the grid and `slice(i, i + chunkSize)` to coerce via truncation,
 *   producing duplicated / skipped ids — `Math.floor` removes the
 *   fractional part defensively.
 * - Values `<= 0` or non-numeric fall back to the default constant.
 * - Values `> SESSION_LIST_SUBSCRIBE_CHUNK_SIZE` are clamped down so a
 *   buggy caller can never emit a chunk the server's
 *   `SubscribeSessionsSchema.max(20)` would reject.
 */
export function chunkSubscribeSessionIds(
  sessionList: SessionInfo[],
  activeSessionId: string | null,
  subscribeChunkSize: number = SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
): string[][] {
  const requested =
    typeof subscribeChunkSize === 'number' &&
    Number.isFinite(subscribeChunkSize) &&
    subscribeChunkSize > 0
      ? Math.floor(subscribeChunkSize)
      : SESSION_LIST_SUBSCRIBE_CHUNK_SIZE
  // Floor may produce 0 if 0 < value < 1 (e.g. 0.5) — fall back to default.
  const normalised = requested >= 1 ? requested : SESSION_LIST_SUBSCRIBE_CHUNK_SIZE
  // Clamp to the protocol-enforced cap so callers can't produce
  // payloads that violate SubscribeSessionsSchema.max(20).
  const chunkSize = Math.min(normalised, SESSION_LIST_SUBSCRIBE_CHUNK_SIZE)
  const ids: string[] = []
  for (const s of sessionList) {
    if (!s || typeof s.sessionId !== 'string') continue
    if (s.sessionId !== activeSessionId) ids.push(s.sessionId)
  }
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize))
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Session-status / client-focus handlers (session_context, session_timeout,
// session_restore_failed, session_warning, session_switched,
// client_focus_changed) live in ./session-status.ts (audit P2-3 split).
// Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './session-status'

// ---------------------------------------------------------------------------
// conversation_id
// ---------------------------------------------------------------------------

/** Parsed payload for a `conversation_id` message. */
export interface ConversationIdPayload {
  /**
   * Raw `sessionId` from the message — NOT resolved against an active session.
   *
   * The prior inline implementation read `msg.sessionId as string` and gated
   * the patch on `if (convSessionId && get().sessionStates[convSessionId])`,
   * meaning a missing `sessionId` skipped the update entirely (no fallback to
   * the active session). Preserving that behaviour: this handler returns null
   * when the field is missing or non-string, and the call site is expected to
   * skip the patch in that case.
   */
  sessionId: string | null
  /** Validated `conversationId` string, or null when missing/non-string. */
  conversationId: string | null
}

/**
 * Parse a `conversation_id` message into a `(sessionId, conversationId)` pair.
 *
 * Both clients update the target session's `conversationId` field when the
 * server announces a fresh conversation handle. The session-existence guard
 * (`sessionStates[targetId]`) and the actual `updateSession` call stay at the
 * call site — this handler only normalises the payload.
 */
export function handleConversationId(
  msg: Record<string, unknown>,
): ConversationIdPayload {
  return {
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    conversationId:
      typeof msg.conversationId === 'string' ? msg.conversationId : null,
  }
}

// ---------------------------------------------------------------------------
// conversations_list
// ---------------------------------------------------------------------------

/**
 * Parse a `conversations_list` message into a typed array.
 *
 * App-only handler today — the dashboard's `conversations_list` already lives
 * in the dispatcher map via a small inline function and currently differs in
 * what state slices it touches (`conversationHistoryError` is app-only;
 * `useConversationStore` mirroring is app-only). The shared parser only
 * normalises the array shape so future dashboard adoption can layer on its
 * own state mutation.
 *
 * Per-element shape is NOT validated — the cast to `ConversationSummary[]`
 * matches the inline behaviour in the app prior to this migration. Tightening
 * would be a behaviour change beyond the scope of #2661.
 */
export function handleConversationsList(msg: Record<string, unknown>): {
  conversations: ConversationSummary[]
} {
  const conversations: ConversationSummary[] = Array.isArray(msg.conversations)
    ? (msg.conversations as ConversationSummary[])
    : []
  return { conversations }
}

// ---------------------------------------------------------------------------
// history_replay_start / history_replay_end
//
// Both clients track a module-level `_receivingHistoryReplay` flag (or, in the
// app, `_ctx.receivingHistoryReplay`) that gates how subsequent messages are
// processed. The shared handlers normalise the payload — extracting the
// strict `fullHistory === true` check and resolving the target sessionId for
// the messages-clearing branch — but the actual flag mutation stays at the
// call site (it lives in module state, not store state).
// ---------------------------------------------------------------------------

/** Parsed payload for a `history_replay_start` message. */
export interface HistoryReplayStartPayload {
  /** Always `true` — the flag value the client should set on entry. */
  receivingHistoryReplay: true
  /**
   * Strict `msg.fullHistory === true` check (matches both clients' prior
   * inline guard). Only triggers the messages-clearing branch when literally
   * `true`; truthy values like `1` or `'true'` do NOT count.
   */
  fullHistory: boolean
  /**
   * Resolved target session id for the full-history clearing branch.
   *
   * Falls back to `activeSessionId` when the message omits `sessionId`,
   * matching `(msg.sessionId as string) || get().activeSessionId` exactly —
   * including no whitespace trimming, so `'  sess-1  '` is preserved verbatim
   * and an empty string `''` falls back to `activeSessionId`. The call site
   * only consults this when `fullHistory` is true and only applies the patch
   * when the resolved id maps to an existing session in its store.
   */
  sessionId: string | null
  /**
   * #5555.3 — the server's latest per-session history seq, carried on the
   * `history_replay_start` frame so the client can advance its cursor even for
   * an EMPTY delta replay (already-current reconnect). null when absent
   * (older server) — the client then derives the cursor from per-entry
   * `historySeq` instead.
   */
  latestSeq: number | null
}

/**
 * Parse a `history_replay_start` message.
 *
 * Returns the new flag value (`receivingHistoryReplay: true`), the strict
 * `fullHistory` flag, the resolved target session id for the clearing branch,
 * and (#5555.3) the server's `latestSeq` for cursor advancement. Module-level
 * flag mutation, transient-state clearing, the no-blank-flash reconcile, and
 * the existence guard on the resolved sessionId stay at the call site.
 *
 * Note: this handler intentionally does NOT use `resolveSessionId()` because
 * the prior inline logic was `(msg.sessionId as string) || activeSessionId`,
 * which preserves whitespace. Switching to the trimming helper would change
 * behaviour (e.g. `'  sess-1  '` would be normalised), and this migration is
 * mechanical.
 */
export function handleHistoryReplayStart(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): HistoryReplayStartPayload {
  const rawSessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId : null
  return {
    receivingHistoryReplay: true,
    fullHistory: msg.fullHistory === true,
    sessionId: rawSessionId || activeSessionId,
    latestSeq:
      typeof msg.latestSeq === 'number' && Number.isFinite(msg.latestSeq)
        ? msg.latestSeq
        : null,
  }
}

/** Parsed payload for a `history_replay_end` message. */
export interface HistoryReplayEndPayload {
  /** Always `false` — the flag value the client should set on exit. */
  receivingHistoryReplay: false
}

/**
 * Parse a `history_replay_end` message.
 *
 * Returns the new flag value (`receivingHistoryReplay: false`). Module-level
 * flag mutation and the post-replay prompt-cleanup pass stay at the call site
 * (they touch session state via the consumer's update helper).
 */
export function handleHistoryReplayEnd(): HistoryReplayEndPayload {
  return { receivingHistoryReplay: false }
}

// ---------------------------------------------------------------------------
// permission_request / permission_resolved / permission_expired /
// permission_timeout / permission_rules_updated
// ---------------------------------------------------------------------------

/**
 * Permission rule shape advertised by the server in `permission_rules_updated`.
 *
 * The handler does NOT validate element shape — the cast matches the inline
 * `as PermissionRule[]` both clients used prior to the migration. Tightening
 * would be a behaviour change and is out of scope for #2661.
 */
export interface PermissionRule {
  tool: string
  decision: 'allow' | 'deny'
  pattern?: string
}

/**
 * Parsed payload from a `permission_request` message.
 *
 * App-only handler today (the dashboard parses inline against its own session
 * routing rules); extracted here so dashboard can adopt later. Returns the
 * verbatim wire fields with the same shallow validation the inline impls used.
 *
 * Per-field notes (behaviour-preserving):
 * - `requestId`: null when missing/non-string (caller skips the prompt).
 * - `tool` / `description`: null when missing/non-string. The app uses these
 *   to build the prompt content string `"${tool}: ${description}"` with a
 *   "Permission required" fallback at the call site.
 * - `input`: the raw message payload's `input` when it is a non-null
 *   non-array object; null otherwise (#3123). The declared
 *   `Record<string, unknown> | null` type now matches the runtime guard —
 *   arrays are rejected so the type is no longer a shallow lie.
 * - `sessionId`: explicit sessionId from the message (no active-session
 *   fallback here — pending-permission routing is platform-specific).
 * - `remainingMs`: numeric value forwarded verbatim, including 0; null for
 *   missing or non-number values. The call site converts to absolute
 *   `expiresAt = Date.now() + remainingMs` only when non-null.
 *
 * Side effects (split streaming response, "Allow for Session" provider gate,
 * push session notification) all stay at the call site — they touch
 * platform-specific state.
 */
export interface PermissionRequestPayload {
  requestId: string | null
  tool: string | null
  description: string | null
  input: Record<string, unknown> | null
  sessionId: string | null
  remainingMs: number | null
}

export function handlePermissionRequest(
  msg: Record<string, unknown>,
): PermissionRequestPayload {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  const tool = typeof msg.tool === 'string' ? msg.tool : null
  const description = typeof msg.description === 'string' ? msg.description : null
  const input =
    msg.input && typeof msg.input === 'object' && !Array.isArray(msg.input)
      ? (msg.input as Record<string, unknown>)
      : null
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const remainingMs = typeof msg.remainingMs === 'number' ? msg.remainingMs : null
  return { requestId, tool, description, input, sessionId, remainingMs }
}

/**
 * Parsed payload from a `permission_resolved` message.
 *
 * App-only handler today (dashboard parses inline). Returns the requestId and
 * decision string verbatim — the decision is NOT validated against an enum to
 * match the prior inline `msg.decision as string` cast. The call site searches
 * all session states for the matching prompt and applies its own UX side
 * effects (clearing pending state, dismissing notification banners).
 */
export interface PermissionResolvedPayload {
  requestId: string | null
  decision: string | null
}

export function handlePermissionResolved(
  msg: Record<string, unknown>,
): PermissionResolvedPayload {
  return {
    requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
    decision: typeof msg.decision === 'string' ? msg.decision : null,
  }
}

/**
 * Parse a `permission_expired` message into the requestId plus a system
 * ChatMessage (mirrors `handleBudgetExceeded`'s shape).
 *
 * The system message text is the same line both clients append to the
 * matching prompt today: `"(Expired — this permission was already handled or
 * timed out)"`. The handler does NOT decide whether to apply it — the call
 * site gates on `requestId` and on whether the prompt was already resolved
 * (the dashboard's "already handled" race-suppression path stays platform-
 * specific). Banner dismissal also stays at the call site.
 */
export function handlePermissionExpired(msg: Record<string, unknown>): {
  requestId: string | null
  systemMessage: ChatMessage
} {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  return {
    requestId,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: '(Expired — this permission was already handled or timed out)',
      timestamp: Date.now(),
    },
  }
}

/**
 * Parse a `permission_timeout` message (app-only today) into the requestId,
 * the tool name, and a system ChatMessage describing the auto-deny.
 *
 * `tool` defaults to `"permission"` when missing/non-string — matches the
 * inline `typeof msg.tool === 'string' ? msg.tool : 'permission'` guard. The
 * system message follows the inline pattern
 * `"Permission for \"${tool}\" was auto-denied (timed out)"`.
 *
 * The call site uses this to:
 *   - mark matching prompts in any session as auto-denied (UI-side),
 *   - dismiss matching notification banners,
 *   - push a `ServerError` toast with the same wording.
 */
export function handlePermissionTimeout(msg: Record<string, unknown>): {
  requestId: string | null
  tool: string
  systemMessage: ChatMessage
} {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  const tool = typeof msg.tool === 'string' ? msg.tool : 'permission'
  return {
    requestId,
    tool,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `Permission for "${tool}" was auto-denied (timed out)`,
      timestamp: Date.now(),
    },
  }
}

/**
 * Parsed payload from a `permission_rules_updated` message.
 *
 * `rules` is the array as-sent by the server when it is an array, else an
 * empty array. Per-element shape is NOT validated — matches the inline
 * `Array.isArray(msg.rules) ? (msg.rules as PermissionRule[]) : []` cast both
 * clients used. Tightening would be a behaviour change and is out of scope.
 *
 * `sessionId` is the message's explicit sessionId or null; the call site
 * applies its own active-session fallback (the app and dashboard both default
 * to `activeSessionId` when missing).
 */
export interface PermissionRulesUpdatedPayload {
  sessionId: string | null
  rules: PermissionRule[]
}

export function handlePermissionRulesUpdated(
  msg: Record<string, unknown>,
): PermissionRulesUpdatedPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const rules: PermissionRule[] = Array.isArray(msg.rules)
    ? (msg.rules as unknown as PermissionRule[])
    : []
  return { sessionId, rules }
}

// ---------------------------------------------------------------------------
// File-operation result handlers (directory_listing / file_listing /
// file_content / write_file_result) live in ./file.ts (audit P2-3 split).
// Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './file'

// ---------------------------------------------------------------------------
// slash_commands / agent_list / provider_list / file_list
//
// All four are list-replacement handlers: validate `Array.isArray(...)`, then
// hand the array back to the caller for `set({ ...: arr as Concrete[] })`.
// `slash_commands` and `agent_list` additionally apply a session-id guard (skip
// when `msg.sessionId` is set AND `activeSessionId` is set AND they differ).
//
// Element shape is NOT validated by these handlers — the cast to the concrete
// list element type stays at the call site (matches both clients' prior inline
// behaviour). The mobile app additionally tightens `provider_list` element
// validation; that extra filtering stays at the call site, layered on top of
// the array returned here.
// ---------------------------------------------------------------------------

/**
 * Apply the `if (msg.sessionId && active && msg.sessionId !== active) skip`
 * guard used by `slash_commands` and `agent_list` — **broadcast-guard semantics**.
 *
 * Returns true when the caller should DROP the message because the explicit
 * `msg.sessionId` does not match the user's current `activeSessionId`. When
 * either side is missing, the message is allowed through (either because it
 * was a server-wide broadcast or because there is no active session yet to
 * mismatch against).
 *
 * Distinct from {@link resolveSessionId}, which uses **fallback semantics**
 * (default to the active session when the message omits the tag). This guard
 * is the right primitive for list-replacement events (`slash_commands`,
 * `agent_list`) where applying a stale session's list to the wrong session
 * would clobber unrelated UI state.
 *
 * Mirrors the prior inline truthiness-based guard exactly: any truthy
 * `msg.sessionId` (including non-string values like `123`) counts as "set",
 * any truthy `activeSessionId` counts as "active", and the strict-inequality
 * comparison is then applied. Non-string `sessionId` values are still
 * skipped when they don't match an active session — preserving the
 * dashboard/app behaviour.
 */
function shouldSkipForSessionMismatch(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): boolean {
  return (
    !!msg.sessionId &&
    !!activeSessionId &&
    msg.sessionId !== activeSessionId
  )
}

/**
 * Parse a `slash_commands` message into the replacement array.
 *
 * Returns null when the session-id guard rejects the message OR when
 * `msg.commands` is missing/non-array — caller should `if (!result) break`.
 * Element shape is NOT validated; downstream casts to the concrete
 * `SlashCommand[]` type.
 */
export function handleSlashCommands(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): { commands: unknown[] } | null {
  if (shouldSkipForSessionMismatch(msg, activeSessionId)) return null
  if (!Array.isArray(msg.commands)) return null
  return { commands: msg.commands as unknown[] }
}

/**
 * Parse an `agent_list` message into the replacement array.
 *
 * Returns null when the session-id guard rejects the message OR when
 * `msg.agents` is missing/non-array — caller should `if (!result) break`.
 * Element shape is NOT validated; downstream casts to the concrete
 * `CustomAgent[]` type.
 */
export function handleAgentList(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): { agents: unknown[] } | null {
  if (shouldSkipForSessionMismatch(msg, activeSessionId)) return null
  if (!Array.isArray(msg.agents)) return null
  return { agents: msg.agents as unknown[] }
}

/**
 * Parse a `provider_list` message into the replacement array.
 *
 * No session-id guard — provider lists are server-wide. Returns null when
 * `msg.providers` is missing/non-array. The mobile app additionally tightens
 * element validation at the call site; this handler only handles the
 * shared array-ness check.
 */
export function handleProviderList(
  msg: Record<string, unknown>,
): { providers: unknown[] } | null {
  if (!Array.isArray(msg.providers)) return null
  return { providers: msg.providers as unknown[] }
}

/**
 * #5555 (auth_bootstrap) — parse the connect-time bootstrap burst into the
 * three list-replacement arrays. The frame folds `list_providers` /
 * `list_slash_commands` / `list_agents` responses into one server-initiated
 * push so a new client skips its connect-time request round trip.
 *
 * Each list is independent and defaults to `[]` when missing/non-array so a
 * partial server compute (e.g. an unreadable agents dir shipped `[]` for that
 * list only) still applies the lists that ARE present. Element shape is NOT
 * validated here — consumers reuse the same per-list casts they apply to the
 * discrete `provider_list` / `slash_commands` / `agent_list` messages.
 *
 * No session-id guard: providers are server-wide, and the slash/agent lists
 * are scoped to the active session the server just restored for this connect
 * (the same session the client lands on), so a connect-time burst is always
 * for the right session. The optional `sessionId` is surfaced so a consumer
 * CAN drop a stale burst if it has already switched away.
 */
export function handleAuthBootstrap(
  msg: Record<string, unknown>,
): {
  providers: unknown[]
  slashCommands: unknown[]
  agents: unknown[]
  sessionId: string | null
  tunnelUrl: string | null
} {
  const providers: unknown[] = Array.isArray(msg.providers) ? (msg.providers as unknown[]) : []
  const slashCommands: unknown[] = Array.isArray(msg.slashCommands) ? (msg.slashCommands as unknown[]) : []
  const agents: unknown[] = Array.isArray(msg.agents) ? (msg.agents as unknown[]) : []
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
  // #5555 (sub-item 7): the server's live public tunnel URL, when a tunnel is
  // up. Lets a reconnecting client re-learn a URL that rotated while it was
  // offline. Absent in LAN / no-tunnel deployments. Validated as `wss://` here
  // (not just non-empty) so the parser matches its documented contract and a
  // bogus scheme is dropped before either client's apply step.
  const tunnelUrl = asWssUrl(msg.tunnelUrl)
  return { providers, slashCommands, agents, sessionId, tunnelUrl }
}

/**
 * #5555 (sub-item 7) — coerce a wire value to a `wss://` URL string, or null.
 * The tunnel URL is always a secure WebSocket endpoint; rejecting any other
 * scheme (or non-string) here keeps the shared tunnel-URL parsers honest so the
 * platform apply steps never have to re-defend against `ws://`/garbage.
 */
function asWssUrl(value: unknown): string | null {
  return typeof value === 'string' && /^wss:\/\//i.test(value) ? value : null
}

/**
 * #5555 (sub-item 7) — parse a `tunnel_url_changed` push (quick-tunnel URL
 * rotation). Returns the new `wss://` URL and the previous URL (when the server
 * knew it), or null when the payload is malformed so the caller skips it.
 *
 * The tunnel URL is connection metadata, not a secret (the QR code shares it),
 * so this is delivered to every authenticated client. Both clients apply it the
 * same way conceptually — repoint the stored endpoint their reconnect path
 * dials — but the STORAGE differs per platform (mobile: SecureStore-backed
 * SavedConnection.tunnelUrl; dashboard: the server-registry entry's wsUrl in
 * localStorage), so the apply step stays platform-local rather than living in
 * the shared dispatch table.
 */
export function handleTunnelUrlChanged(
  msg: Record<string, unknown>,
): { url: string; previousUrl: string | null } | null {
  // Validate as `wss://` (the parser's documented contract) rather than just
  // non-empty, so a malformed scheme is dropped here instead of relying on each
  // client's apply step to re-check it.
  const url = asWssUrl(msg.url)
  if (!url) return null
  const previousUrl = asWssUrl(msg.previousUrl)
  return { url, previousUrl }
}

/**
 * Parse a `file_list` message into the replacement array.
 *
 * Dashboard-only consumer today. No session-id guard. Always returns the
 * `{ files }` shape — defaulting to `[]` when the field is missing or
 * non-array (matches the dashboard's prior inline `Array.isArray(...) ? ... : []`).
 */
export function handleFileList(msg: Record<string, unknown>): { files: unknown[] } {
  const files: unknown[] = Array.isArray(msg.files) ? (msg.files as unknown[]) : []
  return { files }
}

// ---------------------------------------------------------------------------
// Git operation result handlers (diff_result / git_status_result /
// git_branches_result / git_stage_result / git_unstage_result /
// git_commit_result) live in ./git.ts (audit P2-3 split). Re-exported here so
// the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './git'
// ---------------------------------------------------------------------------
// Agent-tracking handlers (agent_spawned / agent_completed / agent_event) and
// AgentInfoBuilder live in ./agent.ts (audit P2-3 split). Re-exported here so
// the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './agent'

// ---------------------------------------------------------------------------
// #4307 — background_work_changed
//
// Snapshot-replacement: each event carries the full pending list for the
// targeted session. The handler returns a builder mirroring the
// agent_spawned/completed shape so the caller can gate on
// `sessionStates[sessionId]` (a known session) before applying, matching
// the surrounding handler conventions. Defensive against missing /
// non-array `pending` field (returns []), missing session id (caller
// treats as no-op), and malformed entries (skips fail-soft).
// ---------------------------------------------------------------------------

/**
 * Builder returned by {@link handleBackgroundWorkChanged}. Mirrors
 * {@link AgentInfoBuilder} / {@link ActiveToolBuilder}: callers gate
 * on `sessionStates[sessionId]` and call `applyTo` with the current
 * value to produce the next array (same reference when no change).
 */
export interface PendingBackgroundShellsBuilder {
  sessionId: string | null
  applyTo: (current: PendingBackgroundShell[]) => PendingBackgroundShell[]
}

/**
 * Parse a `background_work_changed` message into a builder that
 * replaces the session's `pendingBackgroundShells` slot with the
 * server's authoritative snapshot.
 *
 * Why snapshot-replace (rather than per-id diff): the wire event always
 * carries the full pending list (full-snapshot protocol — see
 * `ServerBackgroundWorkChangedSchema` doc-comment), so the handler can
 * be a flat replace. Late joiners catch up via `session_list`'s
 * `pendingBackgroundShells` field; live updates come through this
 * handler.
 *
 * Malformed entries (missing/non-string shellId, missing/non-number
 * startedAt, missing/non-string command) are filtered out fail-soft so
 * one bad row from a hypothetical future server can't make the whole
 * list disappear.
 */
export function handleBackgroundWorkChanged(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): PendingBackgroundShellsBuilder {
  const rawPending = Array.isArray(msg.pending) ? msg.pending : []
  const next: PendingBackgroundShell[] = []
  for (const raw of rawPending) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const shellId = typeof entry.shellId === 'string' ? entry.shellId : null
    if (!shellId) continue
    const command = typeof entry.command === 'string' ? entry.command : ''
    const startedAt = typeof entry.startedAt === 'number' && entry.startedAt >= 0
      ? entry.startedAt
      : Date.now()
    next.push({ shellId, command, startedAt })
  }
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => {
      // Reference-equality short-circuit: same length AND same
      // (shellId, startedAt, command) per index means no observable
      // change. The dashboard's `updateSession` skips re-renders when
      // the patch yields the same reference, so this matters for
      // duplicate emissions (idempotent server pushes from
      // pre-existing flows or reconnect-replay races).
      if (next.length === current.length) {
        let same = true
        for (let i = 0; i < next.length; i++) {
          const a = next[i]
          const b = current[i]
          // Index-in-bounds guard satisfies TS strict-null: `next` /
          // `current` are equal length but `noUncheckedIndexedAccess`
          // still types the element as `T | undefined`. The `!a || !b`
          // path is unreachable given the bounds; treat as mismatch
          // defensively.
          if (!a || !b) {
            same = false
            break
          }
          if (a.shellId !== b.shellId || a.startedAt !== b.startedAt || a.command !== b.command) {
            same = false
            break
          }
        }
        if (same) return current
      }
      return next
    },
  }
}

// ---------------------------------------------------------------------------
// Environment message handlers (environment_list / environment_error) live in
// ./environment.ts (audit P2-3 split). Re-exported here so the barrel's
// public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './environment'

// ---------------------------------------------------------------------------
// available_models
//
// Validates and normalizes the `models` array on an `available_models`
// message. Each entry can be either:
//
//  - A `ModelInfo` object with at least `id`, `label`, `fullId` (all non-empty
//    after trim). `contextWindow` is preserved only when it's a number > 0.
//  - A bare string (trimmed; non-empty), which gets expanded into
//    `{id, label: capitalized, fullId}` (label = first char uppercased).
//
// Malformed entries are dropped. Also extracts `defaultModelId` from
// `msg.defaultModel` via `parseStringField` (trim + reject empty/whitespace),
// aligning both clients on the stricter normalisation (#3137).
// ---------------------------------------------------------------------------

/**
 * Parsed payload from an `available_models` message: the validated/normalized
 * model list and the server-default model id.
 */
export interface AvailableModelsPayload {
  /** Cleaned/normalized list of models. Empty when input is missing or non-array. */
  models: ModelInfo[]
  /** Default model id from `msg.defaultModel` when string, else null. */
  defaultModelId: string | null
}

/**
 * Parse and normalize an `available_models` message.
 *
 * Behaviour-preserving (matches the dashboard's prior inline implementation):
 * - Object entries are parsed with `ServerAvailableModelsEntrySchema` from
 *   `@chroxy/protocol` (#3138 — first migrated handler in the established
 *   Zod-handler pattern). After Zod parse, additional empty-string trim
 *   rejection is applied to `id`, `label`, and `fullId`. Fields are NOT
 *   trimmed in the output (preserves verbatim values).
 * - `contextWindow` is included only when `typeof === 'number' && > 0`.
 * - String entries are trimmed; the trimmed value is used as `id` and `fullId`,
 *   and `label` is the trimmed value with its first character uppercased.
 * - `defaultModel` is normalised via `parseStringField` — trimmed; empty or
 *   whitespace-only inputs return `null` (#3137). The model picker treats
 *   empty string the same as null, so this aligns the two clients.
 */
export function handleAvailableModels(
  msg: Record<string, unknown>,
): AvailableModelsPayload {
  if (!Array.isArray(msg.models)) {
    return { models: [], defaultModelId: null }
  }
  const cleaned = (msg.models as unknown[])
    .map((m: unknown): ModelInfo | null => {
      if (typeof m === 'object' && m !== null) {
        const parsed = ServerAvailableModelsEntrySchema.safeParse(m)
        if (parsed.success) {
          const { id, label, fullId, contextWindow } = parsed.data
          // Reject whitespace-only / empty fields after Zod parse — schema
          // requires `string` but does not enforce non-empty trimming.
          if (id.trim() !== '' && label.trim() !== '' && fullId.trim() !== '') {
            const info: ModelInfo = { id, label, fullId }
            if (typeof contextWindow === 'number' && contextWindow > 0) {
              info.contextWindow = contextWindow
            }
            return info
          }
        }
      }
      if (typeof m === 'string' && m.trim().length > 0) {
        const s = m.trim()
        return { id: s, label: s.charAt(0).toUpperCase() + s.slice(1), fullId: s }
      }
      return null
    })
    .filter((m: ModelInfo | null): m is ModelInfo => m !== null)
  const defaultModelId = parseStringField(msg, 'defaultModel')
  return { models: cleaned, defaultModelId }
}

// ---------------------------------------------------------------------------
// mcp_servers
//
// Session-scoped list-replacement: writes the `mcpServers` array into the
// target session's state. The element type is left as `unknown[]` here — both
// callers cast to their own `McpServer[]` type at the call site.
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a session patch that replaces the
 * `mcpServers` list. Defaults to an empty array when the message has no
 * (or non-array) `servers` field.
 *
 * Session resolution matches the prior inline behaviour exactly:
 * `(msg.sessionId as string) || activeSessionId` (raw string passthrough; no
 * trim, no whitespace coercion). A whitespace-only `sessionId` is preserved
 * verbatim so the downstream `sessionStates[id]` lookup misses, rather than
 * silently falling back to the active session and patching the wrong one.
 * Mirrors the pattern used by `handleHistoryReplayStart`.
 */
export function handleMcpServers(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  const servers: unknown[] = Array.isArray(msg.servers)
    ? (msg.servers as unknown[])
    : []
  const rawSessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId : null
  return {
    sessionId: rawSessionId || activeSessionId,
    patch: { mcpServers: servers },
  }
}

// ---------------------------------------------------------------------------
// Cost/usage handlers (cost_update / session_usage) live in ./usage.ts
// (audit P2-3 split). Re-exported here so the barrel's public surface is
// unchanged.
// ---------------------------------------------------------------------------
export * from './usage'

// ---------------------------------------------------------------------------
// server_error
//
// Builds the ServerError + ChatMessage pair for a `server_error` message.
// Routing/dispatch decisions stay at the call site:
//   - The dashboard slices a 10-deep `serverErrors` array and routes the
//     ChatMessage to the matched session, the active session, or the global
//     message log.
//   - The app does the same plus adds the ServerError to its
//     `useNotificationStore`. The optional `Alert.alert` for non-recoverable
//     errors is also a side-effect kept at the call site.
// ---------------------------------------------------------------------------

export interface ServerErrorPayload {
  serverError: ServerError
  chatMessage: ChatMessage
}

const SERVER_ERROR_CATEGORIES: readonly ServerError['category'][] = [
  'tunnel',
  'session',
  'permission',
  'general',
]

/**
 * Normalize a `server_error` message into a ServerError record and a paired
 * ChatMessage of type `'error'`.
 *
 * - `category`: one of {tunnel, session, permission, general}; anything else
 *   (including missing or non-string) defaults to `'general'`.
 * - `message`: ANSI-stripped from the raw input when it's a string whose
 *   trimmed length is non-zero (the trim is used as the empty-check only —
 *   surrounding whitespace is preserved on the stored value). Defaults to
 *   `'Unknown server error'` when missing, non-string, or whitespace-only.
 * - `recoverable`: boolean type-check; defaults to `true` when missing or
 *   non-boolean.
 * - `sessionId`: included on the ServerError only when the message had a
 *   string `sessionId`. Callers compare against `sessionStates[id]` to decide
 *   whether to route the ChatMessage to that session, the active session, or
 *   the global log.
 */
export function handleServerError(
  msg: Record<string, unknown>,
): ServerErrorPayload {
  const category: ServerError['category'] =
    typeof msg.category === 'string' &&
    (SERVER_ERROR_CATEGORIES as readonly string[]).includes(msg.category)
      ? (msg.category as ServerError['category'])
      : 'general'
  const message: string =
    typeof msg.message === 'string' && (msg.message as string).trim().length > 0
      ? stripAnsi(msg.message as string)
      : 'Unknown server error'
  const recoverable: boolean =
    typeof msg.recoverable === 'boolean' ? msg.recoverable : true
  const errSessionId =
    typeof msg.sessionId === 'string' ? (msg.sessionId as string) : undefined
  const now = Date.now()
  const serverError: ServerError = {
    id: nextMessageId('err'),
    category,
    message,
    recoverable,
    timestamp: now,
    ...(errSessionId ? { sessionId: errSessionId } : {}),
  }
  const chatMessage: ChatMessage = {
    id: nextMessageId('err'),
    type: 'error',
    content: message,
    timestamp: now,
  }
  return { serverError, chatMessage }
}

// ---------------------------------------------------------------------------
// server_shutdown
//
// Returns the shutdown patch fields. App callers additionally invoke
// `useNotificationStore.getState().setShutdown(...)` — that side-effect stays
// at the call site since it's app-only.
// ---------------------------------------------------------------------------

export interface ServerShutdownPayload {
  shutdownReason: 'restart' | 'shutdown' | 'crash'
  restartEtaMs: number
  restartingSince: number
}

/**
 * Normalize a `server_shutdown` message into the shutdown state patch.
 *
 * - `reason`: one of {restart, shutdown, crash}; anything else defaults to
 *   `'shutdown'`.
 * - `restartEtaMs`: numeric pass-through (including `0`); non-numbers default
 *   to `0`.
 * - `restartingSince`: always set to `Date.now()` so the UI can compute
 *   countdowns relative to message receipt.
 */
export function handleServerShutdown(
  msg: Record<string, unknown>,
): ServerShutdownPayload {
  const reason: ServerShutdownPayload['shutdownReason'] =
    msg.reason === 'restart' ||
    msg.reason === 'shutdown' ||
    msg.reason === 'crash'
      ? (msg.reason as ServerShutdownPayload['shutdownReason'])
      : 'shutdown'
  const restartEtaMs =
    typeof msg.restartEtaMs === 'number' ? msg.restartEtaMs : 0
  return {
    shutdownReason: reason,
    restartEtaMs,
    restartingSince: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// server_status (legacy plain-message branch)
//
// The dashboard's structured `phase`-based branch (tunnel_warming/ready) stays
// inline at the call site. This helper covers ONLY the legacy plain-message
// branch shared by app + dashboard: a system-typed ChatMessage carrying the
// ANSI-stripped status text (or `'Status update'` when the input is missing,
// non-string, or whitespace-only).
// ---------------------------------------------------------------------------

export interface ServerStatusLegacyPayload {
  chatMessage: ChatMessage
}

/**
 * Build the system-typed ChatMessage for a legacy plain-message
 * `server_status` event.
 *
 * - `message`: ANSI-stripped from the raw input when it's a string whose
 *   trimmed length is non-zero (the trim is used as the empty-check only —
 *   surrounding whitespace is preserved on the stored value). Defaults to
 *   `'Status update'` when missing, non-string, or whitespace-only.
 * - The ChatMessage is of type `'system'`. Callers route it to the active
 *   session's message list, falling back to the global log.
 */
export function handleServerStatusLegacy(
  msg: Record<string, unknown>,
): ServerStatusLegacyPayload {
  const statusMessage: string =
    typeof msg.message === 'string' && (msg.message as string).trim().length > 0
      ? stripAnsi(msg.message as string)
      : 'Status update'
  const chatMessage: ChatMessage = {
    id: nextMessageId('status'),
    type: 'system',
    content: statusMessage,
    timestamp: Date.now(),
  }
  return { chatMessage }
}

// ---------------------------------------------------------------------------
// web_task_created / web_task_updated (shared upsert)
//
// Both messages carry a single `task` payload that should replace any existing
// task with the same `taskId`. The handler extracts the validated task; the
// caller performs the filter-and-append against its own `webTasks` list so
// the dedup semantics stay identical across consumers.
// ---------------------------------------------------------------------------

export interface WebTaskUpsertPayload {
  /** The validated task to upsert, or null when the message is malformed. */
  task: WebTask | null
}

/**
 * Validate and extract the task from a `web_task_created` or `web_task_updated`
 * message.
 *
 * Returns `{ task: null }` when:
 * - `msg.task` is missing or not a non-null object
 * - `task.taskId` is missing or not a non-empty string
 *
 * Otherwise returns the task as-is. The element type stays downstream — the
 * runtime check above is only on `taskId`, matching the prior inline behaviour.
 */
export function handleWebTaskUpsert(
  msg: Record<string, unknown>,
): WebTaskUpsertPayload {
  const task = msg.task
  if (!task || typeof task !== 'object') return { task: null }
  const taskId = (task as { taskId?: unknown }).taskId
  if (typeof taskId !== 'string' || taskId.length === 0) return { task: null }
  return { task: task as WebTask }
}

/**
 * Filter-and-append upsert against an existing `webTasks` list (#5556 slice 4).
 * Drops any existing task with the same `taskId`, then appends `task` at the
 * end — exactly the `state.webTasks.filter(t => t.taskId !== task.taskId)`
 * then-spread the app and dashboard both performed inline. Both clients were
 * byte-identical here, so this is the shared body the dispatch handler runs.
 */
export function applyWebTaskUpsert(existing: WebTask[], task: WebTask): WebTask[] {
  const kept = existing.filter((t) => t.taskId !== task.taskId)
  return [...kept, task]
}

// ---------------------------------------------------------------------------
// web_task_error
//
// Server-emitted failure for a web task. The shared handler extracts the
// taskId, the user-visible error text, the optional error code, and the
// optional bound-session name; it also pre-builds the system ChatMessage.
// Callers decide the side-effects: the app shows a Disconnect Alert when a
// SESSION_TOKEN_MISMATCH carries a `boundSessionName` and skips dispatching
// the chat message; the dashboard always dispatches the chat message.
// ---------------------------------------------------------------------------

export interface WebTaskErrorPayload {
  /** Validated taskId for the failed task, or null when missing. */
  taskId: string | null
  /**
   * Failure text to apply to the matching task's `error` field. Defaults to
   * `'Unknown error'` when the message is missing or non-string.
   */
  errorMessage: string
  /**
   * Normalized chat content for the optional system ChatMessage. Defaults to
   * `'Web task error'` when the message is missing or non-string. The caller
   * builds the ChatMessage (allocating id + timestamp) only when it will
   * actually dispatch — the app's SESSION_TOKEN_MISMATCH-with-boundSessionName
   * branch short-circuits to an Alert and never builds the message.
   */
  chatMessageContent: string
  /** Optional error code (e.g. `'SESSION_TOKEN_MISMATCH'`). */
  code: string | null
  /** Optional bound session name for the SESSION_TOKEN_MISMATCH branch. */
  boundSessionName: string | null
}

/**
 * Normalize a `web_task_error` message.
 *
 * - `taskId`: string pass-through; null when missing, non-string, or empty.
 * - `errorMessage`: `msg.message` when a non-empty string, else
 *   `'Unknown error'`. Used by the caller to update the matching task's
 *   `error` field.
 * - `chatMessageContent`: `msg.message` when a non-empty string, else
 *   `'Web task error'`. The caller wraps this in a system-typed ChatMessage
 *   (allocating id + timestamp) only when it actually dispatches the message
 *   — the app's SESSION_TOKEN_MISMATCH-with-boundSessionName branch
 *   short-circuits to an Alert and skips dispatch (and the construction).
 * - `code`: string pass-through; null when missing or non-string.
 * - `boundSessionName`: string pass-through; null when missing, non-string,
 *   or empty.
 */
export function handleWebTaskError(
  msg: Record<string, unknown>,
): WebTaskErrorPayload {
  const taskId =
    typeof msg.taskId === 'string' && (msg.taskId as string).length > 0
      ? (msg.taskId as string)
      : null
  const messageText =
    typeof msg.message === 'string' && (msg.message as string).length > 0
      ? (msg.message as string)
      : null
  const errorMessage = messageText ?? 'Unknown error'
  const code = typeof msg.code === 'string' ? (msg.code as string) : null
  const boundSessionName =
    typeof msg.boundSessionName === 'string' &&
    (msg.boundSessionName as string).length > 0
      ? (msg.boundSessionName as string)
      : null
  const chatMessageContent = messageText ?? 'Web task error'
  return { taskId, errorMessage, chatMessageContent, code, boundSessionName }
}

// ---------------------------------------------------------------------------
// web_task_list
//
// Server emits the full webTasks list. Caller replaces its `webTasks` state
// wholesale. Element type stays at the call site (`tasks as WebTask[]`).
// ---------------------------------------------------------------------------

export interface WebTaskListPayload {
  tasks: unknown[]
}

/** Extract the tasks array from a `web_task_list` message; defaults to `[]`. */
export function handleWebTaskList(
  msg: Record<string, unknown>,
): WebTaskListPayload {
  return { tasks: Array.isArray(msg.tasks) ? (msg.tasks as unknown[]) : [] }
}

// ---------------------------------------------------------------------------
// web_feature_status
//
// Server reports availability flags for the Claude Code Web feature. All
// three booleans are coerced via `!!` to preserve the prior inline behaviour
// (truthy non-booleans become `true`, missing/falsy become `false`).
// ---------------------------------------------------------------------------

export interface WebFeatureStatusPayload {
  webFeatures: {
    available: boolean
    remote: boolean
    teleport: boolean
  }
}

/**
 * Coerce the three boolean fields of a `web_feature_status` message into the
 * `webFeatures` state patch. Missing fields default to `false`.
 */
export function handleWebFeatureStatus(
  msg: Record<string, unknown>,
): WebFeatureStatusPayload {
  return {
    webFeatures: {
      available: !!msg.available,
      remote: !!msg.remote,
      teleport: !!msg.teleport,
    },
  }
}

// ---------------------------------------------------------------------------
// search_results
//
// Server emits search results in response to a search query. The shared
// handler validates the array shape and applies the stale-query guard so the
// client does not overwrite newer results with a late response. Callers do
// the platform-specific `set(...)` (the app additionally clears `searchError`
// and mirrors the results into `useConversationStore`).
// ---------------------------------------------------------------------------

export interface SearchResultsPayload {
  /**
   * Validated results array (non-array `msg.results` defaults to `[]`).
   * Typed as `SearchResult[]` (#3146) — per-element shape is NOT validated;
   * the cast trusts the wire format. Always defined; meaningful only when
   * `shouldApply` is `true`.
   */
  results: SearchResult[]
  /**
   * Whether the caller should apply the results. Returns `false` when the
   * server-echoed `query` no longer matches the current in-flight `query`,
   * preserving the prior inline stale-response guard.
   */
  shouldApply: boolean
}

/**
 * Validate and stale-check a `search_results` message.
 *
 * - `results`: pass-through when `msg.results` is an array, else `[]`.
 * - `shouldApply`:
 *   - `false` only when the message included a non-null `query` AND the
 *     current in-flight `currentQuery` is truthy AND the two strings differ.
 *   - `true` otherwise — including when the message omits `query` (broadcast)
 *     or when the client has already cleared its `currentQuery` (no in-flight
 *     query to be stale against).
 *
 * Callers use the boolean to short-circuit before applying state. The handler
 * does not mutate or clone the array; the original reference is returned.
 */
export function handleSearchResults(
  msg: Record<string, unknown>,
  currentQuery: string | null,
): SearchResultsPayload {
  const results: SearchResult[] = Array.isArray(msg.results)
    ? (msg.results as SearchResult[])
    : []
  const msgQuery: string | null =
    typeof msg.query === 'string' ? (msg.query as string) : null
  if (msgQuery !== null && currentQuery && msgQuery !== currentQuery) {
    return { results, shouldApply: false }
  }
  return { results, shouldApply: true }
}

// ---------------------------------------------------------------------------
// user_question
//
// Server forwards a `user_question` event when Claude wants to prompt the
// user with multiple-choice options. The shared handler validates the
// message shape and pre-builds the `prompt`-typed ChatMessage, the resolved
// session ID for routing, and the truncated notification text.
//
// Side-effects (dispatching the chat message, calling
// `pushSessionNotification`) stay at the call site.
// ---------------------------------------------------------------------------

/**
 * Sentinel `value` appended to the option list of every multi-choice
 * `user_question` (#3746). Renderers detect this value and swap their
 * option buttons for a free-text input so the user can always supply a
 * custom answer outside the model-provided choices — matching the
 * upstream `AskUserQuestion` tool contract.
 *
 * Only appended when at least one real option was provided; questions
 * with zero options keep their free-text-only rendering.
 */
export const OTHER_OPTION_VALUE = '__chroxy_other__'
export const OTHER_OPTION_LABEL = 'Other'

export interface UserQuestionPayload {
  /**
   * Resolved session for the question. Falls back to the active session
   * when the message omits an explicit `sessionId`. May be `null` when both
   * sources are empty (caller routes the chat message to the global log).
   */
  sessionId: string | null
  /**
   * Pre-built `prompt`-typed ChatMessage. The caller dispatches it to the
   * resolved session (or the global log) without further transformation.
   */
  chatMessage: ChatMessage
  /**
   * The first 60 characters of the question text — used by the caller for
   * the `pushSessionNotification` body.
   */
  questionText: string
}

/**
 * Validate and normalize a `user_question` message.
 *
 * Returns `null` when the message is malformed:
 * - `msg.questions` missing, not an array, or empty
 * - first `questions[0]` not a non-null object
 * - `q.question` not a string
 *
 * Otherwise returns:
 * - `sessionId`: `msg.sessionId` when a non-empty string, else `activeSessionId`.
 *   Non-string `msg.sessionId` falls through to `activeSessionId`.
 * - `chatMessage`: `prompt`-typed with a fresh `nextMessageId('question')`,
 *   `content` = `q.question`, `toolUseId` populated only when `msg.toolUseId`
 *   is a string (otherwise omitted), and `options` filtered to objects with
 *   a string `label` (mapped to `{label, value}` where `value === label`).
 *   Missing/non-array `q.options` yields `[]`.
 * - `questionText`: `q.question.slice(0, 60)`.
 *
 * Each non-`questions` field is validated at runtime so the returned payload
 * matches its declared TypeScript types regardless of what the server sends.
 */
export function handleUserQuestion(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): UserQuestionPayload | null {
  const questions = msg.questions as unknown[]
  if (!Array.isArray(questions) || questions.length === 0) return null
  const q = questions[0] as Record<string, unknown>
  if (!q || typeof q !== 'object' || typeof q.question !== 'string') return null

  /**
   * #4604 Chunk B — shared per-question normalization. Same dedup +
   * Other-sentinel logic the original single-question path applied,
   * pulled into a closure so every entry in the multi-question payload
   * gets it. Returns `null` for malformed entries so the caller can
   * skip them without poisoning the rest of the form.
   */
  const normalizeQuestion = (rawQ: unknown): {
    question: string
    options: { label: string; value: string }[]
    multiSelect?: boolean
  } | null => {
    if (!rawQ || typeof rawQ !== 'object') return null
    const qq = rawQ as Record<string, unknown>
    if (typeof qq.question !== 'string') return null
    const rawOptions = Array.isArray(qq.options)
      ? (qq.options as unknown[])
          .filter(
            (o: unknown): o is { label: string } =>
              !!o &&
              typeof o === 'object' &&
              typeof (o as Record<string, unknown>).label === 'string',
          )
          .map((o: { label: string }) => ({ label: o.label, value: o.label }))
      : []
    // #3752: dedup against the synthetic sentinel BEFORE appending it.
    const baseOptions = rawOptions.filter(
      (o) => o.label !== OTHER_OPTION_LABEL && o.value !== OTHER_OPTION_VALUE,
    )
    const modelSuppliedOther = rawOptions.find((o) => o.label === OTHER_OPTION_LABEL)
    const hasUsableOptions = baseOptions.length > 0 || modelSuppliedOther != null
    // #4604 Chunk B: only append the Other sentinel for single-select
    // questions. Multi-select questions render as checkboxes and the
    // free-text escape hatch doesn't compose cleanly with that UI;
    // multi-select forms produced by claude SDK never include a
    // free-text fallback anyway.
    const isMultiSelect = qq.multiSelect === true
    const options = !hasUsableOptions
      ? []
      : isMultiSelect
        ? baseOptions
        : modelSuppliedOther
          ? [...baseOptions, modelSuppliedOther]
          : [...baseOptions, { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_VALUE }]
    const out: { question: string; options: { label: string; value: string }[]; multiSelect?: boolean } = {
      question: qq.question as string,
      options,
    }
    if (isMultiSelect) out.multiSelect = true
    return out
  }

  // Normalize every question. Drop malformed entries (return null from
  // normalizeQuestion); if the first question is dropped, fail closed
  // — that's the legacy null-return shape the call site already handles.
  const normalizedAll = (questions as unknown[]).map(normalizeQuestion).filter(
    (v): v is { question: string; options: { label: string; value: string }[]; multiSelect?: boolean } => v != null,
  )
  // The top-level `options` mirrors q[0].options exactly (legacy
  // contract — every existing test pin still applies). Multi-question
  // renderers iterate `chatMessage.questions` instead.
  const [firstNormalized] = normalizedAll
  if (firstNormalized == null) return null
  const questionContent = firstNormalized.question
  const options = firstNormalized.options
  // #4613 — honour the wire `timestamp` field when present (number). Mirrors
  // the #4607 fix for handleToolStart. The server's history ring buffer
  // stamps `timestamp: Date.now()` at append time
  // (session-message-history.js:208-216) and forwards it on every replay —
  // question events are part of that ring buffer. Pre-#4613 we always
  // overwrote with `Date.now()`, so a question prompt that originally fired
  // at 10:00 showed as "just now" if the user tabbed away and the dashboard
  // rebuilt the prompt ChatMessage during history_replay. Lower-impact than
  // #4607 (affects bubble display only, not the timer pill), but still a
  // correctness bug. The fallback to `Date.now()` covers live (non-replay)
  // user_question broadcasts, which never carry `msg.timestamp` on the wire.
  const wireTimestamp =
    typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
      ? msg.timestamp
      : Date.now()
  const chatMessage: ChatMessage = {
    id: nextMessageId('question'),
    type: 'prompt',
    content: questionContent,
    options,
    // #4604 Chunk B: always populate `questions` (a single-question form
    // is just an N=1 case of the multi-question shape). Renderers can
    // detect multi-question by `questions.length > 1` and switch UI.
    questions: normalizedAll,
    timestamp: wireTimestamp,
  }
  if (typeof msg.toolUseId === 'string') {
    chatMessage.toolUseId = msg.toolUseId
  }
  const msgSessionId =
    typeof msg.sessionId === 'string' && msg.sessionId.length > 0
      ? msg.sessionId
      : null
  const sessionId = msgSessionId ?? activeSessionId
  const questionText = questionContent.slice(0, 60)
  return { sessionId, chatMessage, questionText }
}

// ---------------------------------------------------------------------------
// user_input
//
// Server broadcasts `user_input` to all OTHER clients when someone sends a
// message. Both the app and dashboard render it identically; the dashboard
// additionally writes the prompt to the terminal buffer (handled at the call
// site via the returned `content` field).
// ---------------------------------------------------------------------------

export interface UserInputPayload {
  /** Resolved session for the user_input. */
  sessionId: string
  /**
   * Pre-built `user_input`-typed ChatMessage. Adopts the server's stable
   * `messageId` when present so a later replay of the same entry dedups by
   * id against this live-echo copy (#2902).
   */
  chatMessage: ChatMessage
  /**
   * Original user prompt content. The dashboard uses this to write the
   * terminal buffer (`appendTerminalData`). The app ignores it.
   */
  content: string
}

/**
 * Validate a `user_input` message and build the renderable ChatMessage.
 *
 * Returns `null` when `parseUserInputMessage` returns null — i.e. when the
 * message originated from this client (already shown via optimistic UI) or
 * when no target session can be resolved.
 */
export function handleUserInput(
  msg: Record<string, unknown>,
  myClientId: string | null,
  activeSessionId: string | null,
): UserInputPayload | null {
  const parsed = parseUserInputMessage(msg, myClientId, activeSessionId)
  if (!parsed) return null
  const { sessionId: parsedSessionId, ...parsedMsg } = parsed
  const stableId = typeof msg.messageId === 'string' ? msg.messageId : undefined
  const chatMessage: ChatMessage = {
    id: stableId || nextMessageId('user_input'),
    ...parsedMsg,
  }
  return {
    sessionId: parsedSessionId,
    chatMessage,
    content: parsed.content,
  }
}

// ---------------------------------------------------------------------------
// Message / tool / stream rendering handlers (message, tool_start /
// tool_result / tool_input_delta, stream_start / stream_end, result_usage,
// raw_output, sharedStreamDelta + PendingDelta / StreamDeltaContext) live in
// ./stream.ts (audit P2-3 split). Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './stream'

// ---------------------------------------------------------------------------
// token_rotated
// ---------------------------------------------------------------------------

/**
 * Extract the new bearer token from a `token_rotated` message.
 *
 * Returns the token verbatim when it is a string (including the empty
 * string), else null. Both call sites gate the "seamless update" path on a
 * truthy check — so `''` takes the legacy "re-authentication required" path
 * exactly as it did with the prior inline
 * `typeof msg.token === 'string' ? msg.token : null` guard.
 *
 * Side effects are platform-specific and stay at the call site: the app
 * persists the token via `saveConnection` (or disconnects + alerts on the
 * legacy path); the dashboard rewrites the `token` query param in the
 * browser URL.
 */
export function handleTokenRotated(msg: Record<string, unknown>): { token: string | null } {
  return { token: typeof msg.token === 'string' ? msg.token : null }
}

// ---------------------------------------------------------------------------
// pair_fail
// ---------------------------------------------------------------------------

/**
 * User-facing copy for the known `pair_fail` reasons. Worded for the QR-code
 * pairing flow — the mobile app uses these verbatim. The dashboard's
 * paste-a-pairing-URL flow (#5297) keeps its plain `Pairing failed: <reason>`
 * template at the call site, since "Scan the latest QR code" does not match
 * that surface's UX.
 */
export const PAIR_FAIL_MESSAGES: Record<string, string> = {
  expired: 'This QR code has expired. Scan the latest QR code from your server.',
  already_used: 'This QR code has already been used. Scan the latest QR code from your server.',
  invalid_pairing_id: 'Invalid pairing code. Scan the latest QR code from your server.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
}

/** Parsed payload from a `pair_fail` message. */
export interface PairFailPayload {
  /** The server-sent reason, or `fallbackReason` when missing/empty/non-string. */
  reason: string
  /**
   * QR-flow alert copy: the friendly message for known reasons, else
   * `Pairing failed: <reason>`.
   */
  alertMessage: string
}

/**
 * Parse a `pair_fail` message.
 *
 * `fallbackReason` is injected because the two clients historically used
 * different fallbacks (app: `'pairing_failed'`, dashboard: `'unknown'`) and
 * the alert copy renders the reason verbatim — changing either fallback would
 * change user-visible text.
 *
 * Non-string and empty-string reasons both resolve to the fallback. (The
 * app's prior inline guard was `(msg.reason as string) || fallback` — a
 * truthy check — so this is byte-identical for it; the dashboard's prior
 * guard passed `''` through, which only affected the cosmetic
 * `Pairing failed: ` string.)
 *
 * Socket teardown, lifecycle-phase flips, and registry cleanup (#5281) are
 * platform glue and stay at the call sites.
 */
export function handlePairFail(
  msg: Record<string, unknown>,
  fallbackReason: string,
): PairFailPayload {
  const reason =
    typeof msg.reason === 'string' && msg.reason.length > 0 ? msg.reason : fallbackReason
  return {
    reason,
    alertMessage: PAIR_FAIL_MESSAGES[reason] ?? `Pairing failed: ${reason}`,
  }
}

// ---------------------------------------------------------------------------
// session_cost_threshold_crossed (#4075)
// ---------------------------------------------------------------------------

/** Parsed payload from a `session_cost_threshold_crossed` message. */
export interface SessionCostThresholdCrossedPayload {
  /**
   * Explicit sessionId from the message, or null. There is deliberately NO
   * active-session fallback (matches both prior inline impls): the soft
   * "you've spent $X" warning fires once per session and must never be
   * misattributed to whichever session happens to be active.
   */
  sessionId: string | null
  /** Session-state patch that arms the dismissible warning banner. */
  patch: { costThresholdWarning: { costUsd: number; thresholdUsd: number; dismissedAt: null } }
}

/**
 * Parse a `session_cost_threshold_crossed` message into a session patch.
 *
 * `costUsd` / `thresholdUsd` fall back to `0` for missing / non-number /
 * non-finite values — identical to the prior inline guards on both clients.
 * The caller applies the patch only when the target session exists in its
 * store (the server doesn't replay this event, so a missed banner stays
 * missed by design).
 */
export function handleSessionCostThresholdCrossed(
  msg: Record<string, unknown>,
): SessionCostThresholdCrossedPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const costUsd =
    typeof msg.costUsd === 'number' && Number.isFinite(msg.costUsd) ? msg.costUsd : 0
  const thresholdUsd =
    typeof msg.thresholdUsd === 'number' && Number.isFinite(msg.thresholdUsd)
      ? msg.thresholdUsd
      : 0
  return {
    sessionId,
    patch: { costThresholdWarning: { costUsd, thresholdUsd, dismissedAt: null } },
  }
}

// ---------------------------------------------------------------------------
// notification_prefs (#4542 / #4544)
// ---------------------------------------------------------------------------

/**
 * Notification-prefs snapshot shape both clients store (mirrors the
 * `notificationPrefs` state slice that existed verbatim on each side before
 * this extraction).
 */
export interface NotificationPrefsState {
  categories: Record<string, boolean>
  devices: Record<
    string,
    {
      categories?: Record<string, boolean>
      quietHours?: { start: string; end: string; timezone: string } | null
      bypassCategories?: string[]
    }
  >
  quietHours: { start: string; end: string; timezone: string } | null
  /**
   * #4544: optional globally-applied bypass list (categories that fire even
   * during quiet hours). Omitted entirely when the wire payload lacks it —
   * clients fall back to the documented defaults (permission +
   * activity_error).
   */
  bypassCategories?: string[]
}

/** Result of parsing a `notification_prefs` message. */
export interface NotificationPrefsPayload {
  /** Validated snapshot ready to store, or null when validation failed. */
  notificationPrefs: NotificationPrefsState | null
  /** Zod issues when validation failed, else null (for the call-site warn). */
  issues: unknown[] | null
}

/**
 * Validate and extract a `notification_prefs` snapshot.
 *
 * Emitted in response to `notification_prefs_get` and broadcast after every
 * `notification_prefs_set` so multiple connected clients stay in lockstep.
 * Validated against `ServerNotificationPrefsSchema` (the wire schema is
 * permissive — `z.record(string, boolean)` for categories — so adding a
 * category server-side does not require a client rebuild). On failure the
 * caller logs `issues` and leaves existing state alone, exactly as both
 * inline implementations did.
 */
export function handleNotificationPrefs(
  msg: Record<string, unknown>,
): NotificationPrefsPayload {
  const parsed = ServerNotificationPrefsSchema.safeParse(msg)
  if (!parsed.success) {
    return { notificationPrefs: null, issues: parsed.error.issues }
  }
  const prefs = parsed.data.prefs
  // #4544: wire snapshot carries an optional `bypassCategories`. Older
  // servers omit it — spread-include only when it's a real array so the
  // stored object matches the prior inline shape key-for-key.
  const bypassCategories = (prefs as { bypassCategories?: string[] }).bypassCategories
  return {
    notificationPrefs: {
      categories: prefs.categories,
      devices: prefs.devices,
      quietHours: prefs.quietHours,
      ...(Array.isArray(bypassCategories) ? { bypassCategories } : {}),
    },
    issues: null,
  }
}

// ---------------------------------------------------------------------------
// permission_request — #554 stream-split resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the #554 "split streaming response at permission boundary" decision
 * for a `permission_request` message.
 *
 * Both clients carried a near line-for-line copy of this block: when a
 * permission prompt arrives mid-stream, the in-flight assistant message must
 * be split so the prompt doesn't get visually fused onto it. The pure part —
 * deciding whether a split applies and reverse-mapping the client-side stream
 * id back to the server-origin id through the delta-remap table — lives here.
 *
 * Returns null when there is nothing to split: no current stream, or the
 * `'pending'` placeholder id (stream_start not yet processed).
 *
 * Side effects stay at the call site, in this order (matching both prior
 * inline copies): clear the pending delta-flush timer, flush pending deltas,
 * add `serverStreamId` to the post-permission-splits set, and clear the
 * target session's `streamingMessageId`.
 */
export function resolvePermissionStreamSplit(
  currentStreamId: string | null,
  deltaIdRemaps: ReadonlyMap<string, string>,
): { serverStreamId: string } | null {
  if (!currentStreamId || currentStreamId === 'pending') return null
  let serverStreamId = currentStreamId
  for (const [origId, remappedId] of deltaIdRemaps) {
    if (remappedId === currentStreamId) {
      serverStreamId = origId
      break
    }
  }
  return { serverStreamId }
}
