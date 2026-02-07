import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useConnectionStore, DiscoveredSession } from '../store/connection';

interface CreateSessionModalProps {
  visible: boolean;
  onClose: () => void;
}

export function CreateSessionModal({ visible, onClose }: CreateSessionModalProps) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const createSession = useConnectionStore((s) => s.createSession);
  const sessions = useConnectionStore((s) => s.sessions);
  const discoverSessions = useConnectionStore((s) => s.discoverSessions);
  const attachSession = useConnectionStore((s) => s.attachSession);
  const discoveredSessions = useConnectionStore((s) => s.discoveredSessions);
  const [isDiscovering, setIsDiscovering] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setIsDiscovering(false);
    }
  }, [visible]);

  const handleCreate = () => {
    const sessionName = name.trim() || `Session ${sessions.length + 1}`;
    const sessionCwd = cwd.trim() || undefined;
    createSession(sessionName, sessionCwd);
    setName('');
    setCwd('');
    onClose();
  };

  const handleCancel = () => {
    setName('');
    setCwd('');
    onClose();
  };

  const handleDiscover = () => {
    setIsDiscovering(true);
    discoverSessions();
    // Safety timeout: clear loading state if no response arrives (e.g. session_error, disconnect)
    setTimeout(() => setIsDiscovering(false), 10_000);
  };

  // Clear discovering state when results arrive
  useEffect(() => {
    if (discoveredSessions !== null) {
      setIsDiscovering(false);
    }
  }, [discoveredSessions]);

  const handleAttach = (session: DiscoveredSession) => {
    attachSession(session.sessionName);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} bounces={false}>
          <View style={styles.modal}>
            <Text style={styles.title}>New Session</Text>

            <Text style={styles.label}>Session Name</Text>
            <TextInput
              style={styles.input}
              placeholder={`Session ${sessions.length + 1}`}
              placeholderTextColor="#555"
              value={name}
              onChangeText={setName}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />

            <Text style={styles.label}>Working Directory</Text>
            <TextInput
              style={styles.input}
              placeholder="Server default"
              placeholderTextColor="#555"
              value={cwd}
              onChangeText={setCwd}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>Leave empty to use the server's default directory</Text>

            <View style={styles.buttons}>
              <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.createButton} onPress={handleCreate}>
                <Text style={styles.createButtonText}>Create</Text>
              </TouchableOpacity>
            </View>

            {/* Host session discovery */}
            <View style={styles.divider} />
            <Text style={styles.sectionTitle}>Attach to Host Session</Text>
            <Text style={styles.sectionHint}>
              Discover tmux sessions running Claude on the server
            </Text>

            <TouchableOpacity
              style={styles.discoverButton}
              onPress={handleDiscover}
              disabled={isDiscovering}
            >
              {isDiscovering ? (
                <ActivityIndicator size="small" color="#4a9eff" />
              ) : (
                <Text style={styles.discoverButtonText}>Scan for Sessions</Text>
              )}
            </TouchableOpacity>

            {discoveredSessions !== null && discoveredSessions.length === 0 && (
              <Text style={styles.noSessions}>
                No Claude sessions found. Start Claude in a tmux session first.
              </Text>
            )}

            {discoveredSessions !== null && discoveredSessions.length > 0 && (
              <View style={styles.discoveredList}>
                {discoveredSessions.map((s) => (
                  <TouchableOpacity
                    key={`${s.sessionName}-${s.pid}`}
                    style={styles.discoveredItem}
                    onPress={() => handleAttach(s)}
                  >
                    <Text style={styles.discoveredName}>{s.sessionName}</Text>
                    <Text style={styles.discoveredCwd} numberOfLines={1}>{s.cwd}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2a2a4e',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  label: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#0f0f1a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a4e',
  },
  hint: {
    color: '#555',
    fontSize: 12,
    marginTop: -8,
    marginBottom: 16,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#2a2a4e',
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#888',
    fontSize: 15,
    fontWeight: '600',
  },
  createButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#4a9eff',
    alignItems: 'center',
  },
  createButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#2a2a4e',
    marginVertical: 16,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  sectionHint: {
    color: '#555',
    fontSize: 12,
    marginBottom: 12,
  },
  discoverButton: {
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#2a2a4e',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3a3a5e',
    minHeight: 40,
    justifyContent: 'center',
  },
  discoverButtonText: {
    color: '#4a9eff',
    fontSize: 14,
    fontWeight: '600',
  },
  noSessions: {
    color: '#555',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 10,
  },
  discoveredList: {
    marginTop: 10,
    gap: 6,
  },
  discoveredItem: {
    backgroundColor: '#0f0f1a',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#22c55e44',
  },
  discoveredName: {
    color: '#22c55e',
    fontSize: 14,
    fontWeight: '600',
  },
  discoveredCwd: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
});
