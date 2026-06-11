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
import { useCallback, useEffect, useState } from 'react'
import { ControlRoomSection, type RepoInvestigateRequest, type RepoOpenSessionRequest } from './ControlRoomSection'
import { RunnerStatusSection } from './RunnerStatusSection'
import { IntegrationsSection } from './IntegrationsSection'
import { useConnectionStore } from '../store/connection'

export type ControlRoomTab = 'repos' | 'runners' | 'integrations'

/**
 * #5543: how old a tab's snapshot may be before opening/switching to that tab
 * re-fetches it. Judged against the snapshot's `generatedAt`. The surveys shell
 * out to git/gh per repo (the runner/integration ones are expensive), so this
 * deliberately favours showing a slightly-stale snapshot over re-running a
 * survey on every flick between tabs — and there is no interval polling, only
 * fetch-on-activation plus the manual Refresh force.
 */
export const CONTROL_ROOM_STALENESS_MS = 60_000

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

/**
 * #5543: true when a tab's snapshot warrants a re-fetch — null/absent snapshot,
 * an unparseable `generatedAt`, or one older than the staleness window. A fresh
 * snapshot (within the window) returns false so we skip the survey.
 */
function isStale(generatedAt: string | undefined): boolean {
  if (!generatedAt) return true
  const ms = Date.parse(generatedAt)
  if (Number.isNaN(ms)) return true
  return Date.now() - ms >= CONTROL_ROOM_STALENESS_MS
}

const TABS: ReadonlyArray<{ key: ControlRoomTab; label: string }> = [
  { key: 'repos', label: 'Project status' },
  { key: 'runners', label: 'Self-hosted runners' },
  { key: 'integrations', label: 'Integrations' },
]

export interface ControlRoomViewProps {
  /** Forwarded to the repo table's actionable verdict tags (#5202). */
  onInvestigate?: (req: RepoInvestigateRequest) => void
  /** Forwarded to the repo table's per-row "Open session" action (#5507). */
  onOpenSession?: (req: RepoOpenSessionRequest) => void
  /** Optional initial tab override (defaults to the persisted tab). For tests. */
  initialTab?: ControlRoomTab
}

export function ControlRoomView({ onInvestigate, onOpenSession, initialTab }: ControlRoomViewProps = {}) {
  const [tab, setTab] = useState<ControlRoomTab>(() => initialTab ?? loadPersistedTab())

  const selectTab = useCallback((next: ControlRoomTab) => {
    setTab(next)
    persistTab(next)
  }, [])

  // #5543: auto-fetch the active tab's survey when the Control Room opens with a
  // tab already active and on each tab switch, with a staleness guard. We only
  // fire when the WS is up (the request actions no-op when the socket is closed,
  // but gating here avoids churning the effect against a snapshot that will
  // never arrive) and the tab isn't already loading (the server enforces a
  // per-client in-flight guard — don't trip it). A snapshot newer than the
  // staleness window is left alone; the manual Refresh button still forces a
  // re-fetch regardless. No interval polling — fetch-on-activation only.
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const hostStatus = useConnectionStore((s) => s.hostStatus)
  const runnerStatus = useConnectionStore((s) => s.runnerStatus)
  const integrationStatus = useConnectionStore((s) => s.integrationStatus)
  const hostStatusLoading = useConnectionStore((s) => s.hostStatusLoading)
  const runnerStatusLoading = useConnectionStore((s) => s.runnerStatusLoading)
  const integrationStatusLoading = useConnectionStore((s) => s.integrationStatusLoading)
  const requestHostStatus = useConnectionStore((s) => s.requestHostStatus)
  const requestRunnerStatus = useConnectionStore((s) => s.requestRunnerStatus)
  const requestIntegrationStatus = useConnectionStore((s) => s.requestIntegrationStatus)

  useEffect(() => {
    if (!connected) return

    const snapshot = tab === 'repos' ? hostStatus : tab === 'runners' ? runnerStatus : integrationStatus
    const loading =
      tab === 'repos' ? hostStatusLoading : tab === 'runners' ? runnerStatusLoading : integrationStatusLoading
    if (loading) return

    if (!isStale(snapshot?.generatedAt)) return

    const request =
      tab === 'repos' ? requestHostStatus : tab === 'runners' ? requestRunnerStatus : requestIntegrationStatus
    request()
  }, [
    tab,
    connected,
    hostStatus,
    runnerStatus,
    integrationStatus,
    hostStatusLoading,
    runnerStatusLoading,
    integrationStatusLoading,
    requestHostStatus,
    requestRunnerStatus,
    requestIntegrationStatus,
  ])

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
        <ControlRoomSection onInvestigate={onInvestigate} onOpenSession={onOpenSession} />
      ) : tab === 'runners' ? (
        <RunnerStatusSection />
      ) : (
        <IntegrationsSection />
      )}
    </div>
  )
}
