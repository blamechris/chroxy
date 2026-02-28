import React, { forwardRef, useMemo, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, StyleSheet, Platform, Animated, Alert } from 'react-native';
import { ICON_RETURN, ICON_PARAGRAPH } from '../constants/icons';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';
import type { SlashCommand } from '../store/connection';
import type { Attachment } from '../utils/attachments';
import { formatFileSize } from '../utils/attachments';


// -- Props --

export interface InputBarProps {
  inputText: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onKeyPress: (key: string) => void;
  onClearTerminal: () => void;
  enterToSend: boolean;
  onToggleEnterMode: () => void;
  isStreaming: boolean;
  claudeReady: boolean;
  viewMode: 'chat' | 'terminal' | 'files';
  hasTerminal: boolean;
  bottomPadding: number;
  disabled?: boolean;
  disabledPlaceholder?: string;
  slashCommands?: SlashCommand[];
  isRecognizing?: boolean;
  onMicPress?: () => void;
  speechUnavailable?: boolean;
  attachments?: Attachment[];
  onAttach?: () => void;
  onCamera?: () => void;
  onRemoveAttachment?: (id: string) => void;
}

// -- Component --

export const InputBar = forwardRef<TextInput, InputBarProps>(function InputBar({
  inputText,
  onChangeText,
  onSend,
  onInterrupt,
  onKeyPress,
  onClearTerminal,
  enterToSend,
  onToggleEnterMode,
  isStreaming,
  claudeReady,
  viewMode,
  hasTerminal,
  bottomPadding,
  disabled,
  disabledPlaceholder,
  slashCommands = [],
  isRecognizing,
  onMicPress,
  speechUnavailable,
  attachments = [],
  onAttach,
  onCamera,
  onRemoveAttachment,
}, ref) {
  const a11yDisabled = disabled ? { disabled: true as const } : undefined;

  // Pulsing animation for recording state
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isRecognizing) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.4, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    }
    pulseAnim.setValue(1);
  }, [isRecognizing, pulseAnim]);

  const showMicButton = viewMode === 'chat' && !isStreaming && !disabled && (onMicPress || speechUnavailable);
  const showAttachButton = viewMode === 'chat' && !hasTerminal && !isStreaming && !disabled && onAttach;
  const showCameraButton = viewMode === 'chat' && !hasTerminal && !isStreaming && !disabled && onCamera;

  // Filter slash commands based on current input (only when typing `/` at the start)
  const filteredCommands = useMemo(() => {
    if (viewMode !== 'chat' || !inputText.startsWith('/') || slashCommands.length === 0) return [];
    const query = inputText.slice(1).toLowerCase();
    // Show all commands if user just typed `/`
    if (!query) return slashCommands;
    return slashCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [inputText, slashCommands, viewMode]);

  const showDropdown = filteredCommands.length > 0;

  return (
    <View style={[styles.inputContainer, { paddingBottom: bottomPadding }]}>
      {showDropdown && (
        <ScrollView
          style={styles.dropdown}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          {filteredCommands.map((cmd) => (
            <TouchableOpacity
              key={cmd.name}
              style={styles.dropdownItem}
              onPress={() => onChangeText(`/${cmd.name} `)}
              accessibilityRole="button"
              accessibilityLabel={`Slash command ${cmd.name}`}
            >
              <View style={styles.dropdownItemHeader}>
                <Text style={styles.dropdownItemName}>/{cmd.name}</Text>
                {cmd.source === 'project' && (
                  <Text style={styles.dropdownItemBadge}>project</Text>
                )}
              </View>
              {cmd.description ? (
                <Text style={styles.dropdownItemDesc} numberOfLines={1}>{cmd.description}</Text>
              ) : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      {viewMode === 'terminal' && hasTerminal && (
        <View style={styles.specialKeys}>
          {['Enter', 'Ctrl+C', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].map((key) => (
            <TouchableOpacity
              key={key}
              style={styles.specialKey}
              onPress={() => onKeyPress(key)}
            >
              <Text style={styles.specialKeyText}>
                {key.replace('Arrow', '').replace('Ctrl+', '^')}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.specialKey}
            onPress={onClearTerminal}
          >
            <Text style={styles.specialKeyText}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}
      {attachments.length > 0 && (
        <ScrollView
          horizontal
          style={styles.attachmentStrip}
          contentContainerStyle={styles.attachmentStripContent}
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {attachments.map((att) => (
            <View key={att.id} style={styles.attachmentThumb}>
              {att.type === 'image' ? (
                <Image source={{ uri: att.uri }} style={styles.attachmentImage} />
              ) : (
                <View style={styles.attachmentDoc}>
                  <Icon name="document" size={20} color={COLORS.textMuted} />
                  <Text style={styles.attachmentDocName} numberOfLines={1}>{att.name}</Text>
                </View>
              )}
              <Text style={styles.attachmentSize}>{formatFileSize(att.size)}</Text>
              {onRemoveAttachment && (
                <TouchableOpacity
                  style={styles.attachmentRemove}
                  onPress={() => onRemoveAttachment(att.id)}
                  hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${att.name}`}
                >
                  <Icon name="close" size={10} color={COLORS.textPrimary} />
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
      )}
      <View style={styles.inputRow}>
        <TouchableOpacity
          style={styles.enterModeToggle}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={enterToSend ? 'Enter key sends message. Tap to switch to newline mode.' : 'Enter key inserts newline. Tap to switch to send mode.'}
          onPress={onToggleEnterMode}
        >
          <Text style={styles.enterModeText}>{enterToSend ? ICON_RETURN : ICON_PARAGRAPH}</Text>
        </TouchableOpacity>
        <TextInput
          ref={ref}
          style={[styles.input, !enterToSend && styles.inputMultiline, disabled && styles.inputDisabled]}
          placeholder={disabled ? (disabledPlaceholder || 'Reconnecting...') : !claudeReady ? 'Connecting to Claude...' : 'Message Claude...'}
          placeholderTextColor={COLORS.textDim}
          value={inputText}
          onChangeText={onChangeText}
          // When enterToSend is true, multiline is false and onSubmitEditing fires on Enter.
          // When enterToSend is false, multiline is true so onSubmitEditing never fires.
          onSubmitEditing={enterToSend && !isStreaming && !disabled ? onSend : undefined}
          blurOnSubmit={false}
          multiline={!enterToSend}
          autoCapitalize={viewMode === 'chat' ? 'sentences' : 'none'}
          autoCorrect={viewMode === 'chat'}
          editable={!disabled}
          accessibilityState={a11yDisabled}
        />
        {showCameraButton && (
          <TouchableOpacity
            onPress={onCamera}
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={styles.cameraButton}>
              <Icon name="camera" size={20} color={COLORS.textMuted} />
            </View>
          </TouchableOpacity>
        )}
        {showAttachButton && (
          <TouchableOpacity
            onPress={onAttach}
            accessibilityRole="button"
            accessibilityLabel="Attach file"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <View style={styles.attachButton}>
              <Icon name="paperclip" size={20} color={COLORS.textMuted} />
            </View>
          </TouchableOpacity>
        )}
        {showMicButton && (
          <TouchableOpacity
            onPress={onMicPress ?? (() => {
              Alert.alert(
                'Voice Input Unavailable',
                'Speech recognition requires a dev build. Voice input is not available in Expo Go.',
              );
            })}
            accessibilityRole="button"
            accessibilityLabel={!onMicPress ? 'Voice input unavailable' : isRecognizing ? 'Stop voice input' : 'Start voice input'}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Animated.View
              style={[
                styles.micButton,
                { backgroundColor: !onMicPress ? COLORS.backgroundCard : isRecognizing ? COLORS.accentRed : COLORS.accentGreen },
                isRecognizing ? { opacity: pulseAnim } : undefined,
                !onMicPress ? { opacity: 0.3 } : undefined,
              ]}
            >
              <Icon name="mic" size={18} color={COLORS.textMuted} />
            </Animated.View>
          </TouchableOpacity>
        )}
        {isStreaming ? (
          <TouchableOpacity
            style={[styles.interruptButton, disabled && styles.interruptButtonDisabled]}
            onPress={onInterrupt}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Interrupt Claude"
            accessibilityState={a11yDisabled}
          >
            <Icon name="stop" size={16} color={COLORS.textPrimary} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendButton, disabled && styles.sendButtonDisabled]}
            onPress={onSend}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={a11yDisabled}
          >
            <Icon name="arrowUp" size={20} color={COLORS.textPrimary} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

// -- Styles --

const styles = StyleSheet.create({
  inputContainer: {
    borderTopWidth: 1,
    borderTopColor: COLORS.backgroundCard,
    backgroundColor: COLORS.backgroundSecondary,
  },
  dropdown: {
    maxHeight: 200,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  dropdownItem: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
    minHeight: 44,
  },
  dropdownItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dropdownItemName: {
    color: COLORS.accentBlue,
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '600',
  },
  dropdownItemBadge: {
    color: COLORS.textDim,
    fontSize: 11,
    backgroundColor: COLORS.backgroundCard,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  dropdownItemDesc: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  specialKeys: {
    flexDirection: 'row',
    padding: 8,
    gap: 8,
  },
  specialKey: {
    backgroundColor: COLORS.backgroundCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  specialKeyText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  attachmentStrip: {
    maxHeight: 80,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  attachmentStripContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  attachmentThumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundCard,
    overflow: 'hidden',
  },
  attachmentImage: {
    width: 64,
    height: 64,
    borderRadius: 8,
  },
  attachmentDoc: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  attachmentDocIcon: {
    fontSize: 20,
  },
  attachmentDocName: {
    color: COLORS.textMuted,
    fontSize: 9,
    textAlign: 'center',
  },
  attachmentSize: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    color: COLORS.textDim,
    fontSize: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
  attachmentRemove: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.accentRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentRemoveText: {
    color: COLORS.textPrimary,
    fontSize: 10,
    fontWeight: 'bold',
  },
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    paddingTop: 4,
    gap: 8,
    alignItems: 'center',
  },
  enterModeToggle: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  enterModeText: {
    color: COLORS.textDisabled,
    fontSize: 16,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: COLORS.textPrimary,
    fontSize: 16,
  },
  inputMultiline: {
    maxHeight: 100,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  cameraButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraButtonText: {
    fontSize: 20,
  },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButtonText: {
    fontSize: 20,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButton: {
    backgroundColor: COLORS.accentBlue,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: COLORS.textPrimary,
    fontSize: 20,
    fontWeight: 'bold',
  },
  interruptButton: {
    backgroundColor: COLORS.accentRed,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  interruptButtonDisabled: {
    opacity: 0.4,
  },
  interruptButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: 'bold',
  },
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonText: {
    fontSize: 18,
  },
});
