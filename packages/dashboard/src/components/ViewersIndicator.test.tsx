/**
 * ViewersIndicator (#5281 ①.3) — shared-session presence surface tests.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ViewersIndicator } from './ViewersIndicator'
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

  it('closes the popover on Escape', () => {
    render(
      <ViewersIndicator
        connected
        clients={[client({ clientId: 'c0', isSelf: true }), client({ clientId: 'c1' })]}
        primaryClientId={null}
      />,
    )
    fireEvent.click(screen.getByTestId('viewers-indicator-trigger'))
    expect(screen.getByTestId('viewers-popover')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('viewers-popover')).not.toBeInTheDocument()
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
})
