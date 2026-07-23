/**
 * #6774 — combined "approve plan + auto-accept edits" action tests.
 *
 * The whole reason this logic is centralised is the ordering guarantee: the
 * permission-mode switch must be dispatched BEFORE the approval (the server
 * drops a mid-turn mode change). These tests lock that contract in.
 */
import { describe, it, expect, vi } from 'vitest';
import { approvePlanWithAcceptEdits, ACCEPT_EDITS_MODE } from './plan-approval';

describe('approvePlanWithAcceptEdits (#6774)', () => {
  it('exposes acceptEdits as the target mode', () => {
    expect(ACCEPT_EDITS_MODE).toBe('acceptEdits');
  });

  it('calls BOTH setPermissionMode(acceptEdits) and approve', () => {
    const setPermissionMode = vi.fn();
    const approve = vi.fn();
    approvePlanWithAcceptEdits({ setPermissionMode, approve });
    expect(setPermissionMode).toHaveBeenCalledTimes(1);
    expect(setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('switches permission mode BEFORE approving (server rejects a mid-turn switch)', () => {
    const order: string[] = [];
    const setPermissionMode = vi.fn(() => order.push('setPermissionMode'));
    const approve = vi.fn(() => order.push('approve'));
    approvePlanWithAcceptEdits({ setPermissionMode, approve });
    expect(order).toEqual(['setPermissionMode', 'approve']);
  });

  it('order holds even when approve is the client-supplied approve handler', () => {
    // Simulate a client `approve` that, like the mobile handler, has its own
    // side effects (send + clear plan state). The mode switch must still land
    // first regardless of what approve does internally.
    const calls: string[] = [];
    const setPermissionMode = vi.fn((mode: string) => calls.push(`mode:${mode}`));
    const approve = vi.fn(() => {
      calls.push('send-approval');
      calls.push('clear-plan-state');
    });
    approvePlanWithAcceptEdits({ setPermissionMode, approve });
    expect(calls).toEqual(['mode:acceptEdits', 'send-approval', 'clear-plan-state']);
  });
});
