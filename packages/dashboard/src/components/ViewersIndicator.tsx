/**
 * ViewersIndicator (#5281 ①.3) — shared-session presence surface.
 *
 * The chroxy daemon fans a single session out to every connected client, so a
 * desktop and a phone (or a second collaborator) can watch and drive the same
 * agent. This chip makes that visible from the sidebar footer: it shows how
 * many devices are attached and, on click, lists them by name.
 *
 * The active session's "primary" client — the device that most recently sent
 * input — is tagged "drove last". Primary is deliberately framed as a transient
 * fact, NOT a fixed "you are in control" role: the server only rejects input
 * with `input_conflict` while the agent is mid-request for another device;
 * otherwise anyone can send and becomes the new primary (last-writer-wins, see
 * input-handlers.js + ws-server._setPrimaryClient). Claiming a stable control
 * role here would misrepresent that policy, so we don't.
 *
 * Solo (one device) renders the same plain "1 client" text the footer showed
 * before this component existed — the interactive popover only appears once a
 * session is genuinely shared (≥2 devices).
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { SessionRole } from '@chroxy/store-core'
import type { ConnectedClient } from '../store/types'

export interface ViewersIndicatorProps {
  /** All clients attached to the daemon (each carries isSelf + deviceType). */
  clients: ConnectedClient[]
  /**
   * The active session's primary client id — the device that drove it last —
   * used only to tag a row "drove last". Null when nobody has driven yet.
   */
  primaryClientId: string | null
  /** Footer renders nothing useful while disconnected; mirrors the old gate. */
  connected: boolean
  /**
   * #5589 / #5281 — THIS client's explicit role for the active session. When
   * `'observer'`, the trigger gains an "Observing" badge and the popover gains
   * a "Take over" affordance. Null/undefined or `'primary'`/`'unclaimed'`
   * render the prior neutral presence UI.
   */
  sessionRole?: SessionRole | null
  /** #5589 / #5281 — force-claim primary (take over) for the active session. */
  onTakeOver?: () => void
}

function deviceGlyph(type: ConnectedClient['deviceType']): string {
  switch (type) {
    case 'phone': return '\u{1F4F1}'   // 📱
    case 'tablet': return '\u{1F4DF}'  // 📟 (closest stock glyph)
    case 'desktop': return '\u{1F5A5}' // 🖥
    default: return '\u{1F310}'        // 🌐
  }
}

function clientLabel(c: ConnectedClient): string {
  if (c.deviceName) return c.deviceName
  if (c.platform) return c.platform
  if (c.deviceType !== 'unknown') return c.deviceType
  return 'Unknown device'
}

/**
 * Resolve the "drove last" client id for the footer indicator.
 *
 * The server routes `primary_changed` to two distinct slots: a real session's
 * primary lands on that session's per-session `primaryClientId`, while the
 * default / no-session context lands on the global one (see
 * store-core handlers/index.ts + message-handler primary_changed). So when a
 * real session is active we MUST read only its per-session value (null when
 * nobody has driven it yet) — falling back to the global there would surface a
 * stale "drove last" from a different context on a session no one has driven
 * (#5281 ①.3 review). The global is the right answer only for the
 * pre-session / 'default' view.
 */
export function resolveActivePrimaryClientId(
  activeSessionId: string | null,
  sessionStates: Record<string, { primaryClientId: string | null }>,
  globalPrimaryClientId: string | null,
): string | null {
  if (activeSessionId) return sessionStates[activeSessionId]?.primaryClientId ?? null
  return globalPrimaryClientId
}

export function ViewersIndicator({ clients, primaryClientId, connected, sessionRole, onTakeOver }: ViewersIndicatorProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const popoverId = useId()

  // Dismiss the popover on outside-click (capturing mousedown, matching
  // HeaderOverflowMenu / SessionContextMenu), Escape, and window blur.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        // Restore focus to the trigger so a keyboard user isn't dropped to
        // <body> after dismissing — matches the disclosure pattern elsewhere.
        triggerRef.current?.focus()
      }
    }
    const onBlur = () => setOpen(false)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  // Only meaningful while connected — mirrors the footer's pre-existing gate.
  if (!connected) return null
  const total = clients.length
  if (total === 0) return null

  const countText = `${total} client${total === 1 ? '' : 's'}`
  // #5589 / #5281 — this client is read-only-while-running because ANOTHER
  // device holds primary. Surfaced unobtrusively on the trigger + popover.
  const isObserving = sessionRole === 'observer'

  // Solo: keep the plain, non-interactive label the footer always showed.
  if (total === 1) {
    return (
      <span className="sidebar-client-count" data-testid="viewers-indicator-solo">
        {countText}
      </span>
    )
  }

  // Resolve the driving device's display name for the observer copy.
  const driver = primaryClientId ? clients.find(c => c.clientId === primaryClientId) : null
  const driverLabel = driver ? clientLabel(driver) : 'another device'

  return (
    <div
      className={`viewers-indicator sidebar-client-count${isObserving ? ' observing' : ''}`}
      data-testid="viewers-indicator"
    >
      <button
        ref={triggerRef}
        type="button"
        className="viewers-trigger"
        data-testid="viewers-indicator-trigger"
        onClick={() => setOpen(p => !p)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        // The visible content is a decorative glyph + bare number, which a
        // screen reader would announce as just "2" — give the control an
        // explicit name describing what it does. When observing, fold the role
        // into the name so a screen reader announces it too.
        aria-label={
          isObserving
            ? `Observing — ${driverLabel} is driving. ${countText} sharing this session — show devices`
            : `${countText} sharing this session — show devices`
        }
        title={isObserving ? `Observing — ${driverLabel} is driving` : `${countText} sharing this session`}
      >
        <span className="viewers-trigger-glyph" aria-hidden="true">{'\u{1F465}'}</span>
        <span className="viewers-trigger-count">{total}</span>
        {isObserving && (
          <span className="viewers-observing-badge" data-testid="viewers-observing-badge">
            Observing
          </span>
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          className="viewers-popover"
          data-testid="viewers-popover"
          role="dialog"
          aria-modal="false"
          aria-label="Connected devices"
        >
          <div className="viewers-popover-header">
            <strong>Shared session</strong>
            <p className="viewers-popover-sub">
              Everyone here sees the same output. The agent handles one request at
              a time — if it's busy, other devices wait.
            </p>
          </div>
          <ul className="viewers-list">
            {clients.map(c => {
              const isPrimary = !!primaryClientId && c.clientId === primaryClientId
              return (
                <li
                  key={c.clientId}
                  className="viewers-client-row"
                  data-testid={`viewers-client-${c.clientId}`}
                >
                  <span className="viewers-client-glyph" aria-hidden="true">
                    {deviceGlyph(c.deviceType)}
                  </span>
                  <span className="viewers-client-name">{clientLabel(c)}</span>
                  {c.isSelf && (
                    <span className="viewers-tag viewers-tag-self" data-testid={`viewers-self-${c.clientId}`}>
                      This device
                    </span>
                  )}
                  {isPrimary && (
                    <span className="viewers-tag viewers-tag-primary" data-testid={`viewers-primary-${c.clientId}`}>
                      drove last
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          {isObserving && (
            <div className="viewers-observing-footer" data-testid="viewers-observing-footer">
              <p className="viewers-observing-note">
                {driverLabel} is driving. Your input is rejected while the agent is
                busy — take over to drive.
              </p>
              {onTakeOver && (
                <button
                  type="button"
                  className="viewers-takeover-button"
                  data-testid="viewers-takeover-button"
                  onClick={() => { onTakeOver(); setOpen(false) }}
                >
                  Take over
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
