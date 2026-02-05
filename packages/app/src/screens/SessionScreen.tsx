import React, { useState, useRef, useEffect } from 'react';
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
    disconnect,
  } = useConnectionStore();

  const handleSend = () => {
    if (!inputText.trim()) return;
    sendInput(inputText + '\n');
    setInputText('');
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
            💬 Chat
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeButton, viewMode === 'terminal' && styles.modeButtonActive]}
          onPress={() => setViewMode('terminal')}
        >
          <Text style={[styles.modeButtonText, viewMode === 'terminal' && styles.modeButtonTextActive]}>
            🖥️ Terminal
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.disconnectButton} onPress={disconnect}>
          <Text style={styles.disconnectButtonText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Content area */}
      {viewMode === 'chat' ? (
        <ChatView messages={messages} scrollViewRef={scrollViewRef} />
      ) : (
        <TerminalView
          content={terminalBuffer}
          scrollViewRef={scrollViewRef}
          onKeyPress={handleKeyPress}
        />
      )}

      {/* Input area */}
      <View style={[styles.inputContainer, { paddingBottom: bottomPadding }]}>
        {viewMode === 'terminal' && (
          <View style={styles.specialKeys}>
            {['Ctrl+C', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].map((key) => (
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
          </View>
        )}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder={viewMode === 'chat' ? 'Message Claude...' : 'Type command...'}
            placeholderTextColor="#666"
            value={inputText}
            onChangeText={setInputText}
            blurOnSubmit={false}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSend}>
            <Text style={styles.sendButtonText}>↑</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// Chat view component
function ChatView({
  messages,
  scrollViewRef,
}: {
  messages: ChatMessage[];
  scrollViewRef: React.RefObject<ScrollView>;
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
            Connected! Waiting for messages...
          </Text>
        </View>
      ) : (
        messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))
      )}
    </ScrollView>
  );
}

// Single message bubble
function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.type === 'user_input';
  const isTool = message.type === 'tool_use';

  return (
    <View style={[styles.messageBubble, isUser && styles.userBubble]}>
      {isTool && (
        <View style={styles.toolBadge}>
          <Text style={styles.toolBadgeText}>🔧 {message.tool}</Text>
        </View>
      )}
      <Text style={styles.messageText}>{message.content}</Text>
    </View>
  );
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
  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.terminalContainer}
      contentContainerStyle={styles.terminalContent}
      onContentSizeChange={() => scrollViewRef.current?.scrollToEnd()}
    >
      <Text style={styles.terminalText}>{content || 'Connected. Terminal output will appear here...'}</Text>
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
  toolBadge: {
    backgroundColor: '#22c55e22',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  toolBadgeText: {
    color: '#22c55e',
    fontSize: 12,
    fontWeight: '600',
  },
  messageText: {
    color: '#e0e0e0',
    fontSize: 15,
    lineHeight: 22,
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
});
