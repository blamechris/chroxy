import { trustFolder, scanFolderSettings } from '../../src/folder-trust.js'

/** Trust a folder the way the dashboard does: bound to the digest of the state it reviewed. */
export function trustReviewed(dir) {
  return trustFolder(dir, scanFolderSettings(dir).digest)
}
