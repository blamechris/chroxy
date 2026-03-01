/**
 * ToolBubble component tests (#1168)
 *
 * Tests keyboard accessibility, ARIA attributes, and expand/collapse behavior.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ToolBubble } from './ToolBubble'

afterEach(cleanup)

describe('ToolBubble', () => {
  const baseProps = {
    toolName: 'Read',
    toolUseId: 'tool-1',
    input: '/path/to/file',
    result: 'file contents here',
  }

  it('renders tool name and input summary', () => {
    render(<ToolBubble {...baseProps} />)
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByTestId('tool-input-summary')).toHaveTextContent('/path/to/file')
  })

  it('uses a button element for the toggle', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    expect(toggle).toBeInTheDocument()
  })

  it('has aria-expanded reflecting collapsed state', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands on click and sets aria-expanded to true', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('file contents here')).toBeInTheDocument()
  })

  it('collapses on second click', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('file contents here')).not.toBeInTheDocument()
  })

  it('expands on Enter key', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.keyDown(toggle, { key: 'Enter' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('file contents here')).toBeInTheDocument()
  })

  it('expands on Space key', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('ignores repeated Space key events', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Held key (repeat) should not toggle back
    fireEvent.keyDown(toggle, { key: ' ', repeat: true })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('sets aria-controls only when result panel is visible', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    // Collapsed: no aria-controls (panel not in DOM)
    expect(toggle).not.toHaveAttribute('aria-controls')
    // Expanded: aria-controls references the panel
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-controls', 'tool-result-tool-1')
  })

  it('result panel has matching id', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.click(toggle)
    const resultPanel = screen.getByText('file contents here').closest('.tool-result')
    expect(resultPanel).toHaveAttribute('id', 'tool-result-tool-1')
  })

  it('is focusable via tab', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('tabindex', '0')
  })

  it('does not show result when no result prop', () => {
    render(<ToolBubble toolName="Write" toolUseId="tool-2" />)
    expect(screen.getByText('Write')).toBeInTheDocument()
    expect(screen.queryByTestId('tool-input-summary')).not.toBeInTheDocument()
  })

  it('truncates long input summaries', () => {
    const longInput = 'a'.repeat(200)
    render(<ToolBubble toolName="Read" toolUseId="tool-3" input={longInput} />)
    const summary = screen.getByTestId('tool-input-summary')
    expect(summary.textContent!.length).toBeLessThanOrEqual(100)
  })
})
