# Package coverage reports

CI publishes four separate `*-coverage` artifacts and a named summary in each
test job. Each artifact contains `lcov.info`, `coverage-summary.json`, and an
HTML report (`index.html`). The server artifact excludes c8's raw `coverage/tmp/`
instrumentation data. The summary validator fails if an expected report is
missing, malformed, or has no instrumented source.

| Package | Runner | Source denominator |
| --- | --- | --- |
| Server | Node test runner + c8 | `packages/server/src/`, including unexecuted files; excludes CLI entry point, test client, tests and scripts per `.c8rc.json` |
| Mobile app | Jest | `packages/app/src/**/*.{ts,tsx}`; excludes declarations and the generated xterm bundle |
| Dashboard | Vitest + V8 | `packages/dashboard/src/**/*.{ts,tsx}`; excludes tests, declarations, test setup and generated theme tokens |
| Store core | Vitest + V8 | `packages/store-core/src/**/*.{ts,tsx}`; excludes tests, declarations and contract fixtures |

The reports count each package's own instrumented source. Percentages are not
averaged across packages. `coverage-summary.json` carries the line, branch,
function and statement numerators and denominators for each package. Coverage
validation maps the JSON summary's absolute runner paths and LCOV's `src/`
paths to the selected package's source identities, then checks that both
reporters name the same files with the same line counts. The mapping uses the
`/packages/<package>/src/` portion, so an artifact can be checked after moving
it to another checkout without assuming the runner's absolute directory.
The HTML index must contain the complete Istanbul coverage table and document.
Coverage means code executed, not assertions checked. The initial rollout only
reports percentages; it does not add a global percentage threshold. The first measured
baseline at main `8f3d5497` was 96.25% server lines / 87.14% branches and
61.21% mobile lines / 55.06% branches. Dashboard and store core had no reports
at that baseline, so their previous values are unmeasured rather than zero.

## Local generation

With Node 22 and dependencies installed, run `npm test -w @chroxy/server`,
`npm test -w @chroxy/app`, `npm run test:coverage -w @chroxy/dashboard`, and
`npm run test:coverage -w @chroxy/store-core`. The app and server normal CI
commands already collect coverage. Run `node scripts/report-coverage.mjs <package>`
for the same report validation and Markdown table printed in CI.

## Measurement gaps and later gates

Protocol, design tokens, Claude hooks, the remaining JavaScript packages, and
the Rust desktop code are unmeasured by these four reports. Add runner-specific
source-wide reports for those packages before comparing percentages. Rust needs
its own instrumentation and denominator; no JavaScript percentage stands in for
it.

After the baseline has stabilized, set per-package no-regression floors from
observed reports, with an explicit tolerance for instrumentation changes.
Then add a changed-code gate that compares touched lines against the target
branch, handles renamed and deleted files, and fails closed when either coverage
or diff data is unavailable. Keep existing mobile debt visible while adding
behavioral tests for SessionScreen, GitView, FileBrowser and full journeys.

Codecov is optional and is not part of this rollout. Its current tokenless
upload path for public repositories requires organization settings that allow
tokenless uploads, or an eligible unprotected branch; an administrator must
verify that setting and connect the repository before a Codecov-backed patch
gate can be relied on. If token authentication stays required, a repository
upload token must be configured as a CI secret. See [Codecov's token
documentation](https://docs.codecov.com/docs/codecov-tokens). The local CI
summary and artifacts require neither Codecov nor a secret.
