/**
 * CALL-SITE coverage for the inlined isEntryPoint() guard copy in
 * packages/server/sidecar/agent.js (#7937, filed from #7934).
 *
 *   sidecar/agent.js   const invokedDirectly = (() => { ... })()
 *                       if (invokedDirectly) { const agent = new PodAgent(); agent.listen(PORT) ... }
 *
 * The guard itself is thoroughly covered — three un-mergeable copies, a drift
 * gate (scripts/__tests__/is-entry-point.test.mjs), a lint that forbids a
 * fourth (scripts/lint-entry-point-guard.mjs). What had no coverage was this
 * CALL SITE: agent.test.js imports `PodAgent`/`LineLimitTransform` directly at
 * module scope and exercises the class through its public API, but nothing
 * ever runs `node agent.js` or merely imports the module to check that the
 * `invokedDirectly` branch behaves as advertised in either direction.
 *
 * This module ships as a standalone in-pod bundle (its own package.json,
 * copied alone into the K8s sidecar image — see the module's own header) and
 * is the daemon's actual entry point in that environment. A guard stuck FALSE
 * there means `node agent.js` starts, does nothing, and exits 0 — a pod that
 * looks healthy at the container level and answers no health check at all,
 * which is indistinguishable from "still starting" until a probe times out.
 *
 * ── Why this is a SEPARATE FILE from agent.test.js, and NOTHING here imports
 * the module at file scope ──────────────────────────────────────────────────
 *
 * Same rule as packages/server/tests/entry-point-call-sites.test.js, and the
 * same reason: if the guard ever read TRUE on a plain import, importing the
 * module at module scope here would start a real HTTP+WS server as a side
 * effect of loading this test file — before a single assertion has run. That
 * failure has to surface as a NAMED assertion in the case built for it, not as
 * an unrelated port conflict or a process that never exits because
 * agent.test.js's own suite runs without `--test-force-exit` (#6042).
 *
 * ── Why the primary evidence is an OBSERVABLE SIDE EFFECT, not exit status ──
 *
 * The failure this exists to catch (#7198's class) is a guard that reads
 * false: the module body never runs `agent.listen()`, and the process exits 0
 * having done nothing. Exit 0 is what the bug looks like AND what a clean
 * "imported, did nothing" import looks like, so it distinguishes nothing on
 * its own. `/healthz` answering `{ok:true}` on a bound port is absent in both
 * the "never ran" and the "crashed" cases, so it is asserted as the deciding
 * fact; exit status is checked too, but only ever as a bounded secondary
 * signal (see {@link exitCodeWithin}'s own doc for why it must be bounded).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  allocatePort,
  attach,
  exitCodeWithin,
  expectNeverListening,
  makeTempDir,
  removeTempDir,
  terminate,
  waitForListening,
  waitForOutput,
} from '../helpers/entry-point-call-site.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_JS = resolve(__dirname, '..', '..', 'sidecar', 'agent.js')

const tempDirs = []
after(() => { for (const d of tempDirs) removeTempDir(d) })

const stageDir = (prefix) => {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

// A staged file, never `node -e`. Under `-e` there is no argv[1] at all, so
// the guard's very first line (`if (!process.argv[1]) return false`) decides
// the case before the path comparison this call site actually depends on is
// ever reached (see entry-point-call-sites.test.js for the same note).
const writeStagedScript = (dir, name, source) => {
  const file = join(dir, name)
  writeFileSync(file, source)
  return file
}

/** The module under test, as a specifier a staged script can `import()`. */
const moduleUrl = (target) => JSON.stringify(pathToFileURL(target).href)

describe('entry-point call site: sidecar/agent.js (#7937)', () => {
  const launch = (entry, port) => attach(spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  }))

  it('running the module directly binds the pod agent HTTP server and answers /healthz', async () => {
    const port = await allocatePort()
    const { child, stdout, stderr } = launch(AGENT_JS, port)
    try {
      const bound = await waitForListening(port)
      assert.ok(
        bound,
        `nothing bound 127.0.0.1:${port} — invokedDirectly never went true, so main() never ran.\n` +
        `stderr: ${JSON.stringify(stderr())}\nstdout: ${JSON.stringify(stdout())}`,
      )

      // Bounded: a child that binds but wedges before res.end() must fail this
      // test, not hang the suite.
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(10000) })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.ok, true, `unexpected /healthz body: ${JSON.stringify(body)}`)

      // A second, independent observation of the same fact: the listen()
      // callback's own log line, which only fires once the socket is bound and
      // `_startPingInterval()` has run — proving the guarded block reached its
      // success path, not merely that something answered HTTP on this port.
      const announced = await waitForOutput(stdout, (t) => t.includes('Listening on'), { timeoutMs: 5000 })
      assert.ok(announced, `main() never announced itself on stdout:\n${JSON.stringify(stdout())}`)
    } finally {
      await terminate(child)
    }
  })

  // POSITIVE CONTROL for the test after it, and the reason that test means
  // anything. Same staged-file shape, same env, same port observation as the
  // stuck-TRUE test below — differing only in that it calls `listen()` itself,
  // exactly what the guard would have called. If this ever fails, the test
  // below proves nothing and should be read as broken rather than green.
  it('positive control: the same staged-importer harness DOES bind when listen() is called', async () => {
    const dir = stageDir('agent-ctl-')
    const port = await allocatePort()
    const control = writeStagedScript(
      dir,
      'control.mjs',
      `const m = await import(${moduleUrl(AGENT_JS)})\n` +
      'const agent = new m.PodAgent()\n' +
      `await agent.listen(${JSON.stringify(port)})\n`,
    )
    const { child, stdout, stderr } = launch(control, port)
    try {
      assert.ok(
        await waitForListening(port, { timeoutMs: 5000 }),
        `the control did not bind 127.0.0.1:${port}, so the import test below cannot distinguish anything ` +
        '(or the module auto-ran on import and this second listen() call hit EADDRINUSE — read the ' +
        `stuck-TRUE result first).\nstderr: ${JSON.stringify(stderr())}\nstdout: ${JSON.stringify(stdout())}`,
      )
    } finally {
      await terminate(child)
    }
  })

  it('importing the module does NOT start the pod agent (the stuck-TRUE direction)', async () => {
    const dir = stageDir('agent-import-')
    const port = await allocatePort()
    const importer = writeStagedScript(
      dir,
      'importer.mjs',
      `await import(${moduleUrl(AGENT_JS)})\nconsole.log('IMPORTED-OK')\n`,
    )

    const { child, stdout, stderr, exited } = launch(importer, port)
    try {
      // Positive control FIRST: a typo'd URL or a module that threw on load
      // would leave the port just as unbound as correct behaviour does, so the
      // negative assertions below are only evidence once the import is proven
      // to have actually happened.
      assert.ok(
        await waitForOutput(stdout, (t) => t.includes('IMPORTED-OK'), { timeoutMs: 30000 }),
        `the importer never got past its import, so the assertions below prove nothing:\n` +
        `stderr: ${JSON.stringify(stderr())}`,
      )
      assert.ok(
        await expectNeverListening(port, { windowMs: 3000 }),
        'importing the module bound the pod agent HTTP server — the guard reads true when it is not ' +
        `the entry point, so merely running the unit suite would start a server.\nstderr: ${JSON.stringify(stderr())}`,
      )
      assert.ok(
        !stdout().includes('Listening on'),
        `main() announced itself on import:\n${JSON.stringify(stdout())}`,
      )
      // Bounded, like every other wait here. A guard stuck true turns this
      // importer into a live server that never exits, and an unbounded await
      // would hang the suite instead of failing it.
      assert.equal(
        await exitCodeWithin(exited),
        0,
        `the importer did not exit cleanly — importing started something that keeps the process ` +
        `alive: ${stderr()}`,
      )
    } finally {
      await terminate(child)
    }
  })
})
