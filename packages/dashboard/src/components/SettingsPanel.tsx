/**
 * SettingsPanel — slide-out panel with theme picker and session defaults.
 *
 * Triggered via gear icon in header or Cmd+,. Changes apply instantly
 * and persist to localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import { getAvailableThemes, applyTheme } from '../theme/theme-engine'
import { getThemeById } from '../theme/themes'
import type { ThemeDefinition } from '../theme/themes'
import { PROVIDER_LABELS } from '../lib/provider-labels'
import { isTauri } from '../utils/tauri'
import { getTunnelMode, setTunnelMode } from '../hooks/useTauriIPC'

export interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  showConsoleTab?: boolean
  onToggleConsoleTab?: (show: boolean) => void
}

/** Preview swatches for a theme */
function ThemeSwatches({ theme }: { theme: ThemeDefinition }) {
  const bg = theme.colors['bg-primary'] || '#0f0f1a'
  const accent = theme.colors['accent-blue'] || '#4a9eff'
  const text = theme.colors['text-primary'] || '#ffffff'
  const termBg = theme.terminal.background
  const termFg = theme.terminal.foreground

  return (
    <div className="theme-swatches">
      <span className="theme-swatch" style={{ backgroundColor: bg }} title="Background" />
      <span className="theme-swatch" style={{ backgroundColor: accent }} title="Accent" />
      <span className="theme-swatch" style={{ backgroundColor: text }} title="Text" />
      <span className="theme-swatch" style={{ backgroundColor: termBg, border: `1px solid ${termFg}` }} title="Terminal" />
      <span className="theme-swatch" style={{ backgroundColor: termFg }} title="Terminal text" />
    </div>
  )
}

export function SettingsPanel({ isOpen, onClose, showConsoleTab, onToggleConsoleTab }: SettingsPanelProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const activeTheme = useConnectionStore(s => s.activeTheme)
  const setTheme = useConnectionStore(s => s.setTheme)
  const defaultProvider = useConnectionStore(s => s.defaultProvider)
  const setDefaultProvider = useConnectionStore(s => s.setDefaultProvider)
  const defaultModel = useConnectionStore(s => s.defaultModel)
  const setDefaultModel = useConnectionStore(s => s.setDefaultModel)
  const availableModels = useConnectionStore(s => s.availableModels ?? [])
  const availableProviders = useConnectionStore(s => s.availableProviders ?? [])
  const inputSettings = useConnectionStore(s => s.inputSettings)
  const updateInputSettings = useConnectionStore(s => s.updateInputSettings)
  const themes = getAvailableThemes()
  const inTauri = isTauri()
  const [tunnelMode, setTunnelModeState] = useState<string>('none')
  const [tunnelError, setTunnelError] = useState<string | null>(null)

  // Load tunnel mode from Tauri settings on open and clear stale errors
  useEffect(() => {
    if (!isOpen || !inTauri) return
    setTunnelError(null)
    getTunnelMode().then(mode => {
      if (mode) setTunnelModeState(mode)
    })
  }, [isOpen, inTauri])

  const handleTunnelModeChange = useCallback(async (mode: string) => {
    setTunnelError(null)
    const previousMode = tunnelMode
    setTunnelModeState(mode)
    try {
      await setTunnelMode(mode)
    } catch (err) {
      // Revert to actual saved mode, or previous mode as fallback
      const actual = await getTunnelMode()
      setTunnelModeState(actual ?? previousMode)
      setTunnelError(err instanceof Error ? err.message : String(err))
    }
  }, [tunnelMode])

  // Normalize: if persisted defaultProvider isn't in server's list, use first available
  const effectiveProvider = useMemo(() => {
    if (availableProviders.length > 0 && !availableProviders.some(p => p.name === defaultProvider)) {
      return availableProviders[0]!.name
    }
    return defaultProvider
  }, [availableProviders, defaultProvider])

  const handleSelectTheme = useCallback((themeId: string) => {
    setTheme(themeId)
    applyTheme(getThemeById(themeId))
  }, [setTheme])

  const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDefaultProvider(e.target.value)
  }, [setDefaultProvider])

  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDefaultModel(e.target.value)
  }, [setDefaultModel])

  const handleSendShortcutChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateInputSettings({ chatEnterToSend: e.target.value === 'enter' })
  }, [updateInputSettings])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const overlays = document.querySelectorAll('[data-modal-overlay]')
        if (overlays.length > 0 && overlays[overlays.length - 1] === backdropRef.current) {
          e.preventDefault()
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <>
      <div ref={backdropRef} className="settings-backdrop" data-modal-overlay onClick={onClose} />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close settings" type="button">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="theme-grid">
              {themes.map(theme => (
                <button
                  key={theme.id}
                  className={`theme-card${activeTheme === theme.id ? ' active' : ''}`}
                  onClick={() => handleSelectTheme(theme.id)}
                  type="button"
                  aria-pressed={activeTheme === theme.id}
                >
                  <ThemeSwatches theme={theme} />
                  <span className="theme-card-name">{theme.name}</span>
                  <span className="theme-card-desc">{theme.description}</span>
                  {activeTheme === theme.id && (
                    <span className="theme-card-check" aria-hidden="true">&#10003;</span>
                  )}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>Session Defaults</h3>
            <div className="settings-field">
              <label htmlFor="default-provider">Default provider</label>
              <select
                id="default-provider"
                aria-label="Default provider"
                value={effectiveProvider}
                onChange={handleProviderChange}
              >
                {availableProviders.length > 0
                  ? availableProviders.map(p => (
                      <option key={p.name} value={p.name}>
                        {PROVIDER_LABELS[p.name] || p.name}
                      </option>
                    ))
                  : <>
                      <option value="claude-sdk">Claude Code (SDK)</option>
                      <option value="claude-cli">Claude Code (CLI)</option>
                    </>
                }
              </select>
            </div>
            {availableModels.length > 0 && (
              <div className="settings-field">
                <label htmlFor="default-model">Default model</label>
                <select
                  id="default-model"
                  aria-label="Default model"
                  value={defaultModel}
                  onChange={handleModelChange}
                >
                  <option value="">Server default</option>
                  {availableModels.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="settings-field">
              <label htmlFor="send-shortcut">Send message with</label>
              <select
                id="send-shortcut"
                aria-label="Send shortcut"
                value={inputSettings.chatEnterToSend ? 'enter' : 'cmd-enter'}
                onChange={handleSendShortcutChange}
              >
                <option value="enter">Enter</option>
                <option value="cmd-enter">Cmd/Ctrl+Enter</option>
              </select>
            </div>
          </section>

          {onToggleConsoleTab && (
            <section className="settings-section">
              <h3>Dashboard</h3>
              <div className="settings-field">
                <label htmlFor="show-console-tab">Show Console tab</label>
                <input
                  id="show-console-tab"
                  type="checkbox"
                  checked={showConsoleTab ?? false}
                  onChange={(e) => onToggleConsoleTab(e.target.checked)}
                />
              </div>
            </section>
          )}

          {inTauri && (
            <section className="settings-section">
              <h3>Network</h3>
              <div className="settings-field">
                <span id="tunnel-mode-label">Tunnel mode</span>
                <div className="tunnel-mode-options" role="radiogroup" aria-labelledby="tunnel-mode-label">
                  {([
                    { value: 'none', label: 'Off', desc: 'LAN only' },
                    { value: 'quick', label: 'Quick Tunnel', desc: 'Random Cloudflare URL' },
                    { value: 'named', label: 'Named Tunnel', desc: 'Stable URL, requires setup' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      className={`tunnel-mode-option${tunnelMode === opt.value ? ' active' : ''}`}
                      onClick={() => handleTunnelModeChange(opt.value)}
                      aria-checked={tunnelMode === opt.value}
                    >
                      <span className="tunnel-mode-label">{opt.label}</span>
                      <span className="tunnel-mode-desc">{opt.desc}</span>
                    </button>
                  ))}
                </div>
                {tunnelError && (
                  <p className="tunnel-mode-error">{tunnelError}</p>
                )}
                <p className="tunnel-mode-note">Server restart required after change</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
