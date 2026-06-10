/**
 * ControlRoomView (#5253) — the Control Room's top-level surface, a tab shell
 * over the Host/Repo Status table (`ControlRoomSection`), the Self-hosted
 * runners table (`RunnerStatusSection`), and the Integrations table
 * (`IntegrationsSection`, #5499).
 *
 * Before #5253 the Control Room rendered `ControlRoomSection` directly; this
 * wrapper keeps that as the default tab and adds siblings. The active sub-tab
 * is persisted to localStorage so a reload returns to the operator's last view
 * (same try/catch-guarded posture as the Control Room's filter/sort persistence
 * — localStorage can throw in privacy mode and a dashboard panel must never
 * crash on it).
 *
 * App.tsx renders this in place of the old `ControlRoomSection` and forwards the
 * `onInvestigate` action through to the repo table unchanged.
 */
import { useCallback, useState } from 'react'
import { ControlRoomSection, type RepoInvestigateRequest } from './ControlRoomSection'
import { RunnerStatusSection } from './RunnerStatusSection'
import { IntegrationsSection } from './IntegrationsSection'

export type ControlRoomTab = 'repos' | 'runners' | 'integrations'

const CR_TAB_STORAGE_KEY = 'chroxy_cr_tab'
const VALID_TABS: ReadonlySet<string> = new Set<ControlRoomTab>(['repos', 'runners', 'integrations'])

function loadPersistedTab(): ControlRoomTab {
  try {
    const raw = localStorage.getItem(CR_TAB_STORAGE_KEY)
    if (raw && VALID_TABS.has(raw)) return raw as ControlRoomTab
  } catch {
    /* noop — storage unavailable */
  }
  return 'repos'
}

function persistTab(tab: ControlRoomTab): void {
  try {
    localStorage.setItem(CR_TAB_STORAGE_KEY, tab)
  } catch {
    /* noop — storage unavailable */
  }
}

const TABS: ReadonlyArray<{ key: ControlRoomTab; label: string }> = [
  { key: 'repos', label: 'Project status' },
  { key: 'runners', label: 'Self-hosted runners' },
  { key: 'integrations', label: 'Integrations' },
]

export interface ControlRoomViewProps {
  /** Forwarded to the repo table's actionable verdict tags (#5202). */
  onInvestigate?: (req: RepoInvestigateRequest) => void
  /** Optional initial tab override (defaults to the persisted tab). For tests. */
  initialTab?: ControlRoomTab
}

export function ControlRoomView({ onInvestigate, initialTab }: ControlRoomViewProps = {}) {
  const [tab, setTab] = useState<ControlRoomTab>(() => initialTab ?? loadPersistedTab())

  const selectTab = useCallback((next: ControlRoomTab) => {
    setTab(next)
    persistTab(next)
  }, [])

  return (
    <div className="cr-view" data-testid="control-room-view">
      <div className="cr-tabs" role="tablist" aria-label="Control Room sections" data-testid="cr-tabs">
        {TABS.map((t, i) => {
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              // Roving tabindex: only the active tab is in the tab order; the
              // others are reached with ArrowLeft/ArrowRight (matches the
              // SessionBar tab convention so keyboard nav is consistent).
              tabIndex={active ? 0 : -1}
              className={`cr-tab${active ? ' cr-tab-active' : ''}`}
              data-testid={`cr-tab-${t.key}`}
              onClick={() => selectTab(t.key)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                e.preventDefault()
                const next =
                  e.key === 'ArrowRight'
                    ? (i + 1) % TABS.length
                    : (i - 1 + TABS.length) % TABS.length
                const target = TABS[next]!
                selectTab(target.key)
                const tabs = (e.currentTarget.parentElement as HTMLElement)?.querySelectorAll<HTMLElement>(
                  '[role="tab"]',
                )
                tabs?.[next]?.focus()
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      {tab === 'repos' ? (
        <ControlRoomSection onInvestigate={onInvestigate} />
      ) : tab === 'runners' ? (
        <RunnerStatusSection />
      ) : (
        <IntegrationsSection />
      )}
    </div>
  )
}
