import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager, mergeEditedInput } from '../src/permission-manager.js'

/**
 * #6543 (IDE P3 feature B) — the editedInput execution seam. The load-bearing
 * security control: a client that reviewed the agent's proposed Write/Edit
 * per-hunk may substitute the CONTENT, but can NEVER redirect the path (or
 * change a non-content field / a non-editable tool). Covers the pure
 * `mergeEditedInput` whitelist + the `respondToPermission` integration.
 */

describe('mergeEditedInput whitelist (#6543)', () => {
  it('Write: substitutes content, PRESERVES file_path (path redirect blocked)', () => {
    const r = mergeEditedInput({ file_path: '/repo/a.js', content: 'orig' }, { content: 'edited', file_path: '/etc/passwd' }, 'Write')
    assert.equal(r.content, 'edited')
    assert.equal(r.file_path, '/repo/a.js') // the attacker's /etc/passwd is ignored
  })

  it('Edit: substitutes new_string, PRESERVES file_path AND old_string (anchor)', () => {
    const r = mergeEditedInput(
      { file_path: '/repo/a.js', old_string: 'foo', new_string: 'bar' },
      { new_string: 'BAZ', old_string: 'HIJACK', file_path: '/evil' },
      'Edit',
    )
    assert.equal(r.new_string, 'BAZ')
    assert.equal(r.old_string, 'foo')       // anchor not editable
    assert.equal(r.file_path, '/repo/a.js') // path not editable
  })

  it('a non-editable tool (Bash) ignores editedInput ENTIRELY (no command change)', () => {
    const r = mergeEditedInput({ command: 'ls' }, { command: 'rm -rf /', content: 'x' }, 'Bash')
    assert.deepEqual(r, { command: 'ls' })
  })

  it('ignores non-whitelisted fields, non-string values, and cannot ADD fields', () => {
    const r = mergeEditedInput({ file_path: '/a', content: 'orig' }, { content: 42, extra: 'nope', file_path: '/evil' }, 'Write')
    assert.equal(r.content, 'orig')  // 42 is not a string → ignored
    assert.equal(r.extra, undefined) // cannot inject a new field
    assert.equal(r.file_path, '/a')
  })

  it('returns the ORIGINAL for missing / null / array editedInput', () => {
    const orig = { file_path: '/a', content: 'orig' }
    assert.strictEqual(mergeEditedInput(orig, undefined, 'Write'), orig)
    assert.strictEqual(mergeEditedInput(orig, null, 'Write'), orig)
    assert.strictEqual(mergeEditedInput(orig, ['x'], 'Write'), orig)
  })

  it('does not mutate the original input', () => {
    const orig = { file_path: '/a', content: 'orig' }
    mergeEditedInput(orig, { content: 'edited' }, 'Write')
    assert.equal(orig.content, 'orig')
  })
})

describe('respondToPermission editedInput integration (#6543)', () => {
  function seed(tool, input) {
    const pm = new PermissionManager({ log: { info() {}, warn() {}, error() {} } })
    let resolved
    pm._pendingPermissions.set('req-1', { resolve: (r) => { resolved = r }, input, suggestions: [] })
    pm._lastPermissionData.set('req-1', { tool })
    return { pm, resolved: () => resolved }
  }

  it('allow + editedInput ⇒ updatedInput has the edited content, original path', () => {
    const { pm, resolved } = seed('Write', { file_path: '/repo/a.js', content: 'orig' })
    pm.respondToPermission('req-1', 'allow', { content: 'edited', file_path: '/evil' })
    assert.equal(resolved().behavior, 'allow')
    assert.equal(resolved().updatedInput.content, 'edited')
    assert.equal(resolved().updatedInput.file_path, '/repo/a.js')
  })

  it('allow WITHOUT editedInput ⇒ original input executes unchanged', () => {
    const { pm, resolved } = seed('Write', { file_path: '/repo/a.js', content: 'orig' })
    pm.respondToPermission('req-1', 'allow')
    assert.equal(resolved().updatedInput.content, 'orig')
  })

  it('deny + editedInput ⇒ denied, editedInput ignored (no execution)', () => {
    const { pm, resolved } = seed('Write', { file_path: '/repo/a.js', content: 'orig' })
    pm.respondToPermission('req-1', 'deny', { content: 'edited' })
    assert.equal(resolved().behavior, 'deny')
    assert.equal(resolved().updatedInput, undefined)
  })

  it('allowAlways + editedInput ⇒ current execution uses the edit', () => {
    const { pm, resolved } = seed('Edit', { file_path: '/repo/a.js', old_string: 'a', new_string: 'b' })
    pm.respondToPermission('req-1', 'allowAlways', { new_string: 'EDITED' })
    assert.equal(resolved().behavior, 'allow')
    assert.equal(resolved().updatedInput.new_string, 'EDITED')
    assert.equal(resolved().updatedInput.file_path, '/repo/a.js')
  })

  it('an unknown requestId returns false and resolves nothing', () => {
    const { pm, resolved } = seed('Write', { file_path: '/a', content: 'x' })
    assert.equal(pm.respondToPermission('nope', 'allow', { content: 'y' }), false)
    assert.equal(resolved(), undefined)
  })
})
