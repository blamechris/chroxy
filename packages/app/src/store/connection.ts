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
  // #6769: occupancy snapshot type (the context meter's only honest input).
  ContextOccupancy,
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
  ContextOccupancy,
  MessageAttachment,
  RestoreCheckpointMode,
  PermissionRule,
  SavedConnection,
  SessionInfo,
  SessionState,
} from './types';
import { stripAnsi, filterThinking, nextMessageId, createEmptySessionState, formatQuestionAnswerSummary } from './utils';
import { selectConnectEndpoint, deriveTunnelUrl, isLanWsUrl } from '../utils/endpoint-selector';
import {
  setStore,
  wsSend,
  sendIfOpen,
  sendClientVisible,
  handleMessage,
  setConnectionContext,
  setEncryptionState,
  resetEncryptionContext,
  prepareEagerKeyExchange,
  getEncryptionState,
  getPendingKeyPair,
  connectionAttemptId,
  bumpConnectionAttemptId,
  disconnectedAttemptId,
  setDisconnectedAttemptId,
  lastConnectedUrl,
  setLastConnectedUrl,
  nextReconnectAttempt,
  pendingPairingId,
  setPendingPairingId,
  setPendingSwitchSessionId,
  resetReplayFlags,
  clearPermissionSplits,
  clearTerminalWriteBatching,
  appendPendingTerminalWrite,
  stopHeartbeat,
  armHandshakeTimer,
  clearHandshakeTimer,
  resetReconnectAttempt,
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
  HEARTBEAT_INTERVAL_MS,
} from './message-handler';
import { CLIENT_CAPABILITIES } from '@chroxy/protocol';
import {
  getWsCloseMessage,
  getHealthCheckErrorMessage,
  // #5968 — seed the cross-session activity reducer state consumed by the mobile
  // MissionControlScreen. PR1 only initializes/resets it; the live feeder is PR2.
  createEmptyActivityState,
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
  // #5555.3 — per-session history cursors for delta replay, sent in `auth`.
  getHistoryCursors,
  // #5555.4 — hard-reset the replay reconcile state on explicit disconnect.
  resetReplayReconcile,
  // #5556 sub-item 4 — shared connect-flow orchestration: the retry ladder, the
  // probe → restart → connect decision tree, and the per-socket reconnect
  // dedup. The app supplies its store writes / Alert give-up / device-id wiring
  // as callbacks. `resolveEndpoint` is the #5597/#5537 LAN/tunnel seam (static).
  runConnectAttempt,
  createReconnectScheduler,
  // #5621 — the shared retry-ladder defaults (was duplicated verbatim here).
  CONNECT_MAX_RETRIES,
  CONNECT_RETRY_DELAYS,
  // #5725 (#5698) — cap the reconnect ladder so it goes terminal (server_down)
  // instead of spinning forever.
  RECONNECT_MAX_RUNG,
  // #5537 — shared LAN→tunnel fast-fallback decision for the reconnect ladder.
  selectReconnectEndpoint,
  // #5938 (epic #5935 slice ③) — optimistic outgoing-queue helpers for the
  // send-while-streaming path. The server is authoritative (it echoes
  // message_queued / message_dequeued, reconciled by the shared dispatch
  // table); these only seed/clear the local bubble so the queued state renders
  // immediately without waiting on the round-trip.
  enqueueOptimisticQueuedMessage,
  removeQueuedMessage,
  type ProbeResult,
  type ConnectEndpoint,
} from '@chroxy/store-core';
import type { InputSettings, QueuedSessionMessage } from '@chroxy/store-core';
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

// #5632 — post-handshake plaintext guard (consensus C3 / Adversary F1).
// Once E2E encryption is established (encState set), every server→client frame
// MUST arrive inside an `encrypted` envelope. The #5614 downgrade gate only
// protects the `auth_ok` handshake frame; without this guard a MITM could still
// inject a forged plaintext app frame (e.g. permission_request) AFTER the
// handshake and have the client act on it. We fail closed exactly like a
// decrypt failure (log + socket.close, no dispatch).
//
// Post-encState cleartext frames fall into three buckets, handled below:
//
//   1. auth_ok / key_exchange_ok — re-entry handshake frames. On a normal
//      connection these arrive while encState is still null, so they never hit
//      this guard. After encState is set, a plaintext copy is a forged
//      re-handshake attempt (a MITM replaying it re-enters the handshake state
//      machine and can clobber connectedClients / myClientId / UI state and
//      trigger a fresh key_exchange re-key — see message-handler.ts). We DROP
//      these silently (log + return, NO dispatch) rather than close, so a
//      forged frame cannot weaponise the guard into a DoS disconnect.
//
//   2. auth_fail / pair_fail — terminal handshake frames the server may
//      legitimately emit cleartext (e.g. a late rejection). These are safe to
//      dispatch — they only surface an error / tear the connection down — so
//      they stay allow-listed and flow through to handleMessage.
//
//   3. everything else (including `error`, which since #5632 the server now
//      sends ENCRYPTED post-handshake) — treated as a downgrade/injection
//      attempt: log + socket.close, no dispatch.
//
// (Encryption-disabled / plaintext sessions never set encState, so the guard is
// inert for them.)
const ENCRYPTED_PHASE_HANDSHAKE_DROP = new Set([
  'auth_ok',
  'key_exchange_ok',
]);
const ENCRYPTED_PHASE_PLAINTEXT_ALLOWLIST = new Set([
  'auth_fail',
  'pair_fail',
]);

// #5555.5 — the close/error-path reconnect delay is no longer a fixed
// constant. Both handlers now climb the shared CONNECT_RETRY_DELAYS ladder
// (from @chroxy/store-core) via the module-level reconnectAttempt counter,
// which resets on `auth_ok`. See scheduleReconnect() below.

// #4771: getWsCloseMessage and getHealthCheckErrorMessage are now
// defined in `packages/store-core/src/ws-errors.ts` and exported from
// the package public entrypoint (`@chroxy/store-core`) so the mobile
// app and dashboard share a single tested mapping. Re-exported here
// for backward compatibility with existing imports from
// `app/src/store/connection`.
export { getWsCloseMessage, getHealthCheckErrorMessage } from '@chroxy/store-core';

export const selectShowSession = (s: ConnectionState): boolean =>
  useConnectionLifecycleStore.getState().connectionPhase !== 'disconnected' || s.viewingCachedSession;

/**
 * #5597 — re-resolve the freshest tunnel URL for a dial that was started against
 * `dialUrl`. The authoritative source is the SecureStore-backed saved
 * connection's `tunnelUrl`, which `applyRotatedTunnelUrl` repoints on a live
 * `tunnel_url_changed` push (or auth_bootstrap re-advertisement). When `dialUrl`
 * is a `wss://` tunnel URL and the record has since rotated to a different
 * tunnel, return the new one so a reconnect/retry stops hammering the dead URL.
 *
 * A `ws://` LAN `dialUrl` is returned unchanged — a rotation only concerns the
 * tunnel endpoint, and the LAN→tunnel failover is handled by
 * {@link resolveEndpointForAttempt} (#5537). Also unchanged when there's no
 * saved record, no tunnel, or the tunnel already matches `dialUrl` (the common
 * no-op case).
 *
 * Scoped to the dial's own credentials: `savedConnection` is only updated on
 * `auth_ok`, so during a manual connect to a DIFFERENT server it still holds the
 * previous server's record. Re-resolving against it would redirect the new dial
 * to the old server's tunnel URL. We therefore only consult the saved record
 * when its token matches `dialToken` (proof it describes this same connection);
 * otherwise the captured `dialUrl` passes through untouched.
 */
function resolveCurrentEndpointUrl(dialUrl: string, dialToken: string): string {
  if (isLanWsUrl(dialUrl)) return dialUrl;
  const saved = useConnectionLifecycleStore.getState().savedConnection;
  if (!saved || saved.token !== dialToken) return dialUrl;
  const tunnelUrl = deriveTunnelUrl(saved);
  return tunnelUrl ?? dialUrl;
}

/**
 * #5597 + #5537 — pick the URL for connect attempt `attempt` (the inner
 * health-check retry index, `_retryCount`), given this connect was started
 * against `dialUrl`. Both re-resolutions read the authoritative saved record:
 *
 *  - #5537 LAN→tunnel fast fallback: when `dialUrl` is a `ws://` LAN URL and the
 *    record has a tunnel, the first `LAN_FALLBACK_THRESHOLD` attempts stay on
 *    LAN (so a momentary wifi blip recovers in place), then attempt
 *    `LAN_FALLBACK_THRESHOLD`+ switches to the tunnel — instead of burning the
 *    whole 5-retry health-check budget hammering the dead LAN host while the
 *    daemon is still reachable over the tunnel. The decision is the shared,
 *    tested `selectReconnectEndpoint`.
 *  - #5597 tunnel rotation: once the URL is the tunnel (either `dialUrl` already
 *    was, or #5537 just switched to it), re-resolve the freshest `tunnelUrl` so
 *    a rotation that landed mid-ladder is dialed, not the dead captured URL.
 *
 * No-op (returns `dialUrl`) when there's no saved record, or when the saved
 * record's token doesn't match `dialToken` — `savedConnection` only updates on
 * `auth_ok`, so a manual connect to a DIFFERENT server still sees the previous
 * server's record; gating on the token prevents redirecting the new dial to the
 * old server's tunnel/LAN endpoints.
 */
function resolveEndpointForAttempt(dialUrl: string, dialToken: string, attempt: number): string {
  const saved = useConnectionLifecycleStore.getState().savedConnection;
  if (!saved || saved.token !== dialToken) return dialUrl;
  const tunnelUrl = deriveTunnelUrl(saved);
  const chosen = selectReconnectEndpoint({
    lastUrl: dialUrl,
    attempt,
    tunnelUrl,
    lastUrlIsLan: isLanWsUrl(dialUrl),
  });
  // If #5537 fell back to (or stayed on) the tunnel, make sure it's the freshest
  // rotated tunnel URL (#5597). A LAN URL we're still retrying passes through.
  return isLanWsUrl(chosen) ? chosen : (tunnelUrl ?? chosen);
}

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
// #6769: occupancy snapshot — the context meter's only input (billing
// contextUsage above must never feed the meter).
export const selectContextOccupancy = (s: ConnectionState): ContextOccupancy | null =>
  activeSession(s)?.contextOccupancy ?? null;
export const selectLastResultCost = (s: ConnectionState): number | null =>
  activeSession(s)?.lastResultCost ?? null;
export const selectLastResultDuration = (s: ConnectionState): number | null =>
  activeSession(s)?.lastResultDuration ?? null;
export const selectIsIdle = (s: ConnectionState): boolean =>
  activeSession(s)?.isIdle ?? true;
// #5938 — the active session's outgoing queue (messages sent mid-turn, awaiting
// flush). Stable empty fallback so an idle/empty session keeps a referentially
// constant value and never churns the selector.
const EMPTY_QUEUED: QueuedSessionMessage[] = [];
export const selectQueuedMessages = (s: ConnectionState): QueuedSessionMessage[] =>
  activeSession(s)?.queuedMessages ?? EMPTY_QUEUED;

// Search request tracking — prevents stale timeout/response races
let searchNonce = 0;
let searchTimeoutId: ReturnType<typeof setTimeout> | undefined;

// Stable device ID persisted across sessions
const STORAGE_KEY_DEVICE_ID = 'chroxy_device_id';
let _cachedDeviceId: string | null = null;
// #5555 — memoize the *in-flight* read, not just the resolved string. The #5555
// prewarm kicks getDeviceId() off at connect() start and `socket.onopen` calls
// it again; on a cold first launch (empty/unavailable storage) caching only the
// resolved value would let the two overlapping calls each pass the empty-cache
// check and generate *different* random IDs (a race onto inconsistent deviceIds
// within one connection). Sharing the promise collapses concurrent callers onto
// a single SecureStore read + single generated id.
let _deviceIdPromise: Promise<string> | null = null;

async function readOrCreateDeviceId(): Promise<string> {
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

function getDeviceId(): Promise<string> {
  if (_cachedDeviceId) return Promise.resolve(_cachedDeviceId);
  // Reuse an in-flight read so the prewarm and the onopen await share one result.
  if (_deviceIdPromise) return _deviceIdPromise;
  _deviceIdPromise = readOrCreateDeviceId();
  // Drop the in-flight handle once settled; the resolved id is now in
  // `_cachedDeviceId`, so the next caller short-circuits at the top. On
  // rejection (it shouldn't — readOrCreateDeviceId never throws) clear it too so
  // a later call can retry rather than replaying a poisoned promise.
  void _deviceIdPromise.finally(() => {
    _deviceIdPromise = null;
  });
  return _deviceIdPromise;
}

/**
 * Test-only: clear the memoized device id (resolved value AND any in-flight
 * read) so a test can exercise a *cold* SecureStore read (e.g. the #5555
 * prewarm-ordering assertion). No-op / harmless in production — nothing calls it
 * outside tests.
 */
export function __resetDeviceIdCacheForTests(): void {
  _cachedDeviceId = null;
  _deviceIdPromise = null;
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

/**
 * #5623 — clear the presence role (`sessionRole` + `primaryClientId`) on
 * every session in the store.
 *
 * Used by both the `socket.onclose` cleanup (transport-level drop) and the
 * user-initiated `disconnect()` path (which nulls `socket.onclose` so the
 * close handler never runs) — same dual-call contract as
 * `clearInactivityWarningsAcrossSessions`. Iterating all sessions matters
 * because a stale "Observing"/driver badge on any session (and the
 * `ObserverBanner`'s `accessibilityRole="alert"` live-region re-announcing
 * it) must not survive the drop. The server re-emits `session_role` on
 * reconnect/re-subscribe, so the correct role re-establishes once the socket
 * is back; a null role in the meantime reads as "unclaimed" (neutral).
 *
 * Pure shape: skips the mutation when no roles are set so we don't churn
 * referential equality.
 */
function clearSessionRolesAcrossSessions(
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
    if (ss && (ss.sessionRole !== null || ss.primaryClientId !== null)) {
      next[id] = { ...ss, sessionRole: null, primaryClientId: null };
      changed = true;
    } else if (ss) {
      next[id] = ss;
    }
  }
  if (changed) set({ sessionStates: next });
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  socket: null,
  queuedMessageCount: 0,
  sessions: [],
  activeSessionId: null,
  sessionStates: {},
  // #6543 (feature B): pulled full redacted tool inputs keyed by requestId.
  permissionInputs: {},
  // #6543 (feature B): server capability map from auth_ok; gates the pre-write diff.
  serverCapabilities: {},
  activity: createEmptyActivityState(),
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
    const { activeSessionId } = get();
    sendIfOpen({ type: 'close_dev_preview', port, sessionId: activeSessionId });
  },

  // Web tasks (Claude Code Web)
  webFeatures: { available: false, remote: false, teleport: false },
  webTasks: [],

  launchWebTask: (prompt: string, cwd?: string) => {
    const payload: Record<string, unknown> = { type: 'launch_web_task', prompt };
    if (cwd) payload.cwd = cwd;
    return sendIfOpen(payload) ? 'sent' : false;
  },

  listWebTasks: () => {
    sendIfOpen({ type: 'list_web_tasks' });
  },

  teleportWebTask: (taskId: string) => {
    sendIfOpen({ type: 'teleport_web_task', taskId });
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
    return sendIfOpen({ type: 'notification_prefs_get' });
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
      // #6310: send first and gate the optimistic mutation on wsSend. On the
      // OPEN→CLOSING TOCTOU window wsSend catches the InvalidStateError and
      // returns false; mutating then returning true would leave a phantom
      // "sent" toggle the server never received (fails closed, no local drift).
      if (!wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { categories: { [category]: enabled } },
      })) return false;
      if (notificationPrefs) {
        set({
          notificationPrefs: {
            ...notificationPrefs,
            categories: { ...notificationPrefs.categories, [category]: enabled },
          },
        });
      }
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
      // #6310: gate the optimistic mutation on the send (closing-socket TOCTOU).
      if (!wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: {
          devices: {
            [deviceKey]: { categories: { [category]: enabled } },
          },
        },
      })) return false;
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
      // #6310: gate the optimistic delete on the send (closing-socket TOCTOU) —
      // an optimistic row removal on a failed send would never reconcile.
      if (!wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { devices: { [deviceKey]: null } },
      })) return false;
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
      // #6310: gate the optimistic mutation on the send (closing-socket TOCTOU).
      if (!wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { quietHours: window },
      })) return false;
      if (notificationPrefs) {
        set({
          notificationPrefs: { ...notificationPrefs, quietHours: window },
        });
      }
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
      // #6310: gate the optimistic mutation on the send (closing-socket TOCTOU).
      if (!wsSend(socket, {
        type: 'notification_prefs_set',
        prefs: { bypassCategories: categories },
      })) return false;
      if (notificationPrefs) {
        set({
          notificationPrefs: { ...notificationPrefs, bypassCategories: categories },
        });
      }
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
  connectAuto: async (
    saved: SavedConnection,
    options?: { silent?: boolean; preferTunnel?: boolean; force?: boolean },
  ) => {
    const selection = await selectConnectEndpoint(saved, { preferTunnel: options?.preferTunnel });
    console.log(`[ws] Endpoint selected: ${selection.path} (${selection.url})`);
    // No-op when the chosen endpoint matches the live connection. Without this
    // guard a network-change event that re-selects the *same* path (LAN probe
    // still answers, or no LAN candidate so it stays on the tunnel) would tear
    // down a healthy socket and re-handshake, disrupting an active session.
    //
    // #5633: the resume zombie-socket path (Case 0) passes `force: true` to skip
    // ONLY this guard. There the socket claims OPEN and the URL is unchanged
    // (tunnel fallback has no health probe), so all three conditions hold and we
    // would no-op — leaving the dead socket in place, the exact failure the
    // liveness fix targets. We still run selectConnectEndpoint above so the
    // endpoint re-resolution (LAN→tunnel fallback, tunnel rotation) is preserved;
    // we just don't let an unchanged URL short-circuit the forced reconnect.
    const { socket } = get();
    const currentUrl = useConnectionLifecycleStore.getState().wsUrl;
    const connected =
      useConnectionLifecycleStore.getState().connectionPhase === 'connected';
    if (
      !options?.force &&
      connected &&
      socket &&
      socket.readyState === WebSocket.OPEN &&
      currentUrl === selection.url
    ) {
      return;
    }
    get().connect(selection.url, saved.token, {
      silent: options?.silent,
      // #5555 — the selector already ran a liveness probe (`/health`) against
      // this exact URL (LAN path only). Thread the fresh result through so
      // connect() doesn't re-check the same host before opening the WS.
      healthPrecheck: selection.healthPrecheck,
    });
  },

  // Initial connection uses bounded retries (CONNECT_MAX_RETRIES) climbing the
  // fixed CONNECT_RETRY_DELAYS ladder ([1000,2000,3000,5000,8000]ms).
  // This prevents infinite loops on bad credentials or missing servers.
  // Auto-reconnect (socket.onclose) calls connect() with _retryCount=0, resetting
  // the retry budget — intentional, since established connections should recover
  // aggressively after transient drops (tunnel blips, server restarts, etc.).
  connect: (
    url: string,
    token: string,
    options?: {
      silent?: boolean;
      _retryCount?: number;
      // #5555 — a fresh `/health` result from connectAuto's endpoint selector.
      // When recent (≤ HEALTH_PRECHECK_MAX_AGE_MS) and `status: 'ok'`, connect()
      // skips its own redundant probe and opens the WS directly. Only ever
      // carries 'ok' (the selector falls back to the tunnel for a restarting /
      // unreachable box), so the restarting-detection path is never bypassed.
      healthPrecheck?: { ts: number; status: 'ok' };
    },
  ) => {
    const _retryCount = options?._retryCount ?? 0;
    const silent = options?.silent ?? false;
    // Honor a precheck only on the first attempt (retries must re-probe), and
    // only when it's recent enough that the host's liveness hasn't gone stale.
    const HEALTH_PRECHECK_MAX_AGE_MS = 2000;
    const freshPrecheck =
      _retryCount === 0 &&
      options?.healthPrecheck?.status === 'ok' &&
      Date.now() - options.healthPrecheck.ts <= HEALTH_PRECHECK_MAX_AGE_MS;

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
    // #6286 — re-dialing over a still-`connected` phase (the resume/network
    // liveness paths, or switching servers while connected) is a RECONNECT, not
    // a fresh connect: `connected → connecting` is an illegal FSM exit and the
    // FSM now rejects it (leaving the phase stuck on the old `connected`). Treat
    // an already-connected phase as a reconnect so the legal `connected →
    // reconnecting` edge is taken. `isReconnect`/`_retryCount` keep their meaning.
    const wasConnectedPhase =
      useConnectionLifecycleStore.getState().connectionPhase === 'connected';
    const phase =
      isReconnect || _retryCount > 0 || wasConnectedPhase ? 'reconnecting' : 'connecting';
    set({ socket: null });
    useConnectionLifecycleStore.getState().setConnectionPhase(phase);
    useConnectionLifecycleStore.getState().setConnectionError(
      // Only clear on fresh user-initiated connections (not retries/reconnects)
      _retryCount === 0 && !isReconnect ? null : useConnectionLifecycleStore.getState().connectionError,
      _retryCount,
    );
    useConnectionLifecycleStore.getState().setUserDisconnected(false);

    if (_retryCount > 0) {
      console.log(`[ws] Connection attempt ${_retryCount + 1}/${CONNECT_MAX_RETRIES + 1}...`);
    }

    // #5555 — prewarm the device ID off the critical path. The `auth` frame in
    // `socket.onopen` awaits getDeviceId() (an async SecureStore read, memoized
    // only after its first call). Kick it off here so the keychain read overlaps
    // the health fetch + WS handshake; by the time onopen fires the cached value
    // resolves instantly. `.catch` swallows — getDeviceId never rejects (it
    // falls back to a generated id) but we keep this defensive so a stray
    // rejection can't surface as an unhandled-promise warning.
    void getDeviceId().catch(() => {});

    // #5555 — fast path: connectAuto's selector already probed `/health` against
    // this exact URL and the result is fresh + ok. Skip connect()'s own pre-WS
    // liveness check below (the `fetch(httpUrl)` GET of the bare origin — the
    // server answers both `/` and `/health`) and open the WS directly so one
    // connect == one round-trip. (Retries and the manual paths carry no
    // precheck, so they still run the full check below — including the
    // `restarting` detection.)
    if (freshPrecheck) {
      if (myAttemptId !== connectionAttemptId) return;
      console.log('[ws] Reusing endpoint-selector health probe, connecting WebSocket...');
      _connectWebSocket();
      return;
    }

    // #5556 sub-item 4 — the HTTP health check / restart-detect / retry-or-
    // give-up decision tree now lives in the shared `runConnectAttempt`. The app
    // supplies the EFFECTS as callbacks (phase store writes, the Alert give-up,
    // the recursion entry point); the algorithm (which branch, when to retry,
    // what delay) is shared with the dashboard. #5621 — consume the shared
    // CONNECT_MAX_RETRIES / CONNECT_RETRY_DELAYS defaults directly instead of
    // re-declaring the ladder verbatim here.
    void runConnectAttempt({
      attempt: _retryCount,
      maxRetries: CONNECT_MAX_RETRIES,
      retryDelays: CONNECT_RETRY_DELAYS,
      // #5597/#5537 seam — re-resolve the endpoint per attempt instead of
      // dialing the closure-captured URL forever:
      //   • #5597: a tunnel rotation that landed mid-ladder (live
      //     `tunnel_url_changed` push, or a URL persisted from a prior session
      //     into `savedConnection.tunnelUrl`) is picked up on the next retry.
      //   • #5537: a dead `ws://` LAN URL fast-falls-back to the tunnel after
      //     LAN_FALLBACK_THRESHOLD health-check retries (keyed on `attempt`),
      //     instead of burning the whole 5-retry budget on the unreachable host.
      // Returns null when the attempt is already superseded so the probe is
      // skipped entirely.
      resolveEndpoint: (attempt): ConnectEndpoint | null => {
        if (myAttemptId !== connectionAttemptId) return null;
        return { url: resolveEndpointForAttempt(url, token, attempt), token };
      },
      isStale: () => myAttemptId !== connectionAttemptId,
      // The HTTP `/health` GET (bare origin — the server answers both `/` and
      // `/health`) with the 5s abort, mapped to a ProbeResult. Probe failures
      // map through getHealthCheckErrorMessage to a 'failed' result; the flow's
      // own reject path is a safety net.
      probe: async (endpoint): Promise<ProbeResult> => {
        const httpUrl = endpoint.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(httpUrl, { method: 'GET', signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          try {
            const body = await res.json();
            console.log('[ws] Health check response:', body.status ?? 'no status field');
            if (body.status === 'restarting') {
              const restartEtaMs = typeof body.restartEtaMs === 'number' ? body.restartEtaMs : null;
              return { kind: 'restarting', restartEtaMs };
            }
            // #6023: the supervisor exhausted its restart budget and is serving a
            // terminal-down health body (#6022/#6130). Stop the ladder now.
            if (body.status === 'down') {
              return { kind: 'terminal_down', reason: typeof body.reason === 'string' ? body.reason : 'supervisor_gave_up' };
            }
          } catch (err) {
            console.log('[ws] Health check body unreadable:', err instanceof Error ? err.message : String(err));
          }
          return { kind: 'ok' };
        } catch (err) {
          console.log(`[ws] Health check failed: ${err instanceof Error ? err.message : String(err)}`);
          return { kind: 'failed', reason: getHealthCheckErrorMessage(err as { name?: string; message?: string }) };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      openSocket: () => {
        console.log('[ws] Health check passed, connecting WebSocket...');
        _connectWebSocket();
      },
      onRestarting: ({ restartEtaMs }) => {
        const currentState = get();
        set({
          shutdownReason: currentState.shutdownReason ?? 'restart',
          restartEtaMs,
          restartingSince: currentState.restartingSince || Date.now(),
        });
        useConnectionLifecycleStore.getState().setConnectionPhase('server_restarting');
        console.log(`[ws] Server is restarting, will retry (attempt ${_retryCount + 1}/${CONNECT_MAX_RETRIES + 1})`);
      },
      onProbeFailed: (reason) => {
        useConnectionLifecycleStore.getState().setConnectionError(reason, _retryCount);
      },
      onTerminalDown: () => {
        // #6023: supervisor gave up — latch the terminal server_down state now
        // (same sticky FSM phase the ladder cap uses, #5725/#5980) instead of
        // climbing the full retry budget. retryConnection() resets it.
        if (myAttemptId !== connectionAttemptId) return;
        console.log('[ws] server served terminal-down (supervisor gave up) — server_down');
        useConnectionLifecycleStore.getState().setConnectionPhase('server_down');
        useConnectionLifecycleStore.getState().setConnectionError('Server appears to be down', 0);
      },
      scheduleRetry: (nextAttempt, delayMs) => {
        console.log(`[ws] Retrying in ${delayMs}ms...`);
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          // #5597/#5537 — re-resolve the URL for the NEXT attempt so a mid-ladder
          // tunnel rotation, or the LAN→tunnel fallback at the threshold, is
          // dialed instead of the dead captured URL.
          get().connect(resolveEndpointForAttempt(url, token, nextAttempt), token, { silent, _retryCount: nextAttempt });
        }, delayMs);
      },
      onRestartGaveUp: () => {
        // #6583 — latch the sticky terminal 'server_down' (like onProbeGaveUp /
        // onTerminalDown) when there's a saved record to reconnect to. A restart that
        // never completes would otherwise fall to 'disconnected' → ConnectScreen
        // remount → mount auto-connect → 'server_restarting' → give up → the same loop.
        // Without a saved record (a first-time connect to a restarting server), fall
        // back to 'disconnected' → the connect form: mount auto-connect no-ops with no
        // saved record (so no loop), and server_down's Reconnect would no-op anyway.
        // The attempt-id guard prevents a stale callback clobbering a fresh 'connecting'.
        if (myAttemptId !== connectionAttemptId) return;
        const hasSaved = !!useConnectionLifecycleStore.getState().savedConnection?.token;
        useConnectionLifecycleStore.getState().setConnectionPhase(hasSaved ? 'server_down' : 'disconnected');
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
      },
      onProbeGaveUp: () => {
        // #6583 — a give-up must NOT land in 'disconnected' when there's a saved
        // record. App.tsx gates ConnectScreen on phase === 'disconnected', and
        // ConnectScreen's mount effect auto-connects whenever a saved record exists
        // — so 'disconnected' remounts ConnectScreen → auto-connect → 'connecting'
        // (unmount) → give up → 'disconnected' → remount → an endless reconnect loop
        // after lock/unlock over a dead server. Latch the STICKY terminal
        // 'server_down' instead (like onGaveUp/onTerminalDown): ConnectScreen stays
        // unmounted and a stable Retry banner shows; recovery comes from the
        // cooldown-gated resume / network-change / user-retry paths.
        //   For a first-time connect that never authenticated there is NO saved
        // record (savedConnection is only set on auth_ok). Mount auto-connect no-ops
        // without one, so 'disconnected' can't loop there — and 'server_down' would
        // strand the user on SessionScreen's server_down UI whose Reconnect
        // (retryConnection) no-ops with no saved record. So fall back to
        // 'disconnected' (→ the connect form) when there's nothing to reconnect to.
        if (myAttemptId !== connectionAttemptId) return;
        const hasSaved = !!useConnectionLifecycleStore.getState().savedConnection?.token;
        useConnectionLifecycleStore.getState().setConnectionPhase(hasSaved ? 'server_down' : 'disconnected');
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
      },
    });

    function _connectWebSocket() {
    // Reset the encryption context as a unit for each new connection (forward
    // secrecy). #6446: doing this through resetEncryptionContext (not
    // field-by-field) also clears pendingSalt + any future field, so nothing
    // leaks across a reconnect or a server switch.
    resetEncryptionContext();
    // #5962 (#5721 parity) — clear any leftover handshake timer from a prior
    // attempt before opening a new socket, so a stale timer can't fire against
    // this fresh attempt.
    clearHandshakeTimer();
    const socket = new WebSocket(url);

    // #3624 (ported from dashboard) — per-socket reconnect scheduler for both
    // onclose and onerror. A single transport drop fires `error` → `close` on
    // most WebSocket implementations, so without dedupe we'd queue two
    // setTimeouts for one underlying failure.
    //
    // A per-socket flag (not phase-only dedupe) is correct here: each new socket
    // gets a fresh scheduler with its dedup flag cleared, so a *new* socket's
    // failure mid-reconnect (when the global phase is already 'reconnecting')
    // can still arm its own retry timer. The flag is bounded to this socket's
    // lifetime; first-write-wins on the reconnecting phase.
    //
    // #5555.5 — the close/error path climbs the same CONNECT_RETRY_DELAYS ladder used by
    // the pre-WS health-check retries (1s → 2s → 3s → 5s → 8s, capped) instead
    // of a fixed 1.5s/2s. The ladder counter is module-level and only resets on
    // `auth_ok`, so a socket that opens but never authenticates keeps backing
    // off; the per-socket dedupe means a paired error → close drop advances the
    // ladder exactly once.
    //
    // #5556 sub-item 4 — the per-socket dedup + ladder-advance + jittered-delay
    // mechanics now live in the shared `createReconnectScheduler`. The app keeps
    // its platform guards in the onclose/onerror CALLERS (below) and reads
    // `reconnectScheduler.scheduled` to gate its first-write-wins phase/error
    // writes.
    const reconnectScheduler = createReconnectScheduler({
      nextRung: nextReconnectAttempt,
      // #5597 — the socket-close reconnect no longer re-dials the closure-
      // captured `url` forever: re-resolve the freshest tunnel URL so a rotation
      // (live `tunnel_url_changed` push / persisted from a prior session) is
      // dialed. The reconnect re-enters connect() with _retryCount=0, so the
      // inner health-check ladder's resolveEndpoint then owns the #5537 LAN→
      // tunnel fast-fallback (keyed on the per-attempt index).
      reconnect: () => get().connect(resolveCurrentEndpointUrl(url, token), token),
      isStale: () => myAttemptId !== connectionAttemptId,
      retryDelays: CONNECT_RETRY_DELAYS,
      // #5725 (#5698) — stop the reconnect ladder after RECONNECT_MAX_RUNG rungs
      // and go terminal (server_down) instead of looping forever. A user-initiated
      // retryConnection() (or an app resume / network-change recovery) resets the
      // counter, so this is not permanent. Mirrors the dashboard (#5724).
      maxRung: RECONNECT_MAX_RUNG,
      onGaveUp: () => {
        // Superseded by a newer attempt — don't clobber it.
        if (myAttemptId !== connectionAttemptId) return;
        console.log('[ws] reconnect ladder exhausted — server appears down');
        useConnectionLifecycleStore.getState().setConnectionPhase('server_down');
        useConnectionLifecycleStore.getState().setConnectionError('Server appears to be down', 0);
      },
    });
    const scheduleReconnect = (): void => { reconnectScheduler.schedule(); };

    socket.onopen = () => {
      // Include device info in auth for multi-client awareness
      const info = getDeviceInfo();
      // #5555 — getDeviceId() is prewarmed at the top of connect(), so this
      // await point resolves instantly (cached) and the auth frame is not gated
      // on a cold SecureStore read. This `.then` stays as the await point.
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
            // #5555 (eager key exchange) — generate this connection's ephemeral
            // keypair + salt now and send them WITH auth. If the server honours
            // the eager path it returns serverPublicKey in auth_ok and the
            // discrete key_exchange RTT is skipped; otherwise (old server /
            // encryption disabled) the fields are ignored and the auth_ok
            // handler falls back to the discrete handshake using the same
            // stashed keypair. Generating eagerly is cheap and harmless even
            // when the server ends up not requiring encryption.
            const eager = prepareEagerKeyExchange();
            // #5555.3 — send per-session history cursors so the server replays
            // only entries newer than what we've applied. Empty on first
            // connect → omitted → full replay (old-client shape).
            const historyCursors = getHistoryCursors();
            socket.send(JSON.stringify({
              type: 'auth',
              token,
              protocolVersion: CLIENT_PROTOCOL_VERSION,
              deviceInfo: { deviceId, ...info },
              capabilities: CLIENT_CAPABILITIES.mobile,
              eagerPublicKey: eager.publicKey,
              eagerSalt: eager.salt,
              ...(Object.keys(historyCursors).length > 0 ? { historyCursors } : {}),
            }));
          }
          // #5962 (#5721 parity) — a handshake frame (auth/pair) went out; arm the
          // handshake timer. If auth_ok / key_exchange_ok never completes within
          // HANDSHAKE_TIMEOUT_MS, drop this half-open socket and hand off to the
          // SAME reconnect ladder a transport drop uses, surfacing "Handshake
          // failed — reconnecting" instead of a silent stall. The success clears
          // live in the auth_ok / key_exchange_ok handlers; teardown clears live in
          // onclose/onerror/disconnect and at the top of the next connect.
          //
          // The timer is a SINGLE global (message-handler `_ctx`), so guard the
          // ARM (not just the fire callback) against a stale/superseded attempt: a
          // late onopen on an old socket must not clear+re-arm the CURRENT
          // attempt's timer and strip its liveness coverage. (onopen also `await`s
          // getDeviceId, widening the window for a late delivery.)
          if (myAttemptId !== connectionAttemptId || disconnectedAttemptId === myAttemptId) return;
          armHandshakeTimer(() => {
            // Superseded by a newer attempt — ignore (mirrors the onclose/onerror
            // stale guard). The current attempt's timer is the only live one.
            if (myAttemptId !== connectionAttemptId) return;
            // User disconnected this attempt — don't auto-reconnect.
            if (disconnectedAttemptId === myAttemptId) return;
            // Null ALL handlers before closing: onclose/onerror so this manual
            // close doesn't double-dispatch (scheduleReconnect owns recovery), AND
            // onmessage so a late auth_ok / key_exchange_ok already in flight on
            // this wedged socket can't mutate store state after we've declared the
            // handshake failed.
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            try { socket.close(); } catch { /* already closing */ }
            set({ socket: null });
            // Mirror the onerror first-write-wins guard so a paired drop can't
            // double-write the phase/error; then hand off to the ladder.
            if (!reconnectScheduler.scheduled) {
              console.log('[ws] Handshake timed out, reconnecting...');
              useConnectionLifecycleStore.getState().setConnectionPhase('reconnecting');
              useConnectionLifecycleStore.getState().setConnectionError('Handshake failed — reconnecting', 0);
            }
            scheduleReconnect();
          });
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
      } else if (encState && ENCRYPTED_PHASE_HANDSHAKE_DROP.has(msg.type)) {
        // #5632 — a plaintext re-handshake frame (auth_ok / key_exchange_ok)
        // after encryption is established. A MITM replaying it re-enters the
        // handshake state machine and can clobber client/UI state or force a
        // re-key. DROP it silently (no dispatch, no close — closing would let a
        // forged frame DoS the connection).
        console.error('[crypto] Dropped plaintext handshake frame after encryption established:', msg.type);
        return;
      } else if (encState && !ENCRYPTED_PHASE_PLAINTEXT_ALLOWLIST.has(msg.type)) {
        // #5632 — encryption is active but this frame is NOT an `encrypted`
        // envelope and NOT a permitted terminal handshake frame. Treat it as a
        // downgrade/injection attempt and fail closed on the same path a decrypt
        // failure takes (log + close, no dispatch).
        console.error('[crypto] Rejected plaintext frame after encryption established:', msg.type);
        socket.close();
        return;
      }
      handleMessage(msg, socketCtx);
    };

    socket.onclose = (event: CloseEvent) => {
      stopHeartbeat();

      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      // #5962 (#5721 parity) — this attempt's socket closed; no handshake left to
      // time. Clear AFTER the stale guard so a late stale-socket close can't
      // cancel the CURRENT attempt's timer. Idempotent if already cleared.
      clearHandshakeTimer();

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
      // #5623: clear the presence role across ALL sessions so a stale
      // "Observing"/driver badge doesn't survive the reconnect gap.
      clearSessionRolesAcrossSessions(set, get);

      // #5725 (#5698) — terminal: the reconnect ladder already gave up
      // (server_down). The PAIRED event of this same transport drop (RN fires
      // error → close, or close → error) must NOT clobber server_down back to
      // reconnecting/disconnected. Since #6286 the FSM itself rejects those
      // illegal exits, so this early-return is belt-and-suspenders — it also
      // skips the scheduleReconnect()/error writes below that the bare phase
      // guard wouldn't.
      if (useConnectionLifecycleStore.getState().connectionPhase === 'server_down') {
        return;
      }
      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated)
      if (wasConnected && disconnectedAttemptId !== myAttemptId) {
        const closeMsg = getWsCloseMessage(event.code);
        console.log(`[ws] Connection closed (code ${event.code}), auto-reconnecting...`);
        useConnectionLifecycleStore.getState().setConnectionPhase('reconnecting');
        // Only set an error when the close code indicates a real problem (null = normal close)
        if (closeMsg !== null) {
          useConnectionLifecycleStore.getState().setConnectionError(closeMsg, 0);
        }
        // #3624 — dedup via the per-socket guard so a paired error → close
        // sequence arms exactly one retry. #5555.5 — delay comes from the
        // CONNECT_RETRY_DELAYS ladder, not a fixed constant.
        scheduleReconnect();
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

      // #5962 (#5721 parity) — clear the handshake timer after the stale guard
      // (this attempt errored; the reconnect ladder takes over).
      clearHandshakeTimer();

      set({ socket: null });

      // UX landmine #8: extract whatever detail we can from the error
      // event. React Native's WebSocket implementation exposes a
      // `message` property on the error event in most cases.
      const detail = (event as unknown as { message?: string })?.message;
      const errorMsg = detail
        ? `Connection error: ${detail}`
        : 'Connection error — server may be unreachable';

      // #5725 (#5698) — terminal server_down is sticky against the paired event
      // of this drop (mirrors the onclose guard above): once the ladder gave up,
      // a close→error (or error after a give-up) must not clobber it back. Since
      // #6286 the FSM rejects the illegal exit too; this early-return remains as
      // belt-and-suspenders (it also skips the scheduleReconnect()/error writes).
      if (useConnectionLifecycleStore.getState().connectionPhase === 'server_down') {
        return;
      }
      // Auto-reconnect on unexpected WS error
      if (disconnectedAttemptId !== myAttemptId) {
        // #3624 — if onclose already armed the retry for this same transport
        // drop (error → close, or close → error), `scheduleReconnect` no-ops and
        // we skip the phase/error writes too. That preserves first-write-wins on
        // connectionError so a close-code-specific banner isn't clobbered by the
        // generic error copy.
        if (!reconnectScheduler.scheduled) {
          console.log(`[ws] WebSocket error (${detail || 'no detail'}), reconnecting...`);
          useConnectionLifecycleStore.getState().setConnectionPhase('reconnecting');
          useConnectionLifecycleStore.getState().setConnectionError(errorMsg, 0);
        }
        scheduleReconnect();
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
    // #5962 (#5721 parity) — user-initiated disconnect nulls socket.onclose
    // below, so the onclose handshake-timer clear never runs; clear it here.
    clearHandshakeTimer();
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
    // #5623: same dual-call contract — user-initiated disconnect nulls
    // socket.onclose above, so the onclose role-clear never runs; mirror
    // it here so a stale "Observing"/driver badge doesn't survive into
    // the next connect.
    clearSessionRolesAcrossSessions(set, get);
    // Reset replay flags in case disconnect happened mid-replay
    resetReplayFlags();
    // #5555.3/.4 — explicit disconnect is a hard reset: drop the replay
    // baseline AND the history cursors so a later connect (possibly to a
    // different server) starts from a full replay. Tunnel-blip RECONNECTS keep
    // cursors (they don't run disconnect(); auth_ok clears only the baseline).
    resetReplayReconcile({ clearCursors: true });
    // Flush and clear any pending delta buffer
    clearDeltaBuffers();
    // Clear permission boundary split tracking
    clearPermissionSplits();
    // Clear terminal write batching
    clearTerminalWriteBatching();
    // Clear the encryption context as a unit (new connection = new keys =
    // forward secrecy). #6446: also clears pendingSalt + any future field.
    resetEncryptionContext();
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
      // #6559 — drop any pulled pre-write-diff inputs on disconnect (they're
      // per-connection; a resolved prompt already self-prunes, this clears the
      // tail if we disconnect mid-prompt).
      permissionInputs: {},
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

  // #5725 (#5698) — user-initiated retry from the terminal `server_down` state
  // (the Reconnect button, app resume, and network-change recovery all route
  // here). Reset the backoff ladder FIRST so the fresh attempt starts at rung 0;
  // otherwise it would immediately re-exhaust the still-maxed counter and give
  // up again on the first failure. Then reconnect to the saved connection
  // (connectAuto re-resolves the freshest LAN/tunnel endpoint). Mirrors the
  // dashboard's retryConnection (#5724).
  retryConnection: () => {
    resetReconnectAttempt();
    const lifecycle = useConnectionLifecycleStore.getState();
    // #5725 — leave the terminal server_down phase explicitly BEFORE dialing.
    // connect() sets 'reconnecting' when re-dialing the same URL (isReconnect),
    // and `server_down -> reconnecting` is an illegal FSM transition. Move to
    // 'connecting' first; clearing the error here keeps the stale "Server
    // appears to be down" banner from leaking into the fresh attempt.
    // #6286 — the FSM now REJECTS illegal transitions instead of applying them,
    // so this user-initiated terminal exit opts in via { force: true }: it is
    // the ONLY deliberately-flagged way to leave a terminal phase.
    if (lifecycle.connectionPhase === 'server_down') {
      lifecycle.transitionPhase('connecting', { force: true });
      lifecycle.setConnectionError(null, 0);
    }
    const saved = lifecycle.savedConnection;
    if (saved?.url && saved?.token) {
      void get().connectAuto(saved, { silent: true });
    }
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
      activity: createEmptyActivityState(),
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

    // #5938 (epic #5935 slice ③) — send-while-streaming: the live turn already
    // owns the thinking indicator + streamingMessageId, so a queued follow-up
    // must NOT re-arm either (that would replace the in-flight turn's spinner
    // and reset its stream id). Instead append the user bubble and seed an
    // optimistic `'pending'` queue entry so it renders with a "Queued" badge
    // immediately; the server's message_queued/message_dequeued (reconciled by
    // the shared dispatch table) flips it to confirmed and clears it on flush.
    // No safety-net timer either — the entry's lifecycle is the queue's, not a
    // stream-stall window. Mirrors the dashboard's addUserMessage({ queued }).
    if (opts?.queued) {
      const activeId = get().activeSessionId;
      if (activeId && get().sessionStates[activeId]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, userMsg],
          queuedMessages: enqueueOptimisticQueuedMessage(ss.queuedMessages ?? [], {
            clientMessageId: userMsg.id,
            text,
            queuedAt: Date.now(),
          }),
        }));
      }
      return;
    }

    // #5633: capture the session this optimistic turn belongs to AT ARM TIME.
    // The old safety net re-read `get().activeSessionId` when the timer FIRED,
    // so switching sessions (or a legitimately slow stream_start on cellular)
    // let it null `streamingMessageId` and wipe the "thinking" indicator for
    // whatever session happened to be active then — the wrong/live turn.
    const armedSessionId = get().activeSessionId;

    updateActiveSession((ss) => ({
      messages: [...filterThinking(ss.messages), userMsg, thinkingMsg],
      streamingMessageId: 'pending',
      // #6302 — record WHICH send owns this 'pending' optimistic turn so a later
      // message_queued only retires it when its clientMessageId matches (the
      // owner check that protects this turn from another client's broadcast
      // queued send in a multi-client session).
      pendingClientMessageId: userMsg.id,
    }));

    // Safety net: if no stream_start arrives, clear the pending state for THIS
    // session. Prefer the server-advertised stream-stall window (#4497/#4766,
    // already plumbed in connection-lifecycle) so the net matches the real
    // server cadence; fall back to 5s when the server doesn't advertise one.
    const stallMs = useConnectionLifecycleStore.getState().streamStallTimeoutMs;
    const safetyNetMs = stallMs && stallMs > 0 ? stallMs : 5000;
    setTimeout(() => {
      if (!armedSessionId) return;
      const ss = get().sessionStates[armedSessionId];
      // Only clear if this exact session is still waiting on the same pending
      // turn — never touch a session that has since started streaming, or a
      // different session the user switched to.
      if (!ss || ss.streamingMessageId !== 'pending') return;
      updateSession(armedSessionId, (s) => ({
        messages: filterThinking(s.messages),
        streamingMessageId: null,
        pendingClientMessageId: null,
      }));
    }, safetyNetMs);
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
      // #6283: socket.readyState can flip OPEN → CLOSING before this synchronous
      // send over a flaky tunnel, so wsSend can throw and return false. Fall
      // through to the offline queue so the frame retries on reconnect instead
      // of leaving a permanently 'sent'-looking bubble that never reached the
      // server.
      result = wsSend(socket, payload) ? 'sent' : enqueueMessage('input', payload);
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

  // #6861 — `#`-prefix composer quick-append. The server owns the target (the
  // session cwd's project CLAUDE.md), so we send only the note text. Like a
  // file mutation this is NOT offline-queued; the confirmation lands via the
  // `append_memory_result` ack (handled in message-handler.ts).
  appendMemory: (note) => {
    const { socket, activeSessionId } = get();
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const payload: Record<string, unknown> = { type: 'append_memory', text: note };
    if (activeSessionId) payload.sessionId = activeSessionId;
    return wsSend(socket, payload) ? 'sent' : false;
  },

  sendInterrupt: () => {
    const { socket, activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'interrupt' };
    if (activeSessionId) payload.sessionId = activeSessionId;
    // #5938 — Stop clears the outgoing queue too (server policy #5936: a
    // deliberate interrupt cancels pending follow-ups rather than auto-firing
    // them). Drop the queued bubbles + entries optimistically so they don't
    // linger as phantom "sent" messages; the server's per-item
    // message_dequeued{interrupted} then no-ops against the cleared queue.
    if (activeSessionId && get().sessionStates[activeSessionId]) {
      const queued = get().sessionStates[activeSessionId].queuedMessages ?? [];
      if (queued.length > 0) {
        const queuedIds = new Set(queued.map((q) => q.clientMessageId).filter((id): id is string => !!id));
        updateSession(activeSessionId, (ss) => ({
          queuedMessages: [],
          messages: ss.messages.filter((m) => !queuedIds.has(m.id)),
        }));
      }
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      hapticMedium();
      // #6308: the socket can flip OPEN → CLOSING before this synchronous send, so
      // wsSend can throw and return false. Fall through to the offline queue so the
      // interrupt retries on reconnect instead of reporting a 'sent' that never
      // reached the server (the optimistic queue-drop above already matches the
      // offline path's behaviour).
      if (wsSend(socket, payload)) return 'sent';
    }
    return enqueueMessage('interrupt', payload);
  },

  // #5938 (#5943) — cancel one still-queued follow-up before it flushes. Unlike
  // sendInput, this is NOT queued offline: the server EXPIRES the outgoing queue
  // when the socket drops, so a buffered cancel would drain into the void on
  // reconnect. Refuse it while disconnected and optimistically drop the local
  // bubble; the server's message_dequeued { reason: 'cancelled' } is idempotent
  // with the removal (handled by the shared dispatch table). Mirrors the
  // dashboard's sendCancelQueued.
  sendCancelQueued: (clientMessageId: string, sessionId?: string) => {
    const { socket, activeSessionId } = get();
    const sid = sessionId ?? activeSessionId;
    if (!(socket && socket.readyState === WebSocket.OPEN)) return false;
    const payload: Record<string, unknown> = { type: 'cancel_queued', clientMessageId };
    if (sid) payload.sessionId = sid;
    hapticLight();
    // #6308: cancel_queued is NOT offline-queueable, so send BEFORE the optimistic
    // drop and bail if the socket threw on a closing send (wsSend → false). Dropping
    // first then failing would strand the server's queued message (it flushes on the
    // next turn) while the local bubble is already gone — an orphaned turn with no
    // recovery path. Leaving the bubble in place keeps the cancel retryable.
    if (!wsSend(socket, payload)) return false;
    if (sid && get().sessionStates[sid]) {
      updateSession(sid, (ss) => ({
        queuedMessages: removeQueuedMessage(ss.queuedMessages ?? [], clientMessageId),
        // #5938 — also drop the optimistic bubble (its id IS the clientMessageId);
        // a cancelled message was never sent, so it must not linger as a phantom
        // "sent" bubble once the queued badge clears.
        messages: ss.messages.filter((m) => m.id !== clientMessageId),
      }));
    }
    return 'sent';
  },

  // #6451 — locally drop an optimistic 'Queued' badge whose send failed outright
  // (wsSend false AND the offline queue full), so the server will never send a
  // message_queued/dequeued to reconcile it. Unlike sendCancelQueued this sends
  // NOTHING (the message never reached the server) — it only clears the stale
  // local badge so it can't linger forever. The user's message bubble is kept so
  // their text stays visible; the caller surfaces a "couldn't send" notice.
  clearOptimisticQueuedMessage: (clientMessageId: string, sessionId?: string) => {
    const sid = sessionId ?? get().activeSessionId;
    if (sid && get().sessionStates[sid]) {
      updateSession(sid, (ss) => ({
        queuedMessages: removeQueuedMessage(ss.queuedMessages ?? [], clientMessageId),
      }));
    }
  },

  sendPermissionResponse: (requestId: string, decision: string, editedInput?: Record<string, string> | null) => {
    const { socket } = get();
    // #5699 — refuse to answer a permission prompt while disconnected, rather
    // than queuing it. The server EXPIRES the pending request the moment the
    // socket drops, so a queued response just drains into the void on reconnect
    // (the request no longer exists) — the user taps Allow and nothing lands.
    // Return false so the prompt stays actionable and the caller can surface
    // clear "not connected" feedback; the answer buttons also gate on
    // connectionPhase in MessageBubble. Mirrors the dashboard #5699 fix.
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // allowSession: send immediate 'allow' unblock + register a session rule for auto-approval
    const wireDecision = decision === 'allowSession' ? 'allow' : decision;
    // #6543 (feature B): the operator's per-hunk edits ride on an approve only,
    // and only when non-empty. The server whitelists which fields it substitutes.
    const payload = {
      type: 'permission_response',
      requestId,
      decision: wireDecision,
      ...(editedInput && Object.keys(editedInput).length > 0 && wireDecision !== 'deny' ? { editedInput } : {}),
    };
    if (wireDecision === 'deny') hapticWarning(); else hapticMedium();
    // #6308: the socket can flip OPEN → CLOSING before this synchronous send, so
    // wsSend can throw and return false. Bail BEFORE marking the prompt answered —
    // otherwise the UI shows "Allowed"/"Denied" while the server (never having seen
    // the frame) auto-denies on timeout. Returning false keeps the prompt actionable,
    // identical to the disconnected guard above (the #5699 contract).
    if (!wsSend(socket, payload)) return false;
    const result: 'sent' | 'queued' | false = 'sent';
    // #6222: mark the prompt ChatMessage `answered` so the shared pending-count
    // derivation (`isLivePermissionPrompt` keys on `m.answered`) clears. Without
    // this, answering from the cross-session SessionNotificationBanner (which
    // calls only sendPermissionResponse) left the prompt counted as pending. The
    // SessionScreen path marks answered with the same decision AFTER this call.
    // Store the canonical decision TOKEN ('allow' | 'deny' | 'allowSession'), not
    // a display label — SettingsScreen/PermissionHistoryScreen tally
    // `m.answered === 'allow' | 'allowAlways' | 'allowSession' | 'deny'`.
    get().markPromptAnsweredByRequestId(requestId, decision);
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

  // #6543 (feature B): pull the full redacted tool input for a pending permission
  // so the mobile prompt can render a per-hunk pre-write diff. The reply is a
  // single `permission_input` handled into `permissionInputs[requestId]`.
  requestPermissionInput: (requestId: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'get_permission_input', requestId });
      return true;
    }
    return false;
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
    // #5699 — like permission responses, an AskUserQuestion answer is tied to a
    // live pending request the server expires on disconnect; queuing it would
    // drain into the void on reconnect. Refuse while disconnected so the form
    // stays actionable and the caller gives clear feedback (the form also gates
    // on connectionPhase in the UI).
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // #6308: the answer is tied to a live pending AskUserQuestion the server expires
    // on disconnect; like sendPermissionResponse, report failure (not 'sent') when
    // wsSend throws on a closing socket so the caller leaves the form actionable
    // rather than marking it answered against a request the server never received.
    return wsSend(socket, payload) ? 'sent' : false;
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
    const { activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'set_model', model };
    if (activeSessionId) payload.sessionId = activeSessionId;
    sendIfOpen(payload);
  },

  setPermissionMode: (mode: string) => {
    const { socket, activeSessionId, sessionStates } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const requestId = nextMessageId('perm-mode-req');
      const targetSessionId = activeSessionId ?? null;
      const previousMode = targetSessionId
        ? sessionStates[targetSessionId]?.permissionMode ?? null
        : null;
      const payload: Record<string, unknown> = { type: 'set_permission_mode', mode, requestId };
      if (activeSessionId) payload.sessionId = activeSessionId;
      // Send first and gate on the result (#6321). On the OPEN→CLOSING TOCTOU
      // window wsSend catches InvalidStateError and returns false — there's no
      // server round-trip, so a CAPABILITY_NOT_SUPPORTED rejection never arrives
      // to revert. Bailing before the optimistic flip + pending registration keeps
      // a failed send from leaving a phantom permissionMode or an orphaned pending
      // request (mirrors the #6309/#6310 send-fail-closed family).
      if (!wsSend(socket, payload)) return;
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
    }
  },

  setPermissionRules: (rules) => {
    const { activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'set_permission_rules', rules };
    if (activeSessionId) payload.sessionId = activeSessionId;
    sendIfOpen(payload);
  },

  // #6771 — replace the durable per-project ("always allow") rule set for the
  // active session's project cwd. Used by the SessionRules screen to REMOVE a
  // persistent rule (send the reduced list). Session rules are left untouched:
  // we resend the current sessionRules alongside so the server's single
  // set_permission_rules handler doesn't clobber them.
  setProjectPermissionRules: (projectRules) => {
    const { activeSessionId, sessionStates } = get();
    const ss = activeSessionId ? sessionStates[activeSessionId] : null;
    // Strip the client-only `persist` marker before echoing rules back — the
    // server's schema (PermissionRuleSchema) accepts only { tool, decision }.
    const bare = (rs?: PermissionRule[]) =>
      (rs ?? []).map((r) => ({ tool: r.tool, decision: r.decision }));
    const payload: Record<string, unknown> = {
      type: 'set_permission_rules',
      rules: bare(ss?.sessionRules),
      projectRules: bare(projectRules),
    };
    if (activeSessionId) payload.sessionId = activeSessionId;
    sendIfOpen(payload);
  },

  // #6824 — enable/disable an already-configured MCP server for the active
  // session (BYOK lane). Broadcast-driven: the server re-emits `mcp_servers`
  // with the new per-server status on success, which the SettingsBar switch
  // reflects — no optimistic mutation, so a rejection just never moves the
  // switch. A `requestId` correlates a rejection in the server log. Gated on
  // the server's `canToggle` flag at the call site (only BYOK sets it).
  setMcpServerEnabled: (server: string, enabled: boolean) => {
    const { activeSessionId } = get();
    const payload: Record<string, unknown> = {
      type: 'set_mcp_server_enabled',
      server,
      enabled,
      requestId: `set-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (activeSessionId) payload.sessionId = activeSessionId;
    sendIfOpen(payload);
  },

  // #6822 — submit a pasted OAuth authorization code for a remote MCP server that
  // reported `oauth-required` (BYOK lane). Broadcast-driven: the server redeems
  // the code, reconnects the server authenticated, and re-emits `mcp_servers`
  // with the new status. No-op for an empty code. The code is a one-time
  // authorization code and is never stored client-side.
  submitMcpAuthCode: (server: string, code: string) => {
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (!trimmed) return;
    const { activeSessionId } = get();
    const payload: Record<string, unknown> = {
      type: 'submit_mcp_auth_code',
      server,
      code: trimmed,
      requestId: `mcp-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (activeSessionId) payload.sessionId = activeSessionId;
    sendIfOpen(payload);
  },

  confirmPermissionMode: (mode: string) => {
    const { socket, activeSessionId, sessionStates } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const requestId = nextMessageId('perm-mode-req');
      const targetSessionId = activeSessionId ?? null;
      const previousMode = targetSessionId
        ? sessionStates[targetSessionId]?.permissionMode ?? null
        : null;
      const payload: Record<string, unknown> = {
        type: 'set_permission_mode',
        mode,
        confirmed: true,
        requestId,
      };
      if (activeSessionId) payload.sessionId = activeSessionId;
      // Send first and gate the optimistic flip + pending registration on it
      // (#6321) — see setPermissionMode. On a failed (closing-socket) send there's
      // no round-trip to reject, so don't leave a phantom permissionMode or an
      // orphaned pending request. The pendingPermissionConfirm dialog is still
      // cleared below regardless (the user did confirm).
      if (wsSend(socket, payload)) {
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
      }
    }
    set({ pendingPermissionConfirm: null });
  },

  cancelPermissionConfirm: () => {
    set({ pendingPermissionConfirm: null });
  },

  resize: (cols, rows) => {
    const { activeSessionId } = get();
    const payload: Record<string, unknown> = { type: 'resize', cols, rows };
    if (activeSessionId) payload.sessionId = activeSessionId;
    sendIfOpen(payload);
  },

  // #5835 / #5987 — live PTY mirror (read-only on mobile in PR1). Opt in/out of
  // a session's terminal_output stream; only opted-in clients receive the mirror
  // (server-side filter), so this is sent when a user-shell terminal is visible
  // and cleared on leave. Best-effort — a closed socket just means no mirror
  // until reconnect (sendIfOpen no-ops when not OPEN). Mirrors the dashboard's
  // subscribeTerminalMirror / requestTerminalResize.
  subscribeTerminalMirror: (sessionId) => {
    if (!sessionId) return;
    sendIfOpen({ type: 'terminal_subscribe', sessionId });
    // #6313: a (re)subscribe is exactly when the viewer may have missed frames
    // (a reconnect mid-stream, or a first subscribe that sees only future bytes).
    // Ask the server to force a fresh repaint so the grid is current. Ordered
    // after terminal_subscribe on the same socket.
    sendIfOpen({ type: 'terminal_resync', sessionId });
  },
  // #6313: manual "refresh terminal" — force the server to repaint the live PTY
  // when the viewer notices a desynced grid (a backpressure-dropped frame the
  // stateless raw-byte mirror can't otherwise recover). Best-effort.
  requestTerminalResync: (sessionId) => {
    if (!sessionId) return;
    sendIfOpen({ type: 'terminal_resync', sessionId });
  },
  unsubscribeTerminalMirror: (sessionId) => {
    if (!sessionId) return;
    sendIfOpen({ type: 'terminal_unsubscribe', sessionId });
  },
  sendTerminalResize: (sessionId, cols, rows) => {
    if (!sessionId || cols <= 0 || rows <= 0) return;
    sendIfOpen({ type: 'terminal_resize', sessionId, cols, rows });
  },

  // #6003 — forward keystrokes from an interactive (user-shell) terminal to the
  // PTY. A single keystroke is a few bytes, but a bracketed paste fires one
  // onData with the whole clipboard, which can exceed TerminalInputSchema's 100k
  // cap — the server would reject and drop that frame. Split into sub-cap frames
  // (the PTY is an ordered byte stream, so splitting is transparent), and never
  // split a UTF-16 surrogate pair across a boundary so an emoji at the seam can't
  // corrupt into lone surrogates. Mirrors the dashboard's sendTerminalInput.
  sendTerminalInput: (sessionId, data) => {
    if (!sessionId || !data) return;
    const MAX = 65536; // comfortably under TerminalInputSchema.data.max(100000)
    if (data.length <= MAX) {
      sendIfOpen({ type: 'terminal_input', sessionId, data });
      return;
    }
    let i = 0;
    while (i < data.length) {
      let end = Math.min(i + MAX, data.length);
      if (end < data.length) {
        const code = data.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      // sendIfOpen returns false when the socket isn't OPEN; bail rather than
      // slicing the rest of a large paste into frames that can't be sent.
      if (!sendIfOpen({ type: 'terminal_input', sessionId, data: data.slice(i, end) })) return;
      i = end;
    }
  },

  // Directory listing

  setDirectoryListingCallback: (cb) => {
    setImperativeCallback('directoryListing', cb);
  },

  requestDirectoryListing: (path?: string) => {
    const msg: Record<string, string> = { type: 'list_directory' };
    if (path) msg.path = path;
    sendIfOpen(msg);
  },

  // File browser

  setFileBrowserCallback: (cb) => {
    setImperativeCallback('fileBrowser', cb);
  },

  setFileContentCallback: (cb) => {
    setImperativeCallback('fileContent', cb);
  },

  requestFileListing: (path?: string) => {
    const msg: Record<string, string> = { type: 'browse_files' };
    if (path) msg.path = path;
    sendIfOpen(msg);
  },

  requestFileContent: (path: string) => {
    sendIfOpen({ type: 'read_file', path });
  },

  setFileWriteCallback: (cb) => {
    setImperativeCallback('fileWrite', cb);
  },

  requestFileWrite: (path: string, content: string) => {
    return sendIfOpen({ type: 'write_file', path, content });
  },

  // Diff viewer

  setDiffCallback: (cb) => {
    setImperativeCallback('diff', cb);
  },

  requestDiff: (base?: string) => {
    const msg: Record<string, string> = { type: 'get_diff' };
    if (base) msg.base = base;
    sendIfOpen(msg);
  },

  // Git operations

  setGitStatusCallback: (cb) => { setImperativeCallback('gitStatus', cb); },
  setGitBranchesCallback: (cb) => { setImperativeCallback('gitBranches', cb); },
  setGitStageCallback: (cb) => { setImperativeCallback('gitStage', cb); },
  setGitCommitCallback: (cb) => { setImperativeCallback('gitCommit', cb); },

  requestGitStatus: () => {
    sendIfOpen({ type: 'git_status' });
  },

  requestGitBranches: () => {
    sendIfOpen({ type: 'git_branches' });
  },

  requestGitStage: (paths: string[]) => {
    return sendIfOpen({ type: 'git_stage', files: paths });
  },

  requestGitUnstage: (paths: string[]) => {
    return sendIfOpen({ type: 'git_unstage', files: paths });
  },

  requestGitCommit: (message: string) => {
    return sendIfOpen({ type: 'git_commit', message });
  },

  fetchProviders: () => {
    sendIfOpen({ type: 'list_providers' });
  },

  fetchSlashCommands: () => {
    sendIfOpen({ type: 'list_slash_commands' });
  },

  fetchCustomAgents: () => {
    sendIfOpen({ type: 'list_agents' });
  },

  // Session actions

  // #5589 / #5281 — explicitly request primary (driver) ownership of a session.
  // `force: true` is an operator-driven take-over that overrides the current
  // owner; without it the server rejects a claim another device holds with a
  // PRIMARY_HELD `session_error` (input_conflict), surfaced as a calm notice.
  // The authoritative role lands via the resulting `session_role` broadcast.
  claimPrimary: (sessionId: string, options?: { force?: boolean }) => {
    sendIfOpen({
      type: 'claim_primary',
      sessionId,
      ...(options?.force ? { force: true } : {}),
    });
  },

  switchSession: (sessionId: string, options?: { serverNotify?: boolean; haptic?: boolean }) => {
    const { activeSessionId } = get();
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

    if (serverNotify) {
      sendIfOpen({ type: 'switch_session', sessionId });
    }
  },

  // #3611: options-object signature mirrors the dashboard's createSession.
  // Avoids 6+ positional optional args (the previous shape) and makes adding
  // future fields a one-place change. Server's `create_session` handler
  // accepts these fields plus others (e.g. `sandbox`) — see
  // packages/server/src/handlers/session-handlers.js for the full set.
  createSession: ({ name, cwd, worktree, provider, model, permissionMode, environmentId }) => {
    const msg: Record<string, unknown> = { type: 'create_session' };
    if (name) msg.name = name;
    if (cwd) msg.cwd = cwd;
    if (worktree) msg.worktree = true;
    if (provider) msg.provider = provider;
    if (model) msg.model = model;
    if (permissionMode) msg.permissionMode = permissionMode;
    if (environmentId) msg.environmentId = environmentId;
    sendIfOpen(msg);
  },

  destroySession: (sessionId: string) => {
    sendIfOpen({ type: 'destroy_session', sessionId });
  },

  renameSession: (sessionId: string, name: string) => {
    sendIfOpen({ type: 'rename_session', sessionId, name });
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
    const payload: Record<string, unknown> = { type: 'resume_conversation', conversationId };
    if (cwd) payload.cwd = cwd;
    sendIfOpen(payload);
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
    const msg: Record<string, string> = { type: 'request_full_history' };
    if (sessionId) msg.sessionId = sessionId;
    sendIfOpen(msg);
  },

  createCheckpoint: (name?: string) => {
    const msg: Record<string, string> = { type: 'create_checkpoint' };
    if (name) msg.name = name;
    sendIfOpen(msg);
  },

  listCheckpoints: () => {
    sendIfOpen({ type: 'list_checkpoints' });
  },

  restoreCheckpoint: (checkpointId: string, mode?: RestoreCheckpointMode) => {
    // #6767: only send `mode` for a non-default choice so the wire matches
    // pre-#6767 for the common 'both' path.
    sendIfOpen(
      mode && mode !== 'both'
        ? { type: 'restore_checkpoint', checkpointId, mode }
        : { type: 'restore_checkpoint', checkpointId },
    );
  },

  deleteCheckpoint: (checkpointId: string) => {
    sendIfOpen({ type: 'delete_checkpoint', checkpointId });
  },

  clearPlanState: () => {
    updateActiveSession(() => ({
      isPlanPending: false,
      planAllowedPrompts: [],
    }));
  },

  sendPlanResponse: (sessionId: string, approve: boolean) => {
    const data = approve ? 'Go ahead with the plan' : 'n';
    sendIfOpen({ type: 'input', data, sessionId });
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
// #5633: timestamp of the most recent transition OUT of the foreground. iOS
// suspends JS while backgrounded, freezing the heartbeat interval, and the
// tunnel/NAT can silently drop the TCP connection. On foreground the socket
// frequently still reports `readyState === OPEN` despite being dead, so for
// ~20s `sendInput` ships into a black hole and reports 'sent'. We measure how
// long we were away and, if it's at least one heartbeat cycle, treat
// `readyState === OPEN` as untrustworthy and proactively reconnect.
let _backgroundedAt = 0;

export const _appStateSub = AppState.addEventListener('change', (nextState) => {
  // #3404: keep the server in sync with foreground/background state so it
  // can route completion push notifications to backgrounded phones whose
  // sockets are still alive in the OS keepalive grace period.
  const { socket } = useConnectionStore.getState();
  sendClientVisible(socket, isVisibleAppState(nextState));

  if (nextState !== 'active') {
    // Record the first transition away from foreground; later inactive→
    // background hops (iOS emits both) must not reset the clock.
    if (_backgroundedAt === 0) _backgroundedAt = Date.now();
    return;
  }

  if (nextState === 'active') {
    const now = Date.now();
    // #5633: snapshot and clear the backgrounded timestamp up-front so every
    // resume path (including the early cooldown return) starts the next cycle
    // clean. A 0 (never backgrounded, e.g. cold start) yields duration 0.
    const backgroundedFor = _backgroundedAt > 0 ? now - _backgroundedAt : 0;
    _backgroundedAt = 0;

    if (now - _lastResumeReconnectAt < RESUME_RECONNECT_COOLDOWN_MS) {
      return;
    }

    const { connectionPhase, wsUrl, apiToken, userDisconnected, savedConnection } = useConnectionLifecycleStore.getState();

    // #5725 (#5698) — the reconnect ladder gave up (terminal `server_down`)
    // while the app was backgrounded; the server is very likely fine now, so a
    // resume is the natural moment to retry (mirrors the dashboard tab-wake
    // recovery, but mobile auto-clears where the laptop stays manual). Reset the
    // ladder + reconnect via retryConnection; skip the zombie-socket logic below.
    if (connectionPhase === 'server_down' && !userDisconnected && savedConnection?.url && savedConnection?.token) {
      console.log('[ws] App resumed while server_down — retrying');
      _lastResumeReconnectAt = now;
      useConnectionStore.getState().retryConnection();
      return;
    }

    // #5633 Case 0 (zombie socket): we believe we're connected, the socket
    // even still claims OPEN, but we were away at least one heartbeat cycle —
    // long enough for iOS to have suspended JS and the connection to have
    // silently died. `readyState` is not trustworthy here, so reconnect
    // proactively rather than letting input fall into a dead socket for ~20s
    // until the next heartbeat pong-timeout notices. The cooldown above (and
    // the reconnect ladder inside connect/connectAuto) prevents storms.
    const longBackground = backgroundedFor >= HEARTBEAT_INTERVAL_MS;
    if (
      connectionPhase === 'connected' &&
      socket &&
      socket.readyState === WebSocket.OPEN &&
      longBackground &&
      !userDisconnected &&
      wsUrl &&
      apiToken
    ) {
      console.log(
        `[ws] App resumed after ${Math.round(backgroundedFor / 1000)}s — socket claims OPEN but may be a zombie; verifying via reconnect`,
      );
      _lastResumeReconnectAt = now;
      if (savedConnection?.url && savedConnection?.token) {
        // #5633: force past connectAuto's "already connected to this URL" no-op
        // guard. The socket claims OPEN and the tunnel URL is unchanged, so
        // without `force` connectAuto would short-circuit and never tear down the
        // zombie socket — making this whole liveness path a no-op. connect()
        // (called inside connectAuto) still bumps the attempt id and neuters +
        // closes the old socket before opening the new one.
        void useConnectionStore.getState().connectAuto(savedConnection, { force: true });
      } else {
        useConnectionStore.getState().connect(wsUrl, apiToken);
      }
      return;
    }

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

  // #5725 (#5698) — the reconnect ladder gave up (terminal `server_down`) before
  // the network dropped/changed; now that connectivity is back, retry with a
  // fresh ladder (mirrors the app-resume recovery). Unlike the LAN-candidate
  // fast-path below, this fires for ANY saved record — a server_down phone that
  // roamed networks must not sit on a stale terminal banner.
  if (connectionPhase === 'server_down') {
    console.log('[ws] Network changed while server_down — retrying');
    _lastNetworkReconnectAt = now;
    void useConnectionStore.getState().retryConnection();
    return;
  }

  // Only bother re-selecting when a faster local path could exist for this
  // record — i.e. it carries a verified LAN candidate. Without one, the tunnel
  // is the only option and the existing reconnect logic already covers drops.
  if (!savedConnection.lanUrl || !savedConnection.lanVerified) return;

  console.log('[ws] Network changed — re-evaluating LAN/tunnel endpoint');
  _lastNetworkReconnectAt = now;
  void useConnectionStore.getState().connectAuto(savedConnection, { silent: true });
});
global.__chroxy_networkSub = _networkSub;
