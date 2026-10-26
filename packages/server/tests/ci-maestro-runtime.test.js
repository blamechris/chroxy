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
const baselineConfig = { name: 'Fixture', slug: 'fixture', version: '0.11.7', runtimeVersion: { policy: 'fingerprint' },
  ios: { bundleIdentifier: 'com.blamechris.chroxy' }, updates: { enabled: true, url: 'https://example.invalid/updates' } }

function cleanEnv() {
  const env = { ...process.env }
  for (const key of ['CHROXY_MAESTRO_BUILD_MODE', 'CHROXY_MAESTRO_RUNTIME_CACHE', 'CHROXY_MAESTRO_RUNTIME_VERSION', 'CI']) delete env[key]
  return env
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-runtime-'))
  const project = join(dir, 'project')
  const app = join(dir, 'installed app/Chroxy.app')
  const bin = join(dir, 'bin')
  const updates = join(project, 'node_modules/expo-updates')
  mkdirSync(join(app, 'EXUpdates.bundle'), { recursive: true })
  mkdirSync(join(updates, 'bin'), { recursive: true })
  mkdirSync(bin)
  symlinkSync(appRequire.resolve('expo/package.json').replace(/[/\\]package\.json$/, ''), join(project, 'node_modules/expo'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(project, 'package.json'), '{"name":"runtime-fixture","version":"1.0.0"}')
  writeFileSync(join(project, 'app.json'), JSON.stringify({ expo: baselineConfig }))
  copyFileSync(configSource, join(project, 'app.config.js'))
  writeFileSync(join(updates, 'package.json'), '{"name":"expo-updates","version":"55.0.33"}')
  writeFileSync(join(updates, 'bin/cli.js'), `
if (process.argv.slice(2).join(' ') !== 'runtimeversion:resolve --platform ios') throw new Error('wrong resolver command')
if (process.env.CHROXY_MAESTRO_BUILD_MODE !== 'bundled' || process.env.CI !== 'true') throw new Error('variant lost during resolution')
if (process.env.FAKE_RESOLVER_FAIL === '1') process.exit(23)
console.log(JSON.stringify({ runtimeVersion: process.env.FAKE_RESOLVED_RUNTIME }))
`)
  const info = { CFBundleIdentifier: 'com.blamechris.chroxy', NSAppTransportSecurity: { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: false } }
  const nativeUpdates = { EXUpdatesRuntimeVersion: 'file:fingerprint', EXUpdatesEnabled: true,
    EXUpdatesCheckOnLaunch: 'NEVER', EXUpdatesURL: baselineConfig.updates.url }
  writeFileSync(join(app, 'Info.plist'), JSON.stringify(info))
  writeFileSync(join(app, 'Expo.plist'), JSON.stringify(nativeUpdates))
  writeFileSync(join(app, 'EXUpdates.bundle/fingerprint'), fingerprint + '\n')
  writeFileSync(join(app, 'main.jsbundle'), 'nonempty embedded bundle')
  writeFileSync(join(app, 'EXUpdates.bundle/app.manifest'), JSON.stringify({ id: 'fixture-update', assets: [] }))
  writeFileSync(join(bin, 'xcrun'), '#!/bin/bash\nprintf "%s\\n" "$FAKE_INSTALLED_APP"\n', { mode: 0o755 })
  writeFileSync(join(bin, 'plutil'), '#!/bin/bash\ncat "${@: -1}"\n', { mode: 0o755 })
  const output = join(dir, 'output')
  writeFileSync(output, 'existing=kept\n')
  const env = { ...cleanEnv(), CI: 'true', CHROXY_MAESTRO_BUILD_MODE: 'bundled', PATH: `${bin}:${process.env.PATH}`,
    DEVICE: device, GITHUB_OUTPUT: output, FAKE_INSTALLED_APP: app, FAKE_RESOLVED_RUNTIME: fingerprint }
  const run = (overrides = {}) => spawnSync(process.execPath, [script, project], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000
  })
  return { dir, app, project, output, info, nativeUpdates, run }
}

function configFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-config-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"config-fixture","version":"1.0.0"}')
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: baselineConfig }))
  copyFileSync(configSource, join(dir, 'app.config.js'))
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const run = (overrides = {}) => spawnSync(process.execPath, ['-e', `
console.log(JSON.stringify(require(${JSON.stringify(expoConfig)}).getConfig(process.cwd()).exp))
`], { cwd: dir, env: { ...cleanEnv(), ...overrides }, encoding: 'utf8', timeout: 10000 })
  return { dir, run }
}

function changeJson(path, mutate) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  mutate(data)
  writeFileSync(path, JSON.stringify(data))
}

describe('Maestro bundled installed artifact verification', () => {
  shellIt('publishes only the matching installed fingerprint after verifying actual embedded resources', () => {
    const f = fixture()
    try {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.signal, null)
      assert.equal(readFileSync(f.output, 'utf8'), `existing=kept\nruntimeVersion=${fingerprint}\n`)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  for (const [label, mutate, env] of [
    ['different current fingerprint', () => {}, { FAKE_RESOLVED_RUNTIME: 'b'.repeat(40) }],
    ['malformed current fingerprint', () => {}, { FAKE_RESOLVED_RUNTIME: 'invalid' }],
    ['resolver failure', () => {}, { FAKE_RESOLVER_FAIL: '1' }],
    ['missing device', () => {}, { DEVICE: '' }],
    ['invalid build mode', () => {}, { CHROXY_MAESTRO_BUILD_MODE: 'debug' }],
    ['outside CI', () => {}, { CI: '' }],
    ['retired mixed runtime mode', () => {}, { CHROXY_MAESTRO_RUNTIME_CACHE: '1' }],
    ['missing embedded bundle', f => rmSync(join(f.app, 'main.jsbundle'))],
    ['empty embedded bundle', f => writeFileSync(join(f.app, 'main.jsbundle'), '')],
    ['missing embedded manifest', f => rmSync(join(f.app, 'EXUpdates.bundle/app.manifest'))],
    ['malformed embedded manifest', f => writeFileSync(join(f.app, 'EXUpdates.bundle/app.manifest'), '{}')],
    ['malformed installed fingerprint', f => writeFileSync(join(f.app, 'EXUpdates.bundle/fingerprint'), 'invalid')],
    ['wrong identity', f => changeJson(join(f.app, 'Info.plist'), x => { x.CFBundleIdentifier = 'com.example.other' })],
    ['non-fingerprint native policy', f => changeJson(join(f.app, 'Expo.plist'), x => { x.EXUpdatesRuntimeVersion = '0.11.7' })],
    ['enabled automatic updates', f => changeJson(join(f.app, 'Expo.plist'), x => { x.EXUpdatesCheckOnLaunch = 'ALWAYS' })],
    ['disabled native updates', f => changeJson(join(f.app, 'Expo.plist'), x => { x.EXUpdatesEnabled = false })],
    ['mismatched native update URL', f => changeJson(join(f.app, 'Expo.plist'), x => { x.EXUpdatesURL = 'https://example.invalid/other' })],
    ['broadened ATS', f => changeJson(join(f.app, 'Info.plist'), x => { x.NSAppTransportSecurity.NSAllowsArbitraryLoads = true })],
    ['missing local ATS', f => changeJson(join(f.app, 'Info.plist'), x => { x.NSAppTransportSecurity.NSAllowsLocalNetworking = false })],
    ['current explicit runtime', f => changeJson(join(f.project, 'app.json'), x => { x.expo.runtimeVersion = fingerprint })],
    ['current disabled updates', f => changeJson(join(f.project, 'app.json'), x => { x.expo.updates.enabled = false })],
    ['current missing update URL', f => changeJson(join(f.project, 'app.json'), x => { delete x.expo.updates.url })]
  ]) {
    shellIt(`fails before publishing output for ${label}`, () => {
      const f = fixture()
      try {
        mutate(f)
        const result = f.run(env)
        assert.equal(result.signal, null, 'must fail legibly before the outer deadline')
        assert.equal(result.status, 1, result.stderr)
        assert.ok(result.stderr.includes('Maestro runtime preparation failed'))
        assert.equal(readFileSync(f.output, 'utf8'), 'existing=kept\n')
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })
  }
})

describe('Bundled CI config through the real Expo loader', () => {
  it('keeps ordinary production and EAS config exactly equal, including ordinary CI', () => {
    const f = configFixture()
    try {
      const ordinary = f.run()
      const ci = f.run({ CI: 'true' })
      assert.equal(ordinary.status, 0, ordinary.stderr)
      assert.equal(ci.status, 0, ci.stderr)
      const baseline = JSON.parse(ordinary.stdout)
      assert.deepEqual(JSON.parse(ci.stdout), baseline)
      assert.deepEqual(baseline.runtimeVersion, baselineConfig.runtimeVersion)
      assert.deepEqual(baseline.updates, baselineConfig.updates)
      const variant = f.run({ CI: 'true', CHROXY_MAESTRO_BUILD_MODE: 'bundled' })
      assert.equal(variant.status, 0, variant.stderr)
      assert.deepEqual(JSON.parse(variant.stdout), { ...baseline, updates: { ...baseline.updates, checkAutomatically: 'NEVER' } })
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  for (const [label, env] of [
    ['outside CI', { CHROXY_MAESTRO_BUILD_MODE: 'bundled' }],
    ['invalid mode', { CI: 'true', CHROXY_MAESTRO_BUILD_MODE: 'debug' }],
    ['empty mode', { CI: 'true', CHROXY_MAESTRO_BUILD_MODE: '' }],
    ['retired cache marker', { CHROXY_MAESTRO_RUNTIME_CACHE: '1' }],
    ['retired runtime string', { CHROXY_MAESTRO_RUNTIME_VERSION: fingerprint }],
    ['mixed old and bundled mode', { CI: 'true', CHROXY_MAESTRO_BUILD_MODE: 'bundled', CHROXY_MAESTRO_RUNTIME_CACHE: '1' }]
  ]) {
    it(`rejects ${label}`, () => {
      const f = configFixture()
      try {
        const result = f.run(env)
        assert.equal(result.signal, null)
        assert.equal(result.status, 1)
      } finally { rmSync(f.dir, { recursive: true, force: true }) }
    })
  }
})

shellIt('checks no-Metro absence fail closed instead of killing an unknown listener', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-no-metro-'))
  try {
    const command = join(dir, 'lsof')
    const run = body => {
      writeFileSync(command, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
      return spawnSync(process.execPath, [join(root, 'scripts/maestro-no-metro.mjs')], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000
      })
    }
    assert.equal(run('exit 1').status, 0)
    for (const body of ['echo listener; exit 0', 'echo unexpected; exit 1', 'echo permission-denied >&2; exit 1', 'exit 2']) {
      const result = run(body)
      assert.equal(result.status, 1)
      assert.ok(result.stderr.includes('Cannot establish'))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('applies the registered Android dev-menu default idempotently without changing other native preferences', async () => {
  const { withPlugins } = appRequire('expo/config-plugins')
  const appConfig = JSON.parse(readFileSync(join(root, 'packages/app/app.json'), 'utf8')).expo
  const plugins = appConfig.plugins.filter(plugin => typeof plugin === 'string' && plugin.startsWith('./plugins/'))
    .map(plugin => resolve(root, 'packages/app', plugin))
  assert.ok(plugins.length > 0, 'the native preference plugin must be registered')
  for (const existing of [undefined, [{ $: { 'android:name': 'EXDevMenuShowFloatingActionButton', 'android:value': 'true' } }]]) {
    const application = { $: { 'android:name': '.MainApplication' }, activity: [{ $: { 'android:name': '.MainActivity' } }],
      'meta-data': [...(existing || []), { $: { 'android:name': 'unrelated', 'android:value': 'kept' } }] }
    const base = { name: 'Fixture', slug: 'fixture', ios: appConfig.ios, runtimeVersion: appConfig.runtimeVersion,
      _internal: { projectRoot: join(root, 'packages/app') } }
    const configured = withPlugins(base, plugins)
    assert.deepEqual(configured.ios, appConfig.ios)
    assert.deepEqual(configured.runtimeVersion, { policy: 'fingerprint' })
    assert.equal(configured.mods.ios, undefined)
    let mod = { ...configured, modResults: { manifest: { application: [application] } },
      modRequest: { platform: 'android', modName: 'manifest', projectRoot: join(root, 'packages/app') } }
    for (let pass = 0; pass < 2; pass++) mod = await configured.mods.android.manifest(mod)
    const metadata = mod.modResults.manifest.application[0]['meta-data']
    assert.deepEqual(metadata.filter(item => item.$['android:name'] === 'EXDevMenuShowFloatingActionButton'),
      [{ $: { 'android:name': 'EXDevMenuShowFloatingActionButton', 'android:value': 'false' } }])
    assert.deepEqual(metadata.filter(item => item.$['android:name'] !== 'EXDevMenuShowFloatingActionButton'),
      [{ $: { 'android:name': 'unrelated', 'android:value': 'kept' } }])
    assert.deepEqual(application.activity, [{ $: { 'android:name': '.MainActivity' } }])
  }
})
