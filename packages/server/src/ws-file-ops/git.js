import { normalize, resolve, join, relative, sep } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { GIT } from '../git.js'
import { validateGitPath } from './common.js'
import { isPathWithin } from '../utils/path-containment.js'

const execFileAsync = promisify(execFileCb)

// #6876 — result sender for the git_create_pr flow. Every field is always
// present (present-and-nullable) so the wire payload satisfies
// ServerGitCreatePrResultSchema on every path. #6938 — `existingUrl` is a
// structured (non-null) field only on the "PR already exists" error path, so
// the dashboard can render it as a clickable link instead of parsing it back
// out of the `error` string.
function prResult({ url = null, number = null, branch = null, base = null, error = null, existingUrl = null } = {}) {
  return { type: 'git_create_pr_result', url, number, branch, base, error, existingUrl }
}

/** Extract the first `.../pull/<n>` URL from gh output (stdout or stderr). */
function extractPrUrl(text) {
  if (!text) return null
  const m = String(text).match(/https?:\/\/\S*\/pull\/\d+/)
  return m ? m[0] : null
}

/** Parse the numeric PR id out of a `.../pull/<n>` URL. */
function extractPrNumber(url) {
  if (!url) return null
  const m = String(url).match(/\/pull\/(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * Resolve the repo's default (base) branch from `origin/HEAD`. Returns '' when
 * it can't be determined, in which case the caller omits `--base` and lets `gh`
 * pick the repo default via the API.
 */
async function resolveDefaultBase(execImpl, cwdReal) {
  try {
    const { stdout } = await execImpl(GIT, ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: cwdReal, timeout: 5000 })
    const ref = (stdout || '').trim() // e.g. "origin/main"
    if (ref && ref !== 'origin/HEAD') {
      return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
    }
  } catch {
    // origin/HEAD not set (fresh clone / no default) — fall through to gh's default.
  }
  return ''
}

/** First non-empty trimmed line of a multi-line error string. */
function firstLine(text) {
  return String(text || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)[0] || ''
}

/** Map a `git push` failure to an operator-actionable message. */
function mapPushError(err) {
  if (err && err.code === 'ENOENT') return 'git is not available on the daemon host'
  const stderr = String((err && (err.stderr || err.message)) || '')
  const lower = stderr.toLowerCase()
  if (/does not appear to be a git repository|no configured push destination|no such remote|no remote/.test(lower)) {
    return 'Cannot push — no `origin` remote is configured for this repository'
  }
  if (/permission denied|authentication failed|could not read|access rights|403|denied to|fatal: could not read/.test(lower)) {
    return 'Cannot push — the daemon is not authorized to push to origin (check its git credentials)'
  }
  const line = firstLine(stderr)
  return line ? `Failed to push branch: ${line}` : 'Failed to push the current branch to origin'
}

/**
 * Map a `gh pr create` failure to an operator-actionable message.
 *
 * Returns `{ message, existingUrl }` — `existingUrl` is the pre-existing PR's
 * `/pull/<n>` URL (non-null) only on the "PR already exists" path, so the
 * caller can surface it as a structured field on `git_create_pr_result`
 * (#6938) rather than the dashboard having to regex it back out of `message`.
 */
function mapGhCreateError(err) {
  if (err && err.code === 'ENOENT') {
    return {
      message: 'GitHub CLI (gh) is not installed on the daemon host — install it from https://cli.github.com to open PRs from Chroxy',
      existingUrl: null,
    }
  }
  const stderr = String((err && (err.stderr || err.message)) || '')
  const lower = stderr.toLowerCase()
  if (/already exists|a pull request for branch/.test(lower)) {
    // gh sometimes writes the existing-PR URL to stdout rather than stderr —
    // parse both streams (and the error message) the same way the success
    // path does, so the URL isn't missed depending on which stream gh used.
    const existing = extractPrUrl(err && err.stdout) || extractPrUrl(stderr)
    return {
      message: existing
        ? `A pull request already exists for this branch: ${existing}`
        : 'A pull request already exists for this branch',
      existingUrl: existing,
    }
  }
  if (/gh auth login|not logged in|authentication required|no credentials|requires authentication|http 401|gh auth status/.test(lower)) {
    return {
      message: 'GitHub CLI is not authenticated — run `gh auth login` on the daemon host to enable PR creation',
      existingUrl: null,
    }
  }
  if (/no git remotes found|not a git repository|does not appear to be a git repository|could not determine base repo/.test(lower)) {
    return { message: 'No GitHub remote is configured for this repository', existingUrl: null }
  }
  const line = firstLine(stderr)
  return { message: line || (err && err.message) || 'Failed to create pull request', existingUrl: null }
}

/**
 * #7281 — turn a VALIDATED absolute path into the pathspec git will actually receive.
 *
 * `git add` / `git reset` take PATHSPECS, not paths, and a pathspec has its own magic
 * syntax — so the string the client sent and the path we validated are not written in
 * the same language. `:/` resolves, as a filesystem path, to a harmless `<cwd>/:` that
 * passes containment; to git it means "from the repo root", staging the ENTIRE
 * repository, including files outside the session cwd and outside the workspace root.
 * The server reported `error: null` while doing it.
 *
 * Two changes close it, and only together:
 *
 *  - `--literal-pathspecs` on the git invocation, which disables all pathspec magic and
 *    glob expansion. This is the load-bearing half: re-deriving the path is NOT
 *    sufficient on its own, because `relative()` leaves a payload such as
 *    `:/etc/shadow` byte-identical.
 *  - handing git the path we validated instead of the raw client string, so that what
 *    is checked is what is executed.
 *
 * Prefers `absPath` (lexically resolved) over the validator's `realPath`
 * (symlink-resolved): for a symlink INSIDE the cwd, `realPath` names its TARGET, so
 * staging that would record a different object than the one the client asked for.
 *
 * `absPath` is used only when it is lexically inside the cwd, because it is not
 * always. validatePathWithinCwd decides containment on `realPath`, so it says yes to
 * a path that merely REACHES the cwd through a symlink or an aliased prefix —
 * including the entirely ordinary macOS case where the session cwd resolves to
 * `/private/var/...` while the client names the same file under `/var/...`.
 * `relative()` then yields a '..' chain pointing out of the cwd, which git refuses
 * under --literal-pathspecs; and for a symlink ABOVE the cwd it would name a file
 * outside it. Falling back to `realPath` — which containment has already proved is
 * inside — gives this function an invariant worth stating plainly: it never returns
 * a pathspec that leaves the cwd.
 *
 * Containment is still decided by validatePathWithinCwd. The isPathWithin call here
 * is that same root-aware predicate (#7273), not a second implementation of the rule.
 *
 * @param {string} cwdReal - resolved session cwd; the git process's cwd
 * @param {string} absPath - the absolute path that validatePathWithinCwd approved
 * @param {string} realPath - that path with every symlink resolved, from the validator
 * @returns {string|null} a cwd-relative, '/'-separated, magic-free pathspec, or null
 *   when neither form stays inside the cwd (the caller then rejects)
 */
function toLiteralPathspec(cwdReal, absPath, realPath) {
  const rel = isPathWithin(absPath, cwdReal)
    ? relative(cwdReal, absPath)
    : relative(cwdReal, realPath)
  // Defensive: `valid === true` already means realPath is inside, so this is
  // unreachable today. It stays because a pathspec that leaves the cwd must never
  // reach git, and a future caller that stops checking `valid` should fail closed
  // rather than silently widen.
  if (rel !== '' && !isPathWithin(resolve(cwdReal, rel), cwdReal)) return null
  // absPath === cwdReal. git rejects an empty pathspec outright, and '.' is how the
  // caller's intent — "everything in the cwd" — is spelled. Callers reject an empty
  // client string before reaching here, so this only ever stands in for '.' / './'.
  if (rel === '') return '.'
  // git pathspecs are '/'-separated on every platform. relative() yields backslashes
  // on Windows, which git would not match against its own '/'-separated index.
  return sep === '\\' ? rel.split(sep).join('/') : rel
}

/**
 * Git operations: status, branches, stage, unstage, commit, create PR.
 *
 * @param {Function} sendFn - (ws, message) => void
 * @param {Function} resolveSessionCwd - shared CWD resolver
 * @param {Function} validatePathWithinCwd - shared path validator
 * @param {string} workspaceRoot - workspace root directory; git ops are restricted to paths within it
 * @param {Function} [execImpl] - injectable promisified execFile seam (defaults to the real one; the
 *   git_create_pr tests inject a mock so no real branch is pushed or PR opened)
 * @returns {Object} git operation methods
 */
export function createGitOps(sendFn, resolveSessionCwd, validatePathWithinCwd, workspaceRoot, execImpl = execFileAsync) {

  /** Get git status (branch, staged, unstaged, untracked) for a session CWD */
  async function gitStatus(ws, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'git_status_result',
        branch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        error: 'Git status is not available in this mode',
      })
      return
    }

    try {
      await validateGitPath(sessionCwd, workspaceRoot)
      const cwdReal = await resolveSessionCwd(sessionCwd)

      // Get current branch
      let branch = null
      try {
        const { stdout } = await execFileAsync(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: cwdReal,
          timeout: 5000,
        })
        const ref = stdout.trim()
        // In detached HEAD state, git prints literal "HEAD" with exit code 0
        branch = ref === 'HEAD' ? null : ref
      } catch {
        // Not a git repo
      }

      // Get porcelain status
      const { stdout: statusOutput } = await execFileAsync(GIT, ['status', '--porcelain=v1'], {
        cwd: cwdReal,
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      })

      const staged = []
      const unstaged = []
      const untracked = []

      const STATUS_MAP = {
        'M': 'modified',
        'A': 'added',
        'D': 'deleted',
        'R': 'renamed',
        'C': 'copied',
      }

      for (const rawLine of statusOutput.split(/\r?\n/)) {
        const line = rawLine.trimEnd()
        if (!line) continue
        const x = line[0] // index/staged status
        const y = line[1] // working tree status
        let filePath = line.slice(3)
        // Rename/copy entries use "old -> new" format; extract destination
        if ((x === 'R' || x === 'C') && filePath.includes(' -> ')) {
          filePath = filePath.split(' -> ').pop()
        }

        if (x === '?' && y === '?') {
          untracked.push(filePath)
        } else {
          if (x !== ' ' && x !== '?') {
            staged.push({ path: filePath, status: STATUS_MAP[x] || 'unknown' })
          }
          if (y !== ' ' && y !== '?') {
            unstaged.push({ path: filePath, status: STATUS_MAP[y] || 'unknown' })
          }
        }
      }

      sendFn(ws, {
        type: 'git_status_result',
        branch,
        staged,
        unstaged,
        untracked,
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'git_status_result',
        branch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        error: err.message || 'Failed to get git status',
      })
    }
  }

  /** List git branches (local + remote) with current branch marked */
  async function gitBranches(ws, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'git_branches_result',
        branches: [],
        currentBranch: null,
        error: 'Git branches is not available in this mode',
      })
      return
    }

    try {
      await validateGitPath(sessionCwd, workspaceRoot)
      const cwdReal = await resolveSessionCwd(sessionCwd)

      // Get all branches
      const { stdout } = await execFileAsync(GIT, ['branch', '-a', '--no-color'], {
        cwd: cwdReal,
        maxBuffer: 512 * 1024,
        timeout: 5000,
      })

      let currentBranch = null
      const branches = []

      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const isCurrent = line.startsWith('* ')
        const name = trimmed.replace(/^\*\s+/, '')

        // Skip HEAD pointer lines like "remotes/origin/HEAD -> origin/main"
        if (name.includes(' -> ')) continue

        const isRemote = name.startsWith('remotes/')
        const displayName = isRemote ? name.replace(/^remotes\//, '') : name

        if (isCurrent) currentBranch = displayName

        branches.push({
          name: displayName,
          isCurrent,
          isRemote,
        })
      }

      sendFn(ws, {
        type: 'git_branches_result',
        branches,
        currentBranch,
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'git_branches_result',
        branches: [],
        currentBranch: null,
        error: err.message || 'Failed to list branches',
      })
    }
  }

  /** Stage specified files via git add */
  async function gitStage(ws, files, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'git_stage_result', error: 'Git staging is not available in this mode' })
      return
    }

    if (!Array.isArray(files) || files.length === 0) {
      sendFn(ws, { type: 'git_stage_result', error: 'No files specified to stage' })
      return
    }

    try {
      await validateGitPath(sessionCwd, workspaceRoot)
      const cwdReal = await resolveSessionCwd(sessionCwd)
      // Validate each file path is within session CWD (prevents path traversal)
      const validatedFiles = []
      for (const file of files) {
        // An empty pathspec is never meaningful, and would otherwise resolve to the
        // cwd itself and widen to '.' below. git rejects it today; keep that outcome
        // with a clearer message. (#7281)
        if (typeof file !== 'string' || file === '') {
          sendFn(ws, { type: 'git_stage_result', error: 'Invalid file path: empty' })
          return
        }
        const absPath = normalize(resolve(cwdReal, file))
        const { valid, realPath } = await validatePathWithinCwd(absPath, sessionCwd)
        const pathspec = valid ? toLiteralPathspec(cwdReal, absPath, realPath) : null
        if (!valid || pathspec === null) {
          sendFn(ws, { type: 'git_stage_result', error: `Access denied: path outside project directory — ${file}` })
          return
        }
        // #7281 — what git receives is the path we validated, not the client's string.
        validatedFiles.push(pathspec)
      }
      await execFileAsync(GIT, ['--literal-pathspecs', 'add', '--', ...validatedFiles], {
        cwd: cwdReal,
        timeout: 10000,
      })
      sendFn(ws, { type: 'git_stage_result', error: null })
    } catch (err) {
      sendFn(ws, { type: 'git_stage_result', error: err.message || 'Failed to stage files' })
    }
  }

  /** Unstage specified files via git reset HEAD */
  async function gitUnstage(ws, files, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'git_unstage_result', error: 'Git unstaging is not available in this mode' })
      return
    }

    if (!Array.isArray(files) || files.length === 0) {
      sendFn(ws, { type: 'git_unstage_result', error: 'No files specified to unstage' })
      return
    }

    try {
      await validateGitPath(sessionCwd, workspaceRoot)
      const cwdReal = await resolveSessionCwd(sessionCwd)
      // Validate each file path is within session CWD (prevents path traversal)
      const validatedFiles = []
      for (const file of files) {
        // An empty pathspec is never meaningful, and would otherwise resolve to the
        // cwd itself and widen to '.' below. git rejects it today; keep that outcome
        // with a clearer message. (#7281)
        if (typeof file !== 'string' || file === '') {
          sendFn(ws, { type: 'git_unstage_result', error: 'Invalid file path: empty' })
          return
        }
        const absPath = normalize(resolve(cwdReal, file))
        const { valid, realPath } = await validatePathWithinCwd(absPath, sessionCwd)
        const pathspec = valid ? toLiteralPathspec(cwdReal, absPath, realPath) : null
        if (!valid || pathspec === null) {
          sendFn(ws, { type: 'git_unstage_result', error: `Access denied: path outside project directory — ${file}` })
          return
        }
        // #7281 — what git receives is the path we validated, not the client's string.
        validatedFiles.push(pathspec)
      }
      await execFileAsync(GIT, ['--literal-pathspecs', 'reset', 'HEAD', '--', ...validatedFiles], {
        cwd: cwdReal,
        timeout: 10000,
      })
      sendFn(ws, { type: 'git_unstage_result', error: null })
    } catch (err) {
      sendFn(ws, { type: 'git_unstage_result', error: err.message || 'Failed to unstage files' })
    }
  }

  /** Create a git commit with the given message */
  async function gitCommit(ws, message, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'git_commit_result', hash: null, message: null, error: 'Git commit is not available in this mode' })
      return
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      sendFn(ws, { type: 'git_commit_result', hash: null, message: null, error: 'Commit message cannot be empty' })
      return
    }

    try {
      await validateGitPath(sessionCwd, workspaceRoot)
      const cwdReal = await resolveSessionCwd(sessionCwd)
      const { stdout } = await execFileAsync(GIT, ['commit', '-m', message.trim()], {
        cwd: cwdReal,
        timeout: 30000,
      })

      // Extract commit hash from output by finding a hex hash before closing bracket
      let hash = null
      const match = stdout.match(/\b([a-f0-9]{7,})\]/)
      if (match) hash = match[1]

      sendFn(ws, {
        type: 'git_commit_result',
        hash,
        message: message.trim(),
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'git_commit_result',
        hash: null,
        message: null,
        error: err.message || 'Failed to create commit',
      })
    }
  }

  /**
   * #6876 — open a PR for the session's current branch without leaving Chroxy.
   * Pushes the branch (creating/updating its `origin` upstream; a no-op when it
   * is already current) then shells out to `gh pr create`. Returns the created
   * PR URL + number to the client, or a clear, operator-actionable error on any
   * failure (gh missing / not authenticated / no origin remote / PR already
   * exists / detached HEAD / base === head). Never claims success on failure.
   *
   * @param {WebSocket} ws
   * @param {{ title?: string, body?: string, base?: string, draft?: boolean }} opts
   * @param {string|null} sessionCwd
   */
  async function gitCreatePR(ws, opts, sessionCwd) {
    const title = typeof opts?.title === 'string' ? opts.title.trim() : ''
    const body = typeof opts?.body === 'string' ? opts.body : ''
    const requestedBase = typeof opts?.base === 'string' ? opts.base.trim() : ''
    const draft = opts?.draft === true

    if (!sessionCwd) {
      sendFn(ws, prResult({ error: 'PR creation is not available in this mode' }))
      return
    }
    if (!title) {
      sendFn(ws, prResult({ error: 'Pull request title cannot be empty' }))
      return
    }

    try {
      await validateGitPath(sessionCwd, workspaceRoot)
      const cwdReal = await resolveSessionCwd(sessionCwd)

      // 1. Current branch (reject detached HEAD / not-a-repo).
      let branch = null
      try {
        const { stdout } = await execImpl(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cwdReal, timeout: 5000 })
        branch = (stdout || '').trim()
      } catch {
        sendFn(ws, prResult({ error: 'Not a git repository' }))
        return
      }
      if (!branch || branch === 'HEAD') {
        sendFn(ws, prResult({ error: 'Cannot open a PR from a detached HEAD — check out a branch first' }))
        return
      }

      // 2. Base branch — explicit, else the repo default (origin/HEAD).
      const base = requestedBase || (await resolveDefaultBase(execImpl, cwdReal))
      if (base && base === branch) {
        sendFn(ws, prResult({ branch, base, error: `The current branch (${branch}) is the base branch — create a feature branch before opening a PR` }))
        return
      }

      // 3. Push the branch (set upstream). No-op when already up to date.
      try {
        await execImpl(GIT, ['push', '--set-upstream', 'origin', branch], { cwd: cwdReal, timeout: 120000 })
      } catch (err) {
        sendFn(ws, prResult({ branch, base: base || null, error: mapPushError(err) }))
        return
      }

      // 4. gh pr create. Pass the body via a temp `--body-file` rather than an
      // inline `--body <text>` argv element: the client schema permits a body up
      // to 50k chars, which can blow past Windows' command-line length limit when
      // inlined. A body-file sidesteps the limit entirely and keeps the body out
      // of argv. The empty-body case writes an empty file (gh reads it as an
      // empty body without opening an editor). (#6934)
      const bodyFile = join(tmpdir(), `chroxy-pr-body-${randomBytes(8).toString('hex')}.md`)
      let stdout = ''
      let stderr = ''
      try {
        await writeFile(bodyFile, body, 'utf8')

        const args = ['pr', 'create', '--title', title, '--body-file', bodyFile, '--head', branch]
        if (base) args.push('--base', base)
        if (draft) args.push('--draft')

        try {
          const res = await execImpl('gh', args, { cwd: cwdReal, timeout: 120000 })
          stdout = res?.stdout || ''
          stderr = res?.stderr || ''
        } catch (err) {
          const mapped = mapGhCreateError(err)
          sendFn(ws, prResult({ branch, base: base || null, error: mapped.message, existingUrl: mapped.existingUrl }))
          return
        }
      } finally {
        // Best-effort cleanup — never fail the create because the temp body-file
        // couldn't be removed.
        await unlink(bodyFile).catch(() => {})
      }

      // gh prints the created PR URL on stdout, but can emit it on stderr (or
      // split its output). Parse both streams so a stderr-only URL still yields a
      // success. (#6934)
      const url = extractPrUrl(stdout) || extractPrUrl(stderr)
      if (!url) {
        sendFn(ws, prResult({ branch, base: base || null, error: 'PR command succeeded but gh returned no pull-request URL' }))
        return
      }
      sendFn(ws, prResult({ url, number: extractPrNumber(url), branch, base: base || null, error: null }))
    } catch (err) {
      sendFn(ws, prResult({ error: err.message || 'Failed to create pull request' }))
    }
  }

  return {
    gitStatus,
    gitBranches,
    gitStage,
    gitUnstage,
    gitCommit,
    gitCreatePR,
  }
}
