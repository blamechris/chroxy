//! Drift detector: keep the three Tauri-command lists in lockstep.
//!
//! Adding a `#[tauri::command]` requires touching three sites in lockstep:
//!
//!   1. `src/lib.rs` — `tauri::generate_handler![...]` (runtime registration)
//!   2. `build.rs` — `APP_COMMANDS` slice (drives `tauri-build`'s autogen
//!      of `allow-<cmd>` / `deny-<cmd>` permission TOMLs)
//!   3. `capabilities/default.json` — `allow-<cmd>` entries in `permissions`
//!      (grants the webview the right to invoke the command)
//!
//! Missing an entry in (1) makes the command undefined; missing (2) skips
//! the permission TOML; missing (3) causes Tauri 2.11+ to reject the call
//! at runtime with `"Command <name> not allowed by ACL"` — silent until
//! someone tries to invoke it (issue #3741).
//!
//! This test parses all three sources and asserts the command sets match.
//! It is intentionally lo-fi (text scraping, not a Rust parser) so it has
//! zero runtime deps beyond what the crate already pulls in.
//!
//! See issue #3742 for context.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Extract the bracketed body of `const APP_COMMANDS: &[&str] = &[ ... ];`
/// from `build.rs` and return the string literals inside as a sorted set.
///
/// We locate the slice body by anchoring on the `= &[` that starts the
/// initializer — not the first `[`, which would land on the `&[&str]` type
/// annotation and produce an empty body.
fn parse_app_commands(build_rs: &str) -> BTreeSet<String> {
    let marker = "const APP_COMMANDS";
    let decl_start = build_rs
        .find(marker)
        .expect("APP_COMMANDS constant not found in build.rs");
    let init = build_rs[decl_start..]
        .find("= &[")
        .expect("`= &[` initializer not found after APP_COMMANDS declaration");
    let body_start = decl_start + init + "= &[".len();
    let close = build_rs[body_start..]
        .find(']')
        .expect("closing `]` not found for APP_COMMANDS slice");
    let body = &build_rs[body_start..body_start + close];
    extract_string_literals(body)
}

/// Extract the body of `tauri::generate_handler![ ... ]` in `src/lib.rs`
/// and return the command identifiers, stripped of `#[cfg(...)]` attributes
/// and whitespace.
fn parse_generate_handler(lib_rs: &str) -> BTreeSet<String> {
    let marker = "generate_handler![";
    let start = lib_rs
        .find(marker)
        .expect("generate_handler! macro not found in src/lib.rs");
    let body_start = start + marker.len();

    // Find the macro's closing `]` by depth-counting — naive find of the
    // first `]` would land inside a nested attribute like
    // `#[cfg(target_os = "macos")]` and silently truncate the list.
    let close = find_matching_close_bracket(&lib_rs[body_start..])
        .expect("closing `]` not found for generate_handler! macro");
    let body = &lib_rs[body_start..body_start + close];

    // Strip `#[cfg(...)]` attributes — they wrap conditional commands like
    // the macOS-only voice handlers but aren't part of the command name.
    let stripped = strip_cfg_attrs(body);

    stripped
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Return the byte offset of the `]` that closes the bracket group `s`
/// starts at depth 1 in (i.e. callers have already consumed the opening
/// `[`). Tracks nested `[`/`]` pairs so nested attributes don't terminate
/// the scan prematurely.
fn find_matching_close_bracket(s: &str) -> Option<usize> {
    let mut depth: i32 = 1;
    for (i, c) in s.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Strip every `#[cfg(...)]` attribute from a snippet, balancing brackets
/// so nested parens inside `cfg(...)` don't confuse the parser.
fn strip_cfg_attrs(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip `#[ ... ]`, accounting for nested `[`/`]` pairs.
            let mut depth = 0;
            let mut j = i + 1;
            while j < bytes.len() {
                if bytes[j] == b'[' {
                    depth += 1;
                } else if bytes[j] == b']' {
                    depth -= 1;
                    if depth == 0 {
                        j += 1;
                        break;
                    }
                }
                j += 1;
            }
            i = j;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// Pull the `allow-<cmd>` entries from `capabilities/default.json`'s
/// `permissions` array, dropping the `allow-` prefix and converting kebab
/// to snake case so they line up with command identifiers. Plugin
/// permissions (anything with a `:` like `shell:allow-open` or `core:default`)
/// are filtered out — only bare `allow-*` strings reference our custom
/// commands.
fn parse_capabilities_allow(json: &str) -> BTreeSet<String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).expect("capabilities/default.json is not valid JSON");
    let perms = parsed
        .get("permissions")
        .and_then(|v| v.as_array())
        .expect("`permissions` array missing from capabilities/default.json");

    perms
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.contains(':')) // skip plugin perms (e.g. `shell:allow-open`)
        .filter_map(|s| s.strip_prefix("allow-"))
        .map(|kebab| kebab.replace('-', "_"))
        .collect()
}

/// Extract every `"..."` literal inside `body`. Naive but adequate — the
/// snippets we feed it never contain escape sequences or comments with `"`.
fn extract_string_literals(body: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c == '"' {
            let mut buf = String::new();
            for c2 in chars.by_ref() {
                if c2 == '"' {
                    break;
                }
                buf.push(c2);
            }
            out.insert(buf);
        }
    }
    out
}

fn read(rel: &str) -> String {
    let path: PathBuf = manifest_dir().join(rel);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
}

fn diff(label_a: &str, a: &BTreeSet<String>, label_b: &str, b: &BTreeSet<String>) -> String {
    let only_a: Vec<&String> = a.difference(b).collect();
    let only_b: Vec<&String> = b.difference(a).collect();
    if only_a.is_empty() && only_b.is_empty() {
        return String::new();
    }
    let mut msg = String::new();
    if !only_a.is_empty() {
        msg.push_str(&format!(
            "\n  in {label_a} but missing from {label_b}: {only_a:?}"
        ));
    }
    if !only_b.is_empty() {
        msg.push_str(&format!(
            "\n  in {label_b} but missing from {label_a}: {only_b:?}"
        ));
    }
    msg
}

#[test]
fn command_lists_are_in_sync() {
    let build_rs = read("build.rs");
    let lib_rs = read("src/lib.rs");
    let caps = read("capabilities/default.json");

    let app_commands = parse_app_commands(&build_rs);
    let handler = parse_generate_handler(&lib_rs);
    let allow = parse_capabilities_allow(&caps);

    // Sanity: we should find a non-trivial number of commands. If any of
    // the parsers silently returned an empty set (because the source format
    // changed) the equality checks below would falsely pass.
    assert!(
        app_commands.len() >= 5,
        "APP_COMMANDS parser returned suspiciously few entries ({}); parser likely broken",
        app_commands.len()
    );
    assert!(
        handler.len() >= 5,
        "generate_handler! parser returned suspiciously few entries ({}); parser likely broken",
        handler.len()
    );
    assert!(
        allow.len() >= 5,
        "capabilities allow-* parser returned suspiciously few entries ({}); parser likely broken",
        allow.len()
    );

    let mut errors = String::new();
    errors.push_str(&diff(
        "build.rs APP_COMMANDS",
        &app_commands,
        "lib.rs generate_handler!",
        &handler,
    ));
    errors.push_str(&diff(
        "build.rs APP_COMMANDS",
        &app_commands,
        "capabilities/default.json allow-*",
        &allow,
    ));
    errors.push_str(&diff(
        "lib.rs generate_handler!",
        &handler,
        "capabilities/default.json allow-*",
        &allow,
    ));

    if !errors.is_empty() {
        panic!(
            "\nTauri command lists are out of sync (see issue #3742).\n\
             When adding or removing a `#[tauri::command]`, update all three:\n\
               - src/lib.rs       (generate_handler! list)\n\
               - build.rs         (APP_COMMANDS slice)\n\
               - capabilities/default.json (`allow-<cmd>` permission entry)\n\
             Differences detected:{errors}\n"
        );
    }
}

#[test]
fn parsers_self_check() {
    // Guardrails that the helpers behave as expected. These run independent
    // of the source files so the test catches parser regressions even when
    // the real lists happen to be in sync.

    let sample_build = r#"
        const APP_COMMANDS: &[&str] = &[
            "foo",
            "bar_baz",
            // a comment with a "string" should be tolerated by extract_string_literals
            "qux",
        ];
    "#;
    let cmds = parse_app_commands(sample_build);
    // The comment-embedded "string" gets captured too — accepted, the real
    // build.rs has no such comments inside the slice.
    assert!(cmds.contains("foo"));
    assert!(cmds.contains("bar_baz"));
    assert!(cmds.contains("qux"));

    let sample_lib = r#"
        .invoke_handler(tauri::generate_handler![
            alpha,
            beta,
            #[cfg(target_os = "macos")]
            gamma,
            delta,
        ])
    "#;
    let handlers = parse_generate_handler(sample_lib);
    let expected: BTreeSet<String> = ["alpha", "beta", "gamma", "delta"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(handlers, expected);

    let sample_caps = r#"{
        "permissions": [
            "core:default",
            "shell:allow-open",
            "allow-alpha",
            "allow-beta-thing",
            "allow-gamma"
        ]
    }"#;
    let allow = parse_capabilities_allow(sample_caps);
    let expected: BTreeSet<String> = ["alpha", "beta_thing", "gamma"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(allow, expected);
}
