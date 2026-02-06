import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore, ChatMessage } from '../store/connection';

function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return keyboardHeight;
}

export function SessionScreen() {
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
    addMessage,
    inputSettings,
    claudeReady,
    serverMode,
    streamingMessageId,
    isReconnecting,
  } = useConnectionStore();

  const isCliMode = serverMode === 'cli';

  const handleSend = () => {
    if (!inputText.trim()) return;
    const text = inputText.trim();
    setInputText('');

    if (viewMode === 'chat') {
      // Show user message instantly in chat
      addMessage({
        id: `${Date.now()}-${Math.random()}`,
        type: 'user_input',
        content: text,
        timestamp: Date.now(),
      });
      // Show thinking indicator until response arrives
      addMessage({
        id: 'thinking',
        type: 'thinking',
        content: '',
        timestamp: Date.now(),
      });
    }

    sendInput(text);
    // In terminal mode, send Enter separately — Claude Code's TUI needs text and CR as separate writes
    // In CLI mode, the server handles the full message directly
    if (!isCliMode) {
      setTimeout(() => sendInput('\r'), 50);
    }
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

  // Handle tapping a prompt option (sends the value to PTY)
  const handleSelectOption = (value: string) => {
    sendInput(value);
    setTimeout(() => sendInput('\r'), 50);
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
      {/* View mode toggle */}
      <View style={styles.modeToggle}>
        <TouchableOpacity
          style={[styles.modeButton, viewMode === 'chat' && styles.modeButtonActive]}
          onPress={() => setViewMode('chat')}
        >
          <Text style={[styles.modeButtonText, viewMode === 'chat' && styles.modeButtonTextActive]}>
            Chat
          </Text>
        </TouchableOpacity>
        {!isCliMode && (
          <TouchableOpacity
            style={[styles.modeButton, viewMode === 'terminal' && styles.modeButtonActive]}
            onPress={() => setViewMode('terminal')}
          >
            <Text style={[styles.modeButtonText, viewMode === 'terminal' && styles.modeButtonTextActive]}>
              Terminal
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.disconnectButton} onPress={disconnect}>
          <Text style={styles.disconnectButtonText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Reconnecting banner */}
      {isReconnecting && (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>Reconnecting...</Text>
        </View>
      )}

      {/* Content area */}
      {viewMode === 'chat' ? (
        <ChatView messages={messages} scrollViewRef={scrollViewRef} claudeReady={claudeReady} onSelectOption={handleSelectOption} isCliMode={isCliMode} />
      ) : (
        <TerminalView
          content={terminalBuffer}
          scrollViewRef={scrollViewRef}
          onKeyPress={handleKeyPress}
        />
      )}

      {/* Input area */}
      <View style={[styles.inputContainer, { paddingBottom: bottomPadding }]}>
        {viewMode === 'terminal' && !isCliMode && (
          <View style={styles.specialKeys}>
            {['Enter', 'Ctrl+C', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].map((key) => (
              <TouchableOpacity
                key={key}
                style={styles.specialKey}
                onPress={() => handleKeyPress(key)}
              >
                <Text style={styles.specialKeyText}>
                  {key.replace('Arrow', '').replace('Ctrl+', '^')}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.specialKey}
              onPress={clearTerminalBuffer}
            >
              <Text style={styles.specialKeyText}>Clear</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder={!claudeReady ? 'Connecting to Claude...' : 'Message Claude...'}
            placeholderTextColor="#666"
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={enterToSend ? handleSend : undefined}
            blurOnSubmit={false}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {streamingMessageId ? (
            <TouchableOpacity style={styles.interruptButton} onPress={sendInterrupt}>
              <Text style={styles.interruptButtonText}>■</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sendButton} onPress={handleSend}>
              <Text style={styles.sendButtonText}>↑</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// Chat view component
function ChatView({
  messages,
  scrollViewRef,
  claudeReady,
  onSelectOption,
  isCliMode,
}: {
  messages: ChatMessage[];
  scrollViewRef: React.RefObject<ScrollView>;
  claudeReady: boolean;
  onSelectOption: (value: string) => void;
  isCliMode: boolean;
}) {
  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.chatContainer}
      contentContainerStyle={styles.chatContent}
      onContentSizeChange={() => scrollViewRef.current?.scrollToEnd()}
    >
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>
            {claudeReady
              ? 'Connected. Send a message to Claude!'
              : isCliMode
                ? 'Connecting...'
                : 'Starting Claude Code...'}
          </Text>
        </View>
      ) : (
        messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onSelectOption={onSelectOption} />
        ))
      )}
    </ScrollView>
  );
}

// Single message bubble
function MessageBubble({ message, onSelectOption }: { message: ChatMessage; onSelectOption?: (value: string) => void }) {
  const isUser = message.type === 'user_input';
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';

  if (isThinking) {
    return (
      <View style={styles.thinkingBubble}>
        <Text style={styles.thinkingText}>Thinking...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble]}>
      <Text style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : styles.senderLabelClaude}>
        {isUser ? 'You' : isTool ? `Tool: ${message.tool}` : isPrompt ? 'Action Required' : 'Claude'}
      </Text>
      <Text selectable style={[styles.messageText, isUser && styles.userMessageText]}>
        {message.content?.trim()}
      </Text>
      {isPrompt && message.options && (
        <View style={styles.promptOptions}>
          {message.options.map((opt, i) => (
            <TouchableOpacity
              key={i}
              style={styles.promptOptionButton}
              onPress={() => onSelectOption?.(opt.value)}
            >
              <Text style={styles.promptOptionText}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Process raw terminal buffer for plain-text display.
 * Handles \r\n line endings and standalone \r (carriage return)
 * which overwrites the current line in a real terminal.
 */
function processTerminalBuffer(buffer: string): string {
  // Normalize \r\n to \n first
  let text = buffer.replace(/\r\n/g, '\n');
  // For each line, keep only content after the last \r (simulates CR overwrite)
  return text
    .split('\n')
    .map((line) => {
      const lastCR = line.lastIndexOf('\r');
      return lastCR >= 0 ? line.substring(lastCR + 1) : line;
    })
    .join('\n');
}

// Terminal view component
function TerminalView({
  content,
  scrollViewRef,
  onKeyPress,
}: {
  content: string;
  scrollViewRef: React.RefObject<ScrollView>;
  onKeyPress: (key: string) => void;
}) {
  const processed = useMemo(() => processTerminalBuffer(content), [content]);

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.terminalContainer}
      contentContainerStyle={styles.terminalContent}
      onContentSizeChange={() => scrollViewRef.current?.scrollToEnd()}
    >
      <Text style={styles.terminalText}>{processed || 'Connected. Terminal output will appear here...'}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  modeToggle: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4e',
  },
  modeButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  modeButtonActive: {
    backgroundColor: '#4a9eff22',
  },
  modeButtonText: {
    color: '#666',
    fontSize: 14,
  },
  modeButtonTextActive: {
    color: '#4a9eff',
    fontWeight: '600',
  },
  disconnectButton: {
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  disconnectButtonText: {
    color: '#ff4a4a',
    fontSize: 16,
  },
  reconnectingBanner: {
    backgroundColor: '#f59e0b33',
    paddingVertical: 6,
    alignItems: 'center',
  },
  reconnectingText: {
    color: '#f59e0b',
    fontSize: 13,
    fontWeight: '600',
  },

  // Chat styles
  chatContainer: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 24,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
  },
  emptyStateText: {
    color: '#666',
    fontSize: 16,
  },
  messageBubble: {
    backgroundColor: '#1a1a2e',
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '85%',
  },
  userBubble: {
    backgroundColor: '#4a9eff22',
    alignSelf: 'flex-end',
    borderColor: '#4a9eff44',
    borderWidth: 1,
  },
  thinkingBubble: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  thinkingText: {
    color: '#666',
    fontSize: 13,
    fontStyle: 'italic',
  },
  senderLabelUser: {
    color: '#4a9eff',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelClaude: {
    color: '#22c55e',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelPrompt: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  promptBubble: {
    backgroundColor: '#f59e0b11',
    borderColor: '#f59e0b44',
    borderWidth: 1,
    maxWidth: '95%',
  },
  promptOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  promptOptionButton: {
    backgroundColor: '#f59e0b33',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f59e0b66',
  },
  promptOptionText: {
    color: '#f59e0b',
    fontSize: 14,
    fontWeight: '600',
  },
  messageText: {
    color: '#e0e0e0',
    fontSize: 15,
    lineHeight: 22,
  },
  userMessageText: {
    color: '#fff',
  },

  // Terminal styles
  terminalContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  terminalContent: {
    padding: 12,
  },
  terminalText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#00ff00',
    lineHeight: 16,
  },

  // Input styles
  inputContainer: {
    borderTopWidth: 1,
    borderTopColor: '#2a2a4e',
    backgroundColor: '#1a1a2e',
  },
  specialKeys: {
    flexDirection: 'row',
    padding: 8,
    gap: 8,
  },
  specialKey: {
    backgroundColor: '#2a2a4e',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  specialKeyText: {
    color: '#888',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    paddingTop: 4,
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 16,
  },
  sendButton: {
    backgroundColor: '#4a9eff',
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  interruptButton: {
    backgroundColor: '#ff4a4a',
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  interruptButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
