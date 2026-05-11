/**
 * PastedTextModal (mobile) — read-only viewer for a collapsed paste (#3797).
 *
 * Mirrors the dashboard's modal: opens when the user taps a paste chip,
 * shows the full content scrollably + monospaced, lets them remove the
 * paste without first closing.
 */
import React from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { COLORS } from '../constants/colors';

export interface PastedTextModalProps {
  visible: boolean;
  id: number | null;
  content: string;
  onClose: () => void;
  onRemove: (id: number) => void;
}

export function PastedTextModal({ visible, id, content, onClose, onRemove }: PastedTextModalProps) {
  if (id == null) return null;
  const lineCount = (() => {
    let n = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) n++;
    }
    return n;
  })();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="pasted-text-modal"
    >
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={onClose}
        testID="pasted-text-modal-backdrop"
      >
        <TouchableOpacity
          style={styles.dialog}
          activeOpacity={1}
          // Catch backdrop taps inside the dialog so they don't close.
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={styles.headerText} numberOfLines={1}>
              Pasted text #{id} · {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {content.length} chars
            </Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="pasted-text-modal-close"
            >
              <Text style={styles.headerClose}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            testID="pasted-text-modal-body"
          >
            <Text style={styles.bodyText} selectable>{content}</Text>
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.removeButton}
              accessibilityRole="button"
              accessibilityLabel="Remove paste"
              testID="pasted-text-modal-remove"
              onPress={() => { onRemove(id); onClose(); }}
            >
              <Text style={styles.removeButtonText}>Remove paste</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  dialog: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    width: '100%',
    maxWidth: 600,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  headerText: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginRight: 12,
  },
  headerClose: {
    color: COLORS.textMuted,
    fontSize: 22,
    lineHeight: 22,
    paddingHorizontal: 4,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 12,
  },
  bodyText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.backgroundCard,
  },
  removeButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
    minHeight: 44,
    justifyContent: 'center',
  },
  removeButtonText: {
    color: COLORS.textPrimary,
    fontSize: 13,
  },
});
