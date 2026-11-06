import { statSync, existsSync, readdirSync, realpathSync } from 'fs'

import { join } from 'path'
import { claudeProjectsDir } from './utils/claude-config-dir.js'
import { constants as fsConstants } from 'fs'
import { openNoFollow } from './ws-file-ops/open-nofollow.js'
import { createReadLimiter, ReadLimitError } from './utils/read-limiter.js'

// Wire cap for a transcript read: the MOST RECENT 500 parsed messages. This is
// the JSONL path's OWN truncation, entirely separate from the ring buffer's
// (#7484) — a caller that reports `isHistoryTruncated()` alongside a JSONL slice
// is describing a collection it never sent. Exported so callers and tests name
// the same number instead of re-deriving it.
export const MAX_MESSAGES = 500

// Byte ceiling for a single transcript read. The wire replay is capped at
// MAX_MESSAGES frames, but the file read itself was previously unbounded — a
// caller (including a bound client via the read-only transcript endpoint, #6860)
// could trigger a full-file buffer of an arbitrarily large JSONL. Files larger
// than this are read from the TAIL only (most-recent activity), so the result is
// gracefully truncated to recent history rather than crashing or buffering the
// whole file. 25MB comfortably fits even long real transcripts while bounding
// worst-case memory. Overridable per-call for tests.
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024

// One read() call asks for at most this much, so a cancelled read stops within a
// step (see readConversationTranscriptStrictAsync).
const READ_STEP_BYTES = 4 * 1024 * 1024

// Admission for every transcript read in the daemon (see readTranscriptCore).
export const transcriptReadLimiter = createReadLimiter({ maxConcurrent: 4, maxPerClient: 2, maxQueued: 32 })

/**
 * Encode a cwd into the directory name Claude Code uses under
 * `~/.claude/projects/` — the ONE implementation of this mapping (#7283).
 *
 * Every non-alphanumeric character becomes `-`, which is what Claude Code
 * writes: 88 project directories on a macOS host contained nothing outside
 * `[A-Za-z0-9-]` (`~/.codex/sessions` -> `-Users-<u>--codex-sessions`), and the
 * Windows host's `A:\tmp` became `A--tmp`. This used to replace only `/`,
 * which produced a directory that cannot exist for any cwd with a dot,
 * underscore, space, drive letter or backslash — every `.claude/worktrees/*`
 * session among them — so transcript reads silently found nothing. A second
 * encoder (`slugifyCwd` in transcript-tasks.js) had the right rule; the two
 * are now this one function.
 *
 * Not verified: whether Claude Code shortens very long keys. The longest key
 * observed on disk was 120 characters.
 *
 * e.g. '/Users/alice/projects/my.repo' -> '-Users-alice-projects-my-repo'
 * @param {string} cwd
 * @returns {string}
 */
export function encodeProjectPath(cwd) {
  // No String() coercion: a non-string cwd must THROW, not become a
  // `projects/null` key. getFullHistoryAsync relies on that throw to log the
  // failure before it falls back to the ring buffer.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// The NATIVE realpath, never the JS one (#8978). Exported so a test can pin it.
export const PROJECT_CWD_REALPATH = realpathSync.native

/**
 * The form of `cwd` claude records when it names a project directory (#8978).
 *
 * On Windows the JS `realpathSync` keeps 8.3 short names
 * (`C:\WINDOWS\SERVIC~1\...`) while claude records the long form, so encoding
 * a short-form cwd names a project directory that does not exist. The native
 * realpath expands them. On other platforms the path is returned unchanged:
 * this must not start resolving symlinks that claude's own key does not.
 * A path that cannot be resolved (missing, unreadable) is returned as given.
 *
 * @param {string} cwd
 * @param {{ realpath?: (p: string) => string, platform?: string }} [opts]
 * @returns {string}
 */
export function canonicalProjectCwd(cwd, { realpath = PROJECT_CWD_REALPATH, platform = process.platform } = {}) {
  if (platform !== 'win32' || typeof cwd !== 'string') return cwd
  try {
    return realpath(cwd)
  } catch {
    return cwd
  }
}

/**
 * The project directory name for `cwd`: its canonical form (see
 * {@link canonicalProjectCwd}) run through {@link encodeProjectPath}. Use this
 * wherever a slug is derived from a path that may be an 8.3 short form.
 * @param {string} cwd
 * @param {Parameters<typeof canonicalProjectCwd>[1]} [opts]
 * @returns {string}
 */
export function projectSlug(cwd, opts) {
  return encodeProjectPath(canonicalProjectCwd(cwd, opts))
}

/**
 * Best-effort decode of a project directory name back to a filesystem path.
 * LOSSY: `-` stands for any non-alphanumeric character (see encodeProjectPath),
 * so this only tries the all-slashes reading and returns it when that
 * directory exists — `-Users-x-my-repo` decodes to `/Users/x/my/repo`, never
 * `/Users/x/my-repo`. Callers prefer the `cwd` recorded in the transcript and
 * use this only as a fallback label. Returns null when the guess does not exist.
 */
export function decodeProjectPath(encoded) {
  const decoded = encoded.replace(/-/g, '/')
  try {
    if (existsSync(decoded) && statSync(decoded).isDirectory()) return decoded
  } catch { /* path doesn't exist */ }
  return null
}

/**
 * Resolve the JSONL file path for a conversation.
 * @param {string} cwd - Working directory the conversation was started in
 * @param {string} conversationId - UUID of the conversation
 * @param {Record<string, string|undefined>} [env] - env claude runs with; its
 *   `CLAUDE_CONFIG_DIR` (when valid) picks the projects root, else `~/.claude`
 * @param {Parameters<typeof canonicalProjectCwd>[1]} [slugOpts] - test seam for the cwd canonicaliser
 * @returns {string} Absolute path to the JSONL file
 */
export function resolveJsonlPath(cwd, conversationId, env = process.env, slugOpts) {
  const encoded = projectSlug(cwd, slugOpts)
  return join(claudeProjectsDir(env), encoded, `${conversationId}.jsonl`)
}

/**
 * The directory claude keeps its per-project transcripts in:
 * `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`. An unset or empty override falls
 * back to `~/.claude`, matching claude.
 * @param {Record<string, string|undefined>} [env] - env claude runs with
 * @returns {string}
 */
export function resolveClaudeProjectsDir(env = process.env) {
  return claudeProjectsDir(env)
}

/**
 * Has Claude Code persisted a transcript for this conversation id? (#8239)
 *
 * Answers `true` / `false` ONLY when it could actually look. `claude` writes
 * `<id>.jsonl` on the first turn, not at launch, so a session that never
 * completed a turn has no file for the id it was launched with, and resuming
 * that id is rejected ("No conversation found"). The caller uses `false` to
 * spawn fresh instead.
 *
 * Fail-safe: "could not check" is NOT "nothing to resume". An unusable
 * argument, or a read error other than "does not exist", answers `true`, which
 * is today's behaviour (resume), so a probe failure can never abandon a real
 * conversation.
 *
 * The expected directory (`encodeProjectPath(cwd)`) is tried first; if the
 * file is not there every directory under the projects root is tried, so a
 * project-key derivation that differs from Claude Code's cannot read as
 * "never persisted".
 *
 * The projects root is `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`, taken from
 * `env` (default `process.env`). Pass the env the claude child is spawned with:
 * claude honours `CLAUDE_CONFIG_DIR` from ITS environment, so a probe that
 * looks anywhere else would read a real conversation as "never persisted".
 *
 * @param {string} cwd - the directory claude was launched in (real path)
 * @param {string} conversationId
 * @param {Record<string, string|undefined>} [env] - env claude runs with
 * @param {Parameters<typeof canonicalProjectCwd>[1]} [slugOpts] - test seam for the cwd canonicaliser
 * @returns {boolean}
 */
export function hasPersistedTranscript(cwd, conversationId, env = process.env, slugOpts) {
  // The id becomes a path segment; real ids are UUIDs. Anything else cannot be
  // looked up safely, so do not claim the transcript is absent.
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9-]+$/.test(conversationId)) return true
  if (typeof cwd !== 'string') return true
  const fileName = `${conversationId}.jsonl`
  const projectsDir = resolveClaudeProjectsDir(env)
  try {
    statSync(join(projectsDir, projectSlug(cwd, slugOpts), fileName))
    return true
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return true
  }
  let dirs
  try {
    dirs = readdirSync(projectsDir)
  } catch (err) {
    return !(err?.code === 'ENOENT' || err?.code === 'ENOTDIR')
  }
  for (const dir of dirs) {
    try {
      statSync(join(projectsDir, dir, fileName))
      return true
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return true
    }
  }
  return false
}

/**
 * Get the modification time of a JSONL file.
 * @param {string} filePath - Absolute path to the JSONL file
 * @returns {number|null} mtime in ms since epoch, or null if file doesn't exist
 */
export function getJsonlMtime(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

/**
 * Parse raw JSONL text into Chroxy message format.
 * Shared parse core for the reader.
 *
 * Returns the parsed slice ALONGSIDE whether content was dropped to produce it
 * (#7484). Two independent things can drop content, and a caller cannot infer
 * either from the returned array: the `MAX_MESSAGES` message cap here, and the
 * `MAX_TRANSCRIPT_BYTES` tail read the caller may already have performed
 * (`byteTruncated`). Both mean "the client is not seeing the whole
 * conversation", which is exactly what `truncated` on the wire claims to say.
 *
 * @param {string} raw
 * @param {{ byteTruncated?: boolean }} [opts]
 * @returns {{ messages: Array<object>, truncated: boolean }}
 */
function parseJsonlContent(raw, { byteTruncated = false, strict = false } = {}) {
  const rawLines = raw.split('\n')
  const messages = []

  for (let i = 0; i < rawLines.length; i++) {
    // Blank and whitespace-only lines (including a CRLF `\r`) carry no record.
    const line = rawLines[i].trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // Strict (#7828): a record that does not parse in the MIDDLE of the file
      // is a DATA error, not an empty/shorter transcript. Two cuts are normal
      // and tolerated: the first line of a tail-only read (cut by construction)
      // and an unterminated final line (a crash, a kill mid-write, or a session
      // still being appended to) — everything before the cut still replays.
      const tailCutFirstLine = byteTruncated && i === 0
      const unterminatedFinalLine = i === rawLines.length - 1
      if (strict && !tailCutFirstLine && !unterminatedFinalLine) {
        throw new TranscriptDataError('corrupt', `Transcript record ${i + 1} is not valid JSON (corrupt or truncated)`)
      }
      continue // skip malformed lines
    }

    // Skip non-message entries
    if (entry.type === 'queue-operation' || entry.type === 'file-history-snapshot') {
      continue
    }

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
    const messageId = entry.uuid || null

    if (entry.type === 'user') {
      // Extract text from user message content blocks
      const content = entry.message?.content
      if (!Array.isArray(content)) continue

      // Skip tool_result entries (they're part of tool flow, not user text)
      const hasToolResult = content.some(b => b.type === 'tool_result')
      if (hasToolResult) continue

      const textParts = content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      if (textParts) {
        messages.push({
          type: 'user_input',
          content: textParts,
          timestamp,
          messageId,
        })
      }
    } else if (entry.type === 'assistant') {
      const content = entry.message?.content
      if (!Array.isArray(content)) continue

      // Process each content block
      const textParts = []
      const toolUses = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolUses.push(block)
        }
      }

      // Emit text response if any
      if (textParts.length > 0) {
        messages.push({
          type: 'response',
          content: textParts.join('\n'),
          timestamp,
          messageId,
        })
      }

      // Emit tool uses
      for (const tool of toolUses) {
        messages.push({
          type: 'tool_use',
          tool: tool.name || 'unknown',
          content: tool.input ? JSON.stringify(tool.input) : '',
          timestamp,
          messageId: tool.id || messageId,
        })
      }
    }
  }

  // Cap at MAX_MESSAGES most recent. The cap TRIPPING is the JSONL path's own
  // truncation signal — reported, never inferred: 500 returned messages is
  // equally the shape of a 500-message transcript that lost nothing.
  const capped = messages.length > MAX_MESSAGES
  return {
    messages: capped ? messages.slice(-MAX_MESSAGES) : messages,
    truncated: byteTruncated || capped,
  }
}

/**
 * This module's sole exported transcript reader (#7484/#7520; conversation-search/-scanner and transcript-tasks read transcripts their own way): returns { messages, truncated } so
 * a caller can report the slice's own truncation. The sync and array-returning
 * variants were removed in #7520 — the array shape structurally cannot report
 * truncation, which is the false-safety footgun this file used to carry.
 *
 * @param {string} filePath - Absolute path to the JSONL file
 * @param {number} [maxBytes]
 * @returns {Promise<{ messages: Array<object>, truncated: boolean }>}
 */
export async function readConversationHistoryWithMetaAsync(filePath, maxBytes = MAX_TRANSCRIPT_BYTES, opts = {}) {
  // Same reader, same admission, same descriptor checks as the strict endpoint;
  // the difference is only that an unreadable file or a corrupt record reads as
  // an empty history (the caller falls back to its in-memory buffer).
  try {
    return await readTranscriptCore(filePath, maxBytes, { ...opts, strict: false })
  } catch (err) {
    // A refusal for load is reported to the caller, not read as "no history".
    if (err instanceof ReadLimitError) throw err
    return { messages: [], truncated: false }
  }
}

/**
 * A transcript that cannot be served as data: absent, unreadable or corrupt.
 * Distinct from an empty transcript, which is a successful read (#7828).
 */
export class TranscriptDataError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TranscriptDataError'
    this.code = code // 'missing' | 'unreadable' | 'corrupt' | 'cancelled'
  }
}

/**
 * Strict sibling of readConversationHistoryWithMetaAsync for the read-only
 * transcript endpoint (#7828): same byte cap, same tail read, same message cap
 * and parser, but a missing/unreadable file or a corrupt record THROWS a
 * TranscriptDataError instead of reading as an empty successful transcript.
 *
 * The file is opened ONCE through the shared no-follow opener, and everything
 * after that (identity check, size, bytes) goes through that one descriptor, so
 * the object that was checked is the object that is read. When the caller
 * resolved and contained the path beforehand it passes that file's identity
 * (`expectedIdentity`, bigint dev + ino); an opened file with a different
 * identity is refused rather than read.
 *
 * @param {string} filePath
 * @param {number} [maxBytes]
 * @param {{ expectedIdentity?: { dev: bigint, ino: bigint } }} [opts]
 * @returns {Promise<{ messages: Array<object>, truncated: boolean }>}
 */
export async function readConversationTranscriptStrictAsync(filePath, maxBytes = MAX_TRANSCRIPT_BYTES, opts = {}) {
  return readTranscriptCore(filePath, maxBytes, { ...opts, strict: true })
}

/**
 * The one transcript read. EVERY transcript-reading entry point (the strict
 * endpoint, the full-history replay) goes through it, so none can skip the
 * pieces below:
 *   - admission: a daemon-wide cap on concurrent reads, a per-client cap, a
 *     bounded queue, identical in-flight reads shared, cancellation by signal
 *     (`opts.admitted` is for a caller that already holds a slot of the same
 *     limiter and must not queue behind itself);
 *   - a non-blocking open, with the regular-file check and the identity check
 *     made on the opened descriptor;
 *   - bounded, abortable reads.
 */
async function readTranscriptCore(filePath, maxBytes, { expectedIdentity, signal, strict, admitted = false, limiter = transcriptReadLimiter, clientKey = 'daemon', restricted = false } = {}) {
  const run = (sig) => readTranscriptBody(filePath, maxBytes, { expectedIdentity, signal: sig, strict })
  if (admitted) return run(signal)
  const key = `${filePath}\0${expectedIdentity ? `${expectedIdentity.dev}:${expectedIdentity.ino}` : ''}\0${maxBytes}\0${strict ? 's' : 'l'}`
  return limiter.submit({ key, clientKey: String(clientKey), signal, restricted }, run)
}

async function readTranscriptBody(filePath, maxBytes, { expectedIdentity, signal, strict }) {
  const cancelled = () => new TranscriptDataError('cancelled', 'Transcript read cancelled')
  if (signal?.aborted) throw cancelled()
  let raw
  let byteTruncated = false
  let fh
  try {
    fh = await openNoFollow(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0))
    const st = await fh.stat({ bigint: true })
    if (!st.isFile()) {
      throw new TranscriptDataError('unreadable', 'Transcript source is not a regular file')
    }
    if (expectedIdentity && (st.dev !== expectedIdentity.dev || st.ino !== expectedIdentity.ino)) {
      throw new TranscriptDataError('unreadable', 'Transcript file changed after it was resolved')
    }
    const size = Number(st.size)
    byteTruncated = size > maxBytes
    const start = byteTruncated ? size - maxBytes : 0
    const length = size - start
    const buf = Buffer.alloc(length)
    let off = 0
    while (off < length) {
      // Bounded steps, so a read nobody is waiting for any more stops promptly
      // instead of finishing a buffer-sized read first.
      if (signal?.aborted) throw cancelled()
      const { bytesRead } = await fh.read(buf, off, Math.min(length - off, READ_STEP_BYTES), start + off)
      if (bytesRead === 0) break
      off += bytesRead
    }
    raw = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, off))
  } catch (err) {
    if (err instanceof TranscriptDataError) throw err
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw new TranscriptDataError('missing', 'Transcript file not found')
    }
    throw new TranscriptDataError('unreadable', 'Transcript file could not be read; it may be in use or unreadable. Try again.')
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
  return parseJsonlContent(raw, strict ? { byteTruncated, strict: true } : { byteTruncated })
}
