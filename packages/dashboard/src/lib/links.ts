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

/**
 * Schemes safe to emit as a real `<a href>` in rendered markdown / chat
 * content (#6986). ALLOWLIST — `http:`, `https:`, `mailto:` only. Everything
 * else renders as plain text, never a clickable anchor:
 *   - dangerous schemes (`javascript:` / `data:` / `vbscript:`),
 *   - protocol-relative `//host` — the link-injection vector,
 *   - same-origin relative paths (`/foo`) and `#fragment` anchors.
 *
 * Why an allowlist, and why render-time: the previous markdown link check was
 * a BLOCKLIST (`javascript|data|vbscript`). DOMPurify treats a bare `//host`
 * href as a "safe relative URL" and KEEPS it, so a WebFetch of an
 * attacker-controlled page (its fetched content is rendered through the same
 * `renderMarkdown` pipeline) could smuggle a working `[text](//evil.example)`
 * link past both the blocklist and DOMPurify. The click-time JS gate
 * ({@link resolveLinkOpen}) suppresses a plain left-click, but middle-click
 * (`auxclick`) and the browser's native right-click "Open Link in New Tab"
 * read the raw DOM href and open it anyway — so the ONLY reliable place to
 * neutralize it is to never emit the anchor at all, here at render time.
 *
 * A SUPERSET of {@link OPENABLE_SCHEME} (the open gate): `mailto:` is safe to
 * render as an anchor (it hands off to the user's mail client, not a web
 * origin) but is deliberately NOT window.open-ed, so it's absent from the open
 * gate. Kept separate from store-core's `isSafeWebUrl` (http/https-only —
 * that gate decides which WebSearch/WebFetch RESULT urls to keep, where a
 * `mailto:` result would be meaningless).
 */
const RENDERABLE_LINK_SCHEME = /^(?:https?|mailto):/i

/**
 * True when `href` is safe to emit as a real `<a href>` in rendered markdown.
 * Trims first (browsers ignore leading/trailing whitespace in an href, so a
 * ` javascript:` with a leading space must not sneak past). Pure — no DOM.
 * The markdown renderer routes its `[text](url)` check through this so the
 * render gate and the click gate agree on scheme safety.
 */
export function isRenderableLinkHref(href: string | null | undefined): boolean {
  if (typeof href !== 'string') return false
  return RENDERABLE_LINK_SCHEME.test(href.trim())
}

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
  // A click target is normally the deepest Element, but resolve a Text node to
  // its parent (defensive) so `closest` can still reach the anchor and the
  // native `target="_blank"` navigation stays gated.
  const node = e.target
  const el = node instanceof Element ? node : (node as { parentElement?: Element | null } | null)?.parentElement ?? null
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
