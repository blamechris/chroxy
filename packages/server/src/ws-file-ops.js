import { readdir, readFile, writeFile as fsWriteFile, stat, realpath, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve, normalize, extname, relative } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { parseDiff } from './diff-parser.js'
import { GIT } from './git.js'

const execFileAsync = promisify(execFileCb)

/**
 * Create file operation handlers for the WsServer.
 * These methods handle directory browsing, file reading, git diffs,
 * and slash command / agent listing.
 *
 * @param {Function} sendFn - (ws, message) => void — sends a message to a single client
 * @returns {Object} File operation methods
 */
export function createFileOps(sendFn) {
  // Cache resolved CWD real paths to avoid repeated syscalls
  const _cwdRealCache = new Map()

  /** Resolve a session CWD to its real path, caching the result */
  async function resolveSessionCwd(sessionCwd) {
    const key = resolve(sessionCwd)
    if (_cwdRealCache.has(key)) return _cwdRealCache.get(key)
    const resolved = await realpath(key)
    _cwdRealCache.set(key, resolved)
    return resolved
  }

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

      const cwdReal = await resolveSessionCwd(sessionCwd)
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
      if (!realAbsPath.startsWith(cwdReal + '/') && realAbsPath !== cwdReal) {
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

  /** Read file content at a given path within the session CWD */
  async function readFileContent(ws, requestedPath, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'file_content',
        path: null,
        content: null,
        language: null,
        size: null,
        truncated: false,
        error: 'File reading is not available in this mode',
      })
      return
    }

    if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
      sendFn(ws, {
        type: 'file_content',
        path: null,
        content: null,
        language: null,
        size: null,
        truncated: false,
        error: 'No file path provided',
      })
      return
    }

    let absPath = null
    try {
      absPath = normalize(resolve(sessionCwd, requestedPath.trim()))

      const cwdReal = await resolveSessionCwd(sessionCwd)
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
      if (!realAbsPath.startsWith(cwdReal + '/') && realAbsPath !== cwdReal) {
        sendFn(ws, {
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: null,
          truncated: false,
          error: 'Access denied: file reading is restricted to the project directory',
        })
        return
      }

      const fileStat = await stat(realAbsPath)
      if (fileStat.isDirectory()) {
        sendFn(ws, {
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: null,
          truncated: false,
          error: 'Cannot read a directory',
        })
        return
      }

      if (fileStat.size > 512 * 1024) {
        sendFn(ws, {
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: fileStat.size,
          truncated: false,
          error: 'File too large (max 512KB)',
        })
        return
      }

      const buf = await readFile(realAbsPath)

      // Binary detection: check first 8KB for null bytes
      const checkLen = Math.min(buf.length, 8192)
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) {
          sendFn(ws, {
            type: 'file_content',
            path: absPath,
            content: null,
            language: null,
            size: fileStat.size,
            truncated: false,
            error: 'Binary file cannot be displayed',
          })
          return
        }
      }

      let content = buf.toString('utf-8')
      let truncated = false
      if (content.length > 100 * 1024) {
        content = content.slice(0, 100 * 1024)
        truncated = true
      }

      const ext = extname(absPath).slice(1).toLowerCase()

      sendFn(ws, {
        type: 'file_content',
        path: absPath,
        content,
        language: ext || null,
        size: fileStat.size,
        truncated,
        error: null,
      })
    } catch (err) {
      let errorMessage
      if (err.code === 'ENOENT') errorMessage = 'File not found'
      else if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else errorMessage = err.message || 'Unknown error'

      sendFn(ws, {
        type: 'file_content',
        path: absPath || requestedPath || null,
        content: null,
        language: null,
        size: null,
        truncated: false,
        error: errorMessage,
      })
    }
  }

  /** Get git diff for uncommitted changes in the session CWD */
  async function getDiff(ws, base, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'diff_result',
        files: [],
        error: 'Diff is not available in this mode',
      })
      return
    }

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)
      const rawBase = (typeof base === 'string' && base.trim()) ? base.trim() : 'HEAD'
      // Validate ref name to prevent git flag injection
      const diffBase = /^[a-zA-Z0-9._\-\/~^@{}:]+$/.test(rawBase) ? rawBase : 'HEAD'

      let diffOutput = ''
      try {
        const { stdout } = await execFileAsync(GIT, ['diff', diffBase], {
          cwd: cwdReal,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 10000,
        })
        diffOutput = stdout
      } catch (err) {
        if (err.message && err.message.includes('unknown revision')) {
          try {
            const { stdout } = await execFileAsync(GIT, ['diff'], {
              cwd: cwdReal,
              maxBuffer: 2 * 1024 * 1024,
              timeout: 10000,
            })
            diffOutput = stdout
          } catch (innerErr) {
            sendFn(ws, {
              type: 'diff_result',
              files: [],
              error: innerErr.message || 'Failed to run git diff',
            })
            return
          }
        } else {
          sendFn(ws, {
            type: 'diff_result',
            files: [],
            error: err.message || 'Failed to run git diff',
          })
          return
        }
      }

      // Also get staged changes if diffBase is HEAD
      if (diffBase === 'HEAD') {
        try {
          const { stdout: stagedOutput } = await execFileAsync(GIT, ['diff', '--cached', 'HEAD'], {
            cwd: cwdReal,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 10000,
          })
          if (stagedOutput) {
            diffOutput = (diffOutput ? diffOutput + '\n' : '') + stagedOutput
          }
        } catch {
          // Ignore errors for staged diff
        }
      }

      const files = diffOutput.trim() ? parseDiff(diffOutput) : []

      // Deduplicate files that appear in both unstaged and staged diffs
      const seen = new Map()
      for (const file of files) {
        if (seen.has(file.path)) {
          const existing = seen.get(file.path)
          existing.hunks.push(...file.hunks)
          existing.additions += file.additions
          existing.deletions += file.deletions
        } else {
          seen.set(file.path, file)
        }
      }

      // Discover untracked files (new files not yet staged)
      try {
        const { stdout: untrackedOutput } = await execFileAsync(
          GIT, ['ls-files', '--others', '--exclude-standard'],
          { cwd: cwdReal, maxBuffer: 512 * 1024, timeout: 5000 }
        )
        if (untrackedOutput.trim()) {
          const untrackedPaths = untrackedOutput.trim().split('\n')
            .filter(p => p && !seen.has(p))
            .sort()
            .slice(0, 10)

          const MAX_UNTRACKED_SIZE = 50 * 1024
          for (const filePath of untrackedPaths) {
            try {
              const absPath = resolve(cwdReal, filePath)
              let realAbsPath
              try {
                realAbsPath = await realpath(absPath)
              } catch {
                continue
              }
              if (!realAbsPath.startsWith(cwdReal + '/') && realAbsPath !== cwdReal) continue
              const fileStat = await stat(realAbsPath)
              if (!fileStat.isFile()) continue

              let lines, additions
              if (fileStat.size > MAX_UNTRACKED_SIZE) {
                lines = [{ type: 'context', content: `File too large to preview (${(fileStat.size / 1024).toFixed(1)} KB)` }]
                additions = 0
              } else {
                const buf = await readFile(realAbsPath)
                const checkLen = Math.min(buf.length, 8192)
                let isBinary = false
                for (let i = 0; i < checkLen; i++) {
                  if (buf[i] === 0) {
                    isBinary = true
                    break
                  }
                }
                if (isBinary) {
                  lines = [{ type: 'context', content: 'Binary file — not shown' }]
                  additions = 0
                } else {
                  const content = buf.toString('utf-8')
                  const contentLines = content.split('\n')
                  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
                    contentLines.pop()
                  }
                  lines = contentLines.map(l => ({ type: 'addition', content: l }))
                  additions = lines.length
                }
              }

              seen.set(filePath, {
                path: filePath,
                status: 'untracked',
                additions,
                deletions: 0,
                hunks: [{
                  header: 'New untracked file',
                  lines,
                }],
              })
            } catch {
              // Skip files that can't be read
            }
          }
        }
      } catch {
        // Ignore ls-files errors
      }

      sendFn(ws, {
        type: 'diff_result',
        files: Array.from(seen.values()),
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'diff_result',
        files: [],
        error: err.message || 'Unknown error',
      })
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
            console.error(`[ws] Failed to read command file ${join(dir, entry.name)}:`, err.message)
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

  /** List custom agents from project and user agent directories */
  async function listAgents(ws, cwd, sessionId) {
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
            console.error(`[ws] Failed to read agent file ${join(dir, entry.name)}:`, err.message)
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
    await scanDir(join(homedir(), '.claude', 'agents'), 'user')

    agents.sort((a, b) => a.name.localeCompare(b.name))

    const response = { type: 'agent_list', agents }
    if (sessionId) response.sessionId = sessionId
    sendFn(ws, response)
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
      .replace(/\*\*/g, '⚡GLOBSTAR⚡')
      .replace(/\*/g, '[^/]*')
      .replace(/⚡GLOBSTAR⚡/g, '.*')
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
        } catch {
          return
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
              const realTarget = await realpath(absPath)
              if (!realTarget.startsWith(cwdReal + '/') && realTarget !== cwdReal) continue
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

  /** Write file content at a given path within the session CWD */
  async function writeFileContent(ws, requestedPath, content, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'write_file_result',
        path: null,
        error: 'File writing is not available in this mode',
      })
      return
    }

    if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
      sendFn(ws, {
        type: 'write_file_result',
        path: null,
        error: 'No file path provided',
      })
      return
    }

    // 5MB size limit
    const MAX_SIZE = 5 * 1024 * 1024
    if (typeof content === 'string' && content.length > MAX_SIZE) {
      sendFn(ws, {
        type: 'write_file_result',
        path: requestedPath,
        error: 'Content too large (max 5MB)',
      })
      return
    }

    let absPath = null
    try {
      absPath = normalize(resolve(sessionCwd, requestedPath.trim()))

      const cwdReal = await resolveSessionCwd(sessionCwd)

      // Resolve absPath through realpath of the session CWD to handle symlinks
      // (e.g. macOS /var → /private/var)
      const absInCwd = normalize(resolve(cwdReal, requestedPath.trim()))

      // Path traversal check: target must be within session CWD
      if (!absInCwd.startsWith(cwdReal + '/') && absInCwd !== cwdReal) {
        sendFn(ws, {
          type: 'write_file_result',
          path: requestedPath,
          error: 'Access denied: file writing is restricted to the project directory',
        })
        return
      }
      absPath = absInCwd

      // Create parent directories if needed
      await mkdir(resolve(absPath, '..'), { recursive: true })

      // Write the file
      await fsWriteFile(absPath, content || '', 'utf-8')

      sendFn(ws, {
        type: 'write_file_result',
        path: absPath,
        error: null,
      })
    } catch (err) {
      let errorMessage
      if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else errorMessage = err.message || 'Unknown error'

      sendFn(ws, {
        type: 'write_file_result',
        path: absPath || requestedPath || null,
        error: errorMessage,
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
      const cwdReal = await resolveSessionCwd(sessionCwd)
      await execFileAsync(GIT, ['add', '--', ...files], {
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
      const cwdReal = await resolveSessionCwd(sessionCwd)
      await execFileAsync(GIT, ['reset', 'HEAD', '--', ...files], {
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

  return {
    listDirectory,
    browseFiles,
    readFile: readFileContent,
    writeFile: writeFileContent,
    getDiff,
    listSlashCommands,
    listAgents,
    listFiles,
    gitStage,
    gitUnstage,
    gitCommit,
  }
}
