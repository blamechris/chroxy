import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { writeFileRestricted } from './platform.js'

const execFileAsync = promisify(execFileCb)

const CHECKPOINTS_DIR = join(homedir(), '.chroxy', 'checkpoints')
const MAX_CHECKPOINTS_PER_SESSION = 50

/**
 * Manages checkpoint creation and restoration for session rewind.
 *
 * Each checkpoint captures:
 * - The SDK session (conversation) ID at that point in time
 * - A git stash ref for the file state (if in a git repo)
 * - Metadata: timestamp, name, description, message count
 *
 * Rewind creates a new session that resumes from the checkpoint's
 * conversation ID, effectively branching the conversation.
 */
export class CheckpointManager extends EventEmitter {
  constructor() {
    super()
    this._checkpoints = new Map() // sessionId -> Checkpoint[]
    this._counters = new Map() // sessionId -> monotonic counter for default names
    this._ensureDir()
  }

  _ensureDir() {
    if (!existsSync(CHECKPOINTS_DIR)) {
      mkdirSync(CHECKPOINTS_DIR, { recursive: true })
    }
  }

  /**
   * Create a checkpoint for a session.
   * @param {object} params
   * @param {string} params.sessionId - The Chroxy session ID
   * @param {string} params.resumeSessionId - The SDK conversation ID at this point
   * @param {string} params.cwd - Working directory for git operations
   * @param {string} [params.name] - User-provided checkpoint name
   * @param {string} [params.description] - Auto-generated description (e.g., last message)
   * @param {number} [params.messageCount] - Number of messages at checkpoint time
   * @returns {Promise<object>} The created checkpoint
   */
  async createCheckpoint({ sessionId, resumeSessionId, cwd, name, description, messageCount }) {
    const checkpoints = this._getCheckpoints(sessionId)

    // Enforce max checkpoints — remove oldest if at limit
    if (checkpoints.length >= MAX_CHECKPOINTS_PER_SESSION) {
      const evicted = checkpoints.shift()
      if (evicted?.gitRef) {
        this._deleteGitRef(evicted.cwd, evicted.gitRef).catch(() => {})
      }
    }

    const checkpoint = {
      id: randomUUID(),
      sessionId,
      resumeSessionId,
      cwd,
      name: name || `Checkpoint ${(this._counters.get(sessionId) || 0) + 1}`,
      description: description || '',
      messageCount: messageCount || 0,
      createdAt: Date.now(),
      gitRef: null,
    }

    // Capture git state if in a git repo
    const isGit = await this._isGitRepo(cwd)
    if (isGit) {
      checkpoint.gitRef = await this._createGitSnapshot(cwd, checkpoint.id)
    }

    checkpoints.push(checkpoint)
    this._counters.set(sessionId, (this._counters.get(sessionId) || 0) + 1)
    this._checkpoints.set(sessionId, checkpoints)
    this._persist(sessionId)

    this.emit('checkpoint_created', checkpoint)
    return checkpoint
  }

  /**
   * List checkpoints for a session.
   * @param {string} sessionId
   * @returns {object[]} Array of checkpoints (newest last)
   */
  listCheckpoints(sessionId) {
    return this._getCheckpoints(sessionId).map((cp) => ({
      id: cp.id,
      name: cp.name,
      description: cp.description,
      messageCount: cp.messageCount,
      createdAt: cp.createdAt,
      hasGitSnapshot: !!cp.gitRef,
    }))
  }

  /**
   * Get a checkpoint by ID.
   * @param {string} sessionId
   * @param {string} checkpointId
   * @returns {object|null}
   */
  getCheckpoint(sessionId, checkpointId) {
    return this._getCheckpoints(sessionId).find((cp) => cp.id === checkpointId) || null
  }

  /**
   * Restore file state from a checkpoint's git snapshot.
   * Does NOT restore conversation state — that requires creating a new session
   * with the checkpoint's resumeSessionId (handled by session-manager).
   * @param {string} sessionId
   * @param {string} checkpointId
   * @returns {Promise<object>} The checkpoint data (including resumeSessionId)
   */
  async restoreCheckpoint(sessionId, checkpointId) {
    const checkpoint = this.getCheckpoint(sessionId, checkpointId)
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }

    // Restore git state if snapshot exists
    if (checkpoint.gitRef) {
      await this._restoreGitSnapshot(checkpoint.cwd, checkpoint.gitRef)
    }

    this.emit('checkpoint_restored', checkpoint)
    return checkpoint
  }

  /**
   * Delete a checkpoint.
   * @param {string} sessionId
   * @param {string} checkpointId
   */
  deleteCheckpoint(sessionId, checkpointId) {
    const checkpoints = this._getCheckpoints(sessionId)
    const idx = checkpoints.findIndex((cp) => cp.id === checkpointId)
    if (idx === -1) return

    const checkpoint = checkpoints[idx]

    // Clean up git ref if present
    if (checkpoint.gitRef) {
      this._deleteGitRef(checkpoint.cwd, checkpoint.gitRef).catch(() => {})
    }

    checkpoints.splice(idx, 1)
    this._checkpoints.set(sessionId, checkpoints)
    this._persist(sessionId)
  }

  /**
   * Remove all checkpoints for a session.
   * @param {string} sessionId
   */
  clearCheckpoints(sessionId) {
    const checkpoints = this._getCheckpoints(sessionId)
    for (const cp of checkpoints) {
      if (cp.gitRef) {
        this._deleteGitRef(cp.cwd, cp.gitRef).catch(() => {})
      }
    }
    this._checkpoints.delete(sessionId)

    const file = join(CHECKPOINTS_DIR, `${sessionId}.json`)
    if (existsSync(file)) {
      try { unlinkSync(file) } catch { /* ignore */ }
    }
  }

  // -- Git operations --

  async _isGitRepo(cwd) {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
      return true
    } catch {
      return false
    }
  }

  /**
   * Create a lightweight git tag as a snapshot.
   * Uses tags instead of stash because stashes are fragile
   * (easily lost with git stash drop, reorder, etc.).
   */
  async _createGitSnapshot(cwd, checkpointId) {
    const tagName = `chroxy-checkpoint/${checkpointId}`

    try {
      // Check if there are any changes (tracked or untracked) to capture
      const { stdout: status } = await execFileAsync(
        'git', ['status', '--porcelain'],
        { cwd }
      )

      if (!status.trim()) {
        // Working tree is clean — tag HEAD directly
        await execFileAsync('git', ['tag', tagName, 'HEAD'], { cwd })
        return tagName
      }

      // Use stash push to capture full state (including untracked files),
      // tag the stash entry, then drop it from the stack to avoid clutter.
      await execFileAsync(
        'git', ['stash', 'push', '--include-untracked', '-m', `chroxy-checkpoint/${checkpointId}`],
        { cwd }
      )
      await execFileAsync('git', ['tag', tagName, 'stash@{0}'], { cwd })
      // Pop the stash to restore the working tree to its pre-snapshot state
      await execFileAsync('git', ['stash', 'pop'], { cwd })
      return tagName
    } catch (err) {
      // If stash push succeeded but tag/pop failed, try to recover
      try { await execFileAsync('git', ['stash', 'pop'], { cwd }) } catch { /* best effort */ }
      console.warn(`[checkpoint] Failed to create git snapshot: ${err.message}`)
      return null
    }
  }

  async _restoreGitSnapshot(cwd, gitRef) {
    try {
      // First check if working tree has changes
      const { stdout: status } = await execFileAsync(
        'git', ['status', '--porcelain'],
        { cwd }
      )

      if (status.trim()) {
        // Stash current changes before restoring
        await execFileAsync('git', ['stash', 'push', '-m', 'chroxy: auto-stash before rewind'], { cwd })
      }

      // Check if tag points to HEAD (clean state at checkpoint)
      const { stdout: tagCommit } = await execFileAsync(
        'git', ['rev-parse', gitRef],
        { cwd }
      )
      const { stdout: headCommit } = await execFileAsync(
        'git', ['rev-parse', 'HEAD'],
        { cwd }
      )

      if (tagCommit.trim() === headCommit.trim()) {
        // Tag points to HEAD — restore was just the stash (already done above)
        return
      }

      // Restore files from the tagged stash to the working tree.
      // stash apply restores tracked + untracked files from the stash object.
      // Fall back to checkout if the ref is a plain commit (e.g., HEAD tag).
      try {
        await execFileAsync('git', ['stash', 'apply', gitRef], { cwd })
      } catch {
        await execFileAsync('git', ['checkout', gitRef, '--', '.'], { cwd })
      }
    } catch (err) {
      console.warn(`[checkpoint] Failed to restore git snapshot: ${err.message}`)
      throw new Error(`Git restore failed: ${err.message}`)
    }
  }

  async _deleteGitRef(cwd, gitRef) {
    try {
      await execFileAsync('git', ['tag', '-d', gitRef], { cwd })
    } catch { /* tag may already be gone */ }
  }

  // -- Persistence --

  _getCheckpoints(sessionId) {
    if (!this._checkpoints.has(sessionId)) {
      this._load(sessionId)
    }
    return this._checkpoints.get(sessionId) || []
  }

  _load(sessionId) {
    const file = join(CHECKPOINTS_DIR, `${sessionId}.json`)
    try {
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        this._checkpoints.set(sessionId, data.checkpoints || [])
      } else {
        this._checkpoints.set(sessionId, [])
      }
    } catch {
      this._checkpoints.set(sessionId, [])
    }
  }

  _persist(sessionId) {
    const file = join(CHECKPOINTS_DIR, `${sessionId}.json`)
    const data = { version: 1, checkpoints: this._getCheckpoints(sessionId) }
    try {
      writeFileRestricted(file, JSON.stringify(data, null, 2))
    } catch (err) {
      console.warn(`[checkpoint] Failed to persist: ${err.message}`)
    }
  }
}
