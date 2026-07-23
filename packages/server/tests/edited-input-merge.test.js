import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionManager,
  mergeEditedInput,
  buildDenyMessage,
  EDITABLE_INPUT_FIELDS,
  PROTECTED_PATH_INPUT_FIELDS,
} from '../src/permission-manager.js'

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

  it('#6773 — Bash: substitutes the command (whole command is the reviewed content)', () => {
    const r = mergeEditedInput({ command: 'ls' }, { command: 'ls -la', content: 'x' }, 'Bash')
    assert.equal(r.command, 'ls -la')     // command IS editable for Bash now
    assert.equal(r.content, undefined)    // non-whitelisted field ignored (can't ADD)
  })

  it('a non-editable tool (Task) ignores editedInput ENTIRELY (no field change)', () => {
    const r = mergeEditedInput({ prompt: 'go' }, { prompt: 'HIJACK', command: 'rm -rf /' }, 'Task')
    assert.deepEqual(r, { prompt: 'go' })
  })

  it('#6773 — codex `shell` is NOT editable (codex owns command execution)', () => {
    const r = mergeEditedInput({ command: 'ls' }, { command: 'rm -rf /' }, 'shell')
    assert.deepEqual(r, { command: 'ls' }) // absent from whitelist → editedInput ignored
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

  it('#6553 — is prototype-pollution resistant (iterates the whitelist, not client keys)', () => {
    // Attack: a `__proto__` / `constructor` payload can't reach the assignment
    // because the merge loops over EDITABLE_INPUT_FIELDS, never editedInput's own
    // keys. Assert Object.prototype stays clean and no polluted key appears.
    const before = { ...Object.prototype }
    const r1 = mergeEditedInput({ file_path: '/a', content: 'orig' }, JSON.parse('{"__proto__":{"polluted":"yes"},"content":"edited"}'), 'Write')
    const r2 = mergeEditedInput({ file_path: '/a', content: 'orig' }, { constructor: { prototype: { polluted: 'yes' } }, content: 'edited' }, 'Write')
    assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted')
    assert.equal(r1.polluted, undefined)
    assert.equal(r2.polluted, undefined)
    assert.equal(r1.content, 'edited') // the legit whitelisted field still applies
    assert.deepEqual(Object.prototype, before)
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

  it('#6773 — Bash allow + editedInput.command ⇒ updatedInput runs the edited command', () => {
    const { pm, resolved } = seed('Bash', { command: 'ls' })
    pm.respondToPermission('req-1', 'allow', { command: 'ls -la' })
    assert.equal(resolved().behavior, 'allow')
    assert.equal(resolved().updatedInput.command, 'ls -la')
  })
})

/**
 * #6773 — the editedInput WHITELIST GUARD. The load-bearing invariant is that a
 * client-substitutable field can NEVER be a filesystem-target (path) field — a
 * path-redirect would let an approved edit slip a write past the protected-path
 * floor. This guard fails if a future tool addition puts a path field in the
 * whitelist, mirroring the "narrow-only" contract the mergeEditedInput tests prove.
 */
describe('editedInput whitelist guard (#6773)', () => {
  it('no editable field is ever a protected PATH field (no path redirect possible)', () => {
    const pathFields = new Set(PROTECTED_PATH_INPUT_FIELDS)
    for (const [tool, fields] of Object.entries(EDITABLE_INPUT_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          !pathFields.has(field),
          `EDITABLE_INPUT_FIELDS[${tool}] must not include the path field '${field}' — it would let an edit redirect the write past the floor`,
        )
      }
    }
  })

  it('every editable-field list is a non-empty array of strings', () => {
    for (const [tool, fields] of Object.entries(EDITABLE_INPUT_FIELDS)) {
      assert.ok(Array.isArray(fields) && fields.length > 0, `${tool} must map to a non-empty field array`)
      for (const field of fields) assert.equal(typeof field, 'string', `${tool} fields must be strings`)
    }
  })

  it('codex `shell` is NOT in the whitelist (codex ignores updatedInput)', () => {
    assert.equal(EDITABLE_INPUT_FIELDS.shell, undefined)
  })
})

/**
 * #6773 — buildDenyMessage: an operator's free-text reason replaces the fixed
 * 'User denied' string fed back to the agent, bounded + redacted; blank / missing
 * / non-string falls back to 'User denied'.
 */
describe('buildDenyMessage (#6773)', () => {
  it('a non-empty reason replaces the default message', () => {
    assert.equal(buildDenyMessage('use rg instead of grep'), 'use rg instead of grep')
  })

  it('missing / non-string / blank falls back to "User denied"', () => {
    assert.equal(buildDenyMessage(undefined), 'User denied')
    assert.equal(buildDenyMessage(null), 'User denied')
    assert.equal(buildDenyMessage(42), 'User denied')
    assert.equal(buildDenyMessage('   '), 'User denied')
    assert.equal(buildDenyMessage(''), 'User denied')
  })

  it('trims and bounds the reason (no unbounded paste reaches the agent)', () => {
    const long = 'x'.repeat(5000)
    const out = buildDenyMessage(`   ${long}   `)
    assert.equal(out.length, 2000)
  })

  it('redacts a secret-shaped token in the reason before it reaches the agent', () => {
    const out = buildDenyMessage('do not use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    assert.ok(!out.includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'raw secret must not survive')
  })

  it('respondToPermission deny ⇒ agent message carries the reason', () => {
    const pm = new PermissionManager({ log: { info() {}, warn() {}, error() {} } })
    let resolved
    pm._pendingPermissions.set('req-1', { resolve: (r) => { resolved = r }, input: { command: 'ls' }, suggestions: [] })
    pm._lastPermissionData.set('req-1', { tool: 'Bash' })
    pm.respondToPermission('req-1', 'deny', undefined, 'run it read-only instead')
    assert.equal(resolved.behavior, 'deny')
    assert.equal(resolved.message, 'run it read-only instead')
  })

  it('respondToPermission deny WITHOUT a reason ⇒ default "User denied"', () => {
    const pm = new PermissionManager({ log: { info() {}, warn() {}, error() {} } })
    let resolved
    pm._pendingPermissions.set('req-1', { resolve: (r) => { resolved = r }, input: { command: 'ls' }, suggestions: [] })
    pm._lastPermissionData.set('req-1', { tool: 'Bash' })
    pm.respondToPermission('req-1', 'deny')
    assert.equal(resolved.message, 'User denied')
  })
})
