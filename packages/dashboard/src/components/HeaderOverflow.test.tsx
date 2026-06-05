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
  it('#header is a 3-column grid (auto | 1fr | minmax(0,auto)) so zones cannot overlap', () => {
    const block = css.match(/#header\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/display:\s*grid/)
    // #5197: the right column is minmax(0, auto) — it can shrink below its
    // content's max width so the cost badge truncates rather than the whole
    // cluster clipping off the right edge of the window.
    expect(block![0]).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*auto\)/)
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

  it('.header-right is a flex container that can shrink (min-width: 0) so the cluster never clips off-window (#5180/#5197)', () => {
    const block = css.match(/\.header-right\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/display:\s*flex/)
    // #5197: `min-width: max-content` (the #5180 fix) stopped sibling
    // overlap but made the cluster overflow the WINDOW edge once the
    // provider/model cost badge got long. `min-width: 0` lets the column
    // yield; overlap is still prevented by per-child `flex-shrink: 0` (next
    // test) while the squeeze is absorbed by the cost badge truncating.
    // Strip CSS comments so explanatory prose doesn't trip the regex.
    const decls = block![0].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(decls).toMatch(/min-width:\s*0/)
    expect(decls).not.toMatch(/min-width:\s*max-content/)
  })

  it('every direct child of .header-right is flex-shrink: 0 so no control overlaps a sibling (#5180)', () => {
    const block = css.match(/\.header-right > \*\s*\{[^}]*\}/s)
    expect(block, '.header-right > * rule must exist').toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
  })

  it('.header-right .status-bar may shrink (#5197) so the cost badge truncates while the token meter stays fixed', () => {
    // #5197: status-bar is the ONE right-cluster child allowed to shrink
    // (flex-shrink: 1 + min-width: 0) so the long provider/model cost badge
    // can ellipsis-truncate instead of pushing the token count off-screen.
    const block = css.match(/\.header-right \.status-bar\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/flex-shrink:\s*1/)
    expect(block![0]).toMatch(/min-width:\s*0/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    // The squeeze is absorbed by the cost badge (truncates), NOT the token
    // meter or provider tag (both fixed) — so "61 / 200.0k tokens" is never
    // clipped.
    const cost = css.match(/\.status-cost\s*\{[^}]*\}/s)
    expect(cost![0]).toMatch(/text-overflow:\s*ellipsis/)
    expect(cost![0]).toMatch(/flex-shrink:\s*1/)
    const meter = css.match(/\.status-context-meter\s*\{[^}]*\}/s)
    expect(meter![0]).toMatch(/flex-shrink:\s*0/)
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
    // #5197: a native <select> with `width: auto` does NOT grow to its
    // label in WebKit — it collapses to min-width and truncates the rest
    // ("Sonnet 4.6" → "Sonnet …"). The floor must fit the common model
    // labels (160px shows "Sonnet 4.6"); the 240px cap still truncates
    // pathologically long ids.
    expect(model![0]).toMatch(/width:\s*auto/)
    expect(model![0]).toMatch(/min-width:\s*160px/)
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

  // #4974 — Skills / Copy / Settings collapsed behind a single "⋯"
  // overflow trigger so the right zone no longer overlaps the model
  // selector at narrow widths. The trigger reuses `.header-icon-btn`
  // (so the flex-shrink: 0 protection above still applies) but the
  // popover gets its own surface so positioning + dismiss don't
  // collide with the existing CSS for native selects.
  it('.header-overflow wrapper does not shrink (#4974)', () => {
    const block = css.match(/\.header-overflow\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/position:\s*relative/)
    expect(block![0]).toMatch(/flex-shrink:\s*0/)
  })

  it('.header-overflow-menu is an absolutely-positioned popover anchored to the trigger (#4974)', () => {
    const block = css.match(/\.header-overflow-menu\s*\{[^}]*\}/s)
    expect(block).toBeTruthy()
    expect(block![0]).toMatch(/position:\s*absolute/)
    // Right-aligned so the menu hangs off the trigger toward the
    // center of the header (instead of clipping past the right edge).
    expect(block![0]).toMatch(/right:\s*0/)
  })

  it('responsive breakpoint relaxes the dropdown min-width per-kind (#3705 + #3720)', () => {
    // Narrow viewports get smaller floors for each kind. Anchored to
    // the per-kind selectors introduced in #3720 — the previous shared
    // 100/140 floor was only valid when all three selects shared one rule.
    const block = css.match(/@media \(max-width: 600px\)\s*\{[\s\S]*?\n\}/)
    expect(block).toBeTruthy()
    // #5181: model floor relaxed to 80px at narrow widths so short ids
    // aren't padded into a wide box; the 160px cap keeps long ids from
    // pushing the right cluster off-screen on phones.
    expect(block![0]).toMatch(/select\[data-kind="model"\]\s*\{\s*min-width:\s*80px;\s*max-width:\s*160px/)
    expect(block![0]).toMatch(/select\[data-kind="permission"\]\s*\{\s*min-width:\s*80px;\s*max-width:\s*110px/)
    expect(block![0]).toMatch(/select\[data-kind="thinking"\]\s*\{\s*min-width:\s*60px;\s*max-width:\s*80px/)
  })

  // #5179 (C1): the token meter stacks the fill bar beneath the label.
  it('.status-context-meter--stacked is a column so the bar sits under the label (#5179)', () => {
    const block = css.match(/\.status-context-meter--stacked\s*\{[^}]*\}/s)
    expect(block, '.status-context-meter--stacked rule must exist').toBeTruthy()
    expect(block![0]).toMatch(/flex-direction:\s*column/)
    // align-items: stretch lets the bar span the label width and anchor
    // to the same left edge instead of floating at a fixed inline width.
    expect(block![0]).toMatch(/align-items:\s*stretch/)
  })

  it('the stacked meter bar spans the column width instead of the inline 50px floor (#5179)', () => {
    const block = css.match(/\.status-context-meter--stacked \.status-context-bar\s*\{[^}]*\}/s)
    expect(block, 'stacked bar override rule must exist').toBeTruthy()
    expect(block![0]).toMatch(/width:\s*auto/)
  })
})
