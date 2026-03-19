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
  onDestroy: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

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
          <button
            className="btn-env-destroy"
            onClick={() => setConfirming(true)}
            disabled={env.sessions.length > 0}
            title={env.sessions.length > 0 ? 'Disconnect all sessions first' : 'Destroy environment'}
          >
            Destroy
          </button>
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
