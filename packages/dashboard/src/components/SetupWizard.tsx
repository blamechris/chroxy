/**
 * SetupWizard — desktop first-run setup panel (#6787).
 *
 * Wires the three orphaned Tauri commands (`get_setup_state`,
 * `check_dependencies`, `save_setup_config`) to a minimal onboarding UI. On
 * mount inside the Tauri shell, checks whether this is a first run; if so,
 * shows a blocking panel with a dependency checklist (Node 22 / cloudflared
 * / claude CLI) and the port + tunnel-mode choices `save_setup_config`
 * expects. Finishing saves the config (which clears the Rust-side
 * `IS_FIRST_RUN` flag so the panel never shows again) and starts the
 * embedded server, same as the existing "Start Server" affordance.
 *
 * Entirely self-contained: renders `null` outside Tauri (zero behavior
 * change for the plain web dashboard) and `null` once setup is complete, so
 * it can be mounted unconditionally at the top of <App/>.
 */
import { useCallback, useEffect, useState } from 'react'
import { isTauri } from '../utils/tauri'
import {
  checkDependencies,
  getSetupState,
  saveSetupConfig,
  startServer,
  type DependencyCheckResult,
} from '../hooks/useTauriIPC'
import './SetupWizard.css'

const TUNNEL_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: 'None — local network only' },
  { value: 'quick', label: 'Quick — random public URL, no account needed' },
  { value: 'named', label: 'Named — stable URL, requires a Cloudflare account' },
]

type DepStatus = 'checking' | 'unknown' | 'pass' | 'fail'

interface DependencyRowProps {
  testId: string
  label: string
  found?: boolean
  detail?: string | null
  hint: string
  checking: boolean
}

function DependencyRow({ testId, label, found, detail, hint, checking }: DependencyRowProps) {
  const status: DepStatus = checking
    ? 'checking'
    : found === undefined
      ? 'unknown'
      : found
        ? 'pass'
        : 'fail'
  const icon = status === 'checking' ? '…' : status === 'pass' ? '✓' : status === 'unknown' ? '?' : '✕'
  return (
    <li className={`setup-wizard-dep-row setup-wizard-dep-row--${status}`} data-testid={testId}>
      <span className="setup-wizard-dep-icon" aria-hidden="true">{icon}</span>
      <span className="setup-wizard-dep-label">
        {label}
        {detail ? <span className="setup-wizard-dep-detail"> ({detail})</span> : null}
      </span>
      {(status === 'fail' || status === 'unknown') && (
        <span className="setup-wizard-dep-hint">{hint}</span>
      )}
    </li>
  )
}

export function SetupWizard() {
  // Whether we've resolved get_setup_state yet — avoids a flash of the
  // panel (or of nothing) before we know if this is actually a first run.
  const [resolved, setResolved] = useState(false)
  const [visible, setVisible] = useState(false)
  const [port, setPort] = useState(8765)
  const [tunnelMode, setTunnelMode] = useState('none')
  const [deps, setDeps] = useState<DependencyCheckResult | null>(null)
  const [depsChecking, setDepsChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const runDependencyCheck = useCallback(() => {
    setDepsChecking(true)
    checkDependencies()
      .then((result) => setDeps(result))
      .finally(() => setDepsChecking(false))
  }, [])

  useEffect(() => {
    if (!isTauri()) {
      setResolved(true)
      return
    }
    let cancelled = false
    getSetupState().then((state) => {
      if (cancelled) return
      setResolved(true)
      if (state?.isFirstRun) {
        setVisible(true)
        setPort(state.port || 8765)
        setTunnelMode(state.tunnelMode || 'none')
        runDependencyCheck()
      }
    })
    return () => {
      cancelled = true
    }
  }, [runDependencyCheck])

  const handleFinish = useCallback(() => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    saveSetupConfig(port, tunnelMode)
      .then(() => {
        setVisible(false)
        // Mirrors App's handleStartServer — fire-and-forget; useTauriEvents
        // already listens for server_ready/server_error and reconciles the
        // connection store once the embedded server actually comes up.
        startServer()
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to save setup configuration.')
      })
      .finally(() => setSaving(false))
  }, [port, tunnelMode, saving])

  if (!isTauri() || !resolved || !visible) return null

  return (
    <div className="setup-wizard-overlay" data-testid="setup-wizard">
      <div
        className="setup-wizard-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-wizard-title"
      >
        <h2 id="setup-wizard-title" className="setup-wizard-title">Welcome to Chroxy</h2>
        <p className="setup-wizard-subtitle">
          Let&apos;s check your setup before the daemon starts.
        </p>

        <section className="setup-wizard-section">
          <div className="setup-wizard-section-header">
            <h3>Dependencies</h3>
            <button
              type="button"
              className="setup-wizard-recheck-btn"
              onClick={runDependencyCheck}
              disabled={depsChecking}
              data-testid="setup-wizard-recheck"
            >
              {depsChecking ? 'Checking…' : 'Re-check'}
            </button>
          </div>
          <ul className="setup-wizard-dep-list">
            <DependencyRow
              testId="setup-wizard-dep-node"
              label="Node 22"
              found={deps?.node22.found}
              detail={deps?.node22.version}
              hint="Install Node 22 from nodejs.org, nvm, or Homebrew."
              checking={depsChecking}
            />
            <DependencyRow
              testId="setup-wizard-dep-cloudflared"
              label="cloudflared"
              found={deps?.cloudflared.found}
              hint="Install with: brew install cloudflared"
              checking={depsChecking}
            />
            <DependencyRow
              testId="setup-wizard-dep-claude"
              label="Claude CLI"
              found={deps?.claude.found}
              detail={deps?.claude.version}
              hint="Install with: npm install -g @anthropic-ai/claude-code"
              checking={depsChecking}
            />
          </ul>
        </section>

        <section className="setup-wizard-section">
          <h3>Configuration</h3>
          <label className="setup-wizard-field">
            <span>Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 0)}
              data-testid="setup-wizard-port"
            />
          </label>
          <label className="setup-wizard-field">
            <span>Tunnel mode</span>
            <select
              value={tunnelMode}
              onChange={(e) => setTunnelMode(e.target.value)}
              data-testid="setup-wizard-tunnel-mode"
            >
              {TUNNEL_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        </section>

        {saveError && (
          <div className="setup-wizard-error" role="alert" data-testid="setup-wizard-error">
            {saveError}
          </div>
        )}

        <div className="setup-wizard-actions">
          <button
            type="button"
            className="setup-wizard-finish-btn"
            onClick={handleFinish}
            disabled={saving || port < 1 || port > 65535}
            data-testid="setup-wizard-finish"
          >
            {saving ? 'Saving…' : 'Finish setup'}
          </button>
        </div>
      </div>
    </div>
  )
}
