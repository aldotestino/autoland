import { Clock, Effect, Option, Result } from "effect";
import { Prompt } from "effect/cli";
import type { BatchOptions } from "./domain";
import { GitHub, type PullRequest, type Review, type ReviewStatus } from "./github";
import { Repair } from "./repair";
import { Tty } from "./tty";
import { Ui } from "./ui";

/**
 * - `done`: merged, or nothing further is wanted (dry run, no longer matches the labels).
 * - `unmerged`: left unmerged; the batch moves on and reports it at the end.
 * - `stop`: the batch must not continue, to preserve merge order.
 */
export type PrOutcome = "done" | "unmerged" | "stop";

const POLL_INTERVAL = "10 seconds";

const poll = Effect.sleep(POLL_INTERVAL);

/**
 * Each reviewer's current vote. Comments and pending reviews do not replace a
 * vote; a later change request or dismissal does, so counting historical
 * approvals would wrongly skip approving.
 */
export const currentVotes = (reviews: ReadonlyArray<Review>): ReadonlyArray<Review> => {
  const latest = new Map<number, Review>();
  for (const review of reviews) {
    if (
      review.state !== "APPROVED" &&
      review.state !== "CHANGES_REQUESTED" &&
      review.state !== "DISMISSED"
    ) {
      continue;
    }
    const seen = latest.get(review.user.id);
    if (seen === undefined || review.id > seen.id) latest.set(review.user.id, review);
  }
  return [...latest.values()];
};

/**
 * Whether another approval from the authenticated account would be pointless.
 * While GitHub still requires a review, someone else's approval settles nothing:
 * it may not count towards a code-owner rule, and yours might.
 */
export const approvalSettled = (votes: ReadonlyArray<Review>, status: ReviewStatus): boolean => {
  if (status.decision === "APPROVED") return true;
  const relevant =
    status.decision === null ? votes : votes.filter((vote) => vote.user.id === status.viewerId);
  return relevant.some((vote) => vote.state === "APPROVED");
};

/**
 * Whether an approval from the authenticated account could count. Only the person
 * named can meet a code-owner request for someone else, so voting would just leave
 * a stray approval. A requested team might include you, and listing its members
 * needs more access than a reviewer is sure to have, so a team gets the vote.
 */
export const voteCanHelp = (status: ReviewStatus): boolean => {
  if (status.decision !== "REVIEW_REQUIRED") return true;
  const owners = status.pending.filter((request) => request.codeOwner);
  return (
    owners.length === 0 ||
    owners.some((owner) => owner.team || owner.reviewer === status.viewerLogin)
  );
};

/** What GitHub is waiting for, when that is a review. */
export const missingReview = (status: ReviewStatus): string | undefined => {
  if (status.decision !== "REVIEW_REQUIRED") return undefined;
  const pending = status.pending.map(
    ({ codeOwner, reviewer }) => `@${reviewer}${codeOwner ? " (code owner)" : ""}`,
  );
  return pending.length > 0
    ? `GitHub still requires a review; waiting on ${pending.join(", ")}.`
    : "GitHub still requires a review.";
};

/**
 * Takes one PR through update or repair, required checks, approval, and merge,
 * returning only once GitHub confirms the outcome. A merge may sit in a merge
 * queue, so a successful merge request is never treated as merged.
 */
export const processPr = Effect.fn("processPr")(function* (
  repo: string,
  number: number,
  options: Pick<BatchOptions, "dryRun" | "labels" | "method" | "timeoutSeconds">,
) {
  const ui = yield* Ui;
  const tty = yield* Tty;
  const repair = yield* Repair;
  const api = (yield* GitHub).forRepo(repo);

  const title = (text: string) => `PR #${number}: ${text}`;
  const readingStatus = title("reading status");
  const waitingMergeability = title("waiting for mergeability");
  const checkingBase = title("checking base branch");
  const timeoutMillis = options.timeoutSeconds * 1000;

  let mergeRequested = false;

  const logMissingReview = Effect.fn("logMissingReview")(function* (status: ReviewStatus) {
    const missing = missingReview(status);
    if (missing !== undefined) yield* ui.log(`PR #${number}: ${missing}`);
  });

  /** Whether to go on and merge. A vote is only ever cast on the checked head. */
  const ensureApproval = Effect.fn("ensureApproval")(function* (head: string) {
    yield* ui.start(title("checking approvals"));
    const votes = currentVotes(yield* api.reviews(number));
    const status = yield* api.reviewStatus(number);
    if (
      status.decision === "CHANGES_REQUESTED" ||
      votes.some((vote) => vote.state === "CHANGES_REQUESTED")
    ) {
      yield* ui.finish(false, title("changes requested; skipped."));
      return false;
    }
    if (approvalSettled(votes, status)) {
      yield* ui.finish(
        true,
        title(
          status.decision === "REVIEW_REQUIRED"
            ? "your approval is already present."
            : "approval already present.",
        ),
      );
      return true;
    }
    if (!voteCanHelp(status)) {
      yield* ui.finish(false, title("another code owner must approve; skipped."));
      yield* logMissingReview(status);
      return false;
    }
    yield* ui.finish(true, title("approval check complete."));
    yield* ui.start(title("approving as your authenticated gh account"));
    const approval = yield* Effect.result(api.approve(number, head));
    if (Result.isFailure(approval)) {
      yield* ui.finish(false, title("approval failed; skipped."));
      yield* ui.error(approval.failure.message);
      yield* ui.error(
        `PR #${number}: approval failed; skipped. GitHub does not allow approval of your own PR.`,
      );
      yield* logMissingReview(status);
      return false;
    }
    yield* ui.finish(true, title("approved as your authenticated gh account."));
    return true;
  });

  const handleConflict = Effect.fn("handleConflict")(function* (pr: PullRequest) {
    yield* ui.finish(
      false,
      `PR #${number} has merge conflicts: https://github.com/${repo}/pull/${number}`,
    );
    yield* tty.notify("PR merge conflict", `PR #${number} needs your attention`);
    while (true) {
      const answer = yield* tty.prompt(
        Prompt.Select({
          message: "How should this conflict be handled?",
          choices: [
            { title: "OpenCode repair", value: "repair" as const },
            { title: "Retry", value: "retry" as const },
            { title: "Skip this PR", value: "skip" as const, selected: true },
            { title: "Quit the batch", value: "quit" as const },
          ],
        }),
      );
      const choice = Option.getOrElse(answer, () => "skip" as const);
      if (choice === "retry") return "retry" as const;
      if (choice === "skip") return "skip" as const;
      if (choice === "quit") return "quit" as const;
      const repaired = yield* Effect.result(repair.run(repo, number, pr));
      if (Result.isSuccess(repaired)) {
        // The session is unattended, so a person looks at the fix before anything merges.
        const reviewed = yield* tty.prompt(
          Prompt.Confirm({ message: "Review the repair, then recheck GitHub?", initial: true }),
        );
        if (Option.getOrElse(reviewed, () => false)) return "retry" as const;
        continue;
      }
      yield* ui.finish(false);
      yield* ui.error(repaired.failure.message);
      yield* ui.error("Repair did not finish successfully. Worktree, if created, was kept.");
    }
  });

  const run = Effect.gen(function* () {
    let deadline = (yield* Clock.currentTimeMillis) + timeoutMillis;
    let updatingSha: string | undefined;
    let approvalCheckedHead: string | undefined;

    yield* ui.start(readingStatus);
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const pr = yield* api.pull(number);
      const head = pr.head.sha;

      if (pr.merged) {
        yield* ui.finish(true, title("merged."));
        return "done" as const;
      }
      if ((yield* ui.current) === readingStatus) yield* ui.finish(true, title("status loaded."));
      if (pr.state === "closed" || pr.draft) {
        yield* ui.finish(false, title("closed or draft; skipped."));
        return "unmerged" as const;
      }

      if (!mergeRequested && options.labels.length > 0) {
        const names = new Set(pr.labels.map((label) => label.name));
        if (!options.labels.every((label) => names.has(label))) {
          yield* ui.finish(false, title("no longer matches all label filters; skipped."));
          return "done" as const;
        }
      }

      if (options.dryRun) {
        yield* ui.log(
          `PR #${number}: ${pr.mergeable_state}; would update if behind, wait for required checks, approve if needed, then ${options.method}-merge.`,
        );
        return "done" as const;
      }

      if (mergeRequested) {
        yield* poll;
        continue;
      }

      if (pr.mergeable === false) {
        const decision = yield* handleConflict(pr);
        if (decision === "quit") return "stop" as const;
        if (decision === "skip") return "unmerged" as const;
        deadline = (yield* Clock.currentTimeMillis) + timeoutMillis;
        updatingSha = undefined;
        continue;
      }

      if (head === updatingSha) {
        yield* poll;
        continue;
      }
      if (updatingSha !== undefined) {
        yield* ui.finish(true, title("branch updated."));
        updatingSha = undefined;
      }

      if (pr.mergeable === null) {
        if ((yield* ui.current) === "") yield* ui.start(waitingMergeability);
        yield* poll;
        continue;
      }
      if ((yield* ui.current) === waitingMergeability) {
        yield* ui.finish(true, title("mergeability calculated."));
      }

      if ((yield* ui.current) === "") yield* ui.start(checkingBase);
      const baseTip = yield* api.branchTip(pr.base.ref);
      const behind = yield* api.behindBy(baseTip, head);
      const status = yield* ui.current;
      if (status === checkingBase) yield* ui.finish(true, title("base branch checked."));

      if (behind > 0) {
        const running = yield* ui.current;
        if (running !== "") yield* ui.finish(false, `${running} (base changed).`);
        yield* ui.start(title(`updating branch (${behind} commits behind)`));
        const update = yield* Effect.result(api.updateBranch(number, head));
        if (Result.isSuccess(update)) {
          updatingSha = head;
        } else {
          yield* ui.finish(false, title("branch update failed."));
          yield* ui.error(update.failure.message);
          // Conflicts or a concurrent push can appear during the update request.
          const fresh = yield* api.pull(number);
          if (fresh.mergeable !== false && fresh.head.sha === head) return "unmerged" as const;
        }
        yield* poll;
        continue;
      }

      yield* ui.start(title("waiting for required checks"));
      const checks = yield* api.requiredChecks(number);
      const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
      if (failed.length > 0) {
        yield* ui.finish(false, title("required checks failed; skipped."));
        for (const check of failed) yield* ui.log(`  ${check.name}: ${check.link}`);
        return "unmerged" as const;
      }
      if (checks.some((check) => check.bucket === "pending")) {
        yield* poll;
        continue;
      }
      yield* ui.finish(true, title("required checks satisfied."));

      if (approvalCheckedHead !== head) {
        if (!(yield* ensureApproval(head))) return "unmerged" as const;
        approvalCheckedHead = head;
      }

      yield* ui.start(title("merging"));
      const merge = yield* Effect.result(api.merge(number, options.method, head));
      if (Result.isSuccess(merge)) {
        mergeRequested = true;
        continue;
      }
      yield* ui.finish(false, title("merge attempt failed."));
      yield* ui.error(merge.failure.message);

      // A new base commit or head push may have invalidated the attempt.
      const fresh = yield* api.pull(number);
      if (fresh.merged || fresh.mergeable === false || fresh.head.sha !== head) continue;
      const freshTip = yield* api.branchTip(fresh.base.ref);
      if (freshTip !== baseTip || fresh.mergeable_state === "behind") {
        yield* poll;
        continue;
      }
      yield* ui.log(`PR #${number}: merge blocked; skipped (no protection bypass).`);
      // Only explains the outcome, so failing to read it must not change that outcome.
      const review = yield* Effect.result(api.reviewStatus(number));
      if (Result.isSuccess(review)) yield* logMissingReview(review.success);
      return "unmerged" as const;
    }

    yield* ui.finish(false, title(`timed out after ${options.timeoutSeconds} seconds.`));
    yield* ui.error(`PR #${number}: timed out after ${options.timeoutSeconds} seconds.`);
    if (mergeRequested) {
      yield* ui.error(
        "Merge may still be queued. Stopping the batch to preserve order; check GitHub before rerunning.",
      );
      return "stop" as const;
    }
    return "unmerged" as const;
  });

  return yield* run.pipe(
    Effect.catchTag("GitHubError", (error) =>
      Effect.gen(function* () {
        const running = yield* ui.current;
        if (running !== "") yield* ui.finish(false, `${running} (failed).`);
        yield* ui.error(error.message);
        // Once submitted to a merge queue, an API failure does not prove it stopped.
        return mergeRequested ? ("stop" as const) : ("unmerged" as const);
      }),
    ),
  );
});
