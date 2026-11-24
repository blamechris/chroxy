/**
 * Tail-only status reader for local Claude Code transcripts (JSONL).
 *
 * It answers one question per session: what is the last status block the
 * assistant authored, and when. It reads the END of the transcript file, keeps
 * that block and its time, and discards every other line as soon as it has
 * been looked at. Nothing else a transcript holds (prompts, tool input and
 * output, earlier blocks, prose, titles, working directories) is carried into
 * a value this module returns, so it cannot reach the ledger.
 *
 *   - Location: the same locator the closed-conversation endpoint uses
 *     (`resolveTranscriptSource`). It refuses a locator that does not name the
 *     session, a path that resolves outside the provider's projects root, and
 *     returns the file's identity; this reader opens the file read-only and
 *     refuses a file that is not that same object or not a regular file.
 *   - Bounded: at most `maxTailBytes` are read, from the end. A line cut by
 *     the start of the window is dropped; an unterminated final line (a write
 *     still in flight) is ignored. A line in between that does not parse is a
 *     damaged transcript, which is an `error`, not a shorter one.
 *   - Authored: only top-level assistant entries count. A user entry, a tool
 *     result or a subagent (sidechain) entry that quotes a status block is not
 *     one the session authored.
 *   - Parsed by the daemon's own parser (`reportFromText` over
 *     `extractDeclaredStatus`); nothing here parses a status block.
 *   - Changed format is `error`, never `no_report`, never idle: an assistant
 *     entry whose `message.content` is not a list of typed blocks, an entry with
 *     no `type`, a status block with no readable time.
 *
 * It never writes, never creates a file and has no way to send input to a
 * session: `list` and `read` are the whole adapter (`sealAdapter` refuses
 * anything else).
 *
 * Time: the report is timed with the `timestamp` of the entry that carries the
 * block (`report_time_basis: authored_at`).
 *
 * One recorded sample read of a real transcript confirms the format before the
 * first run against real data; that read is an operator step, not part of this
 * module, and it uses only the checks above.
 */

import { join } from 'node:path'
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { AdapterContractError, validSourceName } from '../freshness/adapter.js'
import { reportFromText } from '../freshness/state-file-adapter.js'
import { resolveTranscriptSource } from '../transcript-sources.js'

export const CLAUDE_TRANSCRIPT_SOURCE = 'claude-transcript'

/** The capabilities to register for this source in the reconciler's configuration. */
export const CLAUDE_TRANSCRIPT_CAPS = Object.freeze({ native_in_read: false, activity_read: false, scope: false, can_confirm_gone: true, report_time_basis: 'authored_at' })

/** Default window read from the end of a transcript. */
export const DEFAULT_MAX_TAIL_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_SESSIONS = 5000
const NEWLINE = 0x0a

const AMBIGUOUS = Symbol('ambiguous')

/** A conversation id as a file name: no separators, no dots at the start. */
function safeId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** One snapshot of which sessions exist: names only, no file is opened. */
function scanProjects(projectsDir, maxSessions) {
  let dirs
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return null
  }
  const byId = new Map()
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    let files
    try {
      files = readdirSync(join(projectsDir, d.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      const id = f.name.slice(0, -'.jsonl'.length)
      if (!safeId(id)) continue
      byId.set(id, byId.has(id) ? AMBIGUOUS : `${d.name}/${f.name}`)
      if (byId.size > maxSessions) return null
    }
  }
  return byId
}

const fail = (error_code) => ({ outcome: 'error', error_code })

/**
 * Read the window and find the last authored status block in it.
 * Returns a read.
 */
function readTail(fd, expectedIdentity, maxTailBytes) {
  const st = fstatSync(fd, { bigint: true })
  if (!st.isFile()) return fail('not_regular')
  if (expectedIdentity && (st.dev !== expectedIdentity.dev || st.ino !== expectedIdentity.ino)) return fail('file_changed')
  const size = Number(st.size)
  // One byte before the window says whether the window starts on a line boundary.
  const start = size > maxTailBytes ? size - maxTailBytes - 1 : 0
  const length = size - start
  const buf = Buffer.alloc(length)
  let off = 0
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, start + off)
    if (n === 0) break
    off += n
  }
  let from = 0
  if (start > 0) {
    // A line the window starts inside of is dropped whole.
    from = buf[0] === NEWLINE ? 1 : buf.indexOf(NEWLINE) + 1
    if (from === 0 || from >= off) return fail('tail_too_small')
  }
  const lines = buf.toString('utf8', from, off).split('\n')

  let last = null // the last status block: { report } or { badTime }
  let later = false // an assistant message with text and no status block after it
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // An unterminated final line is a write still in flight; any other bad line is damage.
      if (i === lines.length - 1) continue
      return fail('corrupt')
    }
    if (!isPlain(entry) || typeof entry.type !== 'string') return fail('shape_changed')
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue
    const content = entry.message?.content
    if (!isPlain(entry.message) || !Array.isArray(content)) return fail('shape_changed')
    const texts = []
    for (const block of content) {
      if (!isPlain(block) || typeof block.type !== 'string') return fail('shape_changed')
      if (block.type !== 'text') continue
      if (typeof block.text !== 'string') return fail('shape_changed')
      texts.push(block.text)
    }
    const text = texts.join('\n')
    if (text.trim() === '') continue
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const report = reportFromText(text, { updatedAt: Number.isSafeInteger(at) && at >= 0 ? at : -1 })
    if (report) {
      last = report.last_report_at < 0 ? { badTime: true } : { report }
      later = false
    } else {
      later = true
    }
  }
  if (!last) return { outcome: 'no_report' }
  if (last.badTime) return fail('bad_timestamp')
  return { outcome: 'ok', report: { ...last.report, later_unfootered_messages: later } }
}

/**
 * @param {object} opts
 * @param {string} opts.projectsDir      the Claude projects directory (absolute), the provider's store
 * @param {string} [opts.source]         source name (default `claude-transcript`)
 * @param {number} [opts.maxTailBytes]   bytes read from the end of a transcript
 * @param {number} [opts.maxSessions]    a store listing more sessions than this cannot be listed
 * @param {Function} [opts.resolve]      locator (default `resolveTranscriptSource`); for tests
 */
export function createClaudeTranscriptAdapter({ projectsDir, source = CLAUDE_TRANSCRIPT_SOURCE, maxTailBytes = DEFAULT_MAX_TAIL_BYTES, maxSessions = DEFAULT_MAX_SESSIONS, resolve = resolveTranscriptSource }) {
  if (typeof projectsDir !== 'string' || projectsDir === '') throw new TypeError('createClaudeTranscriptAdapter: projectsDir is required')
  if (!validSourceName(source)) throw new AdapterContractError('adapter.source must be a short lowercase name')
  if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1024) throw new TypeError('createClaudeTranscriptAdapter: maxTailBytes must be an integer of at least 1024')
  let snapshot = null
  const sources = [{ provider: 'claude', projectsDir }]
  return {
    source,
    list() {
      snapshot = scanProjects(projectsDir, maxSessions)
      if (!snapshot) return null
      return [...snapshot.keys()].map((id) => ({ session: { source, native_id: id, incarnation: null }, scope: null }))
    },
    read(session) {
      if (!snapshot) snapshot = scanProjects(projectsDir, maxSessions)
      if (!snapshot) return fail('source_missing')
      const locator = snapshot.get(session.native_id)
      if (locator === undefined) return { listed: false }
      if (locator === AMBIGUOUS) return fail('ambiguous_id')
      const found = resolve({ provider: 'claude', conversationId: session.native_id, sourceLocator: locator, sources })
      if (!found.ok) return fail(found.code === 'source_unavailable' ? 'source_missing' : 'invalid_source')
      let fd
      try {
        fd = openSync(found.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0))
        return readTail(fd, found.identity, maxTailBytes)
      } catch (err) {
        return fail(err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'source_missing' : 'unreadable')
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    },
  }
}
