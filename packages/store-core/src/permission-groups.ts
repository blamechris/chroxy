/**
 * Grouping of resolved permission prompts (#6894, follow-up to #6626).
 *
 * A prompt that has ENDED -- answered, denied, expired or stopped -- collapses to
 * a compact audit line. When several of those sit next to each other and are the
 * same request (a Codex session asking to run the same registry lookup three
 * times), one line with a count reads better than three identical ones.
 *
 * Pure and client-agnostic: it decides WHICH rows form a run, nothing about how a
 * client draws it. The dashboard splices a synthetic group row per run; the
 * mobile app does not call this (its answered prompts already collapse to pills).
 *
 * Two rules carry the whole contract:
 *
 *   - A PENDING prompt never groups with anything. `resolvedPermissionOutcome`
 *     is `null` for it, a `null` key breaks any run, and so each pending approval
 *     stays its own actionable card.
 *   - "Identical" means the same session, tool, description, tool input AND
 *     outcome. Folding an allowed request and a denied one into one line, or two
 *     different commands that share a rationale, would lose exactly what the
 *     audit line exists to keep.
 */
import { permissionOutcomeFromDecision } from './pending-permissions'
import type { ChatMessage, PermissionOutcomeKind } from './types'

/**
 * How a permission prompt ended, or `null` if it has not (pending, a question,
 * the `'(resolved)'` placeholder, or not a permission prompt at all).
 *
 * A recorded `permissionOutcome` (a replayed `permission_outcome`, or a live Stop
 * / abort) wins over the decision token, the same order the renderers read them
 * in: Stop clears `answered`, and an allowed/denied replay sets both.
 */
export function resolvedPermissionOutcome(m: ChatMessage): PermissionOutcomeKind | null {
  if (m.type !== 'prompt' || !m.requestId) return null
  if (m.permissionOutcome) return m.permissionOutcome
  return permissionOutcomeFromDecision(m.answered)
}

/** JSON with object keys sorted, so key order never decides equality. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')
  return `{${body}}`
}

/**
 * Identity of a resolved prompt for grouping, or `null` when the prompt is not
 * resolved (so it can never join a run). Two prompts with an equal non-null key
 * are the same request that ended the same way.
 */
export function resolvedPermissionGroupKey(m: ChatMessage): string | null {
  const outcome = resolvedPermissionOutcome(m)
  if (!outcome) return null
  return stableStringify([
    m.originSessionId ?? null,
    m.tool ?? null,
    m.content,
    outcome,
    m.toolInput ?? null,
  ])
}

export interface ResolvedPermissionRun<T> {
  /** Shared {@link resolvedPermissionGroupKey} of every item. */
  key: string
  /** The adjacent items, in input order. Always at least `minRunLength` long. */
  items: T[]
  /** Index of `items[0]` in the input list. */
  startIndex: number
}

/**
 * The runs of ADJACENT items that are the same resolved permission prompt.
 *
 * `getMessage` maps an item to its store message; an item with none (a synthetic
 * row, a tool group) has no key and breaks the run, as does a pending prompt or a
 * different request. Runs shorter than `minRunLength` (default 2) are not
 * reported: a lone resolved prompt stays its own line.
 */
export function findResolvedPermissionRuns<T>(
  items: readonly T[],
  getMessage: (item: T) => ChatMessage | undefined,
  minRunLength = 2,
): ResolvedPermissionRun<T>[] {
  const runs: ResolvedPermissionRun<T>[] = []
  let current: ResolvedPermissionRun<T> | null = null
  const flush = () => {
    if (current && current.items.length >= minRunLength) runs.push(current)
    current = null
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const msg = getMessage(item)
    const key = msg ? resolvedPermissionGroupKey(msg) : null
    if (key === null) {
      flush()
      continue
    }
    if (current && current.key === key) {
      current.items.push(item)
    } else {
      flush()
      current = { key, items: [item], startIndex: i }
    }
  }
  flush()
  return runs
}
