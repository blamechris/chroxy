/**
 * Client-side state persistence using localStorage (web).
 *
 * Adapted from the mobile app's AsyncStorage-based persistence.
 * Persists session state (messages, view mode, active session) across
 * page reloads. Does not persist auth tokens; token persistence is
 * handled separately (see message-handler.ts).
 *
 * Data is debounced to avoid excessive writes on rapid message streams.
 */
import type { ChatMessage, SessionInfo } from './types';

const KEY_PREFIX = 'chroxy_persist_';
const KEY_VIEW_MODE = `${KEY_PREFIX}view_mode`;
const KEY_ACTIVE_SESSION = `${KEY_PREFIX}active_session_id`;
const KEY_TERMINAL_BUFFER = `${KEY_PREFIX}terminal_buffer`;
const KEY_SESSION_LIST = `${KEY_PREFIX}session_list`;
const KEY_SIDEBAR_WIDTH = `${KEY_PREFIX}sidebar_width`;
const KEY_SPLIT_MODE = `${KEY_PREFIX}split_mode`;
const KEY_ACTIVE_SERVER = `${KEY_PREFIX}active_server_id`;
const KEY_THEME = `${KEY_PREFIX}theme`;

// ---------------------------------------------------------------------------
// Server-scoped persistence — keys scoped by server ID to prevent data loss
// on server switch (#1647)
// ---------------------------------------------------------------------------

/** Current server scope for persistence operations */
let _serverScope: string | null = null;

/** Flush all pending debounced writes (call before changing scope) */
export function flushPendingWrites(): void {
  for (const persister of Object.values(_messagePersisters)) {
    persister.flush();
  }
  _terminalPersister.flush();
  _sessionListPersister.flush();
}

/** Set the active server scope for persistence keys */
export function setServerScope(serverId: string | null): void {
  // Flush pending writes so they land in the old scope
  if (serverId !== _serverScope) {
    flushPendingWrites();
  }
  _serverScope = serverId;
}

/** Get a server-scoped key. Falls back to global key if no scope set. */
function scopedKey(baseKey: string): string {
  if (!_serverScope) return baseKey;
  return `${KEY_PREFIX}${_serverScope}_${baseKey.replace(KEY_PREFIX, '')}`;
}

/**
 * Read from scoped key with migration fallback: if scoped key is empty
 * and an unscoped legacy key has data, read from legacy and copy to scoped.
 */
function scopedRead(baseKey: string): string | null {
  const key = scopedKey(baseKey);
  const value = localStorage.getItem(key);
  if (value !== null || !_serverScope) return value;
  // Fallback: check legacy unscoped key and migrate
  const legacy = localStorage.getItem(baseKey);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(baseKey);
  }
  return legacy;
}

/** Max messages to persist per session (keeps storage bounded) */
const MAX_MESSAGES = 100;

/** Max terminal buffer size to persist (characters, ~50 KB for ASCII) */
const MAX_TERMINAL_SIZE = 50_000;

/** Valid view modes — used to validate persisted values */
const VALID_VIEW_MODES = ['chat', 'terminal', 'files', 'diff', 'system', 'console'] as const;
type ViewMode = (typeof VALID_VIEW_MODES)[number];

function sessionMessagesKey(sessionId: string): string {
  return scopedKey(`${KEY_PREFIX}messages_${sessionId}`);
}

// ---------------------------------------------------------------------------
// Debounce factory — each caller gets independent timer/pending state
// ---------------------------------------------------------------------------

interface DebouncedPersister {
  schedule: (fn: () => void) => void;
  cancel: () => void;
  flush: () => void;
}

/** Create an independent debounced persister with its own timer */
function createDebouncedPersist(delayMs: number): DebouncedPersister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;

  return {
    schedule(fn: () => void): void {
      pending = fn;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const save = pending;
        pending = null;
        if (save) {
          try {
            save();
          } catch (err) {
            console.warn('[persist] Debounced save failed:', err);
          }
        }
      }, delayMs);
    },
    cancel(): void {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
    },
    flush(): void {
      if (timer) { clearTimeout(timer); timer = null; }
      const save = pending;
      pending = null;
      if (save) {
        try { save(); } catch { /* best-effort */ }
      }
    },
  };
}

// Separate debounce instances per data stream — prevents cross-clobbering
const _messagePersisters: Record<string, DebouncedPersister> = {};
const _terminalPersister = createDebouncedPersist(1000);
const _sessionListPersister = createDebouncedPersist(500);

/** Get or create a per-session message debouncer */
function getMessagePersister(sessionId: string): DebouncedPersister {
  if (!_messagePersisters[sessionId]) {
    _messagePersisters[sessionId] = createDebouncedPersist(500);
  }
  return _messagePersisters[sessionId];
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

/** Persist messages for a specific session (per-session debounce) */
export function persistSessionMessages(sessionId: string, messages: ChatMessage[]): void {
  // Capture scoped key at schedule-time to avoid race with scope changes
  const key = sessionMessagesKey(sessionId);
  getMessagePersister(sessionId).schedule(() => {
    const trimmed = messages.slice(-MAX_MESSAGES).map(stripLargeData);
    try {
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {
      // localStorage quota exceeded or not available
    }
  });
}

/** Persist the active view mode */
export function persistViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(KEY_VIEW_MODE, mode);
  } catch {
    // Storage not available
  }
}

/** Persist the active session ID (server-scoped) */
export function persistActiveSession(sessionId: string | null): void {
  try {
    const key = scopedKey(KEY_ACTIVE_SESSION);
    if (sessionId) {
      localStorage.setItem(key, sessionId);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage not available
  }
}

/** Persist terminal buffer (debounced, server-scoped) */
export function persistTerminalBuffer(buffer: string): void {
  // Capture scoped key at schedule-time to avoid race with scope changes
  const key = scopedKey(KEY_TERMINAL_BUFFER);
  _terminalPersister.schedule(() => {
    const trimmed = buffer.length > MAX_TERMINAL_SIZE
      ? buffer.slice(-MAX_TERMINAL_SIZE)
      : buffer;
    try {
      localStorage.setItem(key, trimmed);
    } catch {
      // localStorage quota exceeded
    }
  });
}

/** Persist sidebar width */
export function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(KEY_SIDEBAR_WIDTH, String(width));
  } catch {
    // Storage not available
  }
}

/** Load persisted sidebar width */
export function loadPersistedSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem(KEY_SIDEBAR_WIDTH);
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist split mode */
export function persistSplitMode(mode: string | null): void {
  try {
    if (mode) {
      localStorage.setItem(KEY_SPLIT_MODE, mode);
    } else {
      localStorage.removeItem(KEY_SPLIT_MODE);
    }
  } catch {
    // Storage not available
  }
}

const VALID_SPLIT_MODES = ['horizontal', 'vertical'] as const;

/** Load persisted split mode */
export function loadPersistedSplitMode(): 'horizontal' | 'vertical' | null {
  try {
    const raw = localStorage.getItem(KEY_SPLIT_MODE);
    if (!raw) return null;
    return (VALID_SPLIT_MODES as readonly string[]).includes(raw)
      ? (raw as 'horizontal' | 'vertical')
      : null;
  } catch {
    return null;
  }
}

/** Persist the active server ID */
export function persistActiveServer(serverId: string | null): void {
  try {
    if (serverId) {
      localStorage.setItem(KEY_ACTIVE_SERVER, serverId);
    } else {
      localStorage.removeItem(KEY_ACTIVE_SERVER);
    }
  } catch {
    // Storage not available
  }
}

/** Load the persisted active server ID */
export function loadPersistedActiveServer(): string | null {
  try {
    return localStorage.getItem(KEY_ACTIVE_SERVER) || null;
  } catch {
    return null;
  }
}

/** Persist the session list (debounced, server-scoped) */
export function persistSessionList(sessions: SessionInfo[]): void {
  // Capture scoped key at schedule-time to avoid race with scope changes
  const key = scopedKey(KEY_SESSION_LIST);
  _sessionListPersister.schedule(() => {
    try {
      localStorage.setItem(key, JSON.stringify(sessions));
    } catch {
      // localStorage quota exceeded
    }
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

/** Load all persisted state (server-scoped for session data, global for view mode) */
export function loadPersistedState(): PersistedState {
  try {
    // View mode is global (not per-server)
    const rawViewMode = localStorage.getItem(KEY_VIEW_MODE);
    // Session data is server-scoped (with legacy migration fallback)
    const activeSessionId = scopedRead(KEY_ACTIVE_SESSION);
    const terminalBuffer = scopedRead(KEY_TERMINAL_BUFFER);

    const validatedViewMode: ViewMode | null =
      rawViewMode && (VALID_VIEW_MODES as readonly string[]).includes(rawViewMode)
        ? (rawViewMode as ViewMode)
        : null;

    return {
      viewMode: validatedViewMode,
      activeSessionId: activeSessionId || null,
      terminalBuffer: terminalBuffer || null,
    };
  } catch {
    return { viewMode: null, activeSessionId: null, terminalBuffer: null };
  }
}

/** Load persisted messages for a specific session */
export function loadSessionMessages(sessionId: string): ChatMessage[] {
  try {
    const key = sessionMessagesKey(sessionId);
    let raw = localStorage.getItem(key);
    // Migration fallback: check legacy unscoped key
    if (raw === null && _serverScope) {
      const legacyKey = `${KEY_PREFIX}messages_${sessionId}`;
      raw = localStorage.getItem(legacyKey);
      if (raw !== null) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(legacyKey);
      }
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Load persisted session list (server-scoped) */
export function loadSessionList(): SessionInfo[] {
  try {
    const raw = scopedRead(KEY_SESSION_LIST);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Load cached messages for multiple sessions at once */
export function loadAllSessionMessages(
  sessionIds: string[],
): Record<string, ChatMessage[]> {
  const result: Record<string, ChatMessage[]> = {};
  for (const id of sessionIds) {
    result[id] = loadSessionMessages(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/** Clear persisted data for a specific destroyed/timed-out session */
export function clearPersistedSession(sessionId: string): void {
  try {
    localStorage.removeItem(sessionMessagesKey(sessionId));
  } catch {
    // Storage not available
  }
}

/** Clear the persisted terminal buffer (server-scoped) */
export function clearPersistedTerminalBuffer(): void {
  try {
    localStorage.removeItem(scopedKey(KEY_TERMINAL_BUFFER));
  } catch {
    // Storage not available
  }
}

/**
 * Clear persisted session data for the current server scope.
 * If server scope is set, only removes keys for that server.
 * Global settings (theme, view mode, sidebar width) are preserved.
 */
export function clearPersistedState(): void {
  try {
    const keysToRemove: string[] = [];
    // If scoped, only clear keys belonging to this server
    const scopePrefix = _serverScope ? `${KEY_PREFIX}${_serverScope}_` : KEY_PREFIX;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(scopePrefix)) {
        // Never clear global settings even if unscoped
        if (!_serverScope && isGlobalKey(key)) continue;
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage not available
  }
}

/** Keys that should never be cleared during server switch */
function isGlobalKey(key: string): boolean {
  return key === KEY_VIEW_MODE
    || key === KEY_SIDEBAR_WIDTH
    || key === KEY_SPLIT_MODE
    || key === KEY_ACTIVE_SERVER
    || key === KEY_THEME;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset module-level debounce state and server scope for deterministic testing */
export function _resetForTesting(): void {
  for (const persister of Object.values(_messagePersisters)) {
    persister.cancel();
  }
  for (const key of Object.keys(_messagePersisters)) {
    delete _messagePersisters[key];
  }
  _terminalPersister.cancel();
  _sessionListPersister.cancel();
  _serverScope = null;
}

/** Strip base64 image data from messages to keep storage bounded */
function stripLargeData(msg: ChatMessage): ChatMessage {
  if (!msg.toolResultImages?.length && !msg.attachments?.length) return msg;
  return {
    ...msg,
    toolResultImages: msg.toolResultImages?.map(img => ({
      ...img,
      data: img.data ? '[image data stripped for storage]' : img.data,
    })),
    attachments: msg.attachments?.map(att => ({
      ...att,
      uri: att.uri.startsWith('data:') ? '[data stripped]' : att.uri,
    })),
  };
}
