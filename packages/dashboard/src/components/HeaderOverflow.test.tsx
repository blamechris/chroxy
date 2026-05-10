/**
 * Header overflow prevention CSS tests (#2297, #3705 follow-up).
 *
 * The header was originally a flex `space-between` container with three
 * zones (left/center/right). Under various content widths the center zone
 * could spill into the right zone (overflow: visible was needed for native
 * select dropdowns), causing Skills to underlap the gear button and long
 * model labels to underlap the status dot. The fix is a 3-column CSS grid
 * with explicit auto / 1fr / auto tracks and `overflow: hidden` on the
 * center wrapper.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

describe('Header overflow prevention (#2297, #3705 follow-up)', () => {
  it('#header is a 3-column grid (auto | 1fr | auto) so zones cannot overlap', () => {
    const block = css.match(/#header\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/display:\s*grid/)
    expect(block![0]).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/)
  })

  it('#header has overflow: visible (native selects render outside header bounds)', () => {
    const match = css.match(/#header\s*\{[^}]*overflow:\s*visible/s)
    expect(match).toBeTruthy()
  })

  it('.header-left is a flex container (its children layout) — sizing pinned by the grid `auto` track', () => {
    const block = css.match(/\.header-left\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/display:\s*flex/)
    // No flex-shrink — header-left is a grid item, not a flex item. The
    // grid `auto` column track is what keeps it content-sized;
    // flex-shrink would be a no-op here. Anchor the negation on the
    // `flex-shrink:` declaration form so explanatory comment text
    // mentioning the property doesn't trigger a false positive.
    expect(block![0]).not.toMatch(/flex-shrink:/)
  })

  it('.header-right is a flex container — sizing pinned by the grid `auto` track', () => {
    const block = css.match(/\.header-right\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/display:\s*flex/)
    expect(block![0]).not.toMatch(/flex-shrink:/)
  })

  it('.header-right .status-bar (a flex item inside header-right) gets flex-shrink: 0 + nowrap', () => {
    // status-bar IS a flex item here (header-right is display: flex), so
    // flex-shrink: 0 is the right primitive — without it, the cost +
    // token text could truncate to "718 toke...".
    const block = css.match(/\.header-right \.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })

  it('.header-center has min-width: 0 and overflow: hidden so its column can shrink without spilling', () => {
    const block = css.match(/\.header-center\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/overflow:\s*hidden/)
  })

  it('.header-center select has text truncation (shared across kinds)', () => {
    const block = css.match(/\.header-center select\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/overflow:\s*hidden/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    expect(block![0]).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('.header-center select widths are per-kind so the model dropdown does not impose its width on the smaller permission/thinking selects', () => {
    // Pre-#3720 a single rule applied 180–240px to all three header
    // selects. That floor was right for the model select but visually
    // crowded the right zone for the permission ("Approve"/"Accept Edits")
    // and thinking ("Auto"/"High"/"Max") selects whose longest labels
    // are far shorter. Per-kind data attributes let each select get a
    // width that matches its content.
    const model = css.match(/\.header-center select\[data-kind="model"\]\s*\{[^}]*\}/s)
    const permission = css.match(/\.header-center select\[data-kind="permission"\]\s*\{[^}]*\}/s)
    const thinking = css.match(/\.header-center select\[data-kind="thinking"\]\s*\{[^}]*\}/s)
    expect(model).toBeTruthy()
    expect(permission).toBeTruthy()
    expect(thinking).toBeTruthy()
    expect(model![0]).toMatch(/min-width:\s*180px/)
    expect(model![0]).toMatch(/max-width:\s*240px/)
    expect(permission![0]).toMatch(/min-width:\s*110px/)
    expect(permission![0]).toMatch(/max-width:\s*160px/)
    expect(thinking![0]).toMatch(/min-width:\s*80px/)
    expect(thinking![0]).toMatch(/max-width:\s*110px/)
  })

  // Note: the prompt-evaluator-toggle moved out of the header into
  // SettingsPanel (which uses `.settings-field-checkbox` styling). The
  // old `.prompt-evaluator-toggle` CSS class was deleted in the same
  // change — there is nothing to test here. Coverage for the new
  // location lives in SettingsPanel.test.tsx ("Active session" describe).

  it('.header-icon-btn does not shrink (icon overlap protection)', () => {
    // The .header-text-btn class was removed when Skills was converted to
    // an icon-only button — only .header-icon-btn remains.
    const block = css.match(/\.header-icon-btn\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
  })

  it('.status-bar (footer) has min-width: 0 and white-space: nowrap', () => {
    // Anchor on a leading newline so we match the bare `.status-bar` rule,
    // not the new `.header-right .status-bar` compound selector that ends
    // with the same suffix.
    const block = css.match(/\n\.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })

  it('responsive breakpoint relaxes the dropdown min-width per-kind (#3705 + #3720)', () => {
    // Narrow viewports get smaller floors for each kind. Anchored to
    // the per-kind selectors introduced in #3720 — the previous shared
    // 100/140 floor was only valid when all three selects shared one rule.
    const block = css.match(/@media \(max-width: 600px\)\s*\{[\s\S]*?\n\}/)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/select\[data-kind="model"\]\s*\{\s*min-width:\s*120px;\s*max-width:\s*160px/)
    expect(block![0]).toMatch(/select\[data-kind="permission"\]\s*\{\s*min-width:\s*80px;\s*max-width:\s*110px/)
    expect(block![0]).toMatch(/select\[data-kind="thinking"\]\s*\{\s*min-width:\s*60px;\s*max-width:\s*80px/)
  })
})
