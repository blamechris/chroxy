/**
 * Notification-permission wiring guards (#7351).
 *
 * Unit tests prove each piece works in isolation; #7351 was a bug in which
 * every piece worked and nothing CALLED them. `usePermissionNotification` was
 * correct, its tests passed, and the feature was dead — because
 * `Notification.requestPermission()` had no call site anywhere in the product
 * and the permission never left `'default'`.
 *
 * A behavioural test of a hook cannot witness that. These are source-level
 * guards on the two properties that no in-hook assertion can express:
 *
 *   1. App.tsx actually mounts the permission lifecycle and feeds it to the
 *      notifier. Delete that wiring and every other test in this package still
 *      passes — which is precisely how the original defect survived.
 *   2. `utils/native-notifications` stays the ONLY place that touches the raw
 *      Notification global. The moment a second call site reaches for
 *      `new Notification(...)` again, it is outside the permission lifecycle
 *      and the bug is back in a new location.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..')
// Comment-stripped, like every other scan in this file: a guard whose whole
// purpose is to catch the wiring going missing must not be satisfiable by
// commenting the wiring out.
const appSource = stripCommentLines(fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf-8'))

/**
 * Drop comment-ONLY lines (JSDoc bodies, `//` lines) before scanning.
 *
 * Needed because the modules that legitimately discuss this bug describe
 * `Notification.requestPermission()` in prose, and a guard that cannot tell
 * code from commentary reports its own documentation as a violation.
 *
 * Deliberately conservative: it removes whole lines that are nothing but a
 * comment, and never truncates a line at a mid-line `//`. Truncating would
 * let a real offender hide behind a trailing comment (or behind a `'http://'`
 * literal), which is a strictly worse failure than the false positive it
 * would fix.
 */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

/** Every non-test .ts/.tsx file under src/, recursively. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

describe('App wires the notification-permission lifecycle', () => {
  it('still has App source left after comment-stripping', () => {
    // Positive control: if stripCommentLines ever ate the file, every
    // assertion below would fail loudly rather than silently checking ''.
    expect(appSource.length).toBeGreaterThan(1000)
    expect(appSource).toContain('function App')
  })

  it('imports useNotificationPermission', () => {
    expect(appSource).toContain("from './hooks/useNotificationPermission'")
  })

  it('mounts useNotificationPermission', () => {
    expect(appSource).toMatch(/useNotificationPermission\(\s*\{/)
  })

  it('feeds the live permission into usePermissionNotification', () => {
    // Without the second argument a mid-session grant would not reach a
    // prompt that is already pending.
    expect(appSource).toMatch(/usePermissionNotification\(\s*permissionPrompts\s*,\s*notificationPermission\.permission\s*\)/)
  })
})

describe('App wires the turn-complete notification (#7347)', () => {
  // Same class of guard, same reason: `useTurnCompleteNotification` is fully
  // covered by its own behavioural suite, and every one of those tests would
  // still pass with the call deleted from App.tsx — leaving the exact state
  // #7347 was filed about (a trigger that exists and never runs).

  it('imports and mounts useTurnCompleteNotification', () => {
    expect(appSource).toContain("from './hooks/useTurnCompleteNotification'")
    expect(appSource).toMatch(/useTurnCompleteNotification\(\s*turnCompleteSessions\s*,/)
  })

  it('feeds it the live connection state, not a hardcoded true', () => {
    // `connected: false` is what discards tracking across a socket drop. Wire
    // a literal here and a reconnect manufactures a completed turn out of a
    // re-seeded session_list snapshot.
    expect(appSource).toMatch(/connected:\s*isConnected\s*,/)
  })

  it('derives busy from the per-session isIdle flag, not from sessions[].isBusy', () => {
    // `sessions[].isBusy` is only a session_list snapshot and is NOT
    // rebroadcast on a turn boundary — reading it here would mean the
    // notification fires on session create/destroy and never on a completed
    // turn. `session_activity` maintains `sessionStates[id].isIdle` instead.
    expect(appSource).toMatch(/sessionStates\[id\]!\.isIdle === false/)
    expect(appSource).toMatch(/busy:\s*sessionBusyById\[/)
  })

  it('suppresses the alert for a session that stopped on a permission prompt', () => {
    // Otherwise the same moment produces two cards: this one and
    // usePermissionNotification's.
    expect(appSource).toMatch(/awaitingPermission:\s*\(pendingPermissionCounts\[/)
  })
})

describe('native-notifications is the only Notification call site', () => {
  const files = sourceFiles(SRC)

  it('finds a non-trivial number of source files to scan', () => {
    // Positive control: a traversal bug that returned [] would make every
    // assertion below pass vacuously — the exact shape of the bug this file
    // exists to prevent.
    expect(files.length).toBeGreaterThan(50)
    expect(files).toContain(path.join(SRC, 'utils', 'native-notifications.ts'))
  })

  it('has no `new Notification(` outside the backend module', () => {
    const offenders = files.filter(f => {
      if (f === path.join(SRC, 'utils', 'native-notifications.ts')) return false
      return /\bnew\s+Notification\s*\(/.test(stripCommentLines(fs.readFileSync(f, 'utf-8')))
    })
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([])
  })

  it('has no direct `Notification.permission` / `Notification.requestPermission` read outside the backend module', () => {
    const offenders = files.filter(f => {
      if (f === path.join(SRC, 'utils', 'native-notifications.ts')) return false
      const src = stripCommentLines(fs.readFileSync(f, 'utf-8'))
      return /(?<![.\w])Notification\s*\.\s*(permission|requestPermission)\b/.test(src)
    })
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([])
  })

  it('the backend module itself really does contain the patterns being guarded', () => {
    // Positive control for the two assertions above: if the regexes were wrong
    // (or the Notification API were renamed) they would report "no offenders"
    // for the wrong reason, and keep passing with the guard deleted.
    const backend = stripCommentLines(
      fs.readFileSync(path.join(SRC, 'utils', 'native-notifications.ts'), 'utf-8'),
    )
    // The stripper must not have eaten the file wholesale — otherwise both
    // assertions below would fail loudly, but the two scans above would pass
    // vacuously for every file in the tree.
    expect(backend).toContain('export function sendNativeNotification')
    expect(/\bnew\s+\w+\s*\(\s*title/.test(backend)).toBe(true)
    expect(/(?<![.\w])Notification\s*\.\s*requestPermission\b/.test(backend)).toBe(true)
  })
})

describe('the Enable-notifications button only uses classes that exist', () => {
  it('has every class on the button defined in components.css', () => {
    // Caught in review: the button shipped with `btn-secondary`, which is
    // defined in no stylesheet in the repo — so it rendered with native OS
    // chrome inside the themed panel. TypeScript cannot catch a class name
    // that resolves to nothing, and neither can a render test that only
    // queries by testid.
    const panel = fs.readFileSync(path.join(SRC, 'components', 'SettingsPanel.tsx'), 'utf-8')
    const css = fs.readFileSync(path.join(SRC, 'theme', 'components.css'), 'utf-8')

    const match = panel.match(/className="([^"]*settings-notification-enable[^"]*)"/)
    expect(match?.[1]).toBeTruthy()

    const classes = (match?.[1] ?? '').split(/\s+/).filter(Boolean)
    // Positive control: the button really does carry more than the one class
    // this scan is named for, so an empty/one-item list means the regex broke.
    expect(classes.length).toBeGreaterThan(1)

    const undefinedClasses = classes.filter(c => !new RegExp(`\\.${c}\\b`).test(css))
    expect(undefinedClasses).toEqual([])
  })
})

describe('the Dashboard-section toggles meet the tap-target floor', () => {
  it('gives .settings-field-checkbox label a 44px minimum', () => {
    // The label is the control (clicking the text toggles the checkbox), so
    // the 44pt floor applies to it and not to the native checkbox glyph. This
    // is asserted on the SHARED class deliberately: the turn-complete toggle
    // (#7347), the intervention ping and the console-tab switch all use it, so
    // one rule covers the whole section and a fourth toggle inherits it.
    const css = fs
      .readFileSync(path.join(SRC, 'theme', 'components.css'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = css.match(/\.settings-field-checkbox\s+label\s*\{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toMatch(/min-height:\s*44px/)
  })

  it('renders the turn-complete toggle inside a .settings-field-checkbox row', () => {
    // Positive control for the CSS assertion above: the rule only protects
    // this toggle if the toggle actually carries the class.
    const panel = stripCommentLines(
      fs.readFileSync(path.join(SRC, 'components', 'SettingsPanel.tsx'), 'utf-8'),
    )
    const row = panel.match(
      /className="settings-field settings-field-checkbox"[\s\S]{0,600}?turn-complete-notification-toggle/,
    )
    expect(row).not.toBeNull()
  })
})

describe('the Enable-notifications button meets the tap-target floor', () => {
  it('declares a 44px minimum, per the repo-wide rule', () => {
    // Block comments removed first — the rule is documented with a /* */
    // comment directly above it, and a commented-OUT rule must not count as
    // the rule being present.
    const css = fs
      .readFileSync(path.join(SRC, 'theme', 'components.css'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = css.match(/\.settings-notification-enable\s*\{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toMatch(/min-height:\s*44px/)
    expect(rule![0]).toMatch(/min-width:\s*44px/)
  })
})
