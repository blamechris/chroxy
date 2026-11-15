/**
 * The one durable-write helper (agent-principals contract §5.4, §6.6, §10.2).
 *
 * "Durable" here is the standard `_flushPersistConfirmedDurable`
 * (session-manager.js) uses: write a temp file, fsync the file, rename it over the
 * destination, fsync the DIRECTORY. `writeFileRestricted` (platform.js) already is
 * exactly that recipe when asked for `durable: true` (it also keeps the 0600 mode and
 * the Windows write-through rename), so this module is a thin, named wrapper rather
 * than a second implementation. What it adds is the VERDICT the principal-store
 * callers act on:
 *
 *   - `{ durable: true }`   the file is live and its directory entry is fsynced.
 *   - `{ durable: false }`  the file is live but the directory fsync failed
 *                           (`unconfirmed` carries the reason). A caller must not tell
 *                           the operator the write is durable.
 *   - a throw               nothing was published (the temp write, the file fsync or the
 *                           rename failed); the temp file is removed.
 *
 * The temp name carries the pid and random bytes, so a stale or planted sidecar at a
 * fixed name is never reused, and two writes in one process never share one.
 */
import { randomBytes } from 'node:crypto'
import { writeFileRestricted } from './platform.js'

/**
 * @param {string} filePath
 * @param {string} data
 * @param {object} [seams]  test seams passed to `writeFileRestricted` (`_fsync`, `_rename`)
 * @returns {{ durable: boolean, unconfirmed: string|null }}
 */
export function writeDurableFile(filePath, data, seams = {}) {
  const tmpSuffix = `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const { durabilityUnconfirmed } = writeFileRestricted(filePath, data, { ...seams, tmpSuffix, durable: true, strict: true })
  return { durable: durabilityUnconfirmed == null, unconfirmed: durabilityUnconfirmed ?? null }
}
