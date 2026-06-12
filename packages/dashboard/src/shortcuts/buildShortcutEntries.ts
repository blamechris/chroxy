import type { ShortcutEntry } from '../components/ShortcutHelp'
import type { ShortcutRegistry } from './registry'
import { formatBindingForDisplay, parseBinding } from './registry'
import { formatShortcutKeys } from '../utils/platform'
import { isTauri } from '../utils/tauri'

/**
 * Build the registry-driven keyboard cheat-sheet rows (#4412 / #4432 / #3748).
 *
 * Pure move out of App.tsx (#5560). Recomputed on every render by design — the
 * shortcut registry re-renders whenever a binding changes, so reading
 * `registry.list()` here picks up rebinds automatically; memoising on the
 * (stable) registry reference would silently skip them.
 *
 * @param shortcutRegistry the live registry instance
 * @param isMac whether to format combos with the macOS glyphs (Cmd → ⌘, …)
 * @param isMacPlatform whether the running platform is macOS — gates the
 *   Tauri-only Ctrl+V image-paste entry alongside `isTauri()`. Passed in (not
 *   re-derived) so the call site keeps reading the same value it always did.
 */
export function buildShortcutEntries(
  shortcutRegistry: ShortcutRegistry,
  isMac: boolean,
  isMacPlatform: boolean,
): ShortcutEntry[] {
  const isMacForCheatsheet = isMac
  // Section labels mirror the Settings panel groupings so the cheat
  // sheet and customization UI stay coherent.
  const CATEGORY_TO_SECTION: Record<string, string> = {
    navigation: 'Global',
    view: 'Global',
    session: 'Session',
    sidebar: 'Sidebar',
    composer: 'Input',
    other: 'Global',
  }
  // Cmd+1-9 collapse: nine separate rows would bloat the cheat
  // sheet without adding signal. Emit a single "Cmd+1-9" row whose
  // keys reflect the registry's current first-digit binding so a
  // rebind (e.g. moving them to Alt+1-9) is still visible.
  //
  // #4432 — only collapse when all nine bindings share the same
  // modifier set AND each `session.switch.N` has key `N`. If any
  // entry diverges (e.g. user rebinds only session.switch.1 to
  // Cmd+Q) the cheat sheet would otherwise show a misleading
  // "Cmd+Q-9" label, so we fall back to nine individual rows.
  const tabSwitchEntries = Array.from({ length: 9 }, (_, i) =>
    shortcutRegistry.get(`session.switch.${i + 1}`),
  )
  const tabSwitchAligned = (() => {
    const first = tabSwitchEntries[0]
    if (!first) return false
    const firstParsed = parseBinding(first.binding)
    if (firstParsed.key !== '1') return false
    for (let i = 0; i < tabSwitchEntries.length; i += 1) {
      const entry = tabSwitchEntries[i]
      if (!entry) return false
      const parsed = parseBinding(entry.binding)
      if (parsed.key !== String(i + 1)) return false
      if (
        parsed.meta !== firstParsed.meta ||
        parsed.shift !== firstParsed.shift ||
        parsed.alt !== firstParsed.alt
      ) return false
    }
    return true
  })()
  const tabSwitch1 = tabSwitchEntries[0]
  const tabSwitchKeys = tabSwitch1
    ? formatBindingForDisplay(tabSwitch1.binding, isMacForCheatsheet).replace(/1$/, '1-9')
    : 'Cmd+1-9'
  const registryRows: ShortcutEntry[] = []
  for (const entry of shortcutRegistry.list()) {
    // When aligned: skip the 2..9 tab-switch entries — they're
    // collapsed into one row driven by session.switch.1 below.
    // When diverged: render all nine individually so each rebind is
    // visible.
    if (/^session\.switch\.[2-9]$/.test(entry.id)) {
      if (tabSwitchAligned) continue
      registryRows.push({
        keys: formatBindingForDisplay(entry.binding, isMacForCheatsheet),
        description: entry.description,
        section: CATEGORY_TO_SECTION[entry.category] || 'Global',
      })
      continue
    }
    if (entry.id === 'session.switch.1') {
      if (tabSwitchAligned) {
        registryRows.push({
          keys: tabSwitchKeys,
          description: 'Switch to tab by number',
          section: CATEGORY_TO_SECTION[entry.category] || 'Global',
        })
      } else {
        registryRows.push({
          keys: formatBindingForDisplay(entry.binding, isMacForCheatsheet),
          description: entry.description,
          section: CATEGORY_TO_SECTION[entry.category] || 'Global',
        })
      }
      continue
    }
    registryRows.push({
      keys: formatBindingForDisplay(entry.binding, isMacForCheatsheet),
      description: entry.description,
      section: CATEGORY_TO_SECTION[entry.category] || 'Global',
    })
  }
  // Non-registry entries: permission shortcuts (handled inside the
  // permission prompt UI), composer send (handled in InputBar),
  // Escape (handled per-modal), and the Tauri image-paste shortcut.
  // None of these live in the global keydown ladder so they don't
  // belong in the registry.
  const extraEntries: ShortcutEntry[] = [
    { keys: 'Cmd+Y', description: 'Allow current permission prompt', section: 'Session' },
    { keys: 'Cmd+Shift+Y', description: 'Allow current permission prompt for this session (rule-eligible tools)', section: 'Session' },
    { keys: 'Cmd+Enter', description: 'Send message', section: 'Input' },
    { keys: 'Escape', description: 'Close modal / cancel', section: 'Global' },
  ]
  // #3748 — Ctrl+V (image-paste) only works in the Tauri desktop on
  // macOS; on other platforms Ctrl+V is the native text-paste
  // shortcut. Show the entry only where the shortcut is actually
  // wired.
  if (isTauri() && isMacPlatform) {
    extraEntries.push({
      keys: 'Ctrl+V',
      description: 'Paste image from clipboard (Cmd+V stays as text paste)',
      section: 'Input',
    })
  }
  return [...registryRows, ...extraEntries].map(entry => ({ ...entry, keys: formatShortcutKeys(entry.keys) }))
}
