import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Linking, StyleSheet, TextInput } from 'react-native';
import { COLORS } from '../constants/colors';
import type { DevPreview } from '../store/types';

interface DevPreviewBannerProps {
  previews: DevPreview[];
  onClose: (port: number) => void;
  onOpen?: (port: number) => boolean;
}

export function DevPreviewBanner({ previews, onClose, onOpen }: DevPreviewBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const [port, setPort] = useState('');
  const [sent, setSent] = useState(false);
  const value = Number(port);
  const valid = /^\d+$/.test(port) && value >= 1024 && value <= 65535;
  if (previews.length === 0 && !onOpen) return null;

  return (
    <View style={styles.container}>
      {onOpen && <TouchableOpacity style={styles.requestButton} accessibilityLabel="Preview HTTP service" testID="dev-preview-request-toggle" onPress={() => setExpanded(!expanded)}><Text style={styles.label}>Preview HTTP service</Text></TouchableOpacity>}
      {expanded && <View>
        <Text style={styles.url}>HTTP only; no WebSockets or reconnect. Service must run in this session directory on 127.0.0.1. Primary token required.</Text>
        <Text style={styles.url}>Public URL; Chroxy adds no authentication. Review the service and Allow once in the consent prompt.</Text>
        <TextInput style={styles.portInput} value={port} keyboardType="number-pad" accessibilityLabel="Preview service port" testID="dev-preview-port" placeholder="Service port" placeholderTextColor={COLORS.textMuted} onChangeText={text => { setPort(text); setSent(false); }} />
        <TouchableOpacity style={styles.requestButton} disabled={!valid} accessibilityLabel="Request preview consent" testID="dev-preview-request" onPress={() => { if (valid && onOpen?.(value)) setSent(true); }}><Text style={styles.label}>Request preview consent</Text></TouchableOpacity>
        {sent && <TouchableOpacity style={styles.requestButton} accessibilityLabel="Cancel preview" testID="dev-preview-cancel" onPress={() => { onClose(value); setSent(false); }}><Text style={styles.label}>Cancel preview</Text></TouchableOpacity>}
      </View>}
      {previews.map((preview) => (
        <View key={preview.port} style={styles.banner}>
          <TouchableOpacity
            style={styles.linkArea}
            accessibilityLabel={`Open HTTP preview on port ${preview.port}`}
            testID={`dev-preview-open-${preview.port}`}
            onPress={() => void Linking.openURL(preview.url).catch(() => {})}
          >
            <Text style={styles.icon}>{'\uD83C\uDF10'}</Text>
            <View style={styles.textArea}>
              <Text style={styles.label}>HTTP Preview (:{preview.port})</Text>
              <Text style={styles.url}>{preview.target ? `${preview.target.command} (PID ${preview.target.pid}) · ${preview.target.host}:${preview.target.port}` : 'Loopback HTTP service'}</Text>
              <Text style={styles.url}>{preview.exposure || 'Public HTTP URL; no authentication added. No WebSockets or reconnect.'}</Text>
              <Text style={styles.url} numberOfLines={1}>{preview.url}</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.closeButton}
            accessibilityLabel={`Close HTTP preview on port ${preview.port}`}
            testID={`dev-preview-close-${preview.port}`}
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
  requestButton: { minHeight: 48, minWidth: 48, justifyContent: 'center', padding: 8 },
  portInput: { minHeight: 48, color: COLORS.textPrimary, borderWidth: 1, borderColor: COLORS.accentBlueBorder, padding: 8 },
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
    minHeight: 48,
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
    minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center',
    padding: 4,
    marginLeft: 8,
  },
  closeText: {
    color: COLORS.textMuted,
    fontSize: 14,
  },
});
