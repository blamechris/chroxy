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
  slugifyCwd,
  MAX_SCAN_BYTES,
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

function writeTranscript(lines, name = 'session.jsonl') {
  const p = join(dir, name)
  writeFileSync(p, lines.map((l) => l + '\n').join(''))
  return p
}

// ---------------------------------------------------------------------------
// slugifyCwd / transcriptPathForSessionFile
// ---------------------------------------------------------------------------

describe('slugifyCwd', () => {
  it('replaces every non-alphanumeric character with a dash (verified rule)', () => {
    assert.equal(slugifyCwd('/Users/blamechris/Projects/repo-relay'), '-Users-blamechris-Projects-repo-relay')
    assert.equal(slugifyCwd('/Users/x/Downloads/Mom Hospitalization Files'), '-Users-x-Downloads-Mom-Hospitalization-Files')
    assert.equal(slugifyCwd('/private/tmp/my.dotted_dir'), '-private-tmp-my-dotted-dir')
  })
})

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
    assert.deepEqual(scanner.scan(), { backgroundTasks: [], scheduledWakeup: null })
  })

  it('returns the empty snapshot for an empty file', () => {
    const p = writeTranscript([])
    assert.deepEqual(new TranscriptTaskScanner(p).scan(), { backgroundTasks: [], scheduledWakeup: null })
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
