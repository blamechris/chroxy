import React, { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SecureStore from 'expo-secure-store';

import { ConnectScreen } from './screens/ConnectScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { SessionScreen } from './screens/SessionScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { LockScreen } from './components/LockScreen';
import { useConnectionStore, selectShowSession } from './store/connection';
import { setupNotificationResponseListener } from './notifications';
import { useBiometricLock } from './hooks/useBiometricLock';

const ONBOARDING_KEY = 'onboarding_complete';

export type RootStackParamList = {
  Connect: undefined;
  Session: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const showSession = useConnectionStore(selectShowSession);
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
              component={SessionScreen}
              options={{ title: 'Session' }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ title: 'Settings' }}
            />
          </>
        )}
      </Stack.Navigator>
      {isLocked && <LockScreen onUnlock={unlock} />}
    </NavigationContainer>
  );
}
