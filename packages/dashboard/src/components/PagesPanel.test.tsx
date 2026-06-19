import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { PagesPanel, type PageEntry } from './PagesPanel'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const PAGES: PageEntry[] = [
  { slug: 'status-report', title: 'Status Report', createdAt: '2026-06-19T10:00:00.000Z', bytes: 2048, path: '/p/status-report/' },
  { slug: 'arch-brief', title: 'Arch Brief', createdAt: '2026-06-18T09:00:00.000Z', bytes: 512000, path: '/p/arch-brief/' },
]

describe('PagesPanel', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('fetches /api/pages with the bearer token and lists pages', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pages: PAGES }))
    render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} origin="https://x.example" />)
    await waitFor(() => expect(screen.getByTestId('page-card-status-report')).toBeTruthy())
    expect(fetchImpl).toHaveBeenCalledWith('/api/pages', expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }))
    expect(screen.getByTestId('page-title-status-report').textContent).toBe('Status Report')
    expect(screen.getByTestId('page-card-arch-brief')).toBeTruthy()
  })

  it('renders the empty state when there are no pages', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pages: [] }))
    render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} />)
    await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
    expect(screen.queryByTestId('pages-list')).toBeNull()
  })

  it('renders an error on a non-ok response and does not show the list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'primary_token_required' }, 403))
    render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} />)
    await waitFor(() => expect(screen.getByTestId('pages-error').textContent).toContain('primary_token_required'))
    expect(screen.queryByTestId('pages-list')).toBeNull()
  })

  it('copies the share URL (origin + path) and flashes "Copied!"', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pages: PAGES }))
    const copyImpl = vi.fn(async () => true)
    render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} copyImpl={copyImpl} origin="https://x.example" />)
    await waitFor(() => expect(screen.getByTestId('page-copy-status-report')).toBeTruthy())
    fireEvent.click(screen.getByTestId('page-copy-status-report'))
    await waitFor(() => expect(copyImpl).toHaveBeenCalledWith('https://x.example/p/status-report/'))
    await waitFor(() => expect(screen.getByTestId('page-copy-status-report').textContent).toBe('Copied!'))
  })

  it('deletes a page (DELETE /api/pages/<slug>) and drops the row', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/pages') return jsonResponse({ pages: PAGES })
      if (url === '/api/pages/arch-brief') return jsonResponse({ removed: true })
      return new Response('not found', { status: 404 })
    })
    render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => expect(screen.getByTestId('page-card-arch-brief')).toBeTruthy())
    fireEvent.click(screen.getByTestId('page-delete-arch-brief'))
    await waitFor(() => expect(screen.queryByTestId('page-card-arch-brief')).toBeNull())
    expect(fetchImpl).toHaveBeenCalledWith('/api/pages/arch-brief', expect.objectContaining({ method: 'DELETE', headers: { Authorization: 'Bearer tok' } }))
    // The other page is untouched.
    expect(screen.getByTestId('page-card-status-report')).toBeTruthy()
  })

  it('surfaces a delete failure as an error and keeps the row', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/pages') return jsonResponse({ pages: PAGES })
      return jsonResponse({ error: 'boom' }, 500)
    })
    render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => expect(screen.getByTestId('page-card-status-report')).toBeTruthy())
    fireEvent.click(screen.getByTestId('page-delete-status-report'))
    await waitFor(() => expect(screen.getByTestId('pages-error').textContent).toContain('boom'))
    expect(screen.getByTestId('page-card-status-report')).toBeTruthy()
  })
})
