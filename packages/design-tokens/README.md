# @chroxy/design-tokens

The design-token source of truth — the raw color / spacing / typography values
that the dashboard's theme is **generated** from. Editing tokens here (not the
generated CSS) is how you change the dashboard's look without hand-editing
generated files.

## Flow

```
packages/design-tokens/  (token source — src/tokens-data.js)
        │  npm run generate-tokens -w packages/dashboard
        ▼
packages/dashboard/src/theme/{theme.css, tokens.ts}   (GENERATED — do not hand-edit)
```

Change a token → run `npm run generate-tokens -w packages/dashboard` → the
dashboard's `theme.css` + `tokens.ts` are regenerated. The dashboard's
hand-authored `components.css` consumes these variables and is edited directly.

## Scripts

```bash
npm test -w packages/design-tokens   # node --test (validates the token set)
```

See [`@chroxy/dashboard`](../dashboard) for how the tokens are consumed.
