/**
 * Connection store — Zustand store managing WebSocket connection,
 * session state, and all server communication.
 *
 * This module was split from a single 2850-line file into:
 * - types.ts       — All shared interfaces and type definitions
 * - utils.ts       — Pure utility functions (stripAnsi, filterThinking, etc.)
 * - message-handler.ts — handleMessage() and module-level state
 * - connection.ts   — Store definition and actions (this file)
 *
 * Desktop web port: React Native / Expo dependencies replaced with browser APIs.
 */
import { create } from 'zustand';

// Re-export server registry types
export type { ServerEntry } from './types';

// Re-export all types for backward compatibility
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  ContextUsage,
  ModelInfo,
  SessionInfo,
  DirectoryEntry,
  DirectoryListing,
  FileEntry,
  FileListing,
  FileContent,
  DiffHunkLine,
  DiffHunk,
  DiffFile,
  DiffResult,
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
  InputSettings,
  ServerEntry,
  SessionInfo,
  SessionState,
} from './types';
import {
  loadServerRegistry,
  addServerEntry,
  removeServerEntry,
  updateServerEntry,
  markServerConnected,
} from './server-registry';
import { stripAnsi, filterThinking, nextMessageId, createEmptySessionState, withJitter } from './utils';
import { formatQuestionAnswerSummary } from '../utils/questionAnswerSummary';
import { getAuthToken } from '../utils/auth';
import {
  setStore,
  wsSend,
  sendClientVisible,
  handleMessage,
  setConnectionContext,
  setEncryptionState,
  setPendingKeyPair,
  getEncryptionState,
  connectionAttemptId,
  bumpConnectionAttemptId,
  disconnectedAttemptId,
  setDisconnectedAttemptId,
  lastConnectedUrl,
  setLastConnectedUrl,
  resetReplayFlags,
  clearPermissionSplits,
  clearTerminalWriteBatching,
  appendPendingTerminalWrite,
  stopHeartbeat,
  clearDeltaBuffers,
  clearMessageQueue,
  enqueueMessage,
  updateActiveSession,
  clearSavedCredentials,
  loadConnection,
  CLIENT_PROTOCOL_VERSION,
  registerEvaluatorRequest,
  cancelEvaluatorRequest,
  rejectAllEvaluatorRequests,
  registerTrustGrantRequest,
  clearPendingTrustGrants,
} from './message-handler';
import type { EvaluatorResultPayload } from './types';
import { CLIENT_CAPABILITIES } from '@chroxy/protocol';
import {
  getWsCloseMessage,
  getHealthCheckErrorMessage,
  // #4853: runtime type-guard for `VoiceInputMode`. Used in
  // `loadSavedConnection` below to validate the persisted
  // localStorage blob — keyed off an exhaustive
  // `Record<VoiceInputMode, true>` in store-core, so adding a new mode
  // to the union cannot silently drop here the way a `===` chain would.
  isVoiceInputMode,
  // #4901: shared typed predicate for the AskUserQuestion freeform shape.
  // Replaces the inline 5-condition check that previously duplicated the
  // mobile store's detector (mobile migrated in #4875 / PR #4900). All
  // three call sites (mobile store, mobile screen, dashboard store) now
  // narrow off the same guard, and the `value is OtherFreeformAnswer`
  // narrowing lets the post-detection `as { otherLabel, freeformText }`
  // casts drop out.
  isFreeformAnswer,
  // #5163 (epic #5159): seed the Control Room activity state empty so the
  // reducer can apply snapshots/deltas immutably from the first message.
  createEmptyActivityState,
} from '@chroxy/store-core';
import { decrypt, DIRECTION_SERVER, type EncryptedEnvelope } from './crypto';
// #5184: header cost-badge mode union, default, and runtime guard. Lives in
// a plain `lib/` module (no React dependency) so the store layer doesn't
// import a `.tsx` component; the type, the rehydrate validation, and the
// Settings select all share this one source of truth.
import {
  DEFAULT_COST_BADGE_MODE,
  isCostBadgeMode,
  type CostBadgeMode,
} from '../lib/cost-badge-mode';
import {
  loadPersistedState,
  loadSessionList,
  loadAllSessionMessages,
  persistSessionMessages,
  persistViewMode,
  persistActiveSession,
  persistTerminalBuffer,
  persistSessionList,
  persistActiveServer,
  loadPersistedActiveServer,
  clearPersistedState,
  clearPersistedTerminalBuffer,
  setServerScope,
} from './persistence';

const STORAGE_KEY_INPUT_SETTINGS = 'chroxy_input_settings';

/**
 * Tools eligible for session-scoped auto-approval via the "Allow for Session"
 * button (#2834). Mirrors packages/app/src/store/connection.ts:924 — kept in
 * sync intentionally; bash/exec/network tools intentionally excluded because
 * the server may reject blanket auto-allow rules for them.
 */
const RULE_ELIGIBLE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);

/** Exported for tests and the PermissionPrompt component (#2834). */
export function isRuleEligibleTool(tool: string): boolean {
  return RULE_ELIGIBLE_TOOLS.has(tool);
}

/**
 * Whether a provider supports session-scoped permission rules (#3072).
 * Reads the `sessionRules` capability surfaced by the server's provider_list
 * message. Defaults to false when the provider is unknown so the UI fails
 * closed (don't surface an "Allow for Session" button that the server will
 * reject as "not supported by this provider").
 */
export function isRuleEligibleProvider(
  provider: string | null | undefined,
  availableProviders: { name: string; capabilities?: { sessionRules?: boolean } }[],
): boolean {
  if (!provider) return false;
  const info = availableProviders.find((p) => p.name === provider);
  return info?.capabilities?.sessionRules === true;
}

/**
 * Cap for `resolvedPermissions` to prevent unbounded growth over long sessions (#2838).
 * Exported for tests. LRU eviction: oldest insertion-order entry is dropped when
 * the map exceeds the cap. Re-resolving a requestId bumps it to the most-recent
 * position so repeated resolutions don't thrash eviction.
 */
export const RESOLVED_PERMISSIONS_CAP = 1000;

/**
 * Append `requestId -> decision` to `map`, honouring the cap.
 * Inputs are treated as immutable — a new object is returned. If the requestId
 * is already present we delete-then-reinsert so it becomes the newest entry
 * (recency-ordered, which is what `Object.keys` iteration preserves in modern JS).
 */
export function capResolvedPermissions<T>(
  map: Record<string, T>,
  requestId: string,
  decision: T,
  cap: number = RESOLVED_PERMISSIONS_CAP,
): Record<string, T> {
  const next: Record<string, T> = { ...map };
  // Drop existing entry so re-insertion moves it to the tail (recency bump).
  if (requestId in next) delete next[requestId];
  next[requestId] = decision;
  const keys = Object.keys(next);
  if (keys.length > cap) {
    const excess = keys.length - cap;
    for (let i = 0; i < excess; i++) {
      delete next[keys[i]!];
    }
  }
  return next;
}

/** Read a simple string setting from localStorage with fallback */
function loadPersistedSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

// Stable empty arrays for getActiveSessionState() fallback.
// Inline [] creates new refs each call → useShallow detects false changes → infinite re-render.
const EMPTY_AGENTS: never[] = [];
const EMPTY_PROMPTS: never[] = [];
const EMPTY_MCP_SERVERS: never[] = [];
const EMPTY_DEV_PREVIEWS: never[] = [];
// #4308: stable empty reference for `activeTools` in the flat-state
// fallback. Same `useShallow` stability rationale as the others above.
const EMPTY_ACTIVE_TOOLS: never[] = [];
// #4307: stable empty reference for `pendingBackgroundShells` —
// same `useShallow` stability rationale as the others above.
const EMPTY_PENDING_BACKGROUND_SHELLS: never[] = [];
// #5431: stable empty reference for `transcriptBackgroundTasks` — same
// `useShallow` stability rationale as the others above.
const EMPTY_TRANSCRIPT_BACKGROUND_TASKS: never[] = [];
// #4653: stable empty reference for `interventions` — same `useShallow`
// stability rationale as the others above. SessionIntervention[] in the
// type system; never[] here because the array is provably empty and
// TypeScript widens `never[]` to any element type at the call site.
const EMPTY_INTERVENTIONS: never[] = [];

/** Delay before auto-reconnecting after an unexpected socket close (ms) */
const AUTO_RECONNECT_DELAY = 1500;
/** Delay before reconnecting after a WebSocket error (ms) */
const ERROR_RECONNECT_DELAY = 2000;

/**
 * #3605: Clear in-flight `pendingTrustGrants` arrays from every session.
 *
 * Per-session `pendingTrustGrants` (added in #3588/#3600) tracks the
 * `requestId` of any skill_trust_grant WS request that hasn't received its
 * matching ack/error yet. When the socket drops, the response will never
 * arrive — leaving the entry would keep the SkillsPanel "Trust" button
 * disabled/spinning indefinitely. The matching Map-based correlation in
 * `message-handler.ts` is cleared separately via `clearPendingTrustGrants()`.
 *
 * Returns the cleaned `sessionStates` record. Caller is responsible for
 * applying it via `set({ sessionStates: ... })`.
 */
function clearAllSessionPendingTrustGrants(
  prev: Record<string, SessionState>,
): Record<string, SessionState> {
  const cleaned: Record<string, SessionState> = {};
  for (const sid of Object.keys(prev)) {
    const ss = prev[sid];
    if (!ss) continue;
    if (Array.isArray(ss.pendingTrustGrants) && ss.pendingTrustGrants.length > 0) {
      cleaned[sid] = { ...ss, pendingTrustGrants: [] };
    } else {
      cleaned[sid] = ss;
    }
  }
  return cleaned;
}

export const selectShowSession = (s: ConnectionState): boolean =>
  s.connectionPhase !== 'disconnected' || s.viewingCachedSession;

// Search request tracking — prevents stale timeout/response races
let searchNonce = 0;
let searchTimeoutId: ReturnType<typeof setTimeout> | undefined;

// #5281 ③ PR 2 — one-shot pairing id for the next socket open. When set, the
// auth handshake sends `{type:'pair', pairingId}` instead of `{type:'auth',
// token}`; it's cleared right after that first send so a later reconnect uses
// the issued session token (captured from auth_ok), not the spent pairing id.
let pendingPairingId: string | null = null;

// Stable device ID persisted across sessions
const STORAGE_KEY_DEVICE_ID = 'chroxy_device_id';
let _cachedDeviceId: string | null = null;

function getDeviceId(): string {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    const stored = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
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
    localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
  } catch {
    // Storage not available
  }
  return id;
}

function getDeviceInfo(): { deviceName: string | null; deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown'; platform: string } {
  return {
    deviceName: 'Desktop Browser',
    deviceType: 'desktop' as const,
    platform: 'web',
  };
}

/**
 * #4543: stable per-device key used as the `notification_prefs.devices` map
 * key for THIS browser tab. Wraps `getDeviceId()` so the per-device UI can
 * read the key safely without panicking when storage is broken (private mode
 * + cookies disabled etc.). Returns `null` only when minting failed entirely
 * — UI gates on null to suppress a `devices[null]` patch. In practice we
 * always have a key (in-memory cache mints one even when localStorage write
 * fails), so null is a defensive belt-and-braces branch rather than a hot
 * path.
 *
 * Exported for tests so spec mocks can pin the key without poking localStorage.
 */
export function getCurrentDeviceKey(): string | null {
  try {
    const id = getDeviceId();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// Set server scope before store init so loadPersistedState reads scoped keys
const _initialServerId = loadPersistedActiveServer();
if (_initialServerId) setServerScope(_initialServerId);

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connectionPhase: 'disconnected',
  wsUrl: null,
  apiToken: null,
  socket: null,
  serverRegistry: loadServerRegistry(),
  activeServerId: _initialServerId,
  // True when this dashboard was served by a local daemon with a same-origin
  // token — i.e. a "this machine" connection is available alongside any remote
  // LAN servers in the registry. Lets the ServerPicker pin a local entry so the
  // user can switch local↔remote (desktop LAN-client, #5281 ①.2).
  hasLocalServer: typeof window !== 'undefined' && !!getAuthToken(),
  serverMode: null,
  sessionCwd: null,
  defaultCwd: null,
  serverVersion: null,
  latestVersion: null,
  serverCommit: null,
  serverProtocolVersion: null,
  serverResultTimeoutMs: null,
  // #4497: server-advertised stream-stall inactivity window, threaded to
  // StreamStallChip for the humanised headline.
  streamStallTimeoutMs: null,
  sessions: [],
  activeSessionId: null,
  sessionStates: {},
  // #5163 (epic #5159): Control Room activity tree, fed by the store-core
  // reducer from activity_snapshot / activity_delta.
  activity: createEmptyActivityState(),
  cancellingActivityIds: new Set<string>(),
  // #5175 (epic #5170): Host/Repo Status Control Room snapshot, fed by the
  // host_status_snapshot handler. Null until the first survey lands.
  hostStatus: null,
  hostStatusLoading: false,
  // #5253: Control Room self-hosted runner snapshot, fed by the
  // runner_status_snapshot handler. Null until the first survey lands.
  runnerStatus: null,
  runnerStatusLoading: false,
  // #5499 (epic #5498): Control Room Integrations snapshot, fed by the
  // integration_status_snapshot handler. Null until the first survey lands.
  integrationStatus: null,
  integrationStatusLoading: false,
  // #5500: repo-memory Reindex action — in-flight repo paths + last outcome
  // per repo for inline display (same lifecycle as cancellingActivityIds).
  reindexingRepoPaths: new Set<string>(),
  reindexResults: {},
  claudeReady: false,
  streamingMessageId: null,
  activeModel: null,
  availableProviders: [],
  environments: [],
  pairingRefreshedCount: 0,
  availableModels: [],
  availableModelsProvider: null,
  defaultModelId: null,
  permissionMode: null,
  previousPermissionMode: null,
  availablePermissionModes: [],
  myClientId: null,
  connectedClients: [],
  primaryClientId: null,
  followMode: false,
  activeTheme: loadPersistedSetting('chroxy_persist_theme', 'default'),
  defaultProvider: loadPersistedSetting('chroxy_default_provider', 'claude-sdk'),
  defaultModel: loadPersistedSetting('chroxy_default_model', ''),
  // #5184: header cost-badge display mode. Validated through the badge's
  // own `isCostBadgeMode` guard so a stale / corrupt localStorage value
  // falls back to the default instead of poisoning the union.
  costBadgeMode: (() => {
    const raw = loadPersistedSetting('chroxy_cost_badge_mode', DEFAULT_COST_BADGE_MODE)
    return isCostBadgeMode(raw) ? raw : DEFAULT_COST_BADGE_MODE
  })(),
  // #5206 — whether closing a session tab prompts a confirmation first.
  // Defaults to enabled (string 'true'); only an explicit 'false' disables it,
  // so a missing / corrupt value safely falls back to the protective default.
  confirmSessionClose: loadPersistedSetting('chroxy_confirm_session_close', 'true') !== 'false',
  // #4052: BYOK credentials state. Server-of-truth lives in
  // ~/.chroxy/credentials.json or ANTHROPIC_API_KEY env var; the dashboard
  // mirrors the resolved status (set/missing) + a masked preview. Updates
  // arrive via byok_credentials_status WS messages.
  byokCredentialsStatus: null,
  // #3855: generalized provider-credential state. Server-of-truth lives in
  // ~/.chroxy/credentials.json + env vars + OAuth detection; the dashboard
  // mirrors the masked status snapshot. The raw value is never stored.
  credentialsStatus: null,
  credentialTestResults: {},
  // #4542: per-category notification prefs. Server-of-truth lives in
  // ~/.chroxy/notification-prefs.json; the dashboard mirrors the latest
  // `notification_prefs` snapshot. The Settings panel sends
  // `notification_prefs_get` on open and `notification_prefs_set` on each
  // toggle — the server broadcasts the merged snapshot so other dashboards
  // / mobile clients stay in lockstep.
  notificationPrefs: null,
  // #4543: stable per-device key for THIS browser tab. Resolved once at
  // store init from the same localStorage id used in auth's `deviceInfo`,
  // so the dashboard always addresses the same `devices` map entry across
  // reconnects, tab refreshes, and process restarts.
  currentDeviceKey: getCurrentDeviceKey(),
  connectionError: null,
  connectionRetryCount: 0,
  serverStartupLogs: null,
  latencyMs: null,
  connectionQuality: null,
  logEntries: [],
  serverErrors: [],
  infoNotifications: [],
  sessionNotifications: [],
  sessionNotFoundError: null,
  resolvedPermissions: {},
  serverPhase: null,
  tunnelProgress: null,
  // #5356: exposure snapshot from auth_ok + banner dismissal flag.
  serverExposure: null,
  exposureBannerDismissed: false,
  shutdownReason: null,
  restartEtaMs: null,
  restartingSince: null,
  pendingPermissionConfirm: null,
  slashCommands: [],
  filePickerFiles: null,
  customAgents: [],
  checkpoints: [],
  _directoryListingCallback: null,
  _fileBrowserCallback: null,
  _fileContentCallback: null,
  _gitStatusCallback: null,
  _diffCallback: null,
  conversationHistory: [],
  conversationHistoryLoading: false,
  searchResults: [],
  searchLoading: false,
  searchQuery: '',
  contextUsage: null,
  lastResultCost: null,
  lastResultDuration: null,
  isIdle: true,
  inputSettings: {
    chatEnterToSend: true,
    terminalEnterToSend: false,
    voiceInputMode: 'continuous',
  },
  savedConnection: null,
  userDisconnected: false,
  viewingCachedSession: false,
  viewMode: 'chat',
  messages: [],
  terminalBuffer: '',
  terminalRawBuffer: '',
  _terminalWriteCallback: null,

  closeDevPreview: (port: number) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'close_dev_preview', port, sessionId: activeSessionId });
    }
  },

  // Web tasks (Claude Code Web)
  webFeatures: { available: false, remote: false, teleport: false },
  webTasks: [],

  // #3272: capability map populated from auth_ok. Empty until connected.
  serverCapabilities: {},

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
    if (activeSessionId && (sessionStates[activeSessionId]?.messages.length ?? 0) > 0) {
      set({ viewingCachedSession: true });
    }
  },

  exitCachedSession: () => {
    set({ viewingCachedSession: false });
  },

  setFollowMode: (enabled: boolean) => {
    set({ followMode: enabled });
  },

  setTheme: (themeId: string) => {
    set({ activeTheme: themeId });
    try { localStorage.setItem('chroxy_persist_theme', themeId); } catch { /* noop */ }
  },

  setDefaultProvider: (provider: string) => {
    set({ defaultProvider: provider });
    try { localStorage.setItem('chroxy_default_provider', provider); } catch { /* noop */ }
  },

  setDefaultModel: (model: string) => {
    set({ defaultModel: model });
    try { localStorage.setItem('chroxy_default_model', model); } catch { /* noop */ }
  },

  // #5184: persist the header cost-badge display mode. Mirrors the
  // setTheme / setDefaultProvider pattern — immutable `set` + best-effort
  // localStorage write that swallows quota / private-mode failures.
  setCostBadgeMode: (mode: CostBadgeMode) => {
    set({ costBadgeMode: mode });
    try { localStorage.setItem('chroxy_cost_badge_mode', mode); } catch { /* noop */ }
  },

  // #5206 — toggle the session-close confirmation. Persisted as 'true'/'false'
  // strings to match the loadPersistedSetting string contract.
  setConfirmSessionClose: (enabled: boolean) => {
    set({ confirmSessionClose: enabled });
    try { localStorage.setItem('chroxy_confirm_session_close', enabled ? 'true' : 'false'); } catch { /* noop */ }
  },

  // #4052: BYOK credentials actions. The full key is never stored in the
  // store — only the masked preview from the server's reply. We never
  // round-trip the raw value back to the UI.
  //
  // #4559: each action returns a boolean indicating whether the WS message
  // actually went on the wire. `false` means the socket was closed and the
  // change was silently dropped before this PR — SettingsPanel now surfaces
  // an inline error so the user knows to retry after reconnect.
  refreshByokCredentialsStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'byok_get_credentials_status' });
      return true;
    }
    return false;
  },

  setByokCredentials: (anthropicApiKey: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'byok_set_credentials', anthropicApiKey });
      return true;
    }
    return false;
  },

  clearByokCredentials: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'byok_clear_credentials' });
      return true;
    }
    return false;
  },

  // #3855: generalized provider-credential actions. As with BYOK, the raw
  // value is sent on the wire but NEVER stored in the dashboard — the store
  // only mirrors the masked server reply. Each action returns whether the WS
  // message went on the wire (false = socket closed; caller surfaces an error).
  refreshCredentialsStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'get_credentials_status' });
      return true;
    }
    return false;
  },

  setCredential: (key: string, value: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'set_credential', key, value });
      return true;
    }
    return false;
  },

  deleteCredential: (key: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'delete_credential', key });
      return true;
    }
    return false;
  },

  testCredential: (key: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'test_credential', key });
      return true;
    }
    return false;
  },

  // #5175 (epic #5170): request a Host/Repo Status survey from the server.
  // Sends a `host_status_request`; the reply is a single `host_status_snapshot`
  // handled into `hostStatus`. Flips `hostStatusLoading` so the Refresh button
  // can spin while the survey runs. Returns false (and does NOT set loading)
  // when the socket is closed so the Control Room can render a "not connected"
  // state rather than spinning forever.
  requestHostStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ hostStatusLoading: true });
      wsSend(socket, { type: 'host_status_request' });
      return true;
    }
    return false;
  },

  // #5253: request a self-hosted runner survey. Mirrors requestHostStatus —
  // flips runnerStatusLoading and sends a runner_status_request; the reply is a
  // single runner_status_snapshot handled into runnerStatus. Returns false (and
  // does NOT set loading) when the socket is closed.
  requestRunnerStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ runnerStatusLoading: true });
      wsSend(socket, { type: 'runner_status_request' });
      return true;
    }
    return false;
  },

  // #5499 (epic #5498): request an Integrations survey. Mirrors
  // requestRunnerStatus — flips integrationStatusLoading and sends an
  // integration_status_request; the reply is a single
  // integration_status_snapshot handled into integrationStatus. Returns false
  // (and does NOT set loading) when the socket is closed.
  requestIntegrationStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ integrationStatusLoading: true });
      wsSend(socket, { type: 'integration_status_request' });
      return true;
    }
    return false;
  },

  // #5500 (epic #5498): run the repo-memory Reindex action for one surveyed
  // repo. Clones the sendCancelActivity contract (#5277): tag the request
  // with an opaque requestId the server echoes on the integration_action_ack
  // / INTEGRATION_ACTION_FAILED session_error, and mark the repo pending
  // ONLY when the request is genuinely on the wire — reindex is deliberately
  // NOT queued offline (a reindex that drains seconds later would strand the
  // row "Reindexing…" with no ack ever arriving). The repo's previous inline
  // result is dropped so a stale "✓" can't sit next to the pending state.
  sendRepoMemoryReindex: (repoPath: string): boolean => {
    const { socket } = get();
    if (!repoPath || !socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `reindex-${nextMessageId()}`;
    const pending = new Set(get().reindexingRepoPaths);
    pending.add(repoPath);
    const results = { ...get().reindexResults };
    delete results[repoPath];
    set({ reindexingRepoPaths: pending, reindexResults: results });
    wsSend(socket, { type: 'integration_action', action: 'repo_memory_reindex', repoPath, requestId });
    return true;
  },

  // #4542: notification-prefs round-trip. Requests the current snapshot
  // (on Settings panel open) or patches a single category. The server
  // shallow-merges over the categories map, so a single-key patch never
  // wipes the others.
  //
  // #4559: returns `true` when the WS message was sent, `false` when the
  // socket was closed (no-op). Callers MUST surface an inline error on
  // `false` — pre-#4559, a closed socket silently dropped the patch and
  // the user had no idea why the checkbox refused to stay flipped.
  refreshNotificationPrefs: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'notification_prefs_get' });
      return true;
    }
    return false;
  },

  // #4558: optimistic update. The user's toggle has to feel instant — on
  // a slow cellular → Cloudflare tunnel round-trip the prior server-of-truth
  // behaviour left the checkbox stationary for hundreds of milliseconds
  // until the broadcast landed. We patch `notificationPrefs` locally
  // BEFORE sending the WS message, then rely on the eventual
  // `notification_prefs` broadcast to reconcile — server wins, see the
  // handler in message-handler.ts case 'notification_prefs'.
  //
  // Edge cases:
  //   - notificationPrefs == null  → don't mint a synthetic snapshot. The
  //     UI gates on null and renders the loading hint, so the action only
  //     fires from a checkbox bound to a real snapshot. Still ship the WS
  //     message so the server's reply seeds the snapshot.
  //   - socket closed              → no optimistic patch either. Same
  //     server-of-truth contract as before — without a server to confirm,
  //     a local-only flip would never reconcile and would drift on the
  //     next reconnect snapshot. Return `false` so SettingsPanel can
  //     surface an inline error (#4559).
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

  // #4543: patch a per-device category override. The server's
  // setPrefs (push.js) shallow-merges the inner categories map per device
  // key, so a single-category patch leaves other categories under THIS
  // device — and every OTHER device's entry — untouched. Defensive guards:
  // - empty deviceKey → no-op (we never want a `devices[""]` entry).
  // - socket closed → no-op (the snapshot is the source of truth; we don't
  //   queue, matching `setNotificationPrefsCategory`).
  //
  // #4558: optimistic update — same rationale as setNotificationPrefsCategory.
  // The per-device row's mute checkbox flips immediately; the server's
  // broadcast reconciles. We mirror the server's shallow-merge semantics
  // in the local patch so other devices and other categories under THIS
  // device survive.
  //
  // #4559: returns `true` when sent, `false` for both no-op branches
  // (empty deviceKey OR closed socket). UI surfaces an inline error on
  // `false` for the closed-socket case (the empty-deviceKey branch only
  // fires from defensive paths that already gate on currentDeviceKey).
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

  // #4564: drop an entire per-device entry by sending the null sentinel
  // (`devices: { [deviceKey]: null }`). The server's setPrefs interprets
  // null as "remove this token from the persisted devices map". This is the
  // only way to drain orphan entries left behind when an Expo push token
  // refreshes, the app reinstalls, or a browser tab loses its
  // localStorage device id — without it, the on-disk file grows forever.
  //
  // Defensive guards mirror setNotificationPrefsDevice:
  // - empty deviceKey → no-op (we refuse to ship a `devices[""]` patch).
  // - socket closed   → no-op AND no local mutation. An optimistic delete
  //   on a closed socket would never reconcile and would resurrect on the
  //   next reconnect snapshot, leaving the UI lying to the user.
  //
  // Optimistic local update mirrors setNotificationPrefsDevice: drop the
  // key from the local snapshot immediately so the Settings list row
  // disappears without waiting for the broadcast.
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

  // #4544: global quiet-hours window patch. `null` clears the window;
  // a full window object (start/end/timezone) sets it. The server
  // shallow-merges at the top level, so other fields (categories,
  // bypassCategories, devices) are preserved.
  //
  // #4558: optimistic update — local `quietHours` flips before the
  // broadcast lands so the editor's Save button doesn't visibly lag
  // behind the click.
  //
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

  // #4544: global bypass-category list. The wire sends the full list as a
  // replacement (not a delta), so an empty array maps to "nothing
  // bypasses, not even errors". UI callers should always send the desired
  // final list — toggling one bypass on/off means re-sending the resulting
  // array.
  //
  // #4558: optimistic update — local `bypassCategories` flips before the
  // broadcast lands so the bypass checkboxes feel snappy.
  //
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

  getActiveSessionState: () => {
    const { activeSessionId, sessionStates } = get();
    if (activeSessionId && sessionStates[activeSessionId]) {
      return sessionStates[activeSessionId];
    }
    // Fallback: construct from flat state.
    // IMPORTANT: use the module-level EMPTY_* constants (not inline [])
    // so useShallow sees stable references and avoids infinite re-renders.
    return {
      messages: get().messages,
      streamingMessageId: get().streamingMessageId,
      claudeReady: get().claudeReady,
      activeModel: get().activeModel,
      permissionMode: get().permissionMode,
      contextUsage: get().contextUsage,
      lastResultCost: get().lastResultCost,
      lastResultDuration: get().lastResultDuration,
      sessionCost: null,
      cumulativeUsage: null,
      costThresholdWarning: null,
      isIdle: true,
      lastClientActivityAt: null,
      health: 'healthy' as const,
      // #4879: parity with the BaseSessionState shape; no Stop has been
      // confirmed in the flat-state fallback (session_stopped only fires
      // for known sessions once session_list has populated sessionStates).
      stoppedAt: null,
      stoppedCode: null,
      terminalRawBuffer: get().terminalRawBuffer,
      activeAgents: EMPTY_AGENTS,
      // #4308: parity with the BaseSessionState shape; no live tool tracking
      // in flat-state fallback (only populated once a real SessionState lands).
      activeTools: EMPTY_ACTIVE_TOOLS,
      // #4307: parity with the BaseSessionState shape; no live
      // background-shell tracking in the flat-state fallback.
      pendingBackgroundShells: EMPTY_PENDING_BACKGROUND_SHELLS,
      // #5431: parity — transcript-derived tasks only populate real
      // SessionStates (enriched claude_ready resolves a sessionId).
      transcriptBackgroundTasks: EMPTY_TRANSCRIPT_BACKGROUND_TASKS,
      scheduledWakeup: null,
      isPlanPending: false,
      planAllowedPrompts: EMPTY_PROMPTS,
      primaryClientId: null,
      conversationId: null,
      sessionContext: null,
      mcpServers: EMPTY_MCP_SERVERS,
      devPreviews: EMPTY_DEV_PREVIEWS,
      selectedFilePath: null,
      thinkingLevel: 'default',
      // #3646: always-present, defaulted to `null` (parity with
      // createEmptySessionState).
      pendingEvaluatorClarify: null,
      // #3899: no warning is ever surfaced in the flat-state fallback;
      // inactivity_warning only arrives once SessionStates is populated.
      inactivityWarning: null,
      // #4653: no chroxy intervention is ever surfaced in the flat-state
      // fallback — intervention events are routed by sessionId, which only
      // populates after a session_list snapshot lands.
      interventions: EMPTY_INTERVENTIONS,
    };
  },

  loadSavedConnection: () => {
    const saved = loadConnection();
    if (saved) {
      set({ savedConnection: saved });
    }
    // Load persisted input settings
    try {
      const raw = localStorage.getItem(STORAGE_KEY_INPUT_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Validated, narrowed merge so a stray key in localStorage can't
        // shoehorn arbitrary state into the store. Each field is checked
        // independently because the persisted blob may pre-date #4785 and
        // not include `voiceInputMode`.
        const next: Partial<InputSettings> = {};
        if (typeof parsed.chatEnterToSend === 'boolean') next.chatEnterToSend = parsed.chatEnterToSend;
        if (typeof parsed.terminalEnterToSend === 'boolean') next.terminalEnterToSend = parsed.terminalEnterToSend;
        // #4853: runtime guard keyed off the same exhaustive
        // `Record<VoiceInputMode, true>` map the dashboard `SettingsPanel`
        // change handler uses (#4825). Replaces the previous hand-written
        // `===` chain that silently dropped any new mode added to the union.
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
      const persisted = loadPersistedState();
      const cachedSessions = loadSessionList();
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
        const allMessages = loadAllSessionMessages(sessionIds);
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

  clearSavedConnection: () => {
    clearSavedCredentials();
    set({ savedConnection: null });
  },

  // Initial connection uses bounded retries (MAX_RETRIES) with exponential backoff.
  // This prevents infinite loops on bad credentials or missing servers.
  // Auto-reconnect (socket.onclose) calls connect() with _retryCount=0, resetting
  // the retry budget — intentional, since established connections should recover
  // aggressively after transient drops (tunnel blips, server restarts, etc.).
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number; _pairingId?: string }) => {
    const _retryCount = options?._retryCount ?? 0;
    const silent = options?.silent ?? false;
    // #5281 ③ PR 2 — resolve the pairing id for THIS connect into the closure,
    // consuming the one-shot module global at the top of a fresh connect (NOT on
    // socket open). Consuming here means a pairing connect that never opens
    // (host down) or is superseded by another connect can't leak its armed id
    // into the next, unrelated connect's auth. Retries thread it forward via
    // `_pairingId` so a flaky-but-reachable daemon still pairs.
    const pairingId = _retryCount === 0
      ? (() => { const id = pendingPairingId; pendingPairingId = null; return id; })()
      : (options?._pairingId ?? null);
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];

    // Detect if connecting to a different server — clear old session data + queue
    const currentUrl = get().wsUrl;
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
    // Only clear connectionError on fresh user-initiated connections (not retries/reconnects)
    const errorPatch = _retryCount === 0 && !isReconnect ? { connectionError: null } : {};
    set({ socket: null, connectionPhase: phase, connectionRetryCount: _retryCount, userDisconnected: false, ...errorPatch });

    if (_retryCount > 0) {
      console.log(`[ws] Connection attempt ${_retryCount + 1}/${MAX_RETRIES + 1}...`);
    }

    // HTTP health check before WebSocket — verify server is up.
    // Use root path (/) not the WS path (/ws) — GET /ws returns 404.
    const httpBase = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const httpUrl = new URL('/', httpBase).href;
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
              connectionPhase: 'server_restarting',
              shutdownReason: currentState.shutdownReason ?? 'restart',
              restartEtaMs: healthEta,
              restartingSince: currentState.restartingSince || Date.now(),
            });
            if (_retryCount < MAX_RETRIES) {
              const delay = withJitter(RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)]!);
              setTimeout(() => {
                if (myAttemptId !== connectionAttemptId) return;
                get().connect(url, token, { silent, _retryCount: _retryCount + 1, ...(pairingId ? { _pairingId: pairingId } : {}) });
              }, delay);
            } else {
              set({ connectionPhase: 'disconnected', connectionError: 'Server restart timed out' });
              console.warn(`[chroxy] Connection Failed: The server is still restarting. Try again later.`);
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
        // #4771: shared mapping with the app — AbortError, HTTP 4xx
        // (bad token), HTTP 5xx (server restart), other HTTP, and
        // generic network errors all get distinct copy instead of
        // collapsing 4xx/5xx into the raw status string.
        const reason = getHealthCheckErrorMessage(err);
        set({ connectionError: reason });
        if (_retryCount < MAX_RETRIES) {
          const delay = withJitter(RETRY_DELAYS[_retryCount]!);
          console.log(`[ws] Retrying in ${delay}ms...`);
          setTimeout(() => {
            if (myAttemptId !== connectionAttemptId) return;
            get().connect(url, token, { silent, _retryCount: _retryCount + 1, ...(pairingId ? { _pairingId: pairingId } : {}) });
          }, delay);
        } else {
          set({ connectionPhase: 'disconnected', connectionError: 'Could not reach server' });
          console.warn(`[chroxy] Connection Failed: Could not reach the Chroxy server. Make sure it's running.`);
          void get().clearSavedConnection();
        }
      });

    function _connectWebSocket() {
    // Reset encryption state for each new connection (forward secrecy)
    setEncryptionState(null);
    setPendingKeyPair(null);
    const socket = new WebSocket(url);

    // #3624: shared reconnect scheduler used by both onclose and onerror.
    // Browsers fire `error` → `close` for the same transport drop, so without
    // dedupe we'd queue two setTimeouts for one underlying failure.
    //
    // Why a per-socket flag instead of phase-only dedupe (audit outcome):
    // `connectionPhase: 'reconnecting'` is overloaded — it covers BOTH "timer
    // just armed by this socket's failure" AND "mid-reconnect, a *new* socket
    // is auth-handshaking after a prior drop" (set by `connect()` when
    // `lastConnectedUrl === url`). If the new socket then fails, phase is
    // already 'reconnecting' so phase-only gating would short-circuit and no
    // fresh retry timer would arm — leaving the UI stuck. The per-socket flag
    // is bounded to this socket's lifetime: each new socket gets a fresh
    // scheduler with `reconnectScheduled = false`, so its failure can arm a
    // new timer regardless of the persistent global phase.
    //
    // First-write-wins on `connectionError`: both events carry equally generic
    // messages, so flipping mid-display would just be visual churn.
    let reconnectScheduled = false;
    const scheduleReconnect = (
      reasonText: string,
      errorMessage: string | null,
      delayMs: number,
    ): void => {
      if (reconnectScheduled) return;
      if (get().userDisconnected) return;
      if (disconnectedAttemptId === myAttemptId) return;
      reconnectScheduled = true;
      console.log(`[ws] ${reasonText}, reconnecting...`);
      // #4771: `errorMessage === null` means the close code was 1000
      // (normal server-initiated close — see getWsCloseMessage). Match
      // the mobile app's behaviour and skip updating connectionError so
      // we don't show an "X" banner for a graceful close.
      set({
        connectionPhase: 'reconnecting',
        ...(errorMessage !== null ? { connectionError: errorMessage } : {}),
        connectionRetryCount: 0,
      });
      setTimeout(() => {
        if (myAttemptId !== connectionAttemptId) return;
        // #5281 ③ PR 2 — reconnect with the latest stored token for the active
        // registry server. A paired connection started with an empty token;
        // auth_ok wrote the issued session token back to the registry, so the
        // reconnect must use that, not the stale captured (empty) token.
        const sid = get().activeServerId;
        const reconnectToken = sid
          ? (get().serverRegistry.find((s) => s.id === sid)?.token ?? token)
          : token;
        get().connect(url, reconnectToken);
      }, delayMs);
    };

    socket.onopen = () => {
      // Include device info in auth for multi-client awareness
      const info = getDeviceInfo();
      const deviceId = getDeviceId();
      if (socket.readyState === WebSocket.OPEN) {
        const common = {
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          deviceInfo: { deviceId, ...info },
          capabilities: CLIENT_CAPABILITIES.desktop,
        };
        // #5281 ③ PR 2 — pairing handshake when this connect carries a pairing
        // id (resolved into the closure at connect-start). Otherwise normal
        // token auth. A reconnect carries no pairing id, so it auths with the
        // session token written back to the registry in auth_ok.
        if (pairingId) {
          socket.send(JSON.stringify({ type: 'pair', pairingId, ...common }));
        } else {
          socket.send(JSON.stringify({ type: 'auth', token, ...common }));
        }
      }
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

    socket.onclose = (event?: CloseEvent) => {
      stopHeartbeat();

      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      // #3068: any in-flight evaluator request is now a guaranteed no-op —
      // reject them so awaiters get a fast error instead of waiting 60s for
      // the timeout to fire.
      rejectAllEvaluatorRequests('Connection closed before evaluator response arrived');
      // #3587: drop any pending skill_trust_grant correlations — the
      // matching error (if any) will arrive on a different socket (or
      // never), and a stale toast action would call grantCommunitySkillTrust
      // against a closed socket.
      clearPendingTrustGrants();
      // #3605: also clear the per-session pendingTrustGrants arrays
      // (added in #3588). disconnect() handles user-initiated closes, but
      // an unexpected drop here would otherwise leave the SkillsPanel
      // Trust button stuck across an auto-reconnect.
      const cleanedSessionStates = clearAllSessionPendingTrustGrants(get().sessionStates);

      const wasConnected = get().connectionPhase === 'connected';
      set({ socket: null, sessionStates: cleanedSessionStates });

      // #5277: a dropped socket means any in-flight cancel_activity's ack/failure
      // will never arrive on this socket — clear the pending set so a node can't
      // render "Cancelling…" forever across the reconnect (the tree re-seeds from
      // activity_snapshot on resubscribe).
      if (get().cancellingActivityIds.size > 0) {
        set({ cancellingActivityIds: new Set<string>() });
      }
      // #5500: same contract for in-flight reindex requests — their ack/failure
      // is socket-scoped, so clear the pending rows on a drop. (The server-side
      // index keeps running; the next survey refresh shows its effect.)
      if (get().reindexingRepoPaths.size > 0) {
        set({ reindexingRepoPaths: new Set<string>() });
      }

      // Clear transient streaming/plan state so stale UI doesn't persist
      clearPermissionSplits();
      updateActiveSession((ss) => {
        const patch: Partial<import('./types').SessionState> = {};
        if (ss.streamingMessageId) patch.streamingMessageId = null;
        if (ss.isPlanPending) {
          patch.isPlanPending = false;
          patch.planAllowedPrompts = [];
        }
        // #3188: pendingEvaluatorClarify is explicitly transient — the
        // server re-fires `evaluator_clarify` on the next user_input
        // cycle if the verdict is still clarify. Clearing here keeps the
        // contract: a reconnect drops any in-flight clarify question
        // rather than leaving it on screen with stale state.
        if (ss.pendingEvaluatorClarify) patch.pendingEvaluatorClarify = null;
        // #3899: same contract for the inactivity check-in chip — the
        // server does NOT replay `inactivity_warning` on reconnect, so
        // a chip left over from before the drop would point at stale
        // state. Clear it; if the agent is still quiet post-reconnect,
        // the next soft-timeout firing will re-emit the warning.
        if (ss.inactivityWarning) patch.inactivityWarning = null;
        return Object.keys(patch).length > 0 ? patch : {};
      });

      // Auto-reconnect if the connection dropped unexpectedly (not user-initiated)
      if (wasConnected && !get().userDisconnected && disconnectedAttemptId !== myAttemptId) {
        // #4771: surface close-code-specific copy via the shared mapping
        // — e.g. a 4008 backpressure eviction now reads "Connection
        // dropped — the server was overwhelmed, reconnecting" instead
        // of a generic "Connection lost". `event` is defensively
        // optional because legacy test harnesses invoke
        // `socket.onclose()` with no argument; production browser /
        // WebSocket implementations always pass a CloseEvent.
        //
        // `errorMessage` is forwarded as-is (including null) so a
        // graceful 1000 close doesn't paint a spurious error banner —
        // see the `errorMessage === null` branch in scheduleReconnect.
        // When `event.code` is missing entirely (legacy test mocks),
        // we fall back to the pre-refactor "Connection lost" copy so
        // the existing `MockWebSocket` assertions still pass.
        const code = event?.code;
        const closeMsg = typeof code === 'number' ? getWsCloseMessage(code) : 'Connection lost';
        scheduleReconnect(
          typeof code === 'number' ? `Connection lost (code ${code})` : 'Connection lost',
          closeMsg,
          AUTO_RECONNECT_DELAY,
        );
      } else if (disconnectedAttemptId === myAttemptId || get().userDisconnected) {
        set({ connectionPhase: 'disconnected' });
      } else if (get().connectionPhase !== 'reconnecting') {
        // #3624: in error → close ordering, onerror has already transitioned
        // phase to 'reconnecting' and armed a retry timer. Clobbering to
        // 'disconnected' here would briefly flash the wrong status until
        // the timer fires — preserve 'reconnecting' so the UI stays
        // consistent through the retry.
        set({ connectionPhase: 'disconnected' });
      }
    };

    socket.onerror = () => {
      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      // #3605: an unexpected error means any in-flight skill_trust_grant
      // request will never be acked. Clear both the Map-based correlation
      // (#3587) and the per-session arrays (#3588) so the SkillsPanel
      // Trust button doesn't hang across the reconnect.
      rejectAllEvaluatorRequests('Connection errored before evaluator response arrived');
      clearPendingTrustGrants();
      const cleanedSessionStates = clearAllSessionPendingTrustGrants(get().sessionStates);

      set({ socket: null, sessionStates: cleanedSessionStates });

      // #3624: auto-reconnect on unexpected WS error (skip if user
      // explicitly disconnected). scheduleReconnect's per-socket
      // `reconnectScheduled` flag short-circuits the close → error
      // ordering (onclose already armed the timer); the error → close
      // ordering is covered symmetrically by onclose's `wasConnected`
      // gate (handler defined above).
      scheduleReconnect('WebSocket error', 'Connection error', ERROR_RECONNECT_DELAY);
    };
    } // end _connectWebSocket
  },

  disconnect: () => {
    // Bump attempt ID to cancel any pending health checks / retry timers
    bumpConnectionAttemptId();
    setDisconnectedAttemptId(connectionAttemptId);
    // Clear saved connection so ConnectScreen doesn't auto-reconnect
    setLastConnectedUrl(null);
    stopHeartbeat();
    // #3068: same as the onclose handler — fail any pending evaluator
    // requests fast instead of waiting on the 60s timeout. We do this both
    // here (user-initiated) and in onclose (transport drop) because we null
    // out socket.onclose below to suppress auto-reconnect.
    rejectAllEvaluatorRequests('Disconnected before evaluator response arrived');
    // #3587: paired with rejectAllEvaluatorRequests — clear any pending
    // skill_trust_grant correlations so a stale toast button can't fire
    // against the disconnected socket.
    clearPendingTrustGrants();
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
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
    // #3588: clear in-flight skill_trust_grant requests per session.
    // The WS request would be stale on reconnect anyway, and a stuck
    // entry would leave the SkillsPanel "Pending review" Trust button
    // disabled with no way to retry across the disconnect boundary.
    // #3605: same cleanup also runs in onclose/onerror — see
    // clearAllSessionPendingTrustGrants() docstring.
    const cleanedSessionStates = clearAllSessionPendingTrustGrants(get().sessionStates);
    // Preserve messages, terminalBuffer, sessions, activeSessionId, sessionStates
    set({
      connectionPhase: 'disconnected',
      sessionStates: cleanedSessionStates,
      socket: null,
      serverMode: null,
      sessionCwd: null,
      defaultCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      serverProtocolVersion: null,
      serverResultTimeoutMs: null,
      streamStallTimeoutMs: null,
      claudeReady: false,
      streamingMessageId: null,
      activeModel: null,
      availableProviders: [],
      environments: [],
      pairingRefreshedCount: 0,
      availableModels: [],
      availableModelsProvider: null,
      defaultModelId: null,
      permissionMode: null,
      previousPermissionMode: null,
      availablePermissionModes: [],
      myClientId: null,
      connectedClients: [],
      primaryClientId: null,
      connectionError: null,
      connectionRetryCount: 0,
      latencyMs: null,
      connectionQuality: null,
      logEntries: [],
      serverErrors: [],
      sessionNotifications: [],
      resolvedPermissions: {},
      serverPhase: null,
      tunnelProgress: null,
      // #5356: clear exposure on disconnect so a reconnect against a
      // different server can't show a stale banner.
      serverExposure: null,
      exposureBannerDismissed: false,
      shutdownReason: null,
      restartEtaMs: null,
      restartingSince: null,
      pendingPermissionConfirm: null,
      slashCommands: [],
      filePickerFiles: null,
      customAgents: [],
      checkpoints: [],
      _directoryListingCallback: null,
      _terminalWriteCallback: null,
      contextUsage: null,
      lastResultCost: null,
      lastResultDuration: null,
      webFeatures: { available: false, remote: false, teleport: false },
      webTasks: [],
      // #3272 review: clear advertised capabilities on disconnect so a
      // reconnect against a different (or older) server can't have its
      // UI gates left enabled by stale state. Empty map = fail-closed
      // for any capability-gated affordance.
      serverCapabilities: {},
      savedConnection: null,
      userDisconnected: true,
      viewingCachedSession: false,
      conversationHistory: [],
      conversationHistoryLoading: false,
      searchResults: [],
      searchLoading: false,
      searchQuery: '',
    });
  },

  forgetSession: () => {
    setLastConnectedUrl(null);
    clearPersistedState();
    set({
      messages: [],
      terminalBuffer: '',
      terminalRawBuffer: '',
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      // #5163: drop the Control Room tree on disconnect/forget — a fresh
      // connection re-seeds it from activity_snapshot on subscribe.
      activity: createEmptyActivityState(),
      cancellingActivityIds: new Set<string>(),
      // #5500: drop reindex pending/result state with the rest of the
      // connection-scoped Control Room state.
      reindexingRepoPaths: new Set<string>(),
      reindexResults: {},
      wsUrl: null,
      apiToken: null,
      serverMode: null,
      sessionCwd: null,
      defaultCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      serverProtocolVersion: null,
      serverResultTimeoutMs: null,
      streamStallTimeoutMs: null,
      viewingCachedSession: false,
    });
  },

  /** Reset in-memory session state without clearing persisted data.
   *  Used by switchServer to preserve the old server's cached data. */
  _resetSessionMemory: () => {
    setLastConnectedUrl(null);
    set({
      messages: [],
      terminalBuffer: '',
      terminalRawBuffer: '',
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      // #5163: drop the Control Room tree on disconnect/forget — a fresh
      // connection re-seeds it from activity_snapshot on subscribe.
      activity: createEmptyActivityState(),
      cancellingActivityIds: new Set<string>(),
      // #5500: drop reindex pending/result state with the rest of the
      // connection-scoped Control Room state.
      reindexingRepoPaths: new Set<string>(),
      reindexResults: {},
      wsUrl: null,
      apiToken: null,
      serverMode: null,
      sessionCwd: null,
      defaultCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      serverProtocolVersion: null,
      serverResultTimeoutMs: null,
      streamStallTimeoutMs: null,
      viewingCachedSession: false,
    });
  },

  setViewMode: (mode) => {
    set({ viewMode: mode });
    persistViewMode(mode);
  },

  addMessage: (message) => {
    set((state) => ({
      messages: [
        ...state.messages.filter((m) => m.id !== 'thinking' || message.id === 'thinking'),
        message,
      ],
    }));
  },


  addUserMessage: (text, attachments, opts) => {
    // Use the client-generated messageId as the ChatMessage id when provided
    // so the same id is shared between the optimistic entry, the server's
    // history record, and any live-echo broadcast. Reconnect replay can
    // then dedup by id instead of by (content, timestamp) equality.
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

    // Write user message to terminal buffer for Output view
    if (text) {
      get().appendTerminalData(`\r\n\x1b[33m> ${text}\x1b[0m\r\n\r\n`);
    }

    const activeId = get().activeSessionId;
    if (activeId && get().sessionStates[activeId]) {
      updateActiveSession((ss) => ({
        messages: [...filterThinking(ss.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
      }));
    } else {
      set((state) => ({
        messages: [...filterThinking(state.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
      }));
    }

    // Safety net: if no stream_start arrives, clear pending state after 5 seconds.
    setTimeout(() => {
      if (get().streamingMessageId !== 'pending') return;
      const sid = get().activeSessionId;
      if (sid && get().sessionStates[sid]) {
        updateActiveSession((ss) => ({
          messages: filterThinking(ss.messages),
          streamingMessageId: null,
        }));
      } else {
        set((s) => ({
          messages: filterThinking(s.messages),
          streamingMessageId: null,
        }));
      }
    }, 5000);
  },

  // NOTE: `raw` WS messages don't carry sessionId — terminal data is always routed
  // to the active session's buffer. Background session output goes to the global
  // buffer only. This is a known protocol limitation; proper per-session routing
  // requires sessionId on raw messages (tracked in subscribe_sessions #1104).
  appendTerminalData: (data) => {
    const activeId = get().activeSessionId;
    set((state) => {
      const updates: Record<string, unknown> = {
        terminalBuffer: (state.terminalBuffer + stripAnsi(data)).slice(-50000),
        terminalRawBuffer: (state.terminalRawBuffer + data).slice(-100000),
      };
      // Also update per-session terminal buffer
      if (activeId && state.sessionStates[activeId]) {
        const ss = state.sessionStates[activeId];
        updates.sessionStates = {
          ...state.sessionStates,
          [activeId]: {
            ...ss,
            terminalRawBuffer: (ss.terminalRawBuffer + data).slice(-100000),
          },
        };
      }
      return updates;
    });
    // Forward raw data to xterm.js via batched write callback
    const cb = get()._terminalWriteCallback;
    if (cb) {
      appendPendingTerminalWrite(data);
    }
  },

  clearTerminalBuffer: () => {
    const activeId = get().activeSessionId;
    set((state) => {
      const base: Record<string, unknown> = { terminalBuffer: '', terminalRawBuffer: '' };
      if (activeId && state.sessionStates[activeId]) {
        base.sessionStates = {
          ...state.sessionStates,
          [activeId]: { ...state.sessionStates[activeId], terminalRawBuffer: '' },
        };
      }
      return base;
    });
    clearTerminalWriteBatching();
  },

  setTerminalWriteCallback: (cb) => {
    set({ _terminalWriteCallback: cb });
  },

  updateInputSettings: (settings) => {
    set((state) => {
      const updated = { ...state.inputSettings, ...settings };
      try { localStorage.setItem(STORAGE_KEY_INPUT_SETTINGS, JSON.stringify(updated)); } catch { /* ignore */ }
      return { inputSettings: updated };
    });
  },

  sendInput: (input, wireAttachments, options) => {
    const { socket, activeSessionId } = get();

    // Generate a stable messageId once and use it for both the optimistic
    // UI entry and the wire payload. The server adopts it verbatim as the
    // history entry's messageId, which lets reconnect-replay dedup by id
    // instead of (content, timestamp) equality (issue #2902).
    const clientMessageId = nextMessageId('user');

    // Show user message immediately (optimistic update + thinking indicator).
    // Wire attachments use a different shape than MessageAttachment — pass text only for now.
    get().addUserMessage(input, undefined, { clientMessageId });

    const payload: Record<string, unknown> = { type: 'input', data: input, clientMessageId };
    if (activeSessionId) payload.sessionId = activeSessionId;
    if (wireAttachments?.length) {
      payload.attachments = wireAttachments;
    }
    if (options?.isVoice) {
      payload.isVoice = true;
    }
    let result: 'sent' | 'queued' | false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload);
      result = 'sent';
    } else {
      result = enqueueMessage('input', payload);
    }

    // #3188: clear the inline auto-evaluator clarify prompt once the
    // answer has actually gone over the wire (or been queued for a
    // pending reconnect). Clearing optimistically inside addUserMessage
    // would lose the question if the queue is full and the message is
    // dropped — the operator would be stuck without context to retry.
    //
    // #3899: same idea for an outstanding inactivity warning — once
    // the user's check-in has been sent or queued, dismiss the chip
    // so it doesn't linger while the agent processes the prefab.
    if ((result === 'sent' || result === 'queued') && activeSessionId) {
      const ss = get().sessionStates[activeSessionId];
      if (ss?.pendingEvaluatorClarify || ss?.inactivityWarning) {
        updateActiveSession((curr) => {
          const patch: Partial<SessionState> = {};
          if (curr.pendingEvaluatorClarify) patch.pendingEvaluatorClarify = null;
          if (curr.inactivityWarning) patch.inactivityWarning = null;
          return patch;
        });
      }
    }
    return result;
  },

  sendInterrupt: (sessionId?: string) => {
    const { socket, activeSessionId } = get();
    // #5272: an explicit sessionId (Control Room drill-down) wins over the
    // active session, so an operator can interrupt a repo's session without
    // first making it active.
    const sid = sessionId ?? activeSessionId;
    const payload: Record<string, unknown> = { type: 'interrupt' };
    if (sid) payload.sessionId = sid;
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('interrupt', payload);
  },

  // #5272 (Control Room Phase 2a): cancel one in-flight activity node (a
  // subagent) by its entry id. The server's terminal activity_delta updates the
  // tree; a failure comes back as a session_error (surfaced by the existing
  // handler). cancel_activity is intentionally NOT queued offline — a cancel
  // that drains seconds later races the activity finishing — so we only mark the
  // node "cancelling" when the request is actually on the wire (#5277).
  sendCancelActivity: (activityId: string, sessionId?: string) => {
    const { socket, activeSessionId } = get();
    const sid = sessionId ?? activeSessionId;
    // #5277: tag the request with an opaque requestId the server echoes on the
    // cancel_activity_ack / CANCEL_ACTIVITY_FAILED so the dashboard can correlate.
    const requestId = `cancel-${nextMessageId()}`;
    const payload: Record<string, unknown> = { type: 'cancel_activity', activityId, requestId };
    if (sid) payload.sessionId = sid;
    if (sid && socket && socket.readyState === WebSocket.OPEN) {
      // Only mark "cancelling" once the request is genuinely sent — otherwise an
      // offline send (cancel_activity isn't in QUEUE_TTLS, so enqueue drops it)
      // would strand the node "Cancelling…" with no ack/failure ever arriving.
      // Key by `${sessionId}:${activityId}` — activity ids (toolUseIds) are only
      // unique within a session, so a global activityId-only set would let one
      // session's cancel disable/clear another's identically-ided node (#5277).
      const cancelling = new Set(get().cancellingActivityIds);
      cancelling.add(`${sid}:${activityId}`);
      set({ cancellingActivityIds: cancelling });
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('cancel_activity', payload);
  },

  // #3068 — manual prompt evaluator. Returns a Promise that resolves with the
  // evaluator's result when the server replies, or rejects on disconnect /
  // 60s timeout. The 60s ceiling is generous: an opus + thinking call plus
  // network typically finishes in 5-10s, but we don't want a hung request to
  // leak an entry into the pending Map indefinitely.
  evaluateDraft: (draft: string): Promise<EvaluatorResultPayload> => {
    const { socket, activeSessionId } = get();
    const requestId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<EvaluatorResultPayload>((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to server'));
        return;
      }

      const timeoutId = window.setTimeout(() => {
        cancelEvaluatorRequest(requestId);
        reject(new Error('Evaluator request timed out after 60s'));
      }, 60_000);

      registerEvaluatorRequest(requestId, { resolve, reject, timeoutId });

      const payload: Record<string, unknown> = { type: 'evaluate_draft', draft, requestId };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    });
  },

  sendPermissionResponse: (requestId: string, decision: 'allow' | 'deny' | 'allowSession') => {
    const { socket } = get();
    // allowSession: wire decision is still 'allow' — session-scoped behaviour
    // is implemented client-side via a follow-up set_permission_rules message
    // (the schema only accepts 'allow' | 'allowAlways' | 'deny').
    const wireDecision = decision === 'allowSession' ? 'allow' : decision;
    const payload = { type: 'permission_response', requestId, decision: wireDecision };
    let result: 'sent' | 'queued' | false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload);
      result = 'sent';
    } else {
      result = enqueueMessage('permission_response', payload);
    }
    // Persist the decision in the store so PermissionPrompt renders its
    // answered state across remounts (#2833 — tab switch regression).
    get().markPermissionResolved(requestId, decision);
    // Auto-switch to the session that owns this prompt (if different from active).
    // Prefer sessionNotifications lookup (covers prompts stored before sessionStates[sid] existed),
    // fall back to scanning sessionStates messages.
    const { activeSessionId, sessionStates, sessionNotifications } = get();
    const notifMatch = sessionNotifications.find((n) => n.requestId === requestId);
    const targetSid = notifMatch?.sessionId
      ?? Object.entries(sessionStates).find(([, ss]) => ss.messages.some((m) => m.requestId === requestId))?.[0];
    if (targetSid && targetSid !== activeSessionId) get().switchSession(targetSid);
    // For allowSession: send a follow-up set_permission_rules to register
    // auto-approval for this tool. Skip tools the server won't accept as
    // auto-allow rules (execution/network tools). Mirrors the mobile app
    // pattern at packages/app/src/store/connection.ts:924 (#2834).
    if (decision === 'allowSession' && socket && socket.readyState === WebSocket.OPEN) {
      const sessionId = targetSid ?? activeSessionId;
      if (sessionId) {
        const ss = get().sessionStates[sessionId];
        const permMsg = ss?.messages.find((m) => m.requestId === requestId && m.type === 'prompt');
        const permissionTool = permMsg?.tool;
        if (permissionTool && RULE_ELIGIBLE_TOOLS.has(permissionTool)) {
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

  markPermissionResolved: (requestId: string, decision: 'allow' | 'deny' | 'allowSession') => {
    set((state) => ({
      // #2838: cap map size to prevent unbounded growth across long sessions.
      resolvedPermissions: capResolvedPermissions(state.resolvedPermissions, requestId, decision),
    }));
  },

  sendUserQuestionResponse: (
    answer: string | Record<string, string | string[]> | { otherLabel: string; freeformText: string },
    toolUseId?: string,
  ) => {
    const { socket, activeSessionId, sessionStates } = get();
    // #4604 Chunk B / #4621 / #4651 / #4735 — split the wire payload by call shape:
    // - string `answer`: legacy single-question / free-text path. Wire
    //   shape stays `{ type, answer, toolUseId? }` so older servers
    //   keep working without schema migration.
    // - Record `answer`: multi-question form. Populate the `answers`
    //   field (`UserQuestionResponseSchema` accepts
    //   `Record<string, string | string[]>` per #4621) AND a string
    //   `answer` summary so a server running an older build that only
    //   reads `answer` falls through to its default-to-option-1 path
    //   (a noisy WARN in chroxy.log) instead of stalling the form.
    //   Multi-select values flow through as native arrays — the
    //   summary helper flattens them to comma-joined labels so the
    //   string-only `answer` field stays readable.
    //
    //   Delegate to `formatQuestionAnswerSummary` so the legacy
    //   JSON-stringified array envelope (pre-#4621 wire: a single
    //   value like `'["App","Tests"]'` for multi-select) is also
    //   flattened here — otherwise the terminal echo + the required
    //   string `answer` field can leak `["App","Tests"]` JSON syntax
    //   when mixed-version rehydrated state replays an old answersMap.
    //   The helper detects array-shaped values AND JSON-stringified
    //   arrays and renders both the same way (comma-joined labels).
    // - {otherLabel, freeformText} (#4651): single-question Other path.
    //   `answer` carries the Other option's label so the server can
    //   resolve it to a 1-indexed digit; `freeformText` carries the
    //   typed text so the server can drive a two-stage TUI write
    //   (digit → text-input prompt → freeform text + Enter). Older
    //   servers that ignore `freeformText` fall through to the legacy
    //   path and type the label literally — a clean degradation.
    // Copilot review (#4753): tighten the freeform-shape detection to
    // avoid misclassifying a multi-question Record whose question keys
    // happen to be literally "freeformText" and "otherLabel" (rare, but
    // possible if the model phrases a question that way). The freeform
    // shape is an object with EXACTLY those two keys AND both string
    // values — anything else falls through to the multi-question path.
    //
    // #4901: the shape check now lives in `@chroxy/store-core/freeform-answer`
    // (single source of truth, mobile already migrated in #4875 / PR #4900).
    // The `value is OtherFreeformAnswer` narrowing means the post-detection
    // accesses (`answer.otherLabel`, `answer.freeformText`) no longer need
    // `as { otherLabel: string; freeformText: string }` casts.
    const freeform = isFreeformAnswer(answer);
    const isMultiAnswer = !freeform && typeof answer !== 'string';
    let answerSummary: string;
    if (freeform) {
      answerSummary = answer.freeformText;
    } else {
      // Delegate to the shared summary helper so multi-question Records
      // (and the legacy JSON-stringified array envelope from #4621) both
      // render consistently — comma-joined labels for multi-select, no
      // leaked JSON syntax in the terminal echo or wire `answer` field.
      answerSummary = formatQuestionAnswerSummary(
        answer as string | Record<string, string | string[]>,
      );
    }
    const payload: Record<string, unknown> = { type: 'user_question_response', answer: freeform
      ? answer.otherLabel
      : answerSummary };
    if (isMultiAnswer) {
      payload.answers = answer;
    }
    if (freeform) {
      payload.freeformText = answer.freeformText;
    }
    if (toolUseId) payload.toolUseId = toolUseId;
    // #4296: echo the resolved answer to the terminal buffer so the Output
    // tab shows a visible "User answered: X" line between the AskUserQuestion
    // tool_input JSON and the next event. Cyan (\x1b[36m) distinguishes the
    // line from yellow user-prompt echoes (\x1b[33m in sendInput). Skipped
    // for empty answers — nothing meaningful to render. Fires before the
    // wire send so the echo is present even when the socket queues.
    if (answerSummary) {
      get().appendTerminalData(`\r\n\x1b[36m> User answered: ${answerSummary}\x1b[0m\r\n`);
    }
    // #4312: optimistically flip the active session into "running" so the
    // ActivityIndicator + per-session busy dot light up immediately on
    // answer-send, matching the symmetry of sendInput. Without this, the
    // dashboard reads idle in the gap between answer-send and the next
    // server-emitted stream/tool event, making the answer look dropped.
    // Once a server event arrives, the bump is a no-op (server is
    // authoritative); the timestamp is overwritten in dispatch-activity.
    //
    // #4465: also drop the matching activeTools entry. In TUI sessions,
    // claude TUI may not emit PostToolUse for some AskUserQuestion shapes
    // (v0.9.12 empirical), so the server never sends tool_result and the
    // dashboard's footer pill ticks `Running AskUserQuestion · Nm Ns`
    // indefinitely. Drop the entry optimistically when the user answers
    // so the pill clears within ~1s of the answer landing. If the server
    // does later emit tool_result for the same toolUseId, sharedToolResult
    // is idempotent on missing entries — no double-clear, no re-append.
    //
    // Skipped when toolUseId is absent (free-text question prompts that
    // didn't carry a tool pairing) so the server stays authoritative for
    // any in-flight tools.
    if (activeSessionId && sessionStates[activeSessionId]) {
      updateActiveSession((ss) => {
        const patch: Partial<typeof ss> = {
          isIdle: false,
          lastClientActivityAt: Date.now(),
        };
        if (toolUseId) {
          patch.activeTools = ss.activeTools.filter(t => t.toolUseId !== toolUseId);
          // #4499: also patch the matching `tool_use` ChatMessage in
          // messages[] so the messages-walk fallback
          // (ActivityIndicator.findInFlightToolUse) stops surfacing the
          // unresolved AskUserQuestion the moment activeTools is empty.
          // Without this patch the walk picks it back up (toolResult is
          // undefined because PostToolUse never fired in the TUI case) and
          // the "Running AskUserQuestion · Ns" pill re-appears via the
          // fallback path immediately after the activeTools clear.
          //
          // Sentinel `'(resolved by user)'` mirrors the answered-bubble
          // semantic and is not interpreted as content by any renderer —
          // only the existence-check in findInFlightToolUse matters.
          // sharedToolResult will OVERWRITE this if the server eventually
          // does emit tool_result for the same toolUseId; we never lose
          // server data, only fill in the gap.
          let patched = false;
          const nextMessages = ss.messages.map(m => {
            if (m.id === toolUseId && m.type === 'tool_use' && m.toolResult === undefined) {
              patched = true;
              return { ...m, toolResult: '(resolved by user)' };
            }
            return m;
          });
          if (patched) patch.messages = nextMessages;
        }
        return patch;
      });
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload);
      return 'sent';
    }
    return enqueueMessage('user_question_response', payload);
  },

  markPromptAnswered: (messageId: string, answer: string) => {
    const { activeSessionId, sessionStates } = get();
    const now = Date.now();

    if (activeSessionId && sessionStates[activeSessionId]) {
      updateActiveSession((ss) => ({
        messages: ss.messages.map((m) =>
          m.id === messageId ? { ...m, answered: answer, answeredAt: now } : m
        ),
      }));
    } else {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, answered: answer, answeredAt: now } : m
        ),
      }));
    }
  },

  markPromptAnsweredByRequestId: (requestId: string, answer: string) => {
    const { sessionStates } = get();
    const now = Date.now();

    // Search all sessions (cross-session banners may answer prompts in background sessions)
    for (const [sid, ss] of Object.entries(sessionStates)) {
      if (ss.messages.some((m) => m.requestId === requestId)) {
        set((state) => ({
          sessionStates: {
            ...state.sessionStates,
            [sid]: {
              ...state.sessionStates[sid]!,
              messages: state.sessionStates[sid]!.messages.map((m) =>
                m.requestId === requestId ? { ...m, answered: answer, answeredAt: now } : m
              ),
            },
          },
        }));
        return;
      }
    }

    // Fallback: check legacy flat messages
    set((state) => ({
      messages: state.messages.map((m) =>
        m.requestId === requestId ? { ...m, answered: answer, answeredAt: now } : m
      ),
    }));
  },

  setModel: (model: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_model', model };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
    // Mirror the optimistic-update pattern from setPermissionMode (#3693)
    // so the controlled <select> doesn't briefly snap back to the prior
    // value while waiting for the server's `model_changed` broadcast.
    if (activeSessionId && get().sessionStates[activeSessionId]) {
      updateActiveSession(() => ({ activeModel: model }));
    } else {
      set({ activeModel: model });
    }
  },

  setPermissionMode: (mode: string) => {
    const { socket, activeSessionId, permissionMode } = get();
    // `auto` (bypass-permissions) is destructive — confirm before sending.
    // window.confirm is synchronous and avoids the missing-modal gap that
    // previously left the dropdown stuck on the prior selection (#3693).
    // Confirmed BEFORE updating any state so a cancel leaves both the mode
    // and previousPermissionMode untouched — the latter is the Shift+Tab
    // toggle target, and overwriting it on cancel would silently break the
    // toggle.
    if (mode === 'auto') {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('Switch to Auto mode? Tools will run without asking for permission.')
        : true;
      if (!ok) return;
    }
    // Save current mode before switching (for Shift+Tab toggle)
    if (permissionMode && permissionMode !== mode) {
      set({ previousPermissionMode: permissionMode });
    }
    if (mode === 'auto') {
      // Send with confirmed:true so the server skips its own confirmation
      // round-trip and broadcasts `permission_mode_changed` directly.
      if (socket && socket.readyState === WebSocket.OPEN) {
        const payload: Record<string, unknown> = { type: 'set_permission_mode', mode, confirmed: true };
        if (activeSessionId) payload.sessionId = activeSessionId;
        wsSend(socket, payload);
      }
    } else {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const payload: Record<string, unknown> = { type: 'set_permission_mode', mode };
        if (activeSessionId) payload.sessionId = activeSessionId;
        wsSend(socket, payload);
      }
    }
    // Optimistically update local state so the controlled `<select>`
    // doesn't snap back to the prior value before the server's
    // `permission_mode_changed` broadcast lands (#3693). Idempotent — the
    // broadcast will re-set the same value when it arrives.
    if (activeSessionId && get().sessionStates[activeSessionId]) {
      updateActiveSession(() => ({ permissionMode: mode }));
    } else {
      set({ permissionMode: mode });
    }
  },

  setThinkingLevel: (level: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_thinking_level', level };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // #3185: per-session promptEvaluator toggle. Strict-boolean payload
  // matches the server's validation; `sessionId` is passed when present
  // so the toggle targets the active session in multi-session mode.
  setPromptEvaluator: (value: boolean) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_prompt_evaluator', value };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // #3805: per-session Chroxy context hint toggle. Strict-boolean payload
  // matches the server's validation; `sessionId` is passed when present
  // so the toggle targets the active session in multi-session mode.
  setChroxyContextHint: (value: boolean) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_chroxy_context_hint', value };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // #4660: per-session preamble setter. String payload matches the
  // server's validation; `sessionId` is passed when present so the
  // setter targets the active session in multi-session mode. Server
  // trims + caps the value and broadcasts `session_preamble_changed`
  // back — no optimistic update so the rendered text matches what
  // the server actually injects.
  setSessionPreamble: (value: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_session_preamble', value };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // #3209: skills runtime API
  requestListSkills: () => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'list_skills' };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  activateSkill: (skillName: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'skill_activate', skillName };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  deactivateSkill: (skillName: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'skill_deactivate', skillName };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // #3270/#3235: re-trust a skill whose hash mismatched the trust store.
  // Server resolves the skill via the bound session's loaded list (or
  // filesystem fallback for block-mode-filtered skills), calls
  // SkillsTrustStore.acceptHash + flush, and broadcasts
  // `skill_trust_accepted` which the message-handler uses to clear
  // `mismatchedSkillNames`. Errors come back via the standard `error`
  // envelope (TRUST_NOT_ENABLED / TRUST_FLUSH_FAILED / SKILL_NOT_FOUND).
  // `requestId` lets a future UX correlate a specific click to the
  // resulting broadcast or error.
  acceptSkillTrust: (skillName: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const requestId = `accept-trust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const payload: Record<string, unknown> = { type: 'skill_trust_accept', skillName, requestId };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
  },

  // #3298: grant first-activation trust to a community skill author.
  // Server wires communityTrustChecker + grantCommunityTrust in
  // BaseSession._loadSkills, reloads skills, and broadcasts
  // skill_trust_granted (removes pending row) + skill_trust_grant_ok
  // (ack to requesting client).
  // #3588: track the in-flight requestId on the active session's
  // `pendingTrustGrants` so the SkillsPanel "Pending review" row can
  // render an in-flight state (disabled Trust button + spinner). The
  // entry is cleared by the message-handler on EITHER skill_trust_grant_ok
  // (success) OR an `error` envelope whose requestId matches — without
  // this, an INVALID_AUTHOR / TRUST_NOT_ENABLED / TRUST_FLUSH_FAILED
  // response would leave the row stuck "approving" with no way to retry.
  grantCommunitySkillTrust: (skillName: string, author: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const requestId = `trust-grant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // #3587: remember the request locally so the message-handler can
      // pair the resulting INVALID_AUTHOR error (if any) with the
      // original `skillName` and offer a "Try as <actualAuthor>" toast
      // action. The wire error doesn't echo `skillName`, so client-side
      // tracking is the only correlation path. Cleared on success ack
      // (`skill_trust_grant_ok`) or on error processing.
      registerTrustGrantRequest(requestId, { skillName, author });
      const payload: Record<string, unknown> = {
        type: 'skill_trust_grant',
        skillName,
        author,
        scope: 'author',
        requestId,
      };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
      // Track the in-flight grant so the panel can disable the row.
      // Only track when the message has a session to bind to — otherwise
      // there's no SkillsPanel surface to show feedback on anyway.
      if (activeSessionId && get().sessionStates[activeSessionId]) {
        updateActiveSession((ss) => {
          const existing = Array.isArray(ss.pendingTrustGrants) ? ss.pendingTrustGrants : [];
          // Defensive de-dupe: identical (skillName, author) shouldn't
          // queue twice — collapse to the latest requestId so the
          // success/error correlation always lands on a live entry.
          const filtered = existing.filter(
            g => !(g.skillName === skillName && g.author === author),
          );
          return { pendingTrustGrants: [...filtered, { requestId, skillName, author }] };
        });
      }
    }
  },

  confirmPermissionMode: (mode: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'set_permission_mode', mode, confirmed: true };
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
    set({ _directoryListingCallback: cb });
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
    set({ _fileBrowserCallback: cb });
  },

  setFileContentCallback: (cb) => {
    set({ _fileContentCallback: cb });
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

  // Git status

  setGitStatusCallback: (cb) => {
    set({ _gitStatusCallback: cb });
  },

  requestGitStatus: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'git_status' });
    }
  },

  // Diff viewer

  setDiffCallback: (cb) => {
    set({ _diffCallback: cb });
  },

  requestDiff: (base?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'get_diff' };
      if (base) msg.base = base;
      wsSend(socket, msg);
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

  fetchFileList: (query?: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: 'list_files' };
      if (query) msg.query = query;
      wsSend(socket, msg);
    }
  },

  fetchCustomAgents: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_agents' });
    }
  },

  // Session actions

  switchSession: (sessionId: string) => {
    const { socket, activeSessionId, sessionStates } = get();

    if (sessionId === activeSessionId) return;

    // #4982 — operator picked a live session, so the lost-id banner from
    // the prior SESSION_NOT_FOUND is no longer relevant. Clear it here so
    // a stale banner doesn't outlive the resolution.
    if (get().sessionNotFoundError) set({ sessionNotFoundError: null });

    // Optimistically switch to cached state + mark notifications for target
    // session as read. #4890 — pre-widget we filtered the target session's
    // alerts out entirely, but the new Slack-style widget needs the entries
    // to persist as acknowledged history; the banners stack filters by
    // `readAt === undefined` at render time so the visual behaviour
    // (banners vanish on switch) is unchanged.
    const cached = sessionStates[sessionId];
    const switchReadStamp = Date.now();
    const filteredNotifications = get().sessionNotifications.map((n) =>
      n.sessionId === sessionId && n.readAt === undefined
        ? { ...n, readAt: switchReadStamp }
        : n,
    );
    if (cached) {
      set({
        activeSessionId: sessionId,
        messages: cached.messages,
        streamingMessageId: cached.streamingMessageId,
        claudeReady: cached.claudeReady,
        activeModel: cached.activeModel,
        permissionMode: cached.permissionMode,
        contextUsage: cached.contextUsage,
        lastResultCost: cached.lastResultCost,
        lastResultDuration: cached.lastResultDuration,
        isIdle: cached.isIdle,
        sessionNotifications: filteredNotifications,
      });
    } else {
      // No cached state yet — still switch the active session so the UI responds.
      // Messages will arrive from the server via session_switched/stream_start once the
      // switch_session WS message is processed.
      // Reset all session-scoped fields so the previous session's values don't bleed through
      // during the server round-trip.
      //
      // #4639: seed `isIdle` from the most-recent `session_list` snapshot
      // (where the server reports `isBusy` per session) instead of hardcoding
      // `true`. Without this, clicking a tab whose session is still in-flight
      // on the server would silently drop the Working banner and the Stop
      // button until the next server event lands.
      const sessionInfo = get().sessions.find((s) => s.sessionId === sessionId);
      const seedIsIdle = typeof sessionInfo?.isBusy === 'boolean' ? !sessionInfo.isBusy : true;
      set({
        activeSessionId: sessionId,
        messages: [],
        streamingMessageId: null,
        claudeReady: false,
        activeModel: null,
        permissionMode: null,
        contextUsage: null,
        lastResultCost: null,
        lastResultDuration: null,
        isIdle: seedIsIdle,
        sessionNotifications: filteredNotifications,
      });
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'switch_session', sessionId });
    }
  },

  createSession: ({ name, cwd, provider, model, permissionMode, worktree, environmentId, skipPermissions }) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = { type: 'create_session' };
      if (name) msg.name = name;
      if (cwd) msg.cwd = cwd;
      if (provider) msg.provider = provider;
      if (model) msg.model = model;
      if (permissionMode) msg.permissionMode = permissionMode;
      if (worktree) msg.worktree = true;
      if (environmentId) msg.environmentId = environmentId;
      // #4208: TUI-only opt-in to claude --dangerously-skip-permissions.
      // Forward whenever the caller passes a strict boolean so an explicit
      // `false` can override a server-wide `defaultSkipPermissions: true`
      // on a per-session basis. Only `undefined` (caller omitted the field)
      // falls through to the SessionManager default (which respects
      // `chroxy start --dangerously-skip-permissions` via #4209).
      if (typeof skipPermissions === 'boolean') msg.skipPermissions = skipPermissions;
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

  // Environment actions
  requestEnvironments: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'list_environments' });
    }
  },

  createEnvironment: (opts) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = {
        type: 'create_environment',
        name: opts.name,
        cwd: opts.cwd,
      };
      if (opts.image) msg.image = opts.image;
      if (opts.memoryLimit) msg.memoryLimit = opts.memoryLimit;
      if (opts.cpuLimit) msg.cpuLimit = opts.cpuLimit;
      wsSend(socket, msg);
    }
  },

  destroyEnvironment: (environmentId: string) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'destroy_environment', environmentId });
    }
  },

  fetchConversationHistory: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ conversationHistoryLoading: true });
      wsSend(socket, { type: 'list_conversations' });
      // Safety timeout — clear loading state if server never responds
      setTimeout(() => {
        if (get().conversationHistoryLoading) {
          set({ conversationHistoryLoading: false });
        }
      }, 10_000);
    } else {
      // Ensure loading state is cleared when not connected
      set({ conversationHistoryLoading: false });
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
      set({ searchLoading: true, searchResults: [], searchQuery: query });
      wsSend(socket, { type: 'search_conversations', query });
      // Timeout to clear loading if no response in 15s
      clearTimeout(searchTimeoutId);
      searchTimeoutId = setTimeout(() => {
        if (searchNonce === nonce && get().searchLoading) set({ searchLoading: false });
      }, 15000);
    }
  },

  clearSearchResults: () => {
    set({ searchResults: [], searchLoading: false, searchQuery: '' });
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

  clearLogEntries: () => {
    set({ logEntries: [] });
  },

  addServerError: (message, action, severity, partialCostLine) => {
    const now = Date.now();
    const err = {
      id: nextMessageId('info'),
      category: 'general' as const,
      message,
      recoverable: true,
      timestamp: now,
      // #3587: optional inline recovery action (e.g. "Try as alice").
      // Only attached when the caller has enough context to offer a
      // one-click retry — undefined for the common path so the toast
      // renders message-only as before.
      ...(action ? { action } : {}),
      // #4148: severity differentiates non-fatal warnings (e.g.
      // MAX_TOOL_ROUNDS_REACHED) from destructive STREAM_ERROR / ABORT.
      // Defaults to 'error' when unset — existing call sites unchanged.
      ...(severity ? { severity } : {}),
      // #5039: optional partial-cost sub-line surfaced under the main
      // message when PR #5037 folded parent + Task subagent rounds onto
      // the error envelope. Only attached when the caller has a
      // non-empty pre-formatted line — undefined for every error path
      // that doesn't carry partials so the toast renders message-only.
      ...(partialCostLine ? { partialCostLine } : {}),
    };
    set((state) => ({
      serverErrors: [...state.serverErrors, err].slice(-10),
    }));
  },

  dismissServerError: (id: string) => {
    set((state) => ({
      serverErrors: state.serverErrors.filter((e) => e.id !== id),
    }));
  },

  // #5356: dismiss the exposure warning banner for this connection.
  dismissExposureBanner: () => {
    set({ exposureBannerDismissed: true });
  },

  addInfoNotification: (message: string) => {
    const now = Date.now();
    const notification = {
      id: nextMessageId('info-notif'),
      category: 'general' as const,
      message,
      recoverable: true,
      timestamp: now,
    };
    set((state) => ({
      infoNotifications: [...state.infoNotifications, notification].slice(-10),
    }));
  },

  dismissInfoNotification: (id: string) => {
    const { infoNotifications } = get();
    if (!infoNotifications.some((e) => e.id === id)) {
      return;
    }
    set({
      infoNotifications: infoNotifications.filter((e) => e.id !== id),
    });
  },

  dismissSessionNotification: (id: string) => {
    set((state) => ({
      sessionNotifications: state.sessionNotifications.filter((n) => n.id !== id),
    }));
  },

  // #4890 — Slack-style intervention notifications widget. `read` (a
  // timestamp) is distinct from `dismiss` (removal). Reading means the
  // operator explicitly acknowledged the alert — clicking a widget row,
  // hitting the per-row "mark as read" button, "Mark all read", or
  // switching to the alert's session via any session-switch path. Opening
  // the widget panel by itself does NOT mark notifications read; only the
  // explicit per-row / bulk / session-switch actions do. Once stamped, the
  // alert stops counting toward the unread badge but remains in the
  // widget's history list. Idempotent: a second mark-read keeps the first
  // timestamp so re-opens don't masquerade as fresh acknowledges.
  markSessionNotificationRead: (id: string) => {
    set((state) => ({
      sessionNotifications: state.sessionNotifications.map((n) =>
        n.id === id && n.readAt === undefined
          ? { ...n, readAt: Date.now() }
          : n,
      ),
    }));
  },

  markAllSessionNotificationsRead: () => {
    const now = Date.now();
    set((state) => ({
      sessionNotifications: state.sessionNotifications.map((n) =>
        n.readAt === undefined ? { ...n, readAt: now } : n,
      ),
    }));
  },

  // #4982 — SessionNotFoundChip banner state setters. message-handler sets
  // the value from `session_error{code:'SESSION_NOT_FOUND'}` (and also
  // clears activeSessionId in the same set call to break the resend loop).
  // Dismiss clears the banner; switchSession also clears it (see the
  // explicit clear in switchSession below).
  setSessionNotFoundError: (err) => {
    set({ sessionNotFoundError: err });
  },
  dismissSessionNotFoundError: () => {
    set({ sessionNotFoundError: null });
  },

  // Multi-server registry actions
  addServer: (name: string, wsUrl: string, token: string): ServerEntry => {
    const [updated, entry] = addServerEntry(get().serverRegistry, name, wsUrl, token);
    set({ serverRegistry: updated });
    return entry;
  },

  removeServer: (serverId: string) => {
    const updated = removeServerEntry(get().serverRegistry, serverId);
    // If removing the active server, disconnect
    if (get().activeServerId === serverId) {
      get().disconnect();
      set({ activeServerId: null });
    }
    set({ serverRegistry: updated });
  },

  updateServer: (serverId: string, patch: Partial<Pick<ServerEntry, 'name' | 'wsUrl' | 'token'>>) => {
    const updated = updateServerEntry(get().serverRegistry, serverId, patch);
    set({ serverRegistry: updated });
  },

  /**
   * Switch to a different server — disconnects current, clears session state,
   * then connects fresh. Use for user-initiated server changes.
   */
  switchServer: (serverId: string) => {
    const server = get().serverRegistry.find(s => s.id === serverId);
    if (!server) return;
    // No-op if already connected to this server
    if (serverId === get().activeServerId && get().connectionPhase === 'connected') return;
    // Disconnect from current server (if connected)
    if (get().connectionPhase !== 'disconnected') {
      get().disconnect();
    }
    // Switch persistence scope first — flushes pending old-scope writes, then
    // resets in-memory state so subscriber side-effects target the new scope
    setServerScope(serverId);
    get()._resetSessionMemory();
    set({ activeServerId: serverId, userDisconnected: false });
    // Restore persisted data for the new server
    const persisted = loadPersistedState();
    if (persisted.activeSessionId) {
      set({ activeSessionId: persisted.activeSessionId });
    }
    // Connect to the new server
    get().connect(server.wsUrl, server.token);
  },

  /**
   * Reconnect to a known server without clearing session state.
   * Use for auto-reconnect on startup or after transient disconnects.
   */
  connectToServer: (serverId: string) => {
    const server = get().serverRegistry.find(s => s.id === serverId);
    if (!server) return;
    setServerScope(serverId);
    set({ activeServerId: serverId });
    get().connect(server.wsUrl, server.token);
  },

  /**
   * Connect to the local same-origin daemon ("this machine"). Mirrors
   * switchServer but for the registry-less local target (scope `null`), so a
   * desktop/LAN-client user can switch back from a remote LAN server to their
   * own host. No-op when no same-origin token is available. (#5281 ①.2)
   */
  connectLocal: () => {
    const token = getAuthToken();
    if (!token) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}/ws`;
    // Already on local and connected — nothing to do.
    if (get().activeServerId === null && get().connectionPhase === 'connected') return;
    if (get().connectionPhase !== 'disconnected') {
      get().disconnect();
    }
    // Switch persistence scope to local (null) before resetting in-memory state,
    // so subscriber side-effects target the local scope (same ordering as
    // switchServer).
    setServerScope(null);
    get()._resetSessionMemory();
    set({ activeServerId: null, userDisconnected: false });
    const persisted = loadPersistedState();
    if (persisted.activeSessionId) {
      set({ activeSessionId: persisted.activeSessionId });
    }
    get().connect(wsUrl, token);
  },

  /**
   * Reconnect to the *active* server — registry server when `activeServerId` is
   * set, else the local same-origin daemon. The manual "Retry" affordance must
   * target whatever we were connected to; building the URL from
   * `window.location.host` unconditionally (the old App-level handler) silently
   * reconnected a dropped remote LAN session to the *local* daemon instead
   * (#5284). Unlike switchServer/connectLocal this preserves session state — a
   * retry resumes the same connection rather than switching contexts, so it
   * reuses connectToServer's no-reset reconnect for the registry case.
   */
  retryConnection: () => {
    const activeServerId = get().activeServerId;
    if (activeServerId) {
      // Registry server. connectToServer no-ops on an id absent from the
      // registry. removeServer already nulls activeServerId when it drops the
      // active entry, so this only fires on a stale/desynced id (e.g. the
      // registry was edited in another tab, or storage is corrupt). Falling
      // back to local there would reintroduce the exact wrong-target bug, so
      // we deliberately let it no-op rather than silently jump to local.
      get().connectToServer(activeServerId);
      return;
    }
    // Local same-origin daemon — reconnect in place (no scope/memory reset).
    const token = getAuthToken();
    if (!token) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}/ws`;
    get().connect(wsUrl, token);
  },

  /**
   * Add a server from a pairing URL and connect via the ephemeral pairing
   * handshake — no permanent token typed (#5281 ③ PR 2). The entry starts with
   * an empty token; the session token issued in `auth_ok` replaces it (handled
   * in the auth_ok message handler) so reconnects authenticate normally. A
   * `pair_fail` clears the armed pairing id and surfaces the reason.
   */
  pairServer: (name: string, wsUrl: string, pairingId: string): ServerEntry => {
    const entry = get().addServer(name, wsUrl, '');
    pendingPairingId = pairingId;
    get().switchServer(entry.id);
    return entry;
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

// Track server connection status — mark registry entry as connected + persist active server ID
let _prevConnectionPhase: string | null = null;
let _prevActiveServerId: string | null = null;
useConnectionStore.subscribe((state) => {
  const wasConnected = _prevConnectionPhase === 'connected';
  _prevConnectionPhase = state.connectionPhase;
  if (state.connectionPhase === 'connected' && !wasConnected) {
    if (state.activeServerId) {
      const updated = markServerConnected(state.serverRegistry, state.activeServerId);
      useConnectionStore.setState({ serverRegistry: updated });
    }
  }

  // Persist active server ID changes
  if (state.activeServerId !== _prevActiveServerId) {
    _prevActiveServerId = state.activeServerId;
    persistActiveServer(state.activeServerId);
  }
});

// Persist session messages, active session, session list when they change
let _prevActiveSessionId: string | null = null;
const _prevMessageCounts: Record<string, number> = {};
let _prevTerminalBufferLen = 0;
let _prevSessions: SessionInfo[] = [];
useConnectionStore.subscribe((state) => {
  // Persist active session ID changes
  if (state.activeSessionId !== _prevActiveSessionId) {
    // Flush messages for the previous session before switching (avoids losing debounced writes)
    if (_prevActiveSessionId) {
      const prevSs = state.sessionStates[_prevActiveSessionId];
      if (prevSs) {
        persistSessionMessages(_prevActiveSessionId, prevSs.messages);
        _prevMessageCounts[_prevActiveSessionId] = prevSs.messages.length;
      }
    }
    _prevActiveSessionId = state.activeSessionId;
    persistActiveSession(state.activeSessionId);
  }

  // Persist messages for ALL sessions with changed message counts (not just active)
  for (const [sessionId, ss] of Object.entries(state.sessionStates)) {
    const prevCount = _prevMessageCounts[sessionId] ?? 0;
    if (ss.messages.length !== prevCount) {
      _prevMessageCounts[sessionId] = ss.messages.length;
      persistSessionMessages(sessionId, ss.messages);
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
    } else {
      // Clear persisted terminal buffer when buffer is emptied
      clearPersistedTerminalBuffer();
    }
  }
});

// Reconnect or refresh on tab/window visibility change
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const state = useConnectionStore.getState();
    const { socket, connectionPhase, wsUrl, apiToken, activeSessionId, sessionStates } = state;
    const visible = document.visibilityState === 'visible';

    // #3671: tell the server which side of the visible/hidden edge we're on
    // so completion pushes don't get suppressed when the dashboard tab is in
    // the background. Server defaults visible=true on every fresh connect, so
    // sending only on edge transitions (memoised in sendClientVisible) is
    // enough — no spam during quick alt-tab cycles.
    sendClientVisible(socket, visible);

    if (visible) {
      if (connectionPhase === 'connected' && socket && socket.readyState !== WebSocket.OPEN && wsUrl && apiToken) {
        console.log('[ws] Tab became visible, socket stale — reconnecting');
        state.connect(wsUrl, apiToken);
      } else if (connectionPhase === 'connected' && activeSessionId && sessionStates[activeSessionId]) {
        // Force messages array reference bump so React re-renders any
        // content that accumulated while the tab was in the background.
        // Chrome throttles setTimeout in hidden tabs, so delta flushes
        // may have been delayed — the data is in the store but the UI
        // may show stale DOM.
        const ss = sessionStates[activeSessionId];
        useConnectionStore.setState({ messages: [...ss.messages] });
      }
    }
  });
}
