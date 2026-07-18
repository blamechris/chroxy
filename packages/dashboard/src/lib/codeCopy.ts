import { writeText as defaultWriteText } from '../utils/clipboard'
import { useConnectionStore } from '../store/connection'
import { handleMarkdownLinkClick, type LinkClickEvent } from './links'

/**
 * #6793 — per-fenced-code-block copy button.
 *
 * `renderMarkdown` (lib/markdown.ts) wraps every fenced code block in a
 * `.code-block` container carrying a `.code-copy-btn` button, but that
 * markup is a plain HTML string rendered via `dangerouslySetInnerHTML` — the
 * button can't carry a React `onClick`, and it must NOT carry an inline
 * `onclick="…"` attribute (this repo's dashboard CSP is `script-src 'self'`
 * with no `'unsafe-inline'`, and DOMPurify strips `on*` attributes anyway).
 * Instead, this is a single delegated `onClick` on the markdown container —
 * the same pattern #6625's `handleMarkdownLinkClick` (lib/links.ts) already
 * established for link clicks inside the same `dangerouslySetInnerHTML`
 * body. ChatView.tsx wires both handlers into one `onClick`.
 */

const COPIED_LABEL = 'Copied'
const COPIED_GLYPH = '✓'
const DEFAULT_LABEL = 'Copy code'
const DEFAULT_GLYPH = '⧉'
const COPIED_RESET_MS = 1500

export const CODE_COPY_BTN_CLASS = 'code-copy-btn'
export const CODE_BLOCK_CLASS = 'code-block'

/** Minimal click-event shape this handler reads (test-friendly subset, mirrors LinkClickEvent). */
export interface CodeCopyClickEvent {
  target: EventTarget | null
  stopPropagation: () => void
}

// Pending "copied ✓" reset timers, keyed by the button element so a rapid
// re-click resets cleanly (clears the old timer) instead of two timers
// racing to reset the glyph — mirrors CopyButton's per-click timer reset
// (#6631), just done imperatively since these buttons aren't React state.
const resetTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

function showCopied(button: HTMLElement): void {
  const pending = resetTimers.get(button)
  if (pending) clearTimeout(pending)
  button.textContent = COPIED_GLYPH
  button.setAttribute('aria-label', COPIED_LABEL)
  button.setAttribute('title', COPIED_LABEL)
  button.setAttribute('data-copied', 'true')
  const timer = setTimeout(() => {
    resetTimers.delete(button)
    button.textContent = DEFAULT_GLYPH
    button.setAttribute('aria-label', DEFAULT_LABEL)
    button.setAttribute('title', DEFAULT_LABEL)
    button.removeAttribute('data-copied')
  }, COPIED_RESET_MS)
  resetTimers.set(button, timer)
}

/**
 * `onClick` handler for a container of rendered markdown. A click on a
 * `.code-copy-btn` copies its fenced code block's text to the clipboard and
 * flashes a transient ✓ confirmation directly on the button.
 *
 * The copied text is read from the rendered `<code>` element's
 * `textContent` at click time — NOT a `data-*` attribute stashed on the
 * button. See the comment in `lib/markdown.ts` for why: DOMPurify's
 * SAFE_FOR_XML guard silently strips an ENTIRE attribute whose value
 * contains a `</script>`-shaped substring or a `-->`/`]>` comment closer,
 * which real code snippets can easily contain. `textContent` has no such
 * failure mode and always reconstructs the exact fenced source, since
 * `renderMarkdown` only ever wraps/escapes each character — never drops or
 * reorders it.
 *
 * Returns `true` when the click was on a copy button (handled), so a caller
 * chaining this with `handleMarkdownLinkClick` in the same `onClick` can
 * short-circuit and skip the link-click logic for the same event.
 */
export function handleCodeCopyClick(
  e: CodeCopyClickEvent,
  writeText: (text: string) => Promise<boolean> = defaultWriteText,
): boolean {
  const node = e.target
  const el = node instanceof Element ? node : (node as { parentElement?: Element | null } | null)?.parentElement ?? null
  const button = el && typeof el.closest === 'function' ? (el.closest(`.${CODE_COPY_BTN_CLASS}`) as HTMLElement | null) : null
  if (!button) return false // click wasn't on a copy button — leave other handlers alone
  e.stopPropagation()
  const block = button.closest(`.${CODE_BLOCK_CLASS}`)
  const codeEl = block?.querySelector('pre code')
  const text = codeEl?.textContent ?? ''
  if (!text) return true // nothing to copy (shouldn't happen — button only renders alongside a block)
  void writeText(text).then((ok) => {
    if (!ok) {
      useConnectionStore.getState().addServerError('Failed to copy code to clipboard. Please try again.', undefined, 'warning')
      return
    }
    showCopied(button)
  })
  return true
}

/** Combined click-event shape needed by both delegated handlers below. */
export type MarkdownBodyClickEvent = CodeCopyClickEvent & LinkClickEvent

/**
 * Single delegated `onClick` for any `dangerouslySetInnerHTML` markdown body
 * (ChatView.tsx's response/tool_use rows, OrchestrationRunsSection.tsx's run
 * reports — anywhere `renderMarkdown`'s output is mounted). Tries the
 * per-fenced-code-block copy button first (#6793) — a handled click
 * short-circuits before reaching the link handler — then falls through to
 * the #6625 `handleMarkdownLinkClick`, so both behaviors share one container
 * without stepping on each other.
 */
export function handleMarkdownBodyClick(e: MarkdownBodyClickEvent): void {
  if (handleCodeCopyClick(e)) return
  handleMarkdownLinkClick(e)
}
