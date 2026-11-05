import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Sink, Stdio } from "effect";
import { TerminalCapabilities } from "effect/cli";
import { TestClock } from "effect/testing";
import {
  type Check,
  GitHub,
  GitHubError,
  type PullRequest,
  type RepoApi,
  type Review,
  type ReviewStatus,
} from "../src/github";
import { processPr } from "../src/merge-pr";
import { Repair, RepairFailed } from "../src/repair";
import { Tty } from "../src/tty";
import { Ui } from "../src/ui";

const HEAD = "a".repeat(40);
const HEAD_2 = "b".repeat(40);
const BASE = "c".repeat(40);
const VIEWER = 99;
const VIEWER_LOGIN = "me";

const pull = (overrides: Partial<PullRequest> & { readonly sha?: string } = {}): PullRequest => ({
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  labels: [],
  base: { ref: "main", sha: BASE, repo: { ssh_url: "git@github.com:acme/widgets.git" } },
  head: {
    ref: "feature",
    sha: overrides.sha ?? HEAD,
    repo: { ssh_url: "git@github.com:acme/widgets.git" },
  },
  ...overrides,
});

const merged = pull({ merged: true, state: "closed" });
const fail = (message: string) => Effect.fail(new GitHubError({ message }));

interface Script {
  /** Each read takes the next state; the last repeats. Errors make that read fail. */
  readonly pulls: ReadonlyArray<PullRequest | GitHubError>;
  readonly behind?: ReadonlyArray<number>;
  readonly checks?: ReadonlyArray<ReadonlyArray<Check>>;
  readonly reviews?: ReadonlyArray<Review>;
  readonly status?: Partial<ReviewStatus>;
  readonly approve?: Effect.Effect<void, GitHubError>;
  readonly merge?: Effect.Effect<void, GitHubError>;
  readonly tip?: ReadonlyArray<string>;
  /** Answers to prompts, in order. Undefined means no terminal is available. */
  readonly answers?: ReadonlyArray<unknown>;
  readonly repair?: Effect.Effect<void, RepairFailed>;
}

const next = <A>(items: ReadonlyArray<A>, index: number): A =>
  items[Math.min(index, items.length - 1)] as A;

const run = (script: Script, options: Partial<Parameters<typeof processPr>[2]> = {}) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const output: Array<string> = [];
    let pulls = 0;
    let behind = 0;
    let checks = 0;
    let tips = 0;
    let answers = 0;

    const api: RepoApi = {
      openPrsWithLabels: () => Effect.die("unused"),
      openNonDraftPulls: Effect.die("unused"),
      pull: () =>
        Effect.suspend(() => {
          const state = next(script.pulls, pulls++);
          return "_tag" in state ? Effect.fail(state) : Effect.succeed(state);
        }),
      branchTip: () => Effect.sync(() => next(script.tip ?? [BASE], tips++)),
      behindBy: () => Effect.sync(() => next(script.behind ?? [0], behind++)),
      updateBranch: (_, head) =>
        Effect.sync(() => {
          calls.push(`update:${head}`);
        }),
      requiredChecks: () => Effect.sync(() => next(script.checks ?? [[]], checks++)),
      reviews: () => Effect.succeed(script.reviews ?? []),
      reviewStatus: () =>
        Effect.succeed({
          decision: null,
          viewerId: VIEWER,
          viewerLogin: VIEWER_LOGIN,
          pending: [],
          ...script.status,
        }),
      approve: (_, head) =>
        Effect.suspend(() => {
          calls.push(`approve:${head}`);
          return script.approve ?? Effect.void;
        }),
      merge: (_, method, head) =>
        Effect.suspend(() => {
          calls.push(`merge:${method}:${head}`);
          return script.merge ?? Effect.void;
        }),
    };

    const write = Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        output.push(String(chunk));
      }),
    );

    const services = Ui.layer.pipe(
      Layer.provide(
        Layer.succeed(TerminalCapabilities.TerminalCapabilities, {
          canAnimate: false,
          canColor: false,
          canPrompt: false,
        }),
      ),
      Layer.provide(Stdio.layerTest({ stdout: () => write, stderr: () => write })),
      Layer.merge(
        Layer.succeed(
          GitHub,
          GitHub.of({ currentRepo: Effect.succeed("acme/widgets"), forRepo: () => api }),
        ),
      ),
      Layer.merge(
        Layer.succeed(
          Tty,
          Tty.of({
            available: script.answers !== undefined,
            notify: () => Effect.void,
            prompt: <A>() =>
              Effect.sync(() => {
                calls.push("prompt");
                return script.answers === undefined
                  ? Option.none<A>()
                  : Option.some(next(script.answers, answers++) as A);
              }),
          }),
        ),
      ),
      Layer.merge(
        Layer.succeed(
          Repair,
          Repair.of({
            run: () =>
              Effect.suspend(() => {
                calls.push("repair");
                return script.repair ?? Effect.void;
              }),
          }),
        ),
      ),
    );

    const fiber = yield* processPr("acme/widgets", 1, {
      dryRun: false,
      labels: [],
      method: "squash",
      timeoutSeconds: 1800,
      ...options,
    }).pipe(Effect.provide(services), Effect.forkChild);

    while (fiber.pollUnsafe() === undefined) yield* TestClock.adjust("10 seconds");
    const outcome = yield* Fiber.join(fiber);
    return { outcome, calls, output: output.join("") };
  });

const MERGE = `merge:squash:${HEAD}`;
const APPROVE = `approve:${HEAD}`;

describe("processPr", () => {
  it.effect("reports a PR that is already merged, without writing", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({ pulls: [merged] });
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, []);
      assert.include(output, "✓ PR #1: merged.");
    }),
  );

  it.effect("approves the checked head, then merges", () =>
    Effect.gen(function* () {
      const { calls, outcome } = yield* run({ pulls: [pull(), merged] });
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, [APPROVE, MERGE]);
    }),
  );

  it.effect("does not duplicate an existing approval", () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        pulls: [pull(), merged],
        reviews: [{ id: 1, user: { id: 1 }, state: "APPROVED" }],
      });
      assert.deepStrictEqual(calls, [MERGE]);
    }),
  );

  describe("while GitHub still requires a review", () => {
    const waitingOn = (reviewer: string, codeOwner = true, team = false) =>
      ({
        decision: "REVIEW_REQUIRED",
        pending: [{ reviewer, codeOwner, team }],
      }) as const;
    const someoneElse: Review = { id: 1, user: { id: 1 }, state: "APPROVED" };

    it.effect("approves as the code owner even though someone else already has", () =>
      Effect.gen(function* () {
        const { calls, outcome } = yield* run({
          pulls: [pull(), merged],
          reviews: [someoneElse],
          status: waitingOn(VIEWER_LOGIN),
        });
        assert.strictEqual(outcome, "done");
        assert.deepStrictEqual(calls, [APPROVE, MERGE]);
      }),
    );

    it.effect("leaves no stray approval when only another person can satisfy the rule", () =>
      Effect.gen(function* () {
        const { calls, outcome, output } = yield* run({
          pulls: [pull()],
          reviews: [someoneElse],
          status: waitingOn("owner"),
        });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, []);
        assert.include(output, "another code owner must approve; skipped.");
        assert.include(output, "waiting on @owner (code owner).");
      }),
    );

    it.effect("approves when a requested code-owner team might include you", () =>
      Effect.gen(function* () {
        const { calls } = yield* run({
          pulls: [pull(), merged],
          status: waitingOn("acme/owners", true, true),
        });
        assert.deepStrictEqual(calls, [APPROVE, MERGE]);
      }),
    );

    it.effect("approves when the only pending reviewer is not a code owner", () =>
      Effect.gen(function* () {
        const { calls } = yield* run({
          pulls: [pull(), merged],
          status: waitingOn("colleague", false),
        });
        assert.deepStrictEqual(calls, [APPROVE, MERGE]);
      }),
    );

    it.effect("does not duplicate your own approval, and names who it waits on", () =>
      Effect.gen(function* () {
        const { calls, outcome, output } = yield* run({
          pulls: [pull()],
          reviews: [{ id: 2, user: { id: VIEWER }, state: "APPROVED" }],
          status: waitingOn("owner"),
          merge: fail("the base branch policy prohibits the merge"),
        });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, [MERGE]);
        assert.include(output, "your approval is already present.");
        assert.include(output, "waiting on @owner (code owner).");
      }),
    );

    it.effect("names who it waits on when you cannot approve your own PR", () =>
      Effect.gen(function* () {
        const { calls, outcome, output } = yield* run({
          pulls: [pull()],
          reviews: [someoneElse],
          status: waitingOn("acme/owners", true, true),
          approve: fail("Can not approve your own pull request"),
        });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, [APPROVE]);
        assert.include(output, "waiting on @acme/owners (code owner).");
      }),
    );
  });

  it.effect("does not vote once GitHub considers the PR approved", () =>
    Effect.gen(function* () {
      const { calls, output } = yield* run({
        pulls: [pull(), merged],
        reviews: [{ id: 1, user: { id: 1 }, state: "APPROVED" }],
        status: { decision: "APPROVED" },
      });
      assert.deepStrictEqual(calls, [MERGE]);
      assert.include(output, "approval already present.");
    }),
  );

  it.effect("skips when GitHub reports changes requested", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [pull()],
        status: { decision: "CHANGES_REQUESTED" },
      });
      assert.strictEqual(outcome, "unmerged");
      assert.deepStrictEqual(calls, []);
      assert.include(output, "changes requested; skipped.");
    }),
  );

  it.effect("waits for a queued merge rather than treating the request as merged", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [pull(), pull({ mergeable_state: "blocked" }), pull(), merged],
      });
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, [APPROVE, MERGE]);
      assert.include(output, "✓ PR #1: merged.");
    }),
  );

  it.effect("stops the batch when a queued merge cannot be confirmed", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run({
        pulls: [pull(), new GitHubError({ message: "HTTP 502" })],
      });
      assert.strictEqual(outcome, "stop");
    }),
  );

  it.effect("stops the batch when a queued merge outlasts the timeout", () =>
    Effect.gen(function* () {
      const { outcome, output } = yield* run({ pulls: [pull()] }, { timeoutSeconds: 30 });
      assert.strictEqual(outcome, "stop");
      assert.include(output, "Merge may still be queued");
    }),
  );

  it.effect("leaves a PR unmerged, and continues, when reading it fails before merging", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [new GitHubError({ message: "HTTP 500" })],
      });
      assert.strictEqual(outcome, "unmerged");
      assert.deepStrictEqual(calls, []);
      assert.include(output, "HTTP 500");
    }),
  );

  it.effect("never merges over an outstanding change request", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [pull()],
        reviews: [
          { id: 1, user: { id: 1 }, state: "APPROVED" },
          { id: 2, user: { id: 2 }, state: "CHANGES_REQUESTED" },
        ],
      });
      assert.strictEqual(outcome, "unmerged");
      assert.deepStrictEqual(calls, []);
      assert.include(output, "changes requested; skipped.");
    }),
  );

  it.effect("skips when approval fails, such as on your own PR", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [pull()],
        approve: fail("Can not approve your own pull request"),
      });
      assert.strictEqual(outcome, "unmerged");
      assert.deepStrictEqual(calls, [APPROVE]);
      assert.include(output, "Can not approve your own pull request");
    }),
  );

  it.effect("updates a branch that is behind, and approves only the updated head", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [pull(), pull(), pull({ sha: HEAD_2 }), merged],
        behind: [2, 0],
      });
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, [
        `update:${HEAD}`,
        `approve:${HEAD_2}`,
        `merge:squash:${HEAD_2}`,
      ]);
      assert.include(output, "updating branch (2 commits behind)");
      assert.include(output, "✓ PR #1: branch updated.");
    }),
  );

  it.effect("waits for pending checks and skips failed ones", () =>
    Effect.gen(function* () {
      const pass: Check = { bucket: "pass", name: "ci", link: "https://ci/1" };
      const pending: Check = { ...pass, bucket: "pending" };
      const failed: Check = { ...pass, bucket: "fail" };

      const waited = yield* run({ pulls: [pull(), pull(), merged], checks: [[pending], [pass]] });
      assert.deepStrictEqual(waited.calls, [APPROVE, MERGE]);

      const skipped = yield* run({ pulls: [pull()], checks: [[pending], [failed]] });
      assert.strictEqual(skipped.outcome, "unmerged");
      assert.deepStrictEqual(skipped.calls, []);
      assert.include(skipped.output, "  ci: https://ci/1");
    }),
  );

  it.effect("waits while GitHub calculates mergeability", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run({
        pulls: [pull({ mergeable: null }), pull(), merged],
      });
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, [APPROVE, MERGE]);
      assert.include(output, "mergeability calculated.");
    }),
  );

  it.effect("retries after the base moves during a merge attempt", () =>
    Effect.gen(function* () {
      const { calls, outcome } = yield* run({
        pulls: [pull(), pull(), pull(), merged],
        merge: fail("Base branch was modified"),
        tip: [BASE, "d".repeat(40), "d".repeat(40)],
      });
      assert.strictEqual(outcome, "done");
      assert.strictEqual(calls.filter((call) => call === MERGE).length >= 1, true);
    }),
  );

  it.effect("reports a blocked merge without bypassing protections", () =>
    Effect.gen(function* () {
      const { outcome, output } = yield* run({
        pulls: [pull()],
        merge: fail("Required reviews missing"),
      });
      assert.strictEqual(outcome, "unmerged");
      assert.include(output, "merge blocked; skipped (no protection bypass).");
    }),
  );

  it.effect("skips closed PRs and drafts", () =>
    Effect.gen(function* () {
      for (const state of [pull({ state: "closed" }), pull({ draft: true })]) {
        const { calls, outcome } = yield* run({ pulls: [state] });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, []);
      }
    }),
  );

  it.effect("drops a PR that no longer has every label, without counting it as failed", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run(
        { pulls: [pull({ labels: [{ name: "a" }] })] },
        { labels: ["a", "b"] },
      );
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, []);
      assert.include(output, "no longer matches all label filters");
    }),
  );

  it.effect("writes nothing on a dry run", () =>
    Effect.gen(function* () {
      const { calls, outcome, output } = yield* run(
        { pulls: [pull({ mergeable: false, mergeable_state: "dirty" })] },
        { dryRun: true, method: "rebase" },
      );
      assert.strictEqual(outcome, "done");
      assert.deepStrictEqual(calls, []);
      assert.include(output, "PR #1: dirty; would update if behind");
      assert.include(output, "then rebase-merge.");
    }),
  );

  describe("on a conflict", () => {
    const conflicted = pull({ mergeable: false, mergeable_state: "dirty" });

    it.effect("leaves it unmerged without a terminal", () =>
      Effect.gen(function* () {
        const { calls, outcome, output } = yield* run({ pulls: [conflicted] });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, ["prompt"]);
        assert.include(output, "has merge conflicts: https://github.com/acme/widgets/pull/1");
      }),
    );

    it.effect("stops the batch on quit", () =>
      Effect.gen(function* () {
        const { outcome } = yield* run({ pulls: [conflicted], answers: ["quit"] });
        assert.strictEqual(outcome, "stop");
      }),
    );

    it.effect("rechecks GitHub on retry", () =>
      Effect.gen(function* () {
        const { calls, outcome } = yield* run({
          pulls: [conflicted, pull({ sha: HEAD_2 }), merged],
          answers: ["retry"],
        });
        assert.strictEqual(outcome, "done");
        assert.deepStrictEqual(calls, ["prompt", `approve:${HEAD_2}`, `merge:squash:${HEAD_2}`]);
      }),
    );

    it.effect("resumes after a repair only once a person has reviewed it", () =>
      Effect.gen(function* () {
        const { calls, outcome } = yield* run({
          pulls: [conflicted, pull({ sha: HEAD_2 }), merged],
          answers: ["repair", true],
        });
        assert.strictEqual(outcome, "done");
        assert.deepStrictEqual(calls, [
          "prompt",
          "repair",
          "prompt",
          `approve:${HEAD_2}`,
          `merge:squash:${HEAD_2}`,
        ]);
      }),
    );

    it.effect("does not touch the PR again until the repair has been reviewed", () =>
      Effect.gen(function* () {
        // GitHub would report the PR as clean, so rechecking too early would merge it.
        const { calls, outcome } = yield* run({
          pulls: [conflicted, pull({ sha: HEAD_2 }), merged],
          answers: ["repair", false, "skip"],
        });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, ["prompt", "repair", "prompt", "prompt"]);
      }),
    );

    it.effect("offers the menu again when a repair fails", () =>
      Effect.gen(function* () {
        const { calls, outcome, output } = yield* run({
          pulls: [conflicted],
          answers: ["repair", "skip"],
          repair: Effect.fail(new RepairFailed({ message: "no opencode" })),
        });
        assert.strictEqual(outcome, "unmerged");
        assert.deepStrictEqual(calls, ["prompt", "repair", "prompt"]);
        assert.include(output, "no opencode");
        assert.include(output, "Repair did not finish successfully");
      }),
    );

    it.effect("gives a fresh timeout after retrying", () =>
      Effect.gen(function* () {
        const { outcome } = yield* run(
          {
            // Mergeability stays unknown long enough to outlast one timeout, split by the retry.
            pulls: [
              pull({ mergeable: null }),
              pull({ mergeable: null }),
              conflicted,
              pull({ mergeable: null }),
              pull({ mergeable: null }),
              pull(),
              merged,
            ],
            answers: ["retry"],
          },
          { timeoutSeconds: 25 },
        );
        assert.strictEqual(outcome, "done");
      }),
    );
  });
});
