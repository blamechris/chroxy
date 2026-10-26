import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '../../..')
const script = join(root, 'scripts/maestro-resolve-runtime.mjs')
const configSource = join(root, 'packages/app/app.config.js')
const device = '00000000-0000-4000-8000-000000000001'
const fingerprint = 'a'.repeat(40)
const shellIt = process.platform === 'win32' ? it.skip : it
const appRequire = createRequire(join(root, 'packages/app/package.json'))
const expoConfig = appRequire.resolve('expo/config')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-runtime-'))
  const project = join(dir, 'project')
  const app = join(dir, 'installed app/Chroxy.app')
  const bin = join(dir, 'bin')
  const updates = join(project, 'node_modules/expo-updates')
  mkdirSync(join(app, 'EXUpdates.bundle'), { recursive: true })
  mkdirSync(join(updates, 'bin'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(project, 'package.json'), '{"name":"runtime-fixture","version":"1.0.0"}')
  writeFileSync(join(updates, 'package.json'), '{"name":"expo-updates","version":"55.0.33"}')
  writeFileSync(join(updates, 'bin/cli.js'), `
if (process.env.CHROXY_MAESTRO_RUNTIME_CACHE !== undefined || process.env.CHROXY_MAESTRO_RUNTIME_VERSION !== undefined) throw new Error('cache leaked into real resolution')
if (process.argv.slice(2).join(' ') !== 'runtimeversion:resolve --platform ios') throw new Error('wrong resolver command')
if (process.env.FAKE_RESOLVER_FAIL === '1') process.exit(23)
console.log(JSON.stringify({ runtimeVersion: process.env.FAKE_RESOLVED_RUNTIME }))
`)
  writeFileSync(join(app, 'EXUpdates.bundle/fingerprint'), fingerprint + '\n')
  writeFileSync(join(app, 'Expo.plist'), 'fixture plist')
  for (const [name, body] of Object.entries({
    xcrun: 'printf "%s\\n" "$FAKE_INSTALLED_APP"',
    plutil: 'printf "%s\\n" "$FAKE_SENTINEL"'
  })) writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  const output = join(dir, 'output')
  writeFileSync(output, 'existing=kept\n')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVICE: device, GITHUB_OUTPUT: output,
    FAKE_INSTALLED_APP: app, FAKE_SENTINEL: 'file:fingerprint', FAKE_RESOLVED_RUNTIME: fingerprint }
  const run = (overrides = {}) => spawnSync(process.execPath, [script, project], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000
  })
  return { dir, app, project, output, run }
}

function configFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-config-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"config-fixture","version":"1.0.0"}')
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { name: 'Fixture', slug: 'fixture', version: '0.11.7',
    runtimeVersion: { policy: 'fingerprint' }, ios: { bundleIdentifier: 'com.example.fixture' } } }))
  copyFileSync(configSource, join(dir, 'app.config.js'))
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const run = (overrides = {}) => {
    const env = { ...process.env }
    delete env.CHROXY_MAESTRO_RUNTIME_CACHE
    delete env.CHROXY_MAESTRO_RUNTIME_VERSION
    delete env.CI
    return spawnSync(process.execPath, ['-e', `
const { getConfig } = require(${JSON.stringify(expoConfig)})
const exp = getConfig(process.argv[1]).exp
console.log(JSON.stringify({ runtimeVersion: exp.runtimeVersion, iosRuntimeVersion: exp.ios.runtimeVersion, version: exp.version }))
`, dir], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 })
  }
  return { dir, run }
}

describe('Maestro installed runtime preparation', () => {
  shellIt('publishes only the matching installed fingerprint and strips reuse env before resolution', () => {
    const f = fixture()
    try {
      const result = f.run({ CHROXY_MAESTRO_RUNTIME_CACHE: '1', CHROXY_MAESTRO_RUNTIME_VERSION: 'stale' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.signal, null)
      assert.equal(readFileSync(f.output, 'utf8'), `existing=kept\nruntimeVersion=${fingerprint}\n`)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  for (const [label, overrides, installed] of [
    ['different current fingerprint', { FAKE_RESOLVED_RUNTIME: 'b'.repeat(40) }],
    ['invalid current fingerprint', { FAKE_RESOLVED_RUNTIME: 'not-a-fingerprint' }],
    ['wrong installed runtime policy', { FAKE_SENTINEL: '0.11.7' }],
    ['resolver failure', { FAKE_RESOLVER_FAIL: '1' }],
    ['missing selected simulator', { DEVICE: '' }],
    ['invalid installed fingerprint', {}, 'not-a-fingerprint'],
    ['missing installed fingerprint', {}, null]
  ]) {
    shellIt(`fails before publishing output for ${label}`, () => {
      const f = fixture()
      try {
        if (installed === null) rmSync(join(f.app, 'EXUpdates.bundle/fingerprint'))
        if (installed) writeFileSync(join(f.app, 'EXUpdates.bundle/fingerprint'), installed)
        const result = f.run(overrides)
        assert.equal(result.signal, null, 'invalid input must fail promptly')
        assert.equal(result.status, 1, result.stderr)
        assert.ok(result.stderr.includes('Maestro runtime preparation failed'))
        assert.equal(readFileSync(f.output, 'utf8'), 'existing=kept\n')
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })
  }
})

describe('Maestro runtime config through the real Expo loader', () => {
  it('retains production fingerprint and product version by default, including ordinary CI', () => {
    const f = configFixture()
    try {
      for (const env of [{}, { CI: 'true' }]) {
        const result = f.run(env)
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(JSON.parse(result.stdout), { runtimeVersion: { policy: 'fingerprint' }, version: '0.11.7' })
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  it('reuses the verified iOS hash only under explicit CI activation', () => {
    const f = configFixture()
    try {
      const result = f.run({ CI: 'true', CHROXY_MAESTRO_RUNTIME_CACHE: '1', CHROXY_MAESTRO_RUNTIME_VERSION: fingerprint })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { runtimeVersion: { policy: 'fingerprint' }, iosRuntimeVersion: fingerprint, version: '0.11.7' })
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  for (const [label, env] of [
    ['outside CI', { CHROXY_MAESTRO_RUNTIME_CACHE: '1', CHROXY_MAESTRO_RUNTIME_VERSION: fingerprint }],
    ['missing marker', { CI: 'true', CHROXY_MAESTRO_RUNTIME_VERSION: fingerprint }],
    ['missing fingerprint', { CI: 'true', CHROXY_MAESTRO_RUNTIME_CACHE: '1' }],
    ['malformed fingerprint', { CI: 'true', CHROXY_MAESTRO_RUNTIME_CACHE: '1', CHROXY_MAESTRO_RUNTIME_VERSION: 'invalid' }]
  ]) {
    it(`refuses reuse ${label}`, () => {
      const f = configFixture()
      try {
        const result = f.run(env)
        assert.equal(result.signal, null)
        assert.equal(result.status, 1)
        assert.ok(result.stderr.includes('Maestro runtime reuse requires'))
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })
  }
})


shellIt('requires both runtime step inputs before the actual workflow can launch Metro', () => {
  const workflow = yaml.load(readFileSync(join(root, '.github/workflows/maestro-nightly.yml'), 'utf8'))
  const steps = workflow.jobs.maestro.steps
  const producer = steps.find(step => step.name === 'Verify installed iOS runtime')
  const startup = steps.find(step => step.name === 'Start Metro (background)')
  assert.ok(producer?.id, 'the verified runtime must have a step output identity')
  assert.ok(steps.indexOf(producer) < steps.indexOf(startup))
  assert.equal(workflow.env.CHROXY_MAESTRO_RUNTIME_CACHE, undefined)
  assert.equal(workflow.env.CHROXY_MAESTRO_RUNTIME_VERSION, undefined)
  const f = configFixture()
  try {
    const bin = join(f.dir, 'bin')
    mkdirSync(bin)
    const launched = join(f.dir, 'launched')
    const resultFile = join(f.dir, 'launch-result')
    const probe = join(f.dir, 'metro-probe.cjs')
    writeFileSync(probe, `
const fs = require('node:fs')
fs.writeFileSync(process.env.FAKE_LAUNCHED, 'started')
const exp = require(${JSON.stringify(expoConfig)}).getConfig(process.cwd()).exp
fs.writeFileSync(process.env.FAKE_RESULT, JSON.stringify(exp.ios.runtimeVersion))
`)
    writeFileSync(join(bin, 'npx'), '#!/bin/bash\nexec "$FAKE_NODE" "$FAKE_PROBE"\n', { mode: 0o755 })
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    const resolveExpression = value => value.replace(/\$\{\{\s*steps\.([^.]+)\.outputs\.([^\s}]+)\s*\}\}/g, (_, id, key) => {
      assert.equal(id, producer.id)
      assert.equal(key, 'runtimeVersion')
      return fingerprint
    })
    const env = { ...process.env, CI: 'true', PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: f.dir, GITHUB_ENV: join(f.dir, 'github-env'),
      FAKE_NODE: process.execPath, FAKE_PROBE: probe, FAKE_LAUNCHED: launched, FAKE_RESULT: resultFile }
    for (const [key, value] of Object.entries(startup.env)) env[key] = resolveExpression(String(value))
    const positive = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', startup.run], { cwd: f.dir, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(positive.status, 0, positive.stderr)
    for (let i = 0; i < 100 && !readable(resultFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')), fingerprint, 'actual workflow env must reach the real Expo loader')
    rmSync(launched)
    rmSync(resultFile)
    for (const missing of [['CHROXY_MAESTRO_RUNTIME_CACHE'], ['CHROXY_MAESTRO_RUNTIME_VERSION'], ['CHROXY_MAESTRO_RUNTIME_CACHE', 'CHROXY_MAESTRO_RUNTIME_VERSION']]) {
      const broken = { ...env }
      for (const key of missing) delete broken[key]
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', startup.run], { cwd: f.dir, env: broken, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.signal, null)
      assert.equal(result.status, 1, result.stderr)
      assert.equal(readable(launched), false, 'incomplete verified runtime must stop before Metro launch')
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

function readable(path) {
  try { readFileSync(path); return true } catch { return false }
}
