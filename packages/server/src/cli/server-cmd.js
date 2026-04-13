/**
 * chroxy start / chroxy dev — Server launch commands.
 *
 * Both commands share options via addServerOptions.
 */
import { addServerOptions, loadAndMergeConfig, parseExtraOverrides } from './shared.js'
import { parseTunnelArg } from '../tunnel/index.js'
import { runDoctorChecks } from '../doctor.js'

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

      // UX landmine #3: run preflight checks before starting so the
      // user discovers missing cloudflared in <1s instead of waiting
      // 30s for the tunnel timeout. `chroxy doctor` already has these
      // checks — we just surface them inline on start.
      if (!options.skipChecks) {
        const port = config.port || 8765
        const { checks } = await runDoctorChecks({ port })
        const failures = checks.filter((c) => c.status === 'fail')
        if (failures.length > 0) {
          console.error('\nPreflight checks failed:\n')
          for (const f of failures) {
            console.error(`  ✗ ${f.name}: ${f.message}`)
          }
          console.error('\nRun `npx chroxy doctor` for details, or `--skip-checks` to bypass.\n')
          process.exitCode = 1
          return
        }
      }

      const parsedTunnel = parseTunnelArg(config.tunnel || 'quick')
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
