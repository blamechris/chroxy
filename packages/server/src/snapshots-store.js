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
 *
 * Reconciliation (#5075) closes the drift gap left by the snapshot/restore
 * landings (#5100 / #5092 / #5098): a snapshot is the pair (image tag,
 * sidecar JSON), and either side can outlive the other —
 *
 *   - User runs `docker rmi chroxy-byok-snap:foo` directly: the image is
 *     gone but the sidecar lingers, so the dashboard lists a ghost entry
 *     whose DELETE just re-fails. Also covers the existing best-effort
 *     `imageRemoved: false` case in `deleteSnapshot` above — by the next
 *     reconcile pass the image truly is gone, so we drop the sidecar.
 *   - Sidecar corrupted or manually deleted: the image still sits on the
 *     host eating disk. We log a warning so the operator can decide to
 *     `docker rmi` it themselves, but we DO NOT auto-rm — a user may have
 *     intentionally retagged something into the `chroxy-byok-snap` prefix.
 *
 * `reconcileOrphans()` is the surface for both. It is a pure function over
 * an injected `listImages(): Promise<string[]>` callback (filtered to the
 * `chroxy-byok-snap:` prefix at the docker shell level so we never touch
 * an image outside our scope) and the on-disk sidecar directory.
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

/**
 * Image-tag prefix every docker-byok snapshot is published under. The
 * reconciler only ever reasons about images in this namespace so it can
 * never touch (or even consider an orphan) an unrelated image on the host.
 */
const SNAPSHOT_TAG_PREFIX = 'chroxy-byok-snap:'

/**
 * @typedef {Object} ReconcileResult
 * @property {number} sidecarsScanned          Count of valid (taggable) sidecars considered.
 * @property {number} imagesScanned            Count of `chroxy-byok-snap:` images on the host.
 * @property {string[]} orphanedSidecarsRemoved Slugs of sidecars unlinked (tag gone from daemon).
 * @property {string[]} orphanedImagesLogged    Snapshot image tags with no sidecar (logged, NOT removed).
 */

/**
 * Reconcile the two halves of a docker-byok snapshot — the image tag in
 * the local daemon and the JSON sidecar on disk — and repair drift.
 *
 * Strategy (documented in the module header, #5075):
 *
 *   - sidecar WITHOUT a matching image tag  → the image was deleted out
 *     from under us (`docker rmi` by hand, or a best-effort
 *     `deleteSnapshot` that left `imageRemoved: false`). The sidecar is a
 *     ghost the dashboard would re-list forever, so we UNLINK it.
 *   - image tag WITHOUT a matching sidecar  → an image sits on the host
 *     eating disk but nothing tracks it. We LOG it for the operator and
 *     deliberately do NOT `docker rmi` — a user may have intentionally
 *     retagged something into the `chroxy-byok-snap:` namespace, and a
 *     reconciler must never destroy data it didn't create.
 *
 * `listImages` is treated as the source of truth for what exists in the
 * daemon. If it rejects (daemon down, docker missing) we propagate the
 * error and take NO destructive action — reconciling against a partial or
 * empty image list would wrongly delete every live sidecar. This keeps the
 * pass idempotent and safe to run on a schedule.
 *
 * Pairing is by exact image tag: a sidecar's `tag` field is matched against
 * the set of `chroxy-byok-snap:`-prefixed tags returned by `listImages`.
 * Non-snapshot images returned by `listImages` are filtered out up front so
 * they neither count toward `imagesScanned` nor surface as orphans.
 *
 * @param {object} opts
 * @param {() => Promise<string[]>} opts.listImages  Returns docker image tags (any namespace; filtered here).
 * @param {string} [opts.dir]  Override the snapshots dir (tests).
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcileOrphans({ listImages, dir } = {}) {
  if (typeof listImages !== 'function') {
    throw new Error('reconcileOrphans: listImages callback required')
  }

  // Source of truth first. A rejection here is fatal BY DESIGN — we must
  // never act on a partial/empty image list (it would nuke live sidecars).
  // A non-array return is treated the same way: fail loud rather than
  // coerce to [] and silently delete every sidecar (fail-destructive).
  const rawImages = await listImages()
  if (!Array.isArray(rawImages)) {
    throw new Error('reconcileOrphans: listImages must resolve to an array')
  }
  const snapshotImages = rawImages.filter(
    (tag) => typeof tag === 'string' && tag.startsWith(SNAPSHOT_TAG_PREFIX),
  )
  const imageSet = new Set(snapshotImages)

  // listSnapshots already skips unreadable/malformed/tag-less sidecars and
  // hands back a slug per entry, so reconcile only ever reasons about
  // sidecars it can pair by tag.
  const snapshotsDir = dir || getSnapshotsDir()
  const sidecars = listSnapshots({ dir: snapshotsDir })

  const orphanedSidecarsRemoved = []
  const trackedTags = new Set()

  for (const entry of sidecars) {
    trackedTags.add(entry.tag)
    if (imageSet.has(entry.tag)) continue
    // Sidecar's image is gone from the daemon — drop the ghost.
    const filePath = join(snapshotsDir, `${entry.slug}.json`)
    try {
      unlinkSync(filePath)
      orphanedSidecarsRemoved.push(entry.slug)
      log.info(
        `reconcileOrphans: removed orphaned sidecar ${entry.slug}.json (image ${entry.tag} no longer present)`,
      )
    } catch (err) {
      log.warn(`reconcileOrphans: failed to unlink orphaned sidecar ${filePath}: ${err.message}`)
    }
  }

  const orphanedImagesLogged = []
  for (const tag of snapshotImages) {
    if (trackedTags.has(tag)) continue
    // Image with no sidecar — log only, never auto-rm.
    orphanedImagesLogged.push(tag)
    log.warn(
      `reconcileOrphans: snapshot image ${tag} has no metadata sidecar; ` +
        `leaving in place (run "docker rmi ${tag}" to reclaim disk if unwanted)`,
    )
  }

  return {
    sidecarsScanned: sidecars.length,
    imagesScanned: snapshotImages.length,
    orphanedSidecarsRemoved,
    orphanedImagesLogged,
  }
}
