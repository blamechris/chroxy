/**
 * CALL-SITE coverage for the two server modules that decide whether to run
 * `main()` with the shared `isEntryPoint()` guard (#7254).
 *
 *   src/server-cli-child.js            const isModuleEntryPoint = isEntryPoint(import.meta.url)
 *   src/channels/chroxy-channel-server.js   const isDirectRun = isEntryPoint(import.meta.url)
 *
 * The guard itself is thoroughly covered — three un-mergeable copies, a drift
 * gate (scripts/__tests__/is-entry-point.test.mjs), a lint that forbids a
 * fourth (scripts/lint-entry-point-guard.mjs) and unit tests
 * (tests/is-entry-point.test.js). What had no coverage was the CALL SITES:
 * whether `node server-cli-child.js` actually starts the child, and whether
 * importing it actually stays quiet. Both modules have test files, and both
 * only ever import the module and exercise its exports — the exact asymmetry
 * #7236 was filed about, closed there for the two `scripts/` call sites and
 * here for the two server ones.
 *
 * ── Why this is a SEPARATE FILE, and the one rule it lives by ──────────────
 *
 * NOTHING HERE MAY IMPORT EITHER MODULE UNDER TEST AT MODULE SCOPE.
 *
 * That is not tidiness. One of the two failure directions is "the guard reads
 * TRUE when the module was merely imported", and its symptom is that importing
 * the module runs `main()`. A test file that imports the module is therefore
 * disabled by the very bug it is trying to detect, and it fails in a way that
 * names nothing:
 *
 *   - hardwiring server-cli-child's guard true makes tests/server-cli-child.test.js
 *     die during its own top-level import (main() runs, finds no API token, and
 *     calls process.exit(1)). The runner reports `tests/server-cli-child.test.js
 *     failed` — one anonymous failure, no assertion, no clue.
 *   - hardwiring chroxy-channel-server's guard true makes
 *     tests/chroxy-channel-server.test.js bind 8788 and HANG forever at import,
 *     because the server suite has run without `--test-force-exit` since #6042.
 *     A hang is a CI timeout, not a test failure.
 *
 * Verified: both of those are what actually happens. Keeping these tests in a
 * file that touches the modules only through `fork`/`spawn` is what lets the
 * stuck-TRUE direction fail as a NAMED assertion instead.
 *
 * ── Why nothing here asserts on exit status ────────────────────────────────
 *
 * The failure this whole area exists to catch (#7198) is a guard that reads
 * false: the module body never runs, so the process exits 0 having done
 * nothing. Exit 0 is what the bug looks like AND what success looks like. Every
 * assertion below is therefore an OBSERVABLE SIDE EFFECT — a bound port, an IPC
 * frame, a JSON-RPC notification on stdout — each of which is absent when the
 * body did not run.
 *
 * ── Why each negative assertion is paired with a positive control ──────────
 *
 * "The port stayed closed" and "no ready frame arrived" pass just as happily
 * when the staged file failed to import, when the path was wrong, or when the
 * child died on startup. Each stuck-TRUE test below therefore proves its own
 * observation can see the effect when it IS present, before it is allowed to
 * report absence.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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
  waitUntil,
} from './helpers/entry-point-call-site.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHANNEL_SERVER = resolve(__dirname, '..', 'src', 'channels', 'chroxy-channel-server.js')
const SUPERVISED_CHILD = resolve(__dirname, '..', 'src', 'server-cli-child.js')

// Spelled out rather than imported from the module, for the reason in the
// header. tests/chroxy-channel-server.test.js already pins the module's own
// constant to this same literal, so the two cannot drift apart silently.
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

const tempDirs = []
after(() => { for (const d of tempDirs) removeTempDir(d) })

const stageDir = (prefix) => {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

// A staged file, never `node -e`. Under `-e` there is no argv[1] at all, so
// isEntryPoint returns false on its very first line and never reaches the path
// comparison that actually decides this — the test would pass without
// exercising the branch it exists to cover (#7236).
const stageScript = (dir, name, source) => {
  const file = join(dir, name)
  writeFileSync(file, source)
  return file
}

/** The module under test, as a specifier a staged script can `import()`. */
const moduleUrl = (target) => JSON.stringify(pathToFileURL(target).href)

describe('entry-point call site: chroxy-channel-server.js (#7254)', () => {
  const launch = (entry, port) => attach(spawn(process.execPath, [entry], {
    // stdin stays an open pipe: StdioServerTransport reads it, and closing it
    // would tear the child down before the assertions run.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHROXY_CHANNEL_PORT: String(port) },
  }))

  it('running the module directly binds the control surface and forwards a POST onto the channel', async () => {
    const port = await allocatePort()
    const { child, stdout, stderr } = launch(CHANNEL_SERVER, port)
    try {
      const bound = await waitForListening(port)
      // A guard stuck false lands exactly here: child alive, idle and silent.
      assert.ok(
        bound,
        `nothing bound 127.0.0.1:${port} — main() never ran, so the entry-point guard read false.\n` +
        `stderr: ${JSON.stringify(stderr())}\nstdout: ${JSON.stringify(stdout())}`,
      )

      const res = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', body: 'call-site-probe' })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'ok')

      // Stronger than "a port is open": the POST has to come back out of the
      // MCP stdio transport as a channel notification, which proves main() ran
      // all three of its steps — createChannelServer(), mcp.connect(stdio) and
      // startHttpControlSurface() — not merely that something is listening.
      const forwarded = await waitForOutput(stdout, (t) => t.includes(CHANNEL_NOTIFICATION_METHOD))
      assert.ok(forwarded, `no channel notification reached stdout:\n${JSON.stringify(stdout())}`)
      const line = stdout().trim().split('\n').find((l) => l.includes(CHANNEL_NOTIFICATION_METHOD))
      const frame = JSON.parse(line)
      assert.equal(frame.method, CHANNEL_NOTIFICATION_METHOD)
      assert.equal(frame.params.content, 'call-site-probe')
      assert.equal(frame.params.meta.path, '/probe')
    } finally {
      await terminate(child)
    }
  })

  // POSITIVE CONTROL for the test after it, and the reason that test means
  // anything. It runs the SAME harness — same staged-file shape, same env, same
  // port observation — differing only in that it calls main() itself. If this
  // ever fails, the test below proves nothing and should be read as broken
  // rather than green.
  it('positive control: the same staged-importer harness DOES bind when main() is called', async () => {
    const dir = stageDir('chroxy-channel-ctl-')
    const port = await allocatePort()
    // Deliberately calls main() itself. `main` is exported by this module, so
    // the control invokes exactly what the guard would have invoked.
    const control = stageScript(
      dir,
      'control.mjs',
      `const m = await import(${moduleUrl(CHANNEL_SERVER)})\nawait m.main()\n`,
    )
    const { child, stdout, stderr } = launch(control, port)
    try {
      assert.ok(
        await waitForListening(port),
        `the control did not bind 127.0.0.1:${port}, so the import test below cannot distinguish anything.\n` +
        `stderr: ${JSON.stringify(stderr())}\nstdout: ${JSON.stringify(stdout())}`,
      )
    } finally {
      await terminate(child)
    }
  })

  it('importing the module does NOT run main() (the stuck-TRUE direction)', async () => {
    const dir = stageDir('chroxy-channel-import-')
    const port = await allocatePort()
    const importer = stageScript(
      dir,
      'importer.mjs',
      `await import(${moduleUrl(CHANNEL_SERVER)})\nconsole.log('IMPORTED-OK')\n`,
    )

    const { child, stdout, stderr, exited } = launch(importer, port)
    try {
      assert.ok(
        await expectNeverListening(port),
        'importing the module bound the control surface — the guard reads true when it is not the entry ' +
        'point, so merely running the unit suite would start a server and a stdio transport.\n' +
        `stderr: ${JSON.stringify(stderr())}`,
      )
      assert.ok(
        !stderr().includes('HTTP control surface listening'),
        `main() announced itself on import:\n${JSON.stringify(stderr())}`,
      )
      assert.ok(
        !stdout().includes(CHANNEL_NOTIFICATION_METHOD),
        `the module connected a channel transport on import:\n${JSON.stringify(stdout())}`,
      )
      // Positive control for all three assertions above: they are only evidence
      // of quiet behaviour if the import actually happened. Printed AFTER the
      // import resolves, so a typo'd URL or a module that threw on load cannot
      // masquerade as "imported it and it stayed quiet".
      assert.ok(
        stdout().includes('IMPORTED-OK'),
        `the importer never got past its import, so the assertions above prove nothing:\n${JSON.stringify(stderr())}`,
      )
      // Bounded, and captured at spawn time. A guard stuck true turns this
      // importer into a live server that never exits, and an unbounded await
      // would hang the suite instead of failing it.
      assert.equal(
        await exitCodeWithin(exited),
        0,
        `the importer did not exit cleanly — importing started something that keeps the process alive: ${stderr()}`,
      )
    } finally {
      await terminate(child)
    }
  })
})

describe('entry-point call site: server-cli-child.js (#7254)', () => {
  // This module IS the daemon's child process, which is why its call site
  // matters more than any other. When the guard reads false the module body
  // never runs: no supervisor IPC handler is registered, main() is never
  // called, no server starts — and the process exits 0 with no diagnostic. The
  // supervisor sees a child that started and stopped cleanly.
  //
  // The child boots against the `ollama` provider in a throwaway config dir.
  // That is not arbitrary: it is the cheapest provider that reaches `ready`.
  // The default (claude-tui) spawns a real `claude` TUI subprocess, and an
  // API-key provider such as deepseek aborts with ProviderCredentialMissingError
  // before main() finishes. `noAuth` plus a loopback `host` additionally keep
  // the child from advertising itself over mDNS on the developer's LAN
  // (maybeAdvertiseMdns declines on both counts). Measured: ready in ~285ms,
  // with no provider process and no PTY.
  const stage = async () => {
    const dir = stageDir('chroxy-child-callsite-')
    const cfgDir = join(dir, 'config')
    const home = join(dir, 'home')
    const emptyBin = join(dir, 'bin')
    mkdirSync(cfgDir)
    mkdirSync(home)
    mkdirSync(emptyBin)
    const port = await allocatePort()
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({ provider: 'ollama', host: '127.0.0.1', port, noAuth: true, tunnel: 'none', cwd: home }),
    )
    return { dir, cfgDir, home, emptyBin, port }
  }

  // HOME is redirected as well as CHROXY_CONFIG_DIR, and the redirection —
  // not the sandbox — is what protects the developer's real ~/.chroxy and
  // ~/.claude here (#4633). The child does inherit tests/_setup.mjs: fork()
  // passes process.execArgv through, so the forked daemon boots under the same
  // `--import` guard this process runs under. That is worth knowing but is not
  // worth relying on, for two reasons. It only holds for `fork` (the `spawn`ed
  // channel-server child above gets no execArgv), and the guard does not cover
  // named or namespace ESM `fs` imports at all — see #7262, which this work
  // turned up. Redirecting the roots is the protection; the sandbox is a
  // backstop that may or may not be armed for a given module.
  const boot = (entry, { cfgDir, home, emptyBin, port }) => {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CHROXY_CONFIG_DIR: cfgDir,
      PORT: String(port),
      CHROXY_NO_FILE_LOGGING: '1',
      // Keychain access is a real, prompting side effect on macOS; both stores
      // honour their own switch, so neither is consulted here.
      CHROXY_DISABLE_KEYCHAIN: '1',
      CHROXY_CRED_DISABLE_KEYCHAIN: '1',
      // PATH points at an EMPTY directory, which is the only way to suppress
      // the one subprocess this startup path still makes: wsServer.start() runs
      // `claude --help` unconditionally for feature detection, with no config
      // knob. Verified by putting a recording shim named `claude` on PATH and
      // watching it log `--help`; with PATH empty, nothing is recorded and the
      // child still reaches ready. The ollama provider needs no external binary,
      // so nothing else on this path wants PATH.
      PATH: emptyBin,
      // Point the ollama client at a dead port. Nothing on the startup path
      // makes a request, but a developer running a real Ollama on the default
      // port should not be able to change what this test observes.
      CHROXY_OLLAMA_BASE_URL: 'http://127.0.0.1:1',
    }
    // An inherited API_TOKEN would change the auth branch the child takes; the
    // config file is the only thing that should decide that here.
    delete env.API_TOKEN
    // NOTE: deliberately no `cwd` option. `fork()` inherits process.execArgv,
    // which under this suite is ['--import', './tests/_setup.mjs'] — a RELATIVE
    // specifier. Giving the child a different cwd makes it unresolvable and the
    // child dies at boot with ERR_MODULE_NOT_FOUND, which looks exactly like
    // "the guard read false". The session's working directory is set through
    // config.json's `cwd` key instead.
    return attach(fork(entry, [], {
      // The 'ipc' slot is the point: {type:'ready'} is this module's contract
      // with the supervisor, and it exists only over a fork channel.
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env,
    }))
  }

  const sawReady = (messages) => messages.some((m) => m && m.type === 'ready')

  it('forking the module directly starts the server and sends {type:"ready"} to the supervisor', async () => {
    const staged = await stage()
    const { child, messages, stdout, stderr, exited } = boot(SUPERVISED_CHILD, staged)
    try {
      const ready = await waitUntil(() => sawReady(messages), { timeoutMs: 30000 })
      assert.ok(
        ready,
        'no {type:"ready"} IPC frame — main() never ran, so the entry-point guard read false and the ' +
        'supervised daemon started and did nothing.\n' +
        `stdout: ${JSON.stringify(stdout().slice(-2000))}\nstderr: ${JSON.stringify(stderr().slice(-2000))}`,
      )

      // Second, independent observation of the same fact: the IPC frame proves
      // main() reached its last line, the bound port proves startCliServer
      // genuinely brought a server up.
      assert.ok(
        await waitForListening(staged.port),
        `ready was announced but nothing is listening on 127.0.0.1:${staged.port}`,
      )

      // The guarded block registers the supervisor IPC handler as well as
      // calling main(), so exercise that half too — `shutdown` is the
      // supervisor's stop path and is handled ONLY inside the guard.
      child.send({ type: 'shutdown' })
      const [code] = await exited
      assert.equal(code, 0, `graceful shutdown should exit 0, got ${code}: ${stderr().slice(-2000)}`)
    } finally {
      await terminate(child)
    }
  })

  it('importing the module does NOT start a server (the stuck-TRUE direction)', async () => {
    const staged = await stage()
    const importer = stageScript(
      staged.dir,
      'importer.mjs',
      `await import(${moduleUrl(SUPERVISED_CHILD)})\nconsole.log('IMPORTED-OK')\n`,
    )

    const { child, messages, stdout, stderr, exited } = boot(importer, staged)
    try {
      // ORDER MATTERS, and the ordering is the fix for a defect this test had
      // in draft. Waiting on the child's exit FIRST hangs forever under the very
      // mutation this test exists to catch: a guard stuck true turns the
      // importer into a running daemon, so it never exits. With no default
      // per-test timeout and no --test-force-exit, that is a silent CI job
      // timeout rather than a failure. Every wait below is bounded, and the
      // assertions that name the problem run before the one about exiting.

      // Positive control first: without it, a typo'd import URL, a module that
      // threw on load, or a child that died early all produce exactly the same
      // "no server started" observation as correct behaviour does.
      assert.ok(
        await waitForOutput(stdout, (t) => t.includes('IMPORTED-OK'), { timeoutMs: 30000 }),
        'the importer never got past its import, so "no server started" below would prove nothing.\n' +
        `stdout: ${JSON.stringify(stdout().slice(-2000))}\nstderr: ${JSON.stringify(stderr().slice(-2000))}`,
      )

      // The port window comes before the IPC check because it WAITS: `ready` is
      // sent ~250ms after startup, so sampling messages the instant the import
      // resolves would miss it and report a false all-clear.
      assert.ok(
        await expectNeverListening(staged.port),
        `importing the module bound 127.0.0.1:${staged.port} — merely running the unit suite would start a server.`,
      )
      assert.ok(
        !sawReady(messages),
        'importing the module announced {type:"ready"} — the guard reads true when it is not the entry ' +
        'point, so any test that imports this module boots a daemon as a side effect.',
      )
      assert.equal(
        await exitCodeWithin(exited),
        0,
        'the importer did not exit cleanly — importing the module started something that keeps the process ' +
        `alive: ${stderr().slice(-2000)}`,
      )
    } finally {
      await terminate(child)
    }
  })
})
