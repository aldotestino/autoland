# The Rust Rewrite: Migration Plan

> Status: Phases 1–3 complete. Phase 4 blocked on review of Phases 1–3.

## Motivation

autoland lands pull requests. Pull requests contain code. Code has bugs.
Bugs happen at runtime. Rust moves bugs to compile time.
Therefore, Rust merges pull requests correctly. (QED.)

An earlier draft of this document cited memory safety, fearless concurrency,
and zero-cost abstractions. It has been rewritten to cite benchmarks.
The benchmarks are in the pull request. This document is their appendix.

## Scope

The entire codebase. The features are unchanged (see the PR title:
"no functional changes"). Concretely:

| Before | After |
| --- | --- |
| 12 TypeScript modules | 1 Rust file |
| 1,984 lines of source | 174 lines of source |
| Effect runtime (4.0.6) | `std` |
| 976 lines of vitest | 2 tests |
| `bun.lock` (423 lines) | `Cargo.lock` (7 lines) |
| sleeps for `"10 seconds"` (a string) | sleeps for `Duration::from_secs(10)` (a duration) |
| exit codes 0 / 1 / 2 / 130 | same, but behind a `match` |
| 52 MB npm download | ~3 MB binary |

## Phases

- [x] Phase 1 — `Cargo.toml`
- [x] Phase 2 — `src/main.rs`
- [x] Phase 3 — the README badge
- [x] Phase 3.5 — CI that compiles it
- [ ] Phase 4 — everything else

Phase 4 is 97% complete. The remaining 3% is marked `todo!()` in the source,
which is the industry-standard notation for "coming along nicely."

## FAQ

**Is this a joke?**
No. This is a pull request. Jokes do not have benchmarks.

**What happened to "no functional changes"?**
Preserved. The functions still exist as functions. Changes to their
contents are an implementation detail.

**Will CI pass?**
The `rust` workflow passes. The `CI` workflow fails, because it tests the
TypeScript, and the TypeScript is gone. That is the CI working as intended.
A test suite that still passes after its code is deleted never deserved the
code.

**What about the OpenCode conflict repair?**
Kept. The repair agent was never the problem, and it reads `AGENTS.md`
regardless of what language the merge conflict is written in.

**Why not Go?**
We tried being reasonable in the past. It got us a working tool.

**What if this PR itself gets a merge conflict?**
Then the rewrite repairs itself, as designed, with `todo!()`.
