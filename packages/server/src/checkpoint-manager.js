import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'
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
 * The manager owns the git snapshot and the checkpoint metadata only. It does
 * NOT branch the conversation itself — that is decided at restore time by the
 * WS handler based on the session's provider (#6766): for a fork-capable
 * provider (the SDK, via `forkSession`/`upToMessageId`) restore forks the
 * conversation truncated to the checkpoint's `boundaryMessageId`, so the
 * rewound session's transcript stops at the checkpoint. For providers that
 * cannot truncate a resumed transcript the restore is files-only. The
 * `boundaryMessageId` captured here is what makes that truncation possible.
 *
 * #6767: selective restore (files / conversation / both) is orchestrated by the
 * WS handler, not this manager. `restoreCheckpoint` always performs the git
 * restore (used for the 'files' and 'both' modes); the 'conversation'-only mode
 * reads the checkpoint via `getCheckpoint` instead so the working tree is left
 * untouched. Either way the returned record carries `resumeSessionId` +
 * `boundaryMessageId` for the handler's fork decision.
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
    // #5335: refs whose `git tag -d` failed (cwd -> Set<gitRef>). These are
    // KNOWN orphans — the checkpoint they backed was already removed — so they
    // can be retried later without any speculative "is this tag still live?"
    // guess (which would race in-flight tag creation and, since tags are
    // repo-global, delete a sibling worktree's live ref).
    this._failedRefDeletes = new Map()
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
   * @param {string} [params.boundaryMessageId] - #6766: the SDK transcript UUID
   *   marking this checkpoint's conversation boundary. When present (SDK
   *   provider), restore forks the conversation truncated up to and including
   *   this message; absent → the restore is files-only for this checkpoint.
   * @returns {Promise<object>} The created checkpoint
   */
  async createCheckpoint({ sessionId, resumeSessionId, cwd, name, description, messageCount, boundaryMessageId }) {
    const checkpoints = this._getCheckpoints(sessionId)

    // Enforce max checkpoints — remove oldest if at limit
    let evictedCwd = null
    if (checkpoints.length >= MAX_CHECKPOINTS_PER_SESSION) {
      const evicted = checkpoints.shift()
      if (evicted?.gitRef) {
        evictedCwd = evicted.cwd
        this._deleteGitRefTracked(evicted.cwd, evicted.gitRef)
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
      // #6766: fork boundary for a true conversation rewind at restore. Stored
      // as null when the provider can't supply one (subprocess providers) so a
      // restore of that checkpoint honestly degrades to files-only.
      boundaryMessageId: typeof boundaryMessageId === 'string' && boundaryMessageId ? boundaryMessageId : null,
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
    // #5731 (T3): the checkpoint exists in memory and is returned to the client,
    // but if the disk write failed it'll be gone on restart — surface that so the
    // user isn't told their rewind point is saved when it isn't.
    if (!this._persist(sessionId)) {
      this.emit('checkpoint_persist_failed', { sessionId, checkpointId: checkpoint.id, operation: 'create' })
    }

    // #5335: opportunistically retry any refs whose delete previously failed
    // for this cwd, so transient `git tag -d` failures don't accrue. Race-free
    // (only known orphans are retried) and fire-and-forget — never blocks or
    // fails checkpoint creation.
    if (evictedCwd) {
      this.retryFailedRefDeletes(evictedCwd).catch((err) => {
        log.warn(`retryFailedRefDeletes failed for ${evictedCwd}: ${err.message}`)
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
   *
   * This restores the working tree only. The conversation side of a rewind is
   * the WS restore handler's responsibility (#6766): it reads the returned
   * `resumeSessionId` + `boundaryMessageId` and, for a fork-capable provider,
   * forks the conversation truncated to the boundary; otherwise it resumes
   * files-only. Kept here so the git snapshot and the conversation decision stay
   * decoupled across providers.
   * @param {string} sessionId
   * @param {string} checkpointId
   * @returns {Promise<object>} The checkpoint data (including resumeSessionId
   *   and boundaryMessageId)
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
      this._deleteGitRefTracked(checkpoint.cwd, checkpoint.gitRef)
    }

    checkpoints.splice(idx, 1)
    this._checkpoints.set(sessionId, checkpoints)
    // #5731 (T3): a failed write here means the deleted checkpoint reappears on
    // restart — surface it rather than silently "deleting" something that comes back.
    if (!this._persist(sessionId)) {
      this.emit('checkpoint_persist_failed', { sessionId, checkpointId, operation: 'delete' })
    }
  }

  /**
   * Remove all checkpoints for a session.
   * @param {string} sessionId
   */
  clearCheckpoints(sessionId) {
    const checkpoints = this._getCheckpoints(sessionId)
    for (const cp of checkpoints) {
      if (cp.gitRef) {
        this._deleteGitRefTracked(cp.cwd, cp.gitRef)
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
        // Leave the auto-stash parked, exactly like the checkout success path
        // below: "restore to checkpoint" sets the user's pending changes aside
        // (recoverable via the stash) rather than re-applying them over the
        // restored state.
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

  // Delete a checkpoint's git tag. Returns true if the tag is gone afterwards
  // (deleted now, or already absent), false if the delete genuinely failed
  // (e.g. a transient lock) so the caller can record it for retry.
  async _deleteGitRef(cwd, gitRef) {
    try {
      await execFileAsync(GIT, ['tag', '-d', gitRef], { cwd })
      return true
    } catch (err) {
      // "tag '...' not found" → already gone; treat as success.
      if (/not found|No such|unknown tag/i.test(err.message || '')) return true
      return false
    }
  }

  // #5335: best-effort delete of a checkpoint's ref that records the ref for a
  // later retry if the delete fails, so a transient `git tag -d` failure does
  // not leak a `chroxy-checkpoint/*` tag forever.
  _deleteGitRefTracked(cwd, gitRef) {
    this._deleteGitRef(cwd, gitRef).then((ok) => {
      if (!ok) {
        this._recordFailedRefDelete(cwd, gitRef)
        log.warn(`Failed to delete git ref ${gitRef} (recorded for retry)`)
      }
    })
  }

  _recordFailedRefDelete(cwd, gitRef) {
    if (!this._failedRefDeletes.has(cwd)) this._failedRefDeletes.set(cwd, new Set())
    this._failedRefDeletes.get(cwd).add(gitRef)
  }

  /**
   * Retry deleting refs whose previous delete failed for `cwd`. Race-free: only
   * KNOWN orphans (a checkpoint we already removed) are retried — never a
   * speculative classification of a repo-global tag — so this can never delete
   * an in-flight or sibling-worktree checkpoint's ref.
   * @param {string} cwd
   * @returns {Promise<number>} number of orphaned refs successfully cleared
   */
  async retryFailedRefDeletes(cwd) {
    const set = this._failedRefDeletes.get(cwd)
    if (!set || set.size === 0) return 0
    let cleared = 0
    for (const ref of [...set]) {
      if (await this._deleteGitRef(cwd, ref)) { set.delete(ref); cleared++ }
    }
    if (set.size === 0) this._failedRefDeletes.delete(cwd)
    if (cleared > 0) log.info(`Cleared ${cleared} previously-orphaned checkpoint ref(s) in ${cwd}`)
    return cleared
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

  // #5731 (T3): returns true on success, false if the write failed (disk full,
  // locked file, read-only home). Callers emit `checkpoint_persist_failed` on
  // false so the user is told their checkpoint wasn't durable instead of believing
  // it was — the same silent-loss class fixed for session state in #5714.
  _persist(sessionId) {
    const file = join(this._checkpointsDir, `${sessionId}.json`)
    const data = { version: 1, checkpoints: this._getCheckpoints(sessionId) }
    try {
      writeFileRestricted(file, JSON.stringify(data, null, 2))
      return true
    } catch (err) {
      log.warn(`Failed to persist checkpoint for ${sessionId}: ${err.message}`)
      return false
    }
  }
}
