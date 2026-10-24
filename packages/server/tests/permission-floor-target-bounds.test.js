import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isFlooredTarget, FLOOR_MAX_TARGET_BYTES, FLOOR_MAX_TARGET_COMPONENTS } from '../src/permission-floor.js'

/**
 * The permission floor bounds the work it does per target: a path-tool target
 * longer than FLOOR_MAX_TARGET_BYTES (UTF-8) or with more than
 * FLOOR_MAX_TARGET_COMPONENTS components floors (a prompt, never a deny)
 * before any resolution or walk. Real paths sit far below both (see
 * docs/security/permission-floor.md §1), so these are positive controls too.
 */

const CWD = '/work/project'
const floored = (tool, file_path) => isFlooredTarget(tool, { file_path }, CWD)
const time = (fn) => { const t0 = Date.now(); const value = fn(); return { value, ms: Date.now() - t0 } }

// Under the component bound but over the byte bound: 250-byte names.
const longNames = (count) => 'zz/' + ('n'.repeat(250) + '/').repeat(count) + 'f'

describe('floor: a target over the size bounds floors', () => {
  it('more components than the bound floors, on both floors', () => {
    const target = 'a/'.repeat(FLOOR_MAX_TARGET_COMPONENTS + 10)
    assert.equal(floored('Write', target), true)
    assert.equal(floored('Read', target), true)
  })

  it('`\\`-separated components count too', () => {
    // On win32 `\\` is the separator, so the component bound is what floors this;
    // on POSIX a target holding `\\` floors anyway.
    assert.equal(floored('Write', 'a\\'.repeat(FLOOR_MAX_TARGET_COMPONENTS + 10)), true)
  })

  it('more bytes than the bound floors, with few components', () => {
    const target = longNames(Math.ceil(FLOOR_MAX_TARGET_BYTES / 251) + 1)
    assert.ok(Buffer.byteLength(target) > FLOOR_MAX_TARGET_BYTES, 'premise: over the byte bound')
    assert.ok(target.split('/').length < FLOOR_MAX_TARGET_COMPONENTS, 'premise: under the component bound')
    assert.equal(floored('Read', target), true)
  })

  it('the byte bound counts UTF-8 bytes, not characters', () => {
    const target = 'zz/' + ('\u00E9'.repeat(100) + '/').repeat(21) + 'f'
    assert.ok(target.length <= FLOOR_MAX_TARGET_BYTES, 'premise: within the bound in characters')
    assert.ok(Buffer.byteLength(target) > FLOOR_MAX_TARGET_BYTES, 'premise: over it in UTF-8 bytes')
    assert.equal(floored('Read', target), true)
  })

  it('every path field and changes[] member is bounded', () => {
    const big = 'a/'.repeat(FLOOR_MAX_TARGET_COMPONENTS + 10)
    assert.equal(isFlooredTarget('Grep', { path: big, pattern: 'x' }, CWD), true)
    assert.equal(isFlooredTarget('NotebookEdit', { notebook_path: big }, CWD), true)
    assert.equal(isFlooredTarget('apply_patch', { file_path: CWD, changes: [{ path: 'src/a.js', kind: 'update' }, { path: big, kind: 'update' }] }, CWD), true)
  })

  it('a large over-bound target is decided quickly', () => {
    for (const target of ['a/'.repeat(32_000), 'a/../'.repeat(16_000) + 'x', longNames(4_000)]) {
      const { value, ms } = time(() => floored('Write', target))
      assert.equal(value, true)
      assert.ok(ms < 500, `took ${ms} ms for a ${target.length}-character target`)
    }
  })
})

describe('floor: targets within the size bounds are judged as before', () => {
  it('a realistic deep dependency path is not floored', () => {
    const target = 'node_modules/.pnpm/@babel+plugin-transform-modules-commonjs@7.24.1_@babel+core@7.24.4/node_modules/' +
      '@babel/plugin-transform-modules-commonjs/lib/src/main/kotlin/com/example/very/deep/package/name/' +
      'with/many/levels/of/nesting/that/real/projects/use/index.js'
    assert.equal(floored('Write', target), false)
    assert.equal(floored('Read', target), false)
  })

  it('exactly the component bound is not floored', () => {
    const target = 'a/'.repeat(FLOOR_MAX_TARGET_COMPONENTS - 1) + 'b'
    assert.equal(target.split('/').length, FLOOR_MAX_TARGET_COMPONENTS)
    assert.equal(floored('Read', target), false)
  })

  it('exactly the byte bound is not floored', () => {
    const head = 'zz/'
    const target = head + 'n'.repeat(FLOOR_MAX_TARGET_BYTES - head.length)
    assert.equal(Buffer.byteLength(target), FLOOR_MAX_TARGET_BYTES)
    assert.equal(floored('Read', target), false)
  })
})
