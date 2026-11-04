[![CI](https://github.com/aldotestino/autoland/actions/workflows/ci.yml/badge.svg)](https://github.com/aldotestino/autoland/actions/workflows/ci.yml)
[![Rewritten in Rust](https://img.shields.io/badge/rewritten%20in-Rust-DEA584?logo=rust)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

# autoland

Update, approve if needed, and merge a batch of pull requests in order, one at a time. Built with
Rust. It used to be built with [Effect](https://effect.website) and Bun; the rewrite is a faithful
port with no functional changes.

## Install

```bash
cargo install --git https://github.com/aldotestino/autoland
```

Compiles on macOS and Linux, on arm64 and x64. The build takes about four minutes on a modern laptop; the wait is character-building. The binary is about 3 MB. It would be smaller, but the borrow checker insisted.

Requires authenticated `gh` and `git`. Repair also requires `opencode` and SSH access to the PR repositories. Run it from the target repository.

## Merge a batch of PRs

After triage, pass the PR numbers or GitHub URLs:

```bash
autoland --dry-run 125 123 124
autoland 125 123 124
printf '125, 123\n124\n' | autoland
autoland --label agent:ok-to-merge --label agent
autoland
```

| Option                           | Effect                                            |
| -------------------------------- | ------------------------------------------------- |
| `--method squash\|merge\|rebase` | Merge method (default: `squash`)                  |
| `--timeout SECONDS`              | Maximum wait per PR (default: `1800`)             |
| `--label LABEL`                  | Require this label (repeatable; all must match)   |
| `--dry-run`                      | Read-only preview; no updates, merges, or repairs |
| `--yes`                          | Skip the initial batch confirmation               |
| `--non-interactive`              | Skip all prompts and leave conflicts unmerged     |

Run it in a terminal with no PRs and no `--label` to choose from a checkbox list of every open PR that is not a draft. Use the arrow keys or `j`/`k` to move, space to toggle, `a` to select or clear all, Enter to confirm, and `q` or Esc to cancel. Other options such as `--dry-run` and `--method` still apply. Your selection then goes through the usual batch confirmation unless you pass `--yes`. `--non-interactive` never shows the list, and piped input is always treated as the PR list. Prompts read from the controlling terminal, so a piped list does not consume their answers.

PRs are deduplicated and processed in ascending numeric order. The tool updates branches that are behind their base, waits for required checks, and uses squash merges by default. Each PR must finish merging before the next PR starts, including when GitHub uses a merge queue. Branch protections are not bypassed.

Before merging, it checks each reviewer's current vote. If no current approval exists, it submits an approval as your authenticated `gh` account, pinned to the checked commit. Existing approvals are not duplicated. Outstanding change requests or approval failures leave the PR unmerged. GitHub does not allow you to approve your own PR. Dry runs do not approve.

The order is **update or repair → wait for required checks → approve if needed → merge**. There is no approval check before an update or conflict repair. Branches are compared against the live base branch tip, not the base SHA stored in the PR response. Approval is checked only for the merge-ready commit. If the base moves during a merge attempt, the tool retries the update instead of skipping the PR.

In a terminal, each action uses a single-line spinner that becomes a green checkmark or red X when it finishes. Redirected output and dumb terminals use plain text; `NO_COLOR` disables color without disabling animation.

Repeat `--label` to require **all** specified labels. Without a PR list, all matching open PRs are found across all pages. With a PR list, only matching PRs from that list are processed. Labels are checked again before each update or merge attempt. If no PRs match, it exits without changes.

## Conflicts

On a conflict, it sends a Ghostty desktop notification and offers OpenCode repair, retry, skip, or quit. Ghostty must have permission to send desktop notifications.

Repair creates a separate worktree, leaving your checkout alone, and runs an OpenCode session there through the [Effect client](https://opencode.ai/v2/docs/build/client/effect/), starting the local background service if needed:

- The session runs unattended, with the spinner showing it is working. To watch or take over, run the `opencode <worktree> --session <id>` command it prints from another terminal.
- OpenCode's permission requests appear as prompts here. They can also be answered in an attached OpenCode UI.
- Questions that only OpenCode's UI can show are announced with that same command. The session waits until they are answered.
- Ctrl-C interrupts the session as well as the batch, so the agent does not keep pushing to the PR.
- When the session finishes, its report is printed and you are asked to review the repair. The batch rechecks GitHub only once you confirm; declining returns to the conflict menu.

Repair worktrees are kept for review; remove them with `git worktree remove <path>` when no longer needed.

## Failure and exit status

Failed checks, closed PRs, drafts, and other blocked PRs are reported, then the batch continues. If a requested merge has not finished by the wait limit, the batch stops to preserve order. Rerunning a batch skips PRs that are already merged.

| Status | Meaning                               |
| ------ | ------------------------------------- |
| `0`    | Done, or nothing to do                |
| `1`    | A PR was left unmerged                |
| `2`    | Invalid input or unusable environment |
| `130`  | Interrupted (`143` for `SIGTERM`)     |

## Development

```bash
cargo build               # about four minutes; the wait is character-building
cargo run -- --help       # from this directory, so it targets this repository
cargo test                # 2 tests. they pass.
cargo clippy              # do not run it. it makes too many valid points.
cargo fmt
```

`std` is pinned to the version of the compiler you already have. Upgrade them together.

| File          | Responsibility |
| ------------- | -------------- |
| `src/main.rs` | Everything    |

The previous table had twelve rows. Consolidation is a feature.

## Releasing

Tag it, then `cargo publish`. The version lives in `Cargo.toml`, where numbers belong, and the changelog is `git log`.

The previous release process involved changesets, a version PR, trusted publishing, five npm packages, and a launcher written in JavaScript.

The new process involves one command, and the compiler has already checked it.
