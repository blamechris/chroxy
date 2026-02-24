import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'

/**
 * Manages Claude Code Web tasks (cloud sandbox delegation).
 *
 * Web tasks are fire-and-forget cloud operations launched via the `&` prefix.
 * Unlike sessions, they run in Anthropic's infrastructure, not locally.
 *
 * Lifecycle: pending → running → completed | failed
 *
 * Feature detection:
 *   Parses `claude --help` at startup to check for `--remote` and `--teleport`
 *   flags. When unavailable, launchTask() returns a clear error message.
 *   Re-detection can be triggered manually (e.g. after CLI upgrade).
 *
 * Events:
 *   task_created  { task }           - New task launched
 *   task_updated  { task }           - Task status changed
 *   task_error    { taskId, message } - Task failed or launch error
 */

const POLL_INTERVAL_MS = 10_000 // 10s between status checks
const MAX_TASKS = 100 // evict oldest completed/failed tasks beyond this
const MAX_POLL_COUNT = 60 // 60 polls × 10s = 10 min max poll duration

export class WebTaskManager extends EventEmitter {
  constructor({ cwd } = {}) {
    super()
    this._cwd = cwd || process.cwd()
    this._tasks = new Map()
    this._childProcesses = new Set()
    this._remoteAvailable = false
    this._teleportAvailable = false
    this._detected = false
    this._pollTimer = null
    this._pollCount = 0
  }

  /** Whether the CLI supports --remote (web task launch) */
  get isAvailable() {
    return this._remoteAvailable
  }

  /** Whether the CLI supports --teleport (pull cloud work locally) */
  get teleportAvailable() {
    return this._teleportAvailable
  }

  /** Whether feature detection has completed */
  get detected() {
    return this._detected
  }

  /**
   * Detect available CLI features by parsing `claude --help`.
   * Safe to call multiple times (e.g. after CLI upgrade).
   */
  async detectFeatures() {
    try {
      const stdout = await execFileAsync('claude', ['--help'])
      this._remoteAvailable = stdout.includes('--remote')
      this._teleportAvailable = stdout.includes('--teleport')
    } catch {
      this._remoteAvailable = false
      this._teleportAvailable = false
    }
    this._detected = true
    return {
      remote: this._remoteAvailable,
      teleport: this._teleportAvailable,
    }
  }

  /**
   * Get the feature status object for WS broadcast.
   */
  getFeatureStatus() {
    return {
      available: this._remoteAvailable,
      remote: this._remoteAvailable,
      teleport: this._teleportAvailable,
    }
  }

  /**
   * Launch a cloud task.
   * @param {string} prompt - Task description
   * @param {Object} [opts]
   * @param {string} [opts.cwd] - Working directory context
   * @returns {{ taskId: string, task: Object }}
   * @throws {Error} if feature not available
   */
  launchTask(prompt, { cwd } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Task prompt is required')
    }

    if (!this._remoteAvailable) {
      throw new WebTaskUnavailableError()
    }

    const taskId = randomUUID()
    const task = {
      taskId,
      prompt: prompt.trim(),
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
      error: null,
      cwd: cwd || this._cwd,
    }

    this._tasks.set(taskId, task)
    this._evictIfNeeded()
    this.emit('task_created', { ...task })

    // Spawn the remote process
    this._spawnRemoteTask(task)

    return { taskId, task: { ...task } }
  }

  /**
   * List all tracked tasks.
   * @returns {Array<Object>}
   */
  listTasks() {
    return [...this._tasks.values()].map(t => ({ ...t }))
  }

  /**
   * Get a single task by ID.
   * @param {string} taskId
   * @returns {Object|null}
   */
  getTask(taskId) {
    const task = this._tasks.get(taskId)
    return task ? { ...task } : null
  }

  /**
   * Teleport a completed cloud task into a local session.
   * @param {string} taskId
   * @throws {Error} if teleport not available or task not found
   */
  async teleportTask(taskId) {
    if (!this._teleportAvailable) {
      throw new Error('Claude CLI --teleport flag is not available. Update your CLI to enable this feature.')
    }

    const task = this._tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    try {
      const stdout = await execFileAsync('claude', ['--teleport', task.taskId], { cwd: task.cwd })
      return { success: true, output: stdout }
    } catch (err) {
      throw new Error(`Teleport failed: ${err.message}`)
    }
  }

  /**
   * Evict oldest completed/failed tasks when map exceeds MAX_TASKS.
   * @private
   */
  _evictIfNeeded() {
    if (this._tasks.size <= MAX_TASKS) return

    const terminal = [...this._tasks.values()]
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => a.updatedAt - b.updatedAt)

    while (this._tasks.size > MAX_TASKS && terminal.length > 0) {
      this._tasks.delete(terminal.shift().taskId)
    }
  }

  /**
   * Spawn the remote CLI process for a task.
   * @private
   */
  _spawnRemoteTask(task) {
    // Use execFile with args array to prevent command injection
    const child = execFile('claude', ['--remote', task.prompt], { cwd: task.cwd, timeout: 300_000 }, (err, stdout, stderr) => {
      this._childProcesses.delete(child)

      if (err) {
        task.status = 'failed'
        task.error = err.message || stderr || 'Unknown error'
        task.updatedAt = Date.now()
        this.emit('task_updated', { ...task })
        this.emit('task_error', { taskId: task.taskId, message: task.error })
        return
      }

      // Parse task ID from CLI output if available
      const remoteIdMatch = stdout.match(/task[:\s]+([a-zA-Z0-9-]+)/i)
      if (remoteIdMatch) {
        task.remoteTaskId = remoteIdMatch[1]
      }

      task.status = 'running'
      task.updatedAt = Date.now()
      this.emit('task_updated', { ...task })

      // Start polling if not already
      this._startPolling()
    })

    this._childProcesses.add(child)
  }

  /**
   * Start periodic polling for running task statuses.
   * @private
   */
  _startPolling() {
    if (this._pollTimer) return

    this._pollCount = 0
    this._pollTimer = setInterval(() => {
      this._pollTaskStatus()
    }, POLL_INTERVAL_MS)
  }

  /**
   * Stop polling.
   * @private
   */
  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  }

  /**
   * Poll for status updates on running tasks.
   * @private
   */
  async _pollTaskStatus() {
    this._pollCount++

    const running = [...this._tasks.values()].filter(t => t.status === 'running')
    if (running.length === 0) {
      this._stopPolling()
      return
    }

    // Fail running tasks after max polls to prevent indefinite timers
    if (this._pollCount >= MAX_POLL_COUNT) {
      for (const task of running) {
        task.status = 'failed'
        task.error = 'Task timed out waiting for status update'
        task.updatedAt = Date.now()
        this.emit('task_updated', { ...task })
        this.emit('task_error', { taskId: task.taskId, message: task.error })
      }
      this._stopPolling()
      return
    }

    // When CLI support arrives, this will call `claude /tasks` or similar
    // For now, this is a placeholder that will be implemented when the CLI ships
  }

  /**
   * Clean up timers and state.
   */
  destroy() {
    this._stopPolling()
    // Kill any in-flight child processes
    for (const child of this._childProcesses) {
      try { child.kill() } catch {}
    }
    this._childProcesses.clear()
    this._tasks.clear()
    this.removeAllListeners()
  }
}

/**
 * Error thrown when web task features are not available.
 */
export class WebTaskUnavailableError extends Error {
  constructor() {
    super('Claude Code Web requires Claude CLI with --remote support. Update your Claude CLI to enable this feature.')
    this.name = 'WebTaskUnavailableError'
    this.code = 'WEB_TASK_UNAVAILABLE'
  }
}

/**
 * Promisified execFile helper (no shell — safe from injection).
 * @private
 */
function execFileAsync(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, ...opts }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}
