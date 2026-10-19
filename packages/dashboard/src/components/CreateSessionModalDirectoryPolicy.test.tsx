import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { CreateSessionModal } from './CreateSessionModal'

let callback: ((listing: Record<string, unknown>) => void) | null = null
const request = vi.fn()
const setCallback = (cb: typeof callback) => { callback = cb }
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    defaultProvider: 'claude-sdk', availableProviders: [], defaultCwd: '/workspace/project',
    requestDirectoryListing: request, setDirectoryListingCallback: setCallback,
  }),
}))
beforeEach(() => { vi.useFakeTimers(); request.mockClear(); callback = null })
afterEach(() => { cleanup(); vi.useRealTimers() })
const renderModal = () => render(<CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd="/workspace/project" />)
const reply = (path: string, error: string | null) => act(() => { callback?.({ path, error, entries: [] }) })

describe('New Session directory policy hint', () => {
  it('probes the prefilled cwd and warns when Browse cannot open it', () => {
    renderModal()
    act(() => { vi.advanceTimersByTime(200) })
    expect(request).toHaveBeenCalledWith('/workspace/project', expect.any(String))
    reply('/workspace/project', 'Access denied: outside workspace roots')
    expect(screen.getByTestId('cwd-access-hint')).toHaveTextContent('Browse cannot open this directory')
    expect(screen.getByTestId('cwd-access-hint')).toHaveTextContent('outside workspace roots')
    expect(screen.getByLabelText('Working directory')).toHaveValue('/workspace/project')
    expect(screen.queryByText('New directory — session will start here')).toBeNull()
  })
  it('does not claim a check succeeded while waiting or after no response', () => {
    renderModal()
    expect(screen.getByTestId('cwd-access-hint')).toHaveTextContent('Checking directory access')
    expect(screen.queryByText('New directory — session will start here')).toBeNull()
    act(() => { vi.advanceTimersByTime(2200) })
    expect(screen.getByTestId('cwd-access-hint')).toHaveTextContent('Directory access could not be checked')
  })
  it('clears the hint only after the matching successful reply', () => {
    renderModal()
    act(() => { vi.advanceTimersByTime(200) })
    reply('/other/project', null)
    expect(screen.getByTestId('cwd-access-hint')).toHaveTextContent('Checking directory access')
    reply('/workspace/project', null)
    expect(screen.queryByTestId('cwd-access-hint')).toBeNull()
  })
  it('hands callback ownership to Browse without a probe timer replacing it', () => {
    renderModal()
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.click(screen.getByText('Browse...'))
    const browserCallback = callback
    act(() => { vi.advanceTimersByTime(3000) })
    expect(callback).toBe(browserCallback)
    reply('/workspace/project', null)
    expect(screen.queryByText('Loading...')).toBeNull()
    expect(screen.getByLabelText('Select')).toBeInTheDocument()
  })
})
