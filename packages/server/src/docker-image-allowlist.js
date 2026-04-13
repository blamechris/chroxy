/**
 * Docker image allowlist for create_environment.
 *
 * Adversary A7 (2026-04-11 audit): the create_environment WS handler
 * accepted any string as a Docker image name and passed it straight
 * through to the environment manager. An authenticated attacker could
 * register an attacker-controlled image (containing an exploit payload
 * or pre-installed persistence) and run it inside the operator's
 * Docker daemon.
 *
 * Defense: two-layer allowlist.
 *
 * 1. Default allowlist — a small set of common base images and
 *    devcontainer sources that are reasonable for dev environments and
 *    come from well-known publishers. Each entry supports an optional
 *    trailing `*` wildcard for tag/path flexibility (`node:*` matches
 *    `node:22`, `node:18-slim`, etc.; `mcr.microsoft.com/devcontainers/*`
 *    matches any subtree).
 *
 * 2. Operator override — `config.allowedDockerImages` (array of the
 *    same pattern shape) replaces the default. An empty array in the
 *    config means "no client-supplied images at all" (force the
 *    manager's built-in default); explicit entries are strictly
 *    enforced.
 *
 * The allowlist is a soft defense — an attacker who can run arbitrary
 * Bash on the machine can already call `docker pull` directly. This
 * check prevents the WS handler itself from being used as a
 * privileged pull primitive.
 */

export const DEFAULT_ALLOWED_DOCKER_IMAGES = [
  // Node.js base images
  'node:*',
  // Python base images
  'python:*',
  // Common Linux bases
  'ubuntu:*',
  'debian:*',
  'alpine:*',
  // Devcontainer registries — Microsoft and GitHub published
  'mcr.microsoft.com/devcontainers/*',
  'ghcr.io/devcontainers/*',
  // Rust toolchain
  'rust:*',
  // Go toolchain
  'golang:*',
]

/**
 * Check whether a given image string matches any pattern in the
 * allowlist. Patterns support a single trailing `*` for wildcarding.
 *
 * @param {string} image - The image reference to check (e.g. `node:22`)
 * @param {string[]} patterns - Allowlist patterns (exact or prefix-with-*)
 * @returns {boolean}
 */
export function imageMatchesAllowlist(image, patterns) {
  if (typeof image !== 'string' || image.length === 0) return false
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    if (pattern === image) return true
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      if (image.startsWith(prefix)) return true
    }
  }
  return false
}

/**
 * Validate that a client-supplied Docker image is allowed by the
 * current config. Returns null if allowed, or an error string describing
 * the denial.
 *
 * @param {string|undefined} image - The image from the WS message. If
 *   undefined, returns null (the environment manager's default will be
 *   used — no user-supplied image to validate).
 * @param {object} [config] - Runtime config. `config.allowedDockerImages`
 *   overrides the default allowlist if set.
 * @returns {string|null}
 */
export function validateDockerImage(image, config = null) {
  // No image specified — caller gets the environment manager's
  // built-in default, which is always safe.
  if (!image) return null
  const configured = Array.isArray(config?.allowedDockerImages)
    ? config.allowedDockerImages
    : null
  const patterns = configured || DEFAULT_ALLOWED_DOCKER_IMAGES
  if (imageMatchesAllowlist(image, patterns)) return null
  // Don't leak the full allowlist to the client — it helps attackers
  // enumerate accepted prefixes. Log details server-side only.
  if (patterns.length === 0) {
    return "Docker image rejected: the allowedDockerImages list is empty (no client-supplied images permitted). To allow images, edit 'allowedDockerImages' in your chroxy config file."
  }
  return `Docker image '${image}' is not in the allowlist. To add this image, edit 'allowedDockerImages' in your chroxy config file.`
}
