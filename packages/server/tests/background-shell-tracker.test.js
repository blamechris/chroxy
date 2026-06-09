// #5376: standalone unit tests for BackgroundShellTracker — the collaborator
// extracted from BaseSession. These exercise the sweep / advisory-quiesce /
// hard-quiesce logic in isolation (the payoff of the extraction), with an
// injected emit callback and injected quiesce checks so no filesystem or real
// timer is touched. The session-level delegation contract stays pinned by
// background-shells.test.js.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BackgroundShellTracker,
  BACKGROUND_SHELL_SWEEP_MS,
  BACKGROUND_SHELL_QUIESCE_MS,
  BACKGROUND_SHELL_HARD_QUIESCE_MS,
} from '../src/background-shell-tracker.js'

function makeTracker(opts = {}) {
  const events = []
  const tracker = new BackgroundShellTracker({
    emit: (event, payload) => events.push({ event, payload }),
    ...opts,
  })
  return { tracker, events }
}

describe('BackgroundShellTracker — construction', () => {
  it('requires an emit callback', () => {
    assert.throws(() => new BackgroundShellTracker({}), /requires an emit callback/)
    assert.throws(() => new BackgroundShellTracker({ emit: 'nope' }), /requires an emit callback/)
  })

  it('defaults the windows to the module constants', () => {
    const { tracker } = makeTracker()
    assert.equal(tracker._backgroundShellSweepMs, BACKGROUND_SHELL_SWEEP_MS)
    assert.equal(tracker._backgroundShellQuiesceMs, BACKGROUND_SHELL_QUIESCE_MS)
    assert.equal(tracker._backgroundShellHardQuiesceMs, BACKGROUND_SHELL_HARD_QUIESCE_MS)
  })

  it('honours an explicit hardQuiesceMs of 0 (disable) via ??', () => {
    const { tracker } = makeTracker({ hardQuiesceMs: 0 })
    assert.equal(tracker._backgroundShellHardQuiesceMs, 0)
  })

  it('starts empty (size 0, no sweep timer)', () => {
    const { tracker } = makeTracker()
    assert.equal(tracker.size, 0)
    assert.equal(tracker._backgroundShellSweepTimer, null)
  })
})

describe('BackgroundShellTracker — track / clear', () => {
  it('track adds an entry, emits, and arms the sweep', () => {
    const { tracker, events } = makeTracker()
    const added = tracker.trackBackgroundShell({ shellId: 'a', command: 'sleep 1', outputPath: '/tmp/x' })
    assert.equal(added, true)
    assert.equal(tracker.size, 1)
    assert.ok(tracker._backgroundShellSweepTimer, 'sweep timer armed once work is pending')
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'background_work_changed')
    assert.deepEqual(events[0].payload.pending, [{ shellId: 'a', startedAt: events[0].payload.pending[0].startedAt, command: 'sleep 1' }])
  })

  it('track is idempotent on shellId (no bump, no second emit)', () => {
    const { tracker, events } = makeTracker()
    tracker.trackBackgroundShell({ shellId: 'a', command: 'first' })
    const startedAt = tracker._pendingBackgroundShells.get('a').startedAt
    const again = tracker.trackBackgroundShell({ shellId: 'a', command: 'second' })
    assert.equal(again, false)
    assert.equal(tracker.size, 1)
    assert.equal(tracker._pendingBackgroundShells.get('a').command, 'first', 'original command preserved')
    assert.equal(tracker._pendingBackgroundShells.get('a').startedAt, startedAt, 'startedAt not bumped')
    assert.equal(events.length, 1, 'no second emit for a no-op')
  })

  it('track rejects an empty / non-string shellId', () => {
    const { tracker } = makeTracker()
    assert.equal(tracker.trackBackgroundShell({ shellId: '' }), false)
    assert.equal(tracker.trackBackgroundShell({}), false)
    assert.equal(tracker.size, 0)
  })

  it('clear removes a tracked entry, emits, and stops the sweep when drained', () => {
    const { tracker, events } = makeTracker()
    tracker.trackBackgroundShell({ shellId: 'a' })
    const cleared = tracker.clearBackgroundShell('a')
    assert.equal(cleared, true)
    assert.equal(tracker.size, 0)
    assert.equal(tracker._backgroundShellSweepTimer, null, 'sweep stopped once the last shell drains')
    assert.equal(events.length, 2)
  })

  it('clear of an unknown id is a no-op (no emit)', () => {
    const { tracker, events } = makeTracker()
    assert.equal(tracker.clearBackgroundShell('nope'), false)
    assert.equal(events.length, 0)
  })
})

describe('BackgroundShellTracker — getPendingBackgroundShells wire shape', () => {
  it('projects to { shellId, startedAt, command } and omits outputPath', () => {
    const { tracker } = makeTracker()
    tracker.trackBackgroundShell({ shellId: 'a', command: 'run', outputPath: '/secret/path' })
    const snap = tracker.getPendingBackgroundShells()
    assert.equal(snap.length, 1)
    assert.deepEqual(Object.keys(snap[0]).sort(), ['command', 'shellId', 'startedAt'])
    assert.equal(snap[0].command, 'run')
  })

  it('drops advisory-quiesced shells from the snapshot but keeps them in the map', () => {
    const { tracker } = makeTracker()
    tracker.trackBackgroundShell({ shellId: 'a' })
    tracker._pendingBackgroundShells.get('a').quiesced = true
    assert.deepEqual(tracker.getPendingBackgroundShells(), [], 'quiesced shell drops from the banner')
    assert.equal(tracker.size, 1, 'but stays in the map so liveness is unaffected')
  })
})

describe('BackgroundShellTracker — sweep / advisory quiesce (#5247)', () => {
  it('marks a quiesced shell advisory (flag set, NOT removed), and emits once', () => {
    const { tracker, events } = makeTracker({ hardQuiesceMs: 0 }) // advisory-only
    tracker.trackBackgroundShell({ shellId: 'a', outputPath: '/tmp/a' })
    events.length = 0
    tracker._backgroundShellQuiesceCheck = () => true
    tracker._sweepQuiescedBackgroundShells()
    assert.equal(tracker.size, 1, 'advisory quiesce does NOT remove the shell')
    assert.equal(tracker._pendingBackgroundShells.get('a').quiesced, true)
    assert.equal(events.length, 1, 'one background_work_changed for the banner clear')
    assert.equal(events[0].payload.pending.length, 0)
  })

  it('advisory-only: stops the sweep once nothing can advisory-transition', () => {
    const { tracker } = makeTracker({ hardQuiesceMs: 0 })
    tracker.trackBackgroundShell({ shellId: 'a', outputPath: '/tmp/a' })
    tracker._backgroundShellQuiesceCheck = () => true
    tracker._sweepQuiescedBackgroundShells()
    assert.equal(tracker._backgroundShellSweepTimer, null, 'no active shells left to transition → sweep stops')
  })

  it('a non-quiesced shell keeps the sweep running (advisory-only)', () => {
    const { tracker } = makeTracker({ hardQuiesceMs: 0 })
    tracker.trackBackgroundShell({ shellId: 'a', outputPath: '/tmp/a' })
    tracker._backgroundShellQuiesceCheck = () => false
    tracker._sweepQuiescedBackgroundShells()
    assert.ok(tracker._backgroundShellSweepTimer, 'still-active shell keeps the sweep armed')
  })
})

describe('BackgroundShellTracker — hard quiesce reap (#5265)', () => {
  it('reaps a hard-quiesced shell (removes it → size drops → liveness flips)', () => {
    const { tracker } = makeTracker()
    tracker.trackBackgroundShell({ shellId: 'a', outputPath: '/tmp/a' })
    tracker._backgroundShellHardQuiesceCheck = () => true
    tracker._sweepQuiescedBackgroundShells()
    assert.equal(tracker.size, 0, 'hard-quiesced shell is reaped from the map')
    assert.equal(tracker._backgroundShellSweepTimer, null, 'sweep stops once drained')
  })

  it('hard-quiesce disabled (0) never reaps even if the check would say true', () => {
    const { tracker } = makeTracker({ hardQuiesceMs: 0 })
    tracker.trackBackgroundShell({ shellId: 'a', outputPath: '/tmp/a' })
    tracker._backgroundShellHardQuiesceCheck = () => true // would reap if enabled
    tracker._sweepQuiescedBackgroundShells()
    assert.equal(tracker.size, 1, 'disabled hard-quiesce leaves the shell pinned')
  })

  it('_isBackgroundShellHardQuiesced short-circuits false when disabled', () => {
    const { tracker } = makeTracker({ hardQuiesceMs: 0 })
    tracker._backgroundShellHardQuiesceCheck = () => true
    assert.equal(tracker._isBackgroundShellHardQuiesced({ shellId: 'a', startedAt: 0 }), false)
  })
})

describe('BackgroundShellTracker — destroy', () => {
  it('stops the sweep and clears the pending map', () => {
    const { tracker } = makeTracker()
    tracker.trackBackgroundShell({ shellId: 'a' })
    tracker.trackBackgroundShell({ shellId: 'b' })
    assert.equal(tracker.size, 2)
    tracker.destroy()
    assert.equal(tracker.size, 0)
    assert.equal(tracker._backgroundShellSweepTimer, null)
  })
})
