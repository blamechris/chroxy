import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { ModelInfo, ClaudeStatus, ContextUsage } from '../store/connection';
import { ICON_CHEVRON_RIGHT, ICON_CHEVRON_DOWN } from '../constants/icons';
import { COLORS } from '../constants/colors';


// -- Props --

export interface SettingsBarProps {
  expanded: boolean;
  onToggle: () => void;
  activeModel: string | null;
  availableModels: ModelInfo[];
  permissionMode: string | null;
  availablePermissionModes: { id: string; label: string }[];
  lastResultCost: number | null;
  lastResultDuration: number | null;
  contextUsage: ContextUsage | null;
  claudeStatus: ClaudeStatus | null;
  sessionCwd: string | null;
  serverMode: 'cli' | 'terminal' | null;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
}

// -- Helpers --

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
  availableModels,
  permissionMode,
  availablePermissionModes,
  lastResultCost,
  lastResultDuration,
  contextUsage,
  claudeStatus,
  sessionCwd,
  serverMode,
  setModel,
  setPermissionMode,
}: SettingsBarProps) {
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

  // Build collapsed summary: "~/Projects/chroxy · cli · Opus · $0.02"
  const summaryParts: string[] = [];

  if (truncatedCwd) {
    summaryParts.push(truncatedCwd);
  }
  if (serverMode) {
    summaryParts.push(serverMode);
  }

  // PTY mode: use claudeStatus if available
  if (claudeStatus) {
    if (claudeStatus.model) {
      summaryParts.push(claudeStatus.model);
    }
    if (typeof claudeStatus.cost === 'number') {
      summaryParts.push(`$${claudeStatus.cost.toFixed(2)}`);
    }
    if (claudeStatus.contextTokens) {
      summaryParts.push(claudeStatus.contextTokens);
    }
  } else {
    // CLI mode: use existing fields
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
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={onToggle} style={styles.summaryRow} activeOpacity={0.7}>
        <Text style={styles.summaryText} numberOfLines={1}>
          {summaryParts.join(' \u00B7 ') || 'Settings'}
        </Text>
        <Text style={styles.chevron}>{expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.expandedContent}>
          {claudeStatus ? (
            // PTY mode: display claudeStatus data
            <View style={styles.contextRow}>
              {(claudeStatus.model || typeof claudeStatus.cost === 'number') && (
                <Text style={styles.contextText}>
                  {claudeStatus.model || 'Unknown'}
                  {typeof claudeStatus.cost === 'number' && ` \u00B7 $${claudeStatus.cost.toFixed(4)}`}
                </Text>
              )}
              {claudeStatus.contextTokens && typeof claudeStatus.contextPercent === 'number' && (
                <Text style={styles.contextText}>
                  {claudeStatus.contextTokens} ({claudeStatus.contextPercent}%)
                </Text>
              )}
              {typeof claudeStatus.compactPercent === 'number' && (
                <Text style={styles.contextText}>
                  {claudeStatus.compactPercent}% til compact
                </Text>
              )}
              {typeof claudeStatus.messageCount === 'number' && claudeStatus.messageCount > 0 && (
                <Text style={styles.contextText}>
                  {claudeStatus.messageCount} msg{claudeStatus.messageCount !== 1 ? 's' : ''}
                </Text>
              )}
            </View>
          ) : (
            // CLI mode: display existing fields
            <>
              {availableModels.length > 0 && (
                <View style={styles.chipRow}>
                  {availableModels.map((m) => {
                    const isActive = activeModel === m.id || activeModel === m.fullId;
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
              {(lastResultCost != null || contextUsage) && (
                <View style={styles.contextRow}>
                  {lastResultCost != null && (
                    <Text style={styles.contextText}>
                      ${lastResultCost.toFixed(4)}
                      {lastResultDuration != null ? ` \u00B7 ${(lastResultDuration / 1000).toFixed(1)}s` : ''}
                    </Text>
                  )}
                  {contextUsage && (
                    <Text style={styles.contextText}>
                      {formatTokenCount(contextUsage.inputTokens + contextUsage.outputTokens)}
                    </Text>
                  )}
                </View>
              )}
            </>
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
});
