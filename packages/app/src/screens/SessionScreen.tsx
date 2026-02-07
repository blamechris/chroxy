import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
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
import { useConnectionStore, ChatMessage } from '../store/connection';

// Named Unicode constants for readability
const ICON_CLOSE = '\u2715';       // Multiplication X
const ICON_CHEVRON_RIGHT = '\u25B8'; // Right-pointing triangle
const ICON_CHEVRON_DOWN = '\u25BE';  // Down-pointing triangle

// Enable LayoutAnimation on Android
UIManager.setLayoutAnimationEnabledExperimental?.(true);

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

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
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
    updateInputSettings,
    claudeReady,
    serverMode,
    streamingMessageId,
    isReconnecting,
    activeModel,
    availableModels,
    contextUsage,
    setModel,
  } = useConnectionStore();

  const isCliMode = serverMode === 'cli';

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;

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

  const handleCopy = useCallback(async () => {
    const selected = messages.filter((m) => selectedIds.has(m.id));
    const text = selected.map((m) => {
      const label = m.type === 'user_input' ? 'You' : m.type === 'tool_use' ? `Tool: ${m.tool}` : 'Claude';
      return `[${label}] ${m.content?.trim() || ''}`;
    }).join('\n\n');
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
    const json = JSON.stringify(selected, null, 2);
    try {
      await Share.share({ message: json });
      clearSelection();
    } catch (error) {
      console.error('Failed to export messages', error);
      Alert.alert('Export failed', 'Unable to share messages. Please try again.');
    }
  }, [messages, selectedIds, clearSelection]);

  const handleSend = () => {
    if (!inputText.trim() || streamingMessageId) return;
    const text = inputText.trim();
    setInputText('');

    if (viewMode === 'chat') {
      // Show user message instantly in chat
      addMessage({
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  // Handle tapping a prompt option
  const handleSelectOption = (value: string) => {
    sendInput(value);
    // In PTY mode, send Enter separately — the TUI needs text and CR as separate writes
    if (!isCliMode) {
      setTimeout(() => sendInput('\r'), 50);
    }
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
      {/* Selection bar or view mode toggle */}
      {isSelecting ? (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionCount}>{selectedIds.size} selected</Text>
          <View style={styles.selectionActions}>
            <TouchableOpacity style={styles.selectionButton} onPress={handleCopy}>
              <Text style={styles.selectionButtonText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionButton} onPress={handleExport}>
              <Text style={styles.selectionButtonText}>Export</Text>
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
            <Text style={styles.disconnectButtonText}>{ICON_CLOSE}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Status bar: model selector + context usage */}
      {isCliMode && availableModels.length > 0 && (
        <View style={styles.statusBar}>
          <View style={styles.modelSelector}>
            {availableModels.map((m) => {
              const isActive = activeModel === m.id || activeModel === m.fullId;
              return (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.modelChip, isActive && styles.modelChipActive]}
                  onPress={() => setModel(m.id)}
                >
                  <Text style={[styles.modelChipText, isActive && styles.modelChipTextActive]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {contextUsage && (
            <View style={styles.contextInfo}>
              <Text style={styles.contextText}>
                {formatTokenCount(contextUsage.inputTokens + contextUsage.outputTokens)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Reconnecting banner */}
      {isReconnecting && (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>Reconnecting...</Text>
        </View>
      )}

      {/* Content area */}
      {viewMode === 'chat' ? (
        <ChatView messages={messages} scrollViewRef={scrollViewRef} claudeReady={claudeReady} onSelectOption={handleSelectOption} isCliMode={isCliMode} selectedIds={selectedIds} isSelecting={isSelecting} onToggleSelection={toggleSelection} />
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
          <TouchableOpacity
            style={styles.enterModeToggle}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={enterToSend ? 'Enter key sends message. Tap to switch to newline mode.' : 'Enter key inserts newline. Tap to switch to send mode.'}
            onPress={() => {
              const key = viewMode === 'chat' ? 'chatEnterToSend' : 'terminalEnterToSend';
              updateInputSettings({ [key]: !inputSettings[key] });
            }}
          >
            <Text style={styles.enterModeText}>{enterToSend ? '\u21B5' : '\u00B6'}</Text>
          </TouchableOpacity>
          <TextInput
            style={[styles.input, !enterToSend && styles.inputMultiline]}
            placeholder={!claudeReady ? 'Connecting to Claude...' : 'Message Claude...'}
            placeholderTextColor="#666"
            value={inputText}
            onChangeText={setInputText}
            // When enterToSend is true, multiline is false and onSubmitEditing fires on Enter.
            // When enterToSend is false, multiline is true so onSubmitEditing never fires.
            onSubmitEditing={enterToSend && !streamingMessageId ? handleSend : undefined}
            blurOnSubmit={false}
            multiline={!enterToSend}
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
  selectedIds,
  isSelecting,
  onToggleSelection,
}: {
  messages: ChatMessage[];
  scrollViewRef: React.RefObject<ScrollView>;
  claudeReady: boolean;
  onSelectOption: (value: string) => void;
  isCliMode: boolean;
  selectedIds: Set<string>;
  isSelecting: boolean;
  onToggleSelection: (id: string) => void;
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
          <MessageBubble
            key={msg.id}
            message={msg}
            onSelectOption={onSelectOption}
            isSelected={selectedIds.has(msg.id)}
            isSelecting={isSelecting}
            onLongPress={() => onToggleSelection(msg.id)}
            onPress={() => onToggleSelection(msg.id)}
          />
        ))
      )}
    </ScrollView>
  );
}

// Collapsible tool use bubble
function ToolBubble({ message, isSelected, isSelecting, onLongPress, onPress }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressedRef = useRef(false);
  const content = message.content?.trim();

  // Hide empty tool messages
  if (!content) return null;

  const handlePress = () => {
    // Suppress onPress that fires after a long-press gesture
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) {
      onPress();
    } else {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded((prev) => !prev);
    }
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onLongPress();
  };

  const preview = content.length > 60 ? content.slice(0, 60) + '...' : content;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={[styles.toolBubble, isSelected && styles.selectedBubble]}
    >
      <View style={styles.toolHeader}>
        <Text style={styles.toolChevron}>{expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</Text>
        <Text style={styles.senderLabelTool}>Tool: {message.tool}</Text>
      </View>
      {expanded ? (
        <Text selectable style={styles.toolContentExpanded}>{content}</Text>
      ) : (
        <Text style={styles.toolContentCollapsed} numberOfLines={1}>{preview}</Text>
      )}
    </TouchableOpacity>
  );
}

// Single message bubble
function MessageBubble({ message, onSelectOption, isSelected, isSelecting, onLongPress, onPress }: {
  message: ChatMessage;
  onSelectOption?: (value: string) => void;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
}) {
  const isUser = message.type === 'user_input';
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';
  const isError = message.type === 'error';

  if (isThinking) {
    return (
      <View style={styles.thinkingBubble}>
        <Text style={styles.thinkingText}>Thinking...</Text>
      </View>
    );
  }

  if (isTool) {
    return (
      <ToolBubble
        message={message}
        isSelected={isSelected}
        isSelecting={isSelecting}
        onLongPress={onLongPress}
        onPress={onPress}
      />
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={isSelecting ? onPress : undefined}
      onLongPress={isSelecting ? undefined : onLongPress}
      style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSelected && styles.selectedBubble]}
    >
      <Text style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : isError ? styles.senderLabelError : styles.senderLabelClaude}>
        {isUser ? 'You' : isPrompt ? 'Action Required' : isError ? 'Error' : 'Claude'}
      </Text>
      <Text selectable style={[styles.messageText, isUser && styles.userMessageText, isError && styles.errorMessageText]}>
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
    </TouchableOpacity>
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
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    paddingHorizontal: 16,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#4a9eff44',
  },
  selectionCount: {
    color: '#4a9eff',
    fontSize: 14,
    fontWeight: '600',
  },
  selectionActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  selectionButton: {
    backgroundColor: '#4a9eff22',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4a9eff44',
  },
  selectionButtonText: {
    color: '#4a9eff',
    fontSize: 13,
    fontWeight: '600',
  },
  selectionCancelButton: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  selectionCancelText: {
    color: '#ff4a4a',
    fontSize: 16,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4e',
  },
  modelSelector: {
    flexDirection: 'row',
    gap: 6,
  },
  modelChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#2a2a4e',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modelChipActive: {
    backgroundColor: '#4a9eff33',
    borderColor: '#4a9eff66',
  },
  modelChipText: {
    color: '#666',
    fontSize: 12,
    fontWeight: '500',
  },
  modelChipTextActive: {
    color: '#4a9eff',
  },
  contextInfo: {
    paddingHorizontal: 8,
  },
  contextText: {
    color: '#888',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
  errorBubble: {
    backgroundColor: '#ff4a4a11',
    borderColor: '#ff4a4a44',
    borderWidth: 1,
  },
  senderLabelError: {
    color: '#ff4a4a',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  errorMessageText: {
    color: '#e8a0a0',
  },
  selectedBubble: {
    borderColor: '#4a9eff',
    borderWidth: 2,
  },
  toolBubble: {
    backgroundColor: '#16162a',
    padding: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 8,
    maxWidth: '85%',
    borderWidth: 1,
    borderColor: '#2a2a4e',
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toolChevron: {
    color: '#888',
    fontSize: 10,
  },
  senderLabelTool: {
    color: '#a78bfa',
    fontSize: 11,
    fontWeight: '600',
  },
  toolContentCollapsed: {
    color: '#888',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  toolContentExpanded: {
    color: '#ccc',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6,
    lineHeight: 18,
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
    alignItems: 'center',
  },
  enterModeToggle: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  enterModeText: {
    color: '#555',
    fontSize: 16,
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
  inputMultiline: {
    maxHeight: 100,
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
