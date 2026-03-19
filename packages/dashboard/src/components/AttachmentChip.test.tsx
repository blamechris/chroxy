/**
 * Tests for AttachmentChip — visual chip for file attachments.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AttachmentChip } from './AttachmentChip'

afterEach(cleanup)

describe('AttachmentChip', () => {
  it('renders the filename', () => {
    render(<AttachmentChip name="App.tsx" path="src/App.tsx" onRemove={() => {}} />)
    expect(screen.getByText('App.tsx')).toBeInTheDocument()
  })

  it('renders the full path as tooltip', () => {
    render(<AttachmentChip name="App.tsx" path="src/components/App.tsx" onRemove={() => {}} />)
    const chip = screen.getByTestId('attachment-chip')
    expect(chip).toHaveAttribute('title', 'src/components/App.tsx')
  })

  it('calls onRemove when remove button clicked', () => {
    const onRemove = vi.fn()
    render(<AttachmentChip name="App.tsx" path="src/App.tsx" onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('truncates long filenames', () => {
    const longName = 'very-long-filename-that-exceeds-normal-length.component.tsx'
    render(<AttachmentChip name={longName} path={`src/${longName}`} onRemove={() => {}} />)
    const nameEl = screen.getByTestId('chip-filename')
    // CSS handles truncation, but the text should be present
    expect(nameEl.textContent).toBe(longName)
  })

  it('has accessible remove button', () => {
    render(<AttachmentChip name="foo.ts" path="src/foo.ts" onRemove={() => {}} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-label', 'Remove foo.ts')
  })
})
