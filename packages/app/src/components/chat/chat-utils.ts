/**
 * Format a tool name for display. MCP tools show as "tool_name" with server noted separately.
 * Duplicates the mcp__ prefix parsing from mcp-tools.js as a client-side fallback in case
 * the raw tool name arrives without a pre-extracted serverName.
 */
const MCP_PREFIX = 'mcp__';

export function formatToolName(tool?: string): string {
  if (!tool) return 'Thinking';
  if (tool.startsWith(MCP_PREFIX)) {
    const rest = tool.slice(MCP_PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep > 0) return rest.slice(sep + 2);
  }
  return tool;
}
