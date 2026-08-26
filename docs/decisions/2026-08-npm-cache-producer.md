# The hosted npm cache has no dedicated producer, deliberately

**Date**: 2026-08-26
**Issue**: #7386 (follow-on from #7383 / #7385)
**Status**: decided — accept, with a named escalation trigger (below)
**Touches**: `.github/workflows/ci.yml` (`runner-target.outputs.npmcache`),
`.github/workflows/nightly-k8s-integration.yml`, `.github/workflows/release.yml`

## The question

#7385 fixed a real blocker: `actions/setup-node`'s `cache: npm` was making every
self-hosted job download and unpack a **521 MB** `actions/cache` tarball over a
`~/.npm` that was **already 2.2 GB and warm**. On `chroxy-linux-winbox-01` that
download stalled at `Received 0 of 521063625 (0.0%), 0.0 MBs/sec` until the job
burned its whole timeout, and the cancellation rendered as `fail`.

The fix routed the cache on the same predicate as the runner: empty on the
self-hosted pool, `npm` on GitHub-hosted runners (fork PRs). Correct — but
`actions/setup-node` keys its cache on `RUNNER_OS`/`RUNNER_ARCH`, **not** on which
pool the runner belongs to. The `node-cache-Linux-x64-npm-…` entry that fork PRs
restore on `ubuntu-24.04` had been *produced* by the self-hosted `push`-to-`main`
jobs. After #7385, no `push` job saves it.

So: does the hosted cache need a job whose only purpose is to warm it?

## Decision: no. Accept it.

## Why — the exposure is bounded, and something already closes it

Three facts, all measured rather than assumed (2026-08-26):

1. **Nothing on `main` has produced a Linux-x64 entry since #7385.** The newest
   `refs/heads/main` entry was *created* `2026-08-23T20:14Z`, before #7385 merged
   (`2026-08-26T01:57Z`). Later timestamps on it are `last_accessed_at`, which
   updates on a **restore**, not a save. The issue's premise is correct.

2. **A fork PR can never help the next fork PR.** GitHub scopes a PR's cache
   *writes* to that PR's own ref. A fork that cold-installs and saves populates a
   scope nothing else can read. There is no self-healing here.

3. **But `nightly-k8s-integration.yml` is a producer.** It runs on `ubuntu-24.04`
   — GitHub-hosted — on `refs/heads/main`, at 06:00 UTC, with `cache: npm` and the
   correct `**/package-lock.json` key. On a key miss it *saves*. The issue named it
   as "the only remaining producer" and treated that as the problem; it is also
   the mitigation.

Put together, the exposure is not "every fork PR cold-installs". It is:

> a lockfile change lands on `main` → **up to ~24 h** → the 06:00 nightly misses
> the new key and saves it. Fork PRs opened inside that window cold-install
> across ~12 hosted jobs; fork PRs outside it hit the cache.

**One case the window does not describe, and it is the likelier one.** A fork PR
that *itself changes a lockfile* has a key that exists in no readable scope and
that no nightly will ever create — the nightly builds `main`'s key, not the PR's.
There are no `restore-keys`, so there is no partial fallback. Such a PR
cold-installs on **every push, for its whole life**, and a warm job on `main`
would not help it either. A dependency-bump PR from a contributor is exactly the
shape that hits this, so do not read "up to ~24 h" as the worst case — it is the
worst case only for PRs that leave the lockfiles alone.

A cold `npm ci` of the monorepo costs a couple of minutes per job and **does not
fail**. Fork PRs are currently rare (this is a solo-maintained project). Paying a
hosted job on every push to `main` to shorten a rare window for a rare event is
the wrong trade today.

## The escalation trigger — read this before deciding it is still fine

**This decision is a function of contributor volume, and that is the one input
most likely to change.** Chroxy is open source; the reasoning above stops holding
the moment fork PRs stop being rare.

Adopt the deliberate producer when **any** of these becomes true:

- **External fork PRs become routine** — say, more than one a week, or any week
  where two land inside the same post-lockfile-change window.
- **A contributor reports slow or timing-out CI** on a first PR, or you see a
  hosted job spend minutes in `npm ci` where the cache should have hit.
- **The nightly stops running, is disabled, or moves off `ubuntu-24.04`** — it is
  load-bearing here and nothing states that inside its own workflow. Removing it
  silently removes the only producer.
- **Lockfile churn increases** (a Renovate cadence change, a dependency-heavy
  epic), which widens the fraction of time spent inside the window.

### The proper fix, when the trigger fires

Add a small `push`-to-`main` job to `ci.yml` whose only purpose is to warm the
hosted cache. It must run on a **GitHub-hosted** runner — a self-hosted one has
`npmcache` empty by #7383's routing and would save nothing:

```yaml
  warm-hosted-npm-cache:
    # NOT routed through runner-target: the point is to produce the entry that
    # fork PRs on ubuntu-24.04 restore, and the self-hosted pool saves nothing.
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: '**/package-lock.json'
      - run: npm ci
```

Two things that will bite whoever adds it:

- `packages/server/tests/ci-npm-cache-routing.test.js` asserts that **no**
  setup-node step hardcodes `cache: npm`, deliberately including unrouted jobs.
  This job is the first legitimate exception; add it to that guard explicitly
  rather than loosening the rule.
- `cache-dependency-path` must stay `'**/package-lock.json'`. This repo has three
  lockfiles and setup-node's default key is the root one alone — see
  `packages/server/tests/ci-cache-key.test.js` and
  `docs/false-safety-guards.md` entry 16.

## The Windows cache: kept, and it is not dead config

There are **zero** `node-cache-Windows-*` entries in the repo's cache list, of any
age. #7386 asked whether `release.yml`'s `desktop-windows` `cache: npm` should be
dropped as a permanent no-op. It should not, for a reason the issue did not have:

- CI's `server-tests-windows` routes through `winrunner` to the self-hosted
  `chroxy-win`, where `npmcache` is empty — so CI never produces one.
- A fork PR resolving to `windows-latest` writes to its own isolated ref scope.
- `release.yml` runs on **tag** refs, whose caches are not readable from a PR
  branch — which is why no PR has ever seen one.

But a release **re-dispatched on an existing tag** (`gh workflow run release.yml
--ref vX.Y.Z`, a real workflow here) reads that same tag scope, and hits the entry
the first run saved. The input earns its keep on the second run, not the first.
The comment now in `release.yml` says so, so the next audit does not re-file it.
