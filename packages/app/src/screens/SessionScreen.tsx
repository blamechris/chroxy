import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Keyboard,
  Share,
  Alert,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore, ChatMessage, ConnectionPhase } from '../store/connection';
import { SessionPicker } from '../components/SessionPicker';
import { CreateSessionModal } from '../components/CreateSessionModal';
import { ChatView } from '../components/ChatView';
import { TerminalView } from '../components/TerminalView';
import { SettingsBar } from '../components/SettingsBar';
import { InputBar } from '../components/InputBar';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { ICON_CLOSE, ICON_GEAR } from '../constants/icons';
import { COLORS } from '../constants/colors';


// Enable LayoutAnimation on Android
UIManager.setLayoutAnimationEnabledExperimental?.(true);

function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  React.useEffect(() => {
    const subs: { remove: () => void }[] = [];

    // Show: prefer will (iOS) for smooth animation, did (Android) for reliability
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    subs.push(Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    }));

    // Hide: listen to BOTH will and did on all platforms as a safety net.
    // On some Android/Expo Go configs, keyboardDidHide doesn't fire reliably
    // (e.g. back-button dismiss, swipe gesture). Listening to both ensures
    // at least one fires. Duplicate zero-sets are harmless (React dedupes).
    subs.push(Keyboard.addListener('keyboardWillHide', () => {
      setKeyboardHeight(0);
    }));
    subs.push(Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    }));

    return () => {
      for (const sub of subs) sub.remove();
    };
  }, []);

  return keyboardHeight;
}

/** Shared transcript formatter for copy/share actions */
function formatTranscript(selected: ChatMessage[]): string {
  return selected
    .filter((m) => m.type !== 'thinking')
    .map((m) => {
      const label = m.type === 'user_input' ? 'You'
        : m.type === 'tool_use' ? `Tool: ${m.tool || 'unknown'}`
        : m.type === 'error' ? 'Error'
        : m.type === 'prompt' ? 'Prompt'
        : m.type === 'system' ? 'System'
        : 'Claude';
      return `[${label}] ${m.content?.trim() || ''}`;
    }).join('\n\n');
}

export function SessionScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [inputText, setInputText] = useState('');
  const scrollViewRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();

  const {
    viewMode,
    setViewMode,
    messages,
    terminalBuffer,
    sendInput,
    sendInterrupt,
    disconnect,
    clearTerminalBuffer,
    addUserMessage,
    inputSettings,
    updateInputSettings,
    claudeReady,
    serverMode,
    sessionCwd,
    streamingMessageId,
    isReconnecting,
    connectionPhase,
    activeModel,
    availableModels,
    permissionMode,
    availablePermissionModes,
    contextUsage,
    lastResultCost,
    lastResultDuration,
    claudeStatus,
    setModel,
    setPermissionMode,
    sendPermissionResponse,
  } = useConnectionStore();

  const sessions = useConnectionStore((s) => s.sessions);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const serverErrors = useConnectionStore((s) => s.serverErrors);
  const dismissServerError = useConnectionStore((s) => s.dismissServerError);
  const isCliMode = serverMode === 'cli';
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Determine if the active session has a terminal (PTY sessions do, CLI sessions don't)
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const hasTerminal = !isCliMode || (activeSession?.hasTerminal ?? false);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;
  // Ref so onContentSizeChange always reads the latest value (avoids stale closure)
  const isSelectingRef = useRef(false);
  isSelectingRef.current = isSelecting;

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(messages.map((m) => m.id)));
  }, [messages]);

  const handleCopy = useCallback(async () => {
    const selected = messages.filter((m) => selectedIds.has(m.id));
    const text = formatTranscript(selected);
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert('Copied', `${selected.length} message${selected.length > 1 ? 's' : ''} copied to clipboard`);
      clearSelection();
    } catch (error) {
      console.error('Failed to copy messages to clipboard', error);
      Alert.alert('Copy failed', 'Unable to copy messages to clipboard. Please try again.');
    }
  }, [messages, selectedIds, clearSelection]);

  const handleExport = useCallback(async () => {
    const selected = messages.filter((m) => selectedIds.has(m.id));
    const text = formatTranscript(selected);
    try {
      await Share.share({ message: text });
      clearSelection();
    } catch (error) {
      console.error('Failed to share messages', error);
      Alert.alert('Share failed', 'Unable to share messages. Please try again.');
    }
  }, [messages, selectedIds, clearSelection]);

  const handleSend = () => {
    if (!inputText.trim() || streamingMessageId) return;
    const text = inputText.trim();
    setInputText('');

    if (viewMode === 'chat') {
      // Add user message + thinking indicator with session-aware state update
      addUserMessage(text);
    }

    // PTY sessions: append CR so text + submit arrive as a single atomic write.
    // Sending them separately caused a race condition where multi-line text
    // would sit in the terminal input buffer before the CR arrived.
    // CLI sessions: the server handles the full message directly (no CR needed).
    sendInput(hasTerminal ? text + '\r' : text);
  };

  const handleKeyPress = (key: string) => {
    const keyMap: Record<string, string> = {
      'Enter': '\r',
      'Tab': '\t',
      'Escape': '\x1b',
      'Backspace': '\x7f',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Ctrl+C': '\x03',
      'Ctrl+D': '\x04',
      'Ctrl+Z': '\x1a',
    };
    if (keyMap[key]) {
      sendInput(keyMap[key]);
    }
  };

  // Handle tapping a prompt option
  const handleSelectOption = (value: string, requestId?: string) => {
    if (requestId) {
      // Permission prompt -- send structured response back to server
      sendPermissionResponse(requestId, value);
      return;
    }
    sendInput(hasTerminal ? value + '\r' : value);
  };

  // Check if Enter key should send based on current mode and settings
  const enterToSend = viewMode === 'chat'
    ? inputSettings.chatEnterToSend
    : inputSettings.terminalEnterToSend;

  // Bottom padding: when keyboard is up, use keyboard height + buffer for suggestion bar;
  // otherwise use safe area for Android nav buttons
  const suggestionBarBuffer = Platform.OS === 'android' ? 48 : 0;
  const bottomPadding = keyboardHeight > 0
    ? keyboardHeight + suggestionBarBuffer
    : Math.max(insets.bottom, 12);

  return (
    <View style={styles.container}>
      {/* Session picker (CLI mode with multi-session support) */}
      {isCliMode && sessions.length > 0 && (
        <SessionPicker onCreatePress={() => setShowCreateModal(true)} />
      )}

      {/* Selection bar or view mode toggle */}
      {isSelecting ? (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionCount}>{selectedIds.size} selected</Text>
          <View style={styles.selectionActions}>
            <TouchableOpacity style={styles.selectionButton} onPress={selectAll}>
              <Text style={styles.selectionButtonText}>All</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionButton} onPress={handleCopy}>
              <Text style={styles.selectionButtonText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionButton} onPress={handleExport}>
              <Text style={styles.selectionButtonText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionCancelButton} onPress={clearSelection}>
              <Text style={styles.selectionCancelText}>{ICON_CLOSE}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeButton, viewMode === 'chat' && styles.modeButtonActive]}
            onPress={() => setViewMode('chat')}
          >
            <Text style={[styles.modeButtonText, viewMode === 'chat' && styles.modeButtonTextActive]}>
              Chat
            </Text>
          </TouchableOpacity>
          {hasTerminal && (
            <TouchableOpacity
              style={[styles.modeButton, viewMode === 'terminal' && styles.modeButtonActive]}
              onPress={() => setViewMode('terminal')}
            >
              <Text style={[styles.modeButtonText, viewMode === 'terminal' && styles.modeButtonTextActive]}>
                Terminal
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.settingsButton} onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.settingsButtonText}>{ICON_GEAR}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.disconnectButton} onPress={disconnect}>
            <Text style={styles.disconnectButtonText}>{ICON_CLOSE}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Collapsible settings bar (CLI mode or PTY mode with status data) */}
      {((isCliMode && !activeSession?.hasTerminal && (availableModels.length > 0 || lastResultCost != null || contextUsage)) || (activeSession?.hasTerminal && claudeStatus)) && (
        <SettingsBar
          expanded={settingsExpanded}
          onToggle={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setSettingsExpanded((prev) => !prev);
          }}
          activeModel={activeModel}
          availableModels={availableModels}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          lastResultCost={lastResultCost}
          lastResultDuration={lastResultDuration}
          contextUsage={contextUsage}
          claudeStatus={claudeStatus}
          sessionCwd={sessionCwd}
          serverMode={serverMode}
          setModel={setModel}
          setPermissionMode={setPermissionMode}
        />
      )}

      {/* Reconnecting / restarting banner */}
      {(connectionPhase === 'reconnecting' || connectionPhase === 'server_restarting') && (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>
            {connectionPhase === 'server_restarting' ? 'Server restarting...' : 'Reconnecting...'}
          </Text>
        </View>
      )}

      {/* Server error banners */}
      {serverErrors.map((err) => (
        <View
          key={err.id}
          style={[
            styles.reconnectingBanner,
            err.recoverable ? styles.warningBanner : styles.errorBanner,
          ]}
        >
          <View style={styles.errorBannerContent}>
            <Text
              style={[
                styles.reconnectingText,
                err.recoverable ? styles.warningBannerText : styles.errorBannerText,
              ]}
              numberOfLines={2}
            >
              {err.message}
            </Text>
            <TouchableOpacity
              onPress={() => dismissServerError(err.id)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss server error"
            >
              <Text style={err.recoverable ? styles.warningBannerText : styles.errorBannerText}>
                {ICON_CLOSE}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {/* Content area */}
      {viewMode === 'chat' ? (
        <ChatView
          messages={messages}
          scrollViewRef={scrollViewRef}
          claudeReady={claudeReady}
          onSelectOption={handleSelectOption}
          isCliMode={isCliMode}
          selectedIds={selectedIds}
          isSelecting={isSelecting}
          isSelectingRef={isSelectingRef}
          onToggleSelection={toggleSelection}
          streamingMessageId={streamingMessageId}
        />
      ) : (
        <TerminalView
          content={terminalBuffer}
          scrollViewRef={scrollViewRef}
        />
      )}

      {/* Input area */}
      <InputBar
        inputText={inputText}
        onChangeText={setInputText}
        onSend={handleSend}
        onInterrupt={sendInterrupt}
        onClearTerminal={clearTerminalBuffer}
        onKeyPress={handleKeyPress}
        enterToSend={enterToSend}
        onToggleEnterMode={() => {
          const key = viewMode === 'chat' ? 'chatEnterToSend' : 'terminalEnterToSend';
          updateInputSettings({ [key]: !inputSettings[key] });
        }}
        isStreaming={!!streamingMessageId}
        claudeReady={claudeReady}
        viewMode={viewMode}
        hasTerminal={hasTerminal}
        bottomPadding={bottomPadding}
        disabled={connectionPhase !== 'connected'}
        disabledPlaceholder={connectionPhase === 'server_restarting' ? 'Server restarting...' : 'Reconnecting...'}
      />

      {/* Create session modal */}
      <CreateSessionModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  modeToggle: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  modeButtonActive: {
    backgroundColor: COLORS.accentBlueLight,
  },
  modeButtonText: {
    color: COLORS.textDim,
    fontSize: 14,
  },
  modeButtonTextActive: {
    color: COLORS.accentBlue,
    fontWeight: '600',
  },
  settingsButton: {
    paddingHorizontal: 12,
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
  },
  settingsButtonText: {
    color: COLORS.textMuted,
    fontSize: 16,
  },
  disconnectButton: {
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  disconnectButtonText: {
    color: COLORS.accentRed,
    fontSize: 16,
  },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    paddingHorizontal: 16,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.accentBlueBorder,
  },
  selectionCount: {
    color: COLORS.accentBlue,
    fontSize: 14,
    fontWeight: '600',
  },
  selectionActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  selectionButton: {
    backgroundColor: COLORS.accentBlueLight,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
  },
  selectionButtonText: {
    color: COLORS.accentBlue,
    fontSize: 13,
    fontWeight: '600',
  },
  selectionCancelButton: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  selectionCancelText: {
    color: COLORS.accentRed,
    fontSize: 16,
  },
  reconnectingBanner: {
    backgroundColor: COLORS.accentOrangeMedium,
    paddingVertical: 6,
    alignItems: 'center',
  },
  reconnectingText: {
    color: COLORS.accentOrange,
    fontSize: 13,
    fontWeight: '600',
  },
  warningBanner: {
    backgroundColor: COLORS.accentOrangeSubtle,
  },
  errorBanner: {
    backgroundColor: COLORS.accentRedSubtle,
  },
  errorBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    width: '100%',
  },
  warningBannerText: {
    color: COLORS.accentOrange,
    fontSize: 12,
    fontWeight: '600',
  },
  errorBannerText: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontWeight: '600',
  },
});
