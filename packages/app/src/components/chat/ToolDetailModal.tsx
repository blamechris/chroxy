import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import type { ToolResultImage } from '../../store/connection';
import { Icon } from '../Icon';
import { COLORS } from '../../constants/colors';

export function ToolDetailModal({ visible, toolName, content, toolResult, toolResultTruncated, toolResultImages, serverName, onClose, onImagePress }: {
  visible: boolean;
  toolName: string;
  content: string;
  toolResult?: string;
  toolResultTruncated?: boolean;
  toolResultImages?: ToolResultImage[];
  serverName?: string;
  onClose: () => void;
  onImagePress: (uri: string) => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.toolModalOverlay} onPress={onClose}>
        <Pressable style={styles.toolModalContainer} onPress={(e) => e.stopPropagation()}>
          <View style={styles.toolModalHeader}>
            <View style={styles.toolModalTitleContainer}>
              <Text style={styles.toolModalTitle} numberOfLines={1}>Tool: {toolName}</Text>
              {serverName ? (
                <Text style={styles.toolModalServerLabel}>via MCP server: {serverName}</Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.toolModalCloseButton}
              accessibilityRole="button"
              accessibilityLabel="Close tool details"
            >
              <Icon name="close" size={18} color={COLORS.textPrimary} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.toolModalScroll}>
            {content ? (
              <>
                <Text style={styles.toolModalSectionLabel}>Input</Text>
                <Text selectable style={styles.toolModalContent}>{content}</Text>
              </>
            ) : null}
            {toolResultImages && toolResultImages.length > 0 ? (
              <>
                <Text style={[styles.toolModalSectionLabel, content ? { marginTop: 12 } : undefined]}>
                  {toolResultImages.length === 1 ? 'Image' : `Images (${toolResultImages.length})`}
                </Text>
                <View style={styles.toolImageGrid}>
                  {toolResultImages.map((img, i) => {
                    const uri = `data:${img.mediaType};base64,${img.data}`;
                    return (
                      <TouchableOpacity
                        key={i}
                        onPress={() => onImagePress(uri)}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={`View image ${i + 1} of ${toolResultImages.length}`}
                      >
                        <Image source={{ uri }} style={styles.toolImageThumb} resizeMode="cover" />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            ) : null}
            {toolResult != null ? (
              <>
                <Text style={[styles.toolModalSectionLabel, (content || toolResultImages?.length) ? { marginTop: 12 } : undefined]}>Result{toolResultTruncated ? ' (truncated)' : ''}</Text>
                <Text selectable style={styles.toolModalContent}>{toolResult}</Text>
              </>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  toolModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  toolModalContainer: {
    width: '100%',
    maxHeight: '80%',
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    overflow: 'hidden',
  },
  toolModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  toolModalTitleContainer: {
    flex: 1,
  },
  toolModalTitle: {
    color: COLORS.accentPurple,
    fontSize: 14,
    fontWeight: '600',
    marginRight: 12,
  },
  toolModalServerLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  toolModalCloseButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -12,
  },
  toolModalScroll: {
    padding: 16,
  },
  toolModalContent: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
  },
  toolModalSectionLabel: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  toolImageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  toolImageThumb: {
    width: 140,
    height: 100,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundCard,
  },
});
