/**
 * ImageThumbnail tests (#1289)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ImageThumbnail } from './ImageThumbnail'

afterEach(cleanup)

describe('ImageThumbnail', () => {
  const defaultProps = {
    data: 'aGVsbG8=',
    mediaType: 'image/png',
    name: 'screenshot.png',
    onRemove: vi.fn(),
  }

  it('renders an image element', () => {
    render(<ImageThumbnail {...defaultProps} />)
    const img = screen.getByRole('img')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
  })

  it('shows filename as alt text', () => {
    render(<ImageThumbnail {...defaultProps} />)
    expect(screen.getByAltText('screenshot.png')).toBeInTheDocument()
  })

  it('shows filename on hover via title', () => {
    render(<ImageThumbnail {...defaultProps} />)
    const container = screen.getByTestId('image-thumbnail')
    expect(container).toHaveAttribute('title', 'screenshot.png')
  })

  it('calls onRemove when remove button clicked', () => {
    const onRemove = vi.fn()
    render(<ImageThumbnail {...defaultProps} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).toHaveBeenCalled()
  })

  it('has accessible remove button', () => {
    render(<ImageThumbnail {...defaultProps} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Remove screenshot.png')
  })
})
