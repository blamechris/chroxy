// Child process for session-name-allocator.test.js. argv[2] is a JSON options bag.
//   mode 'loop'  : allocate forever, printing each issued number AFTER allocate returns
//   mode 'hold'  : take the lock, announce via readyFile, block in afterLoad until releaseFile exists
//   mode 'soak'  : allocate `count` numbers (retrying lock_timeout), print them
//   mode 'once'  : one allocate with lockTimeoutMs, print the result
import { existsSync, writeFileSync, writeSync } from 'node:fs'
import { createSessionNameAllocator } from '../../src/session-name-allocator.js'

const a = JSON.parse(process.argv[2])
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const deps = {}
if (a.mode === 'hold') {
  deps.afterLoad = () => {
    writeFileSync(a.readyFile, '1')
    const stop = Date.now() + 10000
    while (!existsSync(a.releaseFile) && Date.now() < stop) sleep(5)
  }
}
const alloc = createSessionNameAllocator({ dir: a.dir, lockTimeoutMs: a.lockTimeoutMs ?? 1000, deps })

if (a.mode === 'loop') {
  for (;;) {
    const r = alloc.allocate({ cwd: a.cwd })
    if (r.ok) writeSync(1, `${r.number}\n`)
  }
} else if (a.mode === 'soak') {
  const out = []
  while (out.length < a.count) {
    const r = alloc.allocate({ cwd: a.cwd })
    if (r.ok) out.push(r.number)
    else if (r.reason !== 'lock_timeout') throw new Error(`unexpected ${r.reason}`)
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
} else {
  const t0 = Date.now()
  const res = alloc.allocate({ cwd: a.cwd })
  process.stdout.write(`${JSON.stringify({ ...res, elapsedMs: Date.now() - t0 })}\n`)
}
