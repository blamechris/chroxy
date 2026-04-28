/**
 * Shared protocol and message types used by both the mobile app and web dashboard.
 *
 * These types represent the wire protocol between the Chroxy server and its clients.
 * Platform-specific types (SessionState, ConnectionState) remain in each consumer.
 */

/** Attachment metadata stored on a ChatMessage (base64 data cleared after send) */
export interface MessageAttachment {
  id: string;
  type: 'image' | 'document';
  uri: string;
  name: string;
  mediaType: string;
  size: number;
}

/** Base64 image from a tool result (e.g. computer use screenshots) */
export interface ToolResultImage {
  mediaType: string;
  data: string;
}

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking' | 'prompt' | 'error' | 'system';
  content: string;
  tool?: string;
  options?: { label: string; value: string }[];
  requestId?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  toolResultTruncated?: boolean;
  /** Base64 images from tool results (e.g. computer use screenshots) */
  toolResultImages?: ToolResultImage[];
  answered?: string;
  /** Timestamp when the user answered a permission prompt */
  answeredAt?: number;
  expiresAt?: number;
  timestamp: number;
  /** Attachments on user_input messages (images, documents) */
  attachments?: MessageAttachment[];
  /** MCP server name (for tool_use messages from MCP tools) */
  serverName?: string;
}

export interface SavedConnection {
  url: string;
  token: string;
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface InputSettings {
  chatEnterToSend: boolean;
  terminalEnterToSend: boolean;
}

/** Default context window size (tokens) used when model metadata doesn't specify one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ModelInfo {
  id: string;
  label: string;
  fullId: string;
  contextWindow?: number;
}

export interface SessionInfo {
  sessionId: string;
  name: string;
  cwd: string;
  type: 'cli';
  hasTerminal: boolean;
  model: string | null;
  permissionMode: string | null;
  isBusy: boolean;
  createdAt: number;
  conversationId: string | null;
  provider?: string;
  worktree?: boolean;
}

export interface AgentInfo {
  toolUseId: string;
  description: string;
  startedAt: number;
}

export interface ConnectedClient {
  clientId: string;
  deviceName: string | null;
  deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown';
  platform: string;
  isSelf: boolean;
}

export type SessionHealth = 'healthy' | 'crashed';

export interface SessionContext {
  gitBranch: string | null;
  gitDirty: number;
  gitAhead: number;
  projectName: string | null;
}

export interface McpServer {
  name: string;
  status: string;
}

/**
 * Server-emitted error captured for the notification/toast UI.
 *
 * Produced by the shared `handleServerError` helper from a `server_error`
 * message. Callers slice an array of these into their `serverErrors` state
 * (typically capped at the most recent 10 entries).
 */
export interface ServerError {
  id: string;
  category: 'tunnel' | 'session' | 'permission' | 'general';
  message: string;
  recoverable: boolean;
  timestamp: number;
  /** Set when the server scoped the error to a specific session. */
  sessionId?: string;
}

export interface DevPreview {
  port: number;
  url: string;
}

export interface WebTask {
  taskId: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  result: string | null;
  error: string | null;
}

export interface WebFeatureStatus {
  available: boolean;
  remote: boolean;
  teleport: boolean;
}

export interface ConversationSummary {
  conversationId: string;
  project: string | null;
  projectName: string;
  modifiedAt: string;
  modifiedAtMs: number;
  sizeBytes: number;
  preview: string | null;
  cwd: string | null;
}

export interface SearchResult {
  conversationId: string;
  projectName: string;
  project: string | null;
  cwd: string | null;
  preview: string | null;
  snippet: string;
  matchCount: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  source: 'project' | 'user';
}

export interface CustomAgent {
  name: string;
  description: string;
  source: 'project' | 'user';
}

export type ConnectionPhase =
  | 'disconnected'        // Not connected, no auto-reconnect
  | 'connecting'          // Initial connection attempt
  | 'connected'           // WebSocket open + authenticated
  | 'reconnecting'        // Auto-reconnecting after unexpected disconnect
  | 'server_restarting';  // Health check returns { status: 'restarting' }

/** Context captured from connect() closure for use by the extracted handleMessage(). */
export interface ConnectionContext {
  url: string;
  token: string;
  isReconnect: boolean;
  silent: boolean;
  socket: WebSocket;
}

/** Queued message for offline send buffer */
export interface QueuedMessage {
  type: string;
  payload: unknown;
  queuedAt: number;
  maxAge: number;
}

export interface Checkpoint {
  id: string;
  name: string;
  description: string;
  messageCount: number;
  createdAt: number;
  hasGitSnapshot: boolean;
}

/**
 * Base session state shared by both the mobile app and web dashboard.
 *
 * Each consumer extends this with platform-specific fields:
 * - App adds: activityState, sessionRules
 * - Dashboard adds: terminalRawBuffer, selectedFilePath, thinkingLevel
 */
export interface BaseSessionState {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  claudeReady: boolean;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  sessionCost: number | null;
  isIdle: boolean;
  health: SessionHealth;
  activeAgents: AgentInfo[];
  isPlanPending: boolean;
  planAllowedPrompts: { tool: string; prompt: string }[];
  primaryClientId: string | null;
  conversationId: string | null;
  sessionContext: SessionContext | null;
  mcpServers: McpServer[];
  devPreviews: DevPreview[];
}
