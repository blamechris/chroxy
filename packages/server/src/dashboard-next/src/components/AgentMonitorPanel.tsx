/**
 * AgentMonitorPanel — live view of active subagents in the current session.
 *
 * Shows:
 * - Active agent cards with description and elapsed time
 * - Empty state when no agents are running
 * - Auto-updates elapsed time every second
 */
import { useState, useEffect } from 'react'
import { useConnectionStore } from '../store/connection'
import type { AgentInfo } from '../store/types'

function formatElapsed(startedAt: number): string {
  const diff = Math.max(0, Date.now() - startedAt)
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return `${mins}m ${remSecs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

function AgentCard({ agent }: { agent: AgentInfo }) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(agent.startedAt))

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(formatElapsed(agent.startedAt))
    }, 1000)
    return () => clearInterval(timer)
  }, [agent.startedAt])

  return (
    <div className="agent-card" data-testid="agent-card">
      <div className="agent-card-header">
        <span className="agent-pulse" />
        <span className="agent-id" title={agent.toolUseId}>
          {agent.toolUseId.slice(0, 12)}
        </span>
        <span className="agent-elapsed">{elapsed}</span>
      </div>
      <div className="agent-description">{agent.description}</div>
    </div>
  )
}

export function AgentMonitorPanel() {
  const activeAgents = useConnectionStore(s => {
    const sid = s.activeSessionId
    if (!sid || !s.sessionStates[sid]) return []
    return s.sessionStates[sid].activeAgents
  })

  return (
    <div className="agent-monitor-panel" data-testid="agent-monitor-panel">
      <div className="agent-monitor-header">
        <span className="agent-monitor-title">
          Active Agents
          {activeAgents.length > 0 && (
            <span className="agent-count">{activeAgents.length}</span>
          )}
        </span>
      </div>
      <div className="agent-monitor-body">
        {activeAgents.length === 0 ? (
          <div className="agent-empty" data-testid="agent-empty">
            No agents currently running.
          </div>
        ) : (
          activeAgents.map(agent => (
            <AgentCard key={agent.toolUseId} agent={agent} />
          ))
        )}
      </div>
    </div>
  )
}
