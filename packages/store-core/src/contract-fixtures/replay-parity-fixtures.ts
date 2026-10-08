/**
 * Live-vs-replay parity fixtures (#6630).
 *
 * THE PROBLEM THIS PINS
 * ---------------------
 * A resumed chat looked "very different" from the live one, and no test could say
 * why, because the two paths are tested separately. LIVE, a client builds its
 * transcript from the frames the server broadcasts as events happen
 * (`stream_*`, `tool_*`, `message`, ...). On a session switch or a reload it
 * instead REBUILDS the transcript from `history_replay_start` ... `history_replay_end`,
 * where every frame is a history ring-buffer entry. The entries were a hand-picked
 * subset of the live frames, so fields (and whole entry types) were silently
 * missing: an error card vanished, a thinking bubble came back as an answer,
 * the compaction marker lost its metadata.
 *
 * WHAT THIS ADDS
 * --------------
 * `replay-parity-data.ts` holds, per scenario, the server EVENTS in order and the
 * `live` and `replay` wire frames the server produces for them (the server's
 * `tests/replay-parity-wire.test.js` regenerates both from the real code and
 * fails on any drift). Each client's test (`replay-parity.test.ts` in the
 * dashboard, `contract-replay-parity.test.ts` in the app) feeds the SAME frames
 * to its REAL message handler twice, once live and once as a full-rebuild
 * replay, and compares the resulting store messages through {@link replayParityModel}.
 *
 * - A scenario with no entry in {@link REPLAY_PARITY_DIVERGENCES} must produce
 *   EQUAL models live and replayed.
 * - A scenario that does have one is a KNOWN divergence: each side's model is
 *   pinned, so the test goes red when either side changes, and also when the
 *   divergence disappears (the entry must then be deleted: a fixed gap must not
 *   stay documented as open). Every entry names the issue that tracks it.
 *
 * Pure data + a projection: no runtime dependency, so the dashboard's vitest and
 * the app's jest consume it from one place.
 */

import type { ChatMessage } from '../types'
import { REPLAY_PARITY_DATA } from './replay-parity-data'

/** One wire frame, as the server sends it. */
export type ReplayParityFrame = Record<string, unknown>

export interface ReplayParityFixture {
  name: string
  description: string
  /** Providers whose event sequence the scenario models. */
  providers: string[]
  /** The session events, in order: `[eventName, eventData]`. */
  events: Array<[string, Record<string, unknown>]>
  /** What a connected client receives live, in order. */
  live: ReplayParityFrame[]
  /** What a full-rebuild replay delivers (between `history_replay_start`/`_end`). */
  replay: ReplayParityFrame[]
}

// The data is typed by inference (tuples widen to arrays); its shape is what the
// server's wire test generated, so assert it rather than re-declare it.
export const REPLAY_PARITY_FIXTURES: ReplayParityFixture[] = (
  REPLAY_PARITY_DATA as unknown as { scenarios: ReplayParityFixture[] }
).scenarios

/** A message projected for comparison (see {@link replayParityModel}). */
export type ReplayParityRow = Record<string, unknown>

/** The session id every fixture's frames are addressed to. */
export const REPLAY_PARITY_SESSION_ID = 's1'

/**
 * The fields of a store message that decide what the user SEES (and what a
 * renderer's branch ladder switches on). Everything else on a `ChatMessage`
 * (`timestamp`, `answeredAt`, a countdown's `expiresAt`) is bookkeeping a clock
 * writes, which two correct builds never agree on.
 */
const MODEL_FIELDS = [
  'type',
  'content',
  'tool',
  'toolUseId',
  'serverName',
  'toolInput',
  'toolResult',
  'toolResultTruncated',
  'toolResultIsError',
  'toolResultTerminatedReason',
  'toolResultImages',
  'code',
  'attemptedResumeId',
  'timeoutMs',
  'compactMetadata',
  'mcpPromptExpansion',
  'thinkingStreaming',
  'thinkingDurationMs',
  'thinkingTokens',
  'thinkingTruncated',
  'requestId',
  'permissionOutcome',
  'answered',
  'options',
] as const

/**
 * A generated id carries the wall clock or a per-process counter
 * (`m1-cont-1791451539499`, `error-3-1791451539500`, `perm-1-...`). Two builds of
 * the same transcript never agree on those, so compare the stable part: the
 * server-assigned ids pass through untouched.
 */
function stableId(id: unknown): unknown {
  if (typeof id !== 'string') return id
  return id
    .replace(/^([a-z]+)-\d+-\d{9,}$/, '$1-#')
    .replace(/-(cont|post)-\d{9,}$/, '-$1-#')
}

/**
 * Project store messages to the comparable model: stable ids, the visible
 * fields, `undefined` dropped. Order is kept: a transcript in a different order
 * is a different transcript.
 */
export function replayParityModel(messages: readonly ChatMessage[]): ReplayParityRow[] {
  return messages.map((m) => {
    const row: ReplayParityRow = { id: stableId(m.id) }
    const source = m as unknown as Record<string, unknown>
    for (const field of MODEL_FIELDS) {
      if (source[field] !== undefined) row[field] = source[field]
    }
    return row
  })
}

/**
 * Known live-vs-replay divergences, each pinned on both sides and tied to the
 * issue behind it. Keyed by scenario name.
 *
 * `open`: a gap someone should close; the entry is deleted when they do (the
 * test fails once the two sides agree, so it cannot outlive the gap).
 * `by-design`: the two sides differ on purpose; `issue` is the one that set the
 * design, and the entry stays.
 */
export interface ReplayParityDivergence {
  kind: 'open' | 'by-design'
  issue: number
  reason: string
  live: ReplayParityRow[]
  replay: ReplayParityRow[]
}

/** The tool card the `text-around-a-tool` scenario builds, identical on both sides. */
const READ_TOOL_ROW: ReplayParityRow = {
  id: 'tu1',
  type: 'tool_use',
  content: '{"file_path":"/repo/a.js"}',
  tool: 'Read',
  toolUseId: 'tu1',
  toolInput: { file_path: '/repo/a.js' },
  toolResult: 'export const x = 1',
  toolResultTruncated: false,
  toolResultIsError: false,
}

/** The prompt a live client holds for the permission scenarios, once it has been resolved. */
const livePrompt = (over: ReplayParityRow): ReplayParityRow => ({
  id: 'perm-#',
  type: 'prompt',
  content: 'Bash: rm -rf build',
  tool: 'Bash',
  requestId: 'req-1',
  toolInput: { command: 'rm -rf build' },
  ...over,
})

/** The compact record a replay rebuilds: no input to re-review, no countdown. */
const replayedPrompt = (over: ReplayParityRow): ReplayParityRow => ({
  id: 'perm-#',
  type: 'prompt',
  content: 'Bash: rm -rf build',
  tool: 'Bash',
  requestId: 'req-1',
  ...over,
})

const PERMISSION_DESIGN_REASON =
  'A replayed permission prompt is a compact transcript record (#8348): the tool, the description and how it ended. ' +
  'The live card also holds the tool input for review. The rendered line is the same for an answered prompt ' +
  '(dashboard: replay-parity.test.ts renders both); the model is not.'

export const REPLAY_PARITY_DIVERGENCES: Record<string, ReplayParityDivergence> = {
  'text-around-a-tool': {
    kind: 'open',
    issue: 8438,
    reason:
      'Live splits a turn into a bubble before and a bubble after the tool; the history records ONE response entry per stream, pushed at stream_end, so a replay shows the tool first and all the text after it.',
    live: [
      { id: 'm1', type: 'response', content: 'Let me read the file. ' },
      READ_TOOL_ROW,
      { id: 'm1-cont-#', type: 'response', content: 'It exports one constant.' },
    ],
    replay: [
      READ_TOOL_ROW,
      { id: 'm1', type: 'response', content: 'Let me read the file. It exports one constant.' },
    ],
  },
  'tool-result-image': {
    kind: 'open',
    issue: 8439,
    reason: 'The history does not keep tool-result images (unbounded base64 in a ring buffer that is persisted whole).',
    live: [
      {
        id: 'tu1',
        type: 'tool_use',
        content: '{"url":"http://localhost"}',
        tool: 'mcp__browser__screenshot',
        toolUseId: 'tu1',
        serverName: 'browser',
        toolInput: { url: 'http://localhost' },
        toolResult: 'screenshot taken',
        toolResultTruncated: false,
        toolResultIsError: false,
        toolResultImages: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
      },
    ],
    replay: [
      {
        id: 'tu1',
        type: 'tool_use',
        content: '{"url":"http://localhost"}',
        tool: 'mcp__browser__screenshot',
        toolUseId: 'tu1',
        serverName: 'browser',
        toolInput: { url: 'http://localhost' },
        toolResult: 'screenshot taken',
        toolResultTruncated: false,
        toolResultIsError: false,
      },
    ],
  },
  'permission-allowed': {
    kind: 'by-design',
    issue: 8348,
    reason: PERMISSION_DESIGN_REASON,
    live: [livePrompt({ answered: 'allow' })],
    replay: [replayedPrompt({ answered: 'allow', permissionOutcome: 'allowed' })],
  },
  'permission-denied': {
    kind: 'by-design',
    issue: 8348,
    reason: PERMISSION_DESIGN_REASON,
    live: [livePrompt({ answered: 'deny' })],
    replay: [replayedPrompt({ answered: 'deny', permissionOutcome: 'denied' })],
  },
  'permission-expired': {
    kind: 'by-design',
    issue: 7353,
    reason:
      'A live prompt that expired stays on screen as a card with a Dismiss button until the user clears it (#7353), and only then collapses to the record a replay shows straight away.',
    live: [livePrompt({ content: 'Bash: rm -rf build\n(Expired \u2014 this permission was already handled or timed out)' })],
    replay: [replayedPrompt({ permissionOutcome: 'expired' })],
  },
}
