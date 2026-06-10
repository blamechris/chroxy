// TranscriptTaskScanner (#5431) — incremental session-transcript scanner that
// derives OUTSTANDING background work (run_in_background Bash/Agent calls,
// Monitor streams) and a pending ScheduleWakeup from a Claude Code session
// transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
//
// Why a transcript scan: the per-PID session file (`~/.claude/sessions/
// <pid>.json`) that drives the readiness probe carries only `status` — no
// task info — but it DOES carry `sessionId` + `cwd`, which is enough to
// derive the transcript path. The transcript contains both halves of the
// signal, pairable by tool-use ID:
//
//   Launch (assistant entry, verified shape):
//     { "type": "assistant", "timestamp": "2026-06-10T02:39:05.423Z",
//       "message": { "role": "assistant", "content": [
//         { "type": "tool_use", "id": "toolu_015ydMyyDW7NE7Jbrqu6Eoxe",
//           "name": "Bash",
//           "input": { "description": "Install dependencies in merge worktree",
//                      "run_in_background": true, ... } } ] } }
//
//   Completion (queue-operation entry; the same XML is also re-delivered as
//   a `user` entry with string content when the notification is dequeued):
//     { "type": "queue-operation", "operation": "enqueue",
//       "timestamp": "2026-06-10T02:39:40.819Z",
//       "content": "<task-notification>\n<task-id>bnclpiaj0</task-id>\n
//         <tool-use-id>toolu_015ydMyyDW7NE7Jbrqu6Eoxe</tool-use-id>\n…
//         <status>completed</status>…</task-notification>" }
//
//   ScheduleWakeup (assistant tool_use, verified shape):
//     { "type": "tool_use", "id": "toolu_016KpP2dT7mFhk4HDgUU2ype",
//       "name": "ScheduleWakeup",
//       "input": { "delaySeconds": 90, "reason": "Waiting for …",
//                  "prompt": "Check PR #149 required checks; …" } }
//
// Outstanding work = launches without a matching completion. A wakeup is
// pending until a later user/assistant entry lands AFTER its scheduled time
// (the harness re-invoked the agent), a later user entry carries its prompt,
// or a newer ScheduleWakeup supersedes it.
//
// Robustness contract (#5431 success criterion — degrade silently):
//   - The transcript format is the harness's INTERNAL representation, not a
//     stable API. Every parse is defensive; an unparseable line is skipped.
//   - Any I/O or structural failure makes `scan()` return the EMPTY result
//     (plus a debug log) — it never throws into the readiness path.
//   - Transcripts grow large (5MB+); a byte offset is tracked per scanner so
//     each scan reads only the new tail. A shrunken file (rotation /
//     truncation) resets the scanner and re-reads from byte 0.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createLogger } from './logger.js'

const log = createLogger('transcript-tasks')

/** Empty scan result — the "no outstanding work / degraded" shape. */
export const EMPTY_TASK_SNAPSHOT = Object.freeze({
  backgroundTasks: Object.freeze([]),
  scheduledWakeup: null,
})

// Cap a single incremental read so a pathological transcript (or a first
// scan against an existing multi-MB file) can't balloon memory. 16 MiB is
// >3x the largest transcript observed in the wild (~5 MB); when the unread
// tail exceeds the cap we skip ahead and only parse the final window —
// stale-launch detail may be lost but the scanner stays bounded and the
// readiness path stays fast.
export const MAX_SCAN_BYTES = 16 * 1024 * 1024

// Truncate `description` fallbacks derived from an Agent `prompt` — prompts
// are unbounded; 80 chars matches the issue's payload sketch.
const PROMPT_DESCRIPTION_MAX = 80

/**
 * Slugify a cwd into the directory name Claude Code uses under
 * `~/.claude/projects/`. Verified against real project dirs on disk:
 * every non-alphanumeric character (slashes, dots, spaces, …) becomes `-`,
 * e.g. `/Users/blamechris/Projects/repo-relay` →
 * `-Users-blamechris-Projects-repo-relay` and
 * `/Users/x/Downloads/Mom Hospitalization Files` →
 * `-Users-x-Downloads-Mom-Hospitalization-Files`.
 * @param {string} cwd
 * @returns {string}
 */
export function slugifyCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Derive the transcript path for a per-PID session file
 * (`~/.claude/sessions/<pid>.json`, which carries `sessionId` + `cwd`).
 * Returns null on any failure (missing file, bad JSON, missing fields) —
 * callers treat null as "no transcript available, degrade to plain ready".
 * @param {string} sessionFilePath
 * @returns {string|null}
 */
export function transcriptPathForSessionFile(sessionFilePath) {
  try {
    const data = JSON.parse(readFileSync(sessionFilePath, 'utf8'))
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null
    const cwd = typeof data?.cwd === 'string' ? data.cwd : null
    if (!sessionId || !cwd) return null
    // Defence-in-depth: the sessionId becomes a path segment. Real ids are
    // UUIDs; reject anything that could traverse out of the projects dir.
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null
    return join(homedir(), '.claude', 'projects', slugifyCwd(cwd), `${sessionId}.jsonl`)
  } catch (err) {
    log.debug?.(`transcriptPathForSessionFile failed for ${sessionFilePath}: ${err.message}`)
    return null
  }
}

/** Extract every `<tool-use-id>…</tool-use-id>` from a task-notification blob. */
const TOOL_USE_ID_TAG = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/g

/**
 * Incremental scanner for one transcript file.
 *
 * Usage: construct once per (session, transcript path); call `scan()` on
 * each readiness edge. Each call reads only bytes appended since the last
 * call and returns the current outstanding-work snapshot:
 *
 *   { backgroundTasks: [{ toolUseId, kind, description, startedAt }],
 *     scheduledWakeup: { at, reason } | null }
 *
 * `scan()` NEVER throws. A missing transcript yields the empty snapshot
 * (the file may simply not exist yet); any other failure logs at debug and
 * yields the empty snapshot too.
 */
export class TranscriptTaskScanner {
  /**
   * @param {string} transcriptPath - absolute path to the session .jsonl
   * @param {object} [logger] - logger with debug/warn (defaults to module log)
   */
  constructor(transcriptPath, logger = log) {
    this.path = transcriptPath
    this._log = logger
    this._reset()
  }

  _reset() {
    this._offset = 0
    this._remainder = ''
    // Set when a capped read skipped ahead — the first "line" of the new
    // window is almost certainly a tail fragment and must not be parsed.
    this._discardFirstPartialLine = false
    /** @type {Map<string, {toolUseId:string,kind:string,description:string,startedAt:number}>} */
    this._tasks = new Map()
    /** @type {{at:number,reason:string,prompt:string}|null} */
    this._wakeup = null
    // Latest user/assistant entry timestamp seen (epoch ms) — used to decide
    // whether a scheduled wakeup has already fired (activity after its time).
    this._lastActivityTs = 0
  }

  /**
   * Read any new transcript bytes, fold them into the tracked state, and
   * return the outstanding-work snapshot. Never throws.
   * @returns {{backgroundTasks: Array<{toolUseId:string,kind:string,description:string,startedAt:number}>, scheduledWakeup: {at:number,reason:string}|null}}
   */
  scan() {
    try {
      this._readNewBytes()
      return this._snapshot()
    } catch (err) {
      // ENOENT is the common benign case (transcript not written yet) —
      // still debug-logged, but state is preserved so a later scan picks
      // up where it left off if the file appears.
      this._log.debug?.(`transcript scan failed for ${this.path}: ${err.message} — degrading to empty snapshot`)
      return { backgroundTasks: [], scheduledWakeup: null }
    }
  }

  _readNewBytes() {
    const fd = openSync(this.path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size < this._offset) {
        // Truncated / rotated — drop everything and re-read from the start.
        this._log.debug?.(`transcript ${this.path} shrank (${size} < ${this._offset}) — resetting scanner`)
        this._reset()
      }
      if (size === this._offset) return
      let start = this._offset
      if (size - start > MAX_SCAN_BYTES) {
        // Bounded read: skip ahead and parse only the final window. The
        // skipped prefix may contain launches we'll never pair — acceptable
        // degradation for a pathological file; note it at debug level.
        this._log.debug?.(`transcript ${this.path} unread tail ${size - start}B exceeds cap — scanning final ${MAX_SCAN_BYTES}B only`)
        this._reset()
        start = size - MAX_SCAN_BYTES
        // Discard the (almost certainly partial) first line of the window.
        this._discardFirstPartialLine = true
      }
      const buf = Buffer.alloc(size - start)
      const bytesRead = readSync(fd, buf, 0, buf.length, start)
      this._offset = start + bytesRead
      let text = this._remainder + buf.toString('utf8', 0, bytesRead)
      this._remainder = ''
      const lines = text.split('\n')
      // The final element is either '' (text ended with \n) or a partial
      // line still being written — keep it for the next scan either way.
      this._remainder = lines.pop() ?? ''
      for (let line of lines) {
        if (this._discardFirstPartialLine) {
          this._discardFirstPartialLine = false
          continue
        }
        line = line.trim()
        if (line) this._ingestLine(line)
      }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Fold one JSONL line into the tracked state. Skips (never throws on)
   * unparseable or unexpected shapes.
   * @param {string} line
   */
  _ingestLine(line) {
    // Completion check works on the RAW line: the task-notification XML
    // appears in several entry shapes (queue-operation `content` string,
    // dequeued `user` message string content, attachment entries) and a
    // raw-text match covers all of them without depending on any one shape.
    if (line.includes('<task-notification>')) {
      for (const m of line.matchAll(TOOL_USE_ID_TAG)) {
        // JSONL string escaping never alters the id (alphanumeric), so the
        // raw match is exact. Any status (completed/failed/…) means the
        // task is no longer running.
        this._tasks.delete(m[1])
      }
    }

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return // mid-write torn line or non-JSON — skip silently
    }
    if (!entry || typeof entry !== 'object') return

    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const entryTs = Number.isFinite(ts) ? ts : null

    if (entry.type === 'user' || entry.type === 'assistant') {
      if (entryTs !== null && entryTs > this._lastActivityTs) this._lastActivityTs = entryTs
    }

    if (entry.type === 'assistant') {
      const blocks = entry?.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue
          this._ingestToolUse(block, entryTs ?? Date.now())
        }
      }
      return
    }

    if (entry.type === 'user' && this._wakeup) {
      // Wakeup consumption path 1: the fired wakeup is delivered back to the
      // agent as a user message carrying the scheduled prompt.
      const content = entry?.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).join('\n')
          : ''
      // Match on a bounded prefix — prompts are long and an exact full-string
      // match is brittle against harness-side trimming/wrapping.
      const probe = this._wakeup.prompt.slice(0, 200)
      if (probe && text.includes(probe)) this._wakeup = null
    }
  }

  /**
   * @param {{id:string,name?:string,input?:object}} block
   * @param {number} startedAt epoch ms
   */
  _ingestToolUse(block, startedAt) {
    const name = typeof block.name === 'string' ? block.name : ''
    const input = (block.input && typeof block.input === 'object') ? block.input : {}

    if (name === 'ScheduleWakeup') {
      const delaySeconds = Number(input.delaySeconds)
      if (Number.isFinite(delaySeconds) && delaySeconds >= 0) {
        // A newer ScheduleWakeup supersedes any earlier pending one — the
        // harness keeps at most one timer armed.
        this._wakeup = {
          at: startedAt + delaySeconds * 1000,
          reason: typeof input.reason === 'string' ? input.reason : '',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
        }
      }
      return
    }

    let kind = null
    if (name === 'Monitor') {
      kind = 'monitor'
    } else if (input.run_in_background === true) {
      if (name === 'Bash') kind = 'bash'
      else if (name === 'Agent') kind = 'agent'
    }
    if (!kind) return

    const description = typeof input.description === 'string' && input.description
      ? input.description
      : typeof input.prompt === 'string'
        ? input.prompt.slice(0, PROMPT_DESCRIPTION_MAX)
        : ''
    this._tasks.set(block.id, { toolUseId: block.id, kind, description, startedAt })
  }

  _snapshot() {
    let scheduledWakeup = null
    if (this._wakeup) {
      // Wakeup consumption path 2: ANY user/assistant activity after the
      // scheduled time means the harness already re-invoked the agent (or
      // the user did) — the wakeup is spent even if its prompt text never
      // re-appears verbatim.
      if (this._lastActivityTs > this._wakeup.at) {
        this._wakeup = null
      } else {
        scheduledWakeup = { at: this._wakeup.at, reason: this._wakeup.reason }
      }
    }
    return {
      backgroundTasks: [...this._tasks.values()].map((t) => ({ ...t })),
      scheduledWakeup,
    }
  }
}
