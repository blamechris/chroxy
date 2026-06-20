/**
 * RepoRuntimeConfigSection (#6139, epic #5530) — renderer tests.
 *
 * Covers the read-only surface against a mocked `repo_runtime_config_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - host-level defaults (backend + source, isolation, allowlist) render
 *   - summary chips render the per-bucket counts
 *   - one row per repo with devcontainer/compose presence, image + source
 *   - the allowlist verdict: allowed / denied / n-a (default image)
 *   - a per-repo error row, and the degraded-survey error banner
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerRepoRuntimeConfigSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      repoRuntimeConfig: null,
      repoRuntimeConfigLoading: false,
      connectionPhase: 'connected',
      requestRepoRuntimeConfig: () => false,
    }),
}))
import { RepoRuntimeConfigSection } from './RepoRuntimeConfigSection'

afterEach(cleanup)

type RepoEntry = ServerRepoRuntimeConfigSnapshotMessage['repos'][number]

function repo(over: Partial<RepoEntry> = {}): RepoEntry {
  return {
    name: 'app',
    path: '/Users/me/Projects/app',
    devcontainer: { present: true, path: '/Users/me/Projects/app/.devcontainer/devcontainer.json' },
    compose: { present: false, files: [] },
    image: 'node:22',
    imageSource: 'devcontainer',
    imageAllowed: true,
    error: null,
    ...over,
  }
}

function snapshot(over: Partial<ServerRepoRuntimeConfigSnapshotMessage> = {}): ServerRepoRuntimeConfigSnapshotMessage {
  return {
    type: 'repo_runtime_config_snapshot',
    generatedAt: '2026-06-19T12:00:00.000Z',
    backend: 'docker',
    backendSource: 'default',
    isolation: 'worktree-before-docker',
    allowlist: { source: 'default', patterns: ['node:*', 'python:*'] },
    repos: [
      repo({ name: 'app', path: '/Users/me/Projects/app' }),
      repo({
        name: 'lib',
        path: '/Users/me/Projects/lib',
        devcontainer: { present: false, path: null },
        compose: { present: true, files: ['docker-compose.yml'] },
        image: 'node:22-slim',
        imageSource: 'default',
        imageAllowed: null,
      }),
    ],
    summary: { total: 2, withDevcontainer: 1, withCompose: 1, imagesDenied: 0, errored: 0 },
    ...over,
  }
}

describe('RepoRuntimeConfigSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run survey button before the first snapshot', () => {
    render(<RepoRuntimeConfigSection snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-empty')).toBeTruthy()
    expect(screen.getByTestId('repo-config-empty-refresh')).toBeTruthy()
    expect(screen.queryByTestId('repo-config-table')).toBeNull()
  })

  it('renders a loading state', () => {
    render(<RepoRuntimeConfigSection snapshot={null} loading={true} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-empty').textContent).toContain('Running the repo runtime config survey')
  })

  it('shows a not-connected hint and disables Run survey when disconnected', () => {
    render(<RepoRuntimeConfigSection snapshot={null} loading={false} connected={false} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-not-connected')).toBeTruthy()
    expect((screen.getByTestId('repo-config-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('RepoRuntimeConfigSection — populated', () => {
  it('renders host-level defaults (backend + source, isolation, allowlist)', () => {
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-backend').textContent).toContain('docker')
    expect(screen.getByTestId('repo-config-backend').textContent).toContain('default')
    expect(screen.getByTestId('repo-config-isolation').textContent).toContain('worktree-before-docker')
    expect(screen.getByTestId('repo-config-allowlist').textContent).toContain('2')
  })

  it('renders summary chips with the per-bucket counts', () => {
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-chip-total').textContent).toContain('2')
    expect(screen.getByTestId('repo-config-chip-devcontainer').textContent).toContain('1')
    expect(screen.getByTestId('repo-config-chip-compose').textContent).toContain('1')
  })

  it('renders a row per repo with image + source', () => {
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-row-/Users/me/Projects/app')).toBeTruthy()
    expect(screen.getByTestId('repo-config-row-/Users/me/Projects/lib')).toBeTruthy()
    const appImage = screen.getByTestId('repo-config-image-/Users/me/Projects/app')
    expect(appImage.textContent).toContain('node:22')
    expect(appImage.textContent).toContain('devcontainer')
  })

  it('shows compose files when present and "—" when absent', () => {
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-compose-/Users/me/Projects/app').textContent).toBe('—')
    expect(screen.getByTestId('repo-config-compose-/Users/me/Projects/lib').textContent).toContain('docker-compose.yml')
  })

  it('renders the allowlist verdict: allowed, denied, and n/a for the default image', () => {
    const snap = snapshot({
      summary: { total: 3, withDevcontainer: 2, withCompose: 0, imagesDenied: 1, errored: 0 },
      repos: [
        repo({ path: '/a', imageAllowed: true }),
        repo({ path: '/b', imageAllowed: false }),
        repo({ path: '/c', imageSource: 'default', imageAllowed: null }),
      ],
    })
    render(<RepoRuntimeConfigSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-verdict-/a').textContent).toContain('allowed')
    expect(screen.getByTestId('repo-config-verdict-/b').textContent).toContain('denied')
    expect(screen.getByTestId('repo-config-verdict-/c').textContent).toContain('n/a')
  })

  it('renders the images-denied chip only when there are denials', () => {
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.queryByTestId('repo-config-chip-denied')).toBeNull()
    const snap = snapshot({ summary: { total: 1, withDevcontainer: 0, withCompose: 0, imagesDenied: 1, errored: 0 } })
    cleanup()
    render(<RepoRuntimeConfigSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-chip-denied').textContent).toContain('1')
  })

  it('renders a per-repo error row', () => {
    const snap = snapshot({
      summary: { total: 1, withDevcontainer: 0, withCompose: 0, imagesDenied: 0, errored: 1 },
      repos: [repo({ path: '/x', error: 'cwd unreadable', image: null, imageSource: null, imageAllowed: null })],
    })
    render(<RepoRuntimeConfigSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    const err = screen.getByTestId('repo-config-error-/x')
    expect(err.textContent).toContain('cwd unreadable')
    expect(err.getAttribute('role')).toBe('alert')
  })

  it('surfaces a degraded-survey error banner', () => {
    const snap = snapshot({
      repos: [],
      summary: { total: 0, withDevcontainer: 0, withCompose: 0, imagesDenied: 0, errored: 0 },
      error: { code: 'SURVEY_FAILED', message: 'fs unreachable' },
    })
    render(<RepoRuntimeConfigSection snapshot={snap} loading={false} connected={true} onRefresh={() => {}} />)
    const banner = screen.getByTestId('repo-config-error')
    expect(banner.textContent).toContain('SURVEY_FAILED')
    expect(banner.textContent).toContain('fs unreachable')
  })

  it('renders the no-repos row when the survey found nothing', () => {
    render(<RepoRuntimeConfigSection snapshot={snapshot({ repos: [], summary: { total: 0, withDevcontainer: 0, withCompose: 0, imagesDenied: 0, errored: 0 } })} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('repo-config-none')).toBeTruthy()
  })
})

describe('RepoRuntimeConfigSection — refresh', () => {
  it('dispatches onRefresh when Refresh is clicked', () => {
    const onRefresh = vi.fn()
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('repo-config-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables Refresh while loading and does not dispatch', () => {
    const onRefresh = vi.fn()
    render(<RepoRuntimeConfigSection snapshot={snapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    const btn = screen.getByTestId('repo-config-refresh') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
