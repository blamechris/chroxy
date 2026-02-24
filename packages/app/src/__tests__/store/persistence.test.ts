/**
 * Tests for client-side state persistence module.
 *
 * Uses the AsyncStorage mock from jest.setup.js (in-memory store).
 * Debounced functions use real timers + explicit delay waits.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  persistSessionMessages,
  persistViewMode,
  persistActiveSession,
  persistTerminalBuffer,
  loadPersistedState,
  loadSessionMessages,
  clearPersistedState,
} from '../../store/persistence';
import type { ChatMessage } from '../../store/types';

function makeMsg(id: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    type: 'response',
    content: `Message ${id}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Wait for debounce timer + async save to complete */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// persistViewMode / loadPersistedState
// ---------------------------------------------------------------------------

describe('persistViewMode', () => {
  it('persists and loads view mode', async () => {
    await persistViewMode('terminal');
    const state = await loadPersistedState();
    expect(state.viewMode).toBe('terminal');
  });

  it('validates view mode against allowed values', async () => {
    await AsyncStorage.setItem('chroxy_persist_view_mode', 'invalid_mode');
    const state = await loadPersistedState();
    expect(state.viewMode).toBeNull();
  });

  it('accepts all valid view modes', async () => {
    for (const mode of ['chat', 'terminal', 'files'] as const) {
      await persistViewMode(mode);
      const state = await loadPersistedState();
      expect(state.viewMode).toBe(mode);
    }
  });
});

// ---------------------------------------------------------------------------
// persistActiveSession
// ---------------------------------------------------------------------------

describe('persistActiveSession', () => {
  it('persists and loads active session ID', async () => {
    await persistActiveSession('session-123');
    const state = await loadPersistedState();
    expect(state.activeSessionId).toBe('session-123');
  });

  it('removes session ID when null', async () => {
    await persistActiveSession('session-123');
    await persistActiveSession(null);
    const state = await loadPersistedState();
    expect(state.activeSessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// persistSessionMessages / loadSessionMessages
// ---------------------------------------------------------------------------

describe('persistSessionMessages', () => {
  it('persists and loads messages for a session', async () => {
    const messages = [makeMsg('1'), makeMsg('2')];
    persistSessionMessages('s1', messages);
    await delay(700); // debounce 500ms + margin

    const loaded = await loadSessionMessages('s1');
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('1');
    expect(loaded[1].id).toBe('2');
  });

  it('trims to MAX_MESSAGES (100)', async () => {
    const messages = Array.from({ length: 120 }, (_, i) => makeMsg(`m-${i}`));
    persistSessionMessages('s1', messages);
    await delay(700);

    const loaded = await loadSessionMessages('s1');
    expect(loaded).toHaveLength(100);
    expect(loaded[0].id).toBe('m-20');
  });

  it('strips base64 image data from toolResultImages', async () => {
    const messages = [
      makeMsg('img-1', {
        toolResultImages: [
          { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANS...' },
        ],
      }),
    ];
    persistSessionMessages('s1', messages);
    await delay(700);

    const loaded = await loadSessionMessages('s1');
    expect(loaded[0].toolResultImages![0].data).toBe('[image data stripped for storage]');
  });

  it('strips data: URIs from attachments', async () => {
    const messages = [
      makeMsg('att-1', {
        attachments: [
          { id: 'a1', type: 'image', uri: 'data:image/png;base64,abc', name: 'photo.png', mediaType: 'image/png', size: 1000 },
        ],
      }),
    ];
    persistSessionMessages('s1', messages);
    await delay(700);

    const loaded = await loadSessionMessages('s1');
    expect(loaded[0].attachments![0].uri).toBe('[data stripped]');
  });

  it('preserves non-data: attachment URIs', async () => {
    const messages = [
      makeMsg('att-2', {
        attachments: [
          { id: 'a2', type: 'document', uri: 'file:///doc.pdf', name: 'doc.pdf', mediaType: 'application/pdf', size: 500 },
        ],
      }),
    ];
    persistSessionMessages('s1', messages);
    await delay(700);

    const loaded = await loadSessionMessages('s1');
    expect(loaded[0].attachments![0].uri).toBe('file:///doc.pdf');
  });

  it('debounces rapid calls (only last wins)', async () => {
    persistSessionMessages('s1', [makeMsg('a')]);
    persistSessionMessages('s1', [makeMsg('b')]);
    persistSessionMessages('s1', [makeMsg('c')]);
    await delay(700);

    const loaded = await loadSessionMessages('s1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('c');
  });

  it('returns empty array for missing session', async () => {
    const loaded = await loadSessionMessages('nonexistent');
    expect(loaded).toEqual([]);
  });

  it('returns empty array for corrupt JSON', async () => {
    await AsyncStorage.setItem('chroxy_persist_messages_s1', 'not json');
    const loaded = await loadSessionMessages('s1');
    expect(loaded).toEqual([]);
  });

  it('returns empty array when stored value is not an array', async () => {
    await AsyncStorage.setItem('chroxy_persist_messages_s1', JSON.stringify({ bad: true }));
    const loaded = await loadSessionMessages('s1');
    expect(loaded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// persistTerminalBuffer
// ---------------------------------------------------------------------------

describe('persistTerminalBuffer', () => {
  it('persists and loads terminal buffer', async () => {
    persistTerminalBuffer('hello terminal');
    await delay(1200); // debounce 1000ms + margin

    const state = await loadPersistedState();
    expect(state.terminalBuffer).toBe('hello terminal');
  });

  it('truncates to MAX_TERMINAL_SIZE (50000 chars)', async () => {
    const bigBuffer = 'x'.repeat(60000);
    persistTerminalBuffer(bigBuffer);
    await delay(1200);

    const state = await loadPersistedState();
    expect(state.terminalBuffer!.length).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// loadPersistedState
// ---------------------------------------------------------------------------

describe('loadPersistedState', () => {
  it('returns nulls when nothing persisted', async () => {
    const state = await loadPersistedState();
    expect(state.viewMode).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.terminalBuffer).toBeNull();
  });

  it('handles AsyncStorage errors gracefully', async () => {
    (AsyncStorage.multiGet as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    const state = await loadPersistedState();
    expect(state).toEqual({ viewMode: null, activeSessionId: null, terminalBuffer: null });
  });
});

// ---------------------------------------------------------------------------
// clearPersistedState
// ---------------------------------------------------------------------------

describe('clearPersistedState', () => {
  it('removes only chroxy_persist_ keys', async () => {
    await AsyncStorage.setItem('chroxy_persist_view_mode', 'chat');
    await AsyncStorage.setItem('chroxy_persist_active_session_id', 's1');
    await AsyncStorage.setItem('unrelated_key', 'keep me');

    await clearPersistedState();

    const allKeys = await AsyncStorage.getAllKeys();
    expect(allKeys).toContain('unrelated_key');
    expect(allKeys).not.toContain('chroxy_persist_view_mode');
    expect(allKeys).not.toContain('chroxy_persist_active_session_id');
  });

  it('does not fail when no persist keys exist', async () => {
    await expect(clearPersistedState()).resolves.not.toThrow();
  });
});
