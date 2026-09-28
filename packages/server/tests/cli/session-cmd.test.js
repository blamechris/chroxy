/**
 * E2E coverage for `chroxy sessions` and `chroxy resume`.
 *
 * Covers src/cli/session-cmd.js. We never exec the real `claude` binary —
 * the "resume" tests focus on argument validation and listing.
 *
 * MEMORY WARNING: session-state.json is read from ~/.chroxy/. Every test
 * isolates HOME to prevent overwriting the real file.
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'
import { BinaryProvenanceLedger } from '../../src/binary-provenance-trust.js'

describe('chroxy sessions', () => {
  describe('with no session-state.json', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    it('reports "No saved sessions found." and exits 0', async () => {
      const r = await runCli(['sessions'], { home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /No saved sessions found/)
    })
  })

  describe('with an empty sessions array', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    before(() => {
      const dir = join(home, '.chroxy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'session-state.json'),
        JSON.stringify({ sessions: [], timestamp: Date.now() }),
      )
    })

    it('prints "No saved sessions."', async () => {
      const r = await runCli(['sessions'], { home })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /No saved sessions\./)
    })
  })

  describe('with populated sessions', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    before(() => {
      const dir = join(home, '.chroxy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'session-state.json'),
        JSON.stringify({
          sessions: [
            {
              name: 'work',
              cwd: '/tmp/work-dir',
              conversationId: 'conv-abc-123',
            },
            {
              name: 'play',
              cwd: '/tmp/play-dir',
              sdkSessionId: 'sdk-def-456',
            },
          ],
          timestamp: Date.now(),
        }),
      )
    })

    it('lists every session name, cwd, and resume hint', async () => {
      const r = await runCli(['sessions'], { home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /Saved Sessions \(2\)/)
      assert.match(r.stdout, /work/)
      assert.match(r.stdout, /play/)
      assert.match(r.stdout, /conv-abc-123/)
      assert.match(r.stdout, /sdk-def-456/)
      assert.match(r.stdout, /claude --resume/)
    })
  })

  describe('resume', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    it('exits 1 with a clear error when no sessions file exists', async () => {
      const r = await runCli(['resume'], { home })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /No saved sessions found/)
    })
  })
})

// ── #8065 review: the binary-provenance gate's PRODUCTION wiring ──────────
//
// Every case above (and every case in session-cmd-binary-gate.test.js)
// injects `readConfig` / `ledger` / `ProviderClass` into
// `resolveVerifiedClaudeBinary` — proving the GATE LOGIC is correct, but
// never evaluating the actual defaults `session-cmd.js` wires up in
// production (`configFile()`, `new BinaryProvenanceLedger()`, `CliSession`).
// A defect in those defaults (reading the wrong file, opening the wrong
// ledger) would pass every one of those tests. The suites below run the
// REAL CLI as a subprocess (`runCli`) with no injected deps at all, so they
// exercise exactly what a real `chroxy resume` invocation does.
//
// PATH is always overridden to a minimal, controlled list
// (`<binDir>:/usr/bin:/bin`) — never the real process PATH — because
// `CLAUDE_BINARY_CANDIDATES` includes absolute fallback paths like
// `/opt/homebrew/bin/claude` and `/usr/local/bin/claude`; leaking the real
// PATH into these tests could resolve an ACTUALLY installed `claude` instead
// of proving what the production defaults resolve.

/**
 * A REAL executable file named exactly `claude` so `which claude` (PATH
 * resolution, `resolve-binary.js`) finds it — writes a marker file the
 * instant it runs and exits 0. Skipped entirely on Windows (a `.mjs`
 * shebang shim isn't directly `execFile`-able there) by the caller's own
 * `{ skip: WINDOWS_SHIM_EXEC_SKIP }`.
 */
function makeClaudeShim(binDir) {
  mkdirSync(binDir, { recursive: true })
  const shimPath = join(binDir, 'claude')
  const markerPath = join(binDir, 'marker.txt')
  const body = [
    // Absolute interpreter path, NOT `#!/usr/bin/env node` — these tests
    // deliberately restrict PATH to `<binDir>:/usr/bin:/bin`, which has no
    // `node` on it, so an `env node` shebang would fail with a misleading
    // "env: node: No such file or directory" (exit 127) instead of actually
    // exercising the gate.
    `#!${process.execPath}`,
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
    `console.log('shim-ok')`,
    'process.exit(0)',
  ].join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
  return { shimPath, markerPath }
}

/** One resumable session, with `cwd` set to `home` (a real, existing directory — required for execFileSync's `cwd`). */
function writeResumableSessionState(home, convId) {
  const dir = join(home, '.chroxy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session-state.json'),
    JSON.stringify({ sessions: [{ name: 'work', cwd: home, conversationId: convId }], timestamp: Date.now() }),
  )
}

const WINDOWS_SHIM_EXEC_SKIP = process.platform === 'win32'
  ? 'a shebang shim is not directly executable via execFileSync on Windows; these cases assert a REFUSAL (no spawn), which does not depend on the shim actually running'
  : false

describe('chroxy resume — the gate runs against the PRODUCTION config reader, default-path ledger, and CliSession default, not injected test deps (#8065 review S1)', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  const binDir = join(home, 'bin')
  const { shimPath, markerPath } = makeClaudeShim(binDir)
  const convId = randomUUID()

  before(() => {
    const chroxyDir = join(home, '.chroxy')
    mkdirSync(chroxyDir, { recursive: true })
    writeFileSync(join(chroxyDir, 'config.json'), JSON.stringify({ binaryProvenance: { mode: 'block' } }))
    writeResumableSessionState(home, convId)
    // Seed the REAL default-path ledger — `resolveVerifiedClaudeBinary`'s
    // production default opens `new BinaryProvenanceLedger()` with no
    // `filePath` override, which resolves to exactly this file
    // (`configPath('binary-trust.json')`). `.approve()` handles the ledger's
    // own key normalization, so this is the daemon's real trust-file format,
    // not a hand-rolled JSON shape.
    new BinaryProvenanceLedger({ filePath: join(chroxyDir, 'binary-trust.json') })
      .approve(shimPath, 'f'.repeat(64))
  })

  it('refuses with no injected deps at all: exit 1, no spawn', async () => {
    const r = await runCli(['resume', '1'], {
      home,
      env: { PATH: `${binDir}:/usr/bin:/bin` },
    })
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /Refusing to resume/)
    assert.equal(
      existsSync(markerPath),
      false,
      'the shim must never have been spawned — this is the test that goes red when the PRODUCTION readConfig/ledger defaults in session-cmd.js point at the wrong place (#8065 review S1, mutants R1/R2); every other resume test in this repo injects readConfig/ledger/ProviderClass and cannot catch that class of defect',
    )
  })
})

describe('chroxy resume — a corrupt config.json refuses rather than silently falling open to gates-off (#8065 review S3)', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  const binDir = join(home, 'bin')
  const { markerPath } = makeClaudeShim(binDir)

  before(() => {
    const chroxyDir = join(home, '.chroxy')
    mkdirSync(chroxyDir, { recursive: true })
    // Invalid JSON (trailing comma) — the same fixture shape the review used
    // (case E) to show `chroxy start` refuses to boot on this exact file
    // (`cli/shared.js`'s config validation), while the OLD readConfigSoft
    // silently mapped the parse failure to `{}` (gates off), which would let
    // this healthy shim resolve and spawn normally.
    writeFileSync(join(chroxyDir, 'config.json'), '{"binaryProvenance":{"mode":"block"},}')
    writeResumableSessionState(home, randomUUID())
  })

  it('refuses instead of falling open — exit 1, no spawn', async () => {
    const r = await runCli(['resume', '1'], { home, env: { PATH: `${binDir}:/usr/bin:/bin` } })
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /Refusing to resume: cannot read .*config\.json to determine binaryProvenance mode/)
    assert.equal(
      existsSync(markerPath),
      false,
      'a corrupt config.json must never let the shim spawn — this is the test that goes red under the pre-S3 readConfigSoft (parse error -> {} -> gates off)',
    )
  })
})

describe('chroxy resume -c <path> honours a non-default config file for the gate (#8065 review S4)', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  const binDir = join(home, 'bin')
  const { shimPath, markerPath } = makeClaudeShim(binDir)
  const customConfigPath = join(home, 'custom-config.json')

  before(() => {
    const chroxyDir = join(home, '.chroxy')
    // The DEFAULT config file (<configDir>/config.json) is deliberately
    // never written — everything below only refuses if `-c <path>` is what
    // actually gets read.
    mkdirSync(chroxyDir, { recursive: true })
    writeFileSync(customConfigPath, JSON.stringify({ binaryProvenance: { mode: 'block' } }))
    writeResumableSessionState(home, randomUUID())
    new BinaryProvenanceLedger({ filePath: join(chroxyDir, 'binary-trust.json') })
      .approve(shimPath, 'f'.repeat(64))
  })

  it('a custom -c config in block mode with a mismatched pin refuses, even though the default config.json is absent (gates-off there)', async () => {
    const r = await runCli(['resume', '1', '-c', customConfigPath], {
      home,
      env: { PATH: `${binDir}:/usr/bin:/bin` },
    })
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /Refusing to resume/)
    assert.equal(
      existsSync(markerPath),
      false,
      'the shim must never have been spawned — this is the test that goes red when -c is not wired into the gate (it would fall back to the absent default config.json, i.e. gates off, and spawn)',
    )
  })
})
