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
  // These two entries describe the existing Alt+ArrowUp / Alt+ArrowDown
  // keyboard reorder shortcut on draggable sidebar rows (#4832). They
  // are intentionally informational-only: the actual keydown handler
  // lives in Sidebar.tsx and matches `event.altKey && event.key ===
  // 'ArrowUp'|'ArrowDown'` directly rather than via the registry, so a
  // user rebind here does NOT change runtime behaviour today. The
  // entries exist so the `?` cheat sheet and Settings rebind list both
  // surface the shortcut — the previous gap left users with no path
  // to discover keyboard reorder short of reading the PR or the source.
  // When the row-level handler is migrated to `registry.matchEvent`,
  // these entries become functional without further migration.
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
  {
    id: 'session.reorder.lift',
    defaultBinding: 'shift+space',
    description: 'Lift session tab for keyboard reorder (Arrow Left/Right to move, Enter/Escape to commit/cancel)',
    category: 'session',
    scope: 'sessionbar',
  },
]
