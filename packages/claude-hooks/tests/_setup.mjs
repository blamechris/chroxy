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

import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
