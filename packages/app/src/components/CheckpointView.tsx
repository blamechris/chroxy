import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  TextInput,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useConnectionStore } from '../store/connection';
import type { Checkpoint } from '../store/types';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';

interface CheckpointViewProps {
  visible: boolean;
  onClose: () => void;
}

/** Format a timestamp into a readable date/time string */
function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return `Today ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `Yesterday ${time}`;
  }

  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function CheckpointItem({
  checkpoint,
  onDelete,
  onRestore,
}: {
  checkpoint: Checkpoint;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <View style={styles.timelineItem}>
      {/* Timeline dot and line */}
      <View style={styles.timelineTrack}>
        <View style={[styles.timelineDot, checkpoint.hasGitSnapshot && styles.timelineDotGit]} />
        <View style={styles.timelineLine} />
      </View>

      {/* Content */}
      <View style={styles.itemContent}>
        <View style={styles.itemHeader}>
          <Text style={styles.itemName} numberOfLines={1}>{checkpoint.name}</Text>
          <Text style={styles.itemTimestamp}>{formatTimestamp(checkpoint.createdAt)}</Text>
        </View>

        {checkpoint.description ? (
          <Text style={styles.itemDescription} numberOfLines={2}>
            {checkpoint.description}
          </Text>
        ) : null}

        <View style={styles.itemMeta}>
          <Text style={styles.itemMetaText}>
            {checkpoint.messageCount} message{checkpoint.messageCount !== 1 ? 's' : ''}
          </Text>
          {checkpoint.hasGitSnapshot && (
            <Text style={styles.itemMetaBadge}>git snapshot</Text>
          )}
        </View>

        <View style={styles.itemActions}>
          <TouchableOpacity
            style={styles.restoreButton}
            onPress={() => onRestore(checkpoint.id)}
            accessibilityRole="button"
            accessibilityLabel={`Restore checkpoint ${checkpoint.name}`}
          >
            <Text style={styles.restoreButtonText}>Restore</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.deleteButton}
            onPress={() => onDelete(checkpoint.id)}
            accessibilityRole="button"
            accessibilityLabel={`Delete checkpoint ${checkpoint.name}`}
          >
            <Icon name="close" size={14} color={COLORS.accentRed} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export function CheckpointView({ visible, onClose }: CheckpointViewProps) {
  const checkpoints = useConnectionStore((s) => s.checkpoints);
  const createCheckpoint = useConnectionStore((s) => s.createCheckpoint);
  const listCheckpoints = useConnectionStore((s) => s.listCheckpoints);
  const deleteCheckpoint = useConnectionStore((s) => s.deleteCheckpoint);
  const restoreCheckpoint = useConnectionStore((s) => s.restoreCheckpoint);

  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newCheckpointName, setNewCheckpointName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const creatingTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(creatingTimerRef.current), []);

  // Fetch checkpoints when modal opens; reset local state when it closes
  useEffect(() => {
    if (visible) {
      listCheckpoints();
    } else {
      setShowCreateInput(false);
      setNewCheckpointName('');
      setIsCreating(false);
      clearTimeout(creatingTimerRef.current);
    }
  }, [visible, listCheckpoints]);

  // Sort checkpoints in reverse chronological order
  const sortedCheckpoints = React.useMemo(
    () => [...checkpoints].sort((a, b) => b.createdAt - a.createdAt),
    [checkpoints],
  );

  const handleCreate = useCallback(() => {
    const name = newCheckpointName.trim() || undefined;
    createCheckpoint(name);
    setNewCheckpointName('');
    setShowCreateInput(false);
    setIsCreating(true);
    // Clear creating state after a short delay (server will update the list)
    clearTimeout(creatingTimerRef.current);
    creatingTimerRef.current = setTimeout(() => setIsCreating(false), 2000);
  }, [newCheckpointName, createCheckpoint]);

  const handleDelete = useCallback(
    (id: string) => {
      const cp = checkpoints.find((c) => c.id === id);
      Alert.alert(
        'Delete Checkpoint',
        `Delete "${cp?.name || 'checkpoint'}"? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteCheckpoint(id),
          },
        ],
      );
    },
    [checkpoints, deleteCheckpoint],
  );

  const handleRestore = useCallback(
    (id: string) => {
      const cp = checkpoints.find((c) => c.id === id);
      Alert.alert(
        'Restore Checkpoint',
        `Restore to "${cp?.name || 'checkpoint'}"? This will create a new session from this point.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            onPress: () => {
              restoreCheckpoint(id);
              onClose();
            },
          },
        ],
      );
    },
    [checkpoints, restoreCheckpoint, onClose],
  );

  const renderItem = useCallback(
    ({ item }: { item: Checkpoint }) => (
      <CheckpointItem
        checkpoint={item}
        onDelete={handleDelete}
        onRestore={handleRestore}
      />
    ),
    [handleDelete, handleRestore],
  );

  const keyExtractor = useCallback((item: Checkpoint) => item.id, []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Checkpoints</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close checkpoints"
            >
              <Icon name="close" size={20} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Create checkpoint area */}
          <View style={styles.createArea}>
            {showCreateInput ? (
              <View style={styles.createInputRow}>
                <TextInput
                  style={styles.createInput}
                  placeholder="Checkpoint name (optional)"
                  placeholderTextColor={COLORS.textDim}
                  value={newCheckpointName}
                  onChangeText={setNewCheckpointName}
                  onSubmitEditing={handleCreate}
                  autoFocus
                  returnKeyType="done"
                />
                <TouchableOpacity
                  style={styles.createConfirmButton}
                  onPress={handleCreate}
                  accessibilityRole="button"
                  accessibilityLabel="Create checkpoint"
                >
                  <Icon name="check" size={18} color={COLORS.accentGreen} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.createCancelButton}
                  onPress={() => {
                    setShowCreateInput(false);
                    setNewCheckpointName('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel creating checkpoint"
                >
                  <Icon name="close" size={16} color={COLORS.textMuted} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.createButton}
                onPress={() => setShowCreateInput(true)}
                accessibilityRole="button"
                accessibilityLabel="Create new checkpoint"
              >
                <Icon name="plus" size={16} color={COLORS.accentBlue} />
                <Text style={styles.createButtonText}>Create Checkpoint</Text>
              </TouchableOpacity>
            )}
            {isCreating && (
              <View style={styles.creatingRow}>
                <ActivityIndicator size="small" color={COLORS.accentBlue} />
                <Text style={styles.creatingText}>Creating checkpoint...</Text>
              </View>
            )}
          </View>

          {/* Checkpoint list */}
          {sortedCheckpoints.length === 0 ? (
            <View style={styles.emptyState}>
              <Icon name="clock" size={32} color={COLORS.textDim} />
              <Text style={styles.emptyText}>No checkpoints yet</Text>
              <Text style={styles.emptySubtext}>
                Create a checkpoint to save your session state for later restoration.
              </Text>
            </View>
          ) : (
            <FlatList
              data={sortedCheckpoints}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: COLORS.backgroundPrimary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '80%',
    minHeight: '40%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  closeButton: {
    padding: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createArea: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
    borderStyle: 'dashed',
  },
  createButtonText: {
    color: COLORS.accentBlue,
    fontSize: 14,
    fontWeight: '500',
  },
  createInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  createInput: {
    flex: 1,
    backgroundColor: COLORS.backgroundCard,
    color: COLORS.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
  },
  createConfirmButton: {
    padding: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createCancelButton: {
    padding: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  creatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  creatingText: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  list: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 32,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: 16,
    fontWeight: '500',
  },
  emptySubtext: {
    color: COLORS.textDim,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  timelineItem: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  timelineTrack: {
    width: 24,
    alignItems: 'center',
    paddingTop: 6,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.accentBlue,
    borderWidth: 2,
    borderColor: COLORS.accentBlueBorderStrong,
  },
  timelineDotGit: {
    backgroundColor: COLORS.accentGreen,
    borderColor: COLORS.accentGreenBorderStrong,
  },
  timelineLine: {
    flex: 1,
    width: 2,
    backgroundColor: COLORS.borderPrimary,
    marginTop: 4,
  },
  itemContent: {
    flex: 1,
    paddingLeft: 12,
    paddingBottom: 16,
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textPrimary,
    flex: 1,
    marginRight: 8,
  },
  itemTimestamp: {
    fontSize: 12,
    color: COLORS.textDim,
  },
  itemDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 6,
    lineHeight: 18,
  },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  itemMetaText: {
    fontSize: 12,
    color: COLORS.textDim,
  },
  itemMetaBadge: {
    fontSize: 11,
    color: COLORS.accentGreen,
    backgroundColor: COLORS.accentGreenLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  restoreButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: COLORS.accentBlueLight,
    borderWidth: 1,
    borderColor: COLORS.accentBlueBorder,
  },
  restoreButtonText: {
    fontSize: 12,
    color: COLORS.accentBlue,
    fontWeight: '500',
  },
  deleteButton: {
    padding: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: COLORS.accentRedLight,
  },
});
