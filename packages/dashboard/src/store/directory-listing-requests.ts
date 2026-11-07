/**
 * Per-request routing for `list_directory` replies (#8303).
 *
 * `_directoryListingCallback` is ONE slot shared by path autocomplete and the
 * Browse picker, each of which overwrites the other's. A caller that wants only
 * its own answer (the New Session browsability probe) registers here under a
 * request id instead: the server echoes the id on the reply, and a reply that
 * carries one goes to that request's callback and NEVER to the shared slot. A
 * reply without an id (an older daemon, or a caller that sent none) goes to the
 * slot exactly as before and can never reach a registered request.
 */
import type { DirectoryListing } from './types'

type ListingCallback = (listing: DirectoryListing) => void

const pending = new Map<string, ListingCallback>()

/** Register a callback for one request id; returns an idempotent cancel. */
export function registerDirectoryListingRequest(requestId: string, cb: ListingCallback): () => void {
  pending.set(requestId, cb)
  return () => {
    if (pending.get(requestId) === cb) pending.delete(requestId)
  }
}

/** Drop every registered request (disconnect / full reset). */
export function clearDirectoryListingRequests(): void {
  pending.clear()
}

/** Registered request count — for tests that assert the map cannot grow. */
export function pendingDirectoryListingRequestCount(): number {
  return pending.size
}

/**
 * Deliver one `directory_listing` reply. An id-tagged reply is consumed by its
 * own registration (and the entry removed); an unknown id is dropped. Only an
 * untagged reply reaches the shared slot.
 */
export function routeDirectoryListing(
  requestId: string | null,
  listing: DirectoryListing,
  sharedSlot: ListingCallback | null,
): void {
  if (requestId) {
    const cb = pending.get(requestId)
    if (cb) {
      pending.delete(requestId)
      cb(listing)
    }
    return
  }
  if (sharedSlot) sharedSlot(listing)
}
