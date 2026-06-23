/**
 * Skills inventory survey (#5554) + summarize-session result (#5547): the Control Room Skills tab (names/metadata only — never skill bodies) and the model-written continuation brief.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
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
export declare const SkillInventoryEntrySchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    source: z.ZodEnum<{
        repo: "repo";
        global: "global";
    }>;
    activation: z.ZodEnum<{
        auto: "auto";
        manual: "manual";
    }>;
    active: z.ZodBoolean;
    providers: z.ZodArray<z.ZodString>;
    version: z.ZodNullable<z.ZodString>;
    trustState: z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>>;
    communityAuthor: z.ZodNullable<z.ZodString>;
    hash: z.ZodNullable<z.ZodString>;
    installed: z.ZodNullable<z.ZodString>;
    overridesGlobal: z.ZodOptional<z.ZodBoolean>;
    lastUsed: z.ZodNullable<z.ZodString>;
    useCount: z.ZodNumber;
    usedRepos: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * #5554 — one surveyed repo's skill overlay. `skills` is the repo-local
 * `.chroxy/skills/` overlay (empty when the repo has no overlay — absence is
 * signal, not an error). `error` carries a per-repo scan-failure reason so a
 * single broken overlay degrades to a chip on that card rather than a dead
 * snapshot.
 */
export declare const SkillInventoryRepoSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        source: z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>;
        activation: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        active: z.ZodBoolean;
        providers: z.ZodArray<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        trustState: z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>>;
        communityAuthor: z.ZodNullable<z.ZodString>;
        hash: z.ZodNullable<z.ZodString>;
        installed: z.ZodNullable<z.ZodString>;
        overridesGlobal: z.ZodOptional<z.ZodBoolean>;
        lastUsed: z.ZodNullable<z.ZodString>;
        useCount: z.ZodNumber;
        usedRepos: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
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
export declare const ServerSkillsInventorySnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_inventory_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    global: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        source: z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>;
        activation: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        active: z.ZodBoolean;
        providers: z.ZodArray<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        trustState: z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>>;
        communityAuthor: z.ZodNullable<z.ZodString>;
        hash: z.ZodNullable<z.ZodString>;
        installed: z.ZodNullable<z.ZodString>;
        overridesGlobal: z.ZodOptional<z.ZodBoolean>;
        lastUsed: z.ZodNullable<z.ZodString>;
        useCount: z.ZodNumber;
        usedRepos: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    globalError: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        skills: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
            source: z.ZodEnum<{
                repo: "repo";
                global: "global";
            }>;
            activation: z.ZodEnum<{
                auto: "auto";
                manual: "manual";
            }>;
            active: z.ZodBoolean;
            providers: z.ZodArray<z.ZodString>;
            version: z.ZodNullable<z.ZodString>;
            trustState: z.ZodNullable<z.ZodEnum<{
                pending: "pending";
                trusted: "trusted";
            }>>;
            communityAuthor: z.ZodNullable<z.ZodString>;
            hash: z.ZodNullable<z.ZodString>;
            installed: z.ZodNullable<z.ZodString>;
            overridesGlobal: z.ZodOptional<z.ZodBoolean>;
            lastUsed: z.ZodNullable<z.ZodString>;
            useCount: z.ZodNumber;
            usedRepos: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
export declare const ServerSummarizeSessionResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"summarize_session_result">;
    sessionId: z.ZodString;
    summary: z.ZodString;
    truncated: z.ZodOptional<z.ZodBoolean>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
