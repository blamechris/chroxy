import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

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
  const [isAvailable, setIsAvailable] = useState(true);

  useEffect(() => {
    setIsAvailable(ExpoSpeechRecognitionModule.isRecognitionAvailable());
  }, []);

  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript;
    if (text) {
      setTranscript(text);
    }
  });

  useSpeechRecognitionEvent('end', () => {
    setIsRecognizing(false);
  });

  useSpeechRecognitionEvent('error', (event) => {
    // Don't treat abort as a user-visible error
    if (event.error !== 'aborted') {
      setError(event.message || event.error);
    }
    setIsRecognizing(false);
  });

  // Abort on unmount
  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  // Track whether a stop was requested during async permission flow
  const stopRequestedRef = useRef(false);

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript('');
    stopRequestedRef.current = false;

    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      Alert.alert(
        'Permissions Required',
        'Microphone and speech recognition permissions are needed for voice input. Please enable them in Settings.',
      );
      return;
    }

    // If stopListening was called while we were awaiting permission, don't start
    if (stopRequestedRef.current) return;

    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      contextualStrings: ['Claude', 'Chroxy'],
    });
    setIsRecognizing(true);
  }, []);

  const stopListening = useCallback(() => {
    stopRequestedRef.current = true;
    ExpoSpeechRecognitionModule.stop();
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
