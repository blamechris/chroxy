import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { COLORS } from '../constants/colors';
import { ICON_CHECK, ICON_CROSS } from '../constants/icons';
import { Icon } from './Icon';
import type { WebTask, WebFeatureStatus } from '../store/types';

interface WebTasksPanelProps {
  tasks: WebTask[];
  webFeatures: WebFeatureStatus;
  onTeleport: (taskId: string) => void;
}

function statusBadge(status: WebTask['status']) {
  switch (status) {
    case 'pending':
      return { color: COLORS.accentOrange, label: 'Pending' };
    case 'running':
      return { color: COLORS.accentBlue, label: 'Running' };
    case 'completed':
      return { color: COLORS.accentGreen, label: 'Completed' };
    case 'failed':
      return { color: COLORS.accentRed, label: 'Failed' };
  }
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function WebTasksPanel({ tasks, webFeatures, onTeleport }: WebTasksPanelProps) {
  const [expanded, setExpanded] = useState(true);

  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(!expanded)}
        accessibilityRole="button"
        accessibilityLabel={`Web Tasks (${tasks.length}), ${expanded ? 'collapse' : 'expand'}`}
      >
        <Icon name="cloud" size={16} color={COLORS.accentBlue} />
        <Text style={styles.headerText}>
          Web Tasks ({tasks.length})
        </Text>
        <Text style={styles.chevron}>{expanded ? '\u25B4' : '\u25BE'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.taskList}>
          {sorted.map((task) => {
            const badge = statusBadge(task.status);
            return (
              <View key={task.taskId} style={styles.taskRow}>
                <View style={styles.taskInfo}>
                  <View style={styles.taskHeader}>
                    {task.status === 'running' ? (
                      <ActivityIndicator size="small" color={badge.color} style={styles.spinner} />
                    ) : (
                      <Text style={[styles.statusDot, { color: badge.color }]}>
                        {task.status === 'completed' ? ICON_CHECK : task.status === 'failed' ? ICON_CROSS : '\u25CF'}
                      </Text>
                    )}
                    <Text style={styles.taskPrompt} numberOfLines={2}>
                      {task.prompt}
                    </Text>
                  </View>
                  <View style={styles.taskMeta}>
                    <Text style={[styles.badge, { borderColor: badge.color, color: badge.color }]}>
                      {badge.label}
                    </Text>
                    <Text style={styles.timeText}>{timeAgo(task.createdAt)}</Text>
                  </View>
                  {task.error && (
                    <Text style={styles.errorText} numberOfLines={2}>{task.error}</Text>
                  )}
                  {task.result && (
                    <Text style={styles.resultText} numberOfLines={3}>{task.result}</Text>
                  )}
                </View>
                {task.status === 'completed' && webFeatures.teleport && (
                  <TouchableOpacity
                    style={styles.teleportButton}
                    onPress={() => onTeleport(task.taskId)}
                    accessibilityLabel="Pull to local"
                  >
                    <Icon name="download" size={14} color={COLORS.accentBlue} />
                    <Text style={styles.teleportText}>Pull</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 8,
    marginHorizontal: 12,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  headerIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  headerText: {
    color: COLORS.accentBlue,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  chevron: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  taskList: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderPrimary,
  },
  taskInfo: {
    flex: 1,
  },
  taskHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    fontSize: 10,
    marginRight: 6,
    width: 14,
    textAlign: 'center',
  },
  spinner: {
    marginRight: 6,
    width: 14,
  },
  taskPrompt: {
    color: COLORS.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  taskMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    marginLeft: 20,
  },
  badge: {
    fontSize: 10,
    fontWeight: '600',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginRight: 8,
  },
  timeText: {
    color: COLORS.textMuted,
    fontSize: 10,
  },
  errorText: {
    color: COLORS.accentRed,
    fontSize: 11,
    marginTop: 4,
    marginLeft: 20,
  },
  resultText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 4,
    marginLeft: 20,
  },
  teleportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.accentBlueLight,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 8,
  },
  teleportIcon: {
    fontSize: 14,
    color: COLORS.accentBlue,
    marginRight: 4,
  },
  teleportText: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontWeight: '600',
  },
});
