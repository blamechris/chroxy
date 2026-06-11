/**
 * #5518 — round-trip tests for the dual-endpoint connection record in
 * SecureStore. `saveConnection`/`loadConnection` must persist the optional LAN
 * candidate (`lanUrl`/`lanVerified`/`tunnelUrl`) alongside the legacy url+token
 * keys, stay backward-compatible with records that predate the LAN fields, and
 * never resurrect a half-written blob.
 */

// In-memory SecureStore so the persistence helpers hit a real key/value store.
jest.mock('expo-secure-store', () => {
  const mem: Record<string, string> = {};
  return {
    __mem: mem,
    getItemAsync: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      mem[k] = v;
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      delete mem[k];
    }),
  };
});

import * as SecureStore from 'expo-secure-store';
import { saveConnection, loadConnection } from '../../store/message-handler';

const mem = (SecureStore as unknown as { __mem: Record<string, string> }).__mem;

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
});

describe('saveConnection / loadConnection — dual-endpoint (#5518)', () => {
  it('round-trips a plain url+token (legacy shape)', async () => {
    await saveConnection('wss://x.com', 'tok');
    expect(await loadConnection()).toEqual({ url: 'wss://x.com', token: 'tok' });
  });

  it('persists and restores the LAN candidate fields', async () => {
    await saveConnection('wss://x.com', 'tok', {
      lanUrl: 'ws://192.168.1.5:8765',
      lanVerified: true,
      tunnelUrl: 'wss://x.com',
    });
    expect(await loadConnection()).toEqual({
      url: 'wss://x.com',
      token: 'tok',
      lanUrl: 'ws://192.168.1.5:8765',
      lanVerified: true,
      tunnelUrl: 'wss://x.com',
    });
  });

  it('omits LAN fields when none are saved', async () => {
    await saveConnection('wss://x.com', 'tok');
    const loaded = await loadConnection();
    expect(loaded).not.toHaveProperty('lanUrl');
    expect(loaded).not.toHaveProperty('lanVerified');
  });

  it('clears stale LAN metadata when a later save omits it', async () => {
    await saveConnection('wss://x.com', 'tok', { lanUrl: 'ws://10.0.0.2:8765', lanVerified: true });
    await saveConnection('wss://y.com', 'tok2'); // new server, no LAN
    const loaded = await loadConnection();
    expect(loaded).toEqual({ url: 'wss://y.com', token: 'tok2' });
  });

  it('returns null when no connection is stored', async () => {
    expect(await loadConnection()).toBeNull();
  });
});
