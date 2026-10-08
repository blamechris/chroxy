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
 * Three rules carry the whole contract:
 *
 *   - A PENDING prompt never groups with anything. `resolvedPermissionOutcome`
 *     is `null` for it, a `null` key breaks any run, and so each pending approval
 *     stays its own actionable card.
 *   - A run lives inside ONE turn and is separated only by tool runs of the same
 *     tool and thinking rows. A turn records each approved prompt next to the tool
 *     run it gated (and the model reasons in between), so requiring literal
 *     adjacency would never group a real turn; anything else between two prompts
 *     (text, a user message, another tool) ends the run.
 *   - "Identical" means the same session, tool, description, tool input, outcome
 *     AND decision, with the input actually recorded (see
 *     {@link resolvedPermissionGroupKey}: a replayed record never groups). Folding an allowed request and a denied one into one line, or two
 *     different commands that share a rationale, would lose exactly what the
 *     audit line exists to keep.
 */
import { isPermissionDecision, permissionOutcomeFromDecision } from './pending-permissions'
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
 * Per-message memo of {@link resolvedPermissionGroupKey}. The grouping pass re-runs
 * on every transcript change (every stream delta) and stringifies each resolved
 * prompt's tool input (up to ~10K characters); store messages are replaced, never
 * mutated, so a message object's key never changes.
 */
const keyCache = new WeakMap<ChatMessage, string | null>()

/**
 * Identity of a resolved prompt for grouping, or `null` when the prompt is not
 * resolved (so it can never join a run). Two prompts with an equal non-null key
 * are the same request that ended the same way.
 *
 * The key carries the session, tool, description, tool input, outcome AND the
 * decision token: `allowAlways` writes a persistent rule and must not be hidden
 * inside an "allowed x N" of one-time allows.
 *
 * A prompt whose tool input was NOT recorded keys on its own `requestId`, so it
 * never matches another. That is every record rebuilt from a replayed
 * `permission_outcome`: the server journals the description, not the input (#8503),
 * and the description is chosen by the agent (the server prefers
 * `input.description` over `input.command`), so `rm a` and `rm -rf ~` under one
 * rationale look identical there. Letting the description stand in for the input
 * would fold them into one "allowed x 2" with no input line. Until #8503 journals
 * the input, grouping therefore happens only where the input is known: live.
 */
export function resolvedPermissionGroupKey(m: ChatMessage): string | null {
  if (keyCache.has(m)) return keyCache.get(m)!
  const key = computeGroupKey(m)
  keyCache.set(m, key)
  return key
}

function computeGroupKey(m: ChatMessage): string | null {
  const outcome = resolvedPermissionOutcome(m)
  if (!outcome) return null
  if (m.toolInput == null) return stableStringify(['unrecorded', m.requestId])
  return stableStringify([
    m.originSessionId ?? null,
    m.tool ?? null,
    m.content,
    outcome,
    isPermissionDecision(m.answered) ? m.answered : null,
    m.toolInput,
  ])
}

export interface ResolvedPermissionRun<T> {
  /** Shared {@link resolvedPermissionGroupKey} of every member. */
  key: string
  /** The member prompts, in input order. Always at least `minRunLength` long. */
  items: T[]
  /** Index in the input list of each member (strictly increasing; not necessarily contiguous). */
  indices: number[]
  /** Index of the first member (`indices[0]`). */
  startIndex: number
}

/**
 * Whether an item is a transparent separator: something that sits BETWEEN two
 * members of a run without ending it. Two kinds, either mixed in one item:
 *
 *   - a tool run of `tool` -- a turn records an approved prompt together with the
 *     tool run it gated (`prompt, tool bubble, prompt, tool bubble, ...`), so
 *     identical prompts of one turn are never adjacent. It must be the SAME tool
 *     (a `Read` between two `Bash` approvals is a different story);
 *   - a `thinking` row -- Haiku and Sonnet reason between tool calls
 *     (`prompt, thinking, tool bubble, prompt, ...`), and the reasoning says
 *     nothing about whether the approvals repeat. Thinking stays a standalone row
 *     (#6756), so it is shown where it was either way.
 *
 * Every message of an item must qualify, and a `turnBoundary` on any of them means
 * the next prompt belongs to the next turn. Text, a user message, an error, another
 * tool, a pending prompt or a synthetic row (no messages) is not transparent.
 */
function isTransparentRun(messages: readonly ChatMessage[], tool: string | undefined): boolean {
  if (messages.length === 0) return false
  return messages.every(
    (m) =>
      !m.turnBoundary &&
      (m.type === 'thinking' || (!!tool && m.type === 'tool_use' && m.tool === tool)),
  )
}

/**
 * The runs of identical resolved permission prompts, in one turn, separated by at
 * most tool runs of the same tool and thinking rows.
 *
 * `getMessages` maps an item (a transcript row) to the store messages it stands
 * for: `[m]` for a plain row, the members of a collapsed tool group, `[]` for a
 * synthetic row. Anything that is not a resolved prompt or a same-tool tool run
 * ends the run: a pending prompt, a different request, an assistant text block, a
 * user message, an error, a tool run of another tool, a synthetic row. A `turnBoundary` on a member ends the run after it, so a run
 * never spans two turns. Runs shorter than `minRunLength` (default 2) are not
 * reported: a lone resolved prompt stays its own line.
 *
 * The separating rows are NOT part of a run: the caller leaves them where
 * they are and moves only the members.
 */
export function findResolvedPermissionRuns<T>(
  items: readonly T[],
  getMessages: (item: T) => readonly ChatMessage[] | undefined,
  minRunLength = 2,
): ResolvedPermissionRun<T>[] {
  const runs: ResolvedPermissionRun<T>[] = []
  let current: (ResolvedPermissionRun<T> & { tool: string | undefined }) | null = null
  const flush = () => {
    if (current && current.items.length >= minRunLength) {
      runs.push({ key: current.key, items: current.items, indices: current.indices, startIndex: current.startIndex })
    }
    current = null
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const msgs = getMessages(item) ?? []
    const member = msgs.length === 1 ? msgs[0]! : null
    const key = member ? resolvedPermissionGroupKey(member) : null
    if (member && key !== null) {
      if (current && current.key === key) {
        current.items.push(item)
        current.indices.push(i)
      } else {
        flush()
        current = { key, items: [item], indices: [i], startIndex: i, tool: member.tool }
      }
      if (member.turnBoundary) flush()
    } else if (current && isTransparentRun(msgs, current.tool)) {
      continue
    } else {
      flush()
    }
  }
  flush()
  return runs
}
