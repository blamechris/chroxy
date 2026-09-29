/**
 * #7416 — behavioural pin over `DockerSession._startContainer`'s real
 * `docker run` argv, WITHOUT a production seam.
 *
 * `_spawnPersistentProcess`'s `docker exec` argv got a behavioural pin at
 * #7374 via the `_spawnDocker` instance-method seam. `_startContainer`'s
 * `docker run` argv (the builder that creates the long-lived container in
 * the first place) had none, and — per PR #8109 review — adding an
 * equivalent `_execFileDocker` seam there is the WRONG fix: `execFile('docker',
 * args, ...)` was directly resolvable by `scripts/lint-argv-sinks.mjs`
 * (`args` is a `const` array built and `.push()`-ed to within
 * `_startContainer` itself), so the static lint independently attested each
 * dynamic element (`this._memoryLimit`, `this._cpuLimit`, the cwd mount
 * template, `this._image`). Routing the call through a same-file wrapper
 * seam makes `args` an opaque parameter to the lint (the same shape
 * `_spawnDocker`'s pre-existing catalogue entry already has), collapsing
 * those 4 attestations into one opaque, human-asserted entry — and, proven
 * on the PR, silently swallows ANY future unguarded addition to this argv
 * (an `args.push('--hostname', this._hostnameOverride)` mutant went
 * undetected by both the lint and a same-file-seam behavioural test).
 *
 * So this file adds NO seam. It uses `node:test`'s `mock.module` (needs
 * `--experimental-test-module-mocks`, already on for this suite) to replace
 * `child_process`'s `execFile` for the specific test process that imports
 * `docker-session.js`, leaving `_startContainer`'s own `execFile('docker',
 * args, ...)` call — and therefore the FOUR real, still-in-place
 * `argv-safety.js` catalogue entries covering it — completely untouched.
 *
 * WHY A DEDICATED FILE: `mock.module('child_process')` patches the module
 * loader for the whole process it runs in. `cli-session-restart-on-input.test.js`
 * and `windows-cmd-routing.test.js` both document avoiding it for exactly this
 * reason — a leak into an unrelated subprocess-spawning suite running
 * concurrently would flake non-deterministically. The established safe
 * pattern already in this repo (`keychain-mock.test.js`) is to confine the
 * mock to its OWN dedicated file rather than mixing it into a file that also
 * drives other, unrelated real-subprocess code paths — this file follows
 * that precedent instead of adding the mock to `docker-session.test.js`
 * (which drives `_spawnPersistentProcess`/`_spawnDocker` real-argv tests that
 * must keep touching the real, unmocked `spawn`).
 *
 * Every value asserted below is a POSITIVE, exact pin (deepEqual on a sorted
 * key/value set, or an exact value at a known argv index) — never merely "at
 * least" — so an unguarded addition anywhere in `_startContainer`'s argv
 * construction that this file's fixture doesn't already cover would still
 * only be caught by the (now fully restored) static lint, not by these
 * tests; that lint is `argv-safety.js`'s own job and is proven separately in
 * `packages/server/scripts/lint-argv-sinks.sh`'s own test suite.
 */
import { describe, it, mock, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

// Skip entire suite if mock.module is unavailable (Node < 22.x without flag) —
// same guard keychain-mock.test.js and cli-session-spawn-admission.test.js use.
if (typeof mock.module !== 'function') {
  describe('DockerSession._startContainer real argv via child_process mock (#7416)', () => {
    it('skipped: mock.module not available (needs --experimental-test-module-mocks)', (t) => {
      t.skip('mock.module requires --experimental-test-module-mocks')
    })
  })
} else {
  // `namedExports` REPLACES the module's whole named-export set, not merges
  // with it — every OTHER module transitively imported by docker-session.js
  // (CliSession → platform.js/resolve-binary.js/verify-binary.js/…) also
  // imports from 'child_process' (execFileSync, spawnSync, fork, …), so the
  // real exports are spread in first and only `execFile`/`spawn` overridden;
  // dropping this spread breaks the import chain with a SyntaxError before a
  // single test runs (confirmed while writing this file).
  const realChildProcess = await import('child_process')
  const cpMock = {
    ...realChildProcess,
    execFile: mock.fn(),
    // docker-session.js also imports `spawn` (for `_spawnDocker`, the #7374
    // exec-argv seam) — overridden too so a regression that routes
    // `_startContainer` through `spawn` instead of `execFile` is caught
    // rather than silently hitting the (still real) spawn.
    spawn: mock.fn(() => {
      throw new Error('spawn() must not be called by _startContainer — only execFile is')
    }),
  }
  mock.module('child_process', { namedExports: cpMock })

  // Import AFTER mocking, so docker-session.js's `import { spawn, execFile }
  // from 'child_process'` binds to the mock.
  const { DockerSession } = await import('../src/docker-session.js')

  const _createdSessions = []
  after(() => {
    // These sessions never got a real `_containerId`-bearing destroy() path
    // exercised (no start()/spawn was ever called) — nothing to tear down
    // beyond dropping references, but keep the array from growing across a
    // (currently single) describe block for hygiene/parity with sibling files.
    _createdSessions.length = 0
  })

  /** The `--env KEY=value` KEYS (not values) present in a captured argv. */
  function envKeysOf(args) {
    const keys = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') keys.push(String(args[i + 1]).split('=')[0])
    }
    return keys
  }

  /** The `-v` / `--mount` VALUES present in a captured argv. */
  function mountsOf(args) {
    const mounts = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-v' || args[i] === '--mount') mounts.push(args[i + 1])
    }
    return mounts
  }

  /** The value immediately following the first occurrence of `flag` in argv, or undefined. */
  function valueAfter(args, flag) {
    const idx = args.indexOf(flag)
    return idx === -1 ? undefined : args[idx + 1]
  }

  beforeEach(() => {
    cpMock.execFile.mock.resetCalls()
    cpMock.spawn.mock.resetCalls()
  })

  /**
   * Drives the REAL `DockerSession._startContainer`, capturing the argv
   * `execFile` is really called with — the mocked `child_process.execFile`,
   * not a session-instance seam. `apiKey` controls
   * `process.env.ANTHROPIC_API_KEY` for the duration of the call only, saved
   * and restored in a `finally` (the `#4633` state-contamination lesson,
   * applied to an env var rather than a state file).
   */
  async function captureRunArgv({
    apiKey,
    cwd = '/tmp/chroxy-7416-project',
    image = 'node:22-slim',
    memoryLimit = '2g',
    cpuLimit = '2',
  } = {}) {
    const session = new DockerSession({ cwd, image, memoryLimit, cpuLimit })
    _createdSessions.push(session)

    let captured = null
    cpMock.execFile.mock.mockImplementation((cmd, args, opts, callback) => {
      captured = { cmd, args, opts }
      callback(null, 'c0ffeec0ffeec0ffee\n', '')
    })

    const savedKey = process.env.ANTHROPIC_API_KEY
    if (apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = apiKey
    try {
      await new Promise((resolve, reject) => {
        session._startContainer((err) => (err ? reject(err) : resolve()))
      })
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = savedKey
    }

    return { captured, session }
  }

  describe('DockerSession._startContainer — real argv via child_process mock (#7416)', () => {
    it('POSITIVE CONTROL: the mock is really reached, is a docker run, and ANTHROPIC_API_KEY forwards when set', async () => {
      const { captured, session } = await captureRunArgv({ apiKey: 'sk-real-test-key' })
      assert.equal(cpMock.execFile.mock.callCount(), 1, 'execFile must have been called exactly once')
      assert.ok(captured, 'the mocked execFile must have been reached')
      assert.equal(captured.cmd, 'docker', 'must shell out to docker')
      assert.equal(captured.args[0], 'run', 'argv must be a docker run invocation')
      assert.equal(session._containerId, 'c0ffeec0ffeec0ffee', 'positive control: the callback path really ran')
      assert.ok(
        envKeysOf(captured.args).includes('ANTHROPIC_API_KEY'),
        `ANTHROPIC_API_KEY must be forwarded when set on the host; got ${JSON.stringify(envKeysOf(captured.args))}`,
      )
      assert.equal(cpMock.spawn.mock.callCount(), 0, 'positive control: _startContainer must not call spawn()')
    })

    it('pins the COMPLETE set of --env keys the run argv forwards', async () => {
      const { captured } = await captureRunArgv({ apiKey: 'sk-real-test-key' })
      assert.deepEqual(
        envKeysOf(captured.args).sort(),
        ['ANTHROPIC_API_KEY'],
        `docker run argv must forward EXACTLY this env key set today; got ${JSON.stringify(envKeysOf(captured.args))}. ` +
        'If this fails because #7337 landed the sidecar mount, update this pin to assert the mount and its env ' +
        'forward TOGETHER (see #7337 note below) rather than widening it to "at least".',
      )
    })

    it('forwards no env vars at all when ANTHROPIC_API_KEY is unset', async () => {
      const { captured } = await captureRunArgv({ apiKey: undefined })
      assert.deepEqual(envKeysOf(captured.args), [], 'no --env at all without ANTHROPIC_API_KEY set on the host')
    })

    it('pins the COMPLETE set of bind mounts the run argv forwards', async () => {
      const { captured } = await captureRunArgv({ apiKey: 'sk-real-test-key', cwd: '/tmp/chroxy-7416-project' })
      assert.deepEqual(
        mountsOf(captured.args),
        ['/tmp/chroxy-7416-project:/workspace'],
        `docker run argv must mount EXACTLY the cwd workspace today, no more; got ${JSON.stringify(mountsOf(captured.args))}. ` +
        'A future #7337 sidecar mount must be added here AND coupled to its env forward above — see the note below.',
      )
    })

    // Review #8109 (Critical #1): the 4 catalogue entries this PR keeps in
    // place (this._memoryLimit / this._cpuLimit / the cwd mount template /
    // this._image) are STATIC attestations only — they say those elements
    // are provably-safe argv VALUES, never that the argv actually carries
    // them, in the right flag, at the right value. These three tests close
    // that behavioural gap for value-swap/wrong-slot/wrong-default mutants
    // (e.g. --cpus and --memory swapped, or a hardcoded value replacing the
    // constructor opt).
    //
    // One shape it CANNOT close, honestly noted rather than silently
    // over-claimed (docs/false-safety-guards.md's "comment describes a
    // stronger check than the code performs"): a `this._image ||
    // this._userSuppliedImageOverride`-style added fallback is unreachable by
    // ANY black-box argv assertion, because the constructor already
    // guarantees `this._image` is truthy (`opts.image || 'node:22-slim'`) —
    // the fallback never actually fires, so the argv is byte-identical with
    // or without it. That specific class needs a static check precise enough
    // to flag the new dynamic identifier regardless of what value it would
    // produce; `argv-safety.js`'s existing bare-substring `match: 'this._image'`
    // entry is (confirmed, pre-existing on origin/main, not introduced by this
    // PR) too loose to do that — it also matches this mutated expression's
    // text as a substring. Left as a known, out-of-scope gap in the lint's
    // own catalogue-matching precision, not something #7416 (a test-only
    // issue) takes on.
    it('pins the exact --memory value', async () => {
      const { captured } = await captureRunArgv({ apiKey: 'sk-real-test-key', memoryLimit: '3g' })
      assert.equal(valueAfter(captured.args, '--memory'), '3g')
    })

    it('pins the exact --cpus value', async () => {
      const { captured } = await captureRunArgv({ apiKey: 'sk-real-test-key', cpuLimit: '4' })
      assert.equal(valueAfter(captured.args, '--cpus'), '4')
    })

    it('pins the exact image positional argument', async () => {
      const { captured } = await captureRunArgv({ apiKey: 'sk-real-test-key', image: 'python:3.12-slim' })
      // The image is the 3rd-to-last positional argument: `<image> sleep infinity`.
      const last3 = captured.args.slice(-3)
      assert.deepEqual(last3, ['python:3.12-slim', 'sleep', 'infinity'])
    })

    /**
     * #7337 — the sidecar bind mount + matching env forward will land
     * TOGETHER in a future change. Today neither exists, so the exact-set
     * pins above are the whole guard. When that lands, split each pin so it
     * asserts the COUPLING explicitly, e.g.:
     *   the mount list includes the sidecar bind mount  <=>  the env keys include CHROXY_PERMISSION_MODE_FILE
     * so a change that mounts without forwarding (or forwards without
     * mounting) fails here instead of shipping half-done.
     */
  })
}
