// Mock expo-speech-recognition (native module not available in Jest)
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn(() => false),
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

// Mock expo-image-picker (native module not available in Jest)
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchCameraAsync: jest.fn(() => Promise.resolve({ canceled: true })),
  launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: true })),
}));

// Mock expo-document-picker (native module not available in Jest)
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(() => Promise.resolve({ canceled: true })),
}));

// Mock expo-file-system (native module not available in Jest)
jest.mock('expo-file-system', () => ({
  readAsStringAsync: jest.fn(() => Promise.resolve('')),
}));

// Mock react-native-webview (native module not available in Jest)
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  const WebView = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      injectJavaScript: jest.fn(),
    }));
    return React.createElement(View, { testID: 'webview', ...props });
  });
  WebView.displayName = 'WebView';
  return { WebView };
});
