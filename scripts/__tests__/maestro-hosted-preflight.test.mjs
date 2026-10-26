import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const script = resolve('scripts/maestro-hosted-preflight.sh')

function runPreflight({ version = 'Xcode 26.2', simulator = true, simulatorId = 'com.apple.iphonesimulator', runtime = '26-2', available = true, name = 'iPhone 16 Pro' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-preflight-'))
  try {
    const bin = join(dir, 'bin')
    const developerDir = join(dir, 'Xcode.app/Contents/Developer')
    mkdirSync(bin)
    mkdirSync(join(developerDir, 'Applications'), { recursive: true })
    if (simulator) mkdirSync(join(developerDir, 'Applications/Simulator.app'))
    const envFile = join(dir, 'github-env')
    const calls = join(dir, 'calls')
    writeFileSync(envFile, '')
    writeFileSync(calls, '')
    const devices = { devices: { [`com.apple.CoreSimulator.SimRuntime.iOS-${runtime}`]: [{ name, isAvailable: available, udid: 'test-device' }] } }
    const devicesFile = join(dir, 'devices.json')
    writeFileSync(devicesFile, JSON.stringify(devices))
    for (const [name, body] of Object.entries({
      xcodebuild: 'printf "%s\nBuild version test\n" "$TEST_XCODE_VERSION"',
      osascript: 'printf "%s\n" "$TEST_SIMULATOR_ID"',
      xcrun: 'if [ "$*" = "simctl list devices available -j" ]; then cat "$TEST_DEVICES"; else printf "%s\n" "$*" >> "$TEST_CALLS"; fi',
    })) writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    const result = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVELOPER_DIR: developerDir, GITHUB_ENV: envFile,
        TEST_XCODE_VERSION: version, TEST_SIMULATOR_ID: simulatorId, TEST_DEVICES: devicesFile, TEST_CALLS: calls },
    })
    assert.equal(result.error, undefined, 'preflight must finish without crashing or hanging')
    return { status: result.status, output: result.stdout + result.stderr, env: readFileSync(envFile, 'utf8'), calls: readFileSync(calls, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('boots the selected available iPhone on the SDK 55 hosted toolchain', () => {
  const result = runPreflight()
  assert.equal(result.status, 0, result.output)
  assert.equal(result.env, 'DEVICE=test-device\n')
  assert.equal(result.calls, 'simctl boot test-device\nsimctl bootstatus test-device -b\n')
})

for (const [label, options, message] of [
  ['missing Simulator.app', { simulator: false }, 'Simulator.app is missing'],
  ['old Xcode', { version: 'Xcode 16.4' }, 'Expected Xcode 26.2'],
  ['wrong LaunchServices app', { simulatorId: 'wrong.app' }, 'cannot resolve Simulator.app'],
  ['old runtime', { runtime: '18-5' }, 'No available iPhone 16 Pro with iOS 26.2'],
  ['unavailable device', { available: false }, 'No available iPhone 16 Pro with iOS 26.2'],
  ['wrong device model', { name: 'iPhone 15' }, 'No available iPhone 16 Pro with iOS 26.2'],
]) {
  test(`rejects ${label} before exporting or booting a device`, () => {
    const result = runPreflight(options)
    assert.equal(result.status, 1, result.output)
    assert.ok(result.output.includes(message), result.output)
    assert.equal(result.env, '')
    assert.equal(result.calls, '')
  })
}
