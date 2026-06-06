/**
 * ControlRoomView (#5253) — the Control Room's top-level surface, a two-tab
 * shell over the existing Host/Repo Status table (`ControlRoomSection`) and the
 * new Self-hosted runners table (`RunnerStatusSection`).
 *
 * Before #5253 the Control Room rendered `ControlRoomSection` directly; this
 * wrapper keeps that as the default tab and adds a sibling. The active sub-tab
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

export type ControlRoomTab = 'repos' | 'runners'

const CR_TAB_STORAGE_KEY = 'chroxy_cr_tab'
const VALID_TABS: ReadonlySet<string> = new Set<ControlRoomTab>(['repos', 'runners'])

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
        {TABS.map((t) => {
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`cr-tab${active ? ' cr-tab-active' : ''}`}
              data-testid={`cr-tab-${t.key}`}
              onClick={() => selectTab(t.key)}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      {tab === 'repos' ? (
        <ControlRoomSection onInvestigate={onInvestigate} />
      ) : (
        <RunnerStatusSection />
      )}
    </div>
  )
}
