/**
 * #4622 — MultiQuestionForm post-answer summary should render multi-select
 * answers as human-readable comma-joined labels, not JSON-stringified
 * arrays.
 *
 * `MultiQuestionForm.handleSubmit` JSON-encodes multi-select answers
 * (`JSON.stringify(['App','Tests'])` → `'["App","Tests"]'`) before passing
 * them to `onSelect`, because the wire shape is
 * `Record<string,string>` and the server's `respondToQuestion` JSON.parse
 * splits it back. The dashboard's post-answer summary chip (rendered via
 * `markPromptAnswered(storeMsg.id, summary)`) must not leak that JSON
 * syntax into UX copy.
 *
 * `formatQuestionAnswerSummary` is the pure helper that App.tsx uses to
 * build the summary string from the `onSelect` answer payload — it
 * accepts both the legacy `string` shape (single-question / free-text
 * path) and the `Record<string,string>` shape (multi-question form, with
 * multi-select values JSON-stringified arrays).
 */
import { describe, it, expect } from 'vitest'
import { formatQuestionAnswerSummary } from './question-answer-summary'

describe('formatQuestionAnswerSummary', () => {
  describe('legacy single-question / free-text path', () => {
    it('returns plain string answers verbatim', () => {
      expect(formatQuestionAnswerSummary('Yes')).toBe('Yes')
    })

    it('returns free-text answers verbatim (no JSON treatment)', () => {
      expect(formatQuestionAnswerSummary('Some custom response')).toBe(
        'Some custom response',
      )
    })

    it('does not treat a stringified array as JSON when handed a bare string', () => {
      // Defensive: a single-question answer that happens to look like a
      // JSON array (very unlikely, but possible if Claude offers literal
      // bracket-prefixed option text) should still render verbatim.
      expect(formatQuestionAnswerSummary('[a,b]')).toBe('[a,b]')
    })
  })

  describe('multi-question form path (Record<string,string>)', () => {
    it('joins single-select answers with " | " between questions', () => {
      const answer = {
        'Which release strategy?': 'Minor',
        'Confirm?': 'Yes',
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which release strategy?: Minor | Confirm?: Yes',
      )
    })

    it('renders multi-select JSON-stringified arrays as comma-joined labels', () => {
      // Repro for #4622: the user sees `["App","Tests"]` instead of
      // `App, Tests` in the post-answer summary chip.
      const answer = {
        'Which areas?': JSON.stringify(['App', 'Tests']),
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which areas?: App, Tests',
      )
    })

    it('renders a mixed single-select + multi-select payload readably', () => {
      const answer = {
        'Which release strategy?': 'Minor',
        'Which areas?': JSON.stringify(['App', 'Tests', 'Docs']),
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which release strategy?: Minor | Which areas?: App, Tests, Docs',
      )
    })

    it('renders an empty multi-select array as an empty value (no brackets)', () => {
      // Multi-select with zero selections is allowed by the SDK; the
      // chip should not show `[]`.
      const answer = {
        'Which areas?': JSON.stringify([]),
      }
      expect(formatQuestionAnswerSummary(answer)).toBe('Which areas?: ')
    })

    it('renders a single-item multi-select array without brackets or quotes', () => {
      const answer = {
        'Which areas?': JSON.stringify(['App']),
      }
      expect(formatQuestionAnswerSummary(answer)).toBe('Which areas?: App')
    })

    it('leaves malformed JSON-looking strings as-is rather than crashing', () => {
      // Defensive: if a value starts with `[` but fails JSON.parse,
      // fall back to the raw string so the chip still renders something
      // useful instead of throwing.
      const answer = {
        'Which areas?': '[not valid json',
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which areas?: [not valid json',
      )
    })

    it('renders Other / freeform single-question answers as the typed text (#4651)', () => {
      // #4651 — single-question "Other" with freeform text. The summary
      // chip should show the user's typed text, not the literal "Other"
      // label that was used to pick the Other option in the menu.
      expect(
        formatQuestionAnswerSummary({
          otherLabel: 'Other',
          freeformText: 'my freeform thought',
        }),
      ).toBe('my freeform thought')
    })

    it('only flattens arrays — non-array JSON values are kept as the raw string', () => {
      // MultiQuestionForm.handleSubmit only ever JSON-stringifies arrays
      // of option values (see handleSubmit in QuestionPrompt.tsx). The
      // summary helper therefore only treats array-parse results
      // specially; any other JSON shape that happens to arrive (object,
      // number, etc.) keeps its raw representation so we don't silently
      // mangle unrelated data.
      const answer = {
        'A?': JSON.stringify({ a: 1 }),
        'B?': JSON.stringify(42),
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'A?: {"a":1} | B?: 42',
      )
    })
  })

  // #4621 / #4735 — per-question wire was widened to
  // `Record<string, string | string[]>` so multi-select answers can be
  // emitted as native arrays. The summary helper renders the array form
  // the same way as the pre-#4621 JSON-stringified form so mixed-version
  // rehydrated state stays readable end-to-end — without leaking
  // `["App","Tests"]` JSON syntax (which the legacy back-compat path
  // also covered).
  describe('native string[] multi-select (#4621 / #4735)', () => {
    it('renders a native string[] multi-select as comma-joined labels', () => {
      const answer: Record<string, string | string[]> = {
        'Which areas?': ['App', 'Tests'],
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which areas?: App, Tests',
      )
    })

    it('renders a mixed string + string[] payload readably', () => {
      const answer: Record<string, string | string[]> = {
        'Which release strategy?': 'Minor',
        'Which areas?': ['App', 'Tests', 'Docs'],
        'Confirm?': 'Yes',
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which release strategy?: Minor | Which areas?: App, Tests, Docs | Confirm?: Yes',
      )
    })

    it('renders an empty native string[] as an empty value', () => {
      const answer: Record<string, string | string[]> = {
        'Which areas?': [],
      }
      expect(formatQuestionAnswerSummary(answer)).toBe('Which areas?: ')
    })

    it('renders a single-item native string[] without brackets or quotes', () => {
      const answer: Record<string, string | string[]> = {
        'Which areas?': ['App'],
      }
      expect(formatQuestionAnswerSummary(answer)).toBe('Which areas?: App')
    })

    it('renders mixed single-select string + native multi-select string[]', () => {
      const answer: Record<string, string | string[]> = {
        'Which release strategy?': 'Minor',
        'Which areas?': ['App', 'Tests', 'Docs'],
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which release strategy?: Minor | Which areas?: App, Tests, Docs',
      )
    })

    it('preserves labels that contain commas (no comma-split corruption)', () => {
      // The legacy JSON-encoded path also handled this, but the native
      // string[] path makes it trivially obvious: round-tripping a label
      // with embedded commas must not split into separate entries.
      const answer: Record<string, string | string[]> = {
        'Which?': ['Hello, world', 'foo'],
      }
      expect(formatQuestionAnswerSummary(answer)).toBe(
        'Which?: Hello, world, foo',
      )
    })
  })
})
