/**
 * Test stand-in for the folder-trust scan worker that dies mid-scan: a request for a
 * folder whose path contains "exit" ends the thread, one containing "throw" raises an
 * uncaught error; any other folder is scanned normally.
 */
import { parentPort } from 'node:worker_threads'
import { scanFolderSettings } from '../../src/folder-trust.js'

parentPort.on('message', ({ id, cwd, limits }) => {
  if (cwd.includes('exit')) process.exit(1)
  if (cwd.includes('throw')) throw new Error('worker crashed')
  parentPort.postMessage({ id, scan: scanFolderSettings(cwd, limits) })
})
