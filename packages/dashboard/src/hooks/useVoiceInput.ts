/**
 * useVoiceInput — streaming voice-to-text for the dashboard.
 *
 * Selects an engine at mount time and exposes a uniform surface:
 *
 *   - `native`: Tauri commands `start_voice_input` / `stop_voice_input`
 *     (macOS Swift helper, see packages/desktop/src-tauri/src/speech.rs).
 *     Streams via the `voice_transcription` / `voice_error` / `voice_stopped`
 *     Tauri events.
 *
 *   - `web`: Web Speech API via `window.SpeechRecognition` (or the prefixed
 *     `webkitSpeechRecognition`). Used in plain browsers (Chrome / Safari /
 *     Edge) and in Tauri shells on Windows / Linux where the Swift helper is
 *     not bundled. Runs with `continuous = true` + `interimResults = true`
 *     so partial transcripts surface as they come in. (#4350)
 *
 *   - `none`: neither path available — `isAvailable` stays `false` and the
 *     InputBar hides its mic button.
 *
 * Native always wins when both paths are present: it has better accuracy on
 * macOS and runs offline (no permission prompt per session, no HTTPS
 * requirement). The Web Speech fallback only takes over when the native
 * helper reports unavailable, which is the right behaviour on Windows /
 * Linux Tauri builds and in plain-browser dashboards.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { getTauriInvoke, getTauriListen } from '../utils/tauri-bridge'

interface TranscriptionPayload {
  text: string
  is_final: boolean
}

interface ErrorPayload {
  message: string
}

type UnlistenFn = () => void

/** Which engine the hook is currently driving. `none` means voice unavailable. */
export type VoiceEngine = 'native' | 'web' | 'none'

// -- Web Speech API minimal type definitions (TS lib.dom doesn't include these) --

interface WebSpeechAlternative {
  transcript: string
}

interface WebSpeechResult {
  isFinal: boolean
  0: WebSpeechAlternative
}

interface WebSpeechRecognitionEvent {
  resultIndex: number
  results: ArrayLike<WebSpeechResult>
}

interface WebSpeechErrorEvent {
  error: string
  message?: string
}

interface WebSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: WebSpeechRecognitionEvent) => void) | null
  onerror: ((e: WebSpeechErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

type WebSpeechRecognitionCtor = new () => WebSpeechRecognition

function getWebSpeechCtor(): WebSpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: WebSpeechRecognitionCtor
    webkitSpeechRecognition?: WebSpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Default language for the Web Speech path. Mobile (`packages/app`) stores a
 * persisted preference via `expo-secure-store`, but the dashboard doesn't
 * have an equivalent setting yet — fall back to the browser's `navigator.language`
 * when present, else `en-US`. The mobile preference helper is intentionally
 * not shared here: it depends on `expo-secure-store` + `expo-localization`,
 * neither of which exists in a browser context. Lifting it into `store-core`
 * is tracked separately.
 */
function defaultLanguage(): string {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) {
    return navigator.language
  }
  return 'en-US'
}

function permissionMessageForError(error: string): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'Microphone permission denied. Please allow microphone access in your browser settings.'
  }
  if (error === 'no-speech') return 'No speech detected.'
  if (error === 'audio-capture') return 'No microphone available.'
  if (error === 'network') return 'Network error during speech recognition.'
  return `Speech recognition error: ${error}`
}

/**
 * Voice input behaviour. See `InputSettings.voiceInputMode` in store-core for
 * the persisted setting; this hook accepts it as a runtime option so the
 * caller (App.tsx) reads the store once and the hook stays store-agnostic.
 *
 * - `'continuous'`: when the Web Speech engine fires `onend` due to silence,
 *   the hook restarts recognition automatically. The mic stays lit until the
 *   user explicitly calls `stop()`. This is the click-to-start / click-to-stop
 *   experience #4785 was filed for.
 *
 * - `'auto-pause'`: original behaviour — `onend` ends the session. Kept for
 *   users who prefer the browser's silence-stop semantics.
 *
 * Only the web engine is affected. The native (Tauri) engine has its own
 * end-of-utterance semantics driven by the Swift helper and is out of scope.
 */
export type VoiceInputMode = 'continuous' | 'auto-pause'

export interface UseVoiceInputOptions {
  mode?: VoiceInputMode
}

export interface UseVoiceInputReturn {
  isRecording: boolean
  transcript: string
  error: string | null
  isAvailable: boolean
  engine: VoiceEngine
  start: () => void
  stop: () => void
}

/**
 * Errors that should NOT trigger a continuous-mode restart loop. `no-speech`
 * is technically the most common loop-trigger (silence followed by silence)
 * but Web Speech raises it benignly during normal pauses — we treat it as a
 * soft end and let the restart proceed. The hard-stop set below is for
 * conditions where retrying would mask a real problem (permission denied,
 * mic hardware gone, user aborted).
 */
const HARD_STOP_ERRORS = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'aborted',
])

/** Maximum consecutive restart attempts before continuous mode gives up. */
const MAX_CONTINUOUS_RESTARTS = 5

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const mode: VoiceInputMode = options.mode ?? 'continuous'
  const [isRecording, setIsRecording] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isAvailable, setIsAvailable] = useState(false)
  const [engine, setEngine] = useState<VoiceEngine>('none')

  // Web Speech: keep the active recognition object + finalised text segment
  // across renders so accumulation doesn't reset on each `onresult` call.
  const recognitionRef = useRef<WebSpeechRecognition | null>(null)
  const finalTranscriptRef = useRef<string>('')
  const unlistenRefs = useRef<UnlistenFn[]>([])

  // Continuous-mode restart bookkeeping. `userStoppedRef` flips true when
  // `stop()` is called so the `onend` handler can distinguish a user-initiated
  // stop from a silence-triggered one. `restartCountRef` bounds the retry
  // loop so a wedged backend doesn't spin forever — counter resets on each
  // successful `onresult` or explicit `start()`.
  const userStoppedRef = useRef<boolean>(false)
  const restartCountRef = useRef<number>(0)
  const modeRef = useRef<VoiceInputMode>(mode)
  modeRef.current = mode

  // ---- Engine selection (runs once on mount) ----
  useEffect(() => {
    let cancelled = false

    async function pickEngine(): Promise<void> {
      const invoke = getTauriInvoke()
      if (invoke) {
        try {
          const available = (await invoke('voice_available')) as boolean
          if (cancelled) return
          if (available) {
            setEngine('native')
            setIsAvailable(true)
            return
          }
        } catch {
          // Tauri available but the command isn't registered (e.g. Windows /
          // Linux Tauri without speech.rs wiring). Fall through to web.
        }
      }

      // Web Speech fallback — covers plain browsers and non-macOS Tauri.
      if (getWebSpeechCtor()) {
        if (cancelled) return
        setEngine('web')
        setIsAvailable(true)
        return
      }

      if (cancelled) return
      setEngine('none')
      setIsAvailable(false)
    }

    void pickEngine()

    return () => {
      cancelled = true
    }
  }, [])

  // ---- Native (Tauri) event listeners ----
  useEffect(() => {
    if (engine !== 'native') return

    const listen = getTauriListen()
    if (!listen) return

    const setup = async (): Promise<void> => {
      const u1 = await listen<TranscriptionPayload>('voice_transcription', (e) => {
        setTranscript(e.payload.text)
        if (e.payload.is_final) {
          setIsRecording(false)
        }
      })

      const u2 = await listen<ErrorPayload>('voice_error', (e) => {
        setError(e.payload.message)
        setIsRecording(false)
      })

      const u3 = await listen<void>('voice_stopped', () => {
        setIsRecording(false)
      })

      unlistenRefs.current = [u1, u2, u3]
    }

    void setup()

    return () => {
      for (const unlisten of unlistenRefs.current) {
        unlisten()
      }
      unlistenRefs.current = []
    }
  }, [engine])

  // ---- Web Speech: abort on unmount ----
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current
      if (rec) {
        // #4789: per the Web Speech spec, abort() fires `onend`. The
        // continuous-mode restart branch in onend would otherwise call
        // recognition.start() on a recogniser whose React owner has already
        // unmounted — either throwing InvalidStateError or leaving runaway
        // recognition holding the mic with no UI to stop it. Two defences:
        //   1. Set userStoppedRef so any fire-before-detach onend exits early.
        //   2. Null the handlers so the abort()-triggered onend is a no-op.
        userStoppedRef.current = true
        rec.onresult = null
        rec.onerror = null
        rec.onend = null
        rec.onstart = null
        try {
          rec.abort()
        } catch {
          // Recognition may already be inactive; ignore.
        }
        recognitionRef.current = null
      }
    }
  }, [])

  const start = useCallback(() => {
    setError(null)
    // Fresh user-initiated start: clear the continuous-mode bookkeeping so
    // a prior session's user-stop or restart-counter doesn't carry over.
    // NOTE: any in-flight web recognition is torn down inside the `web` branch
    // below — and that teardown re-flips userStoppedRef to true BEFORE calling
    // abort(), so the OLD onend doesn't re-arm against the NEW recogniser.
    // We then flip it back to false right before constructing the new one.
    userStoppedRef.current = false
    restartCountRef.current = 0

    if (engine === 'native') {
      const invoke = getTauriInvoke()
      if (!invoke) return
      setTranscript('')
      setIsRecording(true)
      invoke('start_voice_input').catch((err) => {
        setError(String(err))
        setIsRecording(false)
      })
      return
    }

    if (engine === 'web') {
      const Ctor = getWebSpeechCtor()
      if (!Ctor) return

      // Tear down any prior recognition before starting a fresh one.
      // #4789: detach the OLD recogniser's handlers BEFORE calling abort().
      // abort() fires onend, and the continuous-mode branch in onend reads
      // the shared userStoppedRef/restartCountRef — by the time the old
      // onend fires the new start() will have already reset both refs to
      // their "fresh session" values, so the old onend would re-arm itself
      // and race the new recogniser (dual-mic window). Nulling the handlers
      // is the only way to guarantee the old session can't re-arm.
      if (recognitionRef.current) {
        const prior = recognitionRef.current
        prior.onresult = null
        prior.onerror = null
        prior.onend = null
        prior.onstart = null
        try {
          prior.abort()
        } catch {
          // ignore
        }
      }

      finalTranscriptRef.current = ''
      setTranscript('')

      const recognition = new Ctor()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = defaultLanguage()

      recognition.onresult = (event) => {
        // Walk the results from `resultIndex` forward. Anything `isFinal`
        // gets locked into `finalTranscriptRef`; the tail of in-flight
        // interim results is appended live so the UI sees mid-utterance
        // updates.
        let interim = ''
        let finalDelta = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i]
          if (!r) continue
          const text = r[0]?.transcript ?? ''
          if (r.isFinal) {
            finalTranscriptRef.current += text
            finalDelta += text
          } else {
            interim += text
          }
        }
        setTranscript(finalTranscriptRef.current + interim)
        // #4789: only reset the restart counter when the event actually
        // delivers non-empty transcript text. A wedged backend can emit
        // empty/whitespace `onresult` events that would otherwise bypass
        // MAX_CONTINUOUS_RESTARTS and spin forever. Reset only on real
        // speech (final or interim).
        if ((finalDelta + interim).trim().length > 0) {
          restartCountRef.current = 0
        }
      }

      recognition.onerror = (event) => {
        // Hard errors (permission denied, mic gone, user aborted) always
        // surface to the user and stop the session in both modes.
        if (HARD_STOP_ERRORS.has(event.error)) {
          setError(permissionMessageForError(event.error))
          userStoppedRef.current = true
          setIsRecording(false)
          return
        }
        // Soft errors (no-speech, network):
        //   - In `auto-pause` mode we preserve pre-#4785 behaviour and surface
        //     every error to the user so the message channel still works the
        //     same way it did before this PR.
        //   - In `continuous` mode we deliberately swallow soft errors so the
        //     `onend` restart path can re-arm without the UI flashing a
        //     `no-speech` toast on every silence gap — that's the whole point
        //     of continuous mode. `isRecording` is left alone here; `onend`
        //     is the single source of truth for clearing it.
        if (modeRef.current === 'auto-pause') {
          setError(permissionMessageForError(event.error))
          setIsRecording(false)
        }
      }

      recognition.onend = () => {
        // Continuous mode: if the user hasn't pressed stop, the silence-stop
        // is what we're correcting for. Re-issue start() on the same recogniser
        // — bounded by MAX_CONTINUOUS_RESTARTS so a wedged backend can't spin.
        if (
          modeRef.current === 'continuous' &&
          !userStoppedRef.current &&
          restartCountRef.current < MAX_CONTINUOUS_RESTARTS
        ) {
          restartCountRef.current += 1
          try {
            recognition.start()
            // isRecording stays true — the UI doesn't flicker the mic icon
            // during the restart blip.
            return
          } catch {
            // start() can throw InvalidStateError if the engine is still in
            // the tail of the previous session; fall through to stop.
          }
        }
        setIsRecording(false)
      }

      recognitionRef.current = recognition

      try {
        recognition.start()
        setIsRecording(true)
      } catch (err) {
        setError(String(err))
        setIsRecording(false)
        recognitionRef.current = null
      }
      return
    }

    // engine === 'none' — start() is a no-op
  }, [engine])

  const stop = useCallback(() => {
    // Mark the stop as user-initiated BEFORE invoking the engine stop, so
    // the silence-restart path in `onend` (web) sees the flag and exits
    // cleanly rather than re-arming a session the user just cancelled.
    userStoppedRef.current = true

    if (engine === 'native') {
      const invoke = getTauriInvoke()
      if (!invoke) return
      invoke('stop_voice_input').catch(() => {
        // Ignore stop errors — `voice_stopped` will fire from the helper
      })
      // Don't clear isRecording here — wait for the voice_stopped event
      return
    }

    if (engine === 'web') {
      const rec = recognitionRef.current
      if (rec) {
        try {
          rec.stop()
        } catch {
          // Already stopped; `onend` will fire regardless.
        }
      }
      return
    }
  }, [engine])

  return { isRecording, transcript, error, isAvailable, engine, start, stop }
}
