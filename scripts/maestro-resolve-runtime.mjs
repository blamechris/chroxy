// Resolve once before the immutable CI Metro session, retaining the exact
// fingerprint policy used to build the installed iOS development client.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'

try {
  const projectRoot = resolve(process.argv[2] || 'packages/app')
  const device = process.env.DEVICE || ''
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(device)) {
    throw new Error('DEVICE must identify the selected iOS simulator')
  }
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile || !isAbsolute(outputFile)) throw new Error('GITHUB_OUTPUT must be an absolute path')
  const env = { ...process.env }
  delete env.CHROXY_MAESTRO_RUNTIME_CACHE
  delete env.CHROXY_MAESTRO_RUNTIME_VERSION
  const options = { cwd: projectRoot, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
  const installedPath = execFileSync('xcrun', ['simctl', 'get_app_container', device, 'com.blamechris.chroxy', 'app'], options).trim()
  if (!isAbsolute(installedPath)) throw new Error('simctl did not return an absolute installed app path')
  const app = realpathSync(installedPath)
  const sentinel = execFileSync('plutil', ['-extract', 'EXUpdatesRuntimeVersion', 'raw', '-o', '-', join(app, 'Expo.plist')], options).trim()
  if (sentinel !== 'file:fingerprint') throw new Error('Installed app must use the fingerprint runtime policy')
  const installedRuntime = readFileSync(join(app, 'EXUpdates.bundle/fingerprint'), 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(installedRuntime)) throw new Error('Installed runtime fingerprint is invalid')
  const require = createRequire(join(projectRoot, 'package.json'))
  const updatesRoot = resolve(require.resolve('expo-updates/package.json'), '..')
  const result = JSON.parse(execFileSync(process.execPath, [join(updatesRoot, 'bin/cli.js'), 'runtimeversion:resolve', '--platform', 'ios'], options))
  const runtimeVersion = result.runtimeVersion
  if (typeof runtimeVersion !== 'string' || !/^[0-9a-f]{40}$/.test(runtimeVersion)) throw new Error('Resolved runtime fingerprint is invalid')
  if (runtimeVersion !== installedRuntime) throw new Error('Current project fingerprint does not match the installed app; rebuild before Metro starts')
  appendFileSync(outputFile, `runtimeVersion=${runtimeVersion}\n`)
  console.log('Verified current project fingerprint matches the installed iOS client')
} catch (error) {
  console.error(`ERROR: Maestro runtime preparation failed: ${error.message}`)
  process.exitCode = 1
}
