import React from 'react';
import { Modal, View, Image, TouchableOpacity, Pressable, Text, StyleSheet, Dimensions } from 'react-native';
import { Icon } from './Icon';
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
      <Pressable style={styles.overlay} onPress={onClose}>
        <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close image">
          <Icon name="close" size={18} color={COLORS.textPrimary} />
        </TouchableOpacity>
        <Pressable onPress={(e) => e.stopPropagation()}>
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="contain"
          />
        </Pressable>
      </Pressable>
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
