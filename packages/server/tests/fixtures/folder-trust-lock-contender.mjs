/**
 * A contender for the folder-trust store lock, run as a child process by the lock tests.
 *
 *   node folder-trust-lock-contender.mjs '<json: { storePath, criticalFile, logFile, iterations, mode? }>'
 *
 * Inside the lock it creates `<criticalFile>` exclusively and removes it again; finding
 * it already there means two holders overlapped, which is appended to `<logFile>`. With
 * `mode: 'die'` it takes the lock once and exits while holding it (leaving a lock whose holder
 * is gone, for the others to reclaim).
 */
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { withInterprocessLock } from '../../src/folder-trust.js'

const { storePath, criticalFile, logFile, iterations, mode } = JSON.parse(process.argv[2])
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (mode === 'die') {
  await withInterprocessLock(storePath, async () => {
    await pause(5)
    process.exit(0)
  })
}

for (let i = 0; i < Number(iterations); i += 1) {
  await withInterprocessLock(storePath, async () => {
    try {
      writeFileSync(criticalFile, String(process.pid), { flag: 'wx' })
    } catch {
      appendFileSync(logFile, `OVERLAP ${process.pid} iteration ${i}\n`)
      return
    }
    await pause(1 + Math.floor(Math.random() * 4))
    unlinkSync(criticalFile)
    appendFileSync(logFile, `DONE ${process.pid}\n`)
  })
}
