// Child process for session-name-allocator.test.js. argv[2] is a JSON options bag.
//   mode 'loop'    : allocate forever, printing each issued number AFTER allocate returns
//   mode 'soak'    : allocate `count` numbers (retrying `contended`), print them
//   mode 'once'    : one allocate, print the result plus elapsedMs
//   mode 'contend' : every link attempt reports EEXIST; print the result and how many links were tried
import { writeSync } from 'node:fs'
import { createSessionNameAllocator } from '../../src/session-name-allocator.js'

const a = JSON.parse(process.argv[2])
const deps = {}
let links = 0
if (a.mode === 'contend') {
  deps.linkSync = () => {
    links += 1
    throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  }
}
const alloc = createSessionNameAllocator({ dir: a.dir, deps })

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
    else if (r.reason !== 'contended') throw new Error(`unexpected ${r.reason}`)
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
} else {
  const t0 = Date.now()
  const res = alloc.allocate({ cwd: a.cwd })
  process.stdout.write(`${JSON.stringify({ ...res, elapsedMs: Date.now() - t0, links })}\n`)
}
