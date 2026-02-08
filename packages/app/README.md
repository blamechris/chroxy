# @chroxy/app

React Native mobile app for connecting to your Chroxy server.

## Development

```bash
# Install dependencies
npm install

# Start Expo dev server
npm start

# Run on iOS simulator
npm run ios

# Run on Android emulator
npm run android
```

## Building for Release

### iOS (TestFlight)

```bash
eas build --platform ios
eas submit --platform ios
```

### Android (Play Store)

```bash
eas build --platform android
eas submit --platform android
```

## Architecture

```
src/
├── App.tsx              # Root component with navigation
├── screens/
│   ├── ConnectScreen    # QR scan / manual connection
│   └── SessionScreen    # Chat + Terminal views
├── components/          # Reusable UI components
├── hooks/               # Custom hooks
└── store/
    └── connection.ts    # Zustand store for app state
```

## TODO

- [x] Implement QR code scanning with expo-camera
- [x] Implement markdown rendering for chat messages
- [x] Connection persistence (save last server)
- [ ] Add xterm.js WebView for proper terminal emulation
- [ ] Add syntax highlighting for code blocks in chat
- [ ] Push notifications for long-running tasks
- [ ] Haptic feedback
- [ ] Session history and search
