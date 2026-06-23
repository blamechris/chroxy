/**
 * Skills inventory survey (#5554) + summarize-session result (#5547): the Control Room Skills tab (names/metadata only — never skill bodies) and the model-written continuation brief.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
// ───────────────────────────────────────────────────────────────────────────
// #5554 (epic #5159) — Control Room "Skills" tab: inventory + usage history.
// ───────────────────────────────────────────────────────────────────────────
/**
 * #5554 — one skill in the inventory snapshot. Carries only names /
 * descriptions / metadata — never the skill BODY (the security boundary: skill
 * bodies never leave the server). Fields:
 *
 *   - `name` / `description` — from the file + frontmatter (description is the
 *     frontmatter `description:` or the first non-empty body line).
 *   - `source` — which tier this entry came from: `global` (~/.chroxy/skills/)
 *     or `repo` (a repo-local `.chroxy/skills/` overlay).
 *   - `activation` — `auto` (always active) or `manual` (opt-in per session).
 *   - `active` — whether the skill is in the default-active set (a manual skill
 *     not yet activated reports `active: false`).
 *   - `providers` — frontmatter provider scoping (empty = applies to all).
 *   - `version` — frontmatter `version:` if present.
 *   - `trustState` — `trusted` / `pending` for community-namespaced skills;
 *     null for plain skills (implicitly trusted).
 *   - `communityAuthor` — the `community/<author>/` namespace, when applicable.
 *   - `hash` / `installed` — joined from the paired `skills.lock` (null when
 *     the lock has no entry for this skill).
 *   - `overridesGlobal` — set on a repo-tier entry that shadows a global skill
 *     of the same name (the per-session loader's repo-wins precedence).
 *   - `lastUsed` / `useCount` / `usedRepos` — the #5554 Phase 2 usage rollup
 *     (lastUsed null + count 0 when never recorded).
 */
export const SkillInventoryEntrySchema = z.object({
    name: z.string(),
    description: z.string(),
    source: z.enum(['global', 'repo']),
    activation: z.enum(['auto', 'manual']),
    active: z.boolean(),
    providers: z.array(z.string()),
    version: z.string().nullable(),
    trustState: z.enum(['trusted', 'pending']).nullable(),
    communityAuthor: z.string().nullable(),
    hash: z.string().nullable(),
    installed: z.string().nullable(),
    overridesGlobal: z.boolean().optional(),
    lastUsed: z.string().datetime().nullable(),
    useCount: z.number().int().nonnegative().finite(),
    usedRepos: z.array(z.string()),
});
/**
 * #5554 — one surveyed repo's skill overlay. `skills` is the repo-local
 * `.chroxy/skills/` overlay (empty when the repo has no overlay — absence is
 * signal, not an error). `error` carries a per-repo scan-failure reason so a
 * single broken overlay degrades to a chip on that card rather than a dead
 * snapshot.
 */
export const SkillInventoryRepoSchema = z.object({
    name: z.string(),
    path: z.string(),
    skills: z.array(SkillInventoryEntrySchema),
    error: z.string().nullable(),
});
/**
 * #5554 — full Skills inventory snapshot, emitted in reply to a
 * `skills_inventory_request` (see client.ts). `global` is the
 * `~/.chroxy/skills/` tier; `repos` are the per-repo overlays for the surveyed
 * repo set (same set the host / integration surveys resolve). `globalError`
 * degrades the global tier the same way a repo `error` degrades a repo card.
 * `root` is the Control Room discovery root the repo set was resolved under.
 * Same degraded-snapshot-with-`error` posture as the sibling surveys: on a
 * forbidden / in-progress / failed request the handler returns an otherwise
 * valid empty snapshot plus the top-level `error`.
 */
export const ServerSkillsInventorySnapshotSchema = z.object({
    type: z.literal('skills_inventory_snapshot'),
    requestId: z.string().max(128).nullable().optional(),
    generatedAt: z.string().datetime(),
    root: z.string(),
    global: z.array(SkillInventoryEntrySchema),
    globalError: z.string().nullable().optional(),
    repos: z.array(SkillInventoryRepoSchema),
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
/**
 * #5547: reply to a `summarize_session` request — the model-written
 * continuation brief built from the session's persisted history. Sent only to
 * the requesting client. `summary` is the editable brief the dashboard seeds
 * into the create-session composer; `truncated` flags that the history was
 * windowed before summarization (the brief's header also notes this).
 * `sessionId` echoes the source session, `requestId` correlates the click.
 * Failures surface separately as a `SUMMARIZE_FAILED` session_error echoing
 * `sessionId` / `requestId`.
 */
export const ServerSummarizeSessionResultSchema = z.object({
    type: z.literal('summarize_session_result'),
    sessionId: z.string(),
    summary: z.string(),
    truncated: z.boolean().optional(),
    requestId: z.string().max(128).nullable().optional(),
}).passthrough();
