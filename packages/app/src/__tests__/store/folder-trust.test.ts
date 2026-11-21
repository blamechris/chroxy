/**
 * Per-folder trust of project settings, mobile store side: the two server frames,
 * the `error` envelope a refused change arrives in, the two send actions, and the
 * sweeps that settle a request whose socket is gone.
 */
import { Alert } from 'react-native';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { FOLDER_TRUST_FALLBACK_ERROR } from '@chroxy/store-core';
import { useConnectionStore, __resetDeviceIdCacheForTests, createEmptySessionState } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { _testMessageHandler, resetReconnectAttempt, setStore } from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import type { SessionState } from '../../store/types';

const DIGEST = 'b'.repeat(64);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

function summary() {
  return {
    files: [{ path: '.mcp.json' }],
    mcpServers: [{ file: '.mcp.json', name: 'srv', command: 'npx', args: ['-y', 'x'] }],
    hooks: [], statusLine: [], enabledPlugins: [],
    counts: { agents: 0, skills: 0, commands: 0 }, warnings: [],
    hasCommandBearingFiles: true, untrustable: false,
  };
}
const untrustedFrame = (sessionId: string, digest = DIGEST) => ({
  type: 'folder_trust_state', sessionId, status: 'untrusted', appliesFrom: 'next_turn', summary: summary(), digest,
});

interface FakeSocket {
  readyState: number;
  onclose: ((event?: unknown) => void) | null;
  onopen: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  send: jest.Mock;
  close: jest.Mock;
}
function installMockWebSocket(): { instances: FakeSocket[]; restore: () => void } {
  const instances: FakeSocket[] = [];
  const Original = global.WebSocket;
  // @ts-expect-error — mock WebSocket constructor
  global.WebSocket = class MockWebSocket {
    static OPEN = 1;
    readyState = 0;
    onopen = null; onclose = null; onerror = null; onmessage = null;
    send = jest.fn();
    close = jest.fn();
    constructor() { instances.push(this as unknown as FakeSocket); }
  };
  return { instances, restore: () => { global.WebSocket = Original; } };
}
function flushPromises(): Promise<void> {
  return new Promise((resolve) => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));
}

let ws: ReturnType<typeof installMockWebSocket>;
let socket: FakeSocket;
const originalFetch = global.fetch;

async function openSocket(): Promise<void> {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok' }), text: () => Promise.resolve('{}') }) as never;
  useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
  await flushPromises();
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  socket = ws.instances[ws.instances.length - 1]!;
  socket.readyState = 1;
  useConnectionStore.setState({ socket: socket as unknown as WebSocket });
}

function seed(sessions: Record<string, Partial<SessionState>>): void {
  const sessionStates: Record<string, SessionState> = {};
  for (const [id, over] of Object.entries(sessions)) sessionStates[id] = { ...createEmptySessionState(), ...over };
  useConnectionStore.setState({ sessionStates, activeSessionId: Object.keys(sessions)[0] ?? null });
}
const session = (id: string): SessionState => useConnectionStore.getState().sessionStates[id]!;
const handle = (msg: Record<string, unknown>) => _testMessageHandler.handle(msg);
const lastSent = () => JSON.parse(socket.send.mock.calls[socket.send.mock.calls.length - 1]![0] as string) as Record<string, unknown>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearAllCallbacks();
  __resetDeviceIdCacheForTests();
  resetReconnectAttempt();
  jest.spyOn(Math, 'random').mockReturnValue(0);
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('dev-id-123');
  ws = installMockWebSocket();
  useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, socket: null, serverErrors: [] });
  useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected', connectionError: null, connectionRetryCount: 0, wsUrl: null });
  setStore(useConnectionStore as never);
  _testMessageHandler.setContext(createMockConnectionContext());
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  (Math.random as unknown as jest.SpyInstance).mockRestore?.();
  ws.restore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

describe('folder_trust_state', () => {
  it('stores the entry on its session without the type and session id', () => {
    seed({ s1: {} });
    handle(untrustedFrame('s1'));
    expect(session('s1').folderTrust).toEqual({ status: 'untrusted', appliesFrom: 'next_turn', summary: summary(), digest: DIGEST });
  });

  it('replaces the entry wholesale (a later frame without a summary drops it)', () => {
    seed({ s1: {} });
    handle(untrustedFrame('s1'));
    handle({ type: 'folder_trust_state', sessionId: 's1', status: 'trusted', appliesFrom: 'restart' });
    expect(session('s1').folderTrust).toEqual({ status: 'trusted', appliesFrom: 'restart' });
  });

  it('only touches the session it names', () => {
    seed({ s1: {}, s2: {} });
    handle(untrustedFrame('s2'));
    expect(session('s1').folderTrust).toBeNull();
    expect(session('s2').folderTrust).not.toBeNull();
  });

  it('drops a frame for a session this client does not know (the daemon re-sends on subscribe/switch)', () => {
    seed({ s1: {} });
    handle(untrustedFrame('ghost'));
    expect(Object.keys(useConnectionStore.getState().sessionStates)).toEqual(['s1']);
    expect(session('s1').folderTrust).toBeNull();
    // ...and once the session exists, the re-sent frame lands.
    seed({ s1: {}, ghost: {} });
    handle(untrustedFrame('ghost'));
    expect(session('ghost').folderTrust?.status).toBe('untrusted');
  });

  it('ignores a frame without a usable session id', () => {
    seed({ s1: {} });
    const before = useConnectionStore.getState().sessionStates;
    handle({ type: 'folder_trust_state', sessionId: '', status: 'trusted', appliesFrom: 'next_turn' });
    expect(useConnectionStore.getState().sessionStates).toBe(before);
  });
});

describe('folder_trust_result', () => {
  it('a success clears the marker and the last error', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1', folderTrustError: 'old' } });
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted', requestId: 'r1' });
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s1').folderTrustError).toBeNull();
  });

  it('a failure clears the marker and keeps the reason', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: false, status: 'untrusted', requestId: 'r1', error: 'nope' });
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s1').folderTrustError).toBe('nope');
  });

  it('a failure without a reason records the fallback text', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: false, status: 'untrusted', requestId: 'r1' });
    expect(session('s1').folderTrustError).toBe(FOLDER_TRUST_FALLBACK_ERROR);
  });

  it('is matched by requestId, so it never settles a newer request of the same session', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r2' } });
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted', requestId: 'r1' });
    expect(session('s1').folderTrustPendingRequestId).toBe('r2');
  });

  it('settles the session that owns the requestId, whichever session the frame names', () => {
    seed({ s1: {}, s2: { folderTrustPendingRequestId: 'r9' } });
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: false, status: 'untrusted', requestId: 'r9', error: 'x' });
    expect(session('s2').folderTrustPendingRequestId).toBeNull();
    expect(session('s2').folderTrustError).toBe('x');
    expect(session('s1').folderTrustError).toBeNull();
  });

  it('a reply without a requestId settles the session it names', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted' });
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
  });
});

describe('error envelope for a refused trust change', () => {
  it('settles the request it carries, shows the reason on that session, and raises no alert', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'error', code: 'FOLDER_TRUST_FORBIDDEN', message: 'Only the owner can do that', requestId: 'r1' });
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s1').folderTrustError).toBe('Only the owner can do that');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('settles on a request match whatever the code', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'error', code: 'INVALID_MESSAGE', message: 'bad frame', requestId: 'r1' });
    expect(session('s1').folderTrustError).toBe('bad frame');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a FOLDER_TRUST_ code that names a session lands on it even without a request match', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'error', code: 'FOLDER_TRUST_CHANGED', message: 'changed', sessionId: 's1' });
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s1').folderTrustError).toBe('changed');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('an unrelated error keeps the generic alert and leaves trust state alone', () => {
    seed({ s1: { folderTrustPendingRequestId: 'r1' } });
    handle({ type: 'error', code: 'SOMETHING_ELSE', message: 'boom', sessionId: 's1', requestId: 'other' });
    expect(session('s1').folderTrustPendingRequestId).toBe('r1');
    expect(session('s1').folderTrustError).toBeNull();
    expect(alertSpy).toHaveBeenCalledWith('Server Error', 'boom');
  });

  it('a trust error for a session this client does not know still raises the alert', () => {
    seed({ s1: {} });
    handle({ type: 'error', code: 'FOLDER_TRUST_FORBIDDEN', message: 'no', sessionId: 'ghost' });
    expect(alertSpy).toHaveBeenCalledWith('Server Error', 'no');
  });
});

describe('trustFolder / untrustFolder', () => {
  it('trustFolder sends the reviewed digest with a requestId and marks the session in flight', async () => {
    await openSocket();
    seed({ s1: { folderTrustError: 'old' } });
    expect(useConnectionStore.getState().trustFolder('s1', DIGEST)).toBe(true);
    const sent = lastSent();
    expect(sent).toMatchObject({ type: 'trust_folder', sessionId: 's1', digest: DIGEST });
    expect(typeof sent.requestId).toBe('string');
    expect(session('s1').folderTrustPendingRequestId).toBe(sent.requestId);
    expect(session('s1').folderTrustError).toBeNull();
  });

  it('untrustFolder sends no digest', async () => {
    await openSocket();
    seed({ s1: {} });
    expect(useConnectionStore.getState().untrustFolder('s1')).toBe(true);
    const sent = lastSent();
    expect(sent.type).toBe('untrust_folder');
    expect(sent).not.toHaveProperty('digest');
    expect(session('s1').folderTrustPendingRequestId).toBe(sent.requestId);
  });

  it('the reply settles the marker the send set (round trip)', async () => {
    await openSocket();
    seed({ s1: {} });
    useConnectionStore.getState().trustFolder('s1', DIGEST);
    const requestId = lastSent().requestId as string;
    handle({ type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted', requestId });
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
  });

  it('refuses while a change for that session is already in flight', async () => {
    await openSocket();
    seed({ s1: {}, s2: {} });
    expect(useConnectionStore.getState().trustFolder('s1', DIGEST)).toBe(true);
    const sends = socket.send.mock.calls.length;
    expect(useConnectionStore.getState().untrustFolder('s1')).toBe(false);
    expect(socket.send.mock.calls.length).toBe(sends);
    // ...but another session is independent.
    expect(useConnectionStore.getState().untrustFolder('s2')).toBe(true);
  });

  it('refuses when the socket is not open', async () => {
    await openSocket();
    seed({ s1: {} });
    socket.readyState = 3;
    expect(useConnectionStore.getState().trustFolder('s1', DIGEST)).toBe(false);
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    useConnectionStore.setState({ socket: null });
    expect(useConnectionStore.getState().untrustFolder('s1')).toBe(false);
  });

  it('does not mark the session in flight when the frame did not go out', async () => {
    await openSocket();
    seed({ s1: { folderTrustError: 'old' } });
    socket.send.mockImplementation(() => { throw new Error('closing'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(useConnectionStore.getState().trustFolder('s1', DIGEST)).toBe(false);
    warn.mockRestore();
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s1').folderTrustError).toBe('old');
  });

  it('refuses a trust request with no digest, an unknown session, or an empty id', async () => {
    await openSocket();
    seed({ s1: {} });
    expect(useConnectionStore.getState().trustFolder('s1', '')).toBe(false);
    expect(useConnectionStore.getState().trustFolder('ghost', DIGEST)).toBe(false);
    expect(useConnectionStore.getState().untrustFolder('')).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('a request in flight does not outlive its socket', () => {
  it('a transport drop settles every session\'s marker but keeps the entry and the error', async () => {
    await openSocket();
    seed({
      s1: { folderTrustPendingRequestId: 'r1', folderTrust: { status: 'untrusted', appliesFrom: 'next_turn' }, folderTrustError: 'why' },
      s2: { folderTrustPendingRequestId: 'r2' },
    });
    socket.onclose?.({ code: 1006 });
    await flushPromises();
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s2').folderTrustPendingRequestId).toBeNull();
    expect(session('s1').folderTrust).toEqual({ status: 'untrusted', appliesFrom: 'next_turn' });
    expect(session('s1').folderTrustError).toBe('why');
  });

  it('a user disconnect() settles them too (it nulls socket.onclose)', async () => {
    await openSocket();
    seed({ s1: { folderTrustPendingRequestId: 'r1' }, s2: { folderTrustPendingRequestId: 'r2' } });
    useConnectionStore.getState().disconnect();
    expect(session('s1').folderTrustPendingRequestId).toBeNull();
    expect(session('s2').folderTrustPendingRequestId).toBeNull();
  });

  it('control: without a drop the marker stays (the sweep is not clearing it unconditionally)', async () => {
    await openSocket();
    seed({ s1: {} });
    useConnectionStore.getState().trustFolder('s1', DIGEST);
    await flushPromises();
    expect(session('s1').folderTrustPendingRequestId).not.toBeNull();
  });
});

describe('session removal', () => {
  const listEntry = (sessionId: string) => ({
    sessionId, name: sessionId, cwd: '/tmp', type: 'cli', hasTerminal: false, model: null,
    permissionMode: null, isBusy: false, createdAt: 0,
  });

  it('trust state lives on the session, so a session dropped from session_list takes it along', () => {
    seed({ s1: {}, s2: {} });
    handle(untrustedFrame('s2'));
    expect(session('s2').folderTrust).not.toBeNull();
    handle({ type: 'session_list', sessions: [listEntry('s1')] });
    expect(Object.keys(useConnectionStore.getState().sessionStates)).toEqual(['s1']);
    // A frame for the removed session is not resurrected...
    handle(untrustedFrame('s2'));
    expect(Object.keys(useConnectionStore.getState().sessionStates)).toEqual(['s1']);
    // ...and a session that comes back under the same id starts with nothing.
    handle({ type: 'session_list', sessions: [listEntry('s1'), listEntry('s2')] });
    expect(session('s2').folderTrust).toBeNull();
    expect(session('s2').folderTrustPendingRequestId).toBeNull();
  });

  it('forgetSession() drops every session\'s trust state', () => {
    seed({ s1: { folderTrust: { status: 'trusted', appliesFrom: 'next_turn' }, folderTrustPendingRequestId: 'r1', folderTrustError: 'x' } });
    useConnectionStore.getState().forgetSession();
    expect(useConnectionStore.getState().sessionStates).toEqual({});
  });

  it('a session that times out takes its trust state along', () => {
    seed({ s1: {}, s2: {} });
    handle(untrustedFrame('s2'));
    handle({ type: 'session_timeout', sessionId: 's2', name: 's2', idleMs: 1 });
    expect(Object.keys(useConnectionStore.getState().sessionStates)).toEqual(['s1']);
  });
});
