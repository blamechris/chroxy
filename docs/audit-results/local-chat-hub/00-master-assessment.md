# Master Assessment: Local Desktop Chat Hub for Chroxy

**Audit Date**: 2026-02-24
**Target**: Building a local desktop chat hub -- a unified interface for managing Claude Code terminal sessions, inspired by Chell.sh
**Agents**: 6 (4 core + 2 extended)
**Aggregate Rating**: 2.8 / 5

---

## a. Auditor Panel

| # | Agent | Perspective | Rating | Key Contribution |
|---|-------|-------------|--------|------------------|
| 1 | Skeptic | Claims vs reality | 3.0/5 | Discovered existing Tauri app at `packages/desktop/` + dashboard gap analysis |
| 2 | Builder | Implementability | 3.8/5 | Phase 1 MVP (5-day polish) vs Phase 2 (React rewrite) roadmap |
| 3 | Guardian | Safety & failure modes | 3.0/5 | Multi-client conflicts, non-atomic config writes, orphaned processes |
| 4 | Minimalist | YAGNI & complexity | 2.0/5 | "200 lines of dashboard fixes vs 5000-line React rewrite" analysis |
| 5 | Operator | UX walkthrough | 2.5/5 | First-run dead screen, zero client persistence, accessibility at near-zero |
| 6 | Historian | Prior art & competition | 3.0/5 | Claude Code Desktop overlap, "wrapper extinction" pattern, competitive landscape |

---

## b. Consensus Findings

### Consensus 1: A Tauri Desktop App Already Exists (6/6 agents)

All six agents independently discovered that `packages/desktop/` contains a working Tauri v2 app with:
- Server lifecycle management (`server.rs`: start/stop/restart/health-poll)
- Node 22 resolution (`node.rs`: Homebrew/nvm/fnm/volta/raw paths)
- Tray icon with menu (`lib.rs`)
- Autostart at login (`settings.rs`)
- Dashboard WebView management (`window.rs`)
- First-run config generation (`setup.rs`)

**Action:** Do not build a new desktop app. Evolve what exists.

### Consensus 2: Dashboard Is the Weak Link (6/6 agents)

All agents agree that `dashboard.js` (1756 lines, vanilla JS template literal) is functional but severely limited:
- No client-side persistence (messages lost on window close)
- No terminal view (`raw` events ignored)
- No syntax highlighting
- No accessibility (2 ARIA attributes total)
- Surfaces ~30-40% of server capabilities
- Not maintainable as a template literal monolith

**Action:** The dashboard needs improvement, but agents disagree on *how* (see Contested Points).

### Consensus 3: Mobile + Remote Is the Differentiator, Not Desktop (5/6 agents)

Skeptic, Builder, Minimalist, Operator, and Historian agree that Chroxy's genuine differentiation is:
- Mobile-first remote access from any device
- Cloudflare tunnel-based zero-config connectivity
- Push notifications for permission prompts
- QR code scan connection flow
- Voice input from phone

The desktop chat hub moves Chroxy *toward* Claude Code Desktop's feature set and *away* from its unique value.

**Action:** Desktop improvements should complement the mobile experience, not compete with Claude Code Desktop.

### Consensus 4: Client-Side Persistence Is the #1 Missing Feature (5/6 agents)

Skeptic, Builder, Minimalist, Operator, and Historian identify the same gap: the dashboard loses all visual state when the window is closed. The server replays only the last conversation turn. For a "daily driver" desktop app, this is the single highest-impact fix.

**Action:** Add `localStorage` or IndexedDB persistence for messages per session. Estimated effort: 20-50 lines.

### Consensus 5: xterm.js Terminal View Is the #2 Missing Feature (4/6 agents)

Skeptic, Builder, Operator, and Historian agree that the absence of terminal output in the dashboard is a critical gap. The mobile app has full xterm.js emulation. On desktop, xterm.js can run natively without a WebView wrapper.

**Action:** Add xterm.js to the dashboard with a chat/terminal view switcher. Estimated effort: 100-200 lines + library import.

---

## c. Contested Points

### Contest 1: Polish Dashboard (Vanilla JS) vs React Rewrite

**Minimalist & Skeptic (partially):** Polish the existing 1756-line dashboard. Add localStorage, xterm.js, syntax highlighting, sidebar. ~200 lines of changes, 1-week effort. Don't introduce a build system, bundler, or framework.

**Builder & Operator:** Rewrite in React + TypeScript inside `packages/desktop/src/`. Port mobile app patterns (Zustand store, component model, type safety). 2-3 week effort, but produces a maintainable, extensible codebase.

**Assessment:** Both positions have merit. The Minimalist path gets results faster but creates maintenance debt (a 2000-line template literal is not sustainable). The Builder path is more work upfront but aligns with the mobile app's architecture. **Recommendation: Phase 1 polishes the existing dashboard (1 week); Phase 2 considers React rewrite only if the desktop hub proves its value.**

### Contest 2: Desktop Hub as Product vs Desktop as Infrastructure

**Builder & Operator:** The desktop hub should be a first-class product with sidebar sessions, rich UI, accessibility, keyboard shortcuts, and feature parity with the mobile app.

**Minimalist & Historian:** The desktop app should be invisible infrastructure (tray icon + daemon manager). The "product" is the mobile app and the server. The dashboard is a monitoring/interaction tool, not a flagship UI.

**Assessment:** The Historian's "wrapper extinction" argument is compelling -- Claude Code Desktop already ships most desktop hub features. But the Builder's point about the existing Tauri foundation is also valid. **Recommendation: Ship a polished dashboard (not a bare monitoring tool), but don't try to match Claude Code Desktop feature-for-feature. Focus on what Chroxy uniquely enables: multi-device session continuity.**

### Contest 3: Extract `packages/shared/` Now vs Later

**Builder:** Extract shared WS protocol types now to prevent divergence between mobile and desktop.

**Minimalist:** Premature. Only 2 consumers (mobile + dashboard). Copy types when needed; extract at 3+ consumers.

**Assessment:** The Minimalist is right for Phase 1. If Phase 2 React rewrite happens, extraction becomes necessary at that point.

---

## d. Factual Corrections

| Claim | Correction | Found By |
|-------|------------|----------|
| "Need to build a desktop app" | A Tauri v2 desktop app already exists at `packages/desktop/` | All agents |
| "Dashboard is just a simple page" | It's 1756 lines with full WS protocol, sessions, permissions, plan mode, markdown | Skeptic, Builder |
| "No session persistence" | Server persists sessions to `~/.chroxy/session-state.json` with 24h TTL; the gap is *client-side* persistence in the dashboard | Skeptic, Operator |
| "Chell.sh is the only competitor" | At least 5 other Claude Code GUI projects exist (ClaudeCodeUI, Crystal, Opcode, Claudia, Claude Terminal) | Historian |

---

## e. Risk Heatmap

```
                    IMPACT
                Low    Med    High   Critical
           ┌────────┬────────┬────────┬────────┐
  Certain  │        │        │ A      │        │
           ├────────┼────────┼────────┼────────┤
  Likely   │        │ E      │ B      │        │
           ├────────┼────────┼────────┼────────┤
L Possible │        │ D      │ C      │        │
I          ├────────┼────────┼────────┼────────┤
K Unlikely │        │        │        │ F      │
E          └────────┴────────┴────────┴────────┘
L
I  A = Feature overlap with Claude Code Desktop (high impact, certain)
H  B = Dashboard maintainability debt (high impact, likely)
O  C = Multi-client input conflicts (high impact, possible)
O  D = Config file corruption on crash (med impact, possible)
D  E = Orphaned processes on force-kill (med impact, likely)
   F = Anthropic ships mobile Claude Code (critical, unlikely near-term)
```

---

## f. Recommended Action Plan

### Priority 1: Dashboard Quick Wins (1 week)
*Consensus: 5/6 agents agree. Unblocks daily use.*

1. **Add localStorage persistence** for chat messages per session
2. **Add xterm.js terminal view** with chat/terminal view switcher
3. **Add desktop notifications** for permission prompts (via Tauri notification plugin or Notification API)
4. **Add startup loading state** to replace the dead "Server Not Running" fallback page

### Priority 2: Dashboard Polish (1 week)
*Builder + Operator recommend. Makes dashboard usable as daily driver.*

5. **Add syntax highlighting** for code blocks (highlight.js or Prism.js)
6. **Enrich session tabs** with busy dot, health indicator, working directory
7. **Add permission countdown timer** (port logic from mobile's `PermissionCountdown`)
8. **Add reconnect backoff** (match mobile app's escalating delay pattern)

### Priority 3: Safety Hardening (2-3 days)
*Guardian's findings. Prevents data loss and confusion.*

9. **Atomic config writes** (write-to-temp + rename pattern)
10. **Session input locking** (prevent simultaneous input from multiple clients)
11. **Process group cleanup** on server shutdown

### Priority 4: Accessibility Foundations (2-3 days)
*Operator's findings. Legal/ethical requirement for a public project.*

12. **Add ARIA roles** (tablist, tab, log, alertdialog, aria-live)
13. **Add keyboard focus management** (tab navigation for session tabs, `/` to focus input)
14. **Add `prefers-color-scheme`** media query for light mode

### Priority 5 (Deferred): React Frontend Rewrite
*Builder recommends, Minimalist opposes. Only if Phase 1-4 prove desktop demand.*

15. Create `packages/desktop/src/` with Vite + React + TypeScript
16. Extract `packages/shared/` for protocol types
17. Port connection store and component patterns from mobile app

### NOT Recommended
- Building a "competing desktop chat app" to Claude Code Desktop
- Multi-agent grid/split view (Chell feature, high complexity, low necessity)
- Cloud sync for session state (local-first is the right pattern)
- Abandoning the Tauri shell (it works well for its purpose)

---

## g. Final Verdict

**Aggregate Rating: 2.8 / 5**

*Weighted calculation: Core panel (1.0x weight): Skeptic 3.0 + Builder 3.8 + Guardian 3.0 + Minimalist 2.0 = 11.8/4 = 2.95. Extended panel (0.8x weight): Operator 2.5 + Historian 3.0 = 5.5/2 = 2.75. Weighted average: (2.95 * 4 + 2.75 * 2 * 0.8) / (4 + 2 * 0.8) = (11.8 + 4.4) / 5.6 = 2.89 ~ 2.9.*

The "local desktop chat hub" concept is **partially implemented and strategically questionable in its ambitious form.** A Tauri v2 desktop app with server lifecycle management already exists. A 1756-line web dashboard with full WS protocol support already exists. The gap is not architectural -- it's polish: client-side persistence, terminal view, notifications, accessibility.

The biggest strategic risk is building a second-class version of what Claude Code Desktop ships first-class. Chroxy's genuine differentiation is mobile-first remote access via Cloudflare tunnel -- a capability no competitor matches. The recommended path: polish the existing dashboard inside the existing Tauri shell (2 weeks of focused work), then assess whether the desktop experience warrants a larger investment based on actual user demand.

---

## h. Appendix: Individual Reports

| # | Agent | File | Rating |
|---|-------|------|--------|
| 1 | Skeptic | [01-skeptic.md](./01-skeptic.md) | 3.0/5 |
| 2 | Builder | [02-builder.md](./02-builder.md) | 3.8/5 |
| 3 | Guardian | [03-guardian.md](./03-guardian.md) | 3.0/5 |
| 4 | Minimalist | [04-minimalist.md](./04-minimalist.md) | 2.0/5 |
| 5 | Operator | [05-operator.md](./05-operator.md) | 2.5/5 |
| 6 | Historian | [06-historian.md](./06-historian.md) | 3.0/5 |
