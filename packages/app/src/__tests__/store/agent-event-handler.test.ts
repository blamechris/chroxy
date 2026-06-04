/**
 * agent_event handler tests — #5060
 *
 * Verifies the mobile message-handler's `case 'agent_event':` routes
 * through the SHARED `handleAgentEvent` builder from @chroxy/store-core
 * (the same one the dashboard uses), appending each child wire event to
 * the parent Task tool_use bubble's `childAgentEvents[]`. Also pins the
 * same-reference no-op idiom: an event whose parentToolUseId matches no
 * bubble must not mutate (and must not churn) the messages array.
 */
import {
  _testMessageHandler,
  setStore,
} from '../../store/message-handler';
import { createEmptySessionState } from '../../store/utils';
import type { ConnectionState } from '../../store/types';
import type { ChatMessage } from '../../store/connection';

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
    setState: (
      updater:
        | Partial<ConnectionState>
        | ((s: ConnectionState) => Partial<ConnectionState>),
    ) => {
      state = typeof updater === 'function'
        ? { ...state, ...updater(state) }
        : { ...state, ...updater };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

function createMockContext() {
  return {
    socket: { readyState: 1, send: jest.fn() } as any,
    serverUrl: 'wss://test.example.com',
    apiToken: 'test-token',
    connectionId: 'test-conn-1',
    reconnecting: false,
    connectedAt: Date.now(),
    isSessionSwitchReplay: false,
    activeSessionIdAtConnect: null,
  };
}

function taskBubble(toolUseId: string): ChatMessage {
  return {
    id: `m-${toolUseId}`,
    type: 'tool_use',
    sender: 'assistant',
    content: 'Task',
    tool: 'Task',
    toolUseId,
    timestamp: Date.now(),
  } as ChatMessage;
}

function storeWithTask(toolUseId: string) {
  const ss = createEmptySessionState();
  ss.messages = [taskBubble(toolUseId)];
  return createMockStore({
    activeSessionId: 's1',
    sessions: [{ sessionId: 's1', name: 'S1' } as any],
    sessionStates: { s1: ss },
  });
}

describe('agent_event handler (#5060)', () => {
  it('appends a child wire event to the parent Task bubble childAgentEvents[]', () => {
    const store = storeWithTask('parent-1');
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'agent_event',
      sessionId: 's1',
      parentToolUseId: 'parent-1',
      eventType: 'tool_start',
      payload: { toolUseId: 'child-1', tool: 'Read', input: { file_path: '/a' } },
    });

    const msgs = store.getState().sessionStates.s1.messages;
    const parent = msgs.find((m) => m.toolUseId === 'parent-1')!;
    expect(parent.childAgentEvents).toHaveLength(1);
    expect(parent.childAgentEvents![0]!.type).toBe('tool_start');
    expect(parent.childAgentEvents![0]!.payload.toolUseId).toBe('child-1');
  });

  it('accumulates multiple events in arrival order', () => {
    const store = storeWithTask('parent-2');
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'agent_event',
      sessionId: 's1',
      parentToolUseId: 'parent-2',
      eventType: 'tool_start',
      payload: { toolUseId: 'c1', tool: 'Read' },
    });
    _testMessageHandler.handle({
      type: 'agent_event',
      sessionId: 's1',
      parentToolUseId: 'parent-2',
      eventType: 'tool_result',
      payload: { toolUseId: 'c1', result: 'ok' },
    });

    const parent = store
      .getState()
      .sessionStates.s1.messages.find((m) => m.toolUseId === 'parent-2')!;
    expect(parent.childAgentEvents).toHaveLength(2);
    expect(parent.childAgentEvents!.map((e) => e.type)).toEqual([
      'tool_start',
      'tool_result',
    ]);
  });

  it('same-reference no-op when parentToolUseId matches no bubble', () => {
    const store = storeWithTask('parent-3');
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);
    const before = store.getState().sessionStates.s1.messages;

    _testMessageHandler.handle({
      type: 'agent_event',
      sessionId: 's1',
      parentToolUseId: 'does-not-exist',
      eventType: 'tool_start',
      payload: { toolUseId: 'cZ', tool: 'Read' },
    });

    // No matching bubble → builder returns the same array reference → no
    // churn, and the parent bubble stays free of childAgentEvents.
    const after = store.getState().sessionStates.s1.messages;
    expect(after).toBe(before);
    expect(after[0]!.childAgentEvents).toBeUndefined();
  });
});
