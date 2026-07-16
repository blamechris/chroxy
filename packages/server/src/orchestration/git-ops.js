/**
 * Git operations for the orchestration write path (epic #6691, step E-3).
 *
 * The safety primitives behind write-capable workers: create a per-subtask
 * branch in a worker's worktree, compute a capped review diff, auto-commit
 * before any teardown (so uncommitted work is never lost), and merge accepted
 * branches sequentially into a run-owned integration worktree. Landing the
 * result (into the user's branch, or a push) is ALWAYS a human action — this
 * module never touches the user's working tree, never checks out or merges into
 * the user's branch, and never contacts a remote.
 *
 * Hard rules baked in here:
 *  - Every git call is `execFile(GIT, [...args])` — never a shell string, so a
 *    branch name / path / conflict-file list can never inject a command.
 *  - `GIT` is the resolved binary (a bare 'git' is ENOENT under launchd's
 *    minimal PATH).
 *  - `worktree remove --force` + an rm fallback are used ONLY on orchestrator-
 *    owned worktrees under the injected worktrees root; user-adjacent
 *    reclamation is the GC reaper's job, not this module's.
 *  - Expected git failure modes (a merge conflict, a clean tree, a missing
 *    branch) are returned as structured results, not thrown.
 *
 * All collaborators (git binary, clock, fs, worktrees root) are injected via
 * `createGitOps(...)` so the suite can drive it against temp repos.
 */

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { GIT } from '../git.js'

const execFileAsync = promisify(execFileCb)

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024 // git diff of a large subtask can be big; we cap what we KEEP separately

// Orchestrator commit identity — the daemon env has no configured git identity,
// so a bare `git commit` would fail. Passed per-invocation via `-c`, never
// written to any user config.
const ORCH_IDENTITY = { name: 'chroxy-orch', email: 'orch@chroxy.local' }

/** ~/.chroxy (honoring CHROXY_CONFIG_DIR), matching the rest of the daemon. */
export function configDir() {
  return process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

/** The root the orphan sweep and the provisioner MUST agree on. Never `runs/`. */
export function defaultWorktreesRoot() {
  return join(configDir(), 'orchestration', 'worktrees')
}

export class GitOpsError extends Error {
  constructor(message, { args = null, stderr = null } = {}) {
    super(message)
    this.name = 'GitOpsError'
    this.code = 'GIT_OP_FAILED'
    this.args = args
    this.stderr = stderr
  }
}

export function createGitOps({ git = GIT, now = () => Date.now(), worktreesRoot = null, identity = ORCH_IDENTITY, fs = { rmSync, mkdirSync, existsSync } } = {}) {
  const gitBin = () => git
  const rootDir = () => worktreesRoot || defaultWorktreesRoot()

  const errText = (err) => (err?.stderr?.trim?.() || err?.message || String(err))

  // Run git; resolve { stdout, stderr } on success. On failure, resolve a
  // structured { failed:true, stderr, code } so callers can branch on expected
  // failure modes instead of try/catch everywhere.
  const run = async (args, { timeout = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) => {
    try {
      const { stdout, stderr } = await execFileAsync(gitBin(), args, { timeout, maxBuffer })
      return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' }
    } catch (err) {
      return { ok: false, stdout: err?.stdout ?? '', stderr: errText(err), code: err?.code ?? null }
    }
  }
  // Run git; THROW on failure. For ops where a failure is genuinely unexpected.
  const runOrThrow = async (args, opts) => {
    const r = await run(args, opts)
    if (!r.ok) throw new GitOpsError(`git ${args.join(' ')} failed: ${r.stderr}`, { args, stderr: r.stderr })
    return r
  }

  // --- path single-source-of-truth ----------------------------------------

  const orchestrationWorktreesRoot = () => rootDir()
  const runWorktreesDir = (runId) => join(rootDir(), String(runId))
  const integrationWorktreePath = (runId) => join(rootDir(), String(runId), 'integration')

  // --- branch + HEAD -------------------------------------------------------

  const captureHead = async (dir) => {
    const r = await runOrThrow(['-C', dir, 'rev-parse', 'HEAD'])
    return { sha: r.stdout.trim() }
  }

  // A worker worktree is created DETACHED at HEAD; put it on a named branch.
  const createBranch = async (worktreePath, branchName) => {
    const base = await captureHead(worktreePath)
    await runOrThrow(['-C', worktreePath, 'switch', '-c', branchName])
    return { branch: branchName, baseSha: base.sha }
  }

  const branchExists = async (repoDir, branchName) => {
    const r = await run(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`])
    return { exists: r.ok }
  }

  const deleteBranch = async (repoDir, branchName) => {
    const r = await run(['-C', repoDir, 'branch', '-D', branchName])
    return { deleted: r.ok }
  }

  // --- capped diff ---------------------------------------------------------

  // A reproducible, size-bounded review artifact: baseSha..headRef, per-file
  // and total byte caps with explicit truncation markers so a small worker
  // model isn't handed a 2MB patch.
  const computeCappedDiff = async ({ repoDir, baseSha, headRef = 'HEAD', maxBytes = 65_536, maxFileBytes = 8_192 }) => {
    const statR = await run(['-C', repoDir, 'diff', '--stat', `${baseSha}..${headRef}`])
    const patchR = await run(['-C', repoDir, 'diff', `${baseSha}..${headRef}`])
    const stat = statR.ok ? statR.stdout : ''
    const fullPatch = patchR.ok ? patchR.stdout : ''

    // Split into per-file sections on the `diff --git` boundary.
    const sections = []
    const re = /(^|\n)(diff --git [^\n]*\n)/g
    const indices = []
    let m
    while ((m = re.exec(fullPatch)) !== null) indices.push(m.index + (m[1] ? 1 : 0))
    if (indices.length === 0 && fullPatch) sections.push(fullPatch)
    for (let i = 0; i < indices.length; i += 1) {
      const start = indices[i]
      const end = i + 1 < indices.length ? indices[i + 1] : fullPatch.length
      sections.push(fullPatch.slice(start, end))
    }

    const fileNameOf = (section) => {
      const fm = section.match(/^diff --git a\/(.+?) b\/(.+?)\n/)
      return fm ? fm[2] : (section.split('\n', 1)[0] || 'unknown').slice(0, 200)
    }

    let out = ''
    let truncated = false
    const includedFiles = []
    const omittedFiles = []
    for (const section of sections) {
      const name = fileNameOf(section)
      // Whole-file omission once the total budget is exhausted.
      if (Buffer.byteLength(out, 'utf8') >= maxBytes) {
        truncated = true
        omittedFiles.push(name)
        continue
      }
      let piece = section
      if (Buffer.byteLength(piece, 'utf8') > maxFileBytes) {
        // Truncate on a char boundary at/below the byte budget.
        piece = piece.slice(0, maxFileBytes)
        const omittedBytes = Buffer.byteLength(section, 'utf8') - Buffer.byteLength(piece, 'utf8')
        piece += `\n// … ${omittedBytes} bytes omitted (file diff truncated)\n`
        truncated = true
      }
      // Total-budget check after per-file truncation.
      if (Buffer.byteLength(out + piece, 'utf8') > maxBytes) {
        truncated = true
        omittedFiles.push(name)
        continue
      }
      out += piece
      includedFiles.push(name)
    }
    if (omittedFiles.length) out += `\n// omitted files (diff too large): ${omittedFiles.join(', ')}\n`

    return { stat, patch: out, truncated, omittedFiles, includedFiles }
  }

  // --- auto-commit (the load-bearing safety primitive) ---------------------

  const isDirty = async (worktreePath) => {
    const r = await run(['-C', worktreePath, 'status', '--porcelain'])
    return { dirty: r.ok ? r.stdout.trim().length > 0 : false }
  }

  // Commit everything in a worker worktree. Called ALWAYS before destroying an
  // implement worker (destroySession removes the worktree, deleting uncommitted
  // work). A clean tree is a no-op, not an error.
  const autoCommit = async ({ worktreePath, subtaskId, message = null, identity: id = identity }) => {
    const { dirty } = await isDirty(worktreePath)
    if (!dirty) return { committed: false }
    await runOrThrow(['-C', worktreePath, 'add', '-A'])
    const msg = message || `chroxy-orch(${subtaskId}): auto-commit`
    await runOrThrow(['-C', worktreePath, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '-m', msg])
    const head = await captureHead(worktreePath)
    return { committed: true, sha: head.sha }
  }

  // --- integration worktree + sequential merge -----------------------------

  const createIntegrationWorktree = async ({ repoDir, runId, branchName, baseSha }) => {
    const worktreePath = integrationWorktreePath(runId)
    fs.mkdirSync(runWorktreesDir(runId), { recursive: true })
    await runOrThrow(['-C', repoDir, 'worktree', 'add', '-b', branchName, worktreePath, baseSha])
    return { worktreePath, branch: branchName }
  }

  const conflictFiles = async (integrationWorktree) => {
    const r = await run(['-C', integrationWorktree, 'diff', '--name-only', '--diff-filter=U'])
    return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  }

  const mergeNoFf = async ({ integrationWorktree, branch, subtaskId, identity: id = identity }) => {
    const r = await run(['-C', integrationWorktree, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`,
      'merge', '--no-ff', branch, '-m', `chroxy-orch: merge ${subtaskId}`])
    if (r.ok) return { ok: true }
    const files = await conflictFiles(integrationWorktree)
    if (files.length > 0 || /conflict/i.test(r.stderr) || /conflict/i.test(r.stdout)) {
      return { ok: false, conflict: true, conflictFiles: files, stderr: r.stderr }
    }
    // A non-conflict merge failure is genuinely unexpected.
    throw new GitOpsError(`merge ${branch} failed: ${r.stderr}`, { stderr: r.stderr })
  }

  const abortMerge = async (integrationWorktree) => {
    const r = await run(['-C', integrationWorktree, 'merge', '--abort'])
    return { aborted: r.ok }
  }

  // --- teardown + reconcile ------------------------------------------------

  // Remove an ORCHESTRATOR-OWNED worktree. --force is safe here BECAUSE the
  // path is one we created under the worktrees root; the rm fallback covers a
  // git that refuses (locked/partial). NEVER call this on a user worktree.
  const removeWorktree = async ({ repoDir, worktreePath }) => {
    const r = await run(['-C', repoDir, 'worktree', 'remove', '--force', worktreePath])
    if (r.ok) return { removed: true, method: 'git' }
    if (fs.existsSync(worktreePath)) {
      try { fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    return { removed: true, method: 'rm' }
  }

  const pruneWorktrees = async (repoDir) => {
    const r = await run(['-C', repoDir, 'worktree', 'prune'])
    return { pruned: r.ok }
  }

  // Parse `worktree list --porcelain` into { path, head, branch, detached }.
  const listWorktrees = async (repoDir) => {
    const r = await run(['-C', repoDir, 'worktree', 'list', '--porcelain'])
    if (!r.ok) return []
    const entries = []
    let cur = null
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length).trim(), head: null, branch: null, detached: false }; entries.push(cur) }
      else if (cur && line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length).trim()
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice('branch '.length).trim()
      else if (cur && line.trim() === 'detached') cur.detached = true
    }
    return entries
  }

  return {
    now,
    identity,
    configDir,
    orchestrationWorktreesRoot,
    runWorktreesDir,
    integrationWorktreePath,
    captureHead,
    createBranch,
    branchExists,
    deleteBranch,
    computeCappedDiff,
    isDirty,
    autoCommit,
    createIntegrationWorktree,
    mergeNoFf,
    abortMerge,
    removeWorktree,
    pruneWorktrees,
    listWorktrees,
  }
}
