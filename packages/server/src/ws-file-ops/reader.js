import { readFile, stat, mkdir, realpath } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { resolve, normalize, extname } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { GET_DIFF_BASE_MAX_LENGTH } from '@chroxy/protocol'
import { parseDiff, diffFileHeaderPaths } from '../diff-parser.js'
import { GIT } from '../git.js'
import { openNoFollow } from './open-nofollow.js'
import { createLogger } from '../logger.js'
import { isSafeArgvValue } from '../utils/argv-safety.js'
import { unresolvablePathError, isConfigDirOrDirectChild, CONFIG_DIR_REFUSAL } from './common.js'

const execFileAsync = promisify(execFileCb)

// #8012 — the message read_file sends when the first `realpath()` failed with
// one of these codes for a path INSIDE the project. Any other code, or any
// path outside it, gets the generic denial instead (see unresolvablePathError).
const READ_UNRESOLVABLE_REASONS = {
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  ENOTDIR: 'File not found',
}

// #8016 — the same, for write_file and append_memory.
const WRITE_UNRESOLVABLE_REASONS = {
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  ENOTDIR: 'Not a directory',
}
const log = createLogger('ws')

// getDiff reads paths out of `git diff` output (parseDiff, diffFileHeaderPaths), and
// the config-directory rule is applied to those paths. A user's or repo's git config
// can change how a changed file is printed, so every `git diff` call pins what it
// reads. Settings not named here are not pinned.
//   --src-prefix=a/ --dst-prefix=b/   the `a/` / `b/` header form; beats diff.noprefix,
//                                      diff.mnemonicPrefix, diff.srcPrefix, diff.dstPrefix
//   -c diff.relative=false             paths from the repository root, not the cwd
//   --no-ext-diff                      an external diff driver (diff.external, or a
//                                      `diff=` attribute with diff.<name>.command) prints
//                                      no `diff --git` header, so its output would land in
//                                      the previous entry
//   --no-color                         colour escapes start every header line
// Checked on git 2.55.0: each prefix key alone and all four together still print
// `a/` / `b/`; diff.relative=true from a subdirectory prints cwd-relative paths and
// drops files outside it, and `-c diff.relative=false` restores repo-root paths.
// Relative output is pinned with `-c` rather than `--no-relative` because the repo
// states no minimum git version and `--no-relative` needs git 2.28; a `-c` setting
// is accepted by every git (an unknown key is ignored). `-c` must come BEFORE the
// subcommand, so it is a separate piece of argv from the options after it.
const DIFF_PIN_CONFIG = ['-c', 'diff.relative=false']
const DIFF_HEADER_ARGS = ['--src-prefix=a/', '--dst-prefix=b/', '--no-ext-diff', '--no-color']

/**
 * The supported authored layout has a thin CLAUDE.md importing cwd/AGENTS.md.
 * Recognize only that entire adapter, never turn arbitrary @imports into writes.
 * A bounded, symlink-refusing read cannot follow an external adapter or wait on
 * a special file. Legacy project files (including in-bounds links) retain their
 * existing append destination and the validation below.
 */
async function projectMemoryFilename(cwdReal) {
  let fh
  try {
    fh = await openNoFollow(resolve(cwdReal, 'CLAUDE.md'), fsConstants.O_RDONLY)
    const st = await fh.stat()
    if (!st.isFile() || st.size > 64) return 'CLAUDE.md'
    const buffer = Buffer.alloc(65)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await fh.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const content = buffer.subarray(0, length).toString('utf8').trim()
    return content === '@AGENTS.md' || content === '@./AGENTS.md' ? 'AGENTS.md' : 'CLAUDE.md'
  } catch (err) {
    // Missing legacy files are created by append; existing links are validated
    // by the unchanged realpath/containment pipeline rather than read here.
    if (err.code === 'ENOENT' || err.code === 'ELOOP') return 'CLAUDE.md'
    throw err
  } finally {
    await fh?.close()
  }
}

/**
 * Longest `base` getDiff will hand to git. A revision is short — a full OID is
 * 40 characters and a ref name far less — so this rejects nothing legitimate,
 * and it bounds what could otherwise be spent per request: two `rev-parse`
 * argvs, plus whatever git echoes back into an error message.
 *
 * #7870 — imported rather than redeclared: `GetDiffSchema` (packages/protocol)
 * now rejects a `base` over this same length AT THE WIRE, before getDiff ever
 * runs. This constant is the single source both layers read, so the two
 * cannot drift the way a hand-copied number could. This gate stays anyway —
 * it is the server's OWN, independent defense-in-depth boundary, correct even
 * for a future caller that reaches getDiff by a path that skips schema
 * validation (see packages/server/tests/ws-server-file-ops.test.js's direct
 * `createReaderOps` calls, which exercise it without going over the wire).
 */
const MAX_DIFF_BASE_LENGTH = GET_DIFF_BASE_MAX_LENGTH

/** Longest error detail written to the server log in one line (#7298). */
const MAX_LOGGED_ERROR_LENGTH = 500

/**
 * Bound one error detail before it reaches the log.
 *
 * An `execFile` rejection's `message` carries the whole command line — which
 * includes the client's own `base` — followed by the child's stderr, and
 * neither is bounded by anything the caller controls. Logging it raw turns an
 * oversized input into log amplification, so the log gets a prefix and the
 * original length instead.
 */
export function truncateForLog(message) {
  const text = String(message ?? '')
  return text.length > MAX_LOGGED_ERROR_LENGTH
    ? `${text.slice(0, MAX_LOGGED_ERROR_LENGTH)}… (truncated, ${text.length} chars)`
    : text
}

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
 * @param {Function} [execImpl] - injectable promisified execFile seam (defaults to the
 *   real one; matches createGitOps' 5th arg, #7871). Every git invocation inside
 *   getDiff routes through this — `rev-parse --git-dir`, both `rev-parse --verify`
 *   calls, both `diff` calls, and `ls-files` — so the preflight failure branch
 *   (and the exit-128 classification, #7877) can be driven by tests without a
 *   real non-repo/permission-denied/timeout condition on the host.
 * @returns {Object} reader operation methods
 */
export function createReaderOps(sendFn, resolveSessionCwd, validatePathWithinCwd, execImpl = execFileAsync) {

  /**
   * Read file content at a given path within the session CWD.
   *
   * @param {string} [requestId] - #6502: optional request nonce echoed back on
   *   every `file_content` reply so the dashboard can correlate replies to the
   *   latest in-flight request. Omitted from the payload when not provided.
   */
  async function readFileContent(ws, requestedPath, sessionCwd, requestId) {
    // Attach the request nonce (when present) to every file_content reply so a
    // superseded read can be dropped client-side without echoed-path matching.
    const send = requestId === undefined
      ? (payload) => sendFn(ws, payload)
      : (payload) => sendFn(ws, { ...payload, requestId })
    if (!sessionCwd) {
      send({
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
      send({
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

      // Resolve symlinks before validation to prevent TOCTOU attacks.
      // realpath() is called here so both the validation and the subsequent read
      // use the same canonical path — a symlink swapped between calls cannot
      // redirect the read outside the workspace.
      let resolvedAbsPath
      try {
        resolvedAbsPath = await realpath(absPath)
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Before surfacing "File not found", enforce workspace boundary.
          // A nonexistent path outside the root must return Access denied to
          // avoid leaking filesystem existence information as an oracle.
          //
          // #8000 — decide it with the SAME canonical check the existing-file
          // path uses below: realpath the deepest existing ancestor, compare
          // against the realpath'd cwd. This used to be a LEXICAL compare of
          // `absPath` (built from the cwd as given) against the realpath'd cwd,
          // which was wrong both ways:
          //   - a cwd spelled non-canonically (through a symlink on POSIX, as an
          //     8.3 short name on Windows) made a missing file INSIDE the
          //     project answer "Access denied";
          //   - `<cwd>/link-to-outside/missing` looked lexically inside and
          //     answered "File not found" — an existence oracle for the
          //     outside directory, through the link.
          // A check that cannot be answered (ELOOP, EACCES on an ancestor)
          // denies: "could not check" must never read as "not found".
          let withinCwd = false
          try {
            ({ valid: withinCwd } = await validatePathWithinCwd(absPath, sessionCwd))
          } catch {
            withinCwd = false
          }
          if (!withinCwd) {
            send({
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
          // Files directly in the config directory are daemon-managed state, so
          // reads follow the same rule as writes: a missing name there answers
          // the refusal an existing one does, never "File not found". Only
          // reached once the path is known to be inside the project, where the
          // deepest-ancestor walk has already resolved this same path; a check
          // that cannot be answered denies, as it does for writes.
          if (await isConfigDirOrDirectChild(absPath)) {
            send({
              type: 'file_content',
              path: absPath,
              content: null,
              language: null,
              size: null,
              truncated: false,
              error: CONFIG_DIR_REFUSAL,
            })
            return
          }
          send({
            type: 'file_content',
            path: absPath,
            content: null,
            language: null,
            size: null,
            truncated: false,
            error: 'File not found',
          })
          return
        }
        // #8012 — any OTHER failure (EACCES, EPERM, ENOTDIR, ELOOP, …) used to
        // skip the containment check and reach the outer catch, which sent
        // "Permission denied" for EACCES and Node's raw message — server path
        // included — for the rest. For a path outside the project that told
        // "blocked" apart from "readable" and "missing". Outside, or when the
        // check cannot be answered (a cycle), the answer is now the same denial
        // every outside path gets; only an in-project path keeps a specific
        // message, and never the raw text.
        const cwdReal = await resolveSessionCwd(sessionCwd).catch(() => null)
        send({
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: null,
          truncated: false,
          error: await unresolvablePathError(err, absPath, cwdReal, READ_UNRESOLVABLE_REASONS,
            'Access denied: file reading is restricted to the project directory'),
        })
        return
      }

      const { valid } = await validatePathWithinCwd(resolvedAbsPath, sessionCwd)
      if (!valid) {
        send({
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

      // The config directory itself and any file directly in it are
      // daemon-managed state, so the file viewer treats reads the same way as
      // writes. Checked on the resolved path (a symlink into the config directory
      // is judged by where it lands) and BEFORE `stat`, so no size or type of a
      // refused file is revealed.
      if (await isConfigDirOrDirectChild(resolvedAbsPath)) {
        send({
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: null,
          truncated: false,
          error: CONFIG_DIR_REFUSAL,
        })
        return
      }

      const fileStat = await stat(resolvedAbsPath)
      if (fileStat.isDirectory()) {
        send({
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
        send({
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

      // openNoFollow closes the post-validation TOCTOU window: if the file at
      // resolvedAbsPath was replaced with a symlink between
      // validatePathWithinCwd() and this open, it is rejected with ELOOP — by
      // the kernel on POSIX (O_NOFOLLOW), by an lstat + fd-identity check on
      // win32, where O_NOFOLLOW does not exist and the bare flag silently
      // no-opped until #7280. See open-nofollow.js for the exact per-platform
      // guarantee and the race it cannot close.
      let buf
      {
        let fh
        try {
          fh = await openNoFollow(resolvedAbsPath, fsConstants.O_RDONLY)
          // #7938 — `fileStat` above was taken BEFORE this open, so it can't
          // see a FIFO/device swapped in during the TOCTOU window between
          // that stat and this open. openNoFollow's O_NONBLOCK keeps the
          // open from hanging on a planted FIFO with no writer, but the
          // content must still not be read from anything but a regular file
          // — re-check on the OPENED fd, which can't be raced the same way.
          const fhStat = await fh.stat()
          if (!fhStat.isFile()) {
            // No path in the text: this reaches the client verbatim.
            throw new Error('Not a regular file')
          }
          buf = await fh.readFile()
        } catch (openErr) {
          if (openErr.code === 'ELOOP') {
            // Symlink appeared at the canonical path after validation — reject
            send({
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
          throw openErr
        } finally {
          await fh?.close()
        }
      }
      const ext = extname(absPath).slice(1).toLowerCase()

      // Image files: send as base64 data URL for preview
      // SVG excluded — it's an active document format (scripts/external refs); render as text instead
      if (IMAGE_MIME[ext]) {
        const dataUrl = `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`
        send({
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
          send({
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

      send({
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

      send({
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

      // Determine whether the target file already exists so we can choose
      // between a symlink-refusing truncate (existing) and parent-validated
      // creation (new).
      let resolvedTarget
      let fileExists = false
      try {
        resolvedTarget = await realpath(absInCwd)
        fileExists = true
      } catch (err) {
        if (err.code === 'ENOENT') {
          // File doesn't exist yet — validate parent directory instead.
          // Use the lexical path for the new-file case.
          resolvedTarget = absInCwd
        } else {
          // #8016 — any other failure used to reach the outer catch, which
          // answered "Permission denied" (EACCES) or the raw Node message,
          // server path included, even for a target outside the project.
          sendFn(ws, {
            type: 'write_file_result',
            path: requestedPath,
            error: await unresolvablePathError(err, absInCwd, cwdReal, WRITE_UNRESOLVABLE_REASONS,
              'Access denied: file writing is restricted to the project directory'),
          })
          return
        }
      }

      // Existing file: validate the resolved (symlink-followed) path. New file:
      // validate the lexical path. A check that cannot be answered (a
      // self-referential link's ELOOP, the depth ceiling, a file swapped
      // between the two resolutions) denies rather than sending the helper's
      // own text (#8016).
      let writeValid = false
      try {
        ({ valid: writeValid } = await validatePathWithinCwd(fileExists ? resolvedTarget : absInCwd, sessionCwd))
      } catch {
        writeValid = false
      }
      if (!writeValid) {
        sendFn(ws, {
          type: 'write_file_result',
          path: requestedPath,
          error: 'Access denied: file writing is restricted to the project directory',
        })
        return
      }
      absPath = fileExists ? resolvedTarget : absInCwd

      // Generic file writes refuse the daemon's config directory, so the deploy
      // control files can only be written through `daemon_update_action`. This runs
      // BEFORE the mkdir below: a refused write must not create anything either.
      if (await isConfigDirOrDirectChild(absPath)) {
        sendFn(ws, { type: 'write_file_result', path: requestedPath, error: CONFIG_DIR_REFUSAL })
        return
      }

      // Create parent directories if needed
      await mkdir(resolve(absPath, '..'), { recursive: true })

      // Write the file through openNoFollow to close the post-validation TOCTOU
      // window: a symlink swapped in at absPath between validation and this
      // open is rejected with ELOOP on every platform (#7280 — the bare
      // O_NOFOLLOW flag this used to pass is undefined on win32 and ORed to 0).
      const data = Buffer.from(content || '', 'utf-8')
      {
        let fh
        try {
          const flags = fileExists
            ? fsConstants.O_WRONLY | fsConstants.O_TRUNC
            : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          fh = await openNoFollow(absPath, flags, 0o666)
          await fh.writeFile(data)
        } catch (openErr) {
          if (openErr.code === 'ELOOP') {
            // Symlink appeared at the target path after validation — reject
            sendFn(ws, {
              type: 'write_file_result',
              path: requestedPath,
              error: 'Access denied: file writing is restricted to the project directory',
            })
            return
          }
          if (openErr.code === 'EEXIST') {
            // Race: file was created between our existence check and O_EXCL open.
            // Retry once using the existing-file path (O_TRUNC without O_EXCL).
            try {
              fh = await openNoFollow(absPath, fsConstants.O_WRONLY | fsConstants.O_TRUNC, 0o666)
              await fh.writeFile(data)
            } catch (retryErr) {
              if (retryErr.code === 'ELOOP') {
                sendFn(ws, {
                  type: 'write_file_result',
                  path: requestedPath,
                  error: 'Access denied: file writing is restricted to the project directory',
                })
                return
              }
              throw retryErr
            }
          } else {
            throw openErr
          }
        } finally {
          await fh?.close()
        }
      }

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

  /**
   * Append a single note line to the session cwd's project memory. Thin Claude
   * adapters route to authored AGENTS.md; legacy CLAUDE.md files are created
   * when absent (#6861, epic #6760).
   *
   * The TARGET is chosen SERVER-side (a fixed cwd filename) — the client sends only
   * the note text, never a path — so the write is path-confined BY CONSTRUCTION.
   * validatePathWithinCwd is still run for symlink-escape defence (a CLAUDE.md
   * symlinked out of the workspace is rejected), and the open goes through
   * openNoFollow to close the post-validation TOCTOU window, matching
   * writeFileContent above.
   *
   * The write uses O_APPEND (+ O_CREAT): each append lands atomically at EOF, so
   * concurrent appends can't lose a line and a crash can't truncate the file —
   * the correct primitive for appending, unlike a read-modify-write O_TRUNC. The
   * only read is a cheap 1-byte tail check to decide whether a separating newline
   * is needed; a race there is benign (a stray/missing separator at worst — the
   * note line itself is always written atomically and in full).
   */
  async function appendMemory(ws, note, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'append_memory_result', path: null, created: false, error: 'Memory is not available in this mode' })
      return
    }
    if (typeof note !== 'string' || !note.trim()) {
      sendFn(ws, { type: 'append_memory_result', path: null, created: false, error: 'No note provided' })
      return
    }
    const MAX_NOTE = 10_000
    if (note.length > MAX_NOTE) {
      sendFn(ws, { type: 'append_memory_result', path: null, created: false, error: `Note too long (max ${MAX_NOTE} characters)` })
      return
    }
    // Collapse to a single line — quick-append is a one-line note by definition.
    const line = note.trim().replace(/\r?\n/g, ' ')

    let absPath = null
    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)
      const filename = await projectMemoryFilename(cwdReal)
      const target = normalize(resolve(cwdReal, filename))

      // Resolve symlinks: if CLAUDE.md already exists, validate its real path;
      // if not, validate the lexical target (still inside cwd by construction).
      let resolvedTarget
      let fileExists = false
      try {
        resolvedTarget = await realpath(target)
        fileExists = true
      } catch (err) {
        if (err.code === 'ENOENT') {
          if (filename === 'AGENTS.md') throw new Error('Authored project memory AGENTS.md is missing')
          resolvedTarget = target
        } else {
          // #8016 — a CLAUDE.md link whose target cannot be resolved: same
          // answer as a target outside the project, never the raw text.
          sendFn(ws, {
            type: 'append_memory_result',
            path: null,
            created: false,
            error: await unresolvablePathError(err, target, cwdReal, WRITE_UNRESOLVABLE_REASONS,
              'Access denied: memory is restricted to the project directory'),
          })
          return
        }
      }

      // A check that cannot be answered denies (#8016).
      let valid = false
      try {
        ({ valid } = await validatePathWithinCwd(fileExists ? resolvedTarget : target, sessionCwd))
      } catch {
        valid = false
      }
      if (!valid) {
        sendFn(ws, {
          type: 'append_memory_result',
          path: null,
          created: false,
          error: 'Access denied: memory is restricted to the project directory',
        })
        return
      }
      absPath = fileExists ? resolvedTarget : target

      // Same rule as write_file: generic writes refuse the config directory.
      if (await isConfigDirOrDirectChild(absPath)) {
        sendFn(ws, { type: 'append_memory_result', path: null, created: false, error: CONFIG_DIR_REFUSAL })
        return
      }

      // Cheap tail check: does the existing file already end with a newline? If
      // not, prepend one so the note lands on its own line. Best-effort (a race
      // only affects the separator, never the note itself).
      let needsLeadingNewline = false
      if (fileExists) {
        try {
          const st = await stat(absPath)
          if (st.size > 0) {
            let rfh
            try {
              // #7938 — openNoFollow's O_NONBLOCK keeps a FIFO raced in at this
              // path from hanging the open. No post-open isFile() check here,
              // deliberately: the read below is a positioned read (pread), and
              // pread on a FIFO fails ESPIPE and on a directory EISDIR, both
              // landing in the advisory catch exactly as a refusal would. A
              // check could not change any outcome (a mutation deleting one
              // survived every test for that reason), and the one byte read is
              // never returned to the client — it only picks the separator.
              rfh = await openNoFollow(absPath, fsConstants.O_RDONLY)
              const tail = Buffer.alloc(1)
              await rfh.read(tail, 0, 1, st.size - 1)
              needsLeadingNewline = tail[0] !== 0x0a
            } finally {
              await rfh?.close()
            }
          }
        } catch {
          // Tail read is advisory only — fall back to no separator.
        }
      }

      const data = Buffer.from((needsLeadingNewline ? '\n' : '') + line + '\n', 'utf-8')

      // O_APPEND: atomic append at EOF (no lost-update / truncation window).
      // Legacy files use O_CREAT without O_EXCL, so a concurrent creator just
      // means we append instead. Authored rules must still exist at the open:
      // a source removed by another operation must not be recreated as a note.
      // openNoFollow keeps the symlink-escape defence on the final component, on win32 as
      // well as POSIX (#7280).
      {
        let fh
        try {
          let flags = fsConstants.O_WRONLY | fsConstants.O_APPEND
          if (filename !== 'AGENTS.md') flags |= fsConstants.O_CREAT
          fh = await openNoFollow(absPath, flags, 0o666)
          await fh.writeFile(data)
        } catch (openErr) {
          if (openErr.code === 'ENOENT' && filename === 'AGENTS.md') {
            throw new Error('Authored project memory AGENTS.md is missing')
          }
          if (openErr.code === 'ELOOP') {
            sendFn(ws, {
              type: 'append_memory_result',
              path: null,
              created: false,
              error: 'Access denied: memory is restricted to the project directory',
            })
            return
          }
          throw openErr
        } finally {
          await fh?.close()
        }
      }

      sendFn(ws, { type: 'append_memory_result', path: absPath, created: !fileExists, error: null })
    } catch (err) {
      let errorMessage
      if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else errorMessage = err.message || 'Unknown error'
      sendFn(ws, { type: 'append_memory_result', path: absPath, created: false, error: errorMessage })
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

      // Check if the directory is a git repository before running git commands
      try {
        // #7877 — LC_ALL/LANG=C: the classification below reads git's stderr
        // for an English substring. Left to the daemon host's own locale, a
        // translated "not a git repository" message would silently miss that
        // substring and fall into the "other exit-128" branch on EVERY
        // request from that host — exactly the per-request log spam #7862's
        // review downgrade was trying to avoid. Forcing C here makes the
        // classification locale-independent without touching any other git
        // invocation in this function (none of the others string-match stderr).
        await execImpl(GIT, ['rev-parse', '--git-dir'], {
          cwd: cwdReal,
          timeout: 5000,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        })
      } catch (revParseErr) {
        const stderr = (revParseErr.stderr || revParseErr.message || '').toLowerCase()
        // #7877 — git exits 128 for MANY fatals, not only "not a git
        // repository": `fatal: detected dubious ownership in repository at
        // '<path>'` (mounted volumes, container/worktree setups) is the one
        // chroxy actually hits. The old `stderr.includes(...) || code === 128`
        // OR'd every other 128 into the same bucket, so a dubious-ownership
        // session was misreported to the client AND logged nowhere — the
        // operator had no trace of the real cause.
        //
        // The client-facing contract is UNCHANGED here on purpose (still a
        // fixed 'Not a git repository' for any exit-128, never raw stderr —
        // #7298 must hold): the fix is that an "other 128" is now visible to
        // the operator. `isOtherExit128Fatal` is exactly the case the old
        // predicate swallowed: an exit-128 whose stderr, in the forced C
        // locale above, does NOT actually say "not a git repository".
        const isGenuineNotGitRepo = stderr.includes('not a git repository')
        const isOtherExit128Fatal = !isGenuineNotGitRepo && revParseErr.code === 128
        const isNotGitRepo = isGenuineNotGitRepo || isOtherExit128Fatal

        if (isOtherExit128Fatal) {
          // Routine-ish (dubious ownership, etc.) but worth an operator's
          // attention — warn, not error, and not silence (#7877).
          log.warn(`git rev-parse --git-dir exited 128 without a "not a git repository" message — classified as non-repo anyway: ${truncateForLog(revParseErr.message)}`)
        } else if (!isNotGitRepo) {
          // Only the genuinely UNEXPECTED failure (git missing, timeout,
          // EACCES) logs at error level. "Not a git repository" is the
          // ordinary state of a session whose cwd is not a checkout, and it
          // arrives on every `get_diff` that session sends — logging it at
          // error level buries the failures worth reading, which is the same
          // defect as not logging at all (Copilot review of #7862).
          log.error(`git rev-parse --git-dir failed: ${truncateForLog(revParseErr.message)}`)
        }
        sendFn(ws, {
          type: 'diff_result',
          files: [],
          error: isNotGitRepo ? 'Not a git repository' : 'Failed to run git diff',
        })
        return
      }

      const rawBase = (typeof base === 'string' && base.trim()) ? base.trim() : 'HEAD'
      // #7290: `base` is client-controlled and UNVALIDATED on the wire —
      // GetDiffSchema is `z.object({ type }).passthrough()` — and it lands in
      // the REVISION slot of `git diff <base>`. The charset allowlist below
      // used to be the only check, and it put `-` INSIDE its character class,
      // so every single-token option passed it: `--stat`, `-p`, `--exit-code`,
      // `--ext-diff`, and `-O<path>` — which makes git read <path> as a diff
      // orderfile and report whether it could, straight back to the client,
      // which at the time forwarded `err.message` verbatim (see #7298 below).
      //
      // isSafeArgvValue is the load-bearing half (it rejects the leading dash);
      // the allowlist stays as a charset narrowing. A `--` separator canNOT
      // substitute for either — see utils/argv-safety.js for the measurements.
      // A git revision can never legitimately begin with `-`, so REJECTING is
      // correct here; falling back to 'HEAD' preserves the pre-existing
      // contract for any unusable base.
      //
      // #7298 — HALF 1 of 2. The charset above is a NARROWING, never a
      // decision: it cannot tell a revision from a path, and `:` and `/` used
      // to be members, so `HEAD:<path>` and a bare absolute path both reached
      // git as revisions and git answered on the wire (measured, git 2.55.0):
      //
      //     base='HEAD:/etc/passwd' -> fatal: path '/etc/passwd' exists on
      //                                disk, but not in 'HEAD'
      //     base='HEAD:absent'      -> fatal: path 'absent' does not exist in 'HEAD'
      //     base='/etc/passwd'      -> fatal: '/etc/passwd' is outside
      //                                repository at '<cwdReal>'
      //
      // — a filesystem-wide path-existence oracle, as the daemon user,
      // escaping the session cwd, plus the workspace path itself.
      //
      // So RESOLVE the base instead of pattern-matching it: only a revision
      // that names a real commit in THIS repo is ever handed to `git diff`,
      // and everything else falls back to HEAD (the pre-existing contract for
      // an unusable base) without git being asked the client's question at
      // all. `rev-parse --verify --quiet` is silent on failure — it exits 1
      // with empty stderr for every probe above — so the resolution step is
      // not itself an oracle. `:` is dropped from the charset in the same
      // change: `<rev>:<path>` names a BLOB, never a commit.
      //
      // Do NOT "harden" this by appending a `--` to the diff argv instead.
      // That changes an unresolvable base's error to `fatal: bad revision`,
      // which the old `unknown revision` recovery predicate missed — and `--`
      // does not stop option parsing for a token that precedes it anyway
      // (#7290, utils/argv-safety.js).
      // The length bound is the third gate, and it is about COST rather than
      // about the oracle: `base` is unconstrained on the wire (#7870), and
      // every byte of it is spawned twice (both `rev-parse` calls) and can be
      // echoed back into an error message. A revision is short, so nothing
      // legitimate is rejected. Only the LENGTH is logged — never the value,
      // which is the input this whole function exists to distrust.
      if (rawBase.length > MAX_DIFF_BASE_LENGTH) {
        log.warn(`get_diff base rejected: ${rawBase.length} chars exceeds the ${MAX_DIFF_BASE_LENGTH}-char limit`)
      }
      const candidate = (
        rawBase.length <= MAX_DIFF_BASE_LENGTH &&
        isSafeArgvValue(rawBase) &&
        /^[a-zA-Z0-9._\-\/~^@{}]+$/.test(rawBase)
      )
        ? rawBase
        : 'HEAD'

      /** Resolve a revision to a commit OID, or null when it names no commit. */
      const resolveCommit = async (rev) => {
        try {
          const { stdout } = await execImpl(
            GIT, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
            { cwd: cwdReal, timeout: 5000 }
          )
          return stdout.trim() || null
        } catch {
          return null
        }
      }

      const headOid = await resolveCommit('HEAD')
      // An unresolvable base is HEAD. HEAD itself is unresolvable only in a
      // repo with no commits, where `git diff HEAD` used to fail into the
      // `unknown revision` recovery — so go straight to the plain `git diff`
      // that recovery ran, and drop the stderr-substring predicate with it.
      const baseOid = candidate === 'HEAD'
        ? headOid
        : (await resolveCommit(candidate)) || headOid
      const baseIsHead = baseOid === null || baseOid === headOid

      let diffOutput = ''
      try {
        const { stdout } = await execImpl(GIT, [...DIFF_PIN_CONFIG, 'diff', ...DIFF_HEADER_ARGS, ...(baseOid ? [baseOid] : [])], {
          cwd: cwdReal,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 10000,
        })
        diffOutput = stdout
      } catch (err) {
        // #7298 — HALF 2 of 2. Raw git stderr used to go to the client
        // verbatim, which is what made every message above readable on the
        // wire. Half 1 keeps the client's own string out of that stderr, but
        // any git failure can name a path (the workspace, an object, a
        // config), so the detail stays server-side and the wire gets a fixed
        // string. Both halves are load-bearing; neither is redundant.
        log.error(`git diff failed: ${truncateForLog(err.message)}`)
        sendFn(ws, {
          type: 'diff_result',
          files: [],
          error: 'Failed to run git diff',
        })
        return
      }

      // Also get staged changes if the effective base is HEAD
      if (baseIsHead) {
        try {
          const { stdout: stagedOutput } = await execImpl(GIT, [...DIFF_PIN_CONFIG, 'diff', ...DIFF_HEADER_ARGS, '--cached', 'HEAD'], {
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

      let files = diffOutput.trim() ? parseDiff(diffOutput) : []

      // Files directly in the config directory are daemon-managed state, so the
      // diff view treats them the way the file viewer and generic writes do: a
      // changed one is left out of the reply, hunks and all, rather than listed by
      // name. `git diff` names files from the repository root (not the session
      // cwd), and an entry can touch more than one path (the source of a rename).
      // An entry with no placeable path is left out too: "could not check" must
      // never read as "not in the config directory".
      if (files.length > 0) {
        const { stdout: topOut } = await execImpl(GIT, ['rev-parse', '--show-toplevel'], {
          cwd: cwdReal,
          timeout: 5000,
        })
        const repoRoot = topOut.trim()
        if (!repoRoot) throw new Error('git rev-parse --show-toplevel printed nothing')
        const headerPaths = diffFileHeaderPaths(diffOutput)
        const shown = []
        for (let i = 0; i < files.length; i++) {
          const touched = headerPaths[i] ?? []
          let inConfigDir = touched.length === 0
          for (const p of touched) {
            if (await isConfigDirOrDirectChild(resolve(repoRoot, p))) { inConfigDir = true; break }
          }
          if (!inConfigDir) shown.push(files[i])
        }
        files = shown
      }

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
        const { stdout: untrackedOutput } = await execImpl(
          GIT, ['ls-files', '--others', '--exclude-standard'],
          { cwd: cwdReal, maxBuffer: 512 * 1024, timeout: 5000 }
        )
        if (untrackedOutput.trim()) {
          // Files directly in the config directory are daemon-managed state and are left
          // out (as in the tracked-file filter above, and as a file outside the project
          // is left out in the loop below). They are dropped BEFORE the cap of ten, so a
          // config root that holds ten or more of them cannot fill the slots and hide
          // every ordinary file after them. `isConfigDirOrDirectChild` resolves symlinks,
          // so a link to such a file is dropped too.
          const untrackedPaths = []
          for (const p of untrackedOutput.trim().split('\n').filter(p => p && !seen.has(p)).sort()) {
            if (untrackedPaths.length >= 10) break
            if (await isConfigDirOrDirectChild(resolve(cwdReal, p))) continue
            untrackedPaths.push(p)
          }

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
      // #7298 — the last raw-message branch, and the one that names the
      // workspace without any help from the client: this catch wraps
      // `resolveSessionCwd`, whose `realpath()` throws
      // `ENOENT: no such file or directory, realpath '<cwdReal>'` when the
      // session cwd is gone (removed worktree, unmounted volume, rename).
      // That is the same `cwdReal` leak the issue is about, reachable by a
      // bound client sending a bare `get_diff` with no crafted base at all.
      log.error(`getDiff failed: ${truncateForLog(err.message)}`)
      sendFn(ws, {
        type: 'diff_result',
        files: [],
        error: 'Failed to run git diff',
      })
    }
  }

  return {
    readFile: readFileContent,
    writeFile: writeFileContent,
    appendMemory,
    getDiff,
  }
}
