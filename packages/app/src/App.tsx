import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ConnectScreen } from './screens/ConnectScreen';
import { SessionScreen } from './screens/SessionScreen';
import { useConnectionStore, selectShowSession } from './store/connection';

export type RootStackParamList = {
  Connect: undefined;
  Session: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const showSession = useConnectionStore(selectShowSession);

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
