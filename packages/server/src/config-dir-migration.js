import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { configDir, defaultConfigDir } from './config-dir.js'
import { writeFileRestricted } from './platform.js'

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
 * #7244 — acknowledging a deliberate second root.
 *
 * Running a daemon at `CHROXY_CONFIG_DIR=/scratch/x` beside a real `~/.chroxy`
 * is a legitimate setup (the isolated-preview smoke recipe does exactly that),
 * and the stranded warning then fires at every boot with no way to say "I know".
 *
 * The acknowledgement is a SNAPSHOT of entry names, not a flag. `chroxy
 * config-dir ack` records the names stranded right now into
 * {@link ACK_FILE_NAME} in the TARGET root; the warning stays quiet only while
 * every currently stranded name is in that snapshot. An entry that appears
 * after the acknowledgement is not in it, so it warns again. A suppression
 * flag (`CHROXY_CONFIG_DIR_ACK=1`) was rejected because once set it also
 * silences a stranded entry that appears later — the false-safety shape
 * #7052/#7238/#7239 closed. An automatic marker written at boot was rejected
 * because it would silence the warning after one boot with no operator
 * decision, so an accidental stranding is reported once and then forgotten.
 *
 * The subset logic lives HERE and nowhere else: startup, `chroxy doctor`,
 * `config-dir status` and `config-dir ack` all go through it. Matching is by
 * entry name; contents are not hashed.
 */
export const ACK_FILE_NAME = 'config-dir-ack.json'
const ACK_VERSION = 1
// The file is a few hundred bytes; a bigger one is not ours, so do not read it.
const ACK_MAX_BYTES = 1024 * 1024

/**
 * Read the entry names acknowledged for this detection's source root.
 *
 * Returns `null` — "no acknowledgement" — for a missing, unreadable, oversized,
 * malformed or wrong-version file, and for one recorded against a different
 * source root. It never throws: the caller is the boot path, and the safe
 * answer to "cannot tell" is to warn as before, not to stay quiet or fail.
 *
 * @param {StrandedState} detection
 * @returns {string[]|null}
 */
export function readStrandedAck(detection) {
  try {
    const file = join(detection.target, ACK_FILE_NAME)
    const st = statSync(file)
    if (!st.isFile() || st.size > ACK_MAX_BYTES) return null
    const doc = JSON.parse(readFileSync(file, 'utf-8'))
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
    if (doc.version !== ACK_VERSION) return null
    if (doc.source !== detection.source) return null
    if (!Array.isArray(doc.acknowledged) || !doc.acknowledged.every((n) => typeof n === 'string')) return null
    return doc.acknowledged
  } catch {
    return null
  }
}

/**
 * Split a detection into the entries still unacknowledged and those that are.
 *
 * Pure. `stranded` / `highConsequence` on the result describe only the
 * UNACKNOWLEDGED entries, so every consumer that already reads those fields
 * (the warning, doctor) reports the right set without further changes;
 * `acknowledged` carries the stranded names that were covered.
 *
 * @param {StrandedState} detection
 * @param {string[]|null} ackNames
 * @returns {StrandedState & { acknowledged: string[] }}
 */
export function partitionStranded(detection, ackNames) {
  const known = new Set(ackNames ?? [])
  const stranded = detection.stranded.filter((n) => !known.has(n))
  return {
    ...detection,
    stranded,
    highConsequence: detection.highConsequence.filter((n) => stranded.includes(n)),
    acknowledged: detection.stranded.filter((n) => known.has(n)),
  }
}

/**
 * Read the acknowledgement for `detection` and apply it. The one call startup
 * and doctor make.
 *
 * @param {StrandedState} detection
 * @returns {StrandedState & { acknowledged: string[] }}
 */
export function applyStrandedAck(detection) {
  if (!detection.relocated || detection.unreadable) return { ...detection, acknowledged: [] }
  return partitionStranded(detection, readStrandedAck(detection))
}

/**
 * Record the currently stranded names as acknowledged, replacing any earlier
 * snapshot. Written 0600 and atomically into the TARGET root.
 *
 * @param {StrandedState} detection
 * @param {{ now?: () => Date }} [opts]
 * @returns {{ file: string, acknowledged: string[] }}
 */
export function writeStrandedAck(detection, { now = () => new Date() } = {}) {
  mkdirSync(detection.target, { recursive: true, mode: 0o700 })
  const file = join(detection.target, ACK_FILE_NAME)
  const doc = {
    version: ACK_VERSION,
    source: detection.source,
    acknowledged: [...detection.stranded],
    at: now().toISOString(),
  }
  writeFileRestricted(file, JSON.stringify(doc, null, 2))
  return { file, acknowledged: doc.acknowledged }
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
  const acked = detection.acknowledged?.length ?? 0
  if (acked > 0) {
    lines.push(`${acked} other ${acked === 1 ? 'entry was' : 'entries were'} acknowledged earlier and ${acked === 1 ? 'is' : 'are'} not listed above.`)
  }
  lines.push('Keeping this root on purpose?  chroxy config-dir ack  (stays quiet until a new entry appears)')
  return lines
}

/**
 * The lines the daemon logs at startup: the warning for what is still
 * unacknowledged (#7244). The startup path's whole seam, so a test can pin it
 * without booting the server.
 *
 * @param {StrandedState} detection
 * @returns {string[]}
 */
export function startupStrandedWarning(detection) {
  return formatStrandedWarning(applyStrandedAck(detection))
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
