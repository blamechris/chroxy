import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { writeFileRestricted } from './platform.js'
import { GIT } from './git.js'
import { createLogger } from './logger.js'

const log = createLogger('checkpoint')

const execFileAsync = promisify(execFileCb)

// Resolve at call time, not module-load time, so tests that set
// CHROXY_CONFIG_DIR in beforeEach are respected. Mirrors models.js and
// connection-info.js (#4633).
function defaultCheckpointsDir() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'checkpoints')
}
const MAX_CHECKPOINTS_PER_SESSION = 50

/**
 * Per-cwd async mutex map.
 * Prevents concurrent checkpoint operations (create/restore) on the same
 * working directory from interleaving git index/commit operations.
 */
const _cwdMutexes = new Map()

/**
 * Acquire an exclusive lock for the given cwd.
 * Returns a release function — caller MUST call it in a finally block.
 *
 * @param {string} cwd
 * @returns {Promise<() => void>}
 */
async function acquireCwdLock(cwd) {
  if (!_cwdMutexes.has(cwd)) {
    _cwdMutexes.set(cwd, Promise.resolve())
  }

  let release
  const next = new Promise((resolve) => { release = resolve })
  const current = _cwdMutexes.get(cwd)
  _cwdMutexes.set(cwd, next)

  await current
  return () => release()
}

/**
 * Manages checkpoint creation and restoration for session rewind.
 *
 * Each checkpoint captures:
 * - The SDK session (conversation) ID at that point in time
 * - A git snapshot ref for the file state (if in a git repo)
 * - Metadata: timestamp, name, description, message count
 *
 * Git snapshots are stored as plain commit objects (not stash entries).
 * This avoids touching the shared stash stack, making concurrent sessions
 * in the same repository safe.
 *
 * Rewind creates a new session that resumes from the checkpoint's
 * conversation ID, effectively branching the conversation.
 */
export class CheckpointManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.checkpointsDir] - Override the on-disk directory
   *   for checkpoint state files. Defaults to `$CHROXY_CONFIG_DIR/checkpoints`
   *   (or `~/.chroxy/checkpoints` when unset). Tests should pass a tmp
   *   directory (or set `CHROXY_CONFIG_DIR`) to avoid contaminating the
   *   developer's real state (#4633).
   */
  constructor(options = {}) {
    super()
    this._checkpoints = new Map() // sessionId -> Checkpoint[]
    this._counters = new Map() // sessionId -> monotonic counter for default names
    this._checkpointsDir = options.checkpointsDir || defaultCheckpointsDir()
    this._ensureDir()
  }

  _ensureDir() {
    if (!existsSync(this._checkpointsDir)) {
      mkdirSync(this._checkpointsDir, { recursive: true })
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
    let evictedCwd = null
    if (checkpoints.length >= MAX_CHECKPOINTS_PER_SESSION) {
      const evicted = checkpoints.shift()
      if (evicted?.gitRef) {
        evictedCwd = evicted.cwd
        this._deleteGitRef(evicted.cwd, evicted.gitRef).catch((err) => {
          log.warn(`Failed to delete evicted git ref ${evicted.gitRef}: ${err.message} (non-critical, orphaned ref)`)
        })
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
      const release = await acquireCwdLock(cwd)
      try {
        checkpoint.gitRef = await this._createGitSnapshot(cwd, checkpoint.id)
      } finally {
        release()
      }
    }

    checkpoints.push(checkpoint)
    this._counters.set(sessionId, (this._counters.get(sessionId) || 0) + 1)
    this._checkpoints.set(sessionId, checkpoints)
    this._persist(sessionId)

    // #5335: after an eviction (the moment an orphan can be born if the
    // best-effort `git tag -d` above failed), sweep any stray refs. Runs after
    // the new checkpoint is in-memory + persisted, so its ref counts as live.
    // Fire-and-forget: never blocks or fails checkpoint creation.
    if (evictedCwd) {
      this.pruneOrphanedRefs(evictedCwd).catch((err) => {
        log.warn(`pruneOrphanedRefs failed for ${evictedCwd}: ${err.message}`)
      })
    }

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
      const release = await acquireCwdLock(checkpoint.cwd)
      try {
        await this._restoreGitSnapshot(checkpoint.cwd, checkpoint.gitRef)
      } finally {
        release()
      }
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
      this._deleteGitRef(checkpoint.cwd, checkpoint.gitRef).catch((err) => {
        log.warn(`Failed to delete git ref ${checkpoint.gitRef}: ${err.message} (non-critical, orphaned ref)`)
      })
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
        this._deleteGitRef(cp.cwd, cp.gitRef).catch((err) => {
          log.warn(`Failed to delete git ref ${cp.gitRef}: ${err.message} (non-critical, orphaned ref)`)
        })
      }
    }
    this._checkpoints.delete(sessionId)

    const file = join(this._checkpointsDir, `${sessionId}.json`)
    if (existsSync(file)) {
      try { unlinkSync(file) } catch { /* ignore */ }
    }
  }

  // -- Git operations --

  async _isGitRepo(cwd) {
    try {
      await execFileAsync(GIT, ['rev-parse', '--is-inside-work-tree'], { cwd })
      return true
    } catch {
      return false
    }
  }

  /**
   * Create a snapshot of the current working tree state using a plain commit
   * object, without touching the shared git stash stack.
   *
   * Strategy:
   *   1. If the working tree is clean, tag HEAD directly.
   *   2. Otherwise:
   *      a. Capture the current index state via `git write-tree`.
   *      b. Stage everything (tracked + untracked) with `git add -A`.
   *      c. Create a snapshot commit object via `git commit-tree` (no branch
   *         or ref is updated — the commit is dangling until we tag it).
   *      d. Tag the snapshot commit SHA.
   *      e. Restore the pre-snapshot index with `git read-tree` so the
   *         working tree is left exactly as it was.
   *
   * This never modifies refs/stash, so concurrent sessions operating on the
   * same repository cannot corrupt each other. The per-cwd mutex in the
   * caller serialises the git index operations within this process.
   */
  async _createGitSnapshot(cwd, checkpointId) {
    const tagName = `chroxy-checkpoint/${checkpointId}`

    try {
      const { stdout: status } = await execFileAsync(
        GIT, ['status', '--porcelain'],
        { cwd }
      )

      if (!status.trim()) {
        // Working tree is clean — tag HEAD directly
        await execFileAsync(GIT, ['tag', tagName, 'HEAD'], { cwd })
        return tagName
      }

      // Capture the current index so we can restore it afterwards
      const { stdout: savedIndexTree } = await execFileAsync(
        GIT, ['write-tree'],
        { cwd }
      )

      // Stage everything including untracked files
      await execFileAsync(GIT, ['add', '-A'], { cwd })

      // Write the full working tree as a tree object
      const { stdout: snapshotTree } = await execFileAsync(
        GIT, ['write-tree'],
        { cwd }
      )

      // Create a dangling commit from the snapshot tree
      const { stdout: snapshotSha } = await execFileAsync(
        GIT, ['commit-tree', snapshotTree.trim(), '-p', 'HEAD', '-m', `chroxy-snapshot/${checkpointId}`],
        { cwd }
      )

      // Tag the snapshot commit for stable retrieval
      await execFileAsync(GIT, ['tag', tagName, snapshotSha.trim()], { cwd })

      // Restore the pre-snapshot index (leaves working tree untouched)
      await execFileAsync(GIT, ['read-tree', savedIndexTree.trim()], { cwd })

      return tagName
    } catch (err) {
      // Best-effort: restore the index if something went wrong mid-way
      try { await execFileAsync(GIT, ['reset', 'HEAD'], { cwd }) } catch { /* ignore */ }
      log.warn(`Failed to create git snapshot: ${err.message}`)
      return null
    }
  }

  /**
   * Restore file state from a git snapshot tag.
   *
   * The snapshot is a plain commit whose tree captures the full working-tree
   * state at checkpoint time (tracked + untracked files). Restoring it is a
   * two-step process:
   *
   *   1. Stash any current uncommitted changes so they are not lost (using
   *      `git stash push` here is intentional and safe because this is a
   *      user-initiated rewind operation where only one restore runs at a
   *      time under the per-cwd mutex).
   *   2. Resolve the tag to its commit SHA and use `git checkout <sha> -- .`
   *      to overwrite all files in the working tree with the snapshot state.
   */
  async _restoreGitSnapshot(cwd, gitRef) {
    // #5335: we auto-stash the user's pending changes BEFORE resolving the tag.
    // If anything after the stash fails (e.g. a corrupt/missing ref), the work
    // would be silently orphaned in a stash. Track whether we stashed so the
    // catch can put it back instead of leaving the user wedged.
    let stashed = false
    try {
      // Stash any pending changes before restoring
      const { stdout: status } = await execFileAsync(
        GIT, ['status', '--porcelain'],
        { cwd }
      )

      if (status.trim()) {
        await execFileAsync(GIT, ['stash', 'push', '-u', '-m', 'chroxy: auto-stash before rewind'], { cwd })
        stashed = true
      }

      // Resolve the tag to the snapshot commit SHA
      const { stdout: snapshotSha } = await execFileAsync(
        GIT, ['rev-parse', gitRef],
        { cwd }
      )
      const { stdout: headCommit } = await execFileAsync(
        GIT, ['rev-parse', 'HEAD'],
        { cwd }
      )

      const resolvedSha = snapshotSha.trim()
      if (resolvedSha === headCommit.trim()) {
        // Tag points to HEAD — working tree is already at the correct state.
        // Restore the stash we took so the user's pending changes survive a
        // no-op rewind.
        if (stashed) await execFileAsync(GIT, ['stash', 'pop'], { cwd })
        return
      }

      // Checkout all files from the snapshot commit tree into the working tree.
      // This handles both tracked modifications and files that were untracked
      // at checkpoint time (they were staged and committed into the snapshot).
      await execFileAsync(GIT, ['checkout', resolvedSha, '--', '.'], { cwd })
    } catch (err) {
      log.warn(`Failed to restore git snapshot: ${err.message}`)
      // #5335: don't strand the auto-stashed changes. The common failure mode
      // is a corrupt/missing ref, which throws at rev-parse BEFORE any checkout
      // ran — so the tree is clean and the stash pops back cleanly.
      if (stashed) {
        try {
          await execFileAsync(GIT, ['stash', 'pop'], { cwd })
        } catch (popErr) {
          // Pop failed (rare: a conflicting checkout ran before the failure).
          // Point the user at the stash so the work isn't lost.
          throw new Error(
            `Git restore failed: ${err.message}. Your pending changes were auto-stashed but could not be re-applied (${popErr.message}) — recover them with \`git stash list\` / \`git stash pop\` (message: "chroxy: auto-stash before rewind")`
          )
        }
        // Pop succeeded — the user's working state is intact.
        throw new Error(`Git restore failed: ${err.message} (your pending changes were preserved)`)
      }
      throw new Error(`Git restore failed: ${err.message}`)
    }
  }

  async _deleteGitRef(cwd, gitRef) {
    try {
      await execFileAsync(GIT, ['tag', '-d', gitRef], { cwd })
    } catch { /* tag may already be gone */ }
  }

  // #5335: the eviction / delete / clear paths only log a warning when
  // `git tag -d` fails, so a transient failure leaks a `chroxy-checkpoint/*`
  // tag forever. Build the set of refs still referenced by a live checkpoint
  // for `cwd`, from BOTH the on-disk checkpoint files AND the in-memory map
  // (a just-created checkpoint is pushed in-memory before it is persisted).
  // Reading every persisted file is what makes this safe across sessions this
  // manager hasn't loaded — without it, pruning could delete an unloaded
  // session's live ref. (Single-daemon model: one process owns the repo.)
  _liveRefsForCwd(cwd) {
    const live = new Set()
    // In-memory (covers the create-before-persist window).
    for (const list of this._checkpoints.values()) {
      for (const cp of list) {
        if (cp?.gitRef && cp.cwd === cwd) live.add(cp.gitRef)
      }
    }
    // On-disk (covers sessions not loaded into this._checkpoints).
    let files = []
    try { files = readdirSync(this._checkpointsDir).filter((f) => f.endsWith('.json')) } catch { return live }
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(this._checkpointsDir, file), 'utf8'))
        for (const cp of data?.checkpoints || []) {
          if (cp?.gitRef && cp.cwd === cwd) live.add(cp.gitRef)
        }
      } catch { /* skip unreadable / corrupt file */ }
    }
    return live
  }

  /**
   * Prune `chroxy-checkpoint/*` tags in `cwd` that no live checkpoint
   * references. Best-effort: never throws, never deletes a ref still in use.
   * @param {string} cwd
   * @returns {Promise<number>} number of orphaned refs pruned
   */
  async pruneOrphanedRefs(cwd) {
    if (!(await this._isGitRepo(cwd))) return 0
    let tags = []
    try {
      const { stdout } = await execFileAsync(GIT, ['tag', '-l', 'chroxy-checkpoint/*'], { cwd })
      tags = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch (err) {
      log.warn(`pruneOrphanedRefs: failed to list tags in ${cwd}: ${err.message}`)
      return 0
    }
    if (tags.length === 0) return 0
    const live = this._liveRefsForCwd(cwd)
    let pruned = 0
    for (const tag of tags) {
      if (!live.has(tag)) {
        await this._deleteGitRef(cwd, tag)
        pruned++
      }
    }
    if (pruned > 0) log.info(`Pruned ${pruned} orphaned checkpoint ref(s) in ${cwd}`)
    return pruned
  }

  // -- Persistence --

  _getCheckpoints(sessionId) {
    if (!this._checkpoints.has(sessionId)) {
      this._load(sessionId)
    }
    return this._checkpoints.get(sessionId) || []
  }

  _load(sessionId) {
    const file = join(this._checkpointsDir, `${sessionId}.json`)
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
    const file = join(this._checkpointsDir, `${sessionId}.json`)
    const data = { version: 1, checkpoints: this._getCheckpoints(sessionId) }
    try {
      writeFileRestricted(file, JSON.stringify(data, null, 2))
    } catch (err) {
      log.warn(`Failed to persist checkpoint: ${err.message}`)
    }
  }
}
