import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGlobalShortcuts, type ShortcutMap } from './useGlobalShortcuts'

afterEach(() => {
  vi.restoreAllMocks()
})

function fireKeyDown(key: string, opts: Partial<KeyboardEvent> = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  })
  document.dispatchEvent(event)
  return event
}

describe('useGlobalShortcuts', () => {
  it('fires handler for matching shortcut', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+shift+p': handler,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))
    fireKeyDown('p', { metaKey: true, shiftKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not fire when modifier keys do not match', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+shift+p': handler,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))
    // Missing shiftKey
    fireKeyDown('p', { metaKey: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('supports ctrl as alternative to cmd', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+n': handler,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))
    fireKeyDown('n', { ctrlKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not fire when focus is in an input element', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+n': handler,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const event = new KeyboardEvent('keydown', {
      key: 'n',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)

    expect(handler).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('does not fire when focus is in a textarea', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+n': handler,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()

    const event = new KeyboardEvent('keydown', {
      key: 'n',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    textarea.dispatchEvent(event)

    expect(handler).not.toHaveBeenCalled()
    document.body.removeChild(textarea)
  })

  it('handles multiple shortcuts', () => {
    const handlerA = vi.fn()
    const handlerB = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+n': handlerA,
      'cmd+shift+d': handlerB,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))
    fireKeyDown('n', { metaKey: true })
    fireKeyDown('d', { metaKey: true, shiftKey: true })
    expect(handlerA).toHaveBeenCalledOnce()
    expect(handlerB).toHaveBeenCalledOnce()
  })

  it('cleans up listener on unmount', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+n': handler,
    }
    const { unmount } = renderHook(() => useGlobalShortcuts(shortcuts))
    unmount()
    fireKeyDown('n', { metaKey: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('normalizes key to lowercase', () => {
    const handler = vi.fn()
    const shortcuts: ShortcutMap = {
      'cmd+shift+p': handler,
    }
    renderHook(() => useGlobalShortcuts(shortcuts))
    fireKeyDown('P', { metaKey: true, shiftKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })
})
