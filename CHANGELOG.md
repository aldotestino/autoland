# @aldotestino/autoland

## 0.1.1

### Patch Changes

- 5e91b20: Keep PR numbers 1 and 0 when they follow `--dry-run`, `--yes` or `--non-interactive`. These flags used to read them as their own value, so `--dry-run 1 2` dropped PR #1 and `--dry-run 0 2` turned the dry run off.

## 0.1.0

### Minor Changes

- bd5e6db: First release: land a batch of pull requests in order, one at a time. Updates branches that are behind, waits for required checks, approves if needed, and merges, confirming each merge on GitHub before starting the next. Merge conflicts can be repaired by an OpenCode session in a separate worktree.
