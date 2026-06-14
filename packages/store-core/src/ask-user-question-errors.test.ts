/**
 * Tests for the retryable AskUserQuestion error predicate (#5793).
 *
 * Single source of truth for "is this an AskUserQuestion teardown error the
 * user can recover from by resending?" — narrowed by both clients' stall-chip
 * / retry render paths and by `buildChatViewMessages`' stalled-prompt
 * suppression. A drift here silently drops the retry UX on a code, so the set
 * is pinned exactly.
 */
import { describe, it, expect } from 'vitest'
import {
  RETRYABLE_ASK_USER_QUESTION_ERROR_CODES,
  isRetryableAskUserQuestionError,
} from './ask-user-question-errors'

describe('isRetryableAskUserQuestionError (#5793)', () => {
  it.each([
    'ASK_USER_QUESTION_STALL',
    'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED',
    'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE',
    'ASK_USER_QUESTION_MULTISELECT_EMPTY',
    'ASK_USER_QUESTION_MULTISELECT_BUSY',
    'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED',
  ])('is true for %s', (code) => {
    expect(isRetryableAskUserQuestionError(code)).toBe(true)
  })

  it.each([
    'stream_stall',
    'resume_unknown',
    'SESSION_TOKEN_MISMATCH',
    'UNKNOWN',
    '',
    'ASK_USER_QUESTION', // prefix-only must not match
  ])('is false for unrelated code %s', (code) => {
    expect(isRetryableAskUserQuestionError(code)).toBe(false)
  })

  it('is false for null / undefined', () => {
    expect(isRetryableAskUserQuestionError(null)).toBe(false)
    expect(isRetryableAskUserQuestionError(undefined)).toBe(false)
  })

  it('exports the exact set of six codes', () => {
    expect([...RETRYABLE_ASK_USER_QUESTION_ERROR_CODES].sort()).toEqual(
      [
        'ASK_USER_QUESTION_MULTISELECT_BUSY',
        'ASK_USER_QUESTION_MULTISELECT_EMPTY',
        'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE',
        'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED',
        'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED',
        'ASK_USER_QUESTION_STALL',
      ].sort(),
    )
  })
})
