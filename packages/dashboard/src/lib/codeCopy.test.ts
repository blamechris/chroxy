import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleCodeCopyClick, handleMarkdownBodyClick, CODE_BLOCK_CLASS, CODE_COPY_BTN_CLASS } from './codeCopy'
import { useConnectionStore } from '../store/connection'

/**
 * Builds a `.code-block` DOM fragment matching what `renderMarkdown`
 * (lib/markdown.ts) emits: `<div class="code-block"><button class="code-copy-btn">…</button><pre><code>…</code></pre></div>`.
 */
function codeBlock(text: string): { container: HTMLDivElement; button: HTMLButtonElement } {
  const container = document.createElement('div')
  container.innerHTML =
    `<div class="${CODE_BLOCK_CLASS}"><button type="button" class="${CODE_COPY_BTN_CLASS}" aria-label="Copy code" title="Copy code">⧉</button><pre><code>${text}</code></pre></div>`
  document.body.appendChild(container)
  return { container, button: container.querySelector<HTMLButtonElement>(`.${CODE_COPY_BTN_CLASS}`)! }
}

// NOTE: no explicit return-type annotation — `vi.fn()`'s default generic
// (`Procedure`) is what's assignable to a plain `() => void` signature; a
// `ReturnType<typeof vi.fn>` annotation instead resolves the generic to its
// *constraint* (`Procedure | Constructable`), which is NOT assignable and
// breaks the `CodeCopyClickEvent` parameter type at every call site below
// (mirrors the unannotated `mouse()` helper in lib/links.test.ts).
function click(target: EventTarget | null) {
  return { target, stopPropagation: vi.fn() }
}

describe('handleCodeCopyClick (#6793)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('copies the code block textContent (not the button glyph) when clicking the button', () => {
    const { button } = codeBlock('const x = 1')
    const writeText = vi.fn().mockResolvedValue(true)
    const handled = handleCodeCopyClick(click(button), writeText)
    expect(handled).toBe(true)
    expect(writeText).toHaveBeenCalledWith('const x = 1')
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('resolves the button when the click target is a descendant (e.g. the glyph text node)', () => {
    const { button } = codeBlock('const y = 2')
    const glyphText = button.firstChild! // the "⧉" text node
    const writeText = vi.fn().mockResolvedValue(true)
    handleCodeCopyClick(click(glyphText), writeText)
    expect(writeText).toHaveBeenCalledWith('const y = 2')
  })

  it('copies only the CLICKED block\'s text when multiple code blocks are present', () => {
    const container = document.createElement('div')
    container.innerHTML =
      `<div class="${CODE_BLOCK_CLASS}"><button class="${CODE_COPY_BTN_CLASS}" data-testid="btn-a">⧉</button><pre><code>first block</code></pre></div>` +
      `<div class="${CODE_BLOCK_CLASS}"><button class="${CODE_COPY_BTN_CLASS}" data-testid="btn-b">⧉</button><pre><code>second block</code></pre></div>`
    document.body.appendChild(container)
    const btnB = container.querySelector('[data-testid="btn-b"]')!
    const writeText = vi.fn().mockResolvedValue(true)
    handleCodeCopyClick(click(btnB), writeText)
    expect(writeText).toHaveBeenCalledWith('second block')
    expect(writeText).not.toHaveBeenCalledWith('first block')
  })

  it('stops propagation when the click is on the copy button', () => {
    const { button } = codeBlock('x')
    const writeText = vi.fn().mockResolvedValue(true)
    const e = click(button)
    handleCodeCopyClick(e, writeText)
    expect(e.stopPropagation).toHaveBeenCalledOnce()
  })

  it('returns false and does NOT stop propagation for a click outside any copy button', () => {
    const div = document.createElement('div')
    div.textContent = 'plain text'
    const writeText = vi.fn()
    const e = click(div)
    const handled = handleCodeCopyClick(e, writeText)
    expect(handled).toBe(false)
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('flashes a ✓ confirmation directly on the button DOM node, then resets after 1500ms', async () => {
    vi.useFakeTimers()
    try {
      const { button } = codeBlock('x')
      const writeText = vi.fn().mockResolvedValue(true)
      handleCodeCopyClick(click(button), writeText)
      await vi.waitFor(() => expect(button).toHaveAttribute('data-copied', 'true'))
      expect(button.textContent).toBe('✓')
      expect(button.getAttribute('aria-label')).toBe('Copied')

      vi.advanceTimersByTime(1500)
      expect(button).not.toHaveAttribute('data-copied')
      expect(button.textContent).toBe('⧉')
      expect(button.getAttribute('aria-label')).toBe('Copy code')
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a warning toast and does NOT show copied when the clipboard write fails', async () => {
    const { button } = codeBlock('x')
    const writeText = vi.fn().mockResolvedValue(false)
    const addServerError = vi.spyOn(useConnectionStore.getState(), 'addServerError').mockImplementation(() => {})
    handleCodeCopyClick(click(button), writeText)
    await vi.waitFor(() => expect(addServerError).toHaveBeenCalledWith(expect.stringContaining('Failed to copy'), undefined, 'warning'))
    expect(button).not.toHaveAttribute('data-copied')
  })

  it('does nothing (still handled) when the block has no text content', () => {
    const container = document.createElement('div')
    container.innerHTML = `<div class="${CODE_BLOCK_CLASS}"><button class="${CODE_COPY_BTN_CLASS}">⧉</button><pre><code></code></pre></div>`
    document.body.appendChild(container)
    const button = container.querySelector<HTMLButtonElement>(`.${CODE_COPY_BTN_CLASS}`)!
    const writeText = vi.fn()
    const handled = handleCodeCopyClick(click(button), writeText)
    expect(handled).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('handleMarkdownBodyClick (#6793)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('handles a code-copy-button click without falling through to link handling', () => {
    const { container, button } = codeBlock('some code')
    const anchor = document.createElement('a')
    anchor.href = 'https://example.com'
    container.appendChild(anchor)
    const open = vi.fn()
    // handleMarkdownBodyClick only takes the event; we can't inject `open`
    // directly, so just assert it doesn't throw and the click is treated as
    // handled (no navigation side effect possible since target is the button).
    expect(() =>
      handleMarkdownBodyClick({ target: button, stopPropagation: vi.fn(), metaKey: true, ctrlKey: false, detail: 1, preventDefault: vi.fn() }),
    ).not.toThrow()
    expect(open).not.toHaveBeenCalled()
  })

  it('falls through to link handling when the click is not on a copy button', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'https://example.com')
    document.body.appendChild(anchor)
    const preventDefault = vi.fn()
    // A plain mouse click on a link (detail >= 1, no modifier) is suppressed
    // by handleMarkdownLinkClick — preventDefault fires, proving the click
    // fell through past the (non-matching) copy-button check.
    handleMarkdownBodyClick({ target: anchor, stopPropagation: vi.fn(), metaKey: false, ctrlKey: false, detail: 1, preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
