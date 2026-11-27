import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as shim from '../src/redaction.js'
import * as moved from '@chroxy/protocol/redaction'

// #9235: the server's redaction.js is a re-export of @chroxy/protocol/redaction. Every
// export must be the SAME value, which proves one module instance (the
// isSanitizedToolInput WeakSet is shared, not duplicated).
describe('server redaction.js shim', () => {
  it('exports exactly the names the protocol module exports', () => {
    assert.deepEqual(Object.keys(shim).sort(), Object.keys(moved).sort())
    assert.ok(Object.keys(moved).length >= 20, 'the module has its full export surface')
  })

  it('every export is the identical value (one module instance)', () => {
    for (const name of Object.keys(moved)) {
      assert.ok(Object.is(shim[name], moved[name]), `${name} differs through the shim`)
    }
  })

  it('a value sanitised through one path is recognised through the other', () => {
    const out = shim.sanitizeToolInput({ command: 'echo hi' })
    assert.equal(moved.isSanitizedToolInput(out), true)
  })
})
