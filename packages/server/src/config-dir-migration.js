import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { configDir, defaultConfigDir } from './config-dir.js'

/**
 * #7240 — daemon state left behind at `~/.chroxy` when `CHROXY_CONFIG_DIR`
 * points somewhere else.
 *
 * #7052 made the variable relocate ALL daemon state. For anyone who already set
 * it, that means roughly twenty files stop being read on upgrade — and none of
 * them announce it. Two are sharp: an unmoved `server-identity.json` on a
 * keychain-less host makes the daemon mint a NEW identity key (pinned clients
 * report a possible MITM, and #5615's fail-safe cannot fire because
 * absent-everywhere is indistinguishable from first run), and an unmoved
 * `config.json` loses the apiToken, after which `chroxy init` mints a fresh one
 * and every paired device has to re-pair.
 *
 * **The stranded set is derived, never enumerated.** The obvious shape is a
 * const array of the ~20 known state filenames, and it is the repo's documented
 * false-safety pattern (`docs/false-safety-guards.md`): a hardcoded list next to
 * a set that grows. The next module to add a state file would not be in it, and
 * the check would report a clean tree while silently missing that file — the
 * exact failure that #7192/#7197 were filed for. So the set is computed instead:
 * every entry present under the default root and absent under the resolved one.
 * A new state file is covered the day it is written, with no list to update.
 *
 * The one list here is {@link EPHEMERAL_ENTRIES}, and it is deliberately safe to
 * get wrong: both detection and migration consult it, so they can never disagree,
 * and a missing name means a lock file gets reported and copied — not that state
 * goes silently unmigrated.
 *
 * Policy (decided for #7240): **warn loudly, copy on explicit request.** The
 * daemon cannot distinguish "operator just relocated and wants their state" from
 * "operator pointed at a deliberately clean root" — a container, a per-project
 * dir — and copying an identity key and credentials into a directory that may be
 * shared, synced or bind-mounted is the operator's security decision to make.
 * The cited precedents (`maybeEncryptCredentialsAtRest`, `migrateToken`) upgrade
 * a file in place at a path the daemon already owns; this crosses a boundary the
 * operator explicitly drew. `chroxy config-dir migrate` performs the copy.
 */

/**
 * Runtime-ephemeral entries: never reported as stranded, never copied.
 *
 * `supervisor.pid` and `update.lock` describe a process that ran against the
 * OLD root. Copying either forward hands the new root a PID/lock it does not
 * own; leaving them out of detection is what stops the startup warning
 * becoming permanent noise once everything real has been migrated.
 */
export const EPHEMERAL_ENTRIES = new Set(['supervisor.pid', 'update.lock'])

/**
 * The two entries whose absence is actively destructive rather than merely
 * inconvenient, plus the credential store.
 *
 * Used ONLY to order and emphasise the warning — never to gate detection or the
 * copy. If this drifts, the message is less pointed; nothing goes unreported.
 */
export const HIGH_CONSEQUENCE_ENTRIES = ['config.json', 'server-identity.json', 'credentials.json']

/**
 * Do two paths name the same directory?
 *
 * Compared by device + inode, not by string. A string compare has to get
 * symlinks, bind mounts, case-insensitive filesystems, trailing slashes and
 * `..` spellings all right at once, and the repo has been bitten by exactly
 * that class before (#6928's separator handling, and a case-insensitive
 * `~/Projects` path that compared unequal to its own realpath). dev+ino is
 * true identity and sidesteps every one of them.
 *
 * Windows reports `ino` as 0 on some filesystems, so fall back to a normalized
 * (case-insensitive there) path compare when either inode is unusable.
 */
function sameDir(a, b) {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    if (sa.ino && sb.ino) return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    // One side is missing or unreadable — fall through to the path compare,
    // which correctly reports two different paths as different.
  }
  const na = resolve(a)
  const nb = resolve(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/**
 * @typedef {object} StrandedState
 * @property {boolean} relocated  The resolved root differs from `~/.chroxy`.
 * @property {string}  source     The default root that may hold stranded state.
 * @property {string}  target     The root the daemon actually reads.
 * @property {string[]} stranded  Entry names present in source, absent in target (sorted).
 * @property {string[]} highConsequence  The subset of `stranded` that is destructive to lose.
 * @property {string|null} unreadable  Why the source could not be listed, if it could not be.
 */

/**
 * Detect state stranded at the default root.
 *
 * Never throws: an unreadable source is reported via `unreadable` so callers on
 * the boot path can degrade rather than fail.
 *
 * @param {{ source?: string, target?: string }} [opts] Injection seams for tests.
 * @returns {StrandedState}
 */
export function detectStrandedState({ source = defaultConfigDir(), target = configDir() } = {}) {
  const result = {
    relocated: false,
    source,
    target,
    stranded: [],
    highConsequence: [],
    unreadable: null,
  }

  // Covers every not-relocated case at once: the variable unset, set empty, set
  // to a relative path (config-dir.js refuses those back to the default), or set
  // to `~/.chroxy` itself by a different spelling or through a symlink.
  if (sameDir(source, target)) return result
  result.relocated = true

  if (!existsSync(source)) return result

  let entries
  try {
    entries = readdirSync(source)
  } catch (err) {
    result.unreadable = err.message
    return result
  }

  for (const name of entries) {
    if (EPHEMERAL_ENTRIES.has(name)) continue
    if (!existsSync(join(target, name))) result.stranded.push(name)
  }
  result.stranded.sort()
  result.highConsequence = HIGH_CONSEQUENCE_ENTRIES.filter((n) => result.stranded.includes(n))
  return result
}

/**
 * POSIX-quote a path for a shell command we print for the operator to paste.
 *
 * The `cp -a` hint below is a command a human copies and runs, so an unquoted
 * path with a space runs a DIFFERENT command — `cp -a /srv/my state/. /dst/`
 * copies two wrong sources — and one with a shell metacharacter is worse.
 * Single-quoting is the only form that neutralises everything; an embedded
 * single quote is closed, escaped and reopened, which is the standard idiom.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * Build the startup / doctor warning for a detection result.
 *
 * @param {StrandedState} detection
 * @returns {string[]} Lines, or empty when there is nothing to say.
 */
export function formatStrandedWarning(detection) {
  if (!detection.relocated) return []
  if (detection.unreadable) {
    return [`Could not check ${detection.source} for stranded state: ${detection.unreadable}`]
  }
  if (detection.stranded.length === 0) return []

  const { stranded, source, target } = detection
  const lines = [
    `CHROXY_CONFIG_DIR is set, but ${stranded.length} state `
      + `${stranded.length === 1 ? 'entry is' : 'entries are'} still at ${source}:`,
  ]
  // Three per line keeps the longest names readable in a terminal.
  for (let i = 0; i < stranded.length; i += 3) {
    lines.push(`  ${stranded.slice(i, i + 3).join('  ')}`)
  }
  lines.push('')
  lines.push(`The daemon is reading ${target} and will NOT find them.`)

  if (detection.highConsequence.includes('config.json')) {
    lines.push('Do NOT run \'chroxy init\' — it mints a fresh token and forces every device to re-pair.')
  }
  if (detection.highConsequence.includes('server-identity.json')) {
    lines.push('An unmoved server-identity.json makes the daemon mint a new identity key,')
    lines.push('which pinned clients report as a possible MITM.')
  }

  lines.push('')
  lines.push('Copy them once:  chroxy config-dir migrate')
  lines.push(`             or: cp -a ${shellQuote(`${source}/.`)} ${shellQuote(`${target}/`)}`)
  return lines
}

/**
 * Mirror source directory modes onto a freshly copied tree.
 *
 * `cpSync` preserves FILE modes (a 0600 credentials.json lands 0600) but creates
 * directories at the default 0755 — so `skills/` at 0700 would widen on copy.
 * Verified, not assumed: the behaviour is asserted in
 * `tests/config-dir-migration.test.js`.
 *
 * Symlinks are skipped rather than followed: `cpSync` copies them as symlinks,
 * and `chmodSync` follows them, which would otherwise re-mode a file outside the
 * tree entirely.
 */
function mirrorDirectoryModes(srcPath, destPath) {
  let st
  try {
    st = lstatSync(srcPath)
  } catch {
    return
  }
  if (!st.isDirectory()) return
  try {
    chmodSync(destPath, st.mode & 0o777)
  } catch {
    // Best-effort: a mode we cannot set is not a reason to abort a copy that
    // otherwise succeeded. The copied content is already in place.
  }
  let entries
  try {
    entries = readdirSync(srcPath)
  } catch {
    return
  }
  for (const name of entries) mirrorDirectoryModes(join(srcPath, name), join(destPath, name))
}

/**
 * Copy stranded entries from the default root into the resolved one.
 *
 * **Never overwrites.** Only entries absent from the target are copied, which is
 * what {@link detectStrandedState} already computes, so a partially-migrated
 * root converges instead of clobbering.
 *
 * @param {{ source?: string, target?: string, detection?: StrandedState }} [opts]
 * @returns {{ relocated: boolean, copied: string[], failed: Array<{ name: string, error: string }>, source: string, target: string, reason?: string }}
 */
export function migrateStrandedState({ source, target, detection } = {}) {
  const det = detection ?? detectStrandedState({
    ...(source === undefined ? {} : { source }),
    ...(target === undefined ? {} : { target }),
  })
  const out = { relocated: det.relocated, copied: [], failed: [], source: det.source, target: det.target }

  if (!det.relocated) return { ...out, reason: 'not-relocated' }
  if (det.unreadable) return { ...out, reason: `source-unreadable: ${det.unreadable}` }
  if (det.stranded.length === 0) return { ...out, reason: 'nothing-stranded' }

  // mkdir's `mode` is masked by the umask, so chmod explicitly afterwards —
  // the same belt-and-braces logger.js uses for the log directory.
  try {
    mkdirSync(det.target, { recursive: true, mode: 0o700 })
    chmodSync(det.target, 0o700)
  } catch (err) {
    return { ...out, reason: `target-unwritable: ${err.message}` }
  }

  for (const name of det.stranded) {
    const from = join(det.source, name)
    const to = join(det.target, name)
    try {
      // errorOnExist + force:false is a second lock on "never overwrite": the
      // detection already excluded anything present in the target, but the two
      // reads are not atomic and the copy must lose that race, not win it.
      cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
      mirrorDirectoryModes(from, to)
      out.copied.push(name)
    } catch (err) {
      out.failed.push({ name, error: err.message })
    }
  }
  return out
}
