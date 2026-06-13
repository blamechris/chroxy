# Operator's Audit: Daily UX Friction

**Agent**: Operator — walks every flow as a real phone + desktop user; weights reconnect, voice, a11y
**Overall Rating**: 3 / 5 (§5 next-moves vs real daily pain)
**Date**: 2026-06-13

---

Headline: the report's instinct is right (reconnect + voice are the felt pain) but two priorities are miscalibrated — #5674 is essentially shipped, #5631 barely touches daily Claude use, and the genuine live bug it under-rates (#5668 silent voice revert) is concretely confirmed in the wiring.

## Per-item UX verdict (friction = frequency × hurt)
| Item | Frequency | Hurt | Friction | Verdict |
|---|---|---|---|---|
| #5623/#5613 stale "Observing" flash | High (every drop) | Medium (false "observing" + audible SR alarm; ~1s) | **HIGH** | Server re-emit (#5737) shrinks but doesn't close — neither client clears `sessionRole` on disconnect. |
| #5668 mic silent revert (desktop) | Low-med | **High** (headline feature appears broken, no explanation) | **HIGH** | Confirmed live: error captured in hook, never rendered. |
| #5674 mobile attribution | Medium | — | **LOW (mostly done)** | Label + containment shipped; residual = no per-tab "needs you" signal. |
| #5631 model metadata | Low | Low-med (raw-id label; blank cost on Codex/Gemini only) | **LOW-MED** | Over-weighted; server authoritative for Claude cost. |
| #5622 reconnect-storm | Rare | Low (server CPU, invisible to 1-2 device user) | **LOW** | Already de-amplified by #5724. |
| harness-preamble | Every session | — (invisible plumbing) | **LOW (felt)** | Nice-to-have, not a papercut. |

## Top 5 papercuts that most erode "use chroxy instead of the CLI"
1. **Voice failure is silent on desktop (#5668).** `useVoiceInput` captures the error (`useVoiceInput.ts:300`, sets `error`+reverts `isRecording`) — but the `voiceInput` prop passed to InputBar (`InputBar.tsx:85-92`) **omits `error`**, and `App.tsx:2132` never reads `voiceInput.error` (returned at `useVoiceInput.ts:479`). The mic flips on for a frame, flips off, says nothing. **Fix: add `error` to the prop and render it.**
2. **Stale "Observing" flash on every reconnect (#5623).** `app/src/store/connection.ts:1195-1248` (`onclose`) clears streaming/plan/inactivity across sessions but **never `sessionRole`/`primaryClientId`**. Dashboard identical (`dashboard/src/store/connection.ts:1682-1707`). #5737 fixed the server re-emit, not the client flash. **Fix: clear `sessionRole`/`primaryClientId` in both onclose transient-clears (symmetric, cheap).**
3. **No per-tab "blocked on you" signal on mobile (#5674 residual).** The prompt label shipped (`MessageBubble.tsx:63-73,374-380`) but the session-tab pill (`SessionPicker.tsx:102-108`) renders crash/busy/notification/shells dots — **no pending-permission indicator**. A background session blocked on a permission looks identical to one just thinking. Dashboard has `derivePendingPermissionSessions`/`selectNextPendingSession`; mobile doesn't.
4. **Model labels degrade to raw ids (#5631, the real-felt half).** `modelInfo?.label || activeModel` (`SettingsBar.tsx:318`) falls back to raw id. Dashboard's `model-pricing.ts` mislabels `claude-sonnet-4-5` as "Claude 3.7 Sonnet" (line 30), no opus-4-7/sonnet-4-6/fable. But cost impact is contained: `calculateCost` is only a fallback for Codex/Gemini (`message-handler.ts:3693-3706`); Claude cost comes from the server (`models.js:62-100`, current, has `claude-fable-5`). Daily Claude user sees an ugly raw-id label, not a blank cost. The two-table drift is the defect.
5. **Reconnect a11y false alarm (compounds #5623).** `ObserverBanner` is `accessibilityRole="alert"` + `accessibilityLiveRegion="polite"` (`ObserverBanner.tsx:54-56`). Stale role survives the drop → every reconnect re-announces "Observing — another device is driving" before clearing. Fixing #5623 fixes this for free.

## Accessibility gaps adjacent
- #5733 landed dashboard-only (`PermissionPrompt.tsx:200-202` `alertdialog`+`aria-live`, countdown muted — right).
- **Mobile has no "prompt arrived" announcement.** `PermissionDetail.tsx` has control labels + a polite countdown (399) but **no assertive live-region announcing a new prompt bubble** — the mobile parallel to #5733. Open a11y gap.
- ObserverBanner announces a soon-to-be-cleared state (finding 5).

## Recommended user-facing priority order
1. #5668 — surface voice errors (desktop). Tiny, kills "feature looks broken."
2. #5623/#5613 — clear `sessionRole` on disconnect (both clients). ~2 lines; most-frequent jank + a11y alarm.
3. #5674 residual — per-tab pending dot on mobile + assertive prompt announcement.
4. #5631 — collapse to one model table + fix the stale `claude-sonnet-4-5` label.
5. #5622 / harness-preamble — defer.

## Verdict: 3 / 5
§5 correctly identifies reconnect as the jank epicenter and is right to put #5674 last. But it **omits #5668's surfacing gap from the priority list** (only "confirm the mic"), yet that's a concretely-wired live bug on a headline feature; it **inflates #5631 to #4** when the real defect is server↔dashboard table drift, not UI-wide degradation; and it **over-weights #5622** as user-felt when it's server-CPU a 1-2 device user never notices.
