import { describe, it, expect } from 'vitest'
import {
  readAskUserQuestions,
  askUserQuestionHeadline,
  askUserQuestionSummary,
  deriveGatedQuestionIds,
} from './ask-user-question-permission'
import type { ChatMessage } from './types'

const NOW = 1_000_000
const perm = (id: string, o: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, type: 'prompt', content: '', tool: 'AskUserQuestion', requestId: `req-${id}`, expiresAt: NOW + 60_000, timestamp: 1, ...o }) as ChatMessage
const card = (id: string, o: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, type: 'prompt', content: 'Q?', questions: [{ question: 'Q?', options: [] }], timestamp: 1, ...o }) as ChatMessage
const gated = (msgs: ChatMessage[], resolved?: Record<string, string>) =>
  [...deriveGatedQuestionIds(msgs, resolved, NOW)].sort()

describe('deriveGatedQuestionIds (#4685)', () => {
  it('shows a card with no AskUserQuestion permission (auto / bypass modes)', () => {
    expect(gated([card('c1')])).toEqual([])
    expect(deriveGatedQuestionIds(undefined, null, NOW).size).toBe(0)
  })

  it('hides the card while its own permission is pending, in either arrival order', () => {
    expect(gated([perm('p1'), card('c1')])).toEqual(['c1'])
    expect(gated([card('c1'), perm('p1')])).toEqual(['c1'])
  })

  it.each(['allow', 'allowSession', 'allowAlways'])('shows the card once its permission is answered %s', (answered) => {
    expect(gated([perm('p1', { answered }), card('c1')])).toEqual([])
    expect(gated([card('c1'), perm('p1', { answered })])).toEqual([])
  })

  it('keeps a denied question hidden: its own card is the one that was refused', () => {
    expect(gated([perm('p1', { answered: 'deny' }), card('c1')])).toEqual(['c1'])
    expect(gated([perm('p1', { permissionOutcome: 'denied' }), card('c1')])).toEqual(['c1'])
  })

  it('a denied question does not hide a LATER allowed one', () => {
    const msgs = [perm('p1', { answered: 'deny' }), card('c1'), perm('p2', { answered: 'allow' }), card('c2')]
    expect(gated(msgs)).toEqual(['c1'])
  })

  it('the same holds when the later card arrives before its permission', () => {
    const msgs = [perm('p1', { answered: 'deny' }), card('c1'), card('c2'), perm('p2', { answered: 'allow' })]
    expect(gated(msgs)).toEqual(['c1'])
  })

  it('an expired permission (timestamp, outcome record, or stopped) does not hide a later question', () => {
    const expired = perm('p1', { expiresAt: NOW - 1 })
    expect(gated([expired, card('c1'), perm('p2', { answered: 'allow' }), card('c2')])).toEqual([])
    expect(gated([perm('p1', { permissionOutcome: 'expired' }), card('c1')])).toEqual([])
    expect(gated([perm('p1', { permissionOutcome: 'stopped' }), card('c1')])).toEqual([])
    expect(gated([perm('p1', { permissionOutcome: 'expired', expiresAt: undefined }), card('c1'), perm('p2'), card('c2')])).toEqual(['c2'])
  })

  it("a replayed '(resolved)' permission does not hide a later question", () => {
    expect(gated([perm('p1', { answered: '(resolved)' }), card('c1', { answered: '(resolved)' }), perm('p2', { answered: 'allow' }), card('c2')])).toEqual([])
    expect(gated([perm('p1', { answered: '(resolved)' }), card('c2')])).toEqual([])
  })

  it('an unrecognised answered token fails closed', () => {
    expect(gated([perm('p1', { answered: 'mystery' }), card('c1')])).toEqual(['c1'])
  })

  it('a pending permission for another tool never hides a question', () => {
    expect(gated([perm('p1', { tool: 'Bash' }), card('c1')])).toEqual([])
    expect(gated([card('c1'), perm('p1', { tool: undefined })])).toEqual([])
  })

  it('a prompt with no requestId is a question card even if it names AskUserQuestion', () => {
    expect(gated([card('c1', { tool: 'AskUserQuestion' })])).toEqual([])
    expect(gated([perm('p1'), card('c1', { tool: 'AskUserQuestion' })])).toEqual(['c1'])
  })

  it('an answered card is never gated', () => {
    expect(gated([perm('p1'), card('c1', { answered: 'A' })])).toEqual([])
  })

  it('a permission with no toolInput still gates', () => {
    expect(gated([perm('p1', { toolInput: undefined }), card('c1')])).toEqual(['c1'])
  })

  it('opens on a cross-client allow, never on a cross-client deny', () => {
    expect(gated([perm('p1'), card('c1')], { 'req-p1': 'allow' })).toEqual([])
    expect(gated([perm('p1'), card('c1')], { 'req-p1': 'deny' })).toEqual(['c1'])
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
