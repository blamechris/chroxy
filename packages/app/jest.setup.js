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
