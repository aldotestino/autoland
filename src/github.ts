import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { MergeMethod } from "./domain";
import { exec } from "./exec";

export class GitHubError extends Schema.TaggedError<
  GitHubError,
  { readonly brand: unique symbol }
>()("GitHubError", {
  message: Schema.String,
}) {}

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const PrNumber = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const RepoRef = Schema.NullOr(Schema.Struct({ ssh_url: Schema.String }));

export const PullRequest = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeable_state: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  base: Schema.Struct({ ref: NonEmpty, sha: Sha, repo: RepoRef }),
  // `repo` is null when the fork a PR came from has been deleted.
  head: Schema.Struct({ ref: Schema.String, sha: Sha, repo: RepoRef }),
});
export type PullRequest = typeof PullRequest.Type;

const Pages = <S extends Schema.Top>(item: S) => Schema.Array(Schema.Array(item));

const IssuePages = Pages(
  Schema.Struct({ number: PrNumber, pull_request: Schema.optional(Schema.Unknown) }),
);

const PullPages = Pages(
  Schema.Struct({
    number: PrNumber,
    draft: Schema.Boolean,
    title: Schema.String,
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
);
export interface OpenPull {
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
}

export const Review = Schema.Struct({
  id: Schema.Number,
  user: Schema.Struct({ id: Schema.Number }),
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"]),
});
export type Review = typeof Review.Type;

const ReviewStatusResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ databaseId: Schema.Number, login: Schema.String }),
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        // Null when the base branch requires no review.
        reviewDecision: Schema.NullOr(
          Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
        ),
        reviewRequests: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              asCodeOwner: Schema.Boolean,
              // A user, bot or mannequin has a login; a team has a combined slug.
              requestedReviewer: Schema.NullOr(
                Schema.Struct({
                  login: Schema.optional(Schema.String),
                  combinedSlug: Schema.optional(Schema.String),
                }),
              ),
            }),
          ),
        }),
      }),
    }),
  }),
});

const REVIEW_STATUS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { databaseId login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      reviewRequests(first: 100) {
        nodes {
          asCodeOwner
          requestedReviewer {
            ... on User { login }
            ... on Bot { login }
            ... on Mannequin { login }
            ... on Team { combinedSlug }
          }
        }
      }
    }
  }
}`;

/** GitHub's verdict on a PR's reviews, which knows the rules that a list of votes cannot. */
export interface ReviewStatus {
  readonly decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  /** The authenticated account, comparable to `Review["user"]["id"]`. */
  readonly viewerId: number;
  readonly viewerLogin: string;
  readonly pending: ReadonlyArray<{
    readonly reviewer: string;
    readonly codeOwner: boolean;
    readonly team: boolean;
  }>;
}

export const Check = Schema.Struct({
  bucket: Schema.Literals(["pass", "skipping", "fail", "cancel", "pending"]),
  name: Schema.String,
  link: Schema.String,
});
export type Check = typeof Check.Type;

const Checks = Schema.Array(Check);
const NoChecks = /^no (required )?checks reported on the '.*' branch$/;

/** Calls for a single repository. */
export interface RepoApi {
  readonly openPrsWithLabels: (
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<number>, GitHubError>;
  readonly openNonDraftPulls: Effect.Effect<ReadonlyArray<OpenPull>, GitHubError>;
  readonly pull: (number: number) => Effect.Effect<PullRequest, GitHubError>;
  /** The live branch tip. A PR's own `base.sha` can lag behind it. */
  readonly branchTip: (ref: string) => Effect.Effect<string, GitHubError>;
  readonly behindBy: (base: string, head: string) => Effect.Effect<number, GitHubError>;
  readonly updateBranch: (number: number, head: string) => Effect.Effect<void, GitHubError>;
  readonly requiredChecks: (number: number) => Effect.Effect<ReadonlyArray<Check>, GitHubError>;
  readonly reviews: (number: number) => Effect.Effect<ReadonlyArray<Review>, GitHubError>;
  readonly reviewStatus: (number: number) => Effect.Effect<ReviewStatus, GitHubError>;
  /** Pinned to `head`, so a concurrent push cannot inherit an unchecked approval. */
  readonly approve: (number: number, head: string) => Effect.Effect<void, GitHubError>;
  /** Success can mean queued rather than merged, so callers must poll for `merged`. */
  readonly merge: (
    number: number,
    method: MergeMethod,
    head: string,
  ) => Effect.Effect<void, GitHubError>;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly currentRepo: Effect.Effect<string, GitHubError>;
    readonly forRepo: (repo: string) => RepoApi;
  }
>()("autoland/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const raw = (args: ReadonlyArray<string>) =>
        exec("gh", args).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) => new GitHubError({ message: `Cannot run gh: ${cause.message}` }),
          ),
        );

      const stdout = (args: ReadonlyArray<string>) =>
        raw(args).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(
                  new GitHubError({
                    message: result.stderr.trim() || `gh exited with status ${result.exitCode}`,
                  }),
                ),
          ),
        );

      const decode =
        <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, invalid: string) =>
        (text: string) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
            Effect.mapError(() => new GitHubError({ message: invalid })),
          );

      // Every page in one document: a failed page fails the call, never truncates the list.
      const paginate = (path: string, fields: ReadonlyArray<string> = []) =>
        stdout([
          "api",
          "--method",
          "GET",
          "--paginate",
          "--slurp",
          path,
          ...fields.flatMap((field) => ["-f", field]),
        ]);

      const forRepo = (repo: string): RepoApi => ({
        openPrsWithLabels: (labels) =>
          // The issues endpoint supports AND label filters; ordinary issues are dropped here.
          paginate(`repos/${repo}/issues`, [
            "state=open",
            "per_page=100",
            `labels=${labels.join(",")}`,
          ]).pipe(
            Effect.flatMap(decode(IssuePages, "Invalid label search response")),
            Effect.map((pages) =>
              pages
                .flat()
                .filter((issue) => issue.pull_request != null)
                .map((issue) => issue.number),
            ),
          ),

        openNonDraftPulls: paginate(`repos/${repo}/pulls`, ["state=open", "per_page=100"]).pipe(
          Effect.flatMap(decode(PullPages, "Invalid PR list response")),
          Effect.map((pages) =>
            pages
              .flat()
              .filter((pull) => !pull.draft)
              .map((pull) => ({
                number: pull.number,
                title: pull.title,
                author: pull.user?.login ?? null,
              })),
          ),
        ),

        pull: (number) =>
          stdout(["api", `repos/${repo}/pulls/${number}`]).pipe(
            Effect.flatMap(decode(PullRequest, "Invalid PR response.")),
          ),

        branchTip: (ref) =>
          stdout([
            "api",
            `repos/${repo}/git/ref/heads/${encodeURIComponent(ref)}`,
            "--jq",
            ".object.sha",
          ]).pipe(
            Effect.map((text) => text.trim()),
            Effect.flatMap((sha) =>
              Schema.is(Sha)(sha)
                ? Effect.succeed(sha)
                : Effect.fail(new GitHubError({ message: "Invalid base branch response." })),
            ),
          ),

        behindBy: (base, head) =>
          stdout(["api", `repos/${repo}/compare/${base}...${head}`, "--jq", ".behind_by"]).pipe(
            Effect.flatMap(
              decode(
                Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
                "Invalid comparison response.",
              ),
            ),
          ),

        updateBranch: (number, head) =>
          stdout([
            "api",
            "--method",
            "PUT",
            `repos/${repo}/pulls/${number}/update-branch`,
            "-f",
            `expected_head_sha=${head}`,
          ]).pipe(Effect.asVoid),

        requiredChecks: (number) =>
          raw([
            "pr",
            "checks",
            String(number),
            "--repo",
            repo,
            "--required",
            "--json",
            "bucket,name,link",
          ]).pipe(
            Effect.flatMap(({ exitCode, stderr, stdout: out }) => {
              // Only the exact no-checks response is an empty list. Auth and network
              // errors also exit 1, and they must never lead to a merge.
              if (exitCode === 1 && NoChecks.test((out + stderr).trim())) {
                return Effect.succeed<ReadonlyArray<Check>>([]);
              }
              // 8 means checks are pending; 1 with JSON means some failed.
              if (exitCode !== 0 && exitCode !== 1 && exitCode !== 8) {
                return Effect.fail(new GitHubError({ message: (out + stderr).trim() }));
              }
              return decode(Checks, stderr.trim() || "Invalid required checks response.")(out);
            }),
          ),

        reviews: (number) =>
          paginate(`repos/${repo}/pulls/${number}/reviews`).pipe(
            Effect.flatMap(decode(Pages(Review), "Invalid reviews response; leaving PR unmerged.")),
            Effect.map((pages) => pages.flat()),
          ),

        reviewStatus: (number) => {
          const [owner = "", name = ""] = repo.split("/");
          return stdout([
            "api",
            "graphql",
            "-f",
            `query=${REVIEW_STATUS_QUERY}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${number}`,
          ]).pipe(
            Effect.flatMap(
              decode(ReviewStatusResponse, "Invalid review status response; leaving PR unmerged."),
            ),
            Effect.map(({ data }) => {
              const pullRequest = data.repository.pullRequest;
              return {
                decision: pullRequest.reviewDecision,
                viewerId: data.viewer.databaseId,
                viewerLogin: data.viewer.login,
                pending: pullRequest.reviewRequests.nodes.flatMap((request) => {
                  const team = request.requestedReviewer?.combinedSlug;
                  const reviewer = request.requestedReviewer?.login ?? team;
                  return reviewer === undefined
                    ? []
                    : [{ reviewer, codeOwner: request.asCodeOwner, team: team !== undefined }];
                }),
              };
            }),
          );
        },

        approve: (number, head) =>
          stdout([
            "api",
            "--method",
            "POST",
            `repos/${repo}/pulls/${number}/reviews`,
            "-f",
            "event=APPROVE",
            "-f",
            `commit_id=${head}`,
            "-f",
            "body=Automatically approved by the PR merge batch at your request.",
          ]).pipe(Effect.asVoid),

        merge: (number, method, head) =>
          stdout([
            "pr",
            "merge",
            String(number),
            "--repo",
            repo,
            `--${method}`,
            "--match-head-commit",
            head,
          ]).pipe(Effect.asVoid),
      });

      return GitHub.of({
        currentRepo: stdout(["repo", "view", "--json", "nameWithOwner"]).pipe(
          Effect.flatMap(
            decode(Schema.Struct({ nameWithOwner: Schema.String }), "Invalid repository response"),
          ),
          Effect.map((repo) => repo.nameWithOwner),
        ),
        forRepo,
      });
    }),
  );
}
