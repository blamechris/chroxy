/**
 * #6871 review (S1) — the bounded one-shot scheduler request registry.
 *
 * The point of this module is that no scheduler request can leave its UI state
 * stuck. Two failure modes have no correlated reply and so cannot be released by
 * any per-requestId branch:
 *   - the daemon never replies at all (crash, stall, mid-flight drop)
 *   - the rejection frame carries no requestId by construction
 *     (`INVALID_MESSAGE` for an over-cap message, `rate_limited`, a drain-drop)
 *
 * so the watchdog and the disconnect fast-reject are the only things standing
 * between those and a permanently disabled Refresh / "Saving…" button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  armSchedulerRequest,
  settleSchedulerRequest,
  failAllSchedulerRequests,
  hasPendingSchedulerRequests,
  resetSchedulerRequestsForTest,
  SCHEDULER_REQUEST_TIMEOUT_MS,
  SCHEDULER_TIMEOUT_ERROR,
} from './scheduledTaskRequests'

beforeEach(() => {
  resetSchedulerRequestsForTest()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  resetSchedulerRequestsForTest()
})

describe('scheduler request registry — the watchdog', () => {
  it('fails an unanswered request once the window elapses', () => {
    const onFail = vi.fn()
    armSchedulerRequest('sched-read-1', onFail)
    expect(onFail).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS - 1)
    expect(onFail).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onFail).toHaveBeenCalledWith(SCHEDULER_TIMEOUT_ERROR)
    expect(hasPendingSchedulerRequests()).toBe(false)
  })

  it('a settled request is NEVER failed later', () => {
    // The reply landed; the watchdog must not then clobber good state with a
    // spurious timeout error.
    const onFail = vi.fn()
    armSchedulerRequest('sched-read-1', onFail)
    settleSchedulerRequest('sched-read-1')
    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS * 2)
    expect(onFail).not.toHaveBeenCalled()
    expect(hasPendingSchedulerRequests()).toBe(false)
  })

  it('fires at most once', () => {
    const onFail = vi.fn()
    armSchedulerRequest('sched-read-1', onFail)
    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS)
    failAllSchedulerRequests('later disconnect')
    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS)
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('re-arming the same id does not leave a stale timer that fails the retry', () => {
    const first = vi.fn()
    const second = vi.fn()
    armSchedulerRequest('sched-read-1', first)
    armSchedulerRequest('sched-read-1', second)
    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('settling an unknown id is a harmless no-op', () => {
    expect(() => settleSchedulerRequest('never-armed')).not.toThrow()
    expect(() => settleSchedulerRequest(null)).not.toThrow()
    expect(() => settleSchedulerRequest(undefined)).not.toThrow()
  })
})

describe('scheduler request registry — the fast-reject', () => {
  it('fails every outstanding request with the given reason', () => {
    // A dead socket means no reply can ever arrive, so there is no reason to make
    // the operator wait out the full watchdog window.
    const read = vi.fn()
    const mutation = vi.fn()
    const gate = vi.fn()
    armSchedulerRequest('sched-read-1', read)
    armSchedulerRequest('sched-action-1', mutation)
    armSchedulerRequest('sched-gate-1', gate)

    failAllSchedulerRequests('socket closed')

    expect(read).toHaveBeenCalledWith('socket closed')
    expect(mutation).toHaveBeenCalledWith('socket closed')
    expect(gate).toHaveBeenCalledWith('socket closed')
    expect(hasPendingSchedulerRequests()).toBe(false)
  })

  it('clears the watchdogs it fails, so none fire afterwards', () => {
    const onFail = vi.fn()
    armSchedulerRequest('sched-read-1', onFail)
    failAllSchedulerRequests('socket closed')
    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS * 2)
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('does not sweep a retry armed from within a failure callback', () => {
    // A failure handler is allowed to immediately re-request; that new request
    // must survive the loop that triggered it.
    const retry = vi.fn()
    armSchedulerRequest('sched-read-1', () => armSchedulerRequest('sched-read-2', retry))
    failAllSchedulerRequests('socket closed')
    expect(hasPendingSchedulerRequests()).toBe(true)
    vi.advanceTimersByTime(SCHEDULER_REQUEST_TIMEOUT_MS)
    expect(retry).toHaveBeenCalledWith(SCHEDULER_TIMEOUT_ERROR)
  })

  it('is a no-op when nothing is outstanding', () => {
    expect(() => failAllSchedulerRequests('socket closed')).not.toThrow()
    expect(hasPendingSchedulerRequests()).toBe(false)
  })
})
