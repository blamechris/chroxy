//! "Prove, then act": the access token goes to a daemon only after that daemon
//! has answered a fresh health challenge with a valid proof, and the token that is
//! handed over is the one that proved.
//!
//! The steps are written once, here, against two small seams so a test can drive
//! them without a window or a network:
//!
//! - a **prover**, `port -> Option<String>`: the token that made the daemon on
//!   `port` prove itself just now, or `None`;
//! - a **sink** ([`Sink`]): what to do once the daemon has proved itself (tell the
//!   page, navigate) and what to show when it has not.
//!
//! [`begin`] and [`finish`] bracket the pause between announcing a ready daemon
//! and navigating to it; each asks the prover itself, so the answer from before
//! the pause is never reused.

use crate::window::dashboard_url;

/// Where a verified handoff goes.
pub trait Sink {
    /// Tell the page the daemon is ready: `port`, the proven `token` and the
    /// dashboard `url` that carries it.
    fn announce(&self, port: u16, token: &str, url: &str);
    /// Point the window at `url`.
    fn navigate(&self, url: &str);
    /// A handoff was refused: the daemon on `port` did not prove itself.
    fn refuse(&self, port: u16);
}

/// First half of a ready handoff: prove, then announce. `false` when the daemon
/// did not prove itself; nothing was announced.
pub fn begin(prove: &dyn Fn(u16) -> Option<String>, sink: &dyn Sink, port: u16) -> bool {
    let Some(token) = prove(port) else {
        return false;
    };
    sink.announce(port, &token, &dashboard_url(port, Some(&token)));
    true
}

/// Second half, after the pause: prove again, then navigate with the token that
/// proved this time; otherwise refuse.
pub fn finish(prove: &dyn Fn(u16) -> Option<String>, sink: &dyn Sink, port: u16) {
    match prove(port) {
        Some(token) => sink.navigate(&dashboard_url(port, Some(&token))),
        None => sink.refuse(port),
    }
}

/// Prove, then open the dashboard's settings panel; otherwise refuse.
pub fn open_settings(prove: &dyn Fn(u16) -> Option<String>, sink: &dyn Sink, port: u16) -> bool {
    match prove(port) {
        Some(token) => {
            sink.navigate(&format!("{}&settings=1", dashboard_url(port, Some(&token))));
            true
        }
        None => {
            sink.refuse(port);
            false
        }
    }
}

/// Try `attempt` up to `attempts` times, calling `pause` between tries. `true` as
/// soon as one try succeeds. A refused handoff is retried a bounded number of
/// times, then given up; what the caller does about a final refusal is its own.
pub fn with_retries(attempts: u32, mut attempt: impl FnMut() -> bool, mut pause: impl FnMut()) -> bool {
    for n in 0..attempts {
        if attempt() {
            return true;
        }
        if n + 1 < attempts {
            pause();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// Records every step, in order, including each ask of the prover.
    struct Rec {
        log: RefCell<Vec<String>>,
    }

    impl Rec {
        fn new() -> Self {
            Self { log: RefCell::new(Vec::new()) }
        }
        fn log(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
        fn push(&self, s: String) {
            self.log.borrow_mut().push(s);
        }
    }

    impl Sink for Rec {
        fn announce(&self, port: u16, token: &str, url: &str) {
            self.push(format!("announce {} {} {}", port, token, url));
        }
        fn navigate(&self, url: &str) {
            self.push(format!("navigate {}", url));
        }
        fn refuse(&self, port: u16) {
            self.push(format!("refuse {}", port));
        }
    }

    /// A prover that answers from `script`, in order, and records each ask in `rec`.
    fn scripted<'a>(rec: &'a Rec, script: Vec<Option<&'static str>>) -> impl Fn(u16) -> Option<String> + 'a {
        let script = RefCell::new(VecDeque::from(script));
        move |port| {
            rec.push(format!("prove {}", port));
            script.borrow_mut().pop_front().expect("prover asked more often than scripted").map(str::to_string)
        }
    }

    #[test]
    fn a_daemon_that_does_not_prove_itself_gets_no_announcement() {
        let rec = Rec::new();
        assert!(!begin(&scripted(&rec, vec![None]), &rec, 8765));
        assert_eq!(rec.log(), vec!["prove 8765"]);
    }

    #[test]
    fn a_proven_daemon_is_announced_after_the_proof_with_the_token_that_proved() {
        let rec = Rec::new();
        assert!(begin(&scripted(&rec, vec![Some("tok")]), &rec, 8765));
        assert_eq!(
            rec.log(),
            vec!["prove 8765", "announce 8765 tok http://127.0.0.1:8765/dashboard?token=tok"]
        );
    }

    #[test]
    fn the_navigation_asks_again_and_a_daemon_that_stopped_proving_is_refused() {
        let rec = Rec::new();
        let prove = scripted(&rec, vec![Some("tok"), None]);
        assert!(begin(&prove, &rec, 8765));
        finish(&prove, &rec, 8765);
        assert_eq!(
            rec.log(),
            vec![
                "prove 8765",
                "announce 8765 tok http://127.0.0.1:8765/dashboard?token=tok",
                "prove 8765",
                "refuse 8765",
            ]
        );
        assert!(!rec.log().iter().any(|l| l.starts_with("navigate")), "no navigation after a lost proof");
    }

    #[test]
    fn the_navigation_uses_the_token_that_proved_the_second_time() {
        // A rotation during the pause: the second proof is made with the new token.
        let rec = Rec::new();
        let prove = scripted(&rec, vec![Some("old"), Some("new")]);
        assert!(begin(&prove, &rec, 9000));
        finish(&prove, &rec, 9000);
        let log = rec.log();
        assert_eq!(log.last().unwrap(), "navigate http://127.0.0.1:9000/dashboard?token=new");
    }

    #[test]
    fn settings_open_only_after_a_proof_and_carry_the_proven_token() {
        let rec = Rec::new();
        assert!(open_settings(&scripted(&rec, vec![Some("tok")]), &rec, 8765));
        assert_eq!(
            rec.log(),
            vec!["prove 8765", "navigate http://127.0.0.1:8765/dashboard?token=tok&settings=1"]
        );
        let rec = Rec::new();
        assert!(!open_settings(&scripted(&rec, vec![None]), &rec, 8765));
        assert_eq!(rec.log(), vec!["prove 8765", "refuse 8765"]);
    }

    #[test]
    fn a_refused_handoff_is_retried_a_bounded_number_of_times_with_a_pause_between() {
        let mut tries = 0;
        let mut pauses = 0;
        assert!(!with_retries(3, || { tries += 1; false }, || pauses += 1));
        assert_eq!((tries, pauses), (3, 2), "three tries, a pause between each, none after the last");
    }

    #[test]
    fn a_retry_that_succeeds_stops_trying() {
        let mut tries = 0;
        let mut pauses = 0;
        assert!(with_retries(3, || { tries += 1; tries == 2 }, || pauses += 1));
        assert_eq!((tries, pauses), (2, 1));
        let mut tries = 0;
        assert!(with_retries(3, || { tries += 1; true }, || panic!("no pause after a success")));
        assert_eq!(tries, 1);
    }
}
