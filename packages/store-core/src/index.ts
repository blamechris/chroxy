/**
 * @chroxy/store-core — shared store logic for Chroxy app and dashboard.
 *
 * This package provides platform-agnostic interfaces and adapters
 * for the Zustand-based state management shared between the mobile
 * app (React Native) and web dashboard.
 *
 * Platform-specific behavior (alerts, haptics, push notifications,
 * storage) is injected via the PlatformAdapters interface.
 */

export { DEFAULT_CONTEXT_WINDOW } from './types'

export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  SavedConnection,
  ContextUsage,
  InputSettings,
  ModelInfo,
  SessionInfo,
  AgentInfo,
  ConnectedClient,
  SessionHealth,
  SessionContext,
  McpServer,
  DevPreview,
  WebTask,
  WebFeatureStatus,
  ConversationSummary,
  SearchResult,
  SlashCommand,
  CustomAgent,
  ConnectionPhase,
  ConnectionContext,
  QueuedMessage,
  Checkpoint,
  BaseSessionState,
} from './types'

export type {
  AlertAdapter,
  AlertButton,
  HapticAdapter,
  PlatformAdapters,
  PushAdapter,
  StorageAdapter,
} from './platform'

export {
  consoleAlert,
  noopHaptic,
  noopPush,
} from './platform'

export {
  createStorageAdapter,
  createAsyncStorageAdapter,
} from './storage'

export type {
  ParsedUserInput,
} from './user-input-handler'

export {
  parseUserInputMessage,
} from './user-input-handler'

export type {
  IncomingReplayEntry,
} from './replay-dedup'

export {
  isReplayDuplicate,
} from './replay-dedup'

export type {
  TokenType,
  Token,
  SyntaxRule,
  LanguageDef,
} from './syntax'

export {
  SYNTAX_COLORS,
  getLanguage,
  getSyntaxRules,
  tokenize,
  highlightCode,
} from './syntax'

export type {
  KeyPair,
  EncryptedEnvelope,
  EncryptionState,
} from './crypto'

export {
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
  initPRNG,
  createKeyPair,
  deriveSharedKey,
  nonceFromCounter,
  encrypt,
  decrypt,
  generateConnectionSalt,
  deriveConnectionKey,
} from './crypto'

export {
  stripAnsi,
  nextMessageId,
  withJitter,
  filterThinking,
  createEmptyBaseSessionState,
} from './utils'

export type {
  StreamIdResult,
} from './stream-id'

export {
  resolveStreamId,
} from './stream-id'

export {
  PROVIDER_LABELS,
  getProviderLabel,
  getProviderInfo,
} from './provider-labels'

export type {
  ProviderType,
  ProviderInfo,
} from './provider-labels'

export type {
  SessionPatch,
  PermissionMode,
  ThinkingLevel,
} from './handlers'

export {
  resolveSessionId,
  handleModelChanged,
  handlePermissionModeChanged,
  handleAvailablePermissionModes,
  handleSessionUpdated,
  handleClaudeReady,
  handleAgentIdle,
  handleAgentBusy,
  handleThinkingLevelChanged,
  handleBudgetWarning,
  handleBudgetExceeded,
  handleBudgetResumed,
} from './handlers'
