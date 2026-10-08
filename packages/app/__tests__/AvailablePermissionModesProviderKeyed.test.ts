/**
 * #8224 — the mobile permission-mode roster follows the ACTIVE session's
 * provider, including the moment a freshly created session becomes active.
 *
 * Which modes a provider can honour differs (claude-tui has no plan mode,
 * claude-sdk does), and the app kept one flat `availablePermissionModes` list
 * that the server refreshed only on `switch_session`. A session created while a
 * claude-tui one was active therefore showed "Plan (unavailable)" for as long as
 * the tab was not re-selected. This drives the REAL dispatch path with the
 * server's frame sequence for a create (`session_switched`, then the
 * provider-tagged `available_permission_modes`, then `session_list`) and reads
 * the roster through `selectActivePermissionModes` — the SAME selector
 * `SessionScreen` subscribes to.
 */

jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  useNotificationStore: { getState: jest.fn(() => ({ addNotification: jest.fn(), dismissNotification: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/conversations', () => ({
  useConversationStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { selectActivePermissionModes } from '../src/store/connection';
import { handleMessage, setStore, setConnectionContext } from '../src/store/message-handler';
import type { ConnectionState } from '../src/store/types';

const mode = (id: string, label: string, supported = true) => ({
  id, label, supported, enforcement: supported ? 'chroxy' : 'unsupported',
});
const TUI_ROSTER = [
  mode('approve', 'Approve'),
  mode('auto', 'Auto'),
  mode('plan', 'Plan (unavailable)', false),
];
const SDK_ROSTER = [
  mode('approve', 'Approve'),
  mode('auto', 'Auto'),
  mode('plan', 'Plan'),
];
const TUI_SESSION = { sessionId: 'tui-1', name: 'tui', provider: 'claude-tui' };
const SDK_SESSION = { sessionId: 'sdk-1', name: 'sdk', provider: 'claude-sdk' };

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
}

const mockCtx = { url: 'wss://t', token: 'tok', socket: {} as WebSocket, isReconnect: false };

describe('mobile permission-mode roster follows the active session (#8224)', () => {
  let store: ReturnType<typeof createMockStore>;
  const send = (msg: Record<string, unknown>) => handleMessage(msg as never, mockCtx as never);
  const planOf = () => selectActivePermissionModes(store.getState()).find((m) => m.id === 'plan');

  beforeEach(() => {
    store = createMockStore({
      activeSessionId: null,
      sessions: [],
      sessionStates: {},
      modelsByProvider: {},
      permissionModesByProvider: {},
      appendTerminalData: jest.fn(),
      fetchSlashCommands: jest.fn(),
      fetchCustomAgents: jest.fn(),
    } as unknown as Partial<ConnectionState>);
    setStore(store as never);
    setConnectionContext(mockCtx as never);
    // Connect with a claude-tui session active.
    send({ type: 'session_list', sessions: [TUI_SESSION] });
    send({ type: 'session_switched', sessionId: 'tui-1', name: 'tui', cwd: '/w' });
    send({ type: 'available_permission_modes', modes: TUI_ROSTER, provider: 'claude-tui' });
  });

  it('control: with claude-tui active, Plan is unavailable', () => {
    expect(store.getState().activeSessionId).toBe('tui-1');
    expect(planOf()?.supported).toBe(false);
  });

  it('a create-and-auto-switch to claude-sdk offers Plan', () => {
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' });
    send({ type: 'available_permission_modes', modes: SDK_ROSTER, provider: 'claude-sdk' });
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] });

    expect(store.getState().activeSessionId).toBe('sdk-1');
    expect(planOf()?.supported).toBe(true);
    expect(planOf()?.label).toBe('Plan');
  });

  it('never serves the previous session\'s roster while the new one\'s has not arrived', () => {
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' });
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] });

    expect(planOf()).toBeUndefined();
  });

  it('the reverse switch removes it again', () => {
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' });
    send({ type: 'available_permission_modes', modes: SDK_ROSTER, provider: 'claude-sdk' });
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] });
    expect(planOf()?.supported).toBe(true);

    send({ type: 'session_switched', sessionId: 'tui-1', name: 'tui', cwd: '/w' });
    expect(planOf()?.supported).toBe(false);
  });

  it('a daemon from before #8224 (untagged roster, provider named in session_list) still gets its picker', () => {
    store.setState({ permissionModesByProvider: {}, sessions: [], activeSessionId: null } as never);
    send({ type: 'session_list', sessions: [SDK_SESSION] });
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' });
    send({ type: 'available_permission_modes', modes: SDK_ROSTER });

    expect(store.getState().activeSessionId).toBe('sdk-1');
    expect(planOf()?.supported).toBe(true);
  });
});
