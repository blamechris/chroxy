/**
 * useShortcutDispatch — global keydown listener + registry dispatch (#4770).
 *
 * Owns the single `keydown` listener registered on `window`. Three
 * categories of input flow through here:
 *
 *   1. Backspace outside text inputs — `preventDefault` so the
 *      browser / webview doesn't navigate back.
 *   2. Ctrl+V on macOS in Tauri — read an image off the clipboard and
 *      append it to the composer's pending-image tray (#3748). Cmd+V
 *      stays untouched so the OS / textarea handles native text paste.
 *   3. Registry-matched shortcuts — `shortcutRegistry.matchEvent(e,
 *      'global')` returns a definition id, and the switch below routes
 *      it to the right side effect. The registry is the single source
 *      of truth for combos so user rebinds in Settings propagate
 *      everywhere without code changes (#3852 / #4412).
 *
 * App-state knowledge that the registry can't own (overlay-stack check
 * for `help.toggle`, sessions-length guard for `session.close`, empty-
 * slot guard for `session.switch.N`) lives in this hook.
 *
 * Extracted from App.tsx so the dispatch ladder is independently
 * testable and the root component stays under the SRP threshold.
 */
import { useEffect } from 'react'
import type { SessionInfo } from '@chroxy/store-core'
import type { ShortcutRegistry } from '../shortcuts/registry'
import type { SplitDirection } from '../components/SplitPane'
import type { ImageAttachment } from '../components/InputBar'
import { isTauri } from '../utils/tauri'
import { isMacPlatform } from '../utils/platform'
import { readClipboardImage } from '../utils/clipboard-image'
import { processBase64Image } from '../utils/image-utils'
import { useConnectionStore } from '../store/connection'
import { persistSplitMode } from '../store/persistence'

type ViewMode = 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'snapshots'

export interface ShortcutDispatchProps {
  shortcutRegistry: ShortcutRegistry
  sessions: SessionInfo[]
  activeSessionId: string | null
  viewMode: ViewMode | string
  setViewMode: (m: ViewMode) => void
  setSplitMode: (fn: (prev: SplitDirection | null) => SplitDirection | null) => void
  /**
   * #5997 — the active session is a terminal-only provider (user-shell): no
   * Chat view, so the chat/terminal toggle and split shortcuts are no-ops.
   * Gating them here (rather than relying on the App-level cleanup effects)
   * avoids the one-frame empty-chat-pane flicker those keystrokes would
   * otherwise cause before the effect snaps the view back.
   */
  terminalOnly?: boolean
  setPaletteOpen: (fn: (prev: boolean) => boolean) => void
  setSidebarOpen: (fn: (prev: boolean) => boolean) => void
  setSettingsOpen: (fn: (prev: boolean) => boolean) => void
  /**
   * #5544 — Cmd+, now redirects to the Control Room Settings tab (the single
   * home for preferences). When provided this takes precedence over the
   * legacy `setSettingsOpen` modal toggle; left optional so older call sites
   * / tests that only wire the modal toggle keep working.
   */
  openSettings?: () => void
  setShowCreateSession: (open: boolean) => void
  setShortcutHelpOpen: (fn: (prev: boolean) => boolean) => void
  handleSwitchSession: (sessionId: string) => void
  handleCloseSession: (sessionId: string) => void
  handleCopyTranscript: () => void
  sendInterrupt: () => void
  setPermissionMode: (mode: string) => void
  appendImageAttachments: (attachments: ImageAttachment[]) => void
  // #6473 — open the Cmd+P quick-open file palette (the caller gates it on the
  // `ide` capability). Optional so existing call sites / tests keep working.
  openFilePalette?: () => void
  // #6476 — open the Cmd+Shift+O symbol-search palette (caller gates on `ide`).
  openSymbolSearch?: () => void
  // #6474 — open the Cmd+Shift+F find-in-project palette (caller gates on `ide`).
  openCodeSearch?: () => void
  // Show the device-pairing QR modal (Cmd+Shift+L). Optional + undefined when
  // disconnected (the caller gates on `isConnected`), so the shortcut no-ops
  // rather than opening an empty modal with no server to pair against.
  showQr?: () => void
  /**
   * #6788 — true when a chat transcript is on screen (chat view active, or a
   * split with a chat pane). Cmd+F only intercepts the browser's native find
   * when this holds; on non-chat surfaces the event falls through so the
   * browser's find still works (there's no transcript for our find bar to reach).
   */
  chatTranscriptVisible?: boolean
  /**
   * #6788 — summon the in-session find bar (bumps the ChatView open nonce).
   * Only called when `chatTranscriptVisible` is true.
   */
  openTranscriptSearch?: () => void
}

export function useShortcutDispatch(props: ShortcutDispatchProps): void {
  const {
    shortcutRegistry,
    sessions,
    activeSessionId,
    viewMode,
    setViewMode,
    setSplitMode,
    terminalOnly,
    setPaletteOpen,
    setSidebarOpen,
    setSettingsOpen,
    openSettings,
    setShowCreateSession,
    setShortcutHelpOpen,
    handleSwitchSession,
    handleCloseSession,
    handleCopyTranscript,
    sendInterrupt,
    setPermissionMode,
    appendImageAttachments,
    openFilePalette,
    openSymbolSearch,
    openCodeSearch,
    showQr,
    chatTranscriptVisible,
    openTranscriptSearch,
  } = props

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Prevent Backspace from triggering browser/webview "back" navigation
      const target = e.target instanceof HTMLElement ? e.target : null
      if (e.key === 'Backspace' && (!target || (!['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable))) {
        e.preventDefault()
        return
      }
      // Ctrl+V on macOS in Tauri = paste image from clipboard (#3748).
      // Cmd+V remains the native text paste (handled by the OS / textarea
      // onPaste handler, untouched here). On non-Mac platforms Ctrl+V is
      // the native text paste — we leave it alone there. On non-Tauri
      // (web dashboard) there's no way to read the OS clipboard image
      // reliably, so the shortcut only fires inside the Tauri webview.
      if (
        isTauri() &&
        isMacPlatform() &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === 'v' || e.key === 'V')
      ) {
        e.preventDefault()
        void (async () => {
          try {
            const image = await readClipboardImage()
            if (!image) {
              useConnectionStore.getState().addInfoNotification('No image on clipboard')
              return
            }
            // Use processBase64Image (not processImageFiles) to skip the
            // base64 → Blob → File → FileReader → base64 round-trip the
            // File path would otherwise perform on a payload we already
            // have in the canonical shape (#3796 review).
            const { accepted, rejected } = await processBase64Image(image.base64, image.mediaType, image.name)
            if (accepted) {
              appendImageAttachments([accepted])
            } else if (rejected) {
              useConnectionStore.getState().addInfoNotification(rejected)
            }
          } catch (err) {
            useConnectionStore.getState().addInfoNotification(
              `Failed to read clipboard image: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        })()
        return
      }
      // #3852 / #4412: customizable shortcuts win first. The registry
      // is the single source of truth for the entire global keydown
      // ladder — every dispatch below is a registry id, never a raw
      // combo, so user rebinds in Settings propagate automatically.
      // The registry already evaluates `disabledInTextInput` and
      // `enabled` predicates internally (see registry.ts matchEvent),
      // so the per-branch text-input gates the old ladder did inline
      // are gone — they live on the ShortcutDef instead.
      //
      // Note: we deliberately do NOT gate ALL shortcuts on text-input
      // focus — palette / sidebar / settings / new-session / etc.
      // should fire even when a textarea has focus. Only shortcuts
      // declared with `disabledInTextInput: true` are suppressed by
      // the registry (Shift+Tab, ?).
      const matchedId = shortcutRegistry.matchEvent(e, 'global')
      if (matchedId) {
        // session.switch.N — index from id suffix; preventDefault only
        // when we actually have a session for that slot so unused
        // slots don't swallow OS-level Cmd+digit shortcuts.
        if (matchedId.startsWith('session.switch.')) {
          const idx = parseInt(matchedId.slice('session.switch.'.length), 10) - 1
          const target = sessions[idx]
          if (target) {
            e.preventDefault()
            handleSwitchSession(target.sessionId)
          }
          return
        }
        // session.close (Cmd+W) — Tauri-only via registry `enabled`
        // predicate. Additional in-action guard: only close when more
        // than one session exists, otherwise let the event bubble so
        // Cmd+W still closes the desktop window when there's nothing
        // left to close inside the app.
        if (matchedId === 'session.close') {
          if (activeSessionId && sessions.length > 1) {
            e.preventDefault()
            handleCloseSession(activeSessionId)
          }
          return
        }
        // help.toggle — registry already gates text-input focus, but
        // the overlay-stack check is App-state knowledge it can't
        // own. Keep it here.
        if (matchedId === 'help.toggle') {
          const overlays = document.querySelectorAll('[data-modal-overlay]')
          const onlyShortcutHelp = overlays.length === 1 && overlays[0]?.classList.contains('shortcut-help-overlay')
          if (overlays.length === 0 || onlyShortcutHelp) {
            e.preventDefault()
            setShortcutHelpOpen(prev => !prev)
          }
          return
        }
        // #6788 — Cmd/Ctrl+F in-conversation find. Only intercept (and suppress
        // the browser's native find) when a chat transcript is actually on
        // screen; otherwise let the event through so native find still works on
        // non-chat surfaces. Handled BEFORE the generic preventDefault so a
        // non-chat Cmd+F is never swallowed. The registry's `disabledInTextInput`
        // already lets native find run while a text input (composer / other
        // search field) has focus.
        if (matchedId === 'transcript.search') {
          if (chatTranscriptVisible && openTranscriptSearch) {
            e.preventDefault()
            openTranscriptSearch()
          }
          return
        }
        e.preventDefault()
        switch (matchedId) {
          case 'palette.toggle':
          case 'palette.toggle.vscode':
            setPaletteOpen(prev => !prev)
            break
          case 'file.openPalette':
            openFilePalette?.()
            break
          case 'search.inProject':
            openCodeSearch?.()
            break
          case 'symbol.search':
            openSymbolSearch?.()
            break
          case 'sidebar.toggle':
            setSidebarOpen(prev => !prev)
            break
          case 'settings.open':
            // #5544 — prefer the Control Room Settings tab redirect; fall back
            // to the legacy modal toggle when the redirect isn't wired.
            if (openSettings) openSettings()
            else setSettingsOpen(prev => !prev)
            break
          case 'device.pairQr':
            // Open the linking QR modal (same action as the footer "QR" button
            // + the overflow "Pair a device" row). `showQr` is undefined when
            // disconnected, so this no-ops rather than opening an empty modal.
            showQr?.()
            break
          case 'session.new':
            setShowCreateSession(true)
            break
          case 'view.toggleChatTerminal':
            // #5997 — a terminal-only provider has no Chat view; the toggle
            // would flash an empty chat pane before the redirect effect snaps
            // it back. No-op it at the source instead.
            if (terminalOnly) break
            setViewMode(viewMode === 'chat' ? 'terminal' : 'chat')
            break
          case 'view.cycleSplit':
            // #5997 — split is a chat|terminal pane pair; no chat surface on a
            // terminal-only provider, so skip it here too.
            if (terminalOnly) break
            setSplitMode(prev => {
              const next = prev === null ? 'horizontal' : prev === 'horizontal' ? 'vertical' : null
              persistSplitMode(next)
              return next
            })
            break
          case 'session.copyTranscript':
            handleCopyTranscript()
            break
          case 'session.interrupt':
            sendInterrupt()
            break
          case 'session.prev':
          case 'session.next': {
            const currentIdx = sessions.findIndex(s => s.sessionId === activeSessionId)
            if (currentIdx < 0) break
            const nextIdx = matchedId === 'session.prev'
              ? (currentIdx - 1 + sessions.length) % sessions.length
              : (currentIdx + 1) % sessions.length
            handleSwitchSession(sessions[nextIdx]!.sessionId)
            break
          }
          case 'session.togglePlanMode': {
            const state = useConnectionStore.getState()
            const currentMode = state.permissionMode
            if (currentMode === 'plan') {
              // Switch back to previous mode (default to 'approve')
              setPermissionMode(state.previousPermissionMode || 'approve')
            } else {
              setPermissionMode('plan')
            }
            break
          }
          default:
            // Unknown registry id reached the dispatch table — most
            // likely a definition was added in defaults.ts without an
            // App-side handler. Fail loud in dev so the gap is
            // obvious; silently ignore in prod so a stray
            // localStorage override can't brick the app.
            if (import.meta.env?.DEV) {
              // eslint-disable-next-line no-console
              console.warn(`[shortcuts] no handler for matched id "${matchedId}"`)
            }
        }
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    sessions,
    activeSessionId,
    handleSwitchSession,
    handleCloseSession,
    viewMode,
    setViewMode,
    terminalOnly,
    sendInterrupt,
    handleCopyTranscript,
    shortcutRegistry,
    appendImageAttachments,
    setPermissionMode,
    setSplitMode,
    setPaletteOpen,
    setSidebarOpen,
    setSettingsOpen,
    openSettings,
    setShowCreateSession,
    setShortcutHelpOpen,
    chatTranscriptVisible,
    openTranscriptSearch,
  ])
}
