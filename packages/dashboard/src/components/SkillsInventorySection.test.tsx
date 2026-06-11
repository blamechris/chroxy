/**
 * SkillsInventorySection (#5554) — renderer tests.
 *
 * Covers the surface against a mocked `skills_inventory_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - summary chips (global / repos-with-overlay / used)
 *   - the Global card + one card per repo overlay
 *   - skill rows: usage line, manual / inactive / overrides-global / trust tags
 *   - expandable description (tap to expand)
 *   - default sort = recently used
 *   - per-repo error chip degradation + globalError + top-level error callout
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { SkillInventoryEntry, SkillInventoryRepo, ServerSkillsInventorySnapshotMessage } from '@chroxy/protocol'

// The component reads the store unconditionally (React hooks must be called
// every render); our tests drive it via props, so a minimal store stub keeps
// the unused store selectors from touching a real zustand store.
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      skillsInventory: null,
      skillsInventoryLoading: false,
      connectionPhase: 'connected',
      requestSkillsInventory: () => false,
    }),
}))
import { SkillsInventorySection, sortByRecentlyUsed } from './SkillsInventorySection'

afterEach(cleanup)

const NOW = Date.parse('2026-06-11T12:00:00.000Z')

function skill(over: Partial<SkillInventoryEntry> = {}): SkillInventoryEntry {
  return {
    name: 'batch-merge',
    description: 'Merge a batch of PRs',
    source: 'global',
    activation: 'auto',
    active: true,
    providers: [],
    version: null,
    trustState: null,
    communityAuthor: null,
    hash: '0a76684',
    installed: '2026-06-03',
    lastUsed: '2026-06-10T00:00:00.000Z',
    useCount: 12,
    usedRepos: ['/Users/x/Projects/chroxy'],
    ...over,
  }
}

function snapshot(over: Partial<ServerSkillsInventorySnapshotMessage> = {}): ServerSkillsInventorySnapshotMessage {
  return {
    type: 'skills_inventory_snapshot',
    generatedAt: '2026-06-11T11:50:00.000Z',
    root: '/Users/x/Projects',
    global: [skill()],
    globalError: null,
    repos: [
      {
        name: 'chroxy',
        path: '/Users/x/Projects/chroxy',
        skills: [skill({ name: 'coding-style', source: 'repo', hash: null, installed: null, overridesGlobal: true, lastUsed: null, useCount: 0, usedRepos: [] })],
        error: null,
      },
    ],
    ...over,
  }
}

const baseProps = { connected: true, loading: false, onRefresh: () => {}, now: () => NOW }

describe('SkillsInventorySection — empty / loading states', () => {
  it('shows the empty state with a Run survey button before the first snapshot', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={null} />)
    expect(screen.getByTestId('skills-empty')).toBeTruthy()
    expect(screen.getByTestId('skills-empty-refresh')).toBeTruthy()
  })

  it('shows a loading message while a survey is in flight', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={null} loading />)
    expect(screen.getByTestId('skills-empty').textContent).toContain('Running the skills inventory survey')
  })

  it('shows a not-connected note when disconnected', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={null} connected={false} />)
    expect(screen.getByTestId('skills-not-connected')).toBeTruthy()
  })
})

describe('SkillsInventorySection — snapshot rendering', () => {
  it('renders the summary chips', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot()} />)
    expect(screen.getByTestId('skills-chip-count-global').textContent).toBe('1')
    expect(screen.getByTestId('skills-chip-count-overlays').textContent).toBe('1')
    // batch-merge is used (count 12); coding-style is not — so 1 used.
    expect(screen.getByTestId('skills-chip-count-used').textContent).toBe('1')
  })

  it('renders the Global card and one card per repo overlay', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot()} />)
    expect(screen.getByTestId('skills-card-global')).toBeTruthy()
    expect(screen.getByTestId('skills-card-repo-chroxy')).toBeTruthy()
    expect(screen.getByTestId('skills-card-global-count').textContent).toBe('1 skill')
  })

  it('renders the usage line + hash/installed on a used global skill', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot()} />)
    expect(screen.getByTestId('skill-usage-global-batch-merge').textContent).toContain('12×')
    expect(screen.getByTestId('skill-sub-global-batch-merge').textContent).toContain('0a76684')
    expect(screen.getByTestId('skill-sub-global-batch-merge').textContent).toContain('installed 2026-06-03')
  })

  it('flags a repo skill that overrides a global one', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot()} />)
    expect(screen.getByTestId('skill-override-repo-chroxy-coding-style')).toBeTruthy()
  })

  it('shows "never used" for a skill with no usage', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot()} />)
    expect(screen.getByTestId('skill-usage-repo-chroxy-coding-style').textContent).toContain('never used')
  })

  it('expands the description on tap', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot()} />)
    expect(screen.queryByTestId('skill-desc-global-batch-merge')).toBeNull()
    fireEvent.click(screen.getByTestId('skill-head-global-batch-merge'))
    expect(screen.getByTestId('skill-desc-global-batch-merge').textContent).toContain('Merge a batch of PRs')
  })

  it('renders manual + inactive tags', () => {
    const snap = snapshot({ global: [skill({ name: 'risky', activation: 'manual', active: false })] })
    render(<SkillsInventorySection {...baseProps} snapshot={snap} />)
    expect(screen.getByTestId('skill-manual-global-risky')).toBeTruthy()
    expect(screen.getByTestId('skill-inactive-global-risky')).toBeTruthy()
  })

  it('renders a trust-pending flag for a community skill', () => {
    const snap = snapshot({ global: [skill({ name: 'shared', trustState: 'pending', communityAuthor: 'alice' })] })
    render(<SkillsInventorySection {...baseProps} snapshot={snap} />)
    expect(screen.getByTestId('skill-trust-global-shared').textContent).toContain('Trust pending')
  })
})

describe('SkillsInventorySection — degradation', () => {
  it('renders an error chip + detail on a repo whose overlay scan failed', () => {
    const repos: SkillInventoryRepo[] = [
      { name: 'broken', path: '/p/broken', skills: [], error: 'overlay blew up' },
    ]
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot({ repos })} />)
    expect(screen.getByTestId('skills-card-repo-broken-error').textContent).toContain('scan failed')
    expect(screen.getByTestId('skills-card-repo-broken-error-detail').textContent).toContain('overlay blew up')
  })

  it('renders the global error chip when the global tier scan failed', () => {
    render(<SkillsInventorySection {...baseProps} snapshot={snapshot({ global: [], globalError: 'global blew up' })} />)
    expect(screen.getByTestId('skills-card-global-error').textContent).toContain('scan failed')
  })

  it('renders the top-level degraded-survey callout', () => {
    const snap = snapshot({ global: [], repos: [], error: { code: 'FORBIDDEN', message: 'no authority' } })
    render(<SkillsInventorySection {...baseProps} snapshot={snap} />)
    expect(screen.getByTestId('skills-error').textContent).toContain('no authority')
    expect(screen.getByTestId('skills-error').textContent).toContain('FORBIDDEN')
  })
})

describe('SkillsInventorySection — refresh', () => {
  it('dispatches the request on Refresh and disables it while loading', () => {
    let called = 0
    const { rerender } = render(
      <SkillsInventorySection {...baseProps} snapshot={snapshot()} onRefresh={() => { called++ }} />,
    )
    fireEvent.click(screen.getByTestId('skills-refresh'))
    expect(called).toBe(1)

    rerender(<SkillsInventorySection {...baseProps} snapshot={snapshot()} loading onRefresh={() => { called++ }} />)
    const btn = screen.getByTestId('skills-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe('sortByRecentlyUsed', () => {
  it('orders used skills newest-first, never-used last by name', () => {
    const skills = [
      skill({ name: 'old', lastUsed: '2026-06-01T00:00:00.000Z', useCount: 1 }),
      skill({ name: 'zeta', lastUsed: null, useCount: 0 }),
      skill({ name: 'new', lastUsed: '2026-06-10T00:00:00.000Z', useCount: 1 }),
      skill({ name: 'alpha', lastUsed: null, useCount: 0 }),
    ]
    expect(sortByRecentlyUsed(skills).map((s) => s.name)).toEqual(['new', 'old', 'alpha', 'zeta'])
  })
})
