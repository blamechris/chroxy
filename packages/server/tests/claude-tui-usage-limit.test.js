import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  classifyUsageLimit,
  classifyApiErrorEntry,
  USAGE_LIMIT_CODE,
  API_RATE_LIMIT_CODE,
  API_OVERLOADED_CODE,
} from '../src/claude-tui/usage-limit.js'

/**
 * #8400 — the pure classifier for claude's usage-limit / rate-limit / overload
 * messages. The fixture is real claude wording (structured `isApiErrorMessage`
 * transcript entries), not invented text.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-usage-limit-entries.jsonl')
const entries = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const textOf = (e) => e.message.content[0].text
const [sessionE, weeklyE, creditsE, overloadedE, serverErrorE, authE] = entries

describe('classifyUsageLimit — real claude wording', () => {
  it('session limit, with the reset time', () => {
    const r = classifyUsageLimit(textOf(sessionE))
    assert.equal(r.kind, 'session')
    assert.equal(r.code, USAGE_LIMIT_CODE)
    assert.equal(r.resetsAt, '11:30pm (America/Los_Angeles)')
    assert.equal(r.message, "Claude's session usage limit was reached. It resets 11:30pm (America/Los_Angeles); messages will not go through until then.")
    assert.equal(r.episodeKey, 'session|11:30pm (America/Los_Angeles)')
  })

  it('weekly limit, with a date and a time', () => {
    const r = classifyUsageLimit(textOf(weeklyE))
    assert.equal(r.kind, 'weekly')
    assert.equal(r.resetsAt, 'Jul 22 at 4pm (America/Los_Angeles)')
    assert.ok(r.message.startsWith("Claude's weekly usage limit was reached. It resets Jul 22 at 4pm"), r.message)
  })

  it('a model that needs usage credits', () => {
    const r = classifyUsageLimit(textOf(creditsE))
    assert.equal(r.kind, 'credits')
    assert.equal(r.code, USAGE_LIMIT_CODE)
    assert.equal(r.resetsAt, null)
    assert.ok(/usage credits/.test(r.message), r.message)
  })

  it('overloaded (529) is a transient failure with no episode window', () => {
    const r = classifyUsageLimit(textOf(overloadedE))
    assert.equal(r.kind, 'overloaded')
    assert.equal(r.code, API_OVERLOADED_CODE)
    assert.equal(r.episodeKey, null)
    assert.ok(/overloaded/.test(r.message), r.message)
  })

  it('does not classify a 500, an auth failure or an empty value', () => {
    assert.equal(classifyUsageLimit(textOf(serverErrorE)), null)
    assert.equal(classifyUsageLimit(textOf(authE)), null)
    assert.equal(classifyUsageLimit(''), null)
    assert.equal(classifyUsageLimit(undefined), null)
    assert.equal(classifyUsageLimit(42), null)
  })
})

describe('classifyUsageLimit — other wordings', () => {
  it('older "5-hour limit reached ∙ resets 3pm"', () => {
    const r = classifyUsageLimit('5-hour limit reached ∙ resets 3pm')
    assert.equal(r.kind, 'session')
    assert.equal(r.resetsAt, '3pm')
  })

  it('"Weekly limit reached" and "Opus weekly limit reached" are weekly', () => {
    assert.equal(classifyUsageLimit('Weekly limit reached ∙ resets Mon 9am').kind, 'weekly')
    assert.equal(classifyUsageLimit('Opus weekly limit reached ∙ resets 9am').kind, 'weekly')
  })

  it('"You\'ve hit your limit" with no named window is a plain usage limit', () => {
    const r = classifyUsageLimit("You've hit your limit · resets 4am (America/Los_Angeles)")
    assert.equal(r.kind, 'usage')
    assert.ok(r.message.startsWith("Claude's usage limit was reached. It resets 4am"), r.message)
  })

  it('a typographic apostrophe', () => {
    assert.equal(classifyUsageLimit('You’ve hit your weekly limit · resets 4pm').kind, 'weekly')
  })

  it('legacy "Claude AI usage limit reached|<epoch seconds>" reads the epoch as UTC', () => {
    const r = classifyUsageLimit('Claude AI usage limit reached|1760000000')
    assert.equal(r.kind, 'usage')
    assert.equal(r.resetsAt, '2025-10-09 08:53 UTC')
  })

  it('no reset time: says it resets without inventing one', () => {
    const r = classifyUsageLimit("You've hit your session limit")
    assert.equal(r.resetsAt, null)
    assert.equal(r.message, "Claude's session usage limit was reached. Messages will not go through until it resets.")
  })

  it('"resets in 2 hours"', () => {
    assert.equal(classifyUsageLimit('Claude usage limit reached. Your limit resets in 2 hours 10 minutes.').resetsAt, 'in 2 hours 10 minutes')
  })

  it('API 429 and rate_limit_error', () => {
    for (const text of [
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}}',
      'rate_limit_error: too many requests',
    ]) {
      const r = classifyUsageLimit(text)
      assert.equal(r.kind, 'rate_limit', text)
      assert.equal(r.code, API_RATE_LIMIT_CODE)
      assert.equal(r.episodeKey, null)
    }
  })

  it('overloaded_error', () => {
    assert.equal(classifyUsageLimit('overloaded_error: the API is temporarily overloaded').kind, 'overloaded')
  })
})

describe('classifyUsageLimit — the squeezed PTY tail (cursor moves deleted)', () => {
  it('matches the session banner with every space removed and rebuilds the reset time', () => {
    const squeezed = textOf(sessionE).replace(/\s+/g, '')
    assert.ok(!squeezed.includes(' '), 'precondition: no whitespace left')
    const r = classifyUsageLimit(squeezed)
    assert.equal(r.kind, 'session')
    assert.equal(r.resetsAt, '11:30pm (America/Los_Angeles)')
  })

  it('matches the weekly banner squeezed, with the date', () => {
    const r = classifyUsageLimit(textOf(weeklyE).replace(/\s+/g, ''))
    assert.equal(r.kind, 'weekly')
    assert.equal(r.resetsAt, 'Jul 22 at 4pm (America/Los_Angeles)')
  })

  it('matches a banner wrapped over several lines and padded with box drawing spaces', () => {
    const r = classifyUsageLimit("  You've hit your\n    session limit · resets\n    11:30pm\n    (America/Los_Angeles)  ")
    assert.equal(r.kind, 'session')
    assert.equal(r.resetsAt, '11:30pm (America/Los_Angeles)')
  })
})

describe('classifyUsageLimit — ordinary output that merely mentions a limit', () => {
  const ordinary = [
    'The rate limit for this endpoint is 100 requests per minute.',
    'Set a limit of 5 and retry with backoff.',
    'The usage limit docs describe the plans in detail.',
    'This resets the counter to zero every hour.',
    'The loop exceeded the memory limit and the process was killed.',
    'You have hit the goal for today.',
    'Check the limit reached flag before calling resets().',
    'We handle HTTP 429 responses by backing off.',
    'Hit your head? The session ends when the cookie expires; it resets at midnight.',
    'Overloaded operators in C++ are resolved at compile time.',
    'ulimit -n raises the open file limit',
    '',
  ]
  for (const text of ordinary) {
    it(`no match: ${JSON.stringify(text).slice(0, 60)}`, () => {
      assert.equal(classifyUsageLimit(text), null)
    })
  }
})

describe('classifyApiErrorEntry — the structured marker decides, the text refines', () => {
  const classify = (e) => classifyApiErrorEntry({ error: e.error, apiErrorStatus: e.apiErrorStatus, text: textOf(e) })

  it('classifies each real fixture entry', () => {
    assert.equal(classify(sessionE).kind, 'session')
    assert.equal(classify(weeklyE).kind, 'weekly')
    assert.equal(classify(creditsE).kind, 'credits')
    assert.equal(classify(overloadedE).kind, 'overloaded')
  })

  it('a 500 and an authentication_failed entry are not limits', () => {
    assert.equal(classify(serverErrorE), null)
    assert.equal(classify(authE), null)
  })

  it('a rate_limit entry whose text is unfamiliar still counts, as a rate limit', () => {
    const r = classifyApiErrorEntry({ error: 'rate_limit', apiErrorStatus: 429, text: 'something new' })
    assert.equal(r.kind, 'rate_limit')
    const none = classifyApiErrorEntry({ error: 'rate_limit', text: undefined })
    assert.equal(none.kind, 'rate_limit')
  })

  it('a 529 whose text is unfamiliar is overloaded', () => {
    assert.equal(classifyApiErrorEntry({ error: 'server_error', apiErrorStatus: 529, text: 'x' }).kind, 'overloaded')
  })

  it('a limit-sounding TEXT without the structured marker is not a limit', () => {
    assert.equal(classifyApiErrorEntry({ error: 'invalid_request', text: "You've hit your session limit" }), null)
    assert.equal(classifyApiErrorEntry({ text: "You've hit your session limit" }), null)
    assert.equal(classifyApiErrorEntry(), null)
  })
})
