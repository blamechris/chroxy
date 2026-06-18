/**
 * Tests for at-rest persistence-cache encryption (#5644).
 *
 * Uses an in-memory expo-secure-store mock so the cache key round-trips through
 * a fake keychain. expo-crypto's real PRNG works under jest-expo.
 */
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
import {
  encryptForStorage,
  decryptForStorage,
  _resetKeyCacheForTesting,
  PERSIST_CACHE_SECURE_STORE_KEY,
} from '../../store/persist-crypto';

type MockedStore = typeof SecureStore & { __mem: Record<string, string> };
const store = SecureStore as unknown as MockedStore;

beforeEach(() => {
  for (const k of Object.keys(store.__mem)) delete store.__mem[k];
  _resetKeyCacheForTesting();
  jest.clearAllMocks();
  // Restore the in-memory implementations — clearAllMocks wipes call data but
  // NOT implementations, so a prior test's mockRejectedValue would persist.
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (k: string) =>
    k in store.__mem ? store.__mem[k] : null,
  );
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (k: string, v: string) => {
    store.__mem[k] = v;
  });
});

describe('persist-crypto', () => {
  it('round-trips: encrypt then decrypt returns the original', async () => {
    const original = JSON.stringify({ secret: 'sk-abc123', text: 'hello world' });
    const blob = await encryptForStorage(original);
    // Envelope is versioned and does NOT contain the plaintext.
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob).not.toContain('sk-abc123');
    expect(blob).not.toContain('hello world');

    const out = await decryptForStorage(blob);
    expect(out).toBe(original);
  });

  it('generates the cache key on first use and stores it under a dedicated SecureStore key', async () => {
    expect(PERSIST_CACHE_SECURE_STORE_KEY).toBe('chroxy_persist_cache_key');
    expect(store.__mem[PERSIST_CACHE_SECURE_STORE_KEY]).toBeUndefined();
    await encryptForStorage('x');
    expect(store.__mem[PERSIST_CACHE_SECURE_STORE_KEY]).toBeDefined();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      PERSIST_CACHE_SECURE_STORE_KEY,
      expect.any(String),
    );
  });

  it('does not collide with bearer-token / device-id keys', () => {
    expect(PERSIST_CACHE_SECURE_STORE_KEY).not.toBe('chroxy_last_token');
    expect(PERSIST_CACHE_SECURE_STORE_KEY).not.toBe('chroxy_device_id');
    expect(PERSIST_CACHE_SECURE_STORE_KEY).not.toBe('chroxy_last_url');
  });

  it('persists the key across loads — a second cold load reuses it and decrypts prior data', async () => {
    const blob = await encryptForStorage('persisted-secret');
    const keyAfterWrite = store.__mem[PERSIST_CACHE_SECURE_STORE_KEY];

    // Simulate an app restart: drop the in-memory key cache but keep the
    // keychain entry (as a real device would).
    _resetKeyCacheForTesting();

    const out = await decryptForStorage(blob);
    expect(out).toBe('persisted-secret');
    // Key was reused, not regenerated.
    expect(store.__mem[PERSIST_CACHE_SECURE_STORE_KEY]).toBe(keyAfterWrite);
  });

  it('treats a legacy plaintext value as absent (returns null, never throws)', async () => {
    // A value written before this change — raw JSON, no v1: prefix.
    const legacy = JSON.stringify([{ id: '1', content: 'old message' }]);
    await expect(decryptForStorage(legacy)).resolves.toBeNull();
  });

  it('returns null for null/empty/garbage input without throwing', async () => {
    await expect(decryptForStorage(null)).resolves.toBeNull();
    await expect(decryptForStorage(undefined)).resolves.toBeNull();
    await expect(decryptForStorage('')).resolves.toBeNull();
    await expect(decryptForStorage('v1:not-base64-!!!')).resolves.toBeNull();
    await expect(decryptForStorage('v1:')).resolves.toBeNull();
  });

  it('returns null when the key was rotated (cannot decrypt old blob with new key)', async () => {
    const blob = await encryptForStorage('top secret');
    // Rotate: wipe keychain + cache so a fresh key is generated on next use.
    delete store.__mem[PERSIST_CACHE_SECURE_STORE_KEY];
    _resetKeyCacheForTesting();

    const out = await decryptForStorage(blob);
    expect(out).toBeNull(); // MAC failure under the new key → graceful null
  });

  it('detects tampering (flipped ciphertext byte → null)', async () => {
    const blob = await encryptForStorage('integrity-protected');
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(decryptForStorage(tampered)).resolves.toBeNull();
  });

  it('throws on encrypt when the key cannot be loaded or created (disabled path)', async () => {
    // Both read and write of the keychain fail → no usable key.
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValue(new Error('keychain down'));
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValue(new Error('keychain down'));
    _resetKeyCacheForTesting();
    await expect(encryptForStorage('data')).rejects.toThrow('encryption key unavailable');
  });

  it('decrypt is safe (returns null) when the key cannot be loaded or created', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValue(new Error('keychain down'));
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValue(new Error('keychain down'));
    _resetKeyCacheForTesting();
    await expect(decryptForStorage('v1:AAAA')).resolves.toBeNull();
  });

  it('regenerates a fresh key when the stored key is corrupt (wrong length)', async () => {
    store.__mem[PERSIST_CACHE_SECURE_STORE_KEY] = 'dG9vc2hvcnQ='; // "tooshort", != 32 bytes
    _resetKeyCacheForTesting();
    // Should not throw; should overwrite with a valid 32-byte key and round-trip.
    const blob = await encryptForStorage('recovered');
    const out = await decryptForStorage(blob);
    expect(out).toBe('recovered');
  });
});
