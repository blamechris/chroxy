import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert } from 'react-native';

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

  useSpeechEvent('result', (event: any) => {
    const text = event.results[0]?.transcript;
    if (text) {
      setTranscript(text);
    }
  });

  useSpeechEvent('end', () => {
    setIsRecognizing(false);
  });

  useSpeechEvent('error', (event: any) => {
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

    SpeechModule.start({
      lang: 'en-US',
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
