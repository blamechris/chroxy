import { readdir, readFile, stat, realpath } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve, normalize, relative } from 'path'
import { createLogger } from '../logger.js'

const log = createLogger('ws')

/**
 * Directory browsing, file listing, slash commands, and agent listing.
 *
 * @param {Function} sendFn - (ws, message) => void
 * @param {Function} resolveSessionCwd - shared CWD resolver
 * @param {Function} validatePathWithinCwd - shared path validator
 * @returns {Object} browser operation methods
 */
export function createBrowserOps(sendFn, resolveSessionCwd, validatePathWithinCwd) {

  /** List directories at a given path, sending a directory_listing response */
  async function listDirectory(ws, requestedPath) {
    let absPath = null
    try {
      const home = homedir()
      if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
        absPath = home
      } else {
        const trimmed = requestedPath.trim()
        absPath = trimmed.startsWith('~')
          ? resolve(home, trimmed.slice(1).replace(/^\//, ''))
          : resolve(trimmed)
      }
      absPath = normalize(absPath)

      let realAbsPath
      try {
        realAbsPath = await realpath(absPath)
      } catch (err) {
        if (err.code === 'ENOENT') {
          realAbsPath = absPath
        } else {
          throw err
        }
      }
      const homeReal = await realpath(home)

      if (!realAbsPath.startsWith(homeReal + '/') && realAbsPath !== homeReal) {
        sendFn(ws, {
          type: 'directory_listing',
          path: absPath,
          parentPath: null,
          entries: [],
          error: 'Access denied: directory listing is restricted to the home directory',
        })
        return
      }

      const dirents = await readdir(realAbsPath, { withFileTypes: true })
      const entries = dirents
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => ({ name: d.name, isDirectory: true }))

      const parentPath = absPath === '/' ? null : resolve(absPath, '..')

      sendFn(ws, {
        type: 'directory_listing',
        path: absPath,
        parentPath,
        entries,
        error: null,
      })
    } catch (err) {
      let errorMessage
      if (err.code === 'ENOENT') errorMessage = 'Directory not found'
      else if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else if (err.code === 'ENOTDIR') errorMessage = 'Not a directory'
      else errorMessage = err.message || 'Unknown error'

      sendFn(ws, {
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

      const { valid, realPath: realAbsPath, cwdReal } = await validatePathWithinCwd(absPath, sessionCwd)
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
      let errorMessage
      if (err.code === 'ENOENT') errorMessage = 'Directory not found'
      else if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else if (err.code === 'ENOTDIR') errorMessage = 'Not a directory'
      else errorMessage = err.message || 'Unknown error'

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
  async function listFiles(ws, sessionCwd, query, sessionId) {
    if (!sessionCwd) {
      const response = { type: 'file_list', files: [], error: 'File listing is not available in this mode' }
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
        const content = await readFile(join(cwdReal, '.gitignore'), 'utf-8')
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
          const relPath = relative(cwdReal, absPath)

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

      const response = { type: 'file_list', files: result, error: null }
      if (sessionId) response.sessionId = sessionId
      sendFn(ws, response)
    } catch (err) {
      let message = 'Failed to list files'
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        message = 'Directory not found'
      } else if (err && typeof err === 'object' && err.code === 'EACCES') {
        message = 'Permission denied'
      }
      const response = { type: 'file_list', files: [], error: message }
      if (sessionId) response.sessionId = sessionId
      sendFn(ws, response)
    }
  }

  /** List available slash commands from project and user command directories */
  async function listSlashCommands(ws, cwd, sessionId) {
    const commands = []
    const seen = new Set()

    const scanDir = async (dir, source) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue
          if (entry.name.includes('/') || entry.name.includes('\\')) continue
          const name = entry.name.slice(0, -3)
          if (seen.has(name)) continue
          seen.add(name)

          let description = ''
          try {
            const content = await readFile(join(dir, entry.name), 'utf-8')
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
    await scanDir(join(homedir(), '.claude', 'commands'), 'user')

    commands.sort((a, b) => a.name.localeCompare(b.name))

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
  async function listAgents(ws, cwd, sessionId, opts = {}) {
    const agents = []
    const seen = new Set()

    const scanDir = async (dir, source) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue
          if (entry.name.includes('/') || entry.name.includes('\\')) continue
          const name = entry.name.slice(0, -3)
          if (seen.has(name)) continue
          seen.add(name)

          let description = ''
          try {
            const content = await readFile(join(dir, entry.name), 'utf-8')
            const lines = content.split('\n')
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith('#')) continue
              description = trimmed.slice(0, 120)
              break
            }
          } catch (err) {
            log.error(`Failed to read agent file ${join(dir, entry.name)}: ${err.message}`)
          }

          agents.push({ name, description, source })
        }
      } catch {
        // Directory doesn't exist or is unreadable
      }
    }

    if (cwd) {
      await scanDir(join(cwd, '.claude', 'agents'), 'project')
    }

    // Scan user-level agent directories — default ~/.claude/agents, or
    // the caller-supplied list when multiple providers are active (#2965).
    const userAgentsDirs = (Array.isArray(opts.userAgentsDirs) && opts.userAgentsDirs.length > 0)
      ? opts.userAgentsDirs
      : [join(homedir(), '.claude', 'agents')]

    for (const dir of userAgentsDirs) {
      await scanDir(dir, 'user')
    }

    agents.sort((a, b) => a.name.localeCompare(b.name))

    const response = { type: 'agent_list', agents }
    if (sessionId) response.sessionId = sessionId
    sendFn(ws, response)
  }

  return {
    listDirectory,
    browseFiles,
    listFiles,
    listSlashCommands,
    listAgents,
  }
}
