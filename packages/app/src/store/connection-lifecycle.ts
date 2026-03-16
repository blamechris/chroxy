/**
 * Connection lifecycle store — extracted connection state.
 *
 * Holds connection phase, server info, connection quality, and saved
 * connection state. Receives dual-writes from the main ConnectionState
 * store for backward compatibility.
 */
import { create } from 'zustand';
import type { ConnectionPhase, SavedConnection } from './types';

/**
 * Finite state machine: maps each phase to the set of phases it may
 * legally transition into.  Any transition not listed here is invalid and
 * will be logged as a warning (but still applied so production never
 * silently breaks).
 *
 * Notes on non-obvious entries:
 *  - connecting → server_restarting: health check returns "restarting" during the
 *    initial connect attempt before a WebSocket is ever opened.
 *  - connecting → reconnecting: the retry loop inside connect() escalates to
 *    "reconnecting" after the first failed attempt.
 *  - reconnecting → reconnecting / connecting → connecting: self-transitions are
 *    allowed so that recursive retry calls do not generate spurious warnings.
 */
const VALID_TRANSITIONS: Record<ConnectionPhase, ConnectionPhase[]> = {
  disconnected: ['connecting'],
  connecting: ['connecting', 'connected', 'disconnected', 'reconnecting', 'server_restarting'],
  connected: ['disconnected', 'reconnecting', 'server_restarting'],
  reconnecting: ['reconnecting', 'connected', 'disconnected', 'server_restarting'],
  server_restarting: ['connecting', 'disconnected'],
};

interface ServerInfo {
  serverMode?: 'cli' | null;
  serverVersion?: string | null;
  latestVersion?: string | null;
  serverCommit?: string | null;
  serverProtocolVersion?: number | null;
  sessionCwd?: string | null;
  isEncrypted?: boolean;
}

interface ConnectionLifecycleState {
  // Connection phase
  connectionPhase: ConnectionPhase;

  // Connection details
  wsUrl: string | null;
  apiToken: string | null;

  // Server context (from auth_ok)
  serverMode: 'cli' | null;
  sessionCwd: string | null;
  serverVersion: string | null;
  latestVersion: string | null;
  serverCommit: string | null;
  serverProtocolVersion: number | null;
  isEncrypted: boolean;

  // Connection quality
  latencyMs: number | null;
  connectionQuality: 'good' | 'fair' | 'poor' | null;
  connectionError: string | null;
  connectionRetryCount: number;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;
  userDisconnected: boolean;

  // Actions
  setConnectionPhase: (phase: ConnectionPhase) => void;
  transitionPhase: (to: ConnectionPhase) => void;
  setConnectionDetails: (url: string, token: string) => void;
  setServerInfo: (info: ServerInfo) => void;
  setConnectionQuality: (latencyMs: number | null, quality: 'good' | 'fair' | 'poor' | null) => void;
  setConnectionError: (error: string | null, retryCount: number) => void;
  setSavedConnection: (connection: SavedConnection | null) => void;
  setUserDisconnected: (disconnected: boolean) => void;
  reset: () => void;
}

const initialState = {
  connectionPhase: 'disconnected' as ConnectionPhase,
  wsUrl: null as string | null,
  apiToken: null as string | null,
  serverMode: null as 'cli' | null,
  sessionCwd: null as string | null,
  serverVersion: null as string | null,
  latestVersion: null as string | null,
  serverCommit: null as string | null,
  serverProtocolVersion: null as number | null,
  isEncrypted: false,
  latencyMs: null as number | null,
  connectionQuality: null as 'good' | 'fair' | 'poor' | null,
  connectionError: null as string | null,
  connectionRetryCount: 0,
  savedConnection: null as SavedConnection | null,
  userDisconnected: false,
};

export const useConnectionLifecycleStore = create<ConnectionLifecycleState>((set, get) => ({
  ...initialState,

  transitionPhase: (to) => {
    const from = get().connectionPhase;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      console.warn(
        `[ConnectionFSM] Illegal transition: ${from} → ${to}. ` +
          `Allowed from ${from}: [${allowed.join(', ')}]`
      );
    }
    set({ connectionPhase: to });
  },

  setConnectionPhase: (phase) => get().transitionPhase(phase),

  setConnectionDetails: (url, token) => set({ wsUrl: url, apiToken: token }),

  setServerInfo: (info) => set(info),

  setConnectionQuality: (latencyMs, quality) => set({ latencyMs, connectionQuality: quality }),

  setConnectionError: (error, retryCount) => set({ connectionError: error, connectionRetryCount: retryCount }),

  setSavedConnection: (connection) => set({ savedConnection: connection }),

  setUserDisconnected: (disconnected) => set({ userDisconnected: disconnected }),

  reset: () => set((state) => ({
    ...initialState,
    // Preserve saved connection and user disconnect flag across resets
    // (both survive disconnect/reconnect cycles — cleared explicitly when needed)
    savedConnection: state.savedConnection,
    userDisconnected: state.userDisconnected,
  })),
}));
