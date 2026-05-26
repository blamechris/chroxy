/**
 * InputBar tests (#1162)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { InputBar } from './InputBar'
import type { EvaluatorResultPayload } from '../store/types'

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

  it('sends on plain Enter when sendOnEnter is true', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} sendOnEnter />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('test')
  })

  it('does not send on Shift+Enter when sendOnEnter is true (allows newline)', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} sendOnEnter />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows Enter hint in sr-only text when sendOnEnter is true', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} sendOnEnter />)
    const textarea = screen.getByRole('textbox')
    const describedBy = textarea.getAttribute('aria-describedby')
    const hint = document.getElementById(describedBy!)
    expect(hint!.textContent).toMatch(/Enter to send/i)
    expect(hint!.textContent).toMatch(/Shift\+Enter/i)
  })

  it('calls onInterrupt on Escape', () => {
    const onInterrupt = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={onInterrupt} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onInterrupt).toHaveBeenCalled()
  })

  // #3853 — Cmd+L (mac) / Ctrl+L (linux/win) clears the composer text and any
  // queued attachments/images/pasted blocks. No-op when everything is empty so
  // the browser's native Ctrl+L (address-bar focus) still works in that case.
  describe('Cmd+L / Ctrl+L clears the composer (#3853)', () => {
    it('clears text on Cmd+L', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'half-written' } })
      expect(textarea.value).toBe('half-written')
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(textarea.value).toBe('')
    })

    it('clears text on Ctrl+L', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'half-written' } })
      fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true })
      expect(textarea.value).toBe('')
    })

    it('calls onRemoveAttachment for each queued file attachment', () => {
      const onRemoveAttachment = vi.fn()
      const attachments = [
        { path: '/foo.txt', name: 'foo.txt' },
        { path: '/bar.txt', name: 'bar.txt' },
      ]
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
        />,
      )
      const textarea = screen.getByRole('textbox')
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(onRemoveAttachment).toHaveBeenCalledTimes(2)
      expect(onRemoveAttachment).toHaveBeenCalledWith('/foo.txt')
      expect(onRemoveAttachment).toHaveBeenCalledWith('/bar.txt')
    })

    it('calls onRemoveImage for each queued image attachment', () => {
      const onRemoveImage = vi.fn()
      const imageAttachments = [
        { data: 'imgA', mediaType: 'image/png', name: 'a.png' },
        { data: 'imgB', mediaType: 'image/png', name: 'b.png' },
      ]
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          imageAttachments={imageAttachments}
          onRemoveImage={onRemoveImage}
        />,
      )
      const textarea = screen.getByRole('textbox')
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(onRemoveImage).toHaveBeenCalledTimes(2)
    })

    it('calls onRemovePastedText for each queued pasted block', () => {
      const onRemovePastedText = vi.fn()
      const pastedTextBlocks = [
        { id: 1, content: 'block one' },
        { id: 2, content: 'block two' },
      ]
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          pastedTextBlocks={pastedTextBlocks}
          onRemovePastedText={onRemovePastedText}
        />,
      )
      const textarea = screen.getByRole('textbox')
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(onRemovePastedText).toHaveBeenCalledTimes(2)
      expect(onRemovePastedText).toHaveBeenCalledWith(1)
      expect(onRemovePastedText).toHaveBeenCalledWith(2)
    })

    it('keeps focus on the textarea after clearing', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'x' } })
      textarea.focus()
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(document.activeElement).toBe(textarea)
    })

    // Copilot review of #3853: handleChange's auto-resize sets an explicit
    // height on the textarea. setValue('') alone doesn't re-run that path,
    // so without this reset a cleared multi-line draft would leave the
    // textarea visually tall.
    it('resets the explicit height set by auto-resize', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      // Simulate a multi-line draft that's already been auto-resized
      fireEvent.change(textarea, { target: { value: 'line1\nline2\nline3\nline4' } })
      textarea.style.height = '120px'
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(textarea.style.height).toBe('auto')
    })

    it('is a no-op when the composer is empty', () => {
      const onRemoveAttachment = vi.fn()
      const onRemoveImage = vi.fn()
      const onRemovePastedText = vi.fn()
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          onRemoveAttachment={onRemoveAttachment}
          onRemoveImage={onRemoveImage}
          onRemovePastedText={onRemovePastedText}
        />,
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true })
      expect(textarea.value).toBe('')
      expect(onRemoveAttachment).not.toHaveBeenCalled()
      expect(onRemoveImage).not.toHaveBeenCalled()
      expect(onRemovePastedText).not.toHaveBeenCalled()
    })

    it('does not trigger on Alt+L or Shift+L (only plain Cmd/Ctrl+L)', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'x' } })
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true, altKey: true })
      expect(textarea.value).toBe('x')
      fireEvent.keyDown(textarea, { key: 'l', metaKey: true, shiftKey: true })
      expect(textarea.value).toBe('x')
    })
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

  it('shows interrupt button when busy but not streaming', () => {
    render(
      <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />
    )
    expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
  })

  it('calls onInterrupt when clicking stop button while busy', () => {
    const onInterrupt = vi.fn()
    render(
      <InputBar onSend={vi.fn()} onInterrupt={onInterrupt} isBusy />
    )
    fireEvent.click(screen.getByTestId('interrupt-button'))
    expect(onInterrupt).toHaveBeenCalled()
  })

  // #3850: pre-fix, the Send/Stop toggle was gated on `!value.trim()` —
  // typing a follow-up while busy hid Stop and the only way to interrupt
  // was Escape (undiscoverable). These tests pin the fix: while a turn is
  // in flight AND the composer has draft text, BOTH buttons must be
  // reachable so the user can either queue the follow-up (Send) or
  // interrupt the current turn (Stop). When the composer is empty during
  // busy state, only Stop is shown (preserves existing UX — no point
  // showing a Send that has nothing to send).
  describe('Stop button reachability with draft text (#3850)', () => {
    it('shows BOTH Send and Stop when busy with draft text', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'follow-up draft' } })
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('shows BOTH Send and Stop when streaming with draft text', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isStreaming />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'queued message' } })
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('hides Send button when busy with empty composer (only Stop visible)', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />)
      expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('hides Send button when busy and composer is whitespace-only', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: '   \n  \t  ' } })
      expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('clicking Stop interrupts even when composer has draft text', () => {
      const onInterrupt = vi.fn()
      render(<InputBar onSend={vi.fn()} onInterrupt={onInterrupt} isBusy />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'draft' } })
      fireEvent.click(screen.getByTestId('interrupt-button'))
      expect(onInterrupt).toHaveBeenCalled()
    })

    it('clicking Send while busy queues the follow-up (calls onSend with the draft)', () => {
      const onSend = vi.fn()
      render(<InputBar onSend={onSend} onInterrupt={vi.fn()} isBusy />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'queue this' } })
      fireEvent.click(screen.getByTestId('send-button'))
      expect(onSend).toHaveBeenCalledWith('queue this')
    })

    it('Send button while busy uses "Send follow-up" aria-label', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'x' } })
      expect(screen.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send follow-up')
    })

    // Order matters: the PR's UX contract is "Stop keeps the rightmost
    // position across all busy states" so users don't have to hunt when
    // they start typing. Without this assertion, a future reorder
    // (Stop-then-Send) would silently regress the layout — buttons
    // would still both render, all other tests would still pass.
    it('renders Send before Stop in DOM order (Stop stays rightmost)', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'draft' } })
      const sendBtn = screen.getByTestId('send-button')
      const stopBtn = screen.getByTestId('interrupt-button')
      // DOCUMENT_POSITION_FOLLOWING (4) means stopBtn comes after sendBtn
      // in document order — i.e., Send is earlier in the tree, Stop later.
      const pos = sendBtn.compareDocumentPosition(stopBtn)
      expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  // #3903 — symmetric edge case of the #3850 fix. send() will dispatch on
  // attachments-only (no text), and the non-busy path already pins this
  // (see "allows sending with attachments and empty text"). But the busy-
  // state Send-visibility gate was still `value.trim()` only, so users
  // who dragged a file in while a turn was in flight saw only Stop —
  // there was no way to queue the attachment-only follow-up without
  // typing a character first, or waiting for the current turn to end.
  // The fix is to use a `canSubmit` predicate that matches what send()
  // actually does: text OR file attachments OR images OR pasted-text
  // blocks. (Images/pasted-text are dispatched by App.tsx's handleSend
  // which reads them from outside InputBar — see App.tsx:1008.)
  describe('attachment-only follow-up while busy (#3903)', () => {
    it('shows Send when busy with file attachments and empty text', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          attachments={[{ path: 'src/App.tsx', name: 'App.tsx' }]}
          onRemoveAttachment={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('shows Send when streaming with file attachments and empty text', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isStreaming
          attachments={[{ path: 'src/index.ts', name: 'index.ts' }]}
          onRemoveAttachment={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('clicking Send while busy with attachment-only queues the follow-up', () => {
      const onSend = vi.fn()
      render(
        <InputBar
          onSend={onSend}
          onInterrupt={vi.fn()}
          isBusy
          attachments={[{ path: 'src/App.tsx', name: 'App.tsx' }]}
          onRemoveAttachment={vi.fn()}
        />,
      )
      fireEvent.click(screen.getByTestId('send-button'))
      expect(onSend).toHaveBeenCalledWith('', [{ path: 'src/App.tsx', name: 'App.tsx' }])
    })

    it('shows Send when busy with only image attachments', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          imageAttachments={[{ data: 'abc', mediaType: 'image/png', name: 'a.png' }]}
          onRemoveImage={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('shows Send when busy with only pasted-text blocks', () => {
      // #3984 — fixture must include the formatted marker so the block is
      // actually dispatchable. Without it, expandPasteMarkers would emit an
      // empty string and onSend('') would fire, dropping the paste content.
      const block = { id: 1, content: 'a'.repeat(2000) }
      const marker = `[Pasted text #${block.id} +${block.content.length} chars]`
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          controlledValue={marker}
          onValueChange={vi.fn()}
          pastedTextBlocks={[block]}
          onRemovePastedText={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('still hides Send when busy and composer is completely empty (no text, no attachments)', () => {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isBusy />)
      expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('Send button while busy with attachment-only uses "Send follow-up" aria-label', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          attachments={[{ path: 'src/App.tsx', name: 'App.tsx' }]}
          onRemoveAttachment={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send follow-up')
    })
  })

  // #3984 — Copilot follow-up to #3972: `pastedTextBlocks.length > 0` alone
  // was making canSubmit true even when the textarea had no marker referencing
  // those blocks. App.tsx's send path only expands markers present in `text`
  // (expandPasteMarkers), so Send would fire onSend('') and silently drop the
  // pasted content. The fix is to require at least one referenced marker in
  // `value` before treating pasted blocks as dispatchable content.
  describe('paste marker desync — Send must require a referenced marker in text (#3984)', () => {
    it('hides Send when busy with pasted blocks but no marker in textarea (non-dispatchable)', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          controlledValue=""
          onValueChange={vi.fn()}
          pastedTextBlocks={[{ id: 1, content: 'a'.repeat(2000) }]}
          onRemovePastedText={vi.fn()}
        />,
      )
      // No marker in text → expandPasteMarkers would produce '' → Send must
      // stay hidden so we never dispatch onSend('') and drop the paste.
      expect(screen.queryByTestId('send-button')).not.toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('shows Send when busy with pasted blocks AND the formatted marker is in textarea', () => {
      const block = { id: 1, content: 'a'.repeat(2000) }
      const marker = `[Pasted text #${block.id} +${block.content.length} chars]`
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          controlledValue={marker}
          onValueChange={vi.fn()}
          pastedTextBlocks={[block]}
          onRemovePastedText={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
      expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
    })

    it('shows Send when busy with 2 blocks but only 1 marker referenced (the orphan is the user\'s problem; dispatch is non-empty)', () => {
      const blocks = [
        { id: 1, content: 'a'.repeat(2000) },
        { id: 2, content: 'b'.repeat(2000) },
      ]
      // Only block #1's marker is in the text — block #2 is orphaned but
      // dispatch will still contain block #1's expanded content, so Send is
      // safe to enable.
      const marker = `[Pasted text #1 +${blocks[0]!.content.length} chars]`
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          controlledValue={marker}
          onValueChange={vi.fn()}
          pastedTextBlocks={blocks}
          onRemovePastedText={vi.fn()}
        />,
      )
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
    })

    it('does not crash when text contains a marker for a nonexistent block id (behaves like text-only)', () => {
      // Stale marker (block was evicted but the marker is still in the text).
      // App.tsx's expandPasteMarkers passes unknown markers through unchanged,
      // so this is just text content from the user's perspective — Send must
      // still surface because text.trim() is non-empty.
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          isBusy
          controlledValue="[Pasted text #99 +500 chars]"
          onValueChange={vi.fn()}
          pastedTextBlocks={[]}
          onRemovePastedText={vi.fn()}
        />,
      )
      // hasText is true (the marker string itself is text content), so Send
      // should be visible regardless of the dangling marker.
      expect(screen.getByTestId('send-button')).toBeInTheDocument()
    })

    it('non-busy: Send button disabled when pasted blocks exist but no marker in text', () => {
      // Mirrors the busy-state behavior in the non-busy path. The Send button
      // is always rendered when not busy, but canSubmit gates the actual
      // send() invocation — clicking with no dispatchable content is a no-op.
      const onSend = vi.fn()
      render(
        <InputBar
          onSend={onSend}
          onInterrupt={vi.fn()}
          controlledValue=""
          onValueChange={vi.fn()}
          pastedTextBlocks={[{ id: 1, content: 'a'.repeat(2000) }]}
          onRemovePastedText={vi.fn()}
        />,
      )
      // Send button is present (non-busy always renders it) but clicking it
      // must NOT dispatch onSend, because the paste block has no marker and
      // text.trim() is empty.
      fireEvent.click(screen.getByTestId('send-button'))
      expect(onSend).not.toHaveBeenCalled()
    })

    it('non-busy: clicking Send with a referenced marker dispatches normally', () => {
      const block = { id: 1, content: 'a'.repeat(2000) }
      const marker = `[Pasted text #${block.id} +${block.content.length} chars]`
      const onSend = vi.fn()
      render(
        <InputBar
          onSend={onSend}
          onInterrupt={vi.fn()}
          controlledValue={marker}
          onValueChange={vi.fn()}
          pastedTextBlocks={[block]}
          onRemovePastedText={vi.fn()}
        />,
      )
      fireEvent.click(screen.getByTestId('send-button'))
      // App.tsx expands the marker before sending; InputBar just forwards the
      // marker-bearing text verbatim.
      expect(onSend).toHaveBeenCalledWith(marker)
    })
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

  // #4342 — when the filtered command list is empty (e.g. "/no-such-command"),
  // the picker was swallowing Enter: the keydown handler always preventDefault'd
  // and returned, without selecting a command and without falling through to
  // the standard send path. The user got stuck — Enter did nothing, and the
  // only way out was clicking Send with the mouse or hitting Escape. The fix:
  // when the filter yields zero matches, close the picker and let the regular
  // Enter handling decide (sendOnEnter / modifier / newline).
  describe('Enter on empty filter must not be swallowed (#4342)', () => {
    it('plain Enter on empty-filter list does NOT call selectCommand and closes picker', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          slashCommands={mockCommands}
        />,
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: '/unknown' } })
      // Picker is open with "No commands found" state
      expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      // Text was not replaced with "/commit " (or any other selected command).
      // The default `sendOnEnter=false` means plain Enter is a newline, not a
      // send — so the only requirement is that nothing got swallowed.
      expect(textarea.value).toBe('/unknown')
      // Picker is closed so the user can keep typing without further swallows.
      expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
    })

    it('Cmd+Enter on empty-filter list sends the typed text and closes picker', () => {
      const onSend = vi.fn()
      render(
        <InputBar
          onSend={onSend}
          onInterrupt={vi.fn()}
          slashCommands={mockCommands}
        />,
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: '/unknown' } })
      expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
      expect(onSend).toHaveBeenCalledWith('/unknown')
      expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
    })

    it('plain Enter on empty-filter list with sendOnEnter sends the typed text and closes picker', () => {
      const onSend = vi.fn()
      render(
        <InputBar
          onSend={onSend}
          onInterrupt={vi.fn()}
          slashCommands={mockCommands}
          sendOnEnter
        />,
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: '/unknown' } })
      expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(onSend).toHaveBeenCalledWith('/unknown')
      expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
    })

    it('happy path: Enter with matching filter still picks the command (regression guard)', () => {
      render(
        <InputBar
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          slashCommands={mockCommands}
        />,
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: '/com' } })
      expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      // Picker selected the matching command rather than sending the text
      expect(textarea.value).toBe('/commit ')
      expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
    })

    it('Escape on empty-filter list still closes the picker without sending', () => {
      const onSend = vi.fn()
      const onInterrupt = vi.fn()
      render(
        <InputBar
          onSend={onSend}
          onInterrupt={onInterrupt}
          slashCommands={mockCommands}
        />,
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: '/unknown' } })
      expect(screen.getByTestId('slash-picker')).toBeInTheDocument()
      fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(screen.queryByTestId('slash-picker')).not.toBeInTheDocument()
      expect(onSend).not.toHaveBeenCalled()
      // Escape inside the slash picker is consumed by the picker handler — it
      // closes the picker and returns early, so onInterrupt must NOT fire.
      expect(onInterrupt).not.toHaveBeenCalled()
    })
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

  it('does not call onImageDrop when disabled', () => {
    const onImageDrop = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImageDrop={onImageDrop} disabled />)
    const dropZone = screen.getByTestId('input-bar')

    const file = createMockFile('photo.jpg', 1000, 'image/jpeg')
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    })
    expect(onImageDrop).not.toHaveBeenCalled()
  })

  it('does not call onImagePaste when disabled', () => {
    const onImagePaste = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImagePaste={onImagePaste} disabled />)
    const textarea = screen.getByRole('textbox')

    const file = createMockFile('screenshot.png', 1000, 'image/png')
    fireEvent.paste(textarea, {
      clipboardData: { files: [file] },
    })
    expect(onImagePaste).not.toHaveBeenCalled()
  })

  it('adds dragging class on dragEnter and removes on dragLeave', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImageDrop={vi.fn()} />)
    const dropZone = screen.getByTestId('input-bar')

    fireEvent.dragEnter(dropZone)
    expect(dropZone.classList.contains('dragging')).toBe(true)

    fireEvent.dragLeave(dropZone)
    expect(dropZone.classList.contains('dragging')).toBe(false)
  })

  it('removes dragging class on drop', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onImageDrop={vi.fn()} />)
    const dropZone = screen.getByTestId('input-bar')

    fireEvent.dragEnter(dropZone)
    expect(dropZone.classList.contains('dragging')).toBe(true)

    const file = createMockFile('photo.jpg', 1000, 'image/jpeg')
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })
    expect(dropZone.classList.contains('dragging')).toBe(false)
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

  it('deduplicates attachments with same path', () => {
    const attachments = [
      { path: 'src/App.tsx', name: 'App.tsx' },
      { path: 'src/App.tsx', name: 'App.tsx' },
    ]
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={vi.fn()}
      />
    )
    // Should only render one chip despite two entries with same path
    const chips = screen.getAllByText('App.tsx')
    expect(chips).toHaveLength(1)
  })

  it('sends deduplicated attachments to onSend', () => {
    const onSend = vi.fn()
    const attachments = [
      { path: 'src/App.tsx', name: 'App.tsx' },
      { path: 'src/App.tsx', name: 'App.tsx' },
      { path: 'src/index.ts', name: 'index.ts' },
    ]
    render(
      <InputBar
        onSend={onSend}
        onInterrupt={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={vi.fn()}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'explain' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).toHaveBeenCalledWith('explain', [
      { path: 'src/App.tsx', name: 'App.tsx' },
      { path: 'src/index.ts', name: 'index.ts' },
    ])
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

// #3091 — evaluator result panels must announce themselves to screen readers.
// Pending / forward / rewrite / clarify use role="status" + aria-live="polite";
// error keeps role="alert" (implicit aria-live="assertive").
//
// Hoisted to a top-level describe (matching the file's other #issue blocks)
// because evaluator behavior is unrelated to attachments.
describe('InputBar evaluator panel ARIA live regions (#3091)', () => {
  /**
   * Trigger the evaluator and wait for the verdict-specific result panel.
   *
   * Both the pending and resolved panels use the same `evaluator-panel`
   * testid; without waiting for the verdict marker, `findByTestId` could
   * return the pending panel before the resolved verdict renders. Asserting
   * on `data-verdict` inside `waitFor` pins the test to the resolved state.
   */
  async function renderAndEvaluate(payload: EvaluatorResultPayload) {
    const onEvaluate = vi.fn().mockResolvedValue(payload)
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onEvaluate={onEvaluate} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'draft text' } })
    fireEvent.click(screen.getByTestId('evaluate-button'))
    await waitFor(() => {
      expect(onEvaluate).toHaveBeenCalled()
    })
    const panel = await screen.findByTestId('evaluator-panel')
    await waitFor(() => {
      expect(panel).toHaveAttribute('data-verdict', payload.verdict ?? '')
    })
    return panel
  }

  it('pending panel exposes role="status" with aria-live="polite" and aria-busy', () => {
    // Hold the promise open so the pending panel stays visible.
    const onEvaluate = vi.fn().mockReturnValue(new Promise<EvaluatorResultPayload>(() => {}))
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onEvaluate={onEvaluate} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'draft' } })
    fireEvent.click(screen.getByTestId('evaluate-button'))

    const panel = screen.getByTestId('evaluator-panel')
    expect(panel).toHaveAttribute('role', 'status')
    expect(panel).toHaveAttribute('aria-live', 'polite')
    expect(panel).toHaveAttribute('aria-busy', 'true')
  })

  it('forward verdict panel exposes role="status" + aria-live="polite"', async () => {
    const panel = await renderAndEvaluate({ verdict: 'forward', reasoning: 'Looks good' })
    expect(panel).toHaveAttribute('role', 'status')
    expect(panel).toHaveAttribute('aria-live', 'polite')
    expect(panel).toHaveAttribute('data-verdict', 'forward')
  })

  it('rewrite verdict panel exposes role="status" + aria-live="polite"', async () => {
    const panel = await renderAndEvaluate({
      verdict: 'rewrite',
      rewritten: 'Cleaner version',
      reasoning: 'Tightened wording',
    })
    expect(panel).toHaveAttribute('role', 'status')
    expect(panel).toHaveAttribute('aria-live', 'polite')
    expect(panel).toHaveAttribute('data-verdict', 'rewrite')
  })

  it('clarify verdict panel exposes role="status" + aria-live="polite"', async () => {
    const panel = await renderAndEvaluate({
      verdict: 'clarify',
      clarification: 'Which file did you mean?',
      reasoning: 'Ambiguous reference',
    })
    expect(panel).toHaveAttribute('role', 'status')
    expect(panel).toHaveAttribute('aria-live', 'polite')
    expect(panel).toHaveAttribute('data-verdict', 'clarify')
  })

  it('error panel keeps role="alert" (assertive) for failure cases', async () => {
    const onEvaluate = vi.fn().mockRejectedValue(new Error('network down'))
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onEvaluate={onEvaluate} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'draft' } })
    fireEvent.click(screen.getByTestId('evaluate-button'))

    const panel = await screen.findByTestId('evaluator-panel')
    expect(panel).toHaveAttribute('role', 'alert')
    // role="alert" implies aria-live="assertive"; we don't set it explicitly.
    expect(panel).not.toHaveAttribute('aria-live', 'polite')
  })

  // #3100: dashboard branches on error.status to give a specific recovery
  // hint (auth vs rate-limit vs 5xx) instead of forcing the user to parse
  // the generic message.
  describe('#3100 evaluator error status recovery hint', () => {
    async function renderAndEvaluateError(payload: EvaluatorResultPayload) {
      const onEvaluate = vi.fn().mockResolvedValue(payload)
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} onEvaluate={onEvaluate} />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: 'draft' } })
      fireEvent.click(screen.getByTestId('evaluate-button'))
      // Pin to the resolved-error panel: pending uses role="status", error
      // uses role="alert". `findByRole` waits for it to appear, so the
      // negative-case `queryByTestId('evaluator-hint')` assertions below
      // can't run against the still-pending panel.
      return screen.findByRole('alert')
    }

    it('renders an API-key hint for status 401', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator authentication failed', status: 401 },
      })
      const hint = await screen.findByTestId('evaluator-hint')
      expect(hint).toHaveTextContent(/ANTHROPIC_API_KEY/i)
    })

    it('renders an API-key hint for status 403', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator authentication failed', status: 403 },
      })
      const hint = await screen.findByTestId('evaluator-hint')
      expect(hint).toHaveTextContent(/ANTHROPIC_API_KEY/i)
    })

    it('renders a "try again" hint for status 429', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator rate limited', status: 429 },
      })
      const hint = await screen.findByTestId('evaluator-hint')
      expect(hint).toHaveTextContent(/try again/i)
    })

    it('renders an upstream-unavailable hint for 5xx statuses', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator service unavailable', status: 503 },
      })
      const hint = await screen.findByTestId('evaluator-hint')
      expect(hint).toHaveTextContent(/upstream/i)
    })

    it('omits the hint when no status is present (generic / network error)', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator network error' },
      })
      // renderAndEvaluateError already returned only after the resolved
      // error panel rendered (findByRole('alert')), so a stray hint would
      // be visible by now if regressed.
      expect(screen.queryByTestId('evaluator-hint')).toBeNull()
    })

    it('omits the hint for non-API errors that happen to lack status (NO_API_KEY)', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set' },
      })
      expect(screen.queryByTestId('evaluator-hint')).toBeNull()
    })

    it('omits the hint for unmapped statuses (e.g. 400 client error)', async () => {
      await renderAndEvaluateError({
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator API call failed', status: 400 },
      })
      expect(screen.queryByTestId('evaluator-hint')).toBeNull()
    })
  })
})

describe('InputBar large-text paste (#3797)', () => {
  function bigText(lines: number, charsPerLine = 100): string {
    const line = 'x'.repeat(charsPerLine)
    return Array(lines).fill(line).join('\n')
  }

  it('intercepts oversized text paste, calls onLargePaste, and splices the marker', () => {
    const onLargePaste = vi.fn().mockReturnValue('[Pasted text #1 +30 lines]')
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={onValueChange}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox')

    const text = bigText(30)
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onLargePaste).toHaveBeenCalledWith(text)
    expect(onValueChange).toHaveBeenCalledWith('[Pasted text #1 +30 lines]')
  })

  it('splices the marker at the current selection, preserving prefix/suffix', () => {
    const onLargePaste = vi.fn().mockReturnValue('[Pasted text #1 +30 lines]')
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue="hello world"
        onValueChange={onValueChange}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    textarea.setSelectionRange(6, 6)

    const text = bigText(30)
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onValueChange).toHaveBeenCalledWith('hello [Pasted text #1 +30 lines]world')
  })

  it('does NOT intercept paste when text is below the threshold', () => {
    const onLargePaste = vi.fn()
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={onValueChange}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox')

    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) => (type === 'text/plain' ? 'short text' : ''),
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onLargePaste).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('does NOT intercept paste when onLargePaste is undefined (graceful fallback)', () => {
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={onValueChange}
      />,
    )
    const textarea = screen.getByRole('textbox')

    const text = bigText(30)
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    }
    fireEvent.paste(textarea, { clipboardData })

    // No onLargePaste prop, so the default paste behavior runs — onValueChange
    // fires through native paste, which we don't simulate here. Critically,
    // nothing crashes and no marker injection happens.
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('falls back to text/html when text/plain is empty (WKWebView markdown copy)', () => {
    // Repro for the bug: copying rendered markdown out of the chroxy chat view
    // in Tauri's WKWebView puts HTML on the clipboard with no text/plain
    // payload. Without the fallback the paste fell through to default
    // browser handling and never collapsed.
    const onLargePaste = vi.fn().mockReturnValue('[Pasted text #1 +30 lines]')
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={onValueChange}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox')

    // Build an HTML payload that's well over the line threshold once stripped.
    const htmlLines = Array(30).fill('<p>line of <strong>rendered</strong> content</p>').join('')
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === 'text/plain' ? '' : type === 'text/html' ? htmlLines : '',
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onLargePaste).toHaveBeenCalledTimes(1)
    const arg = onLargePaste.mock.calls[0]![0] as string
    expect(arg).toContain('line of rendered content')
    expect(arg.split('\n').length).toBeGreaterThanOrEqual(20)
    expect(onValueChange).toHaveBeenCalledWith('[Pasted text #1 +30 lines]')
  })

  it('preserves leading whitespace on the first line of HTML fallback pastes (#3842)', () => {
    // Regression: `.trim()` on the htmlToPlainText output silently stripped
    // the indentation off the first line of indented code blocks / YAML
    // copied out of a rendered `<pre>`. The collapsed-paste path later
    // sends the stashed content verbatim, so the model received the paste
    // with the first line's indentation removed.
    const onLargePaste = vi.fn().mockReturnValue('[Pasted text #1 +30 lines]')
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={onValueChange}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox')

    // Indented first line, plus enough additional lines to clear the
    // 20-line collapse threshold.
    const extraLines = Array(30).fill('<p>more content</p>').join('')
    const html = `<pre>    def foo():\n        return 1</pre>${extraLines}`
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === 'text/plain' ? '' : type === 'text/html' ? html : '',
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onLargePaste).toHaveBeenCalledTimes(1)
    const arg = onLargePaste.mock.calls[0]![0] as string
    // The four leading spaces from the indented `<pre>` first line must
    // survive into the stashed paste content.
    expect(arg.startsWith('    def foo():')).toBe(true)
  })

  it('falls back to text/html when text/plain is whitespace-only (#3844)', () => {
    // Regression: some clipboard sources (browser extensions, custom
    // Electron apps, Windows-native sources) emit whitespace-only
    // `text/plain` alongside meaningful `text/html`. The previous
    // `if (!text)` guard treated `"   "` as truthy and fell through to
    // default paste behaviour, skipping the HTML fallback entirely.
    const onLargePaste = vi.fn().mockReturnValue('[Pasted text #1 +30 lines]')
    const onValueChange = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={onValueChange}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox')

    const htmlLines = Array(30).fill('<p>line of <strong>rendered</strong> content</p>').join('')
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === 'text/plain' ? '   ' : type === 'text/html' ? htmlLines : '',
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onLargePaste).toHaveBeenCalledTimes(1)
    const arg = onLargePaste.mock.calls[0]![0] as string
    expect(arg).toContain('line of rendered content')
    expect(arg.split('\n').length).toBeGreaterThanOrEqual(20)
    expect(onValueChange).toHaveBeenCalledWith('[Pasted text #1 +30 lines]')
  })

  it('image paste takes priority over text paste when clipboard has both', () => {
    const onImagePaste = vi.fn()
    const onLargePaste = vi.fn()
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={vi.fn()}
        onImagePaste={onImagePaste}
        onLargePaste={onLargePaste}
      />,
    )
    const textarea = screen.getByRole('textbox')

    const file = new File([new ArrayBuffer(1000)], 'screenshot.png', { type: 'image/png' })
    const clipboardData = {
      files: [file],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: (type: string) => (type === 'text/plain' ? 'x'.repeat(2000) : ''),
    }
    fireEvent.paste(textarea, { clipboardData })

    expect(onImagePaste).toHaveBeenCalled()
    expect(onLargePaste).not.toHaveBeenCalled()
  })

  it('renders chips for staged paste blocks', () => {
    const blocks = [
      { id: 1, content: 'a'.repeat(2000) },
      { id: 2, content: 'b\n'.repeat(25) },
    ]
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        controlledValue=""
        onValueChange={vi.fn()}
        pastedTextBlocks={blocks}
        onInspectPastedText={vi.fn()}
        onRemovePastedText={vi.fn()}
      />,
    )

    expect(screen.getByTestId('pasted-text-chip-1')).toBeInTheDocument()
    expect(screen.getByTestId('pasted-text-chip-2')).toBeInTheDocument()
  })
})
