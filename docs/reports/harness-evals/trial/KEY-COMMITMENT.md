# Sealed key commitment — harness trial 2026-10

The owner's answer key for the ten queue issues is sealed outside the
repository (vault path `~/Obsidian/no-it-all/reviews/harness-trial-2026-10/KEY.md`,
encrypted at rest until README step 11). This file commits to its contents, so
that any edit after sealing is detectable, and so that graders can verify at
unseal that the key they receive is the one sealed before run 1.

| Field | Value |
|---|---|
| Sealed at (UTC) | 2026-10-17T23:14Z |
| SHA-256 of `KEY.md` | `2830876d692b01c9faa9e789f6c39c9e0af72d298f8077060a8377d635ccde57` |
| Size | 7641 bytes |
| Trial base T0 | `ab0348a0dc4a1b466672d2f0698c25b413073c43` |
| Verify | `shasum -a 256 KEY.md` (macOS) or `sha256sum KEY.md` must print the digest above |

The digest covers the whole file, including its own "Sealed at" line. A changed
key means a new row here, committed before run 1; once run 1 has started the key
is frozen, and a digest mismatch at unseal is reported as an incident, not
silently accepted.
