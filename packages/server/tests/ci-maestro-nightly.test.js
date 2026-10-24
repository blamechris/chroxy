import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '../../..')
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/maestro-nightly.yml'), 'utf8'))
const preflight = join(root, 'scripts/maestro-hosted-preflight.sh')
const device = '0AD31F77-82DF-4E28-99E6-CAE0A8BB5E54'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-preflight-'))
  const developerDir = join(dir, 'Xcode_16.4.app/Contents/Developer')
  const bin = join(dir, 'bin')
  mkdirSync(join(developerDir, 'Applications/Simulator.app'), { recursive: true })
  mkdirSync(bin)
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  command('xcodebuild', 'echo "Xcode 16.4"; echo "Build version 16F6"')
  command('osascript', 'echo "${SIMULATOR_ID:-com.apple.iphonesimulator}"')
  command('xcrun', 'if [ "$*" = "simctl list devices available -j" ]; then cat "$FAKE_DEVICES"; else echo "$*" >> "$FAKE_TRACE"; fi')
  const devicesFile = join(dir, 'devices.json')
  writeFileSync(devicesFile, JSON.stringify({
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
      { name: 'iPhone 16 Pro', isAvailable: true, udid: device }
    ] }
  }))
  const envFile = join(dir, 'github-env')
  const traceFile = join(dir, 'trace')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVELOPER_DIR: developerDir,
    GITHUB_ENV: envFile, FAKE_DEVICES: devicesFile, FAKE_TRACE: traceFile }
  const run = (overrides = {}) => spawnSync('bash', [preflight], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000
  })
  return { dir, developerDir, devicesFile, envFile, traceFile, run }
}

describe('Maestro nightly hosted runner (#7113)', () => {
  it('wires the scheduled and dispatch suite to a pinned, preflighted hosted image', () => {
    assert.ok(workflow.on.schedule?.length > 0, 'nightly schedule must exist')
    assert.ok(workflow.on.workflow_dispatch !== undefined, 'manual proof run must remain available')
    assert.equal(workflow.jobs.maestro['runs-on'], 'macos-15')
    assert.equal(workflow.env.DEVELOPER_DIR, '/Applications/Xcode_16.4.app/Contents/Developer')
    const steps = workflow.jobs.maestro.steps
    const index = name => steps.findIndex(step => step.name === name)
    const preflightStep = steps[index('Preflight Xcode and boot simulator')]
    assert.equal(preflightStep?.run, 'bash scripts/maestro-hosted-preflight.sh')
    assert.ok(index('Preflight Xcode and boot simulator') < index('Install dependencies'))
    assert.ok(index('Install dependencies') < index('Build + install the dev client'))
    assert.ok(index('Build + install the dev client') < index('Run Maestro suite'))
    assert.ok(steps[index('Run Maestro suite')].run.includes('run-all-sequential.sh'))
  })

  it('exports the exact iOS 18.5 simulator and boots it before a build', () => {
    const f = fixture()
    try {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(f.envFile, 'utf8'), `DEVICE=${device}\n`)
      assert.equal(readFileSync(f.traceFile, 'utf8'), `simctl boot ${device}\nsimctl bootstatus ${device} -b\n`)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  it('fails before boot when Simulator.app or Expo LaunchServices lookup is missing', () => {
    const f = fixture()
    try {
      rmSync(join(f.developerDir, 'Applications/Simulator.app'), { recursive: true })
      const missingApp = f.run()
      assert.notEqual(missingApp.status, 0)
      assert.ok(missingApp.stderr.includes('Simulator.app is missing'))
      mkdirSync(join(f.developerDir, 'Applications/Simulator.app'))
      const missingLookup = f.run({ SIMULATOR_ID: 'com.apple.devicehub' })
      assert.notEqual(missingLookup.status, 0)
      assert.ok(missingLookup.stderr.includes('Expo cannot resolve Simulator.app'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  it('fails when the selected iOS runtime has no available iPhone 16 Pro', () => {
    const f = fixture()
    try {
      writeFileSync(f.devicesFile, JSON.stringify({ devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16 Pro', isAvailable: false, udid: device }]
      } }))
      const result = f.run()
      assert.notEqual(result.status, 0)
      assert.ok(result.stderr.includes('No available iPhone 16 Pro with iOS 18.5'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
})
