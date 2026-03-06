import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  LayoutAnimation,
} from 'react-native';
import type { ChatMessage, ToolResultImage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';
import { FormattedResponse } from '../MarkdownRenderer';
import { PermissionDetailOrFallback, PermissionCountdown, PermissionPill, permissionStyles } from '../PermissionDetail';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolBubble } from './ToolBubble';

export function MessageBubble({ message, onSelectOption, isSelected, isSelecting, onLongPress, onPress, onOpenDetail, onImagePress }: {
  message: ChatMessage;
  onSelectOption?: (value: string, messageId: string, requestId?: string, toolUseId?: string) => void;
  isSelected: boolean;
  isSelecting: boolean;
  onLongPress: () => void;
  onPress: () => void;
  onOpenDetail: (toolName: string, content: string, toolResult?: string, toolResultTruncated?: boolean, toolResultImages?: ToolResultImage[], serverName?: string) => void;
  onImagePress?: (uri: string) => void;
}) {
  const longPressedRef = useRef(false);
  const [isExpired, setIsExpired] = useState(() =>
    message.expiresAt != null && message.expiresAt <= Date.now()
  );
  const [permissionExpanded, setPermissionExpanded] = useState(false);
  const isUser = message.type === 'user_input';
  const isTool = message.type === 'tool_use';
  const isThinking = message.type === 'thinking';
  const isPrompt = message.type === 'prompt';
  const isError = message.type === 'error';
  const isSystem = message.type === 'system';

  // Answered permission prompts (with requestId) collapse to a compact pill.
  // user_question prompts (no requestId) are NOT collapsed.
  // Disable pill mode during selection so pills participate in multi-select.
  const showAsPill = isPrompt && message.requestId && message.answered && !permissionExpanded && !isSelecting;

  const handlePress = () => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (isSelecting) onPress();
  };

  const handleLongPress = () => {
    longPressedRef.current = true;
    onLongPress();
  };

  if (isThinking) {
    return <ThinkingIndicator />;
  }

  if (isTool) {
    return (
      <ToolBubble
        message={message}
        isSelected={isSelected}
        isSelecting={isSelecting}
        onToggleSelection={onPress}
        onOpenDetail={onOpenDetail}
      />
    );
  }

  if (showAsPill) {
    return (
      <PermissionPill
        message={message}
        onExpand={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setPermissionExpanded(true);
        }}
      />
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={isSelecting ? undefined : handleLongPress}
      style={[styles.messageBubble, isUser && styles.userBubble, isPrompt && styles.promptBubble, isError && styles.errorBubble, isSystem && styles.systemBubble, isSelected && styles.selectedBubble]}
    >
      <View style={isPrompt && message.expiresAt && !message.answered ? styles.promptHeaderRow : undefined}>
        <Text style={isUser ? styles.senderLabelUser : isPrompt ? styles.senderLabelPrompt : isError ? styles.senderLabelError : isSystem ? styles.senderLabelSystem : styles.senderLabelClaude}>
          {isUser ? 'You' : isPrompt ? (message.tool || 'Action Required') : isError ? 'Error' : isSystem ? 'System' : 'Claude'}
        </Text>
        {isPrompt && !message.answered && message.expiresAt && (
          <PermissionCountdown expiresAt={message.expiresAt} onExpire={() => setIsExpired(true)} />
        )}
      </View>
      {isPrompt && message.toolInput ? (
        <PermissionDetailOrFallback tool={message.tool} toolInput={message.toolInput} fallback={message.content?.trim() || ''} />
      ) : !isUser && !isPrompt && !isError && !isSystem ? (
        <FormattedResponse content={message.content?.trim() || ''} messageTextStyle={styles.messageText} />
      ) : (
        <Text selectable style={[styles.messageText, isUser && styles.userMessageText, isError && styles.errorMessageText, isSystem && styles.systemMessageText]}>
          {message.content?.trim()}
        </Text>
      )}
      {isUser && message.attachments && message.attachments.length > 0 && (
        <View style={styles.attachmentRow}>
          {message.attachments.map((att) => (
            att.type === 'image' ? (
              <TouchableOpacity key={att.id} onPress={() => onImagePress?.(att.uri)} accessibilityRole="button" accessibilityLabel={`View ${att.name}`}>
                <Image source={{ uri: att.uri }} style={styles.attachmentThumbnail} />
              </TouchableOpacity>
            ) : (
              <View key={att.id} style={styles.attachmentChip}>
                <Icon name="document" size={14} color={COLORS.textMuted} />
                <Text style={styles.attachmentChipName} numberOfLines={1}>{att.name}</Text>
              </View>
            )
          ))}
        </View>
      )}
      {isPrompt && message.options && (
        <View style={styles.promptOptions}>
          {message.options.map((opt, i) => {
            const isAnswered = message.answered != null;
            const isDisabled = isAnswered || isExpired;
            const isChosen = message.answered === opt.value;
            return (
              <TouchableOpacity
                key={i}
                style={[
                  styles.promptOptionButton,
                  isDisabled && !isChosen && styles.promptOptionDisabled,
                  isChosen && styles.promptOptionChosen,
                ]}
                disabled={isDisabled}
                onPress={() => onSelectOption?.(opt.value, message.id, message.requestId, message.toolUseId)}
              >
                <Text style={[
                  styles.promptOptionText,
                  isDisabled && !isChosen && styles.promptOptionTextDisabled,
                  isChosen && styles.promptOptionTextChosen,
                ]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      {isPrompt && message.requestId && message.answered && permissionExpanded && (
        <Text style={permissionStyles.permissionInfoNote}>
          Claude sees the tool result, not your approval decision.
        </Text>
      )}
      {isPrompt && message.requestId && message.answered && permissionExpanded && (
        <TouchableOpacity
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setPermissionExpanded(false);
          }}
          style={permissionStyles.collapseLink}
        >
          <Text style={permissionStyles.collapseLinkText}>Collapse</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  messageBubble: {
    backgroundColor: COLORS.backgroundSecondary,
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '85%',
  },
  userBubble: {
    backgroundColor: COLORS.accentBlueLight,
    alignSelf: 'flex-end',
    borderColor: COLORS.accentBlueBorder,
    borderWidth: 1,
  },
  attachmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  attachmentThumbnail: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    gap: 4,
  },
  attachmentChipName: {
    color: COLORS.textPrimary,
    fontSize: 12,
    maxWidth: 100,
  },
  senderLabelUser: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelClaude: {
    color: COLORS.accentGreen,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  senderLabelPrompt: {
    color: COLORS.accentOrange,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  promptBubble: {
    backgroundColor: COLORS.accentOrangeLight,
    borderColor: COLORS.accentOrangeBorder,
    borderWidth: 1,
    maxWidth: '95%',
  },
  promptHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  promptOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  promptOptionButton: {
    backgroundColor: COLORS.accentOrangeMedium,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentOrangeBorderStrong,
  },
  promptOptionText: {
    color: COLORS.accentOrange,
    fontSize: 14,
    fontWeight: '600',
  },
  promptOptionDisabled: {
    opacity: 0.4,
  },
  promptOptionChosen: {
    backgroundColor: COLORS.accentOrange,
    borderColor: COLORS.accentOrange,
  },
  promptOptionTextDisabled: {
    color: COLORS.textSecondary,
  },
  promptOptionTextChosen: {
    color: '#fff',
  },
  errorBubble: {
    backgroundColor: COLORS.accentRedLight,
    borderColor: COLORS.accentRedBorder,
    borderWidth: 1,
  },
  senderLabelError: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  errorMessageText: {
    color: COLORS.textError,
  },
  systemBubble: {
    backgroundColor: COLORS.accentGrayLight,
    borderColor: COLORS.accentGrayBorder,
    borderWidth: 1,
    alignSelf: 'center',
    maxWidth: '90%',
  },
  senderLabelSystem: {
    color: COLORS.accentGray,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  systemMessageText: {
    color: COLORS.textSystem,
    fontSize: 13,
  },
  selectedBubble: {
    borderColor: COLORS.accentBlue,
    borderWidth: 2,
  },
  messageText: {
    color: COLORS.textChatMessage,
    fontSize: 15,
    lineHeight: 22,
  },
  userMessageText: {
    color: COLORS.textPrimary,
  },
});
