import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
