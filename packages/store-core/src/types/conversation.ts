/**
 * Conversation history, search, slash-command and custom-agent inventory types.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

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
  /**
   * Origin of the command.
   * - `builtin`: provider-baked (e.g. `/clear`, `/compact`, `/model`) — see
   *   packages/server/src/builtin-commands.js. Always rendered with a "built-in" badge
   *   and pinned above project/user entries in the picker (#3856).
   * - `project`: markdown file in `<cwd>/.claude/commands/`.
   * - `user`: markdown file in `~/.claude/commands/`.
   * - `mcp`: a prompt advertised by a connected MCP server, invoked as
   *   `/mcp__<server>__<prompt>` (#6823). BYOK sessions only.
   */
  source: 'builtin' | 'project' | 'user' | 'mcp';
}

export interface CustomAgent {
  name: string;
  description: string;
  source: 'project' | 'user';
}
