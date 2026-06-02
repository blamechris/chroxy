/**
 * Tests for `useDebouncedSetter` (#4739).
 *
 * Extracted from the duplicated debounce + dirty-flag + parked-snapshot
 * conflict pattern that grew up between the per-session preamble editor
 * (#4660 / #4662 / #4738) and QuietHoursEditor (#4570). The hook must
 * preserve byte-identical behaviour for both call sites:
 *
 *   - debounce setter on every setDraft (when `debounceMs > 0`)
 *   - dirty flag tracking with a ref mirror so the hydration effect can
 *     read the current dirty state without re-running when it flips
 *   - parked-snapshot conflict UX (dirty + divergent snapshot)
 *   - cancel on unmount
 *   - cancel on scopeKey change AND re-hydrate to the new snapshot
 *   - own-echo: snapshot that matches the draft clears dirty silently
 *   - clean-apply: snapshot lands on a non-dirty editor → replaces draft
 *   - manual mode (debounceMs = 0) — `setDraft` updates local state only;
 *     `flush()` fires the setter explicitly (QuietHoursEditor Save button)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedSetter } from './useDebouncedSetter'

describe('useDebouncedSetter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('debounced mode (debounceMs > 0)', () => {
    it('fires onFlush after debounceMs with the latest value', () => {
      const onFlush = vi.fn()
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 400,
          onFlush,
        })
      )
      act(() => result.current.setDraft('hello'))
      expect(onFlush).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(399) })
      expect(onFlush).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(2) })
      expect(onFlush).toHaveBeenCalledTimes(1)
      expect(onFlush).toHaveBeenCalledWith('hello')
    })

    it('coalesces rapid setDraft calls into a single flush with the latest value', () => {
      const onFlush = vi.fn()
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 400,
          onFlush,
        })
      )
      act(() => result.current.setDraft('h'))
      act(() => { vi.advanceTimersByTime(100) })
      act(() => result.current.setDraft('he'))
      act(() => { vi.advanceTimersByTime(100) })
      act(() => result.current.setDraft('hello'))
      act(() => { vi.advanceTimersByTime(401) })
      expect(onFlush).toHaveBeenCalledTimes(1)
      expect(onFlush).toHaveBeenCalledWith('hello')
    })

    it('marks the editor dirty as soon as setDraft is called', () => {
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 400,
          onFlush: vi.fn(),
        })
      )
      expect(result.current.dirty).toBe(false)
      act(() => result.current.setDraft('typing'))
      expect(result.current.dirty).toBe(true)
    })

    it('clears dirty after the debounce fires', () => {
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 400,
          onFlush: vi.fn(),
        })
      )
      act(() => result.current.setDraft('typing'))
      expect(result.current.dirty).toBe(true)
      act(() => { vi.advanceTimersByTime(401) })
      expect(result.current.dirty).toBe(false)
    })

    it('cancels pending debounce on unmount', () => {
      const onFlush = vi.fn()
      const { result, unmount } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 400,
          onFlush,
        })
      )
      act(() => result.current.setDraft('half-typed'))
      unmount()
      act(() => { vi.advanceTimersByTime(500) })
      expect(onFlush).not.toHaveBeenCalled()
    })

    it('cancels pending debounce when scopeKey changes', () => {
      const onFlush = vi.fn()
      const { result, rerender } = renderHook(
        ({ scopeKey, serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey,
            debounceMs: 400,
            onFlush,
          }),
        { initialProps: { scopeKey: 'sess-A', serverValue: '' } }
      )
      act(() => result.current.setDraft('A draft'))
      act(() => { vi.advanceTimersByTime(100) })
      // Switch scope mid-debounce.
      rerender({ scopeKey: 'sess-B', serverValue: '' })
      act(() => { vi.advanceTimersByTime(500) })
      expect(onFlush).not.toHaveBeenCalled()
    })

    it('re-hydrates draft to new snapshot when scopeKey changes', () => {
      const { result, rerender } = renderHook(
        ({ scopeKey, serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey,
            debounceMs: 400,
            onFlush: vi.fn(),
          }),
        { initialProps: { scopeKey: 'sess-A', serverValue: 'A value' } }
      )
      expect(result.current.draft).toBe('A value')
      act(() => result.current.setDraft('A draft'))
      rerender({ scopeKey: 'sess-B', serverValue: 'B value' })
      expect(result.current.draft).toBe('B value')
      expect(result.current.dirty).toBe(false)
    })
  })

  describe('conflict UX', () => {
    it('parks a divergent snapshot when editor is dirty', () => {
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 400,
            onFlush: vi.fn(),
          }),
        { initialProps: { serverValue: 'original' } }
      )
      act(() => result.current.setDraft('my local draft'))
      // Divergent snapshot arrives mid-edit.
      rerender({ serverValue: 'other client value' })
      expect(result.current.conflict).toBe('other client value')
      // Draft is preserved.
      expect(result.current.draft).toBe('my local draft')
    })

    it('does NOT park snapshot when it matches the draft (own echo)', () => {
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 400,
            onFlush: vi.fn(),
          }),
        { initialProps: { serverValue: '' } }
      )
      act(() => result.current.setDraft('echo me'))
      // Server echoes the same value back.
      rerender({ serverValue: 'echo me' })
      expect(result.current.conflict).toBeUndefined()
      expect(result.current.draft).toBe('echo me')
      expect(result.current.dirty).toBe(false)
    })

    it('accepts snapshot updates normally when the editor is clean', () => {
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 400,
            onFlush: vi.fn(),
          }),
        { initialProps: { serverValue: 'initial' } }
      )
      // No edits — fresh snapshot replaces draft.
      rerender({ serverValue: 'from server' })
      expect(result.current.draft).toBe('from server')
      expect(result.current.conflict).toBeUndefined()
    })

    it('acceptDraft clears the conflict banner but keeps the local draft', () => {
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 400,
            onFlush: vi.fn(),
          }),
        { initialProps: { serverValue: 'original' } }
      )
      act(() => result.current.setDraft('my draft'))
      rerender({ serverValue: 'other client' })
      expect(result.current.conflict).toBe('other client')
      act(() => result.current.acceptDraft())
      expect(result.current.conflict).toBeUndefined()
      expect(result.current.draft).toBe('my draft')
    })

    it('discardDraft replaces draft with parked snapshot and clears banner', () => {
      const onFlush = vi.fn()
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<string>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 400,
            onFlush,
          }),
        { initialProps: { serverValue: 'original' } }
      )
      act(() => result.current.setDraft('my draft'))
      rerender({ serverValue: 'other client' })
      act(() => result.current.discardDraft())
      expect(result.current.draft).toBe('other client')
      expect(result.current.conflict).toBeUndefined()
      expect(result.current.dirty).toBe(false)
      // Discard should NOT trigger a flush of the parked snapshot —
      // accepting the server value is not a user edit.
      act(() => { vi.advanceTimersByTime(500) })
      expect(onFlush).not.toHaveBeenCalled()
    })

    it('discardDraft is a no-op when there is no parked snapshot', () => {
      const onFlush = vi.fn()
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: 'original',
          scopeKey: 'sess-1',
          debounceMs: 400,
          onFlush,
        })
      )
      act(() => result.current.discardDraft())
      expect(result.current.draft).toBe('original')
      expect(result.current.conflict).toBeUndefined()
    })

    it('preserves draft on own-echo when asymmetric equals deems server matches (fields ignored)', () => {
      // Mirrors QuietHoursEditor's `draftEquals`: a server snapshot with
      // `enabled=false` matches a draft with `enabled=false` regardless
      // of the start/end/timezone fields. Those draft fields must
      // survive the own-echo so re-enabling doesn't blank them.
      type Draft = { enabled: boolean; start: string; end: string }
      const equals = (server: Draft, draft: Draft) => {
        if (!server.enabled) return !draft.enabled
        return draft.enabled && server.start === draft.start && server.end === draft.end
      }
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<Draft>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 0,
            onFlush: vi.fn(),
            equals,
          }),
        { initialProps: { serverValue: { enabled: true, start: '22:00', end: '07:00' } } }
      )
      // User customises the fields then disables.
      act(() => result.current.setDraft({ enabled: true, start: '23:30', end: '08:00' }))
      act(() => result.current.setDraft({ enabled: false, start: '23:30', end: '08:00' }))
      // Server echoes back the disabled state (default seed fields).
      rerender({ serverValue: { enabled: false, start: '22:00', end: '07:00' } })
      // Draft fields preserved — NOT clobbered to the server defaults.
      expect(result.current.draft).toEqual({ enabled: false, start: '23:30', end: '08:00' })
      expect(result.current.dirty).toBe(false)
      expect(result.current.conflict).toBeUndefined()
    })

    it('custom equals controls own-echo detection for object payloads', () => {
      type Window = { start: string; end: string }
      const equals = (a: Window, b: Window) => a.start === b.start && a.end === b.end
      const { result, rerender } = renderHook(
        ({ serverValue }) =>
          useDebouncedSetter<Window>({
            serverValue,
            scopeKey: 'sess-1',
            debounceMs: 400,
            onFlush: vi.fn(),
            equals,
          }),
        { initialProps: { serverValue: { start: '22:00', end: '07:00' } } }
      )
      act(() => result.current.setDraft({ start: '23:00', end: '08:00' }))
      // Server echo — different object identity, same values.
      rerender({ serverValue: { start: '23:00', end: '08:00' } })
      expect(result.current.conflict).toBeUndefined()
      expect(result.current.dirty).toBe(false)
    })
  })

  describe('manual mode (debounceMs = 0)', () => {
    it('setDraft updates local state without firing onFlush', () => {
      const onFlush = vi.fn()
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 0,
          onFlush,
        })
      )
      act(() => result.current.setDraft('typed'))
      expect(result.current.draft).toBe('typed')
      expect(result.current.dirty).toBe(true)
      act(() => { vi.advanceTimersByTime(10000) })
      expect(onFlush).not.toHaveBeenCalled()
    })

    it('flush() fires onFlush with current draft and clears dirty', () => {
      const onFlush = vi.fn()
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          debounceMs: 0,
          onFlush,
        })
      )
      act(() => result.current.setDraft('save this'))
      act(() => result.current.flush())
      expect(onFlush).toHaveBeenCalledTimes(1)
      expect(onFlush).toHaveBeenCalledWith('save this')
      expect(result.current.dirty).toBe(false)
    })
  })

  describe('default debounceMs', () => {
    it('defaults to 400ms when omitted', () => {
      const onFlush = vi.fn()
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: 'sess-1',
          onFlush,
        })
      )
      act(() => result.current.setDraft('hello'))
      act(() => { vi.advanceTimersByTime(399) })
      expect(onFlush).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(2) })
      expect(onFlush).toHaveBeenCalledWith('hello')
    })
  })

  describe('null scopeKey', () => {
    it('still tracks draft + dirty when scopeKey is null', () => {
      const { result } = renderHook(() =>
        useDebouncedSetter<string>({
          serverValue: '',
          scopeKey: null,
          debounceMs: 400,
          onFlush: vi.fn(),
        })
      )
      act(() => result.current.setDraft('x'))
      expect(result.current.dirty).toBe(true)
      expect(result.current.draft).toBe('x')
    })
  })
})
