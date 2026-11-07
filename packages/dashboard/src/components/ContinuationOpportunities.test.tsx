import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContinuationOpportunities } from './ContinuationOpportunities'

const storeState = { apiToken: 'fixture-primary' as string | null, wsUrl: null }
vi.mock('../store/connection', () => ({
  useConnectionStore: (select: (state: object) => unknown) => select(storeState),
}))
const item = { id: 'seed-1', seedPath: '/vault/NEXT-demo.md', cwd: '/projects/demo', ts: Date.now(), available: true, unavailable: null as string | null }
const response = (items = [item]) => new Response(JSON.stringify({ continuations: items }))
afterEach(() => { storeState.apiToken = 'fixture-primary'; cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('ContinuationOpportunities', () => {
  it('rechecks before opening the editable seed flow and deduplicates local activation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response())
    // Each fetch consumes a Response body, so give it a fresh instance.
    fetchMock.mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const onContinue = vi.fn()
    render(<ContinuationOpportunities connected onContinue={onContinue} />)
    const button = await screen.findByRole('button', { name: 'Continue from seed' })
    expect(onContinue).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer fixture-primary')
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(onContinue).toHaveBeenCalledExactlyOnceWith({ cwd: item.cwd, seed: item.seedPath }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Continue from seed' })).not.toBeInTheDocument()
    fireEvent.focus(window)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('button', { name: 'Continue from seed' })).not.toBeInTheDocument()
  })
  it('shows unavailable manual paths and refuses a seed replaced after rendering', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => response())
      .mockImplementation(async () => response([{ ...item, available: false, unavailable: 'changed' }]))
    vi.stubGlobal('fetch', fetchMock)
    const onContinue = vi.fn()
    render(<ContinuationOpportunities connected onContinue={onContinue} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue from seed' }))
    await screen.findByRole('status')
    expect(screen.getByText(item.seedPath)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue from seed' })).toBeDisabled()
    expect(onContinue).not.toHaveBeenCalled()
  })
  it('preserves a manual fallback after failed recheck and aborts on disconnect', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => response()).mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const onContinue = vi.fn()
    const { rerender } = render(<ContinuationOpportunities connected onContinue={onContinue} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue from seed' }))
    await screen.findByRole('status')
    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText(item.seedPath)).toBeInTheDocument()
    rerender(<ContinuationOpportunities connected={false} onContinue={onContinue} />)
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1].signal.aborted).toBe(true)
    expect(screen.queryByText(item.seedPath)).not.toBeInTheDocument()
  })
  it('loads with the empty token of a --no-auth connection (#9046)', async () => {
    storeState.apiToken = ''
    const fetchMock = vi.fn().mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    render(<ContinuationOpportunities connected onContinue={vi.fn()} />)
    await screen.findByRole('button', { name: 'Continue from seed' })
    expect(fetchMock).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined()
  })
  it('stays inert with no token at all', async () => {
    storeState.apiToken = null
    const fetchMock = vi.fn().mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    render(<ContinuationOpportunities connected onContinue={vi.fn()} />)
    await new Promise(r => setTimeout(r, 20))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
