/**
 * Tests for useVoiceInput — covers three engine selection paths:
 *
 *   1. Native (Tauri) path — `__TAURI_INTERNALS__.invoke` + `voice_available`
 *      returns true. Web Speech API is ignored even if present (#4350: native wins).
 *   2. Web Speech API fallback — no Tauri or `voice_available` returns false,
 *      but `window.SpeechRecognition` / `webkitSpeechRecognition` is defined.
 *   3. Neither — `isAvailable` resolves to false; start() is a no-op.
 *
 * Also covers mid-recording NotAllowedError surfacing for the web path
 * (#4350: permissions UX requirement).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useVoiceInput } from './useVoiceInput'

// ---------- Tauri mock plumbing (shared with useTauriEvents.test.ts shape) ----------

type Handler = (event: { payload: unknown }) => void
let listeners: Map<string, Handler[]>
let unlisten: ReturnType<typeof vi.fn>
let mockInvoke: ReturnType<typeof vi.fn>

function setupTauriMock(opts: { voiceAvailable: boolean }) {
  listeners = new Map()
  unlisten = vi.fn()

  mockInvoke = vi.fn(async (cmd: string) => {
    if (cmd === 'voice_available') return opts.voiceAvailable
    if (cmd === 'start_voice_input') return undefined
    if (cmd === 'stop_voice_input') return undefined
    return undefined
  })

  const mockListen = vi.fn(async (event: string, handler: Handler) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event)!.push(handler)
    return unlisten
  })

  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(window, '__TAURI__', {
    value: { event: { listen: mockListen } },
    writable: true,
    configurable: true,
  })
}

function clearTauriMock() {
  delete (window as unknown as Record<string, unknown>).__TAURI__
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

function emit(event: string, payload?: unknown) {
  const handlers = listeners?.get(event) || []
  handlers.forEach(h => h({ payload }))
}

// ---------- Web Speech API mock ----------

interface MockRecognitionInstance {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[]; resultIndex: number }) => void) | null
  onerror: ((e: { error: string; message?: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

let lastRecognition: MockRecognitionInstance | null = null

function installWebSpeechMock() {
  function MockRecognition(this: MockRecognitionInstance) {
    this.continuous = false
    this.interimResults = false
    this.lang = ''
    this.start = vi.fn()
    this.stop = vi.fn()
    this.abort = vi.fn()
    this.onresult = null
    this.onerror = null
    this.onend = null
    this.onstart = null
    lastRecognition = this
  }
  Object.defineProperty(window, 'SpeechRecognition', {
    value: MockRecognition,
    writable: true,
    configurable: true,
  })
}

function installWebkitSpeechMock() {
  function MockRecognition(this: MockRecognitionInstance) {
    this.continuous = false
    this.interimResults = false
    this.lang = ''
    this.start = vi.fn()
    this.stop = vi.fn()
    this.abort = vi.fn()
    this.onresult = null
    this.onerror = null
    this.onend = null
    this.onstart = null
    lastRecognition = this
  }
  Object.defineProperty(window, 'webkitSpeechRecognition', {
    value: MockRecognition,
    writable: true,
    configurable: true,
  })
}

function clearWebSpeechMock() {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  lastRecognition = null
}

// ---------- Tests ----------

describe('useVoiceInput', () => {
  beforeEach(() => {
    clearTauriMock()
    clearWebSpeechMock()
  })

  afterEach(() => {
    clearTauriMock()
    clearWebSpeechMock()
  })

  describe('native (Tauri) path', () => {
    beforeEach(() => {
      setupTauriMock({ voiceAvailable: true })
    })

    it('marks isAvailable=true and reports engine=native when voice_available resolves true', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => {
        expect(result.current.isAvailable).toBe(true)
      })
      expect(result.current.engine).toBe('native')
    })

    it('invokes start_voice_input via Tauri when start() is called', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      expect(mockInvoke).toHaveBeenCalledWith('start_voice_input')
      expect(result.current.isRecording).toBe(true)
    })

    it('updates transcript from voice_transcription event payload', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        emit('voice_transcription', { text: 'hello world', is_final: false })
      })

      expect(result.current.transcript).toBe('hello world')
    })

    it('prefers native even when window.SpeechRecognition is also defined', async () => {
      installWebSpeechMock()
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      // Native wins — engine reports 'native', not 'web'
      expect(result.current.engine).toBe('native')

      act(() => {
        result.current.start()
      })
      // Started via Tauri invoke, NOT via Web Speech constructor
      expect(mockInvoke).toHaveBeenCalledWith('start_voice_input')
      expect(lastRecognition).toBeNull()
    })
  })

  describe('web speech fallback', () => {
    beforeEach(() => {
      installWebSpeechMock()
    })

    it('marks isAvailable=true and reports engine=web when only SpeechRecognition is defined', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))
      expect(result.current.engine).toBe('web')
    })

    it('falls back to webkitSpeechRecognition when SpeechRecognition is not defined', async () => {
      clearWebSpeechMock()
      installWebkitSpeechMock()

      const { result } = renderHook(() => useVoiceInput())
      await waitFor(() => expect(result.current.isAvailable).toBe(true))
      expect(result.current.engine).toBe('web')

      act(() => {
        result.current.start()
      })
      expect(lastRecognition).not.toBeNull()
      expect(lastRecognition!.start).toHaveBeenCalled()
    })

    it('configures continuous + interimResults and sets language on start()', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      expect(lastRecognition).not.toBeNull()
      expect(lastRecognition!.continuous).toBe(true)
      expect(lastRecognition!.interimResults).toBe(true)
      expect(lastRecognition!.lang).toBe('en-US')
      expect(lastRecognition!.start).toHaveBeenCalled()
      expect(result.current.isRecording).toBe(true)
    })

    it('accumulates final transcripts and surfaces interim results', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: 'hello' } }],
        })
      })
      expect(result.current.transcript).toBe('hello')

      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 1,
          results: [
            { isFinal: true, 0: { transcript: 'hello' } },
            { isFinal: false, 0: { transcript: ' world' } },
          ],
        })
      })
      expect(result.current.transcript).toBe('hello world')

      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 1,
          results: [
            { isFinal: true, 0: { transcript: 'hello' } },
            { isFinal: true, 0: { transcript: ' world' } },
          ],
        })
      })
      expect(result.current.transcript).toBe('hello world')
    })

    // #4733 — Chrome / Safari Web Speech routinely emit each utterance's
    // transcript field without a leading space. A naive `+= text` glued
    // them into run-on words ("hello worldhow are you"), which is the
    // strongest source candidate for the 332-codepoint TUI prompt in
    // #4733 that arrived with whitespace stripped mid-message (root
    // cause not yet confirmed end-to-end). Verify the buffer inserts a
    // single separator when neither side carries one — and stays
    // idempotent when the legacy leading-space variant is mixed in.
    it('inserts a separator between final segments that lack leading/trailing space (#4733)', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      // First utterance — a multi-word phrase with interior spaces preserved.
      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: 'Hello I am here' } }],
        })
      })
      expect(result.current.transcript).toBe('Hello I am here')

      // Second utterance — no leading space (the Chrome/Safari shape). Pre-
      // fix this concatenated to "Hello I am hereWhat do we need to do".
      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 1,
          results: [
            { isFinal: true, 0: { transcript: 'Hello I am here' } },
            { isFinal: true, 0: { transcript: 'What do we need to do' } },
          ],
        })
      })
      expect(result.current.transcript).toBe('Hello I am here What do we need to do')

      // Third utterance — already has a leading space (the legacy fixture
      // shape). The separator helper must not double-space the join.
      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 2,
          results: [
            { isFinal: true, 0: { transcript: 'Hello I am here' } },
            { isFinal: true, 0: { transcript: 'What do we need to do' } },
            { isFinal: true, 0: { transcript: ' next' } },
          ],
        })
      })
      expect(result.current.transcript).toBe('Hello I am here What do we need to do next')
    })

    // Sanity-check the no-segment-bleed path — interim results from a
    // single utterance should keep landing as one token regardless of
    // the separator helper. The helper only fires on isFinal, so this
    // pins the interim render path against an off-by-one regression.
    it('interim results inside one utterance render without injected spaces (#4733)', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: false, 0: { transcript: 'hello' } }],
        })
      })
      expect(result.current.transcript).toBe('hello')

      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: false, 0: { transcript: 'hello there' } }],
        })
      })
      expect(result.current.transcript).toBe('hello there')

      // Finalise the utterance — first final segment, no separator needed
      // because finalTranscriptRef is still empty when the helper runs.
      act(() => {
        lastRecognition!.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: 'hello there' } }],
        })
      })
      expect(result.current.transcript).toBe('hello there')
    })

    it('surfaces NotAllowedError with a permission-specific message', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      act(() => {
        lastRecognition!.onerror?.({ error: 'not-allowed' })
      })

      expect(result.current.error).toMatch(/permission|microphone/i)
      expect(result.current.isRecording).toBe(false)
    })

    it('clears recording on onend', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })
      expect(result.current.isRecording).toBe(true)

      act(() => {
        lastRecognition!.onend?.()
      })
      expect(result.current.isRecording).toBe(false)
    })

    it('stop() calls recognition.stop()', async () => {
      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })
      const recognition = lastRecognition!
      act(() => {
        result.current.stop()
      })
      expect(recognition.stop).toHaveBeenCalled()
    })
  })

  describe('neither available', () => {
    it('reports isAvailable=false and engine=none, start() is a no-op', async () => {
      const { result } = renderHook(() => useVoiceInput())

      // Give any pending effects a tick
      await new Promise(r => setTimeout(r, 10))

      expect(result.current.isAvailable).toBe(false)
      expect(result.current.engine).toBe('none')

      // start() should not throw and should not flip isRecording
      act(() => {
        result.current.start()
      })
      expect(result.current.isRecording).toBe(false)
    })

    it('reports isAvailable=false when Tauri is present but voice_available returns false and no Web Speech', async () => {
      setupTauriMock({ voiceAvailable: false })

      const { result } = renderHook(() => useVoiceInput())

      await new Promise(r => setTimeout(r, 10))

      expect(result.current.isAvailable).toBe(false)
      expect(result.current.engine).toBe('none')
    })

    it('falls back to Web Speech when Tauri voice_available returns false but SpeechRecognition is defined', async () => {
      setupTauriMock({ voiceAvailable: false })
      installWebSpeechMock()

      const { result } = renderHook(() => useVoiceInput())

      await waitFor(() => expect(result.current.isAvailable).toBe(true))
      expect(result.current.engine).toBe('web')
    })
  })
})
