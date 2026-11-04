import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { repairPrompt } from "./domain";
import { exec } from "./exec";
import type { PullRequest } from "./github";
import { Agent } from "./opencode";
import { Ui } from "./ui";

export class RepairFailed extends Schema.TaggedError<
  RepairFailed,
  { readonly brand: unique symbol }
>()("RepairFailed", {
  message: Schema.String,
}) {}

/** Has an OpenCode session fix the PR in a new worktree, leaving the current checkout alone. */
export class Repair extends Context.Service<
  Repair,
  {
    readonly run: (
      repo: string,
      number: number,
      pr: PullRequest,
    ) => Effect.Effect<void, RepairFailed>;
  }
>()("autoland/Repair") {
  static readonly layer = Layer.effect(
    Repair,
    Effect.gen(function* () {
      const ui = yield* Ui;
      const agent = yield* Agent;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const git = (number: number, failure: string, args: ReadonlyArray<string>) =>
        // Attached: fetching over ssh may need to ask for a passphrase.
        exec("git", args, { attached: true }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) => new RepairFailed({ message: cause.message })),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(new RepairFailed({ message: (result.stdout + result.stderr).trim() })),
          ),
          Effect.tapError(() => ui.finish(false, `PR #${number}: ${failure}`)),
        );

      return Repair.of({
        run: Effect.fn("Repair.run")(function* (repo, number, pr) {
          yield* ui.start(`PR #${number}: preparing OpenCode repair worktree`);
          const baseUrl = pr.base.repo?.ssh_url;
          const headUrl = pr.head.repo?.ssh_url;
          if (baseUrl === undefined || headUrl === undefined) {
            return yield* new RepairFailed({
              message: "The PR's repository is unavailable, so it cannot be fetched or pushed.",
            });
          }
          yield* agent.connect.pipe(
            Effect.mapError((error) => new RepairFailed({ message: error.message })),
          );
          const parent = yield* fs
            .makeTempDirectory({ prefix: `autoland-pr-${number}.` })
            .pipe(Effect.mapError((cause) => new RepairFailed({ message: cause.message })));
          const worktree = path.join(parent, "worktree");

          yield* git(number, "could not fetch repair branch.", [
            "fetch",
            "--",
            baseUrl,
            `refs/pull/${number}/head`,
          ]);
          yield* git(number, "could not create repair worktree.", [
            "worktree",
            "add",
            "--detach",
            worktree,
            "FETCH_HEAD",
          ]);
          yield* ui.finish(true, `PR #${number}: OpenCode repair worktree ready.`);

          const prompt = repairPrompt({
            number,
            repo,
            baseBranch: pr.base.ref,
            baseUrl,
            headBranch: pr.head.ref,
            headUrl,
          });
          yield* ui.log(`\nRepair worktree (kept for review): ${worktree}\n\nPrompt:\n${prompt}`);

          yield* ui.start(`PR #${number}: OpenCode is resolving the conflicts`);
          const report = yield* agent
            .runSession({ directory: worktree, title: `Repair PR #${number}`, prompt })
            .pipe(
              Effect.tapError(() => ui.finish(false, `PR #${number}: OpenCode session failed.`)),
              Effect.mapError((error) => new RepairFailed({ message: error.message })),
            );
          yield* ui.finish(true, `PR #${number}: OpenCode session finished.`);
          if (report !== "") yield* ui.log(`\nOpenCode's report:\n${report}\n`);
        }),
      });
    }),
  );
}
