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
import { ContainersStatusSection } from './ContainersStatusSection'
import { RepoRuntimeConfigSection } from './RepoRuntimeConfigSection'
import { ByokPoolSection } from './ByokPoolSection'
import { HostPruneSection } from './HostPruneSection'
import { DeviceRuntimesSection } from './DeviceRuntimesSection'
import { IntegrationsSection } from './IntegrationsSection'
import { RepoEventsSection } from './RepoEventsSection'
import { OrchestrationRunsSection } from './OrchestrationRunsSection'
import { SkillsInventorySection } from './SkillsInventorySection'
import { MailboxPanel } from './MailboxPanel'
import { CrossSessionMissionControl } from './CrossSessionMissionControl'
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
  /**
   * #6691 (S-3): optional server-capability gate. When set, the tab renders in
   * the strip (and deep-links/persistence resolve to it) ONLY while
   * `serverCapabilities[capability] === true` — fail-closed, so a feature-off
   * daemon shows no dead chrome.
   */
  readonly capability?: string
}
type StaticTabDescriptor = {
  readonly key: string
  readonly label: string
  readonly survey: false
  readonly capability?: string
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
  // #6133 (epic #5530): the Containers tab — host-wide survey of chroxy-managed
  // containers & environments (Docker/Compose; k8s/rancher as validated) with
  // state / image / uptime / session linkage / docker-stats. Same survey:true
  // request/snapshot flow as the others; the #5546 staleness guard comes free.
  {
    key: 'containers',
    label: 'Containers',
    survey: true,
    requestType: 'containers_status_request',
    snapshotKey: 'containersStatus',
    loadingKey: 'containersStatusLoading',
    requestKey: 'requestContainersStatus',
  },
  // #6139 (epic #5530): the Repo Runtime Config tab — read-only, per-repo view
  // of what governs container runtimes (devcontainer/compose presence, the image
  // a repo would run + the allowlist verdict) plus host-level defaults (effective
  // backend, isolation order, image allowlist). Same survey:true request/snapshot
  // flow as the others; the #5546 staleness guard comes free.
  {
    key: 'repo-config',
    label: 'Repo runtime config',
    survey: true,
    requestType: 'repo_runtime_config_request',
    snapshotKey: 'repoRuntimeConfig',
    loadingKey: 'repoRuntimeConfigLoading',
    requestKey: 'requestRepoRuntimeConfig',
  },
  // #6135 (epic #5530): the BYOK Pool tab — host-wide survey of the BYOK warm-
  // container pool (enabled flag, configured limits, live stats + per-shape warm
  // buckets) with drain / recycle / resize mutating actions. Same survey:true
  // request/snapshot flow as the others; the #5546 staleness guard comes free.
  {
    key: 'byok-pool',
    label: 'BYOK pool',
    survey: true,
    requestType: 'byok_pool_status_request',
    snapshotKey: 'byokPoolStatus',
    loadingKey: 'byokPoolStatusLoading',
    requestKey: 'requestByokPoolStatus',
  },
  // #6140 (epic #5530): the Host prune tab — reclaimable, chroxy-scoped,
  // orphan-only docker pressure (stopped chroxy containers + chroxy snapshot
  // images not tracked by a live env) with drain/recycle-style prune actions.
  // Same survey:true request/snapshot flow as the others.
  {
    key: 'host-prune',
    label: 'Host prune',
    survey: true,
    requestType: 'host_prune_status_request',
    snapshotKey: 'hostPruneStatus',
    loadingKey: 'hostPruneStatusLoading',
    requestKey: 'requestHostPruneStatus',
  },
  // #6136 (epic #5530): the Device runtimes tab — iOS simulators (devices +
  // "Ready for Maestro" verdict) with boot/shutdown actions. Android (#6137) and
  // WSL2 (#6138) are separate sub-issues that will add their own panels here.
  // Same survey:true request/snapshot flow as the others.
  {
    key: 'device-runtimes',
    label: 'Device runtimes',
    survey: true,
    requestType: 'simulator_status_request',
    snapshotKey: 'simulatorStatus',
    loadingKey: 'simulatorStatusLoading',
    requestKey: 'requestSimulatorStatus',
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
  // Mailbox (#5914 follow-up): the agent-to-agent mailbox observability tab —
  // live agentCommId→session registrations + recent live-interrupt deliveries.
  // Same survey:true fetch-on-activation flow as the other tabs; the in-memory
  // snapshot is cheap so the #5546 staleness guard just keeps it fresh.
  {
    key: 'mailbox',
    label: 'Mailbox',
    survey: true,
    requestType: 'mailbox_status_request',
    snapshotKey: 'mailboxStatus',
    loadingKey: 'mailboxStatusLoading',
    requestKey: 'requestMailboxStatus',
  },
  // #5966 (Control Room v2 phase 5 / #5422): the Repo events tab — GitHub-webhook
  // activity (push / PR / issue) the daemon buffers in its bounded RepoEventStore
  // (#6468), scoped best-effort to the repos live sessions are working in. Same
  // survey:true fetch-on-activation flow as the sibling tabs; the in-memory store
  // read is cheap so the #5546 staleness guard just keeps it fresh.
  {
    key: 'repo-events',
    label: 'Repo events',
    survey: true,
    requestType: 'repo_events_request',
    snapshotKey: 'repoEventsSnapshot',
    loadingKey: 'repoEventsLoading',
    requestKey: 'requestRepoEvents',
  },
  // #6183 (Control Room v2 phase 2 / #5964): cross-session mission control — the
  // aggregate, read-only view over EVERY session's activity tree, grouped by
  // repo+worktree with running/blocked/failed rollups. `survey: false`: it reads
  // the live activity reducer state already in the store (fed by the
  // activity_snapshot/delta handlers), so there's no per-tab snapshot to fetch.
  {
    key: 'mission-control',
    label: 'Mission control',
    survey: false,
  },
  // #6691 (S-3, epic #6702): the orchestration "Runs" tab — the committee
  // engine's runs list + per-run detail (nodes, gates, timeline, report). Same
  // survey:true request/snapshot flow as the others; ADDITIONALLY live
  // `orchestration_run_delta` messages upsert between surveys. Capability-gated:
  // hidden entirely unless the daemon advertises `orchestration` in auth_ok
  // (feature-flagged engine, off by default).
  {
    key: 'runs',
    label: 'Runs',
    survey: true,
    requestType: 'orchestration_runs_request',
    snapshotKey: 'orchestrationRuns',
    loadingKey: 'orchestrationRunsLoading',
    requestKey: 'requestOrchestrationRuns',
    capability: 'orchestration',
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

/**
 * #6183: thin store-connected wrapper for the cross-session mission-control view.
 * Reads the live activity reducer state + the session list from the store and
 * maps each SessionInfo to the selector's minimal `CrossSessionMeta`. Re-renders
 * (recomputing the aggregate) whenever activity or the session list changes, so
 * the rollups stay live. The pure `CrossSessionMissionControl` holds all the
 * rendering/grouping logic and is tested in isolation.
 */
function MissionControlTab() {
  const activity = useConnectionStore((s) => s.activity)
  const sessions = useConnectionStore((s) => s.sessions)
  // #5969 — external (/api/events) sessions are a pull survey, not live store
  // state: request a snapshot on open so they appear alongside managed ones.
  const externalSnapshot = useConnectionStore((s) => s.externalSessionsSnapshot)
  const requestExternalSessions = useConnectionStore((s) => s.requestExternalSessions)
  useEffect(() => {
    requestExternalSessions()
  }, [requestExternalSessions])
  const metas = sessions.map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    name: s.name,
    worktree: s.worktree,
  }))
  // A refusal snapshot carries an `error` + empty sessions — render nothing extra.
  const external = externalSnapshot?.sessions ?? []
  // #6125 — control actions over the aggregate view: cancel a subagent in any
  // session (sessionId threaded so the session-scoped cancel hits the right one)
  // and jump-to-intervene (switch the active session to a blocked one).
  const sendCancelActivity = useConnectionStore((s) => s.sendCancelActivity)
  const switchSession = useConnectionStore((s) => s.switchSession)
  const cancellingActivityIds = useConnectionStore((s) => s.cancellingActivityIds)
  return (
    <CrossSessionMissionControl
      activity={activity}
      sessions={metas}
      external={external}
      onCancelActivity={(activityId, sessionId) => sendCancelActivity(activityId, sessionId)}
      cancellingActivityIds={cancellingActivityIds}
      onJumpToSession={(sessionId) => switchSession(sessionId)}
    />
  )
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
  const [rawTab, setTab] = useState<ControlRoomTab>(() => initialTab ?? loadPersistedTab())

  // #6691 (S-3): capability gate — a tab whose descriptor names a capability is
  // visible only while the server advertises it (auth_ok). Fail-closed: a
  // deep-linked/persisted gated tab resolves to 'repos' instead of rendering
  // dead chrome for a feature the daemon doesn't run.
  const serverCapabilities = useConnectionStore((s) => s.serverCapabilities)
  const isTabVisible = useCallback((key: ControlRoomTab): boolean => {
    const d = CONTROL_ROOM_TABS.find((t) => t.key === key)
    const cap = d && 'capability' in d ? d.capability : undefined
    return !cap || serverCapabilities?.[cap] === true
  }, [serverCapabilities])
  const tab: ControlRoomTab = isTabVisible(rawTab) ? rawTab : 'repos'

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

  // #6218: the tab strip has more tabs than fit at common widths, so it scrolls
  // horizontally with edge-chevron affordances. `scrollState` tracks whether
  // there's clipped content on either side (so the chevrons only show when they
  // do something); recomputed on scroll, on resize (ResizeObserver), and after
  // the tab set changes.
  const tablistRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const updateScrollAffordance = useCallback(() => {
    const el = tablistRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    // 1px slack absorbs sub-pixel rounding so a fully-scrolled edge reads as 0.
    const left = scrollLeft > 1
    const right = scrollLeft + clientWidth < scrollWidth - 1
    // Bail when nothing changed — scroll/ResizeObserver fire on every tick, so
    // returning the previous object skips a re-render unless the booleans flip.
    setScrollState((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])
  useEffect(() => {
    const el = tablistRef.current
    if (!el) return
    updateScrollAffordance()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateScrollAffordance)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateScrollAffordance])
  const scrollTabs = useCallback((dir: -1 | 1) => {
    const el = tablistRef.current
    if (!el) return
    // Scroll by ~70% of the visible width so a click reveals a fresh page of
    // tabs while keeping one for context. Optional-call: jsdom doesn't implement
    // scrollBy, and a missing scroll method must not throw.
    el.scrollBy?.({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' })
  }, [])

  // #6230: harden the chevron-only path for mouse-only users (no wheel-tilt).
  // (a) PRESS-AND-HOLD a chevron → continuous scroll. A hold timer (350ms)
  //     distinguishes a tap (→ the single-jump onClick below) from a hold
  //     (→ a repeat interval that nudges the strip every 120ms while held).
  //     `didRepeatRef` suppresses the trailing click that fires when a long
  //     hold is released, so a hold doesn't tack on an extra jump.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const didRepeatRef = useRef(false)
  const stopHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (repeatRef.current !== null) {
      clearInterval(repeatRef.current)
      repeatRef.current = null
    }
    // #6241 review: clear the repeat marker on the NEXT tick, not now — the click
    // that trails a hold-release fires after pointerup (same task) and must still
    // be swallowed by `handleChevronClick`, but a hold that ends WITHOUT a click
    // (pointerleave/cancel, or mouseup off the button) must not leave the flag set
    // to swallow a later, unrelated click. (handleChevronClick also resets it
    // synchronously on the swallow, so this only covers the no-trailing-click case.)
    setTimeout(() => {
      didRepeatRef.current = false
    }, 0)
  }, [])
  const startHold = useCallback((dir: -1 | 1) => {
    stopHold()
    didRepeatRef.current = false
    holdTimerRef.current = setTimeout(() => {
      didRepeatRef.current = true
      repeatRef.current = setInterval(() => {
        const el = tablistRef.current
        // Smaller, snappy nudges (no smooth easing) for a continuous feel.
        el?.scrollBy?.({ left: dir * el.clientWidth * 0.18 })
      }, 120)
    }, 350)
  }, [stopHold])
  const handleChevronClick = useCallback((dir: -1 | 1) => {
    // Swallow the click that trails a press-and-hold release (the hold already
    // scrolled); a plain tap never set didRepeat, so it jumps as before.
    if (didRepeatRef.current) {
      didRepeatRef.current = false
      return
    }
    scrollTabs(dir)
  }, [scrollTabs])

  // (b) DRAG-TO-SCROLL the strip with a pressed pointer. A small movement
  //     threshold keeps a click-on-tab a click (drag only engages past 5px),
  //     and `dragMovedRef` suppresses the tab's select-on-click after a drag so
  //     dragging the strip never accidentally switches tabs.
  const dragRef = useRef<{ active: boolean; startX: number; startScroll: number }>({
    active: false,
    startX: 0,
    startScroll: 0,
  })
  const dragMovedRef = useRef(false)
  const onStripPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // #6241 review: drag-to-scroll is a MOUSE affordance only — touch/pen get
    // native horizontal panning (CSS `touch-action: pan-x`), so running the
    // manual drag for them would double-scroll. Also resets `dragMovedRef` for
    // EVERY pointerdown (a tab click bubbles here first), so a genuine tab click
    // after a prior drag is never wrongly suppressed.
    if (e.button !== 0 || e.pointerType !== 'mouse') return
    const el = tablistRef.current
    if (!el) return
    dragRef.current = { active: true, startX: e.clientX, startScroll: el.scrollLeft }
    dragMovedRef.current = false
  }, [])
  const onStripPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag.active) return
    const el = tablistRef.current
    if (!el) return
    const dx = e.clientX - drag.startX
    if (!dragMovedRef.current && Math.abs(dx) <= 5) return
    dragMovedRef.current = true
    el.setPointerCapture?.(e.pointerId)
    el.scrollLeft = drag.startScroll - dx
  }, [])
  const endStripDrag = useCallback(() => {
    dragRef.current.active = false
    // #6241 review: clear the drag marker on the next tick (same rationale as the
    // hold marker) so a drag that ends WITHOUT a trailing tab-click — including a
    // later keyboard activation of a tab, which fires a click with no preceding
    // pointerdown to reset the flag — isn't wrongly suppressed.
    setTimeout(() => {
      dragMovedRef.current = false
    }, 0)
  }, [])

  // Clear any in-flight hold timer/interval on unmount so a press-and-hold that
  // outlives the view never fires into a torn-down ref.
  useEffect(() => stopHold, [stopHold])
  // Keep the active tab visible when it changes programmatically (deep-link,
  // forceTab, ArrowLeft/Right roving) — scroll it into view within the strip
  // only (inline:'nearest' won't scroll the page vertically).
  useEffect(() => {
    const el = tablistRef.current
    if (!el) return
    const active = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    // Optional-call: jsdom doesn't implement scrollIntoView; a missing method
    // must not throw during render.
    active?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
    updateScrollAffordance()
  }, [tab, updateScrollAffordance])

  return (
    <div className="cr-view" data-testid="control-room-view">
      <div className="cr-tabs-wrap">
        <button
          type="button"
          className={`cr-tab-chevron cr-tab-chevron-left${scrollState.left ? '' : ' cr-tab-chevron-hidden'}`}
          aria-label="Scroll tabs left"
          aria-hidden={!scrollState.left}
          tabIndex={-1}
          data-testid="cr-tabs-chevron-left"
          onClick={() => handleChevronClick(-1)}
          onPointerDown={() => startHold(-1)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
        >
          ‹
        </button>
        <div
          className="cr-tabs"
          role="tablist"
          aria-label="Control Room sections"
          data-testid="cr-tabs"
          ref={tablistRef}
          onScroll={updateScrollAffordance}
          onPointerDown={onStripPointerDown}
          onPointerMove={onStripPointerMove}
          onPointerUp={endStripDrag}
          onPointerCancel={endStripDrag}
          onPointerLeave={endStripDrag}
        >
        {CONTROL_ROOM_TABS.filter((t) => isTabVisible(t.key)).map((t, i) => {
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
              onClick={() => {
                // #6230: a drag on the strip ends with a click on whatever tab
                // was under the pointer — suppress that select so dragging never
                // switches tabs. A plain click never set dragMoved.
                if (dragMovedRef.current) {
                  dragMovedRef.current = false
                  return
                }
                selectTab(t.key)
              }}
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
        <button
          type="button"
          className={`cr-tab-chevron cr-tab-chevron-right${scrollState.right ? '' : ' cr-tab-chevron-hidden'}`}
          aria-label="Scroll tabs right"
          aria-hidden={!scrollState.right}
          tabIndex={-1}
          data-testid="cr-tabs-chevron-right"
          onClick={() => handleChevronClick(1)}
          onPointerDown={() => startHold(1)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
        >
          ›
        </button>
      </div>
      {tab === 'repos' ? (
        <ControlRoomSection onInvestigate={onInvestigate} onOpenSession={onOpenSession} onConfigureRepo={onConfigureRepo} />
      ) : tab === 'runners' ? (
        <RunnerStatusSection />
      ) : tab === 'containers' ? (
        <ContainersStatusSection />
      ) : tab === 'repo-config' ? (
        <RepoRuntimeConfigSection />
      ) : tab === 'byok-pool' ? (
        <ByokPoolSection />
      ) : tab === 'host-prune' ? (
        <HostPruneSection />
      ) : tab === 'device-runtimes' ? (
        <DeviceRuntimesSection />
      ) : tab === 'integrations' ? (
        <IntegrationsSection />
      ) : tab === 'skills' ? (
        <SkillsInventorySection />
      ) : tab === 'mailbox' ? (
        <MailboxPanel />
      ) : tab === 'repo-events' ? (
        <RepoEventsSection />
      ) : tab === 'runs' ? (
        <OrchestrationRunsSection />
      ) : tab === 'mission-control' ? (
        <MissionControlTab />
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
