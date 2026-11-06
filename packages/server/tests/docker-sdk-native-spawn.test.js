import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DockerSdkSession } from '../src/docker-sdk-session.js'
import { DockerBackend } from '../src/environments/backends/docker.js'

// #8027 — drive the REAL DockerSdkSession spawn callback (not a mirror of it)
// with the SDK's native spawn shape and assert the resulting docker exec argv.
describe('DockerSdkSession spawn callback, native SDK shape (#8027)', () => {
  function makeCallback(containerCliPath) {
    let lastSpawn = null
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    const session = new DockerSdkSession({
      cwd: '/tmp/work',
      containerId: 'ctr-native',
      containerCliPath,
      stateFilePath: join(mkdtempSync(join(tmpdir(), 'dsn-')), 'state.json'),
    })
    session._backend = new DockerBackend({
      _spawn: (cmd, args) => { lastSpawn = { cmd, args }; return child },
    })
    return { callback: session._createSpawnCallback(), getLastSpawn: () => lastSpawn, session }
  }

  it('runs the container claude, keeping all args, for an absolute host binary path', () => {
    const cli = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    const { callback, getLastSpawn, session } = makeCallback(cli)
    const hostBin = '/Users/me/.local/bin/claude'
    callback({
      command: hostBin,
      args: ['--output-format', 'stream-json', '--input-format', 'stream-json'],
      cwd: '/tmp/work',
      env: {},
    })
    const { cmd, args } = getLastSpawn()
    assert.equal(cmd, 'docker')
    assert.deepEqual(args.slice(args.indexOf('ctr-native')), [
      'ctr-native', 'node', cli, '--output-format', 'stream-json', '--input-format', 'stream-json',
    ])
    assert.ok(!args.includes(hostBin))
    session.removeAllListeners()
  })

  it('treats the pinned pathToClaudeCodeExecutable as claude whatever its basename', () => {
    const cli = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    const { getLastSpawn, session } = makeCallback(cli)
    const pinned = '/Users/me/.local/share/claude/versions/2.1.7'
    const options = { pathToClaudeCodeExecutable: pinned }
    session._augmentQueryOptions(options)
    options.spawnClaudeCodeProcess({ command: pinned, args: ['-p'], cwd: '/tmp/work', env: {} })
    const { args } = getLastSpawn()
    assert.deepEqual(args.slice(args.indexOf('ctr-native')), ['ctr-native', 'node', cli, '-p'])
    assert.ok(!args.includes(pinned))
    session.removeAllListeners()
  })

  it('still handles the old JS shape', () => {
    const cli = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    const { callback, getLastSpawn, session } = makeCallback(cli)
    callback({
      command: 'node',
      args: ['/Users/me/node_modules/@anthropic-ai/claude-code/cli.js', '-p'],
      cwd: '/tmp/work',
      env: {},
    })
    const { args } = getLastSpawn()
    assert.deepEqual(args.slice(args.indexOf('ctr-native')), ['ctr-native', 'node', cli, '-p'])
    session.removeAllListeners()
  })

  it('pins the claude config directory to the .claude under the container HOME', () => {
    const { callback, getLastSpawn, session } = makeCallback('/usr/local/bin/claude')
    callback({ command: 'node', args: ['/x/@anthropic-ai/claude-code/cli.js', '-p'], cwd: '/tmp/work', env: { CLAUDE_CONFIG_DIR: '/workspace/claude-data' } })
    const { args } = getLastSpawn()
    const envPairs = args.flatMap((a, k) => (a === '--env' ? [args[k + 1]] : []))
    assert.ok(envPairs.includes('CLAUDE_CONFIG_DIR=/home/chroxy/.claude'), 'config dir is the .claude under HOME')
    assert.ok(!envPairs.includes('CLAUDE_CONFIG_DIR=/workspace/claude-data'), 'a caller value is not forwarded')
    session.removeAllListeners()
  })
})
