// Integration-level paste-heuristic stub for ClaudeTuiSession prompt
// writes (#4271).
//
// Unit tests in claude-tui-session.test.js pin the exact bytes
// chroxy emits to the PTY when `_writePtyTextThrottled` runs (#4269 +
// #4273). They cannot verify that those bytes survive claude TUI's
// paste detector and arrive as typed input rather than a paste
// placeholder. This file routes the production write path through a
// `PasteHeuristicPtyStub` that models the user-visible side of the
// detector, and asserts:
//
//   1. Throttled writes (the production path) do NOT trip the
//      heuristic at common burst thresholds.
//   2. A bulk write (the pre-fix regression path) DOES trip the
//      heuristic at the same thresholds — proving the test
//      discriminates rather than passing trivially.
//   3. Throttling is robust to multi-byte chars (emoji).
//   4. Abort-mid-loop does not retroactively turn the partial write
//      into a paste-detected burst.
//
// Stub assumptions are documented in tests/helpers/paste-heuristic-pty-stub.js.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { PasteHeuristicPtyStub } from './helpers/paste-heuristic-pty-stub.js'

// Threshold values picked to discriminate "bulk synchronous write"
// (the pre-#4269 path) from "per-char throttled write" (the fix).
//
// The production throttle spaces chars at PROMPT_CHAR_DELAY_MS
// (currently 1ms) per char via `await new Promise(setTimeout, 1)`.
// In practice Node's timer floor + event-loop scheduling means each
// char lands a few ms apart — N chars take roughly N ms. A bulk
// write, by contrast, delivers all N chars synchronously inside a
// single event-loop tick — ALL chars share a single sub-millisecond
// timestamp.
//
// claude TUI's real heuristic must distinguish these two regimes.
// Empirically (from #4269 repro logs) bulk writes of 30+ chars were
// collapsed; per-char throttled writes were not. We pick thresholds
// that lie between the two regimes so the discriminator test is
// meaningful:
//
//   - LOOSE = 30 chars in 2 ms — a bulk write (all chars share one
//             tick) easily clears this; a 1ms-per-char throttle
//             spends ~30ms on 30 chars, well outside the 2ms window.
//   - TIGHT = 10 chars in 1 ms — a bulk write of 10+ chars still
//             trips it; the throttle puts >=1ms between each char so
//             at most ~2 chars fall inside any 1ms window.
//
// These match the magnitudes of the real heuristic without
// hard-coding claude TUI's exact constants — when claude changes its
// detector, only these two values need re-tuning.
const LOOSE_MS = 2
const LOOSE_CHARS = 30
const TIGHT_MS = 1
const TIGHT_CHARS = 10

describe('ClaudeTuiSession paste-heuristic integration (#4271)', () => {
  function makeSession() {
    const session = new ClaudeTuiSession({
      cwd: '/tmp',
      skillsDir: '/tmp',
      repoSkillsDir: null,
    })
    session._activeTurn = {
      messageId: 'm-paste-heuristic',
      startedAt: Date.now(),
      aborted: false,
      synthSeq: 0,
    }
    return session
  }

  it('throttled 200-char prompt does NOT trip the paste heuristic (LOOSE)', async () => {
    const session = makeSession()
    const pty = new PasteHeuristicPtyStub()
    session._term = pty

    const prompt = 'a'.repeat(200)
    const completed = await session._writePtyTextThrottled(prompt)
    assert.equal(completed, true, 'throttled write completes')
    assert.equal(pty.visibleCharCount(), 200, 'all 200 chars seen by PTY')
    assert.equal(pty.visibleBody(), prompt, 'visible body round-trips verbatim')

    // The actual #4269 / #4273 fix relies on byte-arrival rate, not
    // mode 2004. Use the stricter "ignore mode" check so the assertion
    // proves the throttle itself defeats the heuristic.
    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(LOOSE_MS, LOOSE_CHARS),
      false,
      `throttled write should not match >=${LOOSE_CHARS} chars within ${LOOSE_MS}ms`,
    )
  })

  it('throttled 200-char prompt does NOT trip the paste heuristic (TIGHT)', async () => {
    const session = makeSession()
    const pty = new PasteHeuristicPtyStub()
    session._term = pty

    const prompt = 'b'.repeat(200)
    const completed = await session._writePtyTextThrottled(prompt)
    assert.equal(completed, true)

    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(TIGHT_MS, TIGHT_CHARS),
      false,
      `throttled write should not match >=${TIGHT_CHARS} chars within ${TIGHT_MS}ms`,
    )
  })

  // Discriminator: prove the stub actually flags a bulk write at the
  // SAME thresholds the throttle clears. If this test ever fails (and
  // the throttled-write tests pass), the stub is broken — the
  // assertions above would be passing trivially.
  it('bulk 200-char write DOES trip the paste heuristic at both thresholds (discriminator)', () => {
    const pty = new PasteHeuristicPtyStub()
    // Mimic the pre-fix code path: a single bulk write of the whole
    // prompt body (the bracketed-paste toggles are still there as
    // defense-in-depth, but we use the "ignore mode" check to model
    // real claude TUI's behavior).
    pty.write('\x1b[?2004l')
    pty.write('c'.repeat(200))
    pty.write('\r')
    pty.write('\x1b[?2004h')

    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(LOOSE_MS, LOOSE_CHARS),
      true,
      `bulk write of 200 chars MUST match >=${LOOSE_CHARS} chars within ${LOOSE_MS}ms`,
    )
    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(TIGHT_MS, TIGHT_CHARS),
      true,
      `bulk write of 200 chars MUST match >=${TIGHT_CHARS} chars within ${TIGHT_MS}ms`,
    )
  })

  // Cross-check: if a stub user pretends claude TUI honors the mode
  // toggle (the defense-in-depth path), even a bulk write inside the
  // disable/enable wrap is suppressed. This verifies the toggle code
  // path in the stub itself.
  it('with mode-2004 honored, even bulk write inside the wrap is suppressed', () => {
    const pty = new PasteHeuristicPtyStub()
    pty.write('\x1b[?2004l')
    pty.write('d'.repeat(200))
    pty.write('\r')
    pty.write('\x1b[?2004h')

    assert.equal(
      pty.simulatePasteHeuristic(LOOSE_MS, LOOSE_CHARS),
      false,
      'mode-2004 disable in the byte stream suppresses the heuristic',
    )
  })

  it('throttled multi-byte (emoji) prompt does NOT trip the heuristic', async () => {
    const session = makeSession()
    const pty = new PasteHeuristicPtyStub()
    session._term = pty

    // 100 emoji = 100 visible chars by iterator count, 400 UTF-16 code
    // units. The throttle iterates with `for..of`, so each emoji is
    // its own per-char write at PROMPT_CHAR_DELAY_MS intervals.
    const emoji = '\u{1F600}' // grinning face
    const prompt = emoji.repeat(100)
    const completed = await session._writePtyTextThrottled(prompt)
    assert.equal(completed, true)
    assert.equal(pty.visibleCharCount(), 100, 'each emoji counts as one char')
    assert.equal(pty.visibleBody(), prompt, 'emoji body round-trips intact')

    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(LOOSE_MS, LOOSE_CHARS),
      false,
      'emoji at typing speed should not look like a paste',
    )
  })

  it('abort-mid-loop: partial write does NOT trip the heuristic', async () => {
    const session = makeSession()
    const pty = new PasteHeuristicPtyStub()
    // Wrap the stub's write so we can flip the abort flag after a few
    // chars without otherwise altering its behavior.
    const realWrite = pty.write.bind(pty)
    let charsSeen = 0
    pty.write = (data) => {
      realWrite(data)
      // Only count single visible chars (the per-char loop writes);
      // control sequences and \r are length>1 or non-visible.
      if (data.length > 0 && data.charCodeAt(0) !== 0x1b && data !== '\r') {
        charsSeen += 1
        if (charsSeen === 10) session._activeTurn.aborted = true
      }
    }
    session._term = pty

    let onAbortCalled = false
    const completed = await session._writePtyTextThrottled('e'.repeat(200), {
      onAbort: () => { onAbortCalled = true },
    })

    assert.equal(completed, false, 'aborted mid-loop returns false')
    assert.equal(onAbortCalled, true, 'onAbort fired')
    // We saw 10 chars before aborting, then the finally re-enable.
    assert.equal(pty.visibleCharCount(), 10, 'only the chars before abort landed')
    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(LOOSE_MS, LOOSE_CHARS),
      false,
      'a 10-char partial write at typing speed is not a paste burst',
    )
    // Even at TIGHT thresholds (20 chars / 50ms) the partial write is
    // under the char-count floor, so this should also be false. This
    // pins the "abort never retroactively trips paste" invariant.
    assert.equal(
      pty.simulatePasteHeuristicIgnoringMode(TIGHT_MS, TIGHT_CHARS),
      false,
      'partial write below threshold-chars cannot match',
    )
  })
})
