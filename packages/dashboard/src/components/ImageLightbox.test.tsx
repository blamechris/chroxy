/**
 * ImageLightbox component tests (#6755).
 *
 * The component is a thin wrapper around the generic `Modal` — these tests
 * cover the parts specific to ImageLightbox (null-when-closed, the image
 * itself, the explicit close button, and the click-swallowing wrapper that
 * keeps a dismiss from bubbling into a parent ToolBubble/ToolGroup toggle).
 * Escape-key and backdrop-close behavior are already covered by
 * Modal.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ImageLightbox } from './ImageLightbox'

afterEach(cleanup)

describe('ImageLightbox', () => {
  it('renders nothing when uri is null', () => {
    render(<ImageLightbox uri={null} onClose={vi.fn()} />)
    expect(screen.queryByTestId('image-lightbox-img')).not.toBeInTheDocument()
  })

  it('renders the image at the given data URI when open', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo='
    render(<ImageLightbox uri={uri} onClose={vi.fn()} />)
    expect(screen.getByTestId('image-lightbox-img')).toHaveAttribute('src', uri)
  })

  it('defaults the accessible title to "Image" when no label is given', () => {
    render(<ImageLightbox uri="data:image/png;base64,x" onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Image')
  })

  it('uses a custom label for the accessible title', () => {
    render(<ImageLightbox uri="data:image/png;base64,x" onClose={vi.fn()} label="Image 2 of 3" />)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Image 2 of 3')
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<ImageLightbox uri="data:image/png;base64,x" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('swallows the click so it does not bubble to an ancestor onClick', () => {
    const outerClick = vi.fn()
    render(
      <div onClick={outerClick}>
        <ImageLightbox uri="data:image/png;base64,x" onClose={vi.fn()} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('image-lightbox-img'))
    expect(outerClick).not.toHaveBeenCalled()
  })
})
