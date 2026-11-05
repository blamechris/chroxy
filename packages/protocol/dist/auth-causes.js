/**
 * Why a session reported `AUTH_REQUIRED` — the ONE roster of causes (#8970).
 *
 * The server tags an auth failure with the credential the session actually
 * authenticates with, so a client can name the real remedy: "log in" is wrong
 * advice for someone on Bedrock, Vertex, `ANTHROPIC_AUTH_TOKEN` or an
 * `apiKeyHelper`. The server (classifier + wire allowlist) and both clients
 * (the chip presentation map) all key off this list; a cause added here without
 * a client presentation fails the store-core parity test and the typed
 * `Record<AuthRequiredCause, …>` there, and a presentation without a cause here
 * fails the same test the other way round.
 *
 * Zod-free on purpose (like `./thinking-levels.ts`).
 */
export const AUTH_REQUIRED_CAUSES = [
    'login',
    'api_key',
    'container',
    'bedrock',
    'vertex',
    'auth_token',
    'api_key_helper',
];
/** Narrow an untrusted wire value to a known cause; anything else is `undefined`. */
export function parseAuthRequiredCause(value) {
    return typeof value === 'string' && AUTH_REQUIRED_CAUSES.includes(value)
        ? value
        : undefined;
}
