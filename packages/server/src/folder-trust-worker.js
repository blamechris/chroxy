/**
 * Worker thread that runs `scanFolderSettings` off the daemon's main thread, so a
 * scan of a large folder never delays the frames clients are waiting for. Used for
 * display scans and for launch decisions (each in its own worker; folder-trust.js).
 */
import { parentPort } from 'node:worker_threads'
import { scanFolderSettings } from './folder-trust.js'

parentPort.on('message', ({ id, cwd, limits }) => {
  let scan = null
  try {
    scan = scanFolderSettings(cwd, limits)
  } catch {
    scan = null
  }
  parentPort.postMessage({ id, scan })
})
