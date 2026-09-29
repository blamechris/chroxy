/**
 * E2E coverage for `chroxy start` and `chroxy dev`.
 *
 * Covers src/cli/server-cmd.js. We never let the real server run — we
 * either pass --help, or rely on the missing-config / bad-flag error
 * paths so the CLI exits in milliseconds.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy start / dev', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('start --help lists the shared server flags', async () => {
    const r = await runCli(['start', '--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /Start the Chroxy server/)
    assert.match(r.stdout, /--config/)
    assert.match(r.stdout, /--tunnel/)
    // --cwd is registered by addServerOptions(); asserting it gives us
    // real coverage of the shared-options dispatch instead of duplicating
    // the --config assertion above.
    assert.match(r.stdout, /--cwd/)
  })

  it('dev --help describes development mode', async () => {
    const r = await runCli(['dev', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /development mode/i)
  })

  it('start exits 1 when no config exists (missing init)', async () => {
    // Fresh HOME → no ~/.chroxy/config.json → loadAndMergeConfig() will
    // print "No config found" and process.exit(1) immediately.
    const r = await runCli(['start'], { home, timeoutMs: 10000 })
    assert.equal(r.code, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`)
    assert.match(r.stderr, /No config found/)
  })

  it('start with --config pointing at a missing file errors and exits 1', async () => {
    const r = await runCli(
      ['start', '--config', '/tmp/definitely-not-a-real-config-12345.json'],
      { home, timeoutMs: 10000 },
    )
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Config file not found/)
  })
})

/**
 * #8074 review C1 — `chroxy start -c <path>` used to gate its dependency
 * checks' binary-provenance mode from the DEFAULT config file
 * (`<configDir>/config.json`), never the merged config `-c <path>` actually
 * points at — the same file `startCliServer`/`startSupervisor` are about to
 * launch the daemon from. Mirrors the #8065 review S4 fix for `chroxy resume
 * -c`. Own describe block with its own temp HOME (rather than sharing the
 * block above): this test writes a REAL `binary-trust.json` and a REAL
 * config file, which the "no config exists" test above must never see.
 */
describe('chroxy start -c <path> gates from the merged config (#8074 review C1)', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  // An extensionless shebang shim named `claude` is never resolved on
  // Windows (binary lookup there requires a PATHEXT extension), so the check
  // reports "Not found" before the gate is consulted. The C1 fix — which
  // config file the gate mode is read from — is platform-independent and is
  // proven on the POSIX legs.
  const C1_SHIM_SKIP = process.platform === 'win32'
    ? 'an extensionless shebang shim is not resolvable as `claude` on Windows (PATHEXT); the config-source fix is platform-independent'
    : false

  it('a block-mode "-c" config with a mismatched pin refuses — the shim binary is never exec\'d', { skip: C1_SHIM_SKIP }, async () => {
    // A real, tiny executable masquerading as `claude` (cli-session.js's
    // provider binary name), written to a directory prepended onto PATH for
    // this one child process — so `which claude` finds THIS shim first,
    // regardless of what else is installed on the host running the suite.
    const shimDir = mkdtempSync(join(tmpdir(), 'chroxy-c1-shim-'))
    const shimPath = join(shimDir, 'claude')
    const markerPath = join(shimDir, 'marker.txt')
    writeFileSync(shimPath, [
      `#!${process.execPath}`,
      `import { writeFileSync } from 'node:fs'`,
      `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
      `console.log('2.1.999 (chroxy-c1-shim)')`,
      'process.exit(0)',
    ].join('\n'))
    chmodSync(shimPath, 0o755)

    // The ledger `chroxy start` will read from is at the SANDBOXED default
    // path spawn-cli.js's `runCli` already points CHROXY_CONFIG_DIR at
    // (`<home>/.chroxy`) — seeded with a hash that can never match the shim,
    // so a correctly-wired block-mode gate refuses it. Key casing doesn't
    // matter: `PathHashTrustLedger._normalizeKey` re-normalizes on load.
    const chroxyDir = join(home, '.chroxy')
    mkdirSync(chroxyDir, { recursive: true })
    writeFileSync(join(chroxyDir, 'binary-trust.json'), JSON.stringify({
      binaries: {
        [shimPath]: { sha256: 'f'.repeat(64), firstSeen: '2020-01-01T00:00:00.000Z' },
      },
    }))

    // #8075 (fixed alongside this test): doctor's PROVIDER resolution now
    // honours the MERGED config's provider (`-c other.json`'s `claude-cli`
    // below), not this default file's. This default config.json is written
    // anyway, agreeing on `provider: 'claude-cli'`, so a C1 *regression*
    // that goes back to reading THIS file for the binary-provenance mode
    // still resolves mode 'off' (no `binaryProvenance` key here) and exposes
    // itself, rather than accidentally matching `other.json`'s `block` mode
    // for the wrong reason. It also keeps a fresh HOME from falling through
    // to DEFAULT_PROVIDER (`claude-tui`, @chroxy/protocol) if provider
    // resolution ever regressed too — `claude-tui` would run the SEPARATE
    // claude-tui-driving version probe against this same shimmed `claude`,
    // entangling this test with an unrelated code path.
    writeFileSync(join(chroxyDir, 'config.json'), JSON.stringify({ provider: 'claude-cli' }))

    // The config `-c` points at — deliberately NOT the default
    // `<home>/.chroxy/config.json` above, reproducing the exact review
    // repro: "chroxy start -c other.json" must gate from `other.json`'s
    // `binaryProvenance`, not from the default file's (absent) one.
    const otherConfigPath = join(home, 'other.json')
    writeFileSync(otherConfigPath, JSON.stringify({
      provider: 'claude-cli',
      noAuth: true, // disables the tunnel requirement, so cloudflared's own health can't confound this assertion
      binaryProvenance: { mode: 'block' },
    }))

    const r = await runCli(
      ['start', '-c', otherConfigPath],
      { home, timeoutMs: 15000, env: { PATH: `${shimDir}${delimiter}${process.env.PATH}` } },
    )
    try {
      assert.equal(r.code, 1, `expected a non-zero exit, got ${r.code}. stdout: ${r.stdout} stderr: ${r.stderr}`)
      assert.match(r.stderr, /hash_mismatch/, `expected the provenance refusal in stderr, got stdout: ${r.stdout} stderr: ${r.stderr}`)
      assert.equal(existsSync(markerPath), false, 'the shim must never have been exec\'d — this is the test that goes red under C1\'s defect (gating from the wrong/default config file, which has no binaryProvenance set, so the mismatch is never even checked)')
    } finally {
      rmSync(shimDir, { recursive: true, force: true })
    }
  })
})
