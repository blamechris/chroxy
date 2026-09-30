/**
 * describeNodePtyUnavailable(err) (#8151) — the shared, actionable message
 * both claude-tui-session.js and user-shell-session.js surface when their
 * dynamic `import('node-pty')` rejects (no linux prebuild in the official
 * Docker image, or any other host missing the native addon).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeNodePtyUnavailable } from '../src/utils/node-pty-support.js'

describe('describeNodePtyUnavailable', () => {
  it('keeps the "node-pty unavailable:" prefix existing tests match against', () => {
    const msg = describeNodePtyUnavailable(new Error('Cannot find module pty.node'))
    assert.match(msg, /^node-pty unavailable:/)
  })

  it('includes the original cause verbatim', () => {
    const msg = describeNodePtyUnavailable(new Error('Cannot find module pty.node'))
    assert.match(msg, /Cannot find module pty\.node/)
  })

  it('names the claude-sdk provider as the working alternative', () => {
    const msg = describeNodePtyUnavailable(new Error('boom'))
    assert.match(msg, /claude-sdk/)
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

  it('falls back to a generic cause for a non-Error thrown value', () => {
    const msg = describeNodePtyUnavailable('a thrown string')
    assert.match(msg, /^node-pty unavailable: unknown error —/)
  })

  it('falls back to a generic cause for null/undefined', () => {
    assert.match(describeNodePtyUnavailable(null), /^node-pty unavailable: unknown error —/)
    assert.match(describeNodePtyUnavailable(undefined), /^node-pty unavailable: unknown error —/)
  })
})
