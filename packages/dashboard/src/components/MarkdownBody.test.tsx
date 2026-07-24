/**
 * MarkdownBody routing tests (#6754).
 *
 * MermaidDiagram is stubbed so this focuses purely on the split/route logic:
 * markdown segments hit `renderMarkdown` (innerHTML), mermaid segments mount
 * the diagram component with the inner source.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MarkdownBody } from './MarkdownBody'

vi.mock('./MermaidDiagram', () => ({
  MermaidDiagram: ({ source }: { source: string }) => (
    <div data-testid="stub-mermaid">{source}</div>
  ),
}))

afterEach(cleanup)

describe('MarkdownBody', () => {
  it('renders plain markdown via the single-innerHTML fast path (no mixed wrapper)', () => {
    const { container } = render(<MarkdownBody content={'# Hello\n\n```js\nx()\n```'} />)
    // no mermaid → no diagram, no mixed-segment wrapper
    expect(screen.queryByTestId('stub-mermaid')).toBeNull()
    expect(container.querySelector('.markdown-body-mixed')).toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe('Hello')
    // other-language fence still renders as a highlighted code block
    expect(container.querySelector('pre code')).not.toBeNull()
  })

  it('routes a mermaid fence to MermaidDiagram with the inner source, keeping surrounding text', () => {
    const { container } = render(
      <MarkdownBody content={'intro\n\n```mermaid\ngraph TD; A-->B\n```\n\noutro'} />,
    )
    expect(container.querySelector('.markdown-body-mixed')).not.toBeNull()
    const stub = screen.getByTestId('stub-mermaid')
    expect(stub).toHaveTextContent('graph TD; A-->B')
    // surrounding markdown preserved
    expect(container.textContent).toContain('intro')
    expect(container.textContent).toContain('outro')
  })
})
