/**
 * Provider-keyed permission-mode rosters (#8224).
 *
 * `available_permission_modes` describes ONE provider: the mode ids are the
 * same everywhere, but which of them a provider can honour (`supported`), the
 * "(unavailable)" label, and the description copy all differ — Plan is
 * unavailable on claude-tui and available on claude-sdk, Auto is unavailable on
 * providers without a permission floor, codex has its own copy.
 *
 * Both clients used to land every frame in ONE flat `availablePermissionModes`
 * slot, which the server refreshed only when the active session changed by an
 * explicit `switch_session` (and at connect). Any other way of becoming active —
 * creating a session, which auto-switches the creator — left the previous
 * session's roster in place, so a fresh claude-sdk session opened beside an
 * active claude-tui one showed "Plan (unavailable)" until the tab was
 * re-selected.
 *
 * The fix is the one `available_models` got in #7728, for the same reason: a
 * roster is a fact about a PROVIDER, so it is stored under that provider and the
 * ACTIVE session's roster is DERIVED at read time
 * ({@link selectPermissionModesForProvider}). No refresh event has to arrive in
 * the right order for the picker to be right, because the picker reads from the
 * session that is active now rather than from whichever frame landed last.
 *
 * The tag and bucketing rules are exactly `models-by-provider.ts`'s — the
 * canonicalisation helpers are shared on purpose so the two rosters cannot
 * disagree about which provider a frame belongs to.
 */

import type { PermissionMode } from './handlers/permission'
import { UNTAGGED_MODELS_PROVIDER, bucketKey, canonicalProviderTag } from './models-by-provider'

/** Every permission-mode roster this client has heard, keyed by provider tag. */
export type PermissionModesByProvider = Record<string, PermissionMode[]>

/**
 * Returned when nothing is known for the requested provider. Frozen and shared
 * so a React `useMemo`/zustand selector over it keeps a stable identity.
 */
export const EMPTY_PERMISSION_MODES: PermissionMode[] = Object.freeze(
  [],
) as unknown as PermissionMode[]

/**
 * Write one frame's roster under the provider that sent it, leaving every other
 * provider's roster intact. Replace-per-provider, never merge.
 */
export function mergePermissionModesByProvider(
  previous: PermissionModesByProvider | undefined | null,
  provider: unknown,
  modes: PermissionMode[],
): PermissionModesByProvider {
  return { ...(previous ?? {}), [bucketKey(provider)]: modes }
}

/**
 * The roster the ACTIVE session's provider offers.
 *
 * 1. The provider's own roster.
 * 2. A KNOWN provider with no roster of its own: the UNTAGGED roster, if any.
 *    A daemon from before #8224 (v0.11.4 and earlier) sends every roster
 *    untagged while its `session_list` does name each session's provider, so
 *    without this a new client against an installed daemon would hide the
 *    picker entirely. It cannot leak across providers: a daemon that carries
 *    #8224 tags every roster send, so it never writes the untagged bucket, and
 *    an untagged roster only ever comes from the old daemon whose single roster
 *    is the only one in play. (`available_models` dropped this fallback in
 *    #7759 only AFTER tagging every send; the compatibility window here is the
 *    whole installed daemon base.) A TAGGED roster for a different provider is
 *    never served.
 * 3. Provider UNKNOWN (no active session, or the session list has not arrived)
 *    and exactly one roster known: that one.
 * 4. Otherwise empty — the picker hides until the server's roster for this
 *    provider lands (the server sends it with the session info), which is
 *    better than offering Plan on a provider that cannot plan or hiding it on
 *    one that can.
 */
export function selectPermissionModesForProvider(
  byProvider: PermissionModesByProvider | undefined | null,
  provider: string | null | undefined,
): PermissionMode[] {
  const map = byProvider ?? {}
  const key = canonicalProviderTag(provider)
  if (key !== null) return map[key] ?? map[UNTAGGED_MODELS_PROVIDER] ?? EMPTY_PERMISSION_MODES
  const [only, ...rest] = Object.values(map)
  if (only && rest.length === 0) return only
  return EMPTY_PERMISSION_MODES
}
