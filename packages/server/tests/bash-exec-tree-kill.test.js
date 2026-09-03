// #7606 — the built-in Bash tool's timeout must reap the whole process tree.
// `bash -c 'a; b'` keeps bash as the parent of `a`, so a direct kill of bash on
// timeout left `a` running, reparented to pid 1, after the tool had already
// returned `timedOut: true`. The same shape — provider CLI → bash → node —
// leaked four `node --test` runners for 7.5 days at ~50 GB each.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeBash } from '../src/built-in-tools/bash-exec.js'
import { isWindows } from '../src/platform.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

describe('executeBash reaps the grandchild on timeout (#7606)', { skip: isWindows }, () => {
  it('a node grandchild of `bash -c "node …; :"` is dead after the tool times out', async () => {
    const stamp = `${process.pid}-${Date.now()}`
    const pidFile = join(tmpdir(), `chroxy-bash-treekill-${stamp}.pid`)
    const script = join(tmpdir(), `chroxy-bash-treekill-${stamp}.cjs`)
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9)`,
    )
    // `; :` forces bash to fork node rather than exec into it, so node is a
    // real grandchild of the tracked bash pid.
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}; :`
    let grandPid = null
    try {
      // The pid-file poll (<=3s) must finish well inside the tool timeout, or
      // a slow runner lets the tool reap the grandchild before we observe it.
      const resultP = executeBash({ command, timeoutMs: 5000 })
      for (let i = 0; i < 60 && grandPid === null; i++) {
        try {
          const raw = readFileSync(pidFile, 'utf-8').trim()
          if (raw) grandPid = parseInt(raw, 10)
        } catch { /* not yet */ }
        if (grandPid === null) await sleep(50)
      }
      assert.ok(Number.isInteger(grandPid) && grandPid > 0, 'grandchild should report a pid')
      assert.ok(isAlive(grandPid), 'grandchild alive before the timeout')

      const result = await resultP
      assert.equal(result.timedOut, true)

      let dead = false
      for (let i = 0; i < 80 && !dead; i++) {
        if (!isAlive(grandPid)) { dead = true; break }
        await sleep(100)
      }
      assert.ok(dead, 'timeout must reap the node grandchild, not just bash')
    } finally {
      try { if (grandPid) process.kill(grandPid, 'SIGKILL') } catch {}
      try { rmSync(script, { force: true }) } catch {}
      try { rmSync(pidFile, { force: true }) } catch {}
    }
  })
})
