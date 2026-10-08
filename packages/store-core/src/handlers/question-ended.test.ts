import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../types'
import {
  QUESTION_NOT_DELIVERED_CODE,
  handleQuestionNotDelivered,
  markQuestionEnded,
  endQuestionInSessions,
  questionEndedNotice,
  handlePermissionResolved,
} from './index'
import {
  QUESTION_INTERRUPTED_PLACEHOLDER,
  QUESTION_SUPERSEDED_PLACEHOLDER,
  QUESTION_NOT_DELIVERED_PLACEHOLDER,
  REPLAY_RESOLVED_PLACEHOLDER,
  isQuestionNoAnswerToken,
} from '../replay-reconcile'

const q = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  type: 'prompt',
  content: 'First?',
  toolUseId: 'ask-1',
  timestamp: 1,
  ...over,
})

describe('handleQuestionNotDelivered (#8470)', () => {
  it('reads the toolUseId of the QUESTION_NOT_DELIVERED error', () => {
    expect(handleQuestionNotDelivered({ type: 'error', code: QUESTION_NOT_DELIVERED_CODE, toolUseId: 'ask-1' })).toEqual({ toolUseId: 'ask-1' })
  })
  it('ignores every other error code, and a frame without an id', () => {
    expect(handleQuestionNotDelivered({ type: 'error', code: 'MODEL_NOT_APPLIED', toolUseId: 'ask-1' })).toBeNull()
    expect(handleQuestionNotDelivered({ type: 'error', code: QUESTION_NOT_DELIVERED_CODE })).toBeNull()
    expect(handleQuestionNotDelivered({ type: 'error', code: QUESTION_NOT_DELIVERED_CODE, toolUseId: '' })).toBeNull()
    expect(handleQuestionNotDelivered({ type: 'error', code: QUESTION_NOT_DELIVERED_CODE, toolUseId: 7 })).toBeNull()
  })
})

describe('handlePermissionResolved carries the question id (#8470)', () => {
  it('parses toolUseId, and leaves requestId null on the question variant', () => {
    const r = handlePermissionResolved({ type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'superseded' })
    expect(r.toolUseId).toBe('ask-1')
    expect(r.requestId).toBeNull()
    expect(r.reason).toBe('superseded')
    expect(handlePermissionResolved({ requestId: 'r', decision: 'allow' }).toolUseId).toBeNull()
  })
})

describe('markQuestionEnded (#8470)', () => {
  it('superseded: a waiting card becomes superseded', () => {
    const out = markQuestionEnded([q()], 'ask-1', 'superseded')
    expect(out?.[0].answered).toBe(QUESTION_SUPERSEDED_PLACEHOLDER)
  })
  it('superseded: the replay sweep placeholder is replaced; a real answer is kept', () => {
    expect(markQuestionEnded([q({ answered: REPLAY_RESOLVED_PLACEHOLDER })], 'ask-1', 'superseded')?.[0].answered).toBe(QUESTION_SUPERSEDED_PLACEHOLDER)
    expect(markQuestionEnded([q({ answered: 'A1' })], 'ask-1', 'superseded')).toBeNull()
  })
  it('notDelivered: retracts the answer the client marked on send, and what rendered it', () => {
    const held = q({ answered: 'A1', answeredAt: 5, answeredAnswers: { 'First?': 'A1' } })
    const out = markQuestionEnded([held], 'ask-1', 'notDelivered')!
    expect(out[0].answered).toBe(QUESTION_NOT_DELIVERED_PLACEHOLDER)
    expect(out[0].answeredAt).toBeUndefined()
    expect('answeredAnswers' in out[0]).toBe(false)
    expect(out[0].content).toBe('First?')
  })
  it('a card already ended without an answer keeps its first reason', () => {
    for (const answered of [QUESTION_INTERRUPTED_PLACEHOLDER, QUESTION_SUPERSEDED_PLACEHOLDER, QUESTION_NOT_DELIVERED_PLACEHOLDER]) {
      expect(markQuestionEnded([q({ answered })], 'ask-1', 'notDelivered')).toBeNull()
      expect(markQuestionEnded([q({ answered })], 'ask-1', 'superseded')).toBeNull()
    }
  })
  it('matches only the question card with that id: not a permission prompt, not another question, not another type', () => {
    const msgs = [
      q({ id: 'perm', requestId: 'req-1', toolUseId: 'ask-1' }),
      q({ id: 'other', toolUseId: 'ask-2' }),
      q({ id: 'tool', type: 'tool_use', toolUseId: 'ask-1' }),
    ]
    expect(markQuestionEnded(msgs, 'ask-1', 'notDelivered')).toBeNull()
    expect(markQuestionEnded(msgs, 'ask-9', 'superseded')).toBeNull()
  })
  it('returns null (no store write) when nothing changed, and leaves other messages untouched', () => {
    const other = q({ id: 'other', toolUseId: 'ask-2' })
    const out = markQuestionEnded([other, q()], 'ask-1', 'superseded')!
    expect(out[0]).toBe(other)
  })
})

describe('endQuestionInSessions (#8470)', () => {
  it('finds the card in whichever session holds it', () => {
    const sessions = { a: { messages: [q({ id: 'x', toolUseId: 'ask-9' })] }, b: { messages: [q()] } }
    const out = endQuestionInSessions(sessions, 'ask-1', 'superseded')!
    expect(out.sessionId).toBe('b')
    expect(out.messages[0].answered).toBe(QUESTION_SUPERSEDED_PLACEHOLDER)
  })
  it('returns null when no session holds a card that needs the change', () => {
    expect(endQuestionInSessions({ a: { messages: [q({ answered: 'A1' })] }, c: undefined }, 'ask-1', 'superseded')).toBeNull()
    expect(endQuestionInSessions({}, 'ask-1', 'notDelivered')).toBeNull()
  })
})

describe('questionEndedNotice (#8470)', () => {
  it('names each no-answer token, and nothing else', () => {
    expect(questionEndedNotice(QUESTION_INTERRUPTED_PLACEHOLDER)?.kind).toBe('interrupted')
    expect(questionEndedNotice(QUESTION_INTERRUPTED_PLACEHOLDER)?.label).toBe('Interrupted — chroxy restarted before this was answered')
    expect(questionEndedNotice(QUESTION_SUPERSEDED_PLACEHOLDER)?.kind).toBe('superseded')
    expect(questionEndedNotice(QUESTION_NOT_DELIVERED_PLACEHOLDER)?.kind).toBe('notDelivered')
    for (const v of [undefined, null, '', 'A1', REPLAY_RESOLVED_PLACEHOLDER, 'allow']) {
      expect(questionEndedNotice(v)).toBeNull()
    }
  })
  it('agrees with isQuestionNoAnswerToken on every value', () => {
    for (const v of [QUESTION_INTERRUPTED_PLACEHOLDER, QUESTION_SUPERSEDED_PLACEHOLDER, QUESTION_NOT_DELIVERED_PLACEHOLDER, REPLAY_RESOLVED_PLACEHOLDER, 'A1', undefined]) {
      expect(questionEndedNotice(v) !== null).toBe(isQuestionNoAnswerToken(v))
    }
  })
})
