/**
 * WebSocket message handler — processes all incoming server messages.
 *
 * Extracted from connection.ts to reduce file size. This module contains:
 * - handleMessage() — the main message dispatch (~1100 lines)
 * - Module-level state (delta buffers, replay flags, heartbeat, message queue)
 * - Session update helpers (updateSession, updateActiveSession)
 *
 * Depends on the Zustand store via a late-bound reference (setStore) to
 * avoid circular imports.
 *
 * Ported from packages/app/src/store/message-handler.ts for the web dashboard.
 * Connection persistence uses @chroxy/store-core adapters for DI.
 */
import {
  consoleAlert, noopHaptic, noopPush, createStorageAdapter,
  resolveSessionId,
  handleUserInput as sharedUserInput,
  handleMessage as sharedMessageHandler,
  // available_permission_modes / session_updated / confirm_permission_mode /
  // agent_busy / budget_resumed migrated to the shared dispatch table (#5556)
  handleClaudeReady as sharedClaudeReady,
  handleThinkingLevelChanged as sharedThinkingLevelChanged,
  handleBudgetExceeded as sharedBudgetExceeded,
  // plan_started / inactivity_warning / dev_preview / dev_preview_stopped
  // migrated to the shared dispatch table (#5556 slice 2)
  // #4653: chroxy-side multi-question deny intervention surfaced to the user
  handleToolStart as sharedToolStart,
  handleToolResult as sharedToolResult,
  handleToolInputDelta as sharedToolInputDelta,
  handleStreamStart as sharedStreamStart,
  sharedStreamDelta,
  handleStreamEnd as sharedStreamEnd,
  handleAuthOk as sharedAuthOk,
  parseConnectedClients as sharedParseConnectedClients,
  handleAuthFail as sharedAuthFail,
  handleKeyExchangeOk as sharedKeyExchangeOk,
  decideKeyPinWithPairingIdentity,
  decodeEncryptionGate,
  handleServerMode as sharedServerMode,
  // checkpoint_created / checkpoint_list migrated to the shared dispatch table
  // (#5618 Batch 6); checkpoint_restored is not migrated in this batch — the
  // dashboard handles it via its HANDLERS map (handleCheckpointRestored), not
  // this switch, so no shared import is needed here.
  handleError as sharedError,
  handleSessionError as sharedSessionError,
  handleLogEntry as sharedLogEntry,
  handleClientJoined as sharedClientJoined,
  handleClientLeft as sharedClientLeft,
  // conversation_id migrated to the shared dispatch table (#5556)
  handleHistoryReplayStart as sharedHistoryReplayStart,
  handleHistoryReplayEnd as sharedHistoryReplayEnd,
  // #5555.3 / #5555.4 — lastSeq cursor + no-blank-flash reconcile.
  recordHistorySeq,
  reconcileReplayStart,
  reconcileReplayEnd,
  replayDedupCache,
  resetReplayReconcile,
  handlePermissionExpired as sharedPermissionExpired,
  // permission_rules_updated migrated to the shared dispatch table (#5556)
  // #5454 — dashboard adopts the shared permission family + the remaining
  // both-sides duplicates
  handlePermissionRequest as sharedPermissionRequest,
  handlePermissionResolved as sharedPermissionResolved,
  handlePermissionTimeout as sharedPermissionTimeout,
  handleTokenRotated as sharedTokenRotated,
  handlePairFail as sharedPairFail,
  // session_cost_threshold_crossed / notification_prefs migrated to the shared
  // dispatch table (#5556 slice 2)
  // #5454 — pure core of the #554 stream-split block (permission_request)
  resolvePermissionStreamSplit,
  handleDirectoryListing as sharedDirectoryListing,
  handleFileListing as sharedFileListing,
  handleFileContent as sharedFileContent,
  buildSessionListPatches as sharedBuildSessionListPatches,
  cumulativeUsageEquals as sharedCumulativeUsageEquals,
  handleSessionTimeout as sharedSessionTimeout,
  handleSessionWarning as sharedSessionWarning,
  handleSessionSwitched as sharedSessionSwitched,
  handleFileList as sharedFileList,
  handleDiffResult as sharedDiffResult,
  handleGitStatusResult as sharedGitStatusResult,
  // agent_spawned / agent_completed / agent_event / background_work_changed
  // migrated to the shared dispatch table (#5556 slice 2)
  handleEnvironmentList as sharedEnvironmentList,
  handleEnvironmentError as sharedEnvironmentError,
  // mcp_servers / session_usage migrated to the shared dispatch table (#5556 slice 2)
  handleResultUsage as sharedResultUsage,
  handleResultQueueReconcile,
  handleServerError as sharedServerError,
  handleServerStatusLegacy as sharedServerStatusLegacy,
  // web_task_created / web_task_updated — migrated to the shared dispatch table
  // (#5556 slice 4); the dashboard no longer imports the upsert helper directly.
  handleWebTaskError as sharedWebTaskError,
  // web_task_list / web_feature_status migrated to the shared dispatch table
  // (#5556 slice 2)
  applyOrphanDeltas,
  isActivityEvent,
  // #5163 (epic #5159): Control Room activity reducer — snapshot replace +
  // self-healing delta upsert + terminal-retention prune. The dashboard
  // panel and future mobile parity both consume this one implementation.
  applyActivitySnapshot,
  applyActivityDelta,
  clearSessionActivity,
  // #5039: pre-formatted partial-cost sub-line used by the `case 'error'`
  // branch so the toast and the mobile Alert share copy.
  formatPartialCostLine,
  // #5515 (epic #5514): latency instrumentation primitives.
  RollingPercentiles,
  // #5556 (epic #5514): shared stateful EWMA RTT smoother.
  RttSmoother,
  // #6035: shared connection runtime — the heartbeat ping loop, pong-timeout
  // reaper, handshake-window timer, and pong RTT measurement. The dashboard
  // injects its wsSend / quality-write sink / owned RttSmoother / latency-log
  // hook; the timer mechanics are shared with the app. Constants aliased so the
  // local `HEARTBEAT_INTERVAL_MS` / `HANDSHAKE_TIMEOUT_MS` exports re-source them.
  createHeartbeatController,
  HEARTBEAT_INTERVAL_MS as SC_HEARTBEAT_INTERVAL_MS,
  HANDSHAKE_TIMEOUT_MS as SC_HANDSHAKE_TIMEOUT_MS,
  LATENCY_LOG_INTERVAL_MS as SC_LATENCY_LOG_INTERVAL_MS,
  // #5556 (epic #5514): shared delta-flusher wiring (accumulator + timer +
  // override) — the dashboard supplies only its `applyDeltas` store mutation.
  createDeltaFlusher,
  type DeltaFlusher,
  type PlatformAdapters, type StorageAdapter,
  // epic #5556, sub-item 3: shared client message dispatch table.
  // Pure-delegation cases that were byte-identical with the app route through
  // this table; a miss falls through to the HANDLERS map + switch unchanged.
  createDispatchTable,
  runDispatch,
  type ClientStoreAdapter,
  // #6691 (S-3): orchestration list/detail reducers — the handlers below are
  // thin wrappers over these (never reimplement the merge/seq logic here).
  upsertRunSummary,
  applyRunDelta,
} from '@chroxy/store-core'
import { PROTOCOL_VERSION } from '@chroxy/protocol'
import { ServerByokCredentialsStatusSchema, ServerCredentialsStatusSchema, ServerCredentialTestResultSchema, ServerActivitySnapshotSchema, ServerActivityDeltaSchema, ServerCancelActivityAckSchema, ServerHostStatusSnapshotSchema, ServerRunnerStatusSnapshotSchema, ServerContainersStatusSnapshotSchema, ServerContainersActionAckSchema, ServerRepoRuntimeConfigSnapshotSchema, ServerByokPoolStatusSnapshotSchema, ServerByokPoolActionAckSchema, ServerHostPruneStatusSnapshotSchema, ServerHostPruneActionAckSchema, ServerSimulatorStatusSnapshotSchema, ServerSimulatorActionAckSchema, ServerEmulatorStatusSnapshotSchema, ServerEmulatorActionAckSchema, ServerWslStatusSnapshotSchema, ServerWslActionAckSchema, ServerIntegrationStatusSnapshotSchema, ServerSkillsInventorySnapshotSchema, ServerMailboxStatusSnapshotSchema, ServerExternalSessionsSnapshotSchema, ServerRepoEventsSnapshotSchema, ServerRepoEventsDeltaSchema, ServerPermissionInputSchema, ServerIntegrationActionAckSchema, ServerSummarizeSessionResultSchema, ServerSessionPresetSnapshotSchema, ServerPairPendingSchema, ServerPairResolvedSchema, ServerBillingCanarySchema, BillingCanarySnapshotSchema, ServerSymbolsSnapshotSchema, ServerSymbolLocationSchema, ServerSearchResultsSchema, ServerReferencesResultSchema, ServerOrchestrationRunsSnapshotSchema, ServerOrchestrationRunSnapshotSchema, ServerOrchestrationRunDeltaSchema, ServerOrchestrationActionAckSchema } from '@chroxy/protocol/schemas'
import { resolveSummarizeRequest, rejectSummarizeRequest } from './summarizeRequests'
import {
  createKeyPair,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  DIRECTION_CLIENT,
  type EncryptionState,
  type KeyPair,
} from './crypto';
import { filterThinking, nextMessageId } from './utils';
import { calculateCost } from '../lib/model-pricing';
import { CLIENT_ESTIMATED_COST_PROVIDERS } from '../lib/client-estimated-cost-providers';
import { unwrapToolResultText } from '../lib/tool-result-text';
import type {
  ChatMessage,
  ConnectionContext,
  ConnectionState,
  DirectoryEntry,
  EnvironmentInfo,
  EvaluatorRewriteMeta,
  FileEntry,
  PendingCommunitySkill,
  PendingEvaluatorClarify,
  QueuedMessage,
  SessionInfo,
  SessionNotification,
  SessionState,
  FilePickerItem,
} from './types';
import { createEmptySessionState } from './utils';
import { clearPersistedSession } from './persistence';

// ---------------------------------------------------------------------------
// Protocol version — bumped when the WS message set changes
// ---------------------------------------------------------------------------
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Late-bound store reference — set once by connection.ts after store creation
// ---------------------------------------------------------------------------
type StoreApi = {
  getState: () => ConnectionState;
  setState: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void;
};
let _store: StoreApi | null = null;

export function setStore(store: StoreApi): void {
  _store = store;
}

function getStore(): StoreApi {
  if (!_store) throw new Error('Store not initialized — call setStore() first');
  return _store;
}

// ---------------------------------------------------------------------------
// Prompt evaluator pending requests (#3068)
// ---------------------------------------------------------------------------
//
// The evaluator round-trip is request→response with no streaming, so we keep
// a Map of pending entries keyed by requestId. Each entry carries the
// Promise's resolve + reject + the timeout handle so we can both:
//   - resolve when the matching `evaluate_draft_result` arrives, and
//   - reject on disconnect / explicit cancellation, clearing the timeout
//     so it doesn't fire after the request is gone.

import type { EvaluatorResultPayload } from './types';

interface PendingEvaluatorEntry {
  resolve: (result: EvaluatorResultPayload) => void;
  reject: (err: Error) => void;
  timeoutId: number;
}

const _evaluatorPending = new Map<string, PendingEvaluatorEntry>();

export function registerEvaluatorRequest(
  requestId: string,
  entry: PendingEvaluatorEntry,
): void {
  _evaluatorPending.set(requestId, entry);
}

export function cancelEvaluatorRequest(requestId: string): void {
  const entry = _evaluatorPending.get(requestId);
  if (entry) {
    window.clearTimeout(entry.timeoutId);
    _evaluatorPending.delete(requestId);
  }
}

/**
 * Reject every in-flight evaluator request with the given reason and clear
 * their timeouts. Called from the connection store when the WebSocket closes
 * (or the user explicitly disconnects) so callers don't have to wait the
 * 60s timeout to learn the request will never complete (#3068 review).
 */
export function rejectAllEvaluatorRequests(reason: string): void {
  if (_evaluatorPending.size === 0) return;
  const err = new Error(reason);
  for (const entry of _evaluatorPending.values()) {
    window.clearTimeout(entry.timeoutId);
    entry.reject(err);
  }
  _evaluatorPending.clear();
}

// ---------------------------------------------------------------------------
// In-flight skill_trust_grant tracking (#3587)
// ---------------------------------------------------------------------------
//
// The `skill_trust_grant` request carries `{skillName, author, requestId}` but
// the server's INVALID_AUTHOR error response only echoes `{requestId, code,
// message, actualAuthor}` — there is no `skillName` on the wire. To offer a
// one-click "Try as <actualAuthor>" recovery from the resulting toast we
// remember the original request locally, keyed by `requestId`, and pair it up
// when the matching error arrives.
//
// Entries are cleared when a `skill_trust_grant_ok` ack lands, when an
// `error` with a matching `requestId` is processed, or via the cleanup
// helper invoked on disconnect. The map is bounded at TRUST_GRANT_PENDING_CAP
// (32) entries to defend against a buggy server that never replies — the
// oldest entry is evicted FIFO via JS Map insertion order when the cap is
// reached.

interface PendingTrustGrant {
  skillName: string;
  author: string;
}

const _pendingTrustGrants = new Map<string, PendingTrustGrant>();
const TRUST_GRANT_PENDING_CAP = 32;

export function registerTrustGrantRequest(
  requestId: string,
  entry: { skillName: string; author: string },
): void {
  // FIFO eviction when the cap is reached. Map iteration order is insertion
  // order in JS, so the first key is the oldest.
  if (_pendingTrustGrants.size >= TRUST_GRANT_PENDING_CAP) {
    const oldestKey = _pendingTrustGrants.keys().next().value;
    if (oldestKey !== undefined) _pendingTrustGrants.delete(oldestKey);
  }
  _pendingTrustGrants.set(requestId, { ...entry });
}

export function consumePendingTrustGrant(requestId: string): PendingTrustGrant | null {
  const entry = _pendingTrustGrants.get(requestId);
  if (!entry) return null;
  _pendingTrustGrants.delete(requestId);
  return entry;
}

/** Clear all pending trust-grant entries — called on WebSocket close. */
export function clearPendingTrustGrants(): void {
  _pendingTrustGrants.clear();
}

// #5711 (Gap 2, client half): set_model is applied OPTIMISTICALLY (the dropdown
// flips immediately), but the server may reject it (MODEL_NOT_APPLIED — e.g. a
// mid-turn change is a no-op server-side, fixed in #5696). Without a rollback
// the dashboard keeps showing a model the session never switched to. Remember
// the model we switched FROM, keyed by the set_model requestId the server
// echoes on its error, so the `error` handler can roll the optimistic update
// back. Consumed (deleted) on a matching error; otherwise cleared on disconnect
// or evicted by the bounded FIFO cap. A successful change is NOT cleared here —
// the server sends model_changed XOR error per requestId (#5711), so a success
// entry simply ages out via the cap and is never mis-consumed by a later error.
// (model_changed itself is handled by the shared store-core dispatch table since
// #5618 and only writes activeModel; it never touched this map.)
interface PendingModelRevert {
  sessionId: string | null;
  previousModel: string | null;
}

const _pendingModelReverts = new Map<string, PendingModelRevert>();
const MODEL_REVERT_PENDING_CAP = 16;

export function registerModelChangeRequest(requestId: string, entry: PendingModelRevert): void {
  if (_pendingModelReverts.size >= MODEL_REVERT_PENDING_CAP) {
    const oldestKey = _pendingModelReverts.keys().next().value;
    if (oldestKey !== undefined) _pendingModelReverts.delete(oldestKey);
  }
  _pendingModelReverts.set(requestId, { ...entry });
}

function consumePendingModelRevert(requestId: string): PendingModelRevert | null {
  const entry = _pendingModelReverts.get(requestId);
  if (!entry) return null;
  _pendingModelReverts.delete(requestId);
  return entry;
}

/** Clear all pending model reverts — called on WebSocket close. */
export function clearPendingModelReverts(): void {
  _pendingModelReverts.clear();
}

/** @internal test seam. */
export function _testModelRevertPendingSize(): number {
  return _pendingModelReverts.size;
}

// #5716 (sibling of #5711): set_permission_mode is also applied OPTIMISTICALLY
// (the dropdown flips immediately in setPermissionMode), but the server may
// reject it (PERMISSION_MODE_NOT_APPLIED — a mid-turn change or same-mode no-op
// is rejected server-side, settings-handlers.js). Without a rollback the
// dashboard keeps showing a permission mode the session never switched to —
// the most dangerous case being a phantom "auto"/bypass that the session never
// entered. Remember the mode we switched FROM, keyed by the set_permission_mode
// requestId the server echoes on its error, so the `error` handler can roll the
// optimistic update back. Cleared on the matching error or on disconnect — NOT
// on success: the server sends permission_mode_changed XOR error per requestId,
// so clearing on success would drop a second in-flight revert (the #5715 bug).
// Bounded FIFO like the model-revert map.
interface PendingPermissionModeRevert {
  sessionId: string | null;
  previousMode: string | null;
  // The Shift+Tab toggle target (previousPermissionMode) as it was BEFORE the
  // optimistic change overwrote it, so a rejected change can restore it too
  // (#5722 review). Optional for back-compat with entries that predate the field.
  priorPreviousMode?: string | null;
}

const _pendingPermissionModeReverts = new Map<string, PendingPermissionModeRevert>();
const PERMISSION_MODE_REVERT_PENDING_CAP = 16;

export function registerPermissionModeChangeRequest(requestId: string, entry: PendingPermissionModeRevert): void {
  if (_pendingPermissionModeReverts.size >= PERMISSION_MODE_REVERT_PENDING_CAP) {
    const oldestKey = _pendingPermissionModeReverts.keys().next().value;
    if (oldestKey !== undefined) _pendingPermissionModeReverts.delete(oldestKey);
  }
  _pendingPermissionModeReverts.set(requestId, { ...entry });
}

function consumePendingPermissionModeRevert(requestId: string): PendingPermissionModeRevert | null {
  const entry = _pendingPermissionModeReverts.get(requestId);
  if (!entry) return null;
  _pendingPermissionModeReverts.delete(requestId);
  return entry;
}

/** Clear all pending permission-mode reverts — called on WebSocket close. */
export function clearPendingPermissionModeReverts(): void {
  _pendingPermissionModeReverts.clear();
}

/** @internal test seam. */
export function _testPermissionModeRevertPendingSize(): number {
  return _pendingPermissionModeReverts.size;
}

// #5731 T9 (sibling of #5711/#5716): set_thinking_level is also applied
// OPTIMISTICALLY (the dropdown flips immediately in setThinkingLevel) so it
// doesn't snap back before the server's thinking_level_changed broadcast lands.
// The server may reject it (THINKING_LEVEL_NOT_APPLIED — an invalid level, a
// provider without thinking-level control, or setThinkingLevel throwing), in
// which case the dropdown would otherwise stay on a level the session never
// entered. Remember the level we switched FROM, keyed by the set_thinking_level
// requestId the server echoes on its error, so the `error` handler can roll the
// optimistic update back. Cleared on the matching error or on disconnect — NOT
// on success (the server sends thinking_level_changed XOR error per requestId,
// so clearing on success would drop a second in-flight revert, the #5715 class).
// Bounded FIFO like the model/permission-mode revert maps.
interface PendingThinkingLevelRevert {
  sessionId: string | null;
  previousLevel: string | null;
}

const _pendingThinkingLevelReverts = new Map<string, PendingThinkingLevelRevert>();
const THINKING_LEVEL_REVERT_PENDING_CAP = 16;

export function registerThinkingLevelChangeRequest(requestId: string, entry: PendingThinkingLevelRevert): void {
  if (_pendingThinkingLevelReverts.size >= THINKING_LEVEL_REVERT_PENDING_CAP) {
    const oldestKey = _pendingThinkingLevelReverts.keys().next().value;
    if (oldestKey !== undefined) _pendingThinkingLevelReverts.delete(oldestKey);
  }
  _pendingThinkingLevelReverts.set(requestId, { ...entry });
}

function consumePendingThinkingLevelRevert(requestId: string): PendingThinkingLevelRevert | null {
  const entry = _pendingThinkingLevelReverts.get(requestId);
  if (!entry) return null;
  _pendingThinkingLevelReverts.delete(requestId);
  return entry;
}

/** Clear all pending thinking-level reverts — called on WebSocket close. */
export function clearPendingThinkingLevelReverts(): void {
  _pendingThinkingLevelReverts.clear();
}

/** @internal test seam. */
export function _testThinkingLevelRevertPendingSize(): number {
  return _pendingThinkingLevelReverts.size;
}

/** @internal Exposed for tests so they can inspect the in-flight map. */
export function _testTrustGrantPendingSize(): number {
  return _pendingTrustGrants.size;
}

// ---------------------------------------------------------------------------
// E2E encryption state — reset on every new connection
// ---------------------------------------------------------------------------
let _encryptionState: EncryptionState | null = null;
let _pendingKeyPair: KeyPair | null = null;
let _pendingSalt: string | null = null;

// #5555 (auth_bootstrap) — set fresh from each auth_ok's
// `capabilities.authBootstrap`. When true, the server pushes an
// `auth_bootstrap` burst frame with the provider / slash-command / agent
// lists, so the connect-time list_* request round trip is skipped (in both the
// eager and discrete key-exchange paths). Defaults false (old server) and is
// overwritten on every connect, so it never goes stale across reconnects.
let _serverWillBootstrap = false;

/**
 * Send a JSON message over WebSocket, encrypting if E2E encryption is active.
 * Use this instead of raw `socket.send(JSON.stringify(...))`.
 *
 * Returns `true` when the frame was handed to `socket.send` without throwing,
 * `false` when the send threw. #6283: the caller checks `readyState === OPEN`,
 * but the socket can flip to CLOSING before this synchronous send and throw
 * `InvalidStateError` — a flaky-tunnel TOCTOU window. Swallowing the throw and
 * signalling failure lets delivery-critical callers (`sendInput`) fall back to
 * the offline queue instead of leaving a permanently 'sent'-looking bubble that
 * never reached the server. Mirrors the server-side sender (#5721, see
 * `packages/server/src/ws-client-sender.js`: catch → log → return false).
 * Most callers ignore the result (a closed socket was already a silent no-op).
 */
export function wsSend(socket: WebSocket, payload: Record<string, unknown>): boolean {
  // Serialize/encrypt OUTSIDE the try so a JSON/crypto bug still throws loudly
  // (it's a real defect, not a transient send failure) rather than being
  // swallowed, logged as a "send threw", and re-queued forever. The nonce is
  // consumed for THIS frame here but only advanced after a successful send. (#6283)
  const data = _encryptionState
    ? JSON.stringify(
        encrypt(
          JSON.stringify(payload),
          _encryptionState.sharedKey,
          _encryptionState.sendNonce,
          DIRECTION_CLIENT,
        ),
      )
    : JSON.stringify(payload);
  try {
    socket.send(data);
  } catch (err) {
    // #6283 — the socket flipped to CLOSING after the readyState check (flaky
    // tunnel TOCTOU). Don't advance sendNonce: the frame never went out, so the
    // next send must reuse this nonce (reconnect forces a fresh key exchange,
    // but a same-socket retry must not desync).
    console.warn('[wsSend] socket.send threw — frame not delivered:', err);
    return false;
  }
  if (_encryptionState) _encryptionState.sendNonce++;
  return true;
}

// #3671: edge-trigger memo for the dashboard's client_visible send. Initialised
// to true to match the server's per-connection default — a fresh socket sees
// `visible: true` server-side until we say otherwise. Reset on every fresh
// connect (auth_ok / key_exchange_ok) so the post-auth catch-up fires when
// the dashboard reconnects with the tab already hidden.
let _lastSentVisible: boolean = true;

export function resetClientVisibleMemo(): void {
  _lastSentVisible = true;
}

// #3677 (Copilot review): flip the module-level handshake flags from a
// test so we can assert the encryption-pending guard inside
// `sendClientVisible`. Resetting both to false leaves no observable trace
// for downstream tests in the same file. Cast via `unknown` because we only
// touch the truthy/null aspects of these flags here, not their actual
// crypto contents.
export function _testSetEncryptionHandshake(opts: { pending: boolean; established: boolean }): void {
  _pendingKeyPair = opts.pending
    ? ({ publicKey: 'mock-pub', secretKey: 'mock-sec' } as unknown as KeyPair)
    : null;
  _encryptionState = opts.established
    ? ({ sharedKey: new Uint8Array(32), sendNonce: 0, recvNonce: 0 } as unknown as EncryptionState)
    : null;
}

/**
 * Send the dashboard tab's foreground/background state to the server. The
 * server uses this to gate completion push notifications and other "is anyone
 * actually watching this session" decisions — without it, a dashboard tab
 * left open in the background would keep counting as an active viewer and
 * suppress pushes on mobile, defeating #3404.
 *
 * Mirrors the mobile app's `sendClientVisible` (packages/app/src/store/
 * message-handler.ts) including the encryption-pending guard so we don't
 * fire plaintext during the key-exchange handshake window.
 */
export function sendClientVisible(socket: WebSocket | null, visible: boolean): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (_lastSentVisible === visible) return;
  if (_pendingKeyPair !== null && _encryptionState === null) return;
  _lastSentVisible = visible;
  wsSend(socket, { type: 'client_visible', visible });
}

// Re-export encrypt for wsSend (import is used inside the function)
import { encrypt } from './crypto';

// ---------------------------------------------------------------------------
// Platform adapters — web dashboard uses console.warn + no-op haptics
// ---------------------------------------------------------------------------
const _storage: StorageAdapter = createStorageAdapter(localStorage)

const _adapters: PlatformAdapters = {
  alert: consoleAlert,
  haptic: noopHaptic,
  push: noopPush,
  storage: _storage,
}

// ---------------------------------------------------------------------------
// Connection context (set by connect(), read by handleMessage)
// ---------------------------------------------------------------------------
let _connectionContext: ConnectionContext | null = null;

export function setConnectionContext(ctx: ConnectionContext | null): void {
  _connectionContext = ctx;
}

export function getConnectionContext(): ConnectionContext | null {
  return _connectionContext;
}

// ---------------------------------------------------------------------------
// Encryption state accessors
// ---------------------------------------------------------------------------
export function getEncryptionState(): EncryptionState | null {
  return _encryptionState;
}

export function setEncryptionState(state: EncryptionState | null): void {
  _encryptionState = state;
}

export function getPendingKeyPair(): KeyPair | null {
  return _pendingKeyPair;
}

export function setPendingKeyPair(kp: KeyPair | null): void {
  _pendingKeyPair = kp;
}

// #5536 — the daemon's E2E identity public key captured from the trusted pairing
// URL (`idk=`) for THIS pairing attempt, not yet committed as the pin. The
// key-exchange handler verifies the server's signed exchange key against it and
// pins it (on the active registry entry) on first successful connect. Cleared
// once consumed so it never leaks into a later dial.
let _pendingPairingIdentityKey: string | null = null;

export function setPendingPairingIdentityKey(key: string | null): void {
  _pendingPairingIdentityKey = key;
}

export function getPendingPairingIdentityKey(): string | null {
  return _pendingPairingIdentityKey;
}

/**
 * #5555 (eager key exchange) — generate this connection's ephemeral X25519
 * keypair + per-connection salt and stash them so they can be sent WITH the
 * `auth` message (in `socket.onopen`). Returns the public key + salt to inline
 * into auth.
 *
 * The discrete `key_exchange_ok` / fallback handler reads the same module-level
 * `_pendingKeyPair` + `_pendingSalt`, so if the server omits `serverPublicKey`
 * from auth_ok (old server, encryption disabled, eager derivation failed) the
 * client still has everything it needs to fall back to the discrete handshake
 * without regenerating keys. Crypto is identical to the discrete path — only
 * the send timing changes.
 */
export function prepareEagerKeyExchange(): { publicKey: string; salt: string } {
  _pendingKeyPair = createKeyPair();
  _pendingSalt = generateConnectionSalt();
  return { publicKey: _pendingKeyPair.publicKey, salt: _pendingSalt };
}

// ---------------------------------------------------------------------------
// Connection attempt tracking
// ---------------------------------------------------------------------------
export let connectionAttemptId = 0;
export let disconnectedAttemptId = -1;
export let lastConnectedUrl: string | null = null;

// #5555.5 — consecutive close/error-path reconnect counter, used to index the
// RETRY_DELAYS backoff ladder so a flapping tunnel escalates its retry spacing
// (1s → 2s → 3s → 5s → 8s) instead of hammering the handshake at a fixed delay.
// Reset to 0 on `auth_ok` (a *successful* connect — proof the link is healthy),
// NOT on mere socket-open, so a socket that opens but never authenticates keeps
// climbing the ladder. Lives here (not a connect() closure) because the count
// must survive the connect() → drop → connect() cycle and be cleared from the
// auth_ok handler.
export let reconnectAttempt = 0;

export function bumpConnectionAttemptId(): number {
  return ++connectionAttemptId;
}

/** Advance the backoff ladder, returning the pre-increment attempt index. */
export function nextReconnectAttempt(): number {
  return reconnectAttempt++;
}

/** Reset the backoff ladder — called from the `auth_ok` handler on a clean connect. */
export function resetReconnectAttempt(): void {
  reconnectAttempt = 0;
}

export function setDisconnectedAttemptId(id: number): void {
  disconnectedAttemptId = id;
}

export function setLastConnectedUrl(url: string | null): void {
  lastConnectedUrl = url;
}

// ---------------------------------------------------------------------------
// History replay flags
// ---------------------------------------------------------------------------
// #4493 — per-session replay tracking. `replayHistory()` on the server chunks
// the replay over `setImmediate` (ws-history.js), which yields the event loop
// between chunks, so live broadcasts from OTHER sessions can interleave with
// session A's replay. A module-level boolean would gate all sessions on A's
// replay state and drop legitimate live activity for sessions B/C/etc.
// Scope the flag per-session id and gate per-target.
const _replayingSessions = new Set<string>();

export function resetReplayFlags(): void {
  _replayingSessions.clear();
}

// ---------------------------------------------------------------------------
// Permission boundary message splitting (#554)
// ---------------------------------------------------------------------------
const _postPermissionSplits = new Set<string>();
const _deltaIdRemaps = new Map<string, string>();

export function clearPermissionSplits(): void {
  _postPermissionSplits.clear();
  _deltaIdRemaps.clear();
}

// ---------------------------------------------------------------------------
// Terminal write batching
// ---------------------------------------------------------------------------
let _pendingTerminalWrites = '';
let _terminalWriteTimer: ReturnType<typeof setTimeout> | null = null;

export function flushTerminalWrites(): void {
  _terminalWriteTimer = null;
  if (_pendingTerminalWrites.length === 0) return;
  const data = _pendingTerminalWrites;
  _pendingTerminalWrites = '';
  const cb = getStore().getState()._terminalWriteCallback;
  if (cb) cb(data);
}

export function appendPendingTerminalWrite(data: string): void {
  _pendingTerminalWrites += data;
  if (!_terminalWriteTimer) {
    _terminalWriteTimer = setTimeout(flushTerminalWrites, 50);
  }
}

export function clearTerminalWriteBatching(): void {
  if (_terminalWriteTimer) {
    clearTimeout(_terminalWriteTimer);
    _terminalWriteTimer = null;
  }
  _pendingTerminalWrites = '';
}

// ---------------------------------------------------------------------------
// Client-side heartbeat + handshake timeout
// ---------------------------------------------------------------------------
// #6035: the heartbeat ping loop, the pong-timeout reaper, the handshake-window
// timer, and the pong RTT measurement now live in the shared
// `createHeartbeatController` (store-core/connection-runtime), lifted from the
// byte-identical copy this file shared with the app's message-handler.ts. The
// dashboard injects only the genuinely platform-specific effects: its `wsSend`
// (E2E envelope), the quality-write sink (`getStore().setState`), the owned
// `_rttSmoother` (also read by the delta-flusher), and the latency-log hook
// that gates on the shared `_lastLatencyLogAt` throttle cursor.
//
// `_rttSmoother` stays declared here (not inside the controller) because the
// delta-flusher reads `_rttSmoother.value` for its adaptive interval (#5556).
const _rttSmoother = new RttSmoother();

// #5515 (epic #5514): latency instrumentation. `_deltaServerTs` records the
// server-stamped serverTs (and local recv time) of the OLDEST un-rendered
// delta per messageId; on flush we measure serverTs→render (token-to-render)
// and recv→render (client render cost) into the rolling p50/p95 buffers. See
// store-core/latency-stats for the clock discipline. Dev-only console readout,
// throttled so a streaming turn can't spam the log. `_lastLatencyLogAt` is the
// shared throttle cursor for BOTH the pong-split log (in the controller's
// onLatencyLog hook below) and recordLatencySamples (the delta path).
const _deltaServerTs = new Map<string, { serverTs: number; recvAt: number }>();
const _tokenToRender = new RollingPercentiles(200);
const _clientRender = new RollingPercentiles(200);
let _lastLatencyLogAt = 0;

const _heartbeat = createHeartbeatController({
  wsSend,
  rttSmoother: _rttSmoother,
  onPongQuality: (latencyMs, quality) => {
    getStore().setState({ latencyMs, connectionQuality: quality });
  },
  // The dashboard runs in the browser where WebSocket.OPEN === 1.
  openReadyState: WebSocket.OPEN,
  onLatencyLog: (line, pongRecvAt) => {
    if (pongRecvAt - _lastLatencyLogAt >= LATENCY_LOG_INTERVAL_MS) {
      _lastLatencyLogAt = pongRecvAt;
      console.log(line);
    }
  },
});

export const HEARTBEAT_INTERVAL_MS = SC_HEARTBEAT_INTERVAL_MS;
// #5721 (item 2) — client-side handshake timeout budget (re-exported from
// store-core so connection.ts and the tests can read it). The heartbeat does
// NOT start until `auth_ok` is processed, so the handshake window had no
// liveness coverage before this timer; it hands off to the reconnect ladder
// ("Handshake failed — reconnecting") instead of a silent stall.
export const HANDSHAKE_TIMEOUT_MS = SC_HANDSHAKE_TIMEOUT_MS;
const LATENCY_LOG_INTERVAL_MS = SC_LATENCY_LOG_INTERVAL_MS;

export function stopHeartbeat(): void {
  _heartbeat.stopHeartbeat();
}

export function startHeartbeat(socket: WebSocket): void {
  _heartbeat.startHeartbeat(socket);
}

export function armHandshakeTimer(onTimeout: () => void): void {
  _heartbeat.armHandshakeTimer(onTimeout);
}

export function clearHandshakeTimer(): void {
  _heartbeat.clearHandshakeTimer();
}

function _onPong(serverTs?: number): void {
  _heartbeat.handlePong(serverTs);
}

// ---------------------------------------------------------------------------
// Delta batching
// ---------------------------------------------------------------------------
// #5556 (epic #5514): the accumulator map + coalescing timer + adaptive window
// now live inside the shared `createDeltaFlusher`, sized off `_rttSmoother`. The
// dashboard supplies `applyDeltaBatch` — its store mutation, which (unlike the
// app) keeps a flat-`messages` fallback. The hot path writes into
// `deltaFlusher.pendingDeltas`; teardown goes through `deltaFlusher.clear()`.
const deltaFlusher: DeltaFlusher = createDeltaFlusher({
  getEwmaRtt: () => _rttSmoother.value,
  applyDeltas: applyDeltaBatch,
});
const pendingDeltas = deltaFlusher.pendingDeltas;

// #5516 (epic #5514): adaptive delta-flush interval (was a fixed 100ms).
// Production adapts to the current EWMA RTT via `resolveDeltaFlushMs`
// (16-33ms cheap → 100ms poor). Tests pin it with
// `setDeltaFlushIntervalOverride(N)`; `null` restores adaptive behavior.
// #5556: delegates to the flusher's own override.
export function setDeltaFlushIntervalOverride(ms: number | null): void {
  deltaFlusher.setIntervalOverride(ms);
}

// #5556: the store-mutation half of the old `flushPendingDeltas`. The shared
// flusher owns the accumulator/timer, snapshots+clears `pendingDeltas`, then
// hands us the batch. Dashboard-side this writes session state AND a flat-
// `messages` fallback (the app has only the former).
function applyDeltaBatch(updates: Map<string, { sessionId: string | null; delta: string }>): void {
  const state = getStore().getState();

  const bySession = new Map<string | null, Map<string, string>>();
  for (const [msgId, { sessionId, delta }] of updates) {
    if (!bySession.has(sessionId)) bySession.set(sessionId, new Map());
    bySession.get(sessionId)!.set(msgId, delta);
  }

  let newSessionStates = { ...state.sessionStates };
  let flatUpdated = false;

  for (const [sessionId, deltas] of bySession) {
    if (sessionId && newSessionStates[sessionId]) {
      const sessionState = newSessionStates[sessionId];
      const matched = new Set<string>();
      // Type guard: never apply deltas to non-response messages, even if id
      // matches. Defense against future server regressions that reintroduce
      // id collisions across tool_start and stream_start.
      const updatedMessages = sessionState.messages.map((m) => {
        const d = deltas.get(m.id);
        if (d && m.type === 'response') {
          matched.add(m.id);
          return { ...m, content: m.content + d };
        }
        return m;
      });
      // Safety net: create response messages for orphaned deltas (#2611,
      // canonical helper extracted in #3176).
      const finalMessages = updatedMessages;
      applyOrphanDeltas(finalMessages, deltas, matched, _deltaIdRemaps);
      newSessionStates = {
        ...newSessionStates,
        [sessionId]: { ...sessionState, messages: finalMessages },
      };
      if (sessionId === state.activeSessionId) {
        getStore().setState({ sessionStates: newSessionStates, messages: finalMessages });
        flatUpdated = true;
      }
    } else {
      getStore().setState((s) => {
        const matched2 = new Set<string>();
        const updated = s.messages.map((m) => {
          const d = deltas.get(m.id);
          if (d && m.type === 'response') {
            matched2.add(m.id);
            return { ...m, content: m.content + d };
          }
          return m;
        });
        // Safety net: create response messages for orphaned deltas (#2611,
        // canonical helper extracted in #3176).
        applyOrphanDeltas(updated, deltas, matched2, _deltaIdRemaps);
        return { messages: updated };
      });
      flatUpdated = true;
    }
  }

  if (!flatUpdated) {
    getStore().setState({ sessionStates: newSessionStates });
  }

  // #5515 (epic #5514): the store writes above are the render trigger; sample
  // latency for the ids we just flushed. See store-core/latency-stats for the
  // clock discipline (serverTs→render is approximate/wall-clock; recv→render is
  // the skew-free client render cost).
  recordLatencySamples(updates.keys());
}

// #5515: measure token-to-render for the flushed message ids into the rolling
// p50/p95 buffers and emit a throttled dev log. Each id's stamp is consumed
// once so the next flush window restamps.
function recordLatencySamples(messageIds: Iterable<string>): void {
  const now = Date.now();
  let sampled = false;
  for (const id of messageIds) {
    const stamp = _deltaServerTs.get(id);
    if (!stamp) continue;
    _deltaServerTs.delete(id);
    _tokenToRender.add(now - stamp.serverTs);
    _clientRender.add(now - stamp.recvAt);
    sampled = true;
  }
  if (!sampled) return;
  if (now - _lastLatencyLogAt < LATENCY_LOG_INTERVAL_MS) return;
  _lastLatencyLogAt = now;
  const ttr = _tokenToRender.summary();
  const cr = _clientRender.summary();
  console.log(
    `[latency] token→render(~approx, wall-clock) n=${ttr.count} p50=${ttr.p50}ms p95=${ttr.p95}ms | ` +
    `client-render n=${cr.count} p50=${cr.p50}ms p95=${cr.p95}ms`
  );
}

export function clearDeltaBuffers(): void {
  // #5556: the flusher cancels its timer and drops the accumulator (teardown,
  // not flush — these deltas belong to a connection that's going away).
  deltaFlusher.clear();
  // #5515: drop un-flushed latency stamps so they can't survive a reset.
  _deltaServerTs.clear();
}

// ---------------------------------------------------------------------------
// Message queue: buffer messages while disconnected, drain on reconnect
// ---------------------------------------------------------------------------
const QUEUE_TTLS: Record<string, number> = {
  input: 60_000,
  interrupt: 5_000,
  permission_response: 300_000,
  user_question_response: 60_000,
};
const QUEUE_MAX_SIZE = 10;
const QUEUE_EXCLUDED = new Set(['set_model', 'set_permission_mode', 'mode', 'resize']);

/**
 * #4148: server error codes whose envelopes are NON-fatal even when the
 * server forgot to set `fatal: false`. Routed to severity='warning'
 * (yellow toast) instead of the destructive red error treatment.
 * Hoisted to module scope so the 'error' case doesn't reallocate the
 * Set every message.
 */
const NON_FATAL_ERROR_CODES = new Set(['MAX_TOOL_ROUNDS_REACHED']);
const messageQueue: QueuedMessage[] = [];

export function enqueueMessage(type: string, payload: unknown): 'queued' | false {
  if (QUEUE_EXCLUDED.has(type)) return false;
  const maxAge = QUEUE_TTLS[type];
  if (!maxAge) return false;
  if (messageQueue.length >= QUEUE_MAX_SIZE) return false;
  messageQueue.push({ type, payload, queuedAt: Date.now(), maxAge });
  console.log(`[queue] Queued ${type} (${messageQueue.length}/${QUEUE_MAX_SIZE})`);
  return 'queued';
}

export function drainMessageQueue(socket: WebSocket): void {
  if (messageQueue.length === 0) return;
  const now = Date.now();
  const valid = messageQueue.filter((m) => now - m.queuedAt < m.maxAge);
  messageQueue.length = 0;
  if (valid.length === 0) return;
  console.log(`[queue] Draining ${valid.length} queued message(s)`);
  for (const m of valid) {
    try {
      wsSend(socket, m.payload as Record<string, unknown>);
    } catch (err) {
      console.warn(`[queue] Failed to send queued ${m.type}:`, err);
    }
  }
}

export function clearMessageQueue(): void {
  messageQueue.length = 0;
}

/** @internal Exposed for testing only */
export const _testQueueInternals = {
  getQueue: () => messageQueue,
  enqueue: enqueueMessage,
  drain: drainMessageQueue,
  clear: () => { messageQueue.length = 0; },
};

// ---------------------------------------------------------------------------
// Session update helpers
// ---------------------------------------------------------------------------

/**
 * Update any session's state by ID. Syncs to flat state only when the target
 * session is the currently active session (so UI reads remain correct).
 */
export function updateSession(sessionId: string, updater: (session: SessionState) => Partial<SessionState>): void {
  const state = getStore().getState();
  if (!state.sessionStates[sessionId]) return;

  const current = state.sessionStates[sessionId];
  const patch = updater(current);
  if (Object.keys(patch).length === 0) return;
  const updated = { ...current, ...patch };
  const newSessionStates = { ...state.sessionStates, [sessionId]: updated };

  if (sessionId === state.activeSessionId) {
    const flatPatch: Record<string, unknown> = { sessionStates: newSessionStates };
    if ('messages' in patch) flatPatch.messages = patch.messages;
    if ('streamingMessageId' in patch) flatPatch.streamingMessageId = patch.streamingMessageId;
    if ('claudeReady' in patch) flatPatch.claudeReady = patch.claudeReady;
    if ('activeModel' in patch) flatPatch.activeModel = patch.activeModel;
    if ('permissionMode' in patch) flatPatch.permissionMode = patch.permissionMode;
    if ('contextUsage' in patch) flatPatch.contextUsage = patch.contextUsage;
    if ('lastResultCost' in patch) flatPatch.lastResultCost = patch.lastResultCost;
    if ('lastResultDuration' in patch) flatPatch.lastResultDuration = patch.lastResultDuration;
    if ('isIdle' in patch) flatPatch.isIdle = patch.isIdle;
    getStore().setState(flatPatch);
  } else {
    getStore().setState({ sessionStates: newSessionStates });
  }
}

/** Helper to update the active session's state and sync to flat state */
export function updateActiveSession(updater: (session: SessionState) => Partial<SessionState>): void {
  const state = getStore().getState();
  const activeId = state.activeSessionId;
  if (activeId) updateSession(activeId, updater);
}

// ---------------------------------------------------------------------------
// Shared dispatch table (epic #5556, sub-item 3)
//
// Pure-delegation message cases that were byte-identical with the app's
// handler are owned by the store-core table. `handleMessage` runs the table
// first; a miss falls through to the HANDLERS map + switch below, so the
// remaining (and genuinely divergent) cases stay exactly where they were.
// ---------------------------------------------------------------------------

const _dispatchAdapter: ClientStoreAdapter<SessionState> = {
  getActiveSessionId: () => getStore().getState().activeSessionId,
  hasSession: (id) => !!getStore().getState().sessionStates[id],
  updateSession: (id, updater) => updateSession(id, updater),
  setState: (patch) => getStore().setState(patch as Partial<ConnectionState>),
  // #5556 slice 4 — functional flat-state update for the web-task upsert cases.
  // Mirrors the prior inline `set((state) => …)` exactly (Zustand merges the
  // returned partial). The loose record in/out is cast to the store's
  // ConnectionState shape, same as `setState` above.
  updateState: (updater) =>
    getStore().setState((state) =>
      updater(state as unknown as Record<string, unknown>) as Partial<ConnectionState>,
    ),
  addMessage: (m) => getStore().getState().addMessage(m),
  // #6449 slice 1 — terminal-mirror cases (raw/raw_background/terminal_output)
  // migrated to the shared dispatch table. The dashboard writes only the
  // connection store (no secondary terminal store, unlike the app).
  appendTerminalData: (data) => getStore().getState().appendTerminalData(data),
  // #5618 — budget_warning (and future notice types) surface a transient alert
  // via the dashboard's alert adapter.
  alert: (title, message) => _adapters.alert.alert(title, message),
  getSessions: () => getStore().getState().sessions,
  // #5618 Batch 6 — checkpoint_created reads the prior flat list to append.
  // The dashboard omits syncSecondaryCheckpoints (no secondary checkpoint store).
  getCheckpoints: () => getStore().getState().checkpoints,
  // #5618 — checkpoint_restored auto-switches (plain, no options — the dashboard has
  // no serverNotify/haptic concepts; the app passes those via its own impl).
  switchToRestoredSession: (sessionId) => getStore().getState().switchSession(sessionId),
  // #5618 — search_results staleness gate reads the live flat searchQuery.
  getSearchQuery: () => getStore().getState().searchQuery,
  // #5618 — user_question raises a background-session notification via the
  // dashboard's own helper (dedup by (sessionId, eventType); no push store).
  pushSessionNotification: (sessionId, eventType, message) =>
    pushSessionNotification(sessionId, eventType, message),
  // #5618 — generic no-session fallback: mirror a session-targeted patch into FLAT
  // state (the dashboard UI reads flat streamingMessageId/isIdle/permissionMode; the
  // app omits this hook). Used by agent_idle and permission_mode_changed.
  applyNoSessionFallback: (patch) => getStore().setState(patch as Partial<ConnectionState>),
  // #5618 Batch 3 — error-sink for session_restore_failed / session_persist_failed.
  // The dashboard's connection-store addServerError builds its own envelope
  // (category 'general', id 'info', ring-capped serverErrors) from the message;
  // it ignores the structured opts (its prior behaviour took only the string).
  addServerError: (message) => getStore().getState().addServerError(message),
  // #5618 Batch 3 — session_stopped's info toast (#4878). The app omits this hook.
  addInfoNotification: (message) => getStore().getState().addInfoNotification(message),
  // #5618 Batch 4 — multi-client accessors for primary_changed / session_role /
  // client_focus_changed. The dashboard keeps presence state flat (the app uses
  // a dedicated useMultiClientStore); these accessors hide that divergence. The
  // dashboard has no secondary presence store, so it OMITS setPrimaryClientId.
  getMyClientId: () => getStore().getState().myClientId,
  getFollowMode: () => getStore().getState().followMode,
  switchSession: (sessionId) => getStore().getState().switchSession(sessionId),
  // #5618 Batch 5a — the dashboard tracks which provider the available_models
  // list is for; contribute it to the single available_models patch. The app
  // omits this hook (no availableModelsProvider field). The dashboard omits
  // setCostUpdate (cost_update's flat/cost-store mirror is app-only).
  extendModelsPatch: (msg) => ({
    availableModelsProvider: typeof msg.provider === 'string' ? msg.provider : null,
  }),
  // #5618 Batch 5b — repoint the localStorage server-registry entry after a
  // quick-tunnel rotation (tunnel_url_changed / auth_bootstrap). Consults
  // previousUrl to match the right entry (the app ignores it).
  applyRotatedTunnelUrl: (url, previousUrl) => {
    applyRotatedTunnelUrlDashboard(getStore().getState, url, previousUrl);
  },
};

const _dispatchTable = createDispatchTable<SessionState>();

// ---------------------------------------------------------------------------
// Session notification helper
// ---------------------------------------------------------------------------

/**
 * Push a notification for a background session event.
 * Deduplicates by (sessionId, eventType) — replaces existing rather than stacking.
 */
function pushSessionNotification(
  sessionId: string,
  eventType: SessionNotification['eventType'],
  message: string,
  requestId?: string,
): void {
  const state = getStore().getState();
  if (sessionId === state.activeSessionId) return;
  const sessionInfo = state.sessions.find((s) => s.sessionId === sessionId);
  const sessionName = sessionInfo?.name || sessionId;
  const notification: SessionNotification = {
    id: `${sessionId}-${eventType}-${Date.now()}`,
    sessionId,
    sessionName,
    eventType,
    message,
    timestamp: Date.now(),
    ...(requestId ? { requestId } : {}),
  };
  getStore().setState((s) => {
    const filtered = s.sessionNotifications.filter(
      (n) => !(n.sessionId === sessionId && n.eventType === eventType),
    );
    return { sessionNotifications: [...filtered, notification] };
  });
}

// ---------------------------------------------------------------------------
// Connection persistence helpers — delegated to @chroxy/store-core adapter
// ---------------------------------------------------------------------------

export function saveConnection(url: string, token: string): void {
  _storage.saveConnection(url, token)
}

export function loadConnection(): { url: string; token: string } | null {
  return _storage.loadConnection() as { url: string; token: string } | null
}

/**
 * Wipe the persisted connection URL + token from localStorage.
 *
 * NOTE: Storage-only. This does NOT close the active WebSocket, reset in-memory
 * store state, or navigate the UI. Use the store-level `clearSavedConnection()`
 * for the full "forget this server" flow, or `disconnect()` to close the live
 * socket.
 */
export function clearSavedCredentials(): void {
  _storage.clearSavedCredentials()
}

/**
 * #5536 — verify the server's signed ephemeral exchange key against the pinned
 * (or pairing-time) E2E identity before keying off it. Shared by BOTH handshake
 * paths (eager auth_ok and discrete key_exchange_ok).
 *
 * The pinned identity lives on the ACTIVE registry entry (the dashboard's
 * per-server record). On REFUSE (server identity changed / MITM / pinned-but-
 * unsigned downgrade) it tears the socket down and writes a distinct, specific
 * error so the UI shows a "server identity changed" state — NOT a silent retry
 * loop. On CONNECT it pins the pairing-time identity onto the active entry on a
 * pin-on-first-use.
 *
 * @returns true to PROCEED with the handshake, false to ABORT (already refused).
 */
function verifyServerIdentityOrRefuse(
  ctx: { socket: WebSocket; silent: boolean },
  exchangePublicKey: string,
  serverKeySig: string | null,
  // #5616 — identity-rotation continuity cert from the handshake (auth_ok /
  // key_exchange_ok). When the daemon rotated its identity, `newIdentityKey` is
  // its current key and `rotationCert` is the old-signed-new cert; a pinned
  // client whose pin no longer verifies chains forward instead of refusing.
  // Both null on un-rotated daemons / older servers (refusal path unchanged).
  newIdentityKey: string | null = null,
  rotationCert: string | null = null,
): boolean {
  const state = getStore().getState();
  const activeServerId = state.activeServerId;
  const activeEntry = activeServerId
    ? state.serverRegistry.find((s) => s.id === activeServerId)
    : undefined;
  const pinnedIdentityKey = activeEntry?.pinnedIdentityKey ?? null;
  const decision = decideKeyPinWithPairingIdentity({
    pinnedIdentityKey,
    pairingIdentityKey: getPendingPairingIdentityKey(),
    exchangePublicKey,
    serverKeySig,
    newIdentityKey,
    rotationCert,
  });
  if (decision.action === 'refuse') {
    applyIdentityRefusal(ctx, decision.reason, decision.message);
    return false;
  }
  // Connect — persist the offered identity as the new pin, then clear the
  // pairing identity. #5616 (#5978 parity with the app): BOTH TOFU first-use
  // ('pin-and-connect') AND a forward-chained rotation ('rotate-pin', where the
  // old pinned identity signed the new one) re-pin. Without the explicit
  // 'rotate-pin' arm the dashboard would connect this session but DROP the new
  // pin, so the next connect re-enters the handoff every time and the user is
  // locked out once the cert stops being offered.
  if (
    (decision.action === 'pin-and-connect' || decision.action === 'rotate-pin') &&
    activeServerId
  ) {
    getStore().getState().updateServer(activeServerId, { pinnedIdentityKey: decision.identityKey });
  }
  setPendingPairingIdentityKey(null);
  return true;
}

/**
 * #5614/#5536 — apply the loud, terminal "server identity refused" effects.
 * Shared by the signature/unsigned mismatch path and the plaintext-downgrade
 * gate so both surface identically (no silent retry, no fall-through to an
 * unencrypted session). We do NOT remove the registry entry — the user re-pairs
 * to adopt the new identity (which overwrites the pin). userDisconnected stops
 * the auto-reconnect loop from immediately re-dialing a box we just refused.
 */
function applyIdentityRefusal(
  ctx: { socket: WebSocket; silent: boolean },
  reason: string,
  message: string,
): void {
  console.error(`[crypto] Server identity verification failed (${reason}) — refusing connection`);
  try { ctx.socket.close(); } catch { /* already closing */ }
  getStore().setState({
    connectionPhase: 'disconnected',
    socket: null,
    connectionError: message,
    userDisconnected: true,
  });
  if (!ctx.silent) {
    _adapters.alert.alert('Server Identity Changed', message);
  }
  // Consume the pairing identity so a later dial doesn't reuse it.
  setPendingPairingIdentityKey(null);
}

/**
 * #5614 — the plaintext-downgrade gate, run at the TOP of the `auth_ok` handler
 * BEFORE the `encryption === 'required'` branch (where the pin check lives). If
 * this connection is pinned (committed pin or pairing-time identity) and the
 * server did not negotiate encryption, refuse — a MITM cannot otherwise be
 * stopped from forging a plaintext `auth_ok` that skips verification entirely.
 *
 * @returns true to PROCEED, false when the connection was refused (caller breaks).
 */
function enforceEncryptionGateOrRefuse(
  ctx: { socket: WebSocket; silent: boolean },
  encryptionMode: string | null | undefined,
): boolean {
  const state = getStore().getState();
  const activeEntry = state.activeServerId
    ? state.serverRegistry.find((s) => s.id === state.activeServerId)
    : undefined;
  const gate = decodeEncryptionGate({
    pinnedIdentityKey: activeEntry?.pinnedIdentityKey ?? null,
    pairingIdentityKey: getPendingPairingIdentityKey(),
    encryptionMode,
  });
  if (gate.action === 'refuse') {
    applyIdentityRefusal(ctx, gate.reason, gate.message);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Map-based handler infrastructure
// ---------------------------------------------------------------------------

/**
 * Signature for a standalone message handler extracted from the switch statement.
 * Receives the raw message, store accessors, and the connection context.
 */
type MsgGet = () => ConnectionState;
type MsgSet = (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void;
type Handler = (msg: Record<string, unknown>, get: MsgGet, set: MsgSet, ctx: ConnectionContext) => void;

// --- Extracted handler functions ---

function handlePong(msg: Record<string, unknown>, _get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  _onPong(typeof msg.serverTs === 'number' ? msg.serverTs : undefined);
}

// raw / raw_background / terminal_output — migrated to the shared dispatch table
// (#6449 slice 1; runDispatch handles them before the HANDLERS map, via the
// appendTerminalData adapter hook). terminal_output's active-session guard (drop
// a stale frame whose sessionId isn't the active session) now lives in
// dispatchTerminalOutput, byte-identical to the handler removed here.

// #5835 Phase 2: the server's authoritative live-PTY grid size for a session
// (sent on terminal_subscribe and on every primary-driven resize). Record it so
// the mirror renders at exactly this size, letterboxed. Same active-session +
// string-sessionId guard as terminal_output: the server only sends this for a
// session we're viewing, so an off-session/malformed frame is dropped.
function handleTerminalSize(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  // Positive integers only. The typeof check narrows for the setTerminalSize call
  // below; Number.isInteger then rejects NaN/Infinity/floats and > 0 keeps a
  // 0/negative grid out of term.resize. Matches the other numeric guards in this
  // file (the server sends sane clamped ints; defensive).
  if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return;
  if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows) || msg.cols <= 0 || msg.rows <= 0) return;
  if (typeof msg.sessionId !== 'string' || msg.sessionId !== get().activeSessionId) return;
  get().setTerminalSize(msg.sessionId, msg.cols, msg.rows);
}

function handleTokenRotated(msg: Record<string, unknown>, _get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  // Token parse shared via store-core (#5454); the URL-rewrite side effect
  // stays dashboard-specific.
  const { token: newToken } = sharedTokenRotated(msg);
  if (newToken) {
    // Server sent the new token — update URL query param for reconnection
    console.log('[ws] Server token rotated — updating stored token');
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('token', newToken);
      window.history.replaceState(null, '', url.toString());
    } catch { /* non-critical */ }
  } else {
    console.log('[ws] Server token rotated — re-authentication required');
  }
}

/**
 * #5555 (sub-item 7) — repoint the active server-registry entry's `wsUrl` to a
 * rotated tunnel URL so the dashboard's reconnect path dials the new endpoint
 * instead of the dead one. localStorage-backed, so the fix survives a tab
 * refresh / process restart.
 *
 * Only mutates a NON-localhost registry entry (`activeServerId !== null`): the
 * same-origin "this machine" connection (`activeServerId === null`) dials
 * `window.location` and never the tunnel URL, so a rotation does not affect it.
 * The entry is updated only when its current `wsUrl` is a `wss://` URL — i.e. it
 * really is a tunnel endpoint, not a `ws://` LAN entry. When the server told us
 * the `previousUrl`, we additionally require the stored URL to match it, so we
 * never clobber an entry the operator pointed at a different host.
 *
 * @returns true when an entry was updated, false on a no-op.
 */
function applyRotatedTunnelUrlDashboard(
  get: MsgGet,
  newUrl: string,
  previousUrl: string | null,
): boolean {
  if (!newUrl || !/^wss:\/\//i.test(newUrl)) return false;
  const state = get();
  const activeServerId = state.activeServerId;
  if (!activeServerId) return false;
  const entry = state.serverRegistry.find((s) => s.id === activeServerId);
  if (!entry) return false;
  // Only repoint a tunnel (wss://) entry; never a ws:// LAN entry.
  if (!/^wss:\/\//i.test(entry.wsUrl)) return false;
  if (entry.wsUrl === newUrl) return false;
  // When the server told us the prior URL, require the stored URL to match it
  // so we don't repoint an entry the operator aimed at a different host.
  if (previousUrl && entry.wsUrl !== previousUrl) return false;
  try {
    state.updateServer(activeServerId, { wsUrl: newUrl });
    return true;
  } catch {
    // validateWsUrl rejected the new URL — leave the stored entry untouched.
    return false;
  }
}

// checkpoint_restored — migrated to the shared dispatch table (#5618; runDispatch).
// The auto-switch rides the required switchToRestoredSession adapter hook (the
// dashboard's impl is the plain switchSession, no options).

/**
 * Server emits pairing_refreshed whenever the pairing ID changes: after a
 * pairing ID is consumed, on periodic auto-rotation, or on an explicit
 * refresh() call (#2916). Increment the counter so App.tsx can auto-refresh
 * the QR code while the modal is open.
 */
function handlePairingRefreshed(_msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  set(state => ({ pairingRefreshedCount: (state.pairingRefreshedCount ?? 0) + 1 }));
}

// web_feature_status + web_task_list migrated to the shared dispatch table
// (#5556 slice 2)

// conversations_list — migrated to the shared dispatch table (#5618; runDispatch).
// The dashboard has no conversationHistoryError / conversation-store mirror, so it
// omits the optional applyConversationsListExtras hook.

// #5618 — model_changed migrated to the shared store-core dispatch table
// (runDispatch handles it before the HANDLERS map / switch). Removed from here.
// The #5711 note (model_changed deliberately does NOT clear pending model-revert
// entries — server sends model_changed XOR error per requestId) still holds: the
// shared handler likewise only writes activeModel and never touches reverts.

function handleThinkingLevelChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const { level } = sharedThinkingLevelChanged(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => ({ thinkingLevel: level }));
  }
}

// #3185: per-session promptEvaluator toggle changed. Update the
// `sessions` array entry for the affected session so the UI reflects
// the new toggle state immediately. Other clients on the same session
// receive the broadcast and stay in sync.
function handlePromptEvaluatorChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const value = typeof msg.value === 'boolean' ? msg.value : null;
  if (value === null) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId) return;
  const sessions = get().sessions.map(s =>
    s.sessionId === targetId ? { ...s, promptEvaluator: value } : s,
  );
  _set({ sessions });
}

// #3805: per-session Chroxy context hint toggle changed. Mirrors
// handlePromptEvaluatorChanged — update the `sessions` array entry so
// every client bound to the session sees the new state immediately.
function handleChroxyContextHintChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const value = typeof msg.value === 'boolean' ? msg.value : null;
  if (value === null) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId) return;
  const sessions = get().sessions.map(s =>
    s.sessionId === targetId ? { ...s, chroxyContextHint: value } : s,
  );
  _set({ sessions });
}

// #4660: server-broadcast confirmation that the per-session preamble
// landed (and what trimmed value it actually stored). Mirrors
// handleChroxyContextHintChanged — accept only string-typed payloads,
// fall back to no-op for malformed events instead of clobbering state.
function handleSessionPreambleChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const value = typeof msg.value === 'string' ? msg.value : null;
  if (value === null) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId) return;
  const sessions = get().sessions.map(s =>
    s.sessionId === targetId ? { ...s, sessionPreamble: value } : s,
  );
  _set({ sessions });
}

// #3209: full skills list response. Replaces the cached list on the
// active (or message-targeted) session. Each entry carries `name`,
// `description`, `source`, `activation`, `active`. The dashboard
// SkillsPanel renders manual-skill toggles from this.
function handleSkillsList(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  if (!Array.isArray(msg.skills)) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  // Strip to the SessionSkillInfo shape — the server validates the
  // wire schema upstream, but a defensive copy keeps the store free
  // of any extra fields a future server might add.
  const skills = (msg.skills as Array<Record<string, unknown>>).map(s => {
    const source = s.source === 'global' || s.source === 'repo' ? s.source : undefined;
    const activation = s.activation === 'auto' || s.activation === 'manual' ? s.activation : undefined;
    const trustState = s.trustState === 'pending' || s.trustState === 'trusted' ? s.trustState : undefined;
    return {
      name: typeof s.name === 'string' ? s.name : '',
      description: typeof s.description === 'string' ? s.description : undefined,
      source: source as 'global' | 'repo' | undefined,
      activation: activation as 'auto' | 'manual' | undefined,
      active: typeof s.active === 'boolean' ? s.active : undefined,
      // #3205: optional audit metadata. The handler stays defensive
      // about types (older servers won't send these; future ones
      // might add fields the dashboard hasn't typed yet).
      version: typeof s.version === 'string' ? s.version : undefined,
      hashPrefix: typeof s.hashPrefix === 'string' ? s.hashPrefix : undefined,
      firstSeen: typeof s.firstSeen === 'string' ? s.firstSeen : undefined,
      lastVerified: typeof s.lastVerified === 'string' ? s.lastVerified : undefined,
      // #3298: community-skill trust fields. Only present on community skills;
      // absent (undefined) for global/repo skills.
      trustState: trustState as 'pending' | 'trusted' | undefined,
      communityAuthor: typeof s.communityAuthor === 'string' ? s.communityAuthor : undefined,
    };
  }).filter(s => s.name);
  updateSession(targetId, () => ({ skills }));
}

// #3205: skill content-hash mismatch event. The trust store detected
// that a skill's body changed since the recorded hash. Track the
// mismatched skill name on the affected session so the SkillsPanel
// can render a red-flag indicator. The wire payload also carries
// `oldHashPrefix` / `newHashPrefix` / `mode`, but the panel just
// needs the name list for the indicator UI.
function handleSkillChanged(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const prev = Array.isArray(state.mismatchedSkillNames) ? state.mismatchedSkillNames : [];
    if (prev.includes(skillName)) return {};
    return { mismatchedSkillNames: [...prev, skillName] };
  });
}

// #3209: runtime manual-skill toggle broadcasts. Update the cached
// skills list for the affected session so the toggle UI re-renders.
// If we don't have a cached list yet (rare — list_skills hasn't been
// requested), the next list_skills response will be authoritative.
function handleSkillActivated(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => ({
    skills: (state.skills || []).map(s =>
      s.name === skillName ? { ...s, active: true } : s,
    ),
  }));
}

function handleSkillDeactivated(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => ({
    skills: (state.skills || []).map(s =>
      s.name === skillName ? { ...s, active: false } : s,
    ),
  }));
}

// #3235: operator re-trusted a skill after a content-hash mismatch. The
// dashboard's job is to clear the SkillsPanel red-flag indicator (the
// `mismatchedSkillNames` entry from #3205) so the skill no longer
// appears as flagged. Pairs with `skill_changed` (the event that ADDED
// the name to that list).
function handleSkillTrustAccepted(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  if (!skillName) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const prev = Array.isArray(state.mismatchedSkillNames) ? state.mismatchedSkillNames : [];
    if (!prev.includes(skillName)) return {};
    return { mismatchedSkillNames: prev.filter((n) => n !== skillName) };
  });
}

// #3188: auto-evaluator rewrite broadcast (#3186 emit, #3208 schema).
// Push a `system` message into the targeted session's history with
// `evaluator` metadata so ChatView's renderMessage can render the
// rewrite-explanation banner. The system message is persisted in the
// per-session localStorage cache (`sessionMessagesKey` in
// packages/dashboard/src/store/persistence.ts), so reconnect/replay
// re-renders the banner from cache without re-firing the transient
// wire event. Dedup'd by `evaluatorIterationId`.
//
// Also clears any matching `pendingEvaluatorClarify` for the session: a
// rewrite verdict supersedes a stale clarify-pending entry the operator
// hadn't answered when the new round-trip kicked in.
function handleEvaluatorRewrite(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const evaluatorIterationId = typeof msg.evaluatorIterationId === 'string' ? msg.evaluatorIterationId : null;
  const originalDraft = typeof msg.originalDraft === 'string' ? msg.originalDraft : null;
  const rewritten = typeof msg.rewritten === 'string' ? msg.rewritten : null;
  if (!evaluatorIterationId || originalDraft === null || rewritten === null) return;
  const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;

  const evaluatorMeta: EvaluatorRewriteMeta = {
    kind: 'rewrite',
    evaluatorIterationId,
    originalDraft,
    rewritten,
    reasoning,
  };

  updateSession(targetId, (state) => {
    // Dedup on `evaluatorIterationId` so a localStorage-cache replay
    // (or duplicate broadcast) doesn't double-insert the banner.
    const alreadyInserted = state.messages.some(
      (m) => m.type === 'system' && m.evaluator?.evaluatorIterationId === evaluatorIterationId,
    );
    if (alreadyInserted) {
      // Still clear any stale clarify-pending state — a new rewrite
      // verdict means the prior clarify question no longer applies.
      if (state.pendingEvaluatorClarify) return { pendingEvaluatorClarify: null };
      return {};
    }
    const systemMessage: ChatMessage = {
      id: `evaluator-rewrite-${evaluatorIterationId}`,
      type: 'system',
      content: 'Your message was rewritten to be clearer — see why',
      timestamp: Date.now(),
      evaluator: evaluatorMeta,
    };
    const patch: Partial<SessionState> = {
      messages: [...state.messages, systemMessage],
    };
    if (state.pendingEvaluatorClarify) {
      patch.pendingEvaluatorClarify = null;
    }
    return patch;
  });
}

// #3188: auto-evaluator clarify broadcast (#3186 emit, #3208 schema).
// Set `pendingEvaluatorClarify` on the targeted session so ChatView
// renders an inline prompt block showing the clarifying question + the
// `Iteration N/3` counter. Cleared on the next user_input echo for this
// session or when a follow-up rewrite verdict supersedes it.
//
// Transient — NOT persisted across reconnects. The server re-fires the
// event on the next user_input cycle, so a reconnect mid-clarify drops
// the inline prompt; the operator re-types and the next round-trip
// reproduces it. Dedup'd by `evaluatorIterationId` so a duplicate
// broadcast doesn't reset state to an older question.
function handleEvaluatorClarify(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const evaluatorIterationId = typeof msg.evaluatorIterationId === 'string' ? msg.evaluatorIterationId : null;
  const evaluatorIteration = typeof msg.evaluatorIteration === 'number' && Number.isInteger(msg.evaluatorIteration) && msg.evaluatorIteration >= 1
    ? msg.evaluatorIteration
    : null;
  const originalDraft = typeof msg.originalDraft === 'string' ? msg.originalDraft : null;
  const clarification = typeof msg.clarification === 'string' ? msg.clarification : null;
  if (!evaluatorIterationId || evaluatorIteration === null || originalDraft === null || clarification === null) return;
  const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;

  const pending: PendingEvaluatorClarify = {
    evaluatorIterationId,
    evaluatorIteration,
    originalDraft,
    clarification,
    reasoning,
  };

  updateSession(targetId, (state) => {
    // Dedup on `evaluatorIterationId` — a duplicate broadcast for the
    // same iteration must NOT clobber state (no-op).
    if (state.pendingEvaluatorClarify?.evaluatorIterationId === evaluatorIterationId) return {};
    return { pendingEvaluatorClarify: pending };
  });
}

// #3298: community skill is awaiting first-activation trust grant. Add
// an entry to `pendingCommunitySkills` on the active (or target) session
// so the SkillsPanel "Pending review" section renders a Trust button.
// Idempotent — duplicate events (e.g. two sessions loading the same
// community author) are collapsed so the list stays de-duped.
function handleSkillTrustRequest(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  const author = typeof msg.author === 'string' ? msg.author : null;
  if (!skillName || !author) return;
  // #3310: capture optional description / path from the wire payload so
  // the SkillsPanel "Pending review" row can surface them for the operator.
  // Defensive typed — absent or non-string values become undefined so the
  // type matches PendingCommunitySkill's optional fields.
  const description = typeof msg.description === 'string' && msg.description ? msg.description : undefined;
  const path = typeof msg.path === 'string' && msg.path ? msg.path : undefined;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const existing: PendingCommunitySkill[] = Array.isArray(state.pendingCommunitySkills)
      ? state.pendingCommunitySkills
      : [];
    if (existing.some(p => p.name === skillName && p.author === author)) return {};
    const entry: PendingCommunitySkill = { name: skillName, author };
    if (description !== undefined) entry.description = description;
    if (path !== undefined) entry.path = path;
    return { pendingCommunitySkills: [...existing, entry] };
  });
}

// #3298: community skill trust was granted (broadcast to all clients
// bound to the session). Remove the matching entry from
// `pendingCommunitySkills` so the "Pending review" row disappears. The
// server will also refresh skills_list to reflect the newly-trusted skill.
function handleSkillTrustGranted(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const skillName = typeof msg.skillName === 'string' ? msg.skillName : null;
  const author = typeof msg.author === 'string' ? msg.author : null;
  if (!skillName || !author) return;
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const existing: PendingCommunitySkill[] = Array.isArray(state.pendingCommunitySkills)
      ? state.pendingCommunitySkills
      : [];
    return {
      pendingCommunitySkills: existing.filter(
        p => !(p.name === skillName && p.author === author),
      ),
    };
  });
}

// #3298: ack sent to the requesting client after a successful
// skill_trust_grant. The actual list update flows through
// skill_trust_granted (broadcast) and a subsequent skills_list refresh.
// #3588: clear the matching `pendingTrustGrants` entry so the
// SkillsPanel in-flight state (disabled Trust button + spinner) lifts.
// #3587: also consume the action-toast pending entry so the Map-based
// retry registry doesn't accumulate entries on the success path.
// Idempotent — if the broadcast clears the row before the ack arrives,
// the entry is already gone and this is a no-op.
function handleSkillTrustGrantOk(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  if (!requestId) return;
  // #3587: consume the action-toast Map entry
  consumePendingTrustGrant(requestId);
  // #3588: clear per-session pendingTrustGrants list (SkillsPanel spinner)
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (!targetId || !get().sessionStates[targetId]) return;
  updateSession(targetId, (state) => {
    const existing = Array.isArray(state.pendingTrustGrants) ? state.pendingTrustGrants : [];
    const next = existing.filter(g => g.requestId !== requestId);
    if (next.length === existing.length) return {};
    return { pendingTrustGrants: next };
  });
}

// #3588: clear an in-flight `pendingTrustGrants` entry whose requestId
// matches the supplied error envelope. Searches every session's
// pendingTrustGrants list (the requestId is unique across sessions, but
// the error envelope may not always carry sessionId — we don't want a
// missing sessionId to leave the row stuck). Returns true when an entry
// was cleared so the caller can branch on it; otherwise the requestId
// belongs to some other handler's request and is ignored.
function clearPendingTrustGrantByRequestId(requestId: string, get: MsgGet): boolean {
  const sessionStates = get().sessionStates;
  let cleared = false;
  for (const sid of Object.keys(sessionStates)) {
    const ss = sessionStates[sid];
    if (!ss) continue;
    const existing = Array.isArray(ss.pendingTrustGrants) ? ss.pendingTrustGrants : [];
    const next = existing.filter(g => g.requestId !== requestId);
    if (next.length !== existing.length) {
      cleared = true;
      updateSession(sid, () => ({ pendingTrustGrants: next }));
    }
  }
  return cleared;
}

// permission_mode_changed — migrated to the shared dispatch table (#5618;
// runDispatch). The seeded-session path + the no-session FLAT fallback
// (set({ permissionMode })) are the shared dispatchPermissionModeChanged; the flat
// fallback is carried by the _dispatchAdapter.applyNoSessionFallback hook (the
// dashboard's UI reads flat permissionMode), and pendingPermissionConfirm is cleared
// via setState. The dashboard has no pending optimistic-revert tracker, so it omits
// the clearPendingPermissionModeRequests hook.

// available_permission_modes + session_updated migrated to the shared
// store-core dispatch table (#5556)

function handleSessionSwitched(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const switched = sharedSessionSwitched(msg);
  if (!switched) return;
  const { newSessionId: sessionId, conversationId: switchConvId } = switched;
  // #5553: a create-confirm may carry the resolved repo preset. When it carries
  // a SEED, stash it keyed by sessionId so App's create-confirm effect can stage
  // it EDITABLE into the new session's composer (never auto-sent — same path as
  // the #5547 summarize seed). The preamble is already folded server-side; only
  // the seed crosses into the composer.
  const presetRaw = (msg as { sessionPreset?: unknown }).sessionPreset;
  if (presetRaw && typeof presetRaw === 'object') {
    const seed = (presetRaw as { seed?: unknown }).seed;
    if (typeof seed === 'string' && seed.length > 0) {
      set({ pendingServerSeed: { ...get().pendingServerSeed, [sessionId]: seed } });
    }
  }
  // Per-id dedup runs on every history replay path (#2901), so we no longer
  // need a "pending-switch" hint to distinguish user-initiated session switches
  // from auth-triggered ones.
  set((state: ConnectionState) => {
    // Initialize session state if it doesn't exist
    const sessionStates = { ...state.sessionStates };
    if (!sessionStates[sessionId]) {
      sessionStates[sessionId] = createEmptySessionState();
    }
    // Update conversationId if provided
    if (switchConvId) {
      sessionStates[sessionId] = { ...sessionStates[sessionId], conversationId: switchConvId };
    }
    const ss = sessionStates[sessionId];
    return {
      activeSessionId: sessionId,
      sessionStates,
      // Sync flat state from the switched-to session
      messages: ss.messages,
      streamingMessageId: ss.streamingMessageId,
      claudeReady: ss.claudeReady,
      activeModel: ss.activeModel,
      permissionMode: ss.permissionMode,
      contextUsage: ss.contextUsage,
      lastResultCost: ss.lastResultCost,
      lastResultDuration: ss.lastResultDuration,
      isIdle: ss.isIdle,
    };
  });
  // Refresh slash commands (project commands may differ per session cwd)
  get().fetchSlashCommands();
  // Refresh agents (project agents may differ per session cwd)
  get().fetchCustomAgents();
}

function handleClaudeReady(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // #5431: pass the wire message through — enriched ready carries
  // transcript-derived backgroundTasks / scheduledWakeup fields.
  const patch = sharedClaudeReady(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, () => patch);
  } else {
    set(patch);
  }
  // Drain queued messages on reconnect
  const readySocket = get().socket;
  if (readySocket && readySocket.readyState === WebSocket.OPEN) {
    drainMessageQueue(readySocket);
  }
}

// agent_idle — migrated to the shared dispatch table (#5618; runDispatch handles
// it before this HANDLERS map). The seeded-session path is the shared
// dispatchAgentIdle; the dashboard's no-session FLAT fallback (its UI reads flat
// streamingMessageId/isIdle directly — App.tsx isStreaming — and sendInput writes
// flat 'pending', so without it an abnormal agent_idle leaves the stop button
// stuck) is preserved per-client via the _dispatchAdapter.applyAgentIdleFallback
// hook below.

// agent_busy migrated to the shared store-core dispatch table (#5556)

function handleStreamStart(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const targetId = (msg.sessionId as string) || get().activeSessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => {
      const out = sharedStreamStart(msg, get().activeSessionId, ss.messages);
      if (out.remap) {
        _deltaIdRemaps.set(out.remap.from, out.remap.to);
      }
      if (!out.isNewMessage) {
        // Reuse existing response message (reconnect replay dedup). #6302 — the
        // 'pending' sentinel is now adopted by a real stream id, so null the
        // faked-fresh-turn owner (owner is non-null only while 'pending').
        return { streamingMessageId: out.streamingMessageId, pendingClientMessageId: null };
      }
      return {
        streamingMessageId: out.streamingMessageId,
        // #6302 — real id adopts the turn; clear the faked-fresh-turn owner.
        pendingClientMessageId: null,
        messages: [...filterThinking(ss.messages), out.newMessage!],
      };
    });
  } else {
    set((state: ConnectionState) => {
      const out = sharedStreamStart(msg, get().activeSessionId, state.messages);
      if (out.remap) {
        _deltaIdRemaps.set(out.remap.from, out.remap.to);
      }
      if (!out.isNewMessage) {
        return { streamingMessageId: out.streamingMessageId };
      }
      return {
        streamingMessageId: out.streamingMessageId,
        messages: [...filterThinking(state.messages), out.newMessage!],
      };
    });
  }
}

function handleStreamDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // #5515 (epic #5514): record the server-stamped serverTs and local recv time
  // of the OLDEST un-rendered delta for this messageId so flushPendingDeltas
  // can measure token-to-render. First-write-wins until the next flush clears
  // it (mirrors the server's per-flush emit stamp).
  if (typeof msg.messageId === 'string') {
    const sTs = typeof msg.serverTs === 'number' ? msg.serverTs : null;
    if (sTs !== null && !_deltaServerTs.has(msg.messageId)) {
      _deltaServerTs.set(msg.messageId, { serverTs: sTs, recvAt: Date.now() });
    }
  }
  // #4981 — thin wrapper over `sharedStreamDelta`. The platform-neutral hot
  // path (post-permission split, single-hop defensive remap, post-tool
  // continuation split with the #4999/#5014 sentence gate and #4975 mid-word
  // peel, buffered append + 100ms flush) lives in store-core. The dashboard-
  // specific side effects stay here: the terminal-data write, the #4297
  // empty-response-slot reorder, and the flat-`messages` fallbacks (the app
  // has neither — see the StreamDeltaContext doc comment).
  sharedStreamDelta(msg, {
    activeSessionId: get().activeSessionId,
    pendingDeltas,
    deltaIdRemaps: _deltaIdRemaps,
    postPermissionSplits: _postPermissionSplits,
    replayingSessions: _replayingSessions,

    getSessionMessages: (sessionId) =>
      sessionId && get().sessionStates[sessionId]
        ? get().sessionStates[sessionId]!.messages
        : null,
    getFlatMessages: () => get().messages,

    // Forward delta text to terminal view (synthesize raw output in CLI mode).
    // The shared fn already gates on `typeof msg.delta === 'string' && length`.
    appendTerminalDelta: (delta) => {
      get().appendTerminalData(delta);
    },

    // #4297 — TUI fires stream_start at turn-start (#4010), creating an empty
    // response slot. Tool events that follow append AFTER the slot. If the
    // turn ends with a summary stream_delta, the text would otherwise
    // materialize at the early slot position — making claude's wrap-up appear
    // ABOVE the tool groups it summarized. On the first delta for an empty
    // response slot, move it to the current end of the messages array. We gate
    // on content === '' so a reconnect-replayed response (already populated)
    // is never shifted. The shared fn applies the not-split / not-remapped /
    // not-pending guard before calling this.
    reorderEmptyResponseSlot: (deltaId, capturedSessionId) => {
      const targetForReorder = (capturedSessionId && get().sessionStates[capturedSessionId])
        ? capturedSessionId
        : null;
      if (targetForReorder) {
        const ss = get().sessionStates[targetForReorder]!;
        const idx = ss.messages.findIndex((m) => m.id === deltaId);
        if (idx >= 0 && idx < ss.messages.length - 1) {
          const slot = ss.messages[idx]!;
          if (slot.type === 'response' && slot.content === '') {
            updateSession(targetForReorder, (s) => ({
              messages: [
                ...s.messages.slice(0, idx),
                ...s.messages.slice(idx + 1),
                slot,
              ],
            }));
          }
        }
      } else {
        // Flat-messages fallback (pre-session bootstrap)
        const flat = get().messages;
        const idx = flat.findIndex((m) => m.id === deltaId);
        if (idx >= 0 && idx < flat.length - 1) {
          const slot = flat[idx]!;
          if (slot.type === 'response' && slot.content === '') {
            set((state) => ({
              messages: [
                ...state.messages.slice(0, idx),
                ...state.messages.slice(idx + 1),
                slot,
              ],
            }));
          }
        }
      }
    },

    // Append a fresh response slot + set streamingMessageId. A null target (or
    // a target without session state) routes to the flat-messages array —
    // mirroring the dashboard's original session-state-or-flat branches for
    // the permission split, defensive `-response` suffix, and `-cont-` split.
    appendResponseSlot: (targetSessionId, slot, opts) => {
      if (targetSessionId && get().sessionStates[targetSessionId]) {
        if (opts?.onlyIfAbsent
            && get().sessionStates[targetSessionId]!.messages.some((m) => m.id === slot.id)) {
          return;
        }
        updateSession(targetSessionId, (ss) => ({
          streamingMessageId: slot.id,
          messages: [...ss.messages, slot],
        }));
      } else {
        if (opts?.onlyIfAbsent && get().messages.some((m) => m.id === slot.id)) {
          return;
        }
        set((state: ConnectionState) => ({
          streamingMessageId: slot.id,
          messages: [...state.messages, slot],
        }));
      }
    },

    // Peel `count` trailing chars off the flushed content of the response slot
    // at `deltaId`. Null target routes to flat messages.
    peelSlotContent: (targetSessionId, deltaId, count) => {
      const updater = (ss: { messages: ChatMessage[] }) => ({
        messages: ss.messages.map((m) =>
          m.id === deltaId && m.type === 'response'
            ? { ...m, content: m.content.slice(0, m.content.length - count) }
            : m
        ),
      });
      if (targetSessionId && get().sessionStates[targetSessionId]) {
        updateSession(targetSessionId, updater);
      } else {
        set((s) => ({ messages: updater({ messages: s.messages }).messages }));
      }
    },

    // #5556 — arm the shared coalescing window (adaptive interval; was a fixed
    // 100ms). Memoized rows (step 1) make the tighter flush cheap: only the tail
    // re-renders. First-arm-wins inside the flusher.
    scheduleFlush: () => {
      deltaFlusher.schedule();
    },
  });
}

function handleStreamEnd(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // Flush any buffered deltas immediately before clearing streaming state
  deltaFlusher.flushNow();
  // Add newline separator after response ends for Output view readability
  get().appendTerminalData('\r\n');
  const out = sharedStreamEnd(msg, get().activeSessionId);
  // Clean up permission boundary split tracking. messageId is null for
  // malformed payloads (non-string msg.messageId) — skip cleanup in that case.
  if (out.messageId !== null) {
    _postPermissionSplits.delete(out.messageId);
    _deltaIdRemaps.delete(out.messageId);
  }
  const targetId = out.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    // Force a new messages array reference so selectors detect the change,
    // even when flushPendingDeltas() was a no-op (timer already flushed).
    updateSession(targetId, (ss) => ({
      streamingMessageId: null,
      messages: [...ss.messages],
    }));
  } else {
    set((s) => ({ streamingMessageId: null, messages: [...s.messages] }));
  }
}

function handleToolStart(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  // Forward tool invocation to terminal view (dashboard-only side effect).
  // Performed unconditionally and BEFORE sharedToolStart so a JSON.stringify
  // throw on a non-serialisable msg.input (circular ref) cannot suppress the
  // terminal preview write — matches the prior inline ordering.
  const toolName = typeof msg.tool === 'string' ? msg.tool : 'tool';
  get().appendTerminalData(`\r\n\x1b[36m⏺ ${toolName}\x1b[0m\r\n`);
  const toolStartTargetId = typeof msg.sessionId === 'string' ? msg.sessionId : get().activeSessionId;
  const cached = (() => {
    const targetState = toolStartTargetId ? get().sessionStates[toolStartTargetId] : null;
    // #5555.4 — scope to the appended replay tail during a full rebuild (see
    // the `message` case for the rationale).
    return replayDedupCache(
      toolStartTargetId,
      targetState ? targetState.messages : get().messages,
    );
  })();
  // #4493 — per-session replay scoping. Dedup against the cached history
  // only when THIS message's session is currently replaying.
  const toolStartIsReplay = toolStartTargetId ? _replayingSessions.has(toolStartTargetId) : false;
  // #5555.3 — advance the cursor for replayed tool_start entries.
  if (toolStartIsReplay) recordHistorySeq(toolStartTargetId, (msg as { historySeq?: unknown }).historySeq);
  const result = sharedToolStart(msg, get().activeSessionId, toolStartIsReplay, cached);
  if (!result.shouldDispatch || !result.chatMessage) return;
  const toolMsg = result.chatMessage;
  const targetId = result.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => {
      const patch: Partial<SessionState> = {
        messages: [...ss.messages, toolMsg],
      };
      // If the turn opened with a tool (no preamble text → no stream_start
      // yet), streamingMessageId is still 'pending' from sendInput. The 5-
      // second safety timer in sendInput would clear it, hiding the stop
      // button for the rest of the tool execution. Bump it to the tool
      // bubble's id (already normalized by sharedToolStart — falls back to a
      // synthesized id when msg.messageId is missing) so the timer no-ops;
      // the next stream_start will overwrite with the response id.
      if (ss.streamingMessageId === 'pending') {
        patch.streamingMessageId = toolMsg.id;
        // #6302 — a tool-led turn just adopted the 'pending' sentinel with a real
        // id, so clear the faked-fresh-turn owner (it never queued).
        patch.pendingClientMessageId = null;
      }
      // #4308 — track the in-flight tool in activeTools[]. Same-reference
      // no-op (dedup by toolUseId) is honoured so a duplicate broadcast
      // doesn't churn state.
      const nextActiveTools = result.applyToActiveTools(ss.activeTools);
      if (nextActiveTools !== ss.activeTools) {
        patch.activeTools = nextActiveTools;
      }
      return patch;
    });
  } else {
    get().addMessage(toolMsg);
    // Same bump for the flat-state path (legacy / pre-session bootstrap).
    if (getStore().getState().streamingMessageId === 'pending') {
      getStore().setState({ streamingMessageId: toolMsg.id });
    }
  }
}

function handleToolInputDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // #4081: append the partialJson chunk to the matching tool_use
  // bubble's `toolInputPartial` accumulator. sharedToolInputDelta
  // validates the wire payload (toolUseId + partialJson string types),
  // resolves sessionId, and returns an `applyTo` that no-ops when no
  // matching tool_use is found (mirrors handleToolResult). Permission-
  // pending suppression lives on the server (#4080) — by the time a
  // delta reaches this handler the bubble is guaranteed to be the
  // live target.
  const result = sharedToolInputDelta(msg, get().activeSessionId);
  if (!result) return;
  const targetId = result.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss: SessionState) => {
      const updated = result.applyTo(ss.messages);
      if (updated === ss.messages) return {};
      return { messages: updated };
    });
  } else {
    const updated = result.applyTo(get().messages);
    if (updated !== get().messages) {
      set({ messages: updated });
    }
  }
}

function handleToolResult(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const result = sharedToolResult(msg, get().activeSessionId);
  if (!result) return;
  // Forward tool result to terminal view (dashboard-only side effect).
  // #5778: unwrap the result envelope first so the Output tab shows the
  // stdout/stderr text rather than the raw `{"stdout":...}` JSON.
  if (result.resultText) {
    const text = unwrapToolResultText(result.resultText);
    const preview = text.length > 500
      ? text.slice(0, 500) + '...'
      : text;
    get().appendTerminalData(`\x1b[2m${preview}\x1b[0m\r\n`);
  }
  const targetId = result.sessionId;
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss: SessionState) => {
      const updated = result.applyTo(ss.messages);
      // #4308 — drop the resolved entry from activeTools[]. Same-reference
      // no-op (tool not currently tracked) is honoured to skip the write.
      const nextActiveTools = result.applyToActiveTools(ss.activeTools);
      const patch: Partial<SessionState> = {};
      if (updated !== ss.messages) patch.messages = updated;
      if (nextActiveTools !== ss.activeTools) patch.activeTools = nextActiveTools;
      return patch;
    });
  } else {
    const updated = result.applyTo(get().messages);
    if (updated !== get().messages) {
      set({ messages: updated });
    }
  }
}

function handlePermissionRequest(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // #5454: payload parse is shared via store-core (`handlePermissionRequest`)
  // — same handler the app uses. Dashboard-specific glue kept below:
  //   - flat-state fallbacks (`get().messages` / top-level `streamingMessageId`)
  //     for sessions not yet in `sessionStates`;
  //   - #2853 options trimming (allow/deny only — see comment below);
  //   - the simpler 4-arg `pushSessionNotification` (no input preview).
  const permPayload = sharedPermissionRequest(msg);
  // Skip malformed messages with missing/non-string requestId — matches the
  // app and the shared-handler contract. (Previously the dashboard would
  // insert a prompt with an `undefined` requestId and still run the stream
  // split; such a message is unanswerable, so drop it outright.)
  if (!permPayload.requestId) return;
  // #5693 containment: a permission MAPPED to a session must surface in THAT
  // session's transcript, never whatever tab is focused — and must not disturb
  // the focused tab's in-flight stream. Create the owning session's empty state
  // (tab-invisible — tabs come from `sessions`, not `sessionStates`) BEFORE the
  // #554 stream-split below, so the split reads the owning session's stream
  // (null for a freshly-created state) instead of falling back to the ACTIVE
  // session's `streamingMessageId` and clearing a different tab's stream.
  // Unmapped prompts (no wire sessionId) intentionally stay with the active
  // session (still answerable, not mislabeled — originSessionId stays undefined).
  const ownerSessionId = permPayload.sessionId;
  if (ownerSessionId && !get().sessionStates[ownerSessionId]) {
    set((state) => ({
      sessionStates: { ...state.sessionStates, [ownerSessionId]: createEmptySessionState() },
    }));
  }
  // Split streaming response at permission boundary (#554). The pure
  // split/remap-resolution core is shared via store-core (#5454); the side
  // effects below keep their original order.
  {
    const permTargetId = permPayload.sessionId || get().activeSessionId;
    const currentStreamId = permTargetId && get().sessionStates[permTargetId]
      ? get().sessionStates[permTargetId]!.streamingMessageId
      : get().streamingMessageId;
    const split = resolvePermissionStreamSplit(currentStreamId, _deltaIdRemaps);
    if (split) {
      deltaFlusher.flushNow();
      _postPermissionSplits.add(split.serverStreamId);
      if (permTargetId && get().sessionStates[permTargetId]) {
        updateSession(permTargetId, () => ({ streamingMessageId: null }));
      } else {
        set({ streamingMessageId: null });
      }
    }
  }
  const permRequestId = permPayload.requestId;
  // #2853: PermissionPrompt hardcodes its own buttons (Allow / Allow for Session
  // / Deny) and never reads this array; `sendPermissionResponse` only accepts
  // 'allow' | 'deny' | 'allowSession'. Keep only the wire-level allow/deny
  // options in the stored payload for history/debug inspection, without
  // advertising dashboard-only decisions ('allowSession') or unreachable ones
  // ('allowAlways') here. (Intentional divergence from the app, which builds
  // its options list dynamically — including the #3072 provider-capability
  // gate for 'Allow for Session' — because its prompt UI renders from it.)
  const newOptions = [
    { label: 'Allow', value: 'allow' },
    { label: 'Deny', value: 'deny' },
  ];
  const newExpiresAt = permPayload.remainingMs !== null ? Date.now() + permPayload.remainingMs : undefined;
  const permTargetId = permPayload.sessionId || get().activeSessionId;

  const targetMessages = permTargetId && get().sessionStates[permTargetId]
    ? get().sessionStates[permTargetId]!.messages
    : get().messages;
  const existingIdx = targetMessages.findIndex(
    (m) => m.requestId === permRequestId && m.type === 'prompt'
  );

  if (existingIdx !== -1) {
    const updater = (ss: { messages: ChatMessage[] }) => ({
      messages: ss.messages.map((m) =>
        m.requestId === permRequestId && m.type === 'prompt'
          ? { ...m, answered: undefined, options: newOptions, expiresAt: newExpiresAt }
          : m
      ),
    });
    if (permTargetId && get().sessionStates[permTargetId]) {
      updateSession(permTargetId, updater);
    } else {
      set({ messages: updater({ messages: get().messages }).messages });
    }
  } else {
    const permMsg: ChatMessage = {
      id: nextMessageId('perm'),
      type: 'prompt',
      // Render only the tool name when description is missing; otherwise
      // combine `"<tool>: <description>"`. Fallback to a generic label when
      // neither is available. Fixes the "Tool: undefined" string that the
      // prior `${tool}: ${description}` template produced (#3122). The
      // string guards (#3122) and the array-rejecting input guard (#3123)
      // live in the shared parser.
      content: permPayload.tool
        ? (permPayload.description ? `${permPayload.tool}: ${permPayload.description}` : permPayload.tool)
        : (permPayload.description || 'Permission required'),
      tool: permPayload.tool ?? undefined,
      requestId: permRequestId,
      toolInput: permPayload.input ?? undefined,
      options: newOptions,
      expiresAt: newExpiresAt,
      timestamp: Date.now(),
      // #5667 — record the OWNING session (the wire sessionId), so the renderer
      // can label which session asked. Deliberately not `permTargetId`: that
      // falls back to the active session for unmapped/legacy requests, which
      // would mislabel them as the active session's own prompt. Undefined when
      // the request maps to no session (contract: originSessionId is the owner
      // or absent).
      originSessionId: permPayload.sessionId ?? undefined,
    };
    if (permTargetId && get().sessionStates[permTargetId]) {
      updateSession(permTargetId, (ss) => ({
        messages: [...ss.messages, permMsg],
      }));
    } else {
      get().addMessage(permMsg);
    }
  }
  if (permTargetId) {
    const toolDesc = permPayload.tool ?? 'Permission needed';
    pushSessionNotification(permTargetId, 'permission', toolDesc, permRequestId);
  }
}

function handlePermissionResolved(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  // Another client resolved this permission — dismiss the prompt on this client.
  // The permission_request may have been stored in ANY session state (whichever tab
  // was active when it arrived), so search all session states for the matching requestId.
  // #5454: payload parse shared via store-core (same handler the app uses);
  // the flat-messages fallback and #5008 mark-read banner draining below are
  // dashboard-specific.
  const { requestId: resolvedRequestId, decision: resolvedDecision } =
    sharedPermissionResolved(msg);
  if (resolvedRequestId) {
    const updater = (ss: { messages: ChatMessage[] }) => ({
      messages: ss.messages.map((m) =>
        m.requestId === resolvedRequestId && m.type === 'prompt'
          ? { ...m, answered: resolvedDecision ?? undefined, answeredAt: Date.now(), options: undefined }
          : m
      ),
    });
    // Search all session states for the permission prompt
    const states = get().sessionStates;
    let found = false;
    for (const sid of Object.keys(states)) {
      if (states[sid]?.messages.some((m) => m.requestId === resolvedRequestId)) {
        updateSession(sid, updater);
        found = true;
        break;
      }
    }
    // Also check flat messages (fallback for sessions not in sessionStates)
    if (!found) {
      set({ messages: updater({ messages: get().messages }).messages });
    }
    // #5008 — drain the banner stack (which filters by `readAt === undefined`)
    // without dropping the entry from `sessionNotifications`. Pre-#5008 we
    // hard-removed the row, which silently drained every resolved alert from
    // the NotificationsWidget's "durable history" view. Stamping `readAt`
    // instead keeps the row visible in the widget (read row treatment) while
    // the banner stack still vanishes.
    //
    // Idempotent — only stamp entries that have not already been acked, so a
    // server-driven resolution arriving after the operator already marked the
    // row read via the widget can't clobber the original ack timestamp.
    //
    // Hoist `Date.now()` out of the `.map(...)` so every matching row in this
    // mutation shares a single timestamp. Matches the existing pattern at
    // connection.ts:2167 (`switchReadStamp`) and connection.ts:2461
    // (`markAllSessionNotificationsRead`).
    const readStamp = Date.now();
    set((s) => ({
      sessionNotifications: (s.sessionNotifications ?? []).map((n) =>
        n.requestId === resolvedRequestId && n.readAt === undefined
          ? { ...n, readAt: readStamp }
          : n
      ),
    }));
    // #6559 — prune the pulled pre-write-diff input for this now-resolved prompt.
    // permissionInputs is append-only otherwise and grows unbounded over a long
    // session. Guard the copy-delete so a prompt that never pulled input (the
    // common case) doesn't churn a new object. Mirrors the app handler.
    set((s) => {
      if (!s.permissionInputs || !Object.prototype.hasOwnProperty.call(s.permissionInputs, resolvedRequestId)) return {};
      const next = { ...s.permissionInputs };
      delete next[resolvedRequestId];
      return { permissionInputs: next };
    });
  }
}

// budget_warning — migrated to the shared dispatch table (#5618; runDispatch).
// The alert rides the new adapter.alert primitive; routing is byte-identical.

function handleBudgetExceeded(msg: Record<string, unknown>, get: MsgGet, _set: MsgSet, _ctx: ConnectionContext): void {
  const { exceededMessage, systemMessage } = sharedBudgetExceeded(msg);
  const targetId = resolveSessionId(msg, get().activeSessionId);
  // Dashboard auto-resumes — append note to the system message
  const dashboardMsg: ChatMessage = {
    ...systemMessage,
    content: `${systemMessage.content}. Budget will auto-resume.`,
  };
  // Add system message BEFORE auto-resume so it's visible in the UI
  if (targetId && get().sessionStates[targetId]) {
    updateSession(targetId, (ss) => ({
      messages: [...ss.messages, dashboardMsg],
    }));
  } else {
    get().addMessage(dashboardMsg);
  }
  // Show toast notification
  _adapters.alert.alert('Budget Exceeded', `${exceededMessage}\n\nNew messages are paused.`);
  // Auto-resume budget
  const socket = get().socket;
  if (socket && targetId) {
    wsSend(socket, { type: 'resume_budget', sessionId: targetId });
  }
}

// budget_resumed migrated to the shared store-core dispatch table (#5556)

function handleServerError(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const { serverError, chatMessage: errorMsg } = sharedServerError(msg);
  set((state: ConnectionState) => ({
    serverErrors: [...state.serverErrors, serverError].slice(-10),
  }));
  const errSessionId = serverError.sessionId;
  if (errSessionId && get().sessionStates[errSessionId]) {
    // Scoped error — route to the specific session only
    updateSession(errSessionId, (ss) => ({
      messages: filterThinking([...ss.messages, errorMsg]),
      streamingMessageId: null,
      // #6302 — clear the pending-turn owner with the sentinel (parity with the
      // app's server_error clear) so a stale owner can't mis-gate a reconcile.
      pendingClientMessageId: null,
    }));
  } else {
    const activeErrId = get().activeSessionId;
    if (activeErrId && get().sessionStates[activeErrId]) {
      updateActiveSession((ss) => ({
        messages: filterThinking([...ss.messages, errorMsg]),
        streamingMessageId: null,
        pendingClientMessageId: null,
      }));
    } else {
      set({ streamingMessageId: null });
      get().addMessage(errorMsg);
    }
  }
  if (!serverError.recoverable) {
    _adapters.alert.alert('Server Error', serverError.message);
  }
}

// server_shutdown — migrated to the shared dispatch table (#5618; runDispatch).
// The dashboard has no shutdown notification, so it omits applyShutdownNotification.

/**
 * #5163 (epic #5159) — Control Room `activity_snapshot`: REPLACE the target
 * session's activity tree with the snapshot's entries via the store-core
 * reducer. Emitted on subscribe / resync so a late-joining or reconnecting
 * client reaches canonical state in one message.
 *
 * The wire shape is validated with the protocol Zod schema (same defensive
 * pattern as the credential-status handlers) so a malformed payload is dropped
 * rather than crashing the reducer. `applyActivityDelta`/`applyActivitySnapshot`
 * return the SAME state reference on a no-op, so the equality short-circuit
 * below skips a needless re-render.
 */
function handleActivitySnapshot(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerActivitySnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  const prev = get().activity;
  const next = applyActivitySnapshot(prev, parsed.data);
  if (next === prev) return;
  set({ activity: next });
}

/**
 * #5163 (epic #5159) — Control Room `activity_delta`: upsert the carried entry
 * into its session by id. `op` is advisory — the full entry drives the result,
 * so a dropped earlier delta is self-healed by the next one. Validated +
 * no-op-short-circuited like the snapshot handler above.
 *
 * Copilot review: an `activity_delta` is a genuine live state change (a
 * background shell / subagent / tool started, progressed, or ended), so it
 * also counts as activity-bearing — bump `lastClientActivityAt` and clear any
 * outstanding `inactivityWarning` for the delta's session so the "Working… last
 * activity Ns ago" indicator and the inactivity chip don't go stale while only
 * Control Room traffic is flowing. Gated on `_replayingSessions` exactly like
 * the dispatch-level bump (#4466) so a session switch's history replay doesn't
 * reset the timestamp. NOTE: `activity_snapshot` deliberately does NOT bump —
 * it's a full-state resync emitted on subscribe / reconnect, not fresh work.
 */
function handleActivityDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerActivityDeltaSchema.safeParse(msg);
  if (!parsed.success) return;
  const prev = get().activity;
  const next = applyActivityDelta(prev, parsed.data);
  if (next === prev) return;
  set({ activity: next });

  // #5277: if a node we were cancelling just went terminal (whether from the
  // cancel itself or natural completion racing it), drop its pending state so
  // the id can't leak in cancellingActivityIds after the row is gone/finished.
  if (parsed.data.op === 'ended') {
    clearCancellingActivity(get, set, parsed.data.sessionId, parsed.data.entry.id);
  }

  const sessionId = parsed.data.sessionId;
  if (get().sessionStates[sessionId] && !_replayingSessions.has(sessionId)) {
    updateSession(sessionId, (ss) => {
      const patch: Partial<SessionState> = { lastClientActivityAt: Date.now() };
      if (ss.inactivityWarning) patch.inactivityWarning = null;
      return patch;
    });
  }
}

/**
 * #5277 — Control Room `cancel_activity_ack`: positive confirmation that a
 * cancel_activity request was actioned. Clears the node's "cancelling" pending
 * state (the terminal activity_delta separately updates the tree itself).
 */
function handleCancelActivityAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerCancelActivityAckSchema.safeParse(msg);
  if (!parsed.success) return;
  clearCancellingActivity(get, set, parsed.data.sessionId, parsed.data.activityId);
}

/** #5277 — composite key: activity ids are only unique within a session. */
function cancelKey(sessionId: string | undefined, activityId: string | undefined): string | null {
  if (!sessionId || !activityId) return null;
  return `${sessionId}:${activityId}`;
}

/**
 * #5277 — drop one `${sessionId}:${activityId}` from the in-flight cancel set
 * (shared by the success ack, the CANCEL_ACTIVITY_FAILED session_error, and a
 * terminal activity_delta). No-op if absent.
 */
function clearCancellingActivity(get: MsgGet, set: MsgSet, sessionId: string | undefined, activityId: string | undefined): void {
  const key = cancelKey(sessionId, activityId);
  if (!key) return;
  const prev = get().cancellingActivityIds;
  if (!prev || !prev.has(key)) return;
  const next = new Set(prev);
  next.delete(key);
  set({ cancellingActivityIds: next });
}

/**
 * #5277 — drop ALL pending cancels for a session. Used when a session-level
 * error (SESSION_NOT_FOUND) means no cancel for that session can ever resolve,
 * so its nodes must not stay stuck "Cancelling…".
 */
function clearCancellingForSession(get: MsgGet, set: MsgSet, sessionId: string | undefined): void {
  if (!sessionId) return;
  const prev = get().cancellingActivityIds;
  if (!prev || prev.size === 0) return;
  const prefix = `${sessionId}:`;
  let changed = false;
  const next = new Set<string>();
  for (const key of prev) {
    if (key.startsWith(prefix)) { changed = true; continue; }
    next.add(key);
  }
  if (changed) set({ cancellingActivityIds: next });
}

/**
 * #5175 (epic #5170) — Host/Repo Status Control Room `host_status_snapshot`:
 * REPLACE the stored survey with the carried snapshot and clear the in-flight
 * loading flag. The survey is a full picture (no delta stream), so each
 * snapshot wholesale-replaces the previous one — the Control Room section
 * re-renders the fleet table from `hostStatus`.
 *
 * The wire shape is validated with the protocol Zod schema (same defensive
 * pattern as the activity / credential-status handlers) so a malformed payload
 * is dropped rather than crashing the renderer. `hostStatusLoading` is cleared
 * even on a successful parse only — a malformed payload leaves the spinner up
 * so a buggy server doesn't make the Refresh button silently lie.
 */
function handleHostStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerHostStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ hostStatus: parsed.data, hostStatusLoading: false });
}

/**
 * #6471 (epic #6469) — opt-in IDE `symbols_snapshot`: REPLACE the stored
 * workspace symbol table with the carried snapshot and clear the in-flight
 * loading flag. Each snapshot is a full picture (no delta stream), so it
 * wholesale-replaces the previous one. The wire shape is Zod-validated (same
 * defensive pattern as the Control Room snapshots) so a malformed payload is
 * dropped rather than crashing the symbol panel (#6472). `symbolsLoading` is
 * cleared only on a successful parse so a buggy server can't make the Refresh
 * affordance silently lie. Dashboard-only for v1 (the mobile app has no symbol
 * surface yet).
 */
function handleSymbolsSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSymbolsSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  // #6476 — a whole-workspace scan (path === null) feeds the symbol-search modal;
  // a file-scoped scan feeds the per-file symbol panel (#6472). Route accordingly
  // so the two symbol surfaces never clobber each other's table. Clear BOTH loading
  // flags in either branch so a mis-routed request (e.g. a path-less requestSymbols)
  // can never leave the other surface's loading flag stuck on.
  if (parsed.data.path === null) {
    set({ workspaceSymbols: parsed.data, workspaceSymbolsLoading: false, symbolsLoading: false });
  } else {
    set({ symbols: parsed.data, symbolsLoading: false, workspaceSymbolsLoading: false });
  }
}

/**
 * Go-to-definition (#6475, epic #6469) — `symbol_location`: store the resolve
 * result (with a fresh nonce so a repeat resolve of the same symbol re-fires the
 * jump effect). FileBrowserPanel reacts to `symbolLocation`: on a hit it opens
 * the target file at the line; on a miss it shows a transient 'not found' pill.
 * The wire shape is Zod-validated (drop malformed payloads rather than crash).
 * Dashboard-only for v1 (the mobile app has no symbol surface yet).
 */
function handleSymbolLocation(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSymbolLocationSchema.safeParse(msg);
  if (!parsed.success) return;
  // Store only the fields the state shape declares — drop the wire `type` so
  // ConnectionState.symbolLocation can't drift or grow an accidental dependency.
  const { symbol, file, line, error } = parsed.data;
  const prev = get().symbolLocation;
  set({ symbolLocation: { symbol, file, line, error, nonce: (prev?.nonce ?? 0) + 1 } });
}

/**
 * Find-in-project (#6474, epic #6469) — `code_search_results`: REPLACE the stored
 * result set with the carried one and clear the in-flight loading flag. Each
 * reply is a full picture (no delta). Zod-validated so a malformed payload is
 * dropped rather than crashing the Cmd+Shift+F palette. Dashboard-only for v1.
 */
function handleSearchResults(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSearchResultsSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ codeSearchResults: parsed.data, codeSearchLoading: false });
}

/**
 * Find-all-references (#6477, epic #6469) — `references_result`: REPLACE the
 * stored result set with the carried one and clear the loading flag. Same
 * defensive Zod-validated pattern as code_search_results; drives the references
 * palette (opened by alt/ctrl+click). Dashboard-only for v1.
 */
function handleReferencesResult(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerReferencesResultSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ referencesResult: parsed.data, referencesLoading: false });
}

/**
 * Mailbox (#5914 follow-up) — Control Room "Mailbox" tab `mailbox_status_snapshot`:
 * REPLACE the stored snapshot with the carried one and clear the in-flight
 * loading flag. Same defensive pattern as the host/runner snapshots — the wire
 * shape is Zod-validated so a malformed payload is dropped rather than crashing
 * the panel, and `mailboxStatusLoading` is cleared only on a successful parse so
 * a buggy server doesn't make Refresh silently lie.
 */
function handleMailboxStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerMailboxStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ mailboxStatus: parsed.data, mailboxStatusLoading: false });
}

/**
 * #5969 (epic #5422 phase 4) — mission-control external sessions
 * `external_sessions_snapshot`: REPLACE the stored snapshot with the carried
 * read-only external sessions and clear the in-flight loading flag. Same
 * defensive pattern as the mailbox/host snapshots — Zod-validated, so a
 * malformed payload is dropped rather than crashing the view, and the loading
 * flag clears only on a successful parse.
 */
function handleExternalSessionsSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerExternalSessionsSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ externalSessionsSnapshot: parsed.data, externalSessionsLoading: false });
}

/**
 * #5966 (epic #5422 phase 5) — Control Room repo-events pane
 * `repo_events_snapshot`: REPLACE the stored snapshot with the carried
 * GitHub-webhook events and clear the in-flight loading flag. Same defensive
 * pattern as the mailbox / external-session snapshots — Zod-validated, so a
 * malformed payload is dropped rather than crashing the pane, and the loading
 * flag clears only on a successful parse.
 */
function handleRepoEventsSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerRepoEventsSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ repoEventsSnapshot: parsed.data, repoEventsLoading: false });
}

/**
 * #6536 (PR-2 of #5966) — live repo-events delta `repo_events_delta`: APPEND the
 * single carried event to the stored snapshot so the pane updates without a
 * Refresh. Same defensive Zod-validate-or-drop pattern as the snapshot. A delta
 * that arrives before the first survey (no snapshot yet) is IGNORED — the
 * survey on tab-open fetches the full store tail (which already includes this
 * event, pushed server-side before the broadcast), so nothing is lost. The
 * appended list is bounded to the store cap (200, mirrors REPO_EVENT_STORE_CAP)
 * and stays most-recent-last, matching the survey's ordering. The snapshot's
 * `generatedAt` is advanced to the delta's time so RepoEventsSection's eyebrow
 * date + "generated Nm ago" freshness line stay honest as events stream in
 * (otherwise a live-updating pane would read stale).
 */
function handleRepoEventsDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerRepoEventsDeltaSchema.safeParse(msg);
  if (!parsed.success) return;
  const current = get().repoEventsSnapshot;
  if (!current) return; // no survey yet — tab-open survey fetches the full tail
  const events = [...current.events, parsed.data.event].slice(-200);
  set({ repoEventsSnapshot: { ...current, events, generatedAt: parsed.data.generatedAt } });
}

/**
 * #6691 (S-3) — `orchestration_runs_snapshot`: the Runs-tab list survey.
 * REPLACES the held snapshot wholesale (survey posture; delta.run upserts rows
 * between surveys). The degraded `runs: [] + error` shape is schema-valid and
 * stored as-is (the section renders the error). Malformed → drop WITHOUT
 * clearing loading (matches the survey-family convention).
 */
function handleOrchestrationRunsSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerOrchestrationRunsSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ orchestrationRuns: parsed.data, orchestrationRunsLoading: false });
}

/**
 * #6691 (S-3) — `orchestration_run_snapshot`: one run's full detail (pull-only —
 * issued on selection or as the seq-gap resync). `run: null` is the degraded
 * not-found/unavailable reply: store the error per-run and clear loading.
 */
function handleOrchestrationRunSnapshot(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerOrchestrationRunSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  const { run, seq, error } = parsed.data;
  if (run) {
    const details = { ...get().orchestrationRunDetails, [run.runId]: { detail: run, seq } };
    const loading = new Set(get().orchestrationRunDetailLoading);
    loading.delete(run.runId);
    const stale = { ...get().orchestrationRunDetailStale };
    delete stale[run.runId];
    const errors = { ...get().orchestrationRunDetailErrors };
    delete errors[run.runId];
    set({ orchestrationRunDetails: details, orchestrationRunDetailLoading: loading, orchestrationRunDetailStale: stale, orchestrationRunDetailErrors: errors });
    return;
  }
  // degraded: no run — we can't know which runId without echo, so clear ALL
  // in-flight detail loading and record the error under the requestId when
  // present (the panel keys its error banner off the selected run's absence).
  const loading = new Set<string>();
  const errors = { ...get().orchestrationRunDetailErrors };
  if (typeof parsed.data.requestId === 'string' && error) errors[parsed.data.requestId] = error;
  set({ orchestrationRunDetailLoading: loading, ...(error ? { orchestrationRunDetailErrors: errors } : {}) });
}

/**
 * #6691 (S-3) — `orchestration_run_delta`: live run update pushed to host-level
 * clients. Two independent applications:
 *  - list row: `delta.run` (a RunSummary) upserts into the held runs snapshot
 *    via the store-core reducer; a delta before the first survey with pending
 *    user gates triggers one list fetch (so the gate badge can appear).
 *  - held detail: applied via applyRunDelta under the strict seq===held+1
 *    contract; a gap marks the run stale and issues ONE resync re-request.
 */
function handleOrchestrationRunDelta(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerOrchestrationRunDeltaSchema.safeParse(msg);
  if (!parsed.success) return;
  const delta = parsed.data;

  // list row upsert (or a one-shot list fetch when nothing is held yet)
  const list = get().orchestrationRuns;
  if (list && delta.run) {
    set({ orchestrationRuns: { ...list, runs: upsertRunSummary(list.runs, delta.run), generatedAt: delta.generatedAt } });
  } else if (!list && delta.run && delta.run.pendingUserGates > 0 && !get().orchestrationRunsLoading) {
    // no survey yet but a gate needs the user — fetch the list so the badge shows
    get().requestOrchestrationRuns();
  }

  // held-detail application via the shared reducer
  const held = get().orchestrationRunDetails[delta.runId] ?? null;
  if (!held) return;
  const { held: next, resync } = applyRunDelta(held, delta);
  if (resync) {
    // seq gap: mark stale; issue exactly one re-request (the request action
    // no-ops into `false` when the socket is closed, and the loading Set guards
    // duplicate resyncs while one is already in flight)
    const stale = { ...get().orchestrationRunDetailStale, [delta.runId]: true };
    set({ orchestrationRunDetailStale: stale });
    if (!get().orchestrationRunDetailLoading.has(delta.runId)) {
      get().requestOrchestrationRunDetail(delta.runId);
    }
    return;
  }
  if (next && next !== held) {
    set({ orchestrationRunDetails: { ...get().orchestrationRunDetails, [delta.runId]: next } });
  }
}

/**
 * #6691 (S-3) — `orchestration_action_ack`: terminal success echo for a mutating
 * orchestration action (start/gate_response/cancel/pause/resume/annotate).
 * Clears the pending entry and records the result keyed by requestId. The
 * failure path arrives as `session_error{ORCHESTRATION_ACTION_FAILED}` instead.
 */
function handleOrchestrationActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerOrchestrationActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  const requestId = parsed.data.requestId ?? null;
  if (!requestId) return;
  const pending = { ...get().orchestrationPendingActions };
  delete pending[requestId];
  const results = { ...get().orchestrationActionResults, [requestId]: { ok: true, error: null, at: Date.now() } };
  set({ orchestrationPendingActions: pending, orchestrationActionResults: results });
}

/**
 * #6543 (IDE P3 feature B) — `permission_input`: store the pulled full (secret-
 * redacted) tool input keyed by requestId so the permission prompt can build a
 * per-hunk pre-write diff. Zod-validated (drop-on-malformed). Both `found:true`
 * (carries `input`/`tool`) and `found:false` (carries `error`) are stored — the
 * UI distinguishes "not fetched" (absent) from "unavailable" (found:false).
 */
function handlePermissionInput(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerPermissionInputSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ permissionInputs: { ...get().permissionInputs, [parsed.data.requestId]: parsed.data } });
}

/**
 * #5553 — per-repo session-preset snapshot. The reply to session_preset_get /
 * _set / _approve / _revoke. Store the resolved preset keyed by cwd so the
 * create-session modal can disclose "repo preset applies" and the per-repo
 * drawer can render/edit it. Validated with the protocol Zod schema; a
 * malformed payload is dropped rather than crashing the renderer. A null preset
 * (no preset for the repo) is stored explicitly so the modal can distinguish
 * "no preset" from "not yet fetched".
 */
function handleSessionPresetSnapshot(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSessionPresetSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  const { cwd, preset } = parsed.data;
  if (!cwd) return;
  const next = { ...get().sessionPresetSnapshots, [cwd]: preset };
  set({ sessionPresetSnapshots: next });
}

/**
 * #5510 (epic #5509) — a new device requested pairing; the daemon fanned the
 * request out to this host surface. Append it to `pendingPairRequests` (deduped
 * by requestId so a replay/reconnect can't double-stack the banner). Validated
 * with the protocol Zod schema; a malformed payload is dropped rather than
 * crashing the renderer. `deviceName` is attacker-controlled — stored as-is and
 * rendered as plain text (React escapes on render).
 */
function handlePairPending(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerPairPendingSchema.safeParse(msg);
  if (!parsed.success) return;
  const existing = get().pendingPairRequests;
  const next = existing.filter((p) => p.requestId !== parsed.data.requestId);
  next.push(parsed.data);
  set({ pendingPairRequests: next });
}

/**
 * #5510 — a pending pair request was resolved (approved/denied elsewhere, or it
 * expired). Drop it from the banner queue. The carried `reason` is informational
 * only; the surface simply retracts the entry.
 */
function handlePairResolved(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerPairResolvedSchema.safeParse(msg);
  if (!parsed.success) return;
  const next = get().pendingPairRequests.filter((p) => p.requestId !== parsed.data.requestId);
  set({ pendingPairRequests: next });
}

/**
 * #5253 — self-hosted runner survey `runner_status_snapshot`: REPLACE the
 * stored runner survey and clear the loading flag. Same defensive,
 * full-replace, clear-loading-only-on-valid-parse contract as the host survey
 * handler above.
 */
function handleRunnerStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerRunnerStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ runnerStatus: parsed.data, runnerStatusLoading: false });
}

/**
 * #6133 (epic #5530) — containers & environments survey
 * `containers_status_snapshot`: REPLACE the stored survey and clear the loading
 * flag. Same defensive, full-replace, clear-loading-only-on-valid-parse contract
 * as the host/runner survey handlers above.
 */
function handleContainersStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerContainersStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ containersStatus: parsed.data, containersStatusLoading: false });
}

/**
 * #6139 (epic #5530) — per-repo runtime config survey
 * `repo_runtime_config_snapshot`: REPLACE the stored survey and clear the
 * loading flag. Same defensive, full-replace, clear-loading-only-on-valid-parse
 * contract as the host/runner/containers survey handlers above.
 */
function handleRepoRuntimeConfigSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerRepoRuntimeConfigSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ repoRuntimeConfig: parsed.data, repoRuntimeConfigLoading: false });
}

/**
 * #6135 (epic #5530) — BYOK pool survey `byok_pool_status_snapshot`: REPLACE the
 * stored snapshot and clear the loading flag. Same defensive, full-replace,
 * clear-loading-only-on-valid-parse contract as the sibling survey handlers.
 */
function handleByokPoolStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerByokPoolStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ byokPoolStatus: parsed.data, byokPoolStatusLoading: false });
}

/**
 * #6140 (epic #5530) — host prune survey `host_prune_status_snapshot`: REPLACE
 * the stored snapshot and clear the loading flag. Same defensive, full-replace,
 * clear-loading-only-on-valid-parse contract as the sibling survey handlers.
 */
function handleHostPruneStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerHostPruneStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ hostPruneStatus: parsed.data, hostPruneStatusLoading: false });
}

/**
 * #6136 (epic #5530) — iOS simulator survey `simulator_status_snapshot`: REPLACE
 * the stored snapshot and clear the loading flag. Same defensive, full-replace,
 * clear-loading-only-on-valid-parse contract as the sibling survey handlers.
 * `available:false` (off macOS / no xcrun) is a valid snapshot, not an error.
 */
function handleSimulatorStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSimulatorStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ simulatorStatus: parsed.data, simulatorStatusLoading: false });
}

/**
 * #6137 (epic #5530) — Android emulator survey `emulator_status_snapshot`:
 * REPLACE the stored snapshot and clear the loading flag. Same defensive,
 * full-replace, clear-loading-only-on-valid-parse contract as the iOS sibling.
 * `available:false` (no Android SDK) is a valid snapshot, not an error.
 */
function handleEmulatorStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerEmulatorStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ emulatorStatus: parsed.data, emulatorStatusLoading: false });
}

/**
 * #6138 (epic #5530) — WSL2 distro survey `wsl_status_snapshot`: REPLACE the
 * stored snapshot and clear the loading flag. Same defensive, full-replace,
 * clear-loading-only-on-valid-parse contract as the iOS/Android siblings.
 * `available:false` (off Windows / no wsl.exe) is a valid snapshot, not an error.
 */
function handleWslStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerWslStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ wslStatus: parsed.data, wslStatusLoading: false });
}

/**
 * #5499 (epic #5498) — Integrations survey `integration_status_snapshot`:
 * REPLACE the stored survey and clear the loading flag. Same defensive,
 * full-replace, clear-loading-only-on-valid-parse contract as the host and
 * runner survey handlers above.
 */
function handleIntegrationStatusSnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerIntegrationStatusSnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ integrationStatus: parsed.data, integrationStatusLoading: false });
}

/**
 * #5554 (epic #5159) — Skills inventory survey `skills_inventory_snapshot`:
 * REPLACE the stored inventory and clear the loading flag. Same defensive,
 * full-replace, clear-loading-only-on-valid-parse contract as the host /
 * runner / integration survey handlers above.
 */
function handleSkillsInventorySnapshot(msg: Record<string, unknown>, _get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSkillsInventorySnapshotSchema.safeParse(msg);
  if (!parsed.success) return;
  set({ skillsInventory: parsed.data, skillsInventoryLoading: false });
}

/**
 * #5500 — resolve one repo's pending Reindex state: drop the repoPath from
 * `reindexingRepoPaths` and record the outcome (ack counts or failure
 * message) in `reindexResults` for inline display. Shared by the success ack
 * and the INTEGRATION_ACTION_FAILED session_error — the same
 * clear-pending-on-either-outcome contract as the cancel_activity pair.
 */
function resolveReindex(
  get: MsgGet,
  set: MsgSet,
  repoPath: string,
  result: { counts: import('@chroxy/protocol').IntegrationActionCounts | null; error: string | null },
): void {
  const pending = new Set(get().reindexingRepoPaths);
  pending.delete(repoPath);
  set({
    reindexingRepoPaths: pending,
    reindexResults: { ...get().reindexResults, [repoPath]: { ...result, at: Date.now() } },
  });
}

/**
 * #5502 — same contract for the relay Re-run action, against its own bucket
 * (`relayRerunningRepoPaths` / `relayRerunResults`): a rerun outcome must
 * never clear, or be cleared by, a reindex on the same repoPath.
 */
function resolveRelayRerun(
  get: MsgGet,
  set: MsgSet,
  repoPath: string,
  result: { error: string | null },
): void {
  const pending = new Set(get().relayRerunningRepoPaths);
  pending.delete(repoPath);
  set({
    relayRerunningRepoPaths: pending,
    relayRerunResults: { ...get().relayRerunResults, [repoPath]: { ...result, at: Date.now() } },
  });
}

/**
 * #5500 — Reindex success ack: positive confirmation that the
 * `integration_action` repo_memory_reindex run completed, echoing the
 * request's repoPath (+ requestId) with the parsed index counts (`null` when
 * the server couldn't parse the CLI report — the row then shows a neutral
 * "reindexed" note and the next Refresh shows the cache truth). A malformed
 * ack is dropped (Zod safeParse) so the row keeps its honest pending state
 * rather than rendering a half-true breakdown.
 */
function handleIntegrationActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerIntegrationActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  // #5502: route by the echoed action — a relay re-run ack resolves the
  // rerun bucket, a reindex ack the reindex bucket. An unknown future
  // action's ack stays opaque (the protocol's forward-compat contract):
  // this client can't have pending state for an action it can't send, so
  // clearing either bucket would clobber the wrong row.
  if (parsed.data.action === 'repo_relay_rerun') {
    resolveRelayRerun(get, set, parsed.data.repoPath, { error: null });
    return;
  }
  if (parsed.data.action !== 'repo_memory_reindex') return;
  resolveReindex(get, set, parsed.data.repoPath, { counts: parsed.data.counts, error: null });
}

/**
 * #6134 (epic #5530) — resolve one environment's pending container action:
 * drop the environmentId from `containerActioningIds` and record the outcome
 * (resulting status, or a failure message) in `containerActionResults` for
 * inline display. Shared by the success ack and the CONTAINER_ACTION_FAILED
 * session_error — the same clear-pending-on-either-outcome contract as the
 * reindex / relay-rerun pairs.
 */
function resolveContainerAction(
  get: MsgGet,
  set: MsgSet,
  environmentId: string,
  result: { action: string; status: string | null; error: string | null },
): void {
  const pending = new Set(get().containerActioningIds);
  pending.delete(environmentId);
  set({
    containerActioningIds: pending,
    containerActionResults: { ...get().containerActionResults, [environmentId]: { ...result, at: Date.now() } },
  });
}

/**
 * #6134 — container lifecycle action success ack: positive confirmation that
 * the `containers_action` stop / restart / destroy completed, echoing the
 * request's environmentId (+ action + resulting status). A malformed ack is
 * dropped (Zod safeParse) so the row keeps its honest pending state rather
 * than clearing on a half-true message.
 */
function handleContainersActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerContainersActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  resolveContainerAction(get, set, parsed.data.environmentId, {
    action: parsed.data.action,
    status: parsed.data.status ?? null,
    error: null,
  });
}

/**
 * #6135 slice 3 (epic #5530) — derive the pending/result TARGET id for a BYOK
 * pool action from its echoed `action` (+ `key` for recycle). Must match the id
 * `sendByokPoolAction` registers: 'drain' / 'recycle:<key>' / 'resize'. A
 * recycle with no key can't have a live pending entry, so it maps to the bare
 * action (a harmless no-op delete).
 */
function byokPoolActionTargetId(action: string, key: string | null | undefined): string {
  return action === 'recycle' && typeof key === 'string' && key.length > 0 ? `recycle:${key}` : action;
}

/**
 * #6135 slice 3 — resolve one BYOK pool action target's pending state: drop the
 * target id from `byokPoolActioningIds` and record the outcome (a human `note`,
 * or a failure message) in `byokPoolActionResults` for inline display. Shared by
 * the success ack and the BYOK_POOL_ACTION_FAILED session_error — the same
 * clear-pending-on-either-outcome contract as the container/reindex pairs.
 */
function resolveByokPoolAction(
  get: MsgGet,
  set: MsgSet,
  targetId: string,
  result: { action: string; note: string | null; error: string | null },
): void {
  const pending = new Set(get().byokPoolActioningIds);
  pending.delete(targetId);
  set({
    byokPoolActioningIds: pending,
    byokPoolActionResults: { ...get().byokPoolActionResults, [targetId]: { ...result, at: Date.now() } },
  });
}

/**
 * #6135 slice 3 — BYOK pool action success ack: positive confirmation that the
 * `byok_pool_action` drain / recycle / resize completed. Builds a human note
 * from the echoed result (drained/evicted counts, new limits) and clears the
 * matching target's pending state. A malformed ack is dropped (Zod safeParse) so
 * the row keeps its honest pending state rather than clearing on a half-true
 * message.
 */
function handleByokPoolActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerByokPoolActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  const { action, key, drained, evicted, limits } = parsed.data;
  let note: string;
  if (action === 'resize') {
    const caps = limits ? ` (caps now ${limits.maxPerKey}/key, ${limits.maxTotal} total)` : '';
    note = `Resized — evicted ${evicted ?? 0}${caps}`;
  } else {
    note = `${action === 'recycle' ? 'Recycled' : 'Drained'} — evicted ${drained ?? 0}`;
  }
  resolveByokPoolAction(get, set, byokPoolActionTargetId(action, key), { action, note, error: null });
}

/**
 * #6140 slice 2 (epic #5530) — resolve one host prune `kind`'s pending state:
 * drop it from `hostPruneActioningIds` and record the outcome in
 * `hostPruneActionResults`. Shared by the ack and the HOST_PRUNE_ACTION_FAILED
 * session_error.
 */
function resolveHostPruneAction(
  get: MsgGet,
  set: MsgSet,
  kind: string,
  result: { note: string | null; error: string | null },
): void {
  const pending = new Set(get().hostPruneActioningIds);
  pending.delete(kind);
  set({
    hostPruneActioningIds: pending,
    hostPruneActionResults: { ...get().hostPruneActionResults, [kind]: { kind, ...result, at: Date.now() } },
  });
}

/**
 * #6140 slice 2 — compact auto-unit byte format for the prune note, so it reads
 * consistently with the section's chips/tables (which use the same KiB/MiB/GiB
 * scaling) rather than always-MiB.
 */
function formatReclaimedBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

/**
 * #6140 slice 2 — host prune success ack: builds a human note from removed counts
 * + reclaimed bytes (+ any per-resource failures) and clears the kind's pending
 * state. A malformed ack is dropped (Zod safeParse) so the row keeps its honest
 * pending state.
 */
function handleHostPruneActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerHostPruneActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  const { kind, removedContainers, removedImages, reclaimedBytes, failures } = parsed.data;
  let note = `Removed ${removedContainers} container${removedContainers === 1 ? '' : 's'}, ${removedImages} image${removedImages === 1 ? '' : 's'} (~${formatReclaimedBytes(reclaimedBytes)})`;
  if (failures.length > 0) note += ` — ${failures.length} failed`;
  resolveHostPruneAction(get, set, kind, { note, error: null });
}

/**
 * #6136 slice 3 (epic #5530) — resolve one simulator action target's pending
 * state: drop the `udid` from `simulatorActioningIds` and record the outcome in
 * `simulatorActionResults`. Shared by the success ack and the
 * SIMULATOR_ACTION_FAILED session_error.
 */
function resolveSimulatorAction(
  get: MsgGet,
  set: MsgSet,
  udid: string,
  result: { action: string; note: string | null; error: string | null },
): void {
  const pending = new Set(get().simulatorActioningIds);
  pending.delete(udid);
  set({
    simulatorActioningIds: pending,
    simulatorActionResults: { ...get().simulatorActionResults, [udid]: { ...result, at: Date.now() } },
  });
}

/**
 * #6136 slice 3 — simulator action success ack: builds a human note from the
 * echoed new state and clears the udid's pending state. A malformed ack is
 * dropped (Zod safeParse) so the row keeps its honest pending state.
 */
function handleSimulatorActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerSimulatorActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  const { action, udid, status } = parsed.data;
  // Append the echoed status only when it adds information — the happy path
  // (boot → "Booted", shutdown → "Shutdown") is implied by the action, so a
  // bare "Booted (Booted)" would be noise.
  const implied = action === 'boot' ? 'Booted' : 'Shutdown';
  const base = action === 'boot' ? 'Booted' : 'Shut down';
  const note = status && status !== implied ? `${base} (${status})` : base;
  resolveSimulatorAction(get, set, udid, { action, note, error: null });
}

/**
 * #6137 (epic #5530) — resolve one emulator action target's pending state: drop
 * the target (avd or serial) from `emulatorActioningIds` and record the outcome
 * in `emulatorActionResults`. Shared by the ack and the EMULATOR_ACTION_FAILED
 * session_error.
 */
function resolveEmulatorAction(
  get: MsgGet,
  set: MsgSet,
  targetId: string,
  result: { action: string; note: string | null; error: string | null },
): void {
  const pending = new Set(get().emulatorActioningIds);
  pending.delete(targetId);
  set({
    emulatorActioningIds: pending,
    emulatorActionResults: { ...get().emulatorActionResults, [targetId]: { ...result, at: Date.now() } },
  });
}

/**
 * #6137 — emulator action success ack: builds a human note ("Starting…" after a
 * boot, "Killed" after a kill) and clears the target's pending state. The target
 * id is the echoed avd (boot) or serial (kill). A malformed ack is dropped (Zod)
 * so the row keeps its honest pending state.
 */
function handleEmulatorActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerEmulatorActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  const { action, avd, serial, status } = parsed.data;
  const targetId = action === 'boot' ? avd : serial;
  if (!targetId) return;
  const note = action === 'boot' ? `Starting${status ? `… (${status})` : '…'}` : `Killed${status ? ` (${status})` : ''}`;
  resolveEmulatorAction(get, set, targetId, { action, note, error: null });
}

/**
 * #6138 (epic #5530) — resolve one WSL distro action target's pending state: drop
 * the distro name from `wslActioningIds` and record the outcome in
 * `wslActionResults`. Shared by the ack and the WSL_ACTION_FAILED session_error.
 */
function resolveWslAction(
  get: MsgGet,
  set: MsgSet,
  distro: string,
  result: { action: string; note: string | null; error: string | null },
): void {
  const pending = new Set(get().wslActioningIds);
  pending.delete(distro);
  set({
    wslActioningIds: pending,
    wslActionResults: { ...get().wslActionResults, [distro]: { ...result, at: Date.now() } },
  });
}

/**
 * #6138 — WSL action success ack: builds a human note ("Started" after a start,
 * "Terminated" after a terminate) and clears the distro's pending state. The
 * target id is the echoed distro name. A malformed ack is dropped (Zod) so the
 * row keeps its honest pending state.
 */
function handleWslActionAck(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerWslActionAckSchema.safeParse(msg);
  if (!parsed.success) return;
  const { action, distro, status } = parsed.data;
  if (!distro) return;
  // Append the echoed status only when it adds information — the happy path
  // (start → "running", terminate → "stopped") is implied by the action.
  const implied = action === 'start' ? 'running' : 'stopped';
  const base = action === 'start' ? 'Started' : 'Terminated';
  const note = status && status !== implied ? `${base} (${status})` : base;
  resolveWslAction(get, set, distro, { action, note, error: null });
}

/**
 * #5547: a `summarize_session_result` resolves the pending summarize promise
 * (keyed by the echoed requestId) so the awaiting create-session flow opens
 * with the brief seeded. The failure half (SUMMARIZE_FAILED) rejects the same
 * promise from the session_error branch below.
 */
function handleSummarizeSessionResult(msg: Record<string, unknown>): void {
  const parsed = ServerSummarizeSessionResultSchema.safeParse(msg);
  if (!parsed.success) return;
  const requestId = parsed.data.requestId;
  if (typeof requestId !== 'string' || !requestId) return;
  resolveSummarizeRequest(requestId, {
    summary: parsed.data.summary,
    truncated: Boolean(parsed.data.truncated),
  });
}

/**
 * #5821 — `billing_canary` broadcast. Validated via the shared schema (drop on
 * mismatch). Stores the snapshot; resets the per-connection dismissal ONLY when
 * the warning set changed (a new/cleared warning re-surfaces the banner) so an
 * unchanged re-broadcast doesn't un-dismiss what the user already dismissed.
 */
function handleBillingCanary(msg: Record<string, unknown>, get: MsgGet, set: MsgSet, _ctx: ConnectionContext): void {
  const parsed = ServerBillingCanarySchema.safeParse(msg);
  if (!parsed.success) return;
  const { eraStarted, defaultProvider, defaultBillingClass, warnings } = parsed.data;
  const snapshot = { eraStarted, defaultProvider, defaultBillingClass, warnings };
  const prev = get().billingCanary;
  // Signature over the FULL warning content (not just `code`): a reclassification
  // trip can emit multiple warnings sharing TUI_REPORTED_PROGRAMMATIC_COST but
  // differing in session/cost, and a code-only signature would mask that change
  // and leave a dismissed banner stale (#5829 / review). Serialize each warning's
  // identifying fields, order-independent.
  const sig = (s: typeof snapshot | null) =>
    s
      ? s.warnings
          .map((w) => `${w.code} ${w.sessionId ?? ''} ${w.costUsd ?? ''} ${w.message}`)
          .sort()
          .join('')
      : '';
  const changed = sig(prev) !== sig(snapshot);
  set(changed ? { billingCanary: snapshot, billingBannerDismissed: false } : { billingCanary: snapshot });
}

/**
 * Map of message type → handler function for the simplest, most self-contained
 * cases. handleMessage() dispatches to this map first; unmatched types fall
 * through to the legacy switch statement below.
 */
const HANDLERS: Record<string, Handler> = {
  billing_canary: handleBillingCanary,
  pong: handlePong,
  // raw / raw_background / terminal_output — migrated to the shared dispatch
  // table (#6449 slice 1; runDispatch handles them before this HANDLERS map).
  terminal_size: handleTerminalSize,
  token_rotated: handleTokenRotated,
  pairing_refreshed: handlePairingRefreshed,
  // checkpoint_restored — migrated to the shared dispatch table (#5618; runDispatch).
  // web_feature_status / web_task_list migrated to the shared dispatch table
  // (#5556 slice 2)
  // conversations_list — migrated to the shared dispatch table (#5618; runDispatch).
  thinking_level_changed: handleThinkingLevelChanged,
  prompt_evaluator_changed: handlePromptEvaluatorChanged,
  chroxy_context_hint_changed: handleChroxyContextHintChanged,
  session_preamble_changed: handleSessionPreambleChanged,
  // #3188: auto-evaluator broadcast events (#3186 emit, #3208 schema)
  evaluator_rewrite: handleEvaluatorRewrite,
  evaluator_clarify: handleEvaluatorClarify,
  skills_list: handleSkillsList,
  skill_changed: handleSkillChanged,
  skill_activated: handleSkillActivated,
  skill_trust_accepted: handleSkillTrustAccepted,
  skill_deactivated: handleSkillDeactivated,
  skill_trust_request: handleSkillTrustRequest,
  skill_trust_granted: handleSkillTrustGranted,
  skill_trust_grant_ok: handleSkillTrustGrantOk,
  // permission_mode_changed — migrated to the shared dispatch table (#5618; runDispatch).
  // available_permission_modes / session_updated / agent_busy migrated to the
  // shared store-core dispatch table (#5556)
  session_switched: handleSessionSwitched,
  claude_ready: handleClaudeReady,
  // agent_idle — migrated to the shared dispatch table (#5618; runDispatch).
  stream_start: handleStreamStart,
  stream_delta: handleStreamDelta,
  stream_end: handleStreamEnd,
  tool_start: handleToolStart,
  tool_input_delta: handleToolInputDelta,
  tool_result: handleToolResult,
  permission_request: handlePermissionRequest,
  permission_resolved: handlePermissionResolved,
  // budget_warning — migrated to the shared dispatch table (#5618; runDispatch).
  budget_exceeded: handleBudgetExceeded,
  // budget_resumed migrated to the shared store-core dispatch table (#5556)
  server_error: handleServerError,
  // server_shutdown — migrated to the shared dispatch table (#5618; runDispatch).
  // #5163 (epic #5159): Control Room live activity tree.
  activity_snapshot: handleActivitySnapshot,
  activity_delta: handleActivityDelta,
  // #5277: positive ack correlating a cancel_activity request to its outcome.
  cancel_activity_ack: handleCancelActivityAck,
  // #5510 (epic #5509): pairing-approval primitive — host-surface fan-out.
  pair_pending: handlePairPending,
  pair_resolved: handlePairResolved,
  // #6471 (epic #6469): opt-in IDE workspace symbol table snapshot.
  symbols_snapshot: handleSymbolsSnapshot,
  // #6475 (epic #6469): opt-in IDE go-to-definition result.
  symbol_location: handleSymbolLocation,
  // #6474 (epic #6469): opt-in IDE find-in-project results (distinct wire type
  // from the cross-session `search_results` handled by the shared dispatch table).
  code_search_results: handleSearchResults,
  // #6477 (epic #6469): opt-in IDE find-all-references result.
  references_result: handleReferencesResult,
  // #5175 (epic #5170): Host/Repo Status Control Room survey snapshot.
  host_status_snapshot: handleHostStatusSnapshot,
  // Mailbox (#5914 follow-up): Control Room "Mailbox" tab survey snapshot.
  mailbox_status_snapshot: handleMailboxStatusSnapshot,
  // #5969 (epic #5422 phase 4): mission-control external-session survey snapshot.
  external_sessions_snapshot: handleExternalSessionsSnapshot,
  // #5966 (epic #5422 phase 5): Control Room repo-events survey snapshot.
  repo_events_snapshot: handleRepoEventsSnapshot,
  // #6536 (PR-2 of #5966): live repo-events delta appended to the pane.
  repo_events_delta: handleRepoEventsDelta,
  // #6691 (S-3): orchestration Runs tab (dashboard-only v1) — list survey,
  // pull-only run detail, live run delta (store-core reducers), action ack.
  orchestration_runs_snapshot: handleOrchestrationRunsSnapshot,
  orchestration_run_snapshot: handleOrchestrationRunSnapshot,
  orchestration_run_delta: handleOrchestrationRunDelta,
  orchestration_action_ack: handleOrchestrationActionAck,
  // #6543 (IDE P3 feature B): pulled full redacted tool input for a pre-write diff.
  permission_input: handlePermissionInput,
  session_preset_snapshot: handleSessionPresetSnapshot,
  // #5253: self-hosted runner Control Room survey snapshot.
  runner_status_snapshot: handleRunnerStatusSnapshot,
  containers_status_snapshot: handleContainersStatusSnapshot,
  // #6139 (epic #5530): Control Room per-repo runtime config survey snapshot.
  repo_runtime_config_snapshot: handleRepoRuntimeConfigSnapshot,
  // #6135 (epic #5530): Control Room BYOK pool survey snapshot.
  byok_pool_status_snapshot: handleByokPoolStatusSnapshot,
  // #6140 (epic #5530): Control Room host prune survey snapshot.
  host_prune_status_snapshot: handleHostPruneStatusSnapshot,
  // #6136 (epic #5530): Control Room iOS simulator survey snapshot.
  simulator_status_snapshot: handleSimulatorStatusSnapshot,
  // #6137 (epic #5530): Control Room Android emulator survey snapshot.
  emulator_status_snapshot: handleEmulatorStatusSnapshot,
  // #6138 (epic #5530): Control Room WSL2 distro survey snapshot.
  wsl_status_snapshot: handleWslStatusSnapshot,
  // #5499 (epic #5498): Control Room Integrations survey snapshot.
  integration_status_snapshot: handleIntegrationStatusSnapshot,
  skills_inventory_snapshot: handleSkillsInventorySnapshot,
  // #5500: positive ack correlating an integration_action (repo-memory
  // Reindex) request to its outcome.
  integration_action_ack: handleIntegrationActionAck,
  // #6134 (epic #5530): positive ack correlating a containers_action (stop /
  // restart / destroy) request to its outcome.
  containers_action_ack: handleContainersActionAck,
  // #6135 (epic #5530): positive ack correlating a byok_pool_action (drain /
  // recycle / resize) request to its outcome.
  byok_pool_action_ack: handleByokPoolActionAck,
  // #6140 (epic #5530): positive ack correlating a host_prune_action to its outcome.
  host_prune_action_ack: handleHostPruneActionAck,
  // #6136 (epic #5530): positive ack correlating a simulator_action (boot /
  // shutdown) request to its outcome.
  simulator_action_ack: handleSimulatorActionAck,
  // #6137 (epic #5530): positive ack correlating an emulator_action (boot /
  // kill) request to its outcome.
  emulator_action_ack: handleEmulatorActionAck,
  // #6138 (epic #5530): positive ack correlating a wsl_action (start /
  // terminate) request to its outcome.
  wsl_action_ack: handleWslActionAck,
  // #5547: one-shot session-summary result; resolves the pending summarize
  // promise so the create-session flow can open with the brief seeded.
  summarize_session_result: handleSummarizeSessionResult,
};

// ---------------------------------------------------------------------------
// handleMessage — main message dispatch
// ---------------------------------------------------------------------------

/**
 * Handles a parsed WebSocket message. Extracted from the socket.onmessage
 * closure so it can be tested directly with raw JSON payloads.
 *
 * Reads/writes store via getStore().getState()/setState() and
 * module-level helpers (updateSession, updateActiveSession, nextMessageId, etc).
 * The few variables that were closured in connect() are accessed via _connectionContext.
 */
export function handleMessage(raw: unknown, ctxOverride?: ConnectionContext): void {
  const ctx = ctxOverride ?? _connectionContext;
  if (!ctx) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return;

  const get = () => getStore().getState();
  const set: (s: Partial<ConnectionState> | ((state: ConnectionState) => Partial<ConnectionState>)) => void =
    (s) => getStore().setState(s as ConnectionState);

  // #3758 — bump lastClientActivityAt for activity-bearing events BEFORE
  // any per-case handler runs. Doing it here keeps the bump in one place
  // instead of threading it through every stream_*/tool_*/message handler.
  // Mirrors the logic in packages/app/src/store/message-handler.ts.
  //
  // #3899 — any activity event also dismisses an outstanding inactivity
  // warning: by definition the silence has ended, so the chip should
  // disappear without waiting for the user to dismiss it manually.
  //
  // #4466 — gate on the replay set. switch_session on the server replays
  // every past event in the target session through this handler, and a
  // replayed tool_start / message / result is NOT fresh activity. Without
  // this gate the act of switching tabs:
  //   1) bumps lastClientActivityAt to Date.now(), so "Working… last
  //      activity Ns ago" resets to 1s no matter how idle the session was;
  //   2) wipes inactivityWarning, so the "Agent quiet for 46m 32s · Status
  //      update?" chip disappears without the user ever seeing it again.
  // The live activity events that arrive AFTER history_replay_end removes
  // the session from the set still bump correctly — verified by the
  // regression-guard tests in message-handler.test.ts.
  //
  // #4493 — gate per target session id (Set membership), not a module flag.
  // `replayHistory()` chunks over setImmediate, so live broadcasts from
  // session B can interleave with A's replay. A module-wide boolean would
  // wrongly suppress B's live activity bump for the duration of A's replay.
  if (isActivityEvent(msg.type)) {
    const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || get().activeSessionId;
    if (targetId && get().sessionStates[targetId] && !_replayingSessions.has(targetId)) {
      updateSession(targetId, (ss) => {
        const patch: Partial<SessionState> = { lastClientActivityAt: Date.now() };
        if (ss.inactivityWarning) patch.inactivityWarning = null;
        return patch;
      });
    }
  }

  // #5556 — shared dispatch table first. A hit handles the message and
  // returns; a miss falls through to the dashboard's own HANDLERS map +
  // switch below, keeping migration incremental.
  if (runDispatch(_dispatchTable, msg, _dispatchAdapter)) return;

  // Dispatch to the handler map next — extracted, self-contained cases.
  const handler = HANDLERS[msg.type];
  if (handler) {
    handler(msg, get, set, ctx);
    return;
  }

  switch (msg.type) {

    case 'auth_ok': {
      // Reset replay flags — fresh auth means clean slate (#4493: clear the
      // per-session replaying set so a reconnect doesn't leave stale ids
      // gating future activity bumps).
      _replayingSessions.clear();
      // #5555.4 — clear any in-progress replay BASELINE (a rebuild that never
      // saw its history_replay_end before the socket dropped). Cursors are
      // intentionally RETAINED so this reconnect's replay can be incremental.
      resetReplayReconcile();
      // #5555.5 — a successful auth is the ONLY proof the link is healthy, so
      // reset the close/error-path backoff ladder here (not on socket-open). A
      // socket that opens but never authenticates keeps climbing the ladder.
      resetReconnectAttempt();
      // #5721 (item 2) — auth_ok is the authoritative handshake-completion frame
      // (the issue calls it out by name); a discrete key_exchange round-trip, when
      // it happens, only ever FOLLOWS a successful auth_ok. Clear the handshake
      // timer here so the (healthy) encryption sub-handshake isn't counted against
      // the budget. Eager-encryption and no-encryption connects never send
      // key_exchange, so this is the single authoritative clear.
      clearHandshakeTimer();
      // Track this URL as successfully connected
      lastConnectedUrl = ctx.url;
      // #4766: full wire-shape decode lives in the shared parser
      // (handleAuthOk + parseConnectedClients). The dashboard assembles the
      // platform-specific `set()` patch from the parsed payload below.
      const auth = sharedAuthOk(msg);
      const clients = sharedParseConnectedClients(msg.connectedClients, auth.myClientId);

      // #5281 ③ PR 2 — a pairing handshake issues a session token in auth_ok;
      // adopt it as the effective token so reconnects authenticate normally.
      // For the normal token-auth path `auth.sessionToken` is null and this is
      // just `ctx.token`.
      const effectiveToken = auth.sessionToken ?? ctx.token;
      // Persist the issued session token onto the active registry entry (which
      // was added with an empty token by pairServer) so connectToServer/
      // switchServer reuse it later.
      const pairedServerId = get().activeServerId;
      if (auth.sessionToken && pairedServerId) {
        get().updateServer(pairedServerId, { token: auth.sessionToken });
      }

      // #5356: exposure snapshot (non-loopback bind / public quick tunnel).
      // Read off the raw message — the auth_ok schema is passthrough and the
      // shared parser predates the field. Absent/malformed → null (no banner).
      const rawExposure = (msg as { exposure?: { lanBind?: unknown; quickTunnel?: unknown } }).exposure;
      const serverExposure =
        rawExposure && typeof rawExposure === 'object'
          ? { lanBind: rawExposure.lanBind === true, quickTunnel: rawExposure.quickTunnel === true }
          : null;

      // #5821: billing-canary snapshot seed from auth_ok. Validated via the
      // shared schema so a malformed/absent field → null (no banner). Live
      // changes arrive via the `billing_canary` broadcast handled below.
      const rawBillingCanary = (msg as { billingCanary?: unknown }).billingCanary;
      const billingCanarySeed = rawBillingCanary
        ? (BillingCanarySnapshotSchema.safeParse(rawBillingCanary).success
            ? BillingCanarySnapshotSchema.parse(rawBillingCanary)
            : null)
        : null;

      // On reconnect, preserve messages and terminal buffer
      const connectedState = {
        connectionPhase: 'connected' as const,
        viewingCachedSession: false,
        wsUrl: ctx.url,
        apiToken: effectiveToken,
        socket: ctx.socket,
        claudeReady: false,
        serverMode: auth.serverMode,
        sessionCwd: auth.sessionCwd,
        defaultCwd: auth.defaultCwd,
        serverVersion: auth.serverVersion,
        latestVersion: auth.latestVersion,
        serverCommit: auth.serverCommit,
        serverProtocolVersion: auth.protocolVersion,
        serverResultTimeoutMs: auth.resultTimeoutMs,
        streamStallTimeoutMs: auth.streamStallTimeoutMs,
        streamingMessageId: null,
        myClientId: auth.myClientId,
        connectedClients: clients,
        connectionError: null as string | null,
        connectionRetryCount: 0,
        // Clear shutdown / startup state on successful connect
        serverPhase: null,
        tunnelProgress: null,
        serverExposure,
        billingCanary: billingCanarySeed,
        shutdownReason: null,
        restartEtaMs: null,
        restartingSince: null,
        webFeatures: auth.webFeatures,
        serverCapabilities: auth.serverCapabilities,
      };
      if (ctx.isReconnect) {
        set(connectedState);
      } else {
        set({
          ...connectedState,
          // #5356: a fresh (non-reconnect) connection re-surfaces the
          // exposure banner; silent reconnects keep the user's dismissal.
          exposureBannerDismissed: false,
          // #5821: same for the billing banner — fresh connect re-surfaces it.
          billingBannerDismissed: false,
          messages: [],
          terminalBuffer: '',
          terminalRawBuffer: '',
          sessions: [],
          activeSessionId: null,
          sessionStates: {},
          customAgents: [],
        });
      }
      // #5555 — fold the static permission-mode enum out of auth_ok when the
      // server provided it, so we don't have to wait for the discrete
      // `available_permission_modes` burst frame. Older servers omit the field
      // (null) and the discrete frame still lands; new servers send both and
      // this just wins the race harmlessly (idempotent set).
      if (auth.availablePermissionModes) {
        set({ availablePermissionModes: auth.availablePermissionModes });
      }

      // #5555 (auth_bootstrap) — when the server advertises the bootstrap
      // capability it pushes an `auth_bootstrap` burst frame carrying the
      // provider / slash-command / agent lists right after auth_ok. In that
      // case we SKIP the 3 connect-time list requests (they arrive unsolicited
      // in the burst). Older servers don't set the flag, so we request as
      // before. The list_* request paths stay live for post-connect refreshes.
      _serverWillBootstrap = auth.serverCapabilities.authBootstrap === true;
      const sendConnectListRequests = () => {
        if (_serverWillBootstrap) return;
        wsSend(ctx.socket, { type: 'list_providers' });
        wsSend(ctx.socket, { type: 'list_slash_commands' });
        wsSend(ctx.socket, { type: 'list_agents' });
      };

      // Start client-side heartbeat for dead connection detection
      startHeartbeat(ctx.socket);

      // #5614 — close the plaintext-auth_ok downgrade cell. If this connection is
      // PINNED, a non-`required` auth_ok is a downgrade attempt (a MITM forging a
      // plaintext auth_ok would otherwise skip the pin check that lives inside the
      // encryption branch below). Refuse BEFORE that branch — fail closed, same
      // terminal "identity refused" path as a signature mismatch. Unpinned
      // connections fall through and keep TOFU (encryption optional) as before.
      if (!enforceEncryptionGateOrRefuse(ctx, auth.encryption)) {
        _pendingKeyPair = null;
        _pendingSalt = null;
        break;
      }

      // Initiate key exchange if server requires encryption
      if (auth.encryption === 'required') {
        // #5555 (eager key exchange) — the ephemeral keypair + salt were
        // already generated and sent WITH the auth message (socket.onopen →
        // prepareEagerKeyExchange), stashed on _pendingKeyPair / _pendingSalt.
        // If the server honoured the eager path it returns its public key in
        // auth_ok; derive the shared key immediately and start the burst a full
        // RTT earlier than the discrete handshake.
        //
        // #5555 follow-up (hardening) — `auth.serverPublicKey` is shared-parser
        // normalized (empty/non-string → null) but a non-empty MALFORMED value
        // (bad base64 / wrong length) still passes that filter and makes
        // `deriveSharedKey` throw. The discrete `key_exchange_ok` handler
        // guards against a bad key; mirror that here by wrapping the eager
        // derivation in try/catch and FALLING BACK to the discrete handshake
        // on any failure instead of letting the throw tear down the connection.
        let eagerEstablished = false;
        if (auth.serverPublicKey && _pendingKeyPair) {
          // #5536 — verify the server's signed exchange key against the pinned
          // (or pairing-time) identity BEFORE deriving the shared key. On a
          // mismatch this closes the socket + surfaces the refusal; abort.
          if (!verifyServerIdentityOrRefuse(ctx, auth.serverPublicKey, auth.serverKeySig, auth.newIdentityKey, auth.rotationCert)) {
            _pendingKeyPair = null;
            _pendingSalt = null;
            break;
          }
          try {
            const rawSharedKey = deriveSharedKey(auth.serverPublicKey, _pendingKeyPair.secretKey);
            const encryptionKey = _pendingSalt
              ? deriveConnectionKey(rawSharedKey, _pendingSalt)
              : rawSharedKey;
            _encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 };
            _pendingKeyPair = null;
            _pendingSalt = null;
            eagerEstablished = true;
            console.log('[crypto] E2E encryption established (eager)');
            // Burst un-gated: server already activated encryption after auth_ok.
            sendConnectListRequests();
            resetClientVisibleMemo();
            if (typeof document !== 'undefined') {
              sendClientVisible(ctx.socket, document.visibilityState === 'visible');
            }
          } catch (err) {
            // Malformed eager key — discard any partial state and fall through
            // to the discrete handshake below (regenerating the keypair if the
            // eager attempt consumed it).
            console.warn('[crypto] Eager key derivation failed, falling back to discrete key_exchange', err);
            _encryptionState = null;
          }
        }
        if (!eagerEstablished) {
          // Fallback (old server / no eager key / eager derivation failed): the
          // keypair is still stashed from onopen — send the discrete
          // key_exchange. If onopen never ran (defensive) or the eager attempt
          // nulled it, regenerate so we never send an empty handshake.
          if (!_pendingKeyPair) {
            _pendingKeyPair = createKeyPair();
            _pendingSalt = generateConnectionSalt();
          }
          // Send key_exchange plaintext (before encryption is active)
          ctx.socket.send(JSON.stringify({ type: 'key_exchange', publicKey: _pendingKeyPair.publicKey, salt: _pendingSalt }));
          // Post-auth messages will be sent after key_exchange_ok arrives
        }
      } else {
        // No encryption — send post-auth messages immediately
        sendConnectListRequests();
        // #3671: server defaults visible=true on a fresh connect; sync if we
        // reconnected while the tab was hidden so completion pushes fire.
        resetClientVisibleMemo();
        if (typeof document !== 'undefined') {
          sendClientVisible(ctx.socket, document.visibilityState === 'visible');
        }
      }
      // Save for quick reconnect (the issued session token, when paired).
      saveConnection(ctx.url, effectiveToken);
      set({ savedConnection: { url: ctx.url, token: effectiveToken } });
      break;
    }

    case 'key_exchange_ok': {
      if (_pendingKeyPair) {
        const { publicKey: serverPublicKey, serverKeySig, newIdentityKey, rotationCert } = sharedKeyExchangeOk(msg);
        if (!serverPublicKey) {
          console.error('[crypto] Invalid publicKey in key_exchange_ok message', msg.publicKey);
          ctx.socket.close();
          set({ connectionPhase: 'disconnected', socket: null });
          _pendingKeyPair = null;
          _pendingSalt = null;
          break;
        }
        // #5536 — verify the server's signed exchange key against the pinned (or
        // pairing-time) identity BEFORE deriving the shared key. On a mismatch
        // this closes the socket + surfaces the refusal; abort the handshake.
        if (!verifyServerIdentityOrRefuse(ctx, serverPublicKey, serverKeySig, newIdentityKey, rotationCert)) {
          _pendingKeyPair = null;
          _pendingSalt = null;
          break;
        }
        const rawSharedKey = deriveSharedKey(serverPublicKey, _pendingKeyPair.secretKey);
        const encryptionKey = _pendingSalt
          ? deriveConnectionKey(rawSharedKey, _pendingSalt)
          : rawSharedKey;
        _encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 };
        _pendingKeyPair = null;
        _pendingSalt = null;
        // #5721 (item 2) — defensive: auth_ok already cleared the handshake timer
        // (it always precedes this discrete round-trip), but clear again here so a
        // future reordering that makes the encryption sub-handshake the real
        // completion point can't leave a timer to fire spuriously. Idempotent.
        clearHandshakeTimer();
        console.log('[crypto] E2E encryption established');
        // Now send the post-auth messages that were deferred. #5555: skip the
        // 3 list requests when the server advertised the auth_bootstrap
        // capability (the burst frame already carries that data, queued behind
        // encryption and decrypted once this handshake completes).
        if (!_serverWillBootstrap) {
          wsSend(ctx.socket, { type: 'list_providers' });
          wsSend(ctx.socket, { type: 'list_slash_commands' });
          wsSend(ctx.socket, { type: 'list_agents' });
        }
        // #3671: sync visibility once encryption is established (mirrors the
        // unencrypted auth_ok path above).
        resetClientVisibleMemo();
        if (typeof document !== 'undefined') {
          sendClientVisible(ctx.socket, document.visibilityState === 'visible');
        }
      }
      break;
    }

    case 'auth_fail': {
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      if (!ctx.silent) {
        const { reason } = sharedAuthFail(msg);
        _adapters.alert.alert('Auth Failed', reason);
      }
      break;
    }

    case 'pair_fail': {
      // #5281 ③ PR 2 — pairing rejected (invalid/expired/already-used id, rate
      // limited, pairing disabled). The pendingPairingId was already consumed on
      // send. pairServer optimistically added a still-tokenless registry entry;
      // pairing failed before a session token was issued, so drop the dead entry.
      ctx.socket.close();
      set({ connectionPhase: 'disconnected', socket: null });
      const { reason } = sharedPairFail(msg, 'unknown');
      const failedServerId = get().activeServerId;
      // Capture the failed host BEFORE removing the optimistic entry, so the
      // approval-gated path below can re-open the request-pair flow for it.
      const failedEntry = failedServerId
        ? get().serverRegistry.find((s) => s.id === failedServerId)
        : undefined;
      if (failedEntry && !failedEntry.token) get().removeServer(failedServerId!);

      // #5513 (epic #5509) — the redeemed ?pair= link was approval-gated (a
      // Discord-delivered link). Possession of the link is never sufficient: the
      // device must REQUEST pairing and the host must approve it. Transparently
      // fall into the request-pair UX (RequestPairPanel) for the same host
      // instead of dead-ending on an alert. Old/other surfaces that don't read
      // pendingApprovalPairHost still see the legible reason via the alert below.
      if (reason === 'requires_approval' && failedEntry?.wsUrl) {
        set({ pendingApprovalPairHost: { name: failedEntry.name, wsUrl: failedEntry.wsUrl } });
        break;
      }

      if (!ctx.silent) {
        // Reason parse shared via store-core (#5454). The dashboard keeps its
        // plain `Pairing failed: <reason>` copy — the friendly
        // PAIR_FAIL_MESSAGES strings are QR-flow wording ("Scan the latest QR
        // code…") that doesn't fit this paste-a-pairing-URL surface.
        _adapters.alert.alert('Pairing Failed', `Pairing failed: ${reason}`);
      }
      break;
    }

    case 'server_mode': {
      const { mode } = sharedServerMode(msg);
      if (mode) {
        set({ serverMode: mode });
      } else {
        _adapters.alert.alert('Invalid Server Mode', `Ignoring invalid server_mode value: ${msg.mode}`);
      }
      break;
    }

    // --- Multi-session messages ---

    case 'session_list': {
      // #4767: centralised dispatch — store-core precomputes GC + new-session
      // ids + conversationId / cumulativeUsage / pendingShells patch maps;
      // the consumer applies them with platform-specific side-effects
      // (dashboard's activeModel lookup + isBusy → isIdle resync stay here).
      const initialActiveId = get().activeSessionId;
      const patches = sharedBuildSessionListPatches(
        msg,
        Object.keys(get().sessionStates),
        initialActiveId,
      );
      if (!patches) break;
      const {
        sessionList,
        removedIds,
        newSessionIds,
        conversationIdPatches,
        cumulativeUsagePatches,
        backgroundShellBuilders,
      } = patches;
      // GC persisted messages for sessions that dropped out of the list
      for (const prevId of removedIds) {
        void clearPersistedSession(prevId);
      }
      // Batch in-memory cleanup into a single state update
      if (removedIds.length > 0) {
        const patch: Partial<ConnectionState> = {};
        const newStates = { ...get().sessionStates };
        for (const id of removedIds) {
          delete newStates[id];
        }
        patch.sessionStates = newStates;
        // #5163: drop the Control Room activity tree for any session that
        // dropped out of the list so a closed session's tree doesn't linger.
        let nextActivity = get().activity;
        for (const id of removedIds) {
          nextActivity = clearSessionActivity(nextActivity, id);
        }
        if (nextActivity !== get().activity) patch.activity = nextActivity;
        // If the active session was removed, switch to next available
        if (initialActiveId && removedIds.includes(initialActiveId)) {
          const remaining = Object.keys(newStates);
          const nextId = remaining.length > 0 ? remaining[0] : null;
          patch.activeSessionId = nextId;
          if (nextId && newStates[nextId]) {
            const ss = newStates[nextId];
            patch.messages = ss.messages;
            patch.streamingMessageId = ss.streamingMessageId;
            patch.claudeReady = ss.claudeReady;
            patch.activeModel = ss.activeModel;
            patch.permissionMode = ss.permissionMode;
            patch.contextUsage = ss.contextUsage;
            patch.lastResultCost = ss.lastResultCost;
            patch.lastResultDuration = ss.lastResultDuration;
            patch.isIdle = ss.isIdle;
          } else {
            patch.messages = [];
            patch.streamingMessageId = null;
            patch.claudeReady = false;
            patch.activeModel = null;
            patch.permissionMode = null;
            patch.contextUsage = null;
            patch.lastResultCost = null;
            patch.lastResultDuration = null;
            patch.isIdle = true;
          }
        }
        set(patch);
      }
      set({ sessions: sessionList });
      // Sync activeModel from session list to prevent dropdown reset.
      // session_list sends full model IDs (e.g. claude-sonnet-4-5-20250929) but the
      // dropdown uses short IDs (e.g. sonnet). Resolve via availableModels lookup.
      const activeSessionId = get().activeSessionId;
      if (activeSessionId) {
        const activeSessionInfo = sessionList.find((s: { sessionId?: string }) => s.sessionId === activeSessionId);
        if (activeSessionInfo?.model) {
          const fullId = activeSessionInfo.model as string;
          const models = get().availableModels;
          const matched = models.find((m) => m.fullId === fullId || m.id === fullId);
          set({ activeModel: matched ? matched.id : fullId });
        }
      }
      // Initialize session state for any new sessions not yet tracked.
      // #4639: seed `isIdle` from the server's authoritative `isBusy` so a
      // fresh tab / new-session entry reflects the real working state
      // instead of defaulting to `isIdle: true` and silently dropping the
      // Working banner until the next live event arrives.
      if (newSessionIds.length > 0) {
        const currentStates = get().sessionStates;
        const newInitStates = { ...currentStates };
        const sessionsBySid = new Map(sessionList.map((s) => [s.sessionId, s]));
        for (const sid of newSessionIds) {
          if (!newInitStates[sid]) {
            const fresh = createEmptySessionState();
            const s = sessionsBySid.get(sid);
            if (s && typeof s.isBusy === 'boolean') fresh.isIdle = !s.isBusy;
            newInitStates[sid] = fresh;
          }
        }
        set({ sessionStates: newInitStates });
      }
      // #4639: resync `isIdle` on EXISTING session states against the
      // snapshot's `isBusy`. Without this, a session that became busy on
      // the server while the dashboard's local handlers missed the flip
      // (tab swap during a long turn, peer-tab triggered the work, race
      // between agent_busy and history_replay) shows the wrong banner and
      // the wrong Send/Stop button. The snapshot is the source of truth.
      for (const s of sessionList) {
        if (typeof s.isBusy !== 'boolean') continue;
        if (!get().sessionStates[s.sessionId]) continue;
        const desiredIsIdle = !s.isBusy;
        updateSession(s.sessionId, (ss) =>
          ss.isIdle === desiredIsIdle ? {} : { isIdle: desiredIsIdle }
        );
      }
      // Sync conversationId from session list into session states
      for (const [sid, cid] of conversationIdPatches) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) =>
          ss.conversationId !== cid ? { conversationId: cid } : {}
        );
      }
      // #4073: seed cumulativeUsage from the snapshot so refreshing the
      // dashboard mid-session shows the running total without waiting
      // for the next session_usage event to land. listSessions on the
      // server emits the field with zero defaults when no result has
      // landed yet — `cumulativeUsage` is undefined only when an older
      // server omits it entirely. Six-field equality short-circuit lives
      // in store-core via {@link sharedCumulativeUsageEquals} (#4767).
      for (const [sid, snapshot] of cumulativeUsagePatches) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) =>
          sharedCumulativeUsageEquals(ss.cumulativeUsage, snapshot)
            ? {}
            : { cumulativeUsage: snapshot }
        );
      }
      // #4307: seed pendingBackgroundShells from the snapshot so a
      // fresh tab / reconnect catches up to any sessions already
      // waiting on background work without needing the next
      // background_work_changed event to arrive. The
      // `handleBackgroundWorkChanged` builder does the
      // same-reference short-circuit so duplicate seeds don't
      // re-render. The field is optional on `SessionInfo` because
      // older servers omit it; treat `undefined` as "no waiting
      // work" (empty array passthrough).
      for (const [sid, builder] of backgroundShellBuilders) {
        if (!get().sessionStates[sid]) continue;
        updateSession(sid, (ss) => {
          const next = builder.applyTo(ss.pendingBackgroundShells);
          return next === ss.pendingBackgroundShells
            ? {}
            : { pendingBackgroundShells: next };
        });
      }
      break;
    }

    // session_context — migrated to the shared store-core dispatch table (#5618)

    case 'monthly_budget': {
      // #5665 — machine-wide monthly programmatic-credit meter snapshot/event.
      // Sent on connect and after each programmatic-credit-billed turn. Store
      // the latest snapshot for the sidebar meter, and fire a one-time info
      // toast when the server reports a fresh threshold crossing
      // (justWarned/justExceeded — latched once per month server-side, so the
      // toast never spams turn-over-turn while over the threshold).
      const month = typeof msg.month === 'string' ? msg.month : null;
      if (month) {
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        const numOrNull = (v: unknown): number | null =>
          v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : null;
        const spentUsd = num(msg.spentUsd);
        const budgetUsd = numOrNull(msg.budgetUsd);
        getStore().setState({
          monthlyBudget: {
            month,
            spentUsd,
            turnsBilled: num(msg.turnsBilled),
            budgetUsd,
            warningPercent: num(msg.warningPercent),
            percent: numOrNull(msg.percent),
            warning: msg.warning === true,
            exceeded: msg.exceeded === true,
          },
        });
        const cap = budgetUsd != null ? `$${budgetUsd.toFixed(2)}` : '';
        const spent = `$${spentUsd.toFixed(2)}`;
        if (msg.justExceeded === true) {
          get().addInfoNotification(
            `Monthly programmatic-credit budget exceeded — ${spent}${cap ? ` of ${cap}` : ''} of your credit pool spent this month (chroxy-observed).`,
          );
        } else if (msg.justWarned === true) {
          const pct = numOrNull(msg.percent);
          get().addInfoNotification(
            `Monthly credit budget at ${pct != null ? `${Math.round(pct)}%` : 'the warning threshold'} — ${spent}${cap ? ` of ${cap}` : ''} spent this month (chroxy-observed).`,
          );
        }
      }
      break;
    }

    case 'session_activity': {
      // #4639: server-emitted busy/idle broadcast (ws-forwarding.js fires it
      // on stream_start and result for every session, to every authenticated
      // client). Pre-fix the dashboard had no handler, so a peer tab driving
      // the session — or this tab's own session_list snapshot — was the only
      // way to learn about busy state changes for non-active sessions. That
      // gap is what made the Working banner desync after a tab swap.
      //
      // Defensive: ignore if either field is missing/wrong type, and skip
      // unknown sessions (session_list is responsible for seeding new
      // entries — we don't want session_activity racing it).
      const activitySessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const activityIsBusy = typeof msg.isBusy === 'boolean' ? msg.isBusy : null;
      if (activitySessionId && activityIsBusy !== null && get().sessionStates[activitySessionId]) {
        const desiredIsIdle = !activityIsBusy;
        updateSession(activitySessionId, (ss) =>
          ss.isIdle === desiredIsIdle ? {} : { isIdle: desiredIsIdle }
        );
      }
      break;
    }

    // conversation_id — migrated to the shared dispatch table (#5556)


    case 'evaluate_draft_result': {
      // #3068: route to the resolver registered by the matching evaluateDraft()
      // call. Drop on the floor if there's no waiter — the request was
      // cancelled or already timed out, so the late-arriving result is moot.
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (requestId) {
        const entry = _evaluatorPending.get(requestId);
        if (entry) {
          _evaluatorPending.delete(requestId);
          window.clearTimeout(entry.timeoutId);
          entry.resolve({
            verdict: msg.verdict as 'forward' | 'rewrite' | 'clarify' | undefined,
            rewritten: typeof msg.rewritten === 'string' ? msg.rewritten : null,
            clarification: typeof msg.clarification === 'string' ? msg.clarification : null,
            reasoning: typeof msg.reasoning === 'string' ? msg.reasoning : '',
            // #3100: forward optional `status` so the InputBar can branch on
            // 401 (auth) / 429 (rate-limit) / 5xx (service down) for the
            // recovery hint without parsing message text.
            error: msg.error as { code: string; message: string; status?: number } | undefined,
          });
        }
      }
      break;
    }

    case 'session_error': {
      // Crash branch: flip session health + notify; non-crash branch: rewrite
      // SESSION_TOKEN_MISMATCH into the actionable bound-session hint (#2904)
      // and surface via toast/banner. Parser is shared via store-core; the
      // platform-specific surfaces (notification, alert, server error banner)
      // stay here.
      const parsed = sharedSessionError(msg, get().activeSessionId);
      // #5277: clear pending "cancelling" state so the ActivityTree button
      // recovers. CANCEL_ACTIVITY_FAILED echoes the exact sessionId+activityId;
      // SESSION_NOT_FOUND means the whole session is gone, so no cancel for it
      // can resolve — drop all of its pending cancels.
      if (parsed.code === 'CANCEL_ACTIVITY_FAILED' && typeof msg.sessionId === 'string' && typeof msg.activityId === 'string') {
        clearCancellingActivity(get, set, msg.sessionId, msg.activityId);
      } else if (parsed.code === 'SESSION_NOT_FOUND') {
        clearCancellingForSession(get, set, parsed.attemptedSessionId ?? undefined);
      } else if (parsed.code === 'SUMMARIZE_FAILED' && typeof msg.requestId === 'string') {
        // #5547: a failed summarize_session echoes the requestId — reject the
        // pending promise so the awaiting create-session flow surfaces the
        // (curated, leak-free) message. Return early: the generic toast below
        // would double-report; the caller decides how to surface it.
        rejectSummarizeRequest(msg.requestId, parsed.message || 'Could not summarize this session.');
        return;
      } else if (parsed.code === 'INTEGRATION_ACTION_FAILED' && typeof msg.repoPath === 'string') {
        // #5500/#5502: a failed integration action echoes the exact repoPath
        // (and action) — clear that row's pending state and surface the
        // reason inline (the generic branch below still raises the toast,
        // matching the CANCEL_ACTIVITY_FAILED precedent). Routed by the
        // echoed action so a rerun failure can't clear a reindex pending;
        // an unknown future action's failure touches neither bucket (the
        // generic toast below still fires).
        if (msg.action === 'repo_relay_rerun') {
          resolveRelayRerun(get, set, msg.repoPath, {
            error: parsed.message || 'Re-run failed.',
          });
        } else if (msg.action === 'repo_memory_reindex') {
          resolveReindex(get, set, msg.repoPath, {
            counts: null,
            error: parsed.message || 'Reindex failed.',
          });
        }
      } else if (parsed.code === 'ORCHESTRATION_ACTION_FAILED' && typeof msg.requestId === 'string') {
        // #6691 (S-3): a failed orchestration action echoes the requestId —
        // clear the pending entry and record the failure inline (the generic
        // toast below still fires, matching the INTEGRATION_ACTION_FAILED
        // precedent).
        const orchPending = { ...get().orchestrationPendingActions };
        if (msg.requestId in orchPending) {
          delete orchPending[msg.requestId];
          set({
            orchestrationPendingActions: orchPending,
            orchestrationActionResults: {
              ...get().orchestrationActionResults,
              [msg.requestId]: { ok: false, error: parsed.message || 'Orchestration action failed.', at: Date.now() },
            },
          });
        }
      } else if (parsed.code === 'CONTAINER_ACTION_FAILED' && typeof msg.environmentId === 'string') {
        // #6134: a failed containers_action echoes the exact environmentId
        // (and action) — clear that row's pending state and surface the reason
        // inline (the generic branch below still raises the toast, matching the
        // INTEGRATION_ACTION_FAILED precedent). status is null on failure.
        resolveContainerAction(get, set, msg.environmentId, {
          action: typeof msg.action === 'string' ? msg.action : '',
          status: null,
          error: parsed.message || 'Container action failed.',
        });
      } else if (parsed.code === 'BYOK_POOL_ACTION_FAILED' && typeof msg.action === 'string') {
        // #6135: a failed byok_pool_action echoes the exact action (+ key for
        // recycle) — clear that target's pending state and surface the reason
        // inline (the generic branch below still raises the toast, matching the
        // CONTAINER_ACTION_FAILED precedent).
        resolveByokPoolAction(get, set, byokPoolActionTargetId(msg.action, typeof msg.key === 'string' ? msg.key : null), {
          action: msg.action,
          note: null,
          error: parsed.message || 'BYOK pool action failed.',
        });
      } else if (parsed.code === 'HOST_PRUNE_ACTION_FAILED' && typeof msg.kind === 'string') {
        // #6140: a failed host_prune_action echoes the exact kind — clear that
        // kind's pending state and surface the reason inline (the generic branch
        // below still raises the toast, matching the precedents).
        resolveHostPruneAction(get, set, msg.kind, {
          note: null,
          error: parsed.message || 'Host prune failed.',
        });
      } else if (parsed.code === 'SIMULATOR_ACTION_FAILED' && typeof msg.udid === 'string') {
        // #6136: a failed simulator_action echoes the exact udid (+ action) —
        // clear that device's pending state and surface the reason inline (the
        // generic branch below still raises the toast, matching the precedents).
        resolveSimulatorAction(get, set, msg.udid, {
          action: typeof msg.action === 'string' ? msg.action : '',
          note: null,
          error: parsed.message || 'Simulator action failed.',
        });
      } else if (parsed.code === 'EMULATOR_ACTION_FAILED' && (typeof msg.avd === 'string' || typeof msg.serial === 'string')) {
        // #6137: a failed emulator_action echoes the target (avd for boot,
        // serial for kill) — clear that target's pending state and surface the
        // reason inline (the generic branch below still raises the toast).
        const action = typeof msg.action === 'string' ? msg.action : '';
        const targetId = action === 'boot'
          ? (typeof msg.avd === 'string' ? msg.avd : '')
          : (typeof msg.serial === 'string' ? msg.serial : '');
        if (targetId) {
          resolveEmulatorAction(get, set, targetId, {
            action,
            note: null,
            error: parsed.message || 'Emulator action failed.',
          });
        }
      } else if (parsed.code === 'WSL_ACTION_FAILED' && typeof msg.distro === 'string') {
        // #6138: a failed wsl_action echoes the exact distro (+ action) — clear
        // that distro's pending state and surface the reason inline (the generic
        // branch below still raises the toast, matching the precedents).
        resolveWslAction(get, set, msg.distro, {
          action: typeof msg.action === 'string' ? msg.action : '',
          note: null,
          error: parsed.message || 'WSL action failed.',
        });
      }
      if (parsed.category === 'crash' && parsed.sessionPatch) {
        const crashedId = parsed.sessionPatch.sessionId;
        if (crashedId && get().sessionStates[crashedId]) {
          updateSession(crashedId, () => ({ health: 'crashed' as const }));
          pushSessionNotification(crashedId, 'error', 'Session crashed');
        }
      } else if (parsed.code === 'SESSION_NOT_FOUND') {
        // #4982 — dashboard's persisted `activeSessionId` points at a
        // pre-restart session id that no longer exists after
        // `session-manager.restoreState()` regenerated ids on the daemon
        // side (#4979). Without clearing the stale id, the next user send
        // trips the same error in a loop and the operator stays wedged.
        //
        // The SessionNotFoundChip reads `sessionNotFoundError` from the
        // store and renders an actionable banner over the empty-state
        // pane. The toast still fires so the operator sees the immediate
        // signal too, but the loop stops because activeSessionId is gone
        // and the next send addresses a different (operator-picked) id.
        get().setSessionNotFoundError({
          attemptedSessionId: parsed.attemptedSessionId ?? null,
          message: parsed.message ?? 'Session not found.',
        });
        set({ activeSessionId: null });
        if (parsed.message) {
          _adapters.alert.alert('Session Restarted', parsed.message);
          get().addServerError(parsed.message);
        }
      } else if (parsed.category === 'input_conflict') {
        // #5281 ①.3 — an expected "can't send right now" event, NOT a failure:
        // either another device's request is mid-flight, or this session is
        // still evaluating a previous draft. The generic branch below would
        // raise a modal alert + red serverError, which is the wrong register.
        // Instead: drop the stranded optimistic user message (its send was
        // rejected) + its thinking spinner, and surface a calm, transient
        // notice using the server's specific reason.
        //
        // sessionId resolution leans on the invariant that the dashboard only
        // ever sends to (and optimistically records on) its active session —
        // sendInput sets payload.sessionId = activeSessionId — so the echoed
        // sessionId is where the ghost lives. Revisit if a multi-session send
        // path is ever added.
        const conflictSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : get().activeSessionId;
        const rejectedId = typeof msg.clientMessageId === 'string' && msg.clientMessageId.length > 0
          ? msg.clientMessageId
          : null;
        // filterThinking drops the spinner immediately (no 5s safety-net wait);
        // the id filter removes the ghost send when the server echoed which
        // message it rejected — but ONLY the optimistic user_input at that id,
        // never a colliding message of another type.
        const dropGhost = (messages: ChatMessage[]) =>
          filterThinking(messages).filter(
            (m) => !(rejectedId && m.id === rejectedId && m.type === 'user_input'),
          );
        if (conflictSessionId && get().sessionStates[conflictSessionId]) {
          updateSession(conflictSessionId, (ss) => ({
            messages: dropGhost(ss.messages),
            streamingMessageId: ss.streamingMessageId === 'pending' ? null : ss.streamingMessageId,
            // #6302 — the optimistic turn is being torn down (server rejected the
            // send); drop its owner alongside the 'pending' sentinel.
            ...(ss.streamingMessageId === 'pending' ? { pendingClientMessageId: null } : {}),
          }));
        } else {
          // Root-level (CLI single-session) store mode: addUserMessage put the
          // optimistic entry on the top-level messages/streamingMessageId, so
          // clean those instead of a per-session slot.
          set((state: ConnectionState) => ({
            messages: dropGhost(state.messages),
            streamingMessageId: state.streamingMessageId === 'pending' ? null : state.streamingMessageId,
          }));
        }
        // Prefer the server's specific reason (cross-device vs evaluator lock);
        // fall back to a variant-neutral notice for an older server.
        get().addInfoNotification(
          parsed.message || 'Your message wasn’t sent — the session is busy. Wait for it to finish, or interrupt the current run.',
        );
      } else if (parsed.message) {
        _adapters.alert.alert('Session Error', parsed.message);
        get().addServerError(parsed.message);
      }
      break;
    }

    // session_stopped — migrated to the shared dispatch table (#5618 Batch 3;
    // handled by runDispatch before this switch). Sets stoppedAt/stoppedCode on
    // the target session (shared with the app) and fires the dashboard-specific
    // info toast (#4878) via the `addInfoNotification` adapter hook.

    // --- History replay ---

    case 'history_replay_start': {
      // Parser is shared via store-core; flag mutation stays at this call
      // site (module-level state, not store state).
      const { fullHistory, sessionId: replayTargetId, latestSeq } = sharedHistoryReplayStart(
        msg,
        get().activeSessionId,
      );
      // #4493 — track per-session. Falls back to activeSessionId via
      // sharedHistoryReplayStart, matching the gate's targetId resolution.
      if (replayTargetId) _replayingSessions.add(replayTargetId);
      // #5555.4 — DO NOT wipe messages here. For a full rebuild we record the
      // pre-replay baseline and keep the existing messages visible; the
      // authoritative replayed set is appended after the baseline and swapped
      // in atomically at history_replay_end (no blank flash). For a delta
      // replay (cursor honoured) this is purely append-only. `latestSeq` seeds
      // the cursor so an already-current empty replay still advances it.
      {
        const curLen =
          (replayTargetId && get().sessionStates[replayTargetId]?.messages.length) || 0;
        reconcileReplayStart(replayTargetId, fullHistory, curLen, latestSeq);
      }
      // Clear transient state — these events are not replayed from history,
      // so any surviving entries are stale from pre-disconnect
      updateActiveSession((ss) => {
        const patch: Partial<SessionState> = {};
        if (ss.activeAgents.length > 0) patch.activeAgents = [];
        // #4466: preserve activeTools through the replay boundary. The
        // earlier #4308 wipe rebuilt entries from replayed tool_start
        // events with startedAt = Date.now(), so the "Running <tool> · Ns"
        // pill restarted at 1s every time the user switched tabs. The
        // in-flight set is authoritative (carried in-memory, not derivable
        // from history), so keeping it intact preserves the elapsed-time
        // clock. tool_result events that fire during replay still
        // correctly drop resolved entries via sharedToolResult, and the
        // dedup logic in sharedToolStart prevents replayed tool_start
        // events from re-adding tools already in activeTools.
        if (ss.isPlanPending) {
          patch.isPlanPending = false;
          patch.planAllowedPrompts = [];
        }
        return Object.keys(patch).length > 0 ? patch : {};
      });
      break;
    }

    case 'history_replay_end':
      // Parser is shared via store-core; flag mutation stays here.
      sharedHistoryReplayEnd();
      // #4493 — remove this session id from the replaying set. Falls back
      // to activeSessionId to mirror sharedHistoryReplayStart's resolution.
      {
        const endTargetId =
          (typeof msg.sessionId === 'string' && msg.sessionId) || get().activeSessionId;
        if (endTargetId) _replayingSessions.delete(endTargetId);
        // #5555.4 — atomic swap for a full rebuild: replace messages with the
        // appended replayed tail in ONE update (old prefix dropped here, not at
        // start → no blank flash). reconcileReplayEnd also advances the cursor
        // from `latestSeq`. Returns null for a delta replay (nothing to swap).
        const endLatestSeq =
          typeof msg.latestSeq === 'number' && Number.isFinite(msg.latestSeq)
            ? msg.latestSeq
            : undefined;
        if (endTargetId && get().sessionStates[endTargetId]) {
          const { swappedMessages } = reconcileReplayEnd(
            endTargetId,
            get().sessionStates[endTargetId]!.messages,
            endLatestSeq,
          );
          if (swappedMessages) {
            updateSession(endTargetId, () => ({
              messages: swappedMessages as SessionState['messages'],
            }));
          }
        } else {
          // Session vanished mid-replay — still settle the cursor.
          reconcileReplayEnd(endTargetId, [], endLatestSeq);
        }
      }
      // Mark all replayed prompts as answered — any prompt in history
      // has already been resolved by the server.
      updateActiveSession((ss) => {
        const hasUnansweredPrompts = ss.messages.some(
          (m) => m.type === 'prompt' && !m.answered
        );
        if (!hasUnansweredPrompts) return {};
        return {
          messages: ss.messages.map((m) =>
            m.type === 'prompt' && !m.answered
              ? { ...m, answered: '(resolved)' }
              : m
          ),
        };
      });
      break;

    // --- User input echoed from other clients ---

    case 'user_input': {
      // Server broadcasts user_input to all OTHER clients when someone sends a message.
      // Skip if it came from this client (we already show it via optimistic UI).
      const userInput = sharedUserInput(msg, get().myClientId, get().activeSessionId);
      if (!userInput) break;
      // Write user message to terminal buffer for Output view
      if (userInput.content) {
        get().appendTerminalData(`\r\n\x1b[33m> ${userInput.content}\x1b[0m\r\n\r\n`);
      }
      // #3188: a remote client just answered (or otherwise sent a fresh
      // user_input for this session). Any locally-rendered evaluator
      // clarify prompt is now stale — clear it so two paired clients
      // don't both keep showing the question after one has responded.
      updateSession(userInput.sessionId, (ss) => {
        const patch: Partial<SessionState> = {
          messages: [...ss.messages, userInput.chatMessage],
        };
        if (ss.pendingEvaluatorClarify) patch.pendingEvaluatorClarify = null;
        return patch;
      });
      break;
    }

    // --- Existing message handlers (now session-aware) ---

    case 'message': {
      // Use the shared resolver so trim / empty-string normalization stays
      // consistent with sharedMessageHandler and the rest of store-core.
      const targetId = resolveSessionId(msg, get().activeSessionId);
      // Resolve the cache used for replay-dedup (target session if known,
      // else the global message log).
      const targetState = targetId ? get().sessionStates[targetId] : null;
      // #5555.4 — during a FULL rebuild, dedup only against the appended replay
      // tail (replayDedupCache slices off the about-to-be-discarded prefix) so a
      // replayed entry isn't suppressed by an id in the prefix and then lost in
      // the swap. For delta replay / no rebuild this returns the whole array.
      const cached = replayDedupCache(
        targetId,
        targetState ? targetState.messages : get().messages,
      );
      // #4493 — dedup against history only when THIS message's session is
      // currently replaying. A module-wide boolean would suppress live
      // messages for session B while A replays.
      const messageIsReplay = targetId ? _replayingSessions.has(targetId) : false;
      // #5555.3 — advance this session's cursor as we apply a replayed entry.
      if (messageIsReplay) recordHistorySeq(targetId, (msg as { historySeq?: unknown }).historySeq);
      const result = sharedMessageHandler(msg, get().activeSessionId, messageIsReplay, cached);
      if (!result.shouldDispatch) break;
      const newMsg = result.chatMessage;
      if (targetId && get().sessionStates[targetId]) {
        updateSession(targetId, (ss) => ({
          messages: [
            ...ss.messages.filter((m) => m.id !== 'thinking' || newMsg.id === 'thinking'),
            newMsg,
          ],
        }));
      } else {
        get().addMessage(newMsg);
      }
      // Surface rate limit / usage limit errors prominently (#616)
      if (result.isRateLimitError && result.errorContent) {
        _adapters.alert.alert('Usage Limit', result.errorContent);
      }
      break;
    }

    case 'result': {
      // Flush any buffered deltas before clearing streaming state
      deltaFlusher.flushNow();
      // Clean up permission boundary split tracking
      _postPermissionSplits.clear();
      _deltaIdRemaps.clear();
      const normalized = sharedResultUsage(msg, get().activeSessionId);
      const targetId = normalized.sessionId;
      // Resolve cost: server provides it for Claude; compute client-side for
      // sessions whose provider really cannot return a cost number (Codex,
      // Gemini). The provider gate is intentionally narrow — see
      // CLIENT_ESTIMATED_COST_PROVIDERS — so a new server-side priced
      // provider that just happens to emit `cost: null` momentarily (race,
      // edge case) doesn't get a wrong client-side estimate written into
      // its session state. The shared helper returns null when msg.cost
      // is missing/non-numeric; we fall back to client-side pricing only
      // when we have a usage payload AND the provider is on the list.
      // #4206: this list is also imported by status-tooltips.ts so the
      // "estimated client-side" tooltip wording can only diverge with an
      // explicit double edit.
      let resolvedCost: number | null = normalized.lastResultCost;
      if (resolvedCost === null && normalized.contextUsage) {
        const session = get().sessions.find(
          (s: SessionInfo) => s.sessionId === targetId,
        );
        const sessionModel = session?.model ?? null;
        const sessionProvider = session?.provider ?? null;
        if (sessionModel && sessionProvider && CLIENT_ESTIMATED_COST_PROVIDERS.has(sessionProvider)) {
          resolvedCost = calculateCost(
            sessionModel,
            normalized.contextUsage.inputTokens,
            normalized.contextUsage.outputTokens,
          );
        }
      }
      const resultPatch = {
        streamingMessageId: null as string | null,
        contextUsage: normalized.contextUsage,
        lastResultCost: resolvedCost,
        lastResultDuration: normalized.lastResultDuration,
      };
      // #6627 — reconcile the queue against the result's authoritative queueLength
      // so a stale "Queued" bubble (from a dropped/late message_dequeued) self-heals
      // on this turn boundary. Null when the server sent no queueLength (older).
      const queueReconcile = handleResultQueueReconcile(msg, get().activeSessionId);
      // Notify if a background session just finished (was streaming)
      if (targetId && get().sessionStates[targetId]?.streamingMessageId) {
        pushSessionNotification(targetId, 'completed', 'Task completed');
      }
      if (targetId && get().sessionStates[targetId]) {
        // Force a new messages array reference so selectors detect the change,
        // even when flushPendingDeltas() was a no-op (timer already flushed).
        updateSession(targetId, (ss) => {
          // #4308 — `result` is a guaranteed turn boundary; any still-tracked
          // activeTools are a missed tool_result (server crash, dropped
          // broadcast) and must be dropped so the activity indicator can't
          // get stuck on a phantom "Running X". Mirror in agent_idle.
          //
          // #4466 — but ONLY for live result events. `result` events are
          // recorded in the server's per-session history ring buffer
          // (session-message-history.js) and replayed on switch_session via
          // PROXIED_EVENTS (session-manager.js). Without this gate, every
          // tab switch on a session that's completed at least one prior
          // turn fires a replayed `result` that wipes the activeTools the
          // history_replay_start guard is trying to preserve — the
          // replayed in-flight tool_start then re-adds the entry with a
          // fresh Date.now() startedAt, restoring the exact "Running X · 1s"
          // clock-reset symptom #4466 set out to fix.
          // #6627 — self-heal a stale "Queued" bubble on the turn boundary.
          // LIVE results only: a REPLAYED result (on switch_session) carries a
          // stale queueLength that must not trim the current queue (mirrors the
          // activeTools replay guard below). Only patch queuedMessages when the
          // reconcile actually trimmed an orphan — reconcileQueueLength returns
          // the same array reference in the common in-sync case, so gating on
          // referential inequality avoids a needless write/rerender every turn.
          const currentQueue = ss.queuedMessages ?? [];
          const reconciledQueue =
            queueReconcile && !_replayingSessions.has(targetId)
              ? queueReconcile.applyTo(currentQueue).queuedMessages
              : currentQueue;
          const patch: Partial<SessionState> = {
            ...resultPatch,
            messages: [...ss.messages],
            ...(reconciledQueue !== currentQueue ? { queuedMessages: reconciledQueue } : {}),
          };
          // #4493 — gate per target session id. A live `result` for
          // session B during A's replay must still sweep B's activeTools.
          if (ss.activeTools.length > 0 && !_replayingSessions.has(targetId)) patch.activeTools = [];
          return patch;
        });
      } else {
        set((s) => ({ ...resultPatch, messages: [...s.messages] }));
      }
      break;
    }

    // available_models — migrated to the shared dispatch table (#5618 Batch 5a;
    // handled by runDispatch before this switch). Non-array payloads are a no-op
    // that preserves the existing list. The dashboard's availableModelsProvider
    // rides on the `extendModelsPatch` adapter hook (single set).

    // confirm_permission_mode — migrated to the shared dispatch table (#5556)


    // agent_spawned / agent_completed / agent_event / background_work_changed /
    // plan_started — migrated to the shared dispatch table (#5556 slice 2)

    // plan_ready — migrated to the shared dispatch table (#5618; runDispatch). The
    // dashboard has no plan notification, so it omits the notifyPlanReady hook.

    // inactivity_warning — migrated to the shared dispatch table (#5556 slice 2)

    case 'permission_expired': {
      const { requestId: expiredRequestId, systemMessage: expiredSystemMsg } =
        sharedPermissionExpired(msg);
      if (expiredRequestId) {
        // #6559 — prune the pulled input for an expired prompt. Hoisted above the
        // alreadyResolved early-return so both branches drop it (guarded copy-delete).
        set((s) => {
          if (!s.permissionInputs || !Object.prototype.hasOwnProperty.call(s.permissionInputs, expiredRequestId)) return {};
          const next = { ...s.permissionInputs };
          delete next[expiredRequestId];
          return { permissionInputs: next };
        });
        // If the user already resolved this request (via Allow/Deny/AllowSession),
        // this is the race condition from #2833 — the server expired the prompt
        // after we answered. Suppress the "Expired — already handled" message
        // append so the UI does not surface this as an error to the user.
        const alreadyResolved = Boolean(get().resolvedPermissions?.[expiredRequestId]);
        if (alreadyResolved) {
          // #5008 — drain the banner stack without dropping the row from the
          // widget's durable history. See handlePermissionResolved for the
          // full rationale; this branch handles the #2833 race where expiry
          // arrives after we already resolved locally. Single timestamp per
          // mutation — see handlePermissionResolved for the pattern source.
          const readStamp = Date.now();
          set((s) => ({
            sessionNotifications: s.sessionNotifications.map((n) =>
              n.requestId === expiredRequestId && n.readAt === undefined
                ? { ...n, readAt: readStamp }
                : n
            ),
          }));
          // #2839: surface a user-centric info toast confirming the
          // response was already recorded, without exposing the underlying
          // server-side expiration race as an error-like message.
          get().addInfoNotification('Already answered — your response was already recorded');
          break;
        }
        console.warn(`[ws] Permission ${expiredRequestId} expired: ${msg.message}`);
        const expTargetId = (msg.sessionId as string) || get().activeSessionId;
        if (expTargetId && get().sessionStates[expTargetId]) {
          updateSession(expTargetId, (ss) => ({
            messages: ss.messages.map((m) =>
              m.requestId === expiredRequestId && m.type === 'prompt'
                ? { ...m, content: `${m.content}\n${expiredSystemMsg.content}`, options: undefined }
                : m
            ),
          }));
        }
        // #5008 — drain banner without dropping widget history. Mark the
        // matching row read; the banner filter (`readAt === undefined`)
        // drops it and the widget keeps the entry as part of its durable
        // intervention history. Updates the original #1580 auto-dismiss
        // contract from "remove" to "mark-read-and-keep". Single timestamp
        // per mutation — see handlePermissionResolved for the pattern source.
        const readStamp = Date.now();
        set((s) => ({
          sessionNotifications: s.sessionNotifications.map((n) =>
            n.requestId === expiredRequestId && n.readAt === undefined
              ? { ...n, readAt: readStamp }
              : n
          ),
        }));
      }
      break;
    }

    case 'permission_timeout': {
      // #5454: the dashboard previously dropped this event on the floor while
      // the app handled it (the #2661 close-out flagged the gap). Not yet
      // emitted by the server (see the handler-coverage SYNTHETIC_TYPES
      // note) — wired up now for parity via the shared store-core handler so
      // both clients react identically when the server grows the emit side.
      const { requestId: timeoutRequestId, systemMessage: timeoutSystemMsg } =
        sharedPermissionTimeout(msg);
      if (timeoutRequestId) {
        // Mark the matching prompt as auto-denied. Scan all session states
        // first (the prompt may have been stored in any session — mirrors the
        // handlePermissionResolved all-sessions search), then fall back to
        // the flat messages array for sessions not in sessionStates.
        const timeoutUpdater = (ss: { messages: ChatMessage[] }) => ({
          messages: ss.messages.map((m) =>
            m.requestId === timeoutRequestId && m.type === 'prompt'
              ? { ...m, content: `${m.content}\n(Auto-denied — permission timed out)`, options: undefined }
              : m
          ),
        });
        const timeoutStates = get().sessionStates;
        let timeoutFound = false;
        for (const sid of Object.keys(timeoutStates)) {
          if (timeoutStates[sid]?.messages.some((m) => m.requestId === timeoutRequestId)) {
            updateSession(sid, timeoutUpdater);
            timeoutFound = true;
            break;
          }
        }
        if (!timeoutFound) {
          set({ messages: timeoutUpdater({ messages: get().messages }).messages });
        }
        // #5008 — drain the banner stack without dropping the row from the
        // NotificationsWidget's durable history: stamp `readAt` instead of
        // removing (see handlePermissionResolved for the pattern source).
        const readStamp = Date.now();
        set((s) => ({
          sessionNotifications: s.sessionNotifications.map((n) =>
            n.requestId === timeoutRequestId && n.readAt === undefined
              ? { ...n, readAt: readStamp }
              : n
          ),
        }));
        // #6559 — prune the pulled input for a timed-out prompt too.
        set((s) => {
          if (!s.permissionInputs || !Object.prototype.hasOwnProperty.call(s.permissionInputs, timeoutRequestId)) return {};
          const next = { ...s.permissionInputs };
          delete next[timeoutRequestId];
          return { permissionInputs: next };
        });
      }
      // Surface a dismissible error toast so the operator knows the
      // permission was auto-denied (wording comes from the shared handler so
      // the two clients stay in sync).
      get().addServerError(timeoutSystemMsg.content);
      break;
    }

    // permission_rules_updated — migrated to the shared dispatch table (#5556)


    // user_question — migrated to the shared dispatch table (#5618)

    case 'server_status': {
      // Handle structured startup phase events (phase field present)
      const phase = msg.phase as string | undefined;
      // #2836: 'tunnel_warming' is the current phase name. 'tunnel_verifying'
      // is accepted as a legacy alias — older servers may still emit it.
      if (phase === 'tunnel_warming' || phase === 'tunnel_verifying') {
        const attempt = typeof msg.attempt === 'number' ? msg.attempt : null;
        const maxAttempts = typeof msg.maxAttempts === 'number' ? msg.maxAttempts : null;
        set({
          serverPhase: 'tunnel_warming',
          tunnelProgress: attempt != null && maxAttempts != null ? { attempt, maxAttempts } : null,
        } as Partial<ConnectionState>);
        break;
      }
      if (phase === 'ready') {
        const readyPatch: Partial<ConnectionState> = {
          serverPhase: 'ready',
          tunnelProgress: null,
        };
        // #5356: a quick tunnel coming up mid-connection makes the server
        // publicly reachable — merge into the exposure snapshot so the
        // warning banner appears even when auth_ok predated the tunnel.
        if ((msg as { tunnelMode?: unknown }).tunnelMode === 'quick') {
          const prevExposure = get().serverExposure;
          readyPatch.serverExposure = {
            lanBind: prevExposure?.lanBind ?? false,
            quickTunnel: true,
          };
        }
        set(readyPatch);
        break;
      }

      // Legacy plain-message server_status (no phase field, or unknown phase)
      const { chatMessage: statusMsg } = sharedServerStatusLegacy(msg);
      const activeStatusId = get().activeSessionId;
      if (activeStatusId && get().sessionStates[activeStatusId]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, statusMsg],
        }));
      } else {
        get().addMessage(statusMsg);
      }
      break;
    }

    // rate_limited (#6334) — migrated to the shared dispatch table (#5618;
    // runDispatch). Byte-identical active-session notice; no per-client hook.

    // --- Multi-client awareness ---

    case 'client_joined': {
      const joined = sharedClientJoined(msg, get().connectedClients);
      if (!joined) break;
      set({ connectedClients: joined.roster });
      const deviceLabel = joined.client.deviceName || 'A device';
      const joinMsg: ChatMessage = {
        id: nextMessageId('client'),
        type: 'system',
        content: `${deviceLabel} connected`,
        timestamp: Date.now(),
      };
      // Global event — broadcast to all sessions so any tab shows it (single setState)
      const joinSessionIds = Object.keys(get().sessionStates);
      if (joinSessionIds.length > 0) {
        set((state: ConnectionState) => {
          const newSessionStates: typeof state.sessionStates = {};
          for (const sid in state.sessionStates) {
            const ss = state.sessionStates[sid]!;
            newSessionStates[sid] = { ...ss, messages: [...ss.messages, joinMsg] };
          }
          const activeId = state.activeSessionId;
          const patch: Partial<ConnectionState> = { sessionStates: newSessionStates };
          if (activeId && newSessionStates[activeId]) {
            patch.messages = newSessionStates[activeId].messages;
          }
          return patch;
        });
      } else {
        get().addMessage(joinMsg);
      }
      break;
    }

    case 'client_left': {
      const left = sharedClientLeft(msg, get().connectedClients);
      if (!left) break;
      set({ connectedClients: left.roster });
      const leftLabel = left.departingClient?.deviceName || 'A device';
      const leftMsg: ChatMessage = {
        id: nextMessageId('client'),
        type: 'system',
        content: `${leftLabel} disconnected`,
        timestamp: Date.now(),
      };
      // Global event — broadcast to all sessions so any tab shows it (single setState)
      const leftSessionIds = Object.keys(get().sessionStates);
      if (leftSessionIds.length > 0) {
        set((state: ConnectionState) => {
          const newSessionStates: typeof state.sessionStates = {};
          for (const sid in state.sessionStates) {
            const ss = state.sessionStates[sid]!;
            newSessionStates[sid] = { ...ss, messages: [...ss.messages, leftMsg] };
          }
          const activeId = state.activeSessionId;
          const patch: Partial<ConnectionState> = { sessionStates: newSessionStates };
          if (activeId && newSessionStates[activeId]) {
            patch.messages = newSessionStates[activeId].messages;
          }
          return patch;
        });
      } else {
        get().addMessage(leftMsg);
      }
      break;
    }

    // primary_changed / session_role / client_focus_changed — migrated to the
    // shared dispatch table (#5618 Batch 4; handled by runDispatch before this
    // switch). The dashboard's flat presence state (myClientId / followMode /
    // switchSession) is reached through the getMyClientId / getFollowMode /
    // switchSession adapter hooks, so the three cases are now fully shared. The
    // dashboard omits setPrimaryClientId (no secondary presence store).

    case 'directory_listing': {
      const cb = get()._directoryListingCallback;
      if (cb) {
        const payload = sharedDirectoryListing(msg);
        cb({ ...payload, entries: payload.entries as DirectoryEntry[] });
      }
      break;
    }

    case 'file_listing': {
      const fileBrowserCb = get()._fileBrowserCallback;
      if (fileBrowserCb) {
        const payload = sharedFileListing(msg);
        fileBrowserCb({ ...payload, entries: payload.entries as FileEntry[] });
      }
      break;
    }

    case 'file_content': {
      const fileContentCb = get()._fileContentCallback;
      if (fileContentCb) {
        fileContentCb(sharedFileContent(msg));
      }
      break;
    }

    case 'diff_result': {
      const diffCb = get()._diffCallback;
      if (diffCb) {
        const payload = sharedDiffResult(msg);
        // payload.files is now typed as DiffFile[] from store-core (#3132).
        diffCb({
          files: payload.files,
          error: payload.error,
        });
      }
      break;
    }

    case 'git_status_result': {
      const gitStatusCb = get()._gitStatusCallback;
      if (gitStatusCb) {
        const payload = sharedGitStatusResult(msg);
        // payload arrays are now strongly typed from store-core (#3132).
        gitStatusCb({
          branch: payload.branch,
          staged: payload.staged,
          unstaged: payload.unstaged,
          untracked: payload.untracked,
          error: payload.error,
        });
      }
      break;
    }

    // slash_commands / agent_list / provider_list — migrated to the shared
    // dispatch table (#5618 Batch 2; handled by runDispatch before this switch).
    // The dashboard has no secondary conversation store and trusts the server
    // provider payload, so it supplies neither the `syncSecondaryInventory` nor
    // the `mapProviderList` adapter hook — the dispatch handlers perform the
    // plain flat-state write, exactly as these cases did. (auth_bootstrap, which
    // folds the same lists into one connect-time frame, was migrated in #5618
    // Batch 5b — see below.) file_list remains dashboard-only.

    case 'file_list': {
      const fileResult = sharedFileList(msg);
      set({ filePickerFiles: fileResult.files as FilePickerItem[] });
      break;
    }

    // auth_bootstrap / tunnel_url_changed — migrated to the shared dispatch table
    // (#5618 Batch 5b; handled by runDispatch before this switch). auth_bootstrap
    // applies the provider list (verbatim — dashboard omits mapProviderList) + the
    // session-scope-guarded slash/agent lists + the tunnel URL via the
    // applyRotatedTunnelUrl hook; tunnel_url_changed's apply rides on that hook
    // alone (consulting previousUrl to match the registry entry).

    case 'byok_credentials_status': {
      // #4052: server replies after refresh / set / clear. The masked
      // form is intentionally the only key-shaped string we ever store —
      // never the raw value, even transiently.
      // #4144: fileExists must flow through too — the stale-file notice
      // and the Remove button are both gated on it. Hand-picking fields
      // here silently dropped it before (caught by agent-review on
      // PR #4174).
      // #4141: validate the wire payload via the protocol Zod schema
      // instead of raw `as` casts. A malformed server can no longer
      // store `status: 'unknown'` into the store; safeParse failure
      // logs a warn and leaves the store unchanged.
      const parsed = ServerByokCredentialsStatusSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('byok_credentials_status: invalid payload from server', parsed.error.issues);
        break;
      }
      const payload = parsed.data;
      set({
        byokCredentialsStatus: {
          status: payload.status,
          source: payload.source,
          masked: payload.masked,
          reason: payload.reason,
          fileExists: payload.fileExists,
        },
      });
      break;
    }

    case 'credentials_status': {
      // #3855: generalized provider-credential snapshot. Emitted in reply to
      // get_credentials_status and broadcast after every set/delete. The
      // masked previews are the only key-shaped strings we ever store — never
      // a raw value. Validate the wire payload via the protocol Zod schema so
      // a malformed server can't poison the store.
      const parsed = ServerCredentialsStatusSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('credentials_status: invalid payload from server', parsed.error.issues);
        break;
      }
      const payload = parsed.data;
      set({
        credentialsStatus: {
          credentials: payload.credentials.map((c) => ({
            key: c.key,
            provider: c.provider,
            label: c.label,
            kind: c.kind,
            status: c.status,
            source: c.source,
            masked: c.masked,
            oauth: c.oauth,
          })),
          fileExists: payload.fileExists,
          fileError: payload.fileError ?? null,
        },
      });
      break;
    }

    case 'credential_test_result': {
      // #3855: per-key test outcome. Store keyed by credential key so each row
      // renders its own inline result.
      const parsed = ServerCredentialTestResultSchema.safeParse(msg);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn('credential_test_result: invalid payload from server', parsed.error.issues);
        break;
      }
      const payload = parsed.data;
      set((state) => ({
        credentialTestResults: {
          ...state.credentialTestResults,
          [payload.key]: {
            ok: payload.ok,
            error: payload.error,
            model: payload.model,
            latencyMs: payload.latencyMs,
          },
        },
      }));
      break;
    }

    // notification_prefs — migrated to the shared dispatch table (#5556 slice 2)

    // checkpoint_created / checkpoint_list — migrated to the shared dispatch
    // table (#5618 Batch 6; handled by runDispatch before this switch). The
    // dashboard has no secondary checkpoint store, so it omits the
    // syncSecondaryCheckpoints adapter hook (the app implements it).

    // session_restore_failed / session_persist_failed — migrated to the shared
    // dispatch table (#5618 Batch 3; handled by runDispatch before this switch).
    // Both surface the error via the `addServerError` adapter hook (the dashboard
    // forwards the message to its connection-store addServerError banner); the
    // shared handlers own the message construction + console.warn.

    // mcp_servers — migrated to the shared dispatch table (#5556 slice 2)

    // cost_update — migrated to the shared dispatch table (#5618 Batch 5a;
    // handled by runDispatch before this switch). The dashboard applies only the
    // shared per-session sessionCost patch (it omits the app's setCostUpdate
    // flat/cost-store mirror).

    // session_usage / session_cost_threshold_crossed / dev_preview /
    // dev_preview_stopped — migrated to the shared dispatch table (#5556 slice 2)

    // -- Web tasks (Claude Code Web) --

    // web_task_created / web_task_updated — migrated to the shared dispatch
    // table (#5556 slice 4). Both were the byte-identical `sharedWebTaskUpsert`
    // → filter-and-append upsert (identical to the app's), now run by the table
    // via `_dispatchAdapter.updateState` (functional flat-state update).

    case 'web_task_error': {
      const { taskId: errTaskId, errorMessage, chatMessageContent } = sharedWebTaskError(msg);
      if (errTaskId) {
        // Update task status to failed
        set((state: ConnectionState) => ({
          webTasks: state.webTasks.map((t) =>
            t.taskId === errTaskId
              ? { ...t, status: 'failed' as const, error: errorMessage, updatedAt: Date.now() }
              : t,
          ),
        }));
      }
      // Show error as system message in chat. Build the ChatMessage here so
      // its id + timestamp are allocated after the task state update above.
      const errorMsg: ChatMessage = {
        id: nextMessageId('web'),
        type: 'system',
        content: chatMessageContent,
        timestamp: Date.now(),
      };
      const activeSid = get().activeSessionId;
      if (activeSid && get().sessionStates[activeSid]) {
        updateActiveSession((ss) => ({
          messages: [...ss.messages, errorMsg],
        }));
      } else {
        get().addMessage(errorMsg);
      }
      break;
    }

    // search_results — migrated to the shared dispatch table (#5618; runDispatch).
    // The staleness gate reads searchQuery via getSearchQuery; the dashboard has no
    // searchError / conversation-store mirror, so it omits applySearchResultsExtras.

    case 'log_entry': {
      const { entry } = sharedLogEntry(msg);
      set((state: ConnectionState) => ({
        logEntries: [...state.logEntries, entry].slice(-500),
      }));
      break;
    }

    case 'shell_pending_approval': {
      // #6277 — a user-shell spawn this client requested is HELD pending the
      // host operator's out-of-band approval (`chroxy shell approve <id>`).
      // Surface a one-time info toast so the requester knows it isn't stuck; the
      // normal session_switched confirms on approval, a session_error
      // (SHELL_APPROVAL_DENIED) arrives on deny, and it simply times out on
      // expiry. Dashboard-only for v1; mobile parity is deferred.
      const approvalId = typeof msg.approvalId === 'string' ? msg.approvalId : '';
      getStore()
        .getState()
        .addInfoNotification(
          `Shell pending host approval — run \`chroxy shell approve ${approvalId}\` on the host machine`,
        );
      break;
    }

    case 'session_warning': {
      const { sessionId: warnSessionId, message, systemMessage: warningMsg } =
        sharedSessionWarning(msg);
      if (warnSessionId && get().sessionStates[warnSessionId]) {
        const prevActiveId = get().activeSessionId;
        // Add warning to the target session's messages
        set((state: ConnectionState) => {
          const sess = state.sessionStates[warnSessionId]!;
          return {
            sessionStates: {
              ...state.sessionStates,
              [warnSessionId]: {
                ...sess,
                messages: [...sess.messages, warningMsg],
              },
            },
          };
        });
        // Also show console warning if the session isn't currently active
        if (prevActiveId !== warnSessionId) {
          _adapters.alert.alert('Session Warning', message);
        }
      } else {
        get().addMessage(warningMsg);
      }
      break;
    }

    case 'session_timeout': {
      const { sessionId: timeoutSessionId, name } = sharedSessionTimeout(msg);
      _adapters.alert.alert('Session Closed', `Session "${name}" was closed due to inactivity.`);
      if (timeoutSessionId) {
        // Clean up sessionStates entry for the destroyed session (#816)
        const { sessionStates, sessions } = get();
        const newStates = { ...sessionStates };
        delete newStates[timeoutSessionId];
        const newSessions = sessions.filter((s) => s.sessionId !== timeoutSessionId);
        const patch: Partial<ConnectionState> = { sessionStates: newStates, sessions: newSessions };
        // If the timed-out session was active, switch to next and sync flat fields (#816)
        if (get().activeSessionId === timeoutSessionId) {
          const remaining = Object.keys(newStates);
          const nextId = remaining.length > 0 ? remaining[0] : null;
          patch.activeSessionId = nextId;
          if (nextId && newStates[nextId]) {
            const ss = newStates[nextId];
            patch.messages = ss.messages;
            patch.streamingMessageId = ss.streamingMessageId;
            patch.claudeReady = ss.claudeReady;
            patch.activeModel = ss.activeModel;
            patch.permissionMode = ss.permissionMode;
            patch.contextUsage = ss.contextUsage;
            patch.lastResultCost = ss.lastResultCost;
            patch.lastResultDuration = ss.lastResultDuration;
            patch.isIdle = ss.isIdle;
          } else {
            // No sessions remain — clear flat fields
            patch.messages = [];
            patch.streamingMessageId = null;
            patch.claudeReady = false;
            patch.activeModel = null;
            patch.permissionMode = null;
            patch.contextUsage = null;
            patch.lastResultCost = null;
            patch.lastResultDuration = null;
            patch.isIdle = true;
          }
        }
        set(patch);
        // Garbage-collect persisted messages for the deleted session (#797)
        void clearPersistedSession(timeoutSessionId);
      }
      break;
    }

    // -- Environment messages --
    case 'environment_list': {
      const { environments } = sharedEnvironmentList(msg);
      set({ environments: environments as EnvironmentInfo[] });
      break;
    }
    case 'environment_created':
    case 'environment_destroyed':
    case 'environment_info':
      // Handled implicitly via the environment_list broadcast that follows
      break;
    case 'environment_error': {
      const { error } = sharedEnvironmentError(msg);
      console.error('[ws] Environment error:', error);
      break;
    }

    case 'error': {
      // Structured error response from a handler catch block.
      // Log it and surface it as a server error notification.
      // #4178: `fatal` is read off the typed parser return so dashboard
      // + app share a single normalised shape (no `msg.fatal` reach-in,
      // no per-client type guard, and a typo'd value can't silently
      // degrade severity).
      // #5039: `partialCost` carries the optional PR #5037 fold of
      // parent + Task subagent rounds completed before the error fired.
      // Pre-formatted with the shared helper so the dashboard toast and
      // mobile alert show identical wording.
      const { code: errCode, message: errMsg, fatal: errFatal, partialCost } = sharedError(msg);
      const partialCostLine = partialCost ? formatPartialCostLine(partialCost) : undefined;
      console.error(`[ws] Server handler error [${errCode}]: ${errMsg}`);
      // #3588: clear any in-flight skill_trust_grant whose requestId
      // matches this error envelope so the SkillsPanel "Pending review"
      // row's disabled state lifts. Without this, an INVALID_AUTHOR /
      // TRUST_NOT_ENABLED / TRUST_FLUSH_FAILED response would leave the
      // Trust button stuck "approving" forever and the operator would
      // have no way to retry. The helper is a no-op when the requestId
      // belongs to some other handler's request.
      const errReqId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (errReqId) {
        clearPendingTrustGrantByRequestId(errReqId, get);
      }
      // #5711 (Gap 2, client half): roll back the optimistic set_model when the
      // server says it never applied (MODEL_NOT_APPLIED — e.g. a mid-turn
      // change). Without this the dropdown keeps showing a model the session
      // never switched to. Mirror handleModelChanged's session-vs-flat write so
      // the revert lands exactly where the optimistic update did.
      if (errCode === 'MODEL_NOT_APPLIED' && errReqId) {
        const revert = consumePendingModelRevert(errReqId);
        if (revert) {
          if (revert.sessionId && get().sessionStates[revert.sessionId]) {
            updateSession(revert.sessionId, () => ({ activeModel: revert.previousModel }));
          } else {
            set({ activeModel: revert.previousModel });
          }
        }
      }
      // #5716: roll back the optimistic set_permission_mode when the server says
      // it never applied (PERMISSION_MODE_NOT_APPLIED — mid-turn or no-op). Mirror
      // setPermissionMode's session-vs-flat optimistic write so the revert lands
      // exactly where the optimistic update did. Critical for a rejected switch to
      // 'auto'/bypass: without it the dropdown shows bypass the session never entered.
      if (errCode === 'PERMISSION_MODE_NOT_APPLIED' && errReqId) {
        const revert = consumePendingPermissionModeRevert(errReqId);
        if (revert) {
          if (revert.sessionId && get().sessionStates[revert.sessionId]) {
            updateSession(revert.sessionId, () => ({ permissionMode: revert.previousMode }));
          } else {
            set({ permissionMode: revert.previousMode });
          }
          // #5722 review: also roll back the Shift+Tab toggle target. The
          // optimistic setPermissionMode overwrote previousPermissionMode with the
          // mode we tried to switch FROM (revert.previousMode); restore the value
          // it had before. Compare-and-swap on that exact value so a later
          // successful change (which re-set previousPermissionMode) is not clobbered.
          if (revert.priorPreviousMode !== undefined && get().previousPermissionMode === revert.previousMode) {
            set({ previousPermissionMode: revert.priorPreviousMode });
          }
        }
      }
      // #5731 T9: roll back the optimistic set_thinking_level when the server
      // says it never applied (THINKING_LEVEL_NOT_APPLIED — invalid level,
      // provider without thinking-level control, or a setThinkingLevel throw).
      // thinkingLevel is per-session only (no flat ConnectionState mirror, unlike
      // activeModel/permissionMode), so the revert writes to the session state —
      // matching setThinkingLevel's optimistic updateActiveSession write.
      if (errCode === 'THINKING_LEVEL_NOT_APPLIED' && errReqId) {
        const revert = consumePendingThinkingLevelRevert(errReqId);
        if (revert?.sessionId && get().sessionStates[revert.sessionId]) {
          updateSession(revert.sessionId, () => ({ thinkingLevel: (revert.previousLevel ?? 'default') as SessionState['thinkingLevel'] }));
        }
      }
      // #3570: skill_trust_grant INVALID_AUTHOR carries a structured
      // `actualAuthor` field (#3568, locked by
      // ServerSkillTrustGrantInvalidAuthorSchema) when the per-author
      // resolve landed on a different community author than the caller
      // claimed. Branch on the structured field instead of regex-parsing
      // the (intentionally unstable) human-readable `message`, so the
      // user sees a concrete "owned by alice" hint rather than the bare
      // server text. Other INVALID_AUTHOR variants (empty `author`
      // validation) do not include `actualAuthor` and fall through to
      // the plain message — see schema comment.
      const actualAuthor = typeof msg.actualAuthor === 'string' && msg.actualAuthor.length > 0
        ? msg.actualAuthor
        : null;
      // #3587: when the original `skill_trust_grant` request is still
      // tracked client-side (#3587 registerTrustGrantRequest), pair the
      // `requestId` with its remembered `skillName` so we can offer a
      // one-click recovery. The error wire shape carries `requestId` but
      // NOT `skillName` (per ServerSkillTrustGrantInvalidAuthorSchema),
      // so this is the only correlation path. Always consume the entry
      // even if we don't end up rendering an action — the request is
      // resolved either way and we don't want stale entries piling up.
      // `requestId` may be null on the wire (per protocol nullable), so
      // be defensive about the type.
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const pending = requestId !== null ? consumePendingTrustGrant(requestId) : null;
      let surfaced: string;
      let action: { label: string; onClick: () => void } | undefined;
      if (errCode === 'INVALID_AUTHOR' && actualAuthor !== null) {
        if (pending) {
          // We know the skillName and the corrected author — render an
          // actionable toast that re-issues skill_trust_grant on click.
          // The pending row for the real owner is still on the panel,
          // but a one-click retry is faster than scanning the list.
          const skillName = pending.skillName;
          surfaced = `Skill is owned by '${actualAuthor}', not '${pending.author}'. Try as ${actualAuthor}?`;
          action = {
            label: `Try as ${actualAuthor}`,
            onClick: () => {
              get().grantCommunitySkillTrust(skillName, actualAuthor);
            },
          };
        } else {
          // No tracked request (e.g. disconnect+reconnect dropped the
          // map, or a duplicate error fires after first consume). Fall
          // back to the #3570 text-only hint.
          surfaced = `Skill is owned by '${actualAuthor}'. Use the 'Trust ${actualAuthor}' button on the pending entry instead.`;
        }
      } else {
        surfaced = errMsg;
      }
      // #4148: non-fatal server signals (MAX_TOOL_ROUNDS_REACHED and any
      // future error envelope that sets fatal: false) render as warnings
      // — yellow toast, role=status, less alarming — instead of the
      // destructive red toast used for STREAM_ERROR / ABORT. The session
      // remains usable; the toast is informational. errCode-list lets us
      // keep the fatal: false check for future-proofing while still
      // catching codes that don't carry the flag.
      // #4178: `errFatal` is the typed (boolean | undefined) value from
      // sharedError. A typo on the wire ('fatal': 'false') resolves to
      // undefined, which falls back to the errCode-list — preserving
      // the loud red toast instead of silently degrading.
      const isNonFatal = errFatal === false || NON_FATAL_ERROR_CODES.has(errCode);
      const severity: 'error' | 'warning' = isNonFatal ? 'warning' : 'error';
      // #5039: thread the optional partial-cost sub-line through to the
      // store. addServerError keeps it undefined for every pre-#5037
      // error path so the existing toast layout is unchanged.
      get().addServerError(surfaced, action, severity, partialCostLine);
      break;
    }

    default: {
      // Log unknown message types when server protocol is newer (likely new features)
      const serverPV = getStore().getState().serverProtocolVersion;
      if (serverPV != null && serverPV > CLIENT_PROTOCOL_VERSION) {
        console.warn(`[ws] Unknown message type "${msg.type}" (server protocol v${serverPV}, client v${CLIENT_PROTOCOL_VERSION})`);
      }
      break;
    }
  }
}

/** @internal Exposed for testing only — same pattern as _testQueueInternals */
export const _testMessageHandler = {
  handle: handleMessage,
  setContext: (ctx: ConnectionContext) => { _connectionContext = ctx; },
  clearContext: () => { _connectionContext = null; },
};
