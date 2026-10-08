/** #8268 — the persistent "Chroxy was updated — Reload" prompt. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { StaleBundleBanner } from './StaleBundleBanner'

afterEach(cleanup)

const base = { clientVersion: '0.11.2', clientBuildId: 'aaaa', serverVersion: '0.11.4', serverBuildId: 'bbbb' }

describe('StaleBundleBanner', () => {
  it('renders nothing for a current page', () => {
    render(<StaleBundleBanner stale={null} onReload={vi.fn()} />)
    expect(screen.queryByTestId('stale-bundle-banner')).not.toBeInTheDocument()
  })

  it('says the app was updated, names both versions, and reloads on click', () => {
    const onReload = vi.fn()
    render(<StaleBundleBanner stale={base} onReload={onReload} />)
    expect(screen.getByTestId('stale-bundle-message').textContent).toBe('Chroxy was updated — Reload')
    expect(screen.getByTestId('stale-bundle-detail').textContent).toContain('v0.11.2')
    expect(screen.getByTestId('stale-bundle-detail').textContent).toContain('v0.11.4')
    fireEvent.click(screen.getByTestId('stale-bundle-reload'))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('says "rebuilt" when the versions are equal but the builds differ', () => {
    render(<StaleBundleBanner stale={{ ...base, clientVersion: '0.11.4' }} onReload={vi.fn()} />)
    expect(screen.getByTestId('stale-bundle-detail').textContent).toContain('rebuilt')
  })

  it('is persistent: there is no dismiss control', () => {
    render(<StaleBundleBanner stale={base} onReload={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
