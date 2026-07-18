/**
 * SidebarMcpView (#6820) — MCP server list in the sidebar panel slot.
 *
 * The desktop analogue of the mobile app's `SettingsBar.tsx` "MCP Servers (N)"
 * section: it renders the active session's `mcpServers` store field (already
 * carried in `connection.ts`, written by the `mcp_servers` broadcast handler)
 * as a status dot + name + status text per server.
 *
 * Status semantics mirror the mobile pattern: the dot is green only when a
 * server reports `connected` (a live status from an sdk/cli-mode session),
 * muted otherwise. claude-tui-mode sessions report `configured` (the config
 * declares the server but the PTY exposes no live connection status), which
 * renders muted — honest about the difference between "connected" and
 * "declared in config".
 *
 * #6824 — per-server enable/disable toggle. Rendered ONLY when the server
 * reports `canToggle` (the BYOK lane, which runs an in-daemon MCP fleet);
 * sdk/cli/tui servers stay read-only. Toggling sends `set_mcp_server_enabled`;
 * the switch is broadcast-driven (it reflects the server's re-emitted
 * `mcp_servers` state, not an optimistic guess), so a rejected toggle simply
 * never moves rather than flashing a wrong state.
 */
import { useConnectionStore } from '../store/connection'
import type { McpServer } from '@chroxy/store-core'

// Module-level stable empty array so the store selector's fallback keeps a
// referentially-stable identity (avoids needless re-renders / render loops).
const EMPTY_MCP_SERVERS: McpServer[] = []

// #6824: a server is "on" when it isn't parked. Prefer the explicit `enabled`
// flag (BYOK emits it); fall back to the status so a pre-#6824 payload (no
// `enabled`) still reads sensibly.
function isServerEnabled(server: McpServer): boolean {
  if (typeof server.enabled === 'boolean') return server.enabled
  return server.status !== 'disabled'
}

export interface SidebarMcpViewProps {
  /**
   * Server list override (defaults to the active session's `mcpServers`). The
   * parent Sidebar already selects this for the collapsed-header metric, so it
   * passes the same array here to avoid a second store subscription; tests pass
   * a fixture directly.
   */
  servers?: McpServer[]
}

export function SidebarMcpView({ servers: serversProp }: SidebarMcpViewProps = {}) {
  const storeServers = useConnectionStore((s) => {
    const id = s.activeSessionId
    return id && s.sessionStates[id] ? s.sessionStates[id].mcpServers : EMPTY_MCP_SERVERS
  })
  const setMcpServerEnabled = useConnectionStore((s) => s.setMcpServerEnabled)
  const servers = serversProp ?? storeServers

  return (
    <div className="sidebar-mcp-view" data-testid="sidebar-mcp-view">
      {servers.length === 0 ? (
        <div className="sidebar-mcp-view-empty" data-testid="sidebar-mcp-view-empty">
          No MCP servers
        </div>
      ) : (
        <ul className="sidebar-mcp-view-list" data-testid="sidebar-mcp-view-list">
          {servers.map((server) => {
            const connected = server.status === 'connected'
            const enabled = isServerEnabled(server)
            return (
              <li
                key={server.name}
                className="sidebar-mcp-view-row"
                data-testid={`sidebar-mcp-view-row-${server.name}`}
              >
                <span
                  className={`sidebar-mcp-view-dot${connected ? ' connected' : ''}`}
                  data-testid={`sidebar-mcp-view-dot-${server.name}`}
                  data-status={server.status}
                  aria-hidden="true"
                />
                <span className="sidebar-mcp-view-name" data-testid={`sidebar-mcp-view-name-${server.name}`}>
                  {server.name}
                </span>
                <span className="sidebar-mcp-view-status" data-testid={`sidebar-mcp-view-status-${server.name}`}>
                  {server.status}
                </span>
                {server.canToggle && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    className={`sidebar-mcp-view-toggle${enabled ? ' enabled' : ''}`}
                    data-testid={`sidebar-mcp-view-toggle-${server.name}`}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} MCP server ${server.name}`}
                    title={enabled ? 'Disable server' : 'Enable server'}
                    onClick={() => setMcpServerEnabled(server.name, !enabled)}
                  >
                    {enabled ? 'On' : 'Off'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Collapsed-panel header metric for the MCP view — mirrors
 * `tokenViewCollapsedMetric`. Shows the configured/connected server count so a
 * user with the panel collapsed still sees at-a-glance MCP presence.
 */
export function mcpViewCollapsedMetric(servers: McpServer[]): string {
  if (servers.length === 0) return 'No MCP'
  return `${servers.length} server${servers.length === 1 ? '' : 's'}`
}
