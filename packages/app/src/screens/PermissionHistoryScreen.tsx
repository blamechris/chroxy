import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  LayoutAnimation,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore } from '../store/connection';
import { ChatMessage, SessionInfo } from '../store/types';
import { renderPermissionDetail, getPermissionSummary } from '../components/PermissionDetail';
import { ICON_CHECK, ICON_CLOSE } from '../constants/icons';
import { COLORS } from '../constants/colors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterStatus = 'all' | 'allowed' | 'denied' | 'expired' | 'pending';

interface PermissionEntry {
  message: ChatMessage;
  sessionId: string | null;
  sessionName: string | null;
  status: 'allowed' | 'denied' | 'expired' | 'pending';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function deriveStatus(msg: ChatMessage): PermissionEntry['status'] {
  if (!msg.answered) {
    if (msg.expiresAt && msg.expiresAt <= Date.now()) return 'expired';
    return 'pending';
  }
  if (msg.answered === 'allow' || msg.answered === 'allowAlways') return 'allowed';
  if (msg.answered === 'deny') return 'denied';
  // Resolved via history replay or other means
  return 'allowed';
}

function formatDecisionTime(msg: ChatMessage): string | null {
  if (!msg.answeredAt || !msg.timestamp) return null;
  const ms = msg.answeredAt - msg.timestamp;
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

const STATUS_CONFIG = {
  allowed: { label: 'Allowed', icon: ICON_CHECK, color: COLORS.accentGreen, bg: COLORS.accentGreenLight, border: COLORS.accentGreenBorder },
  denied: { label: 'Denied', icon: ICON_CLOSE, color: COLORS.accentRed, bg: COLORS.accentRedLight, border: COLORS.accentRedBorder },
  expired: { label: 'Expired', icon: ICON_CLOSE, color: COLORS.accentOrange, bg: COLORS.accentOrangeLight, border: COLORS.accentOrangeBorder },
  pending: { label: 'Pending', icon: '?', color: COLORS.accentBlue, bg: COLORS.accentBlueLight, border: COLORS.accentBlueBorder },
} as const;

const FILTER_OPTIONS: { key: FilterStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'allowed', label: 'Allowed' },
  { key: 'denied', label: 'Denied' },
  { key: 'expired', label: 'Expired' },
  { key: 'pending', label: 'Pending' },
];

// ---------------------------------------------------------------------------
// PermissionEntryRow
// ---------------------------------------------------------------------------

function PermissionEntryRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: PermissionEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const cfg = STATUS_CONFIG[entry.status];
  const summary = getPermissionSummary(entry.message.tool, entry.message.toolInput);
  const decisionTime = formatDecisionTime(entry.message);

  return (
    <TouchableOpacity
      onPress={() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        onToggle();
      }}
      style={styles.entryRow}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${cfg.label}: ${summary}`}
    >
      {/* Header row */}
      <View style={styles.entryHeader}>
        {/* Status badge */}
        <View style={[styles.statusBadge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
          <Text style={[styles.statusBadgeText, { color: cfg.color }]}>{cfg.icon}</Text>
        </View>

        {/* Summary */}
        <View style={styles.entrySummary}>
          <Text style={styles.entryTool} numberOfLines={1}>{summary}</Text>
          <View style={styles.entryMeta}>
            <Text style={[styles.entryStatusLabel, { color: cfg.color }]}>{cfg.label}</Text>
            {decisionTime && (
              <Text style={styles.entryDecisionTime}> in {decisionTime}</Text>
            )}
          </View>
        </View>

        {/* Timestamp */}
        <Text style={styles.entryTimestamp}>{formatRelativeTime(entry.message.timestamp)}</Text>
      </View>

      {/* Session name (multi-session) */}
      {entry.sessionName && (
        <Text style={styles.entrySessionName}>{entry.sessionName}</Text>
      )}

      {/* Expanded detail */}
      {isExpanded && (
        <View style={styles.entryDetail}>
          {renderPermissionDetail(entry.message.tool, entry.message.toolInput)}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function PermissionHistoryScreen() {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sessions = useConnectionStore((s) => s.sessions);
  const sessionStates = useConnectionStore((s) => s.sessionStates);
  const legacyMessages = useConnectionStore((s) => s.messages);

  // Aggregate permission entries from all sessions
  const entries = useMemo(() => {
    const result: PermissionEntry[] = [];

    // Multi-session messages
    for (const session of sessions) {
      const ss = sessionStates[session.sessionId];
      if (!ss) continue;
      for (const msg of ss.messages) {
        if (msg.type === 'prompt' && msg.requestId) {
          result.push({
            message: msg,
            sessionId: session.sessionId,
            sessionName: sessions.length > 1 ? session.name : null,
            status: deriveStatus(msg),
          });
        }
      }
    }

    // Legacy flat messages (PTY mode or no session list)
    if (result.length === 0) {
      for (const msg of legacyMessages) {
        if (msg.type === 'prompt' && msg.requestId) {
          result.push({
            message: msg,
            sessionId: null,
            sessionName: null,
            status: deriveStatus(msg),
          });
        }
      }
    }

    // Sort newest first
    result.sort((a, b) => b.message.timestamp - a.message.timestamp);
    return result;
  }, [sessions, sessionStates, legacyMessages]);

  // Counts for summary bar
  const counts = useMemo(() => {
    const c = { allowed: 0, denied: 0, expired: 0, pending: 0 };
    for (const e of entries) c[e.status]++;
    return c;
  }, [entries]);

  // Filtered entries
  const filtered = useMemo(() => {
    let result = entries;
    if (filter !== 'all') {
      result = result.filter((e) => e.status === filter);
    }
    if (sessionFilter) {
      result = result.filter((e) => e.sessionId === sessionFilter);
    }
    return result;
  }, [entries, filter, sessionFilter]);

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const renderItem = useCallback(({ item }: { item: PermissionEntry }) => (
    <PermissionEntryRow
      entry={item}
      isExpanded={expandedId === item.message.id}
      onToggle={() => handleToggle(item.message.id)}
    />
  ), [expandedId, handleToggle]);

  const keyExtractor = useCallback((item: PermissionEntry) => item.message.id, []);

  const showSessionFilter = sessions.length > 1;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: COLORS.accentGreen }]}>{counts.allowed}</Text>
          <Text style={styles.summaryLabel}>Allowed</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: COLORS.accentRed }]}>{counts.denied}</Text>
          <Text style={styles.summaryLabel}>Denied</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: COLORS.accentOrange }]}>{counts.expired}</Text>
          <Text style={styles.summaryLabel}>Expired</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: COLORS.textMuted }]}>{entries.length}</Text>
          <Text style={styles.summaryLabel}>Total</Text>
        </View>
      </View>

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={styles.filterRowContent}
      >
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setFilter(opt.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Session filter (multi-session) */}
      {showSessionFilter && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterRow}
          contentContainerStyle={styles.filterRowContent}
        >
          <TouchableOpacity
            style={[styles.filterChip, !sessionFilter && styles.filterChipActive]}
            onPress={() => setSessionFilter(null)}
          >
            <Text style={[styles.filterChipText, !sessionFilter && styles.filterChipTextActive]}>All Sessions</Text>
          </TouchableOpacity>
          {sessions.map((s) => {
            const active = sessionFilter === s.sessionId;
            return (
              <TouchableOpacity
                key={s.sessionId}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setSessionFilter(active ? null : s.sessionId)}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {s.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Permission list */}
      {filtered.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {entries.length === 0
              ? 'No permissions requested yet'
              : 'No permissions match the current filter'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },

  // Summary bar
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
  },
  summaryCount: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: monoFont,
  },
  summaryLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: COLORS.borderPrimary,
  },

  // Filter chips
  filterRow: {
    maxHeight: 44,
  },
  filterRowContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: COLORS.backgroundSecondary,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  filterChipActive: {
    backgroundColor: COLORS.accentBlue,
    borderColor: COLORS.accentBlue,
  },
  filterChipText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#fff',
  },

  // Entry row
  entryRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    marginRight: 10,
  },
  statusBadgeText: {
    fontSize: 14,
    fontWeight: '700',
  },
  entrySummary: {
    flex: 1,
    marginRight: 8,
  },
  entryTool: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: monoFont,
  },
  entryMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  entryStatusLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  entryDecisionTime: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  entryTimestamp: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  entrySessionName: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 4,
    marginLeft: 38,
  },
  entryDetail: {
    marginTop: 8,
    marginLeft: 38,
  },

  // List
  listContent: {
    paddingBottom: 16,
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    color: COLORS.textDisabled,
    fontSize: 15,
    textAlign: 'center',
  },
});
