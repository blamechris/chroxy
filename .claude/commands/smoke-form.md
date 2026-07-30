# /smoke-form

Generate an interactive, **self-contained HTML smoke-test form** that guides a
human through a manual verification pass — the hand-driven sibling of
`/smoke-test` (which runs an automated browser pass). Use it before releases,
after a feature batch lands, or whenever a change set needs eyes on a real
device. With its **wake-on-save loop** (section 6 + `assets/smoke-intake.mjs`),
the tester's Pass / Pass-with-note / Fail marks **stream live to the driving
agent**, which triages and files issues in real time — no copy-paste, no waiting.

The output is a single dark-mode `.html` file with inline CSS/JS (no external
dependencies, no network): collapsible sections per test area, a checkbox +
result dropdown + notes field per item, progress tracking, localStorage
persistence (progress survives reloads), and a **Copy Results** button that
serializes everything the tester entered into paste-ready markdown. Every command
in the steps is **click-to-copy**, and each item has **🆘 Need help** / **🖥
Terminal** buttons that hand the item's context (+ the tester's notes) to an
assisting agent — so a tester who's mid-task, even playing the app under test,
gets unblocked in one tap.

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
- If the form can only be run after a **deploy/restart** (the app must be at a
  specific build — e.g. boot-loaded code a page reload won't pick up), make the
  FIRST item a **build-precondition gate**: the exact redeploy/restart command +
  how to confirm the live build matches (a `/build` or version check), with a
  hard "if it doesn't match, STOP". A tester validating a stale build produces
  false fails that look like real regressions — this trap is worth a dedicated item.
- **Open with a labeled UI-region map / glossary** whenever the test targets a
  visual app or overlay. BEFORE the first item, name and locate every on-screen
  region the checklist will reference — e.g. "top-left status bar = hero name +
  placement", "prediction modal = the win/tie/loss bar under it", "Reference tabs
  = Minions / Powers / Comps". An annotated screenshot with callouts is ideal. A
  tester who doesn't share the codebase's vocabulary cannot run an item that says
  "check the face-damage chip" — they don't know what that is or where to look.
  Give them the map first so every later item can simply *point*. (Straight from a
  live tester: "Assume the tester doesn't know where these things are. Don't just
  refer to them by name — point out where you expect it, what it looks like.")
- **Open EVERY section with a "⚙ Before this section — make sure these are running"
  prereq box.** The region map is global; this is per-section. Before a section's
  first item, list the exact services/apps/state that must be up to run it — each
  with its click-to-copy start command — written so a tester with **zero app
  knowledge** can satisfy them. If the driving agent normally starts something (a
  server), say so explicitly ("the agent starts this") AND give the manual command
  as a fallback. (This generalizes the build-precondition gate below from one global
  gate to per-section preconditions. Straight from a live tester who got stranded on
  a section because nothing told them an overlay app had to be launched: "list out
  what needs to be in play before every section — the tester shouldn't need to
  understand the application; that's the whole goal of this flow.")

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

**Atomicity + Steps↔Expected discipline (the QA rigor that makes the form
trustworthy — a tester runs this deliberately, not by inference):**

- **One observable check per item.** Each item verifies ONE thing with ONE pass
  condition. Never bundle independent verifications — "launches without a crash"
  + "no white box" + "a second launch doesn't duplicate" + "a log line appears"
  are FOUR items, not one. If an item's Expected has multiple "AND" clauses
  testing unrelated behaviors, split it.
- **Every Expected clause must trace to a numbered Step.** Expected states the
  observable result of the listed Steps and nothing else. If verifying something
  needs an action (e.g. "launch it a second time", "drag the window"), that
  action IS a numbered Step — never assert in Expected the result of an action
  the tester was never told to perform.
- **Make observation explicit.** When a check needs the tester to look at and
  *report* something rather than judge a clean pass/fail, add an explicit Step —
  "note what you saw, and where" — with a notes prompt. Never smuggle a "go
  observe X" requirement into the Expected line; if you need information from the
  tester, ask for it as a step.
- **Anchor every UI reference to a named region + what it looks like.** Never
  refer to an element by an internal/code name alone — say WHERE it is on screen
  and WHAT it looks like: "the small grey line UNDER the win/tie/loss bar", "the
  Tier header row reading 'Tier 3 · N'", not "the staleness caveat" or "the tier
  group". This is the per-item enforcement of the region map above; assume the
  tester has never seen the code and doesn't know your names for things. An item
  that names a behavior with no visual anchor leaves the tester guessing what's
  even being checked.

A tester must be able to execute the Steps top-to-bottom and judge each Expected
without inferring any hidden action. When in doubt, split the item.

### 3. Build the HTML — structure and behavior contract

Single file, inline `<style>` and `<script>`, zero external requests. The
tester may open it weeks later from a different machine — it must work from
`file://`.

**Theme:** dark mode, system font stack, comfortable line height. Use one
accent color for interactive elements and result-state colors matching the five
statuses: pass=green, note=sky-blue, fail=red, skip=gray, need-help=amber.
Respect `prefers-reduced-motion`.

**Layout, top to bottom:**

1. **Sticky header**: title, scope, generated date, live progress
   (`N of M checked · X pass / N notes / Y fail / Z need help`), and two buttons:
   - **Copy Results** — serializes the ENTIRE form state to markdown and
     copies to clipboard (see format below). Show a "Copied ✓" flash.
   - **Reset** — clears state after a confirm dialog.
2. **Tester metadata row**: free-text inputs for tester name, build/version
   under test, device/environment — each with its own note placeholder.
3. **Sections** as `<details>` dropdowns (open by default), each with a
   section-level progress count in the `<summary>`.
4. **Items**: each row has —
   - a **checkbox** (tested = touched this item),
   - a **result control with FIVE statuses** that map to what the agent does with
     them — this status set is load-bearing (a live tester found the 4-status model
     forced them to misuse "Fail" or "🆘" for "it works but I have a note"):
     - **✅ Pass** — works, nothing to say → agent does nothing.
     - **💡 Pass + note** — *works, but I have feedback* → agent files an
       **enhancement**. (The bridge from smoke-test to backlog; distinct color, e.g.
       sky-blue. This is the status most feedback lands on — don't omit it.)
     - **❌ Fail** — broken / a regression → agent files a **bug** (higher priority).
     - **⏭ Skip** — not tested / N/A → nothing.
     - **🆘 Need help** — *I'm blocked right now* → agent helps live (synchronous).
       Distinct from 💡: 🆘 interrupts, 💡 is async feedback.
   - the title, steps (collapsible if long), expected outcome, source links,
   - a **notes `<input>`/`<textarea>` beside every field** with a
     placeholder hinting what to record ("what you saw, device, repro…").
     Notes are per-item, always visible, never hidden behind a click.
   - **Per-item agent-assist actions** for a hands-busy tester (e.g. playing the
     app under test): a **🆘 Need help** button that copies a self-contained help
     request — the item's title + steps + expected + the tester's per-item AND
     session/metadata notes + the build under test — to paste straight back to
     the driving agent; and a **🖥 Terminal** button that copies a single-line
     `claude "…"` command (quotes/newlines sanitized so it pastes into any shell)
     seeded with the same context to spin up a fresh session. Both flag the item
     amber, and reuse the same clipboard fallback as Copy Results.
   - Row border/left-edge tints with the selected result color.

**Behavior:**

- Every input persists to `localStorage` keyed by the file's slug+date
  (restore on load; checkbox auto-checks when a result is chosen).
- **Per-mark timestamp + "carried over" staleness (the reuse model).** A form is
  ONE dated pass; reopening it CONTINUES that pass. So a status must record **WHEN**
  it was set (`at`, set in `setStatus`) and the item must SHOW it — "✓ marked just
  now / 3h ago". A mark older than a `STALE_MS` threshold (~30 min), **or one with no
  timestamp** (made before this field existed), renders as **"↩ carried over from an
  earlier pass — re-confirm?"** with a dashed left-border + an amber tint, and the
  header shows an "N ↩ carried over" count. This stops a stale Pass from silently
  reading as a fresh one across sessions/builds — the tester re-confirms it (one click
  → "just now") or trusts it deliberately. **Make the reuse intentional:** for a NEW
  change set, generate a NEW form (new slug/date) rather than reopening an old one;
  reopening is only for continuing an in-progress pass. State this in the form's intro.
- **Dictation (progressive enhancement):** if `window.SpeechRecognition ||
  window.webkitSpeechRecognition` exists, render a small round 🎤 button beside
  every note field and tester-metadata input. Click → start recognition
  (`continuous: true`, `interimResults: true`, `lang` from `navigator.language`),
  appending each FINAL transcript to the field (space-joined) and persisting;
  button pulses red while recording, click again (⏹) to stop; only one active
  recorder at a time. Errors (mic permission, offline) surface via the button
  tooltip — never an alert. Where the API is absent the button simply doesn't
  render. Title-hint the privacy caveat: Chromium relays audio to Google's
  speech service; macOS users can always use built-in Dictation instead.
  **"You are being heard" signal:** show a strong live indicator under the
  field being dictated into — a `● recording…` label (pulsing dot) + a live
  **interim-transcript preview** (the not-yet-final text, distinct/dimmed from the
  committed text, replaced on each event), and outline the active item. Keep the
  pure split (interim vs final) + append/merge in a testable helper.
- **Per-item screenshot paste:** the per-item notes accept a pasted
  (`Ctrl+V`) or dropped image — store it WITH that item's result, show a dark
  thumbnail frame on the item, and (when the repo customizes an online
  results-intake mode) include it in the POST to the intake. Guard each image to
  a sane cap (~2.5 MB decoded); oversize → a visible note, never a silent drop.
  Intake side: decode the base64 data-URL to a file under
  `<results>.jsonl.files/` and store a `{file,bytes,mime}` ref in the row
  (keeps the JSONL small + greppable). Multiple items each carry their own shots.
- **Click-to-copy commands (essential for a multitasking tester):** every
  `<code>`/`<pre>` block is click-to-copy — click anywhere on it to copy its
  text, with a brief flash + toast. Detect terminal commands (text starting
  `npm `/`node `/`curl `/`git `/`gh `/`cd `/`http`/`<ENV>=`) and render them as
  prominent, obviously-tappable chips with a `⧉ copy` affordance, so each command
  is a one-tap target. `stopPropagation` so copying a command inside a
  collapsible header doesn't also toggle it.
- Progress counts update live in header and section summaries (count notes
  separately from fails, e.g. `N notes · M fail · K need-help`).
- **Live wake-on-save POST (the loop's client half — see section 6):** detect
  online mode with `const ONLINE = /^https?:$/.test(location.protocol)` (true when
  served by the intake server, false from `file://`). When ONLINE, `postResult(id)`
  POSTs `{id, title, section, status, notes, build, ts}` to `/result` (a) on every
  status change and (b) debounced on note edits for `fail`/`help`/`note` items.
  **Dedup**: keep a `_lastSent[id]` signature of `status+notes` and skip the POST
  when unchanged (otherwise focus/toggle re-pings the agent endlessly). Wrap in
  try/catch — a failure just leaves the answer in localStorage for Export. Show a
  header badge: **🟢 live — auto-files** (online) vs **💾 offline** (file://). From
  `file://` the form degrades to localStorage + Copy Results, unchanged.
- **Copy Results markdown format** (exact) — note the dedicated feedback section so
  the next agent sees what *worked-but-was-flagged* apart from what *broke*:

```markdown
# Smoke test: <scope> — <date>
Tester: <name> · Build: <build> · Env: <env>
Result: X pass / N notes / Y fail / W skipped / Z need help / U untested

## ⚠️ Needs attention (fail / need-help)
- ❌ **<Item title>** — <note>

## 💡 Passed with feedback (file as enhancements)
- 💡 **<Item title>** — <note>

## All results
- ✅ **<Item title>** — <note if any>
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
- **LIVE / VISUAL ONLY — never put a purely back-end check in front of a human.**
  The manual pass is exclusively for what a person at the running app can SEE or
  DO. CLI output, API routes/status codes, parser or function return shapes,
  numeric/statistical correctness (scores, percentages, sort orders) — those are
  UNIT tests, not smoke items. If you catch yourself writing "run `X`, confirm the
  output is `Y`" with no on-screen component, move it to the test suite and leave
  it off the checklist entirely. A human's time is for the things automation
  fundamentally can't observe: layout, rendering, real-device input, "does it
  feel right." (Build-precondition gates like a redeploy/version check are the one
  exception — they protect the live pass itself.)

### 6. Live wake-on-save mode (the loop — strongly recommended)

The form alone makes the tester paste a markdown summary back when they finish. The
**wake-on-save loop** removes that wait entirely: results stream to the driving agent
as the tester marks them, and the agent files issues **in real time**. Battle-tested
live; this is the flow to reach for whenever you (the agent) can stay attached.

Three parts:

1. **The form** (this skill) — generated with the section-6 POST wiring above, so each
   mark hits `/result` when served online.
2. **The intake server** — `assets/smoke-intake.mjs`. **It is not installed with this
   skill.** `skill add` / `skill update` write only `.claude/commands/<name>.md`, so
   the asset has to be fetched the same way `/skill` fetches its own compiler — from a
   local registry clone if there is one, over the network otherwise:

   ```bash
   # local clone (preferred; $REG is the resolved registry path)
   mkdir -p tools && cp "$REG/assets/smoke-intake.mjs" tools/

   # no clone on disk — fetch it, and fail loudly rather than half-fetching
   set -o pipefail
   gh api repos/blamechris/skill-templates/contents/assets/smoke-intake.mjs \
     --jq '.content' | base64 -d > tools/smoke-intake.mjs || exit 1
   [ -s tools/smoke-intake.mjs ] || { echo "intake server fetch failed" >&2; exit 1; }
   ```

   Track it in the project once fetched, so it travels with the repo. It serves the
   form AND appends every result to
   `<form>.results.jsonl` next to it. Generic + dependency-free:
   ```bash
   node tools/smoke-intake.mjs <form.html>   # serves http://127.0.0.1:8770/ , writes <form>.results.jsonl
   ```
   The tester opens the served URL (badge reads 🟢 live), not the `file://` path.
3. **The wake-monitor + triage (agent side)** — the agent tails the results file for
   actionable statuses and is woken on each, then triages with `/create-issue`:
   ```bash
   # arm AFTER the file may already exist; start at end so only NEW marks wake you
   F="<form>.results.jsonl"; until [ -f "$F" ]; do sleep 2; done
   tail -n 0 -F "$F" | grep --line-buffered -E '"status":"(fail|help|note)"'
   ```
   On each wake: read the FULL note from the JSONL (the wake event truncates), then —
   **`fail` → file a bug**, **`note` → file an enhancement**, **`help` → answer/assist
   live**. Use `/create-issue` for the filing (one grouped issue per surface, not one
   per micro-nit; dedup against issues already filed this session). Notes can grow as
   the tester edits — re-read before filing; the dedup in the form prevents identical
   re-pings.

**Setup discipline for the agent:** before telling the tester "go", (a) start every
service the form's prereq boxes name (or confirm it's their job), (b) start the intake
server, (c) arm the wake-monitor. Confirm all three are up with one health check.
Tear down (stop the monitor, kill the intake server) when the tester says the pass is
done, and back up the `.results.jsonl` (the filed issues are the durable output, but
keep the raw record).

**Offline fallback is automatic:** opened from `file://` the form still works
(localStorage + Copy Results) — the loop is a strict enhancement, never a requirement.

<!-- skill-templates: smoke-form eb1a1e5 2026-07-30 -->
