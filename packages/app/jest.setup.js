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
