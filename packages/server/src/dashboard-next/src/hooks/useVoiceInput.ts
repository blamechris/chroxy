/**
 * useVoiceInput — hook for streaming voice-to-text via Tauri speech commands.
 *
 * Invokes the Rust `start_voice_input` / `stop_voice_input` commands and
 * listens for `voice_transcription` / `voice_error` / `voice_stopped` events.
 * Returns { isRecording, transcript, error, isAvailable, start, stop }.
 *
 * Only active inside Tauri (desktop app). Returns isAvailable=false in browser.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { isTauri } from '../utils/tauri'

interface TranscriptionPayload {
  text: string
  is_final: boolean
}

interface ErrorPayload {
  message: string
}

type UnlistenFn = () => void

function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (!isTauri()) return null
  const w = window as unknown as Record<string, unknown>
  const internals = w.__TAURI_INTERNALS__ as { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } | undefined
  return internals?.invoke ?? null
}

function getTauriListen(): (<T>(event: string, handler: (e: { payload: T }) => void) => Promise<UnlistenFn>) | null {
  if (!isTauri()) return null
  const w = window as unknown as Record<string, unknown>
  const tauri = w.__TAURI__ as Record<string, unknown> | undefined
  const event = tauri?.event as { listen: <T>(event: string, handler: (e: { payload: T }) => void) => Promise<UnlistenFn> } | undefined
  return event?.listen ?? null
}

export function useVoiceInput() {
  const [isRecording, setIsRecording] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isAvailable, setIsAvailable] = useState(false)
  const unlistenRefs = useRef<UnlistenFn[]>([])

  // Check availability on mount
  useEffect(() => {
    const invoke = getTauriInvoke()
    if (!invoke) return

    invoke('voice_available')
      .then((available) => setIsAvailable(available as boolean))
      .catch(() => setIsAvailable(false))
  }, [])

  // Set up event listeners
  useEffect(() => {
    const listen = getTauriListen()
    if (!listen) return

    const setup = async () => {
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

    setup()

    return () => {
      for (const unlisten of unlistenRefs.current) {
        unlisten()
      }
      unlistenRefs.current = []
    }
  }, [])

  const start = useCallback(() => {
    const invoke = getTauriInvoke()
    if (!invoke) return

    setError(null)
    setTranscript('')
    setIsRecording(true)

    invoke('start_voice_input').catch((err) => {
      setError(String(err))
      setIsRecording(false)
    })
  }, [])

  const stop = useCallback(() => {
    const invoke = getTauriInvoke()
    if (!invoke) return

    invoke('stop_voice_input').catch(() => {
      // Ignore stop errors
    })
    // Don't set isRecording=false here — wait for voice_stopped event
  }, [])

  return { isRecording, transcript, error, isAvailable, start, stop }
}
