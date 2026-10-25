# Desktop Cargo advisory disposition — #8790

Assessed 2026-10-25 against the desktop lockfile and RustSec database commit
`21d909e4c8bd4e14c7aea58bf980c881a0053ab1` (1,352 advisories).
This record covers dependency resolution and advisory disposition. Platform test/build
results belong to the PR checks; locked metadata alone does not establish runtime safety.

## Compatible updates

All changes resolve within the existing `Cargo.toml` requirements. No manifest override,
vendoring, framework migration, or advisory suppression is used.

| Crate | Before | After | Reason |
| --- | --- | --- | --- |
| rustls | 0.23.40 | 0.23.46 | RUSTSEC-2026-0285, -0346, -0348, -0349 |
| rustls-webpki | 0.103.13 | 0.103.16 | RUSTSEC-2026-0382 |
| webpki-root-certs / webpki-roots | 1.0.7 | 1.0.10 | RUSTSEC-2026-0383 / -0381 |
| serde_with / serde_with_macros | 3.20.0 | 3.21.0 | GHSA-7gcf-g7xr-8hxj |
| anyhow | 1.0.102 | 1.0.103 | RUSTSEC-2026-0190 |
| event-listener | 5.4.1 | 5.4.2 | RUSTSEC-2026-0221 |
| tokio | 1.52.3 | 1.53.3 | RUSTSEC-2026-0386 |
| plist | 1.9.0 | 1.10.0 | Supported parent now requires quick-xml ^0.41.0 |
| wayland-scanner | 0.31.10 | 0.31.11 | Supported parent now requires quick-xml ^0.41 |
| tauri-winrt-notification | 0.7.2 | 0.7.3 | Supported parent removes quick-xml dependency |
| quick-xml | 0.37.5 and 0.39.4 | 0.41.0 | RUSTSEC-2026-0194 and -0195, previously reported for both versions |

`rustls` reaches Chroxy through direct `ureq 2.12.1`, the Tauri updater, and its
HTTP/TLS dependencies. `serde_with` reaches Chroxy through `tauri-utils 2.9.2`.
`plist` is in the Tauri build/configuration graph on all three desktop targets;
`wayland-scanner` is Linux-specific; `tauri-winrt-notification` is Windows-specific.

## Original GitHub alert IDs

These are lockfile dispositions, not claims that GitHub has already closed an alert.

| Alert | Advisory | Disposition and revisit trigger |
| --- | --- | --- |
| 247 | [GHSA-2mjx-qc3c-rqvc](https://github.com/rustls/rustls/security/advisories/GHSA-2mjx-qc3c-rqvc) | Updated rustls to 0.23.46, beyond first fix 0.23.45. Verify GitHub closes it after the lockfile lands; revisit any new rustls advisory. |
| 208 | [GHSA-7gcf-g7xr-8hxj](https://github.com/jonasbb/serde_with/security/advisories/GHSA-7gcf-g7xr-8hxj) | Updated serde_with to first fixed 3.21.0. This GHSA is absent from the assessed RustSec database, so Cargo audit does not verify this alert. Verify GitHub closes it after merge. |
| 207 | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) / GHSA-wrw7-89jp-8q8g | **Open, unfixed:** glib 0.18.5 remains in the Linux graph. Revisit when the Tauri/GTK/WebKit parent stack supports gtk 0.19 / glib 0.22 or another supported fixed stack, or if a reachable affected call is identified. |

## Linux glib constraint and interim mitigation

The actual Linux path includes `chroxy-desktop → tauri 2.11.2 → gtk 0.18.2 →
glib 0.18.5`, plus `tauri-runtime-wry 2.11.2 → wry 0.55.1 → webkit2gtk 2.0.2`
and related GTK crates requiring glib ^0.18. Locked target-filtered Cargo metadata
includes glib on `aarch64-unknown-linux-gnu`, and excludes it on
`aarch64-apple-darwin` and `x86_64-pc-windows-msvc`.

Fresh crates.io index metadata shows gtk 0.19.0 depends on glib ^0.22. However,
latest stable Tauri 2.12.5, tauri-runtime-wry 2.12.3 and wry 0.57.1 still require
gtk ^0.18. Updating those parents today does not remove this path. Upstream discussion
is tracked in [tauri-apps/tauri#12564](https://github.com/tauri-apps/tauri/issues/12564).

The advisory affects `VariantStrIter` iterator methods. A search of the resolved
604-package source set and Chroxy's Rust sources for `VariantStrIter` and
`array_iter_str` found matches only in glib's definitions, documentation and tests;
no application or transitive caller was identified. This is narrow static evidence,
not proof that the affected behavior is unreachable through every generated, native,
or dynamic path. The interim mitigation is to avoid introducing these APIs while the
parent constraint remains, keep alert 207 open, and validate the Linux build and
runtime on Linux. macOS tests do not exercise GTK. A passing Linux test/build also
does not repair the unsound implementation.

## Explicit Cargo scan and remaining records

Using cargo-audit 0.22.2 with the database above:

```sh
cargo audit --file packages/desktop/src-tauri/Cargo.lock --db /path/to/rustsec-db --json
```

The baseline contains **14 vulnerability records** and 15 warnings. The updated
lockfile contains **3 vulnerability records** and 12 warnings; the command still
**exits 1**. Record counts include multiple advisories for one crate and the same
advisory for multiple versions, and do not equal GitHub alert counts. No ignore
configuration or warning filtering is introduced.

| Remaining record | Actual parent / applicability | Disposition and revisit trigger |
| --- | --- | --- |
| [RUSTSEC-2026-0367](https://rustsec.org/advisories/RUSTSEC-2026-0367.html), [-0368](https://rustsec.org/advisories/RUSTSEC-2026-0368.html), [-0369](https://rustsec.org/advisories/RUSTSEC-2026-0369.html) | tauri-plugin-updater 2.10.1 → zip ^4 → 4.6.1, Windows only | **Open, unfixed.** Fix requires zip ≥9; latest stable updater 2.14.0 still declares zip ^4. Revisit a supported updater release adopting fixed zip or removing this extraction path. |
| RUSTSEC-2024-0429 | Linux GTK/glib stack | Open as alert 207 above. |
| RUSTSEC-2024-0370 | proc-macro-error 1.0.4 | Unmaintained warning retained; revisit a supported GTK/build-macro parent replacement. |
| RUSTSEC-2025-0075, -0080, -0081, -0098, -0100 | unic-char-range, unic-common, unic-char-property, unic-ucd-version, unic-ucd-ident 0.9.0 through the Tauri/URL-pattern graph | Unmaintained warnings retained; revisit supported parent replacement of the unic stack. |
| RUSTSEC-2026-0370, -0371, -0372 | zvariant 5.11.0, zbus_names 4.3.2, zvariant_derive 5.11.0 through the Linux zbus graph | Unmaintained warnings retained; revisit supported parent replacements or upstream maintenance resolution. |
| Yanked: clipboard-win 5.4.1; spin 0.9.8 | Existing locked transitive crates | Warnings retained; revisit supported parent updates or upstream yank guidance. No replacement is forced in this patch. |

The updater's Windows ZIP path invokes `ZipArchive::extract`; its download API
verifies the configured release signature before the normal download-and-install
path. Restrict updates to trusted signed releases and avoid separately passing
untrusted bytes to its install API. That trust boundary does not fix zip or justify
dismissing the three records. Unix-specific permission behavior in an advisory also
does not justify treating every ZIP record as inapplicable to Windows.

## Resolver effects and validation requirements

Cargo also reuses existing compatible Windows bindings for broad parent requirements.
Targeting the existing windows-sys 0.61.2 and iana-time-zone 0.1.65 with Cargo update
did not reverse these choices; dependency edges were not manually edited.

| Unchanged parent | Requirement | windows-sys before → after |
| --- | --- | --- |
| dirs-sys 0.5.0 | ≥0.59.0 | 0.61.2 → 0.59.0 |
| errno 0.3.14; rustix 1.1.4; tempfile 3.27.0 | ≥0.52, <0.62 | 0.61.2 → 0.52.0 |
| rustls-platform-verifier 0.7.0 | ≥0.52.0, <0.62.0 | 0.61.2 → 0.52.0 |
| muda 0.19.2; tray-icon 0.23.1 | ≥0.60, ≤0.61 | 0.61.2 → 0.60.2 |
| socket2 0.6.3; uds_windows 1.2.1 | ≥0.60, <0.62 | 0.61.2 → 0.60.2 |
| os_pipe 1.2.3 | ≥0.28, ≤0.61 | 0.61.2 → 0.45.0 |
| winapi-util 0.1.11 | ≥0.48.0, ≤0.61.* | 0.61.2 → 0.48.0 |

`iana-time-zone 0.1.65` permits windows-core ≥0.56, ≤0.62; Cargo reuses 0.61.2
instead of 0.62.2, removing the now-unused windows-core 0.62.2,
windows-result 0.4.1 and windows-strings 0.5.1 entries. All remaining binding
versions were already present in the lockfile. This increases the importance of
Windows native checks despite unchanged application source.

Locked offline metadata resolves for all three desktop targets. Required delivery
evidence remains locked native tests/builds on macOS, Linux and Windows, plus Linux
runtime validation or an explicit record of its remaining limitation. The PR must
report those results and retain follow-ups for the open records above.
