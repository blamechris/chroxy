/**
 * Transcript JSONL fixtures for thinking blocks (#7393), in the shape Claude
 * Code 2.1.294 actually writes. Taken from real session transcripts under
 * ~/.claude/projects (structure only; the prose and ids here are made up):
 *
 *   - ONE JSONL entry per content block. A message with a thinking block, a text
 *     block and a tool_use block is three `assistant` entries sharing
 *     `message.id` / `requestId`, told apart by `apiBlockIndex` (0, 1, 2).
 *   - A thinking entry is `{ type: 'assistant', message: { content: [ { type:
 *     'thinking', thinking, signature } ] }, thinkingDurationMs, apiBlockIndex,
 *     isSidechain, uuid, requestId, timestamp, ... }`.
 *   - `thinkingDurationMs` sits on the ENTRY, not on the block (pass `durationMs: null` to omit it).
 *   - When the API was not asked for summaries (the TUI default; every
 *     chroxy-spawned smoke session on disk) `thinking` is the empty string and
 *     only `signature` is populated. With `showThinkingSummaries` on, `thinking`
 *     carries the summary text.
 *   - `usage.output_tokens_details.thinking_tokens` is present on the message.
 */

let n = 0
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const baseEntry = (over = {}) => ({
  parentUuid: null,
  isSidechain: false,
  type: 'assistant',
  uuid: uid(),
  timestamp: '2026-10-08T12:00:05.000Z',
  requestId: 'req_011CZ00000000000000000000',
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/tmp/chroxy-fixture',
  sessionId: 'sess-7393',
  version: '2.1.294',
  gitBranch: 'main',
  ...over,
})

const messageOf = (content, over = {}) => ({
  model: 'claude-haiku-5-5',
  id: 'msg_01FIXTURE0000000000000001',
  type: 'message',
  role: 'assistant',
  content,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
    output_tokens: 423,
    output_tokens_details: { thinking_tokens: 267 },
  },
  ...over,
})

export function thinkingEntry({ text = '', durationMs = 1236, ts, sidechain = false, apiBlockIndex = 0, messageId } = {}) {
  return JSON.stringify(baseEntry({
    ...(ts ? { timestamp: ts } : {}),
    isSidechain: sidechain,
    message: messageOf(
      [{ type: 'thinking', thinking: text, signature: 'EqQBCkYIDBgCKkA'.repeat(8) }],
      messageId ? { id: messageId } : {},
    ),
    ...(durationMs === null ? {} : { thinkingDurationMs: durationMs }),
    apiBlockIndex,
  }))
}

export function redactedThinkingEntry({ ts, apiBlockIndex = 0 } = {}) {
  return JSON.stringify(baseEntry({
    ...(ts ? { timestamp: ts } : {}),
    message: messageOf([{ type: 'redacted_thinking', data: 'ENCRYPTED-PAYLOAD-NOT-READABLE' }]),
    apiBlockIndex,
  }))
}

export function textEntry(text, { ts, apiBlockIndex = 1 } = {}) {
  return JSON.stringify(baseEntry({
    ...(ts ? { timestamp: ts } : {}),
    message: messageOf([{ type: 'text', text }]),
    apiBlockIndex,
  }))
}

export function toolUseEntry({ ts, apiBlockIndex = 2 } = {}) {
  return JSON.stringify(baseEntry({
    ...(ts ? { timestamp: ts } : {}),
    message: messageOf(
      [{ type: 'tool_use', id: 'toolu_01FIXTURE', name: 'Read', input: { file_path: '/tmp/x' } }],
      { stop_reason: 'tool_use' },
    ),
    apiBlockIndex,
  }))
}

export const userEntry = (text = 'hi', ts = '2026-10-08T12:00:00.000Z') => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'user', uuid: uid(), timestamp: ts,
  message: { role: 'user', content: text }, sessionId: 'sess-7393', version: '2.1.294',
})
