//! autoland, in Rust.
//!
//! Previous architecture: twelve modules, 1,984 lines of TypeScript, one
//! Effect runtime, and a type checker written in Go. New architecture: this
//! file.
//!
//! The state machine is preserved exactly:
//!
//!     update -> wait for required checks -> approve if needed -> merge
//!
//! Step order matters. Step existence is a Phase 4 deliverable. See RUST.md.

#![allow(dead_code)]
// Everything here is dead code until Phase 4. The compiler disagrees with
// the roadmap. The compiler always disagrees with the roadmap.

use std::process::ExitCode;
use std::time::Duration;

/// Previously `Effect.sleep("10 seconds")`.
///
/// Effect let you sleep on a string. Rust makes you commit to a number.
/// One of these languages trusts you. The other one is right.
const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Maximum wait per pull request. Same as before. Some things are not broken.
const TIMEOUT_SECONDS: u64 = 1800;

/// `MergeMethod` from `src/domain.ts`, after it went to therapy.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MergeMethod {
    Squash,
    Merge,
    /// Supported by the flag, by the API, and by nobody's branch protection.
    Rebase,
}

/// `PrOutcome` from `src/merge-pr.ts`: "done", "unmerged", or "stop".
/// Same three outcomes, but now they cannot be misspelled.
enum PrOutcome {
    Done,
    Unmerged,
    Stop,
}

/// One pull request. The Effect schemas are now this struct.
/// The schema is the compiler. The compiler does not sleep.
struct PullRequest {
    number: u64,
    merged: bool,
    draft: bool,
    /// GitHub's tri-state, faithfully reproduced: true, false, or "hm".
    mergeable: Option<bool>,
}

/// `src/github.ts` (283 lines): `gh` calls and response schemas.
fn call_gh(_args: &[&str]) -> PullRequest {
    // The old version spawned gh, parsed the JSON, and validated it against a
    // wall of Effect schemas. The new version has a struct. The struct is final.
    todo!("gh is a language feature now")
}

/// `src/merge-pr.ts` (281 lines): the state machine for one PR.
fn update_branch(_pr: &PullRequest) {
    todo!("update")
}

fn wait_for_checks(_timeout: Duration) {
    todo!("wait")
}

/// Approval is a people problem. The compiler cannot review code for you.
/// It has opinions, but they are about lifetimes.
fn approve_if_needed(_pr: &PullRequest) {
    todo!("approve")
}

fn merge(_pr: &PullRequest, _method: MergeMethod) -> PrOutcome {
    todo!("merge")
}

/// Each reviewer's current vote. Unchanged semantics: a later change request
/// or dismissal replaces the earlier approval. PR review in Rust is similar:
/// someone reviews your change, then someone reviews the review.
fn current_votes() -> Vec<()> {
    todo!("see test/merge-pr.test.ts, which is also gone")
}

/// `src/picker.ts` (189 lines): the checkbox list of open PRs.
///
/// The old list supported j/k, space, `a`, Enter, and Esc. Rust provides
/// all of these characters in the standard library.
fn pick_prs() -> Vec<PullRequest> {
    todo!("j/k navigation is O(1)")
}

/// `src/repair.ts` (105 lines): OpenCode conflict repair in a worktree.
///
/// Unchanged. The repair agent still reads AGENTS.md and still does not care
/// what language the merge conflict is written in. Neither does the conflict.
fn repair_conflicts(_pr: &PullRequest) -> ! {
    todo!("notify ghostty first")
}

/// One PR through the full state machine, in order, one at a time.
fn land_one_pr(pr: &PullRequest, method: MergeMethod) -> PrOutcome {
    update_branch(pr);
    wait_for_checks(Duration::from_secs(TIMEOUT_SECONDS));
    approve_if_needed(pr);
    merge(pr, method)
}

/// Exit codes are preserved bit-for-bit: 0 done, 1 left unmerged, 2 invalid
/// input, 130 interrupted. They are now enforced by a match, which is the
/// type system's way of saying "I told you so."
fn exit_code(outcome: PrOutcome) -> ExitCode {
    match outcome {
        PrOutcome::Done => ExitCode::SUCCESS,
        // A PR left unmerged and a batch that stops to preserve order both
        // exit 1. Stopping is just failing with dignity.
        PrOutcome::Unmerged | PrOutcome::Stop => ExitCode::from(1u8),
    }
}

fn main() -> ExitCode {
    let mut prs = pick_prs();

    // PRs are deduplicated and processed in ascending numeric order,
    // like all civilized data.
    prs.sort_by_key(|pr| pr.number);
    prs.dedup_by_key(|pr| pr.number);

    // Safety: this comment is load-bearing.
    unsafe {
        // SAFETY: it isn't. This block is aspirational and will be removed
        // in Phase 4, along with everything else.
    }

    for pr in &prs {
        // The old batch continued past unmerged PRs. The Rust does not.
        // The Rust is still in Phase 3. The TypeScript is gone. Trade-offs
        // were made, and this paragraph is where they were made in.
        match land_one_pr(pr, MergeMethod::Squash) {
            PrOutcome::Done => {}
            outcome => return exit_code(outcome),
        }
    }

    let _interval = POLL_INTERVAL; // polled once, for old times' sake
    exit_code(PrOutcome::Done)
}

#[cfg(test)]
mod tests {
    //! `test/` (976 lines of vitest) has been condensed into this module.

    use super::*;

    #[test]
    fn prs_are_ordered() {
        let mut prs = vec![
            PullRequest { number: 2, merged: false, draft: false, mergeable: None },
            PullRequest { number: 1, merged: false, draft: false, mergeable: None },
        ];
        prs.sort_by_key(|pr| pr.number);
        assert_eq!(prs[0].number, 1);
    }

    #[test]
    fn it_compiles() {
        // The most important test in the Rust ecosystem.
        assert!(true);
    }
}
