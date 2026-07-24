/**
 * #6939 — client-side timeout for the git one-shot request/reply callbacks
 * (git_stage/git_unstage + git_commit + git_create_pr).
 *
 * GitPanel arms a one-shot callback (`_gitStageCallback` / `_gitCommitCallback` /
 * `_gitCreatePrCallback`) and flips a busy flag (stagingInProgress / committing /
 * prSubmitting) before sending the request. If the socket send succeeds but
 * the daemon never replies (mid-flight disconnect, crash), the callback would
 * stay armed and the button stuck spinning forever. The store now arms a
 * timer alongside the callback so a never-arriving reply resolves the
 * callback with a timeout error and lets the panel recover.
 *
 * #6954/#6955 — a mid-flight WS disconnect (onclose/onerror/disconnect()) now
 * ALSO fast-rejects any still-armed git one-shot callback immediately, rather
 * than leaving it to spin for up to the full client-side timeout: a dead
 * socket means the daemon can never reply. `disconnect()` is the directly
 * unit-testable entry point (onclose/onerror require a live mock WebSocket
 * mid-handshake) and drives the exact same shared `clearGitOneshotCallbacks`
 * helper the close/error paths use.
 *
 * These tests drive the REAL Zustand store (the timeout lives in the store setters),
 * with vitest fake timers, and model GitPanel's callback faithfully: it nulls itself
 * (which clears the store timer) and drops its busy flag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useConnectionStore,
  GIT_ONESHOT_CALLBACK_TIMEOUT_MS,
  GIT_ONESHOT_TIMEOUT_ERROR,
} from './connection';

// All three one-shot git flows share the arm-with-timeout mechanism (DRY), so
// the scenarios are parametrized over the stage + commit + create-PR
// setters/fields.
const FLOWS = [
  {
    label: 'git_stage',
    setCb: (cb: unknown) =>
      useConnectionStore.getState().setGitStageCallback(cb as never),
    getArmed: () => useConnectionStore.getState()._gitStageCallback,
    successReply: { error: null },
    // Shape a still-armed git_stage/git_unstage callback receives on timeout
    // (GitStageResult) — and, per #6954, on a mid-flight disconnect too.
    timeoutShape: { error: GIT_ONESHOT_TIMEOUT_ERROR },
  },
  {
    label: 'git_commit',
    setCb: (cb: unknown) =>
      useConnectionStore.getState().setGitCommitCallback(cb as never),
    getArmed: () => useConnectionStore.getState()._gitCommitCallback,
    successReply: { hash: 'abc123', message: 'feat: x', error: null },
    // Shape a still-armed git_commit callback receives on timeout (GitCommitResult).
    timeoutShape: { hash: null, message: null, error: GIT_ONESHOT_TIMEOUT_ERROR },
  },
  {
    label: 'git_create_pr',
    setCb: (cb: unknown) =>
      useConnectionStore.getState().setGitCreatePrCallback(cb as never),
    getArmed: () => useConnectionStore.getState()._gitCreatePrCallback,
    successReply: {
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      branch: 'feat/x',
      base: 'main',
      error: null,
    },
    // Shape a still-armed git_create_pr callback receives on timeout (GitCreatePrResult).
    timeoutShape: {
      url: null,
      number: null,
      branch: null,
      base: null,
      error: GIT_ONESHOT_TIMEOUT_ERROR,
    },
  },
] as const;

type Flow = (typeof FLOWS)[number];

// Faithful stand-in for GitPanel's one-shot callback: it nulls itself first
// (which clears the store timer), then drops its busy flag and records the
// result — the exact recovery path the panel relies on.
function armPanel(flow: Flow) {
  const rec = { busy: true, calls: [] as unknown[] };
  flow.setCb((result: unknown) => {
    flow.setCb(null);
    rec.busy = false;
    rec.calls.push(result);
  });
  return rec;
}

describe.each(FLOWS)('git one-shot callback timeout — $label (#6939)', (flow) => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Start from a clean slate (also clears any timer a prior test left armed).
    useConnectionStore.getState().setGitStageCallback(null);
    useConnectionStore.getState().setGitCommitCallback(null);
    useConnectionStore.getState().setGitCreatePrCallback(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  afterEach(() => {
    useConnectionStore.getState().setGitStageCallback(null);
    useConnectionStore.getState().setGitCommitCallback(null);
    useConnectionStore.getState().setGitCreatePrCallback(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('resolves the armed callback with a timeout error and clears busy when no reply arrives', () => {
    const rec = armPanel(flow);
    expect(flow.getArmed()).toBeTypeOf('function');
    expect(vi.getTimerCount()).toBe(1);

    // The daemon never replies; the deadline elapses.
    vi.advanceTimersByTime(GIT_ONESHOT_CALLBACK_TIMEOUT_MS);

    // Callback invoked exactly once with the timeout-error payload…
    expect(rec.calls).toEqual([flow.timeoutShape]);
    // …the busy flag is cleared (panel recovers)…
    expect(rec.busy).toBe(false);
    // …and the one-shot callback is disarmed.
    expect(flow.getArmed()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fire early — the callback stays armed right up to the deadline', () => {
    const rec = armPanel(flow);

    vi.advanceTimersByTime(GIT_ONESHOT_CALLBACK_TIMEOUT_MS - 1);
    expect(rec.calls).toHaveLength(0);
    expect(rec.busy).toBe(true);
    expect(flow.getArmed()).toBeTypeOf('function');

    vi.advanceTimersByTime(1);
    expect(rec.calls).toHaveLength(1);
    expect(rec.busy).toBe(false);
  });

  it('a real reply clears the timeout — no late timeout error fires', () => {
    const rec = armPanel(flow);

    // message-handler dispatch: read the armed callback and invoke it with the reply.
    flow.getArmed()!(flow.successReply as never);

    expect(rec.calls).toEqual([flow.successReply]);
    expect(rec.busy).toBe(false);
    expect(flow.getArmed()).toBeNull();
    // The pending timer must be cleared so it can't fire late.
    expect(vi.getTimerCount()).toBe(0);

    // Advancing well past the deadline must NOT re-invoke the callback.
    vi.advanceTimersByTime(GIT_ONESHOT_CALLBACK_TIMEOUT_MS * 2);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toEqual(flow.successReply);
  });

  it('the not-connected send-failure path clears the timeout', () => {
    const rec = armPanel(flow);
    expect(vi.getTimerCount()).toBe(1);

    // GitPanel's send-failure branch disarms the callback directly (requestGit*
    // returned false), then sets its own error + clears busy.
    flow.setCb(null);

    expect(flow.getArmed()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // No timer remains to fire a spurious timeout error.
    vi.advanceTimersByTime(GIT_ONESHOT_CALLBACK_TIMEOUT_MS * 2);
    expect(rec.calls).toHaveLength(0);
  });

  it('re-arming replaces the prior timer (no stale timeout from a superseded request)', () => {
    const first = armPanel(flow);
    // A second request arms a fresh callback before the first ever resolves.
    const second = armPanel(flow);
    // Only one timer is live — the first was cleared on re-arm.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(GIT_ONESHOT_CALLBACK_TIMEOUT_MS);

    // The stale first callback must NOT fire; only the current one times out.
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toEqual([flow.timeoutShape]);
  });

  // #6954 — a mid-flight WS disconnect must fast-reject a still-armed git
  // one-shot callback immediately, instead of leaving GitPanel's busy flag
  // spinning for up to the full 30s client-side timeout. `disconnect()`
  // shares the exact clearGitOneshotCallbacks() helper the socket
  // onclose/onerror handlers call, so exercising it here covers the same
  // fast-reject logic those transport-drop paths run.
  it('disconnect() fast-rejects the armed callback immediately and clears its timer (#6954)', () => {
    const rec = armPanel(flow);
    expect(flow.getArmed()).toBeTypeOf('function');
    expect(vi.getTimerCount()).toBe(1);

    useConnectionStore.getState().disconnect();

    // Fast-rejected synchronously — no need to advance the fake clock at all.
    expect(rec.calls).toEqual([flow.timeoutShape]);
    // …the busy flag is cleared (panel recovers) immediately…
    expect(rec.busy).toBe(false);
    // …and the one-shot callback is disarmed.
    expect(flow.getArmed()).toBeNull();
    // The pending 30s timer must be cleared — it can't fire a duplicate/late
    // reject after the fast-reject already resolved the callback.
    expect(vi.getTimerCount()).toBe(0);

    // Advancing well past the deadline must NOT re-invoke the callback.
    vi.advanceTimersByTime(GIT_ONESHOT_CALLBACK_TIMEOUT_MS * 2);
    expect(rec.calls).toHaveLength(1);
  });

  it('disconnect() is a no-op when no git one-shot callback is armed', () => {
    expect(flow.getArmed()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    expect(() => useConnectionStore.getState().disconnect()).not.toThrow();

    expect(flow.getArmed()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
