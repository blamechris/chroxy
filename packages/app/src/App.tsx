import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ConnectScreen } from './screens/ConnectScreen';
import { SessionScreen } from './screens/SessionScreen';
import { useConnectionStore } from './store/connection';

export type RootStackParamList = {
  Connect: undefined;
  Session: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const isConnected = useConnectionStore((s) => s.isConnected);
  const isReconnecting = useConnectionStore((s) => s.isReconnecting);
  // Stay on SessionScreen during reconnection attempts to show reconnect state
  const showSession = isConnected || isReconnecting;

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
          <Stack.Screen
            name="Session"
            component={SessionScreen}
            options={{ title: 'Session' }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
