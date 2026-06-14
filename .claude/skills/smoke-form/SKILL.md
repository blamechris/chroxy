---
description: "Generate an interactive, **self-contained HTML smoke-test form** that guides a human through a manual verification pass — the hand-driven sibling of `/smoke-..."
---

# /smoke-form

Generate an interactive, **self-contained HTML smoke-test form** that guides a
human through a manual verification pass — the hand-driven sibling of
`/smoke-test` (which runs an automated browser pass). Use it before releases,
after a feature batch lands, or whenever a change set needs eyes on a real
device.

The output is a single dark-mode `.html` file with inline CSS/JS (no external
dependencies, no network): collapsible sections per test area, a checkbox +
result dropdown + notes field per item, progress tracking, localStorage
persistence (progress survives reloads), and a **Copy Results** button that
serializes everything the tester entered into paste-ready markdown.

## Arguments

- `$ARGUMENTS` - What to build the checklist from, plus optional flags:
  - Free text = the scope (e.g. `the last two epics`, `PRs #51-#58`,
    `release v1.2 gate`). If empty, infer from the session: what merged or
    changed recently that a human should verify.
  - `--dir PATH` — output directory (overrides the default below).
  - `--no-open` — write the file but don't launch the browser.

## Output location (resolution order)

1. `--dir PATH` if given.
2. `$CLAUDE_BRIEF_DIR` if set (point at an Obsidian vault subfolder, e.g.
   `~/Obsidian/no-it-all/briefs`); else `~/.claude/briefs/` (created if missing).
   Also drop a copy at the chroxy repo root (untracked) when the scope is a
   chroxy release gate, so it sits next to the session logs.

Filename: `smoke-form-<slug>-<YYYY-MM-DD>.html` (slug from the scope; never
overwrite — append `-2`, `-3` on collision).

## Instructions

### 1. Derive REAL test items — never invent

The form is only as good as its checklist. Ground every item in what actually
changed:

- Pull the real change set for the scope: `gh pr list --state merged`,
  `git log --oneline`, closed issues/epics, release notes. Read PR bodies for
  "needs manual verification" / "before release" notes — those are mandatory
  items.
- For each change, write the test as a USER ACTION with an observable outcome,
  not a restatement of the implementation ("Open the picker, click the
  discovered server, confirm a 6-digit code appears" — not "verify pairing
  works").
- Include the standing baseline checks that every smoke pass needs regardless
  of the change set:
  - Chroxy.app launches and the server child binds :8765 (`curl localhost:8765/health` reports the expected version)
  - Dashboard loads with the keychain token (`http://localhost:8765/dashboard?token=$(security find-generic-password -s chroxy -a api-token -w)`)
  - A session starts, streams a reply, and the Discord status embed updates
  - Mobile app connects (QR or LAN) and mirrors the session
- Note per-item **prerequisites** (device, simulator, second machine, network
  conditions) so the tester can batch items by setup:
  Booted iOS simulator + Metro (`npx expo start` from packages/app) + the dev client (`npx expo run:ios` — Expo Go cannot load the app); mock server on :9876 for chat-renderer flows (`bash packages/app/.maestro/scripts/start-mock-server.sh`); a second machine/phone on the same wifi for LAN/pairing items; Node 22 for any server command; Discord webhook configured (keychain `chroxy-discord-webhook` or `CHROXY_DISCORD_WEBHOOK_URL`) for notification items.

Group items into 4–8 sections by surface or setup (not by PR number). Order
sections so setup flows naturally (e.g. everything needing the same device is
adjacent). 3–10 items per section; split bigger sections.

### 2. Each item carries

- **Title** — imperative, one line.
- **Steps** — numbered, concrete, with exact commands/URLs/buttons. A tester
  who didn't write the code must be able to follow them.
- **Expected** — the observable pass condition, stated plainly.
- **Source** — the PR/issue reference(s) this item verifies (rendered as links).
- **Prereq chip** — if it needs special setup (device, second machine, etc.).

### 3. Build the HTML — structure and behavior contract

Single file, inline `<style>` and `<script>`, zero external requests. The
tester may open it weeks later from a different machine — it must work from
`file://`.

**Theme:** dark mode, system font stack, comfortable line height. Use one
accent color for interactive elements and result-state colors: pass=green,
fail=red, blocked=amber, skipped=gray. Respect `prefers-reduced-motion`.

**Layout, top to bottom:**

1. **Sticky header**: title, scope, generated date, live progress
   (`N of M checked · X pass / Y fail / Z blocked`), and two buttons:
   - **Copy Results** — serializes the ENTIRE form state to markdown and
     copies to clipboard (see format below). Show a "Copied ✓" flash.
   - **Reset** — clears state after a confirm dialog.
2. **Tester metadata row**: free-text inputs for tester name, build/version
   under test, device/environment — each with its own note placeholder.
3. **Sections** as `<details>` dropdowns (open by default), each with a
   section-level progress count in the `<summary>`.
4. **Items**: each row has —
   - a **checkbox** (tested = touched this item),
   - a **result `<select>`**: `— / Pass / Fail / Blocked / Skipped`,
   - the title, steps (collapsible if long), expected outcome, source links,
   - a **notes `<input>`/`<textarea>` beside every field** with a
     placeholder hinting what to record ("what you saw, device, repro…").
     Notes are per-item, always visible, never hidden behind a click.
   - Row border/left-edge tints with the selected result color.

**Behavior:**

- Every input persists to `localStorage` keyed by the file's slug+date
  (restore on load; checkbox auto-checks when a result is chosen).
- **Dictation (progressive enhancement):** if `window.SpeechRecognition ||
  window.webkitSpeechRecognition` exists, render a small round 🎤 button beside
  every note field and tester-metadata input. Click → start recognition
  (`continuous: true`, final results only, `lang` from `navigator.language`),
  appending each final transcript to the field (space-joined) and persisting;
  button pulses red while recording, click again (⏹) to stop; only one active
  recorder at a time. Errors (mic permission, offline) surface via the button
  tooltip — never an alert. Where the API is absent the button simply doesn't
  render. Title-hint the privacy caveat: Chromium relays audio to Google's
  speech service; macOS users can always use built-in Dictation instead.
- Progress counts update live in header and section summaries.
- **Copy Results markdown format** (exact):

```markdown
# Smoke test: <scope> — <date>
Tester: <name> · Build: <build> · Env: <env>
Result: X pass / Y fail / Z blocked / W skipped / U untested

## <Section>
- [x] **<Item title>** — PASS — <note if any>
- [x] **<Item title>** — FAIL — <note>
- [ ] **<Item title>** — (untested)
```

  Use `navigator.clipboard.writeText` with a `document.execCommand('copy')`
  fallback (file:// clipboard quirks). Failed items list their notes verbatim —
  this paste goes straight into a bug report or release-gate comment.

### 4. Write, verify, open

- Write the file to the resolved directory.
- Sanity-check your own output: `python3 -c "import html.parser; ..."` or at
  minimum confirm balanced tags by re-reading the rendered structure; confirm
  the file has NO external `src=`/`href=` network references.
- Open it (`open <file>` on macOS / `xdg-open` on Linux) unless `--no-open`.
- Tell the user: path, item count by section, and any items you could NOT
  ground in a real change (there should be none — flag, don't fabricate).

### 5. Tone and scope discipline

- The form is for a HUMAN under time pressure: terse steps, no filler prose.
- Don't pad the checklist — ten well-grounded items beat thirty vague ones.
- Anything already covered by green automated tests does not need a manual
  item UNLESS it has a visual/device component automation can't see.
  Server node:test + dashboard/store-core vitest + app jest suites run in CI on every PR; the 20 Maestro flows (`packages/app/.maestro/run-all.yaml`) cover mobile UI on a simulator; `/smoke-test` drives the dashboard headless via Playwright. Manual items should target what those cannot see: real-device feel (latency, scroll, keyboard), multi-machine flows (LAN pairing, tunnel fallback), Discord-side rendering, and anything flagged "needs simulator/device pass" in PR bodies.
