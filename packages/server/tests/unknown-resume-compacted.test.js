import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COMPACTED_UNKNOWN_RESUME_PATTERN, stderrIndicatesUnknownResumeCompacted } from '../src/cli-session.js'

// #7847: the compacted classifier on its own, independent of the TUI scanner.
const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('COMPACTED_UNKNOWN_RESUME_PATTERN (#7847)', () => {
  it('matches the compacted phrase with a lowercase or uppercase UUID', () => {
    assert.ok(COMPACTED_UNKNOWN_RESUME_PATTERN.test(`noconversationfoundwithsessionid:${UUID}`))
    assert.ok(COMPACTED_UNKNOWN_RESUME_PATTERN.test(`NoconversationfoundwithsessionID:${UUID.toUpperCase()}`))
  })

  it('rejects a UUID with a wrong group length or a truncated UUID', () => {
    assert.equal(COMPACTED_UNKNOWN_RESUME_PATTERN.test('noconversationfoundwithsessionid:0a1b2c3-4e5f-4a6b-8c7d-9e0f1a2b3c4d'), false)
    assert.equal(COMPACTED_UNKNOWN_RESUME_PATTERN.test('noconversationfoundwithsessionid:0a1b2c3d-4e5f-4a6b'), false)
  })

  it('rejects the phrase without the session-id part', () => {
    assert.equal(COMPACTED_UNKNOWN_RESUME_PATTERN.test(`noconversationfound${UUID}`), false)
  })
})

describe('stderrIndicatesUnknownResumeCompacted (#7847)', () => {
  it('matches fragments inside the default 10-line window', () => {
    const lines = ['Noconvers', 'ation', 'foundwith', 'session', 'ID:', '0a1b2c3d-4', 'e5f-4a6b-8', 'c7d-9e0f1a', '2b3c4d']
    assert.equal(stderrIndicatesUnknownResumeCompacted(lines), true)
  })

  it('does not match unrelated text between the phrase and the id', () => {
    const lines = ['Noconvers', 'ation', 'foundwith', 'session', 'x0', `ID:${UUID}`]
    assert.equal(stderrIndicatesUnknownResumeCompacted(lines), false)
  })

  // Pins the window from ABOVE: a complete rejection, nothing in between, split
  // into one character per line so it spans far more than the window. It must
  // not match at the default, and must match once the window covers it, so
  // removing or inflating the bound turns this red.
  it('does not match a complete rejection spread over more lines than the window', () => {
    const lines = [...`NoconversationfoundwithsessionID:${UUID}`]
    assert.equal(stderrIndicatesUnknownResumeCompacted(lines), false)
    assert.equal(stderrIndicatesUnknownResumeCompacted(lines, lines.length), true)
  })

  it('tolerates empty and non-array input', () => {
    assert.equal(stderrIndicatesUnknownResumeCompacted([]), false)
    assert.equal(stderrIndicatesUnknownResumeCompacted(undefined), false)
    assert.equal(stderrIndicatesUnknownResumeCompacted([null, 42]), false)
  })
})
