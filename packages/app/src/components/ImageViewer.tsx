import React from 'react';
import { Modal, View, Image, TouchableOpacity, Text, StyleSheet, Dimensions } from 'react-native';
import { ICON_CLOSE } from '../constants/icons';
import { COLORS } from '../constants/colors';

interface ImageViewerProps {
  uri: string | null;
  onClose: () => void;
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export function ImageViewer({ uri, onClose }: ImageViewerProps) {
  if (!uri) return null;

  return (
    <Modal
      visible={!!uri}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close image">
          <Text style={styles.closeText}>{ICON_CLOSE}</Text>
        </TouchableOpacity>
        <Image
          source={{ uri }}
          style={styles.image}
          resizeMode="contain"
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    zIndex: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: 'bold',
  },
  image: {
    width: SCREEN_WIDTH - 32,
    height: SCREEN_HEIGHT * 0.7,
  },
});
