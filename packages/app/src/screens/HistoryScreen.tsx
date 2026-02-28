import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
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
import type { ConversationSummary, SearchResult } from '../store/types';
import { COLORS } from '../constants/colors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
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
// SearchResultRow
// ---------------------------------------------------------------------------

function SearchResultRow({
  item,
  onResume,
}: {
  item: SearchResult;
  onResume: (conversationId: string, cwd?: string) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowContent}>
        <Text style={styles.searchProjectName} numberOfLines={1}>
          {item.projectName}
        </Text>
        <Text style={styles.searchSnippet} numberOfLines={3}>
          {item.snippet}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>
            {item.matchCount} match{item.matchCount > 1 ? 'es' : ''}
          </Text>
          {item.preview && (
            <>
              <Text style={styles.metaDot}>{'\u00B7'}</Text>
              <Text style={styles.metaText} numberOfLines={1}>
                {item.preview.slice(0, 40)}
              </Text>
            </>
          )}
        </View>
      </View>
      <TouchableOpacity
        style={styles.resumeButton}
        onPress={() => onResume(item.conversationId, item.cwd || undefined)}
        accessibilityRole="button"
        accessibilityLabel={`Resume matching conversation in ${item.projectName}`}
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
  const searchResults = useConnectionStore((s) => s.searchResults);
  const searchLoading = useConnectionStore((s) => s.searchLoading);
  const searchConversations = useConnectionStore((s) => s.searchConversations);
  const clearSearchResults = useConnectionStore((s) => s.clearSearchResults);

  const [searchQuery, setSearchQuery] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch on mount
  useEffect(() => {
    fetchConversationHistory();
    return () => {
      clearSearchResults();
    };
  }, [fetchConversationHistory, clearSearchResults]);

  // Debounced search (300ms)
  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (text.trim().length >= 2) {
      searchTimerRef.current = setTimeout(() => {
        searchConversations(text.trim());
      }, 300);
    } else {
      clearSearchResults();
    }
  }, [searchConversations, clearSearchResults]);

  const isSearching = searchQuery.trim().length >= 2;

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

  const renderSearchResult = useCallback(
    ({ item }: { item: SearchResult }) => (
      <SearchResultRow item={item} onResume={handleResume} />
    ),
    [handleResume],
  );

  const keyExtractor = useCallback((item: ListItem) => item.key, []);
  const searchKeyExtractor = useCallback((item: SearchResult) => item.conversationId, []);

  // Search bar
  const searchBar = (
    <View style={styles.searchBar}>
      <TextInput
        style={styles.searchInput}
        placeholder="Search across conversations..."
        placeholderTextColor={COLORS.textDim}
        value={searchQuery}
        onChangeText={handleSearchChange}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {searchQuery.length > 0 && (
        <TouchableOpacity
          style={styles.clearButton}
          onPress={() => handleSearchChange('')}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Text style={styles.clearButtonText}>{'\u2715'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // Loading state (initial load, no search active)
  if (!isSearching && conversationHistoryLoading && conversationHistory.length === 0) {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        {searchBar}
        <View style={[styles.centered, { flex: 1 }]}>
          <ActivityIndicator size="large" color={COLORS.accentBlue} />
          <Text style={styles.loadingText}>Loading conversations...</Text>
        </View>
      </View>
    );
  }

  // Search mode
  if (isSearching) {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        {searchBar}
        {searchLoading ? (
          <View style={[styles.centered, { flex: 1 }]}>
            <ActivityIndicator size="small" color={COLORS.accentBlue} />
            <Text style={styles.loadingText}>Searching...</Text>
          </View>
        ) : searchResults.length === 0 ? (
          <View style={[styles.centered, { flex: 1 }]}>
            <Text style={styles.emptyText}>No results found</Text>
          </View>
        ) : (
          <FlatList
            data={searchResults}
            renderItem={renderSearchResult}
            keyExtractor={searchKeyExtractor}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>
    );
  }

  // Empty state
  if (!conversationHistoryLoading && conversationHistory.length === 0) {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        {searchBar}
        <View style={[styles.centered, { flex: 1 }]}>
          <Text style={styles.emptyText}>No conversation history found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {searchBar}
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
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
    backgroundColor: COLORS.backgroundSecondary,
  },
  searchInput: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: COLORS.backgroundPrimary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  clearButton: {
    marginLeft: 8,
    padding: 8,
  },
  clearButtonText: {
    color: COLORS.textMuted,
    fontSize: 14,
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
  searchProjectName: {
    color: COLORS.accentPurple,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 2,
  },
  searchSnippet: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
