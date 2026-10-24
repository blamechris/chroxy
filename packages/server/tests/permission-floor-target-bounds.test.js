import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import {
  isFlooredTarget, FLOOR_MAX_TARGET_BYTES, FLOOR_MAX_TARGET_COMPONENTS, FLOOR_MAX_CALL_TARGETS, FLOOR_MAX_CALL_COMPONENTS,
  FLOOR_MAX_CALL_WALK, FLOOR_MAX_CALL_BYTES,
} from '../src/permission-floor.js'

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

describe('floor: one call\'s targets share a budget', () => {
  const patch = (paths) => ({ file_path: CWD, changes: paths.map((path) => ({ path, kind: 'update' })) })

  it('more targets than FLOOR_MAX_CALL_TARGETS floors', () => {
    const paths = Array.from({ length: FLOOR_MAX_CALL_TARGETS + 1 }, (_, i) => `src/f${i}.js`)
    assert.equal(isFlooredTarget('apply_patch', patch(paths), CWD), true)
  })

  it('more components in total than FLOOR_MAX_CALL_COMPONENTS floors', () => {
    const each = FLOOR_MAX_TARGET_COMPONENTS - 6
    const count = Math.floor(FLOOR_MAX_CALL_COMPONENTS / each) + 1
    assert.ok(count <= FLOOR_MAX_CALL_TARGETS, 'premise: under the target-count budget')
    const paths = Array.from({ length: count }, (_, i) => 'd/'.repeat(each - 1) + `f${i}.js`)
    assert.equal(isFlooredTarget('apply_patch', patch(paths), CWD), true)
  })

  it('changes[] members count toward the target budget whatever they hold', () => {
    const changes = Array.from({ length: FLOOR_MAX_CALL_TARGETS + 1 }, () => null)
    assert.equal(isFlooredTarget('apply_patch', { file_path: CWD, changes }, CWD), true)
  })

  it('the flat path fields count toward the component budget too', () => {
    const each = FLOOR_MAX_TARGET_COMPONENTS - 6
    const inChanges = Math.floor(FLOOR_MAX_CALL_COMPONENTS / each)
    const paths = Array.from({ length: inChanges }, (_, i) => 'd/'.repeat(each - 1) + `f${i}.js`)
    const flat = 'e/'.repeat(each - 1) + 'g.js'
    assert.ok(inChanges * each <= FLOOR_MAX_CALL_COMPONENTS, 'premise: changes[] alone is within the budget')
    assert.equal(isFlooredTarget('apply_patch', { file_path: flat, changes: paths.map((path) => ({ path, kind: 'update' })) }, CWD), true)
  })

  it('more UTF-8 bytes in total than FLOOR_MAX_CALL_BYTES floors', () => {
    // Each target is within its own bounds; 249-byte names of a 3-byte character.
    const name = '\uFDFA'.repeat(83)
    const each = 'zz/' + Array.from({ length: 15 }, () => name).join('/') + '/f'
    const count = Math.floor(FLOOR_MAX_CALL_BYTES / Buffer.byteLength(each)) + 1
    assert.ok(Buffer.byteLength(each) <= FLOOR_MAX_TARGET_BYTES, 'premise: each target is within the byte bound')
    assert.equal(isFlooredTarget('Read', { path: 'src', changes: Array.from({ length: count }, () => ({ path: each })) }, CWD), true)
  })

  it('exactly the call budgets are not floored', () => {
    // FLOOR_MAX_CALL_TARGETS targets, a path field among them.
    const targets = Array.from({ length: FLOOR_MAX_CALL_TARGETS - 1 }, (_, i) => ({ path: `src/f${i}.js` }))
    assert.equal(isFlooredTarget('apply_patch', { file_path: 'src', changes: targets }, CWD), false)
    // FLOOR_MAX_CALL_COMPONENTS components across the call.
    const each = FLOOR_MAX_TARGET_COMPONENTS
    const paths = Array.from({ length: FLOOR_MAX_CALL_COMPONENTS / each }, (_, i) => 'd/'.repeat(each - 1) + `f${i}`)
    assert.equal(isFlooredTarget('apply_patch', { changes: paths.map((path) => ({ path })) }, CWD), false)
    // FLOOR_MAX_CALL_BYTES bytes across the call.
    // 4096-byte targets of 255-byte names (a name the filesystem accepts).
    const names = ('b'.repeat(255) + '/').repeat(16)
    const big = Array.from({ length: FLOOR_MAX_CALL_BYTES / 4096 }, (_, i) => names.slice(0, 4096 - 5) + `/f${String(i).padStart(3, '0')}`)
    assert.equal(big.reduce((sum, p) => sum + Buffer.byteLength(p), 0), FLOOR_MAX_CALL_BYTES)
    assert.equal(isFlooredTarget('Read', { changes: big.map((path) => ({ path })) }, CWD), false)
  })

  it('a very large changes[] is decided quickly', () => {
    const paths = Array.from({ length: 40_000 }, (_, i) => `src/f${i}.js`)
    const { value, ms } = time(() => isFlooredTarget('apply_patch', patch(paths), CWD))
    assert.equal(value, true)
    assert.ok(ms < 200, `took ${ms} ms`)
  })

  it('positive control: a large but ordinary patch is not floored', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `packages/server/src/module-${i}/index.js`)
    assert.equal(isFlooredTarget('apply_patch', patch(paths), CWD), false)
  })
})

describe('floor: one call\'s filesystem work is bounded', () => {
  let root

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-floor-call-')))
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('many targets under a deep, missing cwd are decided quickly', () => {
    const cwd = join(root, ...Array.from({ length: 255 }, () => 'm'))
    const changes = Array.from({ length: FLOOR_MAX_CALL_TARGETS - 1 }, (_, i) => ({ path: `f${i}.js`, kind: 'update' }))
    const { value, ms } = time(() => isFlooredTarget('apply_patch', { file_path: 'a.js', changes }, cwd))
    assert.equal(value, false)
    assert.ok(ms < 1000, `took ${ms} ms`)
  })

  it(`targets whose links together walk more than FLOOR_MAX_CALL_WALK (${FLOOR_MAX_CALL_WALK}) components floor`, { skip: SKIP_NO_SYMLINK }, () => {
    // Each link adds 360 components; every target stays within its own walk bound.
    mkdirSync(join(root, 'end'), { recursive: true })
    symlinkSync('end/' + 'q/../'.repeat(180) + 'z', join(root, 'hop'))
    const count = Math.ceil(FLOOR_MAX_CALL_WALK / 360) + 1
    const changes = Array.from({ length: count }, (_, i) => ({ path: `hop/f${i}.js`, kind: 'update' }))
    assert.equal(isFlooredTarget('apply_patch', { file_path: root, changes: changes.slice(0, 2) }, root), false, 'premise: two targets are fine')
    assert.equal(isFlooredTarget('apply_patch', { file_path: root, changes }, root), true)
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
