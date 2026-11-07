import { describe, it, expect } from 'vitest'
import {
  readAskUserQuestions,
  askUserQuestionHeadline,
  askUserQuestionSummary,
  hasPendingAskUserQuestionPermission,
} from './ask-user-question-permission'
import type { ChatMessage } from './types'

const perm = (o: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'p', type: 'prompt', content: '', tool: 'AskUserQuestion', requestId: 'r1', timestamp: 1, ...o }) as ChatMessage

describe('hasPendingAskUserQuestionPermission (#4685)', () => {
  it('is open (false) with no AskUserQuestion permission', () => {
    expect(hasPendingAskUserQuestionPermission([])).toBe(false)
    expect(hasPendingAskUserQuestionPermission(undefined)).toBe(false)
    expect(hasPendingAskUserQuestionPermission([perm({ tool: 'Bash' })])).toBe(false)
  })
  it('is closed while the permission is unanswered', () => {
    expect(hasPendingAskUserQuestionPermission([perm()])).toBe(true)
  })
  it.each(['allow', 'allowSession', 'allowAlways'])('opens on %s', (answered) => {
    expect(hasPendingAskUserQuestionPermission([perm({ answered })])).toBe(false)
  })
  it.each(['deny', '(resolved)', ''])('stays closed on %j', (answered) => {
    expect(hasPendingAskUserQuestionPermission([perm({ answered })])).toBe(true)
  })
  it('opens on a cross-client decision, but never on a cross-client deny', () => {
    expect(hasPendingAskUserQuestionPermission([perm()], { r1: 'allow' })).toBe(false)
    expect(hasPendingAskUserQuestionPermission([perm()], { r1: 'deny' })).toBe(true)
  })
  it('one unresolved permission keeps it closed even if another was allowed', () => {
    const msgs = [perm({ answered: 'allow' }), perm({ id: 'p2', requestId: 'r2' })]
    expect(hasPendingAskUserQuestionPermission(msgs)).toBe(true)
  })
  it('a question card (no requestId) never gates itself', () => {
    expect(hasPendingAskUserQuestionPermission([perm({ requestId: undefined })])).toBe(false)
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
