// is-entry-point.test.js — pins the one entry-point guard (#7213, #7217).
//
// The guard's failure mode is SILENCE: it returns false, main() never runs,
// and the process exits 0. Nothing observable distinguishes that from a clean
// no-op, which is how the bug survived in four files. So every case here
// asserts the boolean directly rather than any downstream side effect.
//
// `process.argv[1]` is read at call time, which is what makes these tests
// possible in-process: each one points argv[1] at a path it controls and
// restores it afterwards.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isEntryPoint } from '../src/utils/is-entry-point.js'

let dir
let realDir
let linkDir
let realScript
let linkedScript

before(() => {
  // The base is deliberately NOT realpath'd. On macOS os.tmpdir() is under
  // /var, itself a symlink to /private/var — so these paths carry a real
  // unresolved symlink, the same shape as the /tmp case that started this.
  dir = mkdtempSync(join(tmpdir(), 'chroxy-entry-'))
  realDir = join(dir, 'real')
  linkDir = join(dir, 'link')
  mkdirSync(realDir)
  realScript = join(realDir, 'probe.js')
  writeFileSync(realScript, 'export const x = 1\n')
  symlinkSync(realDir, linkDir, 'dir')
  linkedScript = join(linkDir, 'probe.js')
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const withArgv1 = (value, fn) => {
  const saved = process.argv[1]
  process.argv[1] = value
  try {
    return fn()
  } finally {
    process.argv[1] = saved
  }
}

describe('isEntryPoint', () => {
  it('is true when the module IS the invoked script', () => {
    withArgv1(realScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), true)
    })
  })

  it('is false when the module is merely imported', () => {
    withArgv1(join(realDir, 'other.js'), () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), false)
    })
  })

  // The original bug (#7198). Node's ESM loader resolves symlinks in
  // import.meta.url; argv[1] is whatever the caller typed. Every hand-rolled
  // guard compared one against the other and read false.
  it('is true when invoked through a symlinked directory', () => {
    withArgv1(linkedScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), true)
    })
  })

  it('is true when import.meta.url is the symlinked side', () => {
    withArgv1(realScript, () => {
      assert.equal(isEntryPoint(pathToFileURL(linkedScript).href), true)
    })
  })

  // The #7217 review finding, and the reason the plain comparison runs first.
  //
  // A path that cannot be realpath'd stands in for the EACCES / unlinked-script
  // cases that are not portable to construct: ENOENT takes the identical branch
  // in the guard. With realpath consulted FIRST, this returns false — a direct
  // `node foo.js` that silently does nothing, which is precisely the class the
  // module was written to eliminate.
  //
  // Mutation check: put the realpath comparison back in front of the plain one
  // and this is the assertion that goes red.
  it('is true for identical paths even when they cannot be realpath\'d', () => {
    const ghost = join(dir, 'does-not-exist', 'probe.js')
    withArgv1(ghost, () => {
      assert.equal(isEntryPoint(pathToFileURL(ghost).href), true)
    })
  })

  // Negative control for the case above: the un-realpath-able path must not
  // become a blanket "true", or the assertion above would pass for the wrong
  // reason.
  it('is false for DIFFERING paths that cannot be realpath\'d', () => {
    withArgv1(join(dir, 'nowhere', 'a.js'), () => {
      assert.equal(isEntryPoint(pathToFileURL(join(dir, 'nowhere', 'b.js')).href), false)
    })
  })

  it('is false when there is no invoked script (node -e, REPL)', () => {
    withArgv1(undefined, () => {
      assert.equal(isEntryPoint(pathToFileURL(realScript).href), false)
    })
  })

  it('resolves a relative argv[1] before comparing', () => {
    const saved = process.cwd()
    process.chdir(realDir)
    try {
      withArgv1('./probe.js', () => {
        assert.equal(isEntryPoint(pathToFileURL(realScript).href), true)
      })
    } finally {
      process.chdir(saved)
    }
  })
})
