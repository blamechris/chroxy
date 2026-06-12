/**
 * #5555 (sub-item 7) — the app applies a rotated tunnel URL.
 *
 * Quick-tunnel recovery rotates the public URL. The server pushes it live
 * (`tunnel_url_changed`) and re-advertises it on every reconnect (the
 * `auth_bootstrap` burst's `tunnelUrl`). The app repoints the SecureStore-backed
 * `SavedConnection.tunnelUrl` so the next reconnect dials the working endpoint
 * instead of hammering the dead one — and the fix survives an app restart.
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
import { applyRotatedTunnelUrl, loadConnection } from '../../store/message-handler';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

const mem = (SecureStore as unknown as { __mem: Record<string, string> }).__mem;

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  useConnectionLifecycleStore.getState().reset();
  // reset() does not clear savedConnection — null it explicitly per test.
  useConnectionLifecycleStore.getState().setSavedConnection(null);
});

describe('applyRotatedTunnelUrl (#5555 sub-item 7)', () => {
  it('repoints tunnelUrl and the canonical url for a tunnel-only record', () => {
    useConnectionLifecycleStore.getState().setSavedConnection({
      url: 'wss://old.trycloudflare.com',
      token: 'tok',
      tunnelUrl: 'wss://old.trycloudflare.com',
    });

    const changed = applyRotatedTunnelUrl('wss://new.trycloudflare.com');

    expect(changed).toBe(true);
    const saved = useConnectionLifecycleStore.getState().savedConnection;
    expect(saved?.tunnelUrl).toBe('wss://new.trycloudflare.com');
    // url was the old tunnel endpoint, so it follows the rotation.
    expect(saved?.url).toBe('wss://new.trycloudflare.com');
  });

  it('updates tunnelUrl but PRESERVES a verified ws:// LAN url', () => {
    useConnectionLifecycleStore.getState().setSavedConnection({
      url: 'ws://192.168.1.5:8765',
      token: 'tok',
      lanUrl: 'ws://192.168.1.5:8765',
      lanVerified: true,
      tunnelUrl: 'wss://old.trycloudflare.com',
    });

    const changed = applyRotatedTunnelUrl('wss://new.trycloudflare.com');

    expect(changed).toBe(true);
    const saved = useConnectionLifecycleStore.getState().savedConnection;
    expect(saved?.tunnelUrl).toBe('wss://new.trycloudflare.com');
    // The ws:// LAN url is the canonical dial target and must NOT be clobbered.
    expect(saved?.url).toBe('ws://192.168.1.5:8765');
    expect(saved?.lanVerified).toBe(true);
  });

  it('persists the rotation to SecureStore (survives an app restart)', async () => {
    useConnectionLifecycleStore.getState().setSavedConnection({
      url: 'wss://old.trycloudflare.com',
      token: 'tok',
      tunnelUrl: 'wss://old.trycloudflare.com',
    });

    applyRotatedTunnelUrl('wss://new.trycloudflare.com');
    // Flush the fire-and-forget saveConnection microtask.
    await Promise.resolve();
    await Promise.resolve();

    const reloaded = await loadConnection();
    expect(reloaded?.tunnelUrl).toBe('wss://new.trycloudflare.com');
    expect(reloaded?.url).toBe('wss://new.trycloudflare.com');
  });

  it('is a no-op when there is no saved connection', () => {
    expect(applyRotatedTunnelUrl('wss://new.trycloudflare.com')).toBe(false);
    expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
  });

  it('is a no-op (idempotent) when the URL is unchanged', () => {
    useConnectionLifecycleStore.getState().setSavedConnection({
      url: 'ws://192.168.1.5:8765',
      token: 'tok',
      tunnelUrl: 'wss://same.trycloudflare.com',
    });
    expect(applyRotatedTunnelUrl('wss://same.trycloudflare.com')).toBe(false);
  });

  it('rejects a non-wss URL defensively', () => {
    useConnectionLifecycleStore.getState().setSavedConnection({
      url: 'wss://old.trycloudflare.com',
      token: 'tok',
      tunnelUrl: 'wss://old.trycloudflare.com',
    });
    expect(applyRotatedTunnelUrl('ws://192.168.1.9:8765')).toBe(false);
    expect(useConnectionLifecycleStore.getState().savedConnection?.tunnelUrl).toBe(
      'wss://old.trycloudflare.com',
    );
  });
});
