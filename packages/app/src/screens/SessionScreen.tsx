import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
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
  Modal,
  Pressable,
  LayoutAnimation,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore, ChatMessage, ConnectionPhase, AgentInfo, McpServer, DevPreview, stripAnsi } from '../store/connection';
import { SessionPicker } from '../components/SessionPicker';
import { CreateSessionModal } from '../components/CreateSessionModal';
import { ChatView } from '../components/ChatView';
import { TerminalView, TerminalHandle } from '../components/TerminalView';
import { SettingsBar } from '../components/SettingsBar';
import { WebTasksPanel } from '../components/WebTasksPanel';
import { InputBar } from '../components/InputBar';
import { FileBrowser } from '../components/FileBrowser';
import { DiffViewer } from '../components/DiffViewer';
import { SessionNotificationBanner } from '../components/SessionNotificationBanner';
import { DevPreviewBanner } from '../components/DevPreviewBanner';
import { SessionOverview } from '../components/SessionOverview';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { Icon } from '../components/Icon';
import { COLORS } from '../constants/colors';
import { useLayout } from '../hooks/useLayout';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { pickFromCamera, pickFromGallery, pickDocument, toWireAttachments, MAX_ATTACHMENTS } from '../utils/attachments';
import type { Attachment } from '../utils/attachments';


// Stable empty arrays to avoid new-reference-per-render in Zustand selectors
const EMPTY_AGENTS: AgentInfo[] = [];
const EMPTY_MCP_SERVERS: McpServer[] = [];
const EMPTY_DEV_PREVIEWS: DevPreview[] = [];
const EMPTY_PROMPTS: { tool: string; prompt: string }[] = [];

// Message sent when user taps "Approve" on a plan approval card
const PLAN_APPROVAL_MESSAGE = 'Go ahead with the plan';

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
export function formatTranscript(selected: ChatMessage[]): string {
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
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const layout = useLayout();

  const {
    viewMode,
    setViewMode,
    messages,
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
    connectionPhase,
    activeModel,
    availableModels,
    permissionMode,
    availablePermissionModes,
    contextUsage,
    lastResultCost,
    lastResultDuration,
    setModel,
    setPermissionMode,
    confirmPermissionMode,
    cancelPermissionConfirm,
    sendPermissionResponse,
    sendUserQuestionResponse,
    markPromptAnswered,
  } = useConnectionStore();

  const sessions = useConnectionStore((s) => s.sessions);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);
  const viewingCachedSession = useConnectionStore((s) => s.viewingCachedSession);
  const exitCachedSession = useConnectionStore((s) => s.exitCachedSession);
  const savedConnection = useConnectionStore((s) => s.savedConnection);
  const connect = useConnectionStore((s) => s.connect);
  const isIdle = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].isIdle : s.isIdle;
  });
  const activeAgents = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].activeAgents : EMPTY_AGENTS;
  });
  const activeSessionHealth = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].health : 'healthy';
  });
  const isPlanPending = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].isPlanPending : false;
  });
  const planAllowedPrompts = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].planAllowedPrompts : EMPTY_PROMPTS;
  });
  const connectedClients = useConnectionStore((s) => s.connectedClients);
  const conversationId = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].conversationId : null;
  });
  const sessionContext = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].sessionContext : null;
  });
  const pendingPermissionConfirm = useConnectionStore((s) => s.pendingPermissionConfirm);
  const slashCommands = useConnectionStore((s) => s.slashCommands);
  const customAgents = useConnectionStore((s) => s.customAgents);
  const mcpServers = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].mcpServers : EMPTY_MCP_SERVERS;
  });
  const sessionCost = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].sessionCost : null;
  });
  const costBudget = useConnectionStore((s) => s.costBudget);
  const devPreviews = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].devPreviews : EMPTY_DEV_PREVIEWS;
  });
  const closeDevPreview = useConnectionStore((s) => s.closeDevPreview);
  const webFeatures = useConnectionStore((s) => s.webFeatures);
  const webTasks = useConnectionStore((s) => s.webTasks);
  const launchWebTask = useConnectionStore((s) => s.launchWebTask);
  const teleportWebTask = useConnectionStore((s) => s.teleportWebTask);
  const destroySession = useConnectionStore((s) => s.destroySession);
  const latencyMs = useConnectionStore((s) => s.latencyMs);
  const connectionQuality = useConnectionStore((s) => s.connectionQuality);
  const connectionError = useConnectionStore((s) => s.connectionError);
  const connectionRetryCount = useConnectionStore((s) => s.connectionRetryCount);
  const shutdownReason = useConnectionStore((s) => s.shutdownReason);
  const restartEtaMs = useConnectionStore((s) => s.restartEtaMs);
  const restartingSince = useConnectionStore((s) => s.restartingSince);
  const serverErrors = useConnectionStore((s) => s.serverErrors);
  const dismissServerError = useConnectionStore((s) => s.dismissServerError);
  const setTerminalWriteCallback = useConnectionStore((s) => s.setTerminalWriteCallback);
  const isCliMode = serverMode === 'cli';
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showSessionOverview, setShowSessionOverview] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Search state
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<TextInput>(null);

  // Speech recognition
  const { isRecognizing, transcript, isAvailable: speechAvailable, startListening, stopListening, error: speechError } = useSpeechRecognition();
  const dictationStartRef = useRef(inputText.length);
  const usedVoiceRef = useRef(false);

  // Surface speech recognition errors to the user
  useEffect(() => {
    if (speechError) {
      Alert.alert('Voice Input Error', speechError);
    }
  }, [speechError]);

  // Search: compute matching message IDs
  const searchMatchIds = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.type === 'thinking') continue;
      if (m.content?.toLowerCase().includes(q) || m.toolResult?.toLowerCase().includes(q)) {
        ids.add(m.id);
      }
    }
    return ids;
  }, [messages, searchQuery]);

  const searchMatchArray = useMemo(
    () => messages.filter((m) => searchMatchIds.has(m.id)).map((m) => m.id),
    [messages, searchMatchIds],
  );

  // Reset match index when the query changes (more reliable than .length which misses same-count changes)
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  const currentMatchId = searchMatchArray.length > 0 ? searchMatchArray[currentMatchIndex] ?? null : null;

  const handleSearchPrev = useCallback(() => {
    if (searchMatchArray.length === 0) return;
    setCurrentMatchIndex((i) => (i > 0 ? i - 1 : searchMatchArray.length - 1));
  }, [searchMatchArray.length]);

  const handleSearchNext = useCallback(() => {
    if (searchMatchArray.length === 0) return;
    setCurrentMatchIndex((i) => (i < searchMatchArray.length - 1 ? i + 1 : 0));
  }, [searchMatchArray.length]);

  const handleSearchClose = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
    setCurrentMatchIndex(0);
  }, []);

  const handleSearchOpen = useCallback(() => {
    setSearchVisible(true);
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  // Terminal scrollback export
  const handleExportTerminal = useCallback(async () => {
    // Use the larger raw buffer (100KB) and strip ANSI for readable export
    const raw = useConnectionStore.getState().terminalRawBuffer;
    const buffer = stripAnsi(raw);
    if (!buffer.trim()) {
      Alert.alert('Nothing to export', 'Terminal buffer is empty.');
      return;
    }
    try {
      await Share.share({ message: buffer, title: 'Terminal Output' });
    } catch (err: unknown) {
      Alert.alert('Export failed', `Unable to share terminal output: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, []);

  // Countdown for server restart ETA
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (connectionPhase !== 'server_restarting' || !restartEtaMs || restartEtaMs <= 0 || !restartingSince) {
      setRestartCountdown(null);
      return;
    }
    const update = () => {
      const elapsed = Date.now() - restartingSince;
      const remaining = Math.max(0, Math.ceil((restartEtaMs - elapsed) / 1000));
      setRestartCountdown(remaining);
      if (remaining <= 0) clearInterval(interval);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [connectionPhase, restartEtaMs, restartingSince]);

  // Determine if the active session has a terminal (PTY sessions do, CLI sessions don't)
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const hasTerminal = !isCliMode || (activeSession?.hasTerminal ?? false);

  // Wire up terminal write callback when terminal view is visible (including split view)
  const terminalVisible = (viewMode === 'terminal' || (layout.isSplitView && viewMode !== 'files')) && hasTerminal;
  useEffect(() => {
    if (!terminalVisible) return;

    const writeCallback = (data: string) => {
      terminalRef.current?.write(data);
    };
    setTerminalWriteCallback(writeCallback);

    return () => {
      setTerminalWriteCallback(null);
    };
  }, [terminalVisible, activeSessionId, setTerminalWriteCallback]);

  // Replay raw buffer into xterm.js when it becomes ready (initial mount, view switch, or crash recovery)
  const handleTerminalReady = useCallback(() => {
    terminalRef.current?.clear();
    const rawBuffer = useConnectionStore.getState().terminalRawBuffer;
    if (rawBuffer) {
      terminalRef.current?.write(rawBuffer);
    }
  }, []);

  // Forward terminal dimensions to server for PTY resize
  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    useConnectionStore.getState().resize(cols, rows);
  }, []);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;
  // Ref so onContentSizeChange always reads the latest value (avoids stale closure)
  const isSelectingRef = useRef(false);
  isSelectingRef.current = isSelecting;

  // Ref for focusing the input bar when user taps "Give Feedback" on plan approval
  const inputRef = useRef<TextInput>(null);

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
    const hasAttachments = pendingAttachments.length > 0;
    if ((!inputText.trim() && !hasAttachments) || streamingMessageId) return;
    const text = inputText.trim();
    setInputText('');

    // Detect & prefix for Claude Code Web tasks — check before addUserMessage
    // to avoid adding a thinking indicator for fire-and-forget operations
    if (text && text.startsWith('&') && !hasTerminal && !hasAttachments) {
      const webPrompt = text.slice(1).trim();
      if (webPrompt) {
        const { addMessage } = useConnectionStore.getState();
        // Show the user's message without a thinking indicator
        addMessage({
          id: `web-user-${Date.now()}`,
          type: 'user_input',
          content: `& ${webPrompt}`,
          timestamp: Date.now(),
        });
        if (!webFeatures.available) {
          addMessage({
            id: `web-unavail-${Date.now()}`,
            type: 'system',
            content: 'Claude Code Web is not available on this server. The Claude CLI needs --remote support — update your CLI to enable cloud tasks.',
            timestamp: Date.now(),
          });
          return;
        }
        launchWebTask(webPrompt, sessionCwd || undefined);
        return;
      }
    }

    // Build attachment metadata for the chat message (without base64 data)
    const msgAttachments = hasAttachments
      ? pendingAttachments.map(({ id, type, uri, name, mediaType, size }) => ({ id, type, uri, name, mediaType, size }))
      : undefined;

    if (viewMode === 'chat' || viewMode === 'files') {
      addUserMessage(text || `[${pendingAttachments.length} file(s) attached]`, msgAttachments);
    }

    // Clear plan approval card — user has responded (whether approving or giving feedback)
    if (isPlanPending) clearPlanState();

    // Build wire attachments (with base64 data) for the server
    const wire = hasAttachments ? toWireAttachments(pendingAttachments) : undefined;

    // Clear pending attachments (frees base64 memory)
    if (hasAttachments) setPendingAttachments([]);

    // PTY sessions: append CR so text + submit arrive as a single atomic write.
    // CLI sessions: the server handles the full message directly (no CR needed).
    const isVoice = usedVoiceRef.current;
    usedVoiceRef.current = false;
    const result = sendInput(hasTerminal ? (text || '') + '\r' : (text || ''), wire, { isVoice });
    if (result === 'queued') {
      const { addMessage } = useConnectionStore.getState();
      addMessage({
        id: `queued-${Date.now()}`,
        type: 'system',
        content: 'Message queued — waiting for reconnection...',
        timestamp: Date.now(),
      });
    }
  };

  const addAttachment = useCallback(async (picker: () => Promise<Attachment | null>) => {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      Alert.alert('Limit reached', `Maximum ${MAX_ATTACHMENTS} attachments per message.`);
      return;
    }
    try {
      const att = await picker();
      if (att) {
        setPendingAttachments((prev) => [...prev, att]);
      }
    } catch (err: unknown) {
      Alert.alert('Error', `Failed to attach file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [pendingAttachments.length]);

  const handleCamera = useCallback(() => {
    addAttachment(pickFromCamera);
  }, [addAttachment]);

  const handleAttach = useCallback(() => {
    setShowAttachSheet(true);
  }, []);

  const handleAttachOption = useCallback((picker: () => Promise<Attachment | null>) => {
    setShowAttachSheet(false);
    addAttachment(picker);
  }, [addAttachment]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

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
  const handleSelectOption = (value: string, messageId: string, requestId?: string, toolUseId?: string) => {
    let sent: 'sent' | 'queued' | false = false;
    if (toolUseId) {
      sent = sendUserQuestionResponse(value, toolUseId);
    } else if (requestId) {
      sent = sendPermissionResponse(requestId, value);
    } else {
      sent = sendInput(hasTerminal ? value + '\r' : value);
    }
    if (sent === 'sent') {
      markPromptAnswered(messageId, value);
    }
  };

  const clearPlanState = useConnectionStore((s) => s.clearPlanState);

  const handleApprovePlan = useCallback(() => {
    addUserMessage(PLAN_APPROVAL_MESSAGE);
    sendInput(PLAN_APPROVAL_MESSAGE);
    clearPlanState();
  }, [addUserMessage, sendInput, clearPlanState]);

  const handleFocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleInvokeAgent = useCallback((agentName: string) => {
    setInputText(`@${agentName} `);
    inputRef.current?.focus();
  }, []);

  // Track whether the latest inputText change came from dictation (vs manual edit)
  const isDictationUpdateRef = useRef(false);

  // Wrap setInputText to detect manual edits during dictation
  const handleChangeText = useCallback((text: string) => {
    if (!isDictationUpdateRef.current && isRecognizing) {
      // User manually edited text during dictation — update anchor point
      dictationStartRef.current = text.length;
    }
    isDictationUpdateRef.current = false;
    setInputText(text);
  }, [isRecognizing]);

  // Voice input: toggle start/stop and merge transcript into input text
  const handleMicPress = useCallback(() => {
    if (isRecognizing) {
      stopListening();
    } else {
      dictationStartRef.current = inputText.length;
      startListening();
    }
  }, [isRecognizing, inputText.length, startListening, stopListening]);

  useEffect(() => {
    if (isRecognizing && transcript) {
      const prefix = inputText.slice(0, dictationStartRef.current);
      const separator = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : '';
      isDictationUpdateRef.current = true;
      usedVoiceRef.current = true;
      setInputText(prefix + separator + transcript);
    }
  }, [transcript]); // eslint-disable-line react-hooks/exhaustive-deps -- only react to transcript changes

  // Check if Enter key should send based on current mode and settings
  const enterToSend = viewMode === 'terminal'
    ? inputSettings.terminalEnterToSend
    : inputSettings.chatEnterToSend;

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
        <View style={styles.sessionPickerRow}>
          <View style={styles.sessionPickerWrapper}>
            <SessionPicker onCreatePress={() => setShowCreateModal(true)} />
          </View>
          <TouchableOpacity
            style={styles.overviewButton}
            onPress={() => setShowSessionOverview(!showSessionOverview)}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel={showSessionOverview ? 'Hide session overview' : 'Show session overview'}
          >
            <Text style={[styles.overviewButtonText, showSessionOverview && styles.overviewButtonTextActive]}>
              {'☰'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Session overview panel */}
      {showSessionOverview && (
        <SessionOverview visible={showSessionOverview} onClose={() => setShowSessionOverview(false)} />
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
            <TouchableOpacity style={styles.selectionCancelButton} onPress={clearSelection} accessibilityRole="button" accessibilityLabel="Cancel selection">
              <Icon name="close" size={16} color={COLORS.accentRed} />
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeButton, viewMode === 'chat' && styles.modeButtonActive]}
            onPress={() => setViewMode('chat')}
            accessibilityRole="button"
            accessibilityLabel="Chat"
          >
            <Text style={[styles.modeButtonText, viewMode === 'chat' && styles.modeButtonTextActive]}>
              Chat
            </Text>
          </TouchableOpacity>
          {hasTerminal && (
            <TouchableOpacity
              style={[styles.modeButton, viewMode === 'terminal' && styles.modeButtonActive]}
              onPress={() => setViewMode('terminal')}
              accessibilityRole="button"
              accessibilityLabel="Terminal"
            >
              <Text style={[styles.modeButtonText, viewMode === 'terminal' && styles.modeButtonTextActive]}>
                Term
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.modeButton, viewMode === 'files' && styles.modeButtonActive]}
            onPress={() => setViewMode('files')}
            accessibilityRole="button"
            accessibilityLabel="Files"
          >
            <Text style={[styles.modeButtonText, viewMode === 'files' && styles.modeButtonTextActive]}>
              Files
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.diffButton} onPress={() => setShowDiffViewer(true)} accessibilityRole="button" accessibilityLabel="View changes">
            <Icon name="diff" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          {(viewMode === 'chat' || (layout.isSplitView && viewMode !== 'files')) && (
            <TouchableOpacity style={styles.diffButton} onPress={handleSearchOpen} accessibilityRole="button" accessibilityLabel="Search messages">
              <Icon name="search" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          )}
          {(viewMode === 'terminal' || (layout.isSplitView && hasTerminal && viewMode !== 'files')) && (
            <TouchableOpacity style={styles.diffButton} onPress={handleExportTerminal} accessibilityRole="button" accessibilityLabel="Export terminal output">
              <Icon name="export" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.settingsButton} onPress={() => navigation.navigate('History')} accessibilityRole="button" accessibilityLabel="Conversation history">
            <Icon name="clock" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingsButton} onPress={() => navigation.navigate('Settings')} accessibilityRole="button" accessibilityLabel="Open settings">
            <Icon name="settings" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.disconnectButton} onPress={disconnect} accessibilityRole="button" accessibilityLabel="Disconnect">
            <Icon name="close" size={16} color={COLORS.accentRed} />
          </TouchableOpacity>
        </View>
      )}

      {/* Search bar */}
      {searchVisible && (
        <View style={styles.searchBar}>
          <TextInput
            ref={searchInputRef}
            style={styles.searchInput}
            placeholder="Search messages..."
            placeholderTextColor={COLORS.textDim}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchMatchArray.length > 0 && (
            <Text style={styles.searchCount}>
              {currentMatchIndex + 1}/{searchMatchArray.length}
            </Text>
          )}
          <TouchableOpacity onPress={handleSearchPrev} style={styles.searchNavButton} accessibilityRole="button" accessibilityLabel="Previous match">
            <Icon name="arrowUp" size={16} color={COLORS.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSearchNext} style={styles.searchNavButton} accessibilityRole="button" accessibilityLabel="Next match">
            <Icon name="arrowDown" size={16} color={COLORS.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSearchClose} style={styles.searchNavButton} accessibilityRole="button" accessibilityLabel="Close search">
            <Icon name="close" size={16} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Collapsible settings bar (CLI mode or PTY mode with status data) */}
      {(isCliMode && !activeSession?.hasTerminal && (availableModels.length > 0 || lastResultCost != null || contextUsage)) && (
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
          sessionCost={sessionCost}
          costBudget={costBudget}
          contextUsage={contextUsage}
          sessionCwd={sessionCwd}
          serverMode={serverMode}
          isIdle={isIdle}
          activeAgents={activeAgents}
          connectedClients={connectedClients}
          customAgents={customAgents}
          mcpServers={mcpServers}
          onInvokeAgent={handleInvokeAgent}
          setModel={setModel}
          setPermissionMode={setPermissionMode}
          pendingPermissionConfirm={pendingPermissionConfirm}
          onConfirmPermissionMode={confirmPermissionMode}
          onCancelPermissionConfirm={cancelPermissionConfirm}
          conversationId={conversationId}
          sessionContext={sessionContext}
          latencyMs={latencyMs}
          connectionQuality={connectionQuality}
        />
      )}

      {/* Offline cached session banner */}
      {viewingCachedSession && (
        <View style={styles.reconnectingBanner}>
          <View style={styles.cachedBannerRow}>
            <Text style={styles.reconnectingText}>Viewing cached history</Text>
            <View style={styles.cachedBannerActions}>
              {savedConnection && (
                <TouchableOpacity
                  onPress={() => {
                    exitCachedSession();
                    connect(savedConnection.url, savedConnection.token);
                  }}
                  style={styles.cachedReconnectButton}
                  accessibilityRole="button"
                  accessibilityLabel="Reconnect to server"
                >
                  <Text style={styles.cachedReconnectText}>Reconnect</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={exitCachedSession}
                style={styles.cachedBackButton}
                accessibilityRole="button"
                accessibilityLabel="Go back to connect screen"
              >
                <Text style={styles.cachedBackText}>Back</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Reconnecting / restarting banner */}
      {(connectionPhase === 'reconnecting' || connectionPhase === 'server_restarting') && (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>
            {connectionPhase === 'server_restarting'
              ? shutdownReason === 'shutdown'
                ? 'Server shut down'
                : restartCountdown != null && restartCountdown > 0
                  ? `Server restarting... ~${Math.floor(restartCountdown / 60)}:${String(restartCountdown % 60).padStart(2, '0')}`
                  : 'Server restarting...'
              : connectionRetryCount > 0
                ? `Reconnecting (attempt ${connectionRetryCount + 1})...`
                : 'Reconnecting...'}
          </Text>
          {connectionPhase === 'server_restarting' && shutdownReason === 'restart' && (
            <Text style={styles.reconnectingDetail}>Graceful restart</Text>
          )}
          {connectionPhase === 'server_restarting' && !shutdownReason && (
            <Text style={styles.reconnectingDetail}>Recovering from crash</Text>
          )}
          {connectionPhase === 'reconnecting' && connectionError && (
            <Text style={styles.reconnectingDetail}>{connectionError}</Text>
          )}
        </View>
      )}

      {/* Crash banner for active session */}
      {activeSessionHealth === 'crashed' && (
        <View style={[styles.reconnectingBanner, styles.errorBanner]}>
          <View style={styles.errorBannerContent}>
            <Text style={styles.errorBannerText} numberOfLines={2}>
              Session crashed. Delete this session to free resources.
            </Text>
            <TouchableOpacity
              onPress={() => {
                if (sessions.length <= 1) {
                  Alert.alert('Cannot Delete', 'You must have at least one session.');
                  return;
                }
                Alert.alert(
                  'Delete Crashed Session',
                  'This session has crashed. Delete it?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: () => { if (activeSessionId) destroySession(activeSessionId); },
                    },
                  ],
                );
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Delete crashed session"
            >
              <Icon name="close" size={14} color={COLORS.accentRed} />
            </TouchableOpacity>
          </View>
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
              <Icon name="close" size={14} color={err.recoverable ? COLORS.accentOrange : COLORS.accentRed} />
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {/* Background session notifications */}
      <SessionNotificationBanner />

      {/* Dev server preview banner */}
      <DevPreviewBanner previews={devPreviews} onClose={closeDevPreview} />

      {/* Web tasks panel (Claude Code Web cloud delegation) */}
      {webTasks.length > 0 && (
        <WebTasksPanel tasks={webTasks} webFeatures={webFeatures} onTeleport={teleportWebTask} />
      )}

      {/* Content area — split view on tablets in landscape */}
      {!showSessionOverview && (
        layout.isSplitView && hasTerminal && viewMode !== 'files' ? (
          <View style={styles.splitContainer}>
            <View style={styles.splitPane}>
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
                isPlanPending={isPlanPending}
                planAllowedPrompts={planAllowedPrompts}
                onApprovePlan={handleApprovePlan}
                onFocusInput={handleFocusInput}
                searchQuery={searchVisible ? searchQuery : undefined}
                searchMatchIds={searchVisible ? searchMatchIds : undefined}
                currentMatchId={searchVisible ? currentMatchId : undefined}
              />
            </View>
            <View style={styles.splitDivider} />
            <View style={styles.splitPane}>
              <TerminalView ref={terminalRef} onReady={handleTerminalReady} onResize={handleTerminalResize} />
            </View>
          </View>
        ) : viewMode === 'chat' ? (
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
            isPlanPending={isPlanPending}
            planAllowedPrompts={planAllowedPrompts}
            onApprovePlan={handleApprovePlan}
            onFocusInput={handleFocusInput}
            searchQuery={searchVisible ? searchQuery : undefined}
            searchMatchIds={searchVisible ? searchMatchIds : undefined}
            currentMatchId={searchVisible ? currentMatchId : undefined}
          />
        ) : viewMode === 'files' ? (
          <FileBrowser />
        ) : (
          <TerminalView ref={terminalRef} onReady={handleTerminalReady} onResize={handleTerminalResize} />
        )
      )}

      {/* Input area */}
      <InputBar
        ref={inputRef}
        inputText={inputText}
        onChangeText={handleChangeText}
        onSend={handleSend}
        onInterrupt={sendInterrupt}
        onClearTerminal={() => { clearTerminalBuffer(); terminalRef.current?.clear(); }}
        onKeyPress={handleKeyPress}
        enterToSend={enterToSend}
        onToggleEnterMode={() => {
          const key = viewMode === 'terminal' ? 'terminalEnterToSend' : 'chatEnterToSend';
          updateInputSettings({ [key]: !inputSettings[key] });
        }}
        isStreaming={!!streamingMessageId}
        claudeReady={claudeReady}
        viewMode={viewMode}
        hasTerminal={hasTerminal}
        bottomPadding={bottomPadding}
        disabled={connectionPhase !== 'connected'}
        disabledPlaceholder={viewingCachedSession ? 'Offline — viewing cached history' : connectionPhase === 'server_restarting' ? 'Server restarting...' : 'Reconnecting...'}
        slashCommands={slashCommands}
        isRecognizing={isRecognizing}
        onMicPress={speechAvailable ? handleMicPress : undefined}
        speechUnavailable={!speechAvailable}
        attachments={pendingAttachments}
        onAttach={handleAttach}
        onCamera={handleCamera}
        onRemoveAttachment={handleRemoveAttachment}
      />

      {/* Create session modal */}
      <CreateSessionModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />

      {/* Diff viewer modal */}
      <DiffViewer
        visible={showDiffViewer}
        onClose={() => setShowDiffViewer(false)}
      />

      {/* Attachment picker bottom sheet */}
      <Modal visible={showAttachSheet} transparent animationType="slide" onRequestClose={() => setShowAttachSheet(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => setShowAttachSheet(false)}>
          <Pressable style={[styles.sheetContent, { paddingBottom: Math.max(insets.bottom, 8) }]} onPress={(e) => e.stopPropagation()}>
            <TouchableOpacity style={styles.sheetOption} onPress={() => handleAttachOption(pickFromCamera)} accessibilityRole="button" accessibilityLabel="Take photo">
              <Text style={styles.sheetOptionText}>Take Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetOption} onPress={() => handleAttachOption(pickFromGallery)} accessibilityRole="button" accessibilityLabel="Choose from library">
              <Text style={styles.sheetOptionText}>Choose from Library</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetOption} onPress={() => handleAttachOption(pickDocument)} accessibilityRole="button" accessibilityLabel="Choose file">
              <Text style={styles.sheetOptionText}>Choose File</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.sheetOption, styles.sheetCancel]} onPress={() => setShowAttachSheet(false)} accessibilityRole="button" accessibilityLabel="Cancel attachment selection">
              <Text style={[styles.sheetOptionText, styles.sheetCancelText]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  searchBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    padding: 8,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
    gap: 4,
  },
  searchInput: {
    flex: 1,
    backgroundColor: COLORS.backgroundCard,
    color: COLORS.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  searchCount: {
    color: COLORS.textDim,
    fontSize: 12,
    marginHorizontal: 4,
  },
  searchNavButton: {
    padding: 6,
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  searchNavText: {
    color: COLORS.textSecondary,
    fontSize: 16,
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
  diffButton: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
  },
  diffButtonText: {
    color: COLORS.textMuted,
    fontSize: 16,
    fontWeight: '700',
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
  cachedBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 12,
  },
  cachedBannerActions: {
    flexDirection: 'row',
    gap: 12,
  },
  cachedReconnectButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: COLORS.accentGreen,
    borderRadius: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  cachedReconnectText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  cachedBackButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    minHeight: 36,
    justifyContent: 'center',
  },
  cachedBackText: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  reconnectingText: {
    color: COLORS.accentOrange,
    fontSize: 13,
    fontWeight: '600',
  },
  reconnectingDetail: {
    color: COLORS.accentOrange,
    fontSize: 11,
    opacity: 0.7,
    marginTop: 2,
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
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: COLORS.backgroundSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 34, // overridden inline with insets.bottom
    paddingTop: 8,
  },
  sheetOption: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    minHeight: 52,
    justifyContent: 'center',
  },
  sheetOptionText: {
    color: COLORS.accentBlue,
    fontSize: 18,
    textAlign: 'center',
  },
  sheetCancel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderPrimary,
    marginTop: 4,
  },
  sheetCancelText: {
    color: COLORS.accentRed,
  },
  sessionPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sessionPickerWrapper: {
    flex: 1,
  },
  overviewButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overviewButtonText: {
    color: COLORS.textMuted,
    fontSize: 18,
  },
  overviewButtonTextActive: {
    color: COLORS.accentBlue,
  },
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  splitPane: {
    flex: 1,
  },
  splitDivider: {
    width: 1,
    backgroundColor: COLORS.backgroundCard,
  },
});
