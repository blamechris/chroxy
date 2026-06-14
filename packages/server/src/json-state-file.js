/**
 * JsonStateFile (#5580) — the shared "fail-open load + atomic 0600 save" seam
 * behind chroxy's hand-rolled JSON state files under `~/.chroxy/`.
 *
 * Chroxy carries ~15 small JSON state files (trust ledgers, usage logs,
 * notification prefs, BYOK compose state, …) that all repeat the same two
 * primitives:
 *
 *   1. LOAD: read + JSON.parse, fail OPEN to a caller-supplied empty value on
 *      any read/parse error (missing file, malformed JSON, non-object root).
 *      A corrupt state file must never throw into the caller — a single bad
 *      write can't be allowed to brick session creation or skill loading.
 *   2. SAVE: write atomically (temp + rename) at mode 0600, with a per-pid temp
 *      suffix (#5309 / #5579) so two daemons mid-write can't tear the file.
 *
 * The SAVE half is NOT re-implemented here — it delegates to
 * `writeFileRestricted` (platform.js), the established atomic-0600 writer that
 * already handles the Windows ACL branch, rename-failure cleanup, and the
 * orphaned-sidecar warn. This module is the thin promotion of that primitive
 * into a load+save pair so new state stores stop copy-pasting the parse/empty
 * guard and the mkdir+tmpSuffix dance. It is deliberately a function pair (not a
 * heavyweight class) so existing module-level load/save exports can adopt it
 * with a one-line body change and no behaviour drift.
 *
 * This is NOT a database and NOT a single-file migration: each caller keeps its
 * own path, its own lifecycle, and its own security boundary. JsonStateFile only
 * owns the read-bytes-or-empty and write-bytes-atomically mechanics that every
 * one of them was duplicating.
 */
import { existsSync, readFileSync, mkdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const defaultLog = createLogger('json-state-file')

/**
 * Read + JSON.parse a state file, failing OPEN on any error.
 *
 * Returns `fallback()` (a freshly-built empty value) when the file is missing,
 * unreadable, malformed JSON, or — when `requireObject` is set — has a
 * non-object / array root. Never throws.
 *
 * The `fallback` is a factory (not a value) so each call gets its own fresh
 * mutable container — returning a shared object would let one caller's mutations
 * leak into the next failed load.
 *
 * @template T
 * @param {string} filePath
 * @param {() => T} fallback  Factory returning the empty value on any failure.
 * @param {{
 *   requireObject?: boolean,
 *   log?: { warn?: (msg: string) => void, debug?: (msg: string) => void },
 *   onError?: (stage: 'read' | 'parse' | 'shape', err: Error | null) => void,
 * }} [opts]
 * @returns {T}
 */
export function loadJsonState(filePath, fallback, opts = {}) {
  const log = opts.log || defaultLog
  const requireObject = opts.requireObject !== false
  const onError = typeof opts.onError === 'function' ? opts.onError : null

  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    // ENOENT (first run) is normal and silent; other read errors warn once.
    if (err && err.code !== 'ENOENT') {
      log.warn?.(`Could not read state file (${err.code || err.message}); starting fresh`)
      onError?.('read', err)
    }
    return fallback()
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // Deliberately do NOT echo err.message — JSON.parse errors can quote the
    // offending input bytes, and this seam is reused for secret-adjacent state
    // files (mirrors the session-preset.js leak-guard convention).
    log.warn?.(`State file is malformed JSON (${(err && err.name) || 'SyntaxError'}); starting fresh`)
    onError?.('parse', err)
    return fallback()
  }

  if (requireObject && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    log.warn?.('State file root is not an object; starting fresh')
    onError?.('shape', null)
    return fallback()
  }

  return parsed
}

/**
 * Serialise `value` to pretty JSON (trailing newline) and write it atomically at
 * mode 0600. Creates the parent directory (mode 0700) first if missing. The temp
 * sidecar carries a per-pid suffix (`.<pid>.tmp`) by default so two SEPARATE
 * daemons mid-write can't tear the file (#5309 / #5579). That default does NOT
 * make two concurrent writes from the SAME process unique — a caller that flushes
 * the same path from multiple call sites in one process must pass a per-call
 * random `tmpSuffix` (as PathHashTrustLedger does: `.<pid>.<random>.tmp`).
 *
 * The default path delegates to `writeFileRestricted` (best-effort durability —
 * temp + chmod + rename, no fsync). Pass `fsync: true` for the durable variant:
 * the bytes are `fsync`'d before the rename flips the directory entry, so a crash
 * mid-write can't leave a renamed-but-empty file. #5620 promotes this — formerly
 * the hand-rolled `PathHashTrustLedger.flush` (#3238) — into the shared seam so
 * the trust ledgers stop re-implementing the atomic-durable-write dance, while
 * the ~15 best-effort state writers keep the cheaper non-fsync path.
 *
 * Re-throws on write/rename failure — callers that must surface a read-only-HOME
 * failure (e.g. SkillsTrustStore.flush) get the error; callers that treat
 * persistence as best-effort wrap the call in their own try/catch.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ pretty?: boolean, tmpSuffix?: string, fsync?: boolean }} [opts]
 */
export function saveJsonState(filePath, value, opts = {}) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const payload = opts.pretty === false
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2) + '\n'
  const tmpSuffix = typeof opts.tmpSuffix === 'string' && opts.tmpSuffix.length > 0
    ? opts.tmpSuffix
    : `.${process.pid}.tmp`

  if (opts.fsync) {
    // Durable variant (#5620). `wx` (O_EXCL) refuses to clobber a concurrent
    // writer's sidecar; the 0600 create mode is authoritative (umask only ever
    // tightens it), so no post-write chmod is needed. fsync before rename so the
    // bytes are on disk before the entry flips.
    const tmpPath = `${filePath}${tmpSuffix}`
    let fd = null
    let created = false
    try {
      fd = openSync(tmpPath, 'wx', 0o600)
      created = true
      // writeSync(string) can short-write; loop over a Buffer until every byte
      // lands, since this path exists specifically for durability.
      const buf = Buffer.from(payload, 'utf8')
      let written = 0
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written)
      }
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmpPath, filePath)
    } catch (err) {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
      // Only remove the temp if WE created it. An EEXIST from openSync('wx')
      // means the sidecar belongs to another writer — unlinking it would clobber
      // them, contradicting the `wx` refusal-to-clobber guarantee.
      if (created) {
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      }
      throw err
    }
    return
  }

  writeFileRestricted(filePath, payload, { tmpSuffix })
}
