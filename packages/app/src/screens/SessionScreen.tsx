import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Platform,
  Keyboard,
  Share,
  Alert,
  Modal,
  Pressable,
  LayoutAnimation,
  ActivityIndicator as RNActivityIndicator,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore, selectMessages, selectClaudeReady, selectStreamingMessageId, selectActiveModel, selectPermissionMode, selectContextOccupancy, selectLastResultCost, selectLastResultDuration, selectIsIdle, selectQueuedMessages, stripAnsi, nextMessageId } from '../store/connection';
import type { ChatMessage, ConnectionPhase, AgentInfo, McpServer, DevPreview } from '../store/connection';
import type { SessionIntervention } from '@chroxy/store-core';
// #4875: shared typed predicate for the AskUserQuestion freeform shape.
// Replaces the looser 2-condition inline check (`'otherLabel' in &&
// 'freeformText' in`) with the same 5-condition guard the store layer
// uses, so widening `SelectOptionValue` to a third object shape can't
// silently misroute it as freeform.
// #6882: `isHiddenInCompactMode` is the shared compact-filter predicate from
// store-core's buildChatViewMessages.ts (added in #6880) — the single source
// of truth for which message types compact mode hides. Converging mobile onto
// it (instead of a hand-maintained duplicate of the same tool_use/thinking
// check) keeps dashboard and mobile from silently drifting.
import { isFreeformAnswer, providerSupportsMultiQuestion, providerSupportsSingleMultiSelect, approvePlanWithAcceptEdits, isHiddenInCompactMode } from '@chroxy/store-core';
import { USER_SHELL_PROVIDER } from '@chroxy/protocol';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { SessionPicker } from '../components/SessionPicker';
import { CreateSessionModal } from '../components/CreateSessionModal';
import { ChatView } from '../components/ChatView';
import type { SelectOptionValue } from '../components/chat/MessageBubble';
import { TerminalView, TerminalHandle } from '../components/TerminalView';
import { SettingsBar } from '../components/SettingsBar';
import { WebTasksPanel } from '../components/WebTasksPanel';
import { InputBar, type InputBarHandle } from '../components/InputBar';
import { ActivityIndicator } from '../components/ActivityIndicator';
import { CheckInChip } from '../components/CheckInChip';
import { FileBrowser } from '../components/FileBrowser';
import { SessionPanels } from '../components/SessionPanels';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { SessionNotificationBanner } from '../components/SessionNotificationBanner';
import { BackgroundSessionProgress } from '../components/BackgroundSessionProgress';
import { DevPreviewBanner } from '../components/DevPreviewBanner';
import { SessionTimeoutBanner } from '../components/SessionTimeoutBanner';
import { StdinDisabledBanner } from '../components/StdinDisabledBanner';
import { CostThresholdBanner } from '../components/CostThresholdBanner';
import { ObserverBanner } from '../components/ObserverBanner';
import { SessionOverview } from '../components/SessionOverview';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { Icon } from '../components/Icon';
import { COLORS } from '../constants/colors';
import { useLayout } from '../hooks/useLayout';
import { useSessionViewState } from '../hooks/useSessionViewState';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { useDictationComposer } from '../hooks/useDictationComposer';
import { useAndroidSessionNotification } from '../hooks/useAndroidSessionNotification';
import { pickFromCamera, pickFromGallery, pickDocument, toWireAttachments, MAX_ATTACHMENTS } from '../utils/attachments';
import type { Attachment } from '../utils/attachments';
import { runQueuedEdit } from '../utils/edit-queued';
import { formatPasteMarker, expandPasteMarkers, parseMemoryAppend } from '@chroxy/store-core';
import { PastedTextModal } from '../components/PastedTextModal';
import { disconnectWithQueueGuard } from '../store/disconnectWithQueueGuard';


// Stable empty arrays to avoid new-reference-per-render in Zustand selectors
const EMPTY_AGENTS: AgentInfo[] = [];
const EMPTY_MCP_SERVERS: McpServer[] = [];
const EMPTY_DEV_PREVIEWS: DevPreview[] = [];
const EMPTY_PROMPTS: { tool: string; prompt: string }[] = [];
const EMPTY_INTERVENTIONS: SessionIntervention[] = [];

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
  // #5556 — the composer draft now lives inside InputBar (see `inputRef`
  // below). SessionScreen no longer holds it in render-scope state, which is
  // what decouples typing from streaming-message re-renders.
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  // #5517: ChatView's transcript is a virtualized FlatList. SessionScreen
  // only forwards this ref (never calls imperative methods on it); typed as
  // FlatList<unknown> to match ChatView's prop without naming the row type.
  const scrollViewRef = useRef<FlatList<unknown>>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const layout = useLayout();
  useAndroidSessionNotification();

  // Individual selectors for state values — avoids subscribing to every store change
  const viewMode = useConnectionStore((s) => s.viewMode);
  const allMessages = useConnectionStore(selectMessages);
  const inputSettings = useConnectionStore((s) => s.inputSettings);
  const claudeReady = useConnectionStore(selectClaudeReady);
  const serverMode = useConnectionLifecycleStore((s) => s.serverMode);
  const sessionCwd = useConnectionLifecycleStore((s) => s.sessionCwd);
  const streamingMessageId = useConnectionStore(selectStreamingMessageId);
  const connectionPhase = useConnectionLifecycleStore((s) => s.connectionPhase);
  const activeModel = useConnectionStore(selectActiveModel);
  const availableModels = useConnectionStore((s) => s.availableModels);
  const defaultModelId = useConnectionStore((s) => s.defaultModelId);
  const permissionMode = useConnectionStore(selectPermissionMode);
  const availablePermissionModes = useConnectionStore((s) => s.availablePermissionModes);
  // #6769: occupancy snapshot drives the SettingsBar meter (the billing
  // contextUsage aggregate must never feed it).
  const contextOccupancy = useConnectionStore(selectContextOccupancy);
  const lastResultCost = useConnectionStore(selectLastResultCost);
  const lastResultDuration = useConnectionStore(selectLastResultDuration);
  const activeSessionId = useConnectionStore((s) => s.activeSessionId);

  // #5654 — view-mode / panel-visibility state (chat compact filter and the
  // three modal panels) is owned by useSessionViewState. The compact-filter
  // reset-on-session-switch effect lives inside the hook.
  const {
    chatFilterCompact,
    setChatFilterCompact,
    showDiffViewer,
    setShowDiffViewer,
    showCheckpoints,
    setShowCheckpoints,
    showGitView,
    setShowGitView,
    closeDiffViewer,
    closeCheckpoints,
    closeGitView,
  } = useSessionViewState({ activeSessionId });

  // Filter messages: exclude system (separate tab) and, in compact mode, whatever
  // the shared #6880 predicate hides (tool_use/thinking today). `system` stays a
  // separate inline check — isHiddenInCompactMode is specifically the compact-hide rule.
  const chatMessages = useMemo(
    () => allMessages.filter((m) => {
      if (m.type === 'system') return false;
      if (chatFilterCompact && isHiddenInCompactMode(m.type)) return false;
      return true;
    }),
    [allMessages, chatFilterCompact, isHiddenInCompactMode],
  );
  const systemMessages = useMemo(
    () => allMessages.filter((m) => m.type === 'system'),
    [allMessages],
  );

  // Pick the right message list for the current view
  const messages = viewMode === 'system' ? systemMessages : chatMessages;

  // Track unread system message count per session (keyed by sessionId, never null)
  const lastSeenSystemCountRef = useRef<Map<string, number>>(new Map());
  const lastSeenForSession =
    activeSessionId ? lastSeenSystemCountRef.current.get(activeSessionId) ?? 0 : 0;
  const rawUnreadSystemCount =
    !activeSessionId || viewMode === 'system'
      ? 0
      : systemMessages.length - lastSeenForSession;
  const unreadSystemCount = rawUnreadSystemCount > 0 ? rawUnreadSystemCount : 0;

  // Update last-seen count when entering System tab; clamp when messages are trimmed
  useEffect(() => {
    if (!activeSessionId) return;

    const map = lastSeenSystemCountRef.current;
    const key = activeSessionId;
    const previous = map.get(key) ?? 0;

    // Clamp if messages were trimmed below previously-seen count
    if (previous > systemMessages.length) {
      map.set(key, systemMessages.length);
    }

    if (viewMode === 'system') {
      map.set(key, systemMessages.length);
    }
  }, [viewMode, systemMessages.length, activeSessionId]);

  // Action functions — stable references, individual selectors to avoid omnibus subscription
  const setViewMode = useConnectionStore((s) => s.setViewMode);
  const sendInput = useConnectionStore((s) => s.sendInput);
  const sendInterrupt = useConnectionStore((s) => s.sendInterrupt);
  // #5938 — the active session's outgoing queue (mid-turn follow-ups). Derive a
  // Set of queued clientMessageIds so ChatView/MessageBubble can flag matching
  // user bubbles with a "Queued" badge + cancel affordance in O(1) per row.
  // Reads from the per-session store (not ChatView-local state) so it survives
  // the session-switch re-render without leaking across sessions.
  const queuedMessages = useConnectionStore(selectQueuedMessages);
  const sendCancelQueued = useConnectionStore((s) => s.sendCancelQueued);
  const queuedIds = useMemo(
    () => new Set(queuedMessages.map((m) => m.clientMessageId).filter((id): id is string => !!id)),
    [queuedMessages],
  );
  const handleCancelQueued = useCallback((id: string) => { sendCancelQueued(id); }, [sendCancelQueued]);
  // #5699 — reactive count of queued (unsent) messages, surfaced in the
  // reconnect banner so held input isn't invisible to the user.
  const queuedMessageCount = useConnectionStore((s) => s.queuedMessageCount);
  // #5725 (#5698) — manual retry from the terminal `server_down` banner.
  const retryConnection = useConnectionStore((s) => s.retryConnection);
  const clearTerminalBuffer = useConnectionStore((s) => s.clearTerminalBuffer);
  const addUserMessage = useConnectionStore((s) => s.addUserMessage);
  const updateInputSettings = useConnectionStore((s) => s.updateInputSettings);
  const setModel = useConnectionStore((s) => s.setModel);
  const setPermissionMode = useConnectionStore((s) => s.setPermissionMode);
  const setMcpServerEnabled = useConnectionStore((s) => s.setMcpServerEnabled);
  const submitMcpAuthCode = useConnectionStore((s) => s.submitMcpAuthCode);
  const confirmPermissionMode = useConnectionStore((s) => s.confirmPermissionMode);
  const cancelPermissionConfirm = useConnectionStore((s) => s.cancelPermissionConfirm);
  const sendPermissionResponse = useConnectionStore((s) => s.sendPermissionResponse);
  const sendUserQuestionResponse = useConnectionStore((s) => s.sendUserQuestionResponse);
  const markPromptAnswered = useConnectionStore((s) => s.markPromptAnswered);
  const markPromptAnsweredMulti = useConnectionStore((s) => s.markPromptAnsweredMulti);

  const sessions = useConnectionStore((s) => s.sessions);
  // #4973 / #4735 — allow the interactive multi-question form only for
  // SDK-mode sessions. TUI / CLI sessions (`claude-tui` / `claude-cli`)
  // leave it off because the permission-hook (#4648) denies combined
  // multi-question tool_uses there and answers would misroute through
  // `_pendingUserAnswer`; SDK / BYOK / Codex / Gemini sessions accept
  // per-question answers natively (#4731). Mirrors the dashboard's
  // `allowMultiQuestionForm` (App.tsx).
  const activeSessionProvider = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions.find((sess) => sess.sessionId === id)?.provider ?? null : null;
  });
  // #6901 — active session's resolved Codex sandbox mode (only codex sessions
  // carry it in session_list). Drives the read-only sandbox badge in the
  // SettingsBar. Display-only: changing it needs a new session.
  const activeSessionCodexSandbox = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions.find((sess) => sess.sessionId === id)?.codexSandbox ?? null : null;
  });
  // #5731 — gate the SettingsBar model/permission chips on the active provider's
  // capabilities, mirroring the dashboard's dropdownFlags. Default to supported
  // (true) unless the provider explicitly reports the capability as false, so a
  // provider that can't switch (e.g. claude-tui — model fixed at boot) doesn't
  // render chips that silently do nothing on tap.
  const availableProviders = useConnectionStore((s) => s.availableProviders);
  const providerCaps = useMemo(() => {
    const caps = availableProviders.find((p) => p.name === activeSessionProvider)?.capabilities;
    return {
      modelSwitchSupported: caps?.modelSwitch !== false,
      permissionModeSwitchSupported: caps?.permissionModeSwitch !== false,
    };
  }, [availableProviders, activeSessionProvider]);
  // #5795 — provider capability lives in @chroxy/store-core (single source of
  // truth, keyed off the registered provider `type`), shared with the
  // dashboard so the two clients can't drift. Multi-QUESTION forms need a
  // structured answersMap (SDK family); a single multiSelect also renders for
  // claude-tui via the #5776 reinject path. The plain CLI providers
  // (claude-cli, docker-cli) are excluded — single text answer, no answersMap.
  const allowMultiQuestion = useMemo(
    () => providerSupportsMultiQuestion(activeSessionProvider),
    [activeSessionProvider],
  );
  // #5791 — claude-tui's single multiSelect is gated on the server-advertised
  // `multiSelectReinject` capability (the CHROXY_TUI_MULTISELECT_REINJECT flag),
  // not just the provider name, so the client doesn't offer a form the server
  // would refuse. Pass the active provider's raw capabilities to the predicate.
  const allowSingleMultiSelect = useMemo(() => {
    const caps = availableProviders.find((p) => p.name === activeSessionProvider)?.capabilities;
    return providerSupportsSingleMultiSelect(activeSessionProvider, caps);
  }, [activeSessionProvider, availableProviders]);
  const viewingCachedSession = useConnectionStore((s) => s.viewingCachedSession);
  const exitCachedSession = useConnectionStore((s) => s.exitCachedSession);
  const savedConnection = useConnectionLifecycleStore((s) => s.savedConnection);
  const isIdle = useConnectionStore(selectIsIdle);
  const activeAgents = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].activeAgents : EMPTY_AGENTS;
  });
  const activeSessionHealth = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].health : 'healthy';
  });
  // Chat redesign #6391 (mobile): chat-activity state (already derived +
  // persisted by message-handler) drives the composer's activity hairline.
  // A primitive-string selector → Zustand default equality re-renders the
  // composer only on a real state transition, not every store write.
  const activityState = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id]?.activityState
      ? s.sessionStates[id].activityState.state
      : 'idle';
  });
  // #4879: quiet user-initiated Stop marker. Set by the `session_stopped`
  // handler (sharedSessionStopped); cleared on next claude_ready. Drives
  // the subtle "Session stopped." status strip below — distinct from the
  // loud red crashed banner reserved for unexpected exits.
  const activeSessionStoppedAt = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].stoppedAt : null;
  });
  const activeSessionStoppedCode = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].stoppedCode : null;
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
  // #4074: per-session cumulative tokens + cost. Drives the SettingsBar
  // cost badge + tap-to-expand breakdown sheet.
  const cumulativeUsage = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].cumulativeUsage : null;
  });
  // #4075: soft cost-threshold warning. Banner stays visible until the
  // user dismisses (we set dismissedAt to flip the gate).
  const costThresholdWarning = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].costThresholdWarning : null;
  });
  const costBudget = useConnectionStore((s) => s.costBudget);
  // #5589 / #5281 — this device's shared-session role + the current driver, for
  // the observer banner. Both are per-session.
  const sessionRole = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].sessionRole : null;
  });
  const activePrimaryClientId = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].primaryClientId : null;
  });
  const claimPrimary = useConnectionStore((s) => s.claimPrimary);
  // #4764 — chroxy-side intervention ring for the active session. Drives the
  // session-header counter badge and the tap-to-expand recent-interventions
  // sheet (mirrors the dashboard's FooterBar surface from #4758).
  const interventions = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].interventions : EMPTY_INTERVENTIONS;
  });
  const devPreviews = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].devPreviews : EMPTY_DEV_PREVIEWS;
  });
  const closeDevPreview = useConnectionStore((s) => s.closeDevPreview);
  const webFeatures = useConnectionStore((s) => s.webFeatures);
  const isEncrypted = useConnectionLifecycleStore((s) => s.isEncrypted);
  const timeoutWarning = useConnectionStore((s) => s.timeoutWarning);
  const dismissTimeoutWarning = useConnectionStore((s) => s.dismissTimeoutWarning);
  const wsUrl = useConnectionLifecycleStore((s) => s.wsUrl);
  const webTasks = useConnectionStore((s) => s.webTasks);
  const launchWebTask = useConnectionStore((s) => s.launchWebTask);
  const teleportWebTask = useConnectionStore((s) => s.teleportWebTask);
  const destroySession = useConnectionStore((s) => s.destroySession);
  const createSession = useConnectionStore((s) => s.createSession);
  // #5987 — only surface the "New Shell" affordance when the server advertises
  // the user-shell capability; when absent, render nothing (mirrors the
  // notificationPrefs capability gate in SettingsScreen).
  const userShellSupported = useConnectionLifecycleStore((s) => !!s.serverCapabilities?.userShell);
  const switchSession = useConnectionStore((s) => s.switchSession);
  const latencyMs = useConnectionLifecycleStore((s) => s.latencyMs);
  const connectionQuality = useConnectionLifecycleStore((s) => s.connectionQuality);
  const activePath = useConnectionLifecycleStore((s) => s.activePath);
  const connectionError = useConnectionLifecycleStore((s) => s.connectionError);
  const connectionRetryCount = useConnectionLifecycleStore((s) => s.connectionRetryCount);
  const shutdownReason = useConnectionStore((s) => s.shutdownReason);
  const restartEtaMs = useConnectionStore((s) => s.restartEtaMs);
  const restartingSince = useConnectionStore((s) => s.restartingSince);
  const serverErrors = useConnectionStore((s) => s.serverErrors);
  const dismissServerError = useConnectionStore((s) => s.dismissServerError);
  const setTerminalWriteCallback = useConnectionStore((s) => s.setTerminalWriteCallback);
  const isCliMode = serverMode === 'cli';
  const [showCreateModal, setShowCreateModal] = useState(false);
  // #5654 — showDiffViewer / showCheckpoints / showGitView and chatFilterCompact
  // come from useSessionViewState. The layout-chrome toggles (showMoreTools,
  // showSessionOverview, settingsExpanded) are plain local useState here.
  const [showMoreTools, setShowMoreTools] = useState(false);
  const [showSessionOverview, setShowSessionOverview] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Search state
  const [searchVisible, setSearchVisible] = useState(false);
  const [inSessionSearchQuery, setInSessionSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<TextInput>(null);
  const searchFocusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Speech recognition — wire mode from inputSettings.voiceInputMode (#4807).
  // Mobile defaults to `'continuous'` in the store so users get click-to-stop
  // semantics matching the dashboard.
  const { isRecognizing, transcript, isAvailable: speechAvailable, startListening, stopListening, error: speechError } = useSpeechRecognition({
    mode: inputSettings.voiceInputMode,
  });

  // Surface speech recognition errors to the user
  useEffect(() => {
    if (speechError) {
      Alert.alert('Voice Input Error', speechError);
    }
  }, [speechError]);

  // Search: compute matching message IDs
  const searchMatchIds = useMemo(() => {
    if (!inSessionSearchQuery.trim()) return new Set<string>();
    const q = inSessionSearchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.type === 'thinking') continue;
      if (m.content?.toLowerCase().includes(q) || m.toolResult?.toLowerCase().includes(q)) {
        ids.add(m.id);
      }
    }
    return ids;
  }, [messages, inSessionSearchQuery]);

  const searchMatchArray = useMemo(
    () => messages.filter((m) => searchMatchIds.has(m.id)).map((m) => m.id),
    [messages, searchMatchIds],
  );

  // Reset match index when the query changes (more reliable than .length which misses same-count changes)
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [inSessionSearchQuery]);

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
    clearTimeout(searchFocusTimerRef.current);
    setSearchVisible(false);
    setInSessionSearchQuery('');
    setCurrentMatchIndex(0);
  }, []);

  const handleSearchOpen = useCallback(() => {
    setSearchVisible(true);
    clearTimeout(searchFocusTimerRef.current);
    searchFocusTimerRef.current = setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  // Clean up search focus timer on unmount
  useEffect(() => () => clearTimeout(searchFocusTimerRef.current), []);

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
  // #5987 — a user-shell ($SHELL PTY) session is terminal-only and drives the
  // #5835 mirror channel (terminal_subscribe / terminal_output / terminal_resize)
  // instead of claude-tui's legacy 'raw' + `resize` path. isPtyMirror gates the
  // mirror subscribe/resize so claude-tui behavior stays exactly as before.
  // Reuses the reactive `activeSessionProvider` selector declared above.
  const isUserShell = activeSessionProvider === USER_SHELL_PROVIDER;
  const isPtyMirror = isUserShell;
  // #6329 — manual terminal resync affordance. The store action + the auto-resync
  // on (re)subscribe ship in #6313; this wires the explicit "looks out of sync"
  // button. Only meaningful for the live PTY mirror (user-shell) on an active,
  // non-observer session — the server still enforces resync authority.
  const requestTerminalResync = useConnectionStore((s) => s.requestTerminalResync);
  const canResyncTerminal = isPtyMirror && !!activeSessionId && sessionRole !== 'observer';
  const handleTerminalRefresh = useCallback(() => {
    if (activeSessionId) requestTerminalResync(activeSessionId);
  }, [activeSessionId, requestTerminalResync]);
  // #6003 — a user-shell terminal is interactive (drivable) only when this client
  // may drive it: the server's userShell capability is gated on the primary token
  // (+ userShell.enabled), matching the terminal_input authority gate. claude-tui
  // mirrors stay read-only. Enables xterm stdin + keystroke forwarding below.
  const terminalInteractive = isUserShell && userShellSupported;
  // A user-shell session is terminal-only, so it always has a terminal even
  // though it isn't a claude-tui PTY.
  const hasTerminal = isUserShell || !isCliMode || (activeSession?.hasTerminal ?? false);

  // Wire up terminal write callback when terminal view is visible (including split view)
  const terminalVisible = (viewMode === 'terminal' || (layout.isSplitView && viewMode !== 'files' && viewMode !== 'system')) && hasTerminal;
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

  // #5835 / #5987 — opt into the live PTY mirror for a user-shell session while
  // its terminal is visible, and opt out on leave / session switch. Only
  // user-shell sessions use this channel (isPtyMirror); claude-tui stays on the
  // legacy 'raw' stream and is unaffected. Mirrors the dashboard's subscribe
  // effect — best-effort, the store actions no-op when the socket isn't open.
  useEffect(() => {
    if (!terminalVisible || !isPtyMirror || !activeSessionId) return;
    const sessionId = activeSessionId;
    useConnectionStore.getState().subscribeTerminalMirror(sessionId);
    return () => {
      useConnectionStore.getState().unsubscribeTerminalMirror(sessionId);
    };
  }, [terminalVisible, isPtyMirror, activeSessionId]);

  // #5987 — a user-shell session is terminal-only, so snap the view to the
  // terminal when one becomes active while sitting on the chat default. Only
  // flips away from 'chat' (the default) so it never fights a user who has
  // intentionally opened Files/System for the shell session.
  useEffect(() => {
    if (isUserShell && viewMode === 'chat') {
      setViewMode('terminal');
    }
  }, [isUserShell, viewMode, setViewMode]);

  // Replay raw buffer into xterm.js when it becomes ready (initial mount, view switch, or crash recovery)
  const handleTerminalReady = useCallback(() => {
    terminalRef.current?.clear();
    const rawBuffer = useConnectionStore.getState().terminalRawBuffer;
    if (rawBuffer) {
      terminalRef.current?.write(rawBuffer);
    }
  }, []);

  // Forward terminal dimensions to server for PTY resize. A user-shell session
  // drives the #5835 mirror resize (terminal_resize, per-sessionId); claude-tui
  // keeps the legacy `resize` (active-session) path. Reads provider fresh from
  // the store so the callback can stay stable (empty deps) without going stale.
  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    const store = useConnectionStore.getState();
    const { activeSessionId: sid, sessions: sess } = store;
    const provider = sess.find((s) => s.sessionId === sid)?.provider;
    if (sid && provider === USER_SHELL_PROVIDER) {
      store.sendTerminalResize(sid, cols, rows);
    } else {
      store.resize(cols, rows);
    }
  }, []);

  // #6003 — forward keystrokes/paste from an interactive user-shell terminal to
  // the PTY (terminal_input, chunked under the 100k cap). Reads the session
  // fresh from the store so the callback stays stable; only sends for a
  // user-shell (the read-only mirror's xterm never emits onData anyway).
  const handleTerminalInput = useCallback((data: string) => {
    const store = useConnectionStore.getState();
    const { activeSessionId: sid, sessions: sess } = store;
    const provider = sess.find((s) => s.sessionId === sid)?.provider;
    if (sid && provider === USER_SHELL_PROVIDER) {
      store.sendTerminalInput(sid, data);
    }
  }, []);

  // #3595: dedicated restart handler for the StdinDisabledBanner. Creates a
  // replacement session FIRST and then destroys the broken one so the swap
  // never leaves the user with zero sessions. The server's `destroy_session`
  // handler rejects "Cannot destroy the last session" (see
  // `packages/server/src/handlers/session-handlers.js`), so a destroy-first
  // ordering would fail in the common case where the wedged session is the
  // only one open. Creating first also avoids an intermediate
  // `session_switched` away from the restarted session when the active
  // session is destroyed. No confirm dialog — destruction is implicit in
  // "restart" and any in-flight Claude work was already wedged behind the
  // broken stdin pipe.
  const handleRestartStdinSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;
    // #3599: forward model + permissionMode so the recreated session
    // preserves any non-default values the user had switched to on the
    // broken session. Mirrors the dashboard's handleRestartSession (#3593).
    createSession({
      name: session.name,
      cwd: session.cwd || undefined,
      worktree: session.worktree,
      provider: session.provider,
      model: session.model || undefined,
      permissionMode: session.permissionMode || undefined,
    });
    destroySession(sessionId);
  }, [sessions, destroySession, createSession]);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;
  // Ref so onContentSizeChange always reads the latest value (avoids stale closure)
  const isSelectingRef = useRef(false);
  isSelectingRef.current = isSelecting;

  // #5556 — InputBar now owns its draft internally and exposes an imperative
  // handle (focus/getValue/setValue/clear). SessionScreen reads/writes the
  // composer draft through this ref for the send path, voice-transcript merge,
  // seed prompts, and pasted-text marker stripping — so streaming re-renders no
  // longer churn the TextInput on every delta.
  const inputRef = useRef<InputBarHandle>(null);

  // #6628 — edit a still-queued follow-up before it flushes. Cancel-and-reopen:
  // cancel the queued entry first (its optimistic drop clears the bubble +
  // badge), then reopen the message text in the composer for amend + re-send.
  // The decision logic (draft-clobber guard + fail-closed bail) lives in
  // `runQueuedEdit`; here we wire the app's effects:
  //   - guard: queue-while-processing is a multi-message flow, so if the
  //     composer already holds a non-empty draft (a second follow-up mid-type)
  //     we surface an alert and leave the queued entry intact rather than
  //     silently discarding the draft.
  //   - `sendCancelQueued` returns `false` on a closed socket without dropping
  //     the entry — the helper bails then so we neither clobber the composer nor
  //     strand a queued message the cancel never reached. The already-flushing
  //     race is handled like plain cancel: the server no-ops and the badge (with
  //     these controls) is gone once `message_dequeued` lands.
  const handleEditQueued = useCallback((id: string, text: string) => {
    runQueuedEdit(id, text, {
      getDraft: () => inputRef.current?.getValue() ?? '',
      // sendCancelQueued returns `false` on a closed socket (fail-closed, the
      // entry is NOT dropped) or `'sent'` otherwise — normalize to the helper's
      // boolean contract where `false` means fail-closed.
      cancelQueued: (mid) => sendCancelQueued(mid) !== false,
      reopenComposer: (next) => inputRef.current?.setValue(next),
      notify: (message) => Alert.alert('Finish your current message', message),
      focusComposer: () => inputRef.current?.focus(),
    });
  }, [sendCancelQueued]);

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

  // #5556 — `handleSend` closes over fast-changing state (pendingAttachments,
  // streamingMessageId, pastedTextBlocks, viewMode, …), so a useCallback dep
  // array would re-create it on every streaming delta and defeat InputBar's
  // React.memo. Instead we keep the live implementation in a ref (refreshed
  // each render) behind a single stable wrapper passed to InputBar.
  const handleSendImpl = () => {
    const hasAttachments = pendingAttachments.length > 0;
    // #5556 — read the draft from the InputBar ref (it owns the value now).
    const draft = inputRef.current?.getValue() ?? '';
    if (!draft.trim() && !hasAttachments) return;
    // #5938 — capture busy state at send time. A send mid-turn no longer bails
    // out: it queues (the bubble renders with a "Queued" badge and the server
    // flushes it when the current turn completes) rather than starting a fresh
    // turn. `busy` drives addUserMessage's optimistic-enqueue path below.
    // #6113 — match the dashboard's #5952 condition: `isIdle === false` covers
    // the window after `agent_busy` but before `stream_start` (or a tool-only
    // turn that never streams text), where the server is processing but
    // streamingMessageId is still null. Without it a send in that window would
    // force-send on mobile while the dashboard queues. isIdle defaults to true,
    // so a genuinely idle send still starts a fresh turn (no false-queue).
    const busy = !!streamingMessageId || !isIdle;
    // Expand any collapsed-paste markers back to their original content
    // before send (#3797). Trim happens AFTER expansion so an expanded
    // payload with surrounding whitespace still sends cleanly.
    const blockMap = new Map(pastedTextBlocks.map(b => [b.id, b.content]));
    const expanded = blockMap.size > 0 ? expandPasteMarkers(draft, blockMap) : draft;
    const text = expanded.trim();
    inputRef.current?.clear();
    // Clear paste state alongside the input — neither persists across sends.
    setPastedTextBlocks([]);
    pastedTextNextIdRef.current = 0;
    setInspectedPastedTextId(null);

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

    // #6861 — `#`-prefix quick-append. A leading `# ` (hash + space) routes the
    // note to the project CLAUDE.md instead of sending a chat turn. Disabled for
    // terminal sessions (`#` is a shell comment there) and when attachments are
    // pending (they can't go to memory). The confirmation lands via the
    // `append_memory_result` ack.
    if (text && !hasTerminal && !hasAttachments) {
      const memory = parseMemoryAppend(text);
      if (memory.isMemory) {
        const sent = useConnectionStore.getState().appendMemory(memory.note);
        if (sent === false) {
          // #6308/#6309 — disconnected: appendMemory is NOT offline-queued, so
          // restore the draft (the input was cleared above) and surface a notice
          // rather than silently losing the note.
          inputRef.current?.setValue(text);
          useConnectionStore.getState().addMessage({
            id: `memory-fail-${Date.now()}`,
            type: 'system',
            content: 'Not connected — memory note not saved. Try again once reconnected.',
            timestamp: Date.now(),
          });
        }
        return;
      }
    }

    // Build attachment metadata for the chat message (without base64 data)
    const msgAttachments = hasAttachments
      ? pendingAttachments.map(({ id, type, uri, name, mediaType, size }) => ({ id, type, uri, name, mediaType, size }))
      : undefined;

    // Shared messageId: same ID on the optimistic entry, the wire payload,
    // and (via server adoption) the history record. Lets reconnect replay
    // dedup by id against the existing optimistic copy (issue #2902).
    const clientMessageId = nextMessageId('user');

    if (viewMode === 'chat' || viewMode === 'files') {
      addUserMessage(text || `[${pendingAttachments.length} file(s) attached]`, msgAttachments, { clientMessageId, queued: busy });
    }

    // Clear plan approval card — user has responded (whether approving or giving feedback)
    if (isPlanPending) clearPlanState();

    // Build wire attachments (with base64 data) for the server
    const wire = hasAttachments ? toWireAttachments(pendingAttachments) : undefined;

    // Clear pending attachments (frees base64 memory)
    if (hasAttachments) setPendingAttachments([]);

    // PTY sessions: append CR so text + submit arrive as a single atomic write.
    // CLI sessions: the server handles the full message directly (no CR needed).
    const isVoice = consumeUsedVoice();
    const result = sendInput(hasTerminal ? (text || '') + '\r' : (text || ''), wire, { isVoice, clientMessageId });
    if (result === 'queued') {
      const { addMessage } = useConnectionStore.getState();
      addMessage({
        id: `queued-${Date.now()}`,
        type: 'system',
        content: 'Message queued — waiting for reconnection...',
        timestamp: Date.now(),
      });
    } else if (result === false && busy && (viewMode === 'chat' || viewMode === 'files')) {
      // #6451 — the send AND the offline-enqueue both failed (queue full), so no
      // server message_queued/dequeued will reconcile the optimistic 'Queued'
      // badge we added when busy — roll it back so it doesn't linger forever.
      // (enqueueMessage already surfaced a 'couldn't queue' system message via
      // notifyQueueFailure, so we don't add a duplicate notice here.)
      useConnectionStore.getState().clearOptimisticQueuedMessage(clientMessageId);
    }
  };
  // Refresh the live implementation each render, then expose a stable wrapper.
  const handleSendRef = useRef(handleSendImpl);
  handleSendRef.current = handleSendImpl;
  const handleSend = useCallback(() => handleSendRef.current(), []);

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

  const handleKeyPress = useCallback((key: string) => {
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
  }, [sendInput]);

  // #5556 — stable handlers for InputBar so React.memo isn't defeated by
  // fresh inline arrows on each streaming re-render.
  const handleClearTerminal = useCallback(() => {
    clearTerminalBuffer();
    terminalRef.current?.clear();
  }, [clearTerminalBuffer]);
  const handleToggleEnterMode = useCallback(() => {
    const key = viewMode === 'terminal' ? 'terminalEnterToSend' : 'chatEnterToSend';
    updateInputSettings({ [key]: !inputSettings[key] });
  }, [viewMode, inputSettings, updateInputSettings]);

  // Handle tapping a prompt option
  // #4755 — `value` widened to `SelectOptionValue` to carry the
  // single-question Other / freeform payload (`{otherLabel, freeformText}`).
  // We forward the object shape directly to `sendUserQuestionResponse` so
  // the wire layer can emit `{answer: <otherLabel>, freeformText}` for the
  // server's two-stage TUI write (Other digit → text-input prompt →
  // freeform text + Enter). The local `markPromptAnswered` summary stores
  // the typed text — not the literal "Other" label — matching the
  // post-answer UX of the free-text-only path (#1245) so the chat bubble
  // shows what the user actually wrote. Mirrors dashboard App.tsx +
  // `formatQuestionAnswerSummary` for the freeform shape (#4651).
  const handleSelectOption = (
    value: SelectOptionValue,
    messageId: string,
    requestId?: string,
    toolUseId?: string,
    // #6543 (feature B): the operator's per-hunk narrowing from a Write/Edit
    // pre-write-diff review, forwarded to sendPermissionResponse (which drops it
    // for a deny). Null/omitted for every non-reviewable prompt.
    editedInput?: Record<string, string> | null,
  ) => {
    // #4875: shared `isFreeformAnswer` guard from @chroxy/store-core
    // narrows `value` to `OtherFreeformAnswer` in the true branch, so the
    // string-branch arms can drop the `as string` cast in favour of plain
    // assignment. The previous inline 2-condition check (`'otherLabel' in
    // && 'freeformText' in`) was looser than the store-layer detector and
    // would have silently misrouted a future third object shape; the
    // shared guard keeps both call sites in lockstep.
    const freeform = isFreeformAnswer(value);
    let sent: 'sent' | 'queued' | false = false;
    if (toolUseId) {
      sent = sendUserQuestionResponse(value, toolUseId);
    } else if (requestId) {
      // Permission responses are decision strings ('allow' / 'deny' / etc.)
      // and never carry an Other / freeform payload — the freeform branch
      // is defence-in-depth only; in practice this site sees `string`.
      // #6543 (feature B): forward the pre-write-diff narrowing (null for
      // non-reviewable prompts; the store drops it for a deny).
      sent = sendPermissionResponse(requestId, freeform ? value.freeformText : value, editedInput);
    } else {
      const literal = freeform ? value.freeformText : value;
      sent = sendInput(hasTerminal ? literal + '\r' : literal);
    }
    if (sent === 'sent') {
      // For the freeform shape, store the typed text (not the label) so
      // the answered-state UI renders the user's actual answer.
      const summary = freeform ? value.freeformText : value;
      markPromptAnswered(messageId, summary);
    }
  };

  // #4973 — submit handler for the multi-question AskUserQuestion form.
  // Forwards the per-question answers map (`Record<string, string |
  // string[]>`) to `sendUserQuestionResponse` (widened in #4761), which
  // serializes the `answers` map + a comma-joined `answer` summary on the
  // wire. On success we record the structured map via
  // `markPromptAnsweredMulti` so the post-answer summary chip can map
  // chosen values back to option labels. Mirrors the dashboard's
  // App.tsx + `formatQuestionAnswerSummary` multi-question path (#4760).
  const handleSubmitMultiQuestion = (
    answersMap: Record<string, string | string[]>,
    messageId: string,
    toolUseId?: string,
  ) => {
    if (!toolUseId) return;
    const sent = sendUserQuestionResponse(answersMap, toolUseId);
    if (sent === 'sent') {
      markPromptAnsweredMulti(messageId, answersMap);
    }
  };

  const clearPlanState = useConnectionStore((s) => s.clearPlanState);

  const handleApprovePlan = useCallback(() => {
    const clientMessageId = nextMessageId('user');
    addUserMessage(PLAN_APPROVAL_MESSAGE, undefined, { clientMessageId });
    sendInput(PLAN_APPROVAL_MESSAGE, undefined, { clientMessageId });
    clearPlanState();
  }, [addUserMessage, sendInput, clearPlanState]);

  // #6774 — combined "approve + auto-accept edits": switch the session into
  // acceptEdits AND approve the plan in one tap so the implementation turn runs
  // with edits auto-accepted. `approvePlanWithAcceptEdits` dispatches the mode
  // switch BEFORE the approval — the server drops a mid-turn mode change, so it
  // must land while the session is idle (awaiting approval). Reuses
  // handleApprovePlan unchanged as the approve step.
  const handleApprovePlanAcceptEdits = useCallback(() => {
    approvePlanWithAcceptEdits({ setPermissionMode, approve: handleApprovePlan });
  }, [setPermissionMode, handleApprovePlan]);

  const handleFocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // #5699 / #6081 — manual disconnect during a reconnect discards the outgoing
  // queue (disconnect() calls clearMessageQueue). Delegate to the shared guard
  // so all give-up paths warn identically before silently losing typed input.
  const handleStopReconnecting = disconnectWithQueueGuard;

  const handleInvokeAgent = useCallback((agentName: string) => {
    inputRef.current?.setValue(`@${agentName} `);
    inputRef.current?.focus();
  }, []);

  // Pasted-text-block storage for the composer (#3797). React Native
  // `TextInput` has no native paste event, so we detect large pastes by
  // diffing the previous and next text on each `onChangeText` — anything
  // that grew by more than the shared threshold in a single tick is
  // treated as a paste and collapsed to an inline marker.
  type PastedTextBlock = { id: number; content: string };
  const [pastedTextBlocks, setPastedTextBlocks] = useState<PastedTextBlock[]>([]);
  const pastedTextNextIdRef = useRef(0);
  const [inspectedPastedTextId, setInspectedPastedTextId] = useState<number | null>(null);

  // #5556 — InputBar owns the draft and has already applied the user's
  // keystroke before calling this; we only react to the diff. On a paste
  // collapse we assign the id, format the marker, record the original content,
  // and push the marker-substituted value BACK into InputBar via setValue.
  // The previous implementation short-circuited on a char-only fast-path which
  // missed multi-line pastes that fell below 1500 chars but crossed the 20-line
  // threshold (#3798 review, #3799); `detectPasteFromDiff` on every grow (inside
  // the hook) keeps both clients honouring the same criteria.
  const handlePasteCollapsed = useCallback((inserted: string, prefix: string, suffix: string) => {
    const nextId = pastedTextNextIdRef.current + 1;
    pastedTextNextIdRef.current = nextId;
    const marker = formatPasteMarker(nextId, inserted);
    setPastedTextBlocks(prevBlocks => [...prevBlocks, { id: nextId, content: inserted }]);
    inputRef.current?.setValue(prefix + marker + suffix);
  }, []);

  // #5573 — dictation + composer-change bookkeeping (the voice refs, the
  // change/mic handlers, and the transcript-merge effect) lives in a dedicated
  // hook. Since `setValue` is silent (#5566), every `onChangeText` during
  // recognition is a real user keystroke, so the hook re-anchors unconditionally
  // on each one — a mid-recognition manual edit is preserved and the next
  // transcript appends after it instead of overwriting it.
  const { handleChangeText, handleMicPress, consumeUsedVoice } = useDictationComposer({
    inputRef,
    isRecognizing,
    transcript,
    startListening,
    stopListening,
    onPasteCollapsed: handlePasteCollapsed,
  });

  const handleRemovePastedText = useCallback((id: number) => {
    setPastedTextBlocks(prev => prev.filter(b => b.id !== id));
    // Strip this block's marker from the input. Per-id regex so we only
    // touch the matching marker, not unrelated ones. #5556 — read/write the
    // draft through the InputBar ref instead of a functional setState.
    const markerRe = new RegExp(`\\[Pasted text #${id} \\+\\d+ (?:lines|chars)\\]`, 'g');
    const current = inputRef.current?.getValue() ?? '';
    inputRef.current?.setValue(current.replace(markerRe, ''));
    setInspectedPastedTextId(curr => (curr === id ? null : curr));
  }, []);

  const handleInspectPastedText = useCallback((id: number) => {
    setInspectedPastedTextId(id);
  }, []);

  // Check if Enter key should send based on current mode and settings
  const enterToSend = viewMode === 'terminal'
    ? inputSettings.terminalEnterToSend
    : inputSettings.chatEnterToSend;

  // Keyboard visibility for chat auto-scroll
  const keyboardVisible = keyboardHeight > 0;

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
          {/* #5987 — "New Shell" spins up a user-shell ($SHELL PTY) session.
              Gated on the server's userShell capability; renders nothing when
              the server doesn't advertise it. */}
          {userShellSupported && (
            <TouchableOpacity
              testID="new-shell-button"
              style={styles.overviewButton}
              onPress={() => createSession({ name: 'Shell', provider: USER_SHELL_PROVIDER })}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityRole="button"
              accessibilityLabel="New shell session"
            >
              <Text style={styles.overviewButtonText}>{'>_'}</Text>
            </TouchableOpacity>
          )}
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
        <SessionOverview onClose={() => setShowSessionOverview(false)} />
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
          {/* #5987 — a user-shell session is terminal-only; hide the Chat toggle
              so there's no empty chat view to switch into. */}
          {!isUserShell && (
            <TouchableOpacity
              style={[styles.modeButton, viewMode === 'chat' && styles.modeButtonActive]}
              onPress={() => setViewMode('chat')}
              accessibilityRole="button"
              accessibilityLabel="Chat"
              accessibilityState={{ selected: viewMode === 'chat' }}
            >
              <Text style={[styles.modeButtonText, viewMode === 'chat' && styles.modeButtonTextActive]}>
                Chat
              </Text>
            </TouchableOpacity>
          )}
          {!isUserShell && viewMode === 'chat' && (
            <TouchableOpacity
              style={[styles.modeButton, chatFilterCompact && styles.modeButtonActive]}
              onPress={() => { setChatFilterCompact((v) => !v); clearSelection(); }}
              accessibilityRole="button"
              accessibilityLabel={chatFilterCompact ? 'Compact messages' : 'All messages'}
              accessibilityHint={chatFilterCompact ? 'Show all messages' : 'Show compact messages only'}
              accessibilityState={{ selected: chatFilterCompact }}
            >
              <Text style={[styles.modeButtonText, chatFilterCompact && styles.modeButtonTextActive]}>
                {chatFilterCompact ? 'Compact' : 'All'}
              </Text>
            </TouchableOpacity>
          )}
          {hasTerminal && (
            <TouchableOpacity
              testID="terminal-mode-button"
              style={[styles.modeButton, viewMode === 'terminal' && styles.modeButtonActive]}
              onPress={() => setViewMode('terminal')}
              accessibilityRole="button"
              accessibilityLabel="Terminal"
              accessibilityState={{ selected: viewMode === 'terminal' }}
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
            accessibilityState={{ selected: viewMode === 'files' }}
          >
            <Text style={[styles.modeButtonText, viewMode === 'files' && styles.modeButtonTextActive]}>
              Files
            </Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={styles.diffButton}
            onPress={() => setShowMoreTools((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={showMoreTools ? 'Hide tools' : 'Show tools'}
          >
            <Icon name={showMoreTools ? 'chevronUp' : 'chevronDown'} size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingsButton} onPress={() => navigation.navigate('Settings')} accessibilityRole="button" accessibilityLabel="Open settings">
            <Icon name="settings" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      {/* Secondary tools row (collapsed by default) */}
      {showMoreTools && (
        <View style={styles.secondaryToolsRow}>
          <TouchableOpacity style={styles.diffButton} onPress={() => setShowDiffViewer(true)} accessibilityRole="button" accessibilityLabel="View changes">
            <Icon name="diff" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.diffButton} onPress={() => setShowCheckpoints(true)} accessibilityRole="button" accessibilityLabel="View checkpoints">
            <Icon name="clock" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.diffButton} onPress={() => setShowGitView(true)} accessibilityRole="button" accessibilityLabel="Git operations">
            <Icon name="gitBranch" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          {(viewMode === 'chat' || viewMode === 'system' || (layout.isSplitView && viewMode !== 'files')) && (
            <TouchableOpacity style={styles.diffButton} onPress={handleSearchOpen} accessibilityRole="button" accessibilityLabel="Search messages">
              <Icon name="search" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          )}
          {(viewMode === 'terminal' || (layout.isSplitView && hasTerminal && viewMode !== 'files')) && (
            <TouchableOpacity style={styles.diffButton} onPress={handleExportTerminal} accessibilityRole="button" accessibilityLabel="Export terminal output">
              <Icon name="export" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.diffButton} onPress={() => navigation.navigate('History')} accessibilityRole="button" accessibilityLabel="Conversation history">
            <Icon name="clock" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.diffButton}
            onPress={() => setViewMode('system')}
            accessibilityRole="button"
            accessibilityLabel="System messages"
          >
            <Icon name="terminal" size={16} color={viewMode === 'system' ? COLORS.accentBlue : COLORS.textMuted} />
            {unreadSystemCount > 0 && (
              <View style={styles.systemBadge}>
                <Text style={styles.systemBadgeText}>{unreadSystemCount > 99 ? '99+' : unreadSystemCount}</Text>
              </View>
            )}
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
            value={inSessionSearchQuery}
            onChangeText={setInSessionSearchQuery}
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
      {(isCliMode && !activeSession?.hasTerminal && (availableModels.length > 0 || lastResultCost != null || contextOccupancy)) && (
        <SettingsBar
          expanded={settingsExpanded}
          onToggle={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setSettingsExpanded((prev) => !prev);
          }}
          activeModel={activeModel}
          defaultModelId={defaultModelId}
          availableModels={availableModels}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          lastResultCost={lastResultCost}
          lastResultDuration={lastResultDuration}
          sessionCost={sessionCost}
          cumulativeUsage={cumulativeUsage}
          costBudget={costBudget}
          contextOccupancy={contextOccupancy}
          sessionCwd={sessionCwd}
          serverMode={serverMode}
          isIdle={isIdle}
          activeAgents={activeAgents}
          interventions={interventions}
          connectedClients={connectedClients}
          customAgents={customAgents}
          mcpServers={mcpServers}
          onInvokeAgent={handleInvokeAgent}
          onToggleMcpServer={setMcpServerEnabled}
          onSubmitMcpAuthCode={submitMcpAuthCode}
          setModel={setModel}
          setPermissionMode={setPermissionMode}
          pendingPermissionConfirm={pendingPermissionConfirm}
          onConfirmPermissionMode={confirmPermissionMode}
          onCancelPermissionConfirm={cancelPermissionConfirm}
          conversationId={conversationId}
          sessionContext={sessionContext}
          latencyMs={latencyMs}
          connectionQuality={connectionQuality}
          activePath={activePath}
          // #5424: provider drives context-window resolution — for providers
          // that legitimately report no window (ollama) the usage meter shows
          // the raw token count instead of a percentage against 200k.
          provider={activeSessionProvider}
          modelSwitchSupported={providerCaps.modelSwitchSupported}
          permissionModeSwitchSupported={providerCaps.permissionModeSwitchSupported}
          codexSandbox={activeSessionCodexSandbox}
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
                    // #5518 — re-select LAN vs tunnel for the saved record.
                    void useConnectionStore.getState().connectAuto(savedConnection);
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
      {(connectionPhase === 'reconnecting' || connectionPhase === 'server_restarting' || connectionPhase === 'server_down') && (
        <View testID="reconnect-banner" style={styles.reconnectingBanner}>
          <View style={styles.reconnectingRow}>
            {/* #5725 (#5698) — server_down is terminal: no indefinite spinner. */}
            {connectionPhase !== 'server_down' && (
              <RNActivityIndicator
                testID="reconnect-spinner"
                size="small"
                color={COLORS.accentBlue}
                style={styles.reconnectingSpinner}
              />
            )}
            <Text style={[styles.reconnectingText, { flex: 1 }]}>
              {connectionPhase === 'server_down'
                ? 'Server appears to be down'
                : connectionPhase === 'server_restarting'
                  ? shutdownReason === 'shutdown'
                    ? 'Server shut down'
                    : restartCountdown != null && restartCountdown > 0
                      ? `Server restarting... ~${Math.floor(restartCountdown / 60)}:${String(restartCountdown % 60).padStart(2, '0')}`
                      : 'Server restarting...'
                  : connectionRetryCount > 0
                    ? `Reconnecting (attempt ${connectionRetryCount + 1})...`
                    : 'Reconnecting...'}
            </Text>
            {/* #5725 (#5698) — server_down offers a manual Reconnect (resets the
                ladder + re-dials); the live states keep the Disconnect affordance. */}
            {connectionPhase === 'server_down' ? (
              <TouchableOpacity testID="server-down-reconnect" onPress={retryConnection} style={styles.reconnectDisconnect} accessibilityRole="button" accessibilityLabel="Reconnect">
                <Text style={styles.reconnectDisconnectText}>Reconnect</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={handleStopReconnecting} style={styles.reconnectDisconnect} accessibilityRole="button" accessibilityLabel="Stop reconnecting">
                <Text style={styles.reconnectDisconnectText}>Disconnect</Text>
              </TouchableOpacity>
            )}
          </View>
          {connectionPhase === 'server_restarting' && shutdownReason === 'restart' && (
            <Text style={styles.reconnectingDetail}>Graceful restart</Text>
          )}
          {connectionPhase === 'server_restarting' && !shutdownReason && (
            <Text style={styles.reconnectingDetail}>Recovering from crash</Text>
          )}
          {connectionPhase === 'reconnecting' && connectionError && (
            <Text style={styles.reconnectingDetail}>{connectionError}</Text>
          )}
          {/* #5699 — surface unsent queued messages so the user knows they're
              held (and at risk if they disconnect), rather than silently lost. */}
          {queuedMessageCount > 0 && (
            <Text testID="reconnect-queued-count" style={styles.reconnectingDetail}>
              {queuedMessageCount} unsent message{queuedMessageCount === 1 ? '' : 's'} queued
            </Text>
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

      {/* #4879: Quiet stopped status strip for active session — surfaced
          when the server confirms a user-initiated Stop (session_stopped
          wire message, wired in #4868). Intentionally informational
          rather than error-styled: this is positive feedback that the
          Stop tap landed. Suppressed when health === 'crashed' so the
          loud red crash banner above isn't doubled up on the unlikely
          race where both arrive (defensive — the server only emits
          stopped for clean exits per CliSession._handleChildClose). The
          strip auto-clears on the next `claude_ready` (typically when
          the operator sends another message). */}
      {activeSessionHealth !== 'crashed' && activeSessionStoppedAt !== null && (
        <View
          testID="session-stopped-banner"
          style={[styles.reconnectingBanner, styles.stoppedBanner]}
        >
          <View style={styles.errorBannerContent}>
            <Text
              testID="session-stopped-banner-text"
              style={styles.stoppedBannerText}
              numberOfLines={1}
            >
              {activeSessionStoppedCode !== null && activeSessionStoppedCode !== 0
                ? `Session stopped. (exit ${activeSessionStoppedCode})`
                : 'Session stopped.'}
            </Text>
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

      {/* Unencrypted LAN warning */}
      {!isEncrypted && connectionPhase === 'connected' && wsUrl?.startsWith('ws://') && (
        <View style={styles.lanWarningBanner}>
          <Text style={styles.lanWarningText}>
            Unencrypted LAN connection — auth token sent in plaintext. Use a tunnel for secure remote access.
          </Text>
        </View>
      )}

      {/* Background session notifications */}
      <SessionNotificationBanner />

      {/* Background session progress indicators */}
      <BackgroundSessionProgress />

      {/* Stdin forwarding lost banner (#3595) — render the latched
          `stdinForwardingDisabled` flag from session_list metadata for the
          currently-active session. The flag persists across server restarts
          (#3540 / #3564), so this banner appears immediately after a
          cold-restart reconnect without needing a fresh `error` event. */}
      <StdinDisabledBanner
        visible={!!activeSession?.stdinForwardingDisabled}
        sessionId={activeSessionId}
        onRestart={handleRestartStdinSession}
      />

      {/* #5589 / #5281: observer role banner. Shows only when ANOTHER device is
          the primary (driver) for the active session; names it (when the roster
          resolves the id) and offers an explicit force take-over. */}
      <ObserverBanner
        visible={sessionRole === 'observer'}
        sessionId={activeSessionId}
        driverName={
          connectedClients.find((c) => c.clientId === activePrimaryClientId)?.deviceName ?? null
        }
        onTakeOver={(sid) => claimPrimary(sid, { force: true })}
      />

      {/* #4075: cost-threshold soft warning banner. Server fires once per
          session via `session_cost_threshold_crossed`; user dismissal
          flips `dismissedAt` so the banner stays hidden for this session's
          lifetime even though the record persists. */}
      <CostThresholdBanner
        visible={!!costThresholdWarning && costThresholdWarning.dismissedAt == null}
        costUsd={costThresholdWarning?.costUsd ?? 0}
        thresholdUsd={costThresholdWarning?.thresholdUsd ?? 0}
        onDismiss={() => {
          if (!activeSessionId || !costThresholdWarning) return;
          const { sessionStates } = useConnectionStore.getState();
          const ss = sessionStates[activeSessionId];
          if (!ss?.costThresholdWarning) return;
          useConnectionStore.setState({
            sessionStates: {
              ...sessionStates,
              [activeSessionId]: {
                ...ss,
                costThresholdWarning: { ...ss.costThresholdWarning, dismissedAt: Date.now() },
              },
            },
          });
        }}
      />

      {/* Session timeout warning banner */}
      {timeoutWarning && (
        <SessionTimeoutBanner
          remainingMs={timeoutWarning.remainingMs}
          sessionName={timeoutWarning.sessionName}
          onKeepAlive={() => {
            // Switch to the warned session to make it "active" (server exempts active-viewer sessions)
            if (timeoutWarning.sessionId && timeoutWarning.sessionId !== activeSessionId) {
              switchSession(timeoutWarning.sessionId, { serverNotify: true });
            }
            dismissTimeoutWarning();
          }}
          onDismiss={dismissTimeoutWarning}
        />
      )}

      {/* Dev server preview banner */}
      <DevPreviewBanner previews={devPreviews} onClose={closeDevPreview} />

      {/* Web tasks panel (Claude Code Web cloud delegation) */}
      {webTasks.length > 0 && (
        <WebTasksPanel tasks={webTasks} webFeatures={webFeatures} onTeleport={teleportWebTask} />
      )}

      {/* Content area — split view on tablets in landscape */}
      {!showSessionOverview && (
        layout.isSplitView && hasTerminal && viewMode !== 'files' && viewMode !== 'system' ? (
          <View style={styles.splitContainer}>
            <View style={styles.splitPane}>
              <ErrorBoundary fallbackTitle="Chat view error">
                <ChatView
                  messages={chatMessages}
                  scrollViewRef={scrollViewRef}
                  claudeReady={claudeReady}
                  onSelectOption={handleSelectOption}
                  onSubmitMultiQuestion={handleSubmitMultiQuestion}
                  allowMultiQuestion={allowMultiQuestion}
              allowSingleMultiSelect={allowSingleMultiSelect}
                  isCliMode={isCliMode}
                  selectedIds={selectedIds}
                  isSelecting={isSelecting}
                  isSelectingRef={isSelectingRef}
                  onToggleSelection={toggleSelection}
                  streamingMessageId={streamingMessageId}
                  queuedIds={queuedIds}
                  onCancelQueued={handleCancelQueued}
                  onEditQueued={handleEditQueued}
                  isPlanPending={isPlanPending}
                  planAllowedPrompts={planAllowedPrompts}
                  onApprovePlan={handleApprovePlan}
                  onApprovePlanAcceptEdits={handleApprovePlanAcceptEdits}
                  canApproveAcceptEdits={providerCaps.permissionModeSwitchSupported}
                  onFocusInput={handleFocusInput}
                  searchQuery={searchVisible ? inSessionSearchQuery : undefined}
                  searchMatchIds={searchVisible ? searchMatchIds : undefined}
                  currentMatchId={searchVisible ? currentMatchId : undefined}
                  keyboardVisible={keyboardVisible}
                />
              </ErrorBoundary>
            </View>
            <View style={styles.splitDivider} />
            <View style={styles.splitPane}>
              <ErrorBoundary fallbackTitle="Terminal error">
                <TerminalView ref={terminalRef} onReady={handleTerminalReady} onResize={handleTerminalResize} interactive={terminalInteractive} onInput={handleTerminalInput} onRefresh={canResyncTerminal ? handleTerminalRefresh : undefined} />
              </ErrorBoundary>
            </View>
          </View>
        ) : viewMode === 'chat' ? (
          <ErrorBoundary fallbackTitle="Chat view error">
            <ChatView
              messages={messages}
              scrollViewRef={scrollViewRef}
              claudeReady={claudeReady}
              onSelectOption={handleSelectOption}
              onSubmitMultiQuestion={handleSubmitMultiQuestion}
              allowMultiQuestion={allowMultiQuestion}
              allowSingleMultiSelect={allowSingleMultiSelect}
              isCliMode={isCliMode}
              selectedIds={selectedIds}
              isSelecting={isSelecting}
              isSelectingRef={isSelectingRef}
              onToggleSelection={toggleSelection}
              streamingMessageId={streamingMessageId}
              queuedIds={queuedIds}
              onCancelQueued={handleCancelQueued}
              onEditQueued={handleEditQueued}
              isPlanPending={isPlanPending}
              planAllowedPrompts={planAllowedPrompts}
              onApprovePlan={handleApprovePlan}
              onApprovePlanAcceptEdits={handleApprovePlanAcceptEdits}
              canApproveAcceptEdits={providerCaps.permissionModeSwitchSupported}
              onFocusInput={handleFocusInput}
              searchQuery={searchVisible ? inSessionSearchQuery : undefined}
              searchMatchIds={searchVisible ? searchMatchIds : undefined}
              currentMatchId={searchVisible ? currentMatchId : undefined}
              keyboardVisible={keyboardVisible}
            />
          </ErrorBoundary>
        ) : viewMode === 'files' ? (
          <FileBrowser />
        ) : viewMode === 'system' ? (
          <ErrorBoundary fallbackTitle="System view error">
            <ChatView
              messages={messages}
              scrollViewRef={scrollViewRef}
              claudeReady={claudeReady}
              onSelectOption={handleSelectOption}
              onSubmitMultiQuestion={handleSubmitMultiQuestion}
              allowMultiQuestion={allowMultiQuestion}
              allowSingleMultiSelect={allowSingleMultiSelect}
              isCliMode={isCliMode}
              selectedIds={selectedIds}
              isSelecting={isSelecting}
              isSelectingRef={isSelectingRef}
              onToggleSelection={toggleSelection}
              streamingMessageId={null}
              searchQuery={searchVisible ? inSessionSearchQuery : undefined}
              searchMatchIds={searchVisible ? searchMatchIds : undefined}
              currentMatchId={searchVisible ? currentMatchId : undefined}
              keyboardVisible={keyboardVisible}
            />
          </ErrorBoundary>
        ) : (
          // #6003 — interactive for a user-shell PTY (xterm stdin + terminal_input);
          // read-only mirror for claude-tui (terminal_output renders via the
          // write-callback path, onData stays disabled so no input is forwarded).
          <ErrorBoundary fallbackTitle="Terminal error">
            <TerminalView ref={terminalRef} onReady={handleTerminalReady} onResize={handleTerminalResize} interactive={terminalInteractive} onInput={handleTerminalInput} onRefresh={canResyncTerminal ? handleTerminalRefresh : undefined} />
          </ErrorBoundary>
        )
      )}

      {/* Activity indicator (#3758) — "Working… last activity Ns ago"
          so users can distinguish a still-active long turn from a stalled
          one. Self-gates on busy/idle; renders nothing when idle. */}
      <ActivityIndicator />

      {/* Check-in chip (#3899) — soft inactivity prompt with a one-tap
          "Status update?" follow-up. Self-gates on the active session's
          inactivityWarning slot; renders nothing when none is
          outstanding. Stacks below the activity indicator so a quiet
          session gets a visible affordance without losing the live
          counter. */}
      <CheckInChip />

      {/* Input area */}
      <InputBar
        ref={inputRef}
        onChangeText={handleChangeText}
        onSend={handleSend}
        onInterrupt={sendInterrupt}
        onClearTerminal={handleClearTerminal}
        onKeyPress={handleKeyPress}
        enterToSend={enterToSend}
        onToggleEnterMode={handleToggleEnterMode}
        isStreaming={!!streamingMessageId}
        isBusy={!isIdle}
        claudeReady={claudeReady}
        viewMode={viewMode}
        hasTerminal={hasTerminal}
        bottomPadding={bottomPadding}
        disabled={connectionPhase !== 'connected'}
        disabledPlaceholder={viewingCachedSession ? 'Offline — viewing cached history' : connectionPhase === 'server_restarting' ? 'Server restarting...' : 'Reconnecting...'}
        slashCommands={slashCommands}
        activityState={activityState}
        queuedCount={queuedIds.size}
        isRecognizing={isRecognizing}
        onMicPress={speechAvailable ? handleMicPress : undefined}
        speechUnavailable={!speechAvailable}
        attachments={pendingAttachments}
        onAttach={handleAttach}
        onCamera={handleCamera}
        onRemoveAttachment={handleRemoveAttachment}
        pastedTextBlocks={pastedTextBlocks}
        onInspectPastedText={handleInspectPastedText}
        onRemovePastedText={handleRemovePastedText}
      />

      {/* Pasted-text inspect modal (#3797) */}
      <PastedTextModal
        visible={inspectedPastedTextId != null}
        id={inspectedPastedTextId}
        content={pastedTextBlocks.find(b => b.id === inspectedPastedTextId)?.content ?? ''}
        onClose={() => setInspectedPastedTextId(null)}
        onRemove={handleRemovePastedText}
      />

      {/* Create session modal */}
      <CreateSessionModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />

      {/* Secondary modal panels (#5654): diff viewer, checkpoints, git view */}
      <SessionPanels
        showDiffViewer={showDiffViewer}
        onCloseDiffViewer={closeDiffViewer}
        showCheckpoints={showCheckpoints}
        onCloseCheckpoints={closeCheckpoints}
        showGitView={showGitView}
        onCloseGitView={closeGitView}
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
  lanWarningBanner: {
    backgroundColor: '#7a4a00',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  lanWarningText: {
    color: '#ffcc80',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center' as const,
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
    alignItems: 'center',
    padding: 8,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  secondaryToolsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  modeButton: {
    flex: 0,
    paddingHorizontal: 16,
    paddingVertical: 8,
    // #5634 — 44pt minimum touch target for the primary view-mode tabs.
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
  systemBadge: {
    position: 'absolute',
    top: 4,
    right: 0,
    backgroundColor: COLORS.accentBlue,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  systemBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
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
  reconnectingRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  reconnectingSpinner: {
    marginRight: 4,
  },
  reconnectDisconnect: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: COLORS.accentRed,
  },
  reconnectDisconnectText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600' as const,
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
  // #4879: subtle "Session stopped." status strip. Uses the muted
  // backgroundCard surface (greyed out, NOT the red/orange accent banners
  // reserved for crashes / warnings) and textMuted copy so the operator
  // reads it as a calm confirmation rather than an error.
  stoppedBanner: {
    backgroundColor: COLORS.backgroundCard,
  },
  stoppedBannerText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '500',
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
