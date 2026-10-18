/**
 * One-shot, path-matched `directory_listing` probes.
 *
 * The store holds a single `_directoryListingCallback` slot that the path
 * autocomplete and the Browse view both overwrite. A caller that only wants
 * "what did the server say about THIS path" (the New Session modal's
 * not-browsable note, #8303) cannot share that slot: whoever installs last wins
 * and the other's response is silently swallowed. A probe lives beside the
 * slot instead — it never occupies or disturbs it.
 */
import type { DirectoryListing } from './types'

interface Probe {
  path: string
  cb: (listing: DirectoryListing) => void
}

const probes = new Set<Probe>()

/** Strip trailing slashes so `/a/b/` and `/a/b` compare equal. */
function normalize(p: string): string {
  if (!p || p === '/') return p
  return p.replace(/\/+$/, '')
}

/**
 * Register a one-shot listener for the listing whose `path` equals `path`
 * (exact, modulo trailing slashes). Fires at most once, then removes itself.
 * Returns an unsubscribe.
 */
export function addDirectoryListingProbe(
  path: string,
  cb: (listing: DirectoryListing) => void,
): () => void {
  const probe: Probe = { path: normalize(path), cb }
  probes.add(probe)
  return () => { probes.delete(probe) }
}

/** Deliver an incoming listing to every probe whose path matches; each fires once. */
export function dispatchDirectoryListingProbes(listing: DirectoryListing): void {
  if (probes.size === 0 || !listing.path) return
  const responsePath = normalize(listing.path)
  for (const probe of [...probes]) {
    if (probe.path !== responsePath) continue
    probes.delete(probe)
    probe.cb(listing)
  }
}
