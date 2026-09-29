/**
 * chroxy start / chroxy dev — Server launch commands.
 *
 * Both commands share options via addServerOptions.
 */
import { addServerOptions, loadAndMergeConfig, parseExtraOverrides } from './shared.js'
import { parseTunnelArg } from '../tunnel/index.js'
import { runDoctorChecks } from '../doctor.js'
import { resolveBinaryProvenanceMode, isBinarySignatureGateEnabled } from '../config.js'
import { resolveDaemonDefaultProvider } from '../providers.js'

export function registerServerCommands(program) {
  const startCmd = program
    .command('start')
    .description('Start the Chroxy server')

  addServerOptions(startCmd)
    .option('--no-auth', 'Skip API token requirement (local testing only, disables tunnel)')
    .option('--no-encrypt', 'Disable end-to-end encryption (dev/testing only)')
    .option('--no-supervisor', 'Disable supervisor mode (direct server, no auto-restart)')
    .option('--show-token', 'Show full API token in terminal output (masked by default)')
    .option('--skip-checks', 'Skip preflight dependency checks')
    .action(async (options) => {
      const extraOverrides = parseExtraOverrides(options)
      if (options.auth === false) extraOverrides.noAuth = true
      if (options.encrypt === false) extraOverrides.noEncrypt = true
      if (options.showToken) extraOverrides.showToken = true

      const config = loadAndMergeConfig(options, extraOverrides)

      const parsedTunnel = parseTunnelArg(config.tunnel || 'quick')

      // UX landmine #3: run preflight checks before starting so the
      // user discovers missing cloudflared in <1s instead of waiting
      // 30s for the tunnel timeout. Skip when tunnel is disabled
      // (--no-auth, externalUrl) since cloudflared isn't needed.
      const needsTunnel = !!parsedTunnel && !config.noAuth && !config.externalUrl
      if (!options.skipChecks) {
        const port = config.port || 8765
        // #8074 review C1: resolve the binary-provenance gate from the SAME
        // merged config `startCliServer`/`startSupervisor` below are about to
        // use (loadAndMergeConfig, which honours `-c <path>`) — not doctor's
        // own default `configPath('config.json')` read. Without this, `chroxy
        // start -c other.json` gated its dependency checks against the
        // OPERATOR'S DEFAULT config file while the daemon it then started
        // read `other.json`, so a `-c` invocation's checks could silently
        // gate against the wrong file's `binaryProvenance` settings (or none
        // at all). Env vars still win inside the resolvers themselves, so
        // CHROXY_BINARY_PROVENANCE / CHROXY_BINARY_SIGNATURE_GATE precedence
        // is unchanged.
        //
        // #8075: same defect family, the remaining half C1 left open — the
        // PROVIDER selection. Without an explicit `providers` override,
        // `runDoctorChecks` falls back to `resolveProviders`, which re-reads
        // the provider out of doctor's own default `configPath('config.json')`
        // (or DEFAULT_PROVIDER when that file is missing/unset) — never the
        // provider `--provider`, `-c <path>`, or CHROXY_PROVIDER actually
        // selected on the MERGED config above. That silently checked the
        // wrong provider's binary/credentials/provenance (and, via
        // `resolvedProviders[0]`, the wrong provider in the billing-canary
        // line and the claude-tui version-pin probe too) while the daemon
        // below spawned the one the operator actually asked for.
        // `resolveDaemonDefaultProvider` is the ONE derivation of "this
        // daemon's resolved default provider" (#7932, providers.js) — reused
        // here rather than a second `config.provider || DEFAULT_PROVIDER`
        // inline, so this can never drift from what `startCliServer` /
        // `startSupervisor` are about to spawn.
        const { checks } = await runDoctorChecks({
          port,
          providers: [resolveDaemonDefaultProvider(config)],
          binaryProvenanceMode: resolveBinaryProvenanceMode(config),
          binarySignatureGate: isBinarySignatureGateEnabled(config),
        })
        const failures = checks.filter((c) => {
          if (c.status !== 'fail') return false
          // Only require cloudflared when a tunnel will actually be used
          if (c.name === 'cloudflared' && !needsTunnel) return false
          return true
        })
        if (failures.length > 0) {
          console.error('\nPreflight checks failed:\n')
          for (const f of failures) {
            console.error(`  ✗ ${f.name}: ${f.message}`)
          }
          console.error('\nRun `chroxy doctor` for details, or `--skip-checks` to bypass.\n')
          process.exitCode = 1
          return
        }
      }
      // #7162: bound the service-manager capture files exactly once per
      // service boot — here, in the process the service manager spawned,
      // BEFORE any supervisor fork. This is the only point where the capture
      // fd offset is guaranteed ~0 on the non-append platform (systemd
      // `file:`); a supervised child restart must never re-truncate under
      // the supervisor's live fd (capStdioCaptureLogs itself excludes
      // win32 — the .cmd wrapper rotates before the redirect opens). The
      // notice lands at the top of the freshly truncated capture.
      if (process.env.CHROXY_DAEMON === '1' && process.env.CHROXY_SUPERVISED !== '1') {
        const { capStdioCaptureLogs } = await import('../logger.js')
        for (const { file, archive, preservedBytes } of capStdioCaptureLogs()) {
          console.log(`[chroxy] capped oversized capture log ${file} (last ${preservedBytes} bytes preserved to ${archive})`)
        }
      }

      const useSupervisor = !!parsedTunnel
        && !config.noAuth
        && !config.externalUrl
        && options.supervisor !== false
        && process.env.CHROXY_SUPERVISED !== '1'

      if (useSupervisor) {
        const { startSupervisor } = await import('../supervisor.js')
        await startSupervisor(config)
      } else {
        const { startCliServer } = await import('../server-cli.js')
        await startCliServer(config)
      }
    })

  const devCmd = program
    .command('dev')
    .description('Start in development mode (supervisor + auto-restart)')

  addServerOptions(devCmd)
    .option('--show-token', 'Show full API token in terminal output (masked by default)')
    .action(async (options) => {
      const extraOverrides = parseExtraOverrides(options)
      if (options.showToken) extraOverrides.showToken = true
      const config = loadAndMergeConfig(options, extraOverrides)

      if (config.noAuth) {
        console.error('❌ chroxy dev does not support noAuth mode; an API token is required')
        process.exit(1)
      }

      if (process.env.CHROXY_SUPERVISED === '1') {
        const { startCliServer } = await import('../server-cli.js')
        await startCliServer(config)
      } else {
        const { startSupervisor } = await import('../supervisor.js')
        await startSupervisor(config)
      }
    })
}
