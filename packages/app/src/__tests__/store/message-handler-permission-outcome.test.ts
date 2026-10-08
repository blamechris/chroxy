/**
 * #8348 -- a permission prompt's outcome survives a session switch / reload on
 * the mobile app.
 *
 * `permission_request` / `_resolved` / `_expired` are transient on the server, so
 * a full-rebuild replay swapped in a transcript with no trace of a prompt that had
 * already expired or been answered. The server now records a `permission_outcome`
 * history entry and the replay delivers it; the shared store-core dispatch table
 * turns it into a compact record. Driven through the app's real `handleMessage`.
 */
import {
  _testMessageHandler,
  setStore,
  _testResetStore,
  resetReplayFlags,
} from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import { derivePendingPermissionCounts, resetReplayReconcile } from '@chroxy/store-core';
import type { ChatMessage, ConnectionState } from '../../store/types';

jest.mock('../../store/persistence', () => ({
  clearPersistedSession: jest.fn(() => Promise.resolve()),
  persistSessionMessages: jest.fn(),
  persistViewMode: jest.fn(),
  persistActiveSession: jest.fn(),
  persistTerminalBuffer: jest.fn(),
  loadPersistedState: jest.fn(),
  loadSessionMessages: jest.fn(),
  clearPersistedState: jest.fn(),
  _resetForTesting: jest.fn(),
}));

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState;
  return {
    getState: () => state,
    setState: (updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof updater === 'function' ? updater(state) : updater) };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

const SID = 's1';
const REQ = 'req-1';

function livePrompt(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-live', type: 'prompt', content: 'Bash: rm -rf build', tool: 'Bash', requestId: REQ,
    expiresAt: Date.now() + 300_000, timestamp: 1,
    options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
    ...over,
  } as ChatMessage;
}

const outcomeFrame = (over: Record<string, unknown> = {}) => ({
  type: 'permission_outcome', sessionId: SID, requestId: REQ, tool: 'Bash',
  description: 'rm -rf build', outcome: 'expired', historySeq: 3, ...over,
});

function boot(messages: ChatMessage[]) {
  const store = createMockStore({
    activeSessionId: SID,
    sessions: [{ sessionId: SID, name: 'S1' } as any],
    sessionStates: { [SID]: { ...createEmptySessionState(), messages } },
    sessionNotifications: [],
    serverErrors: [],
  } as Partial<ConnectionState>);
  setStore(store as any);
  _testMessageHandler.setContext(createMockConnectionContext());
  const read = () => store.getState().sessionStates[SID]!.messages;
  return { store, read, send: (m: Record<string, unknown>) => _testMessageHandler.handle(m) };
}

function fullRebuild(send: (m: Record<string, unknown>) => void, entries: Array<Record<string, unknown>>) {
  send({ type: 'history_replay_start', sessionId: SID, fullHistory: true, truncated: false, latestSeq: 9 });
  for (const e of entries) send(e);
  send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 });
}

const userEntry = { type: 'message', messageType: 'user_input', content: 'run the cleanup', timestamp: 1, sessionId: SID, historySeq: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  resetReplayReconcile({ clearCursors: true });
});
afterEach(() => {
  resetReplayFlags();
  _testResetStore();
  _testMessageHandler.setContext(null as never);
});

describe('permission_outcome on the mobile app (#8348)', () => {
  it('THE BUG: an expired prompt is still in the transcript after a session switch', () => {
    const { read, send } = boot([livePrompt({ options: undefined, expiresAt: Date.now() - 1000 })]);
    fullRebuild(send, [userEntry, outcomeFrame()]);
    const prompts = read().filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ requestId: REQ, tool: 'Bash', content: 'Bash: rm -rf build', permissionOutcome: 'expired' });
  });

  it('an answered prompt is still in the transcript, labelled with its decision', () => {
    const { read, send } = boot([livePrompt({ options: undefined, answered: 'deny', answeredAt: 5 })]);
    fullRebuild(send, [userEntry, outcomeFrame({ outcome: 'denied' })]);
    const prompts = read().filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ permissionOutcome: 'denied', answered: 'deny' });
  });

  it('never resurrects a pending card', () => {
    const { read, send, store } = boot([livePrompt()]);
    fullRebuild(send, [userEntry, outcomeFrame()]);
    expect(derivePendingPermissionCounts(store.getState().sessionStates as any, Date.now())).toEqual({});
    expect(read().every((m) => !m.expiresAt)).toBe(true);
  });

  it('a delta replay collapses onto the live card the client held (no duplicate)', () => {
    const held = livePrompt({ options: undefined, answered: 'allow', answeredAt: 5 });
    const { read, send } = boot([held]);
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 });
    send(outcomeFrame({ outcome: 'allowed' }));
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 });
    const prompts = read().filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ id: held.id, answered: 'allow', permissionOutcome: 'allowed' });
  });

  it('a stale permission_request for a recorded outcome does not turn the record into a pending card', () => {
    const { read, send, store } = boot([]);
    fullRebuild(send, [outcomeFrame()]);
    const before = read();
    send({ type: 'permission_request', sessionId: SID, requestId: REQ, tool: 'Bash', description: 'rm -rf build', remainingMs: 120_000 });
    expect(read()).toBe(before);
    expect(derivePendingPermissionCounts(store.getState().sessionStates as any, Date.now())).toEqual({});
  });

  it('a stale permission_request after an outcome merged into a LIVE card does not make it actionable', () => {
    const { read, send, store } = boot([livePrompt()]);
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 });
    send(outcomeFrame());
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 });
    const merged = read().filter((m) => m.type === 'prompt');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'perm-live', permissionOutcome: 'expired' });
    expect(merged[0]!.options).toBeUndefined();

    send({ type: 'permission_request', sessionId: SID, requestId: REQ, tool: 'Bash', description: 'rm -rf build', remainingMs: 120_000 });

    expect(read().filter((m) => m.type === 'prompt')[0]).toBe(merged[0]);
    expect(derivePendingPermissionCounts(store.getState().sessionStates as any, Date.now())).toEqual({});
  });

  it('relabels a card an SDK timeout stamped denied when the replay says the prompt expired', () => {
    const { read, send } = boot([livePrompt({ options: undefined, answered: 'deny', answeredAt: 5, expiresAt: Date.now() - 1000 })]);
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 });
    send(outcomeFrame());
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 });
    const [card] = read().filter((m) => m.type === 'prompt');
    expect(card).toMatchObject({ permissionOutcome: 'expired' });
    expect(card!.answered).toBeUndefined();
  });

  it('a locally expired card accepts an authoritative allowed', () => {
    const { read, send } = boot([livePrompt({ options: undefined, expiresAt: Date.now() - 1000 })]);
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 });
    send(outcomeFrame({ outcome: 'allowed' }));
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 });
    expect(read().filter((m) => m.type === 'prompt')[0]).toMatchObject({ permissionOutcome: 'allowed', answered: 'allow' });
  });

  it('POSITIVE CONTROL: a permission_request for a prompt with no recorded outcome still raises a pending card', () => {
    const { read, send } = boot([]);
    send({ type: 'permission_request', sessionId: SID, requestId: 'req-fresh', tool: 'Bash', description: 'ls', remainingMs: 120_000 });
    const prompts = read().filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.expiresAt).toBeGreaterThan(Date.now());
  });
});

// #8374 -- Stop resolves a pending claude-sdk prompt as a deny with reason
// 'aborted'. The card must read stopped, live and after a replay; a real Deny
// must keep reading Denied.
describe('a Stop-cancelled permission prompt (#8374)', () => {
  const resolvedFrame = (over: Record<string, unknown> = {}) => ({
    type: 'permission_resolved', sessionId: SID, requestId: REQ, decision: 'deny', ...over,
  });

  it('live: permission_resolved with reason "aborted" makes the card a stopped record, not an answered deny', () => {
    const { read, send, store } = boot([livePrompt()]);
    send(resolvedFrame({ reason: 'aborted' }));
    const [card] = read().filter((m) => m.type === 'prompt');
    expect(card).toMatchObject({ id: 'perm-live', permissionOutcome: 'stopped' });
    expect(card!.answered).toBeUndefined();
    expect(card!.options).toBeUndefined();
    expect(derivePendingPermissionCounts(store.getState().sessionStates as any, Date.now() + 1)).toEqual({});
  });

  it('CONTROL: a user Deny stays an answered deny with no outcome record', () => {
    const { read, send } = boot([livePrompt()]);
    send(resolvedFrame({ reason: 'user' }));
    const [card] = read().filter((m) => m.type === 'prompt');
    expect(card).toMatchObject({ answered: 'deny' });
    expect(card!.permissionOutcome).toBeUndefined();
  });

  it('a switch/reload replays the same card: the stopped outcome collapses onto the stopped card', () => {
    const { read, send } = boot([livePrompt()]);
    send(resolvedFrame({ reason: 'aborted' }));
    const before = read().filter((m) => m.type === 'prompt')[0];
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq: 9 });
    send(outcomeFrame({ outcome: 'stopped' }));
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 9 });
    const prompts = read().filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ permissionOutcome: 'stopped' });
    expect(prompts[0]!.answered).toBeUndefined();
    expect(prompts[0]).toBe(before);
  });

  it('a full rebuild builds the stopped record from history alone', () => {
    const { read, send } = boot([]);
    fullRebuild(send, [outcomeFrame({ outcome: 'stopped' })]);
    const prompts = read().filter((m) => m.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ requestId: REQ, permissionOutcome: 'stopped', content: 'Bash: rm -rf build' });
    expect(prompts[0]!.answered).toBeUndefined();
  });
});
