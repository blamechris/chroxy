import React from 'react';
import { View, Text, TouchableOpacity, Linking, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';
import type { DevPreview } from '../store/types';

interface DevPreviewBannerProps {
  previews: DevPreview[];
  onClose: (port: number) => void;
}

export function DevPreviewBanner({ previews, onClose }: DevPreviewBannerProps) {
  if (previews.length === 0) return null;

  return (
    <View style={styles.container}>
      {previews.map((preview) => (
        <View key={preview.port} style={styles.banner}>
          <TouchableOpacity
            style={styles.linkArea}
            onPress={() => void Linking.openURL(preview.url).catch(() => {})}
          >
            <Text style={styles.icon}>{'\uD83C\uDF10'}</Text>
            <View style={styles.textArea}>
              <Text style={styles.label}>Dev Preview (:{preview.port})</Text>
              <Text style={styles.url} numberOfLines={1}>{preview.url}</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => onClose(preview.port)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.closeText}>{'\u2715'}</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.accentBlueLight,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  linkArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    fontSize: 18,
    marginRight: 8,
  },
  textArea: {
    flex: 1,
  },
  label: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontWeight: '600',
  },
  url: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 1,
  },
  closeButton: {
    padding: 4,
    marginLeft: 8,
  },
  closeText: {
    color: COLORS.textMuted,
    fontSize: 14,
  },
});
