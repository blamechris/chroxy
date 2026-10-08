/**
 * #8268 — the header shows the SERVER's version, which hides a stale page. When this
 * window's bundle is a different build, the client's version is shown beside it.
 * The heavy children are stubbed: only the version badges are under test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('./ChatSettingsDropdown', () => ({ ChatSettingsDropdown: () => null }))
vi.mock('./NotificationsWidget', () => ({ NotificationsWidget: () => null }))
vi.mock('./HeaderOverflowMenu', () => ({ HeaderOverflowMenu: () => null }))
vi.mock('./StatusBar', () => ({ StatusBar: () => null }))
vi.mock('./DevPreviewChip', () => ({ DevPreviewChip: () => null }))
vi.mock('./SessionCiChip', () => ({ SessionCiChip: () => null }))

const { AppHeader } = await import('./AppHeader')

afterEach(cleanup)

function renderHeader(over: Record<string, unknown>) {
  const props = {
    serverVersion: '0.11.4', connectionPhase: 'connected', serverPhase: null, isConnected: true, tunnelReady: true,
    devPreviews: [], sessionNotifications: [], ...over,
  }
  return render(<AppHeader {...(props as unknown as Parameters<typeof AppHeader>[0])} />)
}

describe('AppHeader client-version badge (#8268)', () => {
  it('shows only the server version when the bundle matches', () => {
    renderHeader({ clientVersion: '0.11.4' })
    expect(screen.queryByTestId('client-version-badge')).not.toBeInTheDocument()
    expect(document.querySelector('.version-badge')!.textContent).toBe('v0.11.4')
  })

  it('shows BOTH versions when the client bundle differs from the server', () => {
    renderHeader({ clientVersion: '0.11.2' })
    expect(document.querySelector('.version-badge')!.textContent).toBe('v0.11.4')
    const client = screen.getByTestId('client-version-badge')
    expect(client.textContent).toBe('app v0.11.2')
    expect(client.getAttribute('title')).toContain('v0.11.2')
    expect(client.getAttribute('title')).toContain('v0.11.4')
  })

  it('flags a same-version rebuilt bundle as outdated', () => {
    renderHeader({ clientVersion: '0.11.4', bundleStale: true })
    expect(screen.getByTestId('client-version-badge').textContent).toBe('app outdated')
  })

  it('does not compare the client with itself while disconnected (no server version)', () => {
    renderHeader({ serverVersion: null, clientVersion: '0.11.2', connectionPhase: 'disconnected', isConnected: false })
    expect(screen.queryByTestId('client-version-badge')).not.toBeInTheDocument()
    expect(document.querySelector('.version-badge')!.textContent).toBe('v0.11.2')
  })
})
