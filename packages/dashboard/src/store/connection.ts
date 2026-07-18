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
  PermissionDecision,
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
import { stripAnsi, filterThinking, nextMessageId, createEmptySessionState } from './utils';
import { registerSummarizeRequest, cancelSummarizeRequest, rejectAllSummarizeRequests } from './summarizeRequests';
import { formatQuestionAnswerSummary } from '../utils/questionAnswerSummary';
import { getAuthToken } from '../utils/auth';
import { buildAutoModeConfirmMessage } from '../lib/auto-mode-confirm';
import {
  setStore,
  wsSend,
  sendClientVisible,
  handleMessage,
  setConnectionContext,
  setEncryptionState,
  setPendingKeyPair,
  setPendingPairingIdentityKey,
  prepareEagerKeyExchange,
  getEncryptionState,
  connectionAttemptId,
  bumpConnectionAttemptId,
  disconnectedAttemptId,
  setDisconnectedAttemptId,
  lastConnectedUrl,
  setLastConnectedUrl,
  nextReconnectAttempt,
  resetReconnectAttempt,
  resetReplayFlags,
  clearPermissionSplits,
  clearTerminalWriteBatching,
  appendPendingTerminalWrite,
  stopHeartbeat,
  armHandshakeTimer,
  clearHandshakeTimer,
  clearDeltaBuffers,
  clearMessageQueue,
  enqueueMessage,
  updateActiveSession,
  updateSession,
  clearSavedCredentials,
  loadConnection,
  CLIENT_PROTOCOL_VERSION,
  registerEvaluatorRequest,
  cancelEvaluatorRequest,
  rejectAllEvaluatorRequests,
  registerTrustGrantRequest,
  clearPendingTrustGrants,
  registerModelChangeRequest,
  clearPendingModelReverts,
  registerPermissionModeChangeRequest,
  registerThinkingLevelChangeRequest,
  clearPendingThinkingLevelReverts,
  clearPendingPermissionModeReverts,
} from './message-handler';
import type { EvaluatorResultPayload } from './types';
import { CLIENT_CAPABILITIES, DEFAULT_PROVIDER } from '@chroxy/protocol';
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
  // #5555.3 — per-session history cursors for delta replay, sent in `auth`.
  getHistoryCursors,
  // #5555.4 — hard-reset the replay reconcile state on explicit disconnect.
  resetReplayReconcile,
  // #5556 sub-item 4 — shared connect-flow orchestration: the retry ladder, the
  // probe → restart → connect decision tree, and the per-socket reconnect
  // dedup. The dashboard supplies its store writes / console give-up / registry
  // token re-resolution as callbacks. `resolveEndpoint` is the #5597/#5537
  // LAN/tunnel re-resolution seam (static today).
  runConnectAttempt,
  createReconnectScheduler,
  RECONNECT_MAX_RUNG,
  // #5621 — the shared retry-ladder defaults (was duplicated verbatim here).
  CONNECT_MAX_RETRIES,
  CONNECT_RETRY_DELAYS,
  type ProbeResult,
  type ConnectEndpoint,
  // #5939 (epic #5935 ④): optimistic queued-message helpers for the
  // send-while-busy path + per-item cancel.
  enqueueOptimisticQueuedMessage,
  removeQueuedMessage,
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

// #5632 — post-handshake plaintext guard (consensus C3 / Adversary F1).
// Once E2E encryption is established (encState set), every server→client frame
// MUST arrive inside an `encrypted` envelope. The #5614 downgrade gate only
// protects the `auth_ok` handshake frame; without this guard a MITM could still
// inject a forged plaintext app frame AFTER the handshake and have the client
// act on it. We fail closed exactly like a decrypt failure (log + socket.close,
// no dispatch).
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
// #5937: stable empty outgoing-message queue for the flat-state fallback —
// same stable-reference rationale as the EMPTY_* constants above.
const EMPTY_QUEUED_MESSAGES: never[] = [];

// #5555.5 — the close/error-path reconnect delay is no longer a fixed
// constant. Both handlers now climb the shared CONNECT_RETRY_DELAYS ladder
// (from @chroxy/store-core) via the module-level reconnectAttempt counter, which resets on
// `auth_ok`. See scheduleReconnect() below.

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

// #6502 — monotonic read_file request nonce. The server echoes it back on the
// `file_content` reply so the file browser can drop replies from superseded
// requests (path-agnostic correlation), instead of tail-matching the path.
let fileContentRequestNonce = 0;

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

// #5835 (PR2): true when the active session is claude-tui — its Output tab shows
// the live PTY mirror, so the synthetic prompt/answer terminal echoes must be
// suppressed (they'd inject a line at the altscreen cursor and corrupt the redraw).
function activeSessionIsClaudeTui(get: () => ConnectionState): boolean {
  const s = get();
  return s.sessions.find(sess => sess.sessionId === s.activeSessionId)?.provider === DEFAULT_PROVIDER;
}

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
  // #5510 (epic #5509): pairing-approval primitive — outstanding pending pair
  // requests fanned out to this host surface. Empty until a pair_pending lands.
  pendingPairRequests: [],
  // #5513 (epic #5509): set when a redeemed ?pair= link is approval-gated so the
  // UI can transparently open the request-pair flow. Null otherwise.
  pendingApprovalPairHost: null,
  // #5175 (epic #5170): Host/Repo Status Control Room snapshot, fed by the
  // host_status_snapshot handler. Null until the first survey lands.
  hostStatus: null,
  hostStatusLoading: false,
  // #6471 (epic #6469): opt-in IDE workspace symbol table, fed by the
  // symbols_snapshot handler. Null until the first list_symbols reply lands.
  symbols: null,
  symbolsLoading: false,
  // Mailbox (#5914 follow-up): Control Room "Mailbox" tab snapshot, fed by the
  // mailbox_status_snapshot handler. Null until the first survey lands.
  mailboxStatus: null,
  mailboxStatusLoading: false,
  // #5969 (epic #5422 phase 4): mission-control external sessions (read-only,
  // from /api/events), fed by the external_sessions_snapshot handler. Null
  // until the first survey lands.
  externalSessionsSnapshot: null,
  externalSessionsLoading: false,
  // #5966 (epic #5422 phase 5): Control Room repo-events pane, fed by the
  // repo_events_snapshot handler. Null until the first survey lands.
  repoEventsSnapshot: null,
  repoEventsLoading: false,
  // #6691 (S-3): orchestration Runs tab state (dashboard-only v1).
  orchestrationRuns: null,
  orchestrationRunsLoading: false,
  orchestrationRunDetails: {},
  orchestrationRunDetailLoading: new Set<string>(),
  orchestrationRunDetailErrors: {},
  orchestrationRunDetailStale: {},
  orchestrationPendingActions: {},
  orchestrationActionResults: {},
  selectedRunId: null,
  // #5553: per-repo session presets keyed by cwd, fed by session_preset_snapshot.
  sessionPresetSnapshots: {},
  // #5553: server-provided composer seeds keyed by sessionId (drained by App).
  pendingServerSeed: {},
  // #5253: Control Room self-hosted runner snapshot, fed by the
  // runner_status_snapshot handler. Null until the first survey lands.
  runnerStatus: null,
  runnerStatusLoading: false,
  // #6133 (epic #5530): Control Room containers & environments snapshot, fed by
  // the containers_status_snapshot handler. Null until the first survey lands.
  containersStatus: null,
  containersStatusLoading: false,
  // #6139 (epic #5530): Control Room per-repo runtime config snapshot, fed by
  // the repo_runtime_config_snapshot handler. Null until the first survey lands.
  repoRuntimeConfig: null,
  repoRuntimeConfigLoading: false,
  // #6135 (epic #5530): Control Room BYOK pool snapshot, fed by the
  // byok_pool_status_snapshot handler. Null until the first survey lands.
  byokPoolStatus: null,
  byokPoolStatusLoading: false,
  // #6140 (epic #5530): Control Room host prune snapshot, fed by the
  // host_prune_status_snapshot handler. Null until the first survey lands.
  hostPruneStatus: null,
  hostPruneStatusLoading: false,
  // #5499 (epic #5498): Control Room Integrations snapshot, fed by the
  // integration_status_snapshot handler. Null until the first survey lands.
  integrationStatus: null,
  integrationStatusLoading: false,
  // #5554 (epic #5159): Control Room Skills inventory snapshot, fed by the
  // skills_inventory_snapshot handler. Null until the first survey lands.
  skillsInventory: null,
  skillsInventoryLoading: false,
  // #5500: repo-memory Reindex action — in-flight repo paths + last outcome
  // per repo for inline display (same lifecycle as cancellingActivityIds).
  reindexingRepoPaths: new Set<string>(),
  reindexResults: {},
  // #6543 (IDE P3 feature B): pulled full redacted tool inputs keyed by requestId.
  permissionInputs: {},
  // #5502: relay Re-run pending/result buckets (separate from reindex).
  relayRerunningRepoPaths: new Set<string>(),
  relayRerunResults: {},
  // #6134: container lifecycle action — in-flight environment ids + last
  // outcome per environment for inline display (same lifecycle as reindex).
  containerActioningIds: new Set<string>(),
  containerActionResults: {},
  // #6135 slice 3: BYOK pool action — in-flight target ids + last outcome per
  // target for inline display (same lifecycle as containerActioningIds).
  byokPoolActioningIds: new Set<string>(),
  byokPoolActionResults: {},
  // #6140 slice 2: host prune action — in-flight kinds + last outcome per kind.
  hostPruneActioningIds: new Set<string>(),
  hostPruneActionResults: {},
  // #6136 (epic #5530): Control Room iOS simulator snapshot, fed by the
  // simulator_status_snapshot handler. Null until the first survey lands.
  simulatorStatus: null,
  simulatorStatusLoading: false,
  // #6136 slice 3: simulator action — in-flight udids + last outcome per udid.
  simulatorActioningIds: new Set<string>(),
  simulatorActionResults: {},
  // #6137: Control Room Android emulator snapshot, fed by the
  // emulator_status_snapshot handler. Null until the first survey lands.
  emulatorStatus: null,
  emulatorStatusLoading: false,
  // #6137: emulator action — in-flight targets (avd/serial) + last outcome.
  emulatorActioningIds: new Set<string>(),
  emulatorActionResults: {},
  // #6138: Control Room WSL2 distro snapshot, fed by the wsl_status_snapshot
  // handler. Null until the first survey lands.
  wslStatus: null,
  wslStatusLoading: false,
  // #6138: WSL action — in-flight distro names + last outcome per distro.
  wslActioningIds: new Set<string>(),
  wslActionResults: {},
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
  // #5819 / #5823: pre-select the shared DEFAULT_PROVIDER (claude-tui) so the
  // new-session picker doesn't default to a provider that silently draws
  // metered programmatic credits at the 2026-06-15 cutover. Sourced from
  // @chroxy/protocol so server + clients agree. Users who explicitly chose a
  // provider keep their persisted value.
  defaultProvider: loadPersistedSetting('chroxy_default_provider', DEFAULT_PROVIDER),
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
  // #5665 — machine-wide monthly programmatic-credit meter; populated by the
  // server's `monthly_budget` event (on connect + after each billed turn).
  monthlyBudget: null,
  sessionNotFoundError: null,
  resolvedPermissions: {},
  serverPhase: null,
  tunnelProgress: null,
  // #5356: exposure snapshot from auth_ok + banner dismissal flag.
  serverExposure: null,
  exposureBannerDismissed: false,
  // #5821: billing-canary snapshot from auth_ok / billing_canary + dismissal.
  billingCanary: null,
  billingBannerDismissed: false,
  shutdownReason: null,
  restartEtaMs: null,
  restartingSince: null,
  pendingPermissionConfirm: null,
  slashCommands: [],
  filePickerFiles: null,
  fileBrowserPendingOpen: null,
  workspaceSymbols: null,
  workspaceSymbolsLoading: false,
  symbolLocation: null,
  codeSearchResults: null,
  codeSearchLoading: false,
  referencesResult: null,
  referencesSymbol: '',
  referencesOpen: false,
  referencesLoading: false,
  customAgents: [],
  checkpoints: [],
  _directoryListingCallback: null,
  _fileBrowserCallback: null,
  _fileContentCallback: null,
  lastFileContentRequestId: null,
  _gitStatusCallback: null,
  _diffCallback: null,
  conversationHistory: [],
  conversationHistoryLoading: false,
  searchResults: [],
  searchLoading: false,
  searchQuery: '',
  contextUsage: null,
  contextOccupancy: null,
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

  // #5835 Phase 1 (PR2): opt in / out of a claude-tui session's live PTY mirror.
  // Only opted-in clients receive terminal_output (server-side filter), so this
  // is sent when the Output tab is shown for a claude-tui session and cleared on
  // leave. Best-effort — a closed socket just means no mirror until reconnect.
  subscribeTerminalMirror: (sessionId: string) => {
    const { socket } = get();
    if (sessionId && socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'terminal_subscribe', sessionId });
      // #6313: a (re)subscribe is exactly when the viewer may have missed frames
      // — a reconnect mid-stream, or a first subscribe that otherwise sees only
      // future bytes. Ask the server to force a fresh repaint so the grid is
      // current. Ordered after terminal_subscribe on the same socket, so the
      // client is in the subscriber set when the repaint bytes broadcast.
      wsSend(socket, { type: 'terminal_resync', sessionId });
    }
  },
  // #6313: manual "refresh terminal" — force the server to repaint the live PTY
  // when the viewer notices a desynced grid (a backpressure-dropped frame the
  // stateless raw-byte mirror can't otherwise recover). Best-effort.
  requestTerminalResync: (sessionId: string) => {
    const { socket } = get();
    if (sessionId && socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'terminal_resync', sessionId });
    }
  },
  unsubscribeTerminalMirror: (sessionId: string) => {
    const { socket } = get();
    if (sessionId && socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'terminal_unsubscribe', sessionId });
    }
  },

  // #5835 Phase 2: record the authoritative PTY grid size the server reported
  // for a session (terminal_size). Stored per-session so a tab switch shows the
  // right size immediately; the mirror renders at exactly this size, letterboxed.
  setTerminalSize: (sessionId: string, cols: number, rows: number) => {
    // Check BEFORE set(): a Zustand updater returning {} still produces a new
    // state object and notifies every subscriber (Copilot review) — so for an
    // unknown session or an unchanged size, skip the set() entirely. JS is
    // single-threaded with no await here, so the get()→set() read is race-free.
    const ss = get().sessionStates[sessionId];
    if (!ss) return;
    const prev = ss.terminalSize;
    if (prev && prev.cols === cols && prev.rows === rows) return;
    set((state) => ({
      sessionStates: {
        ...state.sessionStates,
        [sessionId]: { ...ss, terminalSize: { cols, rows } },
      },
    }));
  },

  // #5835 Phase 2: ask the server to resize a session's live PTY so the real TUI
  // uses the viewer's available pane. The server enforces the actual authority
  // (only the primary owner / sole viewer drives the shared PTY) and broadcasts
  // the applied size back as terminal_size, so this is a best-effort request — a
  // closed socket or an observer role simply means the size doesn't change.
  requestTerminalResize: (sessionId: string, cols: number, rows: number) => {
    const { socket } = get();
    if (sessionId && cols > 0 && rows > 0 && socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'terminal_resize', sessionId, cols, rows });
    }
  },

  // #5835 Phase 3: forward raw keystrokes to a session's live PTY (true remote
  // control). Best-effort — the server enforces the single-driver authority (only
  // the primary owner / sole viewer drives; an observer's keystroke is rejected
  // with input_conflict). The dashboard also gates locally on role, so an
  // observer's keys never reach here, avoiding per-keystroke input_conflict toasts.
  //
  // Chunk large payloads (Copilot review): a single keystroke is a few bytes, but
  // a bracketed paste fires one onData with the whole clipboard, which can exceed
  // TerminalInputSchema's 100k cap — the server would reject that frame and drop
  // the paste. Split into sub-cap frames (the PTY is an ordered byte stream, so
  // splitting is transparent), and never split a UTF-16 surrogate pair across a
  // boundary so an emoji at the seam can't corrupt into lone surrogates.
  sendTerminalInput: (sessionId: string, data: string) => {
    const { socket } = get();
    if (!sessionId || !data || !socket || socket.readyState !== WebSocket.OPEN) return;
    const MAX = 65536; // comfortably under TerminalInputSchema.data.max(100000)
    if (data.length <= MAX) {
      wsSend(socket, { type: 'terminal_input', sessionId, data });
      return;
    }
    let i = 0;
    while (i < data.length) {
      let end = Math.min(i + MAX, data.length);
      // If the boundary lands on a high surrogate, defer it to the next chunk so a
      // surrogate pair is never split (which would write lone surrogates to the PTY).
      if (end < data.length) {
        const code = data.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      wsSend(socket, { type: 'terminal_input', sessionId, data: data.slice(i, end) });
      i = end;
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

  // Mailbox (#5914 follow-up): request a mailbox snapshot. Mirrors
  // requestHostStatus — sends `mailbox_status_request`, flips
  // `mailboxStatusLoading`, returns false (without setting loading) when the
  // socket is closed.
  requestMailboxStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ mailboxStatusLoading: true });
      wsSend(socket, { type: 'mailbox_status_request' });
      return true;
    }
    return false;
  },

  // #5969 (epic #5422 phase 4): request the live external-session snapshot for
  // mission control. Mirrors requestMailboxStatus — sends
  // `external_sessions_request`, flips `externalSessionsLoading`, returns false
  // (without setting loading) when the socket is closed.
  requestExternalSessions: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ externalSessionsLoading: true });
      wsSend(socket, { type: 'external_sessions_request' });
      return true;
    }
    return false;
  },

  // #5966 (epic #5422 phase 5): request the buffered repo-events snapshot for the
  // Control Room pane. Mirrors requestExternalSessions — sends
  // `repo_events_request`, flips `repoEventsLoading`, returns false (without
  // setting loading) when the socket is closed.
  requestRepoEvents: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ repoEventsLoading: true });
      wsSend(socket, { type: 'repo_events_request' });
      return true;
    }
    return false;
  },

  // #6691 (S-3): request the orchestration runs-list snapshot for the Runs tab.
  // Mirrors requestRepoEvents — wire-or-nothing (loading flips only when the
  // socket is OPEN).
  requestOrchestrationRuns: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ orchestrationRunsLoading: true });
      wsSend(socket, { type: 'orchestration_runs_request' });
      return true;
    }
    return false;
  },

  // #6691 (S-3): request one run's full detail snapshot. Also the resync path
  // when a delta seq gap marks the held detail stale. Clears the run's stale
  // flag/error on dispatch so the panel shows a clean loading state.
  requestOrchestrationRunDetail: (runId: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const loading = new Set(get().orchestrationRunDetailLoading);
      loading.add(runId);
      // NOTE: the stale flag is NOT cleared here — it marks a seq gap and must
      // persist (visible as "resyncing…") until a VALID snapshot lands (the
      // snapshot handler clears it). A previous error IS cleared: this is a
      // fresh attempt.
      const errors = { ...get().orchestrationRunDetailErrors };
      delete errors[runId];
      set({ orchestrationRunDetailLoading: loading, orchestrationRunDetailErrors: errors });
      // requestId encodes the target run so the degraded `run: null` reply can
      // be routed back to the right per-run error/loading slots.
      wsSend(socket, { type: 'orchestration_run_detail_request', runId, requestId: `detail:${runId}` });
      return true;
    }
    return false;
  },

  // #6691 (S-3): select a run in the Runs tab.
  selectRun: (runId: string | null): void => {
    set({ selectedRunId: runId });
  },

  // #6691 (S-3c): the mutating orchestration actions. All wire-or-nothing —
  // the pending entry is written ONLY after wsSend genuinely puts the message on
  // the wire (never queued offline), keyed by the requestId the server echoes on
  // the orchestration_action_ack / ORCHESTRATION_ACTION_FAILED session_error.
  startOrchestrationRun: (opts: {
    preset?: string; epicPrompt?: string; cwd: string; title?: string;
    budgetUsd?: number; autoApprovePlan?: boolean;
    roles?: Record<string, { provider: string; model: string }>;
  }): string | null => {
    const { socket } = get();
    if (!opts.cwd || (!opts.preset && !opts.epicPrompt)) return null;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestId = `orch-start-${nextMessageId()}`;
    const msg: Record<string, unknown> = { type: 'orchestration_run_start', cwd: opts.cwd, requestId };
    if (opts.preset) msg.preset = opts.preset;
    if (opts.epicPrompt) msg.epicPrompt = opts.epicPrompt;
    if (opts.title) msg.title = opts.title;
    // the wire schema is z.number().positive().finite() — only forward a real cap
    if (typeof opts.budgetUsd === 'number' && Number.isFinite(opts.budgetUsd) && opts.budgetUsd > 0) msg.budgetUsd = opts.budgetUsd;
    if (typeof opts.autoApprovePlan === 'boolean') msg.autoApprovePlan = opts.autoApprovePlan;
    if (opts.roles && Object.keys(opts.roles).length > 0) msg.roles = opts.roles;
    if (!wsSend(socket, msg)) return null;
    set({ orchestrationPendingActions: { ...get().orchestrationPendingActions, [requestId]: { kind: 'start', runId: '', at: Date.now() } } });
    return requestId;
  },

  sendOrchestrationGateResponse: (runId: string, gateId: string, decision: 'approve' | 'reject' | 'revise' | 'skip', note?: string, budgetUsd?: number): string | null => {
    const { socket } = get();
    if (!runId || !gateId) return null;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestId = `orch-gate-${nextMessageId()}`;
    const msg: Record<string, unknown> = { type: 'orchestration_gate_response', runId, gateId, decision, requestId };
    if (note) msg.note = note;
    // wire schema is z.number().positive().finite() — only forward a real cap
    if (typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd > 0) msg.budgetUsd = budgetUsd;
    if (!wsSend(socket, msg)) return null;
    set({ orchestrationPendingActions: { ...get().orchestrationPendingActions, [requestId]: { kind: 'gate_response', runId, gateId, at: Date.now() } } });
    return requestId;
  },

  sendOrchestrationRunAction: (runId: string, action: 'cancel' | 'pause' | 'resume'): string | null => {
    const { socket } = get();
    if (!runId) return null;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestId = `orch-action-${nextMessageId()}`;
    if (!wsSend(socket, { type: 'orchestration_run_action', runId, action, requestId })) return null;
    set({ orchestrationPendingActions: { ...get().orchestrationPendingActions, [requestId]: { kind: action, runId, at: Date.now() } } });
    return requestId;
  },

  sendOrchestrationRunAnnotate: (runId: string, opts: { baselineSessionId?: string; verdictQuality?: string }): string | null => {
    const { socket } = get();
    if (!runId || (!opts.baselineSessionId && opts.verdictQuality === undefined)) return null;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestId = `orch-annotate-${nextMessageId()}`;
    const msg: Record<string, unknown> = { type: 'orchestration_run_annotate', runId, requestId };
    if (opts.baselineSessionId) msg.baselineSessionId = opts.baselineSessionId;
    if (opts.verdictQuality !== undefined) msg.verdictQuality = opts.verdictQuality;
    if (!wsSend(socket, msg)) return null;
    set({ orchestrationPendingActions: { ...get().orchestrationPendingActions, [requestId]: { kind: 'annotate', runId, at: Date.now() } } });
    return requestId;
  },

  // #6543 (IDE P3 feature B): pull the full redacted tool input for a pending
  // permission so the prompt can render a per-hunk pre-write diff. The reply is a
  // single `permission_input` handled into `permissionInputs[requestId]`. Returns
  // whether the request went on the wire (false = socket closed).
  requestPermissionInput: (requestId: string): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'get_permission_input', requestId });
      return true;
    }
    return false;
  },

  // #5553 — per-repo session preset surface. Each dispatches the matching
  // host-authority message; the server replies with a `session_preset_snapshot`
  // that lands in `sessionPresetSnapshots[cwd]`. Returns whether the message
  // went on the wire (false = socket closed).
  requestSessionPreset: (cwd: string): boolean => {
    const { socket } = get();
    if (!cwd || !socket || socket.readyState !== WebSocket.OPEN) return false;
    wsSend(socket, { type: 'session_preset_get', cwd });
    return true;
  },
  setSessionPresetOverride: (cwd, preset): boolean => {
    const { socket } = get();
    if (!cwd || !socket || socket.readyState !== WebSocket.OPEN) return false;
    wsSend(socket, { type: 'session_preset_set', cwd, preset });
    return true;
  },
  approveSessionPreset: (cwd: string): boolean => {
    const { socket } = get();
    if (!cwd || !socket || socket.readyState !== WebSocket.OPEN) return false;
    wsSend(socket, { type: 'session_preset_approve', cwd });
    return true;
  },
  revokeSessionPreset: (cwd: string): boolean => {
    const { socket } = get();
    if (!cwd || !socket || socket.readyState !== WebSocket.OPEN) return false;
    wsSend(socket, { type: 'session_preset_revoke', cwd });
    return true;
  },
  takePendingServerSeed: (sessionId: string): string | null => {
    const map = get().pendingServerSeed;
    const seed = map[sessionId];
    if (typeof seed !== 'string' || seed.length === 0) return null;
    const next = { ...map };
    delete next[sessionId];
    set({ pendingServerSeed: next });
    return seed;
  },

  // #5510 (epic #5509): approve a pending pair request. Sends `pair_approve`
  // and optimistically drops the request from the local queue (the server also
  // retracts it via `pair_resolved` to every host surface). Returns false when
  // the socket is closed (the banner stays so the operator can retry once
  // reconnected). The verify code is never sent — the operator already compared
  // it out-of-band; only `requestId` travels.
  approvePairRequest: (requestId: string): boolean => {
    const { socket } = get();
    if (!requestId || !socket || socket.readyState !== WebSocket.OPEN) return false;
    wsSend(socket, { type: 'pair_approve', requestId });
    set((s) => ({ pendingPairRequests: s.pendingPairRequests.filter((p) => p.requestId !== requestId) }));
    return true;
  },

  // #5510: deny a pending pair request. Same optimistic-drop + wire-result
  // contract as approvePairRequest.
  denyPairRequest: (requestId: string): boolean => {
    const { socket } = get();
    if (!requestId || !socket || socket.readyState !== WebSocket.OPEN) return false;
    wsSend(socket, { type: 'pair_deny', requestId });
    set((s) => ({ pendingPairRequests: s.pendingPairRequests.filter((p) => p.requestId !== requestId) }));
    return true;
  },

  // #5513: clear the approval-gated redemption signal once the UI has consumed
  // it (opened the request-pair panel) so it doesn't re-trigger.
  clearPendingApprovalPairHost: (): void => {
    set({ pendingApprovalPairHost: null });
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

  // #6133 (epic #5530): request a containers & environments survey. Mirrors
  // requestRunnerStatus — flips containersStatusLoading and sends a
  // containers_status_request; the reply is a single containers_status_snapshot
  // handled into containersStatus. Returns false (and does NOT set loading) when
  // the socket is closed.
  requestContainersStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ containersStatusLoading: true });
      wsSend(socket, { type: 'containers_status_request' });
      return true;
    }
    return false;
  },

  // #6139 (epic #5530): request a per-repo runtime config survey. Mirrors
  // requestContainersStatus — flips repoRuntimeConfigLoading and sends a
  // repo_runtime_config_request; the reply is a single
  // repo_runtime_config_snapshot handled into repoRuntimeConfig. Returns false
  // (and does NOT set loading) when the socket is closed.
  requestRepoRuntimeConfig: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ repoRuntimeConfigLoading: true });
      wsSend(socket, { type: 'repo_runtime_config_request' });
      return true;
    }
    return false;
  },

  // #6135 (epic #5530): request a BYOK pool survey. Mirrors
  // requestContainersStatus — flips byokPoolStatusLoading and sends a
  // byok_pool_status_request; the reply is a single byok_pool_status_snapshot
  // handled into byokPoolStatus. Returns false (and does NOT set loading) when
  // the socket is closed.
  requestByokPoolStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ byokPoolStatusLoading: true });
      wsSend(socket, { type: 'byok_pool_status_request' });
      return true;
    }
    return false;
  },

  // #6140 (epic #5530): request a host prune survey. Mirrors
  // requestByokPoolStatus — flips hostPruneStatusLoading and sends a
  // host_prune_status_request; the reply is a single host_prune_status_snapshot
  // handled into hostPruneStatus. Returns false (no loading) when the socket is
  // closed.
  requestHostPruneStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ hostPruneStatusLoading: true });
      wsSend(socket, { type: 'host_prune_status_request' });
      return true;
    }
    return false;
  },

  // #6136 (epic #5530): request an iOS simulator survey. Mirrors
  // requestHostPruneStatus — flips simulatorStatusLoading and sends a
  // simulator_status_request; the reply is a single simulator_status_snapshot
  // handled into simulatorStatus. Returns false (no loading) when the socket is
  // closed.
  requestSimulatorStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ simulatorStatusLoading: true });
      wsSend(socket, { type: 'simulator_status_request' });
      return true;
    }
    return false;
  },

  // #6137 (epic #5530): request an Android emulator survey. Mirrors
  // requestSimulatorStatus — flips emulatorStatusLoading and sends an
  // emulator_status_request; the reply is a single emulator_status_snapshot
  // handled into emulatorStatus. Returns false (no loading) when the socket is
  // closed.
  requestEmulatorStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ emulatorStatusLoading: true });
      wsSend(socket, { type: 'emulator_status_request' });
      return true;
    }
    return false;
  },

  // #6138 (epic #5530): request a WSL2 distro survey. Mirrors
  // requestEmulatorStatus — flips wslStatusLoading and sends a
  // wsl_status_request; the reply is a single wsl_status_snapshot handled into
  // wslStatus. Returns false (and does NOT set loading) when the socket is
  // closed.
  requestWslStatus: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ wslStatusLoading: true });
      wsSend(socket, { type: 'wsl_status_request' });
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

  // #5554 (epic #5159): request a Skills inventory survey. Mirrors
  // requestIntegrationStatus — flips skillsInventoryLoading and sends a
  // skills_inventory_request; the reply is a single skills_inventory_snapshot
  // handled into skillsInventory. Returns false (and does NOT set loading) when
  // the socket is closed.
  requestSkillsInventory: (): boolean => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ skillsInventoryLoading: true });
      wsSend(socket, { type: 'skills_inventory_request' });
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

  // #5502 (epic #5498): re-run a FAILED repo-relay run for one surveyed repo.
  // Same contract as sendRepoMemoryReindex: pending state flips ONLY when the
  // message is genuinely on the wire (never queued offline — a re-run that
  // drains seconds later would strand the row "Re-running…" with no ack ever
  // arriving), and the repo's previous inline result is dropped so a stale
  // outcome can't sit next to the pending state. The runId is the databaseId
  // the snapshot surfaced; the server re-validates it before any exec.
  sendRepoRelayRerun: (repoPath: string, runId: number): boolean => {
    const { socket } = get();
    if (!repoPath || !Number.isInteger(runId) || runId < 0) return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `relay-rerun-${nextMessageId()}`;
    const pending = new Set(get().relayRerunningRepoPaths);
    pending.add(repoPath);
    const results = { ...get().relayRerunResults };
    delete results[repoPath];
    set({ relayRerunningRepoPaths: pending, relayRerunResults: results });
    wsSend(socket, { type: 'integration_action', action: 'repo_relay_rerun', repoPath, runId, requestId });
    return true;
  },

  // #6134 (epic #5530): run a container lifecycle action (stop / restart /
  // destroy) for one surveyed environment. Same wire-or-nothing contract as
  // sendRepoMemoryReindex: tag the request with an opaque requestId the server
  // echoes on the `containers_action_ack` / CONTAINER_ACTION_FAILED
  // session_error, and mark the environment pending ONLY when the request is
  // genuinely on the wire — never queued offline (an action that drains
  // seconds later would strand the row mid-action with no ack arriving). The
  // environmentId is the survey's own id; the server re-validates it against
  // the live EnvironmentManager set before any exec. The row's previous inline
  // result is dropped so a stale outcome can't sit next to the pending state.
  // Destroy confirmation lives in the UI — this just sends.
  sendContainersAction: (environmentId: string, action: 'stop' | 'restart' | 'destroy'): boolean => {
    const { socket } = get();
    if (!environmentId) return false;
    if (action !== 'stop' && action !== 'restart' && action !== 'destroy') return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `container-action-${nextMessageId()}`;
    const pending = new Set(get().containerActioningIds);
    pending.add(environmentId);
    const results = { ...get().containerActionResults };
    delete results[environmentId];
    set({ containerActioningIds: pending, containerActionResults: results });
    wsSend(socket, { type: 'containers_action', action, environmentId, requestId });
    return true;
  },

  // #6135 slice 3 (epic #5530): run a BYOK pool mutating action. The pool is a
  // single process-wide singleton, so the target id keys the pending/result
  // state: 'drain' (pool-wide), 'recycle:<key>' (one bucket), 'resize'
  // (pool-wide). Same wire-or-nothing contract as sendContainersAction — tag the
  // request with a requestId the server echoes on the byok_pool_action_ack /
  // BYOK_POOL_ACTION_FAILED session_error, and mark the target pending ONLY when
  // the message is genuinely on the wire (never queued offline). For recycle the
  // bucket key is required and is the survey's own key — the server re-validates
  // it against the live pool's inspect() before any exec. For resize the caps are
  // passed through and the server clamps them to the configured ceiling. The
  // target's previous inline result is dropped so a stale outcome can't sit next
  // to the pending state. Drain/recycle confirmation lives in the UI.
  sendByokPoolAction: (
    action: 'drain' | 'recycle' | 'resize',
    opts?: { key?: string; maxPerKey?: number; maxTotal?: number },
  ): boolean => {
    const { socket } = get();
    if (action !== 'drain' && action !== 'recycle' && action !== 'resize') return false;
    if (action === 'recycle' && !opts?.key) return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const targetId = action === 'recycle' ? `recycle:${opts!.key}` : action;
    const requestId = `byok-pool-action-${nextMessageId()}`;
    const pending = new Set(get().byokPoolActioningIds);
    pending.add(targetId);
    const results = { ...get().byokPoolActionResults };
    delete results[targetId];
    set({ byokPoolActioningIds: pending, byokPoolActionResults: results });
    const msg: Record<string, unknown> = { type: 'byok_pool_action', action, requestId };
    if (action === 'recycle') msg.key = opts!.key;
    if (action === 'resize') {
      if (typeof opts?.maxPerKey === 'number') msg.maxPerKey = opts.maxPerKey;
      if (typeof opts?.maxTotal === 'number') msg.maxTotal = opts.maxTotal;
    }
    wsSend(socket, msg);
    return true;
  },

  // #6140 slice 2 (epic #5530): run a host prune for one `kind`
  // (containers/images/all). The pending/result state is keyed by the kind. Same
  // wire-or-nothing contract as the sibling actions: tag with a requestId the
  // server echoes on the host_prune_action_ack / HOST_PRUNE_ACTION_FAILED
  // session_error, and mark the kind pending ONLY when the message is genuinely
  // on the wire. The server takes no target list — it re-surveys the chroxy-scoped
  // orphan set and removes only those ids. The kind's previous result is dropped
  // so a stale outcome can't sit beside the pending state. Confirmation lives in
  // the UI.
  sendHostPruneAction: (kind: 'containers' | 'images' | 'all'): boolean => {
    const { socket } = get();
    if (kind !== 'containers' && kind !== 'images' && kind !== 'all') return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `host-prune-action-${nextMessageId()}`;
    const pending = new Set(get().hostPruneActioningIds);
    pending.add(kind);
    const results = { ...get().hostPruneActionResults };
    delete results[kind];
    set({ hostPruneActioningIds: pending, hostPruneActionResults: results });
    wsSend(socket, { type: 'host_prune_action', kind, requestId });
    return true;
  },

  // #6136 slice 3 (epic #5530): boot / shut down an iOS simulator. The
  // pending/result state is keyed by the device `udid`. Same wire-or-nothing
  // contract as the sibling actions: tag with a requestId the server echoes on
  // the simulator_action_ack / SIMULATOR_ACTION_FAILED session_error, and mark
  // the udid pending ONLY when the message is genuinely on the wire. The server
  // re-surveys + re-validates the udid (lookup key, never a trusted target) and
  // state-gates the action. The udid's previous result is dropped so a stale
  // outcome can't sit beside the pending state. Non-destructive → no confirm.
  sendSimulatorAction: (action: 'boot' | 'shutdown', udid: string): boolean => {
    const { socket } = get();
    if (action !== 'boot' && action !== 'shutdown') return false;
    if (!udid) return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `simulator-action-${nextMessageId()}`;
    const pending = new Set(get().simulatorActioningIds);
    pending.add(udid);
    const results = { ...get().simulatorActionResults };
    delete results[udid];
    set({ simulatorActioningIds: pending, simulatorActionResults: results });
    wsSend(socket, { type: 'simulator_action', action, udid, requestId });
    return true;
  },

  // #6137 (epic #5530): boot an AVD / kill a running Android emulator. The
  // pending/result state is keyed by the target (avd for boot, serial for kill).
  // Same wire-or-nothing contract as the sibling actions. Non-destructive → no
  // confirm. The server re-surveys + re-validates the target and state-gates it.
  sendEmulatorAction: (action: 'boot' | 'kill', opts: { avd?: string; serial?: string; headless?: boolean }): boolean => {
    const { socket } = get();
    if (action !== 'boot' && action !== 'kill') return false;
    const targetId = action === 'boot' ? opts?.avd : opts?.serial;
    if (!targetId) return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `emulator-action-${nextMessageId()}`;
    const pending = new Set(get().emulatorActioningIds);
    pending.add(targetId);
    const results = { ...get().emulatorActionResults };
    delete results[targetId];
    set({ emulatorActioningIds: pending, emulatorActionResults: results });
    const msg: Record<string, unknown> = { type: 'emulator_action', action, requestId };
    if (action === 'boot') {
      msg.avd = opts.avd;
      if (opts.headless) msg.headless = true;
    } else {
      msg.serial = opts.serial;
    }
    wsSend(socket, msg);
    return true;
  },

  // #6138 (epic #5530): start / terminate a WSL2 distro. The pending/result
  // state is keyed by the distro name. Same wire-or-nothing contract as the
  // sibling actions. Non-destructive (no data loss) → no confirm. The server
  // re-surveys + re-validates the distro and state-gates it (start requires
  // Stopped, terminate requires Running).
  sendWslAction: (action: 'start' | 'terminate', distro: string): boolean => {
    const { socket } = get();
    if (action !== 'start' && action !== 'terminate') return false;
    if (!distro) return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = `wsl-action-${nextMessageId()}`;
    const pending = new Set(get().wslActioningIds);
    pending.add(distro);
    const results = { ...get().wslActionResults };
    delete results[distro];
    set({ wslActioningIds: pending, wslActionResults: results });
    wsSend(socket, { type: 'wsl_action', action, distro, requestId });
    return true;
  },

  // #5547: request a server-side one-shot summary of a session's persisted
  // history. Returns a promise resolved by the `summarize_session_result`
  // handler (or rejected by the SUMMARIZE_FAILED session_error / a disconnect).
  // Not queued offline — if the socket is closed we reject immediately so the
  // caller's UI surfaces an error rather than awaiting a reply that never comes.
  summarizeSession: (sessionId: string): Promise<{ summary: string; truncated: boolean }> => {
    const { socket } = get();
    if (!sessionId || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected — cannot summarize this session.'));
    }
    const requestId = `summarize-${nextMessageId()}`;
    return new Promise((resolve, reject) => {
      // Watchdog: a one-shot model turn is slow (much longer than the evaluator
      // round-trip), so allow 5min — but never leave the entry pending forever
      // if the server stalls or drops the reply while the socket stays open.
      // cancelSummarizeRequest clears the entry; we reject the promise here.
      const timeoutId = setTimeout(() => {
        cancelSummarizeRequest(requestId);
        reject(new Error('Summary request timed out after 5 minutes.'));
      }, 5 * 60_000);
      registerSummarizeRequest(requestId, { resolve, reject, timeoutId });
      wsSend(socket, { type: 'summarize_session', sessionId, requestId });
    });
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
      // #6302 — the flat-state fallback has no active session, so no optimistic
      // pending turn owns it.
      pendingClientMessageId: null,
      claudeReady: get().claudeReady,
      activeModel: get().activeModel,
      permissionMode: get().permissionMode,
      contextUsage: get().contextUsage,
      contextOccupancy: get().contextOccupancy,
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
      // #5589 / #5281: null until the first session_role for this session
      // arrives (the UI treats null as unclaimed).
      sessionRole: null,
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
      // #5937: no queued message in the flat-state fallback — queue events are
      // routed by sessionId, which only populates after a session_list snapshot.
      queuedMessages: EMPTY_QUEUED_MESSAGES,
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

  // Initial connection uses bounded retries (CONNECT_MAX_RETRIES) climbing the
  // fixed CONNECT_RETRY_DELAYS ladder ([1000,2000,3000,5000,8000]ms).
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
      console.log(`[ws] Connection attempt ${_retryCount + 1}/${CONNECT_MAX_RETRIES + 1}...`);
    }

    // #5597 — re-resolve the live endpoint (URL + token) for the active registry
    // server. Falls back to the closure-captured `url`/`token` for the local
    // same-origin target (no registry entry) or a stale/desynced active id, so
    // a manual local connect or a mid-edit registry never loses its endpoint.
    const resolveActiveEndpoint = (
      fallbackUrl: string,
      fallbackToken: string,
    ): ConnectEndpoint => {
      const sid = get().activeServerId;
      if (!sid) return { url: fallbackUrl, token: fallbackToken };
      const entry = get().serverRegistry.find((s) => s.id === sid);
      if (!entry) return { url: fallbackUrl, token: fallbackToken };
      return { url: entry.wsUrl, token: entry.token || fallbackToken };
    };

    // #5556 sub-item 4 — the HTTP health check / restart-detect / retry-or-
    // give-up decision tree now lives in the shared `runConnectAttempt`. The
    // dashboard supplies the EFFECTS as callbacks (single-store `set()` writes,
    // the console give-up + clearSavedConnection, the `_pairingId`-threaded
    // recursion); the algorithm (which branch, when to retry, what delay) is
    // shared with the app. #5621 — consume the shared CONNECT_MAX_RETRIES /
    // CONNECT_RETRY_DELAYS defaults directly instead of re-declaring the ladder.
    void runConnectAttempt({
      attempt: _retryCount,
      maxRetries: CONNECT_MAX_RETRIES,
      retryDelays: CONNECT_RETRY_DELAYS,
      // #5597 seam — re-resolve the endpoint per attempt instead of dialing the
      // closure-captured URL/token forever. The dashboard already re-read the
      // registry TOKEN per reconnect (#5281); this mirrors that for the URL, so
      // a registry entry whose `wsUrl` was repointed mid-ladder (e.g. another
      // tab edited it, or a rotated endpoint was written back) is dialed on the
      // next health-check retry instead of the dead captured URL. Returns null
      // when superseded so the probe is skipped.
      resolveEndpoint: (): ConnectEndpoint | null =>
        myAttemptId !== connectionAttemptId ? null : resolveActiveEndpoint(url, token),
      isStale: () => myAttemptId !== connectionAttemptId,
      // The HTTP `/health` GET — root path (/) not /ws (GET /ws returns 404) —
      // with the 5s abort, mapped to a ProbeResult. #4771: the shared
      // getHealthCheckErrorMessage gives distinct copy for AbortError / HTTP
      // 4xx / 5xx / other instead of the raw status string.
      probe: async (endpoint): Promise<ProbeResult> => {
        const httpBase = endpoint.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        const httpUrl = new URL('/', httpBase).href;
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
          connectionPhase: 'server_restarting',
          shutdownReason: currentState.shutdownReason ?? 'restart',
          restartEtaMs,
          restartingSince: currentState.restartingSince || Date.now(),
        });
        console.log(`[ws] Server is restarting, will retry (attempt ${_retryCount + 1}/${CONNECT_MAX_RETRIES + 1})`);
      },
      onProbeFailed: (reason) => {
        set({ connectionError: reason });
      },
      onTerminalDown: () => {
        // Superseded by a newer attempt — don't clobber it (parity with
        // scheduleRetry / onGaveUp + the app's onTerminalDown). Redundant with
        // store-core's synchronous isStale() today, but guards against a future
        // await sneaking in before this callback.
        if (myAttemptId !== connectionAttemptId) return;
        // #6023: supervisor gave up — latch the terminal server_down state
        // immediately instead of climbing the full retry ladder. The reconnect
        // banner / footer already render this phase; retryConnection() resets it.
        set({ connectionPhase: 'server_down', connectionError: 'Server appears to be down' });
        console.warn('[chroxy] Server appears to be down (supervisor gave up). Reconnect manually when it is back.');
      },
      scheduleRetry: (nextAttempt, delayMs) => {
        console.log(`[ws] Retrying in ${delayMs}ms...`);
        setTimeout(() => {
          if (myAttemptId !== connectionAttemptId) return;
          // #5597 — re-resolve the registry endpoint so a repointed `wsUrl`
          // (or token) is dialed on the next attempt, not the dead captured one.
          const next = resolveActiveEndpoint(url, token);
          get().connect(next.url, next.token, { silent, _retryCount: nextAttempt, ...(pairingId ? { _pairingId: pairingId } : {}) });
        }, delayMs);
      },
      onRestartGaveUp: () => {
        set({ connectionPhase: 'disconnected', connectionError: 'Server restart timed out' });
        console.warn(`[chroxy] Connection Failed: The server is still restarting. Try again later.`);
      },
      onProbeGaveUp: () => {
        set({ connectionPhase: 'disconnected', connectionError: 'Could not reach server' });
        console.warn(`[chroxy] Connection Failed: Could not reach the Chroxy server. Make sure it's running.`);
        void get().clearSavedConnection();
      },
    });

    function _connectWebSocket() {
    // Reset encryption state for each new connection (forward secrecy)
    setEncryptionState(null);
    setPendingKeyPair(null);
    // #5721 (item 2) — clear any handshake timer left armed by a prior socket
    // BEFORE this attempt opens, so a reconnect that re-enters onopen can never
    // leak a second pending timer (the key leak-prevention site).
    clearHandshakeTimer();
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
    // #5556 sub-item 4 — the per-socket dedup + ladder-advance + jittered-delay
    // mechanics now live in the shared `createReconnectScheduler`. The
    // dashboard keeps its PLATFORM guards (userDisconnected / stale-attempt) and
    // its phase/error writes in the `scheduleReconnect` WRAPPER below — the app
    // guards in its onclose/onerror callers, so the shared scheduler stays
    // guard-free and both clients converge on the same dedup+ladder core.
    //
    // The `reconnect` callback re-resolves the token from the registry (#5281
    // ③ PR 2): a paired connection started with an empty token; auth_ok wrote
    // the issued session token back to the registry, so the reconnect must use
    // that, not the stale captured (empty) token. The shared scheduler's own
    // stale-attempt guard covers the timer-fire boundary.
    const reconnectScheduler = createReconnectScheduler({
      nextRung: nextReconnectAttempt,
      // #5597 — re-resolve the registry endpoint (URL + token) on each socket-
      // close reconnect. Previously only the token was re-read (#5281); the URL
      // was the closure-captured one, so a registry entry whose `wsUrl` was
      // repointed kept re-dialing the dead URL up the whole ladder. Now both
      // come from the live active registry entry.
      reconnect: () => {
        const next = resolveActiveEndpoint(url, token);
        get().connect(next.url, next.token);
      },
      isStale: () => myAttemptId !== connectionAttemptId,
      retryDelays: CONNECT_RETRY_DELAYS,
      // #5698 — stop the reconnect ladder after RECONNECT_MAX_RUNG rungs and go
      // terminal instead of spinning forever. A user-initiated retryConnection()
      // resets the counter (resetReconnectAttempt), so this is not permanent.
      maxRung: RECONNECT_MAX_RUNG,
      onGaveUp: () => {
        if (myAttemptId !== connectionAttemptId) return; // superseded — don't clobber a newer attempt
        console.log('[ws] reconnect ladder exhausted — server appears down');
        set({
          connectionPhase: 'server_down',
          connectionError: 'Server appears to be down',
        });
      },
    });
    const scheduleReconnect = (
      reasonText: string,
      errorMessage: string | null,
    ): void => {
      // Platform guards run BEFORE the ladder advances, so a user-initiated
      // close / superseded attempt doesn't burn a rung (these used to live
      // inside scheduleReconnect's body — kept here verbatim).
      if (reconnectScheduler.scheduled) return;
      if (get().userDisconnected) return;
      if (disconnectedAttemptId === myAttemptId) return;
      // #5555.5 — climb the CONNECT_RETRY_DELAYS ladder (was a fixed 1.5s/2s). The
      // per-socket dedupe means a paired error → close drop advances the ladder
      // exactly once. The ladder resets on `auth_ok`, so a clean reconnect
      // starts back at the bottom (1s).
      const armed = reconnectScheduler.schedule();
      // #5698 — schedule() returns false here only when the ladder hit maxRung
      // (the top `scheduled` guard already handled the dedup case). onGaveUp has
      // set the terminal 'server_down' phase; don't overwrite it with
      // 'reconnecting'.
      if (!armed) return;
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
          // #5555 (eager key exchange) — generate this connection's ephemeral
          // keypair + salt now and send them WITH auth. If the server honours
          // the eager path it returns serverPublicKey in auth_ok and the
          // discrete key_exchange RTT is skipped; otherwise (old server /
          // encryption disabled) the fields are ignored and the auth_ok handler
          // falls back to the discrete handshake using the same stashed keypair.
          const eager = prepareEagerKeyExchange();
          // #5555.3 — send the per-session history cursors so the server
          // replays only entries newer than what we've already applied. Empty
          // on a first connect → omitted → full replay (old-client shape).
          const historyCursors = getHistoryCursors();
          socket.send(JSON.stringify({
            type: 'auth',
            token,
            ...common,
            eagerPublicKey: eager.publicKey,
            eagerSalt: eager.salt,
            ...(Object.keys(historyCursors).length > 0 ? { historyCursors } : {}),
          }));
        }
        // #5721 (item 2) — a handshake frame went out; arm the handshake timer.
        // If auth_ok / key_exchange_ok never completes the handshake within
        // HANDSHAKE_TIMEOUT_MS, fire: drop this half-open socket and hand off to
        // the SAME reconnect ladder a transport error uses (scheduleReconnect),
        // surfacing "Handshake failed — reconnecting" instead of a silent stall
        // until the transport gives up. The success clears live in the auth_ok /
        // key_exchange_ok handlers; teardown clears live in onclose/onerror/
        // disconnect and at the top of the next connect.
        armHandshakeTimer(() => {
          // Superseded by a newer attempt — ignore (mirrors the onclose/onerror
          // stale guard). The current attempt's timer is the only live one.
          if (myAttemptId !== connectionAttemptId) return;
          // Null ALL handlers before closing: onclose/onerror so this manual
          // close doesn't double-dispatch (scheduleReconnect owns recovery), AND
          // onmessage so a frame already queued/in-flight on this wedged socket
          // (a late auth_ok / key_exchange_ok) can't be delivered and mutate
          // store state after we've declared the handshake failed.
          socket.onclose = null;
          socket.onerror = null;
          socket.onmessage = null;
          try { socket.close(); } catch { /* already closing */ }
          scheduleReconnect('Handshake timed out', 'Handshake failed — reconnecting');
        });
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

    socket.onclose = (event?: CloseEvent) => {
      stopHeartbeat();

      // Stale socket from a previous connection attempt — ignore
      if (myAttemptId !== connectionAttemptId) return;

      // #5721 (item 2) — this attempt's socket closed; no handshake left to time.
      // Clear AFTER the stale guard so a late stale-socket close can't cancel the
      // CURRENT attempt's timer. (Idempotent if the handshake already completed.)
      clearHandshakeTimer();

      // #3068: any in-flight evaluator request is now a guaranteed no-op —
      // reject them so awaiters get a fast error instead of waiting 60s for
      // the timeout to fire.
      rejectAllEvaluatorRequests('Connection closed before evaluator response arrived');
      // #5547: a dropped socket means any in-flight summarize_session result
      // will never arrive — reject so an awaiting create-session flow surfaces
      // an error instead of hanging.
      rejectAllSummarizeRequests('Connection closed before the summary arrived');
      // #3587: drop any pending skill_trust_grant correlations — the
      // matching error (if any) will arrive on a different socket (or
      // never), and a stale toast action would call grantCommunitySkillTrust
      // against a closed socket.
      clearPendingTrustGrants();
      clearPendingModelReverts();
      clearPendingPermissionModeReverts();
      clearPendingThinkingLevelReverts();
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
      // #5502: ditto for in-flight relay re-runs.
      if (get().relayRerunningRepoPaths.size > 0) {
        set({ relayRerunningRepoPaths: new Set<string>() });
      }
      // #6134: ditto for in-flight container lifecycle actions — the ack/failure
      // is socket-scoped, so clear pending rows on a drop. (The server-side
      // action keeps running; the next survey refresh shows its effect.)
      if (get().containerActioningIds.size > 0) {
        set({ containerActioningIds: new Set<string>() });
      }
      // #6135: ditto for in-flight BYOK pool actions — the ack/failure is
      // socket-scoped, so clear pending targets on a drop. (The server-side
      // action keeps running; the next survey refresh shows its effect.)
      if (get().byokPoolActioningIds.size > 0) {
        set({ byokPoolActioningIds: new Set<string>() });
      }
      // #6140: ditto for in-flight host prune actions.
      if (get().hostPruneActioningIds.size > 0) {
        set({ hostPruneActioningIds: new Set<string>() });
      }
      // #6136: ditto for in-flight simulator actions.
      if (get().simulatorActioningIds.size > 0) {
        set({ simulatorActioningIds: new Set<string>() });
      }
      // #6137: ditto for in-flight emulator actions.
      if (get().emulatorActioningIds.size > 0) {
        set({ emulatorActioningIds: new Set<string>() });
      }
      // #6138: ditto for in-flight WSL distro actions.
      if (get().wslActioningIds.size > 0) {
        set({ wslActioningIds: new Set<string>() });
      }
      // #6691 (S-3): ditto for in-flight orchestration detail requests + pending
      // mutating actions — a reply can never arrive on the dead socket.
      if (get().orchestrationRunDetailLoading.size > 0) {
        set({ orchestrationRunDetailLoading: new Set<string>() });
      }
      if (Object.keys(get().orchestrationPendingActions).length > 0) {
        set({ orchestrationPendingActions: {} });
      }
      // #6153: reset every Control Room survey *Loading flag that's still true on
      // a socket drop. Each survey section computes refreshDisabled = loading ||
      // !connected, so a refresh in flight when the socket dies would leave
      // loading=true forever — the disabled Refresh button can never clear it
      // post-reconnect (it can't issue the request that would). One DRY sweep
      // over the survey family avoids per-tab drift. (We intentionally KEEP the
      // stale snapshots — the "generated Nm ago" line signals staleness, and a
      // reconnect re-fetches on tab activation; clearing would flash empty.)
      const surveyLoadingKeys = [
        'hostStatusLoading', 'runnerStatusLoading', 'containersStatusLoading',
        'repoRuntimeConfigLoading', 'byokPoolStatusLoading', 'hostPruneStatusLoading',
        'simulatorStatusLoading', 'emulatorStatusLoading', 'wslStatusLoading', 'integrationStatusLoading',
        'skillsInventoryLoading', 'mailboxStatusLoading', 'externalSessionsLoading',
        'repoEventsLoading', 'orchestrationRunsLoading',
      ] as const;
      const loadingReset: Partial<Record<(typeof surveyLoadingKeys)[number], boolean>> = {};
      for (const key of surveyLoadingKeys) {
        if (get()[key]) loadingReset[key] = false;
      }
      if (Object.keys(loadingReset).length > 0) {
        set(loadingReset);
      }

      // Clear transient streaming/plan state so stale UI doesn't persist
      clearPermissionSplits();
      // #5731 T4: clear transient state for EVERY session, not just the
      // active one. A background tab mid-stream otherwise keeps its
      // `streamingMessageId` (a phantom "thinking" bubble), pending plan,
      // inactivity chip, or clarify question across the drop —
      // `handleSessionSwitched` then surfaces that stale state when the
      // user switches to the tab post-reconnect. `updateSession` syncs the
      // active session's flat-state mirror for us, and is a no-op for any
      // session that returns an empty patch.
      const clearTransientSessionState = (
        ss: SessionState,
      ): Partial<SessionState> => {
        const patch: Partial<SessionState> = {};
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
        // #5623: clear the presence role on disconnect so a stale
        // "Observing" / driver badge doesn't persist through the
        // reconnect gap. #5737 added the server-side re-emit, but the
        // client never reset its own copy — so the old role survived
        // the drop (and `ObserverBanner`'s a11y alert re-announced a
        // soon-to-be-cleared "Observing" on every reconnect). The
        // server re-emits `session_role` on reconnect/tab-switch, so
        // the correct role re-establishes once the socket is back; a
        // null role in the meantime reads as "unclaimed" (neutral),
        // not a false "you're observing".
        if (ss.sessionRole !== null) patch.sessionRole = null;
        if (ss.primaryClientId !== null) patch.primaryClientId = null;
        return Object.keys(patch).length > 0 ? patch : {};
      };
      for (const sid of Object.keys(get().sessionStates)) {
        updateSession(sid, clearTransientSessionState);
      }

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

      // #5721 (item 2) — the socket errored mid-handshake or after; cancel the
      // handshake timer so it can't also fire (scheduleReconnect's per-socket
      // dedupe would no-op the second one, but clearing keeps it tidy).
      clearHandshakeTimer();

      // #3605: an unexpected error means any in-flight skill_trust_grant
      // request will never be acked. Clear both the Map-based correlation
      // (#3587) and the per-session arrays (#3588) so the SkillsPanel
      // Trust button doesn't hang across the reconnect.
      rejectAllEvaluatorRequests('Connection errored before evaluator response arrived');
      rejectAllSummarizeRequests('Connection errored before the summary arrived');
      clearPendingTrustGrants();
      clearPendingModelReverts();
      clearPendingPermissionModeReverts();
      clearPendingThinkingLevelReverts();
      const cleanedSessionStates = clearAllSessionPendingTrustGrants(get().sessionStates);

      set({ socket: null, sessionStates: cleanedSessionStates });

      // #3624: auto-reconnect on unexpected WS error (skip if user
      // explicitly disconnected). scheduleReconnect's per-socket
      // `reconnectScheduled` flag short-circuits the close → error
      // ordering (onclose already armed the timer); the error → close
      // ordering is covered symmetrically by onclose's `wasConnected`
      // gate (handler defined above).
      scheduleReconnect('WebSocket error', 'Connection error');
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
    // #5721 (item 2) — user-initiated disconnect: cancel any armed handshake
    // timer so it can't fire (and schedule a reconnect) after an explicit close.
    clearHandshakeTimer();
    // #3068: same as the onclose handler — fail any pending evaluator
    // requests fast instead of waiting on the 60s timeout. We do this both
    // here (user-initiated) and in onclose (transport drop) because we null
    // out socket.onclose below to suppress auto-reconnect.
    rejectAllEvaluatorRequests('Disconnected before evaluator response arrived');
    rejectAllSummarizeRequests('Disconnected before the summary arrived');
    // #3587: paired with rejectAllEvaluatorRequests — clear any pending
    // skill_trust_grant correlations so a stale toast button can't fire
    // against the disconnected socket.
    clearPendingTrustGrants();
    clearPendingModelReverts();
    clearPendingPermissionModeReverts();
    clearPendingThinkingLevelReverts();
    const { socket } = get();
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    // Reset replay flags in case disconnect happened mid-replay
    resetReplayFlags();
    // #5555.3/.4 — explicit disconnect is a hard reset: drop the replay
    // baseline AND the history cursors so a later connect (possibly to a
    // different server) starts from a full replay rather than presenting a
    // stale cursor. (Tunnel-blip RECONNECTS keep cursors — they don't run
    // disconnect(); auth_ok clears only the baseline.)
    resetReplayReconcile({ clearCursors: true });
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
      // #6559 — drop any pulled pre-write-diff inputs on disconnect (per-connection
      // state; mirrors the app disconnect reset so both clients clear the tail if
      // we disconnect mid-prompt). A resolved/expired/timed-out prompt already
      // self-prunes above.
      permissionInputs: {},
      serverPhase: null,
      tunnelProgress: null,
      // #5356: clear exposure on disconnect so a reconnect against a
      // different server can't show a stale banner.
      serverExposure: null,
      exposureBannerDismissed: false,
      // #5821: clear billing canary on disconnect so a reconnect against a
      // different server can't show a stale billing banner.
      billingCanary: null,
      billingBannerDismissed: false,
      shutdownReason: null,
      restartEtaMs: null,
      restartingSince: null,
      pendingPermissionConfirm: null,
      slashCommands: [],
      filePickerFiles: null,
  fileBrowserPendingOpen: null,
  workspaceSymbols: null,
  workspaceSymbolsLoading: false,
  symbolLocation: null,
  codeSearchResults: null,
  codeSearchLoading: false,
  referencesResult: null,
  referencesSymbol: '',
  referencesOpen: false,
  referencesLoading: false,
      customAgents: [],
      checkpoints: [],
      _directoryListingCallback: null,
      _terminalWriteCallback: null,
      contextUsage: null,
      contextOccupancy: null,
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
      // #5502: relay re-run pending/result state goes with it.
      relayRerunningRepoPaths: new Set<string>(),
      relayRerunResults: {},
      // #6134: container lifecycle action pending/result state goes with it.
      containerActioningIds: new Set<string>(),
      containerActionResults: {},
      // #6135: BYOK pool action pending/result state goes with it.
      byokPoolActioningIds: new Set<string>(),
      byokPoolActionResults: {},
      // #6140: host prune action pending/result state goes with it.
      hostPruneActioningIds: new Set<string>(),
      hostPruneActionResults: {},
      // #6136: simulator action pending/result state goes with it.
      simulatorActioningIds: new Set<string>(),
      simulatorActionResults: {},
      // #6137: emulator action pending/result state goes with it.
      emulatorActioningIds: new Set<string>(),
      emulatorActionResults: {},
      // #6138: WSL distro action pending/result state goes with it.
      wslActioningIds: new Set<string>(),
      wslActionResults: {},
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
      // #5502: relay re-run pending/result state goes with it.
      relayRerunningRepoPaths: new Set<string>(),
      relayRerunResults: {},
      // #6134: container lifecycle action pending/result state goes with it.
      containerActioningIds: new Set<string>(),
      containerActionResults: {},
      // #6135: BYOK pool action pending/result state goes with it.
      byokPoolActioningIds: new Set<string>(),
      byokPoolActionResults: {},
      // #6140: host prune action pending/result state goes with it.
      hostPruneActioningIds: new Set<string>(),
      hostPruneActionResults: {},
      // #6136: simulator action pending/result state goes with it.
      simulatorActioningIds: new Set<string>(),
      simulatorActionResults: {},
      // #6137: emulator action pending/result state goes with it.
      emulatorActioningIds: new Set<string>(),
      emulatorActionResults: {},
      // #6138: WSL distro action pending/result state goes with it.
      wslActioningIds: new Set<string>(),
      wslActionResults: {},
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
    const messageId = opts?.clientMessageId || nextMessageId('user');
    const userMsg: ChatMessage = {
      id: messageId,
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
      ...(attachments?.length ? { attachments } : undefined),
    };

    // #5939 (epic #5935 ④): send-while-busy QUEUES instead of starting a new
    // turn. The server holds the message in its outgoing queue and flushes it
    // on turn-complete (slice ①); here we add the optimistic user bubble but do
    // NOT fake a new turn — no thinking indicator, no streamingMessageId reset
    // (the live turn keeps its own) — and record the message id in the per-
    // session `queuedMessages` model so the bubble renders a "Queued" badge
    // (cleared by the server's message_dequeued on flush/cancel). The terminal
    // echo above still fires so the Output view stays consistent.
    if (opts?.queued) {
      const activeId = get().activeSessionId;
      if (activeId && get().sessionStates[activeId]) {
        updateActiveSession((ss) => ({
          // Do NOT filterThinking here: the in-progress turn may still be
          // showing its thinking indicator (e.g. streamingMessageId === 'pending',
          // sent but no stream_start yet). Stripping it would blank the current
          // turn's indicator just because the user queued a follow-up. Append the
          // queued bubble at the tail — after the existing thinking indicator,
          // which stays attributed to the live turn — so it reads as "queued
          // behind" rather than "now processing".
          messages: [...ss.messages, userMsg],
          queuedMessages: enqueueOptimisticQueuedMessage(ss.queuedMessages, {
            clientMessageId: messageId,
            text,
            queuedAt: Date.now(),
          }),
        }));
      }
      return;
    }

    const thinkingMsg: ChatMessage = {
      id: 'thinking',
      type: 'thinking',
      content: '',
      timestamp: Date.now(),
    };

    // Write user message to terminal buffer for the Output view. #5835 (PR2):
    // skip this synthetic echo for claude-tui — its Output tab now shows the live
    // PTY mirror (alternate-screen), where injecting an echo at the cursor would
    // corrupt the redraw. The echo was only ever visible on the Output tab, which
    // is now claude-tui-only, so suppressing it for tui loses nothing elsewhere.
    if (text && !activeSessionIsClaudeTui(get)) {
      get().appendTerminalData(`\r\n\x1b[33m> ${text}\x1b[0m\r\n\r\n`);
    }

    const activeId = get().activeSessionId;
    if (activeId && get().sessionStates[activeId]) {
      updateActiveSession((ss) => ({
        messages: [...filterThinking(ss.messages), userMsg, thinkingMsg],
        streamingMessageId: 'pending',
        // #6302 — record WHICH send owns this 'pending' optimistic turn so a later
        // message_queued only retires it when its clientMessageId matches (the
        // owner check that protects this turn from another client's broadcast
        // queued send in a multi-client session). Flat-state fallback below has no
        // per-session owner (legacy PTY mode, single client) so it omits this.
        pendingClientMessageId: messageId,
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
          pendingClientMessageId: null,
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

    // #5939 / #5952: a send while the turn is in progress is QUEUED by the
    // server, not concurrently force-sent. Reflect that optimistically — render
    // the bubble with a "Queued" badge instead of faking a fresh turn.
    //
    // #5952: the busy signal must match EXACTLY what the InputBar shows as busy
    // (`isStreaming || isBusy` → `streamingMessageId !== null || isIdle === false`)
    // so there is no window where the input UI says "busy" (Stop visible, "Type
    // to send follow-up…") yet a send optimistically fakes a fresh turn. `isIdle`
    // is the server-authoritative working flag (#4639); `streamingMessageId`
    // additionally covers the optimistic pre-status window. Either ⇒ queue. The
    // server is authoritative regardless (it queues any mid-turn input and
    // reconciles via message_queued/message_dequeued), so this only keeps the
    // optimistic render honest.
    const active = get().getActiveSessionState();
    const busy = active.streamingMessageId !== null || active.isIdle === false;

    // Show user message immediately (optimistic update + thinking indicator, or
    // a queued badge when busy). #6632: carry the caller-built MessageAttachment
    // previews (composer images → data: URIs, files → chips) onto the optimistic
    // bubble so the transcript shows what was attached.
    get().addUserMessage(input, options?.previewAttachments, { clientMessageId, queued: busy });

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
      // #6283: socket.readyState can flip OPEN → CLOSING before this synchronous
      // send over a flaky tunnel, so wsSend can throw and return false. Fall
      // through to the offline queue so the frame retries on reconnect instead
      // of leaving a permanently 'sent'-looking bubble that never reached the
      // server.
      result = wsSend(socket, payload) ? 'sent' : enqueueMessage('input', payload);
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
    // #5938 — Stop clears the outgoing queue too (server policy #5936: a
    // deliberate interrupt cancels pending follow-ups rather than auto-firing
    // them). Drop the queued bubbles + entries optimistically so they don't
    // linger as phantom "sent" messages (the bubble id IS the clientMessageId);
    // the server's per-item message_dequeued{interrupted} then no-ops against
    // the cleared queue.
    const interruptState = sid ? get().sessionStates[sid] : undefined;
    if (sid && interruptState) {
      const queued = interruptState.queuedMessages ?? [];
      if (queued.length > 0) {
        const queuedIds = new Set(
          queued.map((q) => q.clientMessageId).filter((id): id is string => !!id),
        );
        updateSession(sid, (ss) => ({
          queuedMessages: EMPTY_QUEUED_MESSAGES,
          messages: ss.messages.filter((m) => !queuedIds.has(m.id)),
        }));
      }
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      // #6308: wsSend can return false on a closing socket (see app sendInterrupt);
      // fall through to the offline queue so the interrupt retries on reconnect
      // rather than reporting a 'sent' that never reached the server.
      if (wsSend(socket, payload)) return 'sent';
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
      // #6308: send BEFORE marking the node "cancelling" — wsSend can throw and
      // return false on a closing socket, and marking first would strand the node
      // "Cancelling…" with no ack/failure ever arriving (the same hazard the offline
      // branch below avoids for non-queueable cancel_activity). Only mark once the
      // frame is genuinely on the wire.
      if (!wsSend(socket, payload)) return false;
      // Key by `${sessionId}:${activityId}` — activity ids (toolUseIds) are only
      // unique within a session, so a global activityId-only set would let one
      // session's cancel disable/clear another's identically-ided node (#5277).
      const cancelling = new Set(get().cancellingActivityIds);
      cancelling.add(`${sid}:${activityId}`);
      set({ cancellingActivityIds: cancelling });
      return 'sent';
    }
    return enqueueMessage('cancel_activity', payload);
  },

  // #5943 (epic #5935 ④): cancel one QUEUED send-while-busy follow-up by its
  // clientMessageId (the optimistic bubble id). Like cancel_activity, it is NOT
  // queued offline — a cancel that drains after a reconnect races the flush — so
  // it fires only on a live socket. Optimistically removes the local queued
  // entry so the badge clears immediately; the server's authoritative
  // message_dequeued(reason: 'cancelled') is idempotent with this removal.
  sendCancelQueued: (clientMessageId: string, sessionId?: string) => {
    const { socket, activeSessionId } = get();
    const sid = sessionId ?? activeSessionId;
    if (!(socket && socket.readyState === WebSocket.OPEN)) return false;
    const payload: Record<string, unknown> = { type: 'cancel_queued', clientMessageId };
    if (sid) payload.sessionId = sid;
    // #6308: cancel_queued is NOT offline-queueable — send BEFORE the optimistic drop
    // and bail on a closing-socket failure (wsSend → false). Dropping first then
    // failing would strand the server's queued message (it flushes next turn) while
    // the local bubble is gone — an orphaned turn. Leaving it keeps the cancel retryable.
    if (!wsSend(socket, payload)) return false;
    // Optimistically remove from the TARGET session's queue (updateSession, not
    // updateActiveSession) so a future cross-session cancel — `sid` resolved
    // from an explicit sessionId rather than the active one — clears the right
    // queue, not whichever session happens to be active.
    if (sid && get().sessionStates[sid]) {
      updateSession(sid, (ss) => ({
        queuedMessages: removeQueuedMessage(ss.queuedMessages, clientMessageId),
        // #5938 — also drop the optimistic bubble (its id IS the clientMessageId);
        // a cancelled message was never sent, so it must not linger as a phantom
        // "sent" bubble once the queued badge clears.
        messages: ss.messages.filter((m) => m.id !== clientMessageId),
      }));
    }
    return 'sent';
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

  sendPermissionResponse: (requestId: string, decision: PermissionDecision, editedInput?: Record<string, string> | null) => {
    const { socket } = get();
    // #5699 — refuse to answer a permission prompt while disconnected. A
    // permission request is NOT safely queueable: the server expires the pending
    // request when the socket drops, so the old `enqueueMessage` path either
    // dropped the answer or replayed it against a dead request — and
    // `markPermissionResolved` below would flip the prompt to "answered" even
    // though the server never received it. That's the #5699 silent-loss bug
    // (you tap Allow on a cached/disconnected session and nothing happens, but
    // the UI says you answered). Returning false leaves the prompt un-answered
    // and actionable; the answer buttons + keyboard shortcuts gate on `connected`
    // in PermissionPrompt.tsx (respond()) so the operator gets clear feedback
    // rather than a dead click.
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    // allowSession: wire decision is still 'allow' — session-scoped behaviour
    // is implemented client-side via a follow-up set_permission_rules message.
    // #6771 allowAlways: sent VERBATIM — the server persists a durable
    // per-project rule (permission-manager.js), no follow-up needed. (The schema
    // accepts 'allow' | 'allowAlways' | 'deny'.)
    const wireDecision = decision === 'allowSession' ? 'allow' : decision;
    // #6543 (feature B): the operator's per-hunk edits ride along on an approve.
    // Only sent when present (a plain Allow omits it); the server whitelists
    // which fields it can substitute (permission-manager.js mergeEditedInput).
    const payload = {
      type: 'permission_response',
      requestId,
      decision: wireDecision,
      ...(editedInput && Object.keys(editedInput).length > 0 && wireDecision !== 'deny' ? { editedInput } : {}),
    };
    // #6308: the socket can flip OPEN → CLOSING before this synchronous send (wsSend
    // → false). Bail BEFORE markPermissionResolved/markPromptAnswered — otherwise the
    // bubble flips to "answered" while the server never saw the frame and auto-denies
    // on timeout, exactly the #5699 silent-loss symptom this function's disconnected
    // guard above was written to prevent. Returning false keeps the prompt actionable.
    if (!wsSend(socket, payload)) return false;
    const result: 'sent' | 'queued' | false = 'sent';
    // Persist the decision in the store so PermissionPrompt renders its
    // answered state across remounts (#2833 — tab switch regression).
    get().markPermissionResolved(requestId, decision);
    // #6222: also mark the prompt ChatMessage `answered`. markPermissionResolved
    // only records the decision in the `resolvedPermissions` map — which flips
    // the bubble's answered UI but is NOT consulted by the shared pending-count
    // derivation (`isLivePermissionPrompt` keys on `m.answered`). Without this,
    // answering a permission FROM THE CHAT STREAM (the inline PermissionPrompt,
    // which calls only sendPermissionResponse) left the "N pending" header
    // indicator (#5667) and the dock badge (#6184) stuck. This makes
    // sendPermissionResponse the single choke point that clears the count for
    // every caller. Store the canonical decision TOKEN ('allow' | 'deny' |
    // 'allowSession'), not a display label — consumers treat `m.answered` as a
    // decision enum (App.tsx's hasPendingAskUserQuestionPermission gate checks
    // `=== 'allow' | 'allowSession'`; PermissionPrompt/ChildAgentEventList map
    // the token to an "Allowed"/"Denied" label for display). Additive to the
    // bubble — PermissionPrompt reads answered from resolvedPermissions, not this.
    get().markPromptAnsweredByRequestId(requestId, decision);
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

  markPermissionResolved: (requestId: string, decision: PermissionDecision) => {
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
    // #5835 (PR2): suppress for claude-tui — same reason as the prompt echo
    // above (the live PTY mirror must not get a synthetic line at its cursor).
    if (answerSummary && !activeSessionIsClaudeTui(get)) {
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
      // #6308: wsSend can return false on a closing socket; fall through to the
      // offline queue so the answer retries on reconnect rather than reporting a
      // 'sent' that never reached the server while the optimistic isIdle/activeTools
      // flips above already make the form look resolved.
      if (wsSend(socket, payload)) return 'sent';
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
    // #5711: remember the model we're switching FROM so a server
    // MODEL_NOT_APPLIED rejection (e.g. a mid-turn no-op, #5696) can roll the
    // optimistic update below back, instead of leaving the dropdown showing a
    // model the session never actually switched to.
    const previousModel = (activeSessionId && get().sessionStates[activeSessionId])
      ? (get().sessionStates[activeSessionId]!.activeModel ?? null)
      : (get().activeModel ?? null);
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Correlate the optimistic update with the server's ack/rejection. The
      // requestId rides set_model's passthrough schema; the server echoes it on
      // a MODEL_NOT_APPLIED error so the handler can revert the right request.
      const requestId = `set-model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      registerModelChangeRequest(requestId, { sessionId: activeSessionId, previousModel });
      const payload: Record<string, unknown> = { type: 'set_model', model, requestId };
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
      // #5609: word the confirm to match the ACTUAL consequence for the
      // active session's provider. On CLI a mid-turn switch interrupts the
      // running turn (subprocess respawn — the #3729 panic-button); on SDK/TUI
      // it applies in-place. Sourced from the provider capability so the copy
      // never silently differs from what actually happens.
      const state = get();
      const activeSession = activeSessionId
        ? state.sessions.find((s) => s.sessionId === activeSessionId)
        : undefined;
      const activeProvider = activeSession?.provider ?? null;
      const caps = state.availableProviders.find(
        (p) => p.name === activeProvider,
      )?.capabilities;
      const isStreaming = !!get().getActiveSessionState().streamingMessageId;
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            buildAutoModeConfirmMessage({
              interruptsTurn: caps?.interruptsTurnOnAutoSwitch,
              isStreaming,
            }),
          )
        : true;
      if (!ok) return;
    }
    // #5716: capture the Shift+Tab toggle target BEFORE we overwrite it below,
    // so a rejected change can restore it too (Copilot review on #5722) — without
    // this, a rejected switch leaves previousPermissionMode pointing at the
    // current mode and the toggle silently becomes a no-op.
    const priorPreviousMode = get().previousPermissionMode ?? null;
    // #5716: remember the mode we're switching FROM, keyed by a requestId the
    // server echoes on a PERMISSION_MODE_NOT_APPLIED rejection, so the error
    // handler can roll the optimistic update below back instead of leaving the
    // dropdown showing a mode the session never entered (a phantom bypass is the
    // dangerous case). Read the live optimistic target, mirroring the write below.
    const previousMode = (activeSessionId && get().sessionStates[activeSessionId])
      ? (get().sessionStates[activeSessionId]!.permissionMode ?? null)
      : (get().permissionMode ?? null);
    const requestId = `set-perm-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Send with confirmed:true for `auto` so the server skips its own confirmation
    // round-trip and broadcasts `permission_mode_changed` directly.
    const payload: Record<string, unknown> = mode === 'auto'
      ? { type: 'set_permission_mode', mode, confirmed: true, requestId }
      : { type: 'set_permission_mode', mode, requestId };
    if (activeSessionId) payload.sessionId = activeSessionId;
    // #6321: when the socket is OPEN we attempt the send and gate the pending
    // registration on its result — if wsSend returns false (the OPEN→CLOSING TOCTOU
    // #6293/#6308/#6310 harden against) there's no server round-trip, so a
    // PERMISSION_MODE_NOT_APPLIED rejection never arrives to revert. Bailing keeps a
    // failed send from leaving a phantom permissionMode (a phantom `auto`/bypass is
    // the dangerous case) or an orphaned pending request. With NO open socket we
    // keep the #3693 offline behavior: still flip locally so the controlled
    // <select> reflects the choice (no round-trip is pending, so nothing to register).
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (!wsSend(socket, payload)) return;
      registerPermissionModeChangeRequest(requestId, { sessionId: activeSessionId, previousMode, priorPreviousMode });
    }
    // Save current mode before switching (for Shift+Tab toggle).
    if (permissionMode && permissionMode !== mode) {
      set({ previousPermissionMode: permissionMode });
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
    // #5731 T9: remember the level we're switching FROM, keyed by a requestId the
    // server echoes on a THINKING_LEVEL_NOT_APPLIED rejection, so the error
    // handler can roll the optimistic update below back instead of leaving the
    // dropdown showing a level the session never entered. Read the live value,
    // mirroring the optimistic write below. (Sibling of setModel/setPermissionMode.)
    const previousLevel = (activeSessionId && get().sessionStates[activeSessionId])
      ? (get().sessionStates[activeSessionId]!.thinkingLevel ?? 'default')
      : 'default';
    const requestId = `set-thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (socket && socket.readyState === WebSocket.OPEN) {
      registerThinkingLevelChangeRequest(requestId, { sessionId: activeSessionId, previousLevel });
      const payload: Record<string, unknown> = { type: 'set_thinking_level', level, requestId };
      if (activeSessionId) payload.sessionId = activeSessionId;
      wsSend(socket, payload);
    }
    // Optimistically update the active session's thinking level so the controlled
    // `<select>` doesn't snap back to the prior value before the server's
    // `thinking_level_changed` broadcast lands. Idempotent — the broadcast
    // re-sets the same value when it arrives. thinkingLevel is per-session only.
    if (activeSessionId && get().sessionStates[activeSessionId]) {
      updateActiveSession(() => ({ thinkingLevel: level as SessionState['thinkingLevel'] }));
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
      // #6502 — stamp each request with a fresh nonce and record it as the
      // latest in-flight read. The file_content handler drops any reply whose
      // echoed requestId isn't this one (a superseded read).
      const requestId = String(++fileContentRequestNonce);
      set({ lastFileContentRequestId: requestId });
      wsSend(socket, { type: 'read_file', path, requestId });
    }
  },

  // #6472 (epic #6469) — request the opt-in IDE symbol table. The server is
  // fail-closed when features.ide is off, so the UI gates the affordance on
  // serverCapabilities.ide (never spin symbolsLoading waiting on a reply that
  // won't come). `path` scopes the scan to one file/dir; omitted ⇒ whole workspace.
  requestSymbols: (path?: string) => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ symbolsLoading: true });
      const msg: Record<string, unknown> = { type: 'list_symbols' };
      if (path) msg.path = path;
      if (activeSessionId) msg.sessionId = activeSessionId;
      wsSend(socket, msg);
    }
  },

  // #6473 — open a file in the FileBrowserPanel viewer. Persist the selection,
  // switch to the Files view, and bump fileBrowserPendingOpen so the panel opens
  // it even when the view is already mounted. Used by Cmd+P quick-open.
  openFileInBrowser: (path: string, line?: number) => {
    const { activeSessionId, sessionStates, setViewMode } = get();
    if (activeSessionId && sessionStates[activeSessionId]) {
      set({
        sessionStates: {
          ...sessionStates,
          [activeSessionId]: { ...sessionStates[activeSessionId], selectedFilePath: path },
        },
      });
    }
    set((s) => ({ fileBrowserPendingOpen: { path, line, nonce: (s.fileBrowserPendingOpen?.nonce ?? 0) + 1 } }));
    setViewMode('files');
  },

  // #6476 — request the whole-workspace symbol table (no path scope) for the
  // symbol-search modal. Fail-closed server-side when features.ide is off; the UI
  // gates the affordance on serverCapabilities.ide.
  requestWorkspaceSymbols: () => {
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ workspaceSymbolsLoading: true });
      const msg: Record<string, unknown> = { type: 'list_symbols' };
      if (activeSessionId) msg.sessionId = activeSessionId;
      wsSend(socket, msg);
    }
  },

  // #6475 — go-to-definition: resolve a clicked symbol name to its declaration.
  // The reply (`symbol_location`) lands in `symbolLocation`; FileBrowserPanel
  // reacts to jump there or surface a transient 'not found'.
  requestResolveSymbol: (symbol: string, file?: string) => {
    const trimmed = typeof symbol === 'string' ? symbol.trim() : '';
    if (!trimmed) return;
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = { type: 'resolve_symbol', symbol: trimmed };
      if (file) msg.file = file;
      if (activeSessionId) msg.sessionId = activeSessionId;
      wsSend(socket, msg);
    }
  },

  // #6474 — find-in-project content grep. The reply (`code_search_results`) lands in
  // `codeSearchResults`; the Cmd+Shift+F palette renders it.
  requestSearchContent: (query: string) => {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (trimmed.length < 2) return;
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ codeSearchLoading: true });
      const msg: Record<string, unknown> = { type: 'search_content', query: trimmed };
      if (activeSessionId) msg.sessionId = activeSessionId;
      wsSend(socket, msg);
    }
  },

  // #6477 — find-all-references for a clicked symbol. Opens the references palette
  // and clears any stale result; the reply (`references_result`) lands in
  // `referencesResult`.
  requestFindReferences: (symbol: string, file?: string) => {
    const trimmed = typeof symbol === 'string' ? symbol.trim() : '';
    if (!trimmed) return;
    const { socket, activeSessionId } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      set({ referencesSymbol: trimmed, referencesOpen: true, referencesLoading: true, referencesResult: null });
      const msg: Record<string, unknown> = { type: 'find_references', symbol: trimmed };
      if (file) msg.file = file;
      if (activeSessionId) msg.sessionId = activeSessionId;
      wsSend(socket, msg);
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

  // #5589 / #5281 — explicitly request primary (driver) ownership of a session.
  // `force: true` overrides the current owner (operator-driven take-over);
  // without it a claim another device holds is rejected with a PRIMARY_HELD
  // `session_error` (input_conflict), surfaced as a calm notice. The resulting
  // `session_role` broadcast is the authoritative role update.
  claimPrimary: (sessionId: string, options?: { force?: boolean }) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, {
        type: 'claim_primary',
        sessionId,
        ...(options?.force ? { force: true } : {}),
      });
    }
  },

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
        contextOccupancy: cached.contextOccupancy,
        lastResultCost: cached.lastResultCost,
        lastResultDuration: cached.lastResultDuration,
        isIdle: cached.isIdle,
        // #5731 T2: mirror the per-session primary-owner into the flat slot too.
        // `primaryClientId` is a FLAT ConnectionState field (the presence/"who's
        // driving" badge reads it flat), so omitting it here left the PREVIOUS
        // session's owner bleeding into the newly-selected session's UI until a
        // `primary_changed`/`session_role` re-synced it — cross-session bleed.
        // (thinkingLevel / sessionRole are per-session-read from sessionStates,
        // not flat, so they don't bleed through the flat slot.)
        primaryClientId: cached.primaryClientId,
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
        contextOccupancy: null,
        lastResultCost: null,
        lastResultDuration: null,
        isIdle: seedIsIdle,
        // #5731 T2: reset the flat primary-owner so the previous session's owner
        // doesn't bleed through during the server round-trip (cross-session
        // bleed). Re-syncs from primary_changed/session_role once the switch
        // lands. (thinkingLevel / sessionRole are per-session-read, not flat.)
        primaryClientId: null,
        sessionNotifications: filteredNotifications,
      });
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'switch_session', sessionId });
    }
  },

  // #6285 — return whether the create request actually went on the wire. When
  // the socket is closed the create is a silent no-op, so the caller must NOT
  // latch its "Creating…" spinner (it would wedge forever — nothing arrives to
  // clear it). Mirrors revokeToken's not-open guard: false = nothing sent.
  createSession: ({ name, cwd, provider, model, permissionMode, worktree, environmentId, skipPermissions }): boolean => {
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
      return true;
    }
    console.warn('[chroxy] createSession: socket not open — create request not sent');
    return false;
  },

  // #6006 — operator panic button. Ask the server to immediately revoke the
  // current API token: it severs live user-shells and forces every connection
  // (including this one) to re-authenticate with the new token. Primary-token
  // only; the server rejects non-primary clients with NOT_AUTHORIZED, but the
  // UI also gates the affordance on the `tokenRevoke` capability so a paired
  // device never sees the button.
  revokeToken: () => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, { type: 'revoke_token' });
    } else {
      // Destructive op: don't fail silently. A closing/closed socket is
      // plausible exactly when an operator panics, so surface it instead of
      // leaving them thinking the token was revoked.
      console.warn('[chroxy] revokeToken: socket not open — revoke request not sent');
    }
  },

  destroySession: (sessionId: string, force?: boolean) => {
    const { socket } = get();
    if (socket && socket.readyState === WebSocket.OPEN) {
      // #5710 — `force` bypasses the server's #5695 "is running" guard so a
      // wedged session can be deleted. Only sent when the user explicitly
      // confirms the destructive force-delete (see App.handleCloseSession).
      wsSend(socket, force ? { type: 'destroy_session', sessionId, force: true } : { type: 'destroy_session', sessionId });
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

  // #5821: dismiss the billing warning banner for this connection. A later
  // billing_canary broadcast with a CHANGED warning set re-surfaces it.
  dismissBillingBanner: () => {
    set({ billingBannerDismissed: true });
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

  updateServer: (serverId: string, patch: Partial<Pick<ServerEntry, 'name' | 'wsUrl' | 'token' | 'pinnedIdentityKey'>>) => {
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
    // #5698 — a user-initiated retry starts a fresh reconnect ladder. Without
    // this, retrying from the terminal 'server_down' state would immediately
    // re-exhaust the (still-maxed) counter and give up again on the first failure.
    resetReconnectAttempt();
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
  pairServer: (name: string, wsUrl: string, pairingId: string, identityKey?: string): ServerEntry => {
    const entry = get().addServer(name, wsUrl, '');
    pendingPairingId = pairingId;
    // #5536 — capture the daemon's identity (from the trusted pairing URL `idk=`)
    // for this pairing attempt. Verified against the server's signed exchange key
    // on the first handshake and pinned on success (key_exchange / auth_ok).
    setPendingPairingIdentityKey(identityKey ?? null);
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
      if (connectionPhase === 'server_down') {
        // #5698 — the reconnect ladder gave up while the tab was hidden (e.g. the
        // laptop slept through the whole backoff budget). The server is very
        // likely fine now, so a wake is the natural moment to try again. Reuse
        // the manual-retry path (resets the ladder + reconnects) so the user
        // doesn't have to hunt for the Reconnect button after every sleep.
        console.log('[ws] Tab became visible while server_down — retrying');
        state.retryConnection();
      } else if (connectionPhase === 'connected' && socket && socket.readyState !== WebSocket.OPEN && wsUrl && apiToken) {
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
