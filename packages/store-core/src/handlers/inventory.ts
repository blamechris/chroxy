/**
 * Shared stateless handlers for server-side inventory list-replacement
 * messages (slash_commands / agent_list / provider_list / file_list,
 * available_models, mcp_servers).
 *
 * Extracted from ./misc.ts (issue #6034 — splitting the P2-3 leftover
 * catch-all into cohesively-named slices). Pure move, no logic change.
 * Re-exported from ./index so the public surface is unchanged. These all
 * parse a wire array into the replacement list the caller writes back into
 * its store; element-shape validation stays at the call site. See ./index.ts
 * for the stateless-handler contract.
 */

import type { ModelInfo } from '../types'
// Established Zod-handler pattern (#3138).
import { ServerAvailableModelsEntrySchema } from '@chroxy/protocol'
import { parseRawStringField, parseStringField, parseUnknownArrayField } from './_shared'
import type { SessionPatch } from './_shared'

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
 * Parse a `file_list` message into the replacement arrays.
 *
 * Dashboard-only consumer today. No session-id guard. Always returns the
 * `{ files, resources }` shape — each defaulting to `[]` when the field is
 * missing or non-array. `resources` (#6823) carries MCP-server resources for
 * the `@`-picker; empty for non-BYOK sessions and older servers.
 */
export function handleFileList(msg: Record<string, unknown>): { files: unknown[]; resources: unknown[] } {
  const files = parseUnknownArrayField(msg, 'files')
  const resources = parseUnknownArrayField(msg, 'resources')
  return { files, resources }
}

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
  const servers = parseUnknownArrayField(msg, 'servers')
  const rawSessionId = parseRawStringField(msg, 'sessionId')
  return {
    sessionId: rawSessionId || activeSessionId,
    patch: { mcpServers: servers },
  }
}
