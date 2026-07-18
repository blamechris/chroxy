/**
 * Default shortcut definitions (#3852, #4412).
 *
 * Full migration of App.tsx's global keydown ladder into the registry
 * so every shortcut is user-rebindable. The four palette/sidebar/
 * settings/new-session entries from #3852 stay first for source-diff
 * readability; everything below was migrated in #4412.
 *
 * Variadic shortcuts
 * ------------------
 * Cmd+1-9 (tab switching by index) and Cmd+Shift+[/] (prev/next tab)
 * could be modelled as either a single parameterised action or as N
 * separate entries. We picked N entries because the registry only
 * needs combo->id matching to stay simple, and per-digit entries let
 * users rebind individual slots in Settings independently (e.g. wire
 * Cmd+1 to a different action without losing Cmd+2-9). The trade-off
 * is nine rows in the Settings panel — acceptable, and they group
 * cleanly under the "Session" category. The cheat sheet collapses
 * them back into a single "Cmd+1-9" row for readability.
 *
 * Edge cases / gates
 * ------------------
 * - Cmd+W (close tab): Tauri-only. Uses `enabled: () => isTauri()`.
 * - Shift+Tab (toggle plan mode): must NOT fire inside text inputs so
 *   the user can still reverse-tab between form fields. Uses
 *   `disabledInTextInput: true`.
 * - `?` (open cheat sheet): same text-input gate, plus an overlay
 *   stack check that the App.tsx call site still enforces (the
 *   registry has no notion of modal stacks).
 *
 * The id namespace is `<area>.<action>` so future shortcuts slot in
 * predictably (e.g. `composer.history.prev` for #3854).
 */
import type { ShortcutDef } from './registry'
import { isTauri } from '../utils/tauri'

// 1-indexed digit list for the variadic Cmd+<n> tab-switch entries.
const TAB_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

const tabSwitchShortcuts: ShortcutDef[] = TAB_DIGITS.map(n => ({
  id: `session.switch.${n}`,
  defaultBinding: `cmd+${n}`,
  description: `Switch to tab ${n}`,
  category: 'session',
  scope: 'global',
}))

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  // -- #3852: original migration -----------------------------------
  {
    id: 'palette.toggle',
    defaultBinding: 'cmd+k',
    description: 'Toggle command palette',
    category: 'navigation',
    scope: 'global',
  },
  {
    // #6473 (IDE epic #6469) — Cmd+P fuzzy file quick-open. Opens only when the
    // server advertises the opt-in `ide` capability (gated in App).
    id: 'file.openPalette',
    defaultBinding: 'cmd+p',
    description: 'Quick open file',
    category: 'navigation',
    scope: 'global',
  },
  {
    // #6476 (IDE epic #6469) — Cmd+Shift+O fuzzy symbol search. Gated on `ide` in App.
    id: 'symbol.search',
    defaultBinding: 'cmd+shift+o',
    description: 'Search symbols',
    category: 'navigation',
    scope: 'global',
  },
  {
    // #6474 (IDE epic #6469) — Cmd+Shift+F find-in-project content grep. Gated on `ide` in App.
    id: 'search.inProject',
    defaultBinding: 'cmd+shift+f',
    description: 'Search in files',
    category: 'navigation',
    scope: 'global',
  },
  {
    // #6788 — Cmd/Ctrl+F in-conversation find. `disabledInTextInput` keeps the
    // browser's native find working whenever focus is in a text input (the
    // composer, another search field): we only intercept Cmd+F when focus is on
    // the transcript / app chrome, and only when a chat pane is actually on
    // screen (gated in useShortcutDispatch). The dashboard chat list is
    // virtualized (#5561) so native find can't reach off-screen rows — this
    // find bar can. Joins Shift+Tab / `?` as a text-input-gated shortcut.
    id: 'transcript.search',
    defaultBinding: 'cmd+f',
    description: 'Find in conversation',
    category: 'navigation',
    scope: 'global',
    disabledInTextInput: true,
  },
  {
    id: 'sidebar.toggle',
    defaultBinding: 'cmd+b',
    description: 'Toggle sidebar',
    category: 'view',
    scope: 'global',
  },
  {
    id: 'settings.open',
    defaultBinding: 'cmd+,',
    description: 'Open settings',
    category: 'navigation',
    scope: 'global',
  },
  {
    // Pair a device — opens the linking QR modal (the same action as the
    // footer "QR" button + the header overflow "Pair a device" row). Default
    // Cmd+Shift+L ("L" = link a device); deliberately NOT Cmd+Shift+Q, which
    // macOS reserves for Log Out. No-op when disconnected (App gates the
    // handler on `isConnected`, mirroring the footer/overflow surfaces).
    id: 'device.pairQr',
    defaultBinding: 'cmd+shift+l',
    description: 'Pair a device (show QR)',
    category: 'navigation',
    scope: 'global',
  },
  {
    id: 'session.new',
    defaultBinding: 'cmd+n',
    description: 'New session',
    category: 'session',
    scope: 'global',
  },
  // -- #4412: remaining ladder entries -----------------------------
  {
    id: 'palette.toggle.vscode',
    defaultBinding: 'cmd+shift+p',
    description: 'Toggle command palette (VSCode alias)',
    category: 'navigation',
    scope: 'global',
  },
  {
    id: 'view.toggleChatTerminal',
    defaultBinding: 'cmd+shift+d',
    description: 'Toggle chat / terminal view',
    category: 'view',
    scope: 'global',
  },
  {
    id: 'view.cycleSplit',
    defaultBinding: 'cmd+\\',
    description: 'Cycle split view',
    category: 'view',
    scope: 'global',
  },
  {
    id: 'session.copyTranscript',
    defaultBinding: 'cmd+shift+t',
    description: 'Copy chat transcript',
    category: 'session',
    scope: 'global',
  },
  {
    id: 'session.interrupt',
    defaultBinding: 'cmd+.',
    description: 'Interrupt session',
    category: 'session',
    scope: 'global',
  },
  {
    id: 'session.togglePlanMode',
    defaultBinding: 'shift+tab',
    description: 'Toggle plan mode',
    category: 'session',
    scope: 'global',
    disabledInTextInput: true,
  },
  {
    id: 'help.toggle',
    defaultBinding: '?',
    description: 'Show keyboard shortcuts',
    category: 'other',
    scope: 'global',
    disabledInTextInput: true,
  },
  // Variadic-ish: prev / next tab. Two entries (one per arm) so users
  // can rebind them independently and the registry stays a plain
  // combo->id map. Both dispatch to a single nav action in App.tsx.
  {
    id: 'session.prev',
    defaultBinding: 'cmd+shift+[',
    description: 'Previous tab',
    category: 'session',
    scope: 'global',
  },
  {
    id: 'session.next',
    defaultBinding: 'cmd+shift+]',
    description: 'Next tab',
    category: 'session',
    scope: 'global',
  },
  // Cmd+W close tab — Tauri only. In the browser Cmd+W is reserved by
  // the OS for closing the tab/window itself, so the `enabled`
  // predicate keeps the shortcut quiescent there.
  {
    id: 'session.close',
    defaultBinding: 'cmd+w',
    description: 'Close tab (desktop)',
    category: 'session',
    scope: 'global',
    enabled: () => isTauri(),
  },
  // Cmd+1 .. Cmd+9 tab-switch entries — one per digit.
  ...tabSwitchShortcuts,
  // -- #4941: sidebar reorder discoverability ----------------------
  // These two entries describe the keyboard reorder shortcut on
  // draggable sidebar rows (#4832). Default is Alt+ArrowUp/Down.
  //
  // #4972 — Sidebar.tsx now consults `registry.matchEvent(e, 'global')`
  // when checking these shortcuts, so a user rebind in Settings flows
  // through to runtime behaviour AND the row's aria-keyshortcuts SR
  // announcement. The discoverability surfaces (`?` cheat sheet,
  // Settings rebind list) and the runtime handler now share one source
  // of truth.
  {
    id: 'sidebar.reorder.up',
    defaultBinding: 'alt+arrowup',
    description: 'Move sidebar row up (when focused)',
    category: 'sidebar',
    scope: 'global',
  },
  {
    id: 'sidebar.reorder.down',
    defaultBinding: 'alt+arrowdown',
    description: 'Move sidebar row down (when focused)',
    category: 'sidebar',
    scope: 'global',
  },
  // #4949 — SessionBar keyboard reorder ladder. Shipped in #4945 but
  // was undiscoverable: no cheat-sheet entry, no tooltip. The ladder
  // is owned by SessionBar.tsx itself (focused-tab keydown handler),
  // so this entry exists purely so users can find it in the `?`
  // overlay and the Settings UI.
  //
  // Scope is `sessionbar` (not `global`) on purpose — the global
  // dispatcher unconditionally calls preventDefault() on any matched
  // id, which would break Shift+Space everywhere outside text inputs.
  // The `sessionbar` scope is only consumed by the registry's
  // list()/cheat-sheet path, never by matchEvent.
  //
  // #4970 — for the same reason (SessionBar.tsx hardcodes the keys),
  // this entry is intentionally non-rebindable in Settings today.
  // ShortcutsSection inspects `scope === 'sessionbar'` and disables the
  // Edit/Reset buttons so a user-issued rebind cannot silently fail.
  // When the SessionBar keydown handler is migrated to consult
  // `registry.matchEvent(e, 'sessionbar')`, drop the read-only guard.
  {
    id: 'session.reorder.lift',
    defaultBinding: 'shift+space',
    description: 'Lift session tab for keyboard reorder (Arrow Left/Right to move, Enter/Escape to commit/cancel)',
    category: 'session',
    scope: 'sessionbar',
  },
]
