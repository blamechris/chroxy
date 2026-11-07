import { readdir, stat, lstat, realpath } from 'fs/promises'
import { readContainedTextFile } from '../utils/regular-file.js'
import { homedir } from 'os'
import { claudeConfigDir } from '../utils/claude-config-dir.js'
import { join, resolve, normalize, relative, sep, isAbsolute, dirname, basename } from 'path'
import { createLogger } from '../logger.js'
import { getBuiltinCommands } from '../builtin-commands.js'
import { getProvider } from '../providers.js'
import { isPathWithin } from '../utils/path-containment.js'
import { realpathOfDeepestAncestor, unresolvablePathError, fileOpErrorMessage } from './common.js'
import { truncateForLog } from './reader.js'
import { isGitRepo } from '../utils/git-repo.js'
import { validateCwdAllowed } from '../handler-utils.js'
import { DIRECTORY_LISTING_DENIED_PREFIX } from '@chroxy/protocol'

const log = createLogger('ws')

// #8972 — max distinct check_git_repo probes in flight per socket.
const MAX_GIT_CHECKS_PER_CLIENT = 4

// #8012 — the message list_directory / browse_files send when `realpath()`
// failed with one of these codes for a path INSIDE their boundary. Any other
// code, or any path outside it, gets the handler's generic denial instead
// (see unresolvablePathError).
const LISTING_UNRESOLVABLE_REASONS = {
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  ENOTDIR: 'Not a directory',
}

const HOME_ONLY_DENIAL = `${DIRECTORY_LISTING_DENIED_PREFIX}: directory listing is restricted to the home directory`
const HOME_AND_ROOTS_DENIAL =
  `${DIRECTORY_LISTING_DENIED_PREFIX}: directory listing is restricted to the home directory and any usable workspace roots`

function hasWorkspaceRoots(config) {
  return Array.isArray(config?.workspaceRoots) &&
    config.workspaceRoots.some((r) => typeof r === 'string' && r.length > 0)
}

/**
 * The requested path in the form New Session hands to `validateCwdAllowed`: the
 * trimmed input with `~` expanded and NOT lexically normalised, so the kernel
 * resolves any `..` through the links before it (`/tmp/..` is `/private` where
 * `/tmp` links to `/private/tmp`). `normalize`/`resolve` would collapse it
 * textually and make Browse and Create answer differently for one input (#8303).
 * The containment decision is made on the realpath of this form.
 */
function kernelForm(trimmed, home) {
  if (trimmed.startsWith('~')) {
    // ONE tilde rule for every Browse path: drop every separator after the `~`,
    // so `~//x` is `<home>/x` for list_directory and check_git_repo alike.
    const rest = trimmed.slice(1).replace(/^[\\/]+/, '')
    return rest ? home + sep + rest : home
  }
  return isAbsolute(trimmed) ? trimmed : process.cwd() + sep + trimmed
}

function hasDotDot(p) {
  return p.split(/[\\/]+/).includes('..')
}

const MAX_ANCESTOR_STEPS = 256

/**
 * Resolve `raw` the way the kernel does, and for a target that does not exist
 * find its deepest EXISTING ancestor (a `..` is applied to the prefix before it,
 * through links, never textually). Returns `{ real, missing, code }`: `real` is
 * the resolved target (or ancestor), `missing` whether the target itself is
 * absent, `code` the first failure (ENOENT or ENOTDIR). A dangling symlink on
 * the way is followed with realpathOfDeepestAncestor (#8013). Any other error,
 * or a walk that cannot finish, throws with `walked` set when it happened after
 * the target was already known to be missing, so the caller can answer with the
 * uniform denial instead of an error that differs by what exists out there.
 */
async function deepestExistingAncestor(raw) {
  let cur = raw
  let firstCode = null
  for (let i = 0; i < MAX_ANCESTOR_STEPS; i++) {
    try {
      return { real: await realpath(cur), missing: firstCode !== null, code: firstCode }
    } catch (err) {
      if (firstCode === null && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
      try {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
        firstCode ??= err.code
        const parent = dirname(cur)
        if (parent === cur) throw err
        const leaf = basename(cur)
        if (leaf !== '..' && leaf !== '.') {
          let isLink = false
          try { isLink = (await lstat(cur)).isSymbolicLink() } catch { /* absent */ }
          if (isLink) {
            const realParent = await realpath(parent)
            return { real: await realpathOfDeepestAncestor(join(realParent, leaf)), missing: true, code: firstCode }
          }
        }
        cur = parent
      } catch (inner) {
        inner.walked = true
        throw inner
      }
    }
  }
  throw Object.assign(new Error('ancestor walk too deep'), { walked: true })
}

/** The directory to judge for a (possibly missing) target: its nearest existing directory. */
async function judgedDirectory(real) {
  let cur = real
  for (let i = 0; i < MAX_ANCESTOR_STEPS; i++) {
    try {
      const st = await stat(cur)
      return st.isDirectory() ? cur : dirname(cur)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return null
      cur = parent
    }
  }
  return null
}

/**
 * The one containment rule for Browse (`list_directory`, `check_git_repo`): $HOME
 * as before, plus whatever New Session's cwd check (`validateCwdAllowed`, the
 * credential-directory deny-list then `workspaceRoots`) accepts. Asking the same
 * function keeps the two from drifting. A session-bound client is denied these
 * message types before dispatch (bound-client-policy.js), so this is a second
 * layer: should one ever reach here it keeps the $HOME-only boundary, since it
 * cannot create sessions and gets nothing from the create allowlist
 * (docs/security/bearer-token-authority.md section 4).
 * @param {string} realPath canonical (realpath) target
 * @param {string} homeReal canonical home
 * @param {{ config?: object|null, bound?: boolean }} [opts]
 */
function isBrowsable(realPath, homeReal, opts = {}) {
  if (isPathWithin(realPath, homeReal)) return true
  if (opts.bound !== false || !opts.config) return false
  return validateCwdAllowed(realPath, opts.config) === null
}

/**
 * Directory browsing, file listing, slash commands, and agent listing.
 *
 * @param {Function} sendFn - (ws, message) => void
 * @param {Function} resolveSessionCwd - shared CWD resolver
 * @param {Function} validatePathWithinCwd - shared path validator
 * @param {{ realpath?: Function, readdir?: Function }} [deps] test seam for the catalog directory scans
 * @returns {Object} browser operation methods
 */
export function createBrowserOps(sendFn, resolveSessionCwd, validatePathWithinCwd, deps = {}) {
  const catalogRealpath = deps.realpath ?? realpath
  const catalogReaddir = deps.readdir ?? readdir

  /** List directories at a given path, sending a directory_listing response */
  async function listDirectory(ws, requestedPath, opts = {}) {
    let absPath = null
    // #8303 — echo the caller's correlation id on every reply, to this socket
    // only (sendFn is per-socket). A malformed id is dropped, never echoed; the
    // schema already refuses one before dispatch.
    const requestId = typeof opts.requestId === 'string' && opts.requestId.length > 0 && opts.requestId.length <= 128
      ? opts.requestId
      : null
    const send = (message) => sendFn(ws, requestId ? { ...message, requestId } : message)
    try {
      const home = homedir()
      const trimmed = typeof requestedPath === 'string' ? requestedPath.trim() : ''
      // Create's form (kernelForm); the lexical `absPath` is only the echo.
      const rawPath = trimmed ? kernelForm(trimmed, home) : home
      absPath = normalize(resolve(rawPath))
      const denial = hasWorkspaceRoots(opts.config) && opts.bound === false ? HOME_AND_ROOTS_DENIAL : HOME_ONLY_DENIAL
      const deny = (message = denial) => send({
        type: 'directory_listing',
        path: absPath,
        parentPath: null,
        entries: [],
        error: message,
      })

      let walk
      try {
        walk = await deepestExistingAncestor(rawPath)
      } catch (err) {
        if (err.walked) return deny() // cannot establish containment: the uniform denial
        // #8012 — a first-step failure other than "missing" (EACCES, EPERM,
        // ELOOP, …) keeps a specific message only for a path inside home.
        const homeReal = await realpath(home).catch(() => null)
        deny(await unresolvablePathError(err, absPath, homeReal, LISTING_UNRESOLVABLE_REASONS, denial))
        return
      }
      const homeReal = await realpath(home)

      // #8011/#8303 — a MISSING target is judged by its deepest existing
      // ancestor, resolved as the kernel resolves it, with the SAME rule an
      // existing one gets. Outside the browsable area the answer is the same
      // denial whether or not anything exists out there; inside it nothing is
      // hidden, so the answer is a plain "not found".
      // (A file is judged by the directory holding it, so a file or a path below
      // one inside a root is not mistaken for a path outside it.)
      const judged = await judgedDirectory(walk.real)
      if (judged === null || !isBrowsable(judged, homeReal, opts)) return deny()
      if (walk.missing) throw Object.assign(new Error('missing'), { code: walk.code })
      const realAbsPath = walk.real

      const dirents = await readdir(realAbsPath, { withFileTypes: true })
      const entries = dirents
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => ({ name: d.name, isDirectory: true }))

      // Report the directory actually listed. Without a `..` in the input the
      // lexical form IS that directory (and is what the client asked for); with
      // one, the lexical collapse can name a different directory, so report the
      // resolved one.
      const listedPath = hasDotDot(rawPath) ? realAbsPath : absPath
      const parentPath = dirname(listedPath) === listedPath ? null : dirname(listedPath)

      send({
        type: 'directory_listing',
        path: listedPath,
        parentPath,
        entries,
        error: null,
      })
    } catch (err) {
      log.error(`list_directory failed: ${truncateForLog(err.message)}`)
      const errorMessage = fileOpErrorMessage(err, 'Operation failed', { ENOENT: 'Directory not found' })

      send({
        type: 'directory_listing',
        path: absPath || requestedPath || null,
        parentPath: null,
        entries: [],
        error: errorMessage,
      })
    }
  }

  /** Browse files and directories at a given path within the session CWD */
  async function browseFiles(ws, requestedPath, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'file_listing',
        path: null,
        parentPath: null,
        entries: [],
        error: 'File browsing is not available in this mode',
      })
      return
    }

    let absPath = null
    try {
      if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
        absPath = resolve(sessionCwd)
      } else {
        absPath = resolve(sessionCwd, requestedPath.trim())
      }
      absPath = normalize(absPath)

      // A session cwd that cannot be resolved keeps the outer catch's answer.
      const sessionCwdReal = await resolveSessionCwd(sessionCwd)
      let validation
      try {
        validation = await validatePathWithinCwd(absPath, sessionCwd)
      } catch (err) {
        // #8012 — same residual as list_directory above: a non-ENOENT
        // failure resolving the target skipped containment and reached the
        // outer catch. Outside the project, or a cycle, is the denial.
        sendFn(ws, {
          type: 'file_listing',
          path: absPath,
          parentPath: null,
          entries: [],
          error: await unresolvablePathError(err, absPath, sessionCwdReal, LISTING_UNRESOLVABLE_REASONS,
            'Access denied: browsing is restricted to the project directory'),
        })
        return
      }
      const { valid, realPath: realAbsPath, cwdReal } = validation
      if (!valid) {
        sendFn(ws, {
          type: 'file_listing',
          path: absPath,
          parentPath: null,
          entries: [],
          error: 'Access denied: browsing is restricted to the project directory',
        })
        return
      }

      const dirents = await readdir(realAbsPath, { withFileTypes: true })
      const entries = []
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue
        if (d.name === 'node_modules') continue
        const entry = { name: d.name, isDirectory: d.isDirectory(), size: null }
        if (!d.isDirectory()) {
          try {
            const s = await stat(join(realAbsPath, d.name))
            entry.size = s.size
          } catch (_) { /* skip size on error */ }
        }
        entries.push(entry)
      }

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      const parentPath = realAbsPath === cwdReal ? null : resolve(realAbsPath, '..')

      sendFn(ws, {
        type: 'file_listing',
        path: realAbsPath,
        parentPath,
        entries,
        error: null,
      })
    } catch (err) {
      log.error(`browse_files failed: ${truncateForLog(err.message)}`)
      const errorMessage = fileOpErrorMessage(err, 'Operation failed', { ENOENT: 'Directory not found' })

      sendFn(ws, {
        type: 'file_listing',
        path: absPath || requestedPath || null,
        parentPath: null,
        entries: [],
        error: errorMessage,
      })
    }
  }

  /**
   * Parse a .gitignore file into an array of { pattern, negated } rules.
   * Supports basic gitignore patterns: globs, directory markers, negation.
   */
  function parseGitignore(content) {
    const rules = []
    for (const raw of content.split('\n')) {
      let line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const negated = line.startsWith('!')
      if (negated) line = line.slice(1)
      rules.push({ pattern: line, negated })
    }
    return rules
  }

  /**
   * Test whether a relative file path matches a gitignore rule pattern.
   * Handles: exact name, directory suffix (/), leading slash, glob (*).
   */
  function matchesGitignorePattern(relPath, pattern, isDir) {
    const segments = relPath.split('/')
    let pat = pattern

    // Directory-only pattern (trailing /) — only matches directories
    const dirOnly = pat.endsWith('/')
    if (dirOnly) {
      if (!isDir) return false
      pat = pat.slice(0, -1)
    }

    // Rooted pattern (leading /) — must match from root
    const rooted = pat.startsWith('/')
    if (rooted) pat = pat.slice(1)

    // Convert glob pattern to regex
    const regexStr = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u26a1GLOBSTAR\u26a1')
      .replace(/\*/g, '[^/]*')
      .replace(/\u26a1GLOBSTAR\u26a1/g, '.*')
      .replace(/\?/g, '[^/]')

    const regex = new RegExp(`^${regexStr}$`)

    if (rooted) {
      return regex.test(relPath)
    }

    // Patterns with slashes match against path suffixes
    if (pat.includes('/')) {
      for (let i = 0; i < segments.length; i++) {
        const subpath = segments.slice(i).join('/')
        if (regex.test(subpath)) return true
      }
      return false
    }

    // Unrooted patterns without slashes match any segment or the full path
    if (regex.test(relPath)) return true
    for (const seg of segments) {
      if (regex.test(seg)) return true
    }
    return false
  }

  /**
   * Check if a relative path is ignored by gitignore rules.
   */
  function isIgnored(relPath, rules, isDir) {
    let ignored = false
    for (const rule of rules) {
      if (matchesGitignorePattern(relPath, rule.pattern, isDir)) {
        ignored = !rule.negated
      }
    }
    return ignored
  }

  /**
   * List files recursively from session CWD with gitignore filtering.
   * Max depth defaults to 3. Optional query for substring filtering.
   */
  async function listFiles(ws, sessionCwd, query, sessionId, mcpResources = []) {
    // #6823: MCP resources ride alongside the project file listing so the
    // dashboard `@`-picker can surface them. They are cwd-independent (a BYOK
    // session with no project cwd can still expose resources), applied the same
    // substring `query` filter as files, and included in EVERY response branch.
    const filterResources = (list, q) => {
      const arr = Array.isArray(list) ? list.filter((r) => r && typeof r.uri === 'string' && r.uri) : []
      if (!q || typeof q !== 'string' || !q.trim()) return arr
      const lower = q.toLowerCase()
      return arr.filter((r) =>
        r.uri.toLowerCase().includes(lower) ||
        (typeof r.name === 'string' && r.name.toLowerCase().includes(lower)))
    }
    const resources = filterResources(mcpResources, query)

    if (!sessionCwd) {
      const response = { type: 'file_list', files: [], resources, error: 'File listing is not available in this mode' }
      if (sessionId) response.sessionId = sessionId
      sendFn(ws, response)
      return
    }

    const MAX_DEPTH = 3
    const MAX_FILES = 1000

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)

      // Load .gitignore if it exists
      let gitignoreRules = []
      try {
        // One pinned, contained, size-capped read (utils/regular-file.js).
        const content = await readContainedTextFile(join(cwdReal, '.gitignore'), cwdReal, 1024 * 1024)
        if (content === null) throw new Error('unreadable')
        gitignoreRules = parseGitignore(content)
      } catch {
        // No .gitignore or unreadable — proceed without
      }

      const files = []

      async function walk(dir, depth) {
        if (depth > MAX_DEPTH || files.length >= MAX_FILES) return

        let dirents
        try {
          dirents = await readdir(dir, { withFileTypes: true })
        } catch (err) {
          if (err && err.code === 'EMFILE') {
            for (let attempt = 0; attempt < 3; attempt++) {
              await new Promise(r => setTimeout(r, 50 * (attempt + 1)))
              try {
                dirents = await readdir(dir, { withFileTypes: true })
                break
              } catch (retryErr) {
                if (retryErr?.code !== 'EMFILE' || attempt === 2) return
              }
            }
            if (!dirents) return
          } else {
            return
          }
        }

        for (const d of dirents) {
          if (files.length >= MAX_FILES) break
          if (d.name.startsWith('.')) continue
          if (d.name === 'node_modules') continue

          const absPath = join(dir, d.name)
          // POSIX separators, always (#7282). This string goes onto the wire
          // as `file_list.files[].path`, and a client must not have to know
          // which OS the daemon runs on — on Windows `relative()` yields
          // `src\app.js`. It also feeds `isIgnored` below, whose matcher
          // splits on '/' and builds `[^/]` classes: fed a backslash path it
          // saw one segment, so directory-scoped .gitignore rules silently
          // stopped hiding files on Windows. Same idiom as ide/search.js.
          const relPath = relative(cwdReal, absPath).split(sep).join('/')

          // Validate symlinks stay within CWD boundary
          if (d.isSymbolicLink()) {
            try {
              const { valid: symValid } = await validatePathWithinCwd(absPath, sessionCwd)
              if (!symValid) continue
            } catch {
              continue // Skip broken symlinks
            }
          }

          // Check gitignore
          const isDir = d.isDirectory() || d.isSymbolicLink()
          if (isIgnored(relPath, gitignoreRules, isDir)) continue

          if (d.isDirectory() || d.isSymbolicLink()) {
            // For symlinks, verify the target is a directory before walking
            if (d.isSymbolicLink()) {
              try {
                const s = await stat(absPath)
                if (!s.isDirectory()) {
                  // Symlink to a file — treat as file
                  files.push({ path: relPath, type: 'file', size: s.size })
                  continue
                }
              } catch { continue }
            }
            await walk(absPath, depth + 1)
          } else {
            let size = null
            try {
              const s = await stat(absPath)
              size = s.size
            } catch { /* skip size on error */ }

            files.push({ path: relPath, type: 'file', size })
          }
        }
      }

      await walk(cwdReal, 0)

      // Sort alphabetically by path
      files.sort((a, b) => a.path.localeCompare(b.path))

      // Apply query filter if provided
      let result = files
      if (query && typeof query === 'string' && query.trim()) {
        const lower = query.toLowerCase()
        result = files.filter(f => f.path.toLowerCase().includes(lower))
      }

      const response = { type: 'file_list', files: result, resources, error: null }
      if (sessionId) response.sessionId = sessionId
      sendFn(ws, response)
    } catch (err) {
      let message = 'Failed to list files'
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        message = 'Directory not found'
      } else if (err && typeof err === 'object' && err.code === 'EACCES') {
        message = 'Permission denied'
      }
      const response = { type: 'file_list', files: [], resources, error: message }
      if (sessionId) response.sessionId = sessionId
      sendFn(ws, response)
    }
  }

  /**
   * List available slash commands. Merges three sources:
   *
   *   1. Built-in commands baked into the active provider's CLI/SDK (e.g.
   *      `/clear`, `/compact`, `/model`) — sourced from builtin-commands.js
   *      and filtered by the provider's `capabilities` (#3856).
   *   2. Project-scoped markdown skills in `<cwd>/.claude/commands/`.
   *   3. User-scoped markdown skills in `~/.claude/commands/`.
   *
   * Precedence on name collision is built-in > project > user. Users can't
   * shadow `/clear` with a markdown file of the same name — keeps the picker
   * predictable across machines and matches the provider's actual behaviour
   * (the built-in is what the CLI executes regardless of what we render).
   *
   * Sort order: built-ins first (alphabetical), then everything else
   * (alphabetical). Surfaces the canonical provider commands at the top of
   * the picker so newcomers see them before their custom skills.
   *
   * @param {*} ws - WebSocket client
   * @param {string|null} cwd - Session working directory (scanned for .claude/commands)
   * @param {string|null} sessionId - Session ID to include in the response
   * @param {string|null} [providerName] - Active session's provider id; used
   *   to look up built-ins. Null/unknown providers skip the built-in merge
   *   (picker still shows project + user commands).
   */
  /**
   * Compute the merged slash-command list (built-ins + project/user .md files)
   * without touching the socket. Shared by the `list_slash_commands` request
   * path (`listSlashCommands`) and the connect-time `auth_bootstrap` burst
   * (#5555) so both produce an identical `commands` array.
   */
  // True when `dirReal` (already a real path) lies within the real path of `cwd`.
  async function isInsideProject(cwd, dirReal) {
    try {
      return isPathWithin(dirReal, await realpath(cwd))
    } catch {
      return false
    }
  }

  async function computeSlashCommands(cwd, providerName = null, mcpPrompts = [], { projectOnly = false } = {}) {
    const commands = []
    const seen = new Set()

    // 1. Built-ins go in first so they win every name collision.
    let capabilities = null
    if (providerName && typeof providerName === 'string') {
      try {
        const ProviderClass = getProvider(providerName)
        capabilities = ProviderClass?.capabilities || null
      } catch {
        // Unknown provider — fall through with null capabilities. This is
        // expected for legacy single-cliSession mode (no provider field) and
        // for sessions whose provider was unregistered between server starts.
      }
    }
    const builtins = getBuiltinCommands(providerName, capabilities)
    for (const cmd of builtins) {
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      commands.push(cmd)
    }

    const scanDir = async (dir, source) => {
      try {
        const dirReal = await catalogRealpath(dir)
        // A project-confined caller: the catalog directory must really be inside
        // the project (a link out to the user-level catalog is not the project's).
        if (projectOnly && source === 'project' && !(await isInsideProject(cwd, dirReal))) return
        const entries = await catalogReaddir(dirReal, { withFileTypes: true })
        // The listing was read from the path as it was a moment ago: check that the
        // directory still resolves there, so names read through a link swapped in
        // between are not returned. This narrows a race, it does not close one
        // (the directory can still change right after this check); what is at
        // stake is file NAMES only, since the descriptions are read through the
        // pinned, contained reader.
        if (projectOnly && source === 'project' && (await catalogRealpath(dir)) !== dirReal) return
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue
          if (entry.name.includes('/') || entry.name.includes('\\')) continue
          const name = entry.name.slice(0, -3)
          if (seen.has(name)) continue
          seen.add(name)

          let description = ''
          try {
            // Pinned, contained in the directory, head-capped.
            const content = await readContainedTextFile(join(dirReal, entry.name), dirReal, 64 * 1024, { head: true })
            if (content === null) throw new Error('unreadable')
            const lines = content.split('\n')
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith('#')) continue
              description = trimmed.slice(0, 120)
              break
            }
          } catch (err) {
            log.error(`Failed to read command file ${join(dir, entry.name)}: ${err.message}`)
          }

          commands.push({ name, description, source })
        }
      } catch {
        // Directory doesn't exist or is unreadable
      }
    }

    if (cwd) {
      await scanDir(join(cwd, '.claude', 'commands'), 'project')
    }
    // A project-confined caller (a session-scoped connection) is shown the
    // project's commands only, not the user-level catalog.
    if (!projectOnly) await scanDir(join(claudeConfigDir(), 'commands'), 'user')

    // #6823: MCP-server prompts merged as `source: 'mcp'` slash commands
    // (`/mcp__<server>__<prompt>`). Added last so a same-named built-in / .md
    // skill still wins the collision (built-in > project > user > mcp), and the
    // namespaced `mcp__` names practically never collide anyway. Element shape
    // matches the others (`{ name, description, source }`).
    if (Array.isArray(mcpPrompts)) {
      for (const p of mcpPrompts) {
        if (!p || typeof p.name !== 'string' || !p.name) continue
        if (seen.has(p.name)) continue
        seen.add(p.name)
        commands.push({
          name: p.name,
          description: typeof p.description === 'string' ? p.description : '',
          source: 'mcp',
        })
      }
    }

    // Stable order: built-ins (alphabetical) first, then project/user, then
    // MCP prompts (each alphabetical) — using `source` as the primary key.
    const sourceRank = (s) => (s === 'builtin' ? 0 : s === 'project' ? 1 : s === 'user' ? 2 : 3)
    commands.sort((a, b) => {
      const rankDiff = sourceRank(a.source) - sourceRank(b.source)
      if (rankDiff !== 0) return rankDiff
      return a.name.localeCompare(b.name)
    })

    return commands
  }

  async function listSlashCommands(ws, cwd, sessionId, providerName = null, mcpPrompts = [], opts = {}) {
    const commands = await computeSlashCommands(cwd, providerName, mcpPrompts, opts)
    const response = { type: 'slash_commands', commands }
    if (sessionId) response.sessionId = sessionId
    sendFn(ws, response)
  }

  /**
   * List custom agents from project and user agent directories.
   *
   * @param {*} ws - WebSocket client
   * @param {string|null} cwd - Session working directory (scanned for .claude/agents)
   * @param {string|null} sessionId - Session ID to include in the response
   * @param {Object} [opts] - Options
   * @param {string[]} [opts.userAgentsDirs] - Override the list of user-level agent directories
   *   to scan (#2965). When omitted, defaults to [~/.claude/agents].
   */
  /**
   * Compute the merged custom-agent list (project + user `.claude/agents`)
   * without touching the socket. Shared by the `list_agents` request path
   * (`listAgents`) and the connect-time `auth_bootstrap` burst (#5555).
   */
  async function computeAgents(cwd, opts = {}) {
    /**
     * List the candidate agent .md files in a single directory. Returns
     * `{ dir, source, filenames[] }`. Errors (missing dir, unreadable, etc.)
     * yield an empty filenames array so a single failed dir does not abort
     * the others (#3024).
     */
    const listDir = async (dir, source) => {
      const dirArg = dir
      try {
        dir = await catalogRealpath(dir)
        if (opts.projectOnly && source === 'project' && !(await isInsideProject(cwd, dir))) {
          return { dir, source, filenames: [] }
        }
        const entries = await catalogReaddir(dir, { withFileTypes: true })
        // Same narrowed (not closed) re-check as the commands scan; names only.
        if (opts.projectOnly && source === 'project' && (await catalogRealpath(dirArg)) !== dir) {
          return { dir, source, filenames: [] }
        }
        const filenames = entries
          .filter(e => e.isFile() && e.name.endsWith('.md'))
          .filter(e => !e.name.includes('/') && !e.name.includes('\\'))
          .map(e => e.name)
        return { dir, source, filenames }
      } catch {
        // Directory doesn't exist or is unreadable
        return { dir, source, filenames: [] }
      }
    }

    // Scan user-level agent directories — default ~/.claude/agents, or
    // the caller-supplied list when multiple providers are active (#2965).
    const userAgentsDirs = (Array.isArray(opts.userAgentsDirs) && opts.userAgentsDirs.length > 0)
      ? opts.userAgentsDirs
      : [join(claudeConfigDir(), 'agents')]

    // Phase 1: readdir project + all user dirs in parallel (#3024). Promise.all
    // preserves input order in the resolved array, so first-wins dedup below
    // matches the previous sequential semantics: project dir first, then user
    // dirs in their provided order.
    const dirScans = []
    if (cwd) {
      dirScans.push(listDir(join(cwd, '.claude', 'agents'), 'project'))
    }
    // A project-confined caller is shown the project's agents only.
    if (!opts.projectOnly) {
      for (const dir of userAgentsDirs) {
        dirScans.push(listDir(dir, 'user'))
      }
    }
    const dirResults = await Promise.all(dirScans)

    // Phase 2: dedupe by agent name in input order — first occurrence wins.
    // Skipping duplicates here avoids unnecessary readFile calls in later dirs
    // (matching the old behavior that short-circuited via `seen.has(name)`).
    const winners = []
    const seen = new Set()
    for (const { dir, source, filenames } of dirResults) {
      for (const filename of filenames) {
        const name = filename.slice(0, -3)
        if (seen.has(name)) continue
        seen.add(name)
        winners.push({ name, dir, source, filename })
      }
    }

    // Phase 3: read the winning agent files in parallel and parse descriptions.
    const agents = await Promise.all(winners.map(async ({ name, dir, source, filename }) => {
      let description = ''
      try {
        const content = await readContainedTextFile(join(dir, filename), dir, 64 * 1024, { head: true })
        if (content === null) throw new Error('unreadable')
        const lines = content.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          description = trimmed.slice(0, 120)
          break
        }
      } catch (err) {
        log.error(`Failed to read agent file ${join(dir, filename)}: ${err.message}`)
      }
      return { name, description, source }
    }))

    agents.sort((a, b) => a.name.localeCompare(b.name))

    return agents
  }

  async function listAgents(ws, cwd, sessionId, opts = {}) {
    const agents = await computeAgents(cwd, opts)
    const response = { type: 'agent_list', agents }
    if (sessionId) response.sessionId = sessionId
    sendFn(ws, response)
  }


  /**
   * #8972 — `check_git_repo`: is the directory the New Session dialog is
   * pointing at a git repository? Lets the dialog refuse the worktree switch
   * up front instead of after Create (the server still refuses on create).
   *
   * Answers `isGitRepo: true | false | null`. `null` means "cannot tell" and
   * the client must leave the switch enabled: the path is outside the home
   * directory, unresolvable, not a directory, refused (bound client) or over
   * the per-client probe budget. Those cases share one answer on purpose, so
   * the PAYLOAD is uniform for paths outside home (same containment as
   * `list_directory`); reply timing is not guaranteed uniform.
   *
   * Spawn budget: identical in-flight paths from one socket share one probe,
   * and a socket may have at most MAX_GIT_CHECKS_PER_CLIENT distinct probes in
   * flight; beyond that the reply is `null` without touching the filesystem.
   */
  const inFlightChecks = new WeakMap() // ws -> Map<trimmed path, Promise<boolean|null>>

  function replyGitRepoCheck(ws, requestedPath, requestId, isGitRepoValue) {
    const msg = { type: 'git_repo_check_result', path: typeof requestedPath === 'string' ? requestedPath : '', isGitRepo: isGitRepoValue }
    if (requestId) msg.requestId = requestId
    sendFn(ws, msg)
  }

  async function probeGitRepo(trimmed, opts) {
    try {
      const home = homedir()
      // Same form New Session validates (kernel-resolved `..`), see kernelForm.
      const [realAbs, homeReal] = await Promise.all([realpath(kernelForm(trimmed, home)), realpath(home)])
      if (!isBrowsable(realAbs, homeReal, opts)) return null
      if (!(await stat(realAbs)).isDirectory()) return null
      return await isGitRepo(realAbs)
    } catch {
      return null
    }
  }

  /** Refuse without any path resolution or filesystem access (bound clients). */
  function refuseGitRepoCheck(ws, requestedPath, requestId) {
    replyGitRepoCheck(ws, requestedPath, requestId, null)
  }

  async function checkGitRepo(ws, requestedPath, requestId, opts = {}) {
    const trimmed = typeof requestedPath === 'string' ? requestedPath.trim() : ''
    if (!trimmed) return replyGitRepoCheck(ws, requestedPath, requestId, null)
    let pending = ws && typeof ws === 'object' ? inFlightChecks.get(ws) : undefined
    if (!pending) {
      pending = new Map()
      if (ws && typeof ws === 'object') inFlightChecks.set(ws, pending)
    }
    let probe = pending.get(trimmed)
    if (!probe) {
      if (pending.size >= MAX_GIT_CHECKS_PER_CLIENT) return replyGitRepoCheck(ws, requestedPath, requestId, null)
      probe = probeGitRepo(trimmed, opts).finally(() => { pending.delete(trimmed) })
      pending.set(trimmed, probe)
    }
    return replyGitRepoCheck(ws, requestedPath, requestId, await probe)
  }

  return {
    listDirectory,
    checkGitRepo,
    refuseGitRepoCheck,
    browseFiles,
    listFiles,
    listSlashCommands,
    listAgents,
    computeSlashCommands,
    computeAgents,
  }
}
