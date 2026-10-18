/**
 * Notification categories — the ONE place the client-facing roster (key,
 * label, hint, render order) is written down.
 *
 * #7429. The server's `ALL_CATEGORIES` (notification-prefs.js) and
 * `RATE_LIMITS` (push.js) name what the daemon can fire. Each client used to
 * keep its OWN copy of the labels and the render order (the mobile app's
 * `settings/constants.ts` and the dashboard's `SettingsPanel.tsx`), with
 * nothing tying either copy to the server: a category added server-side
 * rendered as a raw key (`ci_complete`) on both clients, in whatever position
 * the snapshot happened to put it. Adding `ci_complete` (#7424) meant hand-
 * editing four lists, and the only checks were a bounded regex and `>= 10`.
 *
 * Now both clients import this module, so a client roster cannot drift from
 * the other. What stays a separate list is the server's `ALL_CATEGORIES` (its
 * wire order differs from the render order, and the daemon must not depend on
 * a UI table to decide what it can fire) — it is pinned to THIS roster, in
 * both directions, by `packages/server/tests/notification-category-roster.test.js`,
 * which reads the two real exports. Adding a category therefore means: add it
 * to `ALL_CATEGORIES` + `RATE_LIMITS` (server) and to `NOTIFICATION_CATEGORIES`
 * below; forgetting either side fails that test and names the missing key.
 *
 * The default quiet-hours bypass set (the categories that still fire during
 * quiet hours when nobody has overridden it) is the same shape of problem and
 * is solved the same way, with one difference: it is a per-category FLAG
 * (`defaultBypass`) on the roster rather than a second list, so it cannot name
 * a key the roster does not carry, and `DEFAULT_BYPASS_CATEGORIES` below is
 * derived from it. The daemon keeps its own `DEFAULT_BYPASS_CATEGORIES`
 * (notification-prefs.js) for the same reason it keeps `ALL_CATEGORIES`, and
 * the roster test pins it to the flag in both directions.
 *
 * Zod-free and dependency-free on purpose: the server, the dashboard and the
 * mobile app all import it.
 */

export interface NotificationCategoryMeta {
  /** Wire key — must equal the server's `ALL_CATEGORIES` entry. */
  readonly key: string
  /** Human label shown on the toggle. */
  readonly label: string
  /** One-line explanation shown under the label. */
  readonly hint: string
  /**
   * True when this category bypasses quiet hours with no explicit override.
   * Absent means false. The server's `DEFAULT_BYPASS_CATEGORIES` must equal the
   * set of keys flagged here.
   */
  readonly defaultBypass?: boolean
}

/**
 * Every notification category, in the order the clients render them. The
 * order is the array order — there is no second list to keep in step with it.
 * A key the snapshot carries that is not here renders after these, in
 * snapshot order, under its raw key (so a category from a newer server is
 * never hidden).
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategoryMeta[] = Object.freeze([
  {
    key: 'permission',
    label: 'Permission requests',
    hint: 'Tool-use prompts that need an allow / deny decision.',
    // Blocks the agent until the operator decides; muting it stalls the agent.
    defaultBypass: true,
  },
  {
    key: 'activity_waiting',
    label: 'Waiting for input',
    hint: 'Claude asked a question or is paused on a prompt.',
  },
  {
    key: 'activity_error',
    label: 'Session errors',
    hint: 'Crashes, tunnel drops, and unrecoverable session failures.',
    // Crashes and fatal failures demand attention the same way a permission does.
    defaultBypass: true,
  },
  {
    key: 'activity_update',
    label: 'Activity updates',
    hint: 'Foreground task progress while you are away.',
  },
  {
    key: 'inactivity_warning',
    label: 'Inactivity warnings',
    hint: 'Heads-up when a session has gone quiet for a long time. It keeps running.',
  },
  // #5828: billing canary early-warnings (silent metered default, claude-tui
  // reclassification, datacenter egress).
  {
    key: 'billing_warning',
    label: 'Billing alerts',
    hint: 'Metered-credit and datacenter-egress warnings from the billing canary.',
  },
  {
    key: 'result',
    label: 'Task completion',
    hint: 'Sent when a Claude turn finishes and no one is watching.',
  },
  // External-session categories (#5413, fed by POST /api/events) are grouped
  // together, ahead of the platform-specific Live Activity entry which stays
  // last.
  {
    key: 'session_online',
    label: 'External session online',
    hint: 'An external session reported in via /api/events.',
  },
  {
    key: 'session_offline',
    label: 'External session offline',
    hint: 'An external session ended or went away.',
  },
  {
    key: 'session_activity',
    label: 'External session activity',
    hint: 'Subagent and tool activity from external sessions.',
  },
  // Mailbox live-interrupt: "new mail" pings fed by POST /api/mailbox.
  {
    key: 'mailbox',
    label: 'Mailbox',
    hint: 'New agent-to-agent mailbox messages waiting for a session.',
  },
  // #7424: CI runs settling on a session's pull request.
  {
    key: 'ci_complete',
    label: 'CI results',
    hint: 'A CI run finished on the pull request a session opened.',
  },
  {
    key: 'live_activity',
    label: 'Live Activity (iOS)',
    hint: 'iOS Dynamic Island / lock-screen Live Activity updates.',
  },
].map((c) => Object.freeze(c)))

/** Render order for the known categories (derived — never a second list). */
export const NOTIFICATION_CATEGORY_ORDER: readonly string[] = Object.freeze(
  NOTIFICATION_CATEGORIES.map((c) => c.key),
)

/**
 * Categories that bypass quiet hours when no explicit override is set (derived
 * from the `defaultBypass` flag — never a second list). Clients use it when a
 * snapshot omits `bypassCategories` (older server, fresh install).
 */
export const DEFAULT_BYPASS_CATEGORIES: readonly string[] = Object.freeze(
  NOTIFICATION_CATEGORIES.filter((c) => c.defaultBypass === true).map((c) => c.key),
)

/**
 * Label + hint by key (derived — never a second list). Typed as a plain
 * string-keyed record because snapshots carry keys this build has never heard
 * of; lookups must be treated as possibly `undefined` and fall back to the raw
 * key.
 */
export const NOTIFICATION_CATEGORY_LABELS: Readonly<Record<string, { label: string; hint?: string }>> =
  Object.freeze(
    Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((c) => [c.key, Object.freeze({ label: c.label, hint: c.hint })]),
    ),
  )
