import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  LayoutAnimation,
} from 'react-native';
import type { ChatMessage, ToolResultImage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { formatToolName } from './chat-utils';

export function ToolBubble({ message, isSelected, isSelecting, onToggleSelection, onOpenDetail }: {
  message: ChatMessage;
  isSelected: boolean;
  isSelecting: boolean;
  onToggleSelection: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressedRef = useRef(false);
  const content = message.content?.trim();

  // Hide empty tool messages
  if (!content) return null;

  const displayTool = formatToolName(message.tool);

  const handlePress = () => {
    // Suppress the tap that fires on release after a long-press
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) {
      onToggleSelection();
    } else if (expanded) {
      onOpenDetail(displayTool, content, message.toolResult, message.toolResultTruncated, message.toolResultImages, message.serverName);
    } else {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(true);
    }
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onToggleSelection();
  };

  const preview = content.length > 60 ? content.slice(0, 60) + '...' : content;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={!expanded && !isSelecting ? handleLongPress : undefined}
      style={[styles.toolBubble, isSelected && styles.selectedBubble]}
    >
      <View style={styles.toolHeader}>
        {expanded ? <Icon name="chevronDown" size={12} color={COLORS.textMuted} /> : <Icon name="chevronRight" size={12} color={COLORS.textMuted} />}
        <Text style={styles.senderLabelTool}>
          {message.serverName ? (
            <>
              <Text style={styles.mcpServerTag}>{message.serverName}</Text>
              {' '}{displayTool}
            </>
          ) : (
            <>Tool: {displayTool}</>
          )}
        </Text>
      </View>
      {expanded ? (
        <Text selectable style={styles.toolContentExpanded}>{content}</Text>
      ) : (
        <Text style={styles.toolContentCollapsed} numberOfLines={1}>{preview}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  toolBubble: {
    backgroundColor: COLORS.backgroundTertiary,
    padding: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 8,
    maxWidth: '85%',
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  senderLabelTool: {
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '600',
  },
  mcpServerTag: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: '400',
  },
  toolContentCollapsed: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  toolContentExpanded: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6,
    lineHeight: 18,
  },
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
});
