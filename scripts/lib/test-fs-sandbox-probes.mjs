// test-fs-sandbox-probes.mjs — the probe harness both packages use to prove
// their write sandbox actually fires (#7267, #7268).
//
// `docs/false-safety-guards.md`: "when you add or change a check, break the
// thing it protects and confirm it goes red. If you cannot make it fail, it is
// not a guard." Every guarded method is therefore CALLED against a protected
// path here, and the assertion is on the call's observable outcome — never on
// `fn.name`, never on a marker property. A name check is a reading, and the
// sandbox's own first probe in #7254 read as "working" because it happened to
// use a default import.
//
// ── How a probe avoids writing to the real home ────────────────────────────
//
// Every target is a path under the protected root WHOSE PARENT DIRECTORY DOES
// NOT EXIST, which makes the two outcomes cleanly distinguishable at no risk:
//
//   guard fired    -> CHROXY_TEST_SANDBOX   (the patched wrapper ran)
//   guard bypassed -> ENOENT                (the real syscall ran, and the
//                                            kernel refused it)
//
// so a FAILING run still creates nothing. That property is not free, and it is
// not uniform: `cpSync` CREATES the destination's parent chain before it fails.
// Measured on Node 22.22.3 — a `cpSync` probe at a non-existent path under
// `~/.chroxy` left a real directory in the developer's live config dir, through
// an armed sandbox. Every two-path probe therefore puts an ABSENT source in
// argument 0 when the protected path is argument 1, because `cp` checks the
// source before it creates anything (measured: ENOENT, nothing created). The
// leak assertion in the suite is the backstop for that reasoning, not a
// substitute for it.
//
// This module is deliberately NOT in `_setup.mjs`'s import graph — only
// `test-fs-sandbox.mjs` is, and that one carries the #7262 obligation never to
// ESM-import `node:fs`.
import { FS_PATH_MUTATORS, FS_STREAM_MUTATORS, SANDBOX_ERROR_CODE } from './test-fs-sandbox.mjs'

export const GUARDED = 'guarded'
export const REACHED_REAL_FS = 'reached-real-fs'

export function classify (err) {
  if (!err) return 'no-error: the call SUCCEEDED, which means it reached a real path'
  if (err.code === SANDBOX_ERROR_CODE) return GUARDED
  if (err.code === 'ENOENT') return REACHED_REAL_FS
  return `unexpected: ${err.code || err.message}`
}

/**
 * Arguments each operation needs AFTER its path argument(s). Keyed by the
 * `base` in `FS_PATH_MUTATORS`, so a mutator added there without a recipe here
 * fails the suite with "no probe recipe" instead of being silently unprobed.
 */
export const PROBE_EXTRA_ARGS = {
  writeFile: () => ['probe'],
  appendFile: () => ['probe'],
  // Deliberately NOT `{ recursive: true }`: recursive would create real
  // directories under the protected root if the guard were bypassed.
  mkdir: () => [],
  mkdtemp: () => [],
  rm: () => [],
  rmdir: () => [],
  unlink: () => [],
  truncate: () => [0],
  chmod: () => [0o600],
  lchmod: () => [0o600],
  chown: () => [process.getuid?.() ?? 0, process.getgid?.() ?? 0],
  lchown: () => [process.getuid?.() ?? 0, process.getgid?.() ?? 0],
  utimes: () => [new Date(), new Date()],
  lutimes: () => [new Date(), new Date()],
  rename: () => [],
  cp: () => [],
  copyFile: () => [],
  symlink: () => [],
  link: () => [],
  open: () => ['w'],
  createWriteStream: () => [],
}

/**
 * Build one probe plan per (method, protected-argument-position).
 *
 * @param {object} paths
 * @param {string} paths.protectedPath  Under the protected root, parent missing.
 * @param {string} paths.spare          Unprotected, parent missing — a safe
 *   partner for the argument the probe is not aiming at.
 * @param {string} paths.absentSource   Unprotected and NON-EXISTENT — used as
 *   argument 0 whenever the protected path is argument 1, so `cp` and friends
 *   fail on the missing source before creating the destination's parents.
 * @returns {Array<{label: string, method: string, surface: 'sync'|'callback'|'promises'|'stream', args: any[]}>}
 */
export function probePlans ({ protectedPath, spare, absentSource }) {
  const plans = []

  // A mutator row with no recipe here must FAIL, not silently produce an
  // unprobed guard. The comment above used to promise this without any code
  // behind it, which is the shape this whole change is about.
  function requireRecipe (base) {
    const recipe = PROBE_EXTRA_ARGS[base]
    if (typeof recipe !== 'function') {
      throw new Error(
        `no probe recipe for '${base}'. Every row in FS_PATH_MUTATORS / ` +
        `FS_STREAM_MUTATORS needs an entry in PROBE_EXTRA_ARGS giving the ` +
        `arguments that follow its path argument(s), or its guard is installed ` +
        `and never proven.`,
      )
    }
    return recipe
  }

  const positions = (paths) => (paths === 1
    ? [{ suffix: '', args: [protectedPath] }]
    : [
        { suffix: ' (from)', args: [protectedPath, spare] },
        { suffix: ' (to)', args: [absentSource, protectedPath] },
      ])

  for (const { base, paths } of FS_PATH_MUTATORS) {
    const recipe = requireRecipe(base)
    for (const { suffix, args } of positions(paths)) {
      const extra = recipe()
      plans.push({ base, surface: 'sync', method: `${base}Sync`, label: `${base}Sync${suffix}`, args, extra })
      plans.push({ base, surface: 'callback', method: base, label: `${base} (callback)${suffix}`, args, extra })
      plans.push({ base, surface: 'promises', method: base, label: `promises.${base}${suffix}`, args, extra })
    }
  }

  for (const { name, paths } of FS_STREAM_MUTATORS) {
    const recipe = requireRecipe(name)
    for (const { suffix, args } of positions(paths)) {
      plans.push({ base: name, surface: 'stream', method: name, label: `${name}${suffix}`, args, extra: recipe() })
    }
  }

  return plans
}

/**
 * Split plans into the ones this platform can actually run and the ones whose
 * method does not exist here.
 *
 * `lchmod`/`lchmodSync` are macOS-only — Node does not define them on Linux, so
 * a probe built from the table alone calls `undefined` and reports
 * "fn is not a function". That is a test defect, not a guard failure, and it is
 * exactly what CI caught: the whole table was probed on a platform that lacks
 * two of its entries.
 *
 * Dropping a probe is the dangerous half of this, because "cannot run this"
 * must never quietly become "nothing to check" (docs/false-safety-guards.md
 * the "Silently skipped an input" mode). So this only PARTITIONS — the caller is expected to assert that
 * every unavailable plan is corroborated by the installer having skipped the
 * same method for the same reason, and the category-completeness test remains
 * the backstop: it enumerates the LIVE `fs` object, so a method missing from
 * this platform is a method with nothing to guard.
 */
export function partitionByAvailability (plans, { fs, promises }) {
  const runnable = []
  const unavailable = []
  for (const plan of plans) {
    const host = plan.surface === 'promises' ? promises : fs
    ;(typeof host[plan.method] === 'function' ? runnable : unavailable).push(plan)
  }
  return { runnable, unavailable }
}

/** The guard label the installer would report for a plan. */
export function planLabel (plan) {
  if (plan.surface === 'promises') return `promises.${plan.method}`
  if (plan.surface === 'callback') return `${plan.method} (callback)`
  return plan.method
}

export function probeSync (fn, args) {
  try { fn(...args); return classify(null) } catch (err) { return classify(err) }
}

export async function probePromise (fn, args) {
  try {
    const handle = await fn(...args)
    // `promises.open` resolves a FileHandle; leaking it would keep a real fd.
    if (handle && typeof handle.close === 'function') await handle.close()
    return classify(null)
  } catch (err) { return classify(err) }
}

// The callback form's guard throws SYNCHRONOUSLY by design (see
// `installFsWriteSandbox`), so both delivery paths have to be classified.
export function probeCallback (fn, args) {
  return new Promise((resolve) => {
    try { fn(...args, (err) => resolve(classify(err))) } catch (err) { resolve(classify(err)) }
  })
}

// `createWriteStream` is the one probe whose BYPASS path is asynchronous: the
// guard throws synchronously, but a bypassed call returns a live stream and
// reports ENOENT later on an 'error' event. Treating that as "the call
// succeeded" would be wrong, and the unhandled 'error' would surface as an
// uncaughtException after the test had ended — noise that hides which
// assertion failed.
export function probeStream (fn, args, cleanup) {
  return new Promise((resolve) => {
    let stream
    try { stream = fn(...args) } catch (err) { return resolve(classify(err)) }
    stream.once('error', (err) => resolve(classify(err)))
    stream.once('open', () => {
      // It actually opened, so a real file exists under the protected root.
      stream.destroy()
      try { cleanup?.() } catch { /* best effort — the leak assertion reports it */ }
      resolve(classify(null))
    })
  })
}

/** Run one plan against the given `fs` / `fs.promises` binding objects. */
export function runProbe (plan, { fs, promises, cleanup }) {
  const args = plan.extra ? [...plan.args, ...plan.extra] : plan.args
  switch (plan.surface) {
    case 'sync': return probeSync(fs[plan.method], args)
    case 'callback': return probeCallback(fs[plan.method], args)
    case 'promises': return probePromise(promises[plan.method], args)
    case 'stream': return probeStream(fs[plan.method], args, cleanup)
    default: throw new Error(`unknown probe surface: ${plan.surface}`)
  }
}
