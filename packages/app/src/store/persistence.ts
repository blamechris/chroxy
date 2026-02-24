/**
 * Client-side state persistence using AsyncStorage.
 *
 * Persists session state (messages, view mode, active session) across
 * app restarts. Large data (messages, terminal buffer) uses AsyncStorage
 * while sensitive data (tokens, URLs) remains in SecureStore.
 *
 * Data is debounced to avoid excessive writes on rapid message streams.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage } from './types';

const KEY_PREFIX = 'chroxy_persist_';
const KEY_VIEW_MODE = `${KEY_PREFIX}view_mode`;
const KEY_ACTIVE_SESSION = `${KEY_PREFIX}active_session_id`;
const KEY_TERMINAL_BUFFER = `${KEY_PREFIX}terminal_buffer`;

/** Max messages to persist per session (keeps storage bounded) */
const MAX_MESSAGES = 100;

/** Max terminal buffer size to persist (characters, ~50 KB for ASCII) */
const MAX_TERMINAL_SIZE = 50_000;

/** Valid view modes — used to validate persisted values */
const VALID_VIEW_MODES = ['chat', 'terminal', 'files'] as const;
type ViewMode = (typeof VALID_VIEW_MODES)[number];

function sessionMessagesKey(sessionId: string): string {
  return `${KEY_PREFIX}messages_${sessionId}`;
}

// ---------------------------------------------------------------------------
// Debounce factory — each caller gets independent timer/pending state
// ---------------------------------------------------------------------------

interface DebouncedPersister {
  schedule: (fn: () => Promise<void>) => void;
}

/** Create an independent debounced persister with its own timer */
function createDebouncedPersist(delayMs: number): DebouncedPersister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => Promise<void>) | null = null;

  return {
    schedule(fn: () => Promise<void>): void {
      pending = fn;
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        const save = pending;
        pending = null;
        if (save) {
          try {
            await save();
          } catch (err) {
            console.warn('[persist] Debounced save failed:', err);
          }
        }
      }, delayMs);
    },
  };
}

// Separate debounce instances per data stream — prevents cross-clobbering
const _messagesPersister = createDebouncedPersist(500);
const _terminalPersister = createDebouncedPersist(1000);

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

/** Persist messages for a specific session */
export function persistSessionMessages(sessionId: string, messages: ChatMessage[]): void {
  _messagesPersister.schedule(async () => {
    // Keep only the last N messages, strip large base64 data
    const trimmed = messages.slice(-MAX_MESSAGES).map(stripLargeData);
    await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(trimmed));
  });
}

/** Persist the active view mode */
export async function persistViewMode(mode: ViewMode): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_VIEW_MODE, mode);
  } catch {
    // Storage not available
  }
}

/** Persist the active session ID */
export async function persistActiveSession(sessionId: string | null): Promise<void> {
  try {
    if (sessionId) {
      await AsyncStorage.setItem(KEY_ACTIVE_SESSION, sessionId);
    } else {
      await AsyncStorage.removeItem(KEY_ACTIVE_SESSION);
    }
  } catch {
    // Storage not available
  }
}

/** Persist terminal buffer (debounced) */
export function persistTerminalBuffer(buffer: string): void {
  _terminalPersister.schedule(async () => {
    const trimmed = buffer.length > MAX_TERMINAL_SIZE
      ? buffer.slice(-MAX_TERMINAL_SIZE)
      : buffer;
    await AsyncStorage.setItem(KEY_TERMINAL_BUFFER, trimmed);
  });
}

// ---------------------------------------------------------------------------
// Load helpers
// ---------------------------------------------------------------------------

export interface PersistedState {
  viewMode: ViewMode | null;
  activeSessionId: string | null;
  terminalBuffer: string | null;
}

/** Load all persisted state on app startup */
export async function loadPersistedState(): Promise<PersistedState> {
  try {
    const [viewMode, activeSessionId, terminalBuffer] = await AsyncStorage.multiGet([
      KEY_VIEW_MODE,
      KEY_ACTIVE_SESSION,
      KEY_TERMINAL_BUFFER,
    ]);
    // Validate viewMode against allowed values (guards against stale/corrupt data)
    const rawViewMode = viewMode[1];
    const validatedViewMode: ViewMode | null =
      rawViewMode && (VALID_VIEW_MODES as readonly string[]).includes(rawViewMode)
        ? (rawViewMode as ViewMode)
        : null;
    return {
      viewMode: validatedViewMode,
      activeSessionId: activeSessionId[1] || null,
      terminalBuffer: terminalBuffer[1] || null,
    };
  } catch {
    return { viewMode: null, activeSessionId: null, terminalBuffer: null };
  }
}

/** Load persisted messages for a specific session */
export async function loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(sessionMessagesKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/** Clear persisted data for a specific destroyed/timed-out session (#797) */
export async function clearPersistedSession(sessionId: string): Promise<void> {
  try {
    const key = sessionMessagesKey(sessionId);
    await AsyncStorage.removeItem(key);
  } catch {
    // Storage not available
  }
}

/** Clear all persisted session data (e.g., on "Clear Session History") */
export async function clearPersistedState(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const persistKeys = allKeys.filter(k => k.startsWith(KEY_PREFIX));
    if (persistKeys.length > 0) {
      await AsyncStorage.multiRemove(persistKeys);
    }
  } catch {
    // Storage not available
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip base64 image data from messages to keep storage bounded */
function stripLargeData(msg: ChatMessage): ChatMessage {
  if (!msg.toolResultImages?.length && !msg.attachments?.length) return msg;
  return {
    ...msg,
    // Always strip base64 image data — it's not useful after restart
    toolResultImages: msg.toolResultImages?.map(img => ({
      ...img,
      data: img.data ? '[image data stripped for storage]' : img.data,
    })),
    // Attachments should already have data cleared after send, but be safe
    attachments: msg.attachments?.map(att => ({
      ...att,
      uri: att.uri.startsWith('data:') ? '[data stripped]' : att.uri,
    })),
  };
}
