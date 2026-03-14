import { readFile, writeFile as fsWriteFile, stat, mkdir } from 'fs/promises'
import { resolve, normalize, extname } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { parseDiff } from '../diff-parser.js'
import { GIT } from '../git.js'

const execFileAsync = promisify(execFileCb)

/** Image extensions to MIME type mapping (module-level to avoid per-call allocation) */
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

/**
 * File reading, writing, and diff operations.
 *
 * @param {Function} sendFn - (ws, message) => void
 * @param {Function} resolveSessionCwd - shared CWD resolver
 * @param {Function} validatePathWithinCwd - shared path validator
 * @returns {Object} reader operation methods
 */
export function createReaderOps(sendFn, resolveSessionCwd, validatePathWithinCwd) {

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

      const { valid, realPath: realAbsPath } = await validatePathWithinCwd(absPath, sessionCwd)
      if (!valid) {
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
      const ext = extname(absPath).slice(1).toLowerCase()

      // Image files: send as base64 data URL for preview
      // SVG excluded — it's an active document format (scripts/external refs); render as text instead
      if (IMAGE_MIME[ext]) {
        const dataUrl = `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`
        sendFn(ws, {
          type: 'file_content',
          path: absPath,
          content: dataUrl,
          language: 'image',
          size: fileStat.size,
          truncated: false,
          error: null,
        })
        return
      }

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
      const { valid: writeValid } = await validatePathWithinCwd(absInCwd, sessionCwd)
      if (!writeValid) {
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
              const validation = await validatePathWithinCwd(absPath, sessionCwd)
              if (!validation.valid) continue
              const fileStat = await stat(validation.realPath)
              if (!fileStat.isFile()) continue

              let lines, additions
              if (fileStat.size > MAX_UNTRACKED_SIZE) {
                lines = [{ type: 'context', content: `File too large to preview (${(fileStat.size / 1024).toFixed(1)} KB)` }]
                additions = 0
              } else {
                const buf = await readFile(validation.realPath)
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

  return {
    readFile: readFileContent,
    writeFile: writeFileContent,
    getDiff,
  }
}
