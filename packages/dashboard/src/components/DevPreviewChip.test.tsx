/**
 * Tests for DevPreviewChip (#6790) — header surface for active dev-server
 * preview tunnels sourced from the session's `devPreviews` store state.
 *
 * Covers: hidden when devPreviews is empty, renders a chip per active
 * preview with the port + a link to the tunnel URL, the close control
 * invokes onClose with the right port, and the copy control writes the
 * exact tunnel URL to the clipboard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DevPreviewChip } from './DevPreviewChip'
import { writeText } from '../utils/clipboard'
import { useConnectionStore } from '../store/connection'
import type { DevPreview } from '../store/types'

vi.mock('../utils/clipboard', () => ({ writeText: vi.fn() }))
const mockWriteText = vi.mocked(writeText)

afterEach(() => cleanup())

beforeEach(() => {
  mockWriteText.mockReset()
})

describe('DevPreviewChip', () => {
  it('renders nothing when devPreviews is empty', () => {
    const { container } = render(<DevPreviewChip previews={[]} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a chip for a single active preview with port + link to the tunnel URL', () => {
    const previews: DevPreview[] = [{ port: 3000, url: 'https://foo.trycloudflare.com' }]
    render(<DevPreviewChip previews={previews} onClose={() => {}} />)

    expect(screen.getByTestId('dev-preview-chip-3000')).toBeInTheDocument()
    expect(screen.getByText(':3000')).toBeInTheDocument()

    const link = screen.getByRole('link', { name: /open dev preview on port 3000/i })
    expect(link).toHaveAttribute('href', 'https://foo.trycloudflare.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('renders one chip per active preview, deduped by port', () => {
    const previews: DevPreview[] = [
      { port: 3000, url: 'https://foo.trycloudflare.com' },
      { port: 4000, url: 'https://bar.trycloudflare.com' },
    ]
    render(<DevPreviewChip previews={previews} onClose={() => {}} />)

    expect(screen.getByTestId('dev-preview-chip-3000')).toBeInTheDocument()
    expect(screen.getByTestId('dev-preview-chip-4000')).toBeInTheDocument()
  })

  it('calls onClose with the matching port when the dismiss control is clicked', () => {
    const previews: DevPreview[] = [{ port: 5173, url: 'https://baz.trycloudflare.com' }]
    const onClose = vi.fn()
    render(<DevPreviewChip previews={previews} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('dev-preview-chip-close-5173'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(5173)
  })

  it('copies the exact tunnel URL to the clipboard and shows the copied state', async () => {
    mockWriteText.mockResolvedValue(true)
    const previews: DevPreview[] = [{ port: 8080, url: 'https://qux.trycloudflare.com/app' }]
    render(<DevPreviewChip previews={previews} onClose={() => {}} />)

    fireEvent.click(screen.getByTestId('dev-preview-chip-copy-8080'))
    expect(mockWriteText).toHaveBeenCalledWith('https://qux.trycloudflare.com/app')
    await waitFor(() =>
      expect(screen.getByTestId('dev-preview-chip-copy-8080')).toHaveAttribute('data-copied', 'true'),
    )
  })

  it('surfaces a warning toast and does not show copied when the clipboard write fails', async () => {
    mockWriteText.mockResolvedValue(false)
    const previews: DevPreview[] = [{ port: 9000, url: 'https://fail.trycloudflare.com' }]
    const addServerError = vi.spyOn(useConnectionStore.getState(), 'addServerError').mockImplementation(() => {})
    render(<DevPreviewChip previews={previews} onClose={() => {}} />)

    fireEvent.click(screen.getByTestId('dev-preview-chip-copy-9000'))
    await waitFor(() =>
      expect(addServerError).toHaveBeenCalledWith(expect.stringContaining('Failed to copy'), undefined, 'warning'),
    )
    expect(screen.getByTestId('dev-preview-chip-copy-9000')).not.toHaveAttribute('data-copied')
    addServerError.mockRestore()
  })
})
