/**
 * #6625 — modifier-click a rendered link to open it in the user's default
 * browser (Cmd on macOS, Ctrl on Windows/Linux), while a plain click leaves the
 * chat text selectable. Rendered markdown links are real `<a target="_blank">`
 * anchors (see lib/markdown.ts); this gates their navigation on a modifier so a
 * plain click/drag can select the surrounding text instead of navigating away.
 *
 * Safety: only `http:`/`https:` schemes open — the markdown renderer already
 * strips `javascript:`/`data:`/`vbscript:`, and this is a second gate at the
 * click boundary so a crafted href can't open a dangerous scheme.
 */

const OPENABLE_SCHEME = /^https?:\/\//i

/**
 * The URL to open for a modifier-click, or `null` when it should NOT open
 * (plain click, or an unsafe/relative scheme). Pure — no DOM.
 */
export function resolveModifierLinkOpen(
  href: string | null | undefined,
  mods: { metaKey?: boolean; ctrlKey?: boolean },
): string | null {
  if (!href) return null
  if (!(mods.metaKey || mods.ctrlKey)) return null
  const url = href.trim()
  return OPENABLE_SCHEME.test(url) ? url : null
}

/** Minimal shape of the click event fields this handler reads (test-friendly). */
export interface LinkClickEvent {
  target: EventTarget | null
  metaKey: boolean
  ctrlKey: boolean
  preventDefault: () => void
}

/**
 * `onClick` handler for a container of rendered markdown. A modifier-click on an
 * `<a>` opens its (http/https) href in the browser; a plain click on an `<a>` is
 * suppressed so it does not navigate away, keeping the text selectable. A click
 * that isn't on a link is left completely untouched.
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
  const url = resolveModifierLinkOpen(anchor.getAttribute('href'), e)
  if (url) {
    e.preventDefault()
    open(url)
    return
  }
  // Plain click (or an unsafe scheme) ON a link: suppress the native
  // `target="_blank"` navigation so a click/drag selects text instead.
  e.preventDefault()
}
