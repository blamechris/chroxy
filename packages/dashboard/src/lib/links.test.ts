import { describe, it, expect, vi } from 'vitest'
import { resolveLinkOpen, handleMarkdownLinkClick } from './links'

describe('resolveLinkOpen (#6625)', () => {
  it('returns the URL for a modifier-click on an http(s) link', () => {
    expect(resolveLinkOpen('https://example.com', { metaKey: true })).toBe('https://example.com')
    expect(resolveLinkOpen('http://example.com/x', { ctrlKey: true })).toBe('http://example.com/x')
  })

  it('opens on keyboard activation (Enter → synthesized click, detail 0) with no modifier', () => {
    expect(resolveLinkOpen('https://example.com', { detail: 0 })).toBe('https://example.com')
  })

  it('returns null for a plain MOUSE click (detail ≥ 1, no modifier)', () => {
    expect(resolveLinkOpen('https://example.com', { detail: 1 })).toBeNull()
    expect(resolveLinkOpen('https://example.com', {})).toBeNull()
    expect(resolveLinkOpen('https://example.com', { metaKey: false, ctrlKey: false, detail: 1 })).toBeNull()
  })

  it('is case-insensitive on the scheme', () => {
    expect(resolveLinkOpen('HTTPS://Example.com', { metaKey: true })).toBe('HTTPS://Example.com')
  })

  it('returns null for an unsafe / non-http scheme even with a modifier or keyboard', () => {
    expect(resolveLinkOpen('javascript:alert(1)', { metaKey: true })).toBeNull()
    expect(resolveLinkOpen('javascript:alert(1)//x', { metaKey: true })).toBeNull()
    expect(resolveLinkOpen('data:text/html,x', { ctrlKey: true })).toBeNull()
    expect(resolveLinkOpen('mailto:a@b.com', { metaKey: true })).toBeNull()
    expect(resolveLinkOpen('http:/single-slash', { detail: 0 })).toBeNull()
  })

  it('returns null for relative / protocol-relative hrefs (raw attribute, not resolved)', () => {
    expect(resolveLinkOpen('/relative/path', { metaKey: true })).toBeNull()
    expect(resolveLinkOpen('//evil.com', { metaKey: true })).toBeNull()
    expect(resolveLinkOpen('#anchor', { metaKey: true })).toBeNull()
  })

  it('returns null for a missing/blank href', () => {
    expect(resolveLinkOpen(null, { metaKey: true })).toBeNull()
    expect(resolveLinkOpen(undefined, { metaKey: true })).toBeNull()
    expect(resolveLinkOpen('   ', { metaKey: true })).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(resolveLinkOpen('  https://example.com  ', { metaKey: true })).toBe('https://example.com')
  })
})

describe('handleMarkdownLinkClick (#6625)', () => {
  function anchor(href: string): HTMLAnchorElement {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    a.textContent = 'link'
    return a
  }
  const mouse = (over: Partial<{ target: EventTarget; metaKey: boolean; ctrlKey: boolean }>) => ({
    target: null,
    metaKey: false,
    ctrlKey: false,
    detail: 1, // a real mouse click
    preventDefault: vi.fn(),
    ...over,
  })

  it('opens an http(s) link on a Cmd(meta)-click and suppresses navigation', () => {
    const e = { ...mouse({ target: anchor('https://example.com'), metaKey: true }) }
    const open = vi.fn()
    handleMarkdownLinkClick(e, open)
    expect(open).toHaveBeenCalledWith('https://example.com')
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it('opens on a Ctrl-click (Windows/Linux modifier)', () => {
    const open = vi.fn()
    handleMarkdownLinkClick(mouse({ target: anchor('https://example.com'), ctrlKey: true }), open)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })

  it('opens on keyboard activation (detail 0) even without a modifier', () => {
    const open = vi.fn()
    handleMarkdownLinkClick({ target: anchor('https://example.com'), metaKey: false, ctrlKey: false, detail: 0, preventDefault: vi.fn() }, open)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })

  it('resolves the anchor when the click lands on a child of the link', () => {
    const a = anchor('https://example.com')
    const span = document.createElement('span')
    a.appendChild(span)
    const open = vi.fn()
    handleMarkdownLinkClick(mouse({ target: span, metaKey: true }), open)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })

  it('does NOT open on a plain mouse click, but suppresses navigation (keeps selection)', () => {
    const e = mouse({ target: anchor('https://example.com') })
    const open = vi.fn()
    handleMarkdownLinkClick(e, open)
    expect(open).not.toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it('does NOT open an unsafe scheme even with a modifier, and suppresses navigation', () => {
    const e = mouse({ target: anchor('javascript:alert(1)'), metaKey: true })
    const open = vi.fn()
    handleMarkdownLinkClick(e, open)
    expect(open).not.toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it('reads the RAW href attribute — a relative href does NOT open (no origin resolution)', () => {
    const e = mouse({ target: anchor('/relative/path'), metaKey: true })
    const open = vi.fn()
    handleMarkdownLinkClick(e, open)
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves a non-link click completely untouched (no preventDefault, no open)', () => {
    const div = document.createElement('div')
    div.textContent = 'plain text'
    const e = mouse({ target: div, metaKey: true })
    const open = vi.fn()
    handleMarkdownLinkClick(e, open)
    expect(open).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
