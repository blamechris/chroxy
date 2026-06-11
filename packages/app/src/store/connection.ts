/**
 * Connection store — Zustand store managing WebSocket connection,
 * session state, and all server communication.
 *
 * This module was split from a single 2850-line file into:
 * - types.ts       — All shared interfaces and type definitions
 * - utils.ts       — Pure utility functions (stripAnsi, filterThinking, etc.)
 * - message-handler.ts — handleMessage() and module-level state
 * - connection.ts   — Store definition and actions (this file)
 */
import { create } from 'zustand';
import { Alert, AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import { type EncryptedEnvelope } from '../utils/crypto';
import { hapticLight, hapticMedium, hapticWarning } from '../utils/haptics';

// Global augmentation for hot-reload cleanup sentinel
declare global {
  // eslint-disable-next-line no-var
  var __chroxy_appStateSub: ReturnType<typeof AppState.addEventListener> | undefined;
  // #5518 — network-change subscription (LAN↔tunnel re-evaluation).
  // eslint-disable-next-line no-var
  var __chroxy_networkSub: { remove: () => void } | undefined;
}

// Re-export all types for backward compatibility
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  ContextUsage,
  ModelInfo,
  SessionInfo,
  // #4213: typed permission-mode shape (includes optional `description`).
  PermissionMode,
  DirectoryEntry,
  DirectoryListing,
  FileEntry,
  FileListing,
  FileContent,
  FileWriteResult,
  DiffHunkLine,
  DiffHunk,
  DiffFile,
  DiffResult,
  GitFileStatus,
  GitBranch,
  GitStatusResult,
  GitBranchesResult,
  GitStageResult,
  GitCommitResult,
  AgentInfo,
  ConnectedClient,
  SessionHealth,
  SessionContext,
  McpServer,
  DevPreview,
  SessionState,
  ServerError,
  SessionNotification,
  SlashCommand,
  CustomAgent,
  ConnectionPhase,
  ConnectionContext,
  ConversationSummary,
  SearchResult,
  ConnectionState,
} from './types';

// Re-export utility functions for backward compatibility
export { stripAnsi, filterThinking, nextMessageId, createEmptySessionState } from './utils';

// Re-export loadConnection for backward compatibility (used by notifications.ts)
export { loadConnection, _testQueueInternals, _testMessageHandler } from './message-handler';

// Import what we need internally
import type {
  ChatMessage,
  ConnectionContext,
  ConnectionState,
  ContextUsage,
  MessageAttachment,
  SavedConnection,
  SessionInfo,
  SessionState,
} from './types';
import { stripAnsi, filterThinking, nextMessageId, createEmptySessionState, withJitter, formatQuestionAnswerSummary } from './utils';
import { selectConnectEndpoint } from '../utils/endpoint-selector';
import {
  setStore,
  wsSend,
  sendClientVisible,
  handleMessage,
  setConnectionContext,
  setEncryptionState,
  setPendingKeyPair,
  getEncryptionState,
  getPendingKeyPair,
  connectionAttemptId,
  bumpConnectionAttemptId,
  disconnectedAttemptId,
  setDisconnectedAttemptId,
  lastConnectedUrl,
  setLastConnectedUrl,
  pendingPairingId,
  setPendingPairingId,
  setPendingSwitchSessionId,
  resetReplayFlags,
  clearPermissionSplits,
  clearTerminalWriteBatching,
  appendPendingTerminalWrite,
  stopHeartbeat,
  clearDeltaBuffers,
  clearMessageQueue,
  enqueueMessage,
  updateSession,
  updateActiveSession,
  saveConnection,
  clearSavedCredentials,
  loadConnection,
  drainMessageQueue,
  registerPendingPermissionModeRequest,
  clearPendingPermissionModeRequestsForSession,
  CLIENT_PROTOCOL_VERSION,
  isVisibleAppState,
} from './message-handler';
import { CLIENT_CAPABILITIES } from '@chroxy/protocol';
import {
  getWsCloseMessage,
  getHealthCheckErrorMessage,
  // #4875: shared typed predicate for the AskUserQuestion freeform shape.
  // Replaces the inline 5-condition check that previously diverged from
  // the looser SessionScreen variant; both call sites now narrow off the
  // same guard.
  isFreeformAnswer,
  // #4872: shared runtime type-guard for `VoiceInputMode`. The mobile
  // rehydrate path below (`loadSavedConnection`) used to spread the
  // SecureStore blob in unchecked, gated only on `chatEnterToSend` /
  // `terminalEnterToSend` being booleans, so a stale or tampered
  // `voiceInputMode` (`'push-to-talk'`, `null`, `42`) flowed through
  // to `useSpeechRecognition({ mode })`. Now gated by the same guard
  // the dashboard uses (#4853).
  isVoiceInputMode,
} from '@chroxy/store-core';
import type { InputSettings } from '@chroxy/store-core';
import { setCallback as setImperativeCallback, getCallback, clearAllCallbacks } from './imperative-callbacks';
import { useMultiClientStore } from './multi-client';
import { useWebStore } from './web';
import { useCostStore } from './cost';
import { useTerminalStore, TERMINAL_BUFFER_CAP, TERMINAL_RAW_BUFFER_CAP } from './terminal';
import { useNotificationStore } from './notifications';
import { useConversationStore } from './conversations';
import { useConnectionLifecycleStore } from './connection-lifecycle';
import { decrypt, DIRECTION_SERVER, type EncryptionState } from '../utils/crypto';
import {
  loadPersistedState,
  loadSessionMessages,
  loadSessionList,
  loadAllSessionMessages,
  persistSessionMessages,
  persistViewMode,
  persistActiveSession,
  persistTerminalBuffer,
  persistSessionList,
  clearPersistedState,
} from './persistence';

const STORAGE_KEY_INPUT_SETTINGS = 'chroxy_input_settings';

/** Delay before auto-reconnecting after an unexpected socket close (ms) */
const AUTO_RECONNECT_DELAY = 1500;
/** Delay before reconnecting after a WebSocket error (ms) */
const ERROR_RECONNECT_DELAY = 2000;

// #4771: getWsCloseMessage and getHealthCheckErrorMessage are now
// defined in `packages/store-core/src/ws-errors.ts` and exported from
// the package public entrypoint (`@chroxy/store-core`) so the mobile
// app and dashboard share a single tested mapping. Re-exported here
// for backward compatibility with existing imports from
// `app/src/store/connection`.
export { getWsCloseMessage, getHealthCheckErrorMessage } from '@chroxy/store-core';

export const selectShowSession = (s: ConnectionState): boolean =>
  useConnectionLifecycleStore.getState().connectionPhase !== 'disconnected' || s.viewingCachedSession;

// Session-aware selectors — read from sessionStates[activeSessionId]
const EMPTY_MESSAGES: ChatMessage[] = [];

function activeSession(s: ConnectionState): SessionState | null {
  const id = s.activeSessionId;
  return id ? s.sessionStates[id] ?? null : null;
}

export const selectMessages = (s: ConnectionState): ChatMessage[] =>
  activeSession(s)?.messages ?? EMPTY_MESSAGES;
export const selectClaudeReady = (s: ConnectionState): boolean =>
  activeSession(s)?.claudeReady ?? false;
export const selectStreamingMessageId = (s: ConnectionState): string | null =>
  activeSession(s)?.streamingMessageId ?? null;
export const selectActiveModel = (s: ConnectionState): string | null =>
  activeSession(s)?.activeModel ?? null;
export const selectPermissionMode = (s: ConnectionState): string | null =>
  activeSession(s)?.permissionMode ?? null;
export const selectContextUsage = (s: ConnectionState): ContextUsage | null =>
  activeSession(s)?.contextUsage ?? null;
export const selectLastResultCost = (s: ConnectionState): number | null =>
  activeSession(s)?.lastResultCost ?? null;
export const selectLastResultDuration = (s: ConnectionState): number | null =>
  activeSession(s)?.lastResultDuration ?? null;
export const selectIsIdle = (s: ConnectionState): boolean =>
  activeSession(s)?.isIdle ?? true;

// Search request tracking — prevents stale timeout/response races
let searchNonce = 0;
let searchTimeoutId: ReturnType<typeof setTimeout> | undefined;

// Stable device ID persisted across sessions
const STORAGE_KEY_DEVICE_ID = 'chroxy_device_id';
let _cachedDeviceId: string | null = null;

async function getDeviceId(): Promise<string> {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    const stored = await SecureStore.getItemAsync(STORAGE_KEY_DEVICE_ID);
    if (stored) {
      _cachedDeviceId = stored;
      return stored;
    }
  } catch {
    // Storage not available
  }
  // Generate a new device ID
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  _cachedDeviceId = id;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_DEVICE_ID, id);
  } catch {
    // Storage not available
  }
  return id;
}

function getDeviceInfo(): { deviceName: string | null; deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown'; platform: string } {
  const deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown' =
    Device.deviceType === Device.DeviceType.PHONE ? 'phone' :
    Device.deviceType === Device.DeviceType.TABLET ? 'tablet' :
    Device.deviceType === Device.DeviceType.DESKTOP ? 'desktop' : 'unknown';
  return {
    deviceName: Device.deviceName || null,
    deviceType,
    platform: Platform.OS,
  };
}

/**
 * #3899 — wipe `inactivityWarning` on every session in the store.
 *
 * Used by both the `socket.onclose` cleanup (transport-level drop) and
 * the user-initiated `disconnect()` path (which nulls `socket.onclose`
 * so the close handler never runs). Iterating all sessions instead of
 * just the active one matters because a background session can carry a
 * stale chip too, and there's no way to re-derive the value after
 * reconnect — the server doesn't replay `inactivity_warning`.
 *
 * Pure shape: skips the store mutation when no warnings are outstanding
 * so we don't churn referential equality unnecessarily.
 */
function clearInactivityWarningsAcrossSessions(
  set: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void,
  get: () => ConnectionState,
): void {
  const sessionStates = get().sessionStates;
  const ids = Object.keys(sessionStates);
  if (ids.length === 0) return;
  let changed = false;
  const next: Record<string, SessionState> = {};
  for (const id of ids) {
    const ss = sessionStates[id];
    if (ss && ss.inactivityWarning) {
      next[id] = { ...ss, inactivityWarning: null };
      changed = true;
    } else if (ss) {
      next[id] = ss;
    }
  }
  if (changed) set({ sessionStates: next });
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  socket: null,
  sessions: [],
  activeSessionId: null,
  sessionStates: {},
  availableModels: [],
  defaultModelId: null,
  availablePermissionModes: [],
  availableProviders: [],
  myClientId: null,
  connectedClients: [],
  primaryClientId: null,
  followMode: false,
  serverErrors: [],
  sessionNotifications: [],
  shutdownReason: null,
  restartEtaMs: null,
  restartingSince: null,
  pendingPermissionConfirm: null,
  timeoutWarning: null,
  // #4542: per-category notification prefs snapshot. Populated by the
  // `notification_prefs` WS message; null until the first snapshot arrives.
  notificationPrefs: null,
  // #4543: registered Expo push token for THIS device. Filled by
  // registerPushToken (message-handler.ts) after register_push_token. Used
  // as the key into notificationPrefs.devices when patching per-device
  // overrides; null until registration succeeds (or forever on simulators
  // without push capability).
  pushToken: null,
  slashCommands: [],
  customAgents: [],
  checkpoints: [],
  conversationHistory: [],
  conversationHistoryLoading: false,
  conversationHistoryError: null,
  searchResults: [],
  searchLoading: false,
  searchQuery: '',
  searchError: null,
  totalCost: null,
  costBudget: null,
  inputSettings: {
    chatEnterToSend: true,
    terminalEnterToSend: false,
    // #4785: mobile voice path lives in useSpeechRecognition (expo-speech-recognition),
    // which has its own end-of-utterance semantics. Field is type-satisfied here so
    // the shared @chroxy/store-core InputSettings stays a single shape across app +
    // dashboard; wiring it to mobile behaviour is tracked separately.
    voiceInputMode: 'continuous',
  },
  viewingCachedSession: false,
  viewMode: 'chat',
  terminalBuffer: '',
  terminalRawBuffer: '',

  closeDevPreview: (port: number) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'close_dev_preview', port, sessionId: activeSessionId });
    }
  },

  // Web tasks (Claude Code Web)
  webFeatures: { available: false, remote: false, teleport: false },
  webTasks: [],

  launchWebTask: (prompt: string, cwd?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'launch_web_task', prompt };
      if (cwd) payload.cwd = cwd;
      wsSend(socket, payload);
      return 'sent';
    }
    return false;
  },

  listWebTasks: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_web_tasks' });
    }
  },

  teleportWebTask: (taskId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'teleport_web_task', taskId });
    }
  },

  viewCachedSession: () => {
    const { activeSessionId, sessionStates } = get();
    if (activeSessionId && sessionStates[activeSessionId]?.messages.length > 0) {
      set({ viewingCachedSession: true });
    }
  },

  exitCachedSession: () => {
    set({ viewingCachedSession: false });
  },

  dismissTimeoutWarning: () => {
    set({ timeoutWarning: null });
  },

  // #4542: notification-prefs round-trip. Mirrors the dashboard's pattern —
  // `refresh` sends `notification_prefs_get`; `setCategory` sends a single
  // shallow-merge patch via `notification_prefs_set`. The server broadcasts
  // the merged snapshot so other clients (dashboard + mobile) stay in sync
  // without polling.
  // #4559: action returns `true` when the WS message was sent, `false`
  // when the socket was closed (no-op). SettingsScreen surfaces an inline
  // error on `false` so the user knows their change did not reach the
  // server — pre-#4559 the silent-drop made the Switch look unresponsive.
  refreshNotificationPrefs: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'notification_prefs_get' });
      return true;
    }
    return false;
  },

  // #4558: optimistic update. The Switch should flip the moment the user
  // taps it — the WS → server → broadcast round-trip over cellular +
  // Cloudflare tunnel is hundreds of milliseconds, long enough that a
  // server-of-truth-only Switch felt unresponsive. Patch
  // `notificationPrefs` locally BEFORE sending the WS message; the eventual
  // `notification_prefs` broadcast reconciles (server wins, see
  // message-handler.ts case 'notification_prefs').
  //
  // Edge cases mirror the dashboard:
  //   - notificationPrefs == null  → ship the WS message (so the server's
  //     reply seeds the snapshot) but DO NOT mint a synthetic snapshot
  //     locally. The UI gates Switch rendering on a non-null snapshot.
  //   - socket closed              → no optimistic patch either. A
  //     local-only flip would never reconcile and would drift on the next
  //     reconnect snapshot.
  // #4559: returns `true` when sent, `false` when the WS is closed.
  setNotificationPrefsCategory: (category: string, enabled: boolean): boolean => {
    const { socket, notificationPrefs } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (notificationPrefs) {
        set({
          notificationPrefs: {
            ...notificationPrefs,
            categories: { ...notificationPrefs.categories, [category]: enabled },
          },
        });
      }
      wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { categories: { [category]: enabled } },
      });
      return true;
    }
    return false;
  },

  // #4543: patch a per-device category override. Server's setPrefs
  // (push.js) shallow-merges per device key, so a single-category patch
  // leaves other categories under THIS device — and every OTHER device's
  // entry — untouched. Defensive guards:
  // - empty deviceKey → no-op (refuse to ship a `devices[""]` patch).
  // - socket closed   → no-op (the snapshot is the source of truth; we
  //   don't queue, matching setNotificationPrefsCategory).
  //
  // #4558: optimistic update — the per-device mute Switch flips before the
  // broadcast lands. Mirrors the server's shallow-merge so other devices
  // and other categories under THIS device survive.
  // #4559: returns `true` when sent, `false` for both no-op branches
  // (empty deviceKey OR closed socket).
  setNotificationPrefsDevice: (deviceKey: string, category: string, enabled: boolean): boolean => {
    if (!deviceKey) return false;
    const { socket, notificationPrefs } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (notificationPrefs) {
        const existingDevice = notificationPrefs.devices[deviceKey] ?? {};
        const existingCats = existingDevice.categories ?? {};
        set({
          notificationPrefs: {
            ...notificationPrefs,
            devices: {
              ...notificationPrefs.devices,
              [deviceKey]: {
                ...existingDevice,
                categories: { ...existingCats, [category]: enabled },
              },
            },
          },
        });
      }
      wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: {
          devices: {
            [deviceKey]: { categories: { [category]: enabled } },
          },
        },
      });
      return true;
    }
    return false;
  },

  // #4564: drop a per-device entry entirely by sending the null sentinel
  // (`devices: { [deviceKey]: null }`). The server's setPrefs interprets
  // null as "remove this token from the persisted devices map" — the only
  // way to drain orphan entries left behind when an Expo push token
  // refreshes, the app is reinstalled, or a browser device id is cleared.
  //
  // Mirrors setNotificationPrefsDevice's guards:
  // - empty deviceKey → no-op (never ship `devices[""]`).
  // - socket closed   → no-op AND no local mutation (an optimistic delete
  //   on a closed socket would never reconcile, leaving the UI lying).
  //
  // Optimistic local update: drop the key from the snapshot immediately
  // so the Settings list row disappears without waiting for the broadcast.
  deleteNotificationPrefsDevice: (deviceKey: string): boolean => {
    if (!deviceKey) return false;
    const { socket, notificationPrefs } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (notificationPrefs) {
        const { [deviceKey]: _removed, ...rest } = notificationPrefs.devices;
        void _removed;
        set({
          notificationPrefs: {
            ...notificationPrefs,
            devices: rest,
          },
        });
      }
      wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { devices: { [deviceKey]: null } },
      });
      return true;
    }
    return false;
  },

  // #4544: global quiet-hours window patch. `null` clears; a window
  // object (with `timezone`) sets it. Server shallow-merges at the top
  // level so other fields (categories, bypassCategories, devices) survive.
  //
  // #4558: optimistic update — local `quietHours` flips before the
  // broadcast lands so the editor's Save button doesn't visibly lag.
  // #4559: returns `false` when the socket is closed.
  setNotificationPrefsQuietHours: (window: { start: string; end: string; timezone: string } | null): boolean => {
    const { socket, notificationPrefs } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (notificationPrefs) {
        set({
          notificationPrefs: { ...notificationPrefs, quietHours: window },
        });
      }
      wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { quietHours: window },
      });
      return true;
    }
    return false;
  },

  // #4544: global bypass-category list. Sent as a replacement (not a
  // delta) — empty array maps to "nothing bypasses, not even errors".
  //
  // #4558: optimistic update — local `bypassCategories` flips before the
  // broadcast lands so the bypass Switch row feels snappy.
  // #4559: returns `false` when the socket is closed.
  setNotificationPrefsBypassCategories: (categories: string[]): boolean => {
    const { socket, notificationPrefs } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (notificationPrefs) {
        set({
          notificationPrefs: { ...notificationPrefs, bypassCategories: categories },
        });
      }
      wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { bypassCategories: categories },
      });
      return true;
    }
    return false;
  },

  setFollowMode: (enabled: boolean) => {
    useMultiClientStore.getState().setFollowMode(enabled);
    set({ followMode: enabled });
  },

  getActiveSessionState: () => {
    const { activeSessionId, sessionStates } = get();
    if (activeSessionId && sessionStates[activeSessionId]) {
      return sessionStates[activeSessionId];
    }
    return createEmptySessionState();
  },

  loadSavedConnection: async () => {
    const saved = await loadConnection();
    if (saved) {
      useConnectionLifecycleStore.getState().setSavedConnection(saved);
    }
    // Load persisted input settings
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY_INPUT_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        // #4872: validated, narrowed merge — mirrors the dashboard
        // rehydrate path (#4853). A stray key in SecureStore (stale blob
        // from an older mode-name, tampered storage, future variant) can
        // no longer shoehorn arbitrary state into `inputSettings`. Each
        // field is checked independently because the persisted blob may
        // pre-date `voiceInputMode` (#4785) and contain only the boolean
        // toggles.
        const next: Partial<InputSettings> = {};
        if (typeof parsed.chatEnterToSend === 'boolean') next.chatEnterToSend = parsed.chatEnterToSend;
        if (typeof parsed.terminalEnterToSend === 'boolean') next.terminalEnterToSend = parsed.terminalEnterToSend;
        // #4872: runtime guard keyed off the same exhaustive
        // `Record<VoiceInputMode, true>` map the dashboard uses. Adding a
        // new variant to the `VoiceInputMode` union without listing it
        // there is a TS error, so the guard cannot silently drop a new
        // mode the way a hand-written `===` chain would.
        if (isVoiceInputMode(parsed.voiceInputMode)) {
          next.voiceInputMode = parsed.voiceInputMode;
        }
        if (Object.keys(next).length > 0) {
          set((state) => ({ inputSettings: { ...state.inputSettings, ...next } }));
        }
      }
    } catch {
      // Storage not available or corrupt — use defaults
    }
    // Load persisted session state (view mode, active session, terminal buffer, session list)
    try {
      const [persisted, cachedSessions] = await Promise.all([
        loadPersistedState(),
        loadSessionList(),
      ]);
      const updates: Partial<ReturnType<typeof get>> = {};
      if (persisted.viewMode) updates.viewMode = persisted.viewMode;
      if (persisted.activeSessionId) updates.activeSessionId = persisted.activeSessionId;
      if (persisted.terminalBuffer) updates.terminalBuffer = persisted.terminalBuffer;
      if (cachedSessions.length > 0) updates.sessions = cachedSessions;
      if (Object.keys(updates).length > 0) set(updates);

      // Load cached messages for all sessions (not just active)
      const sessionIds = cachedSessions.map((s) => s.sessionId);
      if (persisted.activeSessionId && !sessionIds.includes(persisted.activeSessionId)) {
        sessionIds.push(persisted.activeSessionId);
      }
      if (sessionIds.length > 0) {
        const allMessages = await loadAllSessionMessages(sessionIds);
        const sessionStates: Record<string, ReturnType<typeof createEmptySessionState>> = {};
        for (const [id, messages] of Object.entries(allMessages)) {
          if (messages.length > 0) {
            sessionStates[id] = { ...createEmptySessionState(), messages };
          }
        }
        if (Object.keys(sessionStates).length > 0) {
          set((state) => ({
            sessionStates: { ...state.sessionStates, ...sessionStates },
          }));
        }
      }
    } catch {
      // Persisted state unavailable — use defaults
    }
  },

  clearSavedConnection: async () => {
    await clearSavedCredentials();
    useConnectionLifecycleStore.getState().setSavedConnection(null);
  },

  // #5518 — auto-select the best endpoint for a saved connection, then connect.
  //
  // Races a cheap `/health` probe against the record's *verified* LAN candidate
  // and prefers it when reachable, else uses the tunnel (see endpoint-selector).
  // Used by the auto-reconnect paths (saved-connection load, app resume, network
  // change). The manual paths (QR scan, ServerPicker, manual entry) keep calling
  // `connect()` directly so an explicit user choice is never second-guessed.
  connectAuto: async (saved: SavedConnection, options?: { silent?: boolean; preferTunnel?: boolean }) => {
    const selection = await selectConnectEndpoint(saved, { preferTunnel: options?.preferTunnel });
    console.log(`[ws] Endpoint selected: ${selection.path} (${selection.url})`);
    get().connect(selection.url, saved.token, { silent: options?.silent });
  },

  // Initial connection uses bounded retries (MAX_RETRIES) with exponential backoff.
  // This prevents infinite loops on bad credentials or missing servers.
  // Auto-reconnect (socket.onclose) calls connect() with _retryCount=0, resetting
  // the retry budget — intentional, since established connections should recover
  // aggressively after transient drops (tunnel blips, server restarts, etc.).
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number }) => {
    const _retryCount = options?._retryCount ?? 0;
    const silent = options?.silent ?? false;
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];

    // Detect if connecting to a different server — clear old session data + queue
    const currentUrl = useConnectionLifecycleStore.getState().wsUrl;
    if (_retryCount === 0 && currentUrl !== null && currentUrl !== url) {
      get().forgetSession();
      clearMessageQueue();
    }

    // Robust reconnect detection: check if we've successfully connected to this URL before
    const isReconnect = lastConnectedUrl === url;

    // New top-level connect call (not a retry) — bump attempt ID to cancel any pending retries
    if (_retryCount === 0) {
      bumpConnectionAttemptId();
    }
    const myAttemptId = connectionAttemptId;

    // Close any existing socket first
    const { socket: existing } = get();
    if (existing) {
      existing.onclose = null;
      existing.onerror = null;
      existing.onmessage = null;
      existing.close();
    }
    const phase = isReconnect || _retryCount > 0 ? 'reconnecting' : 'connecting';
    set({ socket: null });
    useConnectionLifecycleStore.getState().setConnectionPhase(phase);
    useConnectionLifecycleStore.getState().setConnectionError(
      // Only clear on fresh user-initiated connections (not retries/reconnects)
      _retryCount === 0 && !isReconnect ? null : useConnectionLifecycleStore.getState().connectionError,
      _retryCount,
    );
    useConnectionLifecycleStore.getState().setUserDisconnected(false);

    if (_retryCount > 0) {
      console.log(`[ws] Connection attempt ${_retryCount + 1}/${MAX_RETRIES + 1}...`);
    }

    // HTTP health check before WebSocket — verify tunnel is up
    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    fetch(httpUrl, { method: 'GET', signal: controller.signal })
      .finally(() => clearTimeout(timeoutId))
      .then(async (res) => {
        if (myAttemptId !== connectionAttemptId) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Check if the server is in restart mode (supervisor standby)
        try {
          const body = await res.json();
          console.log('[ws] Health check response:', body.status ?? 'no status field');
          if (body.status === 'restarting') {
            console.log(`[ws] Server is restarting, will retry (attempt ${_retryCount + 1}/${MAX_RETRIES + 1})`);
            const healthEta = typeof body.restartEtaMs === 'number' ? body.restartEtaMs : null;
            const currentState = get();
            set({
              shutdownReason: currentState.shutdownReason ?? 'restart',
              restartEtaMs: healthEta,
              restartingSince: currentState.restartingSince || Date.now(),
            });
            useConnectionLifecycleStore.getState().setConnectionPhase('server_restarting');
            if (_retryCount < MAX_RETRIES) {
              const delay = withJitter(RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)]);
              setTimeout(() => {
                if (myAttemptId !== connectionAttemptId) return;
                get().connect(url, token, { silent, _retryCount: _retryCount + 1 });
              }, delay);
            } else {
              useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
              useConnectionLifecycleStore.getState().setConnectionError('Server restart timed out', _retryCount);
              if (!silent) {
                Alert.alert(
                  'Connection Failed',
                  'The server is still restarting. Try again later.',
                  [
                    { text: 'OK' },
                    { text: 'Retry', onPress: () => get().connect(url, token) },
                  ],
                );
              }
            }
            return;
          }
        } catch (err) {
          console.log('[ws] Health check body unreadable:', err instanceof Error ? err.message : String(err));
        }

        console.log('[ws] Health check passed, connecting WebSocket...');
        _connectWebSocket();
      })
      .catch((err) => {
        if (myAttemptId !== connectionAttemptId) return;
        console.log(`[ws] Health check failed: ${err.message}`);
        const reason = getHealthCheckErrorMessage(err);
        useConnectionLifecycleStore.getState().setConnectionError(reason, _retryCount);
        if (_retryCount < MAX_RETRIES) {
          const delay = withJitter(RETRY_DELAYS[_retryCount]);
          console.log(`[ws] Retrying in ${delay}ms...`);
          setTimeout(() => {
            if (myAttemptId !== connectionAttemptId) return;
            get().connect(url, token, { silent, _retryCount: _retryCount + 1 });
          }, delay);
        } else {
          useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
          useConnectionLifecycleStore.getState().setConnectionError('Could not reach server', _retryCount);
          if (!silent) {
            Alert.alert(
              'Connection Failed',
              'Could not reach the Chroxy server. Make sure it\'s running.',
              [
                { text: 'OK' },
                { text: 'Forget Server', style: 'destructive', onPress: () => { void get().clearSavedConnection(); } },
                { text: 'Retry', onPress: () => get().connect(url, token) },
              ],
            );
          }
        }
      });

    function _connectWebSocket() {
    // Reset encryption state for each new connection (forward secrecy)
    setEncryptionState(null);
    setPendingKeyPair(null);
    const socket = new WebSocket(url);

    socket.onopen = () => {
      // Include device info in auth for multi-client awareness
      const info = getDeviceInfo();
      void getDeviceId().then((deviceId) => {
        if (socket.readyState === WebSocket.OPEN) {
          // Use pairing flow when pendingPairingId is set (from QR scan)
          const pairId = pendingPairingId;
          if (pairId) {
            setPendingPairingId(null); // Clear after use (one-time)
            socket.send(JSON.stringify({
              type: 'pair',
              pairingId: pairId,
              protocolVersion: CLIENT_PROTOCOL_VERSION,
              deviceInfo: { deviceId, ...info },
            }));
          } else {
            socket.send(JSON.stringify({
              type: 'auth',
              token,
              protocolVersion: CLIENT_PROTOCOL_VERSION,
              deviceInfo: { deviceId, ...info },
              capabilities: CLIENT_CAPABILITIES.mobile,
            }));
          }
        }
      });
    };

    const socketCtx: ConnectionContext = { url, token, isReconnect, silent, socket };
    setConnectionContext(socketCtx);
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // Decrypt incoming encrypted messages
      const encState = getEncryptionState();
      if (msg.type === 'encrypted' && encState) {
        if (typeof msg.d !== 'string' || typeof msg.n !== 'number') {
          console.error('[crypto] Invalid encrypted envelope structure:', msg);
          socket.close();
          return;
        }
        try {
          msg = decrypt(msg as EncryptedEnvelope, encState.sharedKey, encState.recvNonce, DIRECTION_SERVER);
          setEncryptionState({ ...encState, recvNonce: encState.recvNonce + 1 });
        } catch (err) {
          console.error('[crypto] Decryption failed:', err);
          socket.close();
          return;
        }
      }
      handleMessage(msg, socketCtx);
    };

    socket.onclose = (event: CloseEvent) => {
      stopHeartbeat();

      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      const wasConnected = useConnectionLifecycleStore.getState().connectionPhase === 'connected';
      set({ socket: null });

      // Clear transient streaming/plan state so stale UI doesn't persist
      clearPermissionSplits();
      updateActiveSession((ss) => {
        const patch: Partial<import('./types').SessionState> = {};
        if (ss.streamingMessageId) patch.streamingMessageId = null;
        if (ss.isPlanPending) {
          patch.isPlanPending = false;
          patch.planAllowedPrompts = [];
        }
        return Object.keys(patch).length > 0 ? patch : {};
      });
      // #3899: server does NOT replay `inactivity_warning` on reconnect,
      // so a chip left over from before the drop would point at stale
      // state. Sweep ALL sessions (not just the active one) because a
      // background session could carry a stale warning too. If the
      // agent is still quiet post-reconnect, the next soft-timeout
      // firing server-side will re-emit.
      clearInactivityWarningsAcrossSessions(set, get);

      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated)
      if (wasConnected && disconnectedAttemptId !== myAttemptId) {
        const closeMsg = getWsCloseMessage(event.code);
        console.log(`[ws] Connection closed (code ${event.code}), auto-reconnecting...`);
        useConnectionLifecycleStore.getState().setConnectionPhase('reconnecting');
        // Only set an error when the close code indicates a real problem (null = normal close)
        if (closeMsg !== null) {
          useConnectionLifecycleStore.getState().setConnectionError(closeMsg, 0);
        }
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, AUTO_RECONNECT_DELAY);
      } else {
        // Connection dropped before it ever reached "connected" state. Previously
        // we silently marked as disconnected, swallowing the real close reason
        // (auth_fail, 1008 policy violation, etc.) when the UI was waiting on a
        // banner. Surface the close code error if one is available (#2772).
        if (disconnectedAttemptId !== myAttemptId) {
          const closeMsg = getWsCloseMessage(event.code);
          if (closeMsg !== null) {
            useConnectionLifecycleStore.getState().setConnectionError(closeMsg, 0);
          }
        }
        useConnectionLifecycleStore.getState().setConnectionPhase('disconnected');
      }
    };

    socket.onerror = (event: Event) => {
      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      set({ socket: null });

      // UX landmine #8: extract whatever detail we can from the error
      // event. React Native's WebSocket implementation exposes a
      // `message` property on the error event in most cases.
      const detail = (event as unknown as { message?: string })?.message;
      const errorMsg = detail
        ? `Connection error: ${detail}`
        : 'Connection error — server may be unreachable';

      // Auto-reconnect on unexpected WS error
      if (disconnectedAttemptId !== myAttemptId) {
        console.log(`[ws] WebSocket error (${detail || 'no detail'}), reconnecting...`);
        useConnectionLifecycleStore.getState().setConnectionPhase('reconnecting');
        useConnectionLifecycleStore.getState().setConnectionError(errorMsg, 0);
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          get().connect(url, token);
        }, ERROR_RECONNECT_DELAY);
      }
    };
    } // end _connectWebSocket
  },

  disconnect: () => {
    hapticMedium();
    // Bump attempt ID to cancel any pending health checks / retry timers
    bumpConnectionAttemptId();
    setDisconnectedAttemptId(connectionAttemptId);
    // Clear saved connection so ConnectScreen doesn't auto-reconnect
    setLastConnectedUrl(null);
    stopHeartbeat();
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    // #3899: same warning-sweep as onclose — user-initiated disconnect
    // nulls socket.onclose above, so the onclose cleanup never runs
    // and any outstanding check-in chip would survive into the next
    // connection. Mirror the cleanup across all sessions here.
    clearInactivityWarningsAcrossSessions(set, get);
    // Reset replay flags in case disconnect happened mid-replay
    resetReplayFlags();
    // Flush and clear any pending delta buffer
    clearDeltaBuffers();
    // Clear permission boundary split tracking
    clearPermissionSplits();
    // Clear terminal write batching
    clearTerminalWriteBatching();
    // Clear encryption state (new connection = new keys = forward secrecy)
    setEncryptionState(null);
    setPendingKeyPair(null);
    // Clear message queue on explicit disconnect
    clearMessageQueue();
    useMultiClientStore.getState().resetPresence();
    useWebStore.getState().reset();
    useCostStore.getState().reset();
    // Preserve sessions, activeSessionId, sessionStates (messages live there now)
    set({
      socket: null,
      availableModels: [],
      defaultModelId: null,
      availablePermissionModes: [],
      availableProviders: [],
      myClientId: null,
      connectedClients: [],
      primaryClientId: null,
      serverErrors: [],
      sessionNotifications: [],
      shutdownReason: null,
      restartEtaMs: null,
      restartingSince: null,
      pendingPermissionConfirm: null,
      timeoutWarning: null,
      // #4542: clear the cached prefs snapshot on disconnect so the next
      // connect refetches from the actual server (snapshots are host-specific).
      notificationPrefs: null,
      // #4543: clear pushToken on disconnect so a reconnect cycle
      // re-registers and re-mirrors a fresh token. Stale tokens would
      // address the wrong device's override map after a token refresh.
      pushToken: null,
      slashCommands: [],
      customAgents: [],
      checkpoints: [],
      totalCost: null,
      costBudget: null,
      webFeatures: { available: false, remote: false, teleport: false }, // kept for backward compat
      webTasks: [], // kept for backward compat
      viewingCachedSession: false,
      conversationHistory: [],
      conversationHistoryLoading: false,
      conversationHistoryError: null,
      searchResults: [],
      searchLoading: false,
      searchQuery: '',
      searchError: null,
    });
    clearAllCallbacks();
    useTerminalStore.getState().reset();
    useNotificationStore.getState().reset();
    useConversationStore.getState().reset();
    useConnectionLifecycleStore.getState().reset();
    useConnectionLifecycleStore.getState().setUserDisconnected(true);
    // UX landmine #1: do NOT clear savedConnection here. disconnect()
    // means "close the session for now" — the saved server should
    // persist so ConnectScreen shows "Reconnect". Only forgetSession()
    // (called from "Forget Server" in the alert and Settings) clears it.
  },

  forgetSession: () => {
    setLastConnectedUrl(null);
    clearPersistedState().catch(() => {});
    set({
      terminalBuffer: '',
      terminalRawBuffer: '',
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      viewingCachedSession: false,
      conversationHistory: [],
      conversationHistoryLoading: false,
      conversationHistoryError: null,
    });
    useConnectionLifecycleStore.setState({ wsUrl: null, apiToken: null });
    useConnectionLifecycleStore.getState().setServerInfo({
      serverMode: null,
      serverVersion: null,
      latestVersion: null,
      sessionCwd: null,
    });
    useTerminalStore.getState().reset();
    useConversationStore.getState().reset();
  },

  setViewMode: (mode) => {
    set({ viewMode: mode });
    persistViewMode(mode).catch(() => {});
  },

  addMessage: (message) => {
    updateActiveSession((ss) => ({
      messages: [
        ...ss.messages.filter((m) => m.id !== 'thinking' || message.id === 'thinking'),
        message,
      ],
    }));
  },


  addUserMessage: (text, attachments, opts) => {
    // Use the client-generated messageId as the ChatMessage id when provided
    // so the same id is shared between the optimistic entry, the server's
    // history record, and any live-echo broadcast. Reconnect replay can
    // then dedup by id instead of by (content, timestamp) equality (#2902).
    const userMsg: ChatMessage = {
      id: opts?.clientMessageId || nextMessageId('user'),
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
      ...(attachments?.length ? { attachments } : undefined),
    };
    const thinkingMsg: ChatMessage = {
      id: 'thinking',
      type: 'thinking',
      content: '',
      timestamp: Date.now(),
    };

    updateActiveSession((ss) => ({
      messages: [...filterThinking(ss.messages), userMsg, thinkingMsg],
      streamingMessageId: 'pending',
    }));

    // Safety net: if no stream_start arrives, clear pending state after 5 seconds.
    setTimeout(() => {
      const sid = get().activeSessionId;
      const ss = sid ? get().sessionStates[sid] : null;
      if (!ss || ss.streamingMessageId !== 'pending') return;
      updateActiveSession((ss) => ({
        messages: filterThinking(ss.messages),
        streamingMessageId: null,
      }));
    }, 5000);
  },

  appendTerminalData: (data) => {
    set((state) => ({
      terminalBuffer: (state.terminalBuffer + stripAnsi(data)).slice(-TERMINAL_BUFFER_CAP),
      terminalRawBuffer: (state.terminalRawBuffer + data).slice(-TERMINAL_RAW_BUFFER_CAP),
    }));
    // Forward raw data to xterm.js via batched write callback
    if (getCallback('terminalWrite')) {
      appendPendingTerminalWrite(data);
    }
  },

  clearTerminalBuffer: () => {
    set({ terminalBuffer: '', terminalRawBuffer: '' });
    clearTerminalWriteBatching();
  },

  setTerminalWriteCallback: (cb) => {
    setImperativeCallback('terminalWrite', cb);
  },

  updateInputSettings: (settings) => {
    set((state) => {
      const updated = { ...state.inputSettings, ...settings };
      SecureStore.setItemAsync(STORAGE_KEY_INPUT_SETTINGS, JSON.stringify(updated)).catch(() => {});
      return { inputSettings: updated };
    });
  },

  sendInput: (input, wireAttachments, options) => {
    const { socket, activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'input', data: input };
    if (activeSessionId) payload.sessionId = activeSessionId;
    if (wireAttachments?.length) {
      payload.attachments = wireAttachments;
    }
    if (options?.isVoice) {
      payload.isVoice = true;
    }
    // When the caller pre-generated a client-side messageId for the
    // optimistic UI (via addUserMessage), include it in the wire so the
    // server adopts the same id in its history record. Enables id-based
    // dedup on reconnect replay (issue #2902).
    if (options?.clientMessageId) {
      payload.clientMessageId = options.clientMessageId;
    }
    let result: 'sent' | 'queued' | false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      hapticLight();
      wsSend(socket, payload);
      result = 'sent';
    } else {
      result = enqueueMessage('input', payload);
    }
    // #3899: dismiss any outstanding check-in chip for the active session
    // once the user's input has gone over the wire (or been queued for a
    // pending reconnect). Identical contract to the dashboard `sendInput`
    // clear — if the user replies (with the prefab OR any other text),
    // the chip's purpose is fulfilled.
    if ((result === 'sent' || result === 'queued') && activeSessionId) {
      const ss = get().sessionStates[activeSessionId];
      if (ss?.inactivityWarning) {
        updateSession(activeSessionId, () => ({ inactivityWarning: null }));
      }
    }
    return result;
  },

  sendInterrupt: () => {
    const { socket, activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'interrupt' };
    if (activeSessionId) payload.sessionId = activeSessionId;
    if (socket && socket.readyState === WebSocket.OPEN) {
      hapticMedium();
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('interrupt', payload);
  },

  sendPermissionResponse: (requestId: string, decision: string) => {
    const { socket } = get();
    // allowSession: send immediate 'allow' unblock + register a session rule for auto-approval
    const wireDecision = decision === 'allowSession' ? 'allow' : decision;
    const payload = { type: 'permission_response', requestId, decision: wireDecision };
    let result: 'sent' | 'queued' | false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (wireDecision === 'deny') hapticWarning(); else hapticMedium();
      wsSend(socket, payload);
      result = 'sent';
    } else {
      result = enqueueMessage('permission_response', payload);
    }
    // Auto-switch to the session that owns this prompt (if different from active).
    // Prefer sessionNotifications lookup (covers prompts stored before sessionStates[sid] existed),
    // fall back to scanning sessionStates messages.
    const { activeSessionId, sessionStates, sessionNotifications } = get();
    const notifMatch = sessionNotifications.find((n) => n.requestId === requestId);
    const targetSid = notifMatch?.sessionId
      ?? Object.entries(sessionStates).find(([, ss]) => ss.messages.some((m) => m.requestId === requestId))?.[0];
    if (targetSid && targetSid !== activeSessionId) get().switchSession(targetSid, { haptic: false });
    // For allowSession: send set_permission_rules to register auto-approval for this tool.
    // Skip tools that the server won't accept as auto-allow rules (code execution, network).
    // Also skip if the active provider doesn't support session rules (#3072) — the
    // server would reject the set_permission_rules with "not supported".
    const RULE_ELIGIBLE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
    if (decision === 'allowSession' && socket && socket.readyState === WebSocket.OPEN) {
      const sessionId = targetSid ?? activeSessionId;
      if (sessionId) {
        const ss = sessionStates[sessionId];
        const permMsg = ss?.messages.find((m) => m.requestId === requestId && m.type === 'prompt');
        const permissionTool = permMsg?.tool;
        const sessionInfo = get().sessions.find((s) => s.sessionId === sessionId);
        const provider = sessionInfo?.provider ?? null;
        const providerSupportsRules = !!provider &&
          get().availableProviders.find((p) => p.name === provider)?.capabilities?.sessionRules === true;
        if (permissionTool && RULE_ELIGIBLE_TOOLS.has(permissionTool) && providerSupportsRules) {
          const currentRules = ss?.sessionRules ?? [];
          wsSend(socket, {
            type: 'set_permission_rules',
            sessionId,
            rules: [...currentRules, { tool: permissionTool, decision: 'allow' }],
          });
        }
      }
    }
    return result;
  },

  sendUserQuestionResponse: (
    answer: string | Record<string, string | string[]> | { otherLabel: string; freeformText: string },
    toolUseId?: string,
  ) => {
    const { socket } = get();
    // Three shapes (#4761 multi-question + #4755 Other/freeform parity):
    // - string: legacy single-question / free-text. Wire shape stays
    //   `{ type, answer, toolUseId? }` so older servers keep working.
    // - { otherLabel, freeformText }: single-question Other freeform
    //   path (#4755, mirrors dashboard #4651). Wire `{answer: otherLabel,
    //   freeformText: typedText}` so the server can drive the two-stage
    //   TUI write (Other digit → text-input prompt → freeform text + Enter).
    // - Record<string, string | string[]>: multi-question form (#4761,
    //   mirrors dashboard #4760). Populate `answers` per
    //   UserQuestionResponseSchema AND a string `answer` summary so older
    //   servers reading only `answer` fall through readably.
    //
    // Freeform shape detection is tight (exactly the two named keys, both
    // strings) so a multi-question Record whose keys happen to be those
    // names doesn't get misrouted into the freeform branch. The guard
    // lives in `@chroxy/store-core/freeform-answer` so the dashboard
    // store, the mobile screen layer, and this site all narrow off one
    // shared predicate (#4875).
    const freeform = isFreeformAnswer(answer);
    const isMultiAnswer = !freeform && typeof answer !== 'string';
    const payload: Record<string, unknown> = {
      type: 'user_question_response',
      answer: freeform
        ? answer.otherLabel
        : isMultiAnswer
          ? formatQuestionAnswerSummary(answer as Record<string, string | string[]>)
          : (answer as string),
    };
    if (freeform) {
      payload.freeformText = answer.freeformText;
    } else if (isMultiAnswer) {
      payload.answers = answer;
    }
    if (toolUseId) payload.toolUseId = toolUseId;
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('user_question_response', payload);
  },

  markPromptAnswered: (messageId: string, answer: string) => {
    const now = Date.now();
    updateActiveSession((ss) => ({
      messages: ss.messages.map((m) =>
        m.id === messageId ? { ...m, answered: answer, answeredAt: now } : m
      ),
    }));
  },

  // #4973 — record a multi-question form submission. Stores the
  // comma-joined human-readable summary in `answered` (for chat history
  // and legacy single-question renderers) AND the structured per-question
  // answers map in `answeredAnswers` so the multi-question summary chip
  // can map chosen values back to option labels without re-parsing the
  // delimited summary string.
  markPromptAnsweredMulti: (
    messageId: string,
    answers: Record<string, string | string[]>,
  ) => {
    const now = Date.now();
    const summary = formatQuestionAnswerSummary(answers);
    updateActiveSession((ss) => ({
      messages: ss.messages.map((m) =>
        m.id === messageId
          ? { ...m, answered: summary, answeredAnswers: answers, answeredAt: now }
          : m
      ),
    }));
  },

  markPromptAnsweredByRequestId: (requestId: string, answer: string) => {
    const { sessionStates } = get();
    const now = Date.now();

    // Search all sessions — push-notification path may answer prompts in background sessions
    for (const [sid, ss] of Object.entries(sessionStates)) {
      if (ss.messages.some((m) => m.requestId === requestId)) {
        updateSession(sid, (s) => ({
          messages: s.messages.map((m) =>
            m.requestId === requestId ? { ...m, answered: answer, answeredAt: now } : m
          ),
        }));
        return;
      }
    }

  },

  setModel: (model: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_model', model };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  setPermissionMode: (mode: string) => {
    const { socket, activeSessionId, sessionStates } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const requestId = nextMessageId('perm-mode-req');
      const targetSessionId = activeSessionId ?? null;
      const previousMode = targetSessionId
        ? sessionStates[targetSessionId]?.permissionMode ?? null
        : null;
      // Drop any superseded pending entries for this session — only the
      // latest tap should be allowed to revert state on rejection. This
      // prevents stale rejections from overwriting a newer optimistic mode
      // when the user taps multiple modes in rapid succession.
      clearPendingPermissionModeRequestsForSession(targetSessionId);
      registerPendingPermissionModeRequest(requestId, {
        sessionId: targetSessionId,
        previousMode,
        requestedMode: mode,
      });
      // Optimistically apply locally so the selector reflects the user's
      // choice immediately. Reverted by the error handler if the server
      // rejects with CAPABILITY_NOT_SUPPORTED.
      if (targetSessionId && sessionStates[targetSessionId]) {
        updateSession(targetSessionId, () => ({ permissionMode: mode }));
      }
      const payload: Record<string, unknown> = { type: 'set_permission_mode', mode, requestId };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  setPermissionRules: (rules) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_permission_rules', rules };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  confirmPermissionMode: (mode: string) => {
    const { socket, activeSessionId, sessionStates } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const requestId = nextMessageId('perm-mode-req');
      const targetSessionId = activeSessionId ?? null;
      const previousMode = targetSessionId
        ? sessionStates[targetSessionId]?.permissionMode ?? null
        : null;
      // Drop any superseded pending entries (see setPermissionMode for
      // rationale).
      clearPendingPermissionModeRequestsForSession(targetSessionId);
      registerPendingPermissionModeRequest(requestId, {
        sessionId: targetSessionId,
        previousMode,
        requestedMode: mode,
      });
      if (targetSessionId && sessionStates[targetSessionId]) {
        updateSession(targetSessionId, () => ({ permissionMode: mode }));
      }
      const payload: Record<string, unknown> = {
        type: 'set_permission_mode',
        mode,
        confirmed: true,
        requestId,
      };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
    set({ pendingPermissionConfirm: null });
  },

  cancelPermissionConfirm: () => {
    set({ pendingPermissionConfirm: null });
  },

  resize: (cols, rows) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'resize', cols, rows };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // Directory listing

  setDirectoryListingCallback: (cb) => {
    setImperativeCallback('directoryListing', cb);
  },

  requestDirectoryListing: (path?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'list_directory' };
      if (path) msg.path = path;
      wsSend(socket, msg);
    }
  },

  // File browser

  setFileBrowserCallback: (cb) => {
    setImperativeCallback('fileBrowser', cb);
  },

  setFileContentCallback: (cb) => {
    setImperativeCallback('fileContent', cb);
  },

  requestFileListing: (path?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'browse_files' };
      if (path) msg.path = path;
      wsSend(socket, msg);
    }
  },

  requestFileContent: (path: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'read_file', path });
    }
  },

  setFileWriteCallback: (cb) => {
    setImperativeCallback('fileWrite', cb);
  },

  requestFileWrite: (path: string, content: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'write_file', path, content });
    }
  },

  // Diff viewer

  setDiffCallback: (cb) => {
    setImperativeCallback('diff', cb);
  },

  requestDiff: (base?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'get_diff' };
      if (base) msg.base = base;
      wsSend(socket, msg);
    }
  },

  // Git operations

  setGitStatusCallback: (cb) => { setImperativeCallback('gitStatus', cb); },
  setGitBranchesCallback: (cb) => { setImperativeCallback('gitBranches', cb); },
  setGitStageCallback: (cb) => { setImperativeCallback('gitStage', cb); },
  setGitCommitCallback: (cb) => { setImperativeCallback('gitCommit', cb); },

  requestGitStatus: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_status' });
    }
  },

  requestGitBranches: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_branches' });
    }
  },

  requestGitStage: (paths: string[]) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_stage', files: paths });
    }
  },

  requestGitUnstage: (paths: string[]) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_unstage', files: paths });
    }
  },

  requestGitCommit: (message: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_commit', message });
    }
  },

  fetchProviders: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_providers' });
    }
  },

  fetchSlashCommands: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_slash_commands' });
    }
  },

  fetchCustomAgents: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_agents' });
    }
  },

  // Session actions

  switchSession: (sessionId: string, options?: { serverNotify?: boolean; haptic?: boolean }) => {
    const { socket, activeSessionId, sessionStates } = get();
    const serverNotify = options?.serverNotify ?? true;
    const haptic = options?.haptic ?? true;

    if (sessionId === activeSessionId) return;
    if (haptic) hapticLight();

    // Mark as user-initiated switch so session_switched handler uses session-switch dedup
    if (serverNotify) setPendingSwitchSessionId(sessionId);

    // Optimistically switch active session + dismiss notifications for target session
    const filteredNotifications = get().sessionNotifications.filter(
      (n) => n.sessionId !== sessionId,
    );
    set({ activeSessionId: sessionId, sessionNotifications: filteredNotifications });

    if (serverNotify && socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'switch_session', sessionId });
    }
  },

  // #3611: options-object signature mirrors the dashboard's createSession.
  // Avoids 6+ positional optional args (the previous shape) and makes adding
  // future fields a one-place change. Server's `create_session` handler
  // accepts these fields plus others (e.g. `sandbox`) — see
  // packages/server/src/handlers/session-handlers.js for the full set.
  createSession: ({ name, cwd, worktree, provider, model, permissionMode, environmentId }) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = { type: 'create_session' };
      if (name) msg.name = name;
      if (cwd) msg.cwd = cwd;
      if (worktree) msg.worktree = true;
      if (provider) msg.provider = provider;
      if (model) msg.model = model;
      if (permissionMode) msg.permissionMode = permissionMode;
      if (environmentId) msg.environmentId = environmentId;
      wsSend(socket, msg);
    }
  },

  destroySession: (sessionId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'destroy_session', sessionId });
    }
  },

  renameSession: (sessionId: string, name: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'rename_session', sessionId, name });
    }
  },

  fetchConversationHistory: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ conversationHistoryLoading: true, conversationHistoryError: null });
      wsSend(socket, { type: 'list_conversations' });
      // Safety timeout — clear loading state if server never responds
      setTimeout(() => {
        if (get().conversationHistoryLoading) {
          set({ conversationHistoryLoading: false, conversationHistoryError: 'Request timed out. Check your connection and try again.' });
        }
      }, 10_000);
    } else {
      // Not connected — set error
      set({ conversationHistoryLoading: false, conversationHistoryError: 'Not connected to server.' });
    }
  },

  resumeConversation: (conversationId: string, cwd?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'resume_conversation', conversationId };
      if (cwd) payload.cwd = cwd;
      wsSend(socket, payload);
    }
  },

  searchConversations: (query: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const nonce = ++searchNonce;
      set({ searchLoading: true, searchResults: [], searchQuery: query, searchError: null });
      wsSend(socket, { type: 'search_conversations', query });
      // Timeout to surface error if no response in 15s
      clearTimeout(searchTimeoutId);
      searchTimeoutId = setTimeout(() => {
        if (searchNonce === nonce && get().searchLoading) {
          set({ searchLoading: false, searchError: 'Search timed out. Check your connection and try again.' });
        }
      }, 15000);
    } else {
      // Not connected: clear any in-flight search state and surface error
      clearTimeout(searchTimeoutId);
      searchNonce++;
      set({
        searchLoading: false,
        searchResults: [],
        searchQuery: query,
        searchError: 'Not connected to server.',
      });
    }
  },

  clearSearchResults: () => {
    set({ searchResults: [], searchLoading: false, searchQuery: '', searchError: null });
  },

  requestFullHistory: (sessionId?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'request_full_history' };
      if (sessionId) msg.sessionId = sessionId;
      wsSend(socket, msg);
    }
  },

  createCheckpoint: (name?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'create_checkpoint' };
      if (name) msg.name = name;
      wsSend(socket, msg);
    }
  },

  listCheckpoints: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_checkpoints' });
    }
  },

  restoreCheckpoint: (checkpointId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'restore_checkpoint', checkpointId });
    }
  },

  deleteCheckpoint: (checkpointId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'delete_checkpoint', checkpointId });
    }
  },

  clearPlanState: () => {
    updateActiveSession(() => ({
      isPlanPending: false,
      planAllowedPrompts: [],
    }));
  },

  sendPlanResponse: (sessionId: string, approve: boolean) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const data = approve ? 'Go ahead with the plan' : 'n';
      wsSend(socket, { type: 'input', data, sessionId });
    }
    // Clear plan state for the target session
    if (get().sessionStates[sessionId]) {
      const store = get();
      const sessionState = store.sessionStates[sessionId];
      set({
        sessionStates: {
          ...store.sessionStates,
          [sessionId]: { ...sessionState, isPlanPending: false, planAllowedPrompts: [] },
        },
      });
    }
  },

  dismissServerError: (id: string) => {
    set((state) => ({
      serverErrors: state.serverErrors.filter((e) => e.id !== id),
    }));
  },

  dismissSessionNotification: (id: string) => {
    set((state) => ({
      sessionNotifications: state.sessionNotifications.filter((n) => n.id !== id),
    }));
  },
}));

// Type for the store API used by message-handler
type StoreApi = {
  getState: () => ConnectionState;
  setState: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void;
};

// Wire up the store reference synchronously now that create() has returned
setStore({
  getState: useConnectionStore.getState,
  setState: useConnectionStore.setState as StoreApi['setState'],
});

// Persist session messages, active session, session list when they change
let _prevActiveSessionId: string | null = null;
// Reference-equality cache. Tracking just `messages.length` (the previous
// implementation) missed the case where stream_delta events appended content
// to an existing response message without changing the array length: the new
// content never reached AsyncStorage, and on a cold restart the user saw the
// "Claude" header with an empty body for the most recent response (#3076).
// flushPendingDeltas always produces a new messages-array reference when
// content changes, so reference comparison catches both new entries and
// in-place content updates.
const _prevMessages: Record<string, ChatMessage[]> = {};
let _prevTerminalBufferLen = 0;
let _prevSessions: SessionInfo[] = [];

// Test-only accessor for the persistence subscriber's per-session cache.
// Used by connection-persistence-subscriber.test.ts to verify that entries
// for removed sessions are pruned (#3085). Not for production use.
export const __test_getPrevMessagesCache = (): Record<string, ChatMessage[]> => _prevMessages;
useConnectionStore.subscribe((state) => {
  // Persist active session ID changes
  if (state.activeSessionId !== _prevActiveSessionId) {
    // Flush messages for the previous session before switching (avoids losing debounced writes)
    if (_prevActiveSessionId) {
      const prevSs = state.sessionStates[_prevActiveSessionId];
      if (prevSs) {
        persistSessionMessages(_prevActiveSessionId, prevSs.messages);
        _prevMessages[_prevActiveSessionId] = prevSs.messages;
      }
    }
    _prevActiveSessionId = state.activeSessionId;
    persistActiveSession(state.activeSessionId).catch(() => {});
  }

  // Persist messages for ALL sessions whose message array reference changed.
  // The persister is debounced per-session (500ms) so streaming many deltas
  // collapses into a single write.
  for (const [sessionId, ss] of Object.entries(state.sessionStates)) {
    if (ss.messages !== _prevMessages[sessionId]) {
      _prevMessages[sessionId] = ss.messages;
      persistSessionMessages(sessionId, ss.messages);
    }
  }

  // Prune entries for sessions that no longer exist in state. Without this,
  // _prevMessages held ChatMessage[] references alive forever after a session
  // was removed from sessionStates — the array couldn't be GC'd. Cleanup runs
  // once per subscriber fire (not inside the per-session loop) and only mutates
  // the module-level cache; it does not trigger any persistence writes. (#3085)
  for (const id of Object.keys(_prevMessages)) {
    if (!state.sessionStates[id]) {
      delete _prevMessages[id];
    }
  }

  // Persist session list when it changes (reference equality — catches renames, model changes, etc.)
  if (state.sessions !== _prevSessions) {
    _prevSessions = state.sessions;
    if (state.sessions.length > 0) {
      persistSessionList(state.sessions);
    }
  }

  // Persist terminal buffer changes (debounced internally, only when changed)
  if (state.terminalBuffer.length !== _prevTerminalBufferLen) {
    _prevTerminalBufferLen = state.terminalBuffer.length;
    if (state.terminalBuffer) {
      persistTerminalBuffer(state.terminalBuffer);
    }
  }
});

// Reconnect on app resume from background.
// Clean up previous subscription on Metro hot-reload to prevent duplicate listeners.
if (global.__chroxy_appStateSub) {
  global.__chroxy_appStateSub.remove();
}
// Rate-limit resume-triggered reconnects so rapid foreground/background
// toggles (e.g., switching apps quickly) don't spam connect(). Fixes #2813.
const RESUME_RECONNECT_COOLDOWN_MS = 5000;
let _lastResumeReconnectAt = 0;

export const _appStateSub = AppState.addEventListener('change', (nextState) => {
  // #3404: keep the server in sync with foreground/background state so it
  // can route completion push notifications to backgrounded phones whose
  // sockets are still alive in the OS keepalive grace period.
  const { socket } = useConnectionStore.getState();
  sendClientVisible(socket, isVisibleAppState(nextState));

  if (nextState === 'active') {
    const now = Date.now();
    if (now - _lastResumeReconnectAt < RESUME_RECONNECT_COOLDOWN_MS) {
      return;
    }

    const { connectionPhase, wsUrl, apiToken, userDisconnected, savedConnection } = useConnectionLifecycleStore.getState();

    // Case 1: socket thinks it was connected but is actually stale
    if (connectionPhase === 'connected' && socket && socket.readyState !== WebSocket.OPEN && wsUrl && apiToken) {
      console.log('[ws] App resumed, socket stale — reconnecting');
      _lastResumeReconnectAt = now;
      // #5518: re-evaluate the endpoint on resume — a phone returning to home
      // wifi should switch from the tunnel back to the direct LAN path. Use the
      // saved record when present so the LAN candidate is considered; otherwise
      // fall back to the exact url/token we were connected with.
      if (savedConnection?.url && savedConnection?.token) {
        void useConnectionStore.getState().connectAuto(savedConnection);
      } else {
        useConnectionStore.getState().connect(wsUrl, apiToken);
      }
      return;
    }

    // UX landmine #6: when the phone was asleep long enough that the
    // socket dropped and the phase went to 'disconnected', the old code
    // did nothing — user had to tap Reconnect manually. Now we auto-
    // reconnect if there's a saved connection and the user didn't
    // explicitly disconnect.
    if (connectionPhase === 'disconnected' && !userDisconnected && savedConnection?.url && savedConnection?.token) {
      console.log('[ws] App resumed from disconnected state — auto-reconnecting to saved server');
      _lastResumeReconnectAt = now;
      void useConnectionStore.getState().connectAuto(savedConnection);
    }
  }
});
global.__chroxy_appStateSub = _appStateSub;

// ---------------------------------------------------------------------------
// #5518 — re-evaluate the endpoint on network change.
//
// When the device's network changes (cellular → home wifi, or wifi → wifi as it
// roams), re-run endpoint selection so a phone arriving on the daemon's LAN
// switches from the tunnel to the direct path (and vice-versa on leaving). We
// only act when there's a saved connection the user hasn't explicitly
// disconnected from, and we debounce so a flurry of transition events (which
// expo-network emits) collapses to one reconnect.
// ---------------------------------------------------------------------------
if (global.__chroxy_networkSub) {
  global.__chroxy_networkSub.remove();
}

const NETWORK_CHANGE_COOLDOWN_MS = 5000;
let _lastNetworkReconnectAt = 0;

export const _networkSub = Network.addNetworkStateListener((state) => {
  const isConnected = state.isConnected === true;
  // Only react when the device has connectivity. A drop to offline is handled
  // by the existing socket.onclose reconnect path; we just re-evaluate which
  // endpoint to use once a network is (back) up (cellular→wifi, or wifi roam).
  if (!isConnected) return;

  const now = Date.now();
  if (now - _lastNetworkReconnectAt < NETWORK_CHANGE_COOLDOWN_MS) return;

  const { userDisconnected, savedConnection, connectionPhase } =
    useConnectionLifecycleStore.getState();
  if (userDisconnected || !savedConnection?.url || !savedConnection?.token) return;
  // Don't interrupt an in-flight connect/reconnect attempt.
  if (connectionPhase === 'connecting' || connectionPhase === 'reconnecting') return;

  // Only bother re-selecting when a faster local path could exist for this
  // record — i.e. it carries a verified LAN candidate. Without one, the tunnel
  // is the only option and the existing reconnect logic already covers drops.
  if (!savedConnection.lanUrl || !savedConnection.lanVerified) return;

  console.log('[ws] Network changed — re-evaluating LAN/tunnel endpoint');
  _lastNetworkReconnectAt = now;
  void useConnectionStore.getState().connectAuto(savedConnection, { silent: true });
});
global.__chroxy_networkSub = _networkSub;
