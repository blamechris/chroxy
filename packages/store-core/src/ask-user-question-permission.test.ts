import { describe, it, expect } from 'vitest'
import {
  readAskUserQuestions,
  askUserQuestionHeadline,
  askUserQuestionSummary,
  deriveGatedQuestionIds,
} from './ask-user-question-permission'
import type { ChatMessage } from './types'

const NOW = 1_000_000
/** An AskUserQuestion permission prompt, carrying its pairing id `t<n>` unless told otherwise. */
const perm = (n: string, o: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `p${n}`, type: 'prompt', content: '', tool: 'AskUserQuestion', requestId: `req-${n}`, permissionToolUseId: `t${n}`, expiresAt: NOW + 60_000, timestamp: 1, ...o }) as ChatMessage
/** An id-less permission, as an older daemon sends it. */
const bare = (n: string, o: Partial<ChatMessage> = {}): ChatMessage => perm(n, { permissionToolUseId: undefined, ...o })
/** The question card for call `t<n>`. */
const card = (n: string, o: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `c${n}`, type: 'prompt', content: 'Q?', toolUseId: `t${n}`, questions: [{ question: 'Q?', options: [] }], timestamp: 1, ...o }) as ChatMessage
const toolStart = (n: string, tool = 'AskUserQuestion'): ChatMessage =>
  ({ id: `ts${n}`, type: 'tool_use', content: '', tool, toolUseId: `t${n}`, timestamp: 1 }) as ChatMessage
const gated = (msgs: ChatMessage[], resolved?: Record<string, string>) =>
  [...deriveGatedQuestionIds(msgs, resolved, NOW)].sort()

describe('deriveGatedQuestionIds, paired by id (#4685)', () => {
  it('shows a card with no AskUserQuestion permission (auto / bypass modes)', () => {
    expect(gated([card('1')])).toEqual([])
    expect(deriveGatedQuestionIds(undefined, null, NOW).size).toBe(0)
  })

  it('hides the card while its own permission is pending, in either arrival order', () => {
    expect(gated([perm('1'), card('1')])).toEqual(['c1'])
    expect(gated([card('1'), perm('1')])).toEqual(['c1'])
  })

  it('pairs by id however far apart the two are', () => {
    const between = ({ id: 'r', type: 'response', content: 'x', timestamp: 1 }) as ChatMessage
    expect(gated([perm('1'), between, between, card('1')])).toEqual(['c1'])
  })

  it.each(['allow', 'allowSession', 'allowAlways'])('shows the card once its permission is answered %s', (answered) => {
    expect(gated([perm('1', { answered }), card('1')])).toEqual([])
  })

  it('keeps a denied question hidden: its own card is the one refused', () => {
    expect(gated([perm('1', { answered: 'deny' }), card('1')])).toEqual(['c1'])
    expect(gated([perm('1', { permissionOutcome: 'denied' }), card('1')])).toEqual(['c1'])
  })

  it('a denied question does not hide a LATER allowed one, in either order', () => {
    expect(gated([perm('1', { answered: 'deny' }), card('1'), perm('2', { answered: 'allow' }), card('2')])).toEqual(['c1'])
    expect(gated([perm('1', { answered: 'deny' }), card('1'), card('2'), perm('2', { answered: 'allow' })])).toEqual(['c1'])
  })

  it('A: an answered card with NO permission, then a pending pair: only the pair is gated', () => {
    expect(gated([card('1', { answered: 'Red' }), perm('2'), card('2')])).toEqual(['c2'])
  })

  it('B: an unanswered card with NO permission (a denied form), then a pending pair: the pair is gated, the orphan is not', () => {
    expect(gated([card('1'), perm('2'), card('2')])).toEqual(['c2'])
    expect(gated([card('1'), card('2'), perm('2')])).toEqual(['c2'])
  })

  it('D: a denied permission with NO card does not hide a later auto-mode card', () => {
    expect(gated([perm('1', { answered: 'deny' }), card('2')])).toEqual([])
    expect(gated([perm('1'), card('2')])).toEqual([])
  })

  it('a trimmed history (the earlier card and permission gone) gates only what it still holds', () => {
    expect(gated([perm('3', { answered: 'allow' }), card('3'), perm('4'), card('4')])).toEqual(['c4'])
    expect(gated([card('4'), perm('5', { answered: 'deny' })])).toEqual([])
  })

  it('an id that matches nothing pairs with nothing', () => {
    expect(gated([perm('1'), card('2')])).toEqual([])
  })

  it('an expired permission (timestamp, outcome record, or stopped) hides nothing', () => {
    expect(gated([perm('1', { expiresAt: NOW - 1 }), card('1')])).toEqual([])
    expect(gated([perm('1', { permissionOutcome: 'expired', expiresAt: undefined }), card('1')])).toEqual([])
    expect(gated([perm('1', { permissionOutcome: 'stopped', expiresAt: undefined }), card('1')])).toEqual([])
    expect(gated([perm('1', { expiresAt: NOW - 1 }), card('1'), perm('2'), card('2')])).toEqual(['c2'])
  })

  it("a replayed '(resolved)' permission hides nothing", () => {
    expect(gated([perm('1', { answered: '(resolved)' }), card('1')])).toEqual([])
  })

  it("a replayed '(resolved)' CARD is still gated while its own permission is pending or denied", () => {
    expect(gated([perm('1'), card('1', { answered: '(resolved)' })])).toEqual(['c1'])
    expect(gated([perm('1', { answered: 'deny' }), card('1', { answered: '(resolved)' })])).toEqual(['c1'])
    expect(gated([perm('1', { answered: 'allow' }), card('1', { answered: '(resolved)' })])).toEqual([])
  })

  it('a card that ended with no answer (interrupted, superseded) is not gated', () => {
    expect(gated([perm('1'), card('1', { answered: '(interrupted)' })])).toEqual([])
  })

  it('an unrecognised answered token fails closed', () => {
    expect(gated([perm('1', { answered: 'mystery' }), card('1')])).toEqual(['c1'])
  })

  it('a pending permission for another tool never hides a question', () => {
    expect(gated([perm('1', { tool: 'Bash' }), card('1')])).toEqual([])
    expect(gated([card('1'), perm('1', { tool: undefined })])).toEqual([])
  })

  it('a prompt with no requestId is a question card even if it names AskUserQuestion', () => {
    expect(gated([card('1', { tool: 'AskUserQuestion' })])).toEqual([])
    expect(gated([perm('1'), card('1', { tool: 'AskUserQuestion' })])).toEqual(['c1'])
  })

  it('an answered card is never gated', () => {
    expect(gated([perm('1'), card('1', { answered: 'A' })])).toEqual([])
  })

  it('a permission with no toolInput still gates', () => {
    expect(gated([perm('1', { toolInput: undefined }), card('1')])).toEqual(['c1'])
  })

  it('opens on a cross-client allow, never on a cross-client deny', () => {
    expect(gated([perm('1'), card('1')], { 'req-1': 'allow' })).toEqual([])
    expect(gated([perm('1'), card('1')], { 'req-1': 'deny' })).toEqual(['c1'])
  })
})

describe('deriveGatedQuestionIds, fallback for a daemon that sends no id (#4685)', () => {
  it('pairs an id-less permission with the card right after or right before it', () => {
    expect(gated([bare('1'), card('1')])).toEqual(['c1'])
    expect(gated([card('1'), bare('1')])).toEqual(['c1'])
  })

  it("skips only the same call's tool_start bubble between them", () => {
    expect(gated([bare('1'), toolStart('1'), card('1')])).toEqual(['c1'])
    expect(gated([toolStart('1'), card('1'), bare('1')])).toEqual(['c1'])
  })

  it('does not reach across any other message', () => {
    const response = ({ id: 'r', type: 'response', content: 'x', timestamp: 1 }) as ChatMessage
    expect(gated([bare('1', { answered: 'deny' }), response, card('2')])).toEqual([])
    expect(gated([bare('1'), toolStart('9', 'Bash'), card('1')])).toEqual([])
  })

  it('an unpaired card before a real pair does not shift it', () => {
    expect(gated([card('1', { answered: 'Red' }), bare('2'), card('2')])).toEqual(['c2'])
    expect(gated([card('1'), bare('2'), card('2')])).toEqual(['c2'])
  })

  it('a denied pair does not hide a later allowed pair', () => {
    expect(gated([bare('1', { answered: 'deny' }), card('1'), bare('2', { answered: 'allow' }), card('2')])).toEqual(['c1'])
  })

  it("a replayed '(resolved)' card is gated by its adjacent pending permission", () => {
    expect(gated([bare('1'), card('1', { answered: '(resolved)' })])).toEqual(['c1'])
  })

  it('mixes: an id-carrying pair and an id-less pair resolve independently', () => {
    expect(gated([perm('1'), card('1'), bare('2', { answered: 'allow' }), card('2')])).toEqual(['c1'])
  })

  it('a permission is never mistaken for a card: two adjacent permissions pair with nothing', () => {
    expect(gated([bare('1', { answered: 'deny' }), bare('2'), card('2')])).toEqual(['c2'])
  })

  it('an id-carrying permission is never paired by adjacency', () => {
    expect(gated([perm('1'), card('2')])).toEqual([])
  })
})

describe('AskUserQuestion permission body helpers (#8264)', () => {
  const input = { questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] }
  it('reads questions and options, dropping the synthetic Other', () => {
    const qs = readAskUserQuestions(input)
    expect(qs.map((q) => q.question)).toEqual(['Pick'])
    expect(qs[0].options.map((o) => o.label)).toEqual(['A', 'B'])
  })
  it('returns [] for unusable input', () => {
    expect(readAskUserQuestions(undefined)).toEqual([])
    expect(readAskUserQuestions({ _truncated: true, summary: 'x' })).toEqual([])
  })
  it('words the headline and summary', () => {
    expect(askUserQuestionHeadline(1)).toBe('Claude wants to ask you a question')
    expect(askUserQuestionHeadline(3)).toBe('Claude wants to ask you 3 questions')
    expect(askUserQuestionSummary(input)).toBe('Pick')
    expect(askUserQuestionSummary(undefined)).toBe('Claude wants to ask you a question')
  })
})
