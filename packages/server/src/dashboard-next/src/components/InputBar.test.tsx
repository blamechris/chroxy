/**
 * InputBar + ReconnectBanner tests (#1162)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { InputBar } from './InputBar'
import { ReconnectBanner } from './ReconnectBanner'

afterEach(cleanup)

describe('InputBar', () => {
  it('renders textarea and send button', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
  })

  it('calls onSend with input text on send button click', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('clears input after sending', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(textarea.value).toBe('')
  })

  it('sends on Cmd+Enter', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledWith('test')
  })

  it('does not send on plain Enter (allows newline)', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('calls onInterrupt on Escape', () => {
    const onInterrupt = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={onInterrupt} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onInterrupt).toHaveBeenCalled()
  })

  it('disables input when disabled prop is true', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} disabled />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  it('does not send empty input', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send whitespace-only input', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows interrupt button when isStreaming', () => {
    render(
      <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isStreaming />
    )
    expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
  })

  it('shows placeholder text', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} placeholder="Ask Claude..." />)
    expect(screen.getByPlaceholderText('Ask Claude...')).toBeInTheDocument()
  })

  it('has aria-label on textarea (#1171)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.getByLabelText('Message input')).toBeInTheDocument()
  })

  it('has aria-label on send button (#1171)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message')
  })

  it('has aria-label on interrupt button (#1171)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isStreaming />)
    expect(screen.getByTestId('interrupt-button')).toHaveAttribute('aria-label', 'Stop generation')
  })

  it('has aria-describedby linking to keyboard shortcut hints (#1226)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    const describedBy = textarea.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const hint = document.getElementById(describedBy!)
    expect(hint).toBeInTheDocument()
    expect(hint!.textContent).toMatch(/Cmd\/Ctrl.*Enter.*send/i)
    expect(hint!.textContent).toMatch(/Escape.*interrupt/i)
  })

  it('derives max height from getComputedStyle instead of hardcoded lineHeight (#1172)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: '24px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      boxSizing: 'border-box',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      // Mock scrollHeight to exceed the 5-line max
      Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true })
      fireEvent.change(textarea, { target: { value: 'a\nb\nc\nd\ne\nf\ng' } })

      // Max should be 5 lines * 24px + 8+8 padding + 1+1 border = 138px (border-box)
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(138)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('adjusts height for border-box sizing (#1246)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: '24px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      boxSizing: 'border-box',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      // scrollHeight = 100 (includes padding but not border)
      Object.defineProperty(textarea, 'scrollHeight', { value: 100, configurable: true })
      fireEvent.change(textarea, { target: { value: 'hello' } })

      // border-box: style.height = scrollHeight + borderY = 100 + 2 = 102
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(102)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('adjusts height for content-box sizing (#1246)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: '24px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      boxSizing: 'content-box',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      // scrollHeight = 100 (includes padding but not border)
      Object.defineProperty(textarea, 'scrollHeight', { value: 100, configurable: true })
      fireEvent.change(textarea, { target: { value: 'hello' } })

      // content-box: style.height = (scrollHeight + borderY) - paddingY - borderY = scrollHeight - paddingY = 100 - 16 = 84
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(84)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('falls back to defaults when getComputedStyle returns non-numeric values (#1172)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: 'normal',
      paddingTop: '',
      paddingBottom: '',
      borderTopWidth: '',
      borderBottomWidth: '',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true })
      fireEvent.change(textarea, { target: { value: 'a\nb\nc\nd\ne\nf\ng' } })

      // Fallback: 5 lines * 20px + 0 padding + 0 border = 100px
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(100)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })
})

describe('InputBar file picker (#1286)', () => {
  const mockFiles = [
    { path: 'src/index.ts', type: 'file' as const, size: 1024 },
    { path: 'README.md', type: 'file' as const, size: 256 },
    { path: 'package.json', type: 'file' as const, size: 128 },
  ]

  it('shows file picker when @ is typed at start', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} filePickerFiles={mockFiles} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@' } })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('does not show file picker when @ is mid-text', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} filePickerFiles={mockFiles} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'email@test' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('filters files as user types after @', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} filePickerFiles={mockFiles} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@README' } })
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument()
  })

  it('inserts selected file path into input on Enter', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} filePickerFiles={mockFiles} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toContain('src/index.ts')
  })

  it('closes picker on Escape without calling onInterrupt', () => {
    const onInterrupt = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={onInterrupt} filePickerFiles={mockFiles} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it('navigates with arrow keys', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} filePickerFiles={mockFiles} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@' } })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    const items = screen.getAllByRole('option')
    expect(items[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('calls onFileTrigger when @ is typed', () => {
    const onFileTrigger = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        filePickerFiles={mockFiles}
        onFileTrigger={onFileTrigger}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@' } })
    expect(onFileTrigger).toHaveBeenCalled()
  })

  it('opens picker with null files for async loading', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} filePickerFiles={null} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@' } })
    expect(screen.getByText('Loading files...')).toBeInTheDocument()
  })

  it('does not show picker when filePickerFiles prop is not provided', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('InputBar slash command picker (#1281)', () => {
  const mockCommands = [
    { name: 'commit', description: 'Create a git commit', source: 'project' as const },
    { name: 'review-pr', description: 'Review a pull request', source: 'project' as const },
  ]

  it('shows picker when "/" is typed at start of empty input', () => {
    const onSlashTrigger = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
        onSlashTrigger={onSlashTrigger}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })
    expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
  })

  it('does not show picker when "/" is in the middle of text', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'hello / world' } })
    expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
  })

  it('filters commands as user types after "/"', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/com' } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
    expect(screen.queryByText('/review-pr')).not.toBeInTheDocument()
  })

  it('inserts selected command into input', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/' } })
    fireEvent.click(screen.getByText('/commit'))
    expect(textarea.value).toBe('/commit ')
  })

  it('closes picker and inserts on Enter when picker is open', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/' } })
    expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/commit ')
    expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
  })

  it('closes picker on Escape without inserting', () => {
    const onInterrupt = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={onInterrupt}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/' } })
    expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it('navigates with arrow keys', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })
    const items = screen.getAllByRole('option')
    expect(items[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    const updatedItems = screen.getAllByRole('option')
    expect(updatedItems[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('does not navigate past last item with ArrowDown', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })
    // Arrow down past the end (only 2 items)
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    const items = screen.getAllByRole('option')
    // Should stay on last item (index 1)
    expect(items[1]).toHaveAttribute('aria-selected', 'true')
    expect(items[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onSlashTrigger when "/" is typed', () => {
    const onSlashTrigger = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={mockCommands}
        onSlashTrigger={onSlashTrigger}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })
    expect(onSlashTrigger).toHaveBeenCalled()
  })

  it('opens picker when "/" is typed with empty slashCommands (async fetch)', () => {
    const onSlashTrigger = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        slashCommands={[]}
        onSlashTrigger={onSlashTrigger}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })
    // Should open picker (shows "No commands found") and trigger fetch
    expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
    expect(onSlashTrigger).toHaveBeenCalled()
  })

  it('does not show picker when slashCommands prop is not provided', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/' } })
    expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
  })
})

describe('InputBar paste/drop (#1288)', () => {
  function createMockFile(name: string, size: number, type: string): File {
    return new File([new ArrayBuffer(size)], name, { type })
  }

  it('calls onImagePaste when pasting an image', () => {
    const onImagePaste = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImagePaste={onImagePaste} />)
    const textarea = screen.getByRole('textbox')

    const file = createMockFile('screenshot.png', 1000, 'image/png')
    const clipboardData = {
      files: [file],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    }
    fireEvent.paste(textarea, { clipboardData })
    expect(onImagePaste).toHaveBeenCalledWith([file])
  })

  it('does not call onImagePaste for text paste', () => {
    const onImagePaste = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImagePaste={onImagePaste} />)
    const textarea = screen.getByRole('textbox')

    const clipboardData = {
      files: [],
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    }
    fireEvent.paste(textarea, { clipboardData })
    expect(onImagePaste).not.toHaveBeenCalled()
  })

  it('calls onImageDrop when dropping image files', () => {
    const onImageDrop = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImageDrop={onImageDrop} />)
    const dropZone = screen.getByTestId('input-bar')

    const file = createMockFile('photo.jpg', 1000, 'image/jpeg')
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    })
    expect(onImageDrop).toHaveBeenCalledWith([file])
  })

  it('does not call onImageDrop for non-image files', () => {
    const onImageDrop = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImageDrop={onImageDrop} />)
    const dropZone = screen.getByTestId('input-bar')

    const file = createMockFile('doc.pdf', 1000, 'application/pdf')
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    })
    expect(onImageDrop).not.toHaveBeenCalled()
  })

  it('filters to only image files on drop', () => {
    const onImageDrop = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImageDrop={onImageDrop} />)
    const dropZone = screen.getByTestId('input-bar')

    const imgFile = createMockFile('photo.jpg', 1000, 'image/jpeg')
    const pdfFile = createMockFile('doc.pdf', 1000, 'application/pdf')
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [imgFile, pdfFile] },
    })
    expect(onImageDrop).toHaveBeenCalledWith([imgFile])
  })
})

describe('InputBar image thumbnails (#1289)', () => {
  it('renders image thumbnails when imageAttachments provided', () => {
    const images = [
      { data: 'aGVsbG8=', mediaType: 'image/png', name: 'screenshot.png' },
    ]
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} imageAttachments={images} onRemoveImage={vi.fn()} />)
    expect(screen.getByTestId('image-thumbnails')).toBeInTheDocument()
    expect(screen.getByAltText('screenshot.png')).toBeInTheDocument()
  })

  it('does not render thumbnails when no images', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.queryByTestId('image-thumbnails')).not.toBeInTheDocument()
  })

  it('renders count indicator for multiple images', () => {
    const images = [
      { data: 'aQ==', mediaType: 'image/png', name: 'img1.png' },
      { data: 'ag==', mediaType: 'image/jpeg', name: 'img2.jpg' },
      { data: 'aw==', mediaType: 'image/gif', name: 'img3.gif' },
    ]
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} imageAttachments={images} onRemoveImage={vi.fn()} />)
    expect(screen.getByText(/3 images/i)).toBeInTheDocument()
  })

  it('calls onRemoveImage when thumbnail remove clicked', () => {
    const onRemoveImage = vi.fn()
    const images = [
      { data: 'aGVsbG8=', mediaType: 'image/png', name: 'screenshot.png' },
    ]
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} imageAttachments={images} onRemoveImage={onRemoveImage} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemoveImage).toHaveBeenCalledWith(0)
  })

  it('does not show count for single image', () => {
    const images = [
      { data: 'aGVsbG8=', mediaType: 'image/png', name: 'screenshot.png' },
    ]
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} imageAttachments={images} onRemoveImage={vi.fn()} />)
    expect(screen.queryByText(/image/i)).not.toBeInTheDocument()
  })
})

describe('ReconnectBanner', () => {
  it('renders when visible', () => {
    render(<ReconnectBanner visible attempt={1} maxAttempts={8} onRetry={vi.fn()} />)
    expect(screen.getByTestId('reconnect-banner')).toBeInTheDocument()
  })

  it('does not render when not visible', () => {
    render(<ReconnectBanner visible={false} attempt={1} maxAttempts={8} onRetry={vi.fn()} />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })

  it('shows attempt count', () => {
    render(<ReconnectBanner visible attempt={3} maxAttempts={8} onRetry={vi.fn()} />)
    expect(screen.getByText(/attempt 3\/8/i)).toBeInTheDocument()
  })

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn()
    render(<ReconnectBanner visible attempt={1} maxAttempts={8} onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('retry-button'))
    expect(onRetry).toHaveBeenCalled()
  })

  it('has role=status for polite screen reader announcement (#1171)', () => {
    render(<ReconnectBanner visible attempt={1} maxAttempts={8} onRetry={vi.fn()} />)
    const banner = screen.getByTestId('reconnect-banner')
    expect(banner).toHaveAttribute('role', 'status')
  })

  it('shows custom message', () => {
    render(
      <ReconnectBanner
        visible
        attempt={1}
        maxAttempts={8}
        message="Server restarting..."
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText(/Server restarting/)).toBeInTheDocument()
  })
})

describe('InputBar attachments (#1287)', () => {
  it('renders attachment chips when attachments are provided', () => {
    const attachments = [{ path: 'src/App.tsx', name: 'App.tsx' }]
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={vi.fn()}
      />
    )
    expect(screen.getByText('App.tsx')).toBeInTheDocument()
  })

  it('calls onRemoveAttachment when chip remove button clicked', () => {
    const onRemove = vi.fn()
    const attachments = [{ path: 'src/App.tsx', name: 'App.tsx' }]
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={onRemove}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).toHaveBeenCalledWith('src/App.tsx')
  })

  it('renders multiple attachment chips', () => {
    const attachments = [
      { path: 'src/App.tsx', name: 'App.tsx' },
      { path: 'src/index.ts', name: 'index.ts' },
    ]
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={vi.fn()}
      />
    )
    expect(screen.getByText('App.tsx')).toBeInTheDocument()
    expect(screen.getByText('index.ts')).toBeInTheDocument()
  })

  it('includes attachments in onSend callback', () => {
    const onSend = vi.fn()
    const attachments = [{ path: 'src/App.tsx', name: 'App.tsx' }]
    render(
      <InputBar
        onSend={onSend}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={vi.fn()}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'explain this' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).toHaveBeenCalledWith('explain this', [{ path: 'src/App.tsx', name: 'App.tsx' }])
  })

  it('does not render attachment area when no attachments', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.queryByTestId('attachment-chips')).not.toBeInTheDocument()
  })

  it('does not render attachment area when attachments is empty', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
      />
    )
    expect(screen.queryByTestId('attachment-chips')).not.toBeInTheDocument()
  })

  it('allows sending with attachments and empty text', () => {
    const onSend = vi.fn()
    const attachments = [{ path: 'src/App.tsx', name: 'App.tsx' }]
    render(
      <InputBar
        onSend={onSend}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={vi.fn()}
      />
    )
    // Click send with empty text but attachments present
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).toHaveBeenCalledWith('', [{ path: 'src/App.tsx', name: 'App.tsx' }])
  })
})
