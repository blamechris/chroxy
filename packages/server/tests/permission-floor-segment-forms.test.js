import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFlooredTarget } from '../src/permission-floor.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { SKIP_NO_HARDLINK } from './helpers/hardlink-support.js'

/**
 * The permission floor compares each path segment in a canonical form, and
 * floors a few path shapes outright. Pinned here on both floors (the read floor
 * for Read, the full floor for Write); the parity matrix in
 * permission-hook-floor.test.js runs a subset through both pipelines.
 *
 *   - Anything from a `:` on, and trailing dots or spaces, are dropped.
 *   - Names are folded wider than `toLowerCase()`: compatibility forms
 *     decomposed, combining marks removed, each character upper- then
 *     lower-cased.
 *   - A segment in the 8.3 short-name form floors.
 *   - On POSIX, a target holding `\`, or a symlink met on the way whose target
 *     holds one, floors.
 *   - Under the full floor, an existing target with more than one hard link floors.
 */

const CWD = '/work/project'
const floored = (tool, file_path, cwd = CWD) => isFlooredTarget(tool, { file_path }, cwd)

describe('floor: segments compared in canonical form', () => {
  for (const [tool, path] of [
    ['Read', 'id_r\u017Fa'],
    ['Read', '.claude/\u017Fettings.local.json'],
    ['Read', 'certs/a.p\uFF45m'],
    ['Write', '.v\u017Fcode/tasks.json'],
    ['Write', '.git./config'],
    ['Write', '.git /config'],
    ['Read', 'id_rsa '],
    ['Read', '.npmrc.'],
    ['Write', '.git../config'],
    ['Write', '.git. ./config'],
    ['Read', 'id_rsa..'],
    ['Write', '.gi\u0307t/config'],
    ['Read', 'id_r\u015Ba'],
    ['Read', '.env:x'],
    ['Write', '.git:y/config'],
    ['Write', 'GIT~1/config'],
    ['Read', 'SETTIN~1.JSO'],
    ['Write', 'CLAUDE~1/settings.json'],
    ['Read', '.pgpa\u1E9E'],
    ['Write', '.pgpa\u00DF'],
    ['Read', '.claude/SETTIN~1.JSO::$DATA'],
    ['Write', 'CLAUDE~1::$INDEX_ALLOCATION/settings.json'],
    ['Write', 'GIT~1::$INDEX_ALLOCATION/config'],
    ['Write', 'GIT~1./config'],
    ['Write', 'CLAUDE~1 /settings.json'],
    ['Read', 'SETTIN~1.JSO.'],
    ['Write', 'abcdef~1'],
    ['Read', 'a~1.abc'],
    // A name as written is still checked: on POSIX `:` and a leading mark are
    // ordinary name characters.
    ['Read', 'host:2222.pem'],
    ['Read', 'a:b.key'],
    ['Read', '.claude/settings:local.json'],
    ['Read', '\u0301.pem'],
  ]) {
    it(`${tool} ${JSON.stringify(path)} \u2192 floored`, () => {
      assert.equal(floored(tool, path), true)
    })
  }

  for (const [tool, path] of [
    ['Read', 'caf\u00E9/notes.md'],
    ['Read', '\u65E5\u672C\u8A9E/readme.md'],
    ['Write', 'docs/r\u00E9sum\u00E9.md'],
    ['Read', 'dist/chunk~87fd721f7.js'],
    ['Write', 'src/vendors~main.js'],
    ['Write', 'notes.md'],
    ['Write', 'abcdefg~1'],
    ['Read', 'a~1.json'],
    ['Write', 'notes~'],
    ['Write', '~1'],
    ['Write', 'a.b~1'],
  ]) {
    it(`${tool} ${JSON.stringify(path)} \u2192 not floored`, () => {
      assert.equal(floored(tool, path), false)
    })
  }
})

it('a `:` drops only what follows it: `a:b.txt` is not floored', {
  skip: process.platform === 'win32' ? '`:` names a stream on win32' : false,
}, () => {
  assert.equal(floored('Read', 'a:b.txt'), false)
})

it('a long run of dots or spaces in one segment is handled in linear time', () => {
  for (const filler of ['.', ' ']) {
    // The verdict is the resolver's (a name this long fails closed); the time is the point.
    const t0 = Date.now()
    floored('Read', `${filler.repeat(200_000)}x`)
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
  }
})

describe('floor: `\\` in a POSIX target', {
  skip: process.platform === 'win32' ? '`\\` is a path separator on win32' : false,
}, () => {
  it('a target holding `\\` floors, on both floors', () => {
    assert.equal(floored('Read', 'src\\lib\\util.js'), true)
    assert.equal(floored('Write', 'a\\b'), true)
  })
})

describe('floor: what a target is on disk', () => {
  let root

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-floor-forms-')))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/one.js'), 'x')
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('on POSIX, a symlink whose target holds `\\` floors', {
    skip: process.platform === 'win32' ? '`\\` is a path separator on win32' : SKIP_NO_SYMLINK,
  }, () => {
    writeFileSync(join(root, 'src', 'x\\y'), 'x')
    symlinkSync('x\\y', join(root, 'src/plain'))
    assert.equal(floored('Write', 'src/plain', root), true)
    assert.equal(floored('Read', 'src/plain', root), true)
  })

  it('under the full floor, an existing target with more than one hard link floors', { skip: SKIP_NO_HARDLINK }, () => {
    linkSync(join(root, 'src/one.js'), join(root, 'src/two.js'))
    assert.equal(floored('Write', 'src/two.js', root), true)
    assert.equal(floored('Edit', 'src/one.js', root), true)
    assert.equal(floored('Read', 'src/two.js', root), false, 'the rule belongs to the full floor')
  })

  it('positive control: a single-link file, and a file not yet created, are not floored', () => {
    writeFileSync(join(root, 'src/solo.js'), 'x')
    assert.equal(floored('Write', 'src/solo.js', root), false)
    assert.equal(floored('Write', 'src/new.js', root), false)
  })
})
