/**
 * ViewersIndicator (#5281 ①.3) — shared-session presence surface tests.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ViewersIndicator, resolveActivePrimaryClientId } from './ViewersIndicator'
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
