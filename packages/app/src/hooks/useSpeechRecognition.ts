import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getLocales } from 'expo-localization';

import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from 'expo-speech-recognition';

// #4825: consolidated voice-input mode union lives in store-core so the
// mobile hook, dashboard hook, and both settings UIs share one declaration.
import type { VoiceInputMode } from '@chroxy/store-core';

// Dynamically resolve the native module — returns null in Expo Go
let SpeechModule: typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule | null = null;
let useSpeechEvent: typeof import('expo-speech-recognition').useSpeechRecognitionEvent = (() => {}) as any;

try {
  const mod = require('expo-speech-recognition');
  SpeechModule = mod.ExpoSpeechRecognitionModule;
  useSpeechEvent = mod.useSpeechRecognitionEvent;
} catch {
  // Native module not available (Expo Go) — speech features disabled
}

const SPEECH_LANG_KEY = 'chroxy_speech_lang';

/** Get the persisted speech language, or the device default. */
export async function getSpeechLang(): Promise<string> {
  try {
    const stored = await SecureStore.getItemAsync(SPEECH_LANG_KEY);
    if (stored) return stored;
  } catch {
    // Ignore read errors
  }
  const locales = getLocales();
  return locales[0]?.languageTag ?? 'en-US';
}

/** Persist the speech language preference. */
export async function setSpeechLang(lang: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(SPEECH_LANG_KEY, lang);
  } catch {
    // Ignore write errors (e.g., SecureStore unavailable)
  }
}

/**
 * Voice input behaviour. The union itself lives in `@chroxy/store-core`
 * (#4825) — re-exported here so existing imports of `VoiceInputMode` from
 * this module keep working without churn.
 *
 * - `'continuous'`: when the engine fires `end` due to silence, the hook
 *   restarts recognition automatically. The mic stays lit until the user
 *   explicitly calls `stopListening()`. Bounded by `MAX_CONTINUOUS_RESTARTS`
 *   so a wedged backend cannot spin forever.
 * - `'auto-pause'`: original behaviour — `end` ends the session. Default
 *   to keep behaviour stable for callers that don't pass `mode`.
 */
export type { VoiceInputMode };

export interface UseSpeechRecognitionOptions {
  mode?: VoiceInputMode;
}

export interface UseSpeechRecognitionReturn {
  isRecognizing: boolean;
  transcript: string;
  error: string | null;
  isAvailable: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
}

/**
 * Maximum consecutive restart attempts before continuous mode gives up.
 * Mirrors `MAX_CONTINUOUS_RESTARTS` in the dashboard's `useVoiceInput`.
 * Counter resets on each non-empty `result` event or fresh `startListening`.
 */
const MAX_CONTINUOUS_RESTARTS = 5;

/**
 * Errors that hard-stop continuous mode rather than letting the `end`
 * handler re-arm recognition. Mirrors `HARD_STOP_ERRORS` in the dashboard's
 * `useVoiceInput`. Without this set, an error event followed by an `end`
 * event would re-arm recognition while the UI state shows stopped — the
 * engine keeps the mic open silently with no UI feedback (Copilot finding
 * on #4813).
 *
 * - `'not-allowed'` / `'service-not-allowed'`: permission/availability —
 *   retrying would re-fail.
 * - `'audio-capture'`: mic hardware gone.
 * - `'aborted'`: user/system invoked `abort()`; restarting would race the
 *   teardown.
 * - `'interrupted'` (iOS): audio session interrupted by phone call/Siri;
 *   honour the system event and stop.
 * - `'language-not-supported'`: locale invalid — retrying re-throws.
 *
 * Soft errors (`no-speech`, `network`, `speech-timeout`, etc.) are left for
 * the `end` handler so continuous mode can re-arm across normal silence gaps.
 */
const HARD_STOP_ERRORS: ReadonlySet<string> = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'aborted',
  'interrupted',
  'language-not-supported',
]);

export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const mode: VoiceInputMode = options.mode ?? 'auto-pause';

  const [isRecognizing, setIsRecognizing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isAvailable, setIsAvailable] = useState(false);

  // Continuous-mode restart bookkeeping. `userStoppedRef` flips true when
  // `stopListening()` or unmount fires so the `end` handler can distinguish a
  // user-initiated stop from a silence-triggered one. `restartCountRef` bounds
  // the retry loop — counter resets on a real (non-empty) transcript or on a
  // fresh `startListening()` call.
  const userStoppedRef = useRef<boolean>(false);
  const restartCountRef = useRef<number>(0);
  const modeRef = useRef<VoiceInputMode>(mode);
  modeRef.current = mode;

  // Track whether the component is still mounted
  const mountedRef = useRef(true);

  // Track whether a stop was requested during async permission flow
  const stopRequestedRef = useRef(false);

  // Track whether a recogniser session is currently in-flight. Mirrors
  // `isRecognizing` state but stays synchronous so the `startListening`
  // prior-teardown branch (#4826) and the `end` handler don't race against a
  // pending React state update. Set true when `start()` is called (fresh
  // start or continuous-mode re-arm), cleared when the session ends or is
  // explicitly torn down.
  const inFlightRef = useRef<boolean>(false);

  useEffect(() => {
    if (SpeechModule) {
      try {
        setIsAvailable(SpeechModule.isRecognitionAvailable());
      } catch {
        setIsAvailable(false);
      }
    }
  }, []);

  useSpeechEvent('result', (event: ExpoSpeechRecognitionResultEvent) => {
    const text = event.results[0]?.transcript;
    if (text) {
      setTranscript(text);
      // #4789 mirror: only reset the restart counter on real speech so a
      // wedged engine that emits empty `result` events can't bypass the cap.
      if (text.trim().length > 0) {
        restartCountRef.current = 0;
      }
    }
  });

  useSpeechEvent('end', () => {
    // Continuous mode: silence-triggered end re-arms recognition unless the
    // user explicitly stopped (or unmounted) and we're still under the
    // restart cap. The mic stays lit during the restart blip so the UI
    // doesn't flicker.
    if (
      modeRef.current === 'continuous' &&
      !userStoppedRef.current &&
      mountedRef.current &&
      restartCountRef.current < MAX_CONTINUOUS_RESTARTS &&
      SpeechModule
    ) {
      restartCountRef.current += 1;
      try {
        // Re-arm the SAME recogniser session — no permission re-prompt, no
        // lang re-read. `startListening()` is reserved for fresh user-initiated
        // sessions; this path keeps `isRecognizing` true.
        SpeechModule.start({
          lang: lastLangRef.current ?? 'en-US',
          interimResults: true,
          contextualStrings: ['Claude', 'Chroxy'],
        });
        inFlightRef.current = true;
        return;
      } catch {
        // Engine may still be in the tail of the previous session; fall
        // through to clear the mic.
      }
    }
    inFlightRef.current = false;
    setIsRecognizing(false);
  });

  useSpeechEvent('error', (event: ExpoSpeechRecognitionErrorEvent) => {
    // Don't treat abort as a user-visible error
    if (event.error !== 'aborted') {
      setError(event.message || event.error);
    }
    // Hard errors must suppress the continuous-mode `end` restart branch.
    // Without flipping `userStoppedRef`, an error event followed by an
    // `end` event (the spec-mandated sequence) would let the restart path
    // re-arm recognition while the UI shows stopped — the engine would
    // silently hold the mic with no UI to release it (Copilot finding on
    // #4813). Mirrors the dashboard's `onerror` hard-stop branch.
    if (HARD_STOP_ERRORS.has(event.error)) {
      userStoppedRef.current = true;
      inFlightRef.current = false;
      setIsRecognizing(false);
      return;
    }
    inFlightRef.current = false;
    // Soft error in continuous mode (no-speech, network, speech-timeout):
    // leave `isRecognizing` true and let the subsequent `end` event decide
    // whether to re-arm. Flipping false here only to have the restart re-set
    // it true causes a brief mic-icon flicker (#4829). Mirrors the dashboard
    // `useVoiceInput.onerror` behaviour.
    if (modeRef.current === 'continuous') return;
    setIsRecognizing(false);
  });

  // Cache the last resolved language so the silence-restart path doesn't
  // re-await SecureStore on every silence gap.
  const lastLangRef = useRef<string | null>(null);

  // Abort on unmount — also detach the continuous-mode restart guard so the
  // engine's post-abort `end` event can't re-arm against an unmounted owner.
  // Mirrors the #4789 fix pattern from the dashboard.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      userStoppedRef.current = true;
      inFlightRef.current = false;
      SpeechModule?.abort();
    };
  }, []);

  const startListening = useCallback(async () => {
    if (!SpeechModule) return;

    setError(null);
    setTranscript('');
    stopRequestedRef.current = false;

    // #4826 / #4789 parity: tear down any prior in-flight recogniser BEFORE
    // resetting the fresh-session bookkeeping. A double-tap on the mic (or
    // gesture + voice-command racing) can land a second `startListening` on
    // top of an active session. Without this guard, the prior session's
    // queued `onend` would arrive after we reset `userStoppedRef = false` /
    // `restartCountRef = 0` below and re-arm continuous mode against the new
    // session's bookkeeping — the dual-mic window the dashboard #4789 fix
    // closed in its start path. `userStoppedRef = true` BEFORE `abort()` so
    // the prior session's `end` handler sees the stop flag and exits cleanly.
    if (inFlightRef.current) {
      userStoppedRef.current = true;
      try {
        SpeechModule.abort();
      } catch {
        // Engine may already be tearing down; safe to ignore.
      }
      inFlightRef.current = false;
    }

    // Fresh user-initiated start: reset continuous bookkeeping so prior
    // session's user-stop or restart-counter doesn't carry over.
    userStoppedRef.current = false;
    restartCountRef.current = 0;

    const { granted } = await SpeechModule.requestPermissionsAsync();

    // If component unmounted or stop requested while awaiting permission, bail out
    if (!mountedRef.current || stopRequestedRef.current) return;

    if (!granted) {
      Alert.alert(
        'Permissions Required',
        'Microphone and speech recognition permissions are needed for voice input. Please enable them in Settings.',
      );
      return;
    }

    const lang = await getSpeechLang();

    // If component unmounted or stop requested while awaiting language, bail out
    if (!mountedRef.current || stopRequestedRef.current) return;

    lastLangRef.current = lang;
    SpeechModule.start({
      lang,
      interimResults: true,
      contextualStrings: ['Claude', 'Chroxy'],
    });
    inFlightRef.current = true;
    setIsRecognizing(true);
  }, []);

  const stopListening = useCallback(() => {
    stopRequestedRef.current = true;
    // Mark the stop as user-initiated BEFORE invoking engine stop so the
    // silence-restart path in `end` sees the flag and exits cleanly rather
    // than re-arming a session the user just cancelled.
    userStoppedRef.current = true;
    inFlightRef.current = false;
    SpeechModule?.stop();
  }, []);

  return {
    isRecognizing,
    transcript,
    error,
    isAvailable,
    startListening,
    stopListening,
  };
}
