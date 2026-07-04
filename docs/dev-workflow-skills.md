# Dev-workflow skills (the `/skill` registry)

> **Heads up — "skills" means two unrelated things in Chroxy.** This page is about the **dev-workflow `/skill` system**: slash-command playbooks (like `/full-review`, `/check-pr`, `/create-issue`) used by people *building* Chroxy, compiled into each coding agent's native custom-command format. They are a **contributor tool** and have **no runtime role** — they never touch a Chroxy session.
>
> The *other* "skills" are **[runtime skills](skills.md)**: Markdown files in `~/.chroxy/skills/` that Chroxy injects into a live session's prompt. If you're a Chroxy *user* wanting to shape model behaviour, you want those, not this page.

## What it is

Chroxy's development workflow is driven by reusable slash commands. Their neutral source lives in `.claude/commands/*.md`, and they are fetched/customized from a shared registry (`blamechris/skill-templates`) via a `/skill` client — think `npm`/`brew`, but for `.claude/commands/*.md`. There is no push-deploy: skills install **on demand**.

```
/skill add <name>       # resolve from the registry → fetch generic/<name>.md →
                        #   fill its {{CUSTOMIZE}} markers from this repo's
                        #   CLAUDE.md + .claude/skill-profile.md + code →
                        #   write .claude/commands/<name>.md → compile to native
                        #   targets → record in .claude/skills.lock
/skill list             # what's installed
/skill outdated         # which installed skills drifted from their template
/skill update [name]    # refresh a drifted skill
/skill remove <name>    # uninstall
```

**Install-on-miss.** If `/X` is requested but not present, check the neutral source `.claude/commands/X.md`: if it's missing, the skill isn't installed — run `/skill add X`. If the source exists but the native artifact (`.claude/skills/X/SKILL.md`) is missing, it just wasn't compiled — run `node scripts/compile-skill-targets.mjs --name X`.

## Model-agnostic compile (multi-target)

`.claude/commands/<name>.md` is the provider-**neutral** source. `scripts/compile-skill-targets.mjs` compiles each skill into every coding agent's **native** custom-command format, so the same skill is first-party under whichever model drives development:

| Target | Output | Version-controlled? |
|--------|--------|---------------------|
| `claude` | `.claude/skills/<name>/SKILL.md` (the v2.1.x "skills" path — the legacy `.claude/commands/` slash-command discovery is broken upstream, so Claude loads from here) | ✅ in-repo |
| `gemini` | `.gemini/commands/<name>.toml` (TOML; `$ARGUMENTS` → `{{args}}`) | ✅ in-repo |
| `codex` | `~/.codex/prompts/<name>.md` (invoked `/prompts:<name>`; **user-global**, not project-scoped) | ❌ per-machine |

## Codex is opt-in and off by default

The active target list is the `targets:` line in `.claude/skill-profile.md`. **This repo ships `targets: claude, gemini`** — both in-repo and version-controlled. **`codex` is deliberately *not* in that default**, so a fresh clone never writes to an unaware machine's `~/.codex`.

That means a contributor driving Chroxy development *with Codex* gets none of the dev-workflow slash commands until they opt in. To get them, compile with the codex target explicitly:

```bash
# Compile every installed skill to the Codex prompt format (~/.codex/prompts/*.md)
node scripts/compile-skill-targets.mjs --targets codex

# ...or add codex to your local profile so future compiles include it (per-machine;
# don't commit this if you're the only Codex user — it would write to others' ~/.codex)
#   targets: claude, gemini, codex   in .claude/skill-profile.md
```

Codex reads these from `~/.codex/prompts/` and you invoke them as `/prompts:<name>`. (Codex CLI still supports `~/.codex/prompts/`; recent versions additionally ship a `~/.codex/skills/` directory — the emitter targets the stable prompts path.) Why user-global instead of in-repo like `gemini`? Codex custom prompts have no project-scoped location, so the emitter writes to `~/.codex` — which is exactly why it's kept out of the committed default (see the reject-outside-intended-dirs guard in `compile-skill-targets.mjs`).

With no `targets:` line the compiler falls back to `claude` only. After editing a skill's neutral source by hand, recompile: `node scripts/compile-skill-targets.mjs --name <name>` (`--dry-run` to preview).

### Discoverability hint

When you compile, `compile-skill-targets.mjs` prints a one-line hint if it detects an agent's home directory (`~/.codex`, `~/.gemini`) whose target you did **not** select — a nudge so a Codex or Gemini user doesn't silently miss the skills. It never adds the target for you (that would write to a home dir you didn't ask about); it just tells you the flag to pass.

## Two things called skills

| | **Runtime skills** ([skills.md](skills.md)) | **Dev-workflow skills** (this page) |
|---|---|---|
| **Who it's for** | Chroxy **users** shaping model behaviour in a session | **Contributors** building Chroxy |
| **What it is** | Instruction snippets injected into the model's prompt | Slash-command playbooks (`/full-review`, `/check-pr`, …) |
| **Where it lives** | `~/.chroxy/skills/*.md` + `<repo>/.chroxy/skills/*.md` | `.claude/commands/*.md` → compiled to native targets |
| **Needs a running Chroxy?** | **Yes** — injected at session start | **No** — a build-time authoring tool |
| **Provider-agnostic?** | **Yes** — injected for any provider (with optional `providers:` scoping) | Compiled per coding agent (claude / gemini / codex) |
| **How invoked** | Auto-injected; listed via `list_skills` | `/full-review` etc. in your coding agent |
| **Source of truth** | Your files | The `blamechris/skill-templates` registry via `/skill` |

## A third, external "skills": Pi Coding Agent

The [Pi Coding Agent](https://github.com/earendil-works/pi) has its own "skills" ecosystem — a **separate, external** system that does not interoperate with either Chroxy system above. Emitting Chroxy's dev-workflow skills into Pi's native format is tracked as a future compile target in #6573.

## See also

- [`docs/skills.md`](skills.md) — runtime skills (the user-facing, session-injected system).
- `CLAUDE.md` → **Skills (pull-based registry)** — the contributor-facing operational detail (kept as the single source of truth; `AGENTS.md` is generated from it for agents that don't read `CLAUDE.md`).
