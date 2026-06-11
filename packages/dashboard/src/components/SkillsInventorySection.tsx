/**
 * SkillsInventorySection (#5554, epic #5159) — the "Skills" Control Room tab.
 *
 * Renders the host's skill inventory the server returns in a
 * `skills_inventory_snapshot`: an eyebrow + title + Refresh + subtitle, a row of
 * summary chips (global skills / repos with an overlay / skills used), and a set
 * of cards:
 *
 *   - Global card: every skill in `~/.chroxy/skills/` — name, description
 *     (expandable), activation mode, trust state, content hash + installed date
 *     (joined from `skills.lock`), and usage (last used / count / repos).
 *   - Per-repo cards: each surveyed repo's `.chroxy/skills/` overlay — which
 *     skills a session in that repo gains or OVERRIDES (an `overridesGlobal`
 *     skill is flagged). A repo with no overlay renders a quiet "no overlay"
 *     note; a repo whose scan FAILED renders an error chip on the card, never a
 *     dead tab.
 *
 * Skill BODIES never reach the client (the server's #5554 security boundary) —
 * this panel only ever has names / descriptions / metadata to render.
 *
 * Default sort is RECENTLY USED (the "previously used skills" ask): skills with
 * a `lastUsed` sort newest-first, never-used skills fall to the bottom in
 * name order.
 *
 * Same pull-on-Refresh data flow as the sibling Integrations tab: the Refresh
 * button dispatches `skills_inventory_request` via the store's
 * `requestSkillsInventory`; the server replies with one
 * `skills_inventory_snapshot` handled into `skillsInventory`. No delta stream —
 * each refresh replaces the whole inventory. The #5546 staleness guard +
 * auto-fetch-on-activation come free via the Control Room tab registry.
 */
import { useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { SkillInventoryEntry, SkillInventoryRepo, ServerSkillsInventorySnapshotMessage } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'

/** ISO date (no time) for the eyebrow, e.g. "2026-06-11". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** Relative "ago" string for a usage cell, or "never". */
function formatUsedAgo(iso: string | null, nowMs: number): string {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return 'never'
  const deltaSec = Math.floor((nowMs - ms) / 1000)
  if (!Number.isFinite(deltaSec) || deltaSec < 60) return 'just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/** basename of a repo path for compact "used in" chips. */
function repoBase(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/**
 * Default inventory sort: recently used first (lastUsed desc), then never-used
 * skills by name. The "previously used skills" ask — the most recently fired
 * skill bubbles to the top of each card.
 */
export function sortByRecentlyUsed(skills: readonly SkillInventoryEntry[]): SkillInventoryEntry[] {
  return skills.slice().sort((a, b) => {
    const aMs = a.lastUsed ? Date.parse(a.lastUsed) : NaN
    const bMs = b.lastUsed ? Date.parse(b.lastUsed) : NaN
    const aUsed = !Number.isNaN(aMs)
    const bUsed = !Number.isNaN(bMs)
    if (aUsed && bUsed) return bMs - aMs
    if (aUsed) return -1
    if (bUsed) return 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** Trust flag for a skill, or null when it's a plain (implicitly-trusted) skill. */
function trustFlag(skill: SkillInventoryEntry): { label: string; accent: 'warn' | 'bad' } | null {
  if (skill.trustState === 'pending') return { label: 'Trust pending', accent: 'warn' }
  return null
}

/** One inventory skill row: a header line + an expandable description body. */
function SkillRow({ skill, nowMs, testIdPrefix }: { skill: SkillInventoryEntry; nowMs: number; testIdPrefix: string }) {
  const [expanded, setExpanded] = useState(false)
  const trust = trustFlag(skill)
  const hasDescription = typeof skill.description === 'string' && skill.description.trim().length > 0
  const rowId = `${testIdPrefix}-${skill.name}`

  return (
    <li className="cr-skill" data-testid={`skill-row-${rowId}`}>
      <button
        type="button"
        className="cr-skill-head"
        data-testid={`skill-head-${rowId}`}
        onClick={() => hasDescription && setExpanded((v) => !v)}
        aria-expanded={hasDescription ? expanded : undefined}
        disabled={!hasDescription}
      >
        <span className="cr-skill-name" data-testid={`skill-name-${rowId}`}>{skill.name}</span>

        {skill.activation === 'manual' && (
          <span className="cr-tag" data-testid={`skill-manual-${rowId}`} title="Manual activation — opt in per session">manual</span>
        )}
        {skill.active === false && (
          <span className="cr-tag" data-testid={`skill-inactive-${rowId}`} title="Not in the default-active set">inactive</span>
        )}
        {skill.overridesGlobal && (
          <span className="cr-tag cr-tag-warn" data-testid={`skill-override-${rowId}`} title="Shadows a global skill of the same name">overrides global</span>
        )}
        {trust && (
          <span className={`cr-tag cr-tag-${trust.accent}`} data-testid={`skill-trust-${rowId}`} title={skill.communityAuthor ? `community/${skill.communityAuthor}` : undefined}>
            {trust.label}
          </span>
        )}

        <span className="cr-skill-meta cr-dim" data-testid={`skill-usage-${rowId}`}>
          {skill.useCount > 0
            ? `used ${formatUsedAgo(skill.lastUsed, nowMs)} · ${skill.useCount}×`
            : 'never used'}
        </span>
      </button>

      <div className="cr-skill-sub cr-dim cr-mono" data-testid={`skill-sub-${rowId}`}>
        {skill.providers.length > 0 ? skill.providers.join(', ') : 'all providers'}
        {skill.version ? ` · v${skill.version}` : ''}
        {skill.hash ? ` · ${skill.hash}` : ''}
        {skill.installed ? ` · installed ${skill.installed}` : ''}
        {skill.usedRepos.length > 0 ? ` · in ${skill.usedRepos.map(repoBase).join(', ')}` : ''}
      </div>

      {hasDescription && expanded && (
        <p className="cr-skill-desc" data-testid={`skill-desc-${rowId}`}>{skill.description}</p>
      )}
    </li>
  )
}

/** A card listing a set of skills (the Global card or one repo's overlay). */
function SkillCard({
  title,
  subtitle,
  skills,
  nowMs,
  testId,
  testIdPrefix,
  error,
  emptyNote,
}: {
  title: string
  subtitle?: React.ReactNode
  skills: readonly SkillInventoryEntry[]
  nowMs: number
  testId: string
  testIdPrefix: string
  error?: string | null
  emptyNote: string
}) {
  const sorted = sortByRecentlyUsed(skills)
  return (
    <section className="cr-skill-card" data-testid={testId}>
      <header className="cr-skill-card-head">
        <h2 className="cr-skill-card-title" data-testid={`${testId}-title`}>{title}</h2>
        {error ? (
          <span className="cr-tag cr-tag-bad" data-testid={`${testId}-error`} title={error}>scan failed</span>
        ) : (
          <span className="cr-chip" data-testid={`${testId}-count`}>{skills.length} skill{skills.length === 1 ? '' : 's'}</span>
        )}
      </header>
      {subtitle && <p className="cr-sub cr-dim" data-testid={`${testId}-sub`}>{subtitle}</p>}
      {error ? (
        <p className="cr-callout" data-testid={`${testId}-error-detail`}><b>Overlay scan failed:</b> {error}</p>
      ) : sorted.length === 0 ? (
        <p className="cr-dim" data-testid={`${testId}-empty`}>{emptyNote}</p>
      ) : (
        <ul className="cr-skill-list" data-testid={`${testId}-list`}>
          {sorted.map((skill) => (
            <SkillRow key={skill.name} skill={skill} nowMs={nowMs} testIdPrefix={testIdPrefix} />
          ))}
        </ul>
      )}
    </section>
  )
}

export interface SkillsInventorySectionProps {
  /** Snapshot override (defaults to the store's `skillsInventory`). For tests. */
  snapshot?: ServerSkillsInventorySnapshotMessage | null
  /** Loading override (defaults to `skillsInventoryLoading`). For tests. */
  loading?: boolean
  /** Connected override (defaults to `connectionPhase === 'connected'`). For tests. */
  connected?: boolean
  /** Refresh override (defaults to `requestSkillsInventory`). For tests. */
  onRefresh?: () => void
  /** `now` seam for deterministic "ago" rendering. For tests. */
  now?: () => number
}

export function SkillsInventorySection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: SkillsInventorySectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.skillsInventory)
  const storeLoading = useConnectionStore((s) => s.skillsInventoryLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestSkillsInventory = useConnectionStore((s) => s.requestSkillsInventory)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestSkillsInventory

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const nowMs = now()

  // Summary tallies for the chip row.
  const repos: readonly SkillInventoryRepo[] = snapshot?.repos ?? []
  const reposWithOverlay = repos.filter((r) => r.skills.length > 0).length
  const usedCount = (snapshot
    ? [...snapshot.global, ...repos.flatMap((r) => r.skills)].filter((s) => s.useCount > 0).length
    : 0)

  return (
    <div className="cr-section" data-testid="skills-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="skills-eyebrow">
          host · skills{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Skills</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="skills-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="skills-sub">
            Installed chroxy skills across the global <span className="cr-mono">~/.chroxy/skills/</span> tier and the
            per-repo <span className="cr-mono">.chroxy/skills/</span> overlays under{' '}
            <span className="cr-mono">{snapshot.root}</span> — descriptions, trust state, hashes, install dates, and
            usage history. Sorted by most recently used.
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="skills-generated">
            {formatGeneratedAgo(generatedAtMs, nowMs)}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="skills-empty">
          {loading ? (
            <span>Running the skills inventory survey…</span>
          ) : (
            <>
              <p>No skills inventory yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="skills-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="skills-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="skills-chips">
            <span className="cr-chip" data-testid="skills-chip-global">
              Global: <b data-testid="skills-chip-count-global">{snapshot.global.length}</b>
            </span>
            <span className="cr-chip" data-testid="skills-chip-overlays">
              Repos with overlay: <b data-testid="skills-chip-count-overlays">{reposWithOverlay}</b>
            </span>
            <span className="cr-chip" data-testid="skills-chip-used">
              Used: <b data-testid="skills-chip-count-used">{usedCount}</b>
            </span>
          </div>

          {snapshot.error && (
            <div className="cr-callout" data-testid="skills-error">
              <b>Survey degraded:</b> {snapshot.error.message} <span className="cr-dim cr-mono">({snapshot.error.code})</span>
            </div>
          )}

          <SkillCard
            title="Global"
            subtitle={<span className="cr-mono">~/.chroxy/skills/</span>}
            skills={snapshot.global}
            nowMs={nowMs}
            testId="skills-card-global"
            testIdPrefix="global"
            error={snapshot.globalError ?? null}
            emptyNote="No global skills installed."
          />

          {repos.map((repo) => (
            <SkillCard
              key={repo.path}
              title={repo.name}
              subtitle={<span className="cr-mono">{repo.path}/.chroxy/skills/</span>}
              skills={repo.skills}
              nowMs={nowMs}
              testId={`skills-card-repo-${repo.name}`}
              testIdPrefix={`repo-${repo.name}`}
              error={repo.error}
              emptyNote="No repo-local skills overlay."
            />
          ))}
        </>
      )}
    </div>
  )
}
