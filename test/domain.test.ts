import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { parsePrTokens, sanitize, sanitizeText, uniqueSorted } from "../src/domain";
import { permissionChoices, permissionQuestion } from "../src/opencode";
import { currentVotes } from "../src/merge-pr";
import type { Review } from "../src/github";

const REPO = "acme/widgets";

describe("parsePrTokens", () => {
  it.effect("accepts numbers, #numbers and URLs split by spaces, commas and newlines", () =>
    Effect.gen(function* () {
      const numbers = yield* parsePrTokens(
        ["125, 123\n124", "#7", `https://github.com/${REPO}/pull/9/`, ""],
        REPO,
      );
      assert.deepStrictEqual([...numbers], [125, 123, 124, 7, 9]);
    }),
  );

  it.effect("rejects URLs from another repository", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parsePrTokens(["https://github.com/o/r/pull/9"], REPO));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect.each(["0", "abc", "1.5", "-3", "99999999999999999999", "#", "007"])(
    "rejects %s",
    (bad) =>
      Effect.gen(function* () {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(parsePrTokens([bad], REPO))));
      }),
  );
});

it.effect("uniqueSorted removes duplicates and sorts numerically", () =>
  Effect.sync(() => {
    assert.deepStrictEqual([...uniqueSorted([10, 9, 10, 100])], [9, 10, 100]);
  }),
);

describe("sanitizing untrusted text", () => {
  it.effect("removes control and format characters", () =>
    Effect.sync(() => {
      assert.strictEqual(sanitize("a\u001b[31mb‮c\nd"), "a [31mb c d");
    }),
  );
  it.effect("keeps line structure for multi-line text", () =>
    Effect.sync(() => {
      assert.strictEqual(sanitizeText("a\n\tb\u001b[0m\u0007"), "a\n\tb [0m ");
    }),
  );
});

describe("currentVotes", () => {
  const review = (id: number, user: number, state: Review["state"]): Review => ({
    id,
    user: { id: user },
    state,
  });

  it.effect("uses each reviewer's latest vote, ignoring comments and pending reviews", () =>
    Effect.sync(() => {
      const votes = currentVotes([
        review(1, 1, "APPROVED"),
        review(2, 1, "COMMENTED"),
        review(3, 2, "CHANGES_REQUESTED"),
        review(4, 2, "APPROVED"),
        review(5, 3, "PENDING"),
      ]);
      assert.deepStrictEqual(votes.map((vote) => vote.state).sort(), ["APPROVED", "APPROVED"]);
    }),
  );

  it.effect("does not count an approval that was later dismissed", () =>
    Effect.sync(() => {
      const votes = currentVotes([review(9, 1, "DISMISSED"), review(1, 1, "APPROVED")]);
      assert.deepStrictEqual(
        votes.map((vote) => vote.state),
        ["DISMISSED"],
      );
    }),
  );
});

describe("OpenCode permission requests", () => {
  it.effect("only offers 'always' when the server can save the decision", () =>
    Effect.sync(() => {
      const values = (save?: ReadonlyArray<string>) =>
        permissionChoices({ action: "bash", resources: ["ls"], save }).map((c) => c.value);
      assert.deepStrictEqual(values(), ["once", "reject"]);
      assert.deepStrictEqual(values([]), ["once", "reject"]);
      assert.deepStrictEqual(values(["ls *"]), ["once", "always", "reject"]);
    }),
  );

  it.effect("does not let the agent write escape sequences into the question", () =>
    Effect.sync(() => {
      const question = permissionQuestion({ action: "b\u001bash", resources: ["x\u0007"] });
      assert.notInclude(question, "\u001b");
      assert.notInclude(question, "\u0007");
    }),
  );
});
