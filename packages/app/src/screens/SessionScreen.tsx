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
import { useConnectionStore, ChatMessage, ModelInfo } from '../store/connection';
import { SessionPicker } from '../components/SessionPicker';
import { CreateSessionModal } from '../components/CreateSessionModal';

// Named Unicode constants for readability
const ICON_CLOSE = '\u2715';       // Multiplication X
const ICON_CHEVRON_RIGHT = '\u25B8'; // Right-pointing triangle
const ICON_CHEVRON_DOWN = '\u25BE';  // Down-pointing triangle
// ===== Lightweight Markdown Renderer =====

type ContentBlock =
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'text'; content: string };

/** Split content into alternating text and fenced code blocks.
 *  Code fences must start at the beginning of a line — triple backticks
 *  inside prose (e.g. "Code blocks (```)") are NOT treated as fences. */
function splitContentBlocks(rawContent: string): ContentBlock[] {
  // Normalize CRLF → LF so fence regex works on all line endings
  const content = rawContent.replace(/\r\n/g, '\n');
  const blocks: ContentBlock[] = [];
  // Require ``` at line start (or string start), followed by optional language + newline.
  // Closing fence uses lookahead so the \n isn't consumed — allows consecutive code blocks.
  const regex = /(?:^|\n)```(\w*)\n([\s\S]*?)(?:\n```(?=\s*\n|$)|$)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // Adjust: if we matched a leading \n, the fence starts 1 char into the match
    const fenceStart = content[match.index] === '\n' ? match.index + 1 : match.index;
    if (fenceStart > lastIndex) {
      const text = content.slice(lastIndex, fenceStart).trim();
      if (text) blocks.push({ kind: 'text', content: text });
    }
    const code = match[2].trimEnd();
    if (code) blocks.push({ kind: 'code', lang: match[1] || '', content: code });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) blocks.push({ kind: 'text', content: text });
  }

  return blocks;
}

/** Render inline markdown: **bold** and `code` within a line */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|`([^`\n]+)`)/g;
  let lastIdx = 0;
  let key = 0;
  let m;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    if (m[2]) {
      parts.push(<Text key={`${keyBase}-b${key++}`} style={md.bold}>{m[2]}</Text>);
    } else if (m[3]) {
      parts.push(<Text key={`${keyBase}-c${key++}`} style={md.inlineCode}>{m[3]}</Text>);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

/** Render a text block with headers, lists, bold, and inline code.
 *  Splits on blank lines into separate paragraphs with visible spacing. */
function FormattedTextBlock({ text, keyBase }: { text: string; keyBase: string }) {
  // Split into paragraphs on blank lines for visual spacing
  const paragraphs = text.split(/\n{2,}/);
  const paraElements: React.ReactNode[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p].trim();
    if (!para) continue;

    const lines = para.split('\n');
    const elements: React.ReactNode[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lk = `${keyBase}-P${p}-L${i}`;
      if (i > 0) elements.push('\n');

      if (!line.trim()) continue;

      // Header: # ## ###
      const hm = line.match(/^(#{1,3})\s+(.+)/);
      if (hm) {
        const lvl = hm[1].length;
        const hStyle = lvl === 1 ? md.h1 : lvl === 2 ? md.h2 : md.h3;
        elements.push(<Text key={lk} style={hStyle}>{renderInline(hm[2], lk)}</Text>);
        continue;
      }

      // Task list: - [x] or - [ ]
      const tlm = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)/);
      if (tlm) {
        const checked = tlm[2].toLowerCase() === 'x';
        elements.push(<Text key={lk}>{checked ? '  \u2611 ' : '  \u2610 '}{renderInline(tlm[3], lk)}</Text>);
        continue;
      }

      // Unordered list: - or *
      const ulm = line.match(/^(\s*)[-*]\s+(.+)/);
      if (ulm) {
        elements.push(<Text key={lk}>{'  \u2022 '}{renderInline(ulm[2], lk)}</Text>);
        continue;
      }

      // Ordered list: 1. 2. etc
      const olm = line.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (olm) {
        elements.push(<Text key={lk}>{'  '}{olm[2]}{'. '}{renderInline(olm[3], lk)}</Text>);
        continue;
      }

      // Regular line with inline formatting
      elements.push(...renderInline(line, lk));
    }

    if (elements.length > 0) {
      paraElements.push(
        <Text key={`${keyBase}-P${p}`} selectable style={styles.messageText}>
          {elements}
        </Text>
      );
    }
  }

  // Single paragraph — no wrapper needed
  if (paraElements.length <= 1) return <>{paraElements}</>;

  return <View style={md.paragraphs}>{paraElements}</View>;
}

/** Formatted response — renders Claude's markdown as styled blocks */
function FormattedResponse({ content }: { content: string }) {
  const blocks = useMemo(() => splitContentBlocks(content.trim()), [content]);

  if (blocks.length === 0) return null;

  return (
    <View style={md.container}>
      {blocks.map((block, i) => {
        if (block.kind === 'code') {
          return (
            <View key={`b${i}`} style={md.codeBlock}>
              {block.lang ? <Text style={md.codeLang}>{block.lang}</Text> : null}
              <Text selectable style={md.codeText}>{block.content}</Text>
            </View>
          );
        }
        return <FormattedTextBlock key={`b${i}`} text={block.content} keyBase={`b${i}`} />;
      })}
    </View>
  );
}

const md = StyleSheet.create({
  container: {
    gap: 8,
  },
  paragraphs: {
    gap: 10,
  },
  bold: {
    fontWeight: '700',
  },
  inlineCode: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: '#2a2a4e',
    fontSize: 13,
  },
  h1: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f0f0f0',
    lineHeight: 24,
  },
  h2: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e8e8e8',
    lineHeight: 22,
  },
  h3: {
    fontSize: 15,
    fontWeight: '600',
    color: '#e0e0e0',
    lineHeight: 22,
  },
  codeBlock: {
    backgroundColor: '#0a0a18',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#2a2a4e',
  },
  codeLang: {
    color: '#666',
    fontSize: 10,
    marginBottom: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    textTransform: 'uppercase',
  },
  codeText: {
    color: '#a0d0ff',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
});

// Enable LayoutAnimation on Android
UIManager.setLayoutAnimationEnabledExperimental?.(true);

function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
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
    permissionMode,
    availablePermissionModes,
    contextUsage,
    lastResultCost,
    lastResultDuration,
    setModel,
    setPermissionMode,
    sendPermissionResponse,
  } = useConnectionStore();

  const sessions = useConnectionStore((s) => s.sessions);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const isCliMode = serverMode === 'cli';
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Determine if the active session has a terminal (PTY sessions do, CLI sessions don't)
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const hasTerminal = !isCliMode || (activeSession?.hasTerminal ?? false);

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
      // Add user message + thinking indicator in a single atomic state update
      // to prevent React state batching from dropping the user message (#4)
      useConnectionStore.setState((state) => ({
        messages: [
          ...state.messages.filter((m) => m.id !== 'thinking'),
          { id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'user_input' as const, content: text, timestamp: Date.now() },
          { id: 'thinking', type: 'thinking' as const, content: '', timestamp: Date.now() },
        ],
      }));
    }

    sendInput(text);
    // PTY sessions: send Enter separately — Claude Code's TUI needs text and CR as separate writes
    // CLI sessions: the server handles the full message directly
    if (hasTerminal) {
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
  const handleSelectOption = (value: string, requestId?: string) => {
    if (requestId) {
      // Permission prompt — send structured response back to server
      sendPermissionResponse(requestId, value);
      return;
    }
    sendInput(value);
    // PTY sessions: send Enter separately — the TUI needs text and CR as separate writes
    if (hasTerminal) {
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
      {/* Session picker (CLI mode with multi-session support) */}
      {isCliMode && sessions.length > 0 && (
        <SessionPicker onCreatePress={() => setShowCreateModal(true)} />
      )}

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
          <TouchableOpacity style={styles.disconnectButton} onPress={disconnect}>
            <Text style={styles.disconnectButtonText}>{ICON_CLOSE}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Collapsible settings bar (CLI mode only, when model/permission data is available) */}
      {isCliMode && !activeSession?.hasTerminal && (availableModels.length > 0 || lastResultCost != null || contextUsage) && (
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
          setModel={setModel}
          setPermissionMode={setPermissionMode}
        />
      )}

      {/* Reconnecting banner */}
      {isReconnecting && (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>Reconnecting...</Text>
        </View>
      )}

      {/* Content area */}
      {viewMode === 'chat' ? (
        <ChatView messages={messages} scrollViewRef={scrollViewRef} claudeReady={claudeReady} onSelectOption={handleSelectOption} isCliMode={isCliMode} selectedIds={selectedIds} isSelecting={isSelecting} onToggleSelection={toggleSelection} streamingMessageId={streamingMessageId} />
      ) : (
        <TerminalView
          content={terminalBuffer}
          scrollViewRef={scrollViewRef}
          onKeyPress={handleKeyPress}
        />
      )}

      {/* Input area */}
      <View style={[styles.inputContainer, { paddingBottom: bottomPadding }]}>
        {viewMode === 'terminal' && hasTerminal && (
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

      {/* Create session modal */}
      <CreateSessionModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </View>
  );
}

// Collapsible inline settings bar — replaces the old settings modal
function SettingsBar({
  expanded,
  onToggle,
  activeModel,
  availableModels,
  permissionMode,
  availablePermissionModes,
  lastResultCost,
  lastResultDuration,
  contextUsage,
  setModel,
  setPermissionMode,
}: {
  expanded: boolean;
  onToggle: () => void;
  activeModel: string | null;
  availableModels: ModelInfo[];
  permissionMode: string | null;
  availablePermissionModes: { id: string; label: string }[];
  lastResultCost: number | null;
  lastResultDuration: number | null;
  contextUsage: { inputTokens: number; outputTokens: number; cacheCreation: number; cacheRead: number } | null;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
}) {
  // Build collapsed summary: "Opus · Approve · $0.02 · 12.3k"
  const summaryParts: string[] = [];
  if (activeModel) {
    const modelInfo = availableModels.find((m) => m.id === activeModel || m.fullId === activeModel);
    summaryParts.push(modelInfo?.label || activeModel);
  }
  if (permissionMode) {
    const permInfo = availablePermissionModes.find((m) => m.id === permissionMode);
    summaryParts.push(permInfo?.label || permissionMode);
  }
  if (lastResultCost != null) {
    summaryParts.push(`$${lastResultCost.toFixed(2)}`);
  }
  if (contextUsage) {
    const total = contextUsage.inputTokens + contextUsage.outputTokens;
    if (total >= 1_000_000) summaryParts.push(`${(total / 1_000_000).toFixed(1)}M`);
    else if (total >= 1_000) summaryParts.push(`${(total / 1_000).toFixed(1)}k`);
    else summaryParts.push(`${total}`);
  }

  return (
    <View style={settingsBarStyles.container}>
      <TouchableOpacity onPress={onToggle} style={settingsBarStyles.summaryRow} activeOpacity={0.7}>
        <Text style={settingsBarStyles.summaryText} numberOfLines={1}>
          {summaryParts.join(' \u00B7 ') || 'Settings'}
        </Text>
        <Text style={settingsBarStyles.chevron}>{expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={settingsBarStyles.expandedContent}>
          {availableModels.length > 0 && (
            <View style={settingsBarStyles.chipRow}>
              {availableModels.map((m) => {
                const isActive = activeModel === m.id || activeModel === m.fullId;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[settingsBarStyles.chip, isActive && settingsBarStyles.chipActive]}
                    onPress={() => setModel(m.id)}
                  >
                    <Text style={[settingsBarStyles.chipText, isActive && settingsBarStyles.chipTextActive]}>
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {availablePermissionModes.length > 0 && (
            <View style={settingsBarStyles.chipRow}>
              {availablePermissionModes.map((m) => {
                const isActive = permissionMode === m.id;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[settingsBarStyles.chip, isActive && settingsBarStyles.chipActive]}
                    onPress={() => setPermissionMode(m.id)}
                  >
                    <Text style={[settingsBarStyles.chipText, isActive && settingsBarStyles.chipTextActive]}>
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {(lastResultCost != null || contextUsage) && (
            <View style={settingsBarStyles.contextRow}>
              {lastResultCost != null && (
                <Text style={settingsBarStyles.contextText}>
                  ${lastResultCost.toFixed(4)}
                  {lastResultDuration != null ? ` \u00B7 ${(lastResultDuration / 1000).toFixed(1)}s` : ''}
                </Text>
              )}
              {contextUsage && (
                <Text style={settingsBarStyles.contextText}>
                  {formatTokenCount(contextUsage.inputTokens + contextUsage.outputTokens)}
                </Text>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const settingsBarStyles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a2e',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4e',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  summaryText: {
    flex: 1,
    color: '#888',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  chevron: {
    color: '#666',
    fontSize: 10,
    marginLeft: 8,
  },
  expandedContent: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#2a2a4e',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipActive: {
    backgroundColor: '#4a9eff33',
    borderColor: '#4a9eff66',
  },
  chipText: {
    color: '#666',
    fontSize: 11,
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#4a9eff',
  },
  contextRow: {
    flexDirection: 'row',
    gap: 12,
  },
  contextText: {
    color: '#888',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

// Display group types for message grouping
type DisplayGroup =
  | { type: 'single'; message: ChatMessage }
  | { type: 'activity'; messages: ChatMessage[]; isActive: boolean; key: string };

/** Group consecutive tool_use and thinking messages into ActivityGroups */
function groupMessages(messages: ChatMessage[], streamingMessageId: string | null): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let activityBuf: ChatMessage[] = [];

  const flushActivity = () => {
    if (activityBuf.length > 0) {
      const lastMsg = activityBuf[activityBuf.length - 1];
      const isLastMessage = lastMsg === messages[messages.length - 1];
      const isActive = isLastMessage && streamingMessageId !== null;
      groups.push({
        type: 'activity',
        messages: [...activityBuf],
        isActive,
        key: `activity-${activityBuf[0].id}`,
      });
      activityBuf = [];
    }
  };

  for (const msg of messages) {
    if (msg.type === 'tool_use' || msg.type === 'thinking') {
      activityBuf.push(msg);
    } else {
      flushActivity();
      groups.push({ type: 'single', message: msg });
    }
  }
  flushActivity();

  return groups;
}

// Activity group component — groups consecutive tool/thinking messages
function ActivityGroup({
  messages: groupMessages,
  isActive,
  isSelecting,
  selectedIds,
  onToggleSelection,
}: {
  messages: ChatMessage[];
  isActive: boolean;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = groupMessages.filter((m) => m.type === 'tool_use').length;

  const handlePress = () => {
    if (isSelecting) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  };

  // Auto-collapse when activity completes
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(false);
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  const summary = isActive
    ? `Working... (${toolCount} tool${toolCount !== 1 ? 's' : ''})`
    : `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      style={styles.activityGroup}
    >
      <View style={styles.activityHeader}>
        {isActive && <View style={styles.activityPulse} />}
        <Text style={styles.activitySummary}>{summary}</Text>
        <Text style={styles.activityChevron}>{expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</Text>
      </View>
      {expanded && (
        <ScrollView style={styles.activityList} nestedScrollEnabled>
          {groupMessages.map((msg) => (
            <TouchableOpacity
              key={msg.id}
              activeOpacity={0.7}
              onLongPress={isSelecting ? undefined : () => onToggleSelection(msg.id)}
              onPress={isSelecting ? () => onToggleSelection(msg.id) : undefined}
              style={[styles.activityEntry, selectedIds.has(msg.id) && styles.selectedBubble]}
            >
              <Text style={styles.activityEntryIcon}>{ICON_CHEVRON_RIGHT}</Text>
              <Text style={styles.activityEntryTool}>{msg.tool || 'Thinking'}</Text>
              <Text style={styles.activityEntryPreview} numberOfLines={1}>
                {(msg.content || '').slice(0, 40)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </TouchableOpacity>
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
  streamingMessageId,
}: {
  messages: ChatMessage[];
  scrollViewRef: React.RefObject<ScrollView | null>;
  claudeReady: boolean;
  onSelectOption: (value: string, requestId?: string) => void;
  isCliMode: boolean;
  selectedIds: Set<string>;
  isSelecting: boolean;
  onToggleSelection: (id: string) => void;
  streamingMessageId: string | null;
}) {
  const displayGroups = useMemo(
    () => groupMessages(messages, streamingMessageId),
    [messages, streamingMessageId],
  );

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.chatContainer}
      contentContainerStyle={styles.chatContent}
      onContentSizeChange={() => scrollViewRef.current?.scrollToEnd()}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
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
        displayGroups.map((group) => {
          if (group.type === 'activity') {
            return (
              <ActivityGroup
                key={group.key}
                messages={group.messages}
                isActive={group.isActive}
                isSelecting={isSelecting}
                selectedIds={selectedIds}
                onToggleSelection={onToggleSelection}
              />
            );
          }
          const msg = group.message;
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              onSelectOption={onSelectOption}
              isSelected={selectedIds.has(msg.id)}
              isSelecting={isSelecting}
              onLongPress={() => onToggleSelection(msg.id)}
              onPress={() => onToggleSelection(msg.id)}
            />
          );
        })
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
  onSelectOption?: (value: string, requestId?: string) => void;
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
      {!isUser && !isPrompt && !isError ? (
        <FormattedResponse content={message.content?.trim() || ''} />
      ) : (
        <Text selectable style={[styles.messageText, isUser && styles.userMessageText, isError && styles.errorMessageText]}>
          {message.content?.trim()}
        </Text>
      )}
      {isPrompt && message.options && (
        <View style={styles.promptOptions}>
          {message.options.map((opt, i) => (
            <TouchableOpacity
              key={i}
              style={styles.promptOptionButton}
              onPress={() => onSelectOption?.(opt.value, message.requestId)}
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
  scrollViewRef: React.RefObject<ScrollView | null>;
  onKeyPress: (key: string) => void;
}) {
  const processed = useMemo(() => processTerminalBuffer(content), [content]);

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.terminalContainer}
      contentContainerStyle={styles.terminalContent}
      keyboardDismissMode="on-drag"
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
  activityGroup: {
    backgroundColor: '#16162a',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a4e',
    maxWidth: '90%',
  },
  activityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activityPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4a9eff',
    opacity: 0.8,
  },
  activitySummary: {
    flex: 1,
    color: '#a78bfa',
    fontSize: 12,
    fontWeight: '600',
  },
  activityChevron: {
    color: '#888',
    fontSize: 10,
  },
  activityList: {
    marginTop: 8,
    maxHeight: 200,
  },
  activityEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  activityEntryIcon: {
    color: '#666',
    fontSize: 8,
  },
  activityEntryTool: {
    color: '#a78bfa',
    fontSize: 11,
    fontWeight: '500',
    minWidth: 40,
  },
  activityEntryPreview: {
    flex: 1,
    color: '#888',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
