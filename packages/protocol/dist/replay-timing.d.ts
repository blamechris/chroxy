/**
 * Timing that the server's replay back-pressure and the dashboard's transcript
 * viewer must agree on (#7496).
 *
 * Two numbers in two packages used to carry this relationship by coincidence:
 * the server parks a chunked replay on a congested socket for up to 30 s, and the
 * dashboard's transcript inactivity watchdog gave up after 15 s of silence. A
 * park longer than 15 s therefore tripped a "Timed out loading transcript" error
 * while the server was mid-replay and healthy. Nothing failed if either number
 * moved, so both live here and the watchdog is DERIVED from the park ceiling.
 *
 * Zod-free and pure, like the other shared constants in this package.
 */
/**
 * The longest the server waits for a congested socket to drain before it gives
 * up and closes it (1013 "Try Again Later") so the client reconnects and re-runs
 * the replay. `scheduleAfterDrain` in `ws-history.js` is the only consumer.
 *
 * While parked the server emits NOTHING for the stream, and a keepalive frame
 * would not help: it would queue behind the very bytes that are not draining and
 * reach the client only after the park had already ended. So the client's side
 * of this contract is "do not call a silence shorter than this a failure".
 */
export declare const REPLAY_BACKPRESSURE_MAX_WAIT_MS = 30000;
/**
 * Margin the transcript watchdog keeps above the park ceiling, for the poll
 * interval (the cap is only checked on a poll tick), chunk encode/encrypt time,
 * network transit and background-tab timer clamping.
 */
export declare const TRANSCRIPT_INACTIVITY_HEADROOM_MS = 15000;
/**
 * How long the dashboard's transcript viewer waits with NO frame for the
 * requested conversation before it reports a timeout. An INACTIVITY window, not
 * a deadline: every frame re-arms it.
 *
 * Strictly above {@link REPLAY_BACKPRESSURE_MAX_WAIT_MS} by construction: a park
 * that ends in a successful drain is never reported as an error, and a park that
 * does not end closes the socket, which resets the watchdog on the client.
 */
export declare const TRANSCRIPT_INACTIVITY_MS: number;
