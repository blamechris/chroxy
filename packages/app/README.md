# @chroxy/app

React Native mobile app for connecting to your Chroxy server.

**Built with:** TypeScript, Expo 54, Zustand, React Navigation

## Development

The app requires a **custom dev build** (not Expo Go) because native modules like `expo-speech-recognition` and `expo-secure-store` are included.

```bash
# Install dependencies
npm install

# Build a dev client (one-time, or when native deps change)
npx expo run:ios    # or npx expo run:android

# Start Metro dev server (for daily hot-reload development)
npx expo start
```

### EAS Cloud Builds

For building in the cloud (no local SDK required):

```bash
npm install -g eas-cli
eas login
eas build --profile development --platform ios   # or android, or all
```

The dev client app replaces Expo Go. Only rebuild when native dependencies change — for normal code changes, hot reload works instantly.

### Running Tests

```bash
npx jest
npx tsc --noEmit   # type check
```

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
│   ├── TerminalView.tsx     # xterm.js terminal emulator (WebView)
│   ├── SettingsBar.tsx      # Collapsible model/cost/context bar
│   ├── InputBar.tsx         # Text input with send/interrupt + mic button
│   ├── SessionPicker.tsx    # Horizontal session tabs
│   ├── CreateSessionModal.tsx # New session + host session discovery
│   └── MarkdownRenderer.tsx # Inline markdown with code blocks
├── hooks/
│   └── useSpeechRecognition.ts # Voice-to-text input hook
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
- **xterm.js terminal** — full VT100 emulation with colors and scrollback via WebView
- **Permission handling** — approve/deny/always-allow tool use
- **Plan mode UI** — plan approval card with approve and give-feedback actions
- **Multi-session** — create, switch, destroy sessions from the app
- **Agent monitoring** — background task tracking with elapsed time badge
- **Voice input** — speech-to-text via `expo-speech-recognition` with interim results
- **Auto-reconnect** — resilient ConnectionPhase state machine
- **Message selection** — long-press to select, copy, or share transcript
- **Push notifications** — alerts for permission prompts and idle sessions
- **End-to-end encryption** — all WebSocket messages encrypted

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
