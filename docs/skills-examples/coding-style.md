Enforce consistent coding style across all languages and projects.

## General

- Prefer clarity over cleverness. Code is read far more often than it is written.
- Use descriptive names. Variables, functions, and classes should reveal intent.
- Keep functions small and focused — one responsibility per function.
- Avoid deeply nested logic. Flatten conditionals using early returns.

## Error handling

- Always handle errors explicitly. Do not silently swallow exceptions.
- Propagate errors to callers rather than hiding them with fallback values.
- Log errors with enough context to diagnose the problem without a debugger.

## Comments

- Write comments that explain *why*, not *what*. The code shows what — comments explain intent.
- Remove commented-out code before committing. Use version control for history.

## Commits

- Write commit messages in the imperative mood: "add feature" not "added feature".
- Keep the subject line under 72 characters.
- Use the body to explain the reasoning behind the change when it is not obvious.
