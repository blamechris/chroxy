import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ConnectScreen } from './screens/ConnectScreen';
import { SessionScreen } from './screens/SessionScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useConnectionStore, selectShowSession } from './store/connection';
import { setupNotificationResponseListener } from './notifications';

export type RootStackParamList = {
  Connect: undefined;
  Session: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const showSession = useConnectionStore(selectShowSession);

  useEffect(() => {
    const sub = setupNotificationResponseListener();
    return () => sub.remove();
  }, []);

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
    </NavigationContainer>
  );
}
