import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '../../..')
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/maestro-nightly.yml'), 'utf8'))
const preflight = join(root, 'scripts/maestro-hosted-preflight.sh')
const device = '0AD31F77-82DF-4E28-99E6-CAE0A8BB5E54'
const shellIt = process.platform === 'win32' ? it.skip : it

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-preflight-'))
  const developerDir = join(dir, 'Xcode_16.4.app/Contents/Developer')
  const bin = join(dir, 'bin')
  mkdirSync(join(developerDir, 'Applications/Simulator.app'), { recursive: true })
  mkdirSync(bin)
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  // The pause makes an early-closing `head -1` deterministic: xcodebuild writes
  // more output only after head has exited. The real hosted run died this way.
  command('xcodebuild', 'set -e; printf "Xcode %s\\n" "${XCODE_VERSION:-16.4}"; sleep 0.05; for i in $(seq 1 128); do printf "Build detail %s\\n" "$i"; done')
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
  return { dir, developerDir, devicesFile, envFile, traceFile, env, run }
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

  shellIt('captures all xcodebuild output before parsing its first line', () => {
    const f = fixture()
    try {
      const oldPipeline = spawnSync('bash', ['-c', 'set -o pipefail; xcodebuild -version | head -1'], {
        env: f.env, encoding: 'utf8', timeout: 5000
      })
      assert.notEqual(oldPipeline.status, 0, 'fixture must reproduce the early-close failure')
      assert.equal(oldPipeline.stdout, 'Xcode 16.4\n')
      const repaired = f.run()
      assert.equal(repaired.status, 0, repaired.stderr)
      assert.ok(repaired.stdout.includes('Using Xcode 16.4 and iPhone 16 Pro'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('exports the exact iOS 18.5 simulator and boots it before a build', () => {
    const f = fixture()
    try {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(f.envFile, 'utf8'), `DEVICE=${device}\n`)
      assert.equal(readFileSync(f.traceFile, 'utf8'), `simctl boot ${device}\nsimctl bootstatus ${device} -b\n`)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('rejects a different Xcode version before selecting a simulator', () => {
    const f = fixture()
    try {
      const result = f.run({ XCODE_VERSION: '27.0' })
      assert.equal(result.status, 1, result.stderr)
      assert.ok(result.stderr.includes('Expected Xcode 16.4, found Xcode 27.0'))
      assert.equal(existsSync(f.envFile), false, 'must not export a simulator on mismatch')
      assert.equal(existsSync(f.traceFile), false, 'must not call simctl on mismatch')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('fails before boot when Simulator.app or Expo LaunchServices lookup is missing', () => {
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

  shellIt('fails when the selected iOS runtime has no available iPhone 16 Pro', () => {
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
