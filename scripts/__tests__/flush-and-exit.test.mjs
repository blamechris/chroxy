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

import { createWriteStream, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const helperPath = resolve(__dirname, '..', 'flush-and-exit.mjs')

const { flushAndExit } = await import(helperPath)

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

// --- Test 4: fallback timer is unref'd so it doesn't keep node alive -----
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

// --- summary --------------------------------------------------------------
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.exit(0)
