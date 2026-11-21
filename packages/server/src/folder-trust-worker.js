/**
 * Worker thread that runs `scanFolderSettings` off the daemon's main thread, so a
 * display-only scan of a large folder never delays the frames clients are waiting
 * for. Launch decisions do NOT use this: they scan in-thread (folder-trust.js).
 */
import { parentPort } from 'node:worker_threads'
import { scanFolderSettings } from './folder-trust.js'

parentPort.on('message', ({ id, cwd }) => {
  let scan = null
  try {
    scan = scanFolderSettings(cwd)
  } catch {
    scan = null
  }
  parentPort.postMessage({ id, scan })
})
