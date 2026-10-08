//! The daemon's answer to a health challenge.
//!
//! `GET /health?challenge=<nonce>` makes the daemon add
//! `proof = hex(HMAC-SHA256(key = its API token, "chroxy-health-v1:" + <port it
//! listens on> + ":" + nonce))`. The desktop app holds the same token (its config
//! or the OS credential store), so it can check the proof; a process that does not
//! hold the token cannot make one. A daemon is adopted, and the dashboard is
//! opened on it, only when a fresh challenge returns a proof that verifies for the
//! exact port the app would navigate to.
//!
//! This is the same function as `packages/server/src/health-proof.js`.
//!
//! Everything here is pure except [`fresh_nonce`], which reads the OS RNG.

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

/// Prefix of the message the proof is computed over.
pub const PROOF_PREFIX: &str = "chroxy-health-v1:";

/// Number of random bytes in a challenge (64 hex characters).
pub const NONCE_BYTES: usize = 32;

/// True for exactly 64 lowercase hex characters, the only form the daemon honours.
pub fn is_valid_nonce(nonce: &str) -> bool {
    nonce.len() == NONCE_BYTES * 2 && nonce.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A fresh challenge from the OS RNG, or `None` if the RNG failed.
pub fn fresh_nonce() -> Option<String> {
    let mut bytes = [0u8; NONCE_BYTES];
    SystemRandom::new().fill(&mut bytes).ok()?;
    Some(encode_hex(&bytes))
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Strict hex decode: an even number of hex digits, either case, nothing else.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() & 1 == 1 || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn message(port: u16, nonce: &str) -> String {
    format!("{}{}:{}", PROOF_PREFIX, port, nonce)
}

/// True only if `proof_hex` is the HMAC-SHA256 of the challenge for `port`, keyed
/// by `token`. The comparison is constant-time. An empty token, a malformed nonce
/// or a proof that is not exactly 32 hex-encoded bytes never verifies.
pub fn verify_proof(token: &str, port: u16, nonce: &str, proof_hex: &str) -> bool {
    if token.is_empty() || !is_valid_nonce(nonce) {
        return false;
    }
    let Some(tag) = decode_hex(proof_hex) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, token.as_bytes());
    hmac::verify(&key, message(port, nonce).as_bytes(), &tag).is_ok()
}

/// The `proof` field of a `/health` body, if it is a JSON object with a string one.
pub fn proof_field(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("proof")?
        .as_str()
        .map(str::to_string)
}

/// True if `body` carries a proof that verifies for `token`, `port` and `nonce`.
pub fn body_proves_daemon(body: &str, token: &str, port: u16, nonce: &str) -> bool {
    proof_field(body).is_some_and(|proof| verify_proof(token, port, nonce, &proof))
}

/// The request path for a challenge.
pub fn challenge_path(nonce: &str) -> String {
    format!("/health?challenge={}", nonce)
}

/// The proof a daemon holding `token` and listening on `port` gives for `nonce`.
/// Used by tests to stand in for the daemon.
#[cfg(test)]
pub fn compute_proof_hex(token: &str, port: u16, nonce: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, token.as_bytes());
    encode_hex(hmac::sign(&key, message(port, nonce).as_bytes()).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "abababababababababababababababababababababababababababababababab";
    const OTHER_NONCE: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    // HMAC-SHA256(key = "test-token", "chroxy-health-v1:4242:<NONCE>"), computed
    // with Python's hmac; the server test pins the same vector.
    const PROOF_4242: &str = "e8c3801feb0b5d7b91ce06777985620c52141ff9f1b981dad2e40afe2880c9e6";

    #[test]
    fn the_proof_matches_an_independently_computed_vector() {
        assert_eq!(compute_proof_hex("test-token", 4242, NONCE), PROOF_4242);
    }

    #[test]
    fn a_correct_proof_verifies() {
        assert!(verify_proof("test-token", 4242, NONCE, PROOF_4242));
        assert!(verify_proof("test-token", 4242, NONCE, &PROOF_4242.to_uppercase()), "hex case does not matter");
    }

    #[test]
    fn a_wrong_proof_does_not_verify() {
        let mut wrong = PROOF_4242.to_string();
        wrong.replace_range(0..1, if wrong.starts_with('e') { "f" } else { "e" });
        assert!(!verify_proof("test-token", 4242, NONCE, &wrong));
    }

    #[test]
    fn a_proof_for_another_port_does_not_verify() {
        let other_port = compute_proof_hex("test-token", 4243, NONCE);
        assert!(!verify_proof("test-token", 4242, NONCE, &other_port));
    }

    #[test]
    fn a_proof_for_another_nonce_does_not_verify() {
        let other = compute_proof_hex("test-token", 4242, OTHER_NONCE);
        assert!(!verify_proof("test-token", 4242, NONCE, &other));
    }

    #[test]
    fn a_proof_made_with_another_token_does_not_verify() {
        let other = compute_proof_hex("other-token", 4242, NONCE);
        assert!(!verify_proof("test-token", 4242, NONCE, &other));
    }

    #[test]
    fn a_malformed_proof_does_not_verify() {
        for bad in [
            "",
            "zz",
            "e8c3",                       // too short
            &format!("{}00", PROOF_4242), // too long
            &PROOF_4242[..63],            // odd length
            &format!("{}é", &PROOF_4242[..62]), // not ascii
            "not hex at all",
        ] {
            assert!(!verify_proof("test-token", 4242, NONCE, bad), "{:?}", bad);
        }
    }

    #[test]
    fn an_empty_token_or_a_malformed_nonce_never_verifies() {
        let empty_key_proof = compute_proof_hex("", 4242, NONCE);
        assert!(!verify_proof("", 4242, NONCE, &empty_key_proof));
        let short = "abab";
        let p = compute_proof_hex("test-token", 4242, short);
        assert!(!verify_proof("test-token", 4242, short, &p));
    }

    #[test]
    fn a_nonce_is_64_lowercase_hex_characters() {
        assert!(is_valid_nonce(NONCE));
        for bad in ["", "ab", &NONCE.to_uppercase(), &format!("{}0", NONCE), &NONCE[..63], &"g".repeat(64)] {
            assert!(!is_valid_nonce(bad), "{:?}", bad);
        }
    }

    #[test]
    fn fresh_nonces_are_valid_and_differ() {
        let a = fresh_nonce().expect("OS RNG");
        let b = fresh_nonce().expect("OS RNG");
        assert!(is_valid_nonce(&a) && is_valid_nonce(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn a_body_proves_the_daemon_only_through_its_proof_field() {
        let good = format!(r#"{{"status":"ok","version":"1","proof":"{}"}}"#, PROOF_4242);
        assert!(body_proves_daemon(&good, "test-token", 4242, NONCE));
        assert!(!body_proves_daemon(&good, "test-token", 4243, NONCE), "bound to the port");
        assert!(!body_proves_daemon(&good, "test-token", 4242, OTHER_NONCE), "bound to the nonce");
        assert!(!body_proves_daemon(r#"{"status":"ok","version":"1"}"#, "test-token", 4242, NONCE), "no proof");
        assert!(!body_proves_daemon(r#"{"proof":42}"#, "test-token", 4242, NONCE), "proof not a string");
        assert!(!body_proves_daemon("not json", "test-token", 4242, NONCE));
        assert!(!body_proves_daemon("", "test-token", 4242, NONCE));
    }
}
