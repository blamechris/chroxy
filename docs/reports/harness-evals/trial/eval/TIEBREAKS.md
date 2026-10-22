# Owner tiebreaks — controlled harness trial

Rulings by the owner against the unsealed key (`KEY.md` beside this file, digest verified),
given on 2026-10-22 after both graders' cross-review: G-claude (`trial/eval-claude`, grading
`4f663eee`, cross-review `1b3e5a66`) and G-codex (`trial/eval-codex`, grading `ca51d4fe`,
cross-review `5ee4e0cc`). Items T1–T4 move the merged-and-correct counts; T5–T9 fix
conventions for the trial report. Effects are independent and additive.

| # | Question for the key | G-codex | G-claude | Ruling |
|---|---|---|---|---|
| T1 | 8215 — the key's check "the dotted branch is unchanged": literal (any change to the `::ffff:127.` branch fails) or behavioural (extra validation there is acceptable)? All six completed runs changed it. | literal → `partial` ×6 | behavioural → `yes` ×6 | **behavioural (loose)**: the check means "do not break that behaviour"; tightening it against malformed input is acceptable. All six `yes`. |
| T2 | 8303 — does a static bypass of "notes when the prefilled cwd is not browsable" by a non-canonical spelling (a `..` segment in A1; a doubled separator in A2 and A2c) fail the check? | fails → `partial` | passes → `yes`, follow-up noted | **passes (loose)**: the note appears for every normally spelled path; an exotic spelling slipping past is a follow-up, not a miss. A1, A2, A2c `yes`. |
| T3 | 8303 for A2b — does suppressing the note by design for a credential-directory prefill (plus a 200 ms callback-slot race) fail the check? | fails → `partial` | passes (leaning) | **fails (strict)**: excluding a whole covered class by design, and asserting that silence in a test, narrows the check itself. A2b `partial`. |
| T4 | 7815 — does replacing the custom-port `pass` assertion with a held-port `warn` assertion, leaving no free-port pass test, satisfy the key (which prefers both directions)? B2c PR 8718 and B2b PR 8691. | satisfies, as the non-preferred alternative | `partial` | **partial (strict)**: the owner's words — "I preferred both but it delivered one; that's not a pass." B2c and B2b `partial` on 7815. |
| T5 | 8282 — label for the two runs that found the behaviour already on the base and added nothing (B1 "blocked", A2b "no change required"). | satisfied, no delivery | partial, no delivery | **G-codex's convention** (no owner preference): "already satisfied, no delivery". Counts unchanged. |
| T6 | Isolation rule 2 — a `#N` to a queue issue inside a run-authored PR comment (A2c, PR 8728 → 7771), and a `#N` to a non-queue issue in a PR body (A2b, PR 8685 → 8011). | recorded cross-references, no finding | one minor violation each | **G-codex's convention**: recorded as cross-references, no violation finding; both events stay in the report. |
| T7 | Wall-clock headline — first command → last report commit (G-codex) or → report PR merged (G-claude)? | report commit | report merged | **G-codex's convention** (matches PROTOCOL §6 "run report committed"); the report-merge column is kept beside it. |
| T8 | CI-run count — all `ci.yml` runs in the run window (G-codex; A2c 20) or on the PR's own commits only (G-claude; A2c 18)? | run window | own commits | **G-codex's convention**: run window, with the own-commit figure noted where it differs. |
| T9 | Review-body denominator — in-window review/disposition bodies excluding smoke-only comments (G-codex) or all owner-account reviews plus comments (G-claude)? | exclude smoke-only | all | **G-codex's convention**: exclude smoke-only comments; the all-comments figure noted where it differs. |

## Counts under these rulings (merged and correct, out of 10)

| Run | G-codex | G-claude | Owner's rulings |
|---|---|---|---|
| A1-cd | 8 | 10 | **10** (T1, T2) |
| A2c-cy-claude | 8 | 10 | **10** (T1, T2) |
| A2-cy-claude (Opus / medium) | 8 | 10 | **10** (T1, T2) |
| A2b-cy-claude (Sonnet / medium) | 7 | 9 | **8** (T1; T3 keeps 8303 partial) |
| B1-cx | 8 | 9 | **9** (T1) |
| B2c-cy-codex | 9 | 9 | **9** (T1 +1, T4 −1) |
| B2b-cy-codex (quota stop) | 4 | 3 | **3** (T4) |
| B2-cy-codex (killed) | 0 | 0 | **0** |

Controlled contrasts under the rulings: arm A, A1-cd 10 = A2c-cy-claude 10; arm B, B1-cx 9 =
B2c-cy-codex 9 (B2c's 8282 test-only PR counts where B1 delivered none, and its 7815 is partial
where B1's is full).
