/**
 * MCP tool name parsing utilities.
 *
 * Claude Code names MCP-provided tools using the convention:
 *   mcp__<server_name>__<tool_name>
 *
 * Built-in tools use simple names like "Bash", "Read", "Edit".
 */

const MCP_PREFIX = 'mcp__'

/**
 * Parse an MCP tool name into its server and tool components.
 *
 * @param {string} toolName - The tool name from a content_block_start event
 * @returns {{ serverName: string, toolName: string } | null} - Parsed parts, or null for built-in tools
 */
export function parseMcpToolName(toolName) {
  if (!toolName || !toolName.startsWith(MCP_PREFIX)) return null

  const rest = toolName.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep === -1 || sep === 0) return null

  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  }
}

/**
 * Get a display-friendly tool label.
 * For MCP tools: "server:tool_name"
 * For built-in tools: the name as-is
 *
 * @param {string} toolName - The raw tool name
 * @returns {string}
 */
export function formatToolDisplay(toolName) {
  const parsed = parseMcpToolName(toolName)
  if (parsed) return `${parsed.serverName}:${parsed.toolName}`
  return toolName
}
