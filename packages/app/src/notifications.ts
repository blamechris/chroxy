import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useConnectionStore } from './store/connection';
import { loadConnection } from './store/connection';

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
 * Register iOS notification category with Approve/Deny action buttons.
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
    // Gracefully degrade if categories not supported (e.g. Android, Expo Go)
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
    console.log('[push] Expo push token:', tokenData.data);
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
  // Try Zustand store first, fall back to SecureStore for cold start
  let wsUrl = useConnectionStore.getState().wsUrl;
  let apiToken = useConnectionStore.getState().apiToken;

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
  const delays = [0, 2_000, 4_000]; // immediate, then 2s, then 4s

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

      // 4xx errors (except 408/429) are not retryable
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

/**
 * Set up a listener for notification action responses (Approve/Deny buttons).
 * Returns the subscription — caller should call .remove() on cleanup.
 */
export function setupNotificationResponseListener(): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(async (response) => {
    const actionId = response.actionIdentifier;

    // Ignore default tap (just opens app) — only handle explicit action buttons
    if (actionId === Notifications.DEFAULT_ACTION_IDENTIFIER) return;

    const data = response.notification.request.content.data as
      | { category?: string; requestId?: string }
      | undefined;

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
      useConnectionStore.getState().markPromptAnswered(requestId, decision);
    } else {
      console.warn(`[push] Permission ${requestId} could not be delivered — UI not updated`);
    }
  });
}
