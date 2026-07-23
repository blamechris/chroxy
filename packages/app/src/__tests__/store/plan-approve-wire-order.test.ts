/**
 * #6895 — client-level wire-ordering guard for the combined "approve plan +
 * auto-accept edits" action (follow-up from the #6893 / #6774 review).
 *
 * `packages/store-core/src/plan-approval.test.ts` pins the SHARED HELPER's
 * call order, but with `setPermissionMode`/`approve` replaced by plain mock
 * functions — it proves `approvePlanWithAcceptEdits` invokes them in the
 * right order, but says nothing about what either call actually puts on the
 * wire, or when. The real guarantee (documented in `plan-approval.ts` and
 * `SessionScreen.tsx`'s `handleApprovePlanAcceptEdits`) is that the mobile
 * app's REAL `setPermissionMode` action sends the `set_permission_mode`
 * frame SYNCHRONOUSLY before `sendInput(...)` sends the `input` frame —
 * because the server drops a mid-turn permission-mode change once the
 * implementation turn has started (`PERMISSION_MODE_NOT_APPLIED`).
 *
 * This test wires the combined action to the store's REAL setPermissionMode,
 * addUserMessage, sendInput and clearPlanState (mirroring SessionScreen.tsx's
 * `handleApprovePlanAcceptEdits` / `handleApprovePlan` exactly — including
 * the client-generated `clientMessageId` that production passes to BOTH
 * `addUserMessage` and `sendInput` so the optimistic bubble and the wire
 * frame correlate, per #2902), with a socket stub that records frames in
 * send order, and asserts `set_permission_mode` lands strictly before the
 * approve `input` frame. If a future refactor of either action deferred its
 * `wsSend` call behind a microtask/await, this test — unlike the store-core
 * helper test — would catch the reordering, because it observes the actual
 * wire, not just the order the two functions were called in.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticWarning: jest.fn(),
  hapticSuccess: jest.fn(),
}));

import { approvePlanWithAcceptEdits } from '@chroxy/store-core';
import { useConnectionStore, createEmptySessionState, nextMessageId } from '../../store/connection';
import type { SessionState } from '../../store/types';

interface FakeSocket {
  readyState: number;
  send: jest.Mock;
}

const OPEN = 1; // WebSocket.OPEN

/** Healthy OPEN socket that records sent frames in order (mirrors #6308's liveSocket). */
function liveSocket(sent: Array<Record<string, unknown>>): FakeSocket {
  return {
    readyState: OPEN,
    send: jest.fn((raw: string) => {
      try {
        sent.push(JSON.parse(raw));
      } catch {
        /* noop */
      }
    }),
  };
}

describe('#6895 — app combined plan-approve+acceptEdits wire order', () => {
  it('sends set_permission_mode(acceptEdits) strictly before the approve input frame', () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket = liveSocket(sent);
    const sessionId = 'sess-plan-1';
    useConnectionStore.setState({
      activeSessionId: sessionId,
      sessions: [{ sessionId, name: sessionId, provider: 'claude-sdk' }],
      sessionStates: {
        [sessionId]: {
          ...createEmptySessionState(),
          permissionMode: 'plan',
          isPlanPending: true,
        } as unknown as SessionState,
      },
      socket,
    } as never);

    const { setPermissionMode, addUserMessage, sendInput, clearPlanState } = useConnectionStore.getState();
    // Mirrors SessionScreen.tsx's handleApprovePlan exactly: a client-generated
    // clientMessageId passed to BOTH addUserMessage (local-only, no wire
    // effect) and sendInput (which puts it on the `input` frame so the
    // optimistic bubble and server history record correlate, #2902), then
    // clearPlanState (local-only).
    const approve = (): void => {
      const clientMessageId = nextMessageId('user');
      addUserMessage('Go ahead with the plan', undefined, { clientMessageId });
      sendInput('Go ahead with the plan', undefined, { clientMessageId });
      clearPlanState();
    };

    approvePlanWithAcceptEdits({ setPermissionMode, approve });

    // Strict order: exactly two frames, mode change first.
    expect(sent.map((f) => f.type)).toEqual(['set_permission_mode', 'input']);
    expect(sent[0]).toMatchObject({ type: 'set_permission_mode', mode: 'acceptEdits' });
    // Defensive: the input frame should carry the same clientMessageId
    // production correlates against (not the core assertion above, but
    // guards against a regression that drops it from the wire payload).
    expect(sent[1]).toMatchObject({
      type: 'input',
      data: 'Go ahead with the plan',
      clientMessageId: expect.any(String),
    });
  });
});
