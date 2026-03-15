import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, AccessibilityInfo, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ModelInfo, ContextUsage, AgentInfo, ConnectedClient, CustomAgent, SessionContext, McpServer } from '../store/connection';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';

// Connection quality → color mapping (consistent 13% opacity backgrounds)
const QUALITY_COLORS = {
  good: { bg: COLORS.accentGreenLight, fg: COLORS.accentGreen },
  fair: { bg: COLORS.accentOrangeSubtle, fg: COLORS.accentOrange },
  poor: { bg: COLORS.accentRedSubtle, fg: COLORS.accentRed },
} as const;

// -- Props --

export interface SettingsBarProps {
  expanded: boolean;
  onToggle: () => void;
  activeModel: string | null;
  defaultModelId?: string | null;
  availableModels: ModelInfo[];
  permissionMode: string | null;
  availablePermissionModes: { id: string; label: string }[];
  lastResultCost: number | null;
  lastResultDuration: number | null;
  sessionCost?: number | null;
  costBudget?: number | null;
  contextUsage: ContextUsage | null;
  sessionCwd: string | null;
  serverMode: 'cli' | null;
  isIdle: boolean;
  activeAgents: AgentInfo[];
  connectedClients: ConnectedClient[];
  customAgents: CustomAgent[];
  mcpServers: McpServer[];
  onInvokeAgent?: (agentName: string) => void;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
  pendingPermissionConfirm?: { mode: string; warning: string } | null;
  onConfirmPermissionMode?: (mode: string) => void;
  onCancelPermissionConfirm?: () => void;
  conversationId?: string | null;
  sessionContext?: SessionContext | null;
  latencyMs?: number | null;
  connectionQuality?: 'good' | 'fair' | 'poor' | null;
}

// -- Helpers --

export function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs.toString().padStart(2, '0')}s`;
}

function PulsingDot({ reduceMotion }: { reduceMotion: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, opacity]);

  return <Animated.View style={[styles.agentDot, { opacity }]} />;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

// -- Component --

export function SettingsBar({
  expanded,
  onToggle,
  activeModel,
  defaultModelId,
  availableModels,
  permissionMode,
  availablePermissionModes,
  lastResultCost,
  lastResultDuration,
  sessionCost,
  costBudget,
  contextUsage,
  sessionCwd,
  serverMode,
  isIdle,
  activeAgents,
  connectedClients,
  customAgents,
  mcpServers,
  onInvokeAgent,
  setModel,
  setPermissionMode,
  pendingPermissionConfirm,
  onConfirmPermissionMode,
  onCancelPermissionConfirm,
  conversationId,
  sessionContext,
  latencyMs,
  connectionQuality,
}: SettingsBarProps) {
  // Elapsed time ticker — only runs when expanded with active agents
  const [now, setNow] = useState(Date.now());
  const showAgentTimers = expanded && activeAgents.length > 0;
  useEffect(() => {
    if (!showAgentTimers) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [showAgentTimers]);

  // Reduce-motion preference for pulsing dots
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  // Show confirmation dialog when server challenges auto permission mode
  useEffect(() => {
    if (!pendingPermissionConfirm) return;
    const { mode, warning } = pendingPermissionConfirm;
    Alert.alert(
      'Enable Auto Mode?',
      warning,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => onCancelPermissionConfirm?.() },
        { text: 'Enable', style: 'destructive', onPress: () => onConfirmPermissionMode?.(mode) },
      ],
      { cancelable: true, onDismiss: () => onCancelPermissionConfirm?.() },
    );
  }, [pendingPermissionConfirm, onConfirmPermissionMode, onCancelPermissionConfirm]);

  // Truncate working directory path for collapsed view
  let truncatedCwd: string | null = null;
  if (sessionCwd) {
    // Replace common home-directory prefixes with "~" for macOS, Linux, and Windows
    const homeShortened = sessionCwd.replace(
      /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/,
      '~'
    );
    truncatedCwd = homeShortened.length > 30 ? homeShortened.slice(-30) : homeShortened;
  }

  // Build collapsed summary: "main · 3 dirty · chroxy · Opus · $0.02"
  const summaryParts: string[] = [];

  if (sessionContext?.gitBranch) {
    summaryParts.push(sessionContext.gitBranch);
    if (sessionContext.gitDirty > 0) {
      summaryParts.push(`${sessionContext.gitDirty} dirty`);
    }
    if (sessionContext.projectName) {
      summaryParts.push(sessionContext.projectName);
    }
  } else if (truncatedCwd) {
    summaryParts.push(truncatedCwd);
  }
  if (serverMode && !sessionContext) {
    summaryParts.push(serverMode);
  }

  if (activeModel) {
    const modelInfo = availableModels.find((m) => m.id === activeModel || m.fullId === activeModel);
    summaryParts.push(modelInfo?.label || activeModel);
  }
  if (permissionMode) {
    const permInfo = availablePermissionModes.find((m) => m.id === permissionMode);
    summaryParts.push(permInfo?.label || permissionMode);
  }
  if (sessionCost != null) {
    summaryParts.push(`$${sessionCost.toFixed(2)}`);
  } else if (lastResultCost != null) {
    summaryParts.push(`$${lastResultCost.toFixed(2)}`);
  }
  if (contextUsage) {
    const total = contextUsage.inputTokens + contextUsage.outputTokens;
    if (total >= 1_000_000) summaryParts.push(`${(total / 1_000_000).toFixed(1)}M`);
    else if (total >= 1_000) summaryParts.push(`${(total / 1_000).toFixed(1)}k`);
    else summaryParts.push(`${total}`);
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={onToggle} style={styles.summaryRow} activeOpacity={0.7}>
        <View
          style={[styles.statusDot, { backgroundColor: isIdle ? COLORS.accentGreen : COLORS.accentOrange }]}
          accessibilityLabel={isIdle ? 'Agent idle' : 'Agent busy'}
          accessibilityRole="image"
        />
        {activeAgents.length > 0 && (
          <View
            style={styles.agentBadge}
            accessibilityLabel={`${activeAgents.length} background agent${activeAgents.length !== 1 ? 's' : ''} running`}
            accessibilityRole="text"
          >
            <Text style={styles.agentBadgeText}>
              {activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}
            </Text>
          </View>
        )}
        {connectionQuality && (() => {
          const qc = QUALITY_COLORS[connectionQuality];
          return (
            <View
              style={[styles.qualityBadge, { backgroundColor: qc.bg }]}
              accessibilityLabel={`Connection quality: ${connectionQuality}${latencyMs != null ? `, ${latencyMs}ms latency` : ''}`}
              accessibilityRole="text"
            >
              <View style={[styles.qualityDot, { backgroundColor: qc.fg }]} />
              <Text style={[styles.qualityText, { color: qc.fg }]}>
                {latencyMs != null ? `${latencyMs}ms` : connectionQuality}
              </Text>
            </View>
          );
        })()}
        {connectedClients.length > 1 && (
          <View
            style={styles.deviceBadge}
            accessibilityLabel={`${connectedClients.length} devices connected`}
            accessibilityRole="text"
          >
            <Text style={styles.deviceBadgeText}>
              {connectedClients.length} devices
            </Text>
          </View>
        )}
        <Text style={styles.summaryText} numberOfLines={1}>
          {summaryParts.join(' \u00B7 ') || 'Settings'}
        </Text>
        {expanded ? <Icon name="chevronDown" size={12} color={COLORS.textMuted} /> : <Icon name="chevronRight" size={12} color={COLORS.textMuted} />}
      </TouchableOpacity>
      {expanded && (
        <View style={styles.expandedContent}>
          {sessionContext?.gitBranch && (
            <View style={styles.contextRow}>
              <Text style={styles.contextText}>
                {sessionContext.gitBranch}
                {sessionContext.gitDirty > 0 ? ` \u00B7 ${sessionContext.gitDirty} uncommitted` : ''}
                {sessionContext.gitAhead > 0 ? ` \u00B7 ${sessionContext.gitAhead} ahead` : ''}
                {sessionContext.projectName ? ` \u00B7 ${sessionContext.projectName}` : ''}
              </Text>
            </View>
          )}
          {availableModels.length > 0 && (
                <View style={styles.chipRow}>
                  {availableModels.map((m) => {
                    const isActive = activeModel === m.id || activeModel === m.fullId
                      || (!activeModel && defaultModelId === m.id);
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.chip, isActive && styles.chipActive]}
                        onPress={() => setModel(m.id)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              {availablePermissionModes.length > 0 && (
                <View style={styles.chipRow}>
                  {availablePermissionModes.map((m) => {
                    const isActive = permissionMode === m.id;
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.chip, isActive && styles.chipActive]}
                        onPress={() => setPermissionMode(m.id)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              {(lastResultCost != null || sessionCost != null || contextUsage) && (
                <View style={styles.contextRow}>
                  {sessionCost != null ? (
                    <Text style={styles.contextText}>
                      Session: ${sessionCost.toFixed(4)}
                      {costBudget != null ? ` / $${costBudget.toFixed(2)}` : ''}
                      {lastResultDuration != null ? ` \u00B7 ${(lastResultDuration / 1000).toFixed(1)}s` : ''}
                    </Text>
                  ) : lastResultCost != null ? (
                    <Text style={styles.contextText}>
                      ${lastResultCost.toFixed(4)}
                      {lastResultDuration != null ? ` \u00B7 ${(lastResultDuration / 1000).toFixed(1)}s` : ''}
                    </Text>
                  ) : null}
                  {contextUsage && (
                    <Text style={styles.contextText}>
                      {formatTokenCount(contextUsage.inputTokens + contextUsage.outputTokens)}
                    </Text>
                  )}
                </View>
              )}
              {costBudget != null && sessionCost != null && (
                <View style={styles.budgetBarContainer}>
                  <View style={[styles.budgetBarFill, {
                    width: `${Math.min(100, (sessionCost / costBudget) * 100)}%` as `${number}%`,
                    backgroundColor: sessionCost / costBudget >= 1.0 ? COLORS.accentRed : sessionCost / costBudget >= 0.8 ? COLORS.accentOrange : COLORS.accentGreen,
                  }]} />
                </View>
              )}
          {conversationId && (
            <TouchableOpacity
              style={styles.conversationIdRow}
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(conversationId);
                  Alert.alert(
                    'Copied',
                    `Resume this conversation from your terminal:\n\nclaude --resume ${conversationId}`,
                  );
                } catch {
                  Alert.alert('Error', 'Failed to copy conversation ID.');
                }
              }}
              accessibilityRole="button"
              accessibilityLabel="Copy conversation ID"
            >
              <Text style={styles.conversationIdLabel}>Conversation ID</Text>
              <Text style={styles.conversationIdValue} numberOfLines={1}>
                {conversationId.slice(0, 8)}...
              </Text>
            </TouchableOpacity>
          )}
          {activeAgents.length > 0 && (
            <View style={styles.agentSection}>
              <Text style={styles.agentSectionTitle}>
                Running Agents ({activeAgents.length})
              </Text>
              {activeAgents.map((agent) => (
                <View key={agent.toolUseId} style={styles.agentEntry}>
                  <PulsingDot reduceMotion={reduceMotion} />
                  <Text style={styles.agentDescription} numberOfLines={2}>
                    {agent.description}
                  </Text>
                  <Text style={styles.agentElapsed}>
                    {formatElapsed(agent.startedAt, now)}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {connectedClients.length > 1 && (
            <View style={styles.agentSection}>
              <Text style={styles.deviceSectionTitle}>
                Connected Devices ({connectedClients.length})
              </Text>
              {connectedClients.map((client) => (
                <View key={client.clientId} style={styles.agentEntry}>
                  <View style={[styles.statusDot, { backgroundColor: COLORS.accentBlue }]} />
                  <Text style={styles.agentDescription} numberOfLines={1}>
                    {client.deviceName || client.deviceType}{client.isSelf ? ' (this device)' : ''}
                  </Text>
                  <Text style={styles.agentElapsed}>
                    {client.platform}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {mcpServers.length > 0 && (
            <View style={styles.agentSection}>
              <Text style={styles.deviceSectionTitle}>
                MCP Servers ({mcpServers.length})
              </Text>
              {mcpServers.map((server) => (
                <View key={server.name} style={styles.agentEntry}>
                  <View style={[styles.statusDot, { backgroundColor: server.status === 'connected' ? COLORS.accentGreen : COLORS.textMuted }]} />
                  <Text style={styles.agentDescription} numberOfLines={1}>
                    {server.name}
                  </Text>
                  <Text style={styles.agentElapsed}>
                    {server.status}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {customAgents.length > 0 && (
            <View style={styles.agentSection}>
              <Text style={styles.customAgentSectionTitle}>
                Custom Agents ({customAgents.length})
              </Text>
              {customAgents.map((agent) => (
                <TouchableOpacity
                  key={agent.name}
                  style={styles.customAgentEntry}
                  onPress={() => onInvokeAgent?.(agent.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`Invoke agent ${agent.name}`}
                >
                  <View style={[styles.statusDot, { backgroundColor: COLORS.accentGreen }]} />
                  <View style={styles.customAgentInfo}>
                    <Text style={styles.customAgentName}>{agent.name}</Text>
                    {agent.description ? (
                      <Text style={styles.customAgentDesc} numberOfLines={1}>{agent.description}</Text>
                    ) : null}
                  </View>
                  {agent.source === 'project' && (
                    <Text style={styles.customAgentBadge}>project</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    minHeight: 44,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  summaryText: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  chevron: {
    color: COLORS.textDim,
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
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1,
    borderColor: COLORS.borderTransparent,
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: COLORS.accentBlueSubtle,
    borderColor: COLORS.accentBlueBorderStrong,
  },
  chipText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '500',
  },
  chipTextActive: {
    color: COLORS.accentBlue,
  },
  contextRow: {
    flexDirection: 'row',
    gap: 12,
  },
  contextText: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  qualityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
    gap: 3,
  },
  qualityDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  qualityText: {
    fontSize: 9,
    fontWeight: '600',
  },
  budgetBarContainer: {
    height: 3,
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 1.5,
    overflow: 'hidden' as const,
  },
  budgetBarFill: {
    height: 3,
    borderRadius: 1.5,
  },
  deviceBadge: {
    backgroundColor: COLORS.accentBlueSubtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
  },
  deviceBadgeText: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontWeight: '600',
  },
  deviceSectionTitle: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  agentBadge: {
    backgroundColor: COLORS.accentPurpleSubtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
  },
  agentBadgeText: {
    color: COLORS.accentPurple,
    fontSize: 10,
    fontWeight: '600',
  },
  agentSection: {
    gap: 4,
  },
  agentSectionTitle: {
    color: COLORS.accentPurple,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  agentEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentPurple,
  },
  agentDescription: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  agentElapsed: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginLeft: 8,
  },
  customAgentSectionTitle: {
    color: COLORS.accentGreen,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  customAgentEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    minHeight: 44,
  },
  customAgentInfo: {
    flex: 1,
  },
  customAgentName: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '600',
  },
  customAgentDesc: {
    color: COLORS.textDim,
    fontSize: 10,
    marginTop: 1,
  },
  customAgentBadge: {
    color: COLORS.textDim,
    fontSize: 9,
    backgroundColor: COLORS.backgroundCard,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
  conversationIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    minHeight: 32,
  },
  conversationIdLabel: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  conversationIdValue: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginLeft: 8,
  },
});
