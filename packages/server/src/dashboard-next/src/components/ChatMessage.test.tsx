/**
 * ChatMessage + ToolBubble component tests (#1155)
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ChatMessage } from './ChatMessage'
import { ToolBubble } from './ToolBubble'

describe('ChatMessage', () => {
  it('renders assistant message with markdown', () => {
    render(
      <ChatMessage
        id="msg-1"
        type="response"
        content="Hello **world**"
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-1')
    expect(el).toHaveClass('assistant')
    expect(el.innerHTML).toContain('<strong>world</strong>')
  })

  it('renders user message as plain text', () => {
    render(
      <ChatMessage
        id="msg-2"
        type="user_input"
        content="my input <script>"
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-2')
    expect(el).toHaveClass('user')
    expect(el.textContent).toContain('my input <script>')
    expect(el.innerHTML).not.toContain('<script>')
  })

  it('renders system message', () => {
    render(
      <ChatMessage
        id="msg-3"
        type="system"
        content="System notice"
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-3')
    expect(el).toHaveClass('system')
    expect(el.textContent).toContain('System notice')
  })

  it('renders error message', () => {
    render(
      <ChatMessage
        id="msg-4"
        type="error"
        content="Something failed"
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-4')
    expect(el).toHaveClass('error')
    expect(el.textContent).toContain('Something failed')
  })

  it('renders thinking message with animation class', () => {
    render(
      <ChatMessage
        id="msg-5"
        type="thinking"
        content="..."
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-5')
    expect(el).toHaveClass('thinking')
  })

  it('renders tool_use message with markdown', () => {
    render(
      <ChatMessage
        id="msg-7"
        type="tool_use"
        content="Running `npm test`..."
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-7')
    expect(el).toHaveClass('tool_use')
    expect(el.innerHTML).toContain('<code>')
  })

  it('applies streaming class when isStreaming is true', () => {
    render(
      <ChatMessage
        id="msg-6"
        type="response"
        content="partial content..."
        timestamp={Date.now()}
        isStreaming
      />
    )
    const el = screen.getByTestId('chat-message-msg-6')
    expect(el).toHaveClass('streaming')
  })

  it('system message has data-muted attribute', () => {
    render(
      <ChatMessage
        id="msg-sys-muted"
        type="system"
        content="Client connected"
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-sys-muted')
    expect(el).toHaveAttribute('data-muted', 'true')
  })

  it('non-system messages do not have data-muted attribute', () => {
    render(
      <ChatMessage
        id="msg-resp"
        type="response"
        content="Hello"
        timestamp={Date.now()}
      />
    )
    const el = screen.getByTestId('chat-message-msg-resp')
    expect(el).not.toHaveAttribute('data-muted')
  })
})


  it('does not render thinking bubble when content is empty string', () => {
    const { container } = render(
      <ChatMessage
        id="msg-thinking-empty"
        type="thinking"
        content=""
        timestamp={Date.now()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('does not render thinking bubble when content is whitespace only', () => {
    const { container } = render(
      <ChatMessage
        id="msg-thinking-ws"
        type="thinking"
        content="   "
        timestamp={Date.now()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders thinking bubble when content is non-empty', () => {
    render(
      <ChatMessage
        id="msg-thinking-ok"
        type="thinking"
        content="Analyzing..."
        timestamp={Date.now()}
      />
    )
    expect(screen.getByTestId('chat-message-msg-thinking-ok')).toBeInTheDocument()
  })

describe('ToolBubble', () => {
  it('renders tool name', () => {
    render(
      <ToolBubble
        toolName="Read"
        toolUseId="tool-1"
        input={{ file_path: '/src/index.ts' }}
      />
    )
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('shows input summary', () => {
    render(
      <ToolBubble
        toolName="Bash"
        toolUseId="tool-2"
        input={{ command: 'npm test' }}
      />
    )
    const bubble = screen.getByTestId('tool-bubble-tool-2')
    expect(within(bubble).getByText('npm test')).toBeInTheDocument()
  })

  it('shows file_path from input', () => {
    render(
      <ToolBubble
        toolName="Read"
        toolUseId="tool-3"
        input={{ file_path: '/src/app.ts' }}
      />
    )
    expect(screen.getByText('/src/app.ts')).toBeInTheDocument()
  })

  it('toggles expanded state on click', () => {
    render(
      <ToolBubble
        toolName="Read"
        toolUseId="tool-4"
        input={{ file_path: '/test' }}
        result="file contents here"
      />
    )
    const bubble = screen.getByTestId('tool-bubble-tool-4')
    expect(bubble).not.toHaveClass('expanded')
    fireEvent.click(bubble)
    expect(bubble).toHaveClass('expanded')
    fireEvent.click(bubble)
    expect(bubble).not.toHaveClass('expanded')
  })

  it('shows result when expanded', () => {
    render(
      <ToolBubble
        toolName="Bash"
        toolUseId="tool-5"
        input={{ command: 'ls' }}
        result="file1.ts\nfile2.ts"
      />
    )
    const bubble = screen.getByTestId('tool-bubble-tool-5')
    fireEvent.click(bubble)
    expect(screen.getByText(/file1\.ts/)).toBeInTheDocument()
  })

  it('truncates long input summary', () => {
    const longInput = { command: 'x'.repeat(200) }
    render(
      <ToolBubble
        toolName="Bash"
        toolUseId="tool-6"
        input={longInput}
      />
    )
    const bubble = screen.getByTestId('tool-bubble-tool-6')
    const summary = within(bubble).getByTestId('tool-input-summary')
    expect(summary.textContent!.length).toBeLessThanOrEqual(100)
  })
})
