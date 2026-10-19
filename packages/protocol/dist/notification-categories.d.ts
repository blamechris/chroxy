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
 * Zod-free and dependency-free on purpose: the server, the dashboard and the
 * mobile app all import it.
 */
export interface NotificationCategoryMeta {
    /** Wire key — must equal the server's `ALL_CATEGORIES` entry. */
    readonly key: string;
    /** Human label shown on the toggle. */
    readonly label: string;
    /** One-line explanation shown under the label. */
    readonly hint: string;
    /**
     * True when this category bypasses quiet hours by default (#8567). The
     * default bypass set is derived from this flag, so the clients cannot keep
     * their own copy; the server's `DEFAULT_BYPASS_CATEGORIES` is an
     * independent literal pinned to it, in both directions, by
     * `packages/server/tests/notification-category-roster.test.js`.
     */
    readonly defaultBypass?: boolean;
}
/**
 * Every notification category, in the order the clients render them. The
 * order is the array order — there is no second list to keep in step with it.
 * A key the snapshot carries that is not here renders after these, in
 * snapshot order, under its raw key (so a category from a newer server is
 * never hidden).
 */
export declare const NOTIFICATION_CATEGORIES: readonly NotificationCategoryMeta[];
/**
 * Categories that bypass quiet hours when the user has not chosen a list
 * (derived from `defaultBypass` — never a second list). Used by both clients
 * when a snapshot omits `bypassCategories` (older server, fresh install).
 */
export declare const DEFAULT_BYPASS_CATEGORIES: readonly string[];
/** Render order for the known categories (derived — never a second list). */
export declare const NOTIFICATION_CATEGORY_ORDER: readonly string[];
/**
 * Label + hint by key (derived — never a second list). Typed as a plain
 * string-keyed record because snapshots carry keys this build has never heard
 * of; lookups must be treated as possibly `undefined` and fall back to the raw
 * key.
 */
export declare const NOTIFICATION_CATEGORY_LABELS: Readonly<Record<string, {
    label: string;
    hint?: string;
}>>;
