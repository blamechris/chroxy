import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { CopyButton } from './CopyButton'
import { writeText } from '../utils/clipboard'
import { useConnectionStore } from '../store/connection'

vi.mock('../utils/clipboard', () => ({ writeText: vi.fn() }))
const mockWriteText = vi.mocked(writeText)

describe('CopyButton (#6631)', () => {
  beforeEach(() => {
    mockWriteText.mockReset()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders an accessible copy button', () => {
    render(<CopyButton content="hello world" />)
    const btn = screen.getByTestId('msg-copy-button')
    expect(btn).toHaveAttribute('aria-label', 'Copy response')
    expect(btn).not.toHaveAttribute('data-copied')
  })

  it('copies the content to the clipboard on click and shows the copied state', async () => {
    mockWriteText.mockResolvedValue(true)
    render(<CopyButton content="the full response text" />)
    fireEvent.click(screen.getByTestId('msg-copy-button'))
    expect(mockWriteText).toHaveBeenCalledWith('the full response text')
    await waitFor(() => expect(screen.getByTestId('msg-copy-button')).toHaveAttribute('data-copied', 'true'))
    expect(screen.getByTestId('msg-copy-button')).toHaveAttribute('aria-label', 'Copied')
    // a11y: the success is announced through a polite live region
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('surfaces a warning toast and does NOT show copied when the clipboard write fails', async () => {
    mockWriteText.mockResolvedValue(false)
    const addServerError = vi.spyOn(useConnectionStore.getState(), 'addServerError').mockImplementation(() => {})
    render(<CopyButton content="x" />)
    fireEvent.click(screen.getByTestId('msg-copy-button'))
    await waitFor(() => expect(addServerError).toHaveBeenCalledWith(expect.stringContaining('Failed to copy'), undefined, 'warning'))
    expect(screen.getByTestId('msg-copy-button')).not.toHaveAttribute('data-copied')
    addServerError.mockRestore()
  })

  it('resets the copied ✓ when a re-click fails (latest attempt wins)', async () => {
    mockWriteText.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const addServerError = vi.spyOn(useConnectionStore.getState(), 'addServerError').mockImplementation(() => {})
    render(<CopyButton content="x" />)
    const btn = screen.getByTestId('msg-copy-button')
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveAttribute('data-copied', 'true'))
    // Second click fails — the stale ✓ must clear rather than linger.
    fireEvent.click(btn)
    await waitFor(() => expect(addServerError).toHaveBeenCalled())
    expect(btn).not.toHaveAttribute('data-copied')
    addServerError.mockRestore()
  })

  it('stops the click from propagating to parent handlers', () => {
    mockWriteText.mockResolvedValue(true)
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <CopyButton content="x" />
      </div>,
    )
    fireEvent.click(screen.getByTestId('msg-copy-button'))
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('honours className/testId overrides for non-bubble hosts (#6790)', () => {
    render(<CopyButton content="x" className="dev-preview-chip__copy" testId="custom-copy" />)
    const btn = screen.getByTestId('custom-copy')
    expect(btn).toHaveClass('dev-preview-chip__copy')
    expect(btn).not.toHaveClass('msg-copy-btn')
    expect(screen.queryByTestId('msg-copy-button')).toBeNull()
  })

  // #7338 — the control's hover chrome used to paint over the bubble's own text
  // with a see-through background. jsdom has no layout, so assert the
  // stylesheet declarations that keep it clear of the text and opaque.
  describe('chrome vs message text (#7338)', () => {
    const readCss = async () => {
      const { readFileSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      return readFileSync(resolve(__dirname, '../theme/components.css'), 'utf8')
    }
    const decl = (rule: string, prop: string) =>
      rule.match(new RegExp(`(?:^|[\\s;{])${prop}:\\s*([^;]+);`))?.[1]?.trim()

    it('paints an opaque, defined surface (no see-through fallback)', async () => {
      const css = await readCss()
      const rule = css.match(/\n\.msg-copy-btn\s*\{([^}]+)\}/)?.[1] ?? ''
      expect(rule.length > 0, 'the .msg-copy-btn rule exists').toBe(true)
      expect(decl(rule, 'background')).toBe('var(--bg-card)')
    })

    it('assistant bubbles reserve a right gutter at least as wide as the control footprint', async () => {
      const css = await readCss()
      const btn = css.match(/\n\.msg-copy-btn\s*\{([^}]+)\}/)?.[1] ?? ''
      const bubble = css.match(/\n\.msg\.assistant\s*\{([^}]+)\}/)?.[1] ?? ''
      const width = parseFloat(decl(btn, 'width') ?? 'NaN')
      const right = parseFloat(decl(btn, 'right') ?? 'NaN')
      // `padding: <top> <right> <bottom> <left>` — the second value is the right.
      const padding = (decl(bubble, 'padding') ?? '').split(/\s+/).map(parseFloat)
      expect(Number.isFinite(width) && Number.isFinite(right), 'control footprint is parseable').toBe(true)
      expect(padding.length, 'bubble padding is the 4-value form').toBe(4)
      expect(padding[1]! >= width + right).toBe(true)
    })
  })
})
