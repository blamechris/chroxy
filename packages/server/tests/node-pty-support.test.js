/**
 * describeNodePtyUnavailable(err) (#8151) — the shared, actionable message
 * both claude-tui-session.js and user-shell-session.js surface when their
 * dynamic `import('node-pty')` rejects (no linux prebuild in the official
 * Docker image, or any other host missing the native addon).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeNodePtyUnavailable,
  nodePtyImportFailureError,
  NODE_PTY_UNAVAILABLE_CODE,
} from '../src/utils/node-pty-support.js'

describe('describeNodePtyUnavailable', () => {
  it('leads with the actionable sentence (#8151 review S8) — starts with "node-pty is unavailable"', () => {
    const msg = describeNodePtyUnavailable(new Error('Cannot find module pty.node'))
    assert.match(msg, /^node-pty is unavailable/)
  })

  it('names claude-sdk in the FIRST sentence, not buried after the cause', () => {
    const msg = describeNodePtyUnavailable(new Error('Cannot find module pty.node'))
    const firstSentence = msg.split('.')[0]
    assert.match(firstSentence, /claude-sdk/)
  })

  it('includes the original cause, appended last, prefixed "Cause:"', () => {
    const msg = describeNodePtyUnavailable(new Error('Cannot find module pty.node'))
    assert.match(msg, /Cause: Cannot find module pty\.node$/)
  })

  it('truncates a multi-line cause to its first line only (S8)', () => {
    const msg = describeNodePtyUnavailable(new Error('line one\nline two\nline three'))
    assert.match(msg, /Cause: line one$/)
    assert.doesNotMatch(msg, /line two/)
    assert.doesNotMatch(msg, /line three/)
  })

  it('names both affected features — the embedded terminal and claude-tui', () => {
    const msg = describeNodePtyUnavailable(new Error('boom'))
    assert.match(msg, /terminal/)
    assert.match(msg, /claude-tui/)
  })

  it('mentions the Docker image as the expected case', () => {
    const msg = describeNodePtyUnavailable(new Error('boom'))
    assert.match(msg, /Docker/)
  })

  it('gives an accurate non-Docker remediation: npm rebuild + the real N-API build prerequisites (S8)', () => {
    const msg = describeNodePtyUnavailable(new Error('boom'))
    assert.match(msg, /npm rebuild node-pty/)
    assert.match(msg, /python3/)
    assert.match(msg, /C\+\+ compiler/)
  })

  // #8151 round-2 review (S4): "reinstall it" undersold the fix — rebuilding
  // the native addon does nothing for an already-running daemon process
  // until it restarts and re-imports node-pty.
  it('tells the reader to restart the daemon after rebuilding, not just rebuild (S4)', () => {
    const msg = describeNodePtyUnavailable(new Error('boom'))
    assert.match(msg, /npm rebuild node-pty.{0,20}restart the chroxy daemon/)
  })

  it('falls back to a generic cause for a non-Error thrown value', () => {
    const msg = describeNodePtyUnavailable('a thrown string')
    assert.match(msg, /Cause: unknown error$/)
  })

  it('falls back to a generic cause for null/undefined', () => {
    assert.match(describeNodePtyUnavailable(null), /Cause: unknown error$/)
    assert.match(describeNodePtyUnavailable(undefined), /Cause: unknown error$/)
  })

  // #8151 round-2 review (Critical 4): scripts/docker-image-smoke.sh's check
  // 3 greps a healthy container's logs for a NEGATIVE signature of this exact
  // failure. That grep used to be a substring of this prose ('node-pty
  // unavailable'), which S8's rewording ('node-pty is unavailable here')
  // silently broke — the smoke script's own literal no longer matched
  // anything this function could ever produce, so its negative assertion
  // could never fire again. This test pins the INVARIANT the smoke script
  // depends on (the message always contains the stable marker), so a future
  // rewording that drops the marker breaks THIS test instead of silently
  // disarming the smoke script a second time.
  it('always contains the stable NODE_PTY_UNAVAILABLE_CODE marker the Docker smoke script greps for', () => {
    const msg = describeNodePtyUnavailable(new Error('boom'))
    assert.ok(msg.includes(NODE_PTY_UNAVAILABLE_CODE), `expected the message to contain ${NODE_PTY_UNAVAILABLE_CODE}: ${msg}`)
  })
})

describe('nodePtyImportFailureError (#8151 round-2 review Critical 1) — the ONE shared catch-body builder', () => {
  it('wraps describeNodePtyUnavailable\'s message with a matching .code', () => {
    const err = nodePtyImportFailureError(new Error('Cannot find module pty.node'))
    assert.ok(err instanceof Error)
    assert.equal(err.code, NODE_PTY_UNAVAILABLE_CODE)
    assert.equal(err.message, describeNodePtyUnavailable(new Error('Cannot find module pty.node')))
  })
})
