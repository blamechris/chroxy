import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Modal,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { useConnectionStore } from '../store/connection';
import { COLORS } from '../constants/colors';
import { getSpeechLang, setSpeechLang } from '../hooks/useSpeechRecognition';

const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

const SPEECH_LANGUAGES = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'es-ES', label: 'Spanish (Spain)' },
  { tag: 'es-MX', label: 'Spanish (Mexico)' },
  { tag: 'fr-FR', label: 'French' },
  { tag: 'de-DE', label: 'German' },
  { tag: 'it-IT', label: 'Italian' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  { tag: 'pt-PT', label: 'Portuguese (Portugal)' },
  { tag: 'nl-NL', label: 'Dutch' },
  { tag: 'ja-JP', label: 'Japanese' },
  { tag: 'ko-KR', label: 'Korean' },
  { tag: 'zh-CN', label: 'Chinese (Simplified)' },
  { tag: 'zh-TW', label: 'Chinese (Traditional)' },
  { tag: 'ru-RU', label: 'Russian' },
  { tag: 'ar-SA', label: 'Arabic' },
];

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [speechLang, setSpeechLangState] = useState<string>('en-US');
  const [showLangPicker, setShowLangPicker] = useState(false);

  useEffect(() => {
    getSpeechLang().then(setSpeechLangState);
  }, []);

  const handleSelectLang = (tag: string) => {
    setSpeechLangState(tag);
    setSpeechLang(tag);
    setShowLangPicker(false);
  };

  const currentLangLabel = SPEECH_LANGUAGES.find((l) => l.tag === speechLang)?.label ?? speechLang;

  const {
    inputSettings,
    updateInputSettings,
    forgetSession,
    disconnect,
    clearSavedConnection,
    requestFullHistory,
    wsUrl,
    serverVersion,
    latestVersion,
    serverMode,
  } = useConnectionStore();

  const conversationId = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id && s.sessionStates[id] ? s.sessionStates[id].conversationId : null;
  });

  // Simple semver comparison: check if latest > current (not just different)
  const updateAvailable = (() => {
    if (!serverVersion || !latestVersion || latestVersion === serverVersion) return false;
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
    const cur = parse(serverVersion);
    const lat = parse(latestVersion);
    for (let i = 0; i < 3; i++) {
      if ((lat[i] || 0) > (cur[i] || 0)) return true;
      if ((lat[i] || 0) < (cur[i] || 0)) return false;
    }
    return false;
  })();

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
            disconnect();
            forgetSession();
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
          onPress: async () => {
            await clearSavedConnection();
            Alert.alert('Done', 'Saved connection has been cleared.');
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

      {/* PORTABILITY */}
      {conversationId != null && (
        <>
          <Text style={styles.sectionHeader}>PORTABILITY</Text>
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(conversationId);
                  Alert.alert(
                    'Copied',
                    `Resume from terminal:\n\nclaude --resume ${conversationId}`,
                  );
                } catch {
                  Alert.alert('Error', 'Failed to copy.');
                }
              }}
            >
              <Text style={styles.rowLabel}>Conversation ID</Text>
              <Text style={[styles.rowValue, styles.rowValueSmall]} numberOfLines={1}>
                {conversationId.slice(0, 8)}...
              </Text>
            </TouchableOpacity>
            <View style={styles.separator} />
            <TouchableOpacity
              style={styles.row}
              onPress={() => {
                requestFullHistory();
                Alert.alert('Syncing', 'Full conversation history requested from server.');
              }}
            >
              <Text style={styles.actionText}>Sync Full History</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

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
        <View style={styles.separator} />
        <TouchableOpacity style={styles.row} onPress={() => setShowLangPicker(true)}>
          <Text style={styles.rowLabel}>Speech Language</Text>
          <Text style={styles.rowValue}>{currentLangLabel}</Text>
        </TouchableOpacity>
      </View>

      {/* ABOUT */}
      <Text style={styles.sectionHeader}>ABOUT</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>App Version</Text>
          <Text style={styles.rowValue}>{APP_VERSION}</Text>
        </View>
        {serverVersion != null && (
          <>
            <View style={styles.separator} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server Version</Text>
              <View style={styles.versionRow}>
                <Text style={styles.rowValue}>{serverVersion}</Text>
                {updateAvailable && (
                  <View style={styles.updateBadge}>
                    <Text style={styles.updateBadgeText}>{latestVersion} available</Text>
                  </View>
                )}
              </View>
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
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                if (wsUrl) {
                  try {
                    await Clipboard.setStringAsync(wsUrl);
                    Alert.alert('Copied', 'Server URL copied to clipboard.');
                  } catch (error) {
                    console.error('Failed to copy server URL to clipboard:', error);
                    Alert.alert('Error', 'Failed to copy server URL to clipboard.');
                  }
                }
              }}
            >
              <Text style={styles.rowLabel}>Server</Text>
              <Text style={[styles.rowValue, styles.rowValueSmall]} numberOfLines={1}>
                {truncatedUrl}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Speech language picker */}
      <Modal visible={showLangPicker} transparent animationType="slide" onRequestClose={() => setShowLangPicker(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => setShowLangPicker(false)}>
          <Pressable style={[styles.sheetContent, { paddingBottom: Math.max(insets.bottom, 8) }]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Speech Language</Text>
            <ScrollView style={styles.sheetList} bounces={false}>
              {SPEECH_LANGUAGES.map((lang) => (
                <TouchableOpacity
                  key={lang.tag}
                  style={[styles.sheetOption, lang.tag === speechLang && styles.sheetOptionActive]}
                  onPress={() => handleSelectLang(lang.tag)}
                >
                  <Text style={[styles.sheetOptionText, lang.tag === speechLang && styles.sheetOptionTextActive]}>
                    {lang.label}
                  </Text>
                  <Text style={styles.sheetOptionTag}>{lang.tag}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={[styles.sheetOption, styles.sheetCancel]} onPress={() => setShowLangPicker(false)}>
              <Text style={[styles.sheetOptionText, styles.sheetCancelText]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
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
  actionText: {
    color: COLORS.accentBlue,
    fontSize: 15,
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  updateBadge: {
    backgroundColor: COLORS.accentOrangeSubtle,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  updateBadgeText: {
    color: COLORS.accentOrange,
    fontSize: 11,
    fontWeight: '600',
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: COLORS.backgroundSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    maxHeight: '60%',
  },
  sheetTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 12,
  },
  sheetList: {
    flexShrink: 1,
  },
  sheetOption: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    minHeight: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sheetOptionActive: {
    backgroundColor: COLORS.accentBlueLight,
  },
  sheetOptionText: {
    color: COLORS.textPrimary,
    fontSize: 16,
  },
  sheetOptionTextActive: {
    color: COLORS.accentBlue,
    fontWeight: '600',
  },
  sheetOptionTag: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  sheetCancel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderPrimary,
    marginTop: 4,
    justifyContent: 'center',
  },
  sheetCancelText: {
    color: COLORS.accentRed,
    textAlign: 'center',
  },
});
