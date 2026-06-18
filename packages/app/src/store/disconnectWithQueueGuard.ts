/**
 * disconnectWithQueueGuard — shared helper for manual-disconnect entry points.
 *
 * Several UI affordances let the user give up the connection (header Disconnect
 * button, ConnectScreen auto-connect Cancel, reconnect-banner Disconnect).  All
 * of them eventually call disconnect(), which also calls clearMessageQueue() —
 * so any typed-but-unsent messages are silently discarded.
 *
 * This helper centralises the "warn first if there are queued messages" gate so
 * every give-up path behaves identically (#6081 parity with #5699/#6080).
 *
 * Usage (outside React components — reads store imperatively):
 *
 *   import { disconnectWithQueueGuard } from '../store/disconnectWithQueueGuard';
 *   // ...
 *   onPress={disconnectWithQueueGuard}
 *
 * Usage inside a React component that already has a `disconnect` ref:
 *
 *   const disconnect = useConnectionStore((s) => s.disconnect);
 *   // Still call the module-level helper — it reads the same store.
 *   onPress={disconnectWithQueueGuard}
 */
import { Alert } from 'react-native';
import { useConnectionStore } from './connection';

/**
 * Call disconnect() — but when the outgoing queue is non-empty, show a
 * confirmation Alert first so the user can choose to keep waiting instead
 * of silently discarding unsent messages.
 *
 * This is a plain function (not a hook) so it can be used as an `onPress`
 * handler in both component callbacks and static navigator option factories
 * (e.g. `options={{ headerRight: () => … }}`).
 */
export function disconnectWithQueueGuard(): void {
  const { disconnect, queuedMessageCount } = useConnectionStore.getState();
  if (queuedMessageCount > 0) {
    const n = queuedMessageCount;
    Alert.alert(
      'Discard unsent messages?',
      `You have ${n} unsent message${n === 1 ? '' : 's'} waiting to send. Disconnecting will discard ${n === 1 ? 'it' : 'them'}.`,
      [
        { text: 'Keep waiting', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: disconnect },
      ],
    );
    return;
  }
  disconnect();
}
