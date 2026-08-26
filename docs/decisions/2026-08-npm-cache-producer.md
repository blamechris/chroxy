# The hosted npm cache is produced by `dashboard-smoke`

**Date**: 2026-08-26
**Issue**: #7386 (follow-on from #7383 / #7385)
**Status**: decided — adopt, at no cost
**Touches**: `.github/workflows/ci.yml` (`dashboard-smoke`, `runner-target.outputs.npmcache`),
`.github/workflows/nightly-k8s-integration.yml`, `.github/workflows/release.yml`
**Pinned by**: `packages/server/tests/ci-npm-cache-routing.test.js`

## The question

#7385 fixed a real blocker: `actions/setup-node`'s `cache: npm` was making every
self-hosted job download and unpack a **521 MB** `actions/cache` tarball over a
`~/.npm` that was **already 2.2 GB and warm**. On `chroxy-linux-winbox-01` that
download stalled at `Received 0 of 521063625 (0.0%), 0.0 MBs/sec` until the job
burned its whole timeout, and the cancellation rendered as `fail`.

The fix routed the cache on the same predicate as the runner: empty on the
self-hosted pool, `npm` on GitHub-hosted runners (fork PRs). Correct — but
`actions/setup-node` keys its cache on `RUNNER_OS`/`RUNNER_ARCH`, **not** on which
pool the runner belongs to. So who saves the `node-cache-Linux-x64-npm-*` entry
that fork PRs restore?

Only a job that is **GitHub-hosted** *and* runs on **`main`**. A fork PR cannot
help the next one: GitHub scopes a PR's cache *writes* to that PR's own ref, so a
fork that cold-installs and saves populates a scope nothing else can read. There
is no self-healing here.

## Decision: cache `dashboard-smoke`. It was already the job we would have added.

The first draft of this record accepted the gap, on the reasoning that closing it
meant paying for a hosted job on every push to `main`. **That premise was wrong,
and it is the whole reason this is a short document.** `ci.yml`'s
`dashboard-smoke` already:

- runs on `ubuntu-24.04` — GitHub-hosted, x86_64, deliberately pinned there for
  Playwright and explicitly *not* routed through `runner-target`;
- has no `if:` and no `needs:`, and `ci.yml` triggers on `push: branches: [main]`;
- runs a root `npm ci`.

It simply declared no `cache:`, so it **cold-installed the whole monorepo on every
run and saved nothing**. Adding `cache: npm` with the three-lockfile key makes it
the producer at **no meaningful cost to the job**.

### Measured, after the fact — and it corrects this record's first claim

This section originally said the change *makes the job faster*, so the cost was
"negative". Measured on the first post-merge run against the two before it, that
is **wrong**:

| run | total job | `npm ci` |
|---|---|---|
| `f2129e6d3` — with cache | **97 s** | 29 s (plus ~5 s restore) |
| `1674dba8e` — no cache | 93 s | 35 s |
| `4514acc2a` — no cache | 95 s | 35 s |

`npm ci` did get ~6 s faster, and the 497 MB restore costs ~5 s, so the two
cancel: 93–95 s becomes 97 s. **A wash, marginally on the wrong side of it.**

The reason is worth carrying, because it caps what cache-warming can ever buy
here: `~/.npm` is npm's **download** cache. `npm ci` still extracts and links all
1353 packages either way, and that is what dominates the 29–35 s. The cache
removes network fetch, not install work.

So the argument for doing this is **not** "it is free because the job gets
faster". It is:

- the job cost is ~zero (±5 s, inside run-to-run noise), and
- a *dedicated* warm job would cost a whole additional hosted job per push.

Same conclusion, honest reason. The producer function itself is unaffected: on a
key MISS — the case that matters, right after a lockfile change — the job saves
the new entry. On a hit it correctly does not re-save (`Cache hit occurred on the
primary key …, not saving cache`), which is why the first post-merge run produced
no new entry.

`nightly-k8s-integration.yml` (hosted, `refs/heads/main`, 06:00 UTC) remains a
second producer. It is the fallback: it re-saves after the 7-day eviction on a
quiet week, and covers a run where the push producer is skipped.

## What this does NOT fix, and nothing can

A fork PR that **itself changes a `package-lock.json`** has a cache key that
exists in no readable scope, and no producer will ever create it — a producer on
`main` builds `main`'s key, not the PR's. No `restore-keys` are configured, so
there is no partial fallback either. **Such a PR cold-installs on every push, for
its whole life.** A dependency-bump PR from a contributor is exactly that shape.

This is expected, costs a couple of minutes per job, and does not fail. It is
written up for contributors in `CONTRIBUTING.md` so nobody spends time hunting a
bug that isn't there. Adding `restore-keys` would give partial hits, at the cost
of restoring a stale tree over the correct one — not worth it for a
`~/.npm` cache the subsequent `npm ci` reconciles anyway.

## The invariants, and why they are guards rather than prose

Three comments used to carry "keep the producer hosted / scheduled / cached". That
is the weakest possible form, and the trap here is sharper than "someone might
edit it":

> The all-workflows guard in `ci-npm-cache-routing.test.js` **requires** that a
> self-hosted job not hardcode an npm cache — correctly, that is #7383. So moving
> a producer to the self-hosted pool would make **CI itself demand** the removal
> of its `cache: npm` line. The change would go green while deleting the producer.

A guard that drives the defect next to it needs a counterpart. `ci-npm-cache-routing.test.js`
now asserts, **scoped to the property rather than to a roster of filenames**:

- at least one producer exists at all;
- at least one runs on a **push to main** (not merely `on: push:` — `release.yml`
  is `push: tags`, and its hosted jobs *do* carry `cache: npm`, so a loose check
  let `release.yml` stand in for the real producer. Measured: with the loose
  regex, deleting the real producer left the suite green);
- at least one runs on a **schedule**;
- no producer sits on a self-hosted runner — this fails *first*, and explains the
  trap above.

Swapping in an equivalent producer passes. Removing the last one fails.

`dashboard-smoke` is also the first and only entry in `ALLOWED_HARDCODED_CACHE`,
the named exception to "no setup-node step hardcodes `cache: npm`". That
allowlist is name-based by necessity — an exception has to name what it excepts —
and it carries a staleness check, so renaming the job fails the guard on purpose:
renaming the one job allowed to hardcode the cache is exactly when someone should
re-read why the exception exists.

## When to revisit

- **A contributor reports slow CI on a PR that does not touch a lockfile.** That
  should not happen now; if it does, a producer has been lost in a way the guards
  did not catch, and the guards need the missing assertion.
- **Lockfile-changing fork PRs become common enough to be a real drag.** The only
  remedy is `restore-keys`, with the stale-restore tradeoff above. Decide it
  deliberately; do not add them reflexively.
- **The 7-day eviction starts biting** — a week with no push to `main` and no
  nightly. Currently impossible while the nightly runs daily.

## The Windows cache: kept, and it is not dead config

There are **zero** `node-cache-Windows-*` entries in the repo's cache list. #7386
asked whether `release.yml`'s `desktop-windows` `cache: npm` should be dropped as
a permanent no-op. It should not.

The emptiness is explained, not contradictory. A tag-push run *does* save into
that tag's scope; `actions/cache` evicts after 7 days without access, and releases
here are months apart (v0.11.0 on 2026-08-15, v0.9.46 before it on 2026-06-21).
Any entry the last release wrote aged out long before the list was taken.

No *PR* has ever seen one because: CI's `server-tests-windows` routes through
`winrunner` to the self-hosted `chroxy-win`, where `npmcache` is empty; a fork PR
on `windows-latest` writes to its own isolated ref scope; and `release.yml` runs
on tag refs, whose caches a PR branch cannot read.

But a release **re-dispatched on an existing tag**
(`gh workflow run release.yml --ref vX.Y.Z`, a real workflow here) reads that
same tag scope and hits what the first run saved — provided the re-dispatch is inside the 7-day window, which is
the realistic case, since you re-dispatch to fix a failed release rather than
months later. Narrow value, not zero. The comment in `release.yml` says so, so the
next audit does not re-file it as a no-op — which is nearly what happened here.
