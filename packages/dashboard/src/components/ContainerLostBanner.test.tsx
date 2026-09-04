/**
 * #7603 — ContainerLostBanner render tests.
 *
 * Genuinely red-first: the dashboard had NO in-view per-session health banner
 * before this component, so every assertion here fails against `main`.
 *
 * The load-bearing ones are the negative assertions. The whole point of the
 * banner is that a vanished container is NOT a crash: if this ever degrades
 * into the crash copy ("delete this session"), the operator destroys a session
 * the daemon was about to recover (#7602). The tap-target assertions pin the
 * repo's 44x44 floor, which the SessionNotFoundChip template violates.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ContainerLostBanner } from './ContainerLostBanner'

afterEach(() => { cleanup() })

describe('<ContainerLostBanner>', () => {
  it('renders the recoverable "waiting" copy when no reattach refusal is present', () => {
    render(<ContainerLostBanner reattachError={null} onDismiss={() => {}} />)
    const banner = screen.getByTestId('container-lost-banner')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveAttribute('data-variant', 'waiting')
    expect(screen.getByTestId('container-lost-banner-text')).toHaveTextContent(
      /will re-enter it automatically/i,
    )
    expect(screen.queryByTestId('container-lost-banner-detail')).toBeNull()
  })

  it('switches to the "refused" copy and shows the reason when the server declined re-entry', () => {
    render(
      <ContainerLostBanner
        reattachError="the environment now runs a different container (abc123456789)"
        onDismiss={() => {}}
      />,
    )
    const banner = screen.getByTestId('container-lost-banner')
    expect(banner).toHaveAttribute('data-variant', 'refused')
    expect(screen.getByTestId('container-lost-banner-text')).toHaveTextContent(
      /could not re-enter it/i,
    )
    expect(screen.getByTestId('container-lost-banner-detail')).toHaveTextContent(
      'the environment now runs a different container (abc123456789)',
    )
  })

  it('treats a blank refusal as absent rather than rendering an empty reason line', () => {
    render(<ContainerLostBanner reattachError="   " onDismiss={() => {}} />)
    expect(screen.getByTestId('container-lost-banner')).toHaveAttribute('data-variant', 'waiting')
    expect(screen.queryByTestId('container-lost-banner-detail')).toBeNull()
  })

  it('NEVER renders crash / delete-the-session copy — this state is recoverable', () => {
    // The regression this guards: reusing the crash render path (or copying its
    // wording) tells the operator to destroy a session that is about to recover.
    for (const reattachError of [null, 'container was rebuilt']) {
      cleanup()
      render(<ContainerLostBanner reattachError={reattachError} onDismiss={() => {}} />)
      const text = screen.getByTestId('container-lost-banner').textContent ?? ''
      expect(text).not.toMatch(/crash/i)
      expect(text).not.toMatch(/delete/i)
      expect(text).not.toMatch(/free resources/i)
    }
  })

  it('offers a Retry affordance that fires onRetry', () => {
    const onRetry = vi.fn()
    render(<ContainerLostBanner reattachError={null} onRetry={onRetry} onDismiss={() => {}} />)
    fireEvent.click(screen.getByTestId('container-lost-banner-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('hides Retry when there is nothing to resend (no user turn yet)', () => {
    // A dead control is worse than no control — same contract as StreamStallChip.
    render(<ContainerLostBanner reattachError={null} onDismiss={() => {}} />)
    expect(screen.queryByTestId('container-lost-banner-retry')).toBeNull()
  })

  it('offers a Dismiss affordance that fires onDismiss', () => {
    const onDismiss = vi.fn()
    render(<ContainerLostBanner reattachError={null} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('container-lost-banner-dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('gives BOTH controls a >= 44px tap target (repo floor; the chip template violates it)', () => {
    render(<ContainerLostBanner reattachError={null} onRetry={() => {}} onDismiss={() => {}} />)
    for (const id of ['container-lost-banner-retry', 'container-lost-banner-dismiss']) {
      const el = screen.getByTestId(id) as HTMLElement
      expect(parseInt(el.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
      expect(parseInt(el.style.minWidth, 10)).toBeGreaterThanOrEqual(44)
    }
  })

  it('labels both controls for assistive tech', () => {
    render(<ContainerLostBanner reattachError={null} onRetry={() => {}} onDismiss={() => {}} />)
    expect(screen.getByTestId('container-lost-banner-retry')).toHaveAttribute('aria-label')
    expect(screen.getByTestId('container-lost-banner-dismiss')).toHaveAttribute('aria-label')
  })
})
