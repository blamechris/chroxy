# /commit

Create a well-formatted git commit following project conventions.

## Arguments

- `$ARGUMENTS` - Optional commit message override

## Instructions

### 1. Check Status

```bash
git status
git diff --staged --stat
```

### 2. Determine Commit Type

Based on changes, select appropriate type:
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code restructuring
- `test` - Adding/updating tests
- `docs` - Documentation only
- `chore` - Maintenance
- `style` - Formatting only
- `perf` - Performance improvement

### 3. Determine Scope

Based on files changed:
- `server` - Server package changes
- `app` - App package changes
- `ws` - WebSocket protocol changes
- `cli` - CLI command changes
- `parser` - Output parser changes
- `tunnel` - Tunnel management changes
- `docs` - Documentation changes

### 4. Create Commit Message

Format:
```
type(scope): Short summary in present tense

[Optional body explaining why, not what]
```

**CRITICAL:** NO Claude attribution. NO Co-Authored-By lines. User is sole author.

### 5. Commit

```bash
git commit -m "type(scope): message"
```

## Example

```bash
# Input: /commit
# Output:
git add -A
git commit -m "feat(ws): add model switching protocol

Support set_model client message and model_changed broadcast"
```
