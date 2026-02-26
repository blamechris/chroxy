import React, { useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { useConnectionStore } from '../store/connection';
import type { ConversationSummary } from '../store/types';
import { COLORS } from '../constants/colors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// List item type — either a group header or a conversation row
// ---------------------------------------------------------------------------

type ListItem =
  | { kind: 'header'; projectName: string; key: string }
  | { kind: 'conversation'; data: ConversationSummary; key: string };

// ---------------------------------------------------------------------------
// ConversationRow
// ---------------------------------------------------------------------------

function ConversationRow({
  item,
  onResume,
}: {
  item: ConversationSummary;
  onResume: (conversationId: string, cwd?: string) => void;
}) {
  const preview = item.preview
    ? item.preview.length > 80
      ? item.preview.slice(0, 80) + '...'
      : item.preview
    : 'No preview available';

  return (
    <View style={styles.row}>
      <View style={styles.rowContent}>
        <Text style={styles.preview} numberOfLines={2}>
          {preview}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{formatRelativeTime(item.modifiedAtMs)}</Text>
          <Text style={styles.metaDot}>{'\u00B7'}</Text>
          <Text style={styles.metaText}>{formatSize(item.sizeBytes)}</Text>
        </View>
      </View>
      <TouchableOpacity
        style={styles.resumeButton}
        onPress={() => onResume(item.conversationId, item.cwd || undefined)}
        accessibilityRole="button"
        accessibilityLabel={`Resume conversation: ${preview}`}
      >
        <Text style={styles.resumeButtonText}>Resume</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// HistoryScreen
// ---------------------------------------------------------------------------

export function HistoryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();

  const conversationHistory = useConnectionStore((s) => s.conversationHistory);
  const conversationHistoryLoading = useConnectionStore((s) => s.conversationHistoryLoading);
  const fetchConversationHistory = useConnectionStore((s) => s.fetchConversationHistory);
  const resumeConversation = useConnectionStore((s) => s.resumeConversation);

  // Fetch on mount
  useEffect(() => {
    fetchConversationHistory();
  }, [fetchConversationHistory]);

  // Build grouped list items: header + conversations per project
  const listItems = useMemo(() => {
    const groups = new Map<string, ConversationSummary[]>();
    for (const conv of conversationHistory) {
      const name = conv.projectName || 'Unknown Project';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(conv);
    }

    const items: ListItem[] = [];
    for (const [projectName, convs] of groups) {
      items.push({ kind: 'header', projectName, key: `header-${projectName}` });
      for (const conv of convs) {
        items.push({ kind: 'conversation', data: conv, key: conv.conversationId });
      }
    }
    return items;
  }, [conversationHistory]);

  const handleResume = useCallback(
    (conversationId: string, cwd?: string) => {
      resumeConversation(conversationId, cwd);
      navigation.goBack();
    },
    [resumeConversation, navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.kind === 'header') {
        return (
          <View style={styles.groupHeader}>
            <Text style={styles.groupHeaderText}>{item.projectName}</Text>
          </View>
        );
      }
      return <ConversationRow item={item.data} onResume={handleResume} />;
    },
    [handleResume],
  );

  const keyExtractor = useCallback((item: ListItem) => item.key, []);

  // Loading state
  if (conversationHistoryLoading && conversationHistory.length === 0) {
    return (
      <View style={[styles.container, styles.centered, { paddingBottom: insets.bottom }]}>
        <ActivityIndicator size="large" color={COLORS.accentBlue} />
        <Text style={styles.loadingText}>Loading conversations...</Text>
      </View>
    );
  }

  // Empty state
  if (!conversationHistoryLoading && conversationHistory.length === 0) {
    return (
      <View style={[styles.container, styles.centered, { paddingBottom: insets.bottom }]}>
        <Text style={styles.emptyText}>No conversation history found</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={listItems}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        onRefresh={fetchConversationHistory}
        refreshing={conversationHistoryLoading}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: COLORS.textMuted,
    fontSize: 14,
    marginTop: 12,
  },
  emptyText: {
    color: COLORS.textDisabled,
    fontSize: 15,
    textAlign: 'center',
  },
  listContent: {
    paddingBottom: 16,
  },
  groupHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  groupHeaderText: {
    color: COLORS.accentPurple,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  rowContent: {
    flex: 1,
    marginRight: 12,
  },
  preview: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  metaText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  metaDot: {
    color: COLORS.textDim,
    fontSize: 12,
  },
  resumeButton: {
    backgroundColor: COLORS.accentBlueLight,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
  },
  resumeButtonText: {
    color: COLORS.accentBlue,
    fontSize: 13,
    fontWeight: '600',
  },
});
