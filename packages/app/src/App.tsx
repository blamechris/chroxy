import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import ActivityScreen from './screens/ActivityScreen';
import { LockScreen } from './components/LockScreen';
import { ConnectionAnnouncer } from './components/ConnectionAnnouncer';
import { useConnectionStore } from './store/connection';
import { disconnectWithQueueGuard } from './store/disconnectWithQueueGuard';
import { useConnectionLifecycleStore } from './store/connection-lifecycle';
import { setupNotificationResponseListener } from './notifications';
import { useBiometricLock } from './hooks/useBiometricLock';
import { useNotificationStore } from './store/notifications';

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
  Activity: undefined;
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
  const { isLocked, gateReady, unlock } = useBiometricLock();
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    const sub = setupNotificationResponseListener();
    // Load persistent activity history on mount
    void useNotificationStore.getState().loadActivityHistory();
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

  // #5643 — cold-start biometric gate. The navigator (and its ConnectScreen,
  // which auto-reconnects using the stored token) must not mount until the
  // biometric-lock decision has resolved AND any cold-start lock is cleared.
  // navigatorMounted records that the navigator has already come up once, so a
  // later resume-lock (background→foreground) stays an overlay rather than
  // tearing the live session down.
  const navigatorMounted = useRef(false);

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

  // Gate cold start: while the lock decision is unresolved render nothing (no
  // flash of app content); if locked before the navigator has ever mounted,
  // render only the LockScreen so auto-reconnect can't fire behind it.
  if (!gateReady) {
    return <StatusBar style="light" />;
  }
  if (isLocked && !navigatorMounted.current) {
    return (
      <>
        <StatusBar style="light" />
        <LockScreen onUnlock={unlock} />
      </>
    );
  }

  navigatorMounted.current = true;

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      {/* #5581 — single app-level announcer: speaks settled connection-phase
          transitions via AccessibilityInfo.announceForAccessibility (debounced,
          renders nothing — no persistent live-region element). */}
      <ConnectionAnnouncer />
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
                    onPress={disconnectWithQueueGuard}
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
        <Stack.Screen
          name="Activity"
          component={ActivityScreen}
          options={{ title: 'Activity' }}
        />
      </Stack.Navigator>
      {isLocked && <LockScreen onUnlock={unlock} />}
    </NavigationContainer>
  );
}
