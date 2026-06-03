/**
 * snapshots-store — list and delete docker-byok snapshot metadata sidecars.
 *
 * Snapshots produced by `DockerByokSession.snapshot()` (#5023 / #5071) write a
 * JSON sidecar to `${CHROXY_CONFIG_DIR ?? ~/.chroxy}/snapshots/<slug>.json`
 * shaped like:
 *
 *   { tag, name, createdAt, sourceCwd, sourceImage, sourceSessionId }
 *
 * This module gives the HTTP layer a thin read/delete API over that
 * directory so the dashboard can render a list and trigger removal
 * without re-implementing the directory contract. See #5074.
 *
 * Listing tolerates partial corruption: unreadable, malformed, or
 * non-object files are skipped with a warn line rather than failing the
 * entire request, so a single bad sidecar can't take the panel offline.
 *
 * Delete is two-step:
 *   1. `docker rmi <tag>` via the injected `removeImage` callback (the
 *      DockerBackend's helper in production, a stub in tests).
 *   2. `unlink` the sidecar.
 *
 * Step 1 best-effort: if rmi fails (image already gone, daemon down) we
 * still drop the sidecar so the dashboard stops listing a ghost entry.
 * The caller learns about the rmi failure via the returned `imageRemoved`
 * flag.
 */

import { readdirSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger.js'

const log = createLogger('snapshots')

/**
 * Resolve the snapshots metadata directory.
 *
 * Lazy (no caching): tests that mutate `CHROXY_CONFIG_DIR` between
 * cases see the new value, matching the pattern used by models.js /
 * device-preferences.js / connection-info.js.
 *
 * @returns {string}
 */
export function getSnapshotsDir() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'snapshots')
}

/**
 * Filename-safe characters per the sidecar slug convention in
 * docker-byok-session.js `_persistSnapshotMetadata`. Defence-in-depth
 * against path traversal in the DELETE handler: the URL slug must
 * match this charset before it's joined to the directory.
 */
const SLUG_RE = /^[A-Za-z0-9_.-]+$/

/**
 * @typedef {Object} SnapshotMetadata
 * @property {string} tag                Image tag (`chroxy-byok-snap:<rand>-<ts>`)
 * @property {string} name               Human-readable name (falls back to tag slug)
 * @property {string} createdAt          ISO-8601 timestamp
 * @property {string} sourceCwd          Host cwd the session ran in
 * @property {string} sourceImage        Base image the snapshot derives from
 * @property {string|null} sourceSessionId
 * @property {string} slug               Sidecar filename without `.json`
 */

/**
 * List all snapshots currently present in the metadata directory.
 *
 * Returns an empty array when the directory does not exist (no snapshots
 * have ever been taken) — that's the documented happy-path for a fresh
 * install, not an error.
 *
 * Each entry carries a `slug` field — the sidecar filename without its
 * `.json` extension — so the dashboard can pass it back to the DELETE
 * endpoint without re-deriving it from the tag.
 *
 * Files that fail to parse are skipped with a warn line. Sort order is
 * newest-first by `createdAt` so the dashboard can render the most
 * recent snapshot at the top; entries without a parseable createdAt
 * sink to the end.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]  Override the snapshots dir (tests).
 * @returns {SnapshotMetadata[]}
 */
export function listSnapshots({ dir } = {}) {
  const snapshotsDir = dir || getSnapshotsDir()
  if (!existsSync(snapshotsDir)) return []

  let entries
  try {
    entries = readdirSync(snapshotsDir, { withFileTypes: true })
  } catch (err) {
    log.warn(`Could not read snapshots dir ${snapshotsDir}: ${err.message}`)
    return []
  }

  const out = []
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (!ent.name.endsWith('.json')) continue
    const filePath = join(snapshotsDir, ent.name)
    let raw
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (err) {
      log.warn(`Skipping unreadable snapshot sidecar ${ent.name}: ${err.message}`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn(`Skipping malformed snapshot sidecar ${ent.name}: ${err.message}`)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tag !== 'string') {
      log.warn(`Skipping snapshot sidecar ${ent.name}: missing required "tag" field`)
      continue
    }
    out.push({
      tag: parsed.tag,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      sourceCwd: typeof parsed.sourceCwd === 'string' ? parsed.sourceCwd : '',
      sourceImage: typeof parsed.sourceImage === 'string' ? parsed.sourceImage : '',
      sourceSessionId: parsed.sourceSessionId == null ? null : String(parsed.sourceSessionId),
      slug: ent.name.slice(0, -'.json'.length),
    })
  }

  out.sort((a, b) => {
    const ta = Date.parse(a.createdAt)
    const tb = Date.parse(b.createdAt)
    const va = Number.isFinite(ta) ? ta : -Infinity
    const vb = Number.isFinite(tb) ? tb : -Infinity
    return vb - va
  })
  return out
}

/**
 * Delete a snapshot by slug — removes the docker image then drops the
 * sidecar JSON.
 *
 * The `removeImage` callback is injected (the DockerBackend helper in
 * production, a stub in tests) so this module doesn't take a hard
 * dependency on the docker backend. If `removeImage` rejects, the
 * sidecar is STILL deleted (image-rm is best-effort — a ghost sidecar
 * is worse UX than a leaked image, since the dashboard re-lists ghosts
 * forever) and the failure surfaces via the returned `imageRemoved`
 * flag.
 *
 * Returns:
 *   - { ok: false, status: 400, error: 'invalid slug' }  — slug fails charset check
 *   - { ok: false, status: 404, error: 'not found' }     — sidecar missing
 *   - { ok: true, tag, imageRemoved }                    — sidecar dropped (and image-rm attempted)
 *
 * @param {string} slug
 * @param {object} opts
 * @param {(tag: string) => Promise<void>} opts.removeImage
 * @param {string} [opts.dir]  Override the snapshots dir (tests).
 * @returns {Promise<{ok:true, tag:string, imageRemoved:boolean} | {ok:false, status:number, error:string}>}
 */
export async function deleteSnapshot(slug, { removeImage, dir } = {}) {
  if (typeof slug !== 'string' || slug.length === 0 || !SLUG_RE.test(slug)) {
    return { ok: false, status: 400, error: 'invalid slug' }
  }
  if (typeof removeImage !== 'function') {
    throw new Error('deleteSnapshot: removeImage callback required')
  }
  const snapshotsDir = dir || getSnapshotsDir()
  const filePath = join(snapshotsDir, `${slug}.json`)
  if (!existsSync(filePath)) {
    return { ok: false, status: 404, error: 'not found' }
  }
  let metadata
  try {
    metadata = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    log.warn(`deleteSnapshot: malformed sidecar ${slug}.json: ${err.message}`)
    metadata = null
  }
  const tag = metadata && typeof metadata.tag === 'string' ? metadata.tag : null

  let imageRemoved = true
  if (tag) {
    try {
      await removeImage(tag)
    } catch (err) {
      log.warn(`deleteSnapshot: docker rmi ${tag} failed: ${err.message}`)
      imageRemoved = false
    }
  } else {
    // No tag to remove — the sidecar was already corrupt. Treat the
    // image as "removed" in the response since there's nothing to do.
    imageRemoved = true
  }

  try {
    unlinkSync(filePath)
  } catch (err) {
    log.warn(`deleteSnapshot: failed to unlink ${filePath}: ${err.message}`)
    return { ok: false, status: 500, error: 'sidecar unlink failed' }
  }

  return { ok: true, tag: tag || '', imageRemoved }
}
