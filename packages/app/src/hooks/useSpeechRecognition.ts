import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getLocales } from 'expo-localization';

import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from 'expo-speech-recognition';

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

export interface UseSpeechRecognitionReturn {
  isRecognizing: boolean;
  transcript: string;
  error: string | null;
  isAvailable: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
}

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isAvailable, setIsAvailable] = useState(false);

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
    }
  });

  useSpeechEvent('end', () => {
    setIsRecognizing(false);
  });

  useSpeechEvent('error', (event: ExpoSpeechRecognitionErrorEvent) => {
    // Don't treat abort as a user-visible error
    if (event.error !== 'aborted') {
      setError(event.message || event.error);
    }
    setIsRecognizing(false);
  });

  // Abort on unmount
  useEffect(() => {
    return () => {
      SpeechModule?.abort();
    };
  }, []);

  // Track whether a stop was requested during async permission flow
  const stopRequestedRef = useRef(false);

  const startListening = useCallback(async () => {
    if (!SpeechModule) return;

    setError(null);
    setTranscript('');
    stopRequestedRef.current = false;

    const { granted } = await SpeechModule.requestPermissionsAsync();
    if (!granted) {
      Alert.alert(
        'Permissions Required',
        'Microphone and speech recognition permissions are needed for voice input. Please enable them in Settings.',
      );
      return;
    }

    // If stopListening was called while we were awaiting permission, don't start
    if (stopRequestedRef.current) return;

    const lang = await getSpeechLang();

    SpeechModule.start({
      lang,
      interimResults: true,
      contextualStrings: ['Claude', 'Chroxy'],
    });
    setIsRecognizing(true);
  }, []);

  const stopListening = useCallback(() => {
    stopRequestedRef.current = true;
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
