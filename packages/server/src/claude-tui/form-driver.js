// claude-tui/form-driver.js — interactive AskUserQuestion form driver for ClaudeTuiSession.
//
// respondToQuestion assembles the empirically-pinned keystroke sequences
// (project memory: tui_multi_question_form_keys, multi_question_post_deny_wedge)
// — digit auto-advance, Tab between multi-selects, the Submit-settle, the
// Other/freeform two-stage flow, arrow-nav for 10+ option picks — and the stall
// watchdog teardown.
//
// #5559 first moved these bodies out of claude-tui-session.js byte-identical,
// but re-coupled them onto ClaudeTuiSession.prototype via applyMixin(), so they
// still reached into 28 private session fields/methods through `this`.
//
// #5617 makes FormDriver an INJECTED COLLABORATOR: the session constructs it as
// `this._formDriver = new FormDriver(this)` and delegates `respondToQuestion()`;
// every former session access `this._<member>` is now `this._host._<member>`
// against the explicit {@link FormDriverHost} surface below (the `_<member>`s are
// enumerated there). The byte-sequence bodies are otherwise
// UNCHANGED (the #5617 diff reverses to the #5559 source exactly — a pure
// receiver swap). The point is testability: a unit test injects a mock host and
// asserts the keystroke sequences against the pinned recordings WITHOUT a live
// PTY (see tests/claude-tui-form-driver.test.js).
//
/**
 * The slice of ClaudeTuiSession that FormDriver drives. The session satisfies
 * this structurally (FormDriver receives `this`); tests pass a mock. Grouped:
 *
 *  - PTY writers: `_writePtyTextThrottled`, `_writePtyArrowNavSequence` —
 *    emit the keystroke bytes.
 *  - Pending-answer state: `_pendingUserAnswers` (Map), `_pendingUserAnswer`
 *    (back-compat getter), `_clearPendingAnswerByToolUseId`.
 *  - Turn/result state: `_activeTurn`, `_isBusy`, `_currentMessageId`,
 *    `_destroying`, `_assertBusyHasMessageId`, `_emitResult`, `_trackToolResult`,
 *    `_cleanupTurnAttachments`, `_outputTailHexDump`, `_sessionId`.
 *  - Timers/watchdogs: `_armAskUserQuestionWatchdog`,
 *    `_clearAskUserQuestionWatchdog`, `_clearAskUserQuestionLock`,
 *    `_clearFirstOutputWatchdog`, `_streamStallTimeout`, `_resultTimeout`,
 *    `_hardTimeout`, `_nowMonotonic`.
 *  - Misc: `_term`, `_log`, `emit` (the session is an EventEmitter),
 *    `sendMessage` (#5776 multi-select reinject — start a new turn with the
 *    formatted answer text when the denied multi-select form has no live form
 *    to drive).
 *
 * @typedef {import('../claude-tui-session.js').ClaudeTuiSession} FormDriverHost
 */
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

// #5776 (Phase 0) — multi-select reinject spike. claude TUI is keyboard-only
// and exposes no structured answer channel, so multi-select forms are denied at
// permission-hook.sh and (defense-in-depth) refused here. The reinject path
// flips the strategy: instead of refusing, format the user's selection into a
// plain-text answer and feed it to claude as a NEW turn via sendMessage(). This
// works because the form was denied BEFORE it rendered (so there is no live form
// to drive and no PostToolUse coming), and because a multi-select answer reaches
// the model as comma-joined TEXT anyway (verified live 2026-06-13 — see project
// memory tui_askuserquestion_keyboard_only). Gated behind an env flag so the
// default (refuse) behavior is untouched; the same flag steers the hook's deny
// reason. Read at call time so tests can toggle it per-case.
export function multiSelectReinjectEnabled() {
  return process.env.CHROXY_TUI_MULTISELECT_REINJECT === '1'
}

// #5776 — parse a single question's answersMap value into an array of selected
// option LABELS. Mirrors the multi-select parsing in resolveQuestionKeystrokes
// (native array post-#4735 / JSON-encoded array / comma-joined fallback) so the
// reinject formatter and the keystroke driver agree on what the user picked.
function parseSelectedLabels(raw) {
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string')
  if (typeof raw === 'string' && raw.length > 0) {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === 'string')
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

// #5776 — format the pending questions + answersMap into the plain-text answer
// chroxy reinjects as the next user message. Uses option LABELS (not positional
// digits/letters) so the answer is unambiguous to the model regardless of option
// ordering. Returns '' when nothing resolvable was selected (caller falls back to
// teardown). Free-text/"Other" combine is deferred to Phase 1 (#5776 option B).
export function formatMultiSelectReinject(questions, answersMap) {
  const map = (answersMap && typeof answersMap === 'object') ? answersMap : {}
  const lines = []
  for (const q of questions) {
    if (!q || !q.question) continue
    const labels = parseSelectedLabels(map[q.question])
    if (labels.length === 0) continue
    lines.push(`For "${q.question}": ${labels.join(', ')}`)
  }
  return lines.join('\n')
}

// --- interactive-form driver: an injected collaborator of ClaudeTuiSession (#5617) ---
export class FormDriver {
  /**
   * @param {FormDriverHost} host — the owning ClaudeTuiSession (or a mock in tests).
   */
  constructor(host) {
    this._host = host
  }

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
    if (toolUseId && this._host._pendingUserAnswers.has(toolUseId)) {
      entry = this._host._pendingUserAnswers.get(toolUseId)
    } else if (toolUseId && this._host._pendingUserAnswers.size > 0) {
      // Dashboard sent a toolUseId we don't have a pending entry for.
      // Common cause: stale answer arriving after the turn's teardown
      // cleared the Map (watchdog fire, user gave up + the late answer
      // came in). Log + drop rather than write keystrokes into whatever
      // form happens to be currently rendered.
      // #4828: session-scoped — respondToQuestion runs strictly post-start.
      ;(this._host._log || log).warn(`respondToQuestion: dashboard sent toolUseId=${toolUseId} but no matching pending entry (Map.size=${this._host._pendingUserAnswers.size} keys=${[...this._host._pendingUserAnswers.keys()].join(',')}) — dropping`)
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
      if (!toolUseId && this._host._pendingUserAnswers.size > 1) {
        // #4828: session-scoped.
        ;(this._host._log || log).warn(`respondToQuestion: dashboard omitted toolUseId but ${this._host._pendingUserAnswers.size} pending entries exist (keys=${[...this._host._pendingUserAnswers.keys()].join(',')}) — falling back to most-recent which may misroute`)
      }
      entry = this._host._pendingUserAnswer
    }
    const prevToolUseId = entry?.toolUseId || null
    const pendingQuestions = entry?.questions || []
    const answersMapKeyCount = answersMap && typeof answersMap === 'object' ? Object.keys(answersMap).length : 0
    // #4828: session-scoped.
    ;(this._host._log || log).info(`respondToQuestion: tool=${prevToolUseId || '?'} dashboardToolUseId=${toolUseId || 'none'} text.length=${(text || '').length} answersMap.keys=${answersMapKeyCount} questions=${pendingQuestions.length} options=${entry?.options?.length || 0} pendingMapSize=${this._host._pendingUserAnswers.size}`)
    if (!entry) return
    // #5320 (WP-3.3) — arm the stall watchdog the MOMENT we have a live pending
    // entry the dashboard tried to answer, BEFORE any early-return below. The
    // dashboard clears its QuestionPrompt UI when it sends an answer, so ANY
    // respondToQuestion that finds an entry but then bails — the unactionable
    // cases here (non-string / empty text + no answersMap), the validation drops
    // in the freeform path (no options, option-not-found), or `!this._host._term` —
    // would otherwise leave the turn wedged until the 2h hard cap with no
    // dashboard prompt. Arming here (it does NOT clear the pending) gives every
    // such path recovery; a real follow-up answer re-arms idempotently (same
    // key), and the success paths re-arm with a fresh post-write window (the
    // Other-freeform IIFE with its longer second-stage window).
    this._host._armAskUserQuestionWatchdog(prevToolUseId)
    // #5771: a SINGLE multi-select question is denied at the permission hook
    // (permission-hook.sh) because claude TUI is keyboard-only and has no
    // reliable single-toggle+submit keystroke sequence (0/7 production success —
    // swarm audit 2026-06-13, see docs/audit-results/claude-tui-askuserquestion-
    // form-driving/). Defense in depth: if a single multiSelect question reaches
    // the driver anyway (hook failed open on a parse error, or a client bypassed
    // it), refuse to drive it rather than write a wrong single digit, and tear
    // down NOW so the turn recovers immediately instead of waiting out the 30s
    // stall watchdog. (Multi-question forms are denied separately at the hook
    // since #4648 and still flow through the assembler below if hook-bypassed —
    // that dead path is removed in the follow-up cleanup.)
    if (pendingQuestions.length <= 1 && pendingQuestions.some((q) => q && q.multiSelect === true)) {
      // #5776 (Phase 0) — reinject path: format the selection into text and feed
      // it to claude as a new turn instead of driving (un-drivable) keystrokes.
      // The form was denied at permission-hook.sh before it rendered, so there is
      // no live form and no PostToolUse — claude has stopped and is waiting for
      // the next user message (verified live 2026-06-13). Gated by the env flag;
      // when off, fall through to the original refuse-and-teardown behavior.
      if (multiSelectReinjectEnabled()) {
        const reinjectText = formatMultiSelectReinject(pendingQuestions, answersMap)
        if (opts && typeof opts.freeformText === 'string' && opts.freeformText.length > 0) {
          // Phase 1 (#5776 option B) — free-text combine deferred. Log so a
          // dropped custom answer is visible rather than silent.
          ;(this._host._log || log).warn(`respondToQuestion: multiSelect reinject dropping freeformText (Phase 1, #5776 option B) tool=${prevToolUseId || '?'}`)
        }
        if (reinjectText.length === 0) {
          // Nothing resolvable selected — recover via teardown rather than send
          // an empty turn.
          ;(this._host._log || log).warn(`respondToQuestion: multiSelect reinject produced empty text (tool=${prevToolUseId || '?'}) — tearing down`)
          this._teardownAskUserQuestion(prevToolUseId, {
            synthResult: 'No selection received for the multi-select question.',
            emitResultReason: 'ask_user_question_multiselect_empty',
            errorCode: 'ASK_USER_QUESTION_MULTISELECT_EMPTY',
            errorMessage: 'No selection received. Tap Retry to resend your request.',
          })
          return
        }
        // #5776 — the reinject only works once the in-flight (denied) turn has
        // wound down to idle. sendMessage() early-returns (emit 'error' + bare
        // return — NOT a Promise rejection, so the .catch below can't observe it)
        // when _isBusy is still true. In the normal flow the model stops on the
        // deny, its Stop hook drains, and the session is idle by the time the
        // human answers seconds later (verified live 2026-06-13). But if the
        // answer races ahead of that Stop-hook teardown, or the model ignored the
        // deny, the turn is still busy — and silently dropping the selection would
        // wedge the session until the 2h hard cap. Surface a retryable error
        // instead so the user can resend once the turn has settled (the teardown
        // is a no-op-safe interleave with the Stop-hook drain via the poll loop's
        // !_isBusy early return). A future Phase 1 robustness pass can await-idle
        // and deliver seamlessly; for the spike, fail loud + recoverable.
        if (this._host._isBusy) {
          ;(this._host._log || log).warn(`respondToQuestion: multiSelect reinject deferred — session still busy (tool=${prevToolUseId || '?'}); the answer raced the turn teardown`)
          this._teardownAskUserQuestion(prevToolUseId, {
            synthResult: 'Multi-select answer arrived before the previous turn finished; not delivered.',
            emitResultReason: 'ask_user_question_multiselect_busy',
            errorCode: 'ASK_USER_QUESTION_MULTISELECT_BUSY',
            errorMessage: 'Your selection arrived while the previous turn was still finishing. Tap Retry to resend it.',
          })
          return
        }
        // sendMessage() has a SECOND fail-open guard beyond _isBusy: if the
        // session isn't runnable (!_processReady / no _term / _ptyExited) it
        // emit('error')s + bare-returns without starting a turn. We clear the
        // pending entry + watchdog + lock just below, so reaching sendMessage in
        // that state would drop the selection with no retry path (same wedge
        // class the _isBusy guard closes). Mirror that guard here: tear down with
        // a retryable error BEFORE clearing state so the user can resend once the
        // session is back. (#5781 review / #5784)
        if (!this._host._processReady || !this._host._term || this._host._ptyExited) {
          ;(this._host._log || log).warn(`respondToQuestion: multiSelect reinject deferred — session not runnable (tool=${prevToolUseId || '?'}); PTY exited or not yet started`)
          this._teardownAskUserQuestion(prevToolUseId, {
            synthResult: 'Multi-select answer could not be delivered; the session was not running.',
            emitResultReason: 'ask_user_question_multiselect_unavailable',
            errorCode: 'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE',
            errorMessage: 'Your selection could not be delivered — the session wasn\'t running. Tap Retry once it\'s back.',
          })
          return
        }
        ;(this._host._log || log).info(`respondToQuestion: multiSelect reinject (flag on) tool=${prevToolUseId || '?'} text="${reinjectText.slice(0, 80)}"`)
        // The denied form left a pending entry + armed watchdog; clear both, plus
        // the sibling lock, before starting the new turn.
        this._host._clearPendingAnswerByToolUseId(prevToolUseId)
        this._host._clearAskUserQuestionWatchdog(prevToolUseId)
        this._host._clearAskUserQuestionLock()
        Promise.resolve(this._host.sendMessage(reinjectText)).catch((err) => {
          ;(this._host._log || log).warn(`respondToQuestion: multiSelect reinject sendMessage failed: ${err?.message || err} (tool=${prevToolUseId || '?'})`)
        })
        return
      }
      ;(this._host._log || log).warn(`respondToQuestion: refusing single multiSelect AskUserQuestion (tool=${prevToolUseId || '?'}) — multi-select is denied at the permission hook; not driving keystrokes`)
      this._teardownAskUserQuestion(prevToolUseId, {
        synthResult: 'Multi-select questions aren\'t supported by the TUI provider. Ask one single-select question at a time.',
        emitResultReason: 'ask_user_question_multiselect_unsupported',
        errorCode: 'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED',
        errorMessage: 'Multi-select questions aren\'t supported here. Tap Retry to resend your request.',
      })
      return
    }
    // Single-question / free-text path requires a non-empty `text`. The
    // multi-question path is driven from answersMap (text is ignored when
    // a map is present) so an empty string is permitted there.
    if (typeof text !== 'string') return
    if (text.length === 0 && answersMapKeyCount === 0) return
    const { options } = entry
    const questions = pendingQuestions
    // #4668: clear only this specific entry; sibling pending answers
    // (from parallel AskUserQuestion calls in the same turn) survive.
    this._host._clearPendingAnswerByToolUseId(entry.toolUseId)
    if (!this._host._term) return
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
    const slog = this._host._log || log
    const turn = this._host._activeTurn
    if (turn && !turn.hexDumpEmitted) {
      slog.info(`respondToQuestion PTY tail before write (tool=${prevToolUseId || '?'}):\n${this._host._outputTailHexDump()}`)
      turn.hexDumpEmitted = true
    } else if (turn) {
      slog.info(`respondToQuestion PTY tail hex dump skipped (tool=${prevToolUseId || '?'}) — already emitted for turn msg=${turn.messageId || '?'}`)
    } else {
      // No active turn (defensive — tests that drive respondToQuestion
      // directly without sendMessage(), late watchdog teardown races).
      // Emit the dump so the diagnostic is still useful in those paths.
      slog.info(`respondToQuestion PTY tail before write (tool=${prevToolUseId || '?'}):\n${this._host._outputTailHexDump()}`)
    }

    const armWatchdog = () => {
      // #4604: arm a stall watchdog. If claude TUI never emits PostToolUse
      // for this AskUserQuestion (a form shape we don't yet drive),
      // the watchdog clears _isBusy + _pendingUserAnswer and emits
      // ASK_USER_QUESTION_STALL so the dashboard prompts the user to
      // retry. Cancelled on PostToolUse (happy path) and on destroy().
      // #5319 (WP-3.2): keyed by this tool's id so a parallel sibling's arm
      // doesn't clobber it.
      this._host._armAskUserQuestionWatchdog(prevToolUseId)
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
          ;(this._host._log || log).warn(`respondToQuestion: freeformText supplied for question with no options (tool=${prevToolUseId || '?'}) — dropping`)
          return
        }
        const otherIdx = options.findIndex((o) => o && o.label === text)
        if (otherIdx < 0 || otherIdx >= 9) {
          // #4828: session-scoped.
          ;(this._host._log || log).warn(`respondToQuestion: freeformText supplied but chosen option "${text}" not found (or beyond single-digit hotkey range) in pending options for tool=${prevToolUseId || '?'} — dropping`)
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
          const stage1ok = await this._host._writePtyTextThrottled(otherDigit).catch((err) => {
            // #4828: session-scoped.
            ;(this._host._log || log).warn(`respondToQuestion Other-digit PTY write failed: ${err.message} (tool=${tag})`)
            return false
          })
          // #5320 (WP-3.3) — also bail if the turn was ABORTED (interrupt() sets
          // _activeTurn.aborted but does not flip _destroying). Without this the
          // IIFE would keep driving keystrokes into a turn the user already
          // interrupted, and re-arm a watchdog interrupt() just cleared.
          if (this._host._destroying || this._host._activeTurn?.aborted) return
          if (!stage1ok) return
          await new Promise((resolve) => setTimeout(resolve, OTHER_FREEFORM_SETTLE_MS))
          if (this._host._destroying || this._host._activeTurn?.aborted) return
          // Belt-and-braces: destroy() sets _destroying before nulling
          // _term in the same synchronous frame, so the guard above
          // already covers the destroy() race. This null-check is
          // cheap insurance against a future path that releases _term
          // without flipping _destroying (e.g. a PTY-exit handler) —
          // skip the re-arm AND the stage-2 write together so the
          // watchdog never fires for a session that no longer has a
          // PTY behind it.
          if (!this._host._term) return
          // Re-arm the watchdog so the freeform write phase has a fresh
          // OTHER_FREEFORM_WATCHDOG_MS window — the stage-1 arm already
          // counted the settle delay against the original 30s budget.
          // #5319 (WP-3.2): keyed by this tool's id, longer second-stage window.
          this._host._armAskUserQuestionWatchdog(prevToolUseId, OTHER_FREEFORM_WATCHDOG_MS)
          await this._host._writePtyTextThrottled(freeformText).catch((err) => {
            // #4828: session-scoped.
            ;(this._host._log || log).warn(`respondToQuestion Other-freeform PTY write failed: ${err.message} (tool=${tag})`)
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
          ;(this._host._log || log).info(`AskUserQuestion single-question: question has ${total} options and the user picked option ${matchIdx + 1} ("${(text || '').slice(0, 40)}") — driving via arrow-key navigation (#4848) (tool=${prevToolUseId || '?'})`)
          this._host._writePtyArrowNavSequence(matchIdx).catch((err) => {
            ;(this._host._log || log).warn(`respondToQuestion arrow-nav PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
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
      this._host._writePtyTextThrottled(writeText).catch((err) => {
        // #4828: session-scoped.
        ;(this._host._log || log).warn(`respondToQuestion PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
      })
      armWatchdog()
      return
    }

    // #5773: claude TUI multi-QUESTION forms (questions.length > 1) are denied at
    // the permission hook (since #4648), so this path is unreachable in production.
    // The keystroke assembler that drove them (toggle-digit + Tab + Submit settle
    // timing, #4604 Chunk B) and _writePtyMultiQuestionSequence have been removed
    // as a version-pinned maintenance liability (swarm audit 2026-06-13). Keep a
    // defense-in-depth refusal: if a multi-question entry ever reaches
    // respondToQuestion (a fail-open hook), tear the turn down cleanly instead of
    // driving guessed keystrokes — mirroring the hook deny. Single-question and
    // single multi-select (reinject, #5776) are handled above and return early.
    ;(this._host._log || log).warn(`AskUserQuestion: refusing ${questions.length}-question form (tool=${prevToolUseId || '?'}) — multi-question is denied at the permission hook; not driving keystrokes`)
    this._teardownAskUserQuestion(prevToolUseId, {
      synthResult: 'Multi-question AskUserQuestion forms aren\'t supported by the TUI provider. Ask one single-select question at a time.',
      emitResultReason: 'ask_user_question_multi_question_unsupported',
      errorCode: 'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED',
      errorMessage: 'Multi-question forms aren\'t supported here. Tap Retry to resend as single questions.',
    })
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
    if (this._host._destroying) return
    if (!this._host._pendingUserAnswer && !this._host._isBusy) return

    this._host._assertBusyHasMessageId('_onAskUserQuestionStall')
    // #4828: session-scoped — stall watchdog fires strictly post-start.
    ;(this._host._log || log).warn(`AskUserQuestion stall: tool=${toolUseId} — claude TUI never emitted PostToolUse after answer write (${ASK_USER_QUESTION_WATCHDOG_MS}ms). Likely a multi-question form (#4604). Tearing down turn so the session is recoverable.`)

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
    const messageId = this._host._currentMessageId
    const duration = this._host._activeTurn ? this._host._nowMonotonic() - this._host._activeTurn.startedAt : 0

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
    this._host._clearPendingAnswerByToolUseId(toolUseId)
    // #5319 (WP-3.2): cancel THIS tool's stall watchdog. The 30s-stall path
    // arrives here after its own watchdog already self-deleted, but the
    // too-many-options (#4625) path tears down WITHOUT a prior fire, so clear
    // it explicitly. Idempotent; leaves any sibling watchdog intact.
    this._host._clearAskUserQuestionWatchdog(toolUseId)
    this._host._clearAskUserQuestionLock()
    // #4616: emit a synthetic tool_result FIRST so the dashboard's
    // activeTools entry for this AskUserQuestion is cleared. Without it
    // the footer "Running AskUserQuestion · Ns" pill keeps ticking
    // forever even though _isBusy is clear and the user sees the error
    // toast. The handler ignores any fields beyond {toolUseId, result,
    // truncated, images} (see store-core handleToolResult); pairing-by-
    // toolUseId is what drives the activeTools removal in store-core handlers.
    this._host.emit('tool_result', {
      toolUseId,
      result: synthResult,
      truncated: false,
    })
    // #4628: matching tool_start resolved — drop from the in-flight map.
    this._host._trackToolResult(toolUseId)

    // #4645: best-effort Ctrl-C so claude TUI itself unsticks from the
    // form screen. Without this the next sendMessage's prompt write
    // would queue behind the still-displayed form and silently desync.
    // Mirrors _handleStreamStall / _handleHardTimeout.
    if (this._host._term) {
      try { this._host._term.write('\x03') } catch { /* ignore */ }
    }

    // Clear all four inactivity timers — turn is over, nothing to
    // backstop, leaving them armed would fire stale callbacks on a
    // session that's already idle.
    if (this._host._resultTimeout) { clearTimeout(this._host._resultTimeout); this._host._resultTimeout = null }
    if (this._host._hardTimeout) { clearTimeout(this._host._hardTimeout); this._host._hardTimeout = null }
    if (this._host._streamStallTimeout) { clearTimeout(this._host._streamStallTimeout); this._host._streamStallTimeout = null }
    // #4732: pre-first-output watchdog. AskUserQuestion only fires
    // mid-turn (post-stream_start), so the first-output watchdog has
    // typically been disarmed already, but clear it explicitly so a
    // pathological race can't leak a live handle past the stall.
    this._host._clearFirstOutputWatchdog()

    // #4022: drop per-turn attachment dir (same as the other teardown
    // paths) so a failed turn doesn't leak materialized files until destroy().
    this._host._cleanupTurnAttachments(this._host._activeTurn)
    this._host._activeTurn = null
    this._host._isBusy = false
    this._host._currentMessageId = null

    // #4645: pair the stream_start fired at turn-start with stream_end +
    // result so the dashboard's streamingMessageId + Working banner +
    // Stop button all clear immediately (event-normalizer turns result
    // into result + agent_idle). The if-guard mirrors _handleStreamStall
    // — silent skip is acceptable here because the only way messageId
    // is null is a contract violation (_isBusy=true without an active
    // turn), tracked in #4642.
    if (messageId) this._host.emit('stream_end', { messageId })
    this._host._emitResult(
      { cost: null, duration, usage: null, sessionId: this._host._sessionId },
      emitResultReason,
    )
    this._host.emit('error', {
      code: errorCode,
      message: errorMessage,
      toolUseId,
    })
  }
}
