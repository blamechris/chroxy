import React from 'react';
import { View, Text, Switch } from 'react-native';
import { COLORS } from '../../constants/colors';
import { authenticate, setBiometricEnabled } from '../../hooks/useBiometricLock';
import { styles } from './styles';

/**
 * SECURITY section — biometric-lock toggle. Extracted from SettingsScreen
 * (#5655). Behaviour-preserving: shown when hardware is available, or when
 * the preference is still enabled (so the user can disable it even if
 * biometrics were revoked). State lives in SettingsScreen and is passed
 * down; this component owns no store wiring.
 */
export function SecuritySection(props: {
  biometricAvail: boolean;
  biometricOn: boolean;
  onBiometricChange: (value: boolean) => void;
}) {
  const { biometricAvail, biometricOn, onBiometricChange } = props;

  // SECURITY — show when hardware available, or when preference is
  // still enabled (so user can disable it even if biometrics were revoked)
  if (!(biometricAvail || biometricOn)) return null;

  return (
    <>
      <Text style={styles.sectionHeader}>SECURITY</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Biometric Lock</Text>
          <Switch
            value={biometricOn}
            disabled={!biometricAvail && !biometricOn}
            onValueChange={async (value) => {
              if (value) {
                // Verify biometric before enabling
                const ok = await authenticate();
                if (!ok) return;
              }
              onBiometricChange(value);
              await setBiometricEnabled(value);
            }}
            trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          />
        </View>
        <View style={styles.separator} />
        <View style={styles.row}>
          <Text style={[styles.rowLabel, styles.rowHint]}>
            {biometricAvail
              ? 'Require Face ID / Touch ID when returning to the app'
              : 'Biometric hardware unavailable — toggle off to disable lock'}
          </Text>
        </View>
      </View>
    </>
  );
}
