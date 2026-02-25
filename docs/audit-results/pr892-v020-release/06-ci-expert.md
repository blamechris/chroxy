# CI Expert Agent Report — PR #892 (v0.2.0 Release)

**Perspective:** CI/CD Expert — pipeline correctness, build reproducibility, platform compatibility, release mechanics
**Rating: 3 / 5**

---

## Summary

The release pipeline added in this PR has two hard blockers: a macOS-incompatible `base64` flag that will crash the signing step on every macOS runner, and a `workflow_dispatch` trigger that breaks the changelog extraction and `github-release` job when used without a tag. There are also significant build time and supply chain concerns. The pipeline will not successfully produce a signed release on its first real run.

---

## Findings

### 1. base64 --decode -o Fails on macOS BSD — Release Blocker

In `.github/workflows/release.yml`, the macOS codesign setup step contains:

```bash
echo "$APPLE_CERTIFICATE" | base64 --decode -o certificate.p12
```

The `-o` flag (output to file) **does not exist** in macOS BSD `base64`. It exists in GNU coreutils `base64` (Linux). macOS ships with BSD `base64`, which only supports reading from stdin and writing to stdout.

The correct macOS-compatible command is:

```bash
echo "$APPLE_CERTIFICATE" | base64 --decode > certificate.p12
```

The GitHub-hosted macOS runners (`macos-latest`, `macos-13`, `macos-14`) all use BSD `base64`. This command will fail on every macOS runner with:

```
base64: invalid option -- o
```

This is a **hard release blocker**. The signing step will crash on every macOS build. Unsigned builds will either be rejected by Gatekeeper or fail the notarization step.

**Fix:** Replace `base64 --decode -o certificate.p12` with `base64 --decode > certificate.p12` on all macOS steps.

### 2. workflow_dispatch Makes Changelog Extraction Empty + github-release Fail

In `.github/workflows/release.yml`, the workflow is triggered by:

```yaml
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
```

The `github-release` job extracts the changelog for the current tag using a step like:

```bash
TAG="${GITHUB_REF#refs/tags/}"
# extract changelog section for $TAG
```

When triggered via `workflow_dispatch`, `GITHUB_REF` is `refs/heads/main` (or whichever branch). The `TAG` variable becomes `main`. The changelog extraction finds no matching section and produces an empty string. The `gh release create` command then either fails or creates a release with an empty body and the wrong tag.

There is no guard on the `github-release` job to prevent it from running on non-tag triggers.

**Fix:** Add an `if` condition to the `github-release` job:

```yaml
jobs:
  github-release:
    if: startsWith(github.ref, 'refs/tags/v')
```

This allows `workflow_dispatch` to be used for testing the build jobs without triggering a broken release creation.

### 3. No Rust/cargo Caching — 35–45 Minute Builds

In `.github/workflows/release.yml`, the Tauri desktop build steps do not include any caching for Rust compilation artifacts:

```yaml
- name: Build Tauri app
  uses: tauri-apps/tauri-action@v0
```

Without caching, every CI run compiles the entire Rust toolchain and all Cargo dependencies from scratch. For a Tauri project, this typically takes **35–45 minutes** per platform (macOS, Windows, Linux).

**Fix:** Add `Swatinem/rust-cache` before the Tauri build step:

```yaml
- uses: Swatinem/rust-cache@v2
  with:
    workspaces: './packages/desktop/src-tauri -> target'
```

This reduces repeat builds to 5–10 minutes by caching the compiled Cargo registry and incremental build artifacts.

### 4. Workflow-Level Permissions Too Broad

The workflow sets `contents: write` at the workflow level, applying it to all jobs including the pure build jobs. Any vulnerability in a third-party action (e.g., `tauri-apps/tauri-action@v0`) executing during the build step would have write access to the repository.

**Fix:** Remove the workflow-level permissions block and set per-job permissions:

```yaml
jobs:
  build-tauri:
    permissions:
      contents: read
  github-release:
    permissions:
      contents: write
```

### 5. No SHA Pinning on Third-Party Actions

Third-party actions are referenced by mutable version tags:

```yaml
- uses: actions/checkout@v4
- uses: actions/upload-artifact@v4
- uses: tauri-apps/tauri-action@v0
- uses: softprops/action-gh-release@v2  # (or similar)
```

Mutable tags are a supply chain risk. The `tauri-apps/tauri-action` action in particular has access to the runner during the build, including environment variables containing signing secrets.

**Fix:** Pin to commit SHAs with version comments:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
- uses: actions/upload-artifact@6f51ac03b9356f520e9adb1b1b7802705f340c2b  # v4.6.0
```

---

## Factual Note on Tauri $ENV_VAR Interpolation

The Skeptic and Builder agents flagged the `$APPLE_SIGNING_IDENTITY` literal strings in `tauri.conf.json` as non-functional. This is incorrect. **Tauri v2 does support `$ENV_VAR` substitution in `tauri.conf.json`** — this was added in Tauri v2.0 and is documented in the Tauri v2 configuration reference. The JSON config is processed before being passed to the build system, and `$VAR` strings in string values are replaced with the corresponding environment variable.

The Tauri signing config is therefore **not a blocker**. The real signing blocker is the `base64 -o` flag.

---

## Pipeline Correctness Summary

| Issue | Severity | Blocks Release? |
|-------|----------|-----------------|
| base64 --decode -o (macOS) | Critical | Yes — signing crashes |
| workflow_dispatch without tag guard | High | Yes — bad release on manual trigger |
| No Rust caching | Medium | No — just slow |
| Broad permissions | Low | No — risk, not breakage |
| No SHA pinning | Low | No — risk, not breakage |

---

## Conclusion

Two issues will cause the release pipeline to fail on its first real use: the `base64 -o` flag crashes on macOS runners, and `workflow_dispatch` without a tag guard produces a malformed GitHub release. Both are one-line fixes. The caching and pinning issues are improvements that should be filed as follow-up issues.

**Rating: 3/5** — the pipeline structure is sound but two correctness bugs block the first release.
