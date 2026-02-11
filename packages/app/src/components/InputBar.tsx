import React, { forwardRef, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { ICON_ARROW_UP, ICON_SQUARE, ICON_RETURN, ICON_PARAGRAPH } from '../constants/icons';
import { COLORS } from '../constants/colors';
import type { SlashCommand } from '../store/connection';


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
  viewMode: 'chat' | 'terminal';
  hasTerminal: boolean;
  bottomPadding: number;
  disabled?: boolean;
  disabledPlaceholder?: string;
  slashCommands?: SlashCommand[];
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
}, ref) {
  const a11yDisabled = disabled ? { disabled: true as const } : undefined;

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
        {isStreaming ? (
          <TouchableOpacity
            style={[styles.interruptButton, disabled && styles.interruptButtonDisabled]}
            onPress={onInterrupt}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Interrupt Claude"
            accessibilityState={a11yDisabled}
          >
            <Text style={styles.interruptButtonText}>{ICON_SQUARE}</Text>
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
            <Text style={styles.sendButtonText}>{ICON_ARROW_UP}</Text>
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
});
