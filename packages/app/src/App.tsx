import React, { useCallback, useEffect, useState } from 'react';
import { Platform, UIManager, TouchableOpacity, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator, NativeStackScreenProps } from '@react-navigation/native-stack';
import * as SecureStore from 'expo-secure-store';

import { ConnectScreen } from './screens/ConnectScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { SessionScreen } from './screens/SessionScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsScreen } from './screens/SettingsScreen';
import { PermissionHistoryScreen } from './screens/PermissionHistoryScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { LockScreen } from './components/LockScreen';
import { useConnectionStore } from './store/connection';
import { useConnectionLifecycleStore } from './store/connection-lifecycle';
import { setupNotificationResponseListener } from './notifications';
import { useBiometricLock } from './hooks/useBiometricLock';

// Enable LayoutAnimation on Android (must be called before any component uses it)
if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const ONBOARDING_KEY = 'onboarding_complete';

export type RootStackParamList = {
  Connect: undefined;
  Session: undefined;
  Settings: undefined;
  PermissionHistory: undefined;
  History: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function SessionScreenWithBoundary(_props: NativeStackScreenProps<RootStackParamList, 'Session'>) {
  return (
    <ErrorBoundary fallbackTitle="Session crashed">
      <SessionScreen />
    </ErrorBoundary>
  );
}

export default function App() {
  const connectionPhase = useConnectionLifecycleStore((s) => s.connectionPhase);
  const viewingCachedSession = useConnectionStore((s) => s.viewingCachedSession);
  const showSession = connectionPhase !== 'disconnected' || viewingCachedSession;
  const sessionTitle = useConnectionStore((s) => {
    const id = s.activeSessionId;
    const session = id ? s.sessions.find((sess) => sess.sessionId === id) : null;
    if (!session?.cwd) return 'Session';
    // Shorten /Users/name/Projects → ~/Projects
    const cwd = session.cwd.replace(/^\/Users\/[^/]+/, '~');
    // Take last two path components for readability
    const parts = cwd.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : cwd;
  });
  const { isLocked, unlock } = useBiometricLock();
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    const sub = setupNotificationResponseListener();
    return () => sub.remove();
  }, []);

  useEffect(() => {
    SecureStore.getItemAsync(ONBOARDING_KEY)
      .then((val) => {
        setOnboardingDone(val === 'true');
      })
      .catch(() => {
        setOnboardingDone(true);
      });
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    SecureStore.setItemAsync(ONBOARDING_KEY, 'true').catch(() => {});
    setOnboardingDone(true);
  }, []);

  // Still loading onboarding state
  if (onboardingDone === null) return null;

  if (!onboardingDone) {
    return (
      <>
        <StatusBar style="light" />
        <OnboardingScreen onComplete={handleOnboardingComplete} />
      </>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: '#1a1a2e' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#0f0f1a' },
        }}
      >
        {!showSession ? (
          <Stack.Screen
            name="Connect"
            component={ConnectScreen}
            options={{ title: 'Chroxy' }}
          />
        ) : (
          <>
            <Stack.Screen
              name="Session"
              component={SessionScreenWithBoundary}
              options={{
                title: sessionTitle,
                headerRight: () => (
                  <TouchableOpacity
                    onPress={() => useConnectionStore.getState().disconnect()}
                    style={{ paddingLeft: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel="Disconnect and go back"
                  >
                    <Text style={{ color: '#ff6b6b', fontSize: 15, fontWeight: '500' }}>Disconnect</Text>
                  </TouchableOpacity>
                ),
              }}
            />
            <Stack.Screen
              name="PermissionHistory"
              component={PermissionHistoryScreen}
              options={{ title: 'Permission History' }}
            />
            <Stack.Screen
              name="History"
              component={HistoryScreen}
              options={{ title: 'History' }}
            />
          </>
        )}
        {/* UX landmine #2: Settings is always accessible — not gated
            behind a successful connection. Connection-dependent sections
            are conditionally hidden inside SettingsScreen itself. */}
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Settings' }}
        />
      </Stack.Navigator>
      {isLocked && <LockScreen onUnlock={unlock} />}
    </NavigationContainer>
  );
}
