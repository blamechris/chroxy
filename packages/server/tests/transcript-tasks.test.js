// #5431: unit tests for the TranscriptTaskScanner — the incremental session-
// transcript scanner that derives outstanding background work (run_in_background
// Bash/Agent, Monitor) and pending ScheduleWakeups for the enriched
// `claude_ready` payload.
//
// Fixture lines mirror the REAL transcript shapes verified against a live
// 5MB transcript (~/.claude/projects/…/<sessionId>.jsonl): assistant
// tool_use launches, queue-operation task-notification completions, and
// ScheduleWakeup tool_use entries. The scanner's contract is "never throw,
// degrade to empty" — several tests pin that explicitly.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TranscriptTaskScanner,
  transcriptPathForSessionFile,
  MAX_SCAN_BYTES,
  NOTIFIED_TOOL_USE_IDS_MAX,
} from '../src/transcript-tasks.js'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-tasks-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixture builders — shapes verified against a real transcript (#5431).
// ---------------------------------------------------------------------------

function launchLine({ id, name = 'Bash', runInBackground = true, description, prompt, ts = '2026-06-10T02:39:05.423Z' }) {
  const input = {}
  if (runInBackground !== null) input.run_in_background = runInBackground
  if (description !== undefined) input.description = description
  if (prompt !== undefined) input.prompt = prompt
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  })
}

function completionLine({ id, status = 'completed', ts = '2026-06-10T02:39:40.819Z' }) {
  const content = `<task-notification>\n<task-id>bnclpiaj0</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>${status}</status>\n<summary>Background command completed</summary>\n</task-notification>`
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: 's-1', content })
}

function wakeupLine({ id = 'toolu_wake1', delaySeconds = 90, reason = 'Waiting for CI', prompt = 'Check PR #149 required checks; if all pass, squash-merge it', ts = '2026-06-10T02:41:22.369Z' }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input: { delaySeconds, reason, prompt } }] },
  })
}

function userLine({ text, ts }) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

// #7327 — a plain assistant text response, the shape that carries
// `message.model`. Mirrors verified live-journal entries: `<synthetic>` is
// the harness's own placeholder for an injected assistant turn (e.g. an
// API-error stand-in), never a real booted model.
function assistantTextLine({ model, text = 'ok', ts = '2026-06-10T02:39:05.423Z' }) {
  const message = { role: 'assistant', content: [{ type: 'text', text }] }
  if (model !== undefined) message.model = model
  return JSON.stringify({ type: 'assistant', timestamp: ts, message })
}

function writeTranscript(lines, name = 'session.jsonl') {
  const p = join(dir, name)
  writeFileSync(p, lines.map((l) => l + '\n').join(''))
  return p
}

// ---------------------------------------------------------------------------
// transcriptPathForSessionFile (the key encoding itself is tested with
// encodeProjectPath in jsonl-reader.test.js, #7283)
// ---------------------------------------------------------------------------

describe('transcriptPathForSessionFile', () => {
  it('derives the projects-dir transcript path from sessionId + cwd', () => {
    const sessFile = join(dir, '123.json')
    writeFileSync(sessFile, JSON.stringify({
      pid: 123,
      sessionId: '34b3489f-d698-43af-a02e-b4be0c679e42',
      cwd: '/Users/blamechris/Projects/repo-relay',
      status: 'busy',
    }))
    const p = transcriptPathForSessionFile(sessFile)
    assert.ok(p.endsWith(join('.claude', 'projects', '-Users-blamechris-Projects-repo-relay', '34b3489f-d698-43af-a02e-b4be0c679e42.jsonl')))
  })

  it('returns null for a missing file, bad JSON, missing fields, or unsafe sessionId', () => {
    assert.equal(transcriptPathForSessionFile(join(dir, 'nope.json')), null)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    assert.equal(transcriptPathForSessionFile(bad), null)

    const noCwd = join(dir, 'nocwd.json')
    writeFileSync(noCwd, JSON.stringify({ sessionId: 'abc' }))
    assert.equal(transcriptPathForSessionFile(noCwd), null)

    const traversal = join(dir, 'traversal.json')
    writeFileSync(traversal, JSON.stringify({ sessionId: '../../etc/passwd', cwd: '/tmp' }))
    assert.equal(transcriptPathForSessionFile(traversal), null)
  })
})

// ---------------------------------------------------------------------------
// TranscriptTaskScanner — launches and completions
// ---------------------------------------------------------------------------

describe('TranscriptTaskScanner — launch/completion pairing', () => {
  it('reports an unmatched background Bash launch as outstanding', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_aaa', description: 'Wait for CI checks on PR #164' }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.backgroundTasks.length, 1)
    assert.deepEqual(snap.backgroundTasks[0], {
      toolUseId: 'toolu_aaa',
      kind: 'bash',
      description: 'Wait for CI checks on PR #164',
      startedAt: Date.parse('2026-06-10T02:39:05.423Z'),
    })
    assert.equal(snap.scheduledWakeup, null)
  })

  it('clears a launch when its task-notification completion lands', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_aaa', description: 'watcher' }),
      completionLine({ id: 'toolu_aaa' }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.deepEqual(snap.backgroundTasks, [])
  })

  it('treats a failed task-notification as completed too (task no longer running)', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_aaa', description: 'watcher' }),
      completionLine({ id: 'toolu_aaa', status: 'failed' }),
    ])
    assert.deepEqual(new TranscriptTaskScanner(p).scan().backgroundTasks, [])
  })

  it('pairs by tool-use id — only the matching launch clears', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_aaa', description: 'first' }),
      launchLine({ id: 'toolu_bbb', description: 'second' }),
      completionLine({ id: 'toolu_aaa' }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.backgroundTasks.length, 1)
    assert.equal(snap.backgroundTasks[0].toolUseId, 'toolu_bbb')
  })

  it('detects background Agent launches (kind=agent) with prompt-derived description', () => {
    const longPrompt = 'Explore the project at /Users/blamechris/Projects/chroxy '.repeat(5)
    const p = writeTranscript([
      launchLine({ id: 'toolu_agent', name: 'Agent', prompt: longPrompt }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.backgroundTasks[0].kind, 'agent')
    assert.equal(snap.backgroundTasks[0].description, longPrompt.slice(0, 80))
  })

  it('detects Monitor calls as background work even without run_in_background', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_mon', name: 'Monitor', runInBackground: null, description: 'Watch deploy logs' }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.backgroundTasks[0].kind, 'monitor')
  })

  it('ignores foreground Bash/Agent tool_use entries', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_fg1', runInBackground: false, description: 'npm test' }),
      launchLine({ id: 'toolu_fg2', runInBackground: null, description: 'git status' }),
    ])
    assert.deepEqual(new TranscriptTaskScanner(p).scan().backgroundTasks, [])
  })
})

// ---------------------------------------------------------------------------
// ScheduleWakeup
// ---------------------------------------------------------------------------

describe('TranscriptTaskScanner — ScheduleWakeup', () => {

  // #7084 — `delaySeconds` is MODEL-AUTHORED tool input, so `at` must be checked for
  // range, not just finiteness. The wire schema is
  // `z.number().int().nonnegative().finite()`, and Zod's `.int()` enforces the SAFE
  // integer range — so both a fractional and a past-2^53 `at` are wire-illegal.
  describe('#7084 an out-of-range wakeup is dropped, not emitted', () => {
    const ts = '2026-06-10T02:41:22.369Z'

    it('CONTROL: an ordinary delay still produces a wakeup', () => {
      // Without this, every "is null" assertion below could pass because the scanner
      // stopped producing wakeups at all.
      const p = writeTranscript([wakeupLine({ delaySeconds: 90, ts })])
      assert.equal(new TranscriptTaskScanner(p).scan().scheduledWakeup.at, Date.parse(ts) + 90_000)
    })

    it('drops a FRACTIONAL at (delaySeconds with sub-ms precision)', () => {
      // 0.0001s -> +0.1ms -> a fractional instant. Rejected by `.int()` as invalid_type.
      const p = writeTranscript([wakeupLine({ delaySeconds: 0.0001, ts })])
      assert.equal(new TranscriptTaskScanner(p).scan().scheduledWakeup, null)
    })

    it('drops an at past the safe-integer range (a model-authored "never" sentinel)', () => {
      for (const delaySeconds of [1e15, 99999999999999999, 1e300]) {
        const p = writeTranscript([wakeupLine({ delaySeconds, ts })])
        assert.equal(
          new TranscriptTaskScanner(p).scan().scheduledWakeup, null,
          `delaySeconds ${delaySeconds} must not produce a wakeup`,
        )
      }
    })

    it('keeps a large-but-representable delay (the guard is not over-eager)', () => {
      // 9e12 seconds still lands inside the safe range — measured. The guard must
      // reject only what the wire actually refuses, not everything that looks big.
      const p = writeTranscript([wakeupLine({ delaySeconds: 9e12, ts })])
      const snap = new TranscriptTaskScanner(p).scan()
      assert.equal(snap.scheduledWakeup.at, Date.parse(ts) + 9e12 * 1000)
      assert.ok(Number.isSafeInteger(snap.scheduledWakeup.at))
    })

    it('a garbage wakeup does not destroy a previously armed one', () => {
      // Matches what this guard already did for a NaN delaySeconds: invalid input is
      // IGNORED rather than clearing a valid pending wakeup.
      const p = writeTranscript([
        wakeupLine({ delaySeconds: 90, reason: 'good', ts }),
        wakeupLine({ delaySeconds: 1e15, reason: 'garbage', ts: '2026-06-10T02:42:21.322Z' }),
      ])
      const snap = new TranscriptTaskScanner(p).scan()
      assert.equal(snap.scheduledWakeup?.reason, 'good', 'the valid earlier wakeup survives')
    })

    it('CHARACTERIZATION: a pre-epoch wakeup never reaches the wire (via consumption)', () => {
      // Named honestly. Review flagged that `at >= 0` had a mutation score of zero and
      // supplied a schema-level reachability proof — but that proof does not survive the
      // scanner's full pipeline. Measured: with the clause removed, NO input produces a
      // negative `at` in the snapshot, because a wakeup whose instant has passed is
      // already marked spent by the consumption path, and every negative instant is in
      // the past. The nearest survivor is `at: 0`, which is legal anyway.
      //
      // So this pins the OUTCOME (a pre-epoch wakeup is never emitted), not the clause.
      // `at >= 0` stays as defence-in-depth — see the note in transcript-tasks.js — but
      // is not claimed as verified, which is what the earlier version of this test
      // wrongly implied.
      const p = writeTranscript([wakeupLine({ delaySeconds: 0, ts: '1960-01-01T00:00:00.000Z' })])
      assert.equal(new TranscriptTaskScanner(p).scan().scheduledWakeup, null)
    })

    it('drops a background task whose startedAt is unrepresentable', () => {
      // The ADJACENT field, two lines away in the same method, with the byte-identical
      // wire constraint and no guard at all — the same neighbour pattern behind #7051,
      // #7080, #7081, #7089, #7093 and #7096. The snapshot is a LIST, so one bad entry
      // would fail the whole claude_ready frame rather than just its own row.
      const p = writeTranscript([launchLine({ id: 'toolu_bg1', ts: '1960-01-01T00:00:00.000Z' })])
      const snap = new TranscriptTaskScanner(p).scan()
      assert.deepEqual(snap.backgroundTasks, [], 'a pre-epoch task must not reach the wire')
    })

    it('CONTROL: an ordinary background task still appears', () => {
      const p = writeTranscript([launchLine({ id: 'toolu_bg1', ts: '2026-06-10T02:41:22.369Z' })])
      assert.equal(new TranscriptTaskScanner(p).scan().backgroundTasks.length, 1)
    })

    it('CONTRACT: any emitted at is a non-negative safe integer', () => {
      // The property the wire schema requires, asserted directly so it cannot drift
      // from whatever the guard happens to implement.
      for (const delaySeconds of [0, 90, 0.0001, 1e15, 9e12, 1e300]) {
        const p = writeTranscript([wakeupLine({ delaySeconds, ts })])
        const w = new TranscriptTaskScanner(p).scan().scheduledWakeup
        if (w === null) continue
        assert.ok(
          Number.isSafeInteger(w.at) && w.at >= 0,
          `delaySeconds ${delaySeconds} emitted at=${w.at}, which the wire refuses`,
        )
      }
    })
  })

  it('reports a pending wakeup with at = entry timestamp + delaySeconds', () => {
    const ts = '2026-06-10T02:41:22.369Z'
    const p = writeTranscript([wakeupLine({ delaySeconds: 90, ts })])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.deepEqual(snap.scheduledWakeup, {
      at: Date.parse(ts) + 90_000,
      reason: 'Waiting for CI',
    })
  })

  it('a newer ScheduleWakeup supersedes the previous one', () => {
    const p = writeTranscript([
      wakeupLine({ delaySeconds: 90, reason: 'first', ts: '2026-06-10T02:41:22.369Z' }),
      wakeupLine({ delaySeconds: 240, reason: 'second', ts: '2026-06-10T02:42:21.322Z' }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.scheduledWakeup.reason, 'second')
    assert.equal(snap.scheduledWakeup.at, Date.parse('2026-06-10T02:42:21.322Z') + 240_000)
  })

  it('consumes the wakeup when a later user message carries its prompt', () => {
    const prompt = 'Check PR #149 required checks; if all pass, squash-merge it'
    const p = writeTranscript([
      wakeupLine({ prompt, ts: '2026-06-10T02:41:22.369Z' }),
      userLine({ text: prompt, ts: '2026-06-10T02:42:55.000Z' }),
    ])
    assert.equal(new TranscriptTaskScanner(p).scan().scheduledWakeup, null)
  })

  it('consumes the wakeup when any user/assistant activity lands after the scheduled time', () => {
    const ts = '2026-06-10T02:41:22.369Z' // wakeup at +90s = 02:42:52.369Z
    const p = writeTranscript([
      wakeupLine({ delaySeconds: 90, ts }),
      userLine({ text: 'unrelated follow-up from the user', ts: '2026-06-10T02:45:00.000Z' }),
    ])
    assert.equal(new TranscriptTaskScanner(p).scan().scheduledWakeup, null)
  })

  it('keeps the wakeup pending when activity predates the scheduled time', () => {
    const ts = '2026-06-10T02:41:22.369Z'
    const p = writeTranscript([
      wakeupLine({ delaySeconds: 600, ts }),
      // tool_result chatter right after scheduling — well before the wakeup time
      userLine({ text: 'Next wakeup scheduled for 19:43:00 (in 98s).', ts: '2026-06-10T02:41:22.515Z' }),
    ])
    assert.ok(new TranscriptTaskScanner(p).scan().scheduledWakeup)
  })
})

// ---------------------------------------------------------------------------
// Robustness — malformed input, empty/missing files, incremental reads
// ---------------------------------------------------------------------------

describe('TranscriptTaskScanner — robustness', () => {
  it('returns the empty snapshot for a missing file (never throws)', () => {
    const scanner = new TranscriptTaskScanner(join(dir, 'does-not-exist.jsonl'))
    assert.deepEqual(scanner.scan(), { backgroundTasks: [], scheduledWakeup: null, observedModel: null, authFailureCount: 0, usageLimitCount: 0, lastUsageLimit: null })
  })

  it('returns the empty snapshot for an empty file', () => {
    const p = writeTranscript([])
    assert.deepEqual(new TranscriptTaskScanner(p).scan(), { backgroundTasks: [], scheduledWakeup: null, observedModel: null, authFailureCount: 0, usageLimitCount: 0, lastUsageLimit: null })
  })

  it('skips malformed lines without losing surrounding entries', () => {
    const p = writeTranscript([
      '{truncated json garbage',
      launchLine({ id: 'toolu_ok', description: 'survives' }),
      'not even json',
      '{"type":"assistant","message":{"content":"not-an-array"}}',
      '{"type":null}',
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.backgroundTasks.length, 1)
    assert.equal(snap.backgroundTasks[0].toolUseId, 'toolu_ok')
  })

  it('handles entries with no timestamp (last-prompt / mode metadata lines)', () => {
    const p = writeTranscript([
      JSON.stringify({ type: 'last-prompt' }),
      JSON.stringify({ type: 'mode', timestamp: null }),
      launchLine({ id: 'toolu_x', description: 'd' }),
    ])
    assert.equal(new TranscriptTaskScanner(p).scan().backgroundTasks.length, 1)
  })

  it('scans incrementally — a completion appended later clears the task on the next scan', () => {
    const p = writeTranscript([launchLine({ id: 'toolu_inc', description: 'watching' })])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().backgroundTasks.length, 1)

    appendFileSync(p, completionLine({ id: 'toolu_inc' }) + '\n')
    assert.deepEqual(scanner.scan().backgroundTasks, [])
  })

  it('buffers a partial trailing line until the rest is written', () => {
    const full = completionLine({ id: 'toolu_part' })
    const p = writeTranscript([launchLine({ id: 'toolu_part', description: 'd' })])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().backgroundTasks.length, 1)

    // Write only half the completion line (no newline) — must not match yet.
    appendFileSync(p, full.slice(0, 40))
    assert.equal(scanner.scan().backgroundTasks.length, 1)

    // Complete the line — now it pairs.
    appendFileSync(p, full.slice(40) + '\n')
    assert.deepEqual(scanner.scan().backgroundTasks, [])
  })

  it('resets and rescans when the file shrinks (rotation/truncation)', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_old', description: 'old session' }),
      launchLine({ id: 'toolu_old2', description: 'old session 2' }),
    ])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().backgroundTasks.length, 2)

    // Replace with a SHORTER file containing different tasks.
    writeFileSync(p, launchLine({ id: 'toolu_new', description: 'fresh' }) + '\n')
    const snap = scanner.scan()
    assert.equal(snap.backgroundTasks.length, 1)
    assert.equal(snap.backgroundTasks[0].toolUseId, 'toolu_new')
  })

  it('exposes a sane bounded-read cap', () => {
    assert.ok(MAX_SCAN_BYTES >= 8 * 1024 * 1024)
  })
})

// #7327 — observedModel: the model a claude-tui session is ACTUALLY running,
// read off the transcript's own `message.model` on assistant entries. Never
// a stand-in for a configured/requested model — the scanner has no notion of
// "requested" at all, only what it saw.
describe('TranscriptTaskScanner — observedModel (#7327)', () => {
  it('is null before any assistant entry has been seen', () => {
    const p = writeTranscript([userLine({ text: 'hi', ts: '2026-06-10T02:39:00.000Z' })])
    assert.equal(new TranscriptTaskScanner(p).scan().observedModel, null)
  })

  it('reports the model observed on an assistant entry', () => {
    const p = writeTranscript([assistantTextLine({ model: 'claude-sonnet-5' })])
    assert.equal(new TranscriptTaskScanner(p).scan().observedModel, 'claude-sonnet-5')
  })

  it('updates to a later entry’s model (e.g. the user ran /model mid-session)', () => {
    const p = writeTranscript([assistantTextLine({ model: 'claude-sonnet-5', ts: '2026-06-10T02:39:00.000Z' })])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().observedModel, 'claude-sonnet-5')

    appendFileSync(p, assistantTextLine({ model: 'claude-opus-5', ts: '2026-06-10T02:40:00.000Z' }) + '\n')
    assert.equal(scanner.scan().observedModel, 'claude-opus-5')
  })

  it('ignores the synthetic placeholder — never reports it as an observation', () => {
    const p = writeTranscript([assistantTextLine({ model: '<synthetic>', text: 'API Error: 529 Overloaded' })])
    assert.equal(new TranscriptTaskScanner(p).scan().observedModel, null)
  })

  it('a synthetic entry does not clobber an already-observed real model', () => {
    const p = writeTranscript([assistantTextLine({ model: 'claude-sonnet-5', ts: '2026-06-10T02:39:00.000Z' })])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().observedModel, 'claude-sonnet-5')

    appendFileSync(p, assistantTextLine({ model: '<synthetic>', ts: '2026-06-10T02:40:00.000Z' }) + '\n')
    assert.equal(scanner.scan().observedModel, 'claude-sonnet-5',
      'a later synthetic entry must not blank out the real observation')
  })

  it('ignores a missing or non-string model field', () => {
    const p = writeTranscript([
      assistantTextLine({ model: undefined }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T02:39:01.000Z', message: { role: 'assistant', model: 42, content: [] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T02:39:02.000Z', message: { role: 'assistant', model: '', content: [] } }),
    ])
    assert.equal(new TranscriptTaskScanner(p).scan().observedModel, null)
  })

  it('coexists with background-task tracking on the same entry', () => {
    // A tool_use launch and a model observation can land on the same
    // assistant entry (the scanner's tool_use walk and model read are
    // independent passes over the same parsed line).
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-10T02:39:05.423Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'toolu_both', name: 'Bash', input: { description: 'd', run_in_background: true } }],
      },
    })
    const snap = new TranscriptTaskScanner(writeTranscript([line])).scan()
    assert.equal(snap.observedModel, 'claude-opus-5')
    assert.equal(snap.backgroundTasks.length, 1)
  })

  it('ignores a sidechain entry\'s model — a subagent turn can run a different model (review N2)', () => {
    const main = assistantTextLine({ model: 'claude-sonnet-5', ts: '2026-06-10T02:39:00.000Z' })
    const sidechain = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      timestamp: '2026-06-10T02:39:30.000Z',
      message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'subagent output' }] },
    })
    const snap = new TranscriptTaskScanner(writeTranscript([main, sidechain])).scan()
    assert.equal(snap.observedModel, 'claude-sonnet-5', 'the sidechain entry\'s model must not overwrite the main session\'s observation')
  })
})

// ---------------------------------------------------------------------------
// #8223 — authFailureCount: structured `authentication_failed` API errors
// ---------------------------------------------------------------------------

// The shape claude writes when an API call fails authentication (live capture,
// claude 2.1.289): `isApiErrorMessage` + `error` on a synthetic assistant entry,
// whatever the PTY's width — at a narrow PTY the banner is never painted.
function authErrorLine({ ts = '2026-06-10T02:40:00.000Z', text = 'Please run /login · API Error: 401 OAuth access token is invalid.' } = {}) {
  return JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'authentication_failed',
    timestamp: ts,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], usage: { output_tokens: 0 } },
  })
}

describe('TranscriptTaskScanner — authFailureCount (#8223)', () => {
  it('counts a structured authentication_failed API-error entry', () => {
    const p = writeTranscript([userLine({ text: 'hi', ts: '2026-06-10T02:39:59.000Z' }), authErrorLine()])
    assert.equal(new TranscriptTaskScanner(p).scan().authFailureCount, 1)
  })

  it('is 0 for an empty transcript and for a transcript with no auth failures', () => {
    assert.equal(new TranscriptTaskScanner(writeTranscript([])).scan().authFailureCount, 0)
    const p = writeTranscript([userLine({ text: 'hi' }), assistantTextLine({ model: 'claude-opus-5' })])
    assert.equal(new TranscriptTaskScanner(p).scan().authFailureCount, 0)
  })

  it('does not count other API errors, a reply whose TEXT says "Please run /login", or non-assistant entries', () => {
    const p = writeTranscript([
      // other error classes use the same two fields with a different enum value
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'rate limited' }] } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'billing_error', message: { role: 'assistant', content: [] } }),
      // a model discussing /login carries the same words, with neither structured marker
      assistantTextLine({ model: 'claude-opus-5', text: 'Please run /login · API Error: 401 OAuth access token is invalid.' }),
      // `error` without the API-error marker, and the marker without `error`
      JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [] } }),
      // loose truthiness is not the marker
      JSON.stringify({ type: 'assistant', isApiErrorMessage: 'true', error: 'authentication_failed', message: { role: 'assistant', content: [] } }),
      // a user entry (or any non-assistant entry) carrying the fields
      JSON.stringify({ type: 'user', isApiErrorMessage: true, error: 'authentication_failed', message: { role: 'user', content: 'x' } }),
      JSON.stringify({ type: 'system', isApiErrorMessage: true, error: 'authentication_failed' }),
    ])
    assert.equal(new TranscriptTaskScanner(p).scan().authFailureCount, 0)
  })

  it('counts incrementally across appends and never recounts an entry it has already read', () => {
    const p = writeTranscript([userLine({ text: 'hi' })])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().authFailureCount, 0)
    assert.equal(scanner.scan().authFailureCount, 0)

    appendFileSync(p, authErrorLine() + '\n')
    assert.equal(scanner.scan().authFailureCount, 1)
    assert.equal(scanner.scan().authFailureCount, 1, 'a rescan with no new bytes must not recount')

    appendFileSync(p, assistantTextLine({ model: 'claude-opus-5' }) + '\n' + authErrorLine({ ts: '2026-06-10T02:41:00.000Z' }) + '\n')
    assert.equal(scanner.scan().authFailureCount, 2)
  })

  it('buffers a half-written entry and counts it only once the line is complete', () => {
    const full = authErrorLine()
    const p = writeTranscript([])
    const scanner = new TranscriptTaskScanner(p)
    appendFileSync(p, full.slice(0, 60))
    assert.equal(scanner.scan().authFailureCount, 0)
    appendFileSync(p, full.slice(60) + '\n')
    assert.equal(scanner.scan().authFailureCount, 1)
  })

  it('leaves the existing fields untouched by an auth-failure entry', () => {
    const p = writeTranscript([launchLine({ id: 'toolu_bg', description: 'watching' }), authErrorLine()])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.authFailureCount, 1)
    assert.equal(snap.backgroundTasks.length, 1)
    assert.equal(snap.backgroundTasks[0].toolUseId, 'toolu_bg')
    assert.equal(snap.scheduledWakeup, null)
    // The synthetic stand-in model is still not reported as an observation (#7327).
    assert.equal(snap.observedModel, null)
  })

  it('reports a KNOWN 0 for a transcript that does not exist yet, and null when it cannot be read', () => {
    // Not written yet: nothing in it can be an old failure, so a baseline of 0 is sound.
    assert.equal(new TranscriptTaskScanner(join(dir, 'not-yet.jsonl')).scan().authFailureCount, 0)
    // Present but unreadable (a directory here): "could not look" — never a count to baseline against.
    const snap = new TranscriptTaskScanner(dir).scan()
    assert.equal(snap.authFailureCount, null)
    assert.deepEqual(snap.backgroundTasks, [])
  })

  // #8223: the shape Windows gives a directory — it OPENS, reports size 0, and is
  // not a regular file. POSIX refuses to read a directory (EISDIR), so the test
  // above never saw it here; a character device reproduces it on POSIX.
  it('reports null, not a known 0, for a path that opens but is not a regular file', { skip: process.platform === 'win32' ? 'the directory case above covers win32' : false }, () => {
    const snap = new TranscriptTaskScanner('/dev/null').scan()
    assert.equal(snap.authFailureCount, null)
    assert.deepEqual(snap.backgroundTasks, [])
  })

  it('recounts from the start when the transcript shrinks (rotation/truncation)', () => {
    const p = writeTranscript([authErrorLine(), authErrorLine({ ts: '2026-06-10T02:41:00.000Z' }), userLine({ text: 'padding to make the first file larger' })])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().authFailureCount, 2)
    writeFileSync(p, authErrorLine() + '\n')
    assert.equal(scanner.scan().authFailureCount, 1)
  })

  it('never throws, whatever the entry holds', () => {
    const p = writeTranscript(['{"type":"assistant","isApiErrorMessage":true,"error":', 'null', '[]', '{"type":"assistant","isApiErrorMessage":true,"error":{"x":1}}'])
    assert.doesNotThrow(() => new TranscriptTaskScanner(p).scan())
    assert.equal(new TranscriptTaskScanner(p).scan().authFailureCount, 0)
  })
})

// ---------------------------------------------------------------------------
// #8400 — usageLimitCount / lastUsageLimit: structured rate_limit / 529 entries
// ---------------------------------------------------------------------------

// Real claude wording (a live transcript's `isApiErrorMessage` entry).
function limitLine({ error = 'rate_limit', status = 429, text = "You've hit your session limit · resets 11:30pm (America/Los_Angeles)", sidechain = false, ts = '2026-06-10T02:40:00.000Z' } = {}) {
  const e = {
    isSidechain: sidechain,
    type: 'assistant',
    isApiErrorMessage: true,
    error,
    timestamp: ts,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], usage: { output_tokens: 0 } },
  }
  if (status) e.apiErrorStatus = status
  return JSON.stringify(e)
}

describe('TranscriptTaskScanner — usageLimitCount (#8400)', () => {
  it('counts a rate_limit entry and keeps its classification', () => {
    const snap = new TranscriptTaskScanner(writeTranscript([userLine({ text: 'hi' }), limitLine()])).scan()
    assert.equal(snap.usageLimitCount, 1)
    assert.equal(snap.lastUsageLimit.kind, 'session')
    assert.equal(snap.lastUsageLimit.resetsAt, '11:30pm (America/Los_Angeles)')
    assert.equal(snap.authFailureCount, 0, 'a limit is not an auth failure')
  })

  it('counts a 529 overload, and not a 500', () => {
    const p = writeTranscript([
      limitLine({ error: 'server_error', status: 529, text: 'API Error: 529 Overloaded. This is a server-side issue.' }),
      limitLine({ error: 'server_error', status: 500, text: 'API Error: 500 Internal server error.' }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.usageLimitCount, 1)
    assert.equal(snap.lastUsageLimit.kind, 'overloaded')
  })

  it('does not count an auth failure, a plain reply that quotes the words, or a subagent (sidechain) entry', () => {
    const p = writeTranscript([
      authErrorLine(),
      assistantTextLine({ text: "You've hit your session limit · resets 3pm" }),
      limitLine({ sidechain: true }),
    ])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.equal(snap.usageLimitCount, 0)
    assert.equal(snap.lastUsageLimit, null)
  })

  it('needs the isApiErrorMessage marker: a stray `error` field on an ordinary entry is not a limit', () => {
    const stray = JSON.stringify({ type: 'assistant', error: 'rate_limit', apiErrorStatus: 429, timestamp: '2026-06-10T02:40:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    assert.equal(new TranscriptTaskScanner(writeTranscript([stray])).scan().usageLimitCount, 0)
  })

  it('is cumulative and incremental: a rescan with no new bytes does not recount', () => {
    const p = writeTranscript([limitLine()])
    const scanner = new TranscriptTaskScanner(p)
    assert.equal(scanner.scan().usageLimitCount, 1)
    assert.equal(scanner.scan().usageLimitCount, 1)
    appendFileSync(p, limitLine({ text: "You've hit your weekly limit · resets Jul 22 at 4pm (America/Los_Angeles)" }) + '\n')
    const snap = scanner.scan()
    assert.equal(snap.usageLimitCount, 2)
    assert.equal(snap.lastUsageLimit.kind, 'weekly', 'the latest entry wins')
  })

  it('reports a KNOWN 0 for a transcript that does not exist yet, and null when it cannot be read', () => {
    const missing = new TranscriptTaskScanner(join(dir, 'not-yet.jsonl')).scan()
    assert.equal(missing.usageLimitCount, 0)
    assert.equal(missing.lastUsageLimit, null)
    assert.equal(new TranscriptTaskScanner(dir).scan().usageLimitCount, null)
  })

  it('never throws on a malformed entry', () => {
    const p = writeTranscript(['{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","message":{"content":[null,1,{"text":5}]}}', '{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","message":null}'])
    assert.doesNotThrow(() => new TranscriptTaskScanner(p).scan())
    assert.equal(new TranscriptTaskScanner(p).scan().usageLimitCount, 2, 'the structured marker alone counts')
  })
})

// #7396 -- claude-tui tracks subagents from the same transcript. The scanner's
// `backgroundTasks` list only knows launches that REQUESTED
// `run_in_background`, but Claude Code backgrounds an Agent call that never
// asked (observed on a live transcript: `toolUseResult.isAsync` on an Agent
// whose input has no `run_in_background`). The session therefore needs the
// other half on its own: every tool-use id a task-notification has named.
describe('TranscriptTaskScanner -- notifiedToolUseIds (#7396)', () => {
  const attachmentNotice = (id, status = 'completed') => JSON.stringify({
    type: 'attachment', timestamp: '2026-06-10T02:39:41.000Z',
    attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` },
  })

  it('collects the id of every task-notification, whatever launched it and whatever the status', () => {
    const p = writeTranscript([
      launchLine({ id: 'toolu_bg', name: 'Agent', runInBackground: true, description: 'a' }),
      completionLine({ id: 'toolu_bg' }),
      attachmentNotice('toolu_implicit', 'failed'),
    ])
    const scanner = new TranscriptTaskScanner(p)
    scanner.scan()
    assert.deepEqual([...scanner.notifiedToolUseIds].sort(), ['toolu_bg', 'toolu_implicit'])
  })

  it('is empty until a notification lands, and incremental across scans', () => {
    const p = writeTranscript([launchLine({ id: 'toolu_a', name: 'Agent' })])
    const scanner = new TranscriptTaskScanner(p)
    scanner.scan()
    assert.equal(scanner.notifiedToolUseIds.size, 0)
    appendFileSync(p, completionLine({ id: 'toolu_a' }) + '\n')
    scanner.scan()
    assert.deepEqual([...scanner.notifiedToolUseIds], ['toolu_a'])
  })

  it('is re-derived, not retained, when the transcript is truncated', () => {
    const p = writeTranscript([completionLine({ id: 'toolu_old' }), launchLine({ id: 'toolu_pad', description: 'x'.repeat(200) })])
    const scanner = new TranscriptTaskScanner(p)
    scanner.scan()
    assert.ok(scanner.notifiedToolUseIds.has('toolu_old'))
    writeFileSync(p, completionLine({ id: 'toolu_new' }) + '\n')
    scanner.scan()
    assert.deepEqual([...scanner.notifiedToolUseIds], ['toolu_new'])
  })

  it('is bounded, dropping the oldest ids first', () => {
    const lines = []
    for (let i = 0; i < NOTIFIED_TOOL_USE_IDS_MAX + 5; i++) lines.push(completionLine({ id: `toolu_${i}` }))
    const scanner = new TranscriptTaskScanner(writeTranscript(lines))
    scanner.scan()
    assert.equal(scanner.notifiedToolUseIds.size, NOTIFIED_TOOL_USE_IDS_MAX)
    assert.ok(!scanner.notifiedToolUseIds.has('toolu_0'))
    assert.ok(scanner.notifiedToolUseIds.has(`toolu_${NOTIFIED_TOOL_USE_IDS_MAX + 4}`))
  })

  it('does not change the snapshot shape the wire and the dedup key are built from', () => {
    const p = writeTranscript([completionLine({ id: 'toolu_a' })])
    const snap = new TranscriptTaskScanner(p).scan()
    assert.ok(!('notifiedToolUseIds' in snap))
  })
})
