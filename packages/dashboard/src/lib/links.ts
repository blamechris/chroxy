/**
 * #6625 — modifier-click a rendered link to open it in the user's default
 * browser (Cmd on macOS, Ctrl on Windows/Linux), while a plain click leaves the
 * chat text selectable. Rendered markdown links are real `<a target="_blank">`
 * anchors (see lib/markdown.ts); this gates their navigation so a plain
 * click/drag can select the surrounding text instead of navigating away.
 *
 * Keyboard activation is preserved: pressing Enter on a focused link dispatches
 * a synthesized click with `detail === 0`, which we treat as an open (so the
 * link stays operable by keyboard — WCAG 2.1.1). Only a plain MOUSE click
 * (detail ≥ 1, no modifier) is suppressed.
 *
 * Safety: only `http:`/`https:` schemes open — the markdown renderer already
 * strips `javascript:`/`data:`/`vbscript:`, and this is a second gate at the
 * click boundary so a crafted href can't open a dangerous scheme.
 */

const OPENABLE_SCHEME = /^https?:\/\//i

/** Activation state read off a click event (test-friendly subset). */
export interface LinkActivation {
  metaKey?: boolean
  ctrlKey?: boolean
  /** `UIEvent.detail` — 0 for a keyboard-synthesized click (Enter), ≥1 for mouse. */
  detail?: number
}

/**
 * The URL to open for this activation, or `null` when it should NOT open (a
 * plain mouse click, or an unsafe/relative scheme). Opens on a modifier-click
 * OR a keyboard activation (Enter). Pure — no DOM.
 *
 * NOTE: `href` must be the RAW attribute value (not a resolved `.href` DOM
 * property) — resolving would turn `//evil.com` or `/rel` into an absolute URL
 * that passes the http(s) gate. Callers use `getAttribute('href')`.
 */
export function resolveLinkOpen(href: string | null | undefined, act: LinkActivation): string | null {
  if (!href) return null
  const activate = act.metaKey || act.ctrlKey || act.detail === 0
  if (!activate) return null
  const url = href.trim()
  return OPENABLE_SCHEME.test(url) ? url : null
}

/** Minimal shape of the click event fields this handler reads (test-friendly). */
export interface LinkClickEvent extends LinkActivation {
  target: EventTarget | null
  preventDefault: () => void
}

/**
 * `onClick` handler for a container of rendered markdown. A modifier-click (or
 * keyboard Enter) on an `<a>` opens its (http/https) href in the browser; a
 * plain mouse click on an `<a>` is suppressed so it does not navigate away,
 * keeping the text selectable. A click that isn't on a link is left untouched.
 *
 * `open` is injectable so the behavior is unit-testable without a real
 * `window.open`; it defaults to a `noopener,noreferrer` new-tab open.
 */
export function handleMarkdownLinkClick(
  e: LinkClickEvent,
  open: (url: string) => void = (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
): void {
  const el = e.target as HTMLElement | null
  const anchor = el && typeof el.closest === 'function' ? el.closest('a[href]') : null
  if (!anchor) return // click wasn't on a link — leave selection/other handlers alone
  const url = resolveLinkOpen(anchor.getAttribute('href'), e)
  if (url) {
    e.preventDefault()
    open(url)
    return
  }
  // Plain mouse click (or an unsafe scheme) ON a link: suppress the native
  // `target="_blank"` navigation so a click/drag selects text instead.
  e.preventDefault()
}
