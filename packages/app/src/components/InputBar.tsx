import React, { forwardRef, useMemo, useRef, useEffect, useState, useImperativeHandle, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, StyleSheet, Platform, Animated, Alert } from 'react-native';
import { ICON_RETURN, ICON_PARAGRAPH } from '../constants/icons';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';
import type { SlashCommand } from '../store/connection';
import type { Attachment } from '../utils/attachments';
import { formatFileSize } from '../utils/attachments';


// -- Props --

export interface PastedTextBlockChip {
  id: number;
  content: string;
}

/**
 * Imperative handle exposed via the InputBar ref (#5556 — input/stream
 * decoupling). InputBar owns the composer draft internally so that streaming
 * message re-renders in SessionScreen no longer re-render the TextInput on
 * every delta. SessionScreen reads/writes the draft through this handle for
 * the send path, voice-transcript merge, seed prompts (`@agent `), and
 * pasted-text marker stripping.
 *
 * `setValue` updates the internal draft WITHOUT firing `onChangeText`, so
 * programmatic writes (paste collapse, voice merge, marker strip) don't
 * recursively re-trigger the diff/paste-detection path. User keystrokes fire
 * `onChangeText(next, prev)` as before.
 */
export interface InputBarHandle {
  /** Focus the underlying TextInput. */
  focus: () => void;
  /** Read the current draft value. */
  getValue: () => string;
  /** Replace the draft programmatically (does NOT fire onChangeText). */
  setValue: (text: string) => void;
  /** Clear the draft (equivalent to setValue('')). */
  clear: () => void;
}

export interface InputBarProps {
  /**
   * Optional seed value. InputBar owns its draft internally; this prop only
   * supplies an initial value on mount. To change the draft after mount, use
   * the imperative ref (`setValue`/`clear`). Kept for back-compat and tests.
   */
  inputText?: string;
  /**
   * Fired on every user keystroke with the new value and the previous value.
   * The `prevText` arg lets the parent run paste-diff detection (#3797)
   * without holding the draft in its own render-scope state.
   */
  onChangeText: (text: string, prevText: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onKeyPress: (key: string) => void;
  onClearTerminal: () => void;
  enterToSend: boolean;
  onToggleEnterMode: () => void;
  isStreaming: boolean;
  /**
   * #6116 — `isBusy` (= the active session's `isIdle === false`) covers the
   * window after `agent_busy` but before `stream_start`, where the server is
   * processing but no text is streaming yet. A send during this window queues
   * (#6113), so the composer must show the same Stop + "Queue message"
   * affordance it shows while streaming — `isStreaming || isBusy` is the
   * "turn active" gate, matching the dashboard.
   */
  isBusy?: boolean;
  claudeReady: boolean;
  viewMode: 'chat' | 'terminal' | 'files' | 'system';
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
  /** #3797 — chips for collapsed-paste blocks staged in the composer. */
  pastedTextBlocks?: PastedTextBlockChip[];
  /** #3797 — tap a chip to open the inspect modal. */
  onInspectPastedText?: (id: number) => void;
  /** #3797 — tap × on a chip to remove the chip and its inline marker. */
  onRemovePastedText?: (id: number) => void;
}

// -- Component --

export const InputBar = React.memo(forwardRef<InputBarHandle, InputBarProps>(function InputBar({
  inputText,
  onChangeText,
  onSend,
  onInterrupt,
  onKeyPress,
  onClearTerminal,
  enterToSend,
  onToggleEnterMode,
  isStreaming,
  isBusy = false,
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
  pastedTextBlocks = [],
  onInspectPastedText,
  onRemovePastedText,
}, ref) {
  const a11yDisabled = disabled ? { disabled: true as const } : undefined;
  // #6116 — a turn is "active" while streaming OR while the server is busy
  // pre-stream (isBusy). Both states queue a send (#6113), so both show the
  // Stop button + "Queue message" affordance + follow-up placeholder.
  const turnActive = isStreaming || isBusy;

  // #5556 — InputBar owns the composer draft internally so that streaming
  // re-renders in SessionScreen don't re-render the TextInput on every delta.
  // `inputText` is consumed once as an initial seed; subsequent changes flow
  // through user keystrokes (onChangeText) or the imperative ref.
  const [value, setValue] = useState(inputText ?? '');
  const textInputRef = useRef<TextInput>(null);

  // Keep a live ref to the current value so the imperative handle's getValue()
  // and the programmatic setValue() always read the freshest draft without
  // depending on a stale closure.
  const valueRef = useRef(value);
  valueRef.current = value;

  useImperativeHandle(ref, () => ({
    focus: () => textInputRef.current?.focus(),
    getValue: () => valueRef.current,
    setValue: (text: string) => {
      // Programmatic write — does NOT fire onChangeText, so paste detection /
      // voice merge / marker strip don't recurse back into the parent diff.
      valueRef.current = text;
      setValue(text);
    },
    clear: () => {
      valueRef.current = '';
      setValue('');
    },
  }), []);

  // User keystrokes: update the internal draft and notify the parent with both
  // the new and previous values so it can run paste-diff detection (#3797)
  // without holding the draft itself.
  const handleChangeText = useCallback((next: string) => {
    const prev = valueRef.current;
    valueRef.current = next;
    setValue(next);
    onChangeText(next, prev);
  }, [onChangeText]);

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

  const showMicButton = viewMode === 'chat' && !disabled && (onMicPress || speechUnavailable);
  const showAttachButton = viewMode === 'chat' && !hasTerminal && !isStreaming && !disabled && onAttach;
  const showCameraButton = viewMode === 'chat' && !hasTerminal && !isStreaming && !disabled && onCamera;

  // Filter slash commands based on current input (only when typing `/` at the start)
  const filteredCommands = useMemo(() => {
    if (viewMode !== 'chat' || !value.startsWith('/') || slashCommands.length === 0) return [];
    const query = value.slice(1).toLowerCase();
    // Show all commands if user just typed `/`
    if (!query) return slashCommands;
    return slashCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [value, slashCommands, viewMode]);

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
              onPress={() => handleChangeText(`/${cmd.name} `)}
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
      {pastedTextBlocks.length > 0 && (
        <ScrollView
          horizontal
          style={styles.pastedTextStrip}
          contentContainerStyle={styles.pastedTextStripContent}
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          testID="pasted-text-strip"
        >
          {pastedTextBlocks.map((block) => {
            let lineCount = 1;
            for (let i = 0; i < block.content.length; i++) {
              if (block.content.charCodeAt(i) === 10) lineCount++;
            }
            const label = lineCount > 1
              ? `Pasted text #${block.id} · ${lineCount} lines`
              : `Pasted text #${block.id} · ${block.content.length} chars`;
            return (
              <TouchableOpacity
                key={block.id}
                style={styles.pastedTextChip}
                onPress={() => onInspectPastedText?.(block.id)}
                accessibilityRole="button"
                accessibilityLabel={`${label}. Tap to view the full pasted text.`}
                testID={`pasted-text-chip-${block.id}`}
              >
                <Text style={styles.pastedTextChipIcon} accessibilityElementsHidden>📋</Text>
                <Text style={styles.pastedTextChipLabel}>{label}</Text>
                {onRemovePastedText && (
                  <TouchableOpacity
                    style={styles.pastedTextChipRemove}
                    onPress={() => onRemovePastedText(block.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${label}`}
                    testID={`pasted-text-chip-remove-${block.id}`}
                  >
                    <Icon name="close" size={12} color={COLORS.textPrimary} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
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
          ref={textInputRef}
          style={[styles.input, !enterToSend && styles.inputMultiline, disabled && styles.inputDisabled]}
          placeholder={disabled ? (disabledPlaceholder || 'Reconnecting...') : !claudeReady ? 'Connecting to Claude...' : turnActive ? 'Type to send follow-up…' : 'Message Claude...'}
          placeholderTextColor={COLORS.textDim}
          value={value}
          onChangeText={handleChangeText}
          // When enterToSend is true, multiline is false and onSubmitEditing fires on Enter.
          // When enterToSend is false, multiline is true so onSubmitEditing never fires.
          // #5938 — Enter sends EVEN while streaming now; onSend routes a
          // mid-turn message to the outgoing queue (the send-while-busy path).
          onSubmitEditing={enterToSend && !disabled ? onSend : undefined}
          blurOnSubmit={false}
          multiline={!enterToSend}
          autoCapitalize={viewMode === 'chat' ? 'sentences' : 'none'}
          autoCorrect={viewMode === 'chat'}
          editable={!disabled}
          accessibilityState={a11yDisabled}
          testID="chat-message-input"
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
        {/* #5938/#6116 — during an active turn (streaming OR busy pre-stream),
            BOTH controls show: Stop interrupts the turn, Send queues a follow-up
            that flushes when the turn completes. When idle, only Send renders. */}
        {turnActive && (
          <TouchableOpacity
            style={[styles.interruptButton, disabled && styles.interruptButtonDisabled]}
            onPress={onInterrupt}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Interrupt Claude"
            accessibilityState={a11yDisabled}
            testID="chat-stop-button"
          >
            <Icon name="stop" size={16} color={COLORS.textPrimary} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.sendButton, disabled && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={turnActive ? 'Queue message' : 'Send message'}
          accessibilityState={a11yDisabled}
          testID="chat-send-button"
        >
          <Icon name="arrowUp" size={20} color={COLORS.textPrimary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}));

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
  pastedTextStrip: {
    maxHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  pastedTextStripContent: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    alignItems: 'center',
  },
  pastedTextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: COLORS.backgroundCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderPrimary,
  },
  pastedTextChipIcon: {
    fontSize: 12,
  },
  pastedTextChipLabel: {
    color: COLORS.textPrimary,
    fontSize: 12,
  },
  pastedTextChipRemove: {
    marginLeft: 2,
    minWidth: 20,
    minHeight: 20,
    alignItems: 'center',
    justifyContent: 'center',
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
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
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
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
