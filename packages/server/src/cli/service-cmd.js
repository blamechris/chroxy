/**
 * chroxy service — Manage Chroxy as a system daemon
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { isWindows } from '../platform.js'

export function registerServiceCommand(program) {
  const serviceCmd = program
    .command('service')
    .description('Manage Chroxy as a system daemon')

  serviceCmd
    .command('install')
    .description('Register Chroxy as a system daemon (launchd/systemd)')
    .option('--cwd <path>', 'Working directory for Claude sessions')
    .option('--start-at-login', 'Start automatically on login')
    .action(async (options) => {
      const {
        getServicePaths,
        resolveNode22Path,
        resolveChroxyBin,
        loadServiceState,
        installService,
      } = await import('../service.js')

      if (isWindows) {
        console.error('Error: Service install is not supported on Windows.')
        console.error('Only macOS (launchd) and Linux (systemd) are supported.')
        process.exit(1)
      }

      const existing = loadServiceState()
      if (existing) {
        console.error('Chroxy service is already installed.')
        console.error(`  Service file: ${existing.servicePath}`)
        console.error('  Run "chroxy service uninstall" first to remove it.')
        process.exit(1)
      }

      let nodePath
      try {
        nodePath = resolveNode22Path()
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }

      let chroxyBin
      try {
        chroxyBin = resolveChroxyBin()
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }

      const cwd = options.cwd || homedir()

      if (options.cwd && !existsSync(options.cwd)) {
        console.error(`Error: Working directory "${options.cwd}" does not exist.`)
        process.exit(1)
      }

      const startAtLogin = options.startAtLogin || false

      try {
        installService({
          nodePath,
          chroxyBin,
          cwd,
          startAtLogin,
        })

        const paths = getServicePaths()
        const servicePath = paths.type === 'launchd' ? paths.plistPath : paths.unitPath

        console.log('\n\u2705 Chroxy service installed successfully!\n')
        console.log(`  Node:         ${nodePath}`)
        console.log(`  Chroxy CLI:   ${chroxyBin}`)
        console.log(`  Service file: ${servicePath}`)
        console.log(`  Log dir:      ${paths.logDir}`)
        console.log(`  Working dir:  ${cwd}`)
        console.log(`  Start on login: ${startAtLogin}`)
        if (paths.type === 'launchd') {
          console.log('\nThe service is installed but not running. To start it now:')
          console.log('  launchctl start com.chroxy.server')
        } else {
          console.log('\nThe service is enabled and running. To restart it:')
          console.log('  systemctl --user restart chroxy.service')
        }
      } catch (err) {
        console.error(`Error installing service: ${err.message}`)
        process.exit(1)
      }
    })

  serviceCmd
    .command('uninstall')
    .description('Remove the Chroxy system daemon')
    .action(async () => {
      const { uninstallService, loadServiceState } = await import('../service.js')

      const state = loadServiceState()
      if (!state) {
        console.error('Chroxy service is not installed. Nothing to uninstall.')
        process.exit(1)
      }

      try {
        uninstallService()
        console.log('\n\u2705 Chroxy service uninstalled successfully.\n')
        console.log('  Service file and state have been removed.')
        if (state.platform === 'darwin') {
          console.log('  The launchd job has been unloaded.')
        } else {
          console.log('  The systemd unit has been disabled and stopped.')
        }
      } catch (err) {
        console.error(`Error uninstalling service: ${err.message}`)
        process.exit(1)
      }
    })

  serviceCmd
    .command('start')
    .description('Start the Chroxy daemon')
    .action(async () => {
      const { getServiceStatus, startService } = await import('../service.js')
      const status = getServiceStatus()

      if (!status.installed) {
        console.error('Chroxy service is not installed. Run: chroxy service install')
        process.exit(1)
      }
      if (status.running) {
        console.error('Chroxy service is already running (PID ' + status.pid + ')')
        process.exit(1)
      }

      try {
        startService()
        console.log('Chroxy service started')
        console.log('Check status: chroxy service status')
      } catch (err) {
        console.error('Failed to start service:', err.message)
        process.exit(1)
      }
    })

  serviceCmd
    .command('stop')
    .description('Stop the Chroxy daemon')
    .action(async () => {
      const { getServiceStatus, stopService } = await import('../service.js')
      const status = getServiceStatus()

      if (!status.installed) {
        console.error('Chroxy service is not installed.')
        process.exit(1)
      }
      if (!status.running) {
        console.error('Chroxy service is not running.')
        process.exit(1)
      }

      try {
        stopService()
        console.log('Chroxy service stopped')
      } catch (err) {
        console.error('Failed to stop service:', err.message)
        process.exit(1)
      }
    })

  serviceCmd
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      const { getFullServiceStatus } = await import('../service.js')
      const status = await getFullServiceStatus()

      console.log('\nChroxy Service Status\n')

      if (!status.installed) {
        console.log('  Installed:  No')
        console.log('  Run: chroxy service install\n')
        return
      }

      console.log('  Installed:  Yes')

      if (!status.running) {
        if (status.stale) {
          console.log('  Running:    No (stale PID file)')
        } else {
          console.log('  Running:    No')
        }
        console.log('  Run: chroxy service start\n')
        return
      }

      console.log('  Running:    Yes (PID ' + status.pid + ')')

      if (status.health) {
        console.log('  Status:     ' + status.health.status)
      }

      if (status.connection) {
        console.log('  URL:        ' + status.connection.wsUrl)
        const token = status.connection.apiToken
        if (token) console.log('  Token:      ' + token)
      }

      if (status.recentLogs && status.recentLogs.length > 0) {
        console.log('\n  Recent logs:')
        for (const line of status.recentLogs) {
          console.log('    ' + line)
        }
      }

      console.log('')
    })
}
