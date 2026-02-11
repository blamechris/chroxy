import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from '../src/session-manager.js'
import { discoverTmuxSessions } from '../src/session-discovery.js'

/**
 * Create a mock executor for discoverTmuxSessions tests.
 * Override individual methods as needed.
 */
function createMockExecutor(overrides = {}) {
  return {
    whichTmux: overrides.whichTmux || (() => {}),
    listPanes: overrides.listPanes || (() => ''),
    getChildren: overrides.getChildren || (() => { throw new Error('no children') }),
    getCommand: overrides.getCommand || (() => ''),
    getCwd: overrides.getCwd || (() => { throw new Error('no cwd') }),
  }
}

describe('discoverTmuxSessions with mock executor', () => {
  it('returns [] when tmux is not installed', () => {
    const executor = createMockExecutor({
      whichTmux: () => { throw new Error('not found') },
    })
    const result = discoverTmuxSessions({ executor })
    assert.deepStrictEqual(result, [])
  })

  it('returns [] when no panes exist', () => {
    const executor = createMockExecutor({
      listPanes: () => '',
    })
    const result = discoverTmuxSessions({ executor })
    assert.deepStrictEqual(result, [])
  })

  it('discovers session with Claude running (happy path)', () => {
    const executor = createMockExecutor({
      listPanes: () => 'chroxy-main 12345 /Users/dev/project',
      getChildren: (pid) => {
        if (pid === 12345) return '12346'
        throw new Error('no children')
      },
      getCommand: (pid) => {
        if (pid === 12346) return '/usr/local/bin/claude -p --output-format stream-json'
        return 'bash'
      },
      getCwd: (pid) => {
        if (pid === 12346) return 'p12346\nn/Users/dev/actual-cwd'
        throw new Error('no cwd')
      },
    })

    const result = discoverTmuxSessions({ executor })
    assert.equal(result.length, 1)
    assert.equal(result[0].sessionName, 'chroxy-main')
    assert.equal(result[0].cwd, '/Users/dev/actual-cwd')
    assert.equal(result[0].pid, 12346)
  })

  it('filters by prefix', () => {
    const executor = createMockExecutor({
      listPanes: () => [
        'chroxy-main 100 /home/a',
        'other-session 200 /home/b',
      ].join('\n'),
      getChildren: (pid) => {
        if (pid === 100) return '101'
        if (pid === 200) return '201'
        throw new Error('no children')
      },
      getCommand: (pid) => {
        if (pid === 101 || pid === 201) return 'claude -p'
        return 'bash'
      },
      getCwd: () => { throw new Error('no cwd') },
    })

    const result = discoverTmuxSessions({ prefix: 'chroxy-', executor })
    assert.equal(result.length, 1)
    assert.equal(result[0].sessionName, 'chroxy-main')
  })

  it('handles nested processes (shell -> node -> claude)', () => {
    const executor = createMockExecutor({
      listPanes: () => 'dev 500 /tmp',
      getChildren: (pid) => {
        if (pid === 500) return '501'  // shell has node child
        if (pid === 501) return '502'  // node has claude child
        throw new Error('no children')
      },
      getCommand: (pid) => {
        if (pid === 501) return 'node /usr/local/bin/npx'
        if (pid === 502) return 'claude --resume abc123'
        return 'bash'
      },
      getCwd: () => { throw new Error('no cwd') },
    })

    const result = discoverTmuxSessions({ executor })
    assert.equal(result.length, 1)
    assert.equal(result[0].pid, 502)
    assert.equal(result[0].cwd, '/tmp') // falls back to pane cwd
  })

  it('falls back to pane CWD when lsof fails', () => {
    const executor = createMockExecutor({
      listPanes: () => 'mysess 300 /Users/dev/fallback-cwd',
      getChildren: (pid) => {
        if (pid === 300) return '301'
        throw new Error('no children')
      },
      getCommand: (pid) => {
        if (pid === 301) return 'claude -p'
        return 'bash'
      },
      getCwd: () => { throw new Error('lsof failed') },
    })

    const result = discoverTmuxSessions({ executor })
    assert.equal(result.length, 1)
    assert.equal(result[0].cwd, '/Users/dev/fallback-cwd')
  })

  it('returns [] on tmux command failure', () => {
    const executor = createMockExecutor({
      listPanes: () => { throw new Error('tmux crashed') },
    })
    const result = discoverTmuxSessions({ executor })
    assert.deepStrictEqual(result, [])
  })

  it('handles spaces in paths', () => {
    const executor = createMockExecutor({
      listPanes: () => 'sess 400 /Users/dev/My Projects/app',
      getChildren: (pid) => {
        if (pid === 400) return '401'
        throw new Error('no children')
      },
      getCommand: (pid) => {
        if (pid === 401) return 'claude -p'
        return 'bash'
      },
      getCwd: () => { throw new Error('no cwd') },
    })

    const result = discoverTmuxSessions({ executor })
    assert.equal(result.length, 1)
    assert.equal(result[0].cwd, '/Users/dev/My Projects/app')
  })

  it('skips malformed pane lines', () => {
    const executor = createMockExecutor({
      listPanes: () => [
        'valid 600 /tmp',
        'short',              // too few parts
        'bad NaN /tmp',       // non-numeric PID
        '',                   // empty line
      ].join('\n'),
      getChildren: (pid) => {
        if (pid === 600) return '601'
        throw new Error('no children')
      },
      getCommand: (pid) => {
        if (pid === 601) return 'claude -p'
        return 'bash'
      },
      getCwd: () => { throw new Error('no cwd') },
    })

    const result = discoverTmuxSessions({ executor })
    assert.equal(result.length, 1)
    assert.equal(result[0].sessionName, 'valid')
  })
})

describe('SessionManager auto-discovery', () => {
  it('starts auto-discovery timer when enabled', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })
    sessionManager.startAutoDiscovery()
    assert.ok(sessionManager._discoveryTimer, 'Timer should be set')
    sessionManager.stopAutoDiscovery()
    assert.strictEqual(sessionManager._discoveryTimer, null, 'Timer should be cleared after stop')
  })

  it('does not start timer when autoDiscovery is disabled', () => {
    const sessionManager = new SessionManager({ autoDiscovery: false })
    sessionManager.startAutoDiscovery()
    assert.strictEqual(sessionManager._discoveryTimer, null, 'Timer should not be set')
  })

  it('stops auto-discovery on destroyAll', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })
    sessionManager.startAutoDiscovery()
    assert.ok(sessionManager._discoveryTimer, 'Timer should be set')

    sessionManager.destroyAll()
    assert.strictEqual(sessionManager._discoveryTimer, null, 'Timer should be cleared after destroyAll')
  })

  it('initializes discovery tracking with current sessions', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })

    // Before startAutoDiscovery, tracking set should be empty
    assert.strictEqual(sessionManager._lastDiscoveredSessions.size, 0, 'Tracking set should start empty')

    // After startAutoDiscovery, it should be populated with currently discovered sessions
    sessionManager.startAutoDiscovery()

    // If there are any tmux sessions running Claude, they should be tracked
    // (size will be >= 0 depending on host environment)
    assert.ok(sessionManager._lastDiscoveredSessions instanceof Set, 'Should have a tracking set')

    sessionManager.stopAutoDiscovery()
  })

  it('does not start timer twice if already running', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true, discoveryIntervalMs: 1000 })
    sessionManager.startAutoDiscovery()
    const firstTimer = sessionManager._discoveryTimer

    // Try to start again
    sessionManager.startAutoDiscovery()
    const secondTimer = sessionManager._discoveryTimer

    assert.strictEqual(firstTimer, secondTimer, 'Should reuse existing timer')

    sessionManager.stopAutoDiscovery()
  })

  it('uses custom discovery interval', () => {
    const customInterval = 30000
    const sessionManager = new SessionManager({
      autoDiscovery: true,
      discoveryIntervalMs: customInterval
    })

    assert.strictEqual(sessionManager._discoveryIntervalMs, customInterval, 'Should store custom interval')

    sessionManager.startAutoDiscovery()
    assert.ok(sessionManager._discoveryTimer, 'Timer should be set with custom interval')

    sessionManager.stopAutoDiscovery()
  })

  it('defaults to 45 second interval', () => {
    const sessionManager = new SessionManager({ autoDiscovery: true })

    assert.strictEqual(sessionManager._discoveryIntervalMs, 45000, 'Should default to 45000ms')
  })
})
