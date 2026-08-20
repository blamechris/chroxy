// #7273 — the containment predicate, proved against BOTH path namespaces.
//
// The point of this file is that it runs the SHIPPING implementation under
// win32 semantics on a POSIX host. `makeIsPathWithin` exists so the test can
// bind `path.win32` without transcribing the predicate into the test — a
// transcription would prove only that the transcription behaves, which is the
// "measured the wrong artifact" mode in `docs/false-safety-guards.md`.
//
// So: a POSIX-only CI run catches a Windows containment regression. That
// matters because `Server Windows Tests` runs on a single self-hosted box, and
// a guard that can only go red on one machine is a guard that will eventually
// go quiet.

import { describe, it } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import { makeIsPathWithin, isPathWithin, isPathOutside } from '../src/utils/path-containment.js'

const win = makeIsPathWithin(path.win32)
const posix = makeIsPathWithin(path.posix)

describe('isPathWithin — win32 semantics (proved from any host)', () => {
  const CWD = 'C:\\Users\\dev\\Projects\\myapp'

  it('accepts the root itself and paths beneath it', () => {
    assert.equal(win(CWD, CWD), true, 'root contains itself')
    assert.equal(win('C:\\Users\\dev\\Projects\\myapp\\src\\a.js', CWD), true)
    assert.equal(win('C:\\Users\\dev\\Projects\\myapp\\a\\b\\c\\d.txt', CWD), true)
  })

  it('accepts an in-project path spelled with forward slashes', () => {
    // Windows accepts both separators; a client may send either.
    assert.equal(win('C:/Users/dev/Projects/myapp/src/a.js', CWD), true)
  })

  it('accepts a path whose case differs — NTFS is case-insensitive', () => {
    // The same real directory, recorded with different capitalisation. The old
    // `startsWith(root + sep)` spelling rejected this.
    assert.equal(win('c:\\users\\dev\\projects\\myapp\\src\\a.js', CWD), true)
    assert.equal(win('C:\\Users\\dev\\Projects\\MyApp\\src\\a.js', CWD), true)
  })

  it('accepts a drive root as the boundary', () => {
    // `root + sep` produced 'C:\\\\' here and matched nothing.
    assert.equal(win('C:\\Documents', 'C:\\'), true)
    assert.equal(win('C:\\', 'C:\\'), true)
  })

  it('rejects same-drive traversal', () => {
    assert.equal(win('C:\\Users\\dev\\.ssh\\id_rsa', CWD), false)
    assert.equal(win('C:\\Windows\\win.ini', CWD), false)
    assert.equal(win('C:\\Users\\dev\\Projects', CWD), false, 'the parent is not within the child')
  })

  it('rejects a sibling directory that merely shares the prefix', () => {
    assert.equal(win('C:\\Users\\dev\\Projects\\myapp-evil\\x', CWD), false)
    assert.equal(win('C:\\Users\\dev\\Projects\\myappX', CWD), false)
  })

  // ── The security half of #7273. Every one of these returned "inside" under
  // the old `rel.startsWith('..')` spelling, because path.win32.relative()
  // hands back a cross-root target VERBATIM rather than a '..'-prefixed path.
  it('rejects another drive letter', () => {
    assert.equal(win('D:\\secrets\\prod-creds.env', CWD), false)
    assert.equal(win('D:/secrets/prod.env', CWD), false)
  })

  it('rejects a UNC share', () => {
    assert.equal(win('\\\\attacker.example\\share\\x.txt', CWD), false)
    assert.equal(win('\\\\127.0.0.1\\C$\\Users\\dev\\.ssh\\id_rsa', CWD), false)
  })

  it('rejects the \\\\?\\ device namespace aliasing the SAME drive', () => {
    // The sharpest case: on a single-drive machine with no admin share, this
    // names exactly the file the same-drive control above rejects.
    assert.equal(win('\\\\?\\C:\\Users\\dev\\.ssh\\id_rsa', CWD), false)
    assert.equal(win('\\\\?\\C:\\Users\\dev\\Projects\\myapp\\src\\a.js', CWD), false,
      'even an in-project path via the device namespace is a different root — fail closed')
  })

  it('allows a directory whose NAME begins with two dots', () => {
    // `..hidden` is not traversal. The old `startsWith('..')` spelling
    // rejected it — the fail-CLOSED half of the same defect.
    assert.equal(win('C:\\Users\\dev\\Projects\\myapp\\..hidden\\f.js', CWD), true)
    assert.equal(win('C:\\Users\\dev\\Projects\\myapp\\src\\..hidden\\f.js', CWD), true)
  })
})

describe('isPathWithin — posix semantics', () => {
  const CWD = '/home/dev/Projects/myapp'

  it('accepts the root itself and paths beneath it', () => {
    assert.equal(posix(CWD, CWD), true)
    assert.equal(posix('/home/dev/Projects/myapp/src/a.js', CWD), true)
  })

  it('accepts the filesystem root as the boundary', () => {
    // `root + sep` produced '//' here and matched nothing.
    assert.equal(posix('/tmp', '/'), true)
    assert.equal(posix('/', '/'), true)
  })

  it('rejects traversal and prefix-siblings', () => {
    assert.equal(posix('/home/dev/.ssh/id_rsa', CWD), false)
    assert.equal(posix('/home/dev/Projects/myapp-evil/x', CWD), false)
    assert.equal(posix('/etc/passwd', CWD), false)
  })

  it('stays case-SENSITIVE — two distinct directories on a POSIX filesystem', () => {
    assert.equal(posix('/home/dev/Projects/MyApp/src/a.js', CWD), false)
  })

  it('allows a directory whose NAME begins with two dots', () => {
    assert.equal(posix('/home/dev/Projects/myapp/..hidden/f.js', CWD), true)
  })

  it('treats a backslash as an ordinary filename character', () => {
    // On POSIX '..\\..\\etc\\passwd' is ONE filename, not traversal.
    assert.equal(posix('/home/dev/Projects/myapp/..\\..\\etc\\passwd', CWD), true)
  })
})

describe('isPathWithin — contract', () => {
  it('refuses a relative argument rather than resolving it against process.cwd()', () => {
    assert.throws(() => isPathWithin('relative/path', path.resolve('/tmp')), { code: 'EINVAL' })
    assert.throws(() => isPathWithin(path.resolve('/tmp/x'), 'relative/root'), { code: 'EINVAL' })
  })

  it('refuses a non-string argument', () => {
    assert.throws(() => isPathWithin(null, path.resolve('/tmp')), { code: 'EINVAL' })
    assert.throws(() => isPathWithin(path.resolve('/tmp'), undefined), { code: 'EINVAL' })
  })

  it('isPathOutside is the exact negation', () => {
    const root = path.resolve('/tmp/root')
    const inside = path.resolve('/tmp/root/a')
    const outside = path.resolve('/tmp/other')
    assert.equal(isPathOutside(inside, root), false)
    assert.equal(isPathOutside(outside, root), true)
  })

  it('the platform binding matches the platform namespace', () => {
    const native = process.platform === 'win32' ? win : posix
    const root = path.resolve('/tmp/root')
    const target = path.resolve('/tmp/root/sub/file.txt')
    assert.equal(isPathWithin(target, root), native(target, root))
  })
})
