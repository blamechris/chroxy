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

  // #6110: the "publish this artifact" form.
  describe('publish (#6110)', () => {
    it('toggles the publish form open and closed', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ pages: [] }))
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} />)
      await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
      expect(screen.queryByTestId('pages-publish-form')).toBeNull()
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      expect(screen.getByTestId('pages-publish-form')).toBeTruthy()
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      expect(screen.queryByTestId('pages-publish-form')).toBeNull()
    })

    it('POSTs the artifact to /api/pages and shows the share URL inline', async () => {
      const published = { slug: 'new-page', path: '/p/new-page/', title: 'My Report', bytes: 12, createdAt: '2026-06-20T12:00:00.000Z' }
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push({ url, init })
        if (url === '/api/pages' && init?.method === 'POST') return jsonResponse(published)
        // The mount fetch + the post-publish refresh both GET the list.
        return jsonResponse({ pages: calls.some((c) => c.init?.method === 'POST') ? [{ ...published, title: published.title }] : [] })
      })
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} origin="https://x.example" />)
      await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      fireEvent.change(screen.getByTestId('pages-publish-title'), { target: { value: 'My Report' } })
      fireEvent.change(screen.getByTestId('pages-publish-html'), { target: { value: '<h1>hi</h1>' } })
      fireEvent.click(screen.getByTestId('pages-publish-submit'))

      await waitFor(() => expect(screen.getByTestId('pages-publish-result-url').textContent).toBe('https://x.example/p/new-page/'))
      const post = calls.find((c) => c.init?.method === 'POST')!
      expect(post.url).toBe('/api/pages')
      expect((post.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
      expect((post.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
      expect(JSON.parse(post.init?.body as string)).toEqual({ title: 'My Report', html: '<h1>hi</h1>' })
      // The post-publish refresh ran, so the new page appears in the list.
      await waitFor(() => expect(screen.getByTestId('page-card-new-page')).toBeTruthy())
    })

    it('defaults a blank title to Untitled', async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push({ url, init })
        if (url === '/api/pages' && init?.method === 'POST') return jsonResponse({ slug: 's', path: '/p/s/' })
        return jsonResponse({ pages: [] })
      })
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} />)
      await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      fireEvent.change(screen.getByTestId('pages-publish-html'), { target: { value: '<p>x</p>' } })
      fireEvent.click(screen.getByTestId('pages-publish-submit'))
      await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true))
      const post = calls.find((c) => c.init?.method === 'POST')!
      expect(JSON.parse(post.init?.body as string).title).toBe('Untitled')
    })

    it('loads a .html file into the textarea and seeds the title from the filename', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ pages: [] }))
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} />)
      await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      const file = new File(['<h1>loaded</h1>'], 'Report.html', { type: 'text/html' })
      fireEvent.change(screen.getByTestId('pages-publish-file'), { target: { files: [file] } })
      await waitFor(() => expect((screen.getByTestId('pages-publish-html') as HTMLTextAreaElement).value).toBe('<h1>loaded</h1>'))
      // Title seeded from the filename with the extension stripped.
      expect((screen.getByTestId('pages-publish-title') as HTMLInputElement).value).toBe('Report')
    })

    it('disables Publish until HTML is entered', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ pages: [] }))
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} />)
      await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      expect((screen.getByTestId('pages-publish-submit') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.change(screen.getByTestId('pages-publish-html'), { target: { value: '<p>x</p>' } })
      expect((screen.getByTestId('pages-publish-submit') as HTMLButtonElement).disabled).toBe(false)
    })

    it('shows a publish error inline (403) without blanking the list', async () => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/pages' && init?.method === 'POST') return jsonResponse({ error: 'primary_token_required' }, 403)
        return jsonResponse({ pages: PAGES })
      })
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'bound'} />)
      await waitFor(() => expect(screen.getByTestId('page-card-status-report')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      fireEvent.change(screen.getByTestId('pages-publish-html'), { target: { value: '<p>x</p>' } })
      fireEvent.click(screen.getByTestId('pages-publish-submit'))
      await waitFor(() => expect(screen.getByTestId('pages-publish-error').textContent).toContain('primary_token_required'))
      // The list is untouched by a publish failure.
      expect(screen.getByTestId('page-card-status-report')).toBeTruthy()
    })

    it('copies the published share URL', async () => {
      const copyImpl = vi.fn(async () => true)
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/pages' && init?.method === 'POST') return jsonResponse({ slug: 's', path: '/p/s/' })
        return jsonResponse({ pages: [] })
      })
      render(<PagesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 't'} copyImpl={copyImpl} origin="https://x.example" />)
      await waitFor(() => expect(screen.getByTestId('pages-empty')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-toggle'))
      fireEvent.change(screen.getByTestId('pages-publish-html'), { target: { value: '<p>x</p>' } })
      fireEvent.click(screen.getByTestId('pages-publish-submit'))
      await waitFor(() => expect(screen.getByTestId('pages-publish-result-copy')).toBeTruthy())
      fireEvent.click(screen.getByTestId('pages-publish-result-copy'))
      await waitFor(() => expect(copyImpl).toHaveBeenCalledWith('https://x.example/p/s/'))
      await waitFor(() => expect(screen.getByTestId('pages-publish-result-copy').textContent).toBe('Copied!'))
    })
  })
})
