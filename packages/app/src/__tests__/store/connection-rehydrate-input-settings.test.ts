/**
 * #4872 — Tests for `loadSavedConnection`'s SecureStore-backed
 * `inputSettings` rehydrate path in `packages/app/src/store/connection.ts`.
 *
 * Mirrors the dashboard coverage shipped with #4853 / #4858 (which migrated
 * the localStorage rehydrate path to the shared `isVoiceInputMode` guard).
 * The mobile rehydrate path used to spread the SecureStore blob in
 * unchecked, gated only on `chatEnterToSend` / `terminalEnterToSend` being
 * booleans, so a stale or tampered `voiceInputMode` (`'push-to-talk'`,
 * `null`, `42`) flowed through to `useSpeechRecognition({ mode })`.
 *
 * These tests pin the new guarded behaviour: known modes round-trip,
 * unknown / non-string / object values drop on rehydrate, and the existing
 * boolean toggles continue to be gated by `typeof === 'boolean'`.
 *
 * jest.mock() is hoisted above imports, so the SecureStore + AsyncStorage
 * + persistence mocks here apply for every test below — the store under
 * test then sees a fully in-memory SecureStore, no native module touched.
 */

// SecureStore mock — tests overwrite `getItemAsync`'s resolved value to
// drive each scenario. `setItemAsync` / `deleteItemAsync` are stubs so the
// store's persist path doesn't throw if exercised incidentally.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Persistence is async + debounced — stub the load helpers so the rehydrate
// path under test isn't entangled with session-state / session-list
// loading, both of which have their own dedicated test files.
jest.mock('../../store/persistence', () => ({
  loadPersistedState: jest.fn().mockResolvedValue({}),
  loadSessionMessages: jest.fn().mockResolvedValue([]),
  loadSessionList: jest.fn().mockResolvedValue([]),
  loadAllSessionMessages: jest.fn().mockResolvedValue({}),
  persistSessionMessages: jest.fn(),
  persistViewMode: jest.fn().mockResolvedValue(undefined),
  persistActiveSession: jest.fn().mockResolvedValue(undefined),
  persistTerminalBuffer: jest.fn(),
  persistSessionList: jest.fn(),
  clearPersistedState: jest.fn().mockResolvedValue(undefined),
}));

import * as SecureStore from 'expo-secure-store';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

const STORAGE_KEY_INPUT_SETTINGS = 'chroxy_input_settings';

const DEFAULT_INPUT_SETTINGS = {
  chatEnterToSend: true,
  terminalEnterToSend: false,
  voiceInputMode: 'continuous' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the rehydrate slice we care about back to defaults so each test
  // starts from a known baseline.
  useConnectionStore.setState({ inputSettings: { ...DEFAULT_INPUT_SETTINGS } });
  useConnectionLifecycleStore.setState({
    savedConnection: null,
  });
  // Default: SecureStore returns null for every key (no persisted blob).
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
});

/**
 * Wire the SecureStore mock so that the `chroxy_input_settings` key
 * returns the given serialized blob and every other key returns `null`
 * (default). Lets each test focus on a single rehydrate scenario without
 * leaking state into unrelated keys (saved connection URL/token, device
 * id, etc.).
 */
function seedInputSettingsBlob(blob: unknown): void {
  const serialized = blob === undefined ? null : JSON.stringify(blob);
  (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
    if (key === STORAGE_KEY_INPUT_SETTINGS) return Promise.resolve(serialized);
    return Promise.resolve(null);
  });
}

describe('loadSavedConnection() — inputSettings rehydrate (#4872)', () => {
  describe('voiceInputMode validation', () => {
    it('accepts the canonical "continuous" mode', async () => {
      seedInputSettingsBlob({ voiceInputMode: 'continuous' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('accepts the canonical "auto-pause" mode', async () => {
      seedInputSettingsBlob({ voiceInputMode: 'auto-pause' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('auto-pause');
    });

    it('drops an unknown string mode and preserves the default', async () => {
      seedInputSettingsBlob({ voiceInputMode: 'push-to-talk' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops a `null` voiceInputMode and preserves the default', async () => {
      seedInputSettingsBlob({ voiceInputMode: null });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops a numeric voiceInputMode and preserves the default', async () => {
      seedInputSettingsBlob({ voiceInputMode: 42 });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops an object voiceInputMode and preserves the default', async () => {
      seedInputSettingsBlob({ voiceInputMode: { mode: 'continuous' } });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops an array voiceInputMode and preserves the default', async () => {
      seedInputSettingsBlob({ voiceInputMode: ['continuous'] });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops a case-mismatched mode (guard is exact-match)', async () => {
      seedInputSettingsBlob({ voiceInputMode: 'Continuous' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops an empty-string mode', async () => {
      seedInputSettingsBlob({ voiceInputMode: '' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });

    it('drops a prototype-method name (hasOwnProperty defends against this)', async () => {
      seedInputSettingsBlob({ voiceInputMode: 'toString' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.voiceInputMode).toBe('continuous');
    });
  });

  describe('boolean toggle gating', () => {
    it('round-trips chatEnterToSend = false', async () => {
      seedInputSettingsBlob({ chatEnterToSend: false });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.chatEnterToSend).toBe(false);
    });

    it('round-trips terminalEnterToSend = true', async () => {
      seedInputSettingsBlob({ terminalEnterToSend: true });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.terminalEnterToSend).toBe(true);
    });

    it('drops a string chatEnterToSend and preserves the default (true)', async () => {
      seedInputSettingsBlob({ chatEnterToSend: 'yes' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.chatEnterToSend).toBe(true);
    });

    it('drops a numeric terminalEnterToSend and preserves the default (false)', async () => {
      seedInputSettingsBlob({ terminalEnterToSend: 1 });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings.terminalEnterToSend).toBe(false);
    });
  });

  describe('mixed / extraneous payloads', () => {
    it('rehydrates valid fields while dropping a sibling unknown mode', async () => {
      seedInputSettingsBlob({
        chatEnterToSend: false,
        terminalEnterToSend: true,
        voiceInputMode: 'push-to-talk',
      });
      await useConnectionStore.getState().loadSavedConnection();
      const s = useConnectionStore.getState().inputSettings;
      expect(s.chatEnterToSend).toBe(false);
      expect(s.terminalEnterToSend).toBe(true);
      // unknown mode dropped — default preserved
      expect(s.voiceInputMode).toBe('continuous');
    });

    it('ignores extra keys in the persisted blob (no shoehorned state)', async () => {
      seedInputSettingsBlob({
        chatEnterToSend: false,
        somethingElseEntirely: 'should-not-land',
        nestedAttack: { a: 1 },
      });
      await useConnectionStore.getState().loadSavedConnection();
      const s = useConnectionStore.getState().inputSettings;
      expect(s.chatEnterToSend).toBe(false);
      // Spread did NOT pull in unknown keys
      expect((s as unknown as Record<string, unknown>).somethingElseEntirely).toBeUndefined();
      expect((s as unknown as Record<string, unknown>).nestedAttack).toBeUndefined();
    });

    it('preserves all defaults when the blob has no recognised fields', async () => {
      seedInputSettingsBlob({ foo: 'bar' });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings).toEqual(DEFAULT_INPUT_SETTINGS);
    });

    it('preserves all defaults when no blob is persisted', async () => {
      seedInputSettingsBlob(undefined);
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings).toEqual(DEFAULT_INPUT_SETTINGS);
    });

    it('preserves all defaults when the persisted blob is malformed JSON', async () => {
      // raw return — JSON.parse throws, handler swallows it
      (SecureStore.getItemAsync as jest.Mock).mockImplementation((key: string) => {
        if (key === STORAGE_KEY_INPUT_SETTINGS) return Promise.resolve('{not-json');
        return Promise.resolve(null);
      });
      await useConnectionStore.getState().loadSavedConnection();
      expect(useConnectionStore.getState().inputSettings).toEqual(DEFAULT_INPUT_SETTINGS);
    });
  });
});
