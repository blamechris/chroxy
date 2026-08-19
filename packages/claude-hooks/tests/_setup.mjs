/**
 * Test sandbox for @chroxy/claude-hooks (same intent as
 * packages/server/tests/_setup.mjs, #4633): tests must NEVER read from or
 * write to the real ~/.chroxy or ~/.claude trees.
 *
 * Two layers:
 *   1. temp HOME — `os.homedir()` follows $HOME, so default-path code
 *      (defaultSettingsPath, configDir) resolves into a throwaway dir
 *   2. write guard — fs write primitives throw CHROXY_TEST_SANDBOX if
 *      anything still targets the REAL home's .chroxy/.claude (belt and
 *      braces against env leaking out of a spawned process)
 */

import { createRequire } from 'node:module'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// #7262: reach `node:fs` through `createRequire`, NEVER an ESM import.
//
// This file previously opened with `import fs from 'node:fs'` plus
// `import { mkdtempSync } from 'node:fs'`. Both are ESM imports, and ESM
// imports are evaluated before the module body — which links the `node:fs`
// synthetic module and snapshots its named exports off the UNPATCHED
// `module.exports`. The patches below then landed on an object that named and
// namespace importers no longer read, so the guard covered exactly two of the
// four binding forms:
//
//   require / default import  -> guarded      namespace / named import -> NOT
//
// Measured on this package before the fix, writing to the real
// `~/.chroxy`: cjs GUARDED, default GUARDED, namespace ENOENT, named ENOENT.
// The default import was the patch TARGET and still did not save the other
// two, because linking is what does the damage, not which form you patch.
//
// `createRequire` gives the live CJS `module.exports` without linking the
// synthetic module, so the snapshot is taken later, already patched. The
// server's sandbox carries the same rule and the reasoning in full
// (`packages/server/tests/_setup.mjs`), pinned there by
// `tests/setup-sandbox-binding-forms.test.js`.
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const { mkdtempSync } = fs

const REAL_HOME = homedir()
const GUARDED_ROOTS = [join(REAL_HOME, '.chroxy'), join(REAL_HOME, '.claude')]

// Layer 1: relocate HOME before any test module resolves default paths.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'chroxy-hooks-home-'))
process.env.HOME = SANDBOX_HOME
process.env.USERPROFILE = SANDBOX_HOME

function isGuardedPath(target) {
  if (typeof target !== 'string' && !(target instanceof URL)) return false
  let abs
  try {
    // `fileURLToPath` (not `.pathname`) for URL targets — it percent-decodes
    // and handles the Windows `file:///C:/...` leading-slash quirk, same as
    // packages/server/tests/_setup.mjs.
    abs = resolve(target instanceof URL ? fileURLToPath(target) : target)
  } catch {
    return false
  }
  return GUARDED_ROOTS.some((root) => abs === root || abs.startsWith(root + sep))
}

function guard(original, name) {
  return function guarded(target, ...args) {
    if (isGuardedPath(target)) {
      throw new Error(
        `CHROXY_TEST_SANDBOX: ${name} to real user state blocked: ${target}\n` +
        `Tests must use temp paths (env overrides) — see tests/_setup.mjs`
      )
    }
    return original.call(this, target, ...args)
  }
}

fs.writeFileSync = guard(fs.writeFileSync, 'writeFileSync')
fs.mkdirSync = guard(fs.mkdirSync, 'mkdirSync')
// renameSync checks BOTH paths: renaming real state OUT of the tree and
// renaming a temp file INTO it are equally destructive (same as
// packages/server/tests/_setup.mjs).
const realRenameSync = fs.renameSync
fs.renameSync = function guardedRenameSync(oldPath, newPath) {
  if (isGuardedPath(oldPath) || isGuardedPath(newPath)) {
    throw new Error(
      `CHROXY_TEST_SANDBOX: renameSync touching real user state blocked: ${String(oldPath)} -> ${String(newPath)}\n` +
      `Tests must use temp paths (env overrides) — see tests/_setup.mjs`
    )
  }
  return realRenameSync.call(this, oldPath, newPath)
}
fs.rmSync = guard(fs.rmSync, 'rmSync')
fs.unlinkSync = guard(fs.unlinkSync, 'unlinkSync')
fs.createWriteStream = guard(fs.createWriteStream, 'createWriteStream')
const realPromisesWriteFile = fs.promises.writeFile
fs.promises.writeFile = async function guardedWriteFile(target, ...args) {
  if (isGuardedPath(target)) {
    throw new Error(`CHROXY_TEST_SANDBOX: promises.writeFile to real user state blocked: ${target}`)
  }
  return realPromisesWriteFile.call(this, target, ...args)
}
