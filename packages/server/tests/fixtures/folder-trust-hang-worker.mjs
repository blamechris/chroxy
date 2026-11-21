/**
 * Test stand-in for the folder-trust scan worker: it scans like the real one, except
 * that a request for a folder whose path contains "hang" never answers (the thread
 * blocks, as it would on a filesystem that does not respond).
 */
import { parentPort } from 'node:worker_threads'
import { scanFolderSettings } from '../../src/folder-trust.js'

parentPort.on('message', ({ id, cwd, limits }) => {
  if (cwd.includes('hang')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  parentPort.postMessage({ id, scan: scanFolderSettings(cwd, limits) })
})
