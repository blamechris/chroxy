import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  LayoutAnimation,
} from 'react-native';
import type { ChatMessage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { formatToolName } from './chat-utils';
import { ThinkingIndicator } from './ThinkingIndicator';

function ActivityEntry({
  message,
  isSelected,
  isSelecting,
  onToggleSelection,
}: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: (id: string) => void;
}) {
  const longPressedRef = useRef(false);

  const handlePress = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) onToggleSelection(message.id);
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onToggleSelection(message.id);
  };

  const hasResult = !!message.toolResult;
  const imageCount = message.toolResultImages?.length || 0;

  const displayTool = formatToolName(message.tool);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onLongPress={isSelecting ? undefined : handleLongPress}
      onPress={handlePress}
      style={[styles.activityEntry, isSelected && styles.selectedBubble]}
    >
      {hasResult ? <Icon name="check" size={12} color={COLORS.accentGreen} /> : <Icon name="chevronRight" size={12} color={COLORS.textMuted} />}
      {message.serverName ? (
        <Text style={styles.activityEntryTool}>
          <Text style={styles.mcpServerTag}>{message.serverName}</Text>
          {' '}{displayTool}
        </Text>
      ) : (
        <Text style={styles.activityEntryTool}>{displayTool}</Text>
      )}
      {imageCount > 0 && (
        <Text style={styles.activityImageBadge}>{imageCount === 1 ? '1 image' : `${imageCount} images`}</Text>
      )}
      <Text style={styles.activityEntryPreview} numberOfLines={1}>
        {hasResult ? (message.toolResult || '').slice(0, 60) : (message.content || '').slice(0, 40)}
      </Text>
    </TouchableOpacity>
  );
}

export function ActivityGroup({
  messages: activityMessages,
  isActive,
  isSelecting,
  selectedIds,
  onToggleSelection,
  searchMatchIds,
}: {
  messages: ChatMessage[];
  isActive: boolean;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  searchMatchIds?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = activityMessages.filter((m) => m.type === 'tool_use').length;
  const lastMessage = activityMessages[activityMessages.length - 1];
  const isThinking = isActive && lastMessage?.type === 'thinking';

  // Auto-expand when a search match is inside this group
  const hasSearchMatch = searchMatchIds
    ? activityMessages.some((m) => searchMatchIds.has(m.id))
    : false;
  useEffect(() => {
    if (hasSearchMatch && !expanded) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(true);
    }
  }, [hasSearchMatch]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {expanded ? <Icon name="chevronDown" size={14} color={COLORS.textMuted} /> : <Icon name="chevronRight" size={14} color={COLORS.textMuted} />}
      </View>
      {isThinking && <ThinkingIndicator />}
      {expanded && (
        <ScrollView style={styles.activityList} nestedScrollEnabled>
          {activityMessages.map((msg) => (
            <ActivityEntry
              key={msg.id}
              message={msg}
              isSelected={selectedIds.has(msg.id)}
              isSelecting={isSelecting}
              onToggleSelection={onToggleSelection}
            />
          ))}
        </ScrollView>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  activityGroup: {
    backgroundColor: COLORS.backgroundTertiary,
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
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
    backgroundColor: COLORS.accentBlue,
    opacity: 0.8,
  },
  activitySummary: {
    flex: 1,
    color: COLORS.accentPurple,
    fontSize: 12,
    fontWeight: '600',
  },
  activityList: {
    marginTop: 8,
    maxHeight: 200,
  },
  activityEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 44,
    paddingVertical: 10,
  },
  activityEntryTool: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '500',
    minWidth: 40,
  },
  activityEntryPreview: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  activityImageBadge: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontWeight: '600',
    marginRight: 4,
  },
  mcpServerTag: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: '400',
  },
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
});
