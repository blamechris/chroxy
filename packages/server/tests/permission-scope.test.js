import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { permissionScope, permissionDecisionToken } from '../src/permission-scope.js'

/**
 * #8517 -- "Allow for Session" reaches the daemon as the wire decision `allow` plus
 * a `scope: 'session'` label. The label is honoured in exactly one place (this
 * module), and only beside `allow`.
 */
describe('permission scope (#8517)', () => {
  it('keeps the session scope beside allow, and only beside allow', () => {
    assert.equal(permissionScope('allow', 'session'), 'session')
    assert.equal(permissionScope('deny', 'session'), undefined, 'a deny is not a session allow')
    assert.equal(permissionScope('allowAlways', 'session'), undefined, 'allowAlways already outlives the session; it keeps its own token')
    assert.equal(permissionScope('allowSession', 'session'), undefined, 'not a wire decision')
  })

  it('drops anything but the one known scope', () => {
    for (const bad of [undefined, null, '', 'Session', 'always', 'project', 1, true, ['session'], { scope: 'session' }]) {
      assert.equal(permissionScope('allow', bad), undefined, JSON.stringify(bad))
    }
  })

  it('names the decision token the journal and the clients use', () => {
    assert.equal(permissionDecisionToken('allow', 'session'), 'allowSession')
    assert.equal(permissionDecisionToken('allow', undefined), 'allow')
    assert.equal(permissionDecisionToken('allowAlways', 'session'), 'allowAlways')
    assert.equal(permissionDecisionToken('deny', 'session'), 'deny')
    assert.equal(permissionDecisionToken('allow', 'forever'), 'allow')
  })
})
