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
import type { ChatMessage, SessionState } from './types';

const KEY_PREFIX = 'chroxy_persist_';
const KEY_VIEW_MODE = `${KEY_PREFIX}view_mode`;
const KEY_ACTIVE_SESSION = `${KEY_PREFIX}active_session_id`;
const KEY_TERMINAL_BUFFER = `${KEY_PREFIX}terminal_buffer`;

/** Max messages to persist per session (keeps storage bounded) */
const MAX_MESSAGES = 100;

/** Max terminal buffer size to persist (bytes) */
const MAX_TERMINAL_SIZE = 50_000;

function sessionMessagesKey(sessionId: string): string {
  return `${KEY_PREFIX}messages_${sessionId}`;
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSave: (() => Promise<void>) | null = null;

/** Debounced persist — coalesces rapid writes into a single flush */
function debouncedPersist(fn: () => Promise<void>, delayMs = 500): void {
  _pendingSave = fn;
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    const save = _pendingSave;
    _pendingSave = null;
    if (save) {
      try {
        await save();
      } catch (err) {
        console.warn('[persist] Debounced save failed:', err);
      }
    }
  }, delayMs);
}

/** Persist messages for a specific session */
export function persistSessionMessages(sessionId: string, messages: ChatMessage[]): void {
  debouncedPersist(async () => {
    // Keep only the last N messages, strip large base64 data
    const trimmed = messages.slice(-MAX_MESSAGES).map(stripLargeData);
    await AsyncStorage.setItem(sessionMessagesKey(sessionId), JSON.stringify(trimmed));
  });
}

/** Persist the active view mode */
export async function persistViewMode(mode: string): Promise<void> {
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
  debouncedPersist(async () => {
    const trimmed = buffer.length > MAX_TERMINAL_SIZE
      ? buffer.slice(-MAX_TERMINAL_SIZE)
      : buffer;
    await AsyncStorage.setItem(KEY_TERMINAL_BUFFER, trimmed);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Load helpers
// ---------------------------------------------------------------------------

export interface PersistedState {
  viewMode: 'chat' | 'terminal' | 'files' | null;
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
    return {
      viewMode: (viewMode[1] as PersistedState['viewMode']) || null,
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

/** Strip large base64 data from messages to keep storage bounded */
function stripLargeData(msg: ChatMessage): ChatMessage {
  if (!msg.toolResultImages?.length && !msg.attachments?.length) return msg;
  return {
    ...msg,
    // Keep image metadata but strip base64 data
    toolResultImages: msg.toolResultImages?.map(img => ({
      ...img,
      data: img.data.length > 1000 ? '[image data stripped for storage]' : img.data,
    })),
    // Attachments should already have data cleared after send, but be safe
    attachments: msg.attachments?.map(att => ({
      ...att,
      uri: att.uri.startsWith('data:') ? '[data stripped]' : att.uri,
    })),
  };
}
