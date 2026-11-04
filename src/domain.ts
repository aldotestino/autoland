import { Effect, Runtime, Schema } from "effect";

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"]);
export type MergeMethod = typeof MergeMethod.Type;

export interface BatchOptions {
  readonly inputs: ReadonlyArray<string>;
  readonly method: MergeMethod;
  readonly timeoutSeconds: number;
  readonly labels: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly interactive: boolean;
}

/** Invalid input or an unusable environment. Exits with status 2. */
export class UsageError extends Schema.TaggedError<UsageError, { readonly brand: unique symbol }>()(
  "UsageError",
  {
    message: Schema.String,
  },
) {
  override readonly [Runtime.errorExitCode] = 2;
  override readonly [Runtime.errorReported] = false;
}

/** The batch finished, already reported, and left work undone. Exits with status 1. */
export class BatchFailed extends Schema.TaggedError<
  BatchFailed,
  { readonly brand: unique symbol }
>()("BatchFailed", {}) {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
}

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/;
const PR_NUMBER = /^[1-9][0-9]*$/;
export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Parses PR numbers, `#numbers`, and URLs separated by spaces, commas, or newlines.
 * Returns the raw list: filtering by label comes first, then {@link uniqueSorted}.
 */
export const parsePrTokens = (
  inputs: ReadonlyArray<string>,
  repo: string,
): Effect.Effect<ReadonlyArray<number>, UsageError> => {
  const numbers: Array<number> = [];
  for (const token of inputs.flatMap((input) => input.split(/[,\s]+/))) {
    if (token === "") continue;
    let candidate = token;
    const url = PR_URL.exec(token);
    if (url) {
      if (url[1] !== repo) {
        return Effect.fail(
          new UsageError({ message: `PR URL belongs to another repository: ${token}` }),
        );
      }
      candidate = url[2] ?? "";
    } else if (candidate.startsWith("#")) {
      candidate = candidate.slice(1);
    }
    const number = Number(candidate);
    if (!PR_NUMBER.test(candidate) || !Number.isSafeInteger(number)) {
      return Effect.fail(new UsageError({ message: `Invalid PR: ${candidate}` }));
    }
    numbers.push(number);
  }
  return Effect.succeed(numbers);
};

export const uniqueSorted = (numbers: ReadonlyArray<number>): ReadonlyArray<number> =>
  [...new Set(numbers)].sort((a, b) => a - b);

/** PR text is untrusted: control and format characters must not reach the terminal. */
export const sanitize = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");

/** Like {@link sanitize}, for multi-line text: keeps newlines and tabs. */
export const sanitizeText = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : " "));

export const repairPrompt = (input: {
  readonly number: number;
  readonly repo: string;
  readonly baseBranch: string;
  readonly baseUrl: string;
  readonly headBranch: string;
  readonly headUrl: string;
}): string =>
  `Resolve the base-branch merge conflicts for PR #${input.number} in ${input.repo}.
PR: https://github.com/${input.repo}/pull/${input.number}
This dedicated worktree is detached at the PR head. Create a local repair branch before committing.
Read AGENTS.md and use the resolving-merge-conflicts skill if available.
Fetch the latest base branch "${input.baseBranch}" from "${input.baseUrl}" and MERGE it into this branch; do not rebase.
Inspect the PR description, diff, and conflicting files. Preserve both the PR's intent and intervening base changes.
Resolve only the merge conflicts, run relevant tests and checks, and commit the resolution.
Push normally (never force) to "${input.headUrl}" with the explicit refspec "HEAD:refs/heads/${input.headBranch}".
If the remote head changed, reconcile it without discarding changes. Do not push to the base branch.
Do not merge or close the PR, enable auto-merge, bypass checks, or modify other PRs.
Report what you fixed and whether the push succeeded. autoland will re-check GitHub once this session finishes.
`;
