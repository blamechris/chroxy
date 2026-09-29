/**
 * chroxy tunnel — Tunnel management commands
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { CLOUDFLARED_CANDIDATES } from '../tunnel/cloudflare.js'
import { writeFileRestricted, cloudflaredInstallHint } from '../platform.js'
import { configFile, prompt, resolveVerifiedCliBinary } from './shared.js'

/**
 * #7296 — writer-side check on the interactively-prompted tunnel name.
 *
 * `config.tunnelName` lands in three bare positional slots
 * (`tunnel create <name>`, `tunnel route dns <name> <hostname>`, and
 * `tunnel run … <name>` in tunnel/cloudflare.js). Each of those argvs now
 * carries a `--` separator — that is the guard that actually covers the slots,
 * and it covers them whatever wrote the value.
 *
 * This check is a SECOND layer over ONE of the value's three producers, and
 * saying so precisely matters here: claiming more coverage than the code has
 * is the defect class this whole PR is closing. The three producers are the
 * interactive `chroxy tunnel setup` prompt (below), `CHROXY_TUNNEL_NAME`
 * (config.js's env map), and `--tunnel-name <name>` (cli/shared.js). Only the
 * prompt is checked. The other two are typed by the operator into their own
 * shell or service file, so an option-shaped value there is self-inflicted and
 * the separator is the appropriate — and sufficient — control; a reject there
 * would break an operator whose pre-existing tunnel carries an exotic name,
 * for no attacker they do not already outrank.
 *
 * Cloudflare tunnel names are alphanumerics plus `.`, `_` and `-`; requiring
 * the FIRST character to be alphanumeric is what excludes the option shape.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidTunnelName(name) {
  return typeof name === 'string' &&
    name.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * argv for `cloudflared tunnel create <name>`, with option parsing terminated
 * immediately before the positional (#7296). Measured on cloudflared 2026.8.3
 * with a bogus `--origincert`: `tunnel create --help` prints help,
 * `tunnel create -- --help` does not.
 *
 * @param {string} tunnelName
 * @returns {string[]}
 */
export function cloudflaredCreateArgv(tunnelName) {
  return ['tunnel', 'create', '--', tunnelName]
}

/**
 * argv for `cloudflared tunnel route dns <name> <hostname>`, with option
 * parsing terminated immediately before the positionals (#7296).
 *
 * @param {string} tunnelName
 * @param {string} hostname
 * @returns {string[]}
 */
export function cloudflaredRouteDnsArgv(tunnelName, hostname) {
  return ['tunnel', 'route', 'dns', '--', tunnelName, hostname]
}

/**
 * A `preflight`-shaped stand-in for `cloudflared` (#8066) — not a session
 * Provider (there is no `SessionManager` instance backing `chroxy tunnel
 * setup`), but `runProviderPreflight` only ever reads `.preflight` (present),
 * `.resolvedBinary` (absent here, so `resolveBinary` always re-resolves
 * fresh — right for a short-lived CLI invocation with no live spawn path to
 * prefer) and `.capabilities` (absent ⇒ not containerized). Exposing exactly
 * that surface lets `resolveVerifiedCloudflaredBinary` below reuse the SAME
 * gate `chroxy resume` (#8061/#8065) and the daemon's tunnel adapter
 * (`_verifyCloudflaredProvenance`, tunnel/cloudflare.js, #6858/#6937) run,
 * rather than a third implementation.
 */
const CLOUDFLARED_PREFLIGHT_PROVIDER = {
  get preflight() {
    return {
      label: 'cloudflared',
      binary: {
        name: 'cloudflared',
        candidates: CLOUDFLARED_CANDIDATES,
        installHint: cloudflaredInstallHint(),
      },
    }
  },
}

/**
 * #8066 — resolve AND verify the exact `cloudflared` binary `chroxy tunnel
 * setup` is about to exec (`tunnel login` / `tunnel create` / `tunnel route
 * dns`), through the SAME opt-in provenance gate `chroxy resume`
 * (#8061/#8065, `cli/session-cmd.js`) and the daemon's tunnel adapter both
 * run — `runProviderPreflight`, with the gate mode / signature-gate flags
 * resolved from config the same way #8065 does (`resolveBinaryProvenanceMode`
 * / `isBinarySignatureGateEnabled` → `buildBinaryProvenanceOptions`), reading
 * the SAME shared `readGateConfig` (`cli/shared.js`) `chroxy resume` uses.
 *
 * The pre-#8066 "is it available" check (`CloudflareTunnelAdapter.checkBinary()`)
 * ran an unconditional `execFileSync('cloudflared', ['--version'])` — full code
 * execution against whatever `cloudflared` PATH resolved, before any gate and
 * before the operator answered a single prompt. `runProviderPreflight`'s own
 * existence/quarantine check (`verifyBinary`) answers "is it available" with a
 * `stat`, no exec at all, so that probe is gone entirely rather than merely
 * moved after the gate — one fewer exec than the four the issue counted, and
 * one that can never run unverified.
 *
 * This CLI subcommand runs standalone with no daemon `SessionManager`
 * instance to read `_binaryProvenanceMode` / `_binarySignatureGate` /
 * `binaryProvenanceLedger` off of, so — exactly like `chroxy resume` — the
 * two flags are resolved straight from a loaded config file. `configPath`
 * defaults to `configFile()` but honors `chroxy tunnel setup -c <path>`, so
 * the gate reads from THAT file's `binaryProvenance`, not always the default
 * `config.json`, mirroring how a daemon started with `chroxy start -c <path>`
 * is gated from its own file. `CHROXY_BINARY_PROVENANCE` /
 * `CHROXY_BINARY_SIGNATURE_GATE` still outrank either file (read from THIS
 * invocation's own shell).
 *
 * Fails CLOSED: any thrown error (`ProviderBinaryNotFoundError` — the
 * ordinary "cloudflared not found" case, never treated as a provenance
 * failure and never hashing anything relative to cwd — `ProviderBinaryQuarantinedError`,
 * `ProviderBinaryProvenanceError`, or `readGateConfig`'s
 * `GATE_CONFIG_UNREADABLE`) propagates to the caller, which prints it and
 * exits non-zero WITHOUT execing `cloudflared`. Never calls `process.exit`
 * itself, so it stays unit-testable in-process.
 *
 * @param {object} [deps] - test seams; production supplies none of them.
 * @param {string} [deps.configPath] - defaults to `configFile()`.
 * @param {Function} [deps.readConfig] - defaults to `readGateConfig(configPath)`.
 * @param {object} [deps.ledger] - defaults to a lazily-opened, default-path
 *   ledger; pass one explicitly to override, including `null`.
 * @param {Function} [deps.preflight] - defaults to `runProviderPreflight`.
 * @param {object} [deps.ProviderClass] - defaults to `CLOUDFLARED_PREFLIGHT_PROVIDER`.
 * @returns {string} the verified, spawnable absolute path to `cloudflared`.
 */
export function resolveVerifiedCloudflaredBinary({
  configPath,
  readConfig,
  ledger,
  preflight,
  ProviderClass = CLOUDFLARED_PREFLIGHT_PROVIDER,
} = {}) {
  // #8076 review S2: the actual gate sequence now lives once, in
  // `resolveVerifiedCliBinary` (cli/shared.js), shared with `chroxy resume`'s
  // `resolveVerifiedClaudeBinary` — this wrapper only supplies the
  // `cloudflared` stand-in and label.
  return resolveVerifiedCliBinary({
    configPath,
    readConfig,
    ledger,
    preflight,
    ProviderClass,
    providerLabel: 'cloudflared',
  })
}

export function registerTunnelCommand(program) {
  const tunnelCmd = program
    .command('tunnel')
    .description('Manage tunnel configuration')

  tunnelCmd
    .command('setup')
    .description('Interactive Cloudflare Named Tunnel setup')
    // #8066/#8076 review S3 — mirrors `chroxy resume`'s `-c, --config`
    // (#8065 review S4), but for `tunnel setup` this option controls TWO
    // things at the SAME path, not just one: the file the binary-provenance
    // gate reads `binaryProvenance` from, AND the file Step 4 writes
    // `tunnel`/`tunnelName`/`tunnelHostname` to. They must be the same file —
    // a daemon started with `chroxy start -c <path>` reads its named-tunnel
    // settings from THAT file, so writing them anywhere else would leave
    // `chroxy start -c <path>` unaware the setup ever ran. CHROXY_BINARY_PROVENANCE
    // / CHROXY_BINARY_SIGNATURE_GATE still come from the invoking shell's own
    // env, not a running daemon's.
    .option('-c, --config <path>', 'Path to config file — both the binary-provenance gate and the saved tunnel settings read/write this file; env overrides for the gate come from the invoking shell', configFile())
    .action(async (options) => {
      await runTunnelSetup(options)
    })
}

/**
 * Core `chroxy tunnel setup` logic, extracted from the Commander `.action()`
 * above so it is directly callable — with injectable deps — from tests
 * without spawning a subprocess (#8066), mirroring `runSessionResume`
 * (`session-cmd.js`, #8061).
 *
 * @param {{ config?: string }} options - Commander options.
 * @param {object} [deps]
 * @param {Function} [deps.resolveBinary] - defaults to
 *   `resolveVerifiedCloudflaredBinary`, called as
 *   `resolveBinary({ configPath: options.config })` in production.
 * @param {Function} [deps.setup] - defaults to `setupCloudflare`; called as
 *   `setup(cloudflaredPath, options.config, { promptFn: deps.promptFn })`.
 * @param {Function} [deps.promptFn] - forwarded to `setup` — a test-only
 *   stand-in for the real interactive `prompt()`.
 */
export async function runTunnelSetup(options, deps = {}) {
  const {
    resolveBinary = resolveVerifiedCloudflaredBinary,
    setup = setupCloudflare,
    promptFn,
  } = deps

  // #8066 — resolve AND verify the exact binary before printing anything
  // that implies setup is actually proceeding, and before any exec (the
  // `--version` existence probe included) or any prompt. A refusal here
  // fails CLOSED: nothing is spawned. `process.exitCode = ...; return`
  // rather than `process.exit(...)` keeps this unit-testable in-process,
  // matching `runSessionResume`'s #8065 review nitpick 4 convention.
  let cloudflaredPath
  try {
    cloudflaredPath = resolveBinary({ configPath: options.config })
  } catch (err) {
    // #8076 review N1: a plain "binary not installed" refusal should not
    // read like a security refusal for a binary that simply isn't present —
    // that phrasing is reserved for an actual gate verdict (provenance,
    // quarantine, an unreadable gate config). `ProviderBinaryNotFoundError`
    // is thrown BEFORE provenance ever runs (preflight.js's health-check-
    // first ordering), so this branch never fires for a real gate refusal.
    if (err.code === 'PROVIDER_BINARY_NOT_FOUND') {
      console.error(`\n❌ cloudflared not found.${err.installHint ? ` Install with: ${err.installHint}` : ''}`)
    } else {
      console.error(`\n❌ Refusing to set up the tunnel: ${err.message}`)
    }
    process.exitCode = 1
    return
  }

  // #8076 review S3: `-c <path>` must drive BOTH the gate's read (above) and
  // Step 4's write (inside `setup`) — the SAME file, so a daemon started
  // with `chroxy start -c <path>` actually sees the settings this run saves.
  await setup(cloudflaredPath, options.config, { promptFn })
}

/**
 * @param {string} cloudflaredPath - the verified absolute path resolved by
 *   `resolveVerifiedCloudflaredBinary` — execed for every call below,
 *   never the bare string `'cloudflared'` (#8066).
 * @param {string} configWritePath - #8076 review S3: the file Step 4 reads,
 *   merges into, and writes `tunnel`/`tunnelName`/`tunnelHostname` to — the
 *   SAME file `-c <path>` pointed the gate at (`runTunnelSetup` passes
 *   `options.config` here), never always the default `configFile()`, so a
 *   daemon later started with `chroxy start -c <path>` actually sees what
 *   this run saved.
 * @param {object} [deps]
 * @param {Function} [deps.promptFn] - defaults to the real `prompt()`
 *   (`cli/shared.js`); test-only seam so a Maestro-free unit test doesn't
 *   need real stdin.
 */
async function setupCloudflare(cloudflaredPath, configWritePath, { promptFn = prompt } = {}) {
  const { execFileSync } = await import('child_process')

  console.log('\n🔧 Named Tunnel Setup\n')
  console.log('A Named Tunnel gives you a stable URL that never changes.')
  console.log('You need: a Cloudflare account + a domain on Cloudflare DNS.\n')

  console.log('Step 1: Authenticate with Cloudflare\n')
  console.log('This will open a browser window to log in to Cloudflare.')
  const loginAnswer = await promptFn('Ready to login? (Y/n): ')
  if (loginAnswer.toLowerCase() === 'n') {
    console.log('\nRun \'cloudflared tunnel login\' manually when ready.')
    process.exit(0)
  }

  try {
    execFileSync(cloudflaredPath, ['tunnel', 'login'], { stdio: 'inherit' })
  } catch (_err) {
    console.error('\n❌ Login failed. Run \'cloudflared tunnel login\' manually.')
    process.exit(1)
  }

  console.log('\n✅ Authenticated with Cloudflare\n')

  console.log('Step 2: Create a tunnel\n')
  const tunnelName = (await promptFn('Tunnel name (default \'chroxy\'): ')) || 'chroxy'
  if (!isValidTunnelName(tunnelName)) {
    console.error(`\n❌ Invalid tunnel name: ${JSON.stringify(tunnelName.slice(0, 64))}`)
    console.error('   Use letters, digits, \'.\', \'_\' or \'-\', starting with a letter or digit.')
    process.exit(1)
  }

  try {
    execFileSync(cloudflaredPath, cloudflaredCreateArgv(tunnelName), { stdio: 'inherit' })
  } catch {
    console.log(`\nTunnel '${tunnelName}' may already exist. Continuing...\n`)
  }

  console.log('\nStep 3: Set up DNS route\n')
  console.log('Enter the hostname you want to use (e.g., chroxy.example.com).')
  console.log('The domain must be on Cloudflare DNS.\n')
  const hostname = await promptFn('Hostname: ')
  if (!hostname) {
    console.error('❌ Hostname is required.')
    process.exit(1)
  }

  try {
    execFileSync(cloudflaredPath, cloudflaredRouteDnsArgv(tunnelName, hostname), { stdio: 'inherit' })
  } catch {
    console.log('\nDNS route may already exist. Continuing...\n')
  }

  console.log('\nStep 4: Saving configuration\n')

  const writeDir = dirname(configWritePath)
  if (!existsSync(writeDir)) {
    mkdirSync(writeDir, { recursive: true })
  }

  let config = {}
  if (existsSync(configWritePath)) {
    config = JSON.parse(readFileSync(configWritePath, 'utf-8'))
  }

  config.tunnel = 'named'
  config.tunnelName = tunnelName
  config.tunnelHostname = hostname

  writeFileRestricted(configWritePath, JSON.stringify(config, null, 2))

  console.log('✅ Configuration saved to:', configWritePath)
  console.log('')
  console.log('Your stable URLs:')
  console.log(`   HTTP:      https://${hostname}`)
  console.log(`   WebSocket: wss://${hostname}`)
  console.log('')
  console.log('Run \'chroxy start\' to launch with your Named Tunnel.')
  console.log('The QR code will always be the same — scan it once, connect forever.\n')
}
