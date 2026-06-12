// claude-tui/form-driver.js — interactive AskUserQuestion form driver for ClaudeTuiSession.
//
// #5559 — pure-move extraction of the interactive-form driver out of
// claude-tui-session.js. respondToQuestion assembles the empirically-pinned
// keystroke sequences (project memory: tui_multi_question_form_keys,
// multi_question_post_deny_wedge) — digit auto-advance, Tab between multi-
// selects, the Submit-settle, the Other/freeform two-stage flow, arrow-nav for
// 10+ option picks — and the stall watchdog teardown. Bodies are moved
// BYTE-IDENTICAL; only the module location changed. The methods live on
// `FormDriverMixin` and are copied onto ClaudeTuiSession.prototype via
// applyMixin() in claude-tui-session.js, so `this` still refers to the session
// instance and every `this._*` reference resolves as before.
import { createLogger } from '../logger.js'

const log = createLogger('claude-tui-session')


// #4604 — watchdog window for the AskUserQuestion answer round-trip.
// respondToQuestion() writes ONE keystroke (the chosen option's digit)
// and assumes claude TUI emits PostToolUse shortly after. Multi-question
// AskUserQuestion forms violate that assumption: claude TUI renders a
// per-question form that needs additional keystrokes + a Submit, and
// PostToolUse never fires. Without this watchdog the session wedges at
// _isBusy=true forever (the 8m+ symptom in #4604). On expiry we clear
// _isBusy + _pendingUserAnswer and emit ASK_USER_QUESTION_STALL so the
// dashboard can prompt the user to retry. Root cause is fixed in Chunk B.
export const ASK_USER_QUESTION_WATCHDOG_MS = 30 * 1000

// #4651 — settle delay between the "Other" digit write and the freeform
// text write. After we press the Other digit, claude TUI swaps from the
// option-select menu to a text-input prompt. Writing the freeform text
// too quickly races that swap (the keystrokes land at the menu and jump-
// nav fires — same footgun as #4288). 150 ms covers the observed local-
// loop swap time with comfortable margin; tune via the empirical
// recording in scripts/tui-form-recorder.mjs if dogfood reveals a wedge.
const OTHER_FREEFORM_SETTLE_MS = 150

// #4651 — additional watchdog window granted after the Other digit lands
// so the freeform text write + claude TUI's text-input acknowledgement
// have time to complete. Without this, the existing 30s ASK_USER_QUESTION
// watchdog can fire mid-freeform-write on a slow PTY (laggy tunnel,
// emoji-heavy text) and tear down a turn that's actively progressing.
const OTHER_FREEFORM_WATCHDOG_MS = 30 * 1000

// #4635 — settle delay between the final single-select question's auto-
// advance digit and the Submit `'1'` keystroke. Mixed multi-question
// forms (with at least one multi-select) work fine because the explicit
// `'\t'` after each multi-select gives claude TUI a settled commit signal
// that fully renders the next screen before our next keystroke. But on a
// pure all-single-select form the LAST digit auto-advances to the Submit
// screen, and the 1ms per-char throttle writes the Submit `'1'` faster
// than claude TUI can render the Submit screen — so the `'1'` lands on
// the still-rendering last-question screen, gets swallowed, and the form
// never submits. The 30s ASK_USER_QUESTION watchdog then fires.
//
// 150 ms mirrors the empirically-validated OTHER_FREEFORM_SETTLE_MS used
// for the option-menu → text-input prompt swap (#4651) — same render-
// settling motivation, same observed magnitude. Only inserted when the
// final question in the sequence is single-select; mixed forms keep the
// pre-#4635 timing-free path (Tab's commit signal makes Submit settle
// naturally and the existing empirical recording pins the Tab + '1' run).
//
// #4882 (resolved 2026-06-07) — the fresh all-single-select recorder pass
// finally ran against a live claude TUI (v2.1.168) and is committed at
// `docs/empirical/4882-all-single-select-2q.jsonl`. A human driving a pure
// two-question all-single-select form submitted with the digit sequence
// `'2','2','1'` and the form committed on the Submit `'1'` ALONE — no
// trailing `\r` was pressed. So:
//   - The Submit screen accepts `'1'` (it does NOT require `\r`, and does
//     NOT auto-submit after the last digit — there IS a Submit screen).
//   - 150ms is kept (LOCKED): the human's natural gap before Submit was
//     ~4s, which confirms a settle works but gives no lower bound, so
//     tuning down isn't justified by this capture. 150ms mirrors the
//     OTHER_FREEFORM_SETTLE_MS render-settle magnitude (#4651) and the
//     #4635 wedge has not recurred, so it stays.
//   - The trailing `\r` below is now CONFIRMED unnecessary (the human
//     never sent it) but is retained as confirmed-harmless belt-and-braces
//     — see the comment at its `sequence.push('\r')` site. It is NOT
//     removed here because this recording covered only the 2-question
//     all-single-select shape; pulling the `\r` from the mixed and 3+q
//     paths it also feeds would be an overreach from a single-shape capture.
// The 30s ASK_USER_QUESTION watchdog remains the safety net for any shape
// not yet captured. Prior wedge analysis: #4635, #4867.
export const MULTI_QUESTION_SUBMIT_SETTLE_MS = 150

// --- interactive-form driver methods (mixed onto ClaudeTuiSession.prototype) ---
export class FormDriverMixin {
  /**
   * Send a response to an AskUserQuestion prompt (#4278, multi-question
   * support added in #4604 Chunk B). The dashboard's QuestionPrompt UI
   * fires this when the user submits. Two paths:
   *
   * - Single-question (`questions.length === 1`, the v0.9.4 happy path):
   *   write the 1-indexed option digit through the throttled writer,
   *   which appends \r. claude TUI's prompt accepts either; Enter is
   *   redundant but harmless. Pin-tested via #4290.
   *
   * - Multi-question (#4604 Chunk B): drive the inline form per the
   *   empirical key sequence captured by scripts/tui-form-recorder.mjs
   *   against claude CLI v2.1.158 (see tui_multi_question_form_keys
   *   memory). For each question:
   *     - single-select → write the digit (auto-advances to next q)
   *     - multi-select  → write each chosen digit (no advance) then
   *                       write Tab `\t` to commit + advance
   *   After the last question, focus lands on the Submit screen
   *   (`❯ 1. Submit answers / 2. Cancel`); write `'1'` to confirm.
   *   The whole sequence is wrapped in bracketed-paste-disable/re-enable
   *   exactly once and every visible char goes through the same
   *   per-char throttle the single-question path uses (#4269 paste
   *   detector defense).
   *
   * `answersMap` keys are the question text (`q.question`), values are
   * either the chosen option's label string (single-select) or a
   * JSON-encoded `["label1","label2"]` array / comma-joined list
   * (multi-select). Back-compat: when the dashboard only sends `text`
   * with no map (old client + multi-question form), defaults every
   * question to its first option and logs a WARN so the wedge is
   * visible in chroxy.log even though the session isn't stalled.
   *
   * No-op when no pending answer.
   *
   * @param {string} text — the chosen answer (single-question path); on the
   *   Other / freeform path (#4651) this is the Other option's label, used
   *   to resolve the 1-indexed TUI digit. Ignored on the multi-question
   *   path when answersMap is populated.
   * @param {object} [answersMap] — `{ [questionText]: string | string[] }`;
   *   required for multi-question forms (Chunk B).
   * @param {string} [toolUseId] — #4668: target the specific pending entry
   *   to answer when multiple AskUserQuestion tool_uses are in flight in
   *   the same turn. When omitted, falls back to the most-recently-set
   *   pending entry via the back-compat getter.
   * @param {object} [opts] — extra options.
   * @param {string} [opts.freeformText] — #4651 single-question Other path:
   *   when set, the session writes the Other digit (resolved from `text`),
   *   waits ~150 ms for claude TUI's option-menu → text-input prompt swap,
   *   then writes `freeformText` + Enter. Dropped when the chosen option
   *   doesn't exist or sits beyond the single-digit hotkey range.
   */
  respondToQuestion(text, answersMap, toolUseId, opts) {
    // #4668: route to the specific pending entry the dashboard answered
    // for. Pre-#4668 chroxy stored a single pending answer in a field
    // and respondToQuestion always read THAT field — so when claude TUI
    // emitted parallel AskUserQuestion tool_use blocks in one turn, the
    // field got overwritten and the user's answer landed in the wrong
    // toolUseId's slot. Now: if the dashboard supplied a toolUseId, look
    // it up in the Map; if not (legacy clients), fall back to the most-
    // recently-set entry via the back-compat getter so behaviour matches
    // pre-#4668 for the single-pending case.
    //
    // #4651: `opts.freeformText` triggers the Other / freeform path —
    // server resolves the chosen option label to its 1-indexed digit,
    // writes the digit to open claude TUI's text-input prompt, waits
    // ~150 ms for the prompt swap, then writes the freeform text + Enter
    // to submit. Mutually exclusive with answersMap (multi-question
    // Other is out of scope per #4648).
    const freeformText = (opts && typeof opts.freeformText === 'string' && opts.freeformText.length > 0)
      ? opts.freeformText
      : null
    let entry = null
    if (toolUseId && this._pendingUserAnswers.has(toolUseId)) {
      entry = this._pendingUserAnswers.get(toolUseId)
    } else if (toolUseId && this._pendingUserAnswers.size > 0) {
      // Dashboard sent a toolUseId we don't have a pending entry for.
      // Common cause: stale answer arriving after the turn's teardown
      // cleared the Map (watchdog fire, user gave up + the late answer
      // came in). Log + drop rather than write keystrokes into whatever
      // form happens to be currently rendered.
      // #4828: session-scoped — respondToQuestion runs strictly post-start.
      ;(this._log || log).warn(`respondToQuestion: dashboard sent toolUseId=${toolUseId} but no matching pending entry (Map.size=${this._pendingUserAnswers.size} keys=${[...this._pendingUserAnswers.keys()].join(',')}) — dropping`)
      return
    } else {
      // Legacy / unidentified path: route to the most-recent entry via
      // the back-compat getter. Maintains the pre-#4668 behaviour for
      // single-pending cases and for callers that haven't been updated
      // to pass toolUseId.
      //
      // #4688: warn when the dashboard omitted toolUseId AND we have
      // multiple pending entries — the back-compat fallback picks the
      // most-recent entry by insertion order, which may not be what
      // the user intended. Loud log so the wedge symptom is greppable.
      if (!toolUseId && this._pendingUserAnswers.size > 1) {
        // #4828: session-scoped.
        ;(this._log || log).warn(`respondToQuestion: dashboard omitted toolUseId but ${this._pendingUserAnswers.size} pending entries exist (keys=${[...this._pendingUserAnswers.keys()].join(',')}) — falling back to most-recent which may misroute`)
      }
      entry = this._pendingUserAnswer
    }
    const prevToolUseId = entry?.toolUseId || null
    const pendingQuestions = entry?.questions || []
    const answersMapKeyCount = answersMap && typeof answersMap === 'object' ? Object.keys(answersMap).length : 0
    // #4828: session-scoped.
    ;(this._log || log).info(`respondToQuestion: tool=${prevToolUseId || '?'} dashboardToolUseId=${toolUseId || 'none'} text.length=${(text || '').length} answersMap.keys=${answersMapKeyCount} questions=${pendingQuestions.length} options=${entry?.options?.length || 0} pendingMapSize=${this._pendingUserAnswers.size}`)
    if (!entry) return
    // #5320 (WP-3.3) — arm the stall watchdog the MOMENT we have a live pending
    // entry the dashboard tried to answer, BEFORE any early-return below. The
    // dashboard clears its QuestionPrompt UI when it sends an answer, so ANY
    // respondToQuestion that finds an entry but then bails — the unactionable
    // cases here (non-string / empty text + no answersMap), the validation drops
    // in the freeform path (no options, option-not-found), or `!this._term` —
    // would otherwise leave the turn wedged until the 2h hard cap with no
    // dashboard prompt. Arming here (it does NOT clear the pending) gives every
    // such path recovery; a real follow-up answer re-arms idempotently (same
    // key), and the success paths re-arm with a fresh post-write window (the
    // Other-freeform IIFE with its longer second-stage window).
    this._armAskUserQuestionWatchdog(prevToolUseId)
    // Single-question / free-text path requires a non-empty `text`. The
    // multi-question path is driven from answersMap (text is ignored when
    // a map is present) so an empty string is permitted there.
    if (typeof text !== 'string') return
    if (text.length === 0 && answersMapKeyCount === 0) return
    const { options } = entry
    const questions = pendingQuestions
    // #4668: clear only this specific entry; sibling pending answers
    // (from parallel AskUserQuestion calls in the same turn) survive.
    this._clearPendingAnswerByToolUseId(entry.toolUseId)
    if (!this._term) return
    // #4668 diagnostic: capture the PTY output tail just before we write
    // the answer keystroke. The wedge symptom observed 2026-06-01 was
    // "chroxy wrote bytes=1 → TUI silent for 30s → watchdog fires" with
    // no visibility into whether the TUI's input prompt was actually
    // ready to receive a digit. Logging the tail hex dump at write-time
    // tells us exactly what the TUI was showing when our keystroke
    // landed — single-keystroke wedges almost always come from a form
    // misalignment that's visible in the trailing render bytes.
    //
    // #4693: rate-limit to once per turn. The multi-question retry-as-
    // singles wedge fires 4+ respondToQuestion calls in succession; each
    // hex dump is ~70 lines (1024 bytes formatted 16/line + header), so an
    // unbounded emission pumps 280+ lines of diagnostic per affected turn.
    // We stash the emission flag on the active turn object so it resets
    // automatically on every new sendMessage() (which allocates a fresh
    // `_activeTurn`). Subsequent answers in the same turn emit a compact
    // one-line skip notice carrying the tool ids so a log reader can still
    // grep all answer-write events without scanning past 200+ hex lines.
    // #4792: PTY tail hex dumps are the highest-volume, most-sensitive
    // unscoped log lines pre-fix — they emit literal terminal bytes
    // (user prompts, answer text, attachment names) on every
    // respondToQuestion. Routing them through the session-bound logger
    // makes the audit story clean: only operators bound to this session
    // (or unbound) see the dump (#4787 fan-out filter).
    const slog = this._log || log
    const turn = this._activeTurn
    if (turn && !turn.hexDumpEmitted) {
      slog.info(`respondToQuestion PTY tail before write (tool=${prevToolUseId || '?'}):\n${this._outputTailHexDump()}`)
      turn.hexDumpEmitted = true
    } else if (turn) {
      slog.info(`respondToQuestion PTY tail hex dump skipped (tool=${prevToolUseId || '?'}) — already emitted for turn msg=${turn.messageId || '?'}`)
    } else {
      // No active turn (defensive — tests that drive respondToQuestion
      // directly without sendMessage(), late watchdog teardown races).
      // Emit the dump so the diagnostic is still useful in those paths.
      slog.info(`respondToQuestion PTY tail before write (tool=${prevToolUseId || '?'}):\n${this._outputTailHexDump()}`)
    }

    const armWatchdog = () => {
      // #4604: arm a stall watchdog. If claude TUI never emits PostToolUse
      // for this AskUserQuestion (a form shape we don't yet drive),
      // the watchdog clears _isBusy + _pendingUserAnswer and emits
      // ASK_USER_QUESTION_STALL so the dashboard prompts the user to
      // retry. Cancelled on PostToolUse (happy path) and on destroy().
      // #5319 (WP-3.2): keyed by this tool's id so a parallel sibling's arm
      // doesn't clobber it.
      this._armAskUserQuestionWatchdog(prevToolUseId)
    }

    // Single-question / no-questions-array path (back-compat with the
    // pre-Chunk-B happy path). Stay on _writePtyTextThrottled which
    // appends \r — TUI single-select auto-commits on digit, the trailing
    // Enter is redundant but harmless, and the existing test guards
    // (#4290) assert it's present. Requires non-empty `text`: the
    // single-q path is text-driven, not answersMap-driven.
    if (questions.length <= 1) {
      if (text.length === 0) return

      // #4651 — Other / freeform path. The dashboard picked the "Other"
      // option AND typed freeform text. claude TUI accepts this as a
      // two-stage flow: press the Other digit (swaps the option-select
      // menu to a text-input prompt), wait for the swap, then type the
      // freeform text + Enter. Resolve the chosen label → digit via the
      // same 1-indexed lookup as the happy path. When the chosen option
      // doesn't exist (or sits beyond the single-digit hotkey range),
      // drop the answer — blindly writing the freeform text at the
      // digit menu is the #4288 jump-nav footgun and the dashboard
      // shouldn't have been able to send freeformText for an
      // AskUserQuestion without an Other option in the first place.
      if (freeformText) {
        if (!Array.isArray(options) || options.length === 0) {
          // #4828: session-scoped.
          ;(this._log || log).warn(`respondToQuestion: freeformText supplied for question with no options (tool=${prevToolUseId || '?'}) — dropping`)
          return
        }
        const otherIdx = options.findIndex((o) => o && o.label === text)
        if (otherIdx < 0 || otherIdx >= 9) {
          // #4828: session-scoped.
          ;(this._log || log).warn(`respondToQuestion: freeformText supplied but chosen option "${text}" not found (or beyond single-digit hotkey range) in pending options for tool=${prevToolUseId || '?'} — dropping`)
          return
        }
        const otherDigit = String(otherIdx + 1)
        // Stage 1: write the digit. _writePtyTextThrottled appends \r —
        // for the option-select menu the trailing \r commits the digit
        // (same shape as the happy single-select path).
        // Stage 2: after OTHER_FREEFORM_SETTLE_MS, write the freeform
        // text + \r via the same throttled writer. claude TUI's text-
        // input prompt accepts typed input directly (no jump-nav),
        // and the trailing \r submits.
        const tag = prevToolUseId || '?'
        ;(async () => {
          // #4808: destroy() can run during ANY of the awaits below
          // (stage-1 write, settle pause, stage-2 write). Without a
          // guard after each await the IIFE keeps running and:
          //   - re-arms a `_askUserQuestionWatchdogs` entry past destroy(),
          //     leaking a 30s timer that pins `this` in its closure
          //     even though `_onAskUserQuestionStall`'s _destroying
          //     guard silences the eventual emit
          //   - calls `_writePtyTextThrottled(freeformText)` against
          //     a `_term` that destroy() set to null, throwing inside
          //     the inner write loop
          // Bail out at every await boundary instead.
          const stage1ok = await this._writePtyTextThrottled(otherDigit).catch((err) => {
            // #4828: session-scoped.
            ;(this._log || log).warn(`respondToQuestion Other-digit PTY write failed: ${err.message} (tool=${tag})`)
            return false
          })
          // #5320 (WP-3.3) — also bail if the turn was ABORTED (interrupt() sets
          // _activeTurn.aborted but does not flip _destroying). Without this the
          // IIFE would keep driving keystrokes into a turn the user already
          // interrupted, and re-arm a watchdog interrupt() just cleared.
          if (this._destroying || this._activeTurn?.aborted) return
          if (!stage1ok) return
          await new Promise((resolve) => setTimeout(resolve, OTHER_FREEFORM_SETTLE_MS))
          if (this._destroying || this._activeTurn?.aborted) return
          // Belt-and-braces: destroy() sets _destroying before nulling
          // _term in the same synchronous frame, so the guard above
          // already covers the destroy() race. This null-check is
          // cheap insurance against a future path that releases _term
          // without flipping _destroying (e.g. a PTY-exit handler) —
          // skip the re-arm AND the stage-2 write together so the
          // watchdog never fires for a session that no longer has a
          // PTY behind it.
          if (!this._term) return
          // Re-arm the watchdog so the freeform write phase has a fresh
          // OTHER_FREEFORM_WATCHDOG_MS window — the stage-1 arm already
          // counted the settle delay against the original 30s budget.
          // #5319 (WP-3.2): keyed by this tool's id, longer second-stage window.
          this._armAskUserQuestionWatchdog(prevToolUseId, OTHER_FREEFORM_WATCHDOG_MS)
          await this._writePtyTextThrottled(freeformText).catch((err) => {
            // #4828: session-scoped.
            ;(this._log || log).warn(`respondToQuestion Other-freeform PTY write failed: ${err.message} (tool=${tag})`)
          })
        })()
        armWatchdog()
        return
      }

      // #4290: if the chosen label matches one of the structured options
      // exactly, write the 1-indexed TUI shortcut (e.g. "2") instead of
      // the label text. v0.9.3 wrote the raw label and claude TUI's
      // prompt parser single-character-jump-navigated through the menu,
      // landing on "Other" (see #4288 for the empirical trace). Numbered
      // shortcuts hit claude TUI's hotkey path directly. When no exact
      // match is found (user picked "Other" in the dashboard and typed
      // freeform text), fall through to typing the answer literally —
      // claude TUI's Other-path may still mis-parse that, tracked in
      // #4288 as a separate concern.
      let writeText = text
      if (Array.isArray(options) && options.length > 0) {
        const matchIdx = options.findIndex((o) => o && o.label === text)
        // #4292 + #4746 + #4848: single-digit hotkey covers indices 0..8.
        // For matched picks at idx >= 9 we drive the form via arrow-key
        // navigation instead of the hotkey alphabet — Down arrow (`\x1b[B`)
        // N times moves the cursor from the top option (idx 0) to the
        // target idx, and Enter (`\r`) commits the highlighted option
        // (#4848). Pre-#4848 this path tore the turn down with a
        // structured ASK_USER_QUESTION_TOO_MANY_OPTIONS error (#4746)
        // because the empirical multi-digit keystroke for option 10+
        // was unrecorded; arrow-key navigation was always one of the two
        // candidate paths the recorder script (scripts/tui-form-recorder.mjs)
        // called out and is the more conservative bet (single-keystroke
        // menus that auto-commit on the first digit can't be driven via
        // multi-digit chord like '1','0'; arrow keys are the standard
        // claude TUI navigation primitive used elsewhere in its form
        // pickers).
        //
        // #4880 (resolved 2026-06-07): the recorder pass against a 10+ option
        // AskUserQuestion finally ran (docs/empirical/4880-twelve-option-cap.jsonl)
        // and found the form is UNREACHABLE: claude TUI v2.1.168's
        // AskUserQuestion tool hard-caps each question at 4 options. A prompt
        // asking for 12 options fails server-side with
        // `InputValidationError: too_big, maximum: 4, path: questions[0].options`
        // before any form renders — so `matchIdx >= 9` can never be hit via a
        // real AskUserQuestion on this TUI version. This branch is therefore
        // currently DEAD CODE, retained as forward-compat: if a future claude
        // raises the option cap, the arrow-nav drive is ready. The `\x1b[B`
        // (Down) + `\r` (Enter) bytes remain the best-available unverified
        // sequence — they could not be empirically pinned because the form
        // can't be produced. Revisit if/when the cap is raised.
        //
        // Scoped to MATCHED picks at idx >= 9. An unmatched label still
        // falls through to typing the literal text (the v0.9.3 / pre-#4292
        // path) so the Other / freeform back-compat case is preserved.
        if (matchIdx >= 9) {
          const total = options.length
          ;(this._log || log).info(`AskUserQuestion single-question: question has ${total} options and the user picked option ${matchIdx + 1} ("${(text || '').slice(0, 40)}") — driving via arrow-key navigation (#4848) (tool=${prevToolUseId || '?'})`)
          this._writePtyArrowNavSequence(matchIdx).catch((err) => {
            ;(this._log || log).warn(`respondToQuestion arrow-nav PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
          })
          armWatchdog()
          return
        }
        if (matchIdx >= 0 && matchIdx < 9) {
          writeText = String(matchIdx + 1)
        }
      }
      // Fire-and-forget — the write is async due to the per-char throttle,
      // but the caller (handleUserQuestionResponse) is sync. Errors here
      // are non-fatal; worst case the user re-sends the answer.
      this._writePtyTextThrottled(writeText).catch((err) => {
        // #4828: session-scoped.
        ;(this._log || log).warn(`respondToQuestion PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
      })
      armWatchdog()
      return
    }

    // #4604 Chunk B — multi-question form driver. Build the keystroke
    // sequence per the empirical findings, then write through the
    // dedicated multi-question writer (one bracketed-paste wrap around
    // the whole sequence; per-char throttle; no trailing \r).
    const map = (answersMap && typeof answersMap === 'object') ? answersMap : {}
    const haveMap = Object.keys(map).length > 0
    if (!haveMap) {
      // #4828: session-scoped.
      ;(this._log || log).warn(`AskUserQuestion multi-question: dashboard didn't send answersMap (tool=${prevToolUseId || '?'}, questions=${questions.length}) — defaulting every question to option 1. Update the client to populate the per-question answers map.`)
    }

    // #4625 + #4848 — claude TUI's single-digit hotkey alphabet ('1'..'9')
    // covers options at indices 0..8 only. When a question has 10+ options
    // AND the user explicitly picked one at index ≥ 9, we have no
    // representable digit keystroke. Pre-#4625 the driver silently
    // defaulted such picks to option 1; #4625 surfaced a structured
    // ASK_USER_QUESTION_TOO_MANY_OPTIONS error before any PTY write so
    // the dashboard could prompt for a re-ask. #4848 splits this by
    // question kind:
    //   - single-select questions with an explicit pick at idx >= 9:
    //     driven natively via arrow-key navigation in the assembled
    //     sequence below (each Down arrow lands the cursor on the next
    //     option, Enter commits + advances to the next question — same
    //     mechanism the single-question path now uses).
    //   - multi-select questions with a toggle at idx >= 9: KEEP the
    //     structured ASK_USER_QUESTION_TOO_MANY_OPTIONS error. multi-
    //     select form navigation (arrow + Space to toggle + return-to-
    //     start) is empirically unrecorded; mixing arrow nav with the
    //     digit hotkeys for in-range toggles in the same question would
    //     leave the cursor in an unknown state without a tested return-
    //     to-anchor primitive. Reserve the too-many error for this case.
    //
    // Bail BEFORE any PTY write so the form stays in its initial state
    // when the error fires (claude TUI's watchdog or the user's Ctrl-C
    // unsticks it). 10+ option questions with no per-question answer
    // still fall back to option 1 (back-compat for old clients).
    if (haveMap) {
      const unrepresentableMultiSelect = []
      for (const q of questions) {
        const opts = Array.isArray(q.options) ? q.options : []
        if (opts.length <= 9) continue
        if (!q.multiSelect) continue // single-select 10+ now driven via arrow nav
        const raw = map[q.question]
        // Gather every label the user toggled for this multi-select.
        // MUST mirror resolveQuestionKeystrokes' multi-select parsing —
        // array → JSON-encoded array → comma-joined list — so an
        // unrepresentable toggle sent via the comma-joined fallback
        // (e.g. "a,k") isn't accidentally treated as a single 3-char
        // label and missed (Copilot review feedback on #4625).
        let labels = []
        if (Array.isArray(raw)) {
          labels = raw.filter((s) => typeof s === 'string')
        } else if (typeof raw === 'string' && raw.length > 0) {
          let parsed = null
          try { parsed = JSON.parse(raw) } catch { parsed = null }
          if (Array.isArray(parsed)) {
            labels = parsed.filter((s) => typeof s === 'string')
          } else {
            labels = raw.split(',').map((s) => s.trim()).filter(Boolean)
          }
        }
        for (const label of labels) {
          const idx = opts.findIndex((o) => o && o.label === label)
          if (idx >= 9) unrepresentableMultiSelect.push({ question: q.question, label, index: idx, total: opts.length })
        }
      }
      if (unrepresentableMultiSelect.length > 0) {
        const first = unrepresentableMultiSelect[0]
        ;(this._log || log).warn(`AskUserQuestion multi-question: multi-select question has ${first.total} options and the user toggled option ${first.index + 1} ("${(first.label || '').slice(0, 40)}") which is outside claude TUI's 1..9 hotkey alphabet AND beyond the arrow-nav single-select fallback (#4848 deliberately scopes arrow-nav to single-select only) — surfacing ASK_USER_QUESTION_TOO_MANY_OPTIONS (tool=${prevToolUseId || '?'})`)
        // Full AskUserQuestion teardown: synth tool_result + Ctrl-C the
        // TUI + clear inactivity timers + stream_end + _emitResult +
        // error (in that order). Without the full teardown the dashboard
        // would leave the Working banner + Stop button up and the
        // "Running AskUserQuestion · Ns" pill ticking even though
        // chroxy gave up before writing any keystrokes (#4625 hands the
        // form's resolution back to the user via the error toast).
        this._teardownAskUserQuestion(prevToolUseId, {
          synthResult: `AskUserQuestion failed: multi-select question has ${first.total} options and you toggled option ${first.index + 1}, beyond the 9 the claude TUI multi-select form can drive (#4848).`,
          emitResultReason: 'ask_user_question_too_many_options',
          errorCode: 'ASK_USER_QUESTION_TOO_MANY_OPTIONS',
          errorMessage: `Couldn't answer: a multi-select question has ${first.total} options and you toggled option ${first.index + 1}, which is beyond the 9 the claude TUI form can drive for multi-select. Re-prompt the agent to ask with 9 or fewer options for that question.`,
        })
        return
      }
    }

    /** Resolve a single label to its 1-indexed digit; null if no usable digit. */
    const labelToDigit = (q, label) => {
      if (!q || !Array.isArray(q.options) || q.options.length === 0) return null
      const idx = q.options.findIndex((o) => o && o.label === label)
      if (idx >= 0 && idx < 9) return String(idx + 1)
      return null
    }

    /**
     * Resolve a single question's answer entry to an array of keystroke
     * tokens to write. Tokens are arbitrary-length strings — usually a
     * single digit ('1'..'9') or Tab/Enter, but for #4848 a single-select
     * answer at idx >= 9 expands to a multi-token arrow-nav sequence
     * (`'\x1b[B'` × idx + `'\r'`). The writer (`_writePtyMultiQuestionSequence`)
     * doesn't care about token length — it writes each entry as one
     * `term.write` call with a throttle pause after.
     */
    const resolveQuestionKeystrokes = (q, rawAnswer) => {
      const opts = Array.isArray(q.options) ? q.options : []
      const defaultDigit = opts.length > 0 ? '1' : null

      if (q.multiSelect) {
        // multi-select expects 0+ choices. Accept array, JSON-encoded
        // array string, or comma-joined list — the wire schema is
        // `Record<string, string | string[]>` post-#4735 so newer
        // dashboard / app builds send the native array form; pre-#4735
        // builds JSON-stringified the array into a single string for
        // back-compat. Both shapes resolve here.
        let labels = []
        if (Array.isArray(rawAnswer)) {
          labels = rawAnswer.filter((s) => typeof s === 'string')
        } else if (typeof rawAnswer === 'string' && rawAnswer.length > 0) {
          let parsed = null
          try { parsed = JSON.parse(rawAnswer) } catch { parsed = null }
          if (Array.isArray(parsed)) {
            labels = parsed.filter((s) => typeof s === 'string')
          } else {
            // Fallback: comma-joined "label1,label2" — only safe when
            // labels themselves don't contain commas; defensive
            // single-label case also handled here.
            labels = rawAnswer.split(',').map((s) => s.trim()).filter(Boolean)
          }
        }
        const digits = []
        for (const label of labels) {
          const d = labelToDigit(q, label)
          if (d) digits.push(d)
          // Multi-select 10+ toggles already pre-screened above and
          // surfaced as ASK_USER_QUESTION_TOO_MANY_OPTIONS — anything
          // unrepresentable here means the dashboard sent something we
          // couldn't match (defaulted handling below).
        }
        if (digits.length === 0 && defaultDigit) {
          // #4828: session-scoped (closure runs inside respondToQuestion, post-start).
          ;(this._log || log).warn(`AskUserQuestion multi-question: no resolvable answer for q="${(q.question || '').slice(0, 40)}" (multi-select) — defaulting to option 1`)
          digits.push(defaultDigit)
        }
        return digits
      }

      // single-select — exactly one keystroke token.
      let pickedLabel = null
      if (typeof rawAnswer === 'string' && rawAnswer.length > 0) {
        pickedLabel = rawAnswer
      } else if (Array.isArray(rawAnswer) && typeof rawAnswer[0] === 'string') {
        pickedLabel = rawAnswer[0]
      }
      if (pickedLabel !== null) {
        const idx = opts.findIndex((o) => o && o.label === pickedLabel)
        if (idx >= 0 && idx < 9) return [String(idx + 1)]
        if (idx >= 9) {
          // #4848 — option at idx >= 9 in a single-select question.
          // Drive via arrow-key navigation: idx Down arrows from the
          // top option (cursor starts at idx 0) followed by Enter to
          // commit + advance to the next question. The arrow sequence
          // and the Enter are emitted as two distinct keystroke tokens
          // so the throttle pauses BETWEEN them (claude TUI's paste
          // detector treats a single 11-byte burst as a paste). Each
          // arrow is 3 bytes ('\x1b[B'); 10 arrows = 30 bytes is still
          // well under any reasonable paste threshold, but stay safe.
          log.info(`AskUserQuestion multi-question: single-select pick at idx=${idx} (option ${idx + 1}) in q="${(q.question || '').slice(0, 40)}" → arrow-nav (#4848)`)
          const tokens = []
          for (let i = 0; i < idx; i++) tokens.push('\x1b[B')
          tokens.push('\r')
          return tokens
        }
      }
      if (defaultDigit) {
        // #4828: session-scoped (closure runs inside respondToQuestion, post-start).
        if (haveMap) (this._log || log).warn(`AskUserQuestion multi-question: no resolvable answer for q="${(q.question || '').slice(0, 40)}" (single-select) — defaulting to option 1`)
        return [defaultDigit]
      }
      return []
    }

    // Assemble the inner keystroke sequence (no paste-mode toggles —
    // _writePtyMultiQuestionSequence wraps the whole thing). The sequence
    // is a mixed array of strings (chars to write) and numbers (ms to
    // sleep) — the writer dispatches on type.
    const sequence = []
    for (const q of questions) {
      const rawAnswer = map[q.question]
      const keystrokes = resolveQuestionKeystrokes(q, rawAnswer)
      for (const k of keystrokes) sequence.push(k)
      if (q.multiSelect) {
        // Multi-select needs an explicit advance keystroke; single-select
        // auto-advances on digit OR on Enter after arrow-nav (verified
        // empirically for digit; arrow-nav variant pinned by #4848).
        sequence.push('\t')
      }
    }
    // #4635 — when the LAST question is single-select, insert a settling
    // delay before the Submit keystroke. The last digit auto-advances to
    // the Submit screen, but the 1ms per-char throttle races claude TUI's
    // render of that screen so the trailing '1' lands on the still-
    // rendering last-question screen and gets swallowed (the wedge the
    // issue documents). Mixed forms ending in multi-select don't need
    // this — the explicit '\t' already settles the form.
    // #4883 — tighten the lastIsSingleSelect detection so an unexpected TUI
    // question shape surfaces in logs instead of silently picking a branch.
    // Today's TUI omits `multiSelect` on single-select questions and sets it
    // to `true` on multi-select; any other shape (string, null, number, a
    // hypothetical future field rename) is treated as "assume single-select
    // for settle purposes" — but we log a WARN so the shape drift is visible.
    //
    // The "drift" check uses `'multiSelect' in lastQuestion` rather than
    // `!== undefined` so it also catches the in-code pathological case
    // `{ multiSelect: undefined }` (Copilot review on #4902): the key is
    // present but the value isn't boolean — that's still drift worth
    // surfacing, since wire-deserialized shapes can't produce that pattern
    // (JSON.stringify drops undefined-valued keys) but in-code shapes can.
    const lastQuestion = questions.length > 0 ? questions[questions.length - 1] : null
    if (lastQuestion && 'multiSelect' in lastQuestion && typeof lastQuestion.multiSelect !== 'boolean') {
      ;(this._log || log).warn(`AskUserQuestion multi-question: last question has non-boolean multiSelect=${JSON.stringify(lastQuestion.multiSelect)} (q="${(lastQuestion.question || '').slice(0, 40)}") — assuming single-select for settle (#4883)`)
    }
    const lastIsSingleSelect = !!(lastQuestion && lastQuestion.multiSelect !== true)
    if (lastIsSingleSelect) {
      sequence.push(MULTI_QUESTION_SUBMIT_SETTLE_MS)
    }
    // Focus lands on `❯ 1. Submit answers / 2. Cancel` after the last
    // question — press 1 to confirm submission.
    // #4884: tag the Submit position with a marker object so
    // _writePtyMultiQuestionSequence can record the wall-clock at the
    // point the writer reaches Submit (immediately before the `'1'` is
    // written to the PTY, after any preceding settle has elapsed). Used
    // by _emitToolHookEvent's PostToolUse handler to log the
    // Submit→PostToolUse delta — the marker timestamp is the lower bound
    // for when '1' actually leaves the writer (within
    // PROMPT_CHAR_DELAY_MS of the actual write).
    if (prevToolUseId) {
      sequence.push({ type: 'mark', label: 'submit', toolUseId: prevToolUseId })
    }
    sequence.push('1')
    // #4635 — trailing Enter after the Submit `'1'`.
    // #4882 (resolved 2026-06-07): the all-single-select recorder pass
    // (docs/empirical/4882-all-single-select-2q.jsonl) confirmed a human
    // submits the Submit screen with `'1'` ALONE — the trailing `\r` is
    // NOT required (the Submit screen commits on the digit, same as the
    // mixed-form recording and the single-q path's redundant Enter pinned
    // in #4290). The `\r` is RETAINED as confirmed-harmless belt-and-braces:
    // it lands ~1ms after Submit-'1' (per-char throttle) on a form that has
    // already committed, and #4884's Submit→PostToolUse forensics show it
    // arriving without disrupting the round-trip. Kept (not removed) because
    // the recording covered only the 2-question all-single-select shape and
    // this push also feeds the mixed and 3+q paths, which were not re-recorded.
    sequence.push('\r')

    const keystrokeCount = sequence.filter((x) => typeof x === 'string').length
    ;(this._log || log).info(`AskUserQuestion multi-question: tool=${prevToolUseId || '?'} questions=${questions.length} keystrokes=${keystrokeCount} haveAnswersMap=${haveMap}`)

    this._writePtyMultiQuestionSequence(sequence).catch((err) => {
      // #4828: session-scoped.
      ;(this._log || log).warn(`respondToQuestion multi-question PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
    })
    armWatchdog()
  }

  /**
   * Watchdog handler for an AskUserQuestion answer that claude TUI never
   * acknowledged via PostToolUse (#4604). Multi-question forms render a
   * per-question form needing more than the single digit chroxy writes,
   * leaving _isBusy=true forever. We tear the turn down end-to-end and
   * surface a structured error so the dashboard renders a retry prompt
   * AND the Working banner / Stop button clear immediately.
   *
   * Pre-#4645 this only cleared `_isBusy` + emitted the stall error,
   * leaving `stream_start` orphaned (no matching `stream_end`) and no
   * `result` for the event-normalizer to fan into `agent_idle`. The
   * dashboard kept showing "Working… Ns ago" + Stop forever (until the
   * 5-min #4638 stream-stall watchdog or the 2h hard cap eventually
   * cleaned up) even though the agent had already given up. Worse: the
   * red error toast told the user to retry, but the Stop button was up
   * and the input box read "Type to send follow-up…" — there was no
   * Send affordance to retry FROM.
   *
   * Now: best-effort Ctrl-C into the TUI (so `claude` itself unsticks
   * from the form screen for the next turn) → emit `stream_end` →
   * `_emitResult` (sweeps orphan tool_starts and fans `result` →
   * `agent_idle` via the event-normalizer, clearing both Working banner
   * and Stop) → emit `error{code:'ASK_USER_QUESTION_STALL'}` last so the
   * dashboard surfaces the user-facing toast AFTER state has settled.
   *
   * Shape mirrors `_handleStreamStall` and `_handleHardTimeout` (which
   * delegate to `_teardownTurn` per #4641). This path is NOT folded into
   * `_teardownTurn` because it has additional side-effects (synthetic
   * `tool_result` emit, clears all three inactivity timers, error
   * payload carries `toolUseId`) that don't generalise to the other two
   * teardown sites — bringing it in would either widen the helper's
   * surface or split the call into multiple stages, neither of which
   * earns its complexity today.
   *
   * No-ops on destroyed sessions and on sessions where PostToolUse
   * already arrived (would have cleared _pendingUserAnswer + busy state
   * in the normal flow before the watchdog timer fired).
   */
  _onAskUserQuestionStall(toolUseId) {
    if (this._destroying) return
    if (!this._pendingUserAnswer && !this._isBusy) return

    this._assertBusyHasMessageId('_onAskUserQuestionStall')
    // #4828: session-scoped — stall watchdog fires strictly post-start.
    ;(this._log || log).warn(`AskUserQuestion stall: tool=${toolUseId} — claude TUI never emitted PostToolUse after answer write (${ASK_USER_QUESTION_WATCHDOG_MS}ms). Likely a multi-question form (#4604). Tearing down turn so the session is recoverable.`)

    this._teardownAskUserQuestion(toolUseId, {
      synthResult: 'AskUserQuestion stalled — no response from claude TUI within 30s. Likely a multi-question form (#4604).',
      emitResultReason: 'ask_user_question_stall',
      errorCode: 'ASK_USER_QUESTION_STALL',
      // #4648: dropped the "likely a multi-question form" jargon. The
      // permission-hook deny path (also #4648) prevents most multi-question
      // forms from reaching this code path at all, and for the cases that
      // slip through, the user doesn't care about chroxy internals — they
      // care about how to recover. The new copy is action-oriented.
      errorMessage: 'Couldn\'t deliver your answers. Tap Retry to resend your original request.',
    })
  }

  /**
   * Shared teardown for AskUserQuestion failure modes. Used by both the
   * 30s post-write stall watchdog (#4604) and the up-front
   * too-many-options detector (#4625). Mirrors the end-to-end teardown
   * order pinned in #4645: synthetic tool_result → Ctrl-C the TUI →
   * clear inactivity timers → null active turn / busy state →
   * stream_end + _emitResult → error event last. The caller supplies the
   * synth result text, _emitResult reason tag, and error code/message so
   * the same teardown serves both call sites.
   *
   * Splitting this out (vs the original inline form in
   * _onAskUserQuestionStall) is intentional: #4625's too-many-options
   * path needs the full teardown so the dashboard's Working banner +
   * Stop button + activeTools entry all clear immediately, but the
   * trigger and copy differ from the 30s stall path. Inlining the
   * teardown twice risked drift; folding both into _teardownTurn would
   * widen the helper's surface (synth tool_result + 3-timer clear +
   * toolUseId-carrying error don't generalise to the other teardown
   * sites), so a dedicated AskUserQuestion teardown helper earns its
   * keep.
   */
  _teardownAskUserQuestion(toolUseId, { synthResult, emitResultReason, errorCode, errorMessage }) {
    const messageId = this._currentMessageId
    const duration = this._activeTurn ? this._nowMonotonic() - this._activeTurn.startedAt : 0

    // #4691: surgical clear — drop ONLY the entry for the tool that
    // timed out. The other teardown sites (_finishTurnError, hard
    // timeout via _teardownTurn, interrupt, destroy) end the whole
    // turn, so wiping the whole Map there is correct. The watchdog is
    // different: it knows the exact toolUseId that wedged (passed to
    // setTimeout in respondToQuestion) and the rest of the turn is
    // still live — sibling AskUserQuestion entries armed by parallel
    // PreToolUse blocks can still see a PostToolUse arrive. Falling
    // back to `_pendingUserAnswer = null` here would re-trigger the
    // back-compat setter → `_pendingUserAnswers.clear()` and wipe
    // those siblings under their own still-live turns, re-introducing
    // the #4668-class state-shape mismatch (dashboard cleared the
    // QuestionPrompt UI when it sent the answer, but the server-side
    // Map is empty — a late retry-as-singles answer with toolUseId B
    // would hit the "no matching pending entry — dropping" path and
    // wedge the next form silently).
    this._clearPendingAnswerByToolUseId(toolUseId)
    // #5319 (WP-3.2): cancel THIS tool's stall watchdog. The 30s-stall path
    // arrives here after its own watchdog already self-deleted, but the
    // too-many-options (#4625) path tears down WITHOUT a prior fire, so clear
    // it explicitly. Idempotent; leaves any sibling watchdog intact.
    this._clearAskUserQuestionWatchdog(toolUseId)
    this._clearAskUserQuestionLock()
    // #4616: emit a synthetic tool_result FIRST so the dashboard's
    // activeTools entry for this AskUserQuestion is cleared. Without it
    // the footer "Running AskUserQuestion · Ns" pill keeps ticking
    // forever even though _isBusy is clear and the user sees the error
    // toast. The handler ignores any fields beyond {toolUseId, result,
    // truncated, images} (see store-core handleToolResult); pairing-by-
    // toolUseId is what drives the activeTools removal in store-core handlers.
    this.emit('tool_result', {
      toolUseId,
      result: synthResult,
      truncated: false,
    })
    // #4628: matching tool_start resolved — drop from the in-flight map.
    this._trackToolResult(toolUseId)

    // #4645: best-effort Ctrl-C so claude TUI itself unsticks from the
    // form screen. Without this the next sendMessage's prompt write
    // would queue behind the still-displayed form and silently desync.
    // Mirrors _handleStreamStall / _handleHardTimeout.
    if (this._term) {
      try { this._term.write('\x03') } catch { /* ignore */ }
    }

    // Clear all four inactivity timers — turn is over, nothing to
    // backstop, leaving them armed would fire stale callbacks on a
    // session that's already idle.
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    // #4732: pre-first-output watchdog. AskUserQuestion only fires
    // mid-turn (post-stream_start), so the first-output watchdog has
    // typically been disarmed already, but clear it explicitly so a
    // pathological race can't leak a live handle past the stall.
    this._clearFirstOutputWatchdog()

    // #4022: drop per-turn attachment dir (same as the other teardown
    // paths) so a failed turn doesn't leak materialized files until destroy().
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null

    // #4645: pair the stream_start fired at turn-start with stream_end +
    // result so the dashboard's streamingMessageId + Working banner +
    // Stop button all clear immediately (event-normalizer turns result
    // into result + agent_idle). The if-guard mirrors _handleStreamStall
    // — silent skip is acceptable here because the only way messageId
    // is null is a contract violation (_isBusy=true without an active
    // turn), tracked in #4642.
    if (messageId) this.emit('stream_end', { messageId })
    this._emitResult(
      { cost: null, duration, usage: null, sessionId: this._sessionId },
      emitResultReason,
    )
    this.emit('error', {
      code: errorCode,
      message: errorMessage,
      toolUseId,
    })
  }
}
