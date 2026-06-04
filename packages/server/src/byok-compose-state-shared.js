/**
 * Process-wide singleton for the docker-byok compose-state store (#5081).
 *
 * Kept in its own module so live `DockerByokSession`s (which record/forget
 * their project id) and the boot-time `sweepOrphanedComposeStacks()` agree on
 * exactly one on-disk state file. Mirrors `getSharedPool()` in
 * docker-byok-pool.js.
 */

import { ByokComposeStateStore } from './byok-compose-state.js'

let _shared = null

/**
 * Lazily construct (once) and return the process-wide compose-state store.
 * @returns {ByokComposeStateStore}
 */
export function getSharedComposeStateStore() {
  if (!_shared) {
    _shared = new ByokComposeStateStore({})
  }
  return _shared
}

/**
 * Test helper — reset the singleton so a test using the real default path
 * doesn't bleed into the next. Not used in production.
 */
export function _resetSharedComposeStateStore() {
  _shared = null
}
