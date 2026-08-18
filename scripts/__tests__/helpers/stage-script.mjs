// stage-script.mjs — copy a repo script into a temp fixture along with the
// sibling `lib/` directory it imports from.
//
// Subprocess tests run a script out of a temp tree, so they have to stage
// everything it imports, not just the file itself. Naming the individual
// helpers would break on the next extraction: when the entry-point guard moved
// to scripts/lib/is-entry-point.mjs (#7222), a fixture that copied only
// gen-agents-md.mjs died with ERR_MODULE_NOT_FOUND, and one that hardcoded that
// single filename would die the same way on the next helper to be extracted.
// Copying the whole directory stages the next sibling automatically.
//
// This is the one implementation FOR THE .mjs TEST FILES. gen-agents-md.test.mjs
// grew it first and compile-skill-targets.test.mjs needed the identical thing
// (#7236); a second hand-maintained copy of it is the shape #7213/#7222 were
// filed to remove, recreated one directory down.
//
// It is deliberately not the only one in this directory: bump-version.test.sh's
// `install_agents_generator()` stages the same script from shell and cannot
// import this module. That copy also DISAGREES about the missing-lib case — it
// skips the copy when scripts/lib is absent, where this one refuses — which is
// the "'cannot check this' treated as 'nothing to check'" shape from
// docs/false-safety-guards.md. Reconciling them is tracked separately rather
// than smuggled into a test-coverage change.

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Stage `scriptPath` and its sibling `lib/` into `destScriptsDir`.
 *
 * A missing sibling `lib/` throws rather than staging less than asked. Both
 * current callers import from it, so its absence means either the wrong path
 * was passed or the helpers moved — and the alternative is a child process
 * dying with an ERR_MODULE_NOT_FOUND that names a temp path and not the cause.
 * "Could not stage it" is not the same as "there was nothing to stage".
 *
 * @param {string} scriptPath - absolute path to the script under test
 * @param {string} destScriptsDir - fixture directory to stage into
 * @returns {string} the staged script's path
 */
export function stageScript(scriptPath, destScriptsDir) {
  // mkdir FIRST, before anything that can throw. Callers wrap this in a
  // try/finally that chmods and removes the fixture dir, so throwing before the
  // directory exists makes their `chmodSync(scriptsDir)` fail with ENOENT — which
  // masks the diagnostic below AND skips the rmSync, leaking the temp tree. The
  // check reads more naturally above this line and is deliberately not there.
  mkdirSync(destScriptsDir, { recursive: true })
  const libDir = join(dirname(scriptPath), 'lib')
  if (!existsSync(libDir)) {
    throw new Error(
      `stageScript: no lib/ beside ${scriptPath} — the fixture would be staged ` +
      'without the helpers the script imports, and the child would fail with a ' +
      'bare ERR_MODULE_NOT_FOUND naming a temp path.',
    )
  }
  const staged = join(destScriptsDir, basename(scriptPath))
  cpSync(scriptPath, staged)
  cpSync(libDir, join(destScriptsDir, 'lib'), { recursive: true })
  return staged
}
