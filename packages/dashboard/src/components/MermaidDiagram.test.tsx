/**
 * MermaidDiagram tests (#6754).
 *
 * `mermaid` is mocked so the test is deterministic and never pulls the real
 * (large, browser-oriented) engine: a valid source resolves to a fake `<svg>`,
 * a source containing `INVALID` rejects — exercising both the happy path (SVG
 * injected) and the mandatory parse-error fallback (raw code block + error).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MermaidDiagram } from './MermaidDiagram'

const initialize = vi.fn()
const renderFn = vi.fn(async (_id: string, src: string) => {
  if (src.includes('INVALID')) throw new Error('Parse error on line 1')
  return { svg: `<svg data-mermaid="1"><g><text>${src.trim()}</text></g></svg>` }
})

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initialize(...args),
    render: (id: string, src: string) => renderFn(id, src),
  },
}))

afterEach(cleanup)
// NB: `initialize` is intentionally NOT cleared between tests — the component
// guards it to run once per page load, so only the first render in this file
// calls it. `initialize.mock.calls[0]` therefore holds that one strict config
// regardless of which test inspects it.
beforeEach(() => {
  renderFn.mockClear()
})

describe('MermaidDiagram', () => {
  it('shows a loading placeholder before the async render resolves', () => {
    render(<MermaidDiagram source="graph TD; A-->B" />)
    expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument()
  })

  it('renders sanitized SVG for a valid diagram', async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />)
    const el = await screen.findByTestId('mermaid-diagram')
    expect(el.querySelector('svg')).not.toBeNull()
    // textContent decodes entities (innerHTML serializes `>` as `&gt;`)
    expect(el.textContent).toContain('A-->B')
  })

  it('initializes mermaid with strict security level', async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />)
    await screen.findByTestId('mermaid-diagram')
    expect(initialize).toHaveBeenCalled()
    const cfg = initialize.mock.calls[0]![0] as Record<string, unknown>
    expect(cfg.securityLevel).toBe('strict')
    expect(cfg.htmlLabels).toBe(false)
  })

  it('falls back to the raw code block (with the error) when the diagram is invalid', async () => {
    render(<MermaidDiagram source="INVALID not a diagram" />)
    const fallback = await screen.findByTestId('mermaid-fallback')
    // parse error surfaced
    expect(screen.getByTestId('mermaid-error')).toHaveTextContent('Parse error on line 1')
    // and the source is preserved as a code block, not lost
    expect(fallback.querySelector('pre')).not.toBeNull()
    expect(fallback.textContent).toContain('INVALID not a diagram')
    // no diagram was injected
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
  })

  it('re-renders when the source changes', async () => {
    const { rerender } = render(<MermaidDiagram source="graph TD; A-->B" />)
    await screen.findByTestId('mermaid-diagram')
    rerender(<MermaidDiagram source="graph TD; C-->D" />)
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram').textContent).toContain('C-->D')
    })
  })

  // Defense in depth (#6985): every other test here mocks mermaid.render()
  // to return BENIGN SVG, so none of them prove the layer-2 DOMPurify.sanitize
  // call actually strips anything — a refactor that silently dropped it would
  // still pass. Mock a MALICIOUS render result (as if mermaid's own strict
  // sanitization were bypassed or buggy) and assert the DOM we actually mount
  // is clean, proving the second sanitize pass is load-bearing.
  it('strips a malicious payload from the rendered SVG even if mermaid itself lets it through', async () => {
    renderFn.mockImplementationOnce(async () => ({
      svg:
        '<svg data-mermaid="1">' +
        '<script>window.__xss = "script"</script>' +
        '<g onerror="window.__xss = &quot;onerror&quot;"><text>A</text></g>' +
        '<foreignObject><div onclick="window.__xss = &quot;onclick&quot;">evil</div></foreignObject>' +
        '<text>valid label</text>' +
        '</svg>',
    }))
    render(<MermaidDiagram source="graph TD; A-->B" />)
    const el = await screen.findByTestId('mermaid-diagram')

    // The malicious elements/attributes are gone...
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('foreignObject')).toBeNull()
    expect(el.innerHTML).not.toContain('onerror')
    expect(el.innerHTML).not.toContain('onclick')
    expect(el.textContent).not.toContain('__xss')
    // ...while the legitimate diagram content survives (proves the SVG
    // profile isn't just nuking the whole payload — it's targeted removal).
    expect(el.querySelector('svg')).not.toBeNull()
    expect(el.textContent).toContain('valid label')
  })
})
