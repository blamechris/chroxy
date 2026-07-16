import { describe, it, expect, vi } from 'vitest'
import { resolveModifierLinkOpen, handleMarkdownLinkClick } from './links'

describe('resolveModifierLinkOpen (#6625)', () => {
  it('returns the URL for a modifier-click on an http(s) link', () => {
    expect(resolveModifierLinkOpen('https://example.com', { metaKey: true })).toBe('https://example.com')
    expect(resolveModifierLinkOpen('http://example.com/x', { ctrlKey: true })).toBe('http://example.com/x')
  })

  it('returns null for a plain click (no modifier)', () => {
    expect(resolveModifierLinkOpen('https://example.com', {})).toBeNull()
    expect(resolveModifierLinkOpen('https://example.com', { metaKey: false, ctrlKey: false })).toBeNull()
  })

  it('returns null for an unsafe / non-http scheme even with a modifier held', () => {
    expect(resolveModifierLinkOpen('javascript:alert(1)', { metaKey: true })).toBeNull()
    expect(resolveModifierLinkOpen('data:text/html,x', { ctrlKey: true })).toBeNull()
    expect(resolveModifierLinkOpen('mailto:a@b.com', { metaKey: true })).toBeNull()
    expect(resolveModifierLinkOpen('/relative/path', { metaKey: true })).toBeNull()
  })

  it('returns null for a missing/blank href', () => {
    expect(resolveModifierLinkOpen(null, { metaKey: true })).toBeNull()
    expect(resolveModifierLinkOpen(undefined, { metaKey: true })).toBeNull()
    expect(resolveModifierLinkOpen('   ', { metaKey: true })).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(resolveModifierLinkOpen('  https://example.com  ', { metaKey: true })).toBe('https://example.com')
  })
})

describe('handleMarkdownLinkClick (#6625)', () => {
  function anchor(href: string): HTMLAnchorElement {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    a.textContent = 'link'
    return a
  }

  it('opens an http(s) link on a modifier-click and suppresses navigation', () => {
    const a = anchor('https://example.com')
    const open = vi.fn()
    const preventDefault = vi.fn()
    handleMarkdownLinkClick({ target: a, metaKey: true, ctrlKey: false, preventDefault }, open)
    expect(open).toHaveBeenCalledWith('https://example.com')
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('resolves the anchor when the click lands on a child of the link', () => {
    const a = anchor('https://example.com')
    const span = document.createElement('span')
    a.appendChild(span)
    const open = vi.fn()
    handleMarkdownLinkClick({ target: span, metaKey: true, ctrlKey: false, preventDefault: vi.fn() }, open)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })

  it('does NOT open on a plain click, but suppresses navigation (keeps selection)', () => {
    const a = anchor('https://example.com')
    const open = vi.fn()
    const preventDefault = vi.fn()
    handleMarkdownLinkClick({ target: a, metaKey: false, ctrlKey: false, preventDefault }, open)
    expect(open).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledOnce() // native target=_blank open is suppressed
  })

  it('does NOT open an unsafe scheme even with a modifier, and suppresses navigation', () => {
    const a = anchor('javascript:alert(1)')
    const open = vi.fn()
    const preventDefault = vi.fn()
    handleMarkdownLinkClick({ target: a, metaKey: true, ctrlKey: false, preventDefault }, open)
    expect(open).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('leaves a non-link click completely untouched (no preventDefault, no open)', () => {
    const div = document.createElement('div')
    div.textContent = 'plain text'
    const open = vi.fn()
    const preventDefault = vi.fn()
    handleMarkdownLinkClick({ target: div, metaKey: true, ctrlKey: false, preventDefault }, open)
    expect(open).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
