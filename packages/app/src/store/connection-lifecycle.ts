/**
 * Connection lifecycle store — extracted connection state.
 *
 * Holds connection phase, server info, connection quality, and saved
 * connection state. Receives dual-writes from the main ConnectionState
 * store for backward compatibility.
 */
import { create } from 'zustand';
import type { ConnectionPhase, SavedConnection } from './types';

/**
 * Finite state machine: maps each phase to the set of phases it may
 * legally transition into.  Any transition not listed here is invalid and
 * is REJECTED — `transitionPhase` warns and leaves `connectionPhase`
 * unchanged (#6286). `server_down` is the one terminal phase; it is left
 * only via its two declared legal edges — `connecting` (a user-initiated
 * retry, see `retryConnection`) or `disconnected` (an explicit disconnect).
 * `transitionPhase(to, { force: true })` is a deliberately-flagged escape
 * hatch that applies an otherwise-illegal transition — but ONLY for the
 * edges enumerated in `FORCEABLE_TRANSITIONS` (#6296). `force` is NOT a
 * blanket override: an illegal transition that is not whitelisted is
 * rejected even with `force`, so a future caller cannot accidentally
 * bypass terminal-phase stickiness (the #5980 clobber protection #6286
 * added). It is currently used only by `retryConnection` and must stay
 * confined to audited call sites.
 *
 * Notes on non-obvious entries:
 *  - connecting → server_restarting: health check returns "restarting" during the
 *    initial connect attempt before a WebSocket is ever opened.
 *  - connecting → reconnecting: the retry loop inside connect() escalates to
 *    "reconnecting" after the first failed attempt.
 *  - reconnecting → reconnecting / connecting → connecting: self-transitions are
 *    allowed so that recursive retry calls do not generate spurious warnings.
 */
const VALID_TRANSITIONS: Record<ConnectionPhase, ConnectionPhase[]> = {
  // #6286 — `connecting` is a fresh dial; `reconnecting` is an app-resume /
  // network-change re-dial of a previously-connected URL (connect() computes
  // 'reconnecting' when `isReconnect`/`lastConnectedUrl` survives a non-user
  // drop). Both MUST be legal exits from `disconnected`, or the resume re-dial
  // is rejected and a live authenticated socket wedges on the ConnectScreen
  // (disconnected → reconnecting → connected never completes).
  disconnected: ['connecting', 'reconnecting'],
  // #6023 — a first-attempt probe can read the supervisor terminal-down signal
  // and latch 'server_down' straight from 'connecting' (no reconnect ladder yet).
  connecting: ['connecting', 'connected', 'disconnected', 'reconnecting', 'server_restarting', 'server_down'],
  connected: ['disconnected', 'reconnecting', 'server_restarting'],
  // #5698 — the reconnect ladder gives up → terminal 'server_down'.
  reconnecting: ['reconnecting', 'connected', 'disconnected', 'server_restarting', 'server_down'],
  // #6023 — a restarting host whose next probe reads terminal-down goes
  // straight to 'server_down' (supervisor gave up mid-restart).
  server_restarting: ['connecting', 'reconnecting', 'disconnected', 'server_down'],
  // #5698 — terminal; only a user-initiated reconnect (→ connecting) or an
  // explicit disconnect leaves it.
  server_down: ['connecting', 'disconnected'],
};

/**
 * #6296 — the allow-list of otherwise-illegal transitions that `{ force: true }`
 * is permitted to apply. `force` only escapes the FSM for an edge listed here;
 * any other illegal transition is rejected even when forced, so a future caller
 * cannot weaponise `force` to clobber a terminal phase (the #5980 regression
 * #6286 fixed).
 *
 * Today this documents exactly one legitimate intent: leaving the terminal
 * `server_down` phase on a user-initiated retry (`retryConnection`). That edge
 * also happens to be legal in `VALID_TRANSITIONS`, so the current call site
 * never actually needs the escape hatch — the whitelist records the intent so
 * the edge stays force-safe even if its `VALID_TRANSITIONS` membership ever
 * changes. Encoded as `"from→to"` strings for cheap membership checks.
 */
const FORCEABLE_TRANSITIONS: ReadonlySet<string> = new Set<string>([
  'server_down→connecting',
]);

interface ServerInfo {
  serverMode?: 'cli' | null;
  serverVersion?: string | null;
  latestVersion?: string | null;
  serverCommit?: string | null;
  serverProtocolVersion?: number | null;
  serverResultTimeoutMs?: number | null;
  // #4497 / #4477 / #4766 — server-advertised stream-stall window in ms.
  // See ConnectionLifecycleState.streamStallTimeoutMs for the rationale.
  streamStallTimeoutMs?: number | null;
  sessionCwd?: string | null;
  isEncrypted?: boolean;
  // #4560 — server-advertised capability map from auth_ok. See the
  // doc comment on ConnectionLifecycleState.serverCapabilities below.
  serverCapabilities?: Record<string, boolean>;
}

interface ConnectionLifecycleState {
  // Connection phase
  connectionPhase: ConnectionPhase;

  // Connection details
  wsUrl: string | null;
  apiToken: string | null;

  // Server context (from auth_ok)
  serverMode: 'cli' | null;
  sessionCwd: string | null;
  serverVersion: string | null;
  latestVersion: string | null;
  serverCommit: string | null;
  serverProtocolVersion: number | null;
  /**
   * #3760 — effective server inactivity timeout in ms, as advertised in
   * auth_ok. Used by ActivityIndicator to render the "approaching timeout"
   * warning against the real configured value. Null when connecting to an
   * older server that doesn't broadcast the field.
   */
  serverResultTimeoutMs: number | null;
  /**
   * #4497 / #4477 / #4766 — effective server stream-stall window in ms, as
   * advertised in auth_ok. Threaded to StreamStallChip so the headline can
   * humanise to "No response for 5 minutes — retry?". Null when the server
   * omits the field or advertises the protocol's `0` "disabled" sentinel,
   * in which case the chip falls back to the generic phrase.
   *
   * Was silently dropped on mobile until #4766 unified the auth_ok parser
   * — the dashboard already plumbed it through `streamStallTimeoutMs` on
   * its connection store.
   */
  streamStallTimeoutMs: number | null;
  isEncrypted: boolean;

  /**
   * #4560 — server-advertised capability map from auth_ok. Keyed by feature
   * name (e.g. `notificationPrefs`), value=boolean. Lets the app gate UI
   * affordances on the server actually supporting the matching WS message —
   * pre-#4541 servers omit `notificationPrefs` so the Notifications section
   * in SettingsScreen renders an explicit "not supported" message instead
   * of sitting on "Loading preferences…" forever. Empty `{}` on fresh
   * connect, repopulated on every auth_ok; cleared on disconnect so a
   * reconnect against an older server can't have stale flags left set.
   */
  serverCapabilities: Record<string, boolean>;

  // Connection quality
  latencyMs: number | null;
  connectionQuality: 'good' | 'fair' | 'poor' | null;
  connectionError: string | null;
  connectionRetryCount: number;

  /**
   * #5518 — which transport the current connection is using: `'lan'` for a
   * direct `ws://` LAN socket, `'tunnel'` for the `wss://` Cloudflare path,
   * `null` when not connected. Surfaced on the connection-quality badge so the
   * user can see when the faster local path is active. Set by the endpoint
   * selector at connect time; cleared on disconnect.
   */
  activePath: 'lan' | 'tunnel' | null;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;
  userDisconnected: boolean;

  // Actions
  setConnectionPhase: (phase: ConnectionPhase) => void;
  transitionPhase: (to: ConnectionPhase, opts?: { force?: boolean }) => void;
  setConnectionDetails: (url: string, token: string) => void;
  setServerInfo: (info: ServerInfo) => void;
  setConnectionQuality: (latencyMs: number | null, quality: 'good' | 'fair' | 'poor' | null) => void;
  setConnectionError: (error: string | null, retryCount: number) => void;
  setActivePath: (path: 'lan' | 'tunnel' | null) => void;
  setSavedConnection: (connection: SavedConnection | null) => void;
  setUserDisconnected: (disconnected: boolean) => void;
  reset: () => void;
}

const initialState = {
  connectionPhase: 'disconnected' as ConnectionPhase,
  wsUrl: null as string | null,
  apiToken: null as string | null,
  serverMode: null as 'cli' | null,
  sessionCwd: null as string | null,
  serverVersion: null as string | null,
  latestVersion: null as string | null,
  serverCommit: null as string | null,
  serverProtocolVersion: null as number | null,
  serverResultTimeoutMs: null as number | null,
  streamStallTimeoutMs: null as number | null,
  isEncrypted: false,
  // #4560 — empty map until auth_ok lands; cleared on every disconnect via
  // reset() so a reconnect against a different (or older) server can't have
  // its UI gates left enabled by stale state. Empty = fail-closed.
  serverCapabilities: {} as Record<string, boolean>,
  latencyMs: null as number | null,
  connectionQuality: null as 'good' | 'fair' | 'poor' | null,
  connectionError: null as string | null,
  connectionRetryCount: 0,
  activePath: null as 'lan' | 'tunnel' | null,
  savedConnection: null as SavedConnection | null,
  userDisconnected: false,
};

export const useConnectionLifecycleStore = create<ConnectionLifecycleState>((set, get) => ({
  ...initialState,

  transitionPhase: (to, opts) => {
    const from = get().connectionPhase;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      // #6286 — ENFORCE: an illegal transition is rejected, not applied.
      // Previously the FSM warned then mutated unconditionally ("fail open"),
      // so the paired error→close events of one transport drop could clobber
      // the terminal `server_down` phase back to the reconnect spinner (#5980).
      // #6296 — `{ force: true }` is NOT a blanket override: it only applies an
      // illegal transition that is whitelisted in FORCEABLE_TRANSITIONS. The
      // ONE legitimate forced exit (user-initiated retry leaving server_down →
      // connecting) is whitelisted; every other illegal transition stays put
      // even when forced, so `force` can never be used to bypass terminal
      // stickiness.
      if (opts?.force && FORCEABLE_TRANSITIONS.has(`${from}→${to}`)) {
        // Intentional, whitelisted escape — informational, not a violation.
        console.log(`[ConnectionFSM] Forced transition: ${from} → ${to}`);
      } else {
        console.warn(
          `[ConnectionFSM] Illegal transition: ${from} → ${to}. ` +
            `Allowed from ${from}: [${allowed.join(', ')}]` +
            `${opts?.force ? ' (force is not whitelisted for this edge)' : ''} — rejected`
        );
        return;
      }
    }
    set({ connectionPhase: to });
  },

  setConnectionPhase: (phase) => get().transitionPhase(phase),

  setConnectionDetails: (url, token) => set({ wsUrl: url, apiToken: token }),

  setServerInfo: (info) => set(info),

  setConnectionQuality: (latencyMs, quality) => set({ latencyMs, connectionQuality: quality }),

  setConnectionError: (error, retryCount) => set({ connectionError: error, connectionRetryCount: retryCount }),

  setActivePath: (path) => set({ activePath: path }),

  setSavedConnection: (connection) => set({ savedConnection: connection }),

  setUserDisconnected: (disconnected) => set({ userDisconnected: disconnected }),

  reset: () => set((state) => ({
    ...initialState,
    // Preserve saved connection and user disconnect flag across resets
    // (both survive disconnect/reconnect cycles — cleared explicitly when needed)
    savedConnection: state.savedConnection,
    userDisconnected: state.userDisconnected,
  })),
}));
