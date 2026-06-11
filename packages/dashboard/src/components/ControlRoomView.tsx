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
 *
 * #5557 — tab registry. Adding a tab used to cost ~7 coordinated edits (a
 * `ControlRoomTab` union member, a `SURVEY_TABS` entry, a `VALID_TABS` entry, a
 * `TABS` render-list entry, a store status/loading pair, a copy-paste
 * `requestXStatus` store method, and the WS handler wiring) with nothing tying
 * them together — a `VALID_TABS`/`TABS` drift ships a tab you can deep-link to
 * but not render. They now all DERIVE from the single `CONTROL_ROOM_TABS`
 * descriptor array below: the `ControlRoomTab` union, the valid-tab set, the
 * survey-tab set, the rendered tab strip, and the auto-fetch effect's
 * snapshot/loading/request lookups. A `registry-derivation.test` asserts the
 * derived sets stay consistent so the drift class can't reappear.
 *
 * Design choice (documented in PR #5557): the store keeps its existing,
 * heavily-tested per-tab triples (`hostStatus`/`hostStatusLoading`/
 * `requestHostStatus`, etc.) and the on-the-wire WS message types
 * (`host_status_request` …) are untouched — this is a CLIENT-SIDE refactor. The
 * descriptor MAPS each surveyed tab to those existing store keys (`snapshotKey`,
 * `loadingKey`, `requestKey`) so the generic effect drives them through a single
 * keyed lookup instead of a hand-maintained `tab === '…' ? … : …` ladder. That
 * kills the view-side edits (union/sets/strip/effect) outright and removes the
 * need for any new copy-paste request method when a future surveyed tab is
 * added — the smallest refactor that eliminates the per-tab edit cost without
 * churning the tested store internals or the protocol.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ControlRoomSection, type RepoInvestigateRequest, type RepoOpenSessionRequest } from './ControlRoomSection'
import { RunnerStatusSection } from './RunnerStatusSection'
import { IntegrationsSection } from './IntegrationsSection'
import { SkillsInventorySection } from './SkillsInventorySection'
import { SettingsContent } from './SettingsPanel'
import { useConnectionStore } from '../store/connection'
import type { ConnectionState } from '../store/types'

/**
 * #5557 — the keys of the store fields a surveyed tab drives. Each surveyed
 * descriptor names exactly these three (the store keeps its tested per-tab
 * triples — see the file header). Constrained to the matching store shape so a
 * typo (or a renamed store field) fails `tsc` at the descriptor rather than
 * silently no-op'ing the auto-fetch.
 */
type SnapshotKey = {
  [K in keyof ConnectionState]: ConnectionState[K] extends { generatedAt?: string } | null ? K : never
}[keyof ConnectionState]
type LoadingKey = {
  [K in keyof ConnectionState]: ConnectionState[K] extends boolean ? K : never
}[keyof ConnectionState]
type RequestKey = {
  [K in keyof ConnectionState]: ConnectionState[K] extends () => boolean ? K : never
}[keyof ConnectionState]

/**
 * #5557 — one descriptor per Control Room tab. The single source of truth from
 * which the union, the sets, the strip, and the auto-fetch lookups all derive.
 *
 * - `survey: true` tabs auto-fetch on activation (#5543/#5546) and MUST supply
 *   `requestType` (the WS message put on the wire), `snapshotKey`/`loadingKey`/
 *   `requestKey` (the existing store fields the effect reads/calls). `tsc`
 *   enforces the discriminant: a `survey: false` tab may not carry these, and a
 *   `survey: true` tab may not omit them.
 * - `survey: false` tabs (the #5544 Settings tab) are static (server/client
 *   config only) and the effect early-returns for them — they never fetch.
 */
type SurveyTabDescriptor = {
  readonly key: string
  readonly label: string
  readonly survey: true
  /** The WS message type the request method puts on the wire (kept as-is). */
  readonly requestType: string
  /** Store field holding this tab's latest snapshot (staleness is judged here). */
  readonly snapshotKey: SnapshotKey
  /** Store boolean flipped while a request is in flight (the in-flight guard). */
  readonly loadingKey: LoadingKey
  /** Store action that dispatches the survey request. */
  readonly requestKey: RequestKey
}
type StaticTabDescriptor = {
  readonly key: string
  readonly label: string
  readonly survey: false
}
type ControlRoomTabDescriptor = SurveyTabDescriptor | StaticTabDescriptor

export const CONTROL_ROOM_TABS = [
  {
    key: 'repos',
    label: 'Project status',
    survey: true,
    requestType: 'host_status_request',
    snapshotKey: 'hostStatus',
    loadingKey: 'hostStatusLoading',
    requestKey: 'requestHostStatus',
  },
  {
    key: 'runners',
    label: 'Self-hosted runners',
    survey: true,
    requestType: 'runner_status_request',
    snapshotKey: 'runnerStatus',
    loadingKey: 'runnerStatusLoading',
    requestKey: 'requestRunnerStatus',
  },
  {
    key: 'integrations',
    label: 'Integrations',
    survey: true,
    requestType: 'integration_status_request',
    snapshotKey: 'integrationStatus',
    loadingKey: 'integrationStatusLoading',
    requestKey: 'requestIntegrationStatus',
  },
  // #5554 (epic #5159): the Skills tab — inventory of installed chroxy skills
  // (global ~/.chroxy/skills/ + per-repo .chroxy/skills/ overlays) with
  // descriptions / trust / hashes / install dates plus usage history. Same
  // survey:true request/snapshot flow as Integrations; the #5546 staleness
  // guard comes free via the registry.
  {
    key: 'skills',
    label: 'Skills',
    survey: true,
    requestType: 'skills_inventory_request',
    snapshotKey: 'skillsInventory',
    loadingKey: 'skillsInventoryLoading',
    requestKey: 'requestSkillsInventory',
  },
  // #5544: the Settings tab converges the scattered preference surfaces
  // (notification categories, appearance, session defaults, BYOK, Tauri desktop
  // options) into the Control Room. It embeds `SettingsContent` — the same body
  // the legacy slide-out modal renders — so there's a single home and no
  // duplicated controls. It is `survey: false`: purely client/server-config
  // driven, so the auto-fetch effect must NOT trip the snapshot fetch for it.
  {
    key: 'settings',
    label: 'Settings',
    survey: false,
  },
] as const satisfies ReadonlyArray<ControlRoomTabDescriptor>

/** #5557 — the tab union, derived from the descriptor keys. */
export type ControlRoomTab = (typeof CONTROL_ROOM_TABS)[number]['key']

/** #5557 — survey-backed descriptors, narrowed for the auto-fetch effect. */
type SurveyDescriptor = Extract<(typeof CONTROL_ROOM_TABS)[number], { survey: true }>

/** #5557 — the set of valid deep-link / persisted tab keys, derived. */
const VALID_TABS: ReadonlySet<string> = new Set(CONTROL_ROOM_TABS.map((t) => t.key))

/**
 * #5544/#5557: the survey-backed tabs whose auto-fetch effect (#5543/#5546)
 * shells out to git/gh, keyed for O(1) lookup in the effect. The Settings tab is
 * absent (it's `survey: false`), so the effect early-returns for it.
 */
const SURVEY_DESCRIPTORS: ReadonlyMap<ControlRoomTab, SurveyDescriptor> = new Map(
  CONTROL_ROOM_TABS.filter((t): t is SurveyDescriptor => t.survey).map((t) => [t.key, t]),
)

/** #5557 — the survey-tab key set, derived from the descriptors (drift guard). */
export const SURVEY_TABS: ReadonlySet<ControlRoomTab> = new Set(SURVEY_DESCRIPTORS.keys())

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

export interface ControlRoomViewProps {
  /** Forwarded to the repo table's actionable verdict tags (#5202). */
  onInvestigate?: (req: RepoInvestigateRequest) => void
  /** Forwarded to the repo table's per-row "Open session" action (#5507). */
  onOpenSession?: (req: RepoOpenSessionRequest) => void
  /** Forwarded to the repo table's per-row gear action — opens the preset drawer (#5553). */
  onConfigureRepo?: (req: { path: string; name: string }) => void
  /** Optional initial tab override (defaults to the persisted tab). For tests. */
  initialTab?: ControlRoomTab
  /**
   * #5544: imperative tab redirect. When this value changes to a non-null
   * tab, the view switches to it (and persists the choice). App.tsx bumps
   * the paired nonce when the gear / Cmd+, entry points fire so they land on
   * the Settings tab even if the Control Room is already open on another tab.
   */
  forceTab?: ControlRoomTab | null
  /** Monotonic nonce that re-triggers `forceTab` even when the tab is unchanged. */
  forceTabNonce?: number
  // #5544: the Settings tab's dashboard-scoped toggles (Console tab + audible
  // intervention ping) are App-owned localStorage prefs, threaded through here
  // exactly as they were to the legacy SettingsPanel modal. Optional so the
  // tab still renders (without those two rows) when a caller doesn't wire them.
  showConsoleTab?: boolean
  onToggleConsoleTab?: (show: boolean) => void
  interventionPingEnabled?: boolean
  onToggleInterventionPing?: (enabled: boolean) => void
}

export function ControlRoomView({
  onInvestigate,
  onOpenSession,
  onConfigureRepo,
  initialTab,
  forceTab,
  forceTabNonce,
  showConsoleTab,
  onToggleConsoleTab,
  interventionPingEnabled,
  onToggleInterventionPing,
}: ControlRoomViewProps = {}) {
  const [tab, setTab] = useState<ControlRoomTab>(() => initialTab ?? loadPersistedTab())

  const selectTab = useCallback((next: ControlRoomTab) => {
    setTab(next)
    persistTab(next)
  }, [])

  // #5544: honour an imperative redirect while the Control Room is already
  // mounted. The nonce is seeded from the incoming prop so the *mount* never
  // redirects (the closed→open path is handled by App seeding `initialTab`
  // instead) — only a subsequent bump, i.e. an explicit gear / Cmd+, / menu
  // click while the CR is open, switches to `forceTab` (Settings), even if the
  // user had navigated to another tab in between.
  const lastForceNonce = useRef(forceTabNonce)
  useEffect(() => {
    if (forceTabNonce === lastForceNonce.current) return
    lastForceNonce.current = forceTabNonce
    if (!forceTab) return
    selectTab(forceTab)
  }, [forceTab, forceTabNonce, selectTab])

  // #5543/#5557: auto-fetch the active tab's survey when the Control Room opens
  // with a tab already active and on each tab switch, with a staleness guard. We
  // only fire when the WS is up (the request actions no-op when the socket is
  // closed, but gating here avoids churning the effect against a snapshot that
  // will never arrive) and the tab isn't already loading (the server enforces a
  // per-client in-flight guard — don't trip it). A snapshot newer than the
  // staleness window is left alone; the manual Refresh button still forces a
  // re-fetch regardless. No interval polling — fetch-on-activation only.
  //
  // #5557: the snapshot/loading/request triple is looked up via the active tab's
  // descriptor (keyed store fields) rather than a `tab === '…' ? … : …` ladder,
  // so a new surveyed tab needs no edit here — only a descriptor entry. We
  // subscribe to exactly the active tab's snapshot + loading flag (keyed off the
  // descriptor) so the effect re-runs on the same signals the old per-field
  // selectors did — no over-subscription to unrelated store state.
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const descriptor = SURVEY_DESCRIPTORS.get(tab)
  const snapshot = useConnectionStore((s) =>
    descriptor ? (s[descriptor.snapshotKey] as { generatedAt?: string } | null) : null,
  )
  const loading = useConnectionStore((s) => (descriptor ? (s[descriptor.loadingKey] as boolean) : false))
  const request = useConnectionStore((s) =>
    descriptor ? (s[descriptor.requestKey] as () => boolean) : undefined,
  )

  useEffect(() => {
    if (!connected) return
    // #5544: the Settings tab is static (no survey descriptor) — never fetch.
    if (!descriptor || !request) return
    if (loading) return
    if (!isStale(snapshot?.generatedAt)) return
    request()
  }, [connected, descriptor, request, loading, snapshot])

  return (
    <div className="cr-view" data-testid="control-room-view">
      <div className="cr-tabs" role="tablist" aria-label="Control Room sections" data-testid="cr-tabs">
        {CONTROL_ROOM_TABS.map((t, i) => {
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
                    ? (i + 1) % CONTROL_ROOM_TABS.length
                    : (i - 1 + CONTROL_ROOM_TABS.length) % CONTROL_ROOM_TABS.length
                const target = CONTROL_ROOM_TABS[next]!
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
        <ControlRoomSection onInvestigate={onInvestigate} onOpenSession={onOpenSession} onConfigureRepo={onConfigureRepo} />
      ) : tab === 'runners' ? (
        <RunnerStatusSection />
      ) : tab === 'integrations' ? (
        <IntegrationsSection />
      ) : tab === 'skills' ? (
        <SkillsInventorySection />
      ) : (
        // #5544: scrollable wrapper so the (often long) settings body scrolls
        // inside the tab panel rather than the whole Control Room view. The
        // `cr-settings-tab` class reuses the modal's `.settings-section`
        // typography (h3 section headers) which #5530's read-only repo-config
        // surface will sit beside, visually distinct, later.
        <div className="cr-settings-tab" data-testid="cr-settings-tab">
          <SettingsContent
            active={tab === 'settings'}
            showConsoleTab={showConsoleTab}
            onToggleConsoleTab={onToggleConsoleTab}
            interventionPingEnabled={interventionPingEnabled}
            onToggleInterventionPing={onToggleInterventionPing}
          />
        </div>
      )}
    </div>
  )
}
