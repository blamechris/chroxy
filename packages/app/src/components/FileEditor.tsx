import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore } from '../store/connection';
import type { FileWriteResult } from '../store/connection';
import { COLORS } from '../constants/colors';
import { SyntaxHighlightedCode, langFromPath } from './PermissionDetail';

interface FileEditorProps {
  visible: boolean;
  filePath: string | null;
  initialContent: string;
  onClose: () => void;
  /** Called after a successful save with the server-resolved path */
  onSave?: (path: string) => void;
}

/**
 * Full-screen modal editor for file content.
 * Provides a multiline monospace TextInput with Save/Cancel actions.
 */
export function FileEditor({ visible, filePath, initialContent, onClose, onSave }: FileEditorProps) {
  const insets = useSafeAreaInsets();
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const setFileWriteCallback = useConnectionStore((s) => s.setFileWriteCallback);
  const requestFileWrite = useConnectionStore((s) => s.requestFileWrite);

  const writeCallbackRef = useRef<((result: FileWriteResult) => void) | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmingRef = useRef(false);

  // Reset content when modal opens with new file
  useEffect(() => {
    if (visible) {
      setContent(initialContent);
      setSaving(false);
      setIsEditing(false);
      confirmingRef.current = false;
    }
  }, [visible, initialContent]);

  // Clean up callback and save timeout on unmount
  useEffect(() => {
    return () => {
      if (writeCallbackRef.current) {
        setFileWriteCallback(null);
        writeCallbackRef.current = null;
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      confirmingRef.current = false;
    };
  }, [setFileWriteCallback]);

  const hasChanges = content !== initialContent;
  const fileName = filePath ? filePath.split('/').pop() || filePath : '';

  const handleSave = useCallback(() => {
    if (!filePath || saving || confirmingRef.current) return;

    confirmingRef.current = true;

    Alert.alert(
      'Save Changes',
      `Save changes to ${fileName}?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            confirmingRef.current = false;
          },
        },
        {
          text: 'Save',
          onPress: () => {
            confirmingRef.current = false;
            setSaving(true);

            const cb = (result: FileWriteResult) => {
              if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
                saveTimeoutRef.current = null;
              }
              setSaving(false);
              setFileWriteCallback(null);
              writeCallbackRef.current = null;

              if (result.error) {
                Alert.alert('Save Failed', result.error);
              } else {
                onSave?.(result.path || filePath);
                onClose();
              }
            };

            writeCallbackRef.current = cb;
            setFileWriteCallback(cb);
            requestFileWrite(filePath, content);

            // Timeout after 10 seconds
            saveTimeoutRef.current = setTimeout(() => {
              saveTimeoutRef.current = null;
              if (writeCallbackRef.current === cb) {
                setSaving(false);
                setFileWriteCallback(null);
                writeCallbackRef.current = null;
                Alert.alert('Save Failed', 'Request timed out');
              }
            }, 10000);
          },
        },
      ],
    );
  }, [filePath, fileName, content, saving, onClose, onSave, setFileWriteCallback, requestFileWrite]);

  const handleCancel = useCallback(() => {
    if (isEditing && hasChanges) {
      Alert.alert(
        'Discard Changes',
        'You have unsaved changes. Discard them?',
        [
          { text: 'Keep Editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              setContent(initialContent);
              setIsEditing(false);
            },
          },
        ],
      );
    } else if (isEditing) {
      setIsEditing(false);
    } else {
      onClose();
    }
  }, [hasChanges, isEditing, initialContent, onClose]);

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleCancel}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={handleCancel}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={isEditing ? 'Cancel editing' : 'Close file viewer'}
          >
            <Text style={[styles.cancelText, saving && styles.disabledText]}>
              {isEditing ? 'Cancel' : 'Done'}
            </Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
            {hasChanges && <Text style={styles.modifiedBadge}>Modified</Text>}
          </View>

          {isEditing ? (
            <TouchableOpacity
              style={styles.headerButton}
              onPress={handleSave}
              disabled={saving || !hasChanges}
              accessibilityRole="button"
              accessibilityLabel="Save file"
            >
              {saving ? (
                <ActivityIndicator size="small" color={COLORS.accentBlue} />
              ) : (
                <Text style={[styles.saveText, !hasChanges && styles.disabledText]}>Save</Text>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.headerButton}
              onPress={() => setIsEditing(true)}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Edit file"
            >
              <Text style={[styles.saveText, saving && styles.disabledText]}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Content: syntax-highlighted view or editable TextInput */}
        {isEditing ? (
          <TextInput
            style={[styles.editor, { paddingBottom: insets.bottom + 12 }]}
            value={content}
            onChangeText={setContent}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            editable={!saving}
            scrollEnabled
            accessibilityLabel="File content editor"
          />
        ) : (
          <ScrollView
            style={styles.viewerScroll}
            contentContainerStyle={[styles.viewerContent, { paddingBottom: insets.bottom + 12 }]}
          >
            <SyntaxHighlightedCode
              code={content}
              language={filePath ? langFromPath(filePath) : ''}
            />
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
    backgroundColor: COLORS.backgroundSecondary,
  },
  headerButton: {
    minHeight: 44,
    minWidth: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  fileName: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  modifiedBadge: {
    color: COLORS.accentOrange,
    fontSize: 11,
    marginTop: 2,
  },
  cancelText: {
    color: COLORS.accentBlue,
    fontSize: 16,
  },
  saveText: {
    color: COLORS.accentBlue,
    fontSize: 16,
    fontWeight: '600',
  },
  disabledText: {
    color: COLORS.textDisabled,
  },
  editor: {
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    lineHeight: 20,
    color: COLORS.textPrimary,
    paddingHorizontal: 12,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  viewerScroll: {
    flex: 1,
  },
  viewerContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
  },
});
