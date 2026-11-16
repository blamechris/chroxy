#!/usr/bin/env node
/**
 * flush-and-exit.test.mjs — node test harness for scripts/flush-and-exit.mjs.
 *
 * No external test framework. Each `test()` block runs in series and pushes
 * pass/fail into a counter. Exit status is 0 if all pass, 1 otherwise.
 *
 * Run from repo root:
 *   node scripts/__tests__/flush-and-exit.test.mjs
 */

import { drainStdioAndExit } from '../flush-and-exit.mjs'
import { createWriteStream, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const helperPath = resolve(__dirname, '..', 'flush-and-exit.mjs')

const { flushAndExit } = await import(helperPath)

// Every case below must run. Without this, a harness whose cases stop executing
// reports "0 passed, 0 failed" and exits 0 — "all cases passed" and "no case
// executed" are the same observable outcome, the second recurring cause in
// docs/false-safety-guards.md (#7653). Asserted EQUAL, not >=, so removing a
// case is as loud as skipping one: a shell/node harness enumerates its cases
// literally, so the exact count is knowable here in a way it is not for a
// runner that DISCOVERS tests (scripts/lib/assert-test-count.mjs is a lower
// bound for exactly that reason).
const EXPECTED_CASES = 9

let pass = 0
let fail = 0
const failures = []

const test = async (name, fn) => {
  try {
    await fn()
    pass++
    process.stdout.write(`  ok ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// --- Test 1: writes are flushed to disk before exit callback fires --------
await test('flushes buffered writes to file before exit callback', async () => {
  const path = join(tmpdir(), `flush-and-exit-test-${process.pid}-${Date.now()}.txt`)
  const stream = createWriteStream(path, { encoding: 'utf8' })

  // Write a chunk of data that may still be buffered when we call end()
  const payload = 'final line: <<CTRL-D EXIT>>\n'
  stream.write(payload)

  // Use a callback instead of process.exit so the test can observe it
  let exitCalled = false
  let exitCode = null
  await new Promise((resolveP) => {
    flushAndExit(stream, 0, {
      exitFn: (code) => {
        exitCalled = true
        exitCode = code
        resolveP()
      },
    })
  })

  assert(exitCalled, 'exit callback should be called')
  assert(exitCode === 0, `exit code should be 0, got ${exitCode}`)

  const contents = readFileSync(path, 'utf8')
  assert(contents === payload, `file should contain payload, got: ${JSON.stringify(contents)}`)

  rmSync(path, { force: true })
})

// --- Test 2: exit callback called exactly once even if finish fires late --
await test('calls exit callback exactly once when finish fires before timeout', async () => {
  const path = join(tmpdir(), `flush-and-exit-test-${process.pid}-${Date.now()}.txt`)
  const stream = createWriteStream(path, { encoding: 'utf8' })
  stream.write('x\n')

  let callCount = 0
  await new Promise((resolveP) => {
    flushAndExit(stream, 0, {
      exitFn: () => {
        callCount++
        if (callCount === 1) resolveP()
      },
      fallbackMs: 500,
    })
  })

  // Wait past the fallback to make sure timer doesn't also fire
  await new Promise((r) => setTimeout(r, 700))
  assert(callCount === 1, `exit callback should fire exactly once, got ${callCount}`)
  rmSync(path, { force: true })
})

// --- Test 3: fallback timeout fires if finish never arrives --------------
await test('fallback timeout calls exit if finish event never fires', async () => {
  // A Writable that never emits finish (calls neither callback nor flushes)
  const stuckStream = new Writable({
    write(_chunk, _enc, _cb) {
      // intentionally never calls cb -> never drains, never finishes
    },
  })
  stuckStream.write('stuck')

  // Keep the event loop alive during the test so the unref'd fallback timer
  // has a chance to fire (the production process has other handles —
  // stdin, the PTY — that keep the loop alive). Without this guard, node
  // can exit before the fallback fires when the test's Promise is the only
  // pending awaitable.
  const keepAlive = setInterval(() => {}, 100)

  try {
    const t0 = Date.now()
    let exitCode = null
    await new Promise((resolveP) => {
      flushAndExit(stuckStream, 42, {
        exitFn: (code) => {
          exitCode = code
          resolveP()
        },
        fallbackMs: 200,
      })
    })
    const elapsed = Date.now() - t0
    assert(exitCode === 42, `exit code should be 42, got ${exitCode}`)
    assert(elapsed >= 180, `should wait at least ~200ms for fallback, waited ${elapsed}ms`)
    assert(elapsed < 1500, `should not hang forever, waited ${elapsed}ms`)
  } finally {
    clearInterval(keepAlive)
  }
})

// --- Test 4: caller's "closed" guard prevents write-after-end -------------
// This documents the pattern the recorder uses: a `closed` flag flipped
// before invoking flushAndExit, so any late writes (e.g. a PTY chunk
// arriving after Ctrl+D triggered SIGTERM) become no-ops instead of
// throwing ERR_STREAM_WRITE_AFTER_END on the underlying stream.
await test('write-after-flushAndExit guarded by caller flag does not throw', async () => {
  const path = join(tmpdir(), `flush-and-exit-test-${process.pid}-${Date.now()}-4.txt`)
  const stream = createWriteStream(path, { encoding: 'utf8' })
  stream.write('first\n')

  let closed = false
  const safeLog = (line) => {
    if (closed) return
    stream.write(line)
  }

  await new Promise((resolveP) => {
    closed = true
    flushAndExit(stream, 0, {
      exitFn: () => resolveP(),
    })
  })

  // Simulate late writes arriving after shutdown started — must be silent.
  let threw = false
  try {
    safeLog('late chunk 1\n')
    safeLog('late chunk 2\n')
  } catch {
    threw = true
  }
  assert(!threw, 'safeLog should swallow late writes once closed flag is set')

  const contents = readFileSync(path, 'utf8')
  assert(contents === 'first\n', `file should contain only the pre-close write, got: ${JSON.stringify(contents)}`)
  rmSync(path, { force: true })
})

// --- Test 5: fallback timer is unref'd so it doesn't keep node alive -----
await test('fallback timer is unref-ed', async () => {
  // Spawn a small node process that calls flushAndExit on a stuck stream
  // with a long fallback timeout. If the timer is unref-ed, the process
  // exits immediately after the event loop drains; otherwise it hangs
  // for the full fallback duration.
  const { spawn } = await import('node:child_process')
  const script = `
    import { Writable } from 'node:stream'
    const { flushAndExit } = await import('${helperPath}')
    const stuck = new Writable({ write() {} })
    stuck.write('x')
    // 30s fallback. If unref works, node still exits in ~ms because no
    // other handles are active. If unref is missing, node hangs 30s.
    flushAndExit(stuck, 0, { fallbackMs: 30000 })
  `
  const t0 = Date.now()
  await new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'ignore',
    })
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectP(new Error('child hung longer than 3s — fallback timer not unref-ed'))
    }, 3000)
    child.on('exit', () => {
      clearTimeout(killer)
      resolveP()
    })
  })
  const elapsed = Date.now() - t0
  assert(elapsed < 3000, `should exit quickly, took ${elapsed}ms`)
})

// --- Tests 6 & 7: stdout drain through a slow-read pipe (#9164) -----------
// A child prints well over a pipe buffer (~1.3 MB of lines) and a final
// sentinel, then exits. The parent deliberately does not read for 700 ms, so
// the tail is still queued inside the child when it exits. With a bare
// `process.exit` that tail is dropped (the CONTROL, which proves the case can
// fail); with drainStdioAndExit it is delivered.
const SENTINEL = 'SENTINEL-FINAL-LINE'
const runSlowReader = async (exitStatement, which = 'stdout') => {
  const { spawn } = await import('node:child_process')
  const script = `
    import { drainStdioAndExit } from '${helperPath}'
    const line = 'x'.repeat(99) + '\\n'
    for (let i = 0; i < 13000; i++) process.${which}.write(line)
    process.${which}.write('${SENTINEL}\\n')
    ${exitStatement}
  `
  return await new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectP(new Error('child did not finish within 15s'))
    }, 15000)
    // Lag the reader: nothing is consumed until the child has had time to
    // fill the pipe and exit (or block on it).
    if (which !== 'stdout') child.stdout.resume()
    if (which !== 'stderr') child.stderr.resume()
    const startReading = setTimeout(() => {
      child[which].on('data', (c) => chunks.push(c))
    }, 700)
    child.on('close', (code) => {
      clearTimeout(killer)
      clearTimeout(startReading)
      const out = Buffer.concat(chunks).toString('utf8')
      resolveP({ code, out, lines: out.split('\n').filter(Boolean) })
    })
  })
}

await test('drainStdioAndExit delivers the final line through a slow-read pipe and keeps the exit code', async () => {
  const r = await runSlowReader('await drainStdioAndExit(3)')
  assert(r.code === 3, `exit code should be 3, got ${r.code}`)
  assert(r.lines.length === 13001, `expected 13001 lines, got ${r.lines.length}`)
  assert(r.lines[r.lines.length - 1] === SENTINEL, `last line should be the sentinel, got ${JSON.stringify(r.lines[r.lines.length - 1])}`)
})

await test('CONTROL: a bare process.exit under the same slow reader loses the final line', async () => {
  const r = await runSlowReader('process.exit(3)')
  assert(r.code === 3, `exit code should be 3, got ${r.code}`)
  assert(!r.out.includes(SENTINEL),
    'the sentinel survived a bare process.exit — the slow-pipe condition did not reproduce, so case 6 proves nothing')
})

await test('drainStdioAndExit delivers the final STDERR line through a slow-read pipe and keeps the exit code', async () => {
  const r = await runSlowReader('await drainStdioAndExit(4)', 'stderr')
  assert(r.code === 4, `exit code should be 4, got ${r.code}`)
  assert(r.lines.length === 13001, `expected 13001 stderr lines, got ${r.lines.length}`)
  assert(r.lines[r.lines.length - 1] === SENTINEL, `last stderr line should be the sentinel, got ${JSON.stringify(r.lines[r.lines.length - 1])}`)
})

await test('drainStdioAndExit sets process.exitCode before waiting, so a stubbed exitFn cannot turn a failure into 0', async () => {
  const { spawn } = await import('node:child_process')
  const script = `
    import { drainStdioAndExit } from '${helperPath}'
    drainStdioAndExit(7, { exitFn: () => {}, fallbackMs: 50 })
    const t = setInterval(() => {}, 20)
    setTimeout(() => {
      process.stdout.write('exitCode=' + process.exitCode + '\\n')
      clearInterval(t)
    }, 300)
  `
  const r = await new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectP(new Error('child did not finish within 10s'))
    }, 10000)
    child.on('close', (code) => { clearTimeout(killer); resolveP({ code, out }) })
  })
  assert(r.out.trim() === 'exitCode=7', `process.exitCode should be 7 inside the child, got ${JSON.stringify(r.out)}`)
  assert(r.code === 7, `child should end with 7 when the loop empties, got ${r.code}`)
})

// --- summary --------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
let broken = false
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  broken = true
}
const ran = pass + fail
if (ran !== EXPECTED_CASES) {
  process.stdout.write(
    `HARNESS BROKEN: ran ${ran} cases, expected ${EXPECTED_CASES} — a case stopped executing\n`,
  )
  broken = true
}
await drainStdioAndExit(broken ? 1 : 0)
