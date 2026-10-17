# Sealed key commitment — harness trial 2026-10

The owner's answer key for the ten queue issues is sealed outside the
repository (vault path `~/Obsidian/no-it-all/reviews/harness-trial-2026-10/KEY.md`,
encrypted at rest until README step 11). This file commits to its contents, so
that any edit after sealing is detectable, and so that graders can verify at
unseal that the key they receive is the one sealed before run 1.

| Field | Value |
|---|---|
| Sealed at (UTC) | 2026-10-17T23:17Z |
| SHA-256 of `KEY.md` | `fb5599f33ddac7eb230b7edc29f0fefd5b3be7c39c746bf5dcd7055d24d40f23` |
| Size | 7782 bytes |
| Trial base T0 | derived: `git merge-base origin/trial/a1-cd origin/main` (README status table identifies the cut) |
| Verify | `shasum -a 256 KEY.md` (macOS) or `sha256sum KEY.md` must print the digest above |

The digest is of the plaintext `KEY.md`, covering the whole file including
`KEY.md`'s own "Sealed at" line; the encrypted copy at rest is `KEY.md.enc`. A
changed key means a replacement table here (the old digest stays in git
history), committed before run 1; once run 1 has started the key is frozen, and
a digest mismatch at unseal is reported as an incident, not silently accepted.
