import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Alert, Platform } from 'react-native';

/**
 * Configure notification behavior — show alerts and play sounds
 * even when the app is in the foreground.
 */
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch {
  // Expo Go SDK 53+ removed push notification support — gracefully degrade
}

/**
 * Register notification category with Approve/Deny action buttons.
 * Works on both iOS and Android (expo-notifications supports categories on both).
 * Idempotent — safe to call multiple times.
 */
try {
  void Notifications.setNotificationCategoryAsync('permission', [
    {
      identifier: 'approve',
      buttonTitle: 'Approve',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'deny',
      buttonTitle: 'Deny',
      options: { isDestructive: true, opensAppToForeground: true },
    },
  ]).catch(() => {
    // Gracefully degrade if categories not supported (e.g. Expo Go)
  });
} catch {
  // Gracefully degrade if setNotificationCategoryAsync not available
}

/**
 * Register for push notifications and return the Expo push token.
 * Returns null if registration fails (e.g., simulator, denied permission).
 *
 * Platform notes:
 * - Android Expo Go: works (Firebase-backed)
 * - iOS Expo Go: limited push support — full support requires dev client build
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Push notifications only work on physical devices
  if (!Device.isDevice) {
    console.log('[push] Skipping push registration — not a physical device');
    return null;
  }

  try {
    // Check existing permission status
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    // Request permission if not already granted
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[push] Push notification permission denied');
      return null;
    }

    // Android requires a notification channel
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Chroxy',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    // Gate the raw token behind __DEV__ — it's useful while developing but is a
    // secret that must not land in production logs (#5646).
    if (__DEV__) {
      console.log('[push] Expo push token:', tokenData.data);
    }
    return tokenData.data;
  } catch (err) {
    // Expo Go SDK 53+ removed push notification support — gracefully degrade
    console.log('[push] Push registration unavailable:', err);
    return null;
  }
}

/**
 * Send a permission response via HTTP POST (fallback when WS is disconnected).
 * Uses the Cloudflare tunnel HTTPS URL derived from the stored WS URL.
 */
async function sendPermissionResponseHttp(
  requestId: string,
  decision: string,
): Promise<boolean> {
  // Lazy import to break require cycle: connection → message-handler → notifications → connection
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConnection }: {
    loadConnection: typeof import('./store/connection')['loadConnection'];
  } = require('./store/connection');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useConnectionLifecycleStore }: {
    useConnectionLifecycleStore: typeof import('./store/connection-lifecycle')['useConnectionLifecycleStore'];
  } = require('./store/connection-lifecycle');

  // Try Zustand store first, fall back to SecureStore for cold start
  let wsUrl = useConnectionLifecycleStore.getState().wsUrl;
  let apiToken = useConnectionLifecycleStore.getState().apiToken;

  if (!wsUrl || !apiToken) {
    const saved = await loadConnection();
    if (saved) {
      wsUrl = saved.url;
      apiToken = saved.token;
    }
  }

  if (!wsUrl || !apiToken) {
    console.warn('[push] No connection info available for HTTP fallback');
    return false;
  }

  // Convert wss://host → https://host
  const httpsUrl = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  const url = `${httpsUrl}/permission-response`;
  const body = JSON.stringify({ requestId, decision });
  const delays = [0, 2_000, 4_000]; // 3 total attempts: immediate, 2s backoff, 4s backoff

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) {
      console.log(`[push] Retry ${attempt}/${delays.length - 1} after ${delays[attempt]}ms...`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body,
        signal: controller.signal,
      });

      if (res.ok) {
        console.log(`[push] Permission ${requestId} sent via HTTP: ${decision}`);
        return true;
      }

      // 410 = permission expired (auto-denied before user responded).
      // Surface a clear alert so the user knows their tap was too late.
      if (res.status === 410) {
        console.warn(`[push] Permission ${requestId} expired (server returned 410)`);
        const { Alert } = require('react-native');
        Alert.alert(
          'Permission Expired',
          'This permission request has already expired. Open the app to see the current session state.',
        );
        return false;
      }

      // Other 4xx errors (except 408/429) are not retryable
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.warn(`[push] HTTP permission response rejected: ${res.status}`);
        return false;
      }

      console.warn(`[push] HTTP permission response failed: ${res.status} (attempt ${attempt + 1}/${delays.length})`);
    } catch (err) {
      console.warn(`[push] HTTP permission response error (attempt ${attempt + 1}/${delays.length}):`, err);
    } finally {
      clearTimeout(timeout);
    }
  }

  console.warn(`[push] HTTP permission response failed after ${delays.length} attempts`);
  return false;
}

/** Shape of the `data` payload a Chroxy push notification's response can carry. */
type NotificationResponseData = {
  category?: string;
  requestId?: string;
  sessionId?: string;
  tool?: string;
};

// #6792: getLastNotificationResponse() (cold start — see
// handleColdStartNotificationResponse below) and the live
// addNotificationResponseReceivedListener can both deliver the SAME
// response — dedupe by the notification's own identifier so an
// action-button tap (approve/deny) is never sent to the server twice.
let _lastHandledNotificationId: string | null = null;

/**
 * Handle a single notification response — shared by the live listener
 * (setupNotificationResponseListener) and the cold-start replay
 * (handleColdStartNotificationResponse). Two responsibilities:
 *
 *  1. Route to the session that triggered the notification (#6792). Every
 *     push category that has a triggering session carries a `sessionId` in
 *     its data (permission, activity_update, activity_waiting,
 *     activity_error, inactivity_warning — see push.js / ws-permissions.js /
 *     event-normalizer.js / push-notification-handler.js). Reuses the same
 *     `switchSession` primitive as the in-app SessionNotificationBanner and
 *     sendPermissionResponse's auto-switch, so a tap — whether the
 *     notification body (default action) or an action button — always
 *     lands on the right session. `switchSession` no-ops if the session id
 *     isn't in the client's session list yet (e.g. reconnect still in
 *     flight); it optimistically sets `activeSessionId` and the UI degrades
 *     gracefully (SessionScreen reads via `sessions.find(...)`, which is
 *     `undefined`-safe) rather than crashing.
 *  2. For the 'permission' category's Approve/Deny action buttons only,
 *     also deliver the decision over WS/HTTP — unchanged from the
 *     pre-#6792 behavior. The default tap is pure navigation, no WS send.
 */
async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const notificationId = response.notification?.request?.identifier;
  if (notificationId && notificationId === _lastHandledNotificationId) return;
  if (notificationId) _lastHandledNotificationId = notificationId;

  // Lazy import to break require cycle: connection → message-handler → notifications → connection
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useConnectionStore }: {
    useConnectionStore: typeof import('./store/connection')['useConnectionStore'];
  } = require('./store/connection');

  const actionId = response.actionIdentifier;
  const data = response.notification.request.content.data as
    | NotificationResponseData
    | undefined;

  if (data?.sessionId) {
    useConnectionStore.getState().switchSession(data.sessionId);
  }

  // Default tap (notification body, not an action button) is pure
  // navigation — the switchSession call above already handled it.
  if (actionId === Notifications.DEFAULT_ACTION_IDENTIFIER) return;

  if (data?.category !== 'permission' || !data.requestId) return;

  const { requestId } = data;

  // Explicitly handle only known action identifiers
  let decision: 'allow' | 'deny';
  if (actionId === 'approve') {
    decision = 'allow';
  } else if (actionId === 'deny') {
    decision = 'deny';
  } else {
    // Ignore unexpected action identifiers
    return;
  }

  console.log(`[push] Notification action: ${actionId} → ${decision} for ${requestId}`);

  // Try WebSocket first if connected
  let delivered = false;
  const { socket } = useConnectionStore.getState();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({ type: 'permission_response', requestId, decision }),
    );
    console.log(`[push] Permission ${requestId} sent via WS: ${decision}`);
    delivered = true;
  } else {
    // Fall back to HTTP POST via Cloudflare tunnel
    delivered = await sendPermissionResponseHttp(requestId, decision);
  }

  // Only update chat UI if the response was actually delivered
  if (delivered) {
    useConnectionStore.getState().markPromptAnsweredByRequestId(requestId, decision);
  } else {
    console.warn(`[push] Permission ${requestId} could not be delivered — UI not updated`);
    Alert.alert(
      'Permission Response Failed',
      'Could not deliver your response. Open the app to respond manually.',
      [
        { text: 'OK', style: 'cancel' },
        {
          text: 'Retry',
          onPress: () => {
            sendPermissionResponseHttp(requestId, decision).then((ok) => {
              if (ok) {
                useConnectionStore.getState().markPromptAnsweredByRequestId(requestId, decision);
              } else {
                Alert.alert('Still Failed', 'Open the app to respond manually.');
              }
            }).catch(() => {
              // Already logged inside sendPermissionResponseHttp
              Alert.alert('Still Failed', 'Open the app to respond manually.');
            });
          },
        },
      ],
    );
  }
}

/**
 * Set up a listener for notification responses — both the default tap
 * (notification body) and the explicit Approve/Deny action buttons.
 * Returns the subscription — caller should call .remove() on cleanup.
 */
export function setupNotificationResponseListener(): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
}

/**
 * Replay the notification response that already launched the app (cold
 * start) — tapping a notification while Chroxy wasn't running at all.
 * `addNotificationResponseReceivedListener` only delivers responses
 * received AFTER a JS listener is attached; the one that woke the process
 * has to be read back explicitly (#6792). Call once on mount, alongside
 * `setupNotificationResponseListener` — `handleNotificationResponse`'s
 * dedupe guard makes the call order and any native replay of the same
 * response safe either way.
 */
export async function handleColdStartNotificationResponse(): Promise<void> {
  let response: Notifications.NotificationResponse | null = null;
  try {
    response = Notifications.getLastNotificationResponse();
  } catch (err) {
    // Unavailable on this platform/SDK build (e.g. Expo Go) — nothing to replay.
    console.log('[push] getLastNotificationResponse unavailable:', err);
    return;
  }
  if (!response) return;
  await handleNotificationResponse(response);
}
