/** #8188: real mobile handler → store → Default chip notes, without a daemon. */
import React, { act } from 'react';
import renderer from 'react-test-renderer';
import { DEFAULT_PROVIDER } from '@chroxy/protocol';
import { CreateSessionModal } from '../CreateSessionModal';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { handleMessage } from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import type { ProviderInfo } from '../../store/types';

jest.mock('../FolderBrowser', () => ({ FolderBrowser: () => null }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('test-device')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

const providers: ProviderInfo[] = [
  { name: 'claude-sdk', capabilities: { planMode: true, streaming: true, modelSwitch: true } },
  { name: 'claude-tui', capabilities: { planMode: false, streaming: false, modelSwitch: false } },
];
const ctx = createMockConnectionContext();
let component: renderer.ReactTestRenderer | undefined;

function receive(type: 'provider_list' | 'auth_bootstrap', extra: Record<string, unknown> = {}) {
  act(() => handleMessage({ type, providers, slashCommands: [], agents: [], ...extra }, ctx));
}
function openModal() {
  act(() => { component = renderer.create(<CreateSessionModal visible onClose={jest.fn()} />); });
}
function note() {
  const nodes = component!.root.findAllByProps({ testID: 'provider-limitation-note' });
  return nodes.length ? nodes[0].props.children : null;
}
function press(label: string) {
  act(() => component!.root.findByProps({ accessibilityLabel: label }).props.onPress());
}

beforeEach(() => {
  jest.useFakeTimers();
  useConnectionStore.getState().disconnect();
  useConnectionStore.setState({ sessions: [], activeSessionId: null, sessionStates: {} });
});
afterEach(() => {
  act(() => { component?.unmount(); });
  component = undefined;
  useConnectionStore.getState().disconnect();
});

describe.each(['provider_list', 'auth_bootstrap'] as const)('%s server default notes', (type) => {
  it('uses the advertised provider, updates live, and keeps explicit selection separate', () => {
    // The cached issue predates #8276. Use a DIFFERENT advertised provider so
    // the original baked-in claude-sdk fallback genuinely fails this test.
    expect(DEFAULT_PROVIDER).toBe('claude-sdk');
    receive(type, { defaultProvider: 'claude-tui' });
    openModal();
    expect(note()).toBe("This provider doesn't support plan mode, streaming, and model switching.");
    press('Provider: Claude Code (SDK)');
    expect(note()).toBeNull();
    receive(type, { defaultProvider: 'claude-sdk' });
    press('Provider: Default');
    expect(note()).toBeNull();
    receive(type, { defaultProvider: 'claude-tui' });
    expect(note()).toContain('plan mode');
  });

  it.each([undefined, null, '', '   ', 42, {}, []])('falls back for an older or invalid advertisement %p', (value) => {
    receive(type, { defaultProvider: value });
    openModal();
    expect(note()).toBeNull();
  });

  it('does not infer fallback capabilities for an unknown advertised provider', () => {
    receive(type, { providers: providers.map((p) => ({ ...p, capabilities: { planMode: false } })), defaultProvider: 'future-provider' });
    openModal();
    expect(note()).toBeNull();
  });

  it('retains a valid advertisement when a later same-connection list omits it', () => {
    receive(type, { defaultProvider: 'claude-tui' });
    receive(type);
    openModal();
    expect(note()).toContain('plan mode');
  });
});

it('Default creation still omits provider and explicit creation still forwards it', () => {
  receive('auth_bootstrap', { defaultProvider: 'claude-tui' });
  const send = jest.fn();
  useConnectionStore.setState({ socket: { readyState: WebSocket.OPEN, send, close: jest.fn() } as unknown as WebSocket });
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  openModal();
  press('Create session');
  let creates = send.mock.calls.map(([data]) => JSON.parse(data)).filter((m) => m.type === 'create_session');
  expect(creates).toHaveLength(1);
  expect(creates[0]).not.toHaveProperty('provider');
  expect(creates[0]).not.toHaveProperty('connectionId');
  press('Provider: Claude Code (SDK)');
  press('Create session');
  creates = send.mock.calls.map(([data]) => JSON.parse(data)).filter((m) => m.type === 'create_session');
  expect(creates).toHaveLength(2);
  expect(creates[1].provider).toBe('claude-sdk');
});

// Exercise production connect/drop/disconnect boundaries using ONLY inert
// transports. No fetch, real socket, daemon, auth, or session is started.
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = jest.fn();
  close = jest.fn();
  constructor(_url: string) { FakeSocket.instances.push(this); }
}
const originalWebSocket = global.WebSocket;
const originalFetch = global.fetch;

async function connect(url = 'wss://daemon-a.example.test') {
  act(() => useConnectionStore.getState().connect(url, 'fixture-only', {
    silent: true, healthPrecheck: { ts: Date.now(), status: 'ok' },
  }));
  await act(async () => {
    await new Promise<void>((resolve) => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));
  });
  return FakeSocket.instances[FakeSocket.instances.length - 1];
}
function socketReceive(socket: FakeSocket, defaultProvider?: string) {
  act(() => socket.onmessage?.({ data: JSON.stringify({
    type: 'provider_list', providers, ...(defaultProvider ? { defaultProvider } : {}),
  }) }));
}

describe('connection-scoped default metadata', () => {
  beforeEach(() => {
    global.WebSocket = FakeSocket as unknown as typeof WebSocket;
    global.fetch = jest.fn(() => { throw new Error('Unexpected network request'); });
    FakeSocket.instances = [];
    useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected', wsUrl: null, savedConnection: null });
  });
  afterEach(() => {
    act(() => useConnectionStore.getState().disconnect());
    global.WebSocket = originalWebSocket;
    global.fetch = originalFetch;
  });

  it.each(['wss://daemon-a.example.test', 'wss://daemon-b.example.test'])('clears on direct reconnect/server switch to %s', async (url) => {
    const a = await connect();
    socketReceive(a, 'claude-tui');
    openModal();
    expect(note()).toContain('plan mode');
    useConnectionLifecycleStore.setState({ wsUrl: 'wss://daemon-a.example.test', connectionPhase: 'connected' });
    const lateA = a.onmessage!;
    const b = await connect(url);
    expect(note()).toBeNull();
    expect(useConnectionStore.getState().serverDefaultProvider).toBeNull();
    socketReceive(b); // Older daemon must not inherit A's advertised default.
    expect(note()).toBeNull();
    act(() => lateA({ data: JSON.stringify({ type: 'provider_list', providers, defaultProvider: 'claude-tui' }) }));
    expect(note()).toBeNull();
    socketReceive(b, 'claude-tui');
    expect(note()).toContain('plan mode');
  });

  it.each(['close', 'error'] as const)('clears immediately on transport %s before reconnect', async (event) => {
    const socket = await connect();
    socketReceive(socket, 'claude-tui');
    openModal();
    expect(note()).toContain('plan mode');
    act(() => {
      if (event === 'close') socket.onclose?.({ code: 1000, reason: '' });
      else socket.onerror?.({ message: 'fixture drop' });
    });
    expect(useConnectionStore.getState().serverDefaultProvider).toBeNull();
    expect(note()).toBeNull();
  });

  it('clears on explicit disconnect, then falls back on a fresh older daemon', async () => {
    const a = await connect();
    socketReceive(a, 'claude-tui');
    act(() => useConnectionStore.getState().disconnect());
    expect(useConnectionStore.getState().serverDefaultProvider).toBeNull();
    const b = await connect('wss://daemon-b.example.test');
    socketReceive(b);
    openModal();
    expect(note()).toBeNull();
  });
});
