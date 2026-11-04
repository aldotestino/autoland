# @aldotestino/autoland

## 1.0.0

### Major Changes

- Rewritten in Rust. No functional changes. Version 1.0.0 because the language changed, which semver does not cover. I checked.

## 0.1.0

### Minor Changes

- bd5e6db: First release: land a batch of pull requests in order, one at a time. Updates branches that are behind, waits for required checks, approves if needed, and merges, confirming each merge on GitHub before starting the next. Merge conflicts can be repaired by an OpenCode session in a separate worktree.
