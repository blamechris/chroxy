import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  Modal,
  Pressable,
} from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { COLORS } from '../../constants/colors';
import { getSpeechLang, setSpeechLang } from '../../hooks/useSpeechRecognition';
import type { InputSettings } from '../../store/types';
import { styles } from './styles';
import { SPEECH_LANGUAGES, VOICE_INPUT_MODES } from './constants';

/**
 * INPUT section — chat / terminal enter-to-send toggles, speech language,
 * and voice input mode, plus the language + voice-mode picker sheets.
 * Extracted from SettingsScreen (#5655). Behaviour-preserving.
 *
 * Owns the speech-language load + picker visibility as local UI state
 * (mirroring QuietHoursEditor's `showTzPicker`) — none of it is read
 * outside this section. `inputSettings` + `updateInputSettings` come from
 * the connection store and are passed down from SettingsScreen.
 */
export function VoiceInputSection(props: {
  insets: EdgeInsets;
  inputSettings: InputSettings;
  updateInputSettings: (patch: Partial<InputSettings>) => void;
}) {
  const { insets, inputSettings, updateInputSettings } = props;

  const [speechLang, setSpeechLangState] = useState<string>('en-US');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [showVoiceModePicker, setShowVoiceModePicker] = useState(false);

  useEffect(() => {
    getSpeechLang()
      .then(setSpeechLangState)
      .catch(() => {
        // Ignore — falls back to default 'en-US'
      });
  }, []);

  const handleSelectLang = async (tag: string) => {
    setSpeechLangState(tag);
    await setSpeechLang(tag);
    setShowLangPicker(false);
  };

  const currentLangLabel = SPEECH_LANGUAGES.find((l) => l.tag === speechLang)?.label ?? speechLang;

  return (
    <>
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
        <View style={styles.separator} />
        <TouchableOpacity style={styles.row} onPress={() => setShowVoiceModePicker(true)}>
          <Text style={styles.rowLabel}>Voice Input Mode</Text>
          <Text style={styles.rowValue}>
            {VOICE_INPUT_MODES.find((m) => m.value === inputSettings.voiceInputMode)?.label
              ?? inputSettings.voiceInputMode}
          </Text>
        </TouchableOpacity>
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

      {/* Voice input mode picker (#4807) */}
      <Modal
        visible={showVoiceModePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowVoiceModePicker(false)}
      >
        <Pressable style={styles.sheetOverlay} onPress={() => setShowVoiceModePicker(false)}>
          <Pressable
            style={[styles.sheetContent, { paddingBottom: Math.max(insets.bottom, 8) }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.sheetTitle}>Voice Input Mode</Text>
            <ScrollView style={styles.sheetList} bounces={false}>
              {VOICE_INPUT_MODES.map((opt) => {
                const active = opt.value === inputSettings.voiceInputMode;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.sheetOption, active && styles.sheetOptionActive]}
                    onPress={() => {
                      updateInputSettings({ voiceInputMode: opt.value });
                      setShowVoiceModePicker(false);
                    }}
                  >
                    <Text style={[styles.sheetOptionText, active && styles.sheetOptionTextActive]}>
                      {opt.label}
                    </Text>
                    <Text style={styles.sheetOptionTag}>{opt.hint}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={[styles.sheetOption, styles.sheetCancel]}
              onPress={() => setShowVoiceModePicker(false)}
            >
              <Text style={[styles.sheetOptionText, styles.sheetCancelText]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
