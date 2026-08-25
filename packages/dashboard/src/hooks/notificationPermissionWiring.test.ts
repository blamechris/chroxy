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
const appSource = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf-8')

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

describe('the Enable-notifications button meets the tap-target floor', () => {
  it('declares a 44px minimum, per the repo-wide rule', () => {
    const css = fs.readFileSync(path.join(SRC, 'theme', 'components.css'), 'utf-8')
    const rule = css.match(/\.settings-notification-enable\s*\{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toMatch(/min-height:\s*44px/)
    expect(rule![0]).toMatch(/min-width:\s*44px/)
  })
})
