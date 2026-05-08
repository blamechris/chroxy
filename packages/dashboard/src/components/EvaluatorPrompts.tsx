/**
 * EvaluatorPrompts — auto-evaluator UI surfaces (#3188).
 *
 * Two co-located components for the auto-evaluator (#3068 epic, #3186
 * server emit, #3208 wire schemas):
 *
 * - `EvaluatorRewriteBanner`: collapsible inline banner above the
 *   rewritten message in the chat. Default state shows a one-line
 *   "Your message was rewritten to be clearer — see why" affordance;
 *   expanding reveals the original draft and the evaluator's reasoning.
 *   Rendered by App.tsx's `renderMessage` for `system` messages whose
 *   `evaluator.kind === 'rewrite'`.
 *
 * - `EvaluatorClarifyPrompt`: inline prompt block at the bottom of the
 *   chat with the clarifying question, the evaluator's reasoning, an
 *   `Iteration N/3` counter, and a free-text Send affordance that fires
 *   `onSubmit` with the answer (the App wires that to `sendInput`,
 *   re-triggering a fresh `user_input` round-trip on the server).
 *
 * Visual style follows PermissionPrompt / QuestionPrompt — inline blocks
 * inside the chat scroll container, no overlay modals.
 */
import { useState, useRef, useEffect } from 'react'
import type { EvaluatorRewriteMeta } from '../store/types'
import { MAX_EVALUATOR_ITERATIONS } from '../store/types'

export interface EvaluatorRewriteBannerProps {
  meta: EvaluatorRewriteMeta
}

export function EvaluatorRewriteBanner({ meta }: EvaluatorRewriteBannerProps) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = `evaluator-rewrite-${meta.evaluatorIterationId}-details`

  return (
    <div className="evaluator-rewrite-banner" data-testid="evaluator-rewrite-banner">
      <button
        type="button"
        className="evaluator-rewrite-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="evaluator-rewrite-icon" aria-hidden="true">
          {/* sparkle icon — same shape as the assistant icon in ChatView */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L14.09 8.26L20 9.27L15.55 13.97L16.91 20L12 16.9L7.09 20L8.45 13.97L4 9.27L9.91 8.26L12 2Z" />
          </svg>
        </span>
        <span className="evaluator-rewrite-summary">
          Your message was rewritten to be clearer — see why
        </span>
        <span className="evaluator-rewrite-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div id={detailsId} className="evaluator-rewrite-details" data-testid="evaluator-rewrite-details">
          <div className="evaluator-rewrite-section">
            <div className="evaluator-rewrite-label">Original</div>
            <div className="evaluator-rewrite-original">{meta.originalDraft}</div>
          </div>
          <div className="evaluator-rewrite-section">
            <div className="evaluator-rewrite-label">Rewritten</div>
            <div className="evaluator-rewrite-rewritten">{meta.rewritten}</div>
          </div>
          {meta.reasoning && (
            <div className="evaluator-rewrite-section">
              <div className="evaluator-rewrite-label">Why</div>
              <div className="evaluator-rewrite-reasoning">{meta.reasoning}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export interface EvaluatorClarifyPromptProps {
  /** 1-based iteration counter from the server (capped at MAX_EVALUATOR_ITERATIONS). */
  evaluatorIteration: number
  /** Operator's draft that triggered the clarify verdict. */
  originalDraft: string
  /** The clarifying question to display. */
  clarification: string
  /** Optional evaluator reasoning — shown in a smaller, subdued block. */
  reasoning: string
  /** Submit handler — App wires this to `sendInput` so the server re-evaluates. */
  onSubmit: (answer: string) => void
}

export function EvaluatorClarifyPrompt({
  evaluatorIteration,
  originalDraft,
  clarification,
  reasoning,
  onSubmit,
}: EvaluatorClarifyPromptProps) {
  const [text, setText] = useState('')
  const submittedRef = useRef(false)
  // #3645 — hoist `onSubmit` into a ref so the handler identity is stable
  // across re-renders (parents commonly pass a fresh inline closure each
  // render). The ref is assigned synchronously during render so handleSubmit
  // always invokes the *latest* prop, with no commit-phase window where a
  // user-input event could observe a stale closure (vs. useEffect, which
  // runs after paint and leaves a brief gap on the first render with new
  // props).
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit

  // #3645 — when the server fires a new clarify iteration, the same
  // component instance may stay mounted (the parent re-renders with new
  // props rather than unmounting). Reset the double-submit guard and the
  // textarea so the operator can answer the next question.
  useEffect(() => {
    submittedRef.current = false
    setText('')
  }, [evaluatorIteration])

  // Defensive clamp: server should already cap at MAX_EVALUATOR_ITERATIONS,
  // but if a future server raises the cap and forgets to update the
  // dashboard, render the higher value rather than `1/3` — the operator
  // gets accurate transparency either way.
  const totalIterations = Math.max(MAX_EVALUATOR_ITERATIONS, evaluatorIteration)

  const handleSubmit = () => {
    if (submittedRef.current) return
    const trimmed = text.trim()
    if (!trimmed) return
    submittedRef.current = true
    onSubmitRef.current(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter alone submits; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div
      className="evaluator-clarify-prompt"
      data-testid="evaluator-clarify-prompt"
    >
      <div className="evaluator-clarify-header">
        <span className="evaluator-clarify-title">Need a bit more detail</span>
        <span
          className="evaluator-clarify-iteration"
          data-testid="evaluator-clarify-iteration"
          aria-label={`Clarify iteration ${evaluatorIteration} of ${totalIterations}`}
        >
          Iteration {evaluatorIteration}/{totalIterations}
        </span>
      </div>
      <div className="evaluator-clarify-section">
        <div className="evaluator-clarify-label">Your draft</div>
        <div className="evaluator-clarify-original">{originalDraft}</div>
      </div>
      {/*
        #3644 — announce the clarify question to screen readers when it
        appears. `role="status"` + `aria-live="polite"` reads the prompt
        without interrupting the operator's current focus. `aria-atomic="true"`
        announces label + question text as a unit. Scoped to the question
        section only (Copilot review) — applying this to the outer prompt
        container would force the entire `originalDraft`, the controlled
        `<textarea>`, and the Send button into the live announcement, which
        is verbose and disruptive when `originalDraft` is long.
      */}
      <div
        className="evaluator-clarify-section"
        data-testid="evaluator-clarify-question-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="evaluator-clarify-label">Question</div>
        <div className="evaluator-clarify-question">{clarification}</div>
      </div>
      {reasoning && (
        <div className="evaluator-clarify-section evaluator-clarify-reasoning-section">
          <div className="evaluator-clarify-label">Why</div>
          <div className="evaluator-clarify-reasoning">{reasoning}</div>
        </div>
      )}
      <div className="evaluator-clarify-input-row">
        <textarea
          className="evaluator-clarify-input"
          data-testid="evaluator-clarify-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Answer the question…"
          aria-label="Clarification answer"
          rows={2}
        />
        <button
          type="button"
          className="evaluator-clarify-send"
          data-testid="evaluator-clarify-send"
          onClick={handleSubmit}
          disabled={!text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
