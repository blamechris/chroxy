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
}
/**
 * Every notification category, in the order the clients render them. The
 * order is the array order — there is no second list to keep in step with it.
 * A key the snapshot carries that is not here renders after these, in
 * snapshot order, under its raw key (so a category from a newer server is
 * never hidden).
 */
export declare const NOTIFICATION_CATEGORIES: readonly NotificationCategoryMeta[];
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
