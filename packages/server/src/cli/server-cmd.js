/**
 * chroxy start / chroxy dev — Server launch commands.
 *
 * Both commands share options via addServerOptions.
 */
import { addServerOptions, loadAndMergeConfig, parseExtraOverrides } from './shared.js'
import { parseTunnelArg } from '../tunnel/registry.js'

export function registerServerCommands(program) {
  const startCmd = program
    .command('start')
    .description('Start the Chroxy server')

  addServerOptions(startCmd)
    .option('--no-auth', 'Skip API token requirement (local testing only, disables tunnel)')
    .option('--no-encrypt', 'Disable end-to-end encryption (dev/testing only)')
    .option('--no-supervisor', 'Disable supervisor mode (direct server, no auto-restart)')
    .option('--show-token', 'Show full API token in terminal output (masked by default)')
    .action(async (options) => {
      const extraOverrides = parseExtraOverrides(options)
      if (options.auth === false) extraOverrides.noAuth = true
      if (options.encrypt === false) extraOverrides.noEncrypt = true
      if (options.showToken) extraOverrides.showToken = true

      const config = loadAndMergeConfig(options, extraOverrides)

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
