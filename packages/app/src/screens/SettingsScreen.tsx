import React from 'react';
import {
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore } from '../store/connection';
import { COLORS } from '../constants/colors';

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const {
    inputSettings,
    updateInputSettings,
    forgetSession,
    disconnect,
    clearSavedConnection,
    wsUrl,
    serverVersion,
    serverMode,
  } = useConnectionStore();

  const handleClearSessionHistory = () => {
    Alert.alert(
      'Clear Session History',
      'This will erase all chat messages and disconnect from the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            forgetSession();
            disconnect();
          },
        },
      ],
    );
  };

  const handleClearSavedConnection = () => {
    Alert.alert(
      'Clear Saved Connection',
      'This will remove the saved server URL and token used for quick reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void clearSavedConnection();
          },
        },
      ],
    );
  };

  const truncatedUrl = wsUrl
    ? wsUrl.length > 40
      ? wsUrl.slice(0, 37) + '...'
      : wsUrl
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      {/* SESSION */}
      <Text style={styles.sectionHeader}>SESSION</Text>
      <View style={styles.section}>
        <TouchableOpacity style={styles.row} onPress={handleClearSessionHistory}>
          <Text style={styles.destructiveText}>Clear Session History</Text>
        </TouchableOpacity>
      </View>

      {/* CONNECTION */}
      <Text style={styles.sectionHeader}>CONNECTION</Text>
      <View style={styles.section}>
        <TouchableOpacity style={styles.row} onPress={handleClearSavedConnection}>
          <Text style={styles.destructiveText}>Clear Saved Connection</Text>
        </TouchableOpacity>
      </View>

      {/* INPUT */}
      <Text style={styles.sectionHeader}>INPUT</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Chat: Enter to Send</Text>
          <Switch
            value={inputSettings.chatEnterToSend}
            onValueChange={(value) => updateInputSettings({ chatEnterToSend: value })}
            trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          />
        </View>
        <View style={styles.separator} />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Terminal: Enter to Send</Text>
          <Switch
            value={inputSettings.terminalEnterToSend}
            onValueChange={(value) => updateInputSettings({ terminalEnterToSend: value })}
            trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          />
        </View>
      </View>

      {/* ABOUT */}
      <Text style={styles.sectionHeader}>ABOUT</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>App Version</Text>
          <Text style={styles.rowValue}>0.1.0</Text>
        </View>
        {serverVersion != null && (
          <>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server Version</Text>
              <Text style={styles.rowValue}>{serverVersion}</Text>
            </View>
          </>
        )}
        {serverMode != null && (
          <>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server Mode</Text>
              <Text style={styles.rowValue}>{serverMode}</Text>
            </View>
          </>
        )}
        {truncatedUrl != null && (
          <>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server</Text>
              <Text style={[styles.rowValue, styles.rowValueSmall]} numberOfLines={1}>
                {truncatedUrl}
              </Text>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  sectionHeader: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 6,
    marginHorizontal: 16,
  },
  section: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 10,
    marginHorizontal: 16,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.backgroundCard,
    marginLeft: 16,
  },
  rowLabel: {
    color: COLORS.textPrimary,
    fontSize: 15,
  },
  rowValue: {
    color: COLORS.textMuted,
    fontSize: 15,
  },
  rowValueSmall: {
    fontSize: 13,
    maxWidth: 200,
  },
  destructiveText: {
    color: COLORS.accentRed,
    fontSize: 15,
  },
});
