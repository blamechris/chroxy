import { describe, it, expect } from 'vitest'
import { getErrorPresentation, type ErrorKind } from './error-presentation'
import { RETRYABLE_ASK_USER_QUESTION_ERROR_CODES } from './ask-user-question-errors'

describe('getErrorPresentation', () => {
  const cases: Array<[string, ErrorKind, 'status' | 'alert']> = [
    ['stream_stall', 'stall', 'status'],
    ['resume_unknown', 'resume', 'status'],
    ['resume_unknown_exhausted', 'resume', 'alert'],
  ]
  it.each(cases)('maps %s → kind %s / role %s with a headline', (code, kind, role) => {
    const p = getErrorPresentation(code)
    expect(p.kind).toBe(kind)
    expect(p.role).toBe(role)
    expect(p.headline.length).toBeGreaterThan(0)
  })

  it('maps every retryable AskUserQuestion code to the shared question presentation', () => {
    // Drives off the single-source-of-truth set so a future code is covered for free.
    for (const code of RETRYABLE_ASK_USER_QUESTION_ERROR_CODES) {
      const p = getErrorPresentation(code)
      expect(p.kind).toBe('question')
      expect(p.role).toBe('status')
      expect(p.headline).toBe('Question delivery failed — retry?')
    }
  })

  it('makes the exhausted resume terminal (alert) but the recoverable one polite (status)', () => {
    expect(getErrorPresentation('resume_unknown_exhausted').role).toBe('alert')
    expect(getErrorPresentation('resume_unknown').role).toBe('status')
  })

  it('falls back to generic/alert for unknown, empty, null, undefined — never throws', () => {
    const fallbacks: Array<string | null | undefined> = ['totally_unknown_code', '', null, undefined]
    for (const code of fallbacks) {
      const p = getErrorPresentation(code)
      expect(p.kind).toBe('generic')
      expect(p.role).toBe('alert')
      expect(p.headline.length).toBeGreaterThan(0)
    }
  })

  it('returns a non-empty headline for every known code', () => {
    const known = [
      'stream_stall',
      'resume_unknown',
      'resume_unknown_exhausted',
      ...RETRYABLE_ASK_USER_QUESTION_ERROR_CODES,
    ]
    for (const code of known) {
      expect(getErrorPresentation(code).headline.length).toBeGreaterThan(0)
    }
  })
})
