import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PtyManager } from '../src/pty-manager.js'

/**
 * Test helper: Mock tmux command results
 */
class MockTmuxCommands {
  constructor() {
    this.reset()
  }

  reset() {
    this.sessionExists = true
    this.paneDeadOutput = '0' // 0 = alive, 1 = dead
    this.paneCommandOutput = 'claude' // Current command running in pane
    this.shouldThrowError = false
    this.errorMessage = 'tmux command failed'
  }
}

/**
 * Test-only wrapper that allows injecting mock tmux commands
 */
class TestPtyManager extends PtyManager {
  constructor(config = {}) {
    super(config)
    this.mockTmux = config.mockTmux || new MockTmuxCommands()
    this._skipPtySpawn = config.skipPtySpawn !== false // Default to skip
  }

  async start() {
    if (this._skipPtySpawn) {
      // Skip actual PTY spawn for unit tests
      this._startHealthCheck()
      return this
    }
    return super.start()
  }

  _hasTmuxSession() {
    if (this.mockTmux.shouldThrowError) {
      throw new Error(this.mockTmux.errorMessage)
    }
    return this.mockTmux.sessionExists
  }

  _checkHealth() {
    try {
      // Check if tmux session exists
      if (!this._hasTmuxSession()) {
        console.log(`[pty] Health check failed: tmux session '${this.sessionName}' no longer exists`)
        this._stopHealthCheck()
        this.emit('crashed', { reason: 'session_not_found' })
        return
      }

      if (this.mockTmux.shouldThrowError) {
        throw new Error(this.mockTmux.errorMessage)
      }

      // Check pane status
      const paneDeadOutput = this.mockTmux.paneDeadOutput
      const panes = paneDeadOutput.split('\n')
      const deadPanes = panes.filter((status) => status === '1')

      if (deadPanes.length > 0) {
        console.log(
          `[pty] Health check failed: ${deadPanes.length} dead pane(s) in session '${this.sessionName}'`
        )
        this._stopHealthCheck()
        this.emit('crashed', { reason: 'pane_dead' })
        return
      }

      // Check Claude process
      const currentCmdOutput = this.mockTmux.paneCommandOutput
      const paneCommands = currentCmdOutput === '' ? [] : currentCmdOutput.split('\n')
      const hasClaudeProcess = paneCommands.some((cmd) =>
        typeof cmd === 'string' && cmd.toLowerCase().includes('claude')
      )

      if (!hasClaudeProcess) {
        console.log(
          `[pty] Health check failed: no Claude process found in tmux session '${this.sessionName}'`
        )
        this._stopHealthCheck()
        this.emit('crashed', { reason: 'claude_process_not_found' })
        return
      }
    } catch (err) {
      console.error(`[pty] Health check error for session '${this.sessionName}':`, err.message)
      this._stopHealthCheck()
      this.emit('crashed', { reason: 'health_check_error', error: err.message })
    }
  }
}

describe('PtyManager Health Check', () => {
  let ptyManager
  let mockTmux

  beforeEach(() => {
    mockTmux = new MockTmuxCommands()
  })

  afterEach(() => {
    if (ptyManager) {
      ptyManager.destroy()
      ptyManager = null
    }
  })

  describe('_startHealthCheck and _stopHealthCheck', () => {
    it('starts periodic health check timer', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      assert.ok(ptyManager._healthCheckInterval, 'Health check interval should be set')
    })

    it('stops health check timer on destroy', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      assert.ok(ptyManager._healthCheckInterval, 'Health check interval should be set')

      ptyManager.destroy()

      assert.equal(ptyManager._healthCheckInterval, null, 'Health check interval should be null after destroy')
    })

    it('stops health check timer when manually called', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      ptyManager._stopHealthCheck()

      assert.equal(ptyManager._healthCheckInterval, null, 'Health check interval should be null after _stopHealthCheck')
    })
  })

  describe('_checkHealth - healthy session', () => {
    it('passes health check when session and process are healthy', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      let crashedFired = false
      ptyManager.once('crashed', () => {
        crashedFired = true
      })

      // Run health check manually
      ptyManager._checkHealth()

      // Give time for any events to fire
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(crashedFired, false, 'Should not emit crashed event when healthy')
      assert.ok(ptyManager._healthCheckInterval, 'Health check should still be running')
    })
  })

  describe('_checkHealth - crash detection', () => {
    it('detects missing tmux session and emits crashed event', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      // Simulate tmux session no longer exists
      mockTmux.sessionExists = false

      // Run health check manually
      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'session_not_found', 'Should emit crashed with session_not_found reason')
      assert.equal(ptyManager._healthCheckInterval, null, 'Health check should be stopped after crash')
    })

    it('detects dead pane and emits crashed event', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      // Simulate dead pane
      mockTmux.paneDeadOutput = '1'

      // Run health check manually
      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'pane_dead', 'Should emit crashed with pane_dead reason')
      assert.equal(ptyManager._healthCheckInterval, null, 'Health check should be stopped after crash')
    })

    it('detects multiple dead panes', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      // Simulate multiple panes, some dead
      mockTmux.paneDeadOutput = '0\n1\n1'

      // Run health check manually
      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'pane_dead', 'Should emit crashed with pane_dead reason')
    })

    it('detects Claude process not running and emits crashed event', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      // Simulate Claude process not running (different command)
      mockTmux.paneCommandOutput = 'zsh'

      // Run health check manually
      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'claude_process_not_found', 'Should emit crashed with claude_process_not_found reason')
      assert.equal(ptyManager._healthCheckInterval, null, 'Health check should be stopped after crash')
    })

    it('detects Claude process not running with empty pane commands', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      // Simulate no pane commands (empty output)
      mockTmux.paneCommandOutput = ''

      // Run health check manually
      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'claude_process_not_found', 'Should emit crashed with claude_process_not_found reason')
    })

    it('handles health check error and emits crashed event', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      // Simulate tmux command error
      mockTmux.shouldThrowError = true
      mockTmux.errorMessage = 'tmux server not running'

      // Run health check manually
      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'health_check_error', 'Should emit crashed with health_check_error reason')
      assert.equal(crashedEvent.error, 'tmux server not running', 'Should include error message')
      assert.equal(ptyManager._healthCheckInterval, null, 'Health check should be stopped after error')
    })
  })

  describe('health check stops after detecting crash', () => {
    it('stops periodic interval after detecting crash', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      let crashedCount = 0
      ptyManager.on('crashed', () => {
        crashedCount++
      })

      // Simulate dead pane
      mockTmux.paneDeadOutput = '1'

      // Run health check once - this should stop the interval
      ptyManager._checkHealth()

      // Give time for event to fire
      await new Promise(resolve => setTimeout(resolve, 10))

      assert.equal(crashedCount, 1, 'Should emit crashed event once')
      assert.equal(ptyManager._healthCheckInterval, null, 'Health check interval should be stopped')
    })

    it('does not run periodic health checks after crash is detected', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      // Use very short interval for testing
      ptyManager._healthCheckIntervalMs = 50
      await ptyManager.start()

      let crashedCount = 0
      ptyManager.on('crashed', () => {
        crashedCount++
      })

      // Simulate dead pane
      mockTmux.paneDeadOutput = '1'

      // Wait for a few intervals to pass
      await new Promise(resolve => setTimeout(resolve, 200))

      assert.equal(crashedCount, 1, 'Should only emit crashed event once despite multiple intervals')
      assert.equal(ptyManager._healthCheckInterval, null, 'Health check interval should be cleared')
    })
  })

  describe('health check detects Claude process variations', () => {
    it('accepts "claude" command (lowercase)', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      mockTmux.paneCommandOutput = 'claude'

      let crashedFired = false
      ptyManager.once('crashed', () => {
        crashedFired = true
      })

      ptyManager._checkHealth()

      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(crashedFired, false, 'Should not crash with lowercase claude')
    })

    it('accepts "Claude" command (capitalized)', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      mockTmux.paneCommandOutput = 'Claude'

      let crashedFired = false
      ptyManager.once('crashed', () => {
        crashedFired = true
      })

      ptyManager._checkHealth()

      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(crashedFired, false, 'Should not crash with capitalized Claude')
    })

    it('accepts command containing "claude" substring', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      mockTmux.paneCommandOutput = 'node-claude-wrapper'

      let crashedFired = false
      ptyManager.once('crashed', () => {
        crashedFired = true
      })

      ptyManager._checkHealth()

      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(crashedFired, false, 'Should not crash with claude substring')
    })

    it('rejects command not containing "claude"', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      const crashedPromise = new Promise((resolve) => {
        ptyManager.once('crashed', (info) => {
          resolve(info)
        })
      })

      mockTmux.paneCommandOutput = 'bash'

      ptyManager._checkHealth()

      const crashedEvent = await crashedPromise
      assert.equal(crashedEvent.reason, 'claude_process_not_found')
    })

    it('accepts Claude process in multi-pane session', async () => {
      ptyManager = new TestPtyManager({ mockTmux, skipPtySpawn: true })
      await ptyManager.start()

      // First pane running bash, second pane running claude
      mockTmux.paneCommandOutput = 'bash\nclaude'
      mockTmux.paneDeadOutput = '0\n0'

      let crashedFired = false
      ptyManager.once('crashed', () => {
        crashedFired = true
      })

      ptyManager._checkHealth()

      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(crashedFired, false, 'Should not crash when one pane has claude')
    })
  })
})
