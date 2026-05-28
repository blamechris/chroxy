/**
 * Default shortcut definitions (#3852).
 *
 * Scope-reduced for the first cut: the most-commonly-rebound shortcuts
 * — palette, sidebar, settings, new session — are user-customizable
 * through the registry. The remaining (Cmd+1-9 tab switching,
 * Cmd+Shift+[/], Cmd+\, etc.) stay in the keydown ladder for now; once
 * this lands they can be migrated in follow-ups without changing the
 * registry contract.
 *
 * The id namespace is `<area>.<action>` so future shortcuts slot in
 * predictably (e.g. `composer.history.prev` for #3854).
 */
import type { ShortcutDef } from './registry'

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
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
]
