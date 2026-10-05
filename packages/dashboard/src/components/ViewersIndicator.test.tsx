/**
 * ViewersIndicator (#5281 ①.3) — shared-session presence surface tests.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ViewersIndicator, resolveActivePrimaryClientId, computeViewersPopoverPosition } from './ViewersIndicator'
import type { ConnectedClient } from '../store/types'

afterEach(cleanup)

function client(overrides: Partial<ConnectedClient> = {}): ConnectedClient {
  return {
    clientId: 'c0',
    deviceName: 'MacBook Pro',
    deviceType: 'desktop',
    platform: 'macos',
    isSelf: false,
    ...overrides,
  }
}

describe('ViewersIndicator', () => {
  it('renders nothing while disconnected', () => {
    const { container } = render(
      <ViewersIndicator connected={false} clients={[client(), client({ clientId: 'c1' })]} primaryClientId={null} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there are zero clients', () => {
    const { container } = render(
      <ViewersIndicator connected clients={[]} primaryClientId={null} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a plain, non-interactive label when solo (one device)', () => {
    render(<ViewersIndicator connected clients={[client({ isSelf: true })]} primaryClientId={null} />)
    expect(screen.getByTestId('viewers-indicator-solo')).toHaveTextContent('1 client')
    // No interactive chip / popover trigger when solo.
    expect(screen.queryByTestId('viewers-indicator-trigger')).not.toBeInTheDocument()
  })

  it('renders an interactive chip with the device count when shared (≥2)', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    const trigger = screen.getByTestId('viewers-indicator-trigger')
    expect(trigger).toHaveTextContent('2')
    // Popover is closed until clicked.
    expect(screen.queryByTestId('viewers-popover')).not.toBeInTheDocument()
  })

  it('opens a popover listing each device on click', () => {
    render(
      <ViewersIndicator
        connected
        clients={[
          client({ clientId: 'c0', deviceName: 'MacBook Pro', isSelf: true }),
          client({ clientId: 'c1', deviceName: 'iPhone 17 Pro', deviceType: 'phone' }),
        ]}
        primaryClientId={null}
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    const popover = screen.getByTestId('viewers-popover')
    expect(popover).toHaveTextContent('Shared session')
    expect(screen.getByTestId('viewers-client-c0')).toHaveTextContent('MacBook Pro')
    expect(screen.getByTestId('viewers-client-c1')).toHaveTextContent('iPhone 17 Pro')
  })

  it('tags the local device "This device"', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(screen.getByTestId('viewers-self-c0')).toHaveTextContent('This device')
    expect(screen.queryByTestId('viewers-self-c1')).not.toBeInTheDocument()
  })

  it('tags the active session\'s primary client "drove last"', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId="c1"
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(screen.getByTestId('viewers-primary-c1')).toHaveTextContent('drove last')
    expect(screen.queryByTestId('viewers-primary-c0')).not.toBeInTheDocument()
  })

  it('shows no "drove last" tag when there is no primary yet', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(screen.queryByTestId('viewers-primary-c0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('viewers-primary-c1')).not.toBeInTheDocument()
  })

  it('falls back to platform/deviceType when a device has no name', () => {
    render(
      <ViewersIndicator
        connected
        clients={[
          client({ clientId: 'c0', deviceName: null, platform: 'linux', isSelf: true }),
          client({ clientId: 'c1', deviceName: null, platform: '', deviceType: 'unknown' }),
        ]}
        primaryClientId={null}
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(screen.getByTestId('viewers-client-c0')).toHaveTextContent('linux')
    expect(screen.getByTestId('viewers-client-c1')).toHaveTextContent('Unknown device')
  })

  it('gives the trigger an explicit accessible name (not just the count)', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    expect(screen.getByTestId('viewers-indicator-trigger')).toHaveAccessibleName(
      '2 clients sharing this session — show devices',
    )
  })

  it('closes the popover on Escape and restores focus to the trigger', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    const trigger = screen.getByTestId('viewers-indicator-trigger')
    fireEvent.click(trigger)
    expect(screen.getByTestId('viewers-popover')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('viewers-popover')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the popover on an outside click', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(screen.getByTestId('viewers-popover')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('viewers-popover')).not.toBeInTheDocument()
  })

  it('exposes the device count in the trigger title', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    expect(screen.getByTestId('viewers-indicator-trigger')).toHaveAttribute(
      'title',
      '2 clients sharing this session',
    )
  })

  // #5589 / #5281 — observer-role surfacing.
  describe('observer role (#5589)', () => {
    it('shows an "Observing" badge on the trigger when this client is an observer', () => {
      render(
        <ViewersIndicator
          connected
          clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1', deviceName: 'iPhone' })]}
          primaryClientId="c1"
          sessionRole="observer"
        />,
      )
      expect(screen.getByTestId('viewers-observing-badge')).toHaveTextContent('Observing')
      // The trigger names the driver in its accessible name + title.
      expect(screen.getByTestId('viewers-indicator-trigger')).toHaveAttribute(
        'title',
        'Observing — iPhone is driving',
      )
    })

    it('does NOT show the observing badge when this client is primary', () => {
      render(
        <ViewersIndicator
          connected
          clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
          primaryClientId="c0"
          sessionRole="primary"
        />,
      )
      expect(screen.queryByTestId('viewers-observing-badge')).not.toBeInTheDocument()
    })

    it('renders a Take over button in the popover and fires onTakeOver', () => {
      const onTakeOver = vi.fn()
      render(
        <ViewersIndicator
          connected
          clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1', deviceName: 'iPhone' })]}
          primaryClientId="c1"
          sessionRole="observer"
          onTakeOver={onTakeOver}
        />,
      )
      fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
      const btn = screen.getByTestId('viewers-takeover-button')
      expect(screen.getByTestId('viewers-observing-footer')).toHaveTextContent('iPhone is driving')
      fireEvent.click(btn)
      expect(onTakeOver).toHaveBeenCalledTimes(1)
    })

    it('shows no Take over affordance for a primary/unclaimed session', () => {
      render(
        <ViewersIndicator
          connected
          clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
          primaryClientId={null}
          sessionRole="unclaimed"
        />,
      )
      fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
      expect(screen.queryByTestId('viewers-takeover-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('viewers-observing-footer')).not.toBeInTheDocument()
    })
  })

  it('swaps the solo label for the interactive chip when a second device joins', () => {
    const { rerender } = render(
      <ViewersIndicator connected clients={[client({ clientId: 'c0', isSelf: true })]} primaryClientId={null} />,
    )
    expect(screen.getByTestId('viewers-indicator-solo')).toBeInTheDocument()
    expect(screen.queryByTestId('viewers-indicator-trigger')).not.toBeInTheDocument()

    rerender(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    expect(screen.queryByTestId('viewers-indicator-solo')).not.toBeInTheDocument()
    expect(screen.getByTestId('viewers-indicator-trigger')).toHaveTextContent('2')
  })
})

describe('resolveActivePrimaryClientId', () => {
  it('returns the active session\'s per-session primary', () => {
    const states = { s1: { primaryClientId: 'c1' }, s2: { primaryClientId: 'c2' } }
    expect(resolveActivePrimaryClientId('s1', states, 'cGlobal')).toBe('c1')
  })

  it('returns null (NOT the global) for a real session nobody has driven yet', () => {
    // The #5281 ①.3 review fix: a never-driven real session must not inherit a
    // stale global "drove last" from a different (default) routing context.
    const states = { s1: { primaryClientId: null } }
    expect(resolveActivePrimaryClientId('s1', states, 'cGlobal')).toBeNull()
  })

  it('returns null for an unknown active session id', () => {
    expect(resolveActivePrimaryClientId('gone', {}, 'cGlobal')).toBeNull()
  })

  it('falls back to the global primary only when there is no active session', () => {
    expect(resolveActivePrimaryClientId(null, {}, 'cGlobal')).toBe('cGlobal')
    expect(resolveActivePrimaryClientId(null, {}, null)).toBeNull()
  })
})

// #8296 — the popover was anchored right:0 inside the overflow:hidden sidebar,
// so in a narrow sidebar its left side was clipped. It is now fixed-positioned
// and clamped to the viewport.
describe('computeViewersPopoverPosition', () => {
  const viewport = { width: 1200, height: 800 }

  it('right-aligns to the trigger and sits just above it when there is room', () => {
    expect(computeViewersPopoverPosition({ top: 760, right: 600 }, viewport))
      .toEqual({ left: 360, bottom: 46, width: 240, maxHeight: 746 })
  })

  it('clamps to the left margin when the trigger is closer to the edge than the popover is wide', () => {
    // The reported case: a ~170px sidebar, chip at its right edge.
    const pos = computeViewersPopoverPosition({ top: 760, right: 170 }, viewport)
    expect(pos.left).toBe(8)
    expect(pos.width).toBe(240)
  })

  it('clamps to the right margin when the trigger is near the right edge', () => {
    expect(computeViewersPopoverPosition({ top: 760, right: 1200 }, viewport).left).toBe(952)
  })

  it('shrinks to fit a viewport narrower than the popover', () => {
    const pos = computeViewersPopoverPosition({ top: 760, right: 200 }, { width: 200, height: 800 })
    expect(pos).toMatchObject({ left: 8, width: 184 })
  })

  it('caps the height to the space above the trigger', () => {
    expect(computeViewersPopoverPosition({ top: 120, right: 600 }, viewport).maxHeight).toBe(106)
  })

  it('applies the clamped position to the rendered popover', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 760, right: 170, bottom: 780, left: 100, width: 70, height: 20, x: 100, y: 760, toJSON: () => ({}) })
    try {
      render(
        <ViewersIndicator
          connected
          clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
          primaryClientId={null}
        />,
      )
      fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
      const popover = screen.getByTestId('viewers-popover')
      expect(popover.style.left).toBe('8px')
      expect(popover.style.width).toBe('240px')
      expect(popover.style.bottom).toBe(`${window.innerHeight - 760 + 6}px`)
    } finally {
      rect.mockRestore()
    }
  })
})

// #8298 — the open popover follows its trigger: a window resize, a size change
// of the chip or its footer (ResizeObserver), and a fresh measure on reopen.
describe('ViewersIndicator popover follows its trigger', () => {
  type RectLike = { top: number, right: number }
  let rect: RectLike
  let rectSpy: ReturnType<typeof vi.spyOn>
  const observers: FakeResizeObserver[] = []

  class FakeResizeObserver {
    observed: Element[] = []
    disconnected = false
    constructor(public cb: ResizeObserverCallback) { observers.push(this) }
    observe(el: Element) { this.observed.push(el) }
    unobserve() {}
    disconnect() { this.disconnected = true }
    fire() { this.cb([], this as unknown as ResizeObserver) }
  }

  beforeEach(() => {
    observers.length = 0
    rect = { top: 760, right: 600 }
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      top: rect.top, right: rect.right, bottom: rect.top + 20, left: rect.right - 70,
      width: 70, height: 20, x: rect.right - 70, y: rect.top, toJSON: () => ({}),
    }))
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    rectSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  function renderInFooter() {
    return render(
      <div data-testid="footer">
        <ViewersIndicator
          connected
          clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
          primaryClientId={null}
        />
      </div>,
    )
  }
  const popoverLeft = () => screen.getByTestId('viewers-popover').style.left
  const observer = (i: number) => {
    const o = observers[i]
    if (!o) throw new Error(`no ResizeObserver #${i} was created`)
    return o
  }

  it('observes the trigger and its footer while open, and re-places when either resizes', () => {
    renderInFooter()
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(popoverLeft()).toBe('360px')
    expect(observers).toHaveLength(1)
    const observed = observer(0).observed
    expect(observed.includes(screen.getByTestId('viewers-indicator-trigger'))).toBe(true)
    expect(observed.includes(screen.getByTestId('footer'))).toBe(true)

    rect = { top: 740, right: 500 }
    act(() => observer(0).fire())
    expect(popoverLeft()).toBe('260px')
    expect(screen.getByTestId('viewers-popover').style.bottom).toBe(`${window.innerHeight - 740 + 6}px`)
  })

  it('disconnects the observer when the popover closes and on unmount', () => {
    const { unmount } = renderInFooter()
    const trigger = screen.getByTestId('viewers-indicator-trigger')
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(observer(0).disconnected).toBe(true)

    fireEvent.click(trigger)
    expect(observers).toHaveLength(2)
    unmount()
    expect(observer(1).disconnected).toBe(true)
  })

  it('re-places on a window resize', () => {
    renderInFooter()
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    rect = { top: 760, right: 450 }
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(popoverLeft()).toBe('210px')
  })

  it('re-measures the trigger when reopened', () => {
    renderInFooter()
    const trigger = screen.getByTestId('viewers-indicator-trigger')
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    rect = { top: 760, right: 300 }
    fireEvent.click(trigger)
    expect(popoverLeft()).toBe('60px')
  })

  it('still positions the popover where ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    renderInFooter()
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(popoverLeft()).toBe('360px')
  })
})
