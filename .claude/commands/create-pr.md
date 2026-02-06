# /create-pr

Create a pull request with proper formatting.

## Arguments

- `$ARGUMENTS` - Optional PR title override

## Instructions

### 1. Verify Branch State

```bash
git status
git log main..HEAD --oneline
git diff main --stat
```

### 2. Push Branch

```bash
git push -u origin $(git branch --show-current)
```

### 3. Create PR

```bash
gh pr create --title "type: Summary" --body "$(cat <<'EOF'
## Summary

- Change 1
- Change 2
- Change 3

## Changes

| File | What changed |
|------|-------------|
| `file.js` | Description |

## Test Plan

- [ ] Manual testing done
- [ ] Server starts in CLI mode
- [ ] Server starts in terminal mode (--terminal)
- [ ] App connects and functions correctly

## Screenshots (if UI changes)

N/A
EOF
)"
```

### 4. Report PR URL

Output the PR URL for user reference.

## Notes

- **NO** Claude attribution in PR body
- Keep summary concise (3-5 bullets)
- Link related issues if applicable
- Always target `main` branch
