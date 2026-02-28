// Mock @react-native-async-storage/async-storage (native module not available in Jest)
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key) => Promise.resolve(store[key] ?? null)),
      setItem: jest.fn((key, value) => { store[key] = value; return Promise.resolve(); }),
      removeItem: jest.fn((key) => { delete store[key]; return Promise.resolve(); }),
      multiGet: jest.fn((keys) => Promise.resolve(keys.map((k) => [k, store[k] ?? null]))),
      multiSet: jest.fn((pairs) => { pairs.forEach(([k, v]) => { store[k] = v; }); return Promise.resolve(); }),
      multiRemove: jest.fn((keys) => { keys.forEach((k) => { delete store[k]; }); return Promise.resolve(); }),
      getAllKeys: jest.fn(() => Promise.resolve(Object.keys(store))),
      clear: jest.fn(() => { Object.keys(store).forEach((k) => delete store[k]); return Promise.resolve(); }),
    },
  };
}, { virtual: true });

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

// Mock @expo/vector-icons (native font loading not available in Jest)
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const createIconMock = (name) => {
    const IconComponent = (props) => React.createElement(Text, { testID: `icon-${name}` }, props.name);
    IconComponent.glyphMap = {};
    return IconComponent;
  };
  return {
    Ionicons: createIconMock('Ionicons'),
    MaterialCommunityIcons: createIconMock('MaterialCommunityIcons'),
    FontAwesome: createIconMock('FontAwesome'),
  };
});

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
