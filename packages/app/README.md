# @chroxy/app

React Native mobile app for connecting to your Chroxy server.

**Built with:** TypeScript, Expo 54, Zustand, React Navigation

## Development

```bash
# Install dependencies
npm install

# Start Expo dev server
npx expo start

# Run on iOS simulator
npm run ios

# Run on Android emulator
npm run android
```

### Testing with Expo Go

The fastest way to test on a physical device:

1. Install Expo Go from the App Store / Play Store
2. Run `npx expo start`
3. Scan the Expo dev server QR code with Expo Go
4. The app will hot-reload as you make changes

**Note:** Push notifications are not available in Expo Go (removed in SDK 53). The app gracefully degrades — notifications work in production/dev client builds.

## Architecture

```
src/
├── App.tsx                  # Root component with navigation
├── screens/
│   ├── ConnectScreen.tsx    # QR scan / manual connection
│   ├── SessionScreen.tsx    # Chat + Terminal dual-view
│   └── SettingsScreen.tsx   # Model, permission, display settings
├── components/
│   ├── ChatView.tsx         # Message list with markdown rendering
│   ├── TerminalView.tsx     # Raw terminal output display
│   ├── SettingsBar.tsx      # Collapsible model/cost/context bar
│   ├── InputBar.tsx         # Text input with send/interrupt
│   ├── SessionPicker.tsx    # Horizontal session tabs
│   ├── CreateSessionModal.tsx # New session + host session discovery
│   └── MarkdownRenderer.tsx # Inline markdown with code blocks
├── constants/
│   ├── colors.ts            # Theme color constants
│   └── icons.ts             # Unicode icon constants
├── store/
│   └── connection.ts        # Zustand store (ConnectionPhase state machine)
└── notifications.ts         # Push notification registration
```

## Key Features

- **QR code scanning** for quick server connection
- **Chat view** with markdown, code highlighting, blockquotes, links
- **Permission handling** — approve/deny/always-allow tool use
- **Multi-session** — create, switch, destroy sessions from the app
- **Agent monitoring** — background task tracking with elapsed time
- **Auto-reconnect** — resilient ConnectionPhase state machine
- **Message selection** — long-press to select, copy, or share transcript

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
