use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

/// Subset of the daemon's `config.json` fields that the desktop app needs.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChroxyConfig {
    #[serde(default)]
    pub api_token: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub tunnel: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_port() -> u16 {
    8765
}

/// Warn once per process about a relative `CHROXY_CONFIG_DIR`, mirroring the
/// daemon's `warnedRelative` in `config-dir.js`.
static WARNED_RELATIVE: AtomicBool = AtomicBool::new(false);

/// Is `p` absolute by the same rule the **daemon** applies?
///
/// Deliberately NOT `Path::is_absolute()`, because that diverges from Node's
/// `path.isAbsolute()` on Windows and the two halves have to agree on one answer:
///
/// | value    | Node win32 | Rust `is_absolute()` |
/// |----------|-----------|----------------------|
/// | `C:\x`   | true      | true                 |
/// | `/x`     | **true**  | **false**            |
/// | `\x`     | **true**  | **false**            |
/// | `x`      | false     | false                |
///
/// Rust requires a drive prefix *and* a root on Windows; Node accepts a bare
/// root-relative path. Using Rust's rule would make the desktop **refuse a value
/// the daemon accepts**, so `CHROXY_CONFIG_DIR=/data` on Windows would relocate
/// the server while the tray kept reading `~/.chroxy` — the #7239 split-brain
/// this resolver exists to remove, reappearing on one platform only and invisible
/// from a macOS dev machine.
///
/// On Unix the two rules already coincide (`is_absolute` ⇔ starts with `/`), and
/// `\x` is correctly non-absolute there under both.
fn is_absolute_like_node(p: &str) -> bool {
    #[cfg(windows)]
    {
        let b = p.as_bytes();
        match b {
            [] => false,
            // A leading separator — Node's win32 rule accepts it.
            [b'/', ..] | [b'\\', ..] => true,
            // `X:/…` or `X:\…` (a bare `X:` is drive-RELATIVE, so it is not).
            [d, b':', s, ..] => d.is_ascii_alphabetic() && (*s == b'/' || *s == b'\\'),
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        Path::new(p).is_absolute()
    }
}

/// Resolve the config root from a raw `CHROXY_CONFIG_DIR` value and a home dir.
///
/// Split out from [`config_dir`] and kept **pure** so the tests never touch the
/// process environment: `cargo test` runs tests as threads in a SINGLE process,
/// so a `set_var` in one test would race every other test's view of the root
/// (and `config_path_returns_some` below asserts on the default). The env read
/// lives in the thin wrapper instead.
///
/// Semantics match `packages/server/src/config-dir.js` exactly, because the two
/// halves must agree — see [`config_dir`] and [`is_absolute_like_node`].
/// (Plain backticks, not brackets: a file path is not a Rust item, so `[...]`
/// around it renders as literal brackets rather than a link.)
fn resolve_config_dir(raw: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    match raw {
        // An empty value falls through to the default, matching the `||`
        // semantics of the daemon's resolver (`if (!raw) return default`).
        Some(r) if !r.is_empty() => {
            if is_absolute_like_node(r) {
                return Some(PathBuf::from(r));
            }
            // Refused, not resolved — a relative value would otherwise land
            // desktop state wherever the app happened to be launched from. The
            // daemon refuses it identically, so both halves stay on the default
            // rather than diverging.
            let fallback = home.map(|h| h.join(".chroxy"));
            if !WARNED_RELATIVE.swap(true, Ordering::Relaxed) {
                // The message names the directory actually being used, and says
                // so only when there IS one: with no resolvable home there is no
                // default to fall back to, and claiming "~/.chroxy" then would
                // send the operator looking for state in a directory nothing
                // wrote to. Mirrors the daemon, which interpolates
                // `defaultConfigDir()` for the same reason.
                match &fallback {
                    Some(dir) => eprintln!(
                        "[config] ignoring CHROXY_CONFIG_DIR={:?}: not an absolute path. Using {} instead.",
                        r,
                        dir.display()
                    ),
                    None => eprintln!(
                        "[config] ignoring CHROXY_CONFIG_DIR={:?}: not an absolute path, and no home \
                         directory could be resolved — no config directory is available.",
                        r
                    ),
                }
            }
            fallback
        }
        _ => home.map(|h| h.join(".chroxy")),
    }
}

/// The daemon's config/state root — `~/.chroxy` by default, relocated by
/// `CHROXY_CONFIG_DIR` (#7052 / #7241).
///
/// **Read per call, never cached.** A `OnceCell`/`lazy_static` here would
/// reproduce the exact defect #7052 was filed for: the daemon's sixteen
/// module-scope `const` copies froze at import and silently ignored the
/// override, so the variable relocated only half the state.
///
/// The desktop app must agree with the server on this value. `server.rs` spawns
/// the embedded server **without** clearing `CHROXY_CONFIG_DIR`, so the child
/// inherits it; before this existed the Rust side read `~/.chroxy` while that
/// child read the relocated root — the same silent split as #7239, and silent
/// for the same reason (the token survives, because `API_TOKEN` is passed
/// explicitly in the spawn env, so only the *other* state diverges).
pub fn config_dir() -> Option<PathBuf> {
    resolve_config_dir(
        std::env::var("CHROXY_CONFIG_DIR").ok().as_deref(),
        dirs::home_dir(),
    )
}

/// Returns the path to `config.json` inside [`config_dir`]
/// (`~/.chroxy/config.json` with no override).
pub fn config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("config.json"))
}

/// Serialises tests whose result depends on `CHROXY_CONFIG_DIR`.
///
/// `cargo test` runs tests as threads in a SINGLE process, so one test's
/// `set_var` is immediately visible to every test running alongside it. Any test
/// that sets the variable — or that resolves a path and asserts on the result —
/// takes this lock, or the two flake against each other.
///
/// Poisoning is absorbed (`into_inner`) on purpose: if a test panics while
/// holding the lock, the remaining tests should report their own results rather
/// than a cascade of `PoisonError`s that hides which one actually broke.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Load and parse the daemon's `config.json`. Returns default config if file doesn't exist.
/// Falls back to OS keychain for apiToken if not present in config file.
pub fn load_config() -> ChroxyConfig {
    let mut config = load_config_file();
    config.api_token = token_or_store(config.api_token.take(), || {
        let token = get_keychain_token();
        if token.is_some() {
            println!("[config] Loaded API token from OS keychain");
        }
        token
    });
    config
}

/// The file token, or if the file has none (a missing or empty one), the
/// credential store's. The server migrates tokens from config.json to the store
/// on first run. An empty token is no token, here and in [`proof_token`].
fn token_or_store(file_token: Option<String>, read_store: impl FnOnce() -> Option<String>) -> Option<String> {
    non_empty(file_token).or_else(|| non_empty(read_store()))
}

/// `None` for a missing or empty token.
fn non_empty(token: Option<String>) -> Option<String> {
    token.filter(|t| !t.is_empty())
}

/// The configured daemon port, read from `config.json` only. Unlike
/// [`load_config`] this never consults the OS keychain, so it is cheap and
/// prompt-free enough for the tray's periodic port probe (#8267).
pub fn load_port() -> u16 {
    match load_config_file().port {
        0 => default_port(),
        p => p,
    }
}

/// How long [`proof_token`] reuses an answer from the OS credential store.
const PROOF_TOKEN_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// A [`fresh_token`] read this recently is reused rather than read again.
const FRESH_TOKEN_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(2);

/// One answer from the OS credential store and when it was read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TokenCache {
    entry: Option<(std::time::Instant, Option<String>)>,
}

impl TokenCache {
    pub(crate) const fn new() -> Self {
        Self { entry: None }
    }

    /// The cached answer if it was read less than `max_age` before `now`.
    pub(crate) fn get(&self, now: std::time::Instant, max_age: std::time::Duration) -> Option<Option<String>> {
        let (at, token) = self.entry.as_ref()?;
        (now.saturating_duration_since(*at) < max_age).then(|| token.clone())
    }

    pub(crate) fn put(&mut self, now: std::time::Instant, token: Option<String>) {
        self.entry = Some((now, token));
    }
}

static KEYCHAIN_CACHE: std::sync::Mutex<TokenCache> = std::sync::Mutex::new(TokenCache::new());

/// The effective token read through `cache`: the file token, else the credential
/// store's answer when it was read less than `max_age` ago, else read it now.
fn effective_token(
    file_token: Option<String>,
    cache: &mut TokenCache,
    now: std::time::Instant,
    max_age: std::time::Duration,
    read_store: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Some(t) = non_empty(file_token) {
        return Some(t);
    }
    if let Some(cached) = cache.get(now, max_age) {
        return cached;
    }
    let token = non_empty(read_store());
    cache.put(now, token.clone());
    token
}

/// How old an answer from the credential store may be when it is reused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenRead {
    /// The tray's periodic probe: reuse an answer up to [`PROOF_TOKEN_TTL`] old.
    Cached,
    /// A retry after a proof failed: read again unless the answer is under
    /// [`FRESH_TOKEN_MIN_AGE`] old.
    Fresh,
}

impl TokenRead {
    fn max_age(self) -> std::time::Duration {
        match self {
            TokenRead::Cached => PROOF_TOKEN_TTL,
            TokenRead::Fresh => FRESH_TOKEN_MIN_AGE,
        }
    }
}

fn read_token(kind: TokenRead) -> Option<String> {
    let mut cache = KEYCHAIN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    effective_token(
        load_config_file().api_token,
        &mut cache,
        std::time::Instant::now(),
        kind.max_age(),
        get_keychain_token,
    )
}

/// The access token to challenge a daemon with when the tray probes the port:
/// the `config.json` token, else the credential store's answer from the last
/// [`PROOF_TOKEN_TTL`]. The tray probes every few seconds, and spawning the
/// credential tool each time would prompt over and over.
pub fn proof_token() -> Option<String> {
    read_token(TokenRead::Cached)
}

/// The same source as [`proof_token`], read again: it bypasses the cache (except
/// for an answer read within the last [`FRESH_TOKEN_MIN_AGE`]). A daemon whose
/// token was rotated since the cache was filled proves with the new one.
pub fn fresh_token() -> Option<String> {
    read_token(TokenRead::Fresh)
}

/// Parse `config.json` without the keychain fallback. Returns the default config
/// if the file is missing or malformed.
fn load_config_file() -> ChroxyConfig {
    let path = match config_path() {
        Some(p) => p,
        None => return ChroxyConfig::default(),
    };

    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ChroxyConfig::default(),
    };

    match serde_json::from_str(&contents) {
        Ok(config) => {
            note_parse_result(None);
            config
        }
        Err(e) => {
            let msg = format!("Failed to parse {}: {}", path.display(), e);
            if note_parse_result(Some(&msg)) {
                eprintln!("[config] {}", msg);
            }
            ChroxyConfig::default()
        }
    }
}

/// The last parse failure that was logged, so a malformed `config.json` read on
/// every tray poll (#8267) is reported once per change, not every few seconds.
static LAST_PARSE_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Record a parse outcome (`None` = parsed fine). Returns true when `err` is a
/// new failure that should be logged.
fn note_parse_result(err: Option<&str>) -> bool {
    let mut last = LAST_PARSE_ERROR.lock().unwrap_or_else(|e| e.into_inner());
    should_log_parse_error(&mut last, err)
}

fn should_log_parse_error(last: &mut Option<String>, err: Option<&str>) -> bool {
    match err {
        None => {
            *last = None;
            false
        }
        Some(msg) if last.as_deref() == Some(msg) => false,
        Some(msg) => {
            *last = Some(msg.to_string());
            true
        }
    }
}

/// Read the API token from the OS keychain.
/// Uses the same service/account as the Node.js server (keychain.js):
///   service = "chroxy", account = "api-token"
fn get_keychain_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args(["find-generic-password", "-s", "chroxy", "-a", "api-token", "-w"])
            .output()
            .ok()?;
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("secret-tool")
            .args(["lookup", "service", "chroxy", "account", "api-token"])
            .output()
            .ok()?;
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
        None
    }

    #[cfg(windows)]
    {
        get_dpapi_token()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        None
    }
}

// -- Windows credential store (#6644) ------------------------------------------
//
// On Windows the daemon protects its API token with the per-user DPAPI key and
// stores the base64 ciphertext at `%LOCALAPPDATA%\Chroxy\<service>__<account>.dpapi`
// (`packages/server/src/keychain.js`), removing it from `config.json` once stored.
// The read here is the same one the server does: run the same PowerShell script
// with the ciphertext on stdin. A drift test pins the script and the file name
// against `keychain.js`.

/// `keychain.js` `PS_UNPROTECT`: base64 ciphertext on stdin, plaintext on stdout.
#[cfg(any(windows, test))]
const WIN_PS_UNPROTECT: &str = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))";

/// `keychain.js` `_winCredFile` name: anything outside `[A-Za-z0-9._-]` becomes `_`.
#[cfg(any(windows, test))]
fn win_cred_file_name(service: &str, account: &str) -> String {
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
            .collect()
    };
    format!("{}__{}.dpapi", safe(service), safe(account))
}

/// `keychain.js` `winCredDir`: `%LOCALAPPDATA%\Chroxy`, else `<home>\AppData\Local\Chroxy`.
#[cfg(any(windows, test))]
fn win_cred_dir(local_app_data: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    match local_app_data.filter(|v| !v.is_empty()) {
        Some(dir) => Some(Path::new(dir).join("Chroxy")),
        None => home.map(|h| h.join("AppData").join("Local").join("Chroxy")),
    }
}

/// The ciphertext in a `.dpapi` file: its trimmed text, or `None` when empty.
#[cfg(any(windows, test))]
fn parse_dpapi_ciphertext(file: &str) -> Option<String> {
    let c = file.trim();
    (!c.is_empty()).then(|| c.to_string())
}

/// The token in the PowerShell output: one trailing line break removed, `None`
/// when nothing is left.
#[cfg(any(windows, test))]
fn parse_dpapi_plaintext(out: &str) -> Option<String> {
    let t = out.strip_suffix("\r\n").or_else(|| out.strip_suffix('\n')).unwrap_or(out);
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(windows)]
fn get_dpapi_token() -> Option<String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    let dir = win_cred_dir(std::env::var("LOCALAPPDATA").ok().as_deref(), dirs::home_dir().as_deref())?;
    let file = dir.join(win_cred_file_name("chroxy", "api-token"));
    let cipher = parse_dpapi_ciphertext(&fs::read_to_string(file).ok()?)?;

    let root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    let powershell = format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", root);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", WIN_PS_UNPROTECT])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Every way out below the spawn ends the child first.
    let reap = |child: &mut std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
    };
    let Some(mut stdin) = child.stdin.take() else {
        reap(&mut child);
        return None;
    };
    if stdin.write_all(cipher.as_bytes()).is_err() {
        reap(&mut child);
        return None;
    }
    drop(stdin);

    // Bounded, like the server's own read (5 s).
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if start.elapsed() > std::time::Duration::from_secs(5) => {
                reap(&mut child);
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => {
                reap(&mut child);
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    parse_dpapi_plaintext(&out)
}

/// Parse config from a JSON string. Test-only helper.
#[cfg(test)]
pub(crate) fn parse_config(json: &str) -> Result<ChroxyConfig, serde_json::Error> {
    serde_json::from_str(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- the effective token ---------------------------------------------

    use std::time::{Duration, Instant};

    #[test]
    fn an_empty_token_is_no_token() {
        assert_eq!(non_empty(Some(String::new())), None);
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("t".into())), Some("t".into()));
    }

    #[test]
    fn load_config_treats_an_empty_file_token_like_a_missing_one() {
        assert_eq!(token_or_store(Some("f".into()), || panic!("not read")).as_deref(), Some("f"));
        assert_eq!(token_or_store(Some(String::new()), || Some("s".into())).as_deref(), Some("s"));
        assert_eq!(token_or_store(None, || Some("s".into())).as_deref(), Some("s"));
        assert_eq!(token_or_store(Some(String::new()), || Some(String::new())), None);
        assert_eq!(token_or_store(None, || None), None);
    }

    #[test]
    fn the_file_token_wins_and_an_empty_one_falls_through_to_the_store() {
        let t0 = Instant::now();
        let mut cache = TokenCache::new();
        let got = effective_token(Some("from-file".into()), &mut cache, t0, PROOF_TOKEN_TTL, || panic!("not read"));
        assert_eq!(got.as_deref(), Some("from-file"));
        let got = effective_token(Some(String::new()), &mut cache, t0, PROOF_TOKEN_TTL, || Some("from-store".into()));
        assert_eq!(got.as_deref(), Some("from-store"), "an empty file token reads the store, as load_config does");
        let got = effective_token(Some(String::new()), &mut TokenCache::new(), t0, PROOF_TOKEN_TTL, || Some(String::new()));
        assert_eq!(got, None, "an empty store answer is no token");
    }

    #[test]
    fn the_store_answer_is_reused_until_it_is_older_than_the_limit() {
        let t0 = Instant::now();
        let mut cache = TokenCache::new();
        let read = |v: &'static str| move || Some(v.to_string());
        assert_eq!(effective_token(None, &mut cache, t0, PROOF_TOKEN_TTL, read("old")).as_deref(), Some("old"));
        let later = t0 + Duration::from_secs(30);
        assert_eq!(effective_token(None, &mut cache, later, PROOF_TOKEN_TTL, read("new")).as_deref(), Some("old"), "cached");
        let stale = t0 + Duration::from_secs(61);
        assert_eq!(effective_token(None, &mut cache, stale, PROOF_TOKEN_TTL, read("new")).as_deref(), Some("new"), "expired");
    }

    #[test]
    fn a_fresh_read_has_a_short_age_limit_and_the_tray_read_a_long_one() {
        assert_eq!(TokenRead::Cached.max_age(), Duration::from_secs(60));
        assert_eq!(TokenRead::Fresh.max_age(), Duration::from_secs(2));
        // An answer 10 s old is reused by the tray's read and not by a fresh one.
        let t0 = Instant::now();
        let later = t0 + Duration::from_secs(10);
        let mut cache = TokenCache::new();
        cache.put(t0, Some("old".into()));
        let read = |kind: TokenRead, cache: &mut TokenCache| {
            effective_token(None, cache, later, kind.max_age(), || Some("new".into()))
        };
        assert_eq!(read(TokenRead::Cached, &mut cache.clone()).as_deref(), Some("old"));
        assert_eq!(read(TokenRead::Fresh, &mut cache).as_deref(), Some("new"));
    }

    #[test]
    fn a_fresh_read_bypasses_a_stale_cache_but_not_one_just_read() {
        let t0 = Instant::now();
        let mut cache = TokenCache::new();
        let read = |v: &'static str| move || Some(v.to_string());
        assert_eq!(effective_token(None, &mut cache, t0, PROOF_TOKEN_TTL, read("old")).as_deref(), Some("old"));
        // 10 s later the normal cache would still answer "old"; a fresh read does not.
        let later = t0 + Duration::from_secs(10);
        assert_eq!(effective_token(None, &mut cache, later, PROOF_TOKEN_TTL, read("new")).as_deref(), Some("old"));
        assert_eq!(effective_token(None, &mut cache, later, FRESH_TOKEN_MIN_AGE, read("new")).as_deref(), Some("new"));
        // An answer read a moment ago is not read again.
        assert_eq!(
            effective_token(None, &mut cache, later + Duration::from_millis(100), FRESH_TOKEN_MIN_AGE, || panic!("read again")).as_deref(),
            Some("new")
        );
    }

    #[test]
    fn an_absent_store_answer_is_cached_like_any_other() {
        let t0 = Instant::now();
        let mut cache = TokenCache::new();
        assert_eq!(effective_token(None, &mut cache, t0, PROOF_TOKEN_TTL, || None), None);
        assert_eq!(effective_token(None, &mut cache, t0 + Duration::from_secs(1), PROOF_TOKEN_TTL, || panic!("read again")), None);
    }

    // --- the Windows credential store ------------------------------------

    #[test]
    fn the_dpapi_file_is_named_the_way_the_server_names_it() {
        assert_eq!(win_cred_file_name("chroxy", "api-token"), "chroxy__api-token.dpapi");
        assert_eq!(win_cred_file_name("chroxy discord/webhook", "a:b"), "chroxy_discord_webhook__a_b.dpapi");
    }

    #[test]
    fn the_dpapi_directory_follows_localappdata_then_the_home_directory() {
        assert_eq!(
            win_cred_dir(Some(r"C:\Users\me\AppData\Local"), None),
            Some(Path::new(r"C:\Users\me\AppData\Local").join("Chroxy"))
        );
        assert_eq!(
            win_cred_dir(None, Some(Path::new("/home/me"))),
            Some(Path::new("/home/me").join("AppData").join("Local").join("Chroxy"))
        );
        assert_eq!(win_cred_dir(Some(""), Some(Path::new("/home/me"))), win_cred_dir(None, Some(Path::new("/home/me"))));
        assert_eq!(win_cred_dir(None, None), None);
    }

    #[test]
    fn the_dpapi_ciphertext_is_the_trimmed_file_text() {
        assert_eq!(parse_dpapi_ciphertext("AQAAANCM\r\n").as_deref(), Some("AQAAANCM"));
        assert_eq!(parse_dpapi_ciphertext("  AQAA  ").as_deref(), Some("AQAA"));
        assert_eq!(parse_dpapi_ciphertext(""), None);
        assert_eq!(parse_dpapi_ciphertext(" \r\n"), None);
    }

    #[test]
    fn the_dpapi_plaintext_loses_one_trailing_line_break_and_may_not_be_empty() {
        assert_eq!(parse_dpapi_plaintext("tok-123").as_deref(), Some("tok-123"));
        assert_eq!(parse_dpapi_plaintext("tok-123\r\n").as_deref(), Some("tok-123"));
        assert_eq!(parse_dpapi_plaintext("tok-123\n").as_deref(), Some("tok-123"));
        assert_eq!(parse_dpapi_plaintext(""), None);
        assert_eq!(parse_dpapi_plaintext("\r\n"), None);
    }

    /// The Windows read must stay the server's read. These pin the script and the
    /// file name against `packages/server/src/keychain.js`.
    #[test]
    fn the_windows_read_matches_the_servers_keychain_module() {
        let js = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/src/keychain.js"),
        )
        .expect("read keychain.js");
        let quoted = format!("const PS_UNPROTECT = \"{}\"", WIN_PS_UNPROTECT);
        assert!(js.contains(&quoted), "WIN_PS_UNPROTECT differs from keychain.js PS_UNPROTECT");
        assert!(js.contains("`${safe(service)}__${safe(account)}.dpapi`"), "credential file name pattern changed");
        assert!(js.contains("join(winCredDir(), "), "credential directory changed");
        assert!(js.contains("'Chroxy'") && js.contains("'AppData', 'Local'"), "credential directory changed");
        assert!(js.contains("const ACCOUNT = 'api-token'") && js.contains("const DEFAULT_SERVICE = 'chroxy'"));
    }

    #[test]
    fn a_repeated_parse_failure_is_logged_once_and_a_change_logs_again() {
        let mut last = None;
        assert!(should_log_parse_error(&mut last, Some("bad at 1")));
        assert!(!should_log_parse_error(&mut last, Some("bad at 1")));
        assert!(!should_log_parse_error(&mut last, Some("bad at 1")));
        assert!(should_log_parse_error(&mut last, Some("bad at 2")), "a different failure logs");
        assert!(!should_log_parse_error(&mut last, None), "a good read logs nothing");
        assert!(should_log_parse_error(&mut last, Some("bad at 2")), "failing again after a fix logs again");
    }

    #[test]
    fn default_config_has_zero_port() {
        // Note: #[derive(Default)] sets port to 0, not 8765.
        // The default_port() serde function only applies during deserialization.
        let config = ChroxyConfig::default();
        assert_eq!(config.port, 0);
        assert!(config.api_token.is_none());
        assert!(config.tunnel.is_none());
        assert!(config.model.is_none());
        assert!(config.cwd.is_none());
    }

    #[test]
    fn deserialized_default_port_is_8765() {
        // When deserializing an empty object, serde uses default_port()
        let config: ChroxyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.port, 8765);
    }

    #[test]
    fn parse_full_config() {
        let json = r#"{
            "apiToken": "test-token-123",
            "port": 9999,
            "tunnel": "named",
            "model": "sonnet",
            "cwd": "/home/user/projects"
        }"#;
        let config = parse_config(json).unwrap();
        assert_eq!(config.api_token.as_deref(), Some("test-token-123"));
        assert_eq!(config.port, 9999);
        assert_eq!(config.tunnel.as_deref(), Some("named"));
        assert_eq!(config.model.as_deref(), Some("sonnet"));
        assert_eq!(config.cwd.as_deref(), Some("/home/user/projects"));
    }

    #[test]
    fn parse_partial_config_uses_defaults() {
        let json = r#"{"apiToken": "tok"}"#;
        let config = parse_config(json).unwrap();
        assert_eq!(config.api_token.as_deref(), Some("tok"));
        assert_eq!(config.port, 8765); // default
        assert!(config.tunnel.is_none());
    }

    #[test]
    fn parse_empty_object_uses_all_defaults() {
        let config = parse_config("{}").unwrap();
        assert_eq!(config.port, 8765);
        assert!(config.api_token.is_none());
    }

    #[test]
    fn parse_invalid_json_returns_error() {
        assert!(parse_config("not json").is_err());
    }

    #[test]
    fn config_path_returns_some() {
        // Should work on any machine with a home directory
        let _guard = env_lock();
        let path = config_path();
        assert!(path.is_some());
        let p = path.unwrap();
        // Asserted against the RESOLVED root rather than a hardcoded ".chroxy",
        // so this stays correct in an environment that has CHROXY_CONFIG_DIR set
        // instead of going falsely red.
        assert_eq!(p, config_dir().unwrap().join("config.json"));
        assert!(p.ends_with("config.json"));
    }

    // --- CHROXY_CONFIG_DIR resolution (#7241) -------------------------------
    //
    // These drive the pure `resolve_config_dir` rather than setting the env var:
    // cargo runs tests as threads in ONE process, so a `set_var` here would race
    // `config_path_returns_some` above (and every other test that resolves a
    // path) rather than testing this function in isolation.

    fn home() -> Option<PathBuf> {
        Some(PathBuf::from("/home/u"))
    }

    /// An absolute path *for the host platform*.
    ///
    /// A Unix literal like `/mnt/state` is NOT absolute under Rust's Windows rule
    /// (no drive prefix), so hardcoding one made three of these tests fail on the
    /// `Desktop Rust Tests (Windows)` job while passing everywhere else — a
    /// platform divergence a macOS-only run cannot see.
    #[cfg(windows)]
    const ABS: &str = r"C:\chroxy-test-root";
    #[cfg(not(windows))]
    const ABS: &str = "/mnt/chroxy-test-root";

    #[test]
    fn resolve_config_dir_unset_uses_home_default() {
        assert_eq!(
            resolve_config_dir(None, home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
    }

    #[test]
    fn resolve_config_dir_absolute_override_wins() {
        assert_eq!(resolve_config_dir(Some(ABS), home()), Some(PathBuf::from(ABS)));
    }

    #[test]
    fn absoluteness_matches_the_daemons_rule_not_rusts() {
        // The daemon uses Node's `path.isAbsolute`. On Windows that accepts a
        // root-relative path while Rust's `Path::is_absolute` rejects it, and
        // disagreeing here re-splits the two halves (#7241 / #7239).
        assert!(is_absolute_like_node(ABS));
        assert!(!is_absolute_like_node("state"));
        assert!(!is_absolute_like_node("./state"));
        assert!(!is_absolute_like_node(""));

        #[cfg(windows)]
        {
            // Node says true for both of these; Rust's own rule says false.
            assert!(is_absolute_like_node("/data"));
            assert!(is_absolute_like_node(r"\data"));
            assert!(is_absolute_like_node(r"C:/data"));
            // A bare drive letter is drive-RELATIVE, not absolute.
            assert!(!is_absolute_like_node("C:data"));
            assert!(!is_absolute_like_node("C:"));
        }
        #[cfg(not(windows))]
        {
            assert!(is_absolute_like_node("/data"));
            // Not a separator on Unix — matches Node's posix rule.
            assert!(!is_absolute_like_node(r"\data"));
        }
    }

    #[test]
    fn resolve_config_dir_accepts_a_root_relative_value_on_windows() {
        // Regression guard for the divergence above, at the resolver level: a
        // value the daemon would accept must not fall back to the home default.
        #[cfg(windows)]
        assert_eq!(
            resolve_config_dir(Some("/data"), home()),
            Some(PathBuf::from("/data"))
        );
        #[cfg(not(windows))]
        assert_eq!(
            resolve_config_dir(Some("/data"), home()),
            Some(PathBuf::from("/data"))
        );
    }

    #[test]
    fn resolve_config_dir_relative_is_refused_not_resolved() {
        // The daemon refuses a relative value (config-dir.js) rather than
        // resolving it against the cwd. Desktop must refuse identically, or the
        // two halves land on different roots for the same env value.
        assert_eq!(
            resolve_config_dir(Some("state"), home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
        assert_eq!(
            resolve_config_dir(Some("./state"), home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
    }

    #[test]
    fn resolve_config_dir_empty_falls_back_to_default() {
        // Matches the `||` semantics of the daemon's resolver: an empty value is
        // "unset", not "relative".
        assert_eq!(
            resolve_config_dir(Some(""), home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
    }

    #[test]
    fn resolve_config_dir_absolute_override_works_without_home() {
        // A GUI launch may have no resolvable home; an absolute override is
        // still usable, and must not be discarded along with it.
        assert_eq!(resolve_config_dir(Some(ABS), None), Some(PathBuf::from(ABS)));
    }

    #[test]
    fn resolve_config_dir_no_home_no_override_is_none() {
        assert_eq!(resolve_config_dir(None, None), None);
        // A relative override with no home is also None — it falls back to the
        // default, which cannot be built.
        assert_eq!(resolve_config_dir(Some("state"), None), None);
    }

    #[test]
    fn every_desktop_state_path_follows_a_relocated_root() {
        // The defect this guards: N call sites, one of them drifting back to a
        // hardcoded `dirs::home_dir().join(".chroxy/…")` while the rest follow
        // the override. Each path stays individually plausible, so the split is
        // caught only by comparing them against a root that is NOT the home
        // default.
        //
        // That last part is load-bearing and is why this test sets the variable
        // instead of asserting against `config_dir()`: with CHROXY_CONFIG_DIR
        // unset, `config_dir()` IS `~/.chroxy`, so a hardcoded home path and a
        // resolved one are the same string and the assertion passes against the
        // very mutant it exists to catch — a guard that reports success without
        // checking anything (docs/false-safety-guards.md). Proven by mutation:
        // reverting settings.rs::path() to `dirs::home_dir()` fails this test and
        // passes every other test in the crate.
        let _guard = env_lock();
        let previous = std::env::var("CHROXY_CONFIG_DIR").ok();
        // ABS, not a Unix literal — see its doc comment; a `/tmp/...` value is
        // not absolute on Windows and this test then asserted the home default
        // against the relocated root, failing the Windows job only.
        std::env::set_var("CHROXY_CONFIG_DIR", ABS);
        let expected = PathBuf::from(ABS);

        let observed = (
            config_path(),
            crate::settings::DesktopSettings::path(),
            crate::qrcode::connection_info_path(),
        );

        // Restored before asserting, so a failure cannot leak the override into
        // the rest of the suite.
        match previous {
            Some(v) => std::env::set_var("CHROXY_CONFIG_DIR", v),
            None => std::env::remove_var("CHROXY_CONFIG_DIR"),
        }

        assert_eq!(observed.0, Some(expected.join("config.json")), "config.json");
        assert_eq!(
            observed.1,
            Some(expected.join("desktop-settings.json")),
            "desktop-settings.json"
        );
        assert_eq!(
            observed.2,
            Some(expected.join("connection.json")),
            "connection.json"
        );
    }

    #[test]
    fn get_keychain_token_returns_option() {
        // Should not panic regardless of keychain state
        let result = get_keychain_token();
        // We can't assert the value (depends on machine state),
        // but it should be Some(non-empty) or None — never panic.
        if let Some(ref token) = result {
            assert!(!token.is_empty());
        }
    }
}
