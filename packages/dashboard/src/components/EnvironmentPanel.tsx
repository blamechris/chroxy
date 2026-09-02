import { useState, useEffect } from 'react'
import { useConnectionStore } from '../store/connection'
import { useShallow } from 'zustand/react/shallow'
import type { EnvironmentInfo } from '../store/types'

const STATUS_COLORS: Record<string, string> = {
  running: 'var(--status-running, #22c55e)',
  stopped: 'var(--status-stopped, #eab308)',
  error: 'var(--status-error, #ef4444)',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className="env-status-badge"
      style={{ color: STATUS_COLORS[status] || 'var(--text-secondary)' }}
    >
      {status}
    </span>
  )
}

function EnvironmentCard({
  env,
  onDestroy,
}: {
  env: EnvironmentInfo
  /**
   * #7568: `force` cascades — the plain path (`force` omitted) sends a normal
   * destroy that the server refuses when sessions are live; only the
   * live-session confirm below passes `force: true`.
   */
  onDestroy: (id: string, force?: boolean) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const liveSessions = env.sessions.length > 0

  return (
    <div className="env-card">
      <div className="env-card-header">
        <span className="env-card-name">{env.name}</span>
        <StatusBadge status={env.status} />
      </div>
      <div className="env-card-details">
        <div className="env-card-row">
          <span className="env-card-label">Image</span>
          <span className="env-card-value">{env.image}</span>
        </div>
        <div className="env-card-row">
          <span className="env-card-label">CWD</span>
          <span className="env-card-value">{env.cwd}</span>
        </div>
        <div className="env-card-row">
          <span className="env-card-label">Resources</span>
          <span className="env-card-value">{env.memoryLimit} RAM, {env.cpuLimit} CPU</span>
        </div>
        <div className="env-card-row">
          <span className="env-card-label">Sessions</span>
          <span className="env-card-value">{env.sessions.length} connected</span>
        </div>
        <div className="env-card-row">
          <span className="env-card-label">Container</span>
          <span className="env-card-value" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.85em' }}>
            {env.containerId?.slice(0, 12) || 'n/a'}
          </span>
        </div>
      </div>
      <div className="env-card-actions">
        {!confirming ? (
          // #7568: no longer flatly disabled while sessions are live (the old
          // `disabled={env.sessions.length > 0}` was a dead end — the operator
          // could not escalate, and the server refuses the send anyway). Destroy
          // now always opens a confirm; the live-session branch offers the
          // `force` cascade.
          <button
            className="btn-env-destroy"
            onClick={() => setConfirming(true)}
            title={liveSessions ? 'Destroy — will prompt to force-close live sessions' : 'Destroy environment'}
          >
            Destroy
          </button>
        ) : liveSessions ? (
          // Live-session refusal path: NAME the sessions and offer the cascade.
          <div className="env-confirm-row" data-testid={`env-force-confirm-${env.id}`}>
            <span>
              {env.sessions.length} live session{env.sessions.length === 1 ? '' : 's'} running
              {' '}({env.sessions.join(', ')}). Force destroy will end {env.sessions.length === 1 ? 'it' : 'them'} first.
            </span>
            <button
              className="btn-env-force"
              data-testid={`env-force-destroy-${env.id}`}
              onClick={() => { onDestroy(env.id, true); setConfirming(false) }}
            >
              Force destroy
            </button>
            <button className="btn-env-confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <div className="env-confirm-row">
            <span>Destroy this environment?</span>
            <button className="btn-env-confirm-yes" onClick={() => onDestroy(env.id)}>Yes</button>
            <button className="btn-env-confirm-no" onClick={() => setConfirming(false)}>No</button>
          </div>
        )}
      </div>
    </div>
  )
}

function CreateEnvironmentForm({ onClose }: { onClose: () => void }) {
  const createEnvironment = useConnectionStore(s => s.createEnvironment)
  const sessionCwd = useConnectionStore(s => s.sessionCwd)

  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(sessionCwd || '')
  const [image, setImage] = useState('')
  const [memoryLimit, setMemoryLimit] = useState('')
  const [cpuLimit, setCpuLimit] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !cwd.trim()) return
    createEnvironment({
      name: name.trim(),
      cwd: cwd.trim(),
      image: image.trim() || undefined,
      memoryLimit: memoryLimit.trim() || undefined,
      cpuLimit: cpuLimit.trim() || undefined,
    })
    onClose()
  }

  return (
    <form className="env-create-form" onSubmit={handleSubmit}>
      <div className="env-form-field">
        <label htmlFor="env-name">Name</label>
        <input
          id="env-name"
          type="text"
          placeholder="my-project"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div className="env-form-field">
        <label htmlFor="env-cwd">Working Directory</label>
        <input
          id="env-cwd"
          type="text"
          placeholder="/home/user/project"
          value={cwd}
          onChange={e => setCwd(e.target.value)}
        />
      </div>
      <div className="env-form-field">
        <label htmlFor="env-image">Docker Image</label>
        <input
          id="env-image"
          type="text"
          placeholder="node:22-slim (default)"
          value={image}
          onChange={e => setImage(e.target.value)}
        />
      </div>
      <div className="env-form-row">
        <div className="env-form-field">
          <label htmlFor="env-memory">Memory</label>
          <input
            id="env-memory"
            type="text"
            placeholder="2g (default)"
            value={memoryLimit}
            onChange={e => setMemoryLimit(e.target.value)}
          />
        </div>
        <div className="env-form-field">
          <label htmlFor="env-cpu">CPUs</label>
          <input
            id="env-cpu"
            type="text"
            placeholder="2 (default)"
            value={cpuLimit}
            onChange={e => setCpuLimit(e.target.value)}
          />
        </div>
      </div>
      <div className="env-form-buttons">
        <button type="button" className="btn-env-cancel" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-env-create" disabled={!name.trim() || !cwd.trim()}>
          Create Environment
        </button>
      </div>
    </form>
  )
}

export function EnvironmentPanel() {
  const environments = useConnectionStore(useShallow(s => s.environments))
  const requestEnvironments = useConnectionStore(s => s.requestEnvironments)
  const destroyEnvironment = useConnectionStore(s => s.destroyEnvironment)
  const connectionPhase = useConnectionStore(s => s.connectionPhase)

  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    if (connectionPhase === 'connected') {
      requestEnvironments()
    }
  }, [connectionPhase, requestEnvironments])

  return (
    <div className="environment-panel">
      <div className="env-panel-header">
        <h2>Environments</h2>
        <button className="btn-env-new" onClick={() => setShowCreate(true)}>
          + New Environment
        </button>
      </div>

      {showCreate && (
        <CreateEnvironmentForm onClose={() => setShowCreate(false)} />
      )}

      {environments.length === 0 && !showCreate && (
        <div className="env-empty">
          <p>No persistent environments.</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>
            Environments are long-lived Docker containers that outlive sessions.
            Create one to avoid reinstalling dependencies on every session restart.
          </p>
        </div>
      )}

      <div className="env-grid">
        {environments.map(env => (
          <EnvironmentCard
            key={env.id}
            env={env}
            onDestroy={destroyEnvironment}
          />
        ))}
      </div>
    </div>
  )
}
