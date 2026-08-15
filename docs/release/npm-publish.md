# Publishing Chroxy to npm

Three packages go to npm, and they must be published **together, in dependency
order**. This document is the procedure; `scripts/publish-siblings.sh` is the
executable form of it.

| package | published from | why |
|---|---|---|
| `@chroxy/protocol` | the package dir | shared schemas + wire types |
| `@chroxy/store-core` | `packages/store-core/publish/` (staging dir) | its in-repo manifest points `.` at `src/index.ts` for the ~148 app/dashboard files that import it as TypeScript; that is not publishable |
| `@chroxy/server` | the package dir | the daemon + the `chroxy` bin |

`@chroxy/app`, `@chroxy/dashboard`, `@chroxy/desktop`, and `@chroxy/design-tokens`
are **not** published.

## The rule that matters

`@chroxy/server` depends on its siblings with a bounded range (`^X.Y.Z`), and
`@chroxy/store-core` depends on `@chroxy/protocol` the same way. A range only
resolves against what is **already on the registry**, so:

> Publish `protocol` → `store-core` → `server`, and confirm each one is live
> before publishing the next.

Get this wrong and the failure is loud (`ETARGET`, no matching version) rather
than silent — that is deliberate, and it is why the ranges are bounded. Under
the old `"*"` ranges the same mistake resolved a *stale* sibling instead and
shipped a package that installed cleanly and crashed on first import (#7187).

## Procedure

### 0. Preconditions

- On `main`, clean tree, at the release commit (the `chore(release): cut vX.Y.Z` merge).
- The `vX.Y.Z` tag exists and `release.yml` is green.
- Authenticated: `npm whoami` returns your username. If not, `npm login`
  (browser flow; works with 2FA). npm now restricts 2FA-bypassing tokens, so
  prefer `npm login` over a long-lived automation token.

### 1. Verify the artifacts — always, before publishing anything

```bash
node scripts/verify-publish-artifacts.mjs
```

This packs all three tarballs, installs them into a throwaway prefix with a
clean `HOME`, and asserts:

- no test files ride along in any tarball (the `files` allowlist has not drifted)
- `chroxy --version` reports the expected version
- `chroxy doctor` comes up clean
- every declared entry point imports from a from-scratch consumer project.
  The list is **derived from the published manifests' `exports` maps**, not
  hardcoded, so adding an export cannot silently fall outside the gate.
  Currently that resolves to `@chroxy/protocol`, `/schemas`, `/project`,
  `/handler-coverage`, `@chroxy/store-core`, and `/crypto`.

Non-zero exit means **do not publish**. npm does not allow republishing a
version, and unpublishing is barred after 72 hours, so a bad publish is
permanent.

### 2. Publish

```bash
bash scripts/publish-siblings.sh
```

It runs step 1 for you, then publishes in order, waiting for each package to
appear on the registry before starting the next. Pass `--dry-run` to rehearse.

Doing it by hand is the same three commands:

```bash
npm publish -w @chroxy/protocol --access public
npm run build:publish -w @chroxy/store-core && npm publish packages/store-core/publish --access public
npm publish -w @chroxy/server --access public
```

Expect an OTP prompt per publish if 2FA is on for writes.

### 3. Confirm

```bash
npm install -g @chroxy/server --prefer-online && chroxy doctor
```

`--prefer-online` is not optional here. npm caches registry metadata, so a
plain `npm install -g @chroxy/server` right after publishing will often install
the **previous** version and look like the publish failed. Check the version it
actually resolved before concluding anything.

## Why the verification step exists

Three defects reached the edge of an irreversible publish in a single day, and
**every one of them was invisible to unit tests, lint, typecheck, and CI**,
because those test the source tree and none of them test the artifact:

1. `"*"` sibling ranges resolved the two-month-old published protocol against a
   current server — `SyntaxError: does not provide an export named
   'CODEX_DEFAULT_SANDBOX'` at ESM link time (#7187).
2. `@chroxy/protocol` shipped **zero** `dist/*.js`. It had no `files` field and
   no `.npmignore`, so npm fell back to `.gitignore` — which ignores `dist/` —
   and dropped 31 built files that git tracks.
3. `@chroxy/store-core` shipped 59 raw `*.test.ts` files and a root export
   pointing at `src/index.ts`, which Node refuses to load from `node_modules`
   ("Stripping types is currently unsupported"). It had also lost the
   extension-rewrite step its emitted specifiers need, so `dist` was
   unloadable even once it shipped.

All three installed fine and failed on first import. The only check that finds
this class is packing the tarball and running it, so that check is now a script
rather than something remembered.

## Related

- `packages/store-core/scripts/build-publish-dir.mjs` — assembles store-core's
  publishable form, and self-checks both entry points before finishing.
- #7187 — the incident.
- #7189 — this runbook and the verification gate.
