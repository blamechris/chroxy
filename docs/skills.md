# Skills

Skills are reusable instruction snippets that Chroxy injects into every session you start. They let you encode personal conventions, project standards, or any recurring guidance once and have every provider (Claude SDK, Claude CLI, Codex, Gemini) automatically apply it.

## Where skill files live

Chroxy reads skills from `~/.chroxy/skills/`. Each skill is a plain Markdown file:

```
~/.chroxy/skills/
├── coding-style.md
├── commit-format.md
└── debugging-approach.md
```

Create the directory if it does not exist:

```bash
mkdir -p ~/.chroxy/skills
```

## Writing a skill

A skill file is just Markdown — no frontmatter, no special syntax required. The filename (without `.md`) becomes the skill name. The first non-empty line is used as a short description in the `list_skills` response.

Example — `~/.chroxy/skills/coding-style.md`:

```markdown
Prefer explicit error handling over silent failures.

- Always propagate errors to the caller; do not swallow exceptions.
- Use descriptive variable names — prefer `userRecord` over `u`.
- Keep functions focused: one responsibility per function.
```

## Disabling a skill

Rename the file to end in `.disabled.md` instead of `.md`:

```bash
mv ~/.chroxy/skills/coding-style.md ~/.chroxy/skills/coding-style.disabled.md
```

Rename it back to re-enable it. No restart required — skills are loaded fresh at session start.

## How injection works per provider

| Provider | Injection method |
|----------|-----------------|
| Claude SDK (`sdk` / Docker) | Appended to the session system prompt via `systemPrompt.append` |
| Claude CLI (`cli`) | Passed as `--append-system-prompt` when the CLI process starts |
| Codex | Prepended to the first user message of the session |
| Gemini | Prepended to the first user message of the session |

Skills are combined under a `# User skills` header, separated by `---` dividers, and only sent once per session.

## Listing active skills

Send a `list_skills` WebSocket message from any connected client to receive the current skill list. The server replies with a `skills_list` message containing each skill's name and description.

## Sharing skills

Because skills are plain files in a directory, sharing them is straightforward:

```bash
# Share via git
cd ~/.chroxy/skills
git init
git remote add origin git@github.com:you/my-chroxy-skills.git
git push -u origin main

# Pull on another machine
git clone git@github.com:you/my-chroxy-skills.git ~/.chroxy/skills
```

## Scope

Skills in this release (v1, issue #2957) are global — they apply to every session regardless of provider or project. Per-skill metadata (author, version, trust level) and a UI toggle are planned for v2 (#2958, #2959).

## Example skill files

See [`docs/skills-examples/coding-style.md`](skills-examples/coding-style.md) for a ready-to-use starting point.
