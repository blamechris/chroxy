# Chroxy chat redesign — keep navy, port structure

**Status:** design spec / not yet scheduled · **Date:** 2026-06-26
**Scope:** dashboard + mobile chat surfaces · three pillars: chat & tool rendering, composer, visual polish & motion. **Session navigation is out of scope.**

## 1. Decision & north star

Make Chroxy's chat feel like the **Claude desktop app's Code mode** — the chat grammar people already find calm and legible — while **keeping Chroxy's existing cool-navy theme**. We port the *structure and rhythm*, not the palette. The one remote-native addition the desktop app can't have is a **presence rail**: a continuous left-edge spine that reflects "what is my machine doing right now" at a glance.

This direction came out of the `chroxy-design-language` multi-agent workflow (run `wxvn7aruh`): a *Claude-Faithful* spine (scored highest on fidelity to what we actually want) with the *presence rail*, *op-card grammar*, and *composer state-lozenge* grafted on from the runner-up. The original synthesis proposed a warm paper/ember repalette; **that is explicitly rejected here** — we stay navy.

**Coherence is enforced by tokens, not by hand:** one `@chroxy/design-tokens` package single-sources the structural + motion tokens (and the existing navy palette), feeding the dashboard's CSS variables and mobile's `COLORS`, with a CI hex-lint gate.

## 2. Calibration (measured against the real app)

Calibrated against the live Claude desktop app (Code tab) via screenshots. Findings that **corrected** the original synthesis:

1. **Diffs render inline in the chat** (green-bg `+` / red-bg `−`, gutters, syntax preserved) — not in a side modal. The inline-diff proposal *matches* the reference; the side File-viewer / git working-tree panels are separate surfaces.
2. **Thinking is a compact turn-footer stat**, e.g. the spark + `19s · 82 tokens · thought for 4s`, with a live `almost done thinking…` while streaming — **not** a standing "Thought for Ns" block. This is calmer; we adopt it (the original spec's demoted-block treatment is dropped).
3. **Tool groups collapse to a natural-language summary** — "Ran a command, created 2 files, used 2 tools", "Searched for TODO comments under cx-calib" — not a count like "Bash×4, Read×2". We generate a human sentence per group.

Confirmed: no-bubble assistant on bare canvas + a rounded user card; one base body size (~15px) at ~1.6 line-height; the composer layout; measured syntax/diff palette. One bonus — the app renders todo updates *minimally* ("Updated todos"), so Chroxy's existing rich `TodoList` renderer is a place we can **exceed** it.

## 3. Tokens — structural, over the existing navy palette

**Colors are unchanged.** Keep `packages/dashboard/src/theme/theme.css` verbatim (`--bg-primary: #0f0f1a`, `--accent-blue: #4a9eff`, `--accent-purple: #a78bfa`, diff `#1a2e1a`/`#2e1a1a`, syntax keyword `#c4a5ff` / string `#4eca6a` / number `#ff9a52`, …). The redesign adds *structural* tokens and *role mappings* on top.

### 3.1 New structural tokens

**Type scale** (today's is cramped — base 13, lg only 16). Add a chat reading size and relax:

| token | now | proposed | use |
|---|---|---|---|
| `--text-xs` | 10 | 11 | timestamps, meta |
| `--text-sm` | 12 | 12 | chrome, chips |
| `--text-base` | 13 | 13 | UI default |
| `--text-chat` | — | **15** | **chat body (new)** |
| `--text-md` | 14 | 16 | section labels |
| `--text-lg` | 16 | 18 | headings |
| `--text-xl` | — | 22 | rare large |

Line-heights (new): `--leading-tight 1.35` · `--leading-normal 1.5` · `--leading-chat 1.6` · `--leading-code 1.5`.

**Spacing** — keep the existing 4px grid (`--space-1..8`); add `--space-5: 20px`.

**Radii** (new): `--radius-xs 4` · `--radius-sm 6` (op cards) · `--radius-md 10` (message cards, composer) · `--radius-lg 14` (sheets) · `--radius-pill 999`.

**Motion** (new): `--dur-fast 150ms` · `--dur-base 200ms` · `--dur-slow 280ms` · `--ease-out cubic-bezier(.2,.8,.2,1)` · `--ease-standard cubic-bezier(.4,0,.2,1)`. Loop timings: caret-blink 1100ms · rail-heartbeat 1200ms · rail-breathe 2400ms · waiting-pulse 1600ms. **One rail loop animates at a time**; everything gated by `prefers-reduced-motion` (web) and `AccessibilityInfo.isReduceMotionEnabled` (mobile — currently unwired).

### 3.2 Role mappings (reuse existing navy hues)

**Tool-kind colors** (single-sourced for both clients):

| kind | token | hex |
|---|---|---|
| read | `--accent-blue` | `#4a9eff` |
| edit | `--accent-orange` | `#f59e0b` |
| exec / bash | `--accent-purple` | `#a78bfa` |
| write | `--accent-green` | `#22c55e` |
| search | blue (lighter) | `#6ea8ff` |

**Presence-rail state → color/motion:**

| state | color | motion |
|---|---|---|
| idle | `--border-secondary #3a3a5e` | static |
| thinking | `--accent-blue` | breathe 2.4s |
| streaming | `--accent-blue` | downward heartbeat 1.2s |
| tool-running | active tool-kind color | — |
| waiting-on-you | `--accent-blue` solid | node ring pulse 1.6s |
| error | `--text-error #ff5b5b` solid | static (stillness distinguishes it from waiting) |

**Diff / syntax** — use the existing `--diff-*` and `--syntax-*` tokens as-is.

### 3.3 The token package

Stand up `@chroxy/design-tokens` as the canonical TS token map and **invert the pipeline**: tokens flow *from* the package → `generate-theme-tokens.mjs` emits `theme.css` + `tokens.ts` and feeds mobile `COLORS` (stable key names). The existing navy palette + 9 built-in themes are preserved; the package just becomes their single source. CI hex-lint gate forbids raw color literals in styling files (scoped to component/theme/StyleSheet files; excludes generated xterm bundles, error-code/status strings, tests).

## 4. Pillar change lists

Surface = `dashboard` / `mobile` / `both` / `shared`. Effort = S/M/L. File paths relative to repo root.

### 4.1 Chat & tool rendering

| change | surface | effort | files |
|---|---|---|---|
| **No-bubble three-tier hierarchy** — strip bubble chrome from assistant responses (bare canvas), keep the user card. *(Corrected: thinking → §4.1 footer-stat, not a demoted block.)* Highest-value rendering decision. | both | M | `packages/dashboard/src/components/ChatMessage.tsx`, `…/theme/components.css`, `packages/app/src/components/chat/MessageBubble.tsx` |
| **Thinking as a turn-footer stat** — render thinking as compact footer metadata (`spark · Xs · N tokens · thought for Ms`; live `almost done thinking…`), expandable to reveal content; no standing block. Driven by timestamps store-core already carries. | both | S–M | `packages/dashboard/src/components/ChatMessage.tsx`, `packages/app/src/components/chat/MessageBubble.tsx` |
| **One op-card grammar** — merge `ToolBubble` (single) and `ToolGroup`/`ActivityGroup` (multi): a ~32px collapsed row = tool-kind glyph + verb + dimmed target + right-aligned duration chip, on a rail segment. Group = a stacked deck under a **natural-language summary header** ("Read the entry point, edited the server, ran the tests · 3 steps"); last-running expanded, completed auto-collapse; 180ms height ease. | both | L | `packages/dashboard/src/components/ToolBubble.tsx`, `…/ToolGroup.tsx`, `packages/app/src/components/chat/ToolBubble.tsx`, `…/ActivityGroup.tsx` |
| **Canonical verb→glyph→color registry** (`tool-presentation.ts`) in store-core — defined once, imported by both clients; wire `formatToolName`/`getInputSummary` through it. Pure data, dependency-free. | shared | M | `packages/store-core/src/handlers/index.ts`, both `ToolBubble.tsx` |
| **Inline diffs** — a card with `+`/`−` gutter columns, tinted add/del backgrounds (existing `--diff-*`), syntax highlight inside changed lines, `+12 −3` header. Dashboard reuses the web highlighter; **mobile renders gutter + per-token color via the existing `MarkdownRenderer` tokenizer (spike first to size it)**. | both | L | `packages/dashboard/src/lib/markdown.ts`, `…/DiffViewerPanel.tsx`, `packages/app/src/components/MarkdownRenderer.tsx`, `…/DiffViewer.tsx` |
| **Auto-collapse long output** past a shared named threshold (~16 lines / ~2KB; diffs ~40) behind a "Show N more lines" pill, re-collapsible. Threshold exported from store-core so both surfaces match. | both | M | `packages/store-core/src/buildChatViewMessages.ts`, both `ToolBubble.tsx` |
| **Streaming block caret** (2px, 1.1s blink when paused / solid while tokens flow) on the measured tail node, append-only, no reflow. Mobile uses Reanimated. | both | M | `packages/dashboard/src/components/ChatView.tsx`, `…/components.css`, `packages/app/src/components/ChatView.tsx`, `…/AnimatedMessage.tsx` |
| **Linkify file paths** (underline-on-hover → `openFile` intent); keep `TodoWrite` first-class with an in-progress ring + header progress bar (exceeds the desktop app's minimal todo). | both | S | `packages/dashboard/src/lib/markdown.ts`, `…/TodoList.tsx`, `packages/app/src/components/MarkdownRenderer.tsx`, `…/chat/TodoList.tsx` |
| **Unify error chips** (`StreamStallChip`, `ResumeUnknownChip`, `AskUserQuestionStallChip`) into one alert frame: icon + headline + detail + action row, error code drives icon/color, constant layout. | both | M | both `StreamStallChip.tsx`, `ResumeUnknownChip.tsx`, `packages/dashboard/src/hooks/useMessageRenderer.tsx` |

### 4.2 Composer

| change | surface | effort | files |
|---|---|---|---|
| **State lozenge + live hairline** — composer top edge adopts the canonical `ActivityState` color; left lozenge reads "◐ streaming · +2 queued". Fixes the binary `isBusy` ambiguity; gives queue-while-processing a native home. | both | M | `packages/dashboard/src/components/InputBar.tsx`, `…/App.tsx`, `packages/app/src/components/InputBar.tsx`, `…/screens/SessionScreen.tsx` |
| **send↔stop morph** — one state-driven control (send glyph → stop square, 150ms cross-fade, no layout jump) instead of a separate button; always-visible low-opacity keyhint ("⏎ send · ⇧⏎ newline"); mobile's cryptic 28px toggle becomes labeled. | both | S | both `InputBar.tsx` |
| **Categorized slash + @ menus** — Session / Codebase / Provider group headers, per-item glyph + description + source badge. Dashboard = inline dropdown; mobile = bottom sheet of the *same* item model. | both | M | `packages/dashboard/src/components/SlashCommandPicker.tsx`, both `InputBar.tsx` |
| **Queued messages in-thread** as ghost segments (dashed rail connector, 0.7 opacity, cancel affordance, position number) using the existing `queuedIds`; attachment chips gain a count summary. | both | S | both `ChatView.tsx` |

### 4.3 Visual polish & motion

| change | surface | effort | files |
|---|---|---|---|
| **`@chroxy/design-tokens`** — canonical TS token map (structural tokens + existing navy palette); invert `generate-theme-tokens.mjs` to read it; emit `theme.css`/`tokens.ts` + feed mobile `COLORS`; CI fails on stale output. | shared | L | `packages/dashboard/scripts/generate-theme-tokens.mjs`, `…/theme/theme.css`, `…/theme/tokens.ts`, `packages/app/src/constants/colors.ts` |
| **Canonical activity state machine** — merge mobile-only `deriveActivityState` with store-core `deriveSessionStatus` into one function both clients read; the rail + composer lozenge both consume it. | shared | M | `packages/store-core/src/activity-selectors.ts`, `packages/app/src/store/session-activity.ts`, `…/store/message-handler.ts` |
| **Presence rail** — one cheap layer driven by the single state value (CSS-var on dashboard, one Reanimated shared value on mobile), **not** per-row animation; continuous left spine, color = state, one capped loop; must survive dashboard virtualization; static fallback under reduced-motion. | both | L | `packages/dashboard/src/components/ChatView.tsx`, `…/useWindowedRange.ts`, `…/components.css`, `packages/app/src/components/ChatView.tsx` |
| **Card chrome + motion vocabulary** — 10px-radius cards, hairline borders, depth via surface-lightness steps (dark-only, no light-mode shadows), message-enter fade+8px-rise (200ms, 30ms stagger), 180ms collapse/expand; replace ad-hoc transitions with the named duration/ease tokens. | both | M | `packages/dashboard/src/theme/components.css`, `…/global.css`, `packages/app/src/components/AnimatedMessage.tsx` |
| **Reduced-motion gating on mobile** (`AccessibilityInfo.isReduceMotionEnabled`, currently never read) as a global hook; confirm `prefers-reduced-motion` coverage on dashboard. | both | S | `packages/app/src/components/AnimatedMessage.tsx`, `packages/dashboard/src/theme/global.css` |
| **CI hex-lint gate** — forbid raw color literals in styling files outside the token package (scope to component/theme/StyleSheet; exclude generated xterm bundles, error/status strings, tests). | shared | S | `packages/dashboard/src/theme/theme.css`, `packages/app/src/constants/colors.ts` |

## 5. Signature moments

- **The presence rail** — breathes while thinking, heartbeats while streaming, takes the active tool's color while a tool runs, rings when waiting on you. Chroxy's face; the thing the desktop app can't do because it isn't remote.
- **No-bubble assistant + footer-stat thinking** — the calm three-tier hierarchy, with reasoning reduced to a quiet `thought for Ns` footnote.
- **Color-coded op-cards under a human summary** — a long agent run reads as a scannable colored timeline instead of a text wall.
- **A composer that knows the machine is alive** — live state hairline + "◐ streaming · +2 queued" lozenge, killing the binary busy ambiguity.

## 6. Phased rollout

- **Phase 0 — Foundation (ship thin, first):** `@chroxy/design-tokens` (structural tokens + single-sourced navy palette); invert `generate-theme-tokens.mjs`; CI hex-lint; merge the activity state machine; add `tool-presentation.ts`. *(No repalette — navy stays.)*
- **Phase 1 — Quick wins:** relaxed type-scale token swap; no-bubble three-tier hierarchy + footer-stat thinking; send↔stop morph + keyhint + labeled mobile toggle; composer lozenge + live hairline; auto-collapse long output; categorized slash/@ menus.
- **Phase 2 — Signature & dense output:** op-card grammar unify (natural-language group headers); presence rail (dashboard first to validate virtualization, then mobile); streaming caret; unified error alert frame; queued ghost segments.
- **Phase 3 — Inline diffs & polish:** inline diff cards (**spike the mobile renderer first** — no RN syntax highlighter); wire mobile reduced-motion; file-path linkify + `openFile`; `TodoWrite` progress ring; motion polish; Maestro pass + dashboard visual smoke-test.

## 7. Open questions / decisions

- **Presence-rail scope:** chat view only for v1, or extend to terminal view / Control Room / session tabs (so "recognizable from across the room" holds everywhere)? Extending is real extra surface area.
- **Mobile inline diffs:** acceptable to ship Phases 1–2 with mobile diffs still in the modal `DiffViewer` and land inline mobile diffs in Phase 3 after a spike, or is inline-everywhere a hard v1 requirement?
- **Mobile light mode:** the rejected paper/ember direction would have given mobile a light theme for free. Staying navy, mobile remains dark-only — confirm that's fine to defer.
- **Footer-stat thinking:** confirm replacing the standing thinking block entirely (calibrated against the real app), with an expand affordance to reveal reasoning when present.
- **The 9 built-in themes:** kept as-is (no repalette). Confirm none should be pruned while the token package re-sources them.

## 8. Risks

- **Mobile inline diff** is the riskiest item — no RN syntax highlighter exists; gutter + per-token rendering must be built by hand. Spike before committing the estimate.
- **Presence rail under virtualization** — the dashboard's windowed list means the rail must paint per-pane against scroll offset, not per-row; get this right once on the dashboard before porting to mobile.
- **Token-pipeline inversion** touches the build (`generate-theme-tokens.mjs`); land Phase 0 thin and behind CI so a stale generated file fails loudly rather than drifting.

---

*Source: design workflow run `wxvn7aruh` (synthesis in the session task output), calibrated against the live Claude desktop app. Interactive mockups produced in the design session. See project memory `chat-redesign-keep-navy-port-structure`.*
