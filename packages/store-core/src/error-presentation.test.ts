import { describe, it, expect } from 'vitest'
import { AUTH_REQUIRED_CAUSES } from '@chroxy/protocol'
import { getErrorPresentation, getAuthRequiredPresentation, parseAuthCause, AUTH_PRESENTATION_BY_CAUSE, CLAUDE_LOGIN_COMMAND, type ErrorKind } from './error-presentation'
import { RETRYABLE_ASK_USER_QUESTION_ERROR_CODES } from './ask-user-question-errors'

describe('getErrorPresentation', () => {
  const cases: Array<[string, ErrorKind, 'status' | 'alert']> = [
    ['stream_stall', 'stall', 'status'],
    ['resume_unknown', 'resume', 'status'],
    ['resume_unknown_exhausted', 'resume', 'alert'],
    // #8223: signing in is the only fix, so it is terminal (alert), not a retry.
    ['AUTH_REQUIRED', 'auth', 'alert'],
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

  it('words AUTH_REQUIRED as a sign-in problem, not a retry (#8223)', () => {
    const p = getErrorPresentation('AUTH_REQUIRED')
    expect(p.headline).toBe('Claude is not signed in on this host')
    expect(p.headline).not.toMatch(/retry/i)
  })

  // #8223: the dashboard and app chips render this; a stale `claude login` is what the
  // constant exists to prevent. The server keeps its own definition, pinned to this one
  // by packages/server/tests/claude-login-command.test.js.
  it('names the current login command (claude 2.1.x spells it `auth login`)', () => {
    expect(CLAUDE_LOGIN_COMMAND).toBe('claude auth login')
  })

  it('matches AUTH_REQUIRED case-sensitively, like every other code', () => {
    expect(getErrorPresentation('auth_required').kind).toBe('generic')
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
      'AUTH_REQUIRED',
      ...RETRYABLE_ASK_USER_QUESTION_ERROR_CODES,
    ]
    for (const code of known) {
      expect(getErrorPresentation(code).headline.length).toBeGreaterThan(0)
    }
  })
})

// #8273: the AUTH_REQUIRED chip names the cause the server knows, not always a host login.
describe('getAuthRequiredPresentation', () => {
  it('login: the existing headline and the host login command', () => {
    const p = getAuthRequiredPresentation('login')
    expect(p.headline).toBe('Claude is not signed in on this host')
    expect(p.showLoginCommand).toBe(true)
  })

  it('an absent or unknown cause falls back to the login presentation (older servers)', () => {
    for (const cause of [undefined, null, '', 'something_new']) {
      expect(getAuthRequiredPresentation(cause)).toEqual(getAuthRequiredPresentation('login'))
    }
  })

  it('api_key: says the key was rejected and offers no login command', () => {
    const p = getAuthRequiredPresentation('api_key')
    expect(p.headline).toBe('Your Anthropic API key was rejected')
    expect(p.showLoginCommand).toBe(false)
  })

  it('container: says the container needs ANTHROPIC_API_KEY and offers no host login command', () => {
    const p = getAuthRequiredPresentation('container')
    expect(p.headline).toMatch(/container/i)
    expect(p.headline).toMatch(/ANTHROPIC_API_KEY/)
    expect(p.showLoginCommand).toBe(false)
  })

  it('keeps the alert role for every cause', () => {
    for (const cause of [...AUTH_REQUIRED_CAUSES, undefined]) {
      expect(getAuthRequiredPresentation(cause).role).toBe('alert')
    }
  })
})

describe('parseAuthCause', () => {
  it('accepts exactly the known causes', () => {
    expect(['login', 'api_key', 'container'].map(parseAuthCause)).toEqual(['login', 'api_key', 'container'])
    for (const bad of ['', 'API_KEY', 'sk-ant-x', 7, null, undefined, {}]) expect(parseAuthCause(bad)).toBeUndefined()
  })
})

// #8970: the server's cause roster and the clients' presentation map must agree in
// BOTH directions. The expected list is written out by hand on purpose: deriving it
// from either side would leave the test unable to go red (an expectation derived from
// its own subject, docs/false-safety-guards.md), and a one-directional check is the
// roster-checked-one-way class from the same catalogue.
describe('AUTH_REQUIRED cause roster parity (#8970)', () => {
  const EXPECTED = ['api_key', 'api_key_helper', 'auth_token', 'bedrock', 'container', 'login', 'vertex']

  it('the server roster is exactly the expected causes', () => {
    expect([...AUTH_REQUIRED_CAUSES].sort()).toEqual(EXPECTED)
  })

  it('every server cause has a client presentation', () => {
    const missing = AUTH_REQUIRED_CAUSES.filter((c) => !Object.hasOwn(AUTH_PRESENTATION_BY_CAUSE, c))
    expect(missing).toEqual([])
  })

  it('every client presentation is for a real server cause', () => {
    const orphans = Object.keys(AUTH_PRESENTATION_BY_CAUSE).filter(
      (c) => !(AUTH_REQUIRED_CAUSES as readonly string[]).includes(c),
    )
    expect(orphans).toEqual([])
  })

  it('every cause parses, and only the login cause offers the host login command', () => {
    for (const c of AUTH_REQUIRED_CAUSES) {
      expect(parseAuthCause(c)).toBe(c)
      expect(getAuthRequiredPresentation(c).showLoginCommand).toBe(c === 'login')
    }
  })

  it('every mechanism gets its own headline', () => {
    const headlines = AUTH_REQUIRED_CAUSES.map((c) => getAuthRequiredPresentation(c).headline)
    expect(new Set(headlines).size).toBe(AUTH_REQUIRED_CAUSES.length)
    expect(getAuthRequiredPresentation('bedrock').headline).toMatch(/Bedrock/)
    expect(getAuthRequiredPresentation('vertex').headline).toMatch(/Vertex/)
    expect(getAuthRequiredPresentation('auth_token').headline).toMatch(/ANTHROPIC_AUTH_TOKEN/)
    expect(getAuthRequiredPresentation('api_key_helper').headline).toMatch(/apiKeyHelper/)
  })
})
