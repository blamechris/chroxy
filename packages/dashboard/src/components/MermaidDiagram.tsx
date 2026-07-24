/**
 * MermaidDiagram (#6754) — renders a ```mermaid fence as an actual diagram.
 *
 * Security model (mandatory — the diagram source is MODEL-controlled and could
 * be adversarial):
 *  - mermaid is initialized with `securityLevel: 'strict'`, which sanitizes
 *    node labels, disables click handlers / arbitrary-HTML labels, and runs the
 *    generated SVG through mermaid's own internal DOMPurify pass before
 *    returning it. `htmlLabels` is forced off (no `<foreignObject>` HTML escape
 *    hatch) at every level that accepts it.
 *  - We never `dangerouslySetInnerHTML` the raw model text. We call
 *    `mermaid.render()` (which returns sanitized SVG) and then run that SVG
 *    through DOMPurify AGAIN (defense in depth) before injecting it.
 *
 * Robustness:
 *  - mermaid is LAZY-loaded via a dynamic `import()` so the (large) engine is a
 *    separate bundle chunk pulled only when a mermaid block actually renders —
 *    it never bloats the dashboard's initial load.
 *  - Models frequently emit broken mermaid. A parse/render failure (or a
 *    failure to even load the chunk, e.g. offline) MUST NOT break the message:
 *    we catch it and fall back to the exact code-block render the normal
 *    pipeline would have produced (`renderMarkdown` of the re-fenced source),
 *    with the syntax error shown above it, so the user always keeps the source.
 *  - `mermaid.render()` is async; the loading state shows a compact placeholder.
 */
import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { renderMarkdown } from '../lib/markdown'

/** Minimal surface of the mermaid module we depend on (keeps us off `any`). */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

// Monotonic id for the transient element mermaid renders into. Must be a valid
// DOM/CSS id (mermaid does `document.querySelector('#' + id)`), so no colons —
// hence a plain counter rather than React's `useId()` (which yields `:r1:`).
let idCounter = 0
// mermaid.initialize is global + idempotent; run it once per page load.
let initialized = false

async function loadMermaid(): Promise<MermaidApi> {
  const mod = (await import('mermaid')) as unknown as { default?: MermaidApi } & Partial<MermaidApi>
  const mermaid = (mod.default ?? (mod as unknown as MermaidApi))
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Dashboard is dark-navy; mermaid's `dark` theme reads well on it.
      theme: 'dark',
      // Belt-and-braces: keep HTML labels off everywhere so no `<foreignObject>`
      // HTML is ever generated from model-controlled label text.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    })
    initialized = true
  }
  return mermaid
}

type RenderState =
  | { status: 'loading' }
  | { status: 'rendered'; svg: string }
  | { status: 'error'; message: string }

export function MermaidDiagram({ source }: { source: string }) {
  const [state, setState] = useState<RenderState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        const id = `chroxy-mermaid-${++idCounter}`
        const { svg } = await mermaid.render(id, source)
        if (cancelled) return
        // Defense in depth: mermaid strict already sanitizes, but re-run
        // DOMPurify (its default profile keeps SVG + <style> while stripping
        // <script>/`on*` handlers) before we inject the markup.
        const clean = DOMPurify.sanitize(svg)
        setState({ status: 'rendered', svg: clean })
      } catch (err) {
        if (cancelled) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  if (state.status === 'rendered') {
    return (
      <div
        className="mermaid-diagram"
        data-testid="mermaid-diagram"
        // Sanitized (mermaid strict + DOMPurify) SVG string — see above.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="mermaid-loading" data-testid="mermaid-loading">
        Rendering diagram…
      </div>
    )
  }

  // Error → the exact code-block render the normal pipeline would have produced
  // (so it looks like any other fenced block, copy button included), with the
  // parse error above it. Reconstruct the fence from the inner source.
  const fallbackHtml = renderMarkdown('```mermaid\n' + source + '```')
  return (
    <div className="mermaid-error" data-testid="mermaid-fallback">
      <div className="mermaid-error-note" data-testid="mermaid-error">
        Diagram failed to render: {state.message}
      </div>
      <div dangerouslySetInnerHTML={{ __html: fallbackHtml }} />
    </div>
  )
}
