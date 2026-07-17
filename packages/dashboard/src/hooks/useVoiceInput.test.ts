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

    it('surfaces a genuine voice_error while recording', async () => {
      const { result } = renderHook(() => useVoiceInput())
      await waitFor(() => expect(result.current.isAvailable).toBe(true))
      act(() => { result.current.start() })
      act(() => { emit('voice_error', { message: 'Speech recognizer not available' }) })
      expect(result.current.error).toBe('Speech recognizer not available')
      expect(result.current.isRecording).toBe(false)
    })

    it('#6634: suppresses the cancellation voice_error that races an intentional stop', async () => {
      const { result } = renderHook(() => useVoiceInput())
      await waitFor(() => expect(result.current.isAvailable).toBe(true))
      act(() => { result.current.start() })
      // user releases Control / presses Command → stop() flips userStopped
      act(() => { result.current.stop() })
      act(() => { emit('voice_error', { message: 'Recognition request was canceled' }) })
      expect(result.current.error).toBeNull()
      expect(result.current.isRecording).toBe(false)
    })

    it('#6636: suppresses a benign no-speech voice_error even while recording', async () => {
      const { result } = renderHook(() => useVoiceInput())
      await waitFor(() => expect(result.current.isAvailable).toBe(true))
      act(() => { result.current.start() })
      // no stop() yet — the message itself is benign
      act(() => { emit('voice_error', { message: 'No speech detected' }) })
      expect(result.current.error).toBeNull()
      expect(result.current.isRecording).toBe(false)
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

    it('clears recording on onend in auto-pause mode', async () => {
      const { result } = renderHook(() => useVoiceInput({ mode: 'auto-pause' }))

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

    // Regression guard for #4786 review: auto-pause mode must preserve the
    // pre-#4785 behaviour of surfacing soft errors (no-speech, network) to
    // the user. Continuous mode deliberately swallows them so the restart
    // loop doesn't flash a toast on every silence gap, but auto-pause is
    // the "old behaviour" mode and the error channel must keep working.
    it('surfaces soft errors (no-speech) in auto-pause mode', async () => {
      const { result } = renderHook(() => useVoiceInput({ mode: 'auto-pause' }))

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      act(() => {
        lastRecognition!.onerror?.({ error: 'no-speech' })
      })

      expect(result.current.error).toMatch(/no speech/i)
      expect(result.current.isRecording).toBe(false)
    })

    it('does NOT surface soft errors in continuous mode (silent restart path)', async () => {
      const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

      await waitFor(() => expect(result.current.isAvailable).toBe(true))

      act(() => {
        result.current.start()
      })

      act(() => {
        lastRecognition!.onerror?.({ error: 'no-speech' })
      })

      expect(result.current.error).toBeNull()
    })

    // #4785: continuous mode is the new default. The Web Speech API auto-ends
    // recognition after ~5-10s of silence; the hook compensates by restarting
    // on each `onend` until the user explicitly clicks stop.
    describe('continuous mode (#4785)', () => {
      it('default mode is continuous — silence-triggered onend restarts recognition', async () => {
        const { result } = renderHook(() => useVoiceInput())

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!
        expect(recognition.start).toHaveBeenCalledTimes(1)
        expect(result.current.isRecording).toBe(true)

        act(() => {
          recognition.onend?.()
        })

        // Restart was issued; isRecording stays true (no UI flicker).
        expect(recognition.start).toHaveBeenCalledTimes(2)
        expect(result.current.isRecording).toBe(true)
      })

      it('explicit user stop does NOT trigger restart in continuous mode', async () => {
        const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!

        act(() => {
          result.current.stop()
          // stop() flips userStoppedRef → onend should clear isRecording, not restart.
          recognition.onend?.()
        })

        expect(recognition.start).toHaveBeenCalledTimes(1) // no restart
        expect(result.current.isRecording).toBe(false)
      })

      it('auto-pause mode does NOT restart on onend even after multiple cycles', async () => {
        const { result } = renderHook(() => useVoiceInput({ mode: 'auto-pause' }))

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!

        act(() => {
          recognition.onend?.()
        })

        expect(recognition.start).toHaveBeenCalledTimes(1) // no restart
        expect(result.current.isRecording).toBe(false)
      })

      it('hard errors (not-allowed) stop continuous mode without restart', async () => {
        const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!

        act(() => {
          // Hard error → marks user-stop and clears isRecording. The subsequent
          // onend from the underlying engine should NOT restart.
          recognition.onerror?.({ error: 'not-allowed' })
          recognition.onend?.()
        })

        expect(recognition.start).toHaveBeenCalledTimes(1) // no restart
        expect(result.current.isRecording).toBe(false)
        expect(result.current.error).toMatch(/permission|microphone/i)
      })

      it('caps continuous restarts at MAX_CONTINUOUS_RESTARTS to avoid wedge loops', async () => {
        const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!

        // Fire onend repeatedly with no intervening onresult — restart counter
        // increments each time and eventually the hook gives up.
        for (let i = 0; i < 10; i++) {
          act(() => { recognition.onend?.() })
        }

        // Initial start + 5 restarts = 6 total calls; subsequent onends are no-ops.
        expect(recognition.start).toHaveBeenCalledTimes(6)
        expect(result.current.isRecording).toBe(false)
      })

      // #6290: exhausting the restart budget previously flipped the mic off
      // silently — the user kept "dictating" into a dead recogniser. The cap
      // path must now surface a visible error so the InputBar banner shows it.
      it('surfaces a voice error when the restart budget is exhausted (#6290)', async () => {
        const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!

        // No error before the budget runs out.
        expect(result.current.error).toBeNull()

        // Fire onend until the restart counter passes MAX_CONTINUOUS_RESTARTS.
        for (let i = 0; i < 10; i++) {
          act(() => { recognition.onend?.() })
        }

        expect(result.current.isRecording).toBe(false)
        expect(result.current.error).toMatch(/stopped unexpectedly|tap the mic/i)
      })

      it('successful onresult resets the restart counter (long sessions stay healthy)', async () => {
        const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

        await waitFor(() => expect(result.current.isAvailable).toBe(true))

        act(() => {
          result.current.start()
        })
        const recognition = lastRecognition!

        // Burn 3 restarts with no transcript, then deliver one.
        for (let i = 0; i < 3; i++) {
          act(() => { recognition.onend?.() })
        }
        act(() => {
          recognition.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: 'hi' } }],
          })
        })

        // After a successful onresult, counter resets → 5 fresh restarts allowed.
        for (let i = 0; i < 5; i++) {
          act(() => { recognition.onend?.() })
        }

        // Initial + 3 (pre-result) + 5 (post-result) = 9
        expect(recognition.start).toHaveBeenCalledTimes(9)
      })

      // #4789 audit P0.3 regression — three races introduced by #4786:
      //
      //   Bug 1: Unmount effect calls rec.abort() without first flipping
      //          userStoppedRef. abort() fires onend, which sees continuous
      //          mode + !userStopped + counter<5 and calls recognition.start()
      //          on a recogniser whose React owner has already unmounted.
      //   Bug 2: start() aborts the prior recognition AFTER clearing
      //          userStoppedRef, so the OLD onend re-arms while the new
      //          recogniser already owns recognitionRef → dual-mic window.
      //   Bug 3: onresult unconditionally resets restartCountRef even when
      //          the result carries no transcript text, letting a wedged
      //          backend bypass MAX_CONTINUOUS_RESTARTS.
      describe('regression #4789 (audit P0.3)', () => {
        it('unmount does NOT re-arm recognition via the onend restart path (bug 1)', async () => {
          const { result, unmount } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

          await waitFor(() => expect(result.current.isAvailable).toBe(true))

          act(() => {
            result.current.start()
          })
          const recognition = lastRecognition!
          expect(recognition.start).toHaveBeenCalledTimes(1)

          // Simulate the W3C Web Speech spec behaviour: abort() (called by the
          // unmount effect) fires onend synchronously or microtask-later. The
          // recogniser is detached; if onend re-arms via start() we've leaked.
          unmount()
          act(() => {
            recognition.onend?.()
          })

          // start() must NOT have been called again — userStoppedRef should
          // have been set before abort() in the unmount cleanup.
          expect(recognition.start).toHaveBeenCalledTimes(1)
        })

        it('start() while a prior recognition is in-flight does not let the old onend re-arm (bug 2)', async () => {
          const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

          await waitFor(() => expect(result.current.isAvailable).toBe(true))

          act(() => {
            result.current.start()
          })
          const firstRecognition = lastRecognition!
          expect(firstRecognition.start).toHaveBeenCalledTimes(1)

          // Begin a fresh recognition. The hook should abort the prior one
          // AND mark it as user-stopped so its onend exits cleanly without
          // racing the new recogniser.
          act(() => {
            result.current.start()
          })
          const secondRecognition = lastRecognition!
          expect(secondRecognition).not.toBe(firstRecognition)
          expect(secondRecognition.start).toHaveBeenCalledTimes(1)

          // Now fire the OLD recognition's onend (the abort-triggered one).
          // It must NOT call start() on itself — that would create two
          // concurrent recognitions holding the mic.
          act(() => {
            firstRecognition.onend?.()
          })

          // First recogniser stayed at 1 call (no re-arm); second stayed at 1.
          expect(firstRecognition.start).toHaveBeenCalledTimes(1)
          expect(secondRecognition.start).toHaveBeenCalledTimes(1)
        })

        it('empty onresult does NOT reset the restart counter (bug 3 — wedge guard)', async () => {
          const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

          await waitFor(() => expect(result.current.isAvailable).toBe(true))

          act(() => {
            result.current.start()
          })
          const recognition = lastRecognition!

          // Burn 3 restarts with no transcript.
          for (let i = 0; i < 3; i++) {
            act(() => { recognition.onend?.() })
          }
          // A wedged backend fires onresult with empty transcript text. This
          // must NOT reset the counter — otherwise the cap is bypassed.
          act(() => {
            recognition.onresult?.({
              resultIndex: 0,
              results: [{ isFinal: false, 0: { transcript: '' } }],
            })
          })
          // Only 2 more restarts should be allowed (counter at 3, cap at 5).
          for (let i = 0; i < 10; i++) {
            act(() => { recognition.onend?.() })
          }

          // Initial + 3 (pre-empty) + 2 (post-empty, until cap) = 6
          expect(recognition.start).toHaveBeenCalledTimes(6)
          expect(result.current.isRecording).toBe(false)
        })

        it('whitespace-only onresult does NOT reset the restart counter', async () => {
          const { result } = renderHook(() => useVoiceInput({ mode: 'continuous' }))

          await waitFor(() => expect(result.current.isAvailable).toBe(true))

          act(() => {
            result.current.start()
          })
          const recognition = lastRecognition!

          for (let i = 0; i < 3; i++) {
            act(() => { recognition.onend?.() })
          }
          act(() => {
            recognition.onresult?.({
              resultIndex: 0,
              results: [{ isFinal: false, 0: { transcript: '   \t  ' } }],
            })
          })
          for (let i = 0; i < 10; i++) {
            act(() => { recognition.onend?.() })
          }

          // Initial + 3 + 2 = 6 — whitespace counts as empty.
          expect(recognition.start).toHaveBeenCalledTimes(6)
        })
      })
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
