import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SplitPane } from './SplitPane'

// react-resizable-panels requires ResizeObserver which jsdom lacks
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
})

describe('SplitPane', () => {
  it('renders both panes', () => {
    render(
      <SplitPane
        direction="horizontal"
        first={<div data-testid="first">Chat</div>}
        second={<div data-testid="second">Terminal</div>}
      />,
    )
    expect(screen.getByTestId('first')).toBeInTheDocument()
    expect(screen.getByTestId('second')).toBeInTheDocument()
  })

  it('renders with vertical direction', () => {
    const { container } = render(
      <SplitPane
        direction="vertical"
        first={<div>Chat</div>}
        second={<div>Terminal</div>}
      />,
    )
    expect(container.querySelector('.split-vertical')).toBeInTheDocument()
  })

  it('renders with horizontal direction', () => {
    const { container } = render(
      <SplitPane
        direction="horizontal"
        first={<div>Chat</div>}
        second={<div>Terminal</div>}
      />,
    )
    expect(container.querySelector('.split-horizontal')).toBeInTheDocument()
  })

  it('calls onReset when separator is double-clicked', () => {
    const onReset = vi.fn()
    const { container } = render(
      <SplitPane
        direction="horizontal"
        first={<div>Chat</div>}
        second={<div>Terminal</div>}
        onReset={onReset}
      />,
    )
    const handle = container.querySelector('.split-resize-handle')
    expect(handle).toBeInTheDocument()
    if (handle) {
      fireEvent.doubleClick(handle)
      expect(onReset).toHaveBeenCalledTimes(1)
    }
  })

  it('renders two split-panel-content divs', () => {
    const { container } = render(
      <SplitPane
        direction="horizontal"
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    )
    const panels = container.querySelectorAll('.split-panel-content')
    expect(panels.length).toBe(2)
  })
})
