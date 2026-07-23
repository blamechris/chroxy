import type { ComponentProps } from 'react'
import { ChatSettingsDropdown } from './ChatSettingsDropdown'
import { NotificationsWidget } from './NotificationsWidget'
import { HeaderOverflowMenu, type HeaderOverflowItem } from './HeaderOverflowMenu'
import { StatusBar } from './StatusBar'
import { DevPreviewChip } from './DevPreviewChip'
import { formatShortcutKeys } from '../utils/platform'
import type { ChatActivityState } from '@chroxy/store-core'
import type { DevPreview } from '../store/types'

declare const __APP_VERSION__: string

/**
 * AppHeader — the two-row dashboard header (#5200, #5560).
 *
 * Pure presentational grouping extracted verbatim from App's JSX: row 1
 * (logo + version + status dot | model/permission/thinking dropdown | bell +
 * overflow menu) and row 2 (the cost/token StatusBar). A leaf header sibling of
 * the main content — extracting it does not touch the terminal / chat subtree.
 *
 * App owns all the state and the derived `context` string (App's `formatContext`
 * stays in App so the header, footer, and status-tooltip share one formatter).
 */
export interface AppHeaderProps {
  serverVersion: string | null
  connectionPhase: string
  /**
   * Chat redesign #6392: the canonical chat-activity state. When the dot is
   * genuinely connected, an active state (thinking/busy/waiting) makes it
   * breathe — the chrome shows life without overriding the connection colour.
   */
  chatActivityState?: ChatActivityState
  serverPhase: string | null
  isConnected: boolean
  tunnelReady: boolean
  // ChatSettingsDropdown
  showModelPicker: boolean
  availableModels: ComponentProps<typeof ChatSettingsDropdown>['availableModels']
  activeModel: ComponentProps<typeof ChatSettingsDropdown>['activeModel']
  defaultModelId: ComponentProps<typeof ChatSettingsDropdown>['defaultModelId']
  onModelChange: ComponentProps<typeof ChatSettingsDropdown>['onModelChange']
  readOnlyModel: ComponentProps<typeof ChatSettingsDropdown>['readOnlyModel']
  availablePermissionModes: ComponentProps<typeof ChatSettingsDropdown>['availablePermissionModes']
  permissionMode: ComponentProps<typeof ChatSettingsDropdown>['permissionMode']
  onPermissionModeChange: ComponentProps<typeof ChatSettingsDropdown>['onPermissionModeChange']
  showPermissionMode: boolean
  // #6901: active codex session's resolved sandbox mode (read-only badge).
  codexSandbox: ComponentProps<typeof ChatSettingsDropdown>['codexSandbox']
  showThinkingLevel: boolean
  thinkingLevel: ComponentProps<typeof ChatSettingsDropdown>['thinkingLevel']
  onThinkingLevelChange: (level: string) => void
  // NotificationsWidget
  sessionNotifications: ComponentProps<typeof NotificationsWidget>['notifications']
  onSwitchSession: ComponentProps<typeof NotificationsWidget>['onSwitchSession']
  onMarkNotificationRead: ComponentProps<typeof NotificationsWidget>['onMarkRead']
  onMarkAllNotificationsRead: ComponentProps<typeof NotificationsWidget>['onMarkAllRead']
  onDismissNotification: ComponentProps<typeof NotificationsWidget>['onDismiss']
  // Overflow menu
  onNewSession: () => void
  // #5986 — create an embedded user-shell. Undefined when the server doesn't
  // advertise the `userShell` capability (flag off, or this client isn't the
  // primary token), which filters the "New Shell" row out of the menu entirely.
  onNewShell?: () => void
  // #6006 — operator panic button: revoke the API token now. Undefined unless
  // the server advertises the `tokenRevoke` capability (auth on AND this client
  // holds the primary token), which filters the "Revoke token" row out entirely.
  onRevokeToken?: () => void
  onToggleSkillsPanel: () => void
  // Show the device-pairing QR (same action as the footer "QR" button + the
  // Cmd+Shift+L shortcut). Undefined when disconnected, which filters the
  // "Pair a device" row out of the overflow menu entirely.
  onShowQr?: () => void
  showCopyTranscript: boolean
  transcriptCopied: boolean
  onCopyTranscript: () => void
  onOpenSettings: () => void
  // StatusBar (row 2)
  cost?: number
  context?: string
  contextPercent: number | null
  // #6769: window occupancy in tokens from the provider's snapshot — drives
  // the header meter's `used / total` label. Absent = no occupancy signal
  // (the meter hides; honest dash state).
  contextTokens?: number
  // #6769: true when the snapshot is byok's final-round estimate rather than
  // the SDK's authoritative context-usage API — the tooltip says so.
  contextEstimated?: boolean
  inputTokens?: number
  outputTokens?: number
  contextWindow?: number
  isBusy: boolean
  agentCount: number
  provider?: string
  modelLabel?: string
  costBadgeMode: ComponentProps<typeof StatusBar>['costBadgeMode']
  // Dev-server preview tunnels (#6790) — active session's live devPreviews
  // (server-detected localhost dev server, auto-tunneled). Empty array
  // renders nothing; DevPreviewChip self-gates.
  devPreviews: DevPreview[]
  onCloseDevPreview: (port: number) => void
}

export function AppHeader(props: AppHeaderProps) {
  return (
    <header id="header">
      {/* #5200: two-row header — row 1 (.header-main) is the 3-column main
          bar (logo/status | model+permission selects | bell + ⋯); the
          cost/token cluster moved to row 2 (.header-meta) so the main bar
          is never crowded and the permission selector isn't pushed out. */}
      <div className="header-main">
      <div className="header-left">
        <span className="logo">Chroxy</span>
        {/* #4630 — version + status-dot were bare spans with no
            discoverable label, leaving Tauri/WKWebView and SR users with
            nothing on hover. Pair `title` (browser hover tooltip) with
            `aria-label` (screen-reader announcement) so both surfaces
            get a label.
            #4873 — the status dot intentionally does NOT carry
            `role="status"`. role=status implies aria-live=polite,
            which made reconnect-storm churn (connecting →
            reconnecting → connected → reconnecting…) verbally hammer
            SR users with every intermediate transition. aria-label
            alone keeps the dot discoverable on focus/hover, and the
            page-level debounced ConnectionAnnouncer (mounted above)
            announces only the settled phase. */}
        {(() => {
          const versionLabel = `Chroxy server v${props.serverVersion ?? __APP_VERSION__}`
          return (
            <span
              className="version-badge"
              title={versionLabel}
              aria-label={versionLabel}
            >
              v{props.serverVersion ?? __APP_VERSION__}
            </span>
          )
        })()}
        {(() => {
          // #5182 (D1) — the top-bar dot reflects CONNECTED state (the
          // app's WS/tunnel connection), NOT a daemon "running" state.
          // It is driven purely by `connectionPhase` (the connected
          // signal) plus the tunnel-warming gate below, mirroring the
          // FooterBar's "Connected" dot exactly. The separate "Running"
          // indicator lives on the left projects/explorer header (#5192)
          // and is intentionally NOT wired here. The dot only turns
          // green (`.connected`) when `connectionPhase === 'connected'`
          // AND the tunnel is ready — i.e. genuinely connected end-to-end.
          const warming = props.serverPhase === 'tunnel_warming' || props.serverPhase === 'tunnel_verifying' || (props.isConnected && !props.tunnelReady && props.serverPhase == null)
          const phase = warming ? 'connecting' : props.connectionPhase
          const STATUS_LABELS: Record<string, string> = {
            connected: 'Connected to Chroxy server',
            connecting: warming ? 'Tunnel warming up…' : 'Connecting to Chroxy server…',
            reconnecting: 'Reconnecting to Chroxy server…',
            server_restarting: 'Server restarting…',
            server_down: 'Chroxy server appears to be down', // #5698 — terminal; don't leak the raw enum
            disconnected: 'Disconnected from Chroxy server',
          }
          const label = STATUS_LABELS[phase] ?? `Connection status: ${phase}`
          return (
            <span
              className={`status-dot ${phase}`}
              data-activity={phase === 'connected' ? props.chatActivityState : undefined}
              title={label}
              aria-label={label}
            />
          )
        })()}
      </div>
      <div className="header-center">
        <ChatSettingsDropdown
          availableModels={props.showModelPicker ? props.availableModels : []}
          activeModel={props.activeModel}
          defaultModelId={props.defaultModelId}
          onModelChange={props.onModelChange}
          readOnlyModel={props.readOnlyModel}
          providerLabel={props.provider}
          availablePermissionModes={props.availablePermissionModes}
          permissionMode={props.permissionMode}
          onPermissionModeChange={props.onPermissionModeChange}
          showPermissionMode={props.showPermissionMode}
          codexSandbox={props.codexSandbox}
          showThinkingLevel={props.showThinkingLevel}
          thinkingLevel={props.thinkingLevel}
          onThinkingLevelChange={level => props.onThinkingLevelChange(level as 'default' | 'high' | 'max')}
        />
      </div>
      <div className="header-right">
        {/* #6790 — active dev-server preview tunnels for this session. The
            server auto-detects a localhost dev server and opens a Cloudflare
            tunnel; this chip is the only dashboard surface that makes the
            resulting URL discoverable (previously only visible by scrolling
            raw tool output). Self-gates on an empty devPreviews array. */}
        <DevPreviewChip previews={props.devPreviews} onClose={props.onCloseDevPreview} />
        {/* #4890 — Slack-style intervention notifications widget. Bell
            with unread badge → dropdown listing every intervention alert
            (read + unread) so the operator gets a durable "do I have
            outstanding interventions to deal with?" signal. The earlier
            transient banners (NotificationBanners — still rendered above
            the main content for unread alerts) keep their role as
            foreground popups; the widget owns the durable history. */}
        <NotificationsWidget
          notifications={props.sessionNotifications}
          onSwitchSession={props.onSwitchSession}
          onMarkRead={props.onMarkNotificationRead}
          onMarkAllRead={props.onMarkAllNotificationsRead}
          onDismiss={props.onDismissNotification}
        />
        {/* #4974: Skills / Copy / Settings collapsed behind a single
            "⋯" overflow trigger. Previously these three icon buttons
            lived inline in header-right alongside `+ New Session` and
            the StatusBar, which at ≤1400px widths overlapped the
            model selector chevron in header-center. Each item keeps
            its existing handler, aria-label, and data-testid via the
            HeaderOverflowMenu's `items[]` (testids still discoverable
            from inside the open menu so the existing test coverage
            for the underlying actions continues to apply).
            The filter pattern (truthy `onClick`) mirrors the
            SessionContextMenu capability gate — Copy is only present
            when the chat view is active and has at least one
            message, so the dropdown grows/shrinks naturally without
            dead rows. */}
        {(() => {
          const overflowItems: HeaderOverflowItem[] = [
            // #5062 — New Session moved INTO the overflow menu (was a
            // standalone `chrome-new-session-btn` in the header-right
            // zone). The Cmd+N shortcut still fires `handleNewSession`
            // via the global keymap and the macOS menu-bar "File >
            // New Session" item — this row is just the discoverable
            // chrome entry point now. Listed first so a user scanning
            // the menu top-to-bottom finds the most-used action
            // immediately.
            {
              id: 'new-session',
              label: 'New Session',
              icon: '+',
              title: `New session (${formatShortcutKeys('Cmd+N')})`,
              onClick: props.onNewSession,
            },
            // #5986 — embedded user-shell. `onNewShell` is undefined unless the
            // server advertises the userShell capability, so the menu filters
            // this row out (falsy onClick) on hosts where it isn't available.
            {
              id: 'new-shell',
              label: 'New Shell',
              icon: '\u{1F5A5}',
              title: 'Open an embedded terminal shell',
              onClick: props.onNewShell,
            },
            {
              id: 'skills',
              label: 'Skills',
              icon: '\u{1F9E9}',
              title: 'Skills',
              onClick: props.onToggleSkillsPanel,
            },
            // Pair a device — surfaces the linking QR in the discoverable "..."
            // menu (parity with the footer "QR" button). `onShowQr` is undefined
            // when disconnected, so the menu filters this row out (no server to
            // pair against). Mirrors the Cmd+Shift+L shortcut.
            {
              id: 'pair-device',
              label: 'Pair a device',
              icon: '\u{1F4F1}',
              title: `Pair a device — scan the QR with the Chroxy mobile app (${formatShortcutKeys('Cmd+Shift+L')})`,
              onClick: props.onShowQr,
            },
            props.showCopyTranscript
              ? {
                  id: 'copy-transcript',
                  label: props.transcriptCopied ? 'Transcript copied' : 'Copy transcript',
                  icon: props.transcriptCopied ? '✓' : '⎘',
                  title: props.transcriptCopied ? 'Copied!' : `Copy transcript (${formatShortcutKeys('Cmd+Shift+T')})`,
                  onClick: props.onCopyTranscript,
                }
              : { id: 'copy-transcript', label: 'Copy transcript' },
            {
              id: 'settings',
              label: 'Settings',
              icon: '⚙',
              title: `Settings (${formatShortcutKeys('Cmd+,')})`,
              // #5544 — redirect to the Control Room Settings tab (the
              // single home) instead of opening the legacy slide-out modal.
              onClick: props.onOpenSettings,
            },
            // #6006 — operator panic button. `onRevokeToken` is undefined unless
            // the server advertises the `tokenRevoke` capability (auth on + this
            // client is primary), so the menu filters this row out otherwise.
            // Listed last (destructive); App wraps it in a confirm dialog.
            {
              id: 'revoke-token',
              label: 'Revoke token',
              icon: '\u{1F6D1}',
              title: 'Immediately revoke the API token (severs shells, forces re-auth)',
              onClick: props.onRevokeToken,
            },
          ]
          return <HeaderOverflowMenu items={overflowItems} />
        })()}
      </div>
      </div>
      <div className="header-meta">
        <StatusBar
          cost={props.cost}
          context={props.context}
          contextPercent={props.contextPercent}
          contextTokens={props.contextTokens}
          contextEstimated={props.contextEstimated}
          inputTokens={props.inputTokens}
          outputTokens={props.outputTokens}
          // #5065: surface the absolute `used / total` token meter in
          // the header. We only pass the window when there's an active
          // model — that's the "no session selected" gate the meter
          // hides on (`showMeter` requires a positive window).
          // #5424: `activeContextWindow` is null when the window is
          // genuinely unknown (e.g. ollama) — the meter then hides and
          // the chip falls back to the raw token-count text.
          contextWindow={props.contextWindow}
          isBusy={props.isBusy}
          agentCount={props.agentCount}
          provider={props.provider}
          // #5184: model label + Settings-driven badge mode. The mode is
          // always defined (store default `provider-model`), so the
          // StatusBar always renders the configurable badge in the app.
          model={props.modelLabel}
          costBadgeMode={props.costBadgeMode}
        />
      </div>
    </header>
  )
}
