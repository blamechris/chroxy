import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { addServerOptions, loadAndMergeConfig } from '../src/cli/shared.js'

/**
 * #5144 — `--environment-backend` CLI flag wiring on `chroxy start` / `dev`.
 *
 * The flag selects the environment backend (docker | k8s | rancher) and must
 * compose with — not clobber — a file-configured `environments` block
 * (k8s/rancher sub-blocks normally live in config.json).
 */
describe('--environment-backend flag (#5144)', () => {
  function makeServerCmd() {
    const program = new Command()
    program.exitOverride()
    const cmd = program.command('start').helpOption(false).action(() => {})
    addServerOptions(cmd)
    return { program, cmd }
  }

  it('registers --environment-backend as a recognised option', () => {
    const { cmd } = makeServerCmd()
    const optNames = cmd.options.map((o) => o.long)
    assert.ok(optNames.includes('--environment-backend'), `got: ${optNames.join(', ')}`)
  })

  it('help text names docker/k8s/rancher', () => {
    const { cmd } = makeServerCmd()
    const opt = cmd.options.find((o) => o.long === '--environment-backend')
    assert.ok(opt)
    assert.match(opt.description, /docker/)
    assert.match(opt.description, /k8s/)
    assert.match(opt.description, /rancher/)
  })

  it('parses to options.environmentBackend (camelCased)', () => {
    const { program } = makeServerCmd()
    program.parse(['node', 'chroxy', 'start', '--environment-backend', 'rancher'])
    const opts = program.commands.find((c) => c.name() === 'start').opts()
    assert.equal(opts.environmentBackend, 'rancher')
  })

  it('absent flag leaves options.environmentBackend undefined (config-file precedence preserved)', () => {
    const { program } = makeServerCmd()
    program.parse(['node', 'chroxy', 'start'])
    const opts = program.commands.find((c) => c.name() === 'start').opts()
    assert.equal(opts.environmentBackend, undefined)
  })
})

describe('loadAndMergeConfig environments composition (#5144)', () => {
  let tempDir
  let configPath

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-env-backend-'))
    configPath = join(tempDir, 'config.json')
  })
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

  function writeConfig(obj) {
    writeFileSync(configPath, JSON.stringify(obj))
  }

  it('--environment-backend overrides the file value but keeps file sub-blocks', () => {
    writeConfig({
      apiToken: 'tok',
      environments: {
        enabled: true,
        backend: 'docker',
        k8s: { namespace: 'chroxy' },
        rancher: { rancherUrl: 'https://rancher.example.com', clusterId: 'c-m-a', token: 't' },
      },
    })
    const config = loadAndMergeConfig({ config: configPath, environmentBackend: 'rancher' })
    assert.equal(config.environments.backend, 'rancher')
    // File sub-blocks survive the CLI override.
    assert.equal(config.environments.k8s.namespace, 'chroxy')
    assert.equal(config.environments.rancher.clusterId, 'c-m-a')
    // `enabled` survives too.
    assert.equal(config.environments.enabled, true)
  })

  it('--environments alone preserves a file-configured k8s block', () => {
    writeConfig({
      apiToken: 'tok',
      environments: { k8s: { workspace: { claimName: 'pvc' } } },
    })
    const config = loadAndMergeConfig({ config: configPath, environments: true })
    assert.equal(config.environments.enabled, true)
    assert.equal(config.environments.k8s.workspace.claimName, 'pvc')
  })

  it('file backend value is used when no CLI flag is given', () => {
    writeConfig({ apiToken: 'tok', environments: { enabled: true, backend: 'k8s' } })
    const config = loadAndMergeConfig({ config: configPath })
    assert.equal(config.environments.backend, 'k8s')
  })

  it('default path (no environments block at all) is unchanged', () => {
    writeConfig({ apiToken: 'tok' })
    const config = loadAndMergeConfig({ config: configPath })
    assert.equal(config.environments, undefined)
  })
})
