// Verify the actual installed client and current configuration before any flow.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'

try {
  if (process.env.CHROXY_MAESTRO_RUNTIME_CACHE !== undefined ||
      process.env.CHROXY_MAESTRO_RUNTIME_VERSION !== undefined) throw new Error('Retired Maestro runtime inputs must be removed')
  const bundled = process.env.CHROXY_MAESTRO_BUILD_MODE !== undefined
  if (bundled && (process.env.CHROXY_MAESTRO_BUILD_MODE !== 'bundled' || !['1', 'true'].includes(process.env.CI))) {
    throw new Error('Bundled verification requires explicit bundled mode and CI')
  }
  const projectRoot = resolve(process.argv[2] || 'packages/app')
  const device = process.env.DEVICE || ''
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(device)) throw new Error('DEVICE must identify the selected iOS simulator')
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile || !isAbsolute(outputFile)) throw new Error('GITHUB_OUTPUT must be an absolute path')
  const options = { cwd: projectRoot, env: { ...process.env }, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
  const installedPath = execFileSync('xcrun', ['simctl', 'get_app_container', device, 'com.blamechris.chroxy', 'app'], options).trim()
  if (!isAbsolute(installedPath)) throw new Error('simctl did not return an absolute installed app path')
  const app = realpathSync(installedPath)
  const plist = path => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], options))
  const info = plist(join(app, 'Info.plist'))
  const updates = plist(join(app, 'Expo.plist'))
  if (info.CFBundleIdentifier !== 'com.blamechris.chroxy') throw new Error('Installed app identity does not match Chroxy')
  if (updates.EXUpdatesRuntimeVersion !== 'file:fingerprint') throw new Error('Installed app must use the fingerprint runtime policy')
  const installedRuntime = readFileSync(join(app, 'EXUpdates.bundle/fingerprint'), 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(installedRuntime)) throw new Error('Installed runtime fingerprint is invalid')
  const require = createRequire(join(projectRoot, 'package.json'))
  if (bundled) {
    const { exp } = require('expo/config').getConfig(projectRoot)
    const currentRuntime = exp.ios?.runtimeVersion ?? exp.runtimeVersion
    if (currentRuntime?.policy !== 'fingerprint' || exp.updates?.enabled !== true ||
        typeof exp.updates.url !== 'string' || !exp.updates.url.trim() || exp.updates.checkAutomatically !== 'NEVER') {
      throw new Error('Current bundled configuration must retain fingerprint, enabled updates and its URL with NEVER checks')
    }
    if (updates.EXUpdatesEnabled !== true || updates.EXUpdatesCheckOnLaunch !== 'NEVER' || updates.EXUpdatesURL !== exp.updates?.url) {
      throw new Error('Installed bundled update configuration does not match the isolated CI variant')
    }
    const ats = info.NSAppTransportSecurity
    if (ats?.NSAllowsLocalNetworking !== true || ats?.NSAllowsArbitraryLoads !== false) throw new Error('Installed app must retain local-only ATS configuration')
    for (const file of ['main.jsbundle', 'EXUpdates.bundle/app.manifest']) {
      if (!statSync(join(app, file)).isFile() || statSync(join(app, file)).size === 0) throw new Error(`Installed embedded resource is empty: ${file}`)
    }
    const manifest = JSON.parse(readFileSync(join(app, 'EXUpdates.bundle/app.manifest'), 'utf8'))
    if (typeof manifest.id !== 'string' || !Array.isArray(manifest.assets)) throw new Error('Installed embedded manifest is invalid')
  }
  const updatesRoot = resolve(require.resolve('expo-updates/package.json'), '..')
  const result = JSON.parse(execFileSync(process.execPath, [join(updatesRoot, 'bin/cli.js'), 'runtimeversion:resolve', '--platform', 'ios'], options))
  const runtimeVersion = result.runtimeVersion
  if (typeof runtimeVersion !== 'string' || !/^[0-9a-f]{40}$/.test(runtimeVersion)) throw new Error('Resolved runtime fingerprint is invalid')
  if (runtimeVersion !== installedRuntime) throw new Error('Current project fingerprint does not match the installed app; rebuild before flows start')
  appendFileSync(outputFile, `runtimeVersion=${runtimeVersion}\n`)
  console.log('Verified current project fingerprint matches the installed iOS client and required artifacts')
} catch (error) {
  console.error(`ERROR: Maestro runtime preparation failed: ${error.message}`)
  process.exitCode = 1
}
