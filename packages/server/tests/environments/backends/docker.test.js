import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { DockerBackend } from '../../../src/environments/backends/docker.js'

/**
 * Creates a mock execFile that records calls and returns configured results.
 * Keyed by docker subcommand: 'run', 'exec', 'commit', 'rm', 'rmi', 'inspect', 'ps',
 * 'rename', 'compose'.
 */
function createMockExecFile({ results = {}, errors = {} } = {}) {
  const calls = []

  function mockExecFile(cmd, args, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    const subcommand = args[0]
    calls.push({ cmd, args: [...args], opts })

    const err = errors[subcommand]
    if (err) {
      callback(err, '', err.message)
      return
    }

    const result = results[subcommand] ?? ''
    callback(null, result, '')
  }

  mockExecFile.calls = calls
  return mockExecFile
}

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.createEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.createEnvironment()', () => {
  it('runs docker run with required security flags', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'abc123\n', exec: '/usr/local\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const result = await backend.createEnvironment({
      envId: 'env-test',
      cwd: '/home/user/project',
      image: 'node:22-slim',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    })

    assert.equal(result.containerId, 'abc123')
    assert.ok(result.containerCliPath.includes('cli.js'))

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    assert.ok(runCall, 'should have called docker run')
    assert.ok(runCall.args.includes('--cap-drop'))
    assert.ok(runCall.args.includes('ALL'))
    assert.ok(runCall.args.includes('--security-opt'))
    assert.ok(runCall.args.includes('no-new-privileges'))
    assert.ok(runCall.args.includes('--pids-limit'))
    assert.ok(runCall.args.includes('512'))
    assert.ok(runCall.args.includes('--memory'))
    assert.ok(runCall.args.includes('2g'))
    assert.ok(runCall.args.includes('--cpus'))
    assert.ok(runCall.args.includes('2'))
    assert.ok(runCall.args.includes('node:22-slim'))
  })

  it('names the container chroxy-env-{envId}', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'named-ctr\n', exec: '/usr/local\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.createEnvironment({
      envId: 'env-abc123',
      cwd: '/tmp',
      image: 'node:22-slim',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const nameIdx = runCall.args.indexOf('--name')
    assert.ok(nameIdx >= 0)
    assert.equal(runCall.args[nameIdx + 1], 'chroxy-env-env-abc123')
  })

  it('passes containerEnv and forwardPorts', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'env-ctr\n', exec: '/usr/local\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.createEnvironment({
      envId: 'env-ports',
      cwd: '/tmp',
      image: 'node:22-slim',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      containerEnv: { NODE_ENV: 'development', DEBUG: 'true' },
      forwardPorts: [3000, 5432],
    })

    const runCall = mockExec.calls.find(c => c.args[0] === 'run')
    const envPairs = []
    const portPairs = []
    for (let i = 0; i < runCall.args.length - 1; i++) {
      if (runCall.args[i] === '--env') envPairs.push(runCall.args[i + 1])
      if (runCall.args[i] === '-p') portPairs.push(runCall.args[i + 1])
    }
    assert.ok(envPairs.includes('NODE_ENV=development'))
    assert.ok(envPairs.includes('DEBUG=true'))
    assert.ok(portPairs.includes('3000:3000'))
    assert.ok(portPairs.includes('5432:5432'))
  })

  it('runs postCreateCommand inside the container', async () => {
    let postCreateCalled = false
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') { cb(null, 'post-ctr\n', ''); return }
      if (args[0] === 'exec' && args.includes('npm install')) {
        postCreateCalled = true
        cb(null, '', '')
        return
      }
      cb(null, '/usr/local\n', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    await backend.createEnvironment({
      envId: 'env-post',
      cwd: '/tmp',
      image: 'node:22-slim',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      postCreateCommand: 'npm install',
    })

    assert.ok(postCreateCalled, 'postCreateCommand should be run')
  })

  it('removes container and re-throws when setup fails after docker run', async () => {
    let rmCalled = false
    let execCallCount = 0
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') { cb(null, 'orphan-ctr\n', ''); return }
      if (args[0] === 'exec') {
        execCallCount++
        // First exec call is _setupContainer (bash -c "useradd ...") — fail it
        if (execCallCount === 1) {
          cb(new Error('useradd: command not found'), '', 'useradd: command not found')
          return
        }
        cb(null, '', '')
        return
      }
      if (args[0] === 'rm') { rmCalled = true; cb(null, '', ''); return }
      cb(null, '', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    await assert.rejects(
      () => backend.createEnvironment({
        envId: 'env-fail',
        cwd: '/tmp',
        image: 'node:22-slim',
        memoryLimit: '2g',
        cpuLimit: '2',
        containerUser: 'chroxy',
      }),
      /useradd/
    )

    assert.ok(rmCalled, 'should remove orphaned container on setup failure')
  })

  it('resolves cli path from npm prefix output', async () => {
    const mockExec = createMockExecFile({
      results: { run: 'cli-ctr\n', exec: '/opt/my-prefix\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const result = await backend.createEnvironment({
      envId: 'env-cli',
      cwd: '/tmp',
      image: 'node:22-slim',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    })

    assert.equal(result.containerCliPath, '/opt/my-prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js')
  })

  it('falls back to default CLI path when npm prefix fails', async () => {
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'run') { cb(null, 'fallback-ctr\n', ''); return }
      // install succeeds, prefix fails
      if (args[0] === 'exec' && args.includes('prefix')) {
        cb(new Error('prefix failed'), '', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    const result = await backend.createEnvironment({
      envId: 'env-fallback',
      cwd: '/tmp',
      image: 'node:22-slim',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    })

    assert.ok(result.containerCliPath.endsWith('cli.js'))
    // Uses the hardcoded default path
    assert.ok(result.containerCliPath.includes('claude-code'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.createComposeEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.createComposeEnvironment()', () => {
  it('runs docker compose up then identifies primary container', async () => {
    let upCalled = false
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) {
        upCalled = true
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('ps')) {
        cb(null, '{"ID":"compose-ctr-1","Service":"app","State":"running"}\n', '')
        return
      }
      if (args[0] === 'exec') {
        cb(null, '/usr/local\n', '')
        return
      }
      cb(null, '', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    const result = await backend.createComposeEnvironment({
      envId: 'env-compose',
      cwd: '/home/user/project',
      composeFile: '/home/user/project/docker-compose.yml',
      composeProject: 'chroxy-env-compose',
      containerUser: 'chroxy',
    })

    assert.ok(upCalled, 'should call docker compose up')
    assert.equal(result.containerId, 'compose-ctr-1')
    assert.ok(Array.isArray(result.services))
    assert.ok(result.containerCliPath.includes('cli.js'))
  })

  it('forwards opts.envFile as `docker compose --env-file <path>` before the subcommand (#5079)', async () => {
    let upArgs = null
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) {
        upArgs = [...args]
        cb(null, '', '')
        return
      }
      if (args[0] === 'compose' && args.includes('ps')) {
        cb(null, '{"ID":"ctr-1","Service":"app","State":"running"}\n', '')
        return
      }
      if (args[0] === 'exec') { cb(null, '/usr/local\n', ''); return }
      cb(null, '', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    await backend.createComposeEnvironment({
      envId: 'env-envfile',
      cwd: '/proj',
      composeFile: '/proj/docker-compose.yml',
      composeProject: 'chroxy-env-envfile',
      containerUser: 'chroxy',
      envFile: '/tmp/chroxy-byok-secret.env',
    })

    assert.ok(upArgs, 'compose up should have been called')
    // --env-file MUST come before the `up` subcommand to scope it to
    // compose itself (Docker's CLI ignores --env-file after the
    // subcommand for compose-level interpolation).
    const envFileIdx = upArgs.indexOf('--env-file')
    const upIdx = upArgs.indexOf('up')
    assert.ok(envFileIdx >= 0, '--env-file must be present in compose up args')
    assert.ok(envFileIdx < upIdx, '--env-file must precede the up subcommand')
    assert.equal(upArgs[envFileIdx + 1], '/tmp/chroxy-byok-secret.env')
  })

  it('omits --env-file from docker compose up when opts.envFile is absent (#5079)', async () => {
    let upArgs = null
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) { upArgs = [...args]; cb(null, '', ''); return }
      if (args[0] === 'compose' && args.includes('ps')) {
        cb(null, '{"ID":"ctr-1","Service":"app","State":"running"}\n', '')
        return
      }
      if (args[0] === 'exec') { cb(null, '/usr/local\n', ''); return }
      cb(null, '', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    await backend.createComposeEnvironment({
      envId: 'env-no-envfile',
      cwd: '/proj',
      composeFile: '/proj/docker-compose.yml',
      composeProject: 'chroxy-env-no-envfile',
      containerUser: 'chroxy',
    })

    assert.ok(upArgs, 'compose up should have been called')
    assert.equal(upArgs.indexOf('--env-file'), -1, '--env-file must be absent when not requested')
  })

  it('calls compose down and re-throws when primary container not found', async () => {
    let downCalled = false
    function mockExec(_cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      if (args[0] === 'compose' && args.includes('up')) { cb(null, '', ''); return }
      if (args[0] === 'compose' && args.includes('ps') && !args.includes('down')) {
        cb(null, '', '') // empty — no containers found
        return
      }
      if (args[0] === 'compose' && args.includes('down')) { downCalled = true; cb(null, '', ''); return }
      cb(null, '', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    await assert.rejects(
      () => backend.createComposeEnvironment({
        envId: 'env-fail-compose',
        cwd: '/tmp',
        composeFile: '/tmp/docker-compose.yml',
        composeProject: 'chroxy-env-fail',
        containerUser: 'chroxy',
      }),
      /No running containers/
    )

    assert.ok(downCalled, 'should call compose down on failure')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.destroyEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.destroyEnvironment()', () => {
  it('calls docker rm -f on the container ID', async () => {
    const mockExec = createMockExecFile()
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.destroyEnvironment('dead-ctr-123')

    const rmCall = mockExec.calls.find(c => c.args[0] === 'rm')
    assert.ok(rmCall, 'should call docker rm')
    assert.ok(rmCall.args.includes('-f'))
    assert.ok(rmCall.args.includes('dead-ctr-123'))
  })

  it('resolves even when docker rm fails (best-effort)', async () => {
    const mockExec = createMockExecFile({
      errors: { rm: new Error('no such container') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    // Must not reject
    await assert.doesNotReject(() => backend.destroyEnvironment('gone-ctr'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.destroyComposeEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.destroyComposeEnvironment()', () => {
  it('calls docker compose down --remove-orphans', async () => {
    const mockExec = createMockExecFile()
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.destroyComposeEnvironment({
      composeFile: '/tmp/docker-compose.yml',
      composeProject: 'chroxy-test-project',
      cwd: '/tmp',
    })

    const downCall = mockExec.calls.find(c => c.args[0] === 'compose' && c.args.includes('down'))
    assert.ok(downCall, 'should call docker compose down')
    assert.ok(downCall.args.includes('--remove-orphans'))
    assert.ok(downCall.args.includes('chroxy-test-project'))
  })

  it('resolves even when compose down fails (best-effort)', async () => {
    const mockExec = createMockExecFile({
      errors: { compose: new Error('compose not found') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await assert.doesNotReject(() => backend.destroyComposeEnvironment({
      composeFile: '/tmp/docker-compose.yml',
      composeProject: 'chroxy-test',
      cwd: '/tmp',
    }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.removeImage
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.removeImage()', () => {
  it('calls docker rmi on the image tag', async () => {
    const mockExec = createMockExecFile()
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.removeImage('chroxy-env:env-abc-12345')

    const rmiCall = mockExec.calls.find(c => c.args[0] === 'rmi')
    assert.ok(rmiCall, 'should call docker rmi')
    assert.ok(rmiCall.args.includes('chroxy-env:env-abc-12345'))
  })

  it('resolves even when rmi fails (best-effort)', async () => {
    const mockExec = createMockExecFile({
      errors: { rmi: new Error('no such image') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await assert.doesNotReject(() => backend.removeImage('gone-image:tag'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.getEnvironmentStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.getEnvironmentStatus()', () => {
  it('returns true when container is running', async () => {
    const mockExec = createMockExecFile({
      results: { inspect: 'true\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const running = await backend.getEnvironmentStatus('running-ctr')

    assert.equal(running, true)

    const inspectCall = mockExec.calls.find(c => c.args[0] === 'inspect')
    assert.ok(inspectCall)
    assert.ok(inspectCall.args.includes('{{.State.Running}}'))
    assert.ok(inspectCall.args.includes('running-ctr'))
  })

  it('returns false when container is stopped', async () => {
    const mockExec = createMockExecFile({
      results: { inspect: 'false\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const running = await backend.getEnvironmentStatus('stopped-ctr')
    assert.equal(running, false)
  })

  it('rejects when container does not exist', async () => {
    const mockExec = createMockExecFile({
      errors: { inspect: new Error('No such container') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await assert.rejects(
      () => backend.getEnvironmentStatus('missing-ctr'),
      /No such container/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.listEnvironments
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.listEnvironments()', () => {
  it('returns container IDs from docker ps --filter', async () => {
    const mockExec = createMockExecFile({
      results: { ps: 'ctr-a\nctr-b\nctr-c\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const ids = await backend.listEnvironments()

    assert.deepEqual(ids, ['ctr-a', 'ctr-b', 'ctr-c'])

    const psCall = mockExec.calls.find(c => c.args[0] === 'ps')
    assert.ok(psCall)
    assert.ok(psCall.args.includes('--filter'))
    assert.ok(psCall.args.includes('name=chroxy-env'))
    assert.ok(psCall.args.includes('-q'))
  })

  // Regression guard for #3314: docker ps -q returns 12-char truncated IDs.
  // createEnvironment persists the full 64-char ID returned by docker run, so
  // reconcile()'s exact-string comparison would mark every known container as
  // an orphan and destroy it. --no-trunc keeps both sides of the comparison
  // using the same full-length ID format.
  it('passes --no-trunc to docker ps so full container IDs are returned (#3314)', async () => {
    const mockExec = createMockExecFile({
      results: { ps: '' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.listEnvironments()

    const psCall = mockExec.calls.find(c => c.args[0] === 'ps')
    assert.ok(psCall, 'should have called docker ps')
    assert.ok(psCall.args.includes('--no-trunc'),
      'docker ps must include --no-trunc — without it -q returns 12-char IDs that never match the 64-char IDs stored by createEnvironment, so reconcile() destroys every known container')
  })

  it('returns empty array for empty docker ps output', async () => {
    const mockExec = createMockExecFile({
      results: { ps: '\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const ids = await backend.listEnvironments()
    assert.deepEqual(ids, [])
  })

  it('rejects when docker daemon is unreachable', async () => {
    const mockExec = createMockExecFile({
      errors: { ps: new Error('Cannot connect to the Docker daemon') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await assert.rejects(
      () => backend.listEnvironments(),
      /Cannot connect/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.commitEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.commitEnvironment()', () => {
  it('calls docker commit with correct args', async () => {
    const mockExec = createMockExecFile({
      results: { commit: 'sha256:abc123\n' },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const sha = await backend.commitEnvironment('snap-ctr', 'chroxy-env:env-abc-1234567890')

    assert.equal(sha, 'sha256:abc123')

    const commitCall = mockExec.calls.find(c => c.args[0] === 'commit')
    assert.ok(commitCall)
    assert.ok(commitCall.args.includes('snap-ctr'))
    assert.ok(commitCall.args.includes('chroxy-env:env-abc-1234567890'))
  })

  it('rejects when docker commit fails', async () => {
    const mockExec = createMockExecFile({
      errors: { commit: new Error('commit failed') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await assert.rejects(
      () => backend.commitEnvironment('bad-ctr', 'tag'),
      /commit failed/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.renameEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.renameEnvironment()', () => {
  it('calls docker rename with correct args', async () => {
    const mockExec = createMockExecFile()
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.renameEnvironment('old-ctr', 'chroxy-env-env-abc-old')

    const renameCall = mockExec.calls.find(c => c.args[0] === 'rename')
    assert.ok(renameCall)
    assert.ok(renameCall.args.includes('old-ctr'))
    assert.ok(renameCall.args.includes('chroxy-env-env-abc-old'))
  })

  it('resolves even when rename fails (best-effort)', async () => {
    const mockExec = createMockExecFile({
      errors: { rename: new Error('container name already in use') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    await assert.doesNotReject(() => backend.renameEnvironment('old-ctr', 'new-name'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.streamCliInEnvironment — security hardening (parity with
// docker-sdk-session.js#_createSpawnCallback). Regression guard for #3334.
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.streamCliInEnvironment() security hardening', () => {
  // Build a fake child + a spawn spy that captures the docker exec invocation.
  function makeBackendWithSpawnSpy() {
    let lastSpawn = null
    const fakeChild = new EventEmitter()
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.stdin = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = () => { fakeChild.killed = true }

    function fakeSpawn(cmd, args, opts) {
      lastSpawn = { cmd, args, opts }
      return fakeChild
    }

    const backend = new DockerBackend({ _spawn: fakeSpawn })
    return { backend, getLastSpawn: () => lastSpawn }
  }

  it('runs as the configured containerUser (docker exec -u <user>)', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node', args: [], containerUser: 'chroxy',
    })

    const { args } = getLastSpawn()
    const userIdx = args.indexOf('-u')
    assert.ok(userIdx >= 0, 'docker exec must include -u flag')
    assert.equal(args[userIdx + 1], 'chroxy', 'must run as the configured user, never root')
  })

  it('forwards only allowlisted env vars (FORWARDED_ENV_KEYS)', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node',
      args: [],
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        NODE_ENV: 'production',
        SECRET_TOKEN: 'should-not-leak',
        AWS_SECRET_ACCESS_KEY: 'should-not-leak',
        HOME: '/should-not-override',
      },
    })

    const { args } = getLastSpawn()
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }

    // Allowlisted: present
    assert.ok(envPairs.includes('ANTHROPIC_API_KEY=sk-test'), 'ANTHROPIC_API_KEY must be forwarded')
    assert.ok(envPairs.includes('NODE_ENV=production'), 'NODE_ENV must be forwarded')

    // Non-allowlisted: must NOT appear
    assert.ok(!envPairs.some(p => p.startsWith('SECRET_TOKEN=')), 'unlisted vars must not leak')
    assert.ok(!envPairs.some(p => p.startsWith('AWS_SECRET_ACCESS_KEY=')), 'unlisted secrets must not leak')

    // HOME from caller env must not override our explicit value
    assert.ok(!envPairs.some(p => p === 'HOME=/should-not-override'),
      'caller-provided HOME must not be forwarded; we set our own')
  })

  it('sets explicit HOME and PATH for the container user', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node', args: [], containerUser: 'chroxy',
    })

    const { args } = getLastSpawn()
    const envPairs = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--env') envPairs.push(args[i + 1])
    }

    assert.ok(envPairs.includes('HOME=/home/chroxy'), 'must set HOME for the container user')
    assert.ok(envPairs.some(p => p.startsWith('PATH=/usr/local/sbin:/usr/local/bin:')),
      'must set explicit PATH including container binaries')
  })

  it('remaps host cli.js path to containerCliPath', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    const hostCliPath = '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    const containerCliPath = '/opt/installed/lib/node_modules/@anthropic-ai/claude-code/cli.js'

    backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node',
      args: [hostCliPath, '-p', '--input-format', 'stream-json'],
      containerCliPath,
    })

    const { args } = getLastSpawn()
    // The args after the container ID should start with: node, <containerCliPath>, ...
    // Find 'node' in args (the cmd)
    const nodeIdx = args.lastIndexOf('node')
    assert.ok(nodeIdx >= 0, 'node command must be present in docker exec args')
    assert.equal(args[nodeIdx + 1], containerCliPath, 'cli.js path must be remapped to container path')
    assert.ok(!args.includes(hostCliPath), 'host cli.js path must not appear in container exec args')
  })

  it('falls back to default container CLI path when none provided', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node',
      args: ['/host/path/@anthropic-ai/claude-code/cli.js'],
    })

    const { args } = getLastSpawn()
    const nodeIdx = args.lastIndexOf('node')
    assert.equal(args[nodeIdx + 1], '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      'default containerCliPath must be used when none is supplied')
  })

  it('remaps host cwd to /workspace mount point', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node', args: [],
      hostCwd: '/home/user/project',
      cwd: '/home/user/project/src/lib',
    })

    const { args } = getLastSpawn()
    const wIdx = args.indexOf('--workdir')
    assert.ok(wIdx >= 0, '--workdir must be set')
    assert.equal(args[wIdx + 1], '/workspace/src/lib', 'cwd must be remapped relative to /workspace')
  })

  it('honors abort signal by killing the child', async () => {
    const { backend } = makeBackendWithSpawnSpy()
    const ac = new AbortController()

    const child = backend.streamCliInEnvironment('ctr-x', {
      cmd: 'node', args: [], signal: ac.signal,
    })

    ac.abort()
    // Allow the abort listener to fire
    await new Promise(r => setImmediate(r))

    assert.equal(child.killed, true, 'child must be killed when abort signal fires')
  })

  it('defaults containerUser to chroxy when not specified', () => {
    const { backend, getLastSpawn } = makeBackendWithSpawnSpy()

    backend.streamCliInEnvironment('ctr-x', { cmd: 'node', args: [] })

    const { args } = getLastSpawn()
    const userIdx = args.indexOf('-u')
    assert.equal(args[userIdx + 1], 'chroxy', 'default containerUser must be chroxy (never root)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend.execInEnvironment — opts.env and opts.cwd wiring (#3312)
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend.execInEnvironment()', () => {
  it('runs docker exec bash -c <cmd> with no extra flags when opts are absent', async () => {
    const mockExec = createMockExecFile({ results: { exec: 'hello\n' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    const result = await backend.execInEnvironment('ctr-abc', { cmd: 'echo hello' })

    assert.equal(result.stdout, 'hello\n')
    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    assert.ok(execCall, 'should have called docker exec')
    // args: ['exec', 'ctr-abc', 'bash', '-c', 'echo hello']
    assert.deepEqual(execCall.args, ['exec', 'ctr-abc', 'bash', '-c', 'echo hello'])
  })

  it('passes --workdir when opts.cwd is provided', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'pwd',
      cwd: '/workspace/src',
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const wIdx = execCall.args.indexOf('--workdir')
    assert.ok(wIdx >= 0, '--workdir flag must be present when opts.cwd is set')
    assert.equal(execCall.args[wIdx + 1], '/workspace/src')
    // container ID must come after the flags
    assert.ok(execCall.args.indexOf('ctr-abc') > wIdx + 1)
  })

  it('passes --workdir as a single argv element when cwd contains spaces', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'pwd',
      cwd: '/work space/src',
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const wIdx = execCall.args.indexOf('--workdir')
    assert.ok(wIdx >= 0, '--workdir flag must be present')
    // The path with a space must arrive as one unescaped array element — not split
    // or shell-quoted. This guards against any future refactor that naively joins
    // args into a shell string before passing to docker exec.
    assert.equal(execCall.args[wIdx + 1], '/work space/src',
      'cwd with spaces must be a single unescaped argv element')
    assert.ok(!execCall.args.includes('/work'), 'path must not be split on the space')
    assert.ok(!execCall.args.includes('space/src'), 'path must not be split on the space')
  })

  it('passes --env KEY=VAL for each entry in opts.env', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      env: { FOO: 'bar', GREETING: 'hello world' },
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const envPairs = []
    for (let i = 0; i < execCall.args.length - 1; i++) {
      if (execCall.args[i] === '--env') envPairs.push(execCall.args[i + 1])
    }
    assert.ok(envPairs.includes('FOO=bar'), 'FOO must be forwarded')
    assert.ok(envPairs.includes('GREETING=hello world'), 'GREETING must be forwarded')
    // container ID must come after env flags
    assert.ok(execCall.args.indexOf('ctr-abc') > 1)
  })

  it('passes both --workdir and --env flags together', async () => {
    const mockExec = createMockExecFile({ results: { exec: 'output\n' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    const result = await backend.execInEnvironment('ctr-xyz', {
      cmd: 'node -e "console.log(process.env.KEY)"',
      cwd: '/workspace',
      env: { KEY: 'value' },
    })

    assert.equal(result.stdout, 'output\n')
    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    assert.ok(execCall.args.includes('--workdir'), '--workdir must be present')
    assert.ok(execCall.args.includes('/workspace'))
    const envIdx = execCall.args.indexOf('--env')
    assert.ok(envIdx >= 0, '--env must be present')
    assert.equal(execCall.args[envIdx + 1], 'KEY=value')
    // bash -c <cmd> must be the last elements
    const bashIdx = execCall.args.indexOf('bash')
    assert.equal(execCall.args[bashIdx + 1], '-c')
    assert.equal(execCall.args[bashIdx + 2], 'node -e "console.log(process.env.KEY)"')
  })

  it('rejects when the command exits non-zero (stderr message)', async () => {
    const mockExec = createMockExecFile({
      errors: { exec: new Error('command failed') },
    })
    // Override to also supply stderr text
    const backend = new DockerBackend({
      _execFile(_cmd, _args, _opts, cb) {
        cb(new Error('exit 1'), '', 'bash: no such file')
      },
    })

    await assert.rejects(
      () => backend.execInEnvironment('ctr-abc', { cmd: 'nonexistent' }),
      /bash: no such file/
    )
  })

  it('#5067: attaches captured stdout AND stderr to the rejected Error', async () => {
    // postCreateCommand failures often print the actually-useful
    // diagnostic on stdout (npm install per-package errors, repo
    // bootstrap script `echo "FATAL: ..."` lines, apt-get summary).
    // Pre-#5067 the backend dropped stdout on the floor and the caller
    // had to re-run by hand to see what went wrong.
    const backend = new DockerBackend({
      _execFile(_cmd, _args, _opts, cb) {
        const err = new Error('exit 1')
        err.code = 1
        cb(err, 'OUT: setup printed this on stdout\n', 'ERR: setup printed this on stderr\n')
      },
    })

    let caught
    try {
      await backend.execInEnvironment('ctr-abc', { cmd: 'broken-setup.sh' })
      assert.fail('expected execInEnvironment to reject')
    } catch (err) {
      caught = err
    }

    assert.equal(typeof caught.stdout, 'string', 'rejected error must carry stdout')
    assert.equal(typeof caught.stderr, 'string', 'rejected error must carry stderr')
    assert.match(caught.stdout, /OUT: setup printed this on stdout/)
    assert.match(caught.stderr, /ERR: setup printed this on stderr/)
    // The message stays stderr-first for log-line continuity with the
    // pre-#5067 behaviour; stdout lives on the attached property.
    assert.match(caught.message, /ERR: setup printed this on stderr/)
  })

  it('#5067: rejected Error has empty-string stdout/stderr fields when the streams are silent', async () => {
    const backend = new DockerBackend({
      _execFile(_cmd, _args, _opts, cb) {
        cb(new Error('ETIMEDOUT'), '', '')
      },
    })

    let caught
    try {
      await backend.execInEnvironment('ctr-abc', { cmd: 'hangs-forever' })
      assert.fail('expected execInEnvironment to reject')
    } catch (err) {
      caught = err
    }

    assert.equal(caught.stdout, '', 'silent stdout normalised to empty string')
    assert.equal(caught.stderr, '', 'silent stderr normalised to empty string')
    // With no stderr to surface, the message falls back to err.message
    // — matches the pre-#5067 shape used by log scrapers.
    assert.equal(caught.message, 'ETIMEDOUT')
  })

  it('filters out entries whose value is null', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      env: { GOOD: 'value', BAD: null },
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const envPairs = []
    for (let i = 0; i < execCall.args.length - 1; i++) {
      if (execCall.args[i] === '--env') envPairs.push(execCall.args[i + 1])
    }
    assert.ok(envPairs.includes('GOOD=value'), 'non-null value must be forwarded')
    assert.ok(!envPairs.some(p => p.startsWith('BAD=')), 'null value must be skipped')
  })

  it('filters out entries whose value is undefined', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      env: { GOOD: 'value', BAD: undefined },
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const envPairs = []
    for (let i = 0; i < execCall.args.length - 1; i++) {
      if (execCall.args[i] === '--env') envPairs.push(execCall.args[i + 1])
    }
    assert.ok(envPairs.includes('GOOD=value'), 'non-undefined value must be forwarded')
    assert.ok(!envPairs.some(p => p.startsWith('BAD=')), 'undefined value must be skipped')
  })

  it('emits log.warn when skipping a null/undefined env value (#3419)', async (t) => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    // log.warn writes through console.warn (see logger.js).
    // Use node:test's t.mock.method which auto-restores on teardown — avoids
    // the cross-test contamination risk of overriding console.warn at global
    // scope (especially under parallel test runners).
    const warnCalls = []
    t.mock.method(console, 'warn', (msg) => {
      warnCalls.push(String(msg))
    })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      env: { FOO: null, BAR: undefined, OK: 'value' },
    })

    const fooWarn = warnCalls.find(m => m.includes('"FOO"'))
    const barWarn = warnCalls.find(m => m.includes('"BAR"'))
    assert.ok(fooWarn, 'must warn for null env key by name')
    assert.match(fooWarn, /execInEnvironment: skipping null\/undefined value for env key "FOO"/)
    assert.ok(barWarn, 'must warn for undefined env key by name')
    assert.match(barWarn, /execInEnvironment: skipping null\/undefined value for env key "BAR"/)
    assert.ok(!warnCalls.some(m => m.includes('"OK"')), 'must not warn for non-null entries')
  })

  it('coerces numeric values to string via String()', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      env: { PORT: 3000, TIMEOUT: 0 },
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const envPairs = []
    for (let i = 0; i < execCall.args.length - 1; i++) {
      if (execCall.args[i] === '--env') envPairs.push(execCall.args[i + 1])
    }
    assert.ok(envPairs.includes('PORT=3000'), 'numeric value must be coerced to string')
    assert.ok(envPairs.includes('TIMEOUT=0'), 'falsy numeric 0 must not be skipped (only null/undefined are)')
  })

  it('passes string values through unchanged', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      env: { KEY: 'plain-string', EMPTY: '' },
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const envPairs = []
    for (let i = 0; i < execCall.args.length - 1; i++) {
      if (execCall.args[i] === '--env') envPairs.push(execCall.args[i + 1])
    }
    assert.ok(envPairs.includes('KEY=plain-string'), 'plain string must be forwarded as-is')
    assert.ok(envPairs.includes('EMPTY='), 'empty string must be forwarded (not treated as null)')
  })

  it('does not forward process.env — only passes what the caller supplies', async () => {
    // Ensure a process.env var that is NOT in opts.env never appears in args
    process.env._TEST_EXEC_LEAK = 'should-not-appear'

    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', { cmd: 'printenv', env: { SAFE: 'ok' } })

    delete process.env._TEST_EXEC_LEAK

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const joined = execCall.args.join(' ')
    assert.ok(!joined.includes('_TEST_EXEC_LEAK'), 'process.env must never be forwarded')
  })

  it('passes --env-file <path> when opts.envFile is set (#5079)', async () => {
    const mockExec = createMockExecFile({ results: { exec: '' } })
    const backend = new DockerBackend({ _execFile: mockExec })

    await backend.execInEnvironment('ctr-abc', {
      cmd: 'printenv',
      envFile: '/tmp/chroxy-byok-secret.env',
    })

    const execCall = mockExec.calls.find(c => c.args[0] === 'exec')
    const idx = execCall.args.indexOf('--env-file')
    assert.ok(idx >= 0, '--env-file flag must be present when opts.envFile is set')
    assert.equal(execCall.args[idx + 1], '/tmp/chroxy-byok-secret.env')
    // Container ID must come after the flag — same ordering invariant as --env.
    assert.ok(execCall.args.indexOf('ctr-abc') > idx + 1)
  })

  // ───────────────────────────────────────────────────────────────────────
  // #5069 — streaming path: when opts.onData is supplied, run via spawn and
  // surface stdout/stderr incrementally while still buffering for the result
  // and the failure tail (#5067).
  // ───────────────────────────────────────────────────────────────────────

  // Build a fake child + spawn spy. Tests drive child.stdout/stderr/exit
  // by hand to simulate the docker exec process producing output over time.
  function makeStreamingBackend() {
    let lastSpawn = null
    const fakeChild = new EventEmitter()
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.killed = false
    fakeChild.kill = (sig) => { fakeChild.killed = true; fakeChild.lastSignal = sig }
    function fakeSpawn(cmd, args, opts) {
      lastSpawn = { cmd, args, opts }
      return fakeChild
    }
    const backend = new DockerBackend({ _spawn: fakeSpawn })
    return { backend, fakeChild, getLastSpawn: () => lastSpawn }
  }

  it('#5069: invokes onData with each chunk in arrival order and resolves with the full buffer', async () => {
    const { backend, fakeChild } = makeStreamingBackend()
    const seen = []

    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'npm install',
      onData: (chunk, stream) => seen.push([stream, chunk]),
    })

    // Simulate output arriving over time, then a clean exit.
    fakeChild.stdout.write('npm WARN foo\n')
    fakeChild.stderr.write('fetching...\n')
    fakeChild.stdout.write('added 42 packages\n')
    // Let the stream 'data' events flush before closing.
    await new Promise((r) => setImmediate(r))
    fakeChild.emit('close', 0, null)

    const result = await p
    assert.deepEqual(seen, [
      ['stdout', 'npm WARN foo\n'],
      ['stderr', 'fetching...\n'],
      ['stdout', 'added 42 packages\n'],
    ], 'onData must fire per chunk in arrival order with the right stream tag')
    assert.equal(result.stdout, 'npm WARN foo\nadded 42 packages\n', 'full stdout buffered')
    assert.equal(result.stderr, 'fetching...\n', 'full stderr buffered')
  })

  it('#5069: uses spawn (not execFile) when onData is supplied', async () => {
    const { backend, fakeChild, getLastSpawn } = makeStreamingBackend()
    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'echo hi',
      user: 'chroxy',
      onData: () => {},
    })
    await new Promise((r) => setImmediate(r))
    fakeChild.emit('close', 0, null)
    await p

    const spawnCall = getLastSpawn()
    assert.ok(spawnCall, 'spawn must be used for the streaming path')
    // Same argv shape as the buffered path: exec -u <user> ... bash -c <cmd>.
    assert.deepEqual(spawnCall.args, ['exec', '-u', 'chroxy', 'ctr-abc', 'bash', '-c', 'echo hi'])
  })

  it('#5069: keeps the buffered execFile path when onData is absent (backward compat)', async () => {
    const mockExec = createMockExecFile({ results: { exec: 'buffered\n' } })
    const backend = new DockerBackend({
      _execFile: mockExec,
      _spawn: () => { throw new Error('spawn must NOT be called when onData is absent') },
    })
    const result = await backend.execInEnvironment('ctr-abc', { cmd: 'echo hi' })
    assert.equal(result.stdout, 'buffered\n')
    assert.ok(mockExec.calls.some(c => c.args[0] === 'exec'), 'execFile path must be used')
  })

  it('#5069: streamed failure still attaches the buffered stdout/stderr tail to the rejected Error', async () => {
    const { backend, fakeChild } = makeStreamingBackend()
    const seen = []
    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'broken-setup.sh',
      onData: (chunk, stream) => seen.push([stream, chunk]),
    })

    fakeChild.stdout.write('OUT: building native module\n')
    fakeChild.stderr.write('ERR: node-gyp rebuild failed\n')
    await new Promise((r) => setImmediate(r))
    fakeChild.emit('close', 1, null)

    let caught
    try {
      await p
      assert.fail('expected rejection on non-zero exit')
    } catch (err) {
      caught = err
    }
    // Streaming happened.
    assert.equal(seen.length, 2)
    // #5067 contract: both streams attached to the error.
    assert.match(caught.stdout, /OUT: building native module/, 'stdout tail attached on failure')
    assert.match(caught.stderr, /ERR: node-gyp rebuild failed/, 'stderr tail attached on failure')
    // Message is stderr-first, mirroring the buffered path.
    assert.match(caught.message, /ERR: node-gyp rebuild failed/)
    assert.equal(caught.code, 1)
  })

  it('#5069: SIGTERMs the child and rejects on timeout (no leaked process)', async () => {
    const { backend, fakeChild } = makeStreamingBackend()
    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'hangs-forever',
      timeout: 20,
      onData: () => {},
    })

    let caught
    try {
      // The timer fires (20ms), SIGTERMs the child; the real docker exec
      // would then close. Simulate that close after the kill.
      await new Promise((r) => setTimeout(r, 40))
      assert.ok(fakeChild.killed, 'child must be SIGTERM-killed on timeout')
      assert.equal(fakeChild.lastSignal, 'SIGTERM')
      fakeChild.emit('close', null, 'SIGTERM')
      await p
      assert.fail('expected rejection on timeout')
    } catch (err) {
      caught = err
    }
    assert.match(caught.message, /timed out after 20ms/)
    assert.equal(caught.killed, true)
  })

  it('#5069: a throwing onData listener does not orphan the child or reject the run', async () => {
    const { backend, fakeChild } = makeStreamingBackend()
    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'echo hi',
      onData: () => { throw new Error('listener boom') },
    })
    fakeChild.stdout.write('hello\n')
    await new Promise((r) => setImmediate(r))
    fakeChild.emit('close', 0, null)
    // Listener throw is swallowed; the run still resolves with the buffer.
    const result = await p
    assert.equal(result.stdout, 'hello\n')
  })

  // ───────────────────────────────────────────────────────────────────────
  // #5126 — SIGKILL escalation when a child ignores SIGTERM on timeout.
  // ───────────────────────────────────────────────────────────────────────

  // A child that records every signal it receives but NEVER flips `killed`
  // (i.e. it ignores SIGTERM) and never emits `close` on its own.
  function makeStubbornChild() {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.signals = []
    child.kill = (sig) => {
      child.signals.push(sig)
      // Deliberately do NOT set child.killed — simulate a process that
      // ignores SIGTERM. SIGKILL would normally be uncatchable; we let the
      // backend's escalation path do its thing and assert on the signal log.
    }
    return child
  }

  it('#5126: escalates to SIGKILL when the child ignores SIGTERM, and the promise rejects', async () => {
    // Deterministic: stub setTimeout so the 5s grace timer runs synchronously.
    const stubborn = makeStubbornChild()
    const backend = new DockerBackend({ _spawn: () => stubborn })

    const realSetTimeout = global.setTimeout
    // Run the SHORTEST timer (the timeout) on a real micro-delay, but make the
    // grace timer (the longer 5s one) fire immediately so we don't wait 5s.
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms >= 1000) {
        // The SIGKILL grace timer — fire on next tick instead of after 5s.
        const t = realSetTimeout(fn, 0, ...rest)
        if (t && typeof t.unref === 'function') t.unref()
        return t
      }
      return realSetTimeout(fn, ms, ...rest)
    }

    let caught
    try {
      const p = backend.execInEnvironment('ctr-abc', {
        cmd: 'hangs-forever',
        timeout: 5,
        onData: () => {},
      })
      // Let timeout fire (SIGTERM) then the (now-immediate) grace timer (SIGKILL).
      await new Promise((r) => realSetTimeout(r, 30))
      assert.deepEqual(
        stubborn.signals,
        ['SIGTERM', 'SIGKILL'],
        'must SIGTERM first, then escalate to SIGKILL after grace',
      )
      // The real docker process would now close from the SIGKILL.
      stubborn.emit('close', null, 'SIGKILL')
      await p
      assert.fail('expected rejection on timeout')
    } catch (err) {
      caught = err
    } finally {
      global.setTimeout = realSetTimeout
    }
    assert.match(caught.message, /timed out after 5ms/)
    assert.equal(caught.killed, true)
  })

  it('#5126: grace timer is cleared on a prompt close (no SIGKILL on a child that honours SIGTERM)', async () => {
    // Detect any attempt to arm a >=1s timer (the SIGKILL grace) and whether it
    // ever fires. The grace is 5s in production; the child closes promptly after
    // SIGTERM, so settle() must clear the armed grace timer before it fires.
    const realSetTimeout = global.setTimeout
    const realClearTimeout = global.clearTimeout
    let graceFired = false
    let graceArmed = false
    let graceCleared = false
    let graceHandle = null
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms >= 1000) {
        graceArmed = true
        graceHandle = realSetTimeout(() => { graceFired = true; fn() }, ms, ...rest)
        if (graceHandle && typeof graceHandle.unref === 'function') graceHandle.unref()
        return graceHandle
      }
      return realSetTimeout(fn, ms, ...rest)
    }
    global.clearTimeout = (t) => {
      if (t && t === graceHandle) graceCleared = true
      return realClearTimeout(t)
    }

    const { backend, fakeChild } = makeStreamingBackend()
    fakeChild.signals = []
    const realKill = fakeChild.kill
    fakeChild.kill = (sig) => { fakeChild.signals.push(sig); realKill(sig) }

    let caught
    try {
      const p = backend.execInEnvironment('ctr-abc', {
        cmd: 'hangs-then-dies',
        timeout: 5,
        onData: () => {},
      })
      // Timeout fires -> SIGTERM + grace armed. Child honours it and closes
      // before the 5s grace fires, so settle() must clear the grace timer.
      await new Promise((r) => realSetTimeout(r, 20))
      assert.ok(fakeChild.signals.includes('SIGTERM'), 'SIGTERM sent on timeout')
      assert.ok(graceArmed, 'grace timer must be armed after SIGTERM')
      fakeChild.emit('close', null, 'SIGTERM')
      await p
      assert.fail('expected rejection on timeout')
    } catch (err) {
      caught = err
    } finally {
      global.setTimeout = realSetTimeout
      global.clearTimeout = realClearTimeout
    }
    assert.match(caught.message, /timed out after 5ms/)
    assert.ok(graceCleared, 'grace timer must be cleared once the child closes')
    assert.ok(!graceFired, 'grace timer must not fire when the child closes promptly')
    assert.ok(!fakeChild.signals.includes('SIGKILL'), 'no SIGKILL when SIGTERM is honoured')
  })

  // ───────────────────────────────────────────────────────────────────────
  // #5127 — bounded retained buffer (maxBuffer parity). onData still fires
  // for every chunk; only the accumulator is capped to a last-N tail.
  // ───────────────────────────────────────────────────────────────────────

  it('#5127: caps the retained stdout buffer while still delivering every chunk to onData', async () => {
    const { backend, fakeChild } = makeStreamingBackend()
    const seen = []
    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'spammy-setup.sh',
      onData: (chunk, stream) => seen.push([stream, chunk]),
    })

    // The retained cap is 256 KiB. Emit well past it as many discrete chunks so
    // we can assert (a) every chunk reached onData and (b) the resolved buffer
    // is bounded to the tail.
    const CAP = 256 * 1024
    const chunk = 'x'.repeat(64 * 1024) // 64 KiB per chunk
    const numChunks = 10 // 640 KiB total — 2.5x the cap
    const tailMarker = 'TAIL-MARKER-END\n'
    for (let i = 0; i < numChunks; i++) {
      fakeChild.stdout.write(chunk)
    }
    fakeChild.stdout.write(tailMarker)
    await new Promise((r) => setImmediate(r))
    fakeChild.emit('close', 0, null)

    const result = await p

    // (a) Every emitted chunk reached onData — streaming is NOT truncated.
    const stdoutChunks = seen.filter(([s]) => s === 'stdout')
    assert.equal(stdoutChunks.length, numChunks + 1, 'onData fires for every chunk past the cap')
    const totalStreamed = stdoutChunks.reduce((n, [, c]) => n + c.length, 0)
    assert.equal(totalStreamed, numChunks * chunk.length + tailMarker.length, 'full bytes streamed via onData')

    // (b) The retained buffer is bounded to the cap.
    assert.ok(result.stdout.length <= CAP, `retained stdout (${result.stdout.length}) must be <= cap (${CAP})`)
    assert.ok(result.stdout.length > 0, 'retained buffer is non-empty')
    // (c) The TAIL is kept (diagnostic info lands at the end).
    assert.ok(result.stdout.endsWith(tailMarker), 'the last bytes (the diagnostic tail) are retained')
  })

  it('#5127: failure tail is preserved off the bounded buffer on non-zero exit', async () => {
    const { backend, fakeChild } = makeStreamingBackend()
    const p = backend.execInEnvironment('ctr-abc', {
      cmd: 'broken-spammy-setup.sh',
      onData: () => {},
    })

    const filler = 'y'.repeat(64 * 1024)
    for (let i = 0; i < 8; i++) {
      fakeChild.stderr.write(filler) // 512 KiB of noise — past the 256 KiB cap
    }
    fakeChild.stderr.write('ERR: the actual failure line\n')
    await new Promise((r) => setImmediate(r))
    fakeChild.emit('close', 1, null)

    let caught
    try {
      await p
      assert.fail('expected rejection on non-zero exit')
    } catch (err) {
      caught = err
    }
    const CAP = 256 * 1024
    assert.ok(caught.stderr.length <= CAP, 'failure stderr is bounded to the cap')
    assert.match(caught.stderr, /ERR: the actual failure line/, 'failure tail survives the cap')
    assert.match(caught.message, /ERR: the actual failure line/, 'message derives from the bounded tail')
    assert.equal(caught.code, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DockerBackend._composeServices (graceful degradation)
// ─────────────────────────────────────────────────────────────────────────────

describe('DockerBackend._composeServices()', () => {
  it('returns empty array when docker compose ps fails', async () => {
    const mockExec = createMockExecFile({
      errors: { compose: new Error('docker compose not found') },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const services = await backend._composeServices('test-project')
    assert.deepEqual(services, [])
  })

  it('returns empty array when compose ps returns invalid JSON', async () => {
    function mockExec(_cmd, _args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {} }
      cb(null, 'not-valid-json\n', '')
    }
    mockExec.calls = []

    const backend = new DockerBackend({ _execFile: mockExec })
    const services = await backend._composeServices('test-project')
    assert.deepEqual(services, [])
  })

  it('parses service names and states correctly', async () => {
    const mockExec = createMockExecFile({
      results: {
        compose: '{"ID":"ctr-1","Service":"web","State":"running"}\n{"ID":"ctr-2","Service":"db","State":"running"}\n',
      },
    })
    const backend = new DockerBackend({ _execFile: mockExec })

    const services = await backend._composeServices('my-project')
    assert.equal(services.length, 2)
    assert.equal(services[0].name, 'web')
    assert.equal(services[1].name, 'db')
  })
})
