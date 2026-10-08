// TranscriptTaskScanner (#5431) — incremental session-transcript scanner that
// derives OUTSTANDING background work (run_in_background Bash/Agent calls,
// Monitor streams), a pending ScheduleWakeup, and (#7327) the most recently
// OBSERVED model from a Claude Code session transcript
// (`~/.claude/projects/<slug>/<sessionId>.jsonl`). The model field exists
// because claude-tui — the default provider — is a PTY-driven interactive
// TUI with no structured init event of its own (unlike cli-session/sdk-
// session, which learn their booted model from the CLI/SDK's own init
// payload); the transcript's `message.model` on assistant entries is the
// only place that information appears at all.
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
// #8223 — authentication failures. claude writes an API call that failed
// authentication to the transcript as a STRUCTURED entry, regardless of the
// PTY's width (at a narrow PTY it never paints the "Please run /login" banner
// at all), with the same `error` enum the Agent SDK types as
// `SDKAssistantMessageError`:
//     { "type": "assistant", "isApiErrorMessage": true,
//       "error": "authentication_failed",
//       "message": { "role": "assistant", "content": [ { "type": "text",
//         "text": "Please run /login · API Error: 401 OAuth access token is invalid." } ] } }
// The scanner COUNTS those entries (`authFailureCount`, cumulative since the
// scanner was last reset) and nothing else about them; a consumer compares the
// count with a baseline it captured earlier. Only the two structured fields
// count — never the entry's TEXT, because a model discussing `/login` in a
// normal reply carries the same words.
//
// #8400 — usage / rate limits. The SAME structured marker carries them:
//     { "type": "assistant", "isApiErrorMessage": true, "error": "rate_limit",
//       "apiErrorStatus": 429, "message": { ..., "content": [ { "type": "text",
//         "text": "You've hit your session limit · resets 11:30pm (America/Los_Angeles)" } ] } }
// and a 529 overload (`error: "server_error"`, `apiErrorStatus: 529`). The
// scanner counts them (`usageLimitCount`, cumulative like `authFailureCount`) and
// keeps the latest classification (`lastUsageLimit`, see claude-tui/usage-limit.js)
// so a consumer that saw the count rise can say what the limit was. A sidechain
// (subagent) entry is not counted: the main conversation has not stopped.
//
// #7393 — thinking blocks. Claude Code writes ONE JSONL entry per content block
// (a message with thinking, text and tool_use blocks is three `assistant`
// entries sharing `message.id` / `requestId`, told apart by `apiBlockIndex`),
// and a thinking entry looks like:
//     { "type": "assistant", "isSidechain": false, "uuid": "…",
//       "timestamp": "2026-10-08T12:00:05.000Z", "thinkingDurationMs": 1236,
//       "apiBlockIndex": 0,
//       "message": { "role": "assistant", "content": [ { "type": "thinking",
//         "thinking": "…", "signature": "…" } ], … } }
// `thinking` is the empty string unless the API was asked for summaries (the
// TUI asks only when `showThinkingSummaries` is set), and `thinkingDurationMs`
// is on the ENTRY. claude-tui is deliver-on-complete and has no stream to read
// reasoning from, so the transcript is the only source. Capture is opt-in per
// turn (`startThinkingCapture`) and bounded: a scan that is only rebuilding
// state from history queues nothing, so a long resumed transcript costs no
// memory. Sidechain (subagent) entries are skipped, the same as for the
// observed model.
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
import { encodeProjectPath } from './jsonl-reader.js'
import { classifyApiErrorEntry } from './claude-tui/usage-limit.js'

const log = createLogger('transcript-tasks')

/** Empty scan result — the "no outstanding work / degraded" shape. */
export const EMPTY_TASK_SNAPSHOT = Object.freeze({
  backgroundTasks: Object.freeze([]),
  scheduledWakeup: null,
  observedModel: null,
  // #8223: `null` = unknown (the transcript could not be read), as opposed to a
  // known count of 0 — see `TranscriptTaskScanner.scan()`.
  authFailureCount: null,
  // #8400: same convention -- `null` = unknown, `0` = known none.
  usageLimitCount: null,
  lastUsageLimit: null,
})

// #7327: the harness writes this literal `message.model` on synthetic
// assistant entries it injects itself (an API-error stand-in, a retry
// placeholder, …) — verified against live transcripts: every `<synthetic>`
// entry carries `usage.output_tokens: 0` and is not something the model
// actually booted with. Reporting it as the observed model would show a
// fake value instead of an honest "not yet observed" null.
const SYNTHETIC_MODEL = '<synthetic>'

// Cap a single incremental read so a pathological transcript (or a first
// scan against an existing multi-MB file) can't balloon memory. 16 MiB is
// >3x the largest transcript observed in the wild (~5 MB); when the unread
// tail exceeds the cap we skip ahead and only parse the final window —
// stale-launch detail may be lost but the scanner stays bounded and the
// readiness path stays fast.
export const MAX_SCAN_BYTES = 16 * 1024 * 1024

// #7396: how many task-notification tool-use ids the scanner remembers. The set
// answers "has this launch been reported finished", which a session asks about
// the handful of subagents it is tracking right now -- so only recent ids
// matter -- but a long session can see thousands of notifications, and an
// unbounded set is a leak with no consumer. Insertion order is age, so eviction
// drops the oldest first.
export const NOTIFIED_TOOL_USE_IDS_MAX = 512

// Truncate `description` fallbacks derived from an Agent `prompt` — prompts
// are unbounded; 80 chars matches the issue's payload sketch.
const PROMPT_DESCRIPTION_MAX = 80

// #7393: the most thinking blocks held between two drains, and the most text
// kept per block. A turn is drained every poll pass, so the cap is a backstop
// against a runaway file, not a working limit; the newest blocks survive. The
// per-block bound matches the client bubble's own cap (store-core
// MAX_THINKING_CONTENT_LEN), past which it drops text on arrival anyway.
export const MAX_PENDING_THINKING_BLOCKS = 256
export const MAX_THINKING_BLOCK_CHARS = 1024 * 1024

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
    return join(homedir(), '.claude', 'projects', encodeProjectPath(cwd), `${sessionId}.jsonl`)
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
 *     scheduledWakeup: { at, reason } | null,
 *     observedModel: string | null,
 *     authFailureCount: number | null,
 *     usageLimitCount: number | null,   // #8400, same null/0 convention
 *     lastUsageLimit: UsageLimit | null }
 *
 * `authFailureCount` (#8223) is the cumulative number of structured
 * `authentication_failed` API-error assistant entries seen, `0` for a
 * transcript that does not exist yet or holds none, and `null` ONLY when the
 * transcript could not be read for some other reason — so a consumer that
 * needs a baseline can tell "known: none" from "unknown" and wait for a
 * successful read rather than baseline against a guess.
 *
 * `observedModel` (#7327) is the most recent real `message.model` seen on an
 * `assistant` transcript entry — an OBSERVATION of what the session is
 * actually running, never the configured/requested model. `null` until the
 * first assistant entry lands (or when every entry seen so far carries only
 * the synthetic placeholder — see `SYNTHETIC_MODEL`).
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
    // #7396 (review): health of the scanner itself, deliberately OUTSIDE
    // `_reset()` -- a rotation or a skipped tail is exactly when these must
    // survive the reset, because they are how a consumer learns the state it is
    // holding no longer reflects the file.
    this._readable = null
    this._discardCount = 0
    /** @type {{ has(id: string): boolean } | null} */
    this.pinnedToolUseIds = null
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
    // #7396: every tool-use id a task-notification has named, in arrival order.
    // Reset with the rest of the state, so a rotated or truncated transcript is
    // re-derived from its start. See `notifiedToolUseIds`.
    /** @type {Set<string>} */
    this._notified = new Set()
    /** @type {{at:number,reason:string,prompt:string}|null} */
    this._wakeup = null
    // Latest user/assistant entry timestamp seen (epoch ms) — used to decide
    // whether a scheduled wakeup has already fired (activity after its time).
    this._lastActivityTs = 0
    // #7327: most recent real (non-synthetic) `message.model` seen on an
    // assistant entry. Only ever moves forward to a newly-observed value —
    // never reset to null except by `_reset()` itself (a rotated/truncated
    // transcript), so a transient parse miss can't blank out an already-
    // known model.
    this._observedModel = null
    // #8223: cumulative count of `isApiErrorMessage` / `authentication_failed`
    // assistant entries (see the header). Reset with the rest of the state, so a
    // rotated or truncated transcript is recounted from its start.
    this._authFailureCount = 0
    // #8400: cumulative count of structured usage-limit / rate-limit / overload
    // entries, and the classification of the most recent one.
    this._usageLimitCount = 0
    this._lastUsageLimit = null
    // #7393: thinking capture. `_thinkingSinceMs === null` means OFF: blocks seen
    // while rebuilding state are never queued. It is deliberately not cleared by
    // a rotation reset (a reset re-reads the file; the timestamp cutoff and the
    // consumer's uuid de-duplication keep the re-read from replaying old blocks).
    this._thinking ??= []
    this._thinkingSinceMs ??= null
  }

  /**
   * #7393 — start queueing the thinking blocks of the current turn: those on
   * main-conversation assistant entries stamped at or after `sinceMs`. Idempotent
   * while active, so a consumer can call it on every pass without moving the
   * cutoff or dropping what is queued.
   * @param {number} sinceMs epoch ms of the turn start
   */
  startThinkingCapture(sinceMs) {
    if (this._thinkingSinceMs !== null) return
    this._thinking = []
    this._thinkingSinceMs = Number.isFinite(sinceMs) ? sinceMs : Date.now()
  }

  /** #7393 — stop queueing and drop whatever is queued. */
  stopThinkingCapture() {
    this._thinkingSinceMs = null
    this._thinking = []
  }

  /**
   * #7393 — take (and clear) the queued thinking blocks, oldest first.
   * @returns {Array<{uuid: string, ts: number, text: string, redacted: boolean, durationMs: number|undefined}>}
   */
  drainThinking() {
    const out = this._thinking
    this._thinking = []
    return out
  }

  /**
   * #7396: the tool-use ids of every `<task-notification>` seen so far, whatever
   * launched them and whatever their status.
   *
   * Deliberately NOT part of the `scan()` snapshot: the snapshot is what rides
   * the `claude_ready` wire and what the idle poll dedups on, and neither wants
   * this. And deliberately not derived from `backgroundTasks`: that list only
   * knows launches that REQUESTED `run_in_background`, while Claude Code also
   * backgrounds an Agent call that never asked (observed on a live transcript:
   * `toolUseResult.isAsync` on an Agent whose input has no `run_in_background`).
   * A caller tracking such an agent has to ask "was this id reported finished",
   * and this is the one place that answers it.
   *
   * Read-only view: callers must not mutate it.
   * @returns {ReadonlySet<string>}
   */
  get notifiedToolUseIds() {
    return this._notified
  }

  /**
   * #7396 (review): did the LAST `scan()` manage to read the transcript?
   * `null` before any scan. `scan()` itself degrades every failure to an empty
   * snapshot (its contract), which is indistinguishable from "nothing new" -- a
   * consumer that waits on a notification forever needs to tell the two apart.
   * A transcript that does not exist is `false` here, not an empty one.
   * @returns {boolean|null}
   */
  get readable() {
    return this._readable
  }

  /**
   * #7396 (review): how many times an over-cap unread tail made the scanner skip
   * ahead and drop the prefix it never parsed. A notification in that prefix is
   * gone for good, so a consumer waiting on one compares this with the value it
   * saw when it started waiting. Never reset.
   * @returns {number}
   */
  get discardCount() {
    return this._discardCount
  }

  /**
   * Read any new transcript bytes, fold them into the tracked state, and
   * return the outstanding-work snapshot. Never throws.
   * @returns {{backgroundTasks: Array<{toolUseId:string,kind:string,description:string,startedAt:number}>, scheduledWakeup: {at:number,reason:string}|null, observedModel: string|null, authFailureCount: number|null, usageLimitCount: number|null, lastUsageLimit: object|null}}
   */
  scan() {
    try {
      this._readNewBytes()
      this._readable = true
      return this._snapshot()
    } catch (err) {
      this._readable = false
      // ENOENT is the common benign case (transcript not written yet) —
      // still debug-logged, but state is preserved so a later scan picks
      // up where it left off if the file appears.
      this._log.debug?.(`transcript scan failed for ${this.path}: ${err.message} — degrading to empty snapshot`)
      // #8223: a transcript that does not exist holds no auth failures — a KNOWN
      // zero (or whatever was counted before the file went away). Any other
      // failure is "could not look", reported as null so a consumer never
      // baselines against it.
      return {
        backgroundTasks: [],
        scheduledWakeup: null,
        observedModel: null,
        authFailureCount: err?.code === 'ENOENT' ? this._authFailureCount : null,
        usageLimitCount: err?.code === 'ENOENT' ? this._usageLimitCount : null,
        lastUsageLimit: err?.code === 'ENOENT' ? this._lastUsageLimit : null,
      }
    }
  }

  _readNewBytes() {
    const fd = openSync(this.path, 'r')
    try {
      const stat = fstatSync(fd)
      // #8223: something other than a regular file at the transcript path is
      // "could not look", not an empty transcript. POSIX refuses to read a
      // directory (EISDIR); Windows opens it and reports size 0, which would
      // otherwise read as a KNOWN zero auth-failure count.
      if (!stat.isFile()) {
        const err = new Error(`transcript path is not a regular file: ${this.path}`)
        err.code = 'EISDIR'
        throw err
      }
      const size = stat.size
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
        this._discardCount++
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
        this._noteNotified(m[1])
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
      // #8223: both structured markers, never the text (see the header).
      if (entry.isApiErrorMessage === true && entry.error === 'authentication_failed') {
        this._authFailureCount++
      }
      // #8400: the same two structured markers, never free text on its own.
      if (entry.isApiErrorMessage === true && entry.isSidechain !== true) {
        const blocks = entry?.message?.content
        const text = Array.isArray(blocks)
          ? blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ')
          : ''
        const limit = classifyApiErrorEntry({ error: entry.error, apiErrorStatus: entry.apiErrorStatus, text })
        if (limit) {
          this._usageLimitCount++
          this._lastUsageLimit = limit
        }
      }
      // #7327: an OBSERVATION of the model this turn actually ran on — never
      // a stand-in for the requested/configured model. Excludes the
      // synthetic placeholder (see SYNTHETIC_MODEL), any non-string/empty
      // value, and a sidechain entry (review N2) — a subagent turn can run a
      // DIFFERENT model than the main conversation, and this scanner reports
      // the main session's own model. A later real observation always
      // supersedes an earlier one.
      const observedModel = entry?.message?.model
      if (
        entry.isSidechain !== true &&
        typeof observedModel === 'string' && observedModel && observedModel !== SYNTHETIC_MODEL
      ) {
        this._observedModel = observedModel
      }
      const blocks = entry?.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue
          this._ingestToolUse(block, entryTs ?? Date.now())
        }
        this._ingestThinking(entry, blocks, entryTs)
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

  /** @param {string} toolUseId */
  _noteNotified(toolUseId) {
    // Re-insert so a repeat notification (the same task-id notifies again each
    // time the agent stops) refreshes the id's age rather than leaving it to be
    // evicted ahead of newer ones.
    this._notified.delete(toolUseId)
    this._notified.add(toolUseId)
    if (this._notified.size > NOTIFIED_TOOL_USE_IDS_MAX) {
      // Oldest first, but never an id a caller has pinned (the subagents a
      // session is still waiting on): more than the cap of later notifications
      // in one scan window would otherwise evict a tracked agent's id before the
      // caller ever looked. Bounded by the number of pinned ids.
      for (const id of this._notified) {
        if (this.pinnedToolUseIds?.has(id)) continue
        this._notified.delete(id)
        break
      }
    }
  }

  /**
   * #7393 — queue the thinking blocks of one assistant entry while capture is on.
   * An entry with no usable timestamp is skipped: without it there is no telling
   * whether it belongs to this turn, and showing another turn's reasoning is worse
   * than showing none.
   */
  _ingestThinking(entry, blocks, entryTs) {
    if (this._thinkingSinceMs === null) return
    if (entry.isSidechain === true) return
    if (entryTs === null || entryTs < this._thinkingSinceMs) return
    const thinkingBlocks = blocks.filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
    if (thinkingBlocks.length === 0) return
    // `thinkingDurationMs` is per ENTRY, and Claude Code writes one block per
    // entry. If an entry ever held several, the duration cannot be attributed to
    // any one of them, so none gets it.
    const duration = thinkingBlocks.length === 1 && Number.isFinite(entry.thinkingDurationMs) && entry.thinkingDurationMs >= 0
      ? entry.thinkingDurationMs
      : undefined
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : ''
    for (const block of thinkingBlocks) {
      const redacted = block.type === 'redacted_thinking'
      let text = ''
      if (!redacted && typeof block.thinking === 'string') {
        text = block.thinking.length > MAX_THINKING_BLOCK_CHARS ? block.thinking.slice(0, MAX_THINKING_BLOCK_CHARS) : block.thinking
      }
      this._thinking.push({
        uuid: thinkingBlocks.length > 1 ? `${uuid}#${this._thinking.length}` : uuid,
        ts: entryTs,
        text,
        redacted,
        durationMs: duration,
      })
      if (this._thinking.length > MAX_PENDING_THINKING_BLOCKS) this._thinking.shift()
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
        const at = startedAt + delaySeconds * 1000
        // #7084: the computed instant must be a SAFE integer, not merely finite.
        // `delaySeconds` is model-authored tool input, so it is arbitrary JSON, and the
        // wire schema is `z.number().int().nonnegative().finite()` — where Zod's
        // `.int()` enforces the SAFE-integer range, not just integrality. Two reachable
        // shapes fail it:
        //   delaySeconds: 0.0001 -> a fractional `at`            (invalid_type)
        //   delaySeconds: 1e15   -> an `at` past 2^53            (too_big)
        // Measured against the built schema; 9e12 still fits, so the ceiling is real
        // rather than theoretical.
        //
        // DROP the wakeup rather than clamp it. The field is optional, and any clamp
        // renders a precise-looking lie about when the agent will wake — clamping to
        // MAX_SAFE_INTEGER actually yields an Invalid Date, and to Date's own ceiling
        // (8.64e15) yields "13 Sep 275760". Neither is a time. A nonsense delay means
        // the tool call is garbage, so having no scheduled wakeup is the honest state.
        //
        // Ignoring (rather than clearing an existing wakeup) matches what this guard
        // already did for a NaN `delaySeconds`: invalid input leaves any previously
        // armed wakeup alone instead of destroying it.
        // `at >= 0` is DEFENCE-IN-DEPTH, not load-bearing: measured, no input reaches
        // the snapshot with a negative `at`, because the consumption path already treats
        // a wakeup whose instant has passed as spent and every negative instant is past.
        // Kept because it is free and states the wire contract at the point of
        // construction — but do not read it as a guard with test coverage.
        if (Number.isSafeInteger(at) && at >= 0) {
          // A newer ScheduleWakeup supersedes any earlier pending one — the
          // harness keeps at most one timer armed.
          this._wakeup = {
            at,
            reason: typeof input.reason === 'string' ? input.reason : '',
            prompt: typeof input.prompt === 'string' ? input.prompt : '',
          }
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
    // #7084: `startedAt` carries the byte-identical wire constraint to
    // scheduledWakeup.at — BackgroundTaskSchema.startedAt is
    // `z.number().int().nonnegative().finite()` — and had no guard at all. It comes
    // from Date.parse of a transcript timestamp, so a pre-epoch entry yields a negative
    // instant (verified: 1960-01-01 -> -315619200000, which the schema refuses as
    // too_small). Drop the task rather than emit an unrepresentable one; the snapshot
    // is a list, so one bad entry would otherwise fail the whole claude_ready frame.
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) return
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
      observedModel: this._observedModel,
      authFailureCount: this._authFailureCount,
      usageLimitCount: this._usageLimitCount,
      lastUsageLimit: this._lastUsageLimit,
    }
  }
}
