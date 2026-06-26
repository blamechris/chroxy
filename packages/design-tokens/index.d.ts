/** A titled section of design tokens: a list of `[cssVarName, value]` pairs. */
export interface TokenGroup {
  readonly title: string
  readonly vars: ReadonlyArray<readonly [name: string, value: string]>
}

/** The canonical token map, in emission order, grouped for `theme.css` sections. */
export declare const TOKEN_GROUPS: ReadonlyArray<TokenGroup>

/** Flat, ordered list of every `[cssVarName, value]` across all groups. */
export declare const ALL_TOKENS: ReadonlyArray<readonly [string, string]>

/** Render the dashboard `theme.css` (`:root` custom properties) from the map. */
export declare function generateThemeCss(): string

/** Render the dashboard `theme/tokens.ts` (typed token objects) from the map. */
export declare function generateTokensTs(): string
