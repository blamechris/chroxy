/**
 * SettingsPanel — slide-out panel with theme picker and session defaults.
 *
 * Triggered via gear icon in header or Cmd+,. Changes apply instantly
 * and persist to localStorage.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useConnectionStore } from '../store/connection'
import { getAvailableThemes, applyTheme } from '../theme/theme-engine'
import { getThemeById } from '../theme/themes'
import type { ThemeDefinition } from '../theme/themes'

export interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
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

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const activeTheme = useConnectionStore(s => s.activeTheme)
  const setTheme = useConnectionStore(s => s.setTheme)
  const defaultProvider = useConnectionStore(s => s.defaultProvider)
  const setDefaultProvider = useConnectionStore(s => s.setDefaultProvider)
  const themes = getAvailableThemes()

  const handleSelectTheme = useCallback((themeId: string) => {
    setTheme(themeId)
    applyTheme(getThemeById(themeId))
  }, [setTheme])

  const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDefaultProvider(e.target.value)
  }, [setDefaultProvider])

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
      <div className="settings-panel" role="dialog" aria-label="Settings">
        <div className="settings-header">
          <h2>Settings</h2>
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
                value={defaultProvider}
                onChange={handleProviderChange}
              >
                <option value="claude-sdk">Claude Code (SDK)</option>
                <option value="claude-cli">Claude Code (CLI)</option>
              </select>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
