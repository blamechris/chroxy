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

export interface UseVoiceInputReturn {
  isRecording: boolean
  transcript: string
  error: string | null
  isAvailable: boolean
  engine: VoiceEngine
  start: () => void
  stop: () => void
}

export function useVoiceInput(): UseVoiceInputReturn {
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
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
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
        //
        // Segment join (issue #4733): Chrome / Safari Web Speech emit
        // each utterance's `transcript` field without a leading space, so
        // a naive `finalTranscriptRef.current += text` glues sequential
        // utterances into run-on words ("hello worldhow are you" instead
        // of "hello world how are you"). Insert a single space when both
        // sides lack one and the buffer is non-empty. Safe under any
        // implementation that already supplies leading spaces — the
        // `text.startsWith(' ') || finalTranscriptRef.current.endsWith(' ')`
        // guard short-circuits and we add nothing. Mirrors how
        // InputBar.tsx's voice-merge effect (`!prefix.endsWith(' ') ? ' '
        // : ''`) avoids doubled separators when stitching the dictation
        // span into the composer value.
        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i]
          if (!r) continue
          const text = r[0]?.transcript ?? ''
          if (r.isFinal) {
            const needsSeparator =
              finalTranscriptRef.current.length > 0 &&
              !finalTranscriptRef.current.endsWith(' ') &&
              text.length > 0 &&
              !text.startsWith(' ')
            finalTranscriptRef.current += (needsSeparator ? ' ' : '') + text
          } else {
            interim += text
          }
        }
        setTranscript(finalTranscriptRef.current + interim)
      }

      recognition.onerror = (event) => {
        setError(permissionMessageForError(event.error))
        setIsRecording(false)
      }

      recognition.onend = () => {
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
